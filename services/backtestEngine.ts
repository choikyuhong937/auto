/**
 * BacktestEngine — 과거 데이터 기반 전략 시뮬레이션
 *
 * 기존 Scanner.detectDirection, Execution.calculateTPSL, indicatorService 재사용
 * 급등/급락 상위 N종목 × 2160 1h 캔들 (90일) bar-by-bar 시뮬레이션
 */

import type {
    KlineData, TradingConfig, BacktestTrade, BacktestTickerResult,
    BacktestSummary, SimpleRegime, TradeDNA, Session, DayType,
} from '../types';
import { getSessionAndDayType } from '../types';

import { Scanner, type RegimeResult } from './core/scanner';
import { Execution } from './core/execution';
import {
    calculateATR, calculateADX, calculateRSI, calculateEMA, aggregateCandles,
    calculateWaveTrend, calculateIchimoku, calculateVWAP, calculateMFI, calculateHurstExponent,
} from './indicatorService';
import { computeEntryZones, type SwingPoint, type EntryZone } from './zoneCalculator';
import * as bybitService from './bybitService';

// 수수료 + 슬리피지 (실전 반영)
const FEE_RATE_ENTRY = 0.00055;
const FEE_RATE_EXIT = 0.00055;
const SLIPPAGE_RATE = 0.0008;  // ★ 0.03% → 0.08% (시장가 진입/청산 실전 슬리피지 반영)
const TOTAL_FEE_RATE = FEE_RATE_ENTRY + FEE_RATE_EXIT + SLIPPAGE_RATE;

const WARMUP_BARS = 150;  // 1m × 150 = 2.5시간 워밍업
const DEFAULT_KLINE_COUNT = 1440; // 1일 × 60 (1분봉)
const DEFAULT_TOP_MOVERS = 10;
const MIN_VOLUME_USD = 500_000;

// ★ v54: MLR 50%→20% (28,028건 분석: MLR20% + 20x에서 DD 58%→18% 감소)
const MAX_LOSS_RATIO = 0.20;  // 20% = SL 1%→20x, SL 2%→10x, SL 5%→4x
const MAX_LEVERAGE_CAP = 75;

/** ★ 레버리지 = 레짐캡 직접 사용 (slAtrMultiplier 제거)
 *  SL% = 0.50 / leverage 연속공식만 적용 */
function calcLeverageWithRegimeCap(config: TradingConfig, regime: SimpleRegime | string): number {
    const maxLev = config.swing?.maxLeverage as Record<string, number> | undefined;
    const regimeCap = maxLev ? (maxLev[regime] ?? MAX_LEVERAGE_CAP) : MAX_LEVERAGE_CAP;
    return Math.min(MAX_LEVERAGE_CAP, regimeCap);
}

// ★ RANGING TP 캡 제거 — 옵티마이저가 레짐별 tpAtrMultiplier를 이미 최적화
// applyRangingTpCap() 삭제

// 존 기반 진입: 대기 중인 존 엔트리
const ZONE_EXPIRY_BARS = 60; // 1m × 60 = 1시간 내 존 미도달 시 만료
// ★ 모멘텀 바이패스 (1분봉 기준)
const MOMENTUM_BYPASS_MIN_BARS_BT = 20;    // 20분 대기 후 허용
const MOMENTUM_BYPASS_MIN_ATR_BT = 1.0;    // 시그널 가격 대비 최소 1.0 ATR
const MOMENTUM_BYPASS_MAX_ATR_BT = 3.0;    // 최대 3.0 ATR

interface PendingZoneEntry {
    signalBar: number;
    direction: 'Long' | 'Short';
    zones: { type: string; minPrice: number; maxPrice: number }[];
    regime: string;
    session: Session;       // ★ v36: 시그널 세션
    dayType: DayType;       // ★ v36: 시그널 요일
    score: number;
    signalTime: number;
    regimeTpMult: number;
    regimeSlMult: number;
    signalPrice: number;       // 모멘텀 바이패스 거리 계산용
}

// 시뮬레이션 내부 포지션
interface SimPosition {
    entryBar: number;
    direction: 'Long' | 'Short';
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    leverage: number;
    regime: string;
    session: Session;       // ★ v36: 진입 세션
    dayType: DayType;       // ★ v36: 진입 요일
    score: number;
    tp1Hit: boolean;
    tp1PnlRealized: number;
    entryTime: number;
    underwaterBars: number;
    entryDNA?: TradeDNA;
}

interface ExitResult {
    exitPrice: number;
    reason: 'TP1' | 'TP2' | 'SL' | 'END_OF_DATA' | 'MAX_HOLD';
    partialRealized: number;
}

export class BacktestEngine {
    private scanner: Scanner;
    private execution: Execution;
    private onProgress?: (msg: string, percent: number) => void;
    private aborted = false;

    constructor(onProgress?: (msg: string, percent: number) => void) {
        this.scanner = new Scanner();
        this.scanner.setSimulationMode(true); // 백테스트: 캐시/히스테리시스 비활성화
        this.execution = new Execution(() => {});
        this.onProgress = onProgress;
    }

    abort() { this.aborted = true; }

    // ── Public API ──
    // v30: 시간 동기화 크로스-종목 시뮬레이션 (maxPositions 강제)
    // 기존: 종목별 독립 시뮬 → 종목 순서대로 처리 → maxPositions 무시
    // 개선: 전체 kline 수집 후 bar 단위 동기 시뮬 → 동시 포지션 수 제한

    async run(
        config: TradingConfig,
        topN: number = DEFAULT_TOP_MOVERS,
        klineCount: number = DEFAULT_KLINE_COUNT,
        maxPositions: number = 99,
        preloadedKlines?: Map<string, KlineData[]>,
    ): Promise<BacktestSummary> {
        const startTime = Date.now();
        this.aborted = false;

        let klineMap: Map<string, KlineData[]>;

        if (preloadedKlines && preloadedKlines.size > 0) {
            // 옵티마이저 데이터 재사용 → API 호출 없이 동일 데이터로 시뮬
            this.onProgress?.(`옵티마이저 캐시 데이터 사용 (${preloadedKlines.size}종목)...`, 30);
            // topN만큼만 슬라이스 (옵티마이저가 더 많이 fetch 했을 수 있음)
            const entries = Array.from(preloadedKlines.entries());
            const sliced = topN > 0 && topN < entries.length ? entries.slice(0, topN) : entries;
            klineMap = new Map(sliced);
        } else {
            // Phase 1: 종목 조회
            this.onProgress?.(`상위 급등/급락 종목 조회 중 (최대 ${topN === 0 ? '전체' : topN}개)...`, 0);
            const tickers = await this.fetchTopMovers(topN);

            if (tickers.length === 0) {
                throw new Error('조건에 맞는 종목이 없습니다.');
            }

            // Phase 2: 전체 kline 수집
            klineMap = new Map<string, KlineData[]>();
            for (let i = 0; i < tickers.length; i++) {
                if (this.aborted) break;
                const ticker = tickers[i];
                this.onProgress?.(`${ticker} 데이터 수집 중... (${i + 1}/${tickers.length})`, Math.round((i / tickers.length) * 40));
                try {
                    const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', klineCount);
                    if (klines.length < WARMUP_BARS + 10) {
                        console.warn(`[Backtest] ${ticker} 캔들 부족 (${klines.length}) → 스킵`);
                        continue;
                    }
                    klineMap.set(ticker, klines);
                } catch (e) {
                    console.error(`[Backtest] ${ticker} 실패:`, e);
                }
                if (i < tickers.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');
        if (klineMap.size === 0) throw new Error('유효한 종목 데이터가 없습니다.');

        // Phase 3: 시간 동기화 시뮬레이션
        const validTickers = Array.from(klineMap.keys());
        const minLen = Math.min(...Array.from(klineMap.values()).map(k => k.length));
        const totalBars = minLen;

        // ★ v31: MTF 데이터 준비 — 1m→15m/1h 집계 (실전 동기화)
        const klineMap15m = new Map<string, KlineData[]>();
        const klineMap1h = new Map<string, KlineData[]>();
        for (const [ticker, klines] of klineMap) {
            klineMap15m.set(ticker, aggregateCandles(klines, 15));
            klineMap1h.set(ticker, aggregateCandles(klines, 60));
        }

        const openPositions = new Map<string, SimPosition>();
        const tickerTradesMap = new Map<string, BacktestTrade[]>();
        // ★ SL 쿨다운 제거

        // ★ v31: 종목별 MTF 방향 캐시 (optimizerEngine 패턴)
        const tfCache = new Map<string, {
            dir15m: 'Long' | 'Short' | null; score15m: number; idx15m: number;
            dir1h: 'Long' | 'Short' | null; score1h: number; idx1h: number;
            regime1h: SimpleRegime; tpMult1h: number; slMult1h: number;
            running15mIdx: number; running1hIdx: number;
        }>();
        for (const ticker of validTickers) {
            tfCache.set(ticker, {
                dir15m: null, score15m: 0, idx15m: -1,
                dir1h: null, score1h: 0, idx1h: -1,
                regime1h: 'RANGING' as SimpleRegime, tpMult1h: 1.0, slMult1h: 1.0,
                running15mIdx: 0, running1hIdx: 0,
            });
        }

        for (let bar = WARMUP_BARS; bar < totalBars; bar++) {
            if (this.aborted) break;

            if (bar % 50 === 0) {
                const pct = 40 + Math.round(((bar - WARMUP_BARS) / (totalBars - WARMUP_BARS)) * 60);
                this.onProgress?.(`시뮬레이션 Bar ${bar}/${totalBars} | 포지션 ${openPositions.size}/${maxPositions}`, pct);
            }

            // --- Pass 1: 기존 포지션 출구 체크 ---
            for (const [ticker, pos] of [...openPositions.entries()]) {
                const klines = klineMap.get(ticker)!;
                if (bar >= klines.length) continue;
                const candle = klines[bar];

                const exit = this.resolveExit(pos, candle);
                if (exit) {
                    const pnl = this.calculateTradePnl(pos, exit);
                    if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                    tickerTradesMap.get(ticker)!.push({
                        ticker, direction: pos.direction,
                        entryPrice: pos.entryPrice, exitPrice: exit.exitPrice,
                        entryTime: pos.entryTime, exitTime: candle.time,
                        tp1Price: pos.tp1Price, tp2Price: pos.tp2Price, slPrice: pos.slPrice,
                        pnlPercent: pnl, exitReason: exit.reason,
                        regime: pos.regime, session: pos.session, dayType: pos.dayType, directionScore: pos.score,
                        leverage: pos.leverage, barsHeld: bar - pos.entryBar,
                        underwaterBars: pos.underwaterBars,
                    });
                    openPositions.delete(ticker);
                    // ★ SL 쿨다운 제거
                    continue;
                }

                // v31: maxHoldingBars 삭제 — 실전에서 비활성화됨, TP/SL로만 청산

                // ★ 물려있는 시간 카운트
                const isLong = pos.direction === 'Long';
                if ((isLong && candle.close < pos.entryPrice) || (!isLong && candle.close > pos.entryPrice)) {
                    pos.underwaterBars++;
                }

                // 마지막 바 강제 청산
                if (bar === totalBars - 1) {
                    const forcedExit: ExitResult = { exitPrice: candle.close, reason: 'END_OF_DATA', partialRealized: pos.tp1PnlRealized };
                    const pnl = this.calculateTradePnl(pos, forcedExit);
                    if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                    tickerTradesMap.get(ticker)!.push({
                        ticker, direction: pos.direction,
                        entryPrice: pos.entryPrice, exitPrice: candle.close,
                        entryTime: pos.entryTime, exitTime: candle.time,
                        tp1Price: pos.tp1Price, tp2Price: pos.tp2Price, slPrice: pos.slPrice,
                        pnlPercent: pnl, exitReason: 'END_OF_DATA',
                        regime: pos.regime, session: pos.session, dayType: pos.dayType, directionScore: pos.score,
                        leverage: pos.leverage, barsHeld: bar - pos.entryBar,
                        underwaterBars: pos.underwaterBars,
                    });
                    openPositions.delete(ticker);
                }
            }

            // --- Pass 2: 신규 진입 (v31: 실전 lightScan + fullScan 동일 로직) ---

            for (const ticker of validTickers) {
                if (openPositions.has(ticker)) continue;
                // ★ SL 쿨다운 제거
                if (openPositions.size >= maxPositions) break;

                const klines1m = klineMap.get(ticker)!;
                if (bar >= klines1m.length) continue;
                const candle = klines1m[bar];
                const window = klines1m.slice(Math.max(0, bar - 100), bar + 1);
                if (window.length < 52) continue;

                // ── lightScan 동일: 1m 방향 감지 (lightScan 게이트용) ──
                const dirResult = this.scanner.detectDirection(window, candle.close);
                if (!dirResult.side || dirResult.score < 50) continue;
                // ★ dirMultiplier는 1m score 기준 (실전 lightScan 동일)
                const preDirection: 'Long' | 'Short' = config.directionBias?.reverseMode
                    ? (dirResult.side === 'Long' ? 'Short' : 'Long') : dirResult.side;

                const dirMultiplier = preDirection === 'Long'
                    ? (config.directionBias?.longMultiplier ?? 1.0)
                    : (config.directionBias?.shortMultiplier ?? 0.0);
                if (dirResult.score * dirMultiplier < 25) continue;

                // ── lightScan 동일: ADX gate ──
                const adxGateMin = config.filters?.adxGateMinimum ?? 20;
                const adxArr = calculateADX(window, 14);
                const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
                if (adx > 0 && adx < adxGateMin) continue;

                // ── lightScan 동일: Ignition Fast 4-gate (★ v31 NEW, v36: config.filters 경로로 통일) ──
                const IGNITION_BASELINE = 7;
                const IGNITION_RECENT = 3;
                const igThreshold = (config.filters as any)?.ignitionScoreThreshold ?? 0.7;
                const igVolMin = (config.filters as any)?.ignitionVolMin ?? 2.0;
                const igBodyMin = (config.filters as any)?.ignitionBodyMin ?? 0.5;
                const igConsecMin = (config.filters as any)?.ignitionConsecMin ?? 2;
                let ignitionFast = false;
                if (window.length >= IGNITION_BASELINE + IGNITION_RECENT + 1) {
                    const baseStart = window.length - 1 - IGNITION_BASELINE - IGNITION_RECENT;
                    let baselineVolSum = 0;
                    for (let b = baseStart; b < baseStart + IGNITION_BASELINE; b++) {
                        baselineVolSum += window[b].volume;
                    }
                    let recentVolSum = 0;
                    for (let b = window.length - 1 - IGNITION_RECENT; b < window.length; b++) {
                        recentVolSum += window[b].volume;
                    }
                    const baselineAvgVol = baselineVolSum / IGNITION_BASELINE;
                    const recentAvgVol = recentVolSum / IGNITION_RECENT;
                    const igVolSpike = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : 0;
                    const prevClose = window[window.length - 1 - IGNITION_RECENT].close;
                    const curClose = window[window.length - 1].close;
                    const priceChangePct = prevClose > 0 ? Math.abs((curClose - prevClose) / prevClose) * 100 : 0;
                    const igScore = priceChangePct * igVolSpike;

                    // 몸통비율 (실전 동일)
                    let bodyRatioSum = 0;
                    for (let b = window.length - 1 - IGNITION_RECENT; b < window.length; b++) {
                        const k = window[b];
                        const range = k.high - k.low;
                        bodyRatioSum += range > 0 ? Math.abs(k.close - k.open) / range : 0;
                    }
                    const bodyRatio = bodyRatioSum / IGNITION_RECENT;

                    // 연속방향 (실전 동일)
                    const lastK = window[window.length - 1];
                    const lastDir = lastK.close >= lastK.open ? 1 : -1;
                    let consecutive = 0;
                    for (let b = window.length - 1; b > window.length - 2 - IGNITION_RECENT && b >= 0; b--) {
                        const k = window[b];
                        const d = k.close >= k.open ? 1 : -1;
                        if (d === lastDir) consecutive++;
                        else break;
                    }

                    if (igScore >= igThreshold && igVolSpike >= igVolMin
                        && bodyRatio >= igBodyMin && consecutive >= igConsecMin) {
                        ignitionFast = true;
                    }
                }
                if (!ignitionFast) continue;  // ★ Ignition 필수 (실전 동일)

                // ★ volatilityAccel 필터 제거 — 이그니션 4-gate가 이미 가격변동+볼륨 확인
                // ATR 가속도는 "이미 변동 중"인 종목(-28% 등)을 놓치는 문제 있음

                // ── lightScan 동일: RSI extremes (1m 방향 기준 — lightScan 게이트) ──
                const closes = window.map(k => k.close);
                const rsiArr = calculateRSI(closes, 14);
                const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
                if (preDirection === 'Long' && rsi > 85) continue;
                if (preDirection === 'Short' && rsi < 25) continue;

                // ── ★ v36: 지표 게이트 ON/OFF (옵티마이저/실전 동기화) ──
                const gates = config.filters;
                if (gates?.useWaveTrend) {
                    const wt = calculateWaveTrend(window);
                    if (wt) {
                        if (preDirection === 'Long' && !(wt.wt1 > wt.wt2 || wt.wt1 < -53)) continue;
                        if (preDirection === 'Short' && !(wt.wt1 < wt.wt2 || wt.wt1 > 53)) continue;
                    }
                }
                if (gates?.useIchimoku) {
                    const ichi = calculateIchimoku(window);
                    if (ichi) {
                        if (preDirection === 'Long' && !((ichi.priceVsCloud === 'ABOVE' && ichi.tkCross !== 'BEARISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BULLISH'))) continue;
                        if (preDirection === 'Short' && !((ichi.priceVsCloud === 'BELOW' && ichi.tkCross !== 'BULLISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BEARISH'))) continue;
                    }
                }
                if (gates?.useVWAP) {
                    const vwapData = calculateVWAP(window, 24);
                    if (vwapData && vwapData.stdDev > 0) {
                        const vwapDev = (candle.close - vwapData.vwap) / vwapData.stdDev;
                        if (preDirection === 'Long' && vwapDev > 2.0) continue;
                        if (preDirection === 'Short' && vwapDev < -2.0) continue;
                    }
                }
                if (gates?.useMFI) {
                    const mfiArr = calculateMFI(window, 14);
                    if (mfiArr.length > 0) {
                        const mfi = mfiArr[mfiArr.length - 1];
                        if (preDirection === 'Long' && mfi > 80) continue;
                        if (preDirection === 'Short' && mfi < 20) continue;
                    }
                }
                if (gates?.useHurst) {
                    const hurst = closes.length >= 100 ? calculateHurstExponent(closes) : 0.5;
                    if (hurst < 0.35) continue;
                }

                // ── fullScan 동일: MTF 합의 (★ v31 NEW) ──
                const tc = tfCache.get(ticker)!;
                const kl15m = klineMap15m.get(ticker)!;
                const kl1h = klineMap1h.get(ticker)!;
                const barTime = candle.time;

                // 15m 캐시 업데이트 (optimizerEngine 패턴: O(1) amortized)
                if (kl15m.length > 0) {
                    while (tc.running15mIdx < kl15m.length - 2 && kl15m[tc.running15mIdx + 1].time <= barTime) {
                        tc.running15mIdx++;
                    }
                    if (tc.running15mIdx !== tc.idx15m && kl15m.length > 20) {
                        tc.idx15m = tc.running15mIdx;
                        const w15m = kl15m.slice(Math.max(0, tc.idx15m - 60), tc.idx15m + 1);
                        if (w15m.length >= 20) {
                            const d15m = this.scanner.detectDirection(w15m, w15m[w15m.length - 1].close);
                            tc.dir15m = d15m.side;
                            tc.score15m = d15m.score;
                        }
                    }
                }

                // 1h 캐시 업데이트 + 레짐
                if (kl1h.length > 0) {
                    while (tc.running1hIdx < kl1h.length - 2 && kl1h[tc.running1hIdx + 1].time <= barTime) {
                        tc.running1hIdx++;
                    }
                    if (tc.running1hIdx !== tc.idx1h && kl1h.length > 20) {
                        tc.idx1h = tc.running1hIdx;
                        const w1h = kl1h.slice(Math.max(0, tc.idx1h - 60), tc.idx1h + 1);
                        if (w1h.length >= 20) {
                            const d1h = this.scanner.detectDirection(w1h, w1h[w1h.length - 1].close);
                            tc.dir1h = d1h.side;
                            tc.score1h = d1h.score;
                            try {
                                const reg1h = await this.scanner.classifyRegime(ticker, w1h);
                                tc.regime1h = reg1h.simpleRegime;
                                tc.tpMult1h = reg1h.tradingImplications?.tpMultiplier ?? 1.0;
                                tc.slMult1h = reg1h.tradingImplications?.slMultiplier ?? 1.0;
                            } catch { /* default */ }
                        }
                    }
                }

                // 1h 우선, 없으면 1m 폴백 (실전 동일)
                const primaryDir = tc.dir1h ?? dirResult.side;
                if (!primaryDir) continue;

                let tfConsensus = 0;
                if (tc.dir1h) {
                    if (dirResult.side === primaryDir) tfConsensus++;
                    if (tc.dir15m === primaryDir) tfConsensus++;
                    tfConsensus++; // 1h 자신
                } else {
                    tfConsensus = 1; // 1m 자신
                    if (tc.dir15m === dirResult.side) tfConsensus++;
                }

                const minTfConsensus = (config.filters as any)?.minTfConsensus ?? 2;
                if (tfConsensus < minTfConsensus) continue;  // ★ MTF 합의 필수

                // ★ 실전/시뮬 동기화: 진입 방향은 1h 우선 (primaryDir), reverseMode 적용
                const direction: 'Long' | 'Short' = config.directionBias?.reverseMode
                    ? (primaryDir === 'Long' ? 'Short' : 'Long') : primaryDir;

                // ── TP/SL + 포지션 생성 (기존 유지, 1h 레짐 우선) ──
                let regimeResult: RegimeResult;
                try {
                    regimeResult = await this.scanner.classifyRegime(ticker, window);
                } catch { continue; }

                const atrArr = calculateATR(window, 14);
                const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : candle.close * 0.01;

                // ★ v46: 실전 동기화 — 현재 캔들 종가로 진입 (실전은 currentPrice = close)
                if (bar + 1 >= klines1m.length) continue;
                const entryPrice = candle.close;

                const isAgg = maxPositions <= 1;
                // ★ 실전 동일: 1h 레짐 우선 적용
                const effectiveRegime = tc.regime1h ?? regimeResult.simpleRegime;
                const entryConfig = config;
                const leverage = calcLeverageWithRegimeCap(entryConfig, effectiveRegime);
                // ★ 진입 방향 score: 1h 우선 (실전/시뮬 동일)
                const primaryScore = tc.dir1h ? tc.score1h : dirResult.score;
                const tpsl = this.execution.calculateTPSL({
                    price: entryPrice, direction,
                    atr, config: entryConfig, leverage,
                    regimeTpMultiplier: tc.tpMult1h ?? regimeResult.tradingImplications?.tpMultiplier ?? 1.0,
                    regimeSlMultiplier: tc.slMult1h ?? regimeResult.tradingImplications?.slMultiplier ?? 1.0,
                    isAggressive: isAgg,
                });

                openPositions.set(ticker, {
                    entryBar: bar + 1, direction,
                    entryPrice: entryPrice,
                    tp1Price: tpsl.tp1Price, tp2Price: tpsl.tpPrice, slPrice: tpsl.slPrice,
                    leverage, regime: effectiveRegime,
                    ...getSessionAndDayType(klines1m[bar + 1].time),  // ★ v36: 세션/주말평일 태깅
                    score: primaryScore,
                    tp1Hit: false, tp1PnlRealized: 0, entryTime: klines1m[bar + 1].time,
                    underwaterBars: 0,
                });
            }

            // UI yield
            if (bar % 100 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        // 종목별 결과 집계
        const tickerResults: BacktestTickerResult[] = [];
        for (const [ticker, trades] of tickerTradesMap) {
            if (trades.length === 0) continue;
            const wins = trades.filter(t => t.pnlPercent > 0).length;
            const winPnls = trades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
            const lossPnls = trades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);
            // ★ per-ticker PnL: 단순합산 (복리 X — 비현실적 수조% 방지)
            const simplePnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
            let peak = 0, maxDD = 0, cumPnl = 0;
            for (const t of trades) {
                cumPnl += t.pnlPercent;
                if (cumPnl > peak) peak = cumPnl;
                const dd = peak - cumPnl;
                if (dd > maxDD) maxDD = dd;
            }

            const avgUnderwaterMinutes = trades.length > 0
                ? (trades.reduce((s, t) => s + t.underwaterBars, 0) / trades.length) * 1
                : 0;
            const avgHoldingMinutes = trades.length > 0
                ? (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) * 1
                : 0;

            tickerResults.push({
                ticker, trades, totalTrades: trades.length,
                wins, losses: trades.length - wins,
                winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
                totalPnlPercent: simplePnl,
                avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
                avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
                maxDrawdownPercent: maxDD,
                avgUnderwaterMinutes,
                avgHoldingMinutes,
            });
        }

        return this.aggregateResults(tickerResults, config, startTime);
    }

    // ── Rolling Scanner 백테스트 ──
    // 봇의 실제 동작을 시뮬: 매 scanInterval마다 "그 시점 기준 급등/급락" 종목을 재스캔
    // 100-200개 코인 kline을 먼저 캐시 → 시간축 순회하며 동적으로 종목 선정

    async runRolling(config: TradingConfig, topN: number = DEFAULT_TOP_MOVERS, klineCount: number = DEFAULT_KLINE_COUNT, scanIntervalBars: number = 24, maxPositions: number = 99): Promise<BacktestSummary> {
        const startTime = Date.now();
        this.aborted = false;

        // Phase 1: 거래량 상위 코인 전체 목록 (최대 100개)
        this.onProgress?.('전체 코인 목록 조회 중...', 0);
        const allTickers = await this.fetchTopMovers(0); // 0 = 전체
        const pool = allTickers.slice(0, 100); // 상위 100개로 제한

        if (pool.length === 0) throw new Error('조건에 맞는 종목이 없습니다.');

        // Phase 2: 전체 kline 캐시
        const klineMap = new Map<string, KlineData[]>();
        for (let i = 0; i < pool.length; i++) {
            if (this.aborted) break;
            const ticker = pool[i];
            this.onProgress?.(`데이터 수집: ${ticker} (${i + 1}/${pool.length})`, Math.round((i / pool.length) * 40));
            try {
                const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', klineCount);
                if (klines.length >= WARMUP_BARS + scanIntervalBars) {
                    klineMap.set(ticker, klines);
                }
            } catch { /* skip */ }
            if (i < pool.length - 1) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');
        if (klineMap.size === 0) throw new Error('유효한 종목 데이터가 없습니다.');

        // 공통 시간축 (가장 짧은 kline 길이 기준)
        const minLen = Math.min(...Array.from(klineMap.values()).map(k => k.length));
        const totalBars = minLen;

        // Phase 3: Rolling scan — 매 scanIntervalBars 마다 급등/급락 재계산
        const tickerTradesMap = new Map<string, BacktestTrade[]>(); // 종목별 누적 거래
        const openPositions = new Map<string, SimPosition>(); // 현재 보유 포지션

        let scannedTickers: string[] = [];

        for (let bar = WARMUP_BARS; bar < totalBars; bar++) {
            if (this.aborted) break;

            // scanInterval 마다 종목 재스캔
            if ((bar - WARMUP_BARS) % scanIntervalBars === 0) {
                scannedTickers = this.selectTopMoversAtBar(klineMap, bar, topN, scanIntervalBars);
                const pct = 40 + Math.round(((bar - WARMUP_BARS) / (totalBars - WARMUP_BARS)) * 60);
                this.onProgress?.(`Bar ${bar}/${totalBars} | 스캔: ${scannedTickers.length}종목`, pct);
            }

            // 현재 활성 종목들에 대해 bar-by-bar 시뮬레이션
            for (const ticker of new Set([...scannedTickers, ...openPositions.keys()])) {
                const klines = klineMap.get(ticker);
                if (!klines || bar >= klines.length) continue;

                const candle = klines[bar];
                const window = klines.slice(Math.max(0, bar - 100), bar + 1);
                const position = openPositions.get(ticker) || null;

                // 포지션 있으면 출구 체크
                if (position) {
                    const exit = this.resolveExit(position, candle);
                    if (exit) {
                        const pnl = this.calculateTradePnl(position, exit);
                        if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                        tickerTradesMap.get(ticker)!.push({
                            ticker,
                            direction: position.direction,
                            entryPrice: position.entryPrice,
                            exitPrice: exit.exitPrice,
                            entryTime: position.entryTime,
                            exitTime: candle.time,
                            tp1Price: position.tp1Price,
                            tp2Price: position.tp2Price,
                            slPrice: position.slPrice,
                            pnlPercent: pnl,
                            exitReason: exit.reason,
                            regime: position.regime, session: position.session, dayType: position.dayType,
                            directionScore: position.score,
                            leverage: position.leverage,
                            barsHeld: bar - position.entryBar,
                            underwaterBars: position.underwaterBars,
                        });
                        openPositions.delete(ticker);
                    }

                    // v31: maxHoldingBars 삭제 — 실전에서 비활성화됨

                    // ★ 물려있는 시간 카운트 (exit 안 된 포지션)
                    if (openPositions.has(ticker)) {
                        const pos = openPositions.get(ticker)!;
                        const isLong = pos.direction === 'Long';
                        if ((isLong && candle.close < pos.entryPrice) || (!isLong && candle.close > pos.entryPrice)) {
                            pos.underwaterBars++;
                        }
                    }

                    // 마지막 바 강제 청산
                    if (openPositions.has(ticker) && bar === totalBars - 1) {
                        const pos = openPositions.get(ticker)!;
                        const forcedExit: ExitResult = {
                            exitPrice: candle.close,
                            reason: 'END_OF_DATA',
                            partialRealized: pos.tp1PnlRealized,
                        };
                        const pnl = this.calculateTradePnl(pos, forcedExit);
                        if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                        tickerTradesMap.get(ticker)!.push({
                            ticker,
                            direction: pos.direction,
                            entryPrice: pos.entryPrice,
                            exitPrice: candle.close,
                            entryTime: pos.entryTime,
                            exitTime: candle.time,
                            tp1Price: pos.tp1Price,
                            tp2Price: pos.tp2Price,
                            slPrice: pos.slPrice,
                            pnlPercent: pnl,
                            exitReason: 'END_OF_DATA',
                            regime: pos.regime, session: pos.session, dayType: pos.dayType,
                            directionScore: pos.score,
                            leverage: pos.leverage,
                            barsHeld: bar - pos.entryBar,
                            underwaterBars: pos.underwaterBars,
                        });
                        openPositions.delete(ticker);
                    }

                    continue;
                }

                // 스캔된 종목만 신규 진입 가능 + maxPositions 제한
                if (!scannedTickers.includes(ticker)) continue;
                if (openPositions.size >= maxPositions) continue;
                if (window.length < 52) continue;

                // 진입 신호 (기존 로직)
                const dirResult = this.scanner.detectDirection(window, candle.close);
                if (!dirResult.side || dirResult.score < 50) continue;
                const direction: 'Long' | 'Short' = config.directionBias?.reverseMode
                    ? (dirResult.side === 'Long' ? 'Short' : 'Long') : dirResult.side;

                const dirMultiplier = direction === 'Long'
                    ? (config.directionBias?.longMultiplier ?? 1.0)
                    : (config.directionBias?.shortMultiplier ?? 0.0);
                if (dirResult.score * dirMultiplier < 25) continue;

                const adxGateMin = config.filters?.adxGateMinimum ?? 20;  // ★ v36: 실전 동기화 (18→20)
                const adxArr = calculateADX(window, 14);
                const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
                if (adx > 0 && adx < adxGateMin) continue;

                const closes = window.map(k => k.close);
                const rsiArr = calculateRSI(closes, 14);
                const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
                if (direction === 'Long' && rsi > 85) continue;
                if (direction === 'Short' && rsi < 25) continue;

                // ★ v36: 지표 게이트 (백테스트-실전 동기화)
                const gates = config.filters;

                // WaveTrend 게이트
                if (gates?.useWaveTrend) {
                    const wt = calculateWaveTrend(window);
                    if (wt) {
                        if (direction === 'Long') {
                            const bullish = wt.wt1 > wt.wt2;
                            const oversoldBounce = wt.wt1 < -53;
                            if (!bullish && !oversoldBounce) continue;
                        }
                        if (direction === 'Short') {
                            const bearish = wt.wt1 < wt.wt2;
                            const overboughtRev = wt.wt1 > 53;
                            if (!bearish && !overboughtRev) continue;
                        }
                    }
                }

                // Ichimoku 게이트
                if (gates?.useIchimoku) {
                    const ichi = calculateIchimoku(window);
                    if (ichi) {
                        if (direction === 'Long') {
                            const aboveOk = ichi.priceVsCloud === 'ABOVE' && ichi.tkCross !== 'BEARISH';
                            const breakoutOk = ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BULLISH';
                            if (!aboveOk && !breakoutOk) continue;
                        }
                        if (direction === 'Short') {
                            const belowOk = ichi.priceVsCloud === 'BELOW' && ichi.tkCross !== 'BULLISH';
                            const breakdownOk = ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BEARISH';
                            if (!belowOk && !breakdownOk) continue;
                        }
                    }
                }

                // VWAP 과확장 게이트
                if (gates?.useVWAP) {
                    const vwapData = calculateVWAP(window, 24);
                    if (vwapData) {
                        const dev = (candle.close - vwapData.vwap) / (vwapData.stdDev || 1);
                        if (direction === 'Long' && dev > 2.0) continue;   // 매수 과확장
                        if (direction === 'Short' && dev < -2.0) continue; // 매도 과확장
                    }
                }

                // MFI 볼륨 확인 게이트
                if (gates?.useMFI) {
                    const mfiArr = calculateMFI(window, 14);
                    if (mfiArr.length > 0) {
                        const mfi = mfiArr[mfiArr.length - 1];
                        if (direction === 'Long' && mfi > 80) continue;   // 과매수 = 롱 위험
                        if (direction === 'Short' && mfi < 20) continue;  // 과매도 = 숏 위험
                    }
                }

                // Hurst 레짐 보강 게이트
                if (gates?.useHurst) {
                    const closes = window.map(k => k.close);
                    const hurst = calculateHurstExponent(closes);
                    // H < 0.4 = 평균회귀 → 트렌드 추종 진입 차단 (방향성 약함)
                    // H > 0.6 = 강한 추세 → 역추세 진입 주의 (이미 RSI로 커버)
                    if (hurst < 0.35) continue;  // 너무 노이즈한 시장 → 진입 무의미
                }

                let regimeResult: RegimeResult;
                try {
                    regimeResult = await this.scanner.classifyRegime(ticker, window);
                } catch { continue; }

                const simpleRegime = regimeResult.simpleRegime;

                const atrArr = calculateATR(window, 14);
                const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : candle.close * 0.01;

                // ★ v46: 실전 동기화 — 현재 캔들 종가로 진입
                const tickerKlines = klineMap.get(ticker)!;
                if (bar + 1 >= tickerKlines.length) continue;
                const entryPrice2 = candle.close;

                const isAgg2 = maxPositions <= 1 && (config.sizing?.baseSizePercent ?? 20) >= 80;
                // ★ RANGING TP 캡 (실전과 동일)
                const entryConfig2 = config;
                // ★ 실전 동일: slAtrMultiplier → 레버리지 결정 + 레짐캡 적용
                const leverage = calcLeverageWithRegimeCap(entryConfig2, simpleRegime);
                // ★ 실제 레버리지로 TPSL 계산
                const tpsl = this.execution.calculateTPSL({
                    price: entryPrice2,
                    direction,
                    atr, config: entryConfig2, leverage,
                    regimeTpMultiplier: regimeResult.tradingImplications?.tpMultiplier ?? 1.0,
                    regimeSlMultiplier: regimeResult.tradingImplications?.slMultiplier ?? 1.0,
                    isAggressive: isAgg2,
                });

                openPositions.set(ticker, {
                    entryBar: bar + 1,
                    direction,
                    entryPrice: entryPrice2,
                    tp1Price: tpsl.tp1Price,
                    tp2Price: tpsl.tpPrice,
                    slPrice: tpsl.slPrice,
                    leverage,
                    regime: simpleRegime,
                    ...getSessionAndDayType(tickerKlines[bar + 1].time),  // ★ v36: 세션/주말평일 태깅
                    score: dirResult.score,
                    tp1Hit: false,
                    tp1PnlRealized: 0,
                    entryTime: tickerKlines[bar + 1].time,
                    underwaterBars: 0,
                });
            }

            // UI yield
            if (bar % 100 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        // 종목별 결과 집계
        const tickerResults: BacktestTickerResult[] = [];
        for (const [ticker, trades] of tickerTradesMap) {
            if (trades.length === 0) continue;
            const wins = trades.filter(t => t.pnlPercent > 0).length;
            const winPnls = trades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
            const lossPnls = trades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);
            // ★ per-ticker PnL: 단순합산 (복리 X)
            const simplePnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
            let peak2 = 0, maxDD2 = 0, cumPnl2 = 0;
            for (const t of trades) {
                cumPnl2 += t.pnlPercent;
                if (cumPnl2 > peak2) peak2 = cumPnl2;
                const dd = peak2 - cumPnl2;
                if (dd > maxDD2) maxDD2 = dd;
            }

            const avgUnderwaterMinutes2 = trades.length > 0
                ? (trades.reduce((s, t) => s + t.underwaterBars, 0) / trades.length) * 1
                : 0;
            const avgHoldingMinutes2 = trades.length > 0
                ? (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) * 1
                : 0;

            tickerResults.push({
                ticker,
                trades,
                totalTrades: trades.length,
                wins,
                losses: trades.length - wins,
                winRate: (wins / trades.length) * 100,
                totalPnlPercent: simplePnl,
                avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
                avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
                maxDrawdownPercent: maxDD2,
                avgUnderwaterMinutes: avgUnderwaterMinutes2,
                avgHoldingMinutes: avgHoldingMinutes2,
            });
        }

        return this.aggregateResults(tickerResults, config, startTime);
    }

    // 특정 bar 시점에서 "급등/급락" 종목 선정
    // 직전 scanIntervalBars 동안의 가격 변동률로 계산
    private selectTopMoversAtBar(
        klineMap: Map<string, KlineData[]>, bar: number, topN: number, lookback: number,
    ): string[] {
        const changes: { ticker: string; changePct: number }[] = [];

        for (const [ticker, klines] of klineMap) {
            if (bar >= klines.length || bar - lookback < 0) continue;
            const pastPrice = klines[bar - lookback].close;
            const currentPrice = klines[bar].close;
            if (pastPrice <= 0) continue;
            const changePct = ((currentPrice - pastPrice) / pastPrice) * 100;
            changes.push({ ticker, changePct: Math.abs(changePct) });
        }

        changes.sort((a, b) => b.changePct - a.changePct);
        return changes.slice(0, topN).map(c => c.ticker);
    }

    // ── Public: 결과 집계 (OptimizerEngine에서도 사용) ──

    aggregateResults(tickerResults: BacktestTickerResult[], config: TradingConfig, startTime: number = Date.now()): BacktestSummary {
        const allTrades = tickerResults.flatMap(r => r.trades).sort((a, b) => a.entryTime - b.entryTime);
        const totalTrades = allTrades.length;
        const totalWins = allTrades.filter(t => t.pnlPercent > 0).length;
        const totalLosses = totalTrades - totalWins;
        const winPnls = allTrades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
        const lossPnls = allTrades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);

        const baseSizePercent = config.sizing?.baseSizePercent ?? 20;
        const { curve: equityCurve, ddStats } = this.buildEquityCurve(allTrades, baseSizePercent);

        const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : 100;
        const totalPnlFromEquity = finalEquity - 100;

        return {
            tickers: tickerResults,
            totalTrades,
            totalWins,
            totalLosses,
            overallWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
            totalPnlPercent: totalPnlFromEquity,
            avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
            avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
            maxDrawdownPercent: this.calculateDrawdown(equityCurve),
            profitFactor: lossPnls.length > 0
                ? Math.abs(winPnls.reduce((s, v) => s + v, 0)) / Math.abs(lossPnls.reduce((s, v) => s + v, 0))
                : winPnls.length > 0 ? 999 : 0,
            equityCurve,
            startTime,
            endTime: Date.now(),
            durationMs: Date.now() - startTime,
            ddManagement: ddStats,
        };
    }

    // ── Public: 상위 급등/급락 종목 ──

    async fetchTopMovers(topN: number): Promise<string[]> {
        const tickers = await bybitService.fetchMarketTickers();
        const filtered = tickers
            .filter((t: any) => t.symbol.endsWith('USDT') && t.volume >= MIN_VOLUME_USD)
            .sort((a: any, b: any) => Math.abs(b.rawChangePercent) - Math.abs(a.rawChangePercent));

        // 상위 50개 후보에 대해 ignition score 계산
        const candidates = filtered.slice(0, 50).map((t: any) => t.symbol);
        const ignitionMap = await calculateIgnitionScores(candidates);

        // 정렬: igniting (score ≥ 0.5) 우선 → score 내림차순, 나머지는 24h 변동률 순
        const withScores = filtered.slice(0, 50).map((t: any) => ({
            symbol: t.symbol,
            rawChange: Math.abs(t.rawChangePercent),
            ignition: ignitionMap.get(t.symbol) || { score: 0, direction: 'up' as const },
        }));

        withScores.sort((a, b) => {
            const aIgniting = a.ignition.score >= IGNITION_THRESHOLD ? 1 : 0;
            const bIgniting = b.ignition.score >= IGNITION_THRESHOLD ? 1 : 0;
            if (aIgniting !== bIgniting) return bIgniting - aIgniting;
            if (aIgniting && bIgniting) return b.ignition.score - a.ignition.score;
            return b.rawChange - a.rawChange;
        });

        // topN === 0 이면 전체 (거래량 필터 통과한 모든 종목)
        const topSymbols = withScores.slice(0, topN > 0 ? topN : withScores.length).map(s => s.symbol);

        // 로그: igniting 종목 표시
        const igniting = withScores.filter(s => s.ignition.score >= IGNITION_THRESHOLD);
        if (igniting.length > 0) {
            console.log(`🔥 [Ignition] ${igniting.length}개 감지:`,
                igniting.slice(0, 5).map(s =>
                    `${s.symbol}(${s.ignition.direction === 'up' ? '↑' : '↓'} ${s.ignition.score.toFixed(1)})`
                ).join(', '));
        }

        return topSymbols;
    }

    // ── Public: 종목별 백테스트 (OptimizerEngine에서도 사용) ──

    async backtestTicker(
        ticker: string, klines: KlineData[], config: TradingConfig,
    ): Promise<BacktestTickerResult> {
        const trades: BacktestTrade[] = [];
        let position: SimPosition | null = null;
        let pendingZone: PendingZoneEntry | null = null;
        const adxGateMin = config.filters?.adxGateMinimum ?? 20;

        for (let bar = WARMUP_BARS; bar < klines.length; bar++) {
            if (this.aborted) break;

            const candle = klines[bar];
            const window = klines.slice(Math.max(0, bar - 100), bar + 1); // 최근 100바 (성능)

            // ── 포지션 있으면 출구 체크 ──
            if (position) {
                const exit = this.resolveExit(position, candle);
                if (exit) {
                    const pnl = this.calculateTradePnl(position, exit);
                    trades.push({
                        ticker,
                        direction: position.direction,
                        entryPrice: position.entryPrice,
                        exitPrice: exit.exitPrice,
                        entryTime: position.entryTime,
                        exitTime: candle.time,
                        tp1Price: position.tp1Price,
                        tp2Price: position.tp2Price,
                        slPrice: position.slPrice,
                        pnlPercent: pnl,
                        exitReason: exit.reason,
                        regime: position.regime, session: position.session, dayType: position.dayType,
                        directionScore: position.score,
                        leverage: position.leverage,
                        barsHeld: bar - position.entryBar,
                        underwaterBars: position.underwaterBars,
                        entryDNA: position.entryDNA,
                    });
                    position = null;
                }

                // v31: maxHoldingBars 삭제 — 실전에서 비활성화됨

                // ★ 물려있는 시간 카운트 (exit 안 된 포지션)
                if (position) {
                    const isLong = position.direction === 'Long';
                    if ((isLong && candle.close < position.entryPrice) || (!isLong && candle.close > position.entryPrice)) {
                        position.underwaterBars++;
                    }
                }

                // 마지막 캔들이면 강제 청산
                if (position && bar === klines.length - 1) {
                    const forcedExit: ExitResult = {
                        exitPrice: candle.close,
                        reason: 'END_OF_DATA',
                        partialRealized: position.tp1PnlRealized,
                    };
                    const pnl = this.calculateTradePnl(position, forcedExit);
                    trades.push({
                        ticker,
                        direction: position.direction,
                        entryPrice: position.entryPrice,
                        exitPrice: candle.close,
                        entryTime: position.entryTime,
                        exitTime: candle.time,
                        tp1Price: position.tp1Price,
                        tp2Price: position.tp2Price,
                        slPrice: position.slPrice,
                        pnlPercent: pnl,
                        exitReason: 'END_OF_DATA',
                        regime: position.regime, session: position.session, dayType: position.dayType,
                        directionScore: position.score,
                        leverage: position.leverage,
                        barsHeld: bar - position.entryBar,
                        underwaterBars: position.underwaterBars,
                        entryDNA: position.entryDNA,
                    });
                    position = null;
                }

                continue; // 포지션 있으면 신규 진입 안 함
            }

            // ── 대기 중인 존 진입 체크 ──
            if (pendingZone) {
                const barsWaited = bar - pendingZone.signalBar;
                // 존 만료 체크 (ZONE_EXPIRY_BARS 초과)
                if (barsWaited > ZONE_EXPIRY_BARS) {
                    pendingZone = null; // 만료 → 새 시그널 탐색으로 fall-through
                } else {
                    // 캔들이 존 영역과 겹치는지 체크
                    const trigger = this.checkZoneTrigger(pendingZone, candle);
                    if (trigger) {
                        // ★ 존 트리거 → 실제 진입 (진입가 = 존 내부 중간가)
                        const entryPrice = trigger.entryPrice;
                        const atrArr2 = calculateATR(window, 14);
                        const atr2 = atrArr2.length > 0 ? atrArr2[atrArr2.length - 1] : entryPrice * 0.01;
                        const isAgg2 = (config.sizing?.baseSizePercent ?? 20) >= 80;
                        // ★ RANGING TP 캡 (실전과 동일)
                        const zoneConfig = config;

                        // ★ 실전 동일: slAtrMultiplier → 레버리지 결정 + 레짐캡 적용
                        const lev2 = calcLeverageWithRegimeCap(zoneConfig, pendingZone.regime);
                        const tpsl2 = this.execution.calculateTPSL({
                            price: entryPrice, direction: pendingZone.direction, atr: atr2, config: zoneConfig,
                            leverage: lev2,
                            regimeTpMultiplier: pendingZone.regimeTpMult,
                            regimeSlMultiplier: pendingZone.regimeSlMult,
                            isAggressive: isAgg2,
                        });

                        position = {
                            entryBar: bar,
                            direction: pendingZone.direction,
                            entryPrice,
                            tp1Price: tpsl2.tp1Price,
                            tp2Price: tpsl2.tpPrice,
                            slPrice: tpsl2.slPrice,
                            leverage: lev2,
                            regime: pendingZone.regime, session: pendingZone.session, dayType: pendingZone.dayType,
                            score: pendingZone.score,
                            tp1Hit: false,
                            tp1PnlRealized: 0,
                            entryTime: candle.time,
                            underwaterBars: 0,
                            entryDNA: this.captureDNA(window, entryPrice, trigger.zoneType),
                        };
                        pendingZone = null;
                    } else if (barsWaited >= MOMENTUM_BYPASS_MIN_BARS_BT) {
                        // ★ 모멘텀 바이패스: 풀백 없이 TP 방향으로 이탈 → 현재가 진입
                        const atrArr2 = calculateATR(window, 14);
                        const currentAtr = atrArr2.length > 0 ? atrArr2[atrArr2.length - 1] : candle.close * 0.01;
                        const priceDist = pendingZone.direction === 'Long'
                            ? candle.close - pendingZone.signalPrice
                            : pendingZone.signalPrice - candle.close;
                        const distInAtr = currentAtr > 0 ? priceDist / currentAtr : 0;

                        if (distInAtr >= MOMENTUM_BYPASS_MIN_ATR_BT && distInAtr <= MOMENTUM_BYPASS_MAX_ATR_BT) {
                            const momentumPrice = candle.close;
                            const isAgg2 = (config.sizing?.baseSizePercent ?? 20) >= 80;
                            // ★ RANGING TP 캡 (실전과 동일)
                            const momConfig = config;

                            // ★ 실전 동일: slAtrMultiplier → 레버리지 결정 + 레짐캡 적용
                            const lev2 = calcLeverageWithRegimeCap(momConfig, pendingZone.regime);
                            const tpsl2 = this.execution.calculateTPSL({
                                price: momentumPrice, direction: pendingZone.direction, atr: currentAtr, config: momConfig,
                                leverage: lev2,
                                regimeTpMultiplier: pendingZone.regimeTpMult,
                                regimeSlMultiplier: pendingZone.regimeSlMult,
                                isAggressive: isAgg2,
                            });

                            position = {
                                entryBar: bar,
                                direction: pendingZone.direction,
                                entryPrice: momentumPrice,
                                tp1Price: tpsl2.tp1Price,
                                tp2Price: tpsl2.tpPrice,
                                slPrice: tpsl2.slPrice,
                                leverage: lev2,
                                regime: pendingZone.regime, session: pendingZone.session, dayType: pendingZone.dayType,
                                score: pendingZone.score,
                                tp1Hit: false,
                                tp1PnlRealized: 0,
                                entryTime: candle.time,
                                underwaterBars: 0,
                                entryDNA: this.captureDNA(window, momentumPrice, 'MOMENTUM_CHASE'),
                            };
                            pendingZone = null;
                        }
                    }
                    if (pendingZone) continue; // 존 대기 중 → 새 시그널 체크 안 함
                }
            }

            // ── 진입 신호 체크 ──
            if (window.length < 52) continue; // Ichimoku 최소

            const dirResult = this.scanner.detectDirection(window, candle.close);
            if (!dirResult.side || dirResult.score < 50) continue;
            const direction: 'Long' | 'Short' = config.directionBias?.reverseMode
                ? (dirResult.side === 'Long' ? 'Short' : 'Long') : dirResult.side;

            // 방향 바이어스
            const dirMultiplier = direction === 'Long'
                ? (config.directionBias?.longMultiplier ?? 1.0)
                : (config.directionBias?.shortMultiplier ?? 0.0);
            if (dirResult.score * dirMultiplier < 25) continue;

            // ADX 필터
            const adxGateMin2 = config.filters?.adxGateMinimum ?? 20;
            const adxArr = calculateADX(window, 14);
            const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
            if (adx > 0 && adx < adxGateMin2) continue;

            // RSI 극단 차단
            const closes = window.map(k => k.close);
            const rsiArr = calculateRSI(closes, 14);
            const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
            if (direction === 'Long' && rsi > 85) continue;
            if (direction === 'Short' && rsi < 25) continue;

            // ── ★ v36: Ignition 4-gate (run()/실전 동기화) ──
            const IGNITION_BASELINE2 = 7;
            const IGNITION_RECENT2 = 3;
            const igThreshold2 = (config.filters as any)?.ignitionScoreThreshold ?? 0.7;
            const igVolMin2 = (config.filters as any)?.ignitionVolMin ?? 2.0;
            const igBodyMin2 = (config.filters as any)?.ignitionBodyMin ?? 0.5;
            const igConsecMin2 = (config.filters as any)?.ignitionConsecMin ?? 2;
            let ignitionFast2 = false;
            if (window.length >= IGNITION_BASELINE2 + IGNITION_RECENT2 + 1) {
                const baseStart2 = window.length - 1 - IGNITION_BASELINE2 - IGNITION_RECENT2;
                let baselineVolSum2 = 0;
                for (let b = baseStart2; b < baseStart2 + IGNITION_BASELINE2; b++) baselineVolSum2 += window[b].volume;
                let recentVolSum2 = 0;
                for (let b = window.length - 1 - IGNITION_RECENT2; b < window.length; b++) recentVolSum2 += window[b].volume;
                const baselineAvgVol2 = baselineVolSum2 / IGNITION_BASELINE2;
                const recentAvgVol2 = recentVolSum2 / IGNITION_RECENT2;
                const igVolSpike2 = baselineAvgVol2 > 0 ? recentAvgVol2 / baselineAvgVol2 : 0;
                const prevClose2 = window[window.length - 1 - IGNITION_RECENT2].close;
                const curClose2 = window[window.length - 1].close;
                const priceChangePct2 = prevClose2 > 0 ? Math.abs((curClose2 - prevClose2) / prevClose2) * 100 : 0;
                const igScore2 = priceChangePct2 * igVolSpike2;
                let bodyRatioSum2 = 0;
                for (let b = window.length - 1 - IGNITION_RECENT2; b < window.length; b++) {
                    const k = window[b]; const range = k.high - k.low;
                    bodyRatioSum2 += range > 0 ? Math.abs(k.close - k.open) / range : 0;
                }
                const bodyRatio2 = bodyRatioSum2 / IGNITION_RECENT2;
                const lastK2 = window[window.length - 1];
                const lastDir2 = lastK2.close >= lastK2.open ? 1 : -1;
                let consecutive2 = 0;
                for (let b = window.length - 1; b > window.length - 2 - IGNITION_RECENT2 && b >= 0; b--) {
                    const k = window[b]; const d = k.close >= k.open ? 1 : -1;
                    if (d === lastDir2) consecutive2++; else break;
                }
                if (igScore2 >= igThreshold2 && igVolSpike2 >= igVolMin2
                    && bodyRatio2 >= igBodyMin2 && consecutive2 >= igConsecMin2) {
                    ignitionFast2 = true;
                }
            }
            if (!ignitionFast2) continue;  // ★ Ignition 필수

            // ── ★ v36: 지표 게이트 ON/OFF (run()/실전 동기화) ──
            const gates2 = config.filters;
            if (gates2?.useWaveTrend) {
                const wt = calculateWaveTrend(window);
                if (wt) {
                    if (direction === 'Long' && !(wt.wt1 > wt.wt2 || wt.wt1 < -53)) continue;
                    if (direction === 'Short' && !(wt.wt1 < wt.wt2 || wt.wt1 > 53)) continue;
                }
            }
            if (gates2?.useIchimoku) {
                const ichi = calculateIchimoku(window);
                if (ichi) {
                    if (direction === 'Long' && !((ichi.priceVsCloud === 'ABOVE' && ichi.tkCross !== 'BEARISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BULLISH'))) continue;
                    if (direction === 'Short' && !((ichi.priceVsCloud === 'BELOW' && ichi.tkCross !== 'BULLISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BEARISH'))) continue;
                }
            }
            if (gates2?.useVWAP) {
                const vwapData = calculateVWAP(window, 24);
                if (vwapData && vwapData.stdDev > 0) {
                    const vwapDev = (candle.close - vwapData.vwap) / vwapData.stdDev;
                    if (direction === 'Long' && vwapDev > 2.0) continue;
                    if (direction === 'Short' && vwapDev < -2.0) continue;
                }
            }
            if (gates2?.useMFI) {
                const mfiArr = calculateMFI(window, 14);
                if (mfiArr.length > 0) {
                    const mfi = mfiArr[mfiArr.length - 1];
                    if (direction === 'Long' && mfi > 80) continue;
                    if (direction === 'Short' && mfi < 20) continue;
                }
            }
            if (gates2?.useHurst) {
                const hurst = closes.length >= 100 ? calculateHurstExponent(closes) : 0.5;
                if (hurst < 0.35) continue;
            }

            // 레짐 분류
            let regimeResult: RegimeResult;
            try {
                regimeResult = await this.scanner.classifyRegime(ticker, window);
            } catch {
                continue;
            }

            const simpleRegime = regimeResult.simpleRegime;

            // ★ 존 생성 시도 (실전과 동일)
            const strategy: 'TREND' | 'REVERSION' = simpleRegime === 'RANGING' ? 'REVERSION' : 'TREND';
            const dmi = this.calculateDMI(window, 14);
            const { swingHighs, swingLows } = this.detectSwingPoints(window, 5);
            let zones: { type: string; minPrice: number; maxPrice: number }[] = [];
            try {
                const zoneResult = computeEntryZones(
                    window, direction, strategy,
                    regimeResult.regime, dmi, swingHighs, swingLows,
                );
                if (zoneResult.zones.length > 0) {
                    zones = zoneResult.zones.map(z => ({
                        type: z.type, minPrice: z.minPrice, maxPrice: z.maxPrice,
                    }));
                }
            } catch { /* 존 생성 실패 → fallback */ }

            if (zones.length > 0) {
                // ★ 존 생성 성공 → 대기 (실전처럼 존 도달 시 진입)
                pendingZone = {
                    signalBar: bar,
                    direction,
                    zones,
                    regime: simpleRegime,
                    ...getSessionAndDayType(candle.time),  // ★ v36: 세션/주말평일 태깅
                    score: dirResult.score,
                    signalTime: candle.time,
                    regimeTpMult: regimeResult.tradingImplications?.tpMultiplier ?? 1.0,
                    regimeSlMult: regimeResult.tradingImplications?.slMultiplier ?? 1.0,
                    signalPrice: candle.close,
                };
            } else {
                // ★ v46: 실전 동기화 — 현재 캔들 종가로 진입
                if (bar + 1 >= klines.length) continue;
                const entryPrice3 = candle.close;

                const atrArr = calculateATR(window, 14);
                const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : candle.close * 0.01;
                const isAgg3 = (config.sizing?.baseSizePercent ?? 20) >= 80;
                // ★ RANGING TP 캡 (실전과 동일)
                const fallbackConfig = config;
                // ★ 실전 동일: slAtrMultiplier → 레버리지 결정 + 레짐캡 적용
                const leverage = calcLeverageWithRegimeCap(fallbackConfig, simpleRegime);
                const tpsl = this.execution.calculateTPSL({
                    price: entryPrice3, direction, atr, config: fallbackConfig, leverage,
                    regimeTpMultiplier: regimeResult.tradingImplications?.tpMultiplier ?? 1.0,
                    regimeSlMultiplier: regimeResult.tradingImplications?.slMultiplier ?? 1.0,
                    isAggressive: isAgg3,
                });

                position = {
                    entryBar: bar + 1, direction,
                    entryPrice: entryPrice3,
                    tp1Price: tpsl.tp1Price, tp2Price: tpsl.tpPrice, slPrice: tpsl.slPrice,
                    leverage, regime: simpleRegime,
                    ...getSessionAndDayType(klines[bar + 1].time),  // ★ v36: 세션/주말평일 태깅
                    score: dirResult.score,
                    tp1Hit: false, tp1PnlRealized: 0,
                    entryTime: klines[bar + 1].time, underwaterBars: 0,
                    entryDNA: this.captureDNA(window, entryPrice3, 'IMMEDIATE'),
                };
            }
        }

        // 결과 집계
        const wins = trades.filter(t => t.pnlPercent > 0).length;
        const losses = trades.length - wins;
        const winPnls = trades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
        const lossPnls = trades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);

        const baseSizePercent = config.sizing?.baseSizePercent ?? 20;
        const { curve: tickerEquity } = this.buildEquityCurve(trades, baseSizePercent);
        const tickerFinalEquity = tickerEquity.length > 0 ? tickerEquity[tickerEquity.length - 1].equity : 100;

        const avgUnderwaterMinutes = trades.length > 0
            ? (trades.reduce((s, t) => s + t.underwaterBars, 0) / trades.length) * 1
            : 0;
        const avgHoldingMinutes = trades.length > 0
            ? (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) * 1
            : 0;

        return {
            ticker,
            trades,
            totalTrades: trades.length,
            wins,
            losses,
            winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
            totalPnlPercent: tickerFinalEquity - 100,
            avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
            avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
            maxDrawdownPercent: this.calculateDrawdown(tickerEquity),
            avgUnderwaterMinutes,
            avgHoldingMinutes,
        };
    }

    // ── Private: 존 기반 진입 헬퍼 ──

    /**
     * DMI (PDI, MDI, ADX) 계산 — zoneCalculator 입력용
     */
    private calculateDMI(klines: KlineData[], period: number = 14): { pdi: number; mdi: number; adx: number } {
        if (klines.length < period * 2) return { pdi: 0, mdi: 0, adx: 0 };
        const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
        for (let i = 1; i < klines.length; i++) {
            const h = klines[i].high, l = klines[i].low;
            const ph = klines[i - 1].high, pl = klines[i - 1].low, pc = klines[i - 1].close;
            tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            const um = h - ph, dm = pl - l;
            pdm.push(um > dm && um > 0 ? um : 0);
            mdm.push(dm > um && dm > 0 ? dm : 0);
        }
        const smooth = (data: number[], p: number) => {
            const s: number[] = [];
            let cur = 0;
            for (let i = 0; i < p; i++) cur += data[i];
            s.push(cur);
            for (let i = p; i < data.length; i++) s.push(s[s.length - 1] - (s[s.length - 1] / p) + data[i]);
            return s;
        };
        const str = smooth(tr, period), spdm = smooth(pdm, period), smdm = smooth(mdm, period);
        const lastTr = str[str.length - 1];
        const pdi = lastTr > 0 ? (spdm[spdm.length - 1] / lastTr) * 100 : 0;
        const mdi = lastTr > 0 ? (smdm[smdm.length - 1] / lastTr) * 100 : 0;
        const adxArr = calculateADX(klines, period);
        const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
        return { pdi, mdi, adx };
    }

    /**
     * Swing Point 감지 — zoneCalculator 입력용
     */
    private detectSwingPoints(klines: KlineData[], lookback: number): {
        swingHighs: SwingPoint[]; swingLows: SwingPoint[];
    } {
        const swingHighs: SwingPoint[] = [], swingLows: SwingPoint[] = [];
        for (let i = lookback; i < klines.length - lookback; i++) {
            const cur = klines[i];
            let isHigh = true, isLow = true;
            for (let j = 1; j <= lookback; j++) {
                if (cur.high <= klines[i - j].high || cur.high <= klines[i + j].high) isHigh = false;
                if (cur.low >= klines[i - j].low || cur.low >= klines[i + j].low) isLow = false;
            }
            if (isHigh) swingHighs.push({ index: i, price: cur.high, timestamp: cur.time });
            if (isLow) swingLows.push({ index: i, price: cur.low, timestamp: cur.time });
        }
        return { swingHighs, swingLows };
    }

    /**
     * 존 트리거 체크: 캔들의 [low, high]가 존과 겹치는지 확인
     * 겹치면 존 내부 중간가를 진입가로 반환
     */
    private checkZoneTrigger(
        pending: PendingZoneEntry, candle: KlineData,
    ): { entryPrice: number; zoneType: string } | null {
        for (const zone of pending.zones) {
            // 캔들 범위와 존이 겹치는지
            if (candle.low <= zone.maxPrice && candle.high >= zone.minPrice) {
                // 겹치는 영역의 중간가 = 진입가
                const overlapMin = Math.max(candle.low, zone.minPrice);
                const overlapMax = Math.min(candle.high, zone.maxPrice);
                const entryPrice = (overlapMin + overlapMax) / 2;
                return { entryPrice, zoneType: zone.type };
            }
        }
        return null;
    }

    /**
     * Trade DNA 캡처: 진입 시점의 시장 조건 스냅샷
     */
    private captureDNA(window: KlineData[], entryPrice: number, zoneType: string): TradeDNA {
        const adxArr = calculateADX(window, 14);
        const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
        const closes = window.map(k => k.close);
        const rsiArr = calculateRSI(closes, 14);
        const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
        const ema20 = calculateEMA(closes, 20).pop() || entryPrice;
        const ema50 = calculateEMA(closes, 50).pop() || entryPrice;
        const ema200 = closes.length >= 200 ? (calculateEMA(closes, 200).pop() || entryPrice) : entryPrice;
        const atrArr = calculateATR(window, 14);
        const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : entryPrice * 0.01;
        const atrPercent = atr / entryPrice;

        return {
            zoneType,
            adx, rsi, atrPercent,
            adxRange: adx < 20 ? 'WEAK' : adx < 30 ? 'MID' : 'STRONG',
            rsiZone: rsi < 35 ? 'OVERSOLD' : rsi > 65 ? 'OVERBOUGHT' : 'NEUTRAL',
            emaAlignment: ema20 > ema50 && ema50 > ema200 ? 'BULLISH'
                         : ema200 > ema50 && ema50 > ema20 ? 'BEARISH' : 'MIXED',
            volatility: atrPercent < 0.008 ? 'LOW' : atrPercent > 0.02 ? 'HIGH' : 'NORMAL',
        };
    }

    // ── Private: First-Hit 바 해결 (v36 — Bybit 실전 동기화) ──
    //
    // 같은 캔들에서 TP와 SL 둘 다 체결될 때:
    //   양봉: open→low→high (하락 먼저) → Long=SL먼저, Short=TP먼저
    //   음봉: open→high→low (상승 먼저) → Long=TP먼저, Short=SL먼저
    //   도지: open에서 TP/SL 거리 비교 → 가까운 쪽 먼저

    // TP1 전량 청산 (트레일링 스탑 제거 — 단순 TP/SL만 사용)
    private resolveExit(position: SimPosition, candle: KlineData): ExitResult | null {
        const { direction, tp1Price } = position;
        const isLong = direction === 'Long';

        const slHit = isLong ? candle.low <= position.slPrice : candle.high >= position.slPrice;
        const tpHit = isLong ? candle.high >= tp1Price : candle.low <= tp1Price;

        if (slHit && tpHit) {
            const tpFirst = this.quantumResolve(position, candle);
            if (tpFirst) return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
            return { exitPrice: position.slPrice, reason: 'SL', partialRealized: 0 };
        }
        if (slHit) return { exitPrice: position.slPrice, reason: 'SL', partialRealized: 0 };
        if (tpHit) return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
        return null;
    }

    // ★ v36: First-Hit 결정론적 해결 (Bybit 실전 동기화)
    //
    // 캔들 내 가격 경로 추정:
    //   양봉 (close > open): open → low → high → close (하락 먼저)
    //   음봉 (close < open): open → high → low → close (상승 먼저)
    //   도지 (close ≈ open): open에서 SL/TP까지 거리로 결정
    //
    // 결과: 경로상 먼저 도달하는 레벨이 체결됨 (Bybit first-hit과 동일)
    private quantumResolve(position: SimPosition, candle: KlineData): boolean {
        const isLong = position.direction === 'Long';
        const { open, close } = candle;

        // 도지 판별: body가 전체 range의 5% 미만
        const body = Math.abs(close - open);
        const range = candle.high - candle.low;
        const isDoji = range > 0 ? (body / range) < 0.05 : true;

        if (isDoji) {
            // 도지: open에서 TP/SL까지 거리 — 가까운 쪽이 먼저 체결
            const distToTP = Math.abs(open - position.tp1Price);
            const distToSL = Math.abs(open - position.slPrice);
            return distToTP <= distToSL; // TP가 가까우면 TP 먼저
        }

        const isBullish = close > open;
        // 양봉: open→low→high (low 먼저) / 음봉: open→high→low (high 먼저)
        // Long: SL=하단, TP=상단 → 양봉이면 SL 먼저 / 음봉이면 TP 먼저
        // Short: SL=상단, TP=하단 → 양봉이면 TP 먼저 / 음봉이면 SL 먼저
        return isLong !== isBullish;
    }

    // TP 처리 — TP1 전량 청산 (실전과 동일)
    // partialQty1 = 1.0 → TP1에서 100% 포지션 종료
    private processTP(position: SimPosition, candle: KlineData): ExitResult | null {
        const { direction, tp1Price, tp1Hit } = position;
        const isLong = direction === 'Long';

        if (!tp1Hit) {
            const tpReached = isLong ? candle.high >= tp1Price : candle.low <= tp1Price;
            if (tpReached) {
                // TP1 = 전량 청산 (100%)
                return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
            }
        }
        return null;
    }

    // ── Private: PnL 계산 (전량 TP/SL + 수수료 + 레버리지) ──
    // TP1 전량 청산이므로 부분 익절 로직 제거
    // 반환값: 마진 대비 수익률 % (레버리지 적용)

    private calculateTradePnl(position: SimPosition, exit: ExitResult): number {
        const { entryPrice, direction, leverage } = position;
        const { exitPrice } = exit;

        let pnl: number;
        if (direction === 'Long') {
            pnl = (exitPrice - entryPrice) / entryPrice;
        } else {
            pnl = (entryPrice - exitPrice) / entryPrice;
        }

        // 레버리지 적용: 마진 대비 실제 수익률
        return (pnl - TOTAL_FEE_RATE) * leverage * 100; // %로 변환
    }

    // ★ 에쿼티 커브: DD 관리 제거 — 순수 승률/수익률 측정 (모든 거래 동일 비중)
    // simulation.ts와 동일하게 통일

    private buildEquityCurve(trades: BacktestTrade[], baseSizePercent: number = 20): {
        curve: { time: number; equity: number }[];
        ddStats: { tradesSkipped: number; tradesReduced: number; maxConsecutiveLosses: number; circuitBreakerHits: number };
    } {
        const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
        let equity = 100;
        let peak = 100;
        let consecutiveLosses = 0;
        let maxConsecLosses = 0;
        const sizeRatio = baseSizePercent / 100;
        const curve: { time: number; equity: number }[] = [{ time: sorted[0]?.entryTime || 0, equity: 100 }];

        for (const trade of sorted) {
            // ★ 모든 거래 동일 비중 — 연패/DD 기반 사이즈 조절 없음
            const portfolioImpact = trade.pnlPercent * sizeRatio;
            equity = Math.max(0, equity * (1 + portfolioImpact / 100));

            if (trade.pnlPercent > 0) {
                consecutiveLosses = 0;
            } else {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
            }

            // 고점 갱신
            if (equity > peak) peak = equity;

            curve.push({ time: trade.exitTime, equity });
        }

        return {
            curve,
            ddStats: { tradesSkipped: 0, tradesReduced: 0, maxConsecutiveLosses: maxConsecLosses, circuitBreakerHits: 0 },
        };
    }

    // ── Private: 최대 낙폭 ──

    private calculateDrawdown(curve: { time: number; equity: number }[]): number {
        if (curve.length === 0) return 0;
        let peak = curve[0].equity;
        let maxDD = 0;
        for (const point of curve) {
            if (point.equity > peak) peak = point.equity;
            const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
            if (dd > maxDD) maxDD = dd;
        }
        return maxDD;
    }
}

// ── Ignition Score 계산 (1분봉 기반 실시간 급등/급락 감지) ──

const IGNITION_THRESHOLD = 0.5;
const IGNITION_KLINE_COUNT = 50;  // 35 baseline + 15 recent (동일 시간대)

async function calculateIgnitionScores(
    symbols: string[]
): Promise<Map<string, { score: number; direction: 'up' | 'down' }>> {
    const result = new Map<string, { score: number; direction: 'up' | 'down' }>();
    const BATCH_SIZE = 10;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        const promises = batch.map(async (sym) => {
            try {
                const klines = await bybitService.fetchSingleTimeframeKlines(
                    sym, '1m', IGNITION_KLINE_COUNT
                );
                if (klines.length < IGNITION_KLINE_COUNT) return;

                const baseline = klines.slice(0, 35);  // 이전 35봉 (35분)
                const recent = klines.slice(35);        // 최근 15봉 (15분)

                // 가격 변화율 (최근 15봉)
                const priceChange = ((recent[recent.length - 1].close - recent[0].open) / recent[0].open) * 100;

                // 거래량 스파이크
                const baselineAvgVol = baseline.reduce((s, k) => s + k.volume, 0) / baseline.length;
                const recentAvgVol = recent.reduce((s, k) => s + k.volume, 0) / recent.length;
                const volumeSpike = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : 1;

                const score = Math.abs(priceChange) * volumeSpike;
                result.set(sym, {
                    score,
                    direction: priceChange >= 0 ? 'up' : 'down',
                });
            } catch {
                // 개별 실패 무시
            }
        });
        await Promise.all(promises);
        if (i + BATCH_SIZE < symbols.length) {
            await new Promise(r => setTimeout(r, 500));  // 배치 간 500ms 대기
        }
    }
    return result;
}
