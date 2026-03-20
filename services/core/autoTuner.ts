/**
 * MarketAwareTuner — 시장 기회 기반 파라미터 튜닝
 *
 * 3단계 접근:
 *   1. 시장 데이터에서 먹을 수 있는 변동(기회)을 먼저 찾아냄
 *   2. 거래 내역을 기회 대비 평가 (타점/방향/청산 개별 0-100점)
 *   3. 각 축의 파라미터를 독립적으로 튜닝
 *
 * 시장은 계속 바뀌므로 최근 시장 흐름에 맞춰 파라미터가 따라감.
 *
 * DataCollector 대신 Bybit API에서 가져온 BybitTradeRecord를 직접 받음.
 * v17: 10건마다 + 봇 시작 시 튜닝 (스윙은 트레이드 빈도 낮음).
 */

import type { TradingConfig, TuneEvent, KlineData, BybitTradeRecord, StratTunerStats } from '../../types';
import * as bybitService from '../bybitService';
import { calculateATR, calculateRSI, calculateEMA, calculateADX } from '../indicatorService';

function clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
}

function getSessionFromTimestamp(ts: number): string {
    const d = new Date(ts);
    const hour = d.getUTCHours();
    if (hour < 8) return 'ASIA';
    if (hour < 13) return 'EUROPE';
    return 'US';
}

// ── 시장 기회 타입 ──

interface MarketOpportunity {
    ticker: string;
    startTime: number;
    endTime: number;
    direction: 'Long' | 'Short';
    movePercent: number;          // 움직임 크기 (%)
    peakPrice: number;            // 최대 유리 가격
    startPrice: number;
    endPrice: number;
    type: 'TREND' | 'REVERSAL' | 'BREAKOUT' | 'SPIKE';
    atrAtStart: number;           // 기회 시작 시 ATR%
    durationMinutes: number;
}

interface EntryEvaluation {
    score: number;                // 0~100
    rangePosition: number;        // 0~100 (0=저점, 100=고점)
    rsiAlignment: number;         // 0~20
    chasingPenalty: number;       // -20~0
    timingScore: number;          // 기회 시작 대비 진입 타이밍
    matchedOpportunity: MarketOpportunity | null;
}

interface DirectionEvaluation {
    score: number;                // 0~100
    correctDirection: boolean;    // 30분 후 기준
    trendAligned: boolean;        // 상위 추세와 일치
    moveAfter5m: number;
    moveAfter15m: number;
    moveAfter30m: number;
    oppositeWasBetter: boolean;
}

interface ExitEvaluation {
    score: number;                // 0~100
    mfeCapture: number;           // MFE 대비 캡처율 (%)
    exitedTooEarly: boolean;      // 탈출 후 추가 유리
    exitedTooLate: boolean;       // MFE 이후 너무 오래 홀딩
    optimalExitPrice: number;     // 최적 청산가 (MFE 시점)
}

interface TradeEvaluation {
    tradeId: string;
    ticker: string;
    direction: 'Long' | 'Short';
    pnl: number;
    entry: EntryEvaluation;
    dir: DirectionEvaluation;
    exit: ExitEvaluation;
    totalScore: number;
}

interface MarketContext {
    opportunities: MarketOpportunity[];
    currentVolatility: number;        // 현재 ATR% 평균
    trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH';
    activeTickers: string[];
}

// ── 메인 클래스 ──

export class MarketAwareTuner {
    private lastTuneTime = 0;
    private lastMarketContext: MarketContext | null = null;
    private evaluationHistory: TradeEvaluation[] = [];
    private currentRecords: BybitTradeRecord[] = [];
    private readonly MAX_EVAL_HISTORY = 200;

    constructor(private config: TradingConfig) {}

    /**
     * Bybit API에서 가져온 기본 레코드에 kline 기반 지표(RSI, 볼륨 비율) 추가
     */
    async enrichTradeRecords(records: BybitTradeRecord[]): Promise<BybitTradeRecord[]> {
        // ── 티커별 1h klines 캐시 (ADX 계산용, API 호출 최소화) ──
        const klines1hCache: Record<string, KlineData[]> = {};
        const tickers = [...new Set(records.filter(r => r.rsi === 0).map(r => r.ticker))];
        for (const ticker of tickers) {
            try {
                const earliest = Math.min(...records.filter(r => r.ticker === ticker).map(r => r.timestamp));
                const klines1h = await bybitService.fetchSingleTimeframeKlines(
                    ticker, '1h', 50, earliest - 30 * 3600000,
                );
                klines1hCache[ticker] = klines1h;
                await new Promise(r => setTimeout(r, 80));
            } catch { /* 실패 시 캐시 없음 → ADX 기본값 사용 */ }
        }

        for (const record of records) {
            if (record.rsi > 0) continue; // 이미 enriched
            try {
                // v17: 1h klines 사용 (스윙 기반)
                const klines = await bybitService.fetchSingleTimeframeKlines(
                    record.ticker, '1h', 48,
                    record.timestamp - 48 * 3600000,
                );
                const before = klines.filter(k => k.time <= record.timestamp);
                if (before.length < 15) continue;

                // RSI 계산
                const closes = before.map(k => k.close);
                const rsiArr = calculateRSI(closes, 14);
                record.rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;

                // 볼륨 비율 계산
                const volumes = before.slice(-20).map(k => k.volume);
                const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
                const lastVol = before[before.length - 1].volume;
                record.volumeRatio = avgVol > 0 ? lastVol / avgVol : 1.0;

                // ── StratTuner용 추가 지표 (같은 5m klines에서 계산) ──

                // BB Position (20봉 볼린저밴드)
                if (closes.length >= 20) {
                    const bbSlice = closes.slice(-20);
                    const bbMean = bbSlice.reduce((a, b) => a + b, 0) / 20;
                    const bbStd = Math.sqrt(bbSlice.reduce((s, v) => s + (v - bbMean) ** 2, 0) / 20);
                    const bbUpper = bbMean + 2 * bbStd, bbLower = bbMean - 2 * bbStd;
                    record.bbPosition = bbUpper !== bbLower
                        ? ((record.entryPrice - bbLower) / (bbUpper - bbLower)) * 100 : 50;
                }

                // Momentum (최근 5봉)
                const r5 = before.slice(-5);
                record.momentum = r5.length >= 2
                    ? ((r5[r5.length - 1].close - r5[0].open) / r5[0].open) * 100 : 0;

                // Noise Ratio (최근 3봉 avg(range/body))
                const r3 = before.slice(-3);
                let noiseSum = 0, noiseCount = 0;
                for (const k of r3) {
                    const body = Math.abs(k.close - k.open);
                    if (body > 0) { noiseSum += (k.high - k.low) / body; noiseCount++; }
                }
                record.noiseRatio = noiseCount > 0 ? noiseSum / noiseCount : 5;

                // Range Position (최근 5봉 고저 내 위치)
                const h5 = Math.max(...r5.map(k => k.high));
                const l5 = Math.min(...r5.map(k => k.low));
                record.rangePosition = (h5 - l5) > 0
                    ? ((record.entryPrice - l5) / (h5 - l5)) * 100 : 50;

                // Consecutive Candles (진입봉 제외, 같은 방향 연속)
                const beforeEntry = before.slice(0, -1);
                let consec = 0;
                for (let i = beforeEntry.length - 1; i >= 0; i--) {
                    const k = beforeEntry[i];
                    const same = record.direction === 'Long' ? k.close > k.open : k.close < k.open;
                    if (same) consec++; else break;
                }
                record.consecutiveCandles = consec;

                // Session
                record.session = getSessionFromTimestamp(record.timestamp);

                // ADX from cached 1h klines
                const cached1h = klines1hCache[record.ticker] || [];
                const before1h = cached1h.filter(k => k.time <= record.timestamp);
                if (before1h.length >= 30) {
                    const adxArr = calculateADX(before1h, 14);
                    record.adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 20;
                } else {
                    record.adx = 20;
                }

                // API 부하 방지
                await new Promise(r => setTimeout(r, 80));
            } catch {
                // kline 조회 실패 → 기본값 유지
                if (record.rsi === 0) record.rsi = 50;
                if (record.volumeRatio === 0) record.volumeRatio = 1.0;
                record.session = getSessionFromTimestamp(record.timestamp);
                record.adx = 20;
            }
        }
        return records;
    }

    /**
     * StratTuner용 통계 빌더 — enriched 거래 레코드를 집계하여 Gemini 프롬프트 데이터 생성
     */
    buildStratTunerStats(records: BybitTradeRecord[]): StratTunerStats {
        const wins = records.filter(r => r.closedPnl > 0);
        const totalPnl = records.reduce((s, r) => s + r.closedPnl, 0);

        // 버킷 집계 헬퍼
        const groupBy = (arr: BybitTradeRecord[], keyFn: (r: BybitTradeRecord) => string) => {
            const groups: Record<string, BybitTradeRecord[]> = {};
            for (const r of arr) {
                const key = keyFn(r);
                if (!groups[key]) groups[key] = [];
                groups[key].push(r);
            }
            const result: Record<string, { count: number; wr: number; avgPnl: number }> = {};
            for (const [key, arr2] of Object.entries(groups)) {
                const w = arr2.filter(r => r.closedPnl > 0).length;
                const pnl = arr2.reduce((s, r) => s + r.closedPnl, 0);
                result[key] = {
                    count: arr2.length,
                    wr: arr2.length > 0 ? +(w / arr2.length * 100).toFixed(1) : 0,
                    avgPnl: arr2.length > 0 ? +(pnl / arr2.length).toFixed(4) : 0,
                };
            }
            return result;
        };

        const bucketize = (arr: BybitTradeRecord[], valFn: (r: BybitTradeRecord) => number, buckets: { label: string; min: number; max: number }[]) => {
            const groups: Record<string, BybitTradeRecord[]> = {};
            for (const b of buckets) groups[b.label] = [];
            for (const r of arr) {
                const v = valFn(r);
                for (const b of buckets) {
                    if (v >= b.min && v < b.max) { groups[b.label].push(r); break; }
                }
            }
            const result: Record<string, { count: number; wr: number; avgPnl: number }> = {};
            for (const b of buckets) {
                const arr2 = groups[b.label] || [];
                const w = arr2.filter(r => r.closedPnl > 0).length;
                const pnl = arr2.reduce((s, r) => s + r.closedPnl, 0);
                result[b.label] = {
                    count: arr2.length,
                    wr: arr2.length > 0 ? +(w / arr2.length * 100).toFixed(1) : 0,
                    avgPnl: arr2.length > 0 ? +(pnl / arr2.length).toFixed(4) : 0,
                };
            }
            return result;
        };

        // 필터 시뮬레이션
        const simulateFilter = (name: string, checkFn: (r: BybitTradeRecord) => boolean) => {
            const blocked = records.filter(r => checkFn(r));
            const passed = records.filter(r => !checkFn(r));
            const bWR = blocked.length > 0 ? +(blocked.filter(r => r.closedPnl > 0).length / blocked.length * 100).toFixed(1) : 0;
            const pWR = passed.length > 0 ? +(passed.filter(r => r.closedPnl > 0).length / passed.length * 100).toFixed(1) : 0;
            return {
                filter: name,
                blockedCount: blocked.length,
                blockedWR: +bWR,
                passedWR: +pWR,
                verdict: +bWR > +pWR + 5 ? 'HURTING' : +bWR < +pWR - 5 ? 'EFFECTIVE' : 'NEUTRAL',
            };
        };

        const cfg = this.config.filters;

        return {
            totalTrades: records.length,
            overallWR: records.length > 0 ? +(wins.length / records.length * 100).toFixed(1) : 0,
            overallPnl: +totalPnl.toFixed(2),

            byDirection: groupBy(records, r => r.direction),
            bySession: groupBy(records, r => r.session || 'UNKNOWN'),

            // ★ SIGNED momentum (abs() 제거 — 방향 정보 보존!)
            byMomentumBucket: bucketize(records, r => r.momentum, [
                { label: '<-1%', min: -9999, max: -1 },
                { label: '-1~-0.3%', min: -1, max: -0.3 },
                { label: '-0.3~0.3%', min: -0.3, max: 0.3 },
                { label: '0.3~1%', min: 0.3, max: 1 },
                { label: '>1%', min: 1, max: 9999 },
            ]),

            byBBPosition: bucketize(records, r => r.bbPosition, [
                { label: '0-20%', min: -999, max: 20 },
                { label: '20-40%', min: 20, max: 40 },
                { label: '40-60%', min: 40, max: 60 },
                { label: '60-80%', min: 60, max: 80 },
                { label: '80-100%', min: 80, max: 999 },
            ]),

            byNoiseRatio: bucketize(records, r => r.noiseRatio, [
                { label: '<2', min: 0, max: 2 },
                { label: '2-4', min: 2, max: 4 },
                { label: '4-6', min: 4, max: 6 },
                { label: '>6', min: 6, max: 9999 },
            ]),

            byConsecutive: groupBy(records, r => {
                const c = r.consecutiveCandles;
                if (c === 0) return '0(counter)';
                if (c <= 2) return '1-2';
                return '3+';
            }),

            byRangePosition: bucketize(records.filter(r => r.direction === 'Long'), r => r.rangePosition, [
                { label: 'Long@0-30%', min: -999, max: 30 },
                { label: 'Long@30-60%', min: 30, max: 60 },
                { label: 'Long@60-100%', min: 60, max: 999 },
            ]),

            byVolumeSpike: bucketize(records, r => r.volumeRatio, [
                { label: '<1x', min: 0, max: 1 },
                { label: '1-2x', min: 1, max: 2 },
                { label: '2-4x', min: 2, max: 4 },
                { label: '>4x', min: 4, max: 9999 },
            ]),

            filterSimulation: [
                simulateFilter('antiChasing', r => {
                    const absMom = Math.abs(r.momentum);
                    const isChase = (r.direction === 'Long' && r.momentum > (cfg.antiChasingMomentumMax ?? 0.5)) ||
                        (r.direction === 'Short' && r.momentum < -(cfg.antiChasingMomentumMax ?? 0.5));
                    const shortPosMom = r.direction === 'Short' && r.momentum > 0.05;
                    return isChase || shortPosMom;
                }),
                simulateFilter('consecutive', r => r.consecutiveCandles > (cfg.consecutiveCandleMax ?? 0)),
                simulateFilter('noiseRatio', r => r.noiseRatio > (cfg.noiseMaxRatio ?? 6)),
                simulateFilter('volumeSpike', r => r.volumeRatio > (cfg.volumeSpikeMax ?? 4)),
                simulateFilter('rsiMinShort', r => r.direction === 'Short' && r.rsi < (cfg.rsiMinShort ?? 50)),
                simulateFilter('bbPosMinShort', r => r.direction === 'Short' && r.bbPosition < (cfg.bbPositionMinShort ?? 50)),
            ],

            // ★ 교차분석: Direction × Indicator (핵심!)
            momentumByDirection: groupBy(records, r => {
                const momDir = r.momentum > 0.05 ? 'mom>0' : r.momentum < -0.05 ? 'mom<0' : 'mom~0';
                return `${r.direction}+${momDir}`;
            }),

            rsiByDirection: groupBy(records, r => {
                const rsiBucket = r.rsi < 40 ? 'RSI<40' : r.rsi <= 60 ? 'RSI40-60' : 'RSI>60';
                return `${r.direction}+${rsiBucket}`;
            }),

            bbByDirection: groupBy(records, r => {
                const bbBucket = r.bbPosition < 30 ? 'BB<30%' : r.bbPosition <= 70 ? 'BB30-70%' : 'BB>70%';
                return `${r.direction}+${bbBucket}`;
            }),

            // v17: 스윙 기반 홀딩 시간 버킷
            byHoldingTime: bucketize(records, r => r.holdingMinutes, [
                { label: '<30min', min: 0, max: 30 },
                { label: '30-60min', min: 30, max: 60 },
                { label: '1-2h', min: 60, max: 120 },
                { label: '2-4h', min: 120, max: 240 },
                { label: '4h+', min: 240, max: 99999 },
            ]),

            byADX: bucketize(records, r => r.adx ?? 20, [
                { label: '<15', min: 0, max: 15 },
                { label: '15-25', min: 15, max: 25 },
                { label: '25-40', min: 25, max: 40 },
                { label: '>40', min: 40, max: 9999 },
            ]),

            // ★ 자동 위험/기회 감지 (Gemini 토큰 절약용 요약)
            ...this.computeComboRankings(records),

            // ★ v21: 레짐 컨텍스트 — 거래 실적 기반 (BTC 의존 제거)
            regimeContext: {
                ...this.fetchRegimeFromTrades(records),
                dataWindowHours: records.length > 0
                    ? +((records[records.length - 1].closeTimestamp - records[0].timestamp) / 3600000).toFixed(1)
                    : 0,
            },
        };
    }

    /**
     * v21: 거래 실적 기반 레짐 컨텍스트 (BTC 의존 제거)
     * 최근 거래 데이터의 Long/Short WR 차이로 시장 방향 판단
     */
    fetchRegimeFromTrades(records: BybitTradeRecord[]): {
        marketTrend: 'BULL' | 'BEAR' | 'RANGE';
        longWR: number;
        shortWR: number;
        avgPnlPerTrade: number;
    } {
        if (records.length < 5) {
            return { marketTrend: 'RANGE', longWR: 50, shortWR: 50, avgPnlPerTrade: 0 };
        }

        const longs = records.filter(r => r.direction === 'Long');
        const shorts = records.filter(r => r.direction === 'Short');

        const longWR = longs.length > 0
            ? +(longs.filter(r => r.closedPnl > 0).length / longs.length * 100).toFixed(1)
            : 50;
        const shortWR = shorts.length > 0
            ? +(shorts.filter(r => r.closedPnl > 0).length / shorts.length * 100).toFixed(1)
            : 50;
        const avgPnlPerTrade = +(records.reduce((a, r) => a + r.closedPnl, 0) / records.length).toFixed(2);

        // 레짐 판단: Long/Short WR 차이 기반
        let marketTrend: 'BULL' | 'BEAR' | 'RANGE' = 'RANGE';
        const wrDiff = longWR - shortWR;
        if (wrDiff > 15 && longs.length >= 3) marketTrend = 'BULL';      // Long이 15%p 이상 우세
        else if (wrDiff < -15 && shorts.length >= 3) marketTrend = 'BEAR'; // Short이 15%p 이상 우세

        return { marketTrend, longWR, shortWR, avgPnlPerTrade };
    }

    /**
     * 모든 Direction×Indicator 조합의 WR을 계산하여 최악/최고 5개 반환
     */
    private computeComboRankings(records: BybitTradeRecord[]): {
        topDangerCombos: Array<{ combo: string; count: number; wr: number; avgPnl: number }>;
        topOpportunityCombos: Array<{ combo: string; count: number; wr: number; avgPnl: number }>;
    } {
        const combos: Record<string, BybitTradeRecord[]> = {};
        for (const r of records) {
            const keys = [
                `${r.direction}+mom${r.momentum > 0.05 ? '>0' : r.momentum < -0.05 ? '<0' : '~0'}`,
                `${r.direction}+RSI${r.rsi < 40 ? '<40' : r.rsi <= 60 ? '40-60' : '>60'}`,
                `${r.direction}+BB${r.bbPosition < 30 ? '<30%' : r.bbPosition <= 70 ? '30-70%' : '>70%'}`,
                `${r.direction}+hold${r.holdingMinutes < 5 ? '<5m' : r.holdingMinutes < 15 ? '5-15m' : '>15m'}`,
                `${r.direction}+ADX${(r.adx ?? 20) < 20 ? '<20' : '>=20'}`,
            ];
            for (const key of keys) {
                if (!combos[key]) combos[key] = [];
                combos[key].push(r);
            }
        }

        const ranked = Object.entries(combos)
            .filter(([, arr]) => arr.length >= 5) // 최소 5건
            .map(([combo, arr]) => {
                const w = arr.filter(r => r.closedPnl > 0).length;
                return {
                    combo,
                    count: arr.length,
                    wr: +(w / arr.length * 100).toFixed(1),
                    avgPnl: +(arr.reduce((s, r) => s + r.closedPnl, 0) / arr.length).toFixed(4),
                };
            });

        return {
            topDangerCombos: [...ranked].sort((a, b) => a.wr - b.wr).slice(0, 5),
            topOpportunityCombos: [...ranked].sort((a, b) => b.wr - a.wr).slice(0, 5),
        };
    }

    /**
     * Phase 1 전용 — 거래 이력 없이 시장 데이터만으로 direction multiplier 조정
     * 봇 시작 시 거래 5건 미만일 때 사용
     * @param tickers 분석할 티커 목록 (없으면 주요 티커 사용)
     */
    async tuneMarketOnly(tickers?: string[]): Promise<TuneEvent[]> {
        const events: TuneEvent[] = [];
        const targetTickers = tickers && tickers.length > 0
            ? tickers
            : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

        try {
            console.log(`[MarketTune] Phase 1 Only: ${targetTickers.length}개 티커 시장 분석...`);
            const marketContext = await this.analyzeMarketOpportunities(targetTickers);
            this.lastMarketContext = marketContext;

            console.log(`[MarketTune] 시장 상태: 추세=${marketContext.trendBias}, ` +
                `변동성=${marketContext.volatilityRegime} (ATR% avg=${marketContext.currentVolatility.toFixed(2)}), ` +
                `기회=${marketContext.opportunities.length}개`);

            // 시장 바이어스 → direction multiplier 반영
            const { trendBias } = marketContext;
            if (trendBias !== 'NEUTRAL') {
                const longMul = this.config.directionBias.longMultiplier;
                const shortMul = this.config.directionBias.shortMultiplier;

                if (trendBias === 'BULLISH') {
                    // 상승 추세: Long 소폭 강화, Short 소폭 억제
                    const newLong = clamp(longMul * 1.1, 0.3, 2.0);
                    const newShort = clamp(shortMul * 0.95, 0.3, 2.0);
                    if (Math.abs(newLong - longMul) > 0.01) {
                        this.config.directionBias.longMultiplier = Math.round(newLong * 100) / 100;
                        events.push({
                            timestamp: Date.now(),
                            parameter: 'direction.longMultiplier',
                            oldValue: Math.round(longMul * 100) / 100,
                            newValue: this.config.directionBias.longMultiplier,
                            reason: `[MarketOnly] 시장 BULLISH → Long 강화`,
                            basedOnTrades: 0,
                        });
                    }
                    if (Math.abs(newShort - shortMul) > 0.01) {
                        this.config.directionBias.shortMultiplier = Math.round(newShort * 100) / 100;
                        events.push({
                            timestamp: Date.now(),
                            parameter: 'direction.shortMultiplier',
                            oldValue: Math.round(shortMul * 100) / 100,
                            newValue: this.config.directionBias.shortMultiplier,
                            reason: `[MarketOnly] 시장 BULLISH → Short 소폭 억제`,
                            basedOnTrades: 0,
                        });
                    }
                } else if (trendBias === 'BEARISH') {
                    const newShort = clamp(shortMul * 1.1, 0.3, 2.0);
                    const newLong = clamp(longMul * 0.95, 0.3, 2.0);
                    if (Math.abs(newShort - shortMul) > 0.01) {
                        this.config.directionBias.shortMultiplier = Math.round(newShort * 100) / 100;
                        events.push({
                            timestamp: Date.now(),
                            parameter: 'direction.shortMultiplier',
                            oldValue: Math.round(shortMul * 100) / 100,
                            newValue: this.config.directionBias.shortMultiplier,
                            reason: `[MarketOnly] 시장 BEARISH → Short 강화`,
                            basedOnTrades: 0,
                        });
                    }
                    if (Math.abs(newLong - longMul) > 0.01) {
                        this.config.directionBias.longMultiplier = Math.round(newLong * 100) / 100;
                        events.push({
                            timestamp: Date.now(),
                            parameter: 'direction.longMultiplier',
                            oldValue: Math.round(longMul * 100) / 100,
                            newValue: this.config.directionBias.longMultiplier,
                            reason: `[MarketOnly] 시장 BEARISH → Long 소폭 억제`,
                            basedOnTrades: 0,
                        });
                    }
                }
            }

            if (events.length > 0) {
                this.config.lastTuneTimestamp = Date.now();
                this.config.tuneHistory.push(...events);
                if (this.config.tuneHistory.length > 100) {
                    this.config.tuneHistory = this.config.tuneHistory.slice(-100);
                }
            }
        } catch (e) {
            console.warn('[MarketAwareTuner] tuneMarketOnly error:', e);
        }

        this.lastTuneTime = Date.now();
        return events;
    }

    /**
     * 메인 튜닝 — 3단계
     * 1. 시장 기회 탐색 (최근 2시간 kline 분석)
     * 2. 거래 평가 (기회 대비 타점/방향/청산)
     * 3. 축별 파라미터 튜닝
     */
    async tune(records: BybitTradeRecord[]): Promise<TuneEvent[]> {
        if (records.length < 10) return []; // v17: 10건 최소 (스윙 빈도 낮음)

        this.currentRecords = records;
        const events: TuneEvent[] = [];
        const recentRecords = records.slice(-30); // v17: 30건 윈도우 (50→30, 학습 사이클 단축)
        const tickers = [...new Set(recentRecords.map(r => r.ticker))];

        try {
            // ── Phase 1: 시장 기회 탐색 ──
            console.log(`[MarketTune] Phase 1: ${tickers.length}개 티커 시장 기회 분석...`);
            const marketContext = await this.analyzeMarketOpportunities(tickers);
            this.lastMarketContext = marketContext;
            console.log(`[MarketTune] Phase 1 완료: ${marketContext.opportunities.length}개 기회, ` +
                `추세=${marketContext.trendBias}, 변동성=${marketContext.volatilityRegime}`);

            // ── Phase 2: 거래 평가 ──
            console.log(`[MarketTune] Phase 2: ${recentRecords.length}건 거래 평가...`);
            const evaluations = await this.evaluateRecentTrades(recentRecords, marketContext);
            this.evaluationHistory.push(...evaluations);
            if (this.evaluationHistory.length > this.MAX_EVAL_HISTORY) {
                this.evaluationHistory = this.evaluationHistory.slice(-this.MAX_EVAL_HISTORY);
            }
            if (evaluations.length > 0) {
                const avgE = evaluations.reduce((s, e) => s + e.entry.score, 0) / evaluations.length;
                const avgD = evaluations.reduce((s, e) => s + e.dir.score, 0) / evaluations.length;
                const avgX = evaluations.reduce((s, e) => s + e.exit.score, 0) / evaluations.length;
                console.log(`[MarketTune] Phase 2 완료: ${evaluations.length}건 평가 | ` +
                    `Entry=${avgE.toFixed(0)} Dir=${avgD.toFixed(0)} Exit=${avgX.toFixed(0)}`);
            }

            // ── Phase 3: 축별 튜닝 (최소 10건 평가 필요) ──
            if (this.evaluationHistory.length >= 10) {
                console.log(`[MarketTune] Phase 3: ${this.evaluationHistory.length}건 기반 파라미터 튜닝...`);
                events.push(...this.tuneEntryParams(this.evaluationHistory));
                events.push(...this.tuneDirectionParams(this.evaluationHistory, marketContext));
                events.push(...this.tuneExitParams(this.evaluationHistory));
            } else {
                console.log(`[MarketTune] Phase 3 스킵: 평가 ${this.evaluationHistory.length}건 < 10건 최소`);
            }

            if (events.length > 0) {
                this.config.lastTuneTimestamp = Date.now();
                this.config.tuneHistory.push(...events);
                if (this.config.tuneHistory.length > 100) {
                    this.config.tuneHistory = this.config.tuneHistory.slice(-100);
                }
            }
        } catch (e) {
            console.warn('[MarketAwareTuner] tune error:', e);
        }

        this.lastTuneTime = Date.now();
        return events;
    }

    getConfig(): TradingConfig {
        return this.config;
    }

    getHistory(): TuneEvent[] {
        return this.config.tuneHistory;
    }

    getLastMarketContext(): MarketContext | null {
        return this.lastMarketContext;
    }

    getEvaluationSummary(): {
        avgEntry: number; avgDir: number; avgExit: number; count: number;
    } {
        const evals = this.evaluationHistory;
        if (evals.length === 0) return { avgEntry: 0, avgDir: 0, avgExit: 0, count: 0 };
        return {
            avgEntry: evals.reduce((s, e) => s + e.entry.score, 0) / evals.length,
            avgDir: evals.reduce((s, e) => s + e.dir.score, 0) / evals.length,
            avgExit: evals.reduce((s, e) => s + e.exit.score, 0) / evals.length,
            count: evals.length,
        };
    }

    // ================================================================
    // Phase 1: 시장 기회 탐색
    // ================================================================

    private async analyzeMarketOpportunities(tickers: string[]): Promise<MarketContext> {
        const opportunities: MarketOpportunity[] = [];
        const volatilities: number[] = [];
        let bullishCount = 0, bearishCount = 0;

        for (const ticker of tickers.slice(0, 10)) {
            try {
                // v17: 최근 48시간 1h봉 (스윙 기반)
                const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '1h', 48);
                if (klines.length < 20) continue;

                // ATR 계산
                const atrArr = calculateATR(klines, 14);
                const currentAtr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 0;
                const price = klines[klines.length - 1].close;
                const atrPercent = price > 0 ? (currentAtr / price) * 100 : 0;
                volatilities.push(atrPercent);

                // 추세 판단
                const closes = klines.map(k => k.close);
                const ema20 = calculateEMA(closes, 20);
                const ema50 = calculateEMA(closes, Math.min(50, closes.length));
                if (ema20.length > 0 && ema50.length > 0) {
                    if (ema20[ema20.length - 1] > ema50[ema50.length - 1]) bullishCount++;
                    else bearishCount++;
                }

                // 의미 있는 움직임 탐색 (스윙 감지)
                const swings = this.detectSwings(klines, atrPercent);
                opportunities.push(...swings.map(s => ({ ...s, ticker })));
            } catch {
                // API 실패 → 스킵
            }
        }

        // 변동성 레짐 판단
        const avgVol = volatilities.length > 0 ? volatilities.reduce((a, b) => a + b, 0) / volatilities.length : 1;
        const volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH' =
            avgVol > 2 ? 'HIGH' : avgVol > 0.8 ? 'NORMAL' : 'LOW';

        // 추세 바이어스
        const trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
            bullishCount > bearishCount * 1.5 ? 'BULLISH' :
            bearishCount > bullishCount * 1.5 ? 'BEARISH' : 'NEUTRAL';

        return {
            opportunities,
            currentVolatility: avgVol,
            trendBias,
            volatilityRegime,
            activeTickers: tickers,
        };
    }

    /** v17: 1h봉에서 의미 있는 가격 스윙 감지 */
    private detectSwings(klines: KlineData[], atrPercent: number): Omit<MarketOpportunity, 'ticker'>[] {
        const swings: Omit<MarketOpportunity, 'ticker'>[] = [];
        // v17: 최소 움직임: ATR의 2배 또는 1% 중 큰 것 (스윙은 더 큰 움직임 타겟)
        const minMove = Math.max(atrPercent * 2.0, 1.0);

        // 슬라이딩 윈도우로 의미 있는 움직임 탐지
        for (let windowSize = 3; windowSize <= 12; windowSize += 3) {
            for (let i = 0; i <= klines.length - windowSize; i++) {
                const window = klines.slice(i, i + windowSize);
                const startPrice = window[0].open;
                const highInWindow = Math.max(...window.map(k => k.high));
                const lowInWindow = Math.min(...window.map(k => k.low));

                const upMove = ((highInWindow - startPrice) / startPrice) * 100;
                const downMove = ((startPrice - lowInWindow) / startPrice) * 100;

                // Long 기회
                if (upMove >= minMove) {
                    const overlaps = swings.some(s =>
                        s.direction === 'Long' &&
                        Math.abs(s.startTime - window[0].time) < 120 * 60000
                    );
                    if (!overlaps) {
                        swings.push({
                            startTime: window[0].time,
                            endTime: window[window.length - 1].time,
                            direction: 'Long',
                            movePercent: upMove,
                            peakPrice: highInWindow,
                            startPrice,
                            endPrice: window[window.length - 1].close,
                            type: this.classifyMoveType(window, 'Long'),
                            atrAtStart: atrPercent,
                            durationMinutes: windowSize * 60,
                        });
                    }
                }

                // Short 기회
                if (downMove >= minMove) {
                    const overlaps = swings.some(s =>
                        s.direction === 'Short' &&
                        Math.abs(s.startTime - window[0].time) < 120 * 60000
                    );
                    if (!overlaps) {
                        swings.push({
                            startTime: window[0].time,
                            endTime: window[window.length - 1].time,
                            direction: 'Short',
                            movePercent: downMove,
                            peakPrice: lowInWindow,
                            startPrice,
                            endPrice: window[window.length - 1].close,
                            type: this.classifyMoveType(window, 'Short'),
                            atrAtStart: atrPercent,
                            durationMinutes: windowSize * 60,
                        });
                    }
                }
            }
        }

        return swings;
    }

    /** 움직임 유형 분류 */
    private classifyMoveType(
        klines: KlineData[], direction: 'Long' | 'Short'
    ): 'TREND' | 'REVERSAL' | 'BREAKOUT' | 'SPIKE' {
        if (klines.length <= 1) return 'SPIKE';

        const firstBody = Math.abs(klines[0].close - klines[0].open);
        const totalBody = Math.abs(klines[klines.length - 1].close - klines[0].open);
        const firstRatio = totalBody > 0 ? firstBody / totalBody : 0;

        if (firstRatio > 0.7) return 'SPIKE';

        const sameDir = klines.every(k =>
            direction === 'Long' ? k.close >= k.open : k.close <= k.open
        );
        if (sameDir) return 'TREND';

        const half = Math.floor(klines.length / 2);
        const firstHalfMove = klines[half].close - klines[0].open;
        const secondHalfMove = klines[klines.length - 1].close - klines[half].open;
        if ((firstHalfMove > 0 && secondHalfMove < 0) || (firstHalfMove < 0 && secondHalfMove > 0)) {
            return 'REVERSAL';
        }

        return 'BREAKOUT';
    }

    // ================================================================
    // Phase 2: 거래 평가
    // ================================================================

    private async evaluateRecentTrades(
        records: BybitTradeRecord[],
        context: MarketContext,
    ): Promise<TradeEvaluation[]> {
        const evaluations: TradeEvaluation[] = [];
        const evaluatedIds = new Set(this.evaluationHistory.map(e => e.tradeId));

        for (const record of records) {
            if (evaluatedIds.has(record.id)) continue;

            try {
                // v17: 1h klines 사용 (스윙 기반 평가)
                const klines = await bybitService.fetchSingleTimeframeKlines(
                    record.ticker, '1h', 48,
                    record.timestamp - 48 * 3600000,
                );
                if (klines.length < 20) continue;

                const before = klines.filter(k => k.time <= record.timestamp);
                const after = klines.filter(k => k.time >= record.timestamp);

                const entry = this.evaluateEntry(record, before, after, context);
                const dir = this.evaluateDirection(record, before, after);
                const exit = this.evaluateExit(record, after);

                const totalScore = Math.round(entry.score * 0.35 + dir.score * 0.30 + exit.score * 0.35);

                evaluations.push({
                    tradeId: record.id,
                    ticker: record.ticker,
                    direction: record.direction,
                    pnl: record.pnlPercent,
                    entry, dir, exit,
                    totalScore,
                });

                // API 부하 방지
                await new Promise(r => setTimeout(r, 80));
            } catch {
                // 데이터 부족 → 스킵
            }
        }

        return evaluations;
    }

    private evaluateEntry(
        record: BybitTradeRecord, before: KlineData[], after: KlineData[],
        context: MarketContext,
    ): EntryEvaluation {
        let score = 0;
        const entryPrice = record.entryPrice;

        // (1) Range Position (0~30점)
        const recent = before.slice(-12);
        const hrHigh = recent.length > 0 ? Math.max(...recent.map(k => k.high)) : entryPrice;
        const hrLow = recent.length > 0 ? Math.min(...recent.map(k => k.low)) : entryPrice;
        const hrRange = hrHigh - hrLow;
        const rangePosition = hrRange > 0 ? ((entryPrice - hrLow) / hrRange) * 100 : 50;

        if (record.direction === 'Short') {
            score += Math.min(30, rangePosition * 0.3);
        } else {
            score += Math.min(30, (100 - rangePosition) * 0.3);
        }

        // (2) RSI Alignment (0~20점)
        const rsi = record.rsi || 50;
        let rsiAlignment = 0;
        if (record.direction === 'Short') {
            rsiAlignment = rsi >= 70 ? 20 : rsi >= 60 ? 15 : rsi >= 50 ? 10 : rsi >= 40 ? 5 : 0;
        } else {
            rsiAlignment = rsi <= 30 ? 20 : rsi <= 40 ? 15 : rsi <= 50 ? 10 : rsi <= 60 ? 5 : 0;
        }
        score += rsiAlignment;

        // (3) Chasing Penalty (-20~0)
        let chasingPenalty = 0;
        if (before.length >= 5) {
            const r5 = before.slice(-5);
            const mom = ((r5[r5.length - 1].close - r5[0].open) / r5[0].open) * 100;
            if (record.direction === 'Short' && mom < -0.3) {
                chasingPenalty = Math.max(-20, mom * 10);
            } else if (record.direction === 'Long' && mom > 0.3) {
                chasingPenalty = Math.max(-20, -mom * 10);
            }
        }
        score += chasingPenalty;

        // (4) Timing vs Opportunity (0~30점)
        let timingScore = 15; // 기본 중립
        const matched = context.opportunities.find(o =>
            o.ticker === record.ticker &&
            o.direction === record.direction &&
            Math.abs(o.startTime - record.timestamp) < 30 * 60000
        );
        if (matched) {
            const timeDiffMs = record.timestamp - matched.startTime;
            const timeDiffMin = timeDiffMs / 60000;
            if (timeDiffMin >= -5 && timeDiffMin <= 5) timingScore = 30;
            else if (timeDiffMin >= -10 && timeDiffMin <= 10) timingScore = 22;
            else if (timeDiffMin >= -15 && timeDiffMin <= 15) timingScore = 15;
            else timingScore = 5;
        }
        score += timingScore;

        return {
            score: Math.max(0, Math.min(100, Math.round(score))),
            rangePosition: Math.round(rangePosition),
            rsiAlignment,
            chasingPenalty: Math.round(chasingPenalty),
            timingScore,
            matchedOpportunity: matched || null,
        };
    }

    private evaluateDirection(
        record: BybitTradeRecord, before: KlineData[], after: KlineData[],
    ): DirectionEvaluation {
        let score = 0;
        const entryPrice = record.entryPrice;

        const getMove = (candles: KlineData[], idx: number): number => {
            if (after.length <= idx) return 0;
            const p = after[idx].close;
            return record.direction === 'Short'
                ? ((entryPrice - p) / entryPrice) * 100
                : ((p - entryPrice) / entryPrice) * 100;
        };

        const moveAfter5m = getMove(after, 0);
        const moveAfter15m = getMove(after, 2);
        const moveAfter30m = getMove(after, 5);

        // (1) 5분/15분/30분 후 방향 (0~40점)
        if (moveAfter5m > 0) score += 10; else if (moveAfter5m > -0.1) score += 5;
        if (moveAfter15m > 0) score += 13; else if (moveAfter15m > -0.1) score += 6;
        if (moveAfter30m > 0) score += 17; else if (moveAfter30m > -0.1) score += 8;

        // (2) 추세 일치 (0~30점)
        let trendAligned = false;
        if (before.length >= 12) {
            const closes = before.map(k => k.close);
            const c1hr = closes.slice(-12);
            const trend = ((c1hr[c1hr.length - 1] - c1hr[0]) / c1hr[0]) * 100;
            trendAligned = (record.direction === 'Long' && trend > 0.1) ||
                           (record.direction === 'Short' && trend < -0.1);
            if (trendAligned) score += 20;
            else if (Math.abs(trend) < 0.1) score += 10;
        }

        // (3) 반대 방향 비교 (0~30점)
        let oppositeWasBetter = false;
        if (after.length >= 12) {
            const myMfe = record.direction === 'Short'
                ? Math.max(...after.slice(0, 12).map(k => ((entryPrice - k.low) / entryPrice) * 100))
                : Math.max(...after.slice(0, 12).map(k => ((k.high - entryPrice) / entryPrice) * 100));
            const oppMfe = record.direction === 'Short'
                ? Math.max(...after.slice(0, 12).map(k => ((k.high - entryPrice) / entryPrice) * 100))
                : Math.max(...after.slice(0, 12).map(k => ((entryPrice - k.low) / entryPrice) * 100));

            oppositeWasBetter = oppMfe > myMfe * 1.2;
            if (myMfe > oppMfe * 1.5) score += 30;
            else if (myMfe > oppMfe) score += 20;
            else if (myMfe > oppMfe * 0.7) score += 10;
        }

        return {
            score: Math.max(0, Math.min(100, Math.round(score))),
            correctDirection: moveAfter30m > 0,
            trendAligned,
            moveAfter5m: Math.round(moveAfter5m * 1000) / 1000,
            moveAfter15m: Math.round(moveAfter15m * 1000) / 1000,
            moveAfter30m: Math.round(moveAfter30m * 1000) / 1000,
            oppositeWasBetter,
        };
    }

    private evaluateExit(record: BybitTradeRecord, after: KlineData[]): ExitEvaluation {
        let score = 0;
        const entryPrice = record.entryPrice;
        const exitPrice = record.exitPrice;

        if (after.length < 3) {
            return { score: 50, mfeCapture: 0, exitedTooEarly: false, exitedTooLate: false, optimalExitPrice: exitPrice };
        }

        const afterLimited = after.slice(0, 12);

        // MFE/MAE 계산
        let mfe: number, capture: number, mfePrice: number;
        if (record.direction === 'Short') {
            mfe = Math.max(...afterLimited.map(k => ((entryPrice - k.low) / entryPrice) * 100));
            mfePrice = Math.min(...afterLimited.map(k => k.low));
            capture = ((entryPrice - exitPrice) / entryPrice) * 100;
        } else {
            mfe = Math.max(...afterLimited.map(k => ((k.high - entryPrice) / entryPrice) * 100));
            mfePrice = Math.max(...afterLimited.map(k => k.high));
            capture = ((exitPrice - entryPrice) / entryPrice) * 100;
        }

        // (1) MFE Capture Rate (0~40점)
        const mfeCapture = mfe > 0 ? Math.min(100, (capture / mfe) * 100) : 0;
        if (mfeCapture >= 80) score += 40;
        else if (mfeCapture >= 60) score += 30;
        else if (mfeCapture >= 40) score += 20;
        else if (mfeCapture >= 20) score += 10;
        else if (capture > 0) score += 5;

        // (2) 조기/지연 청산 (0~30점)
        const exitTs = record.closeTimestamp || record.timestamp;
        const postExit = after.filter(k => k.time >= exitTs);
        let exitedTooEarly = false;
        let exitedTooLate = false;

        if (postExit.length >= 2) {
            const furtherMove = record.direction === 'Short'
                ? Math.max(...postExit.slice(0, 3).map(k => ((exitPrice - k.low) / exitPrice) * 100))
                : Math.max(...postExit.slice(0, 3).map(k => ((k.high - exitPrice) / exitPrice) * 100));

            if (furtherMove > 0.5) {
                exitedTooEarly = true;
                score += 5;
            } else if (furtherMove < 0) {
                score += 30;
            } else {
                score += 15;
            }
        } else {
            score += 15;
        }

        // MFE 시점 대비 홀딩 시간 (0~30점)
        const mfeCandleIdx = record.direction === 'Short'
            ? afterLimited.indexOf(afterLimited.reduce((best, k) => k.low < best.low ? k : best))
            : afterLimited.indexOf(afterLimited.reduce((best, k) => k.high > best.high ? k : best));
        const mfeTimeMin = (mfeCandleIdx + 1) * 5;
        const holdingMin = record.holdingMinutes;

        if (holdingMin > 0 && mfe > 0.1) {
            const overholdRatio = holdingMin / mfeTimeMin;
            if (overholdRatio >= 0.8 && overholdRatio <= 1.5) {
                score += 30;
            } else if (overholdRatio >= 0.5 && overholdRatio <= 2.0) {
                score += 20;
            } else if (overholdRatio > 3.0) {
                exitedTooLate = true;
                score += 5;
            } else {
                score += 10;
            }
        } else {
            score += 15;
        }

        return {
            score: Math.max(0, Math.min(100, Math.round(score))),
            mfeCapture: Math.round(mfeCapture * 10) / 10,
            exitedTooEarly,
            exitedTooLate,
            optimalExitPrice: mfePrice,
        };
    }

    // ================================================================
    // Phase 3: 축별 파라미터 튜닝
    // ================================================================

    /** 타점 파라미터 튜닝 */
    private tuneEntryParams(evals: TradeEvaluation[]): TuneEvent[] {
        const events: TuneEvent[] = [];
        const recent = evals.slice(-30);
        if (recent.length < 10) return events;

        const avgEntryScore = recent.reduce((s, e) => s + e.entry.score, 0) / recent.length;

        // (1) 추격 진입 비율 → 모멘텀 임계값 조정
        const chasingCount = recent.filter(e => e.entry.chasingPenalty < -5).length;
        const chasingPct = chasingCount / recent.length;

        if (chasingPct > 0.3) {
            const oldVal = this.config.filters.momentumMinScore;
            const newVal = Math.min(5, oldVal + 1);
            if (newVal !== oldVal) {
                this.config.filters.momentumMinScore = newVal;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.momentumMinScore',
                    oldValue: oldVal, newValue: newVal,
                    reason: `[Entry] 추격진입 ${(chasingPct * 100).toFixed(0)}% > 30% → 모멘텀 기준 강화`,
                    basedOnTrades: recent.length,
                });
            }
        } else if (chasingPct < 0.1 && avgEntryScore > 60) {
            const oldVal = this.config.filters.momentumMinScore;
            const newVal = Math.max(2, oldVal - 1);
            if (newVal !== oldVal) {
                this.config.filters.momentumMinScore = newVal;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.momentumMinScore',
                    oldValue: oldVal, newValue: newVal,
                    reason: `[Entry] 추격진입 ${(chasingPct * 100).toFixed(0)}% < 10% + 타점 ${avgEntryScore.toFixed(0)}점 → 기준 완화`,
                    basedOnTrades: recent.length,
                });
            }
        }

        // (2) 기회 매칭 실패 → ADX 조정
        const matchedOpp = recent.filter(e => e.entry.matchedOpportunity !== null).length;
        const matchRate = matchedOpp / recent.length;

        if (matchRate < 0.3 && avgEntryScore < 45) {
            const oldVal = this.config.filters.adxMinimum;
            const newVal = Math.min(25, oldVal + 2);
            if (newVal !== oldVal) {
                this.config.filters.adxMinimum = newVal;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.adxMinimum',
                    oldValue: oldVal, newValue: newVal,
                    reason: `[Entry] 기회매칭 ${(matchRate * 100).toFixed(0)}% + 타점 ${avgEntryScore.toFixed(0)}점 → ADX 필터 강화`,
                    basedOnTrades: recent.length,
                });
            }
        } else if (matchRate > 0.6 && avgEntryScore > 55) {
            const oldVal = this.config.filters.adxMinimum;
            const newVal = Math.max(10, oldVal - 2);
            if (newVal !== oldVal) {
                this.config.filters.adxMinimum = newVal;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.adxMinimum',
                    oldValue: oldVal, newValue: newVal,
                    reason: `[Entry] 기회매칭 ${(matchRate * 100).toFixed(0)}% + 타점 ${avgEntryScore.toFixed(0)}점 → ADX 완화`,
                    basedOnTrades: recent.length,
                });
            }
        }

        // (3) 볼륨 게이트 — 볼륨 있을 때 타점이 더 좋은지
        const withVol = recent.filter(e => {
            const r = this.findRecord(e.tradeId);
            return r && r.volumeRatio >= 1.5;
        });
        const withoutVol = recent.filter(e => {
            const r = this.findRecord(e.tradeId);
            return r && r.volumeRatio < 1.0;
        });

        if (withVol.length >= 5 && withoutVol.length >= 5) {
            const volAvgScore = withVol.reduce((s, e) => s + e.entry.score, 0) / withVol.length;
            const noVolAvgScore = withoutVol.reduce((s, e) => s + e.entry.score, 0) / withoutVol.length;

            if (volAvgScore > noVolAvgScore + 15) {
                const oldVal = this.config.filters.volumeMinRatio;
                const newVal = Math.min(2.0, oldVal + 0.2);
                if (Math.abs(newVal - oldVal) > 0.05) {
                    this.config.filters.volumeMinRatio = newVal;
                    events.push({
                        timestamp: Date.now(),
                        parameter: 'filters.volumeMinRatio',
                        oldValue: oldVal, newValue: newVal,
                        reason: `[Entry] 고볼륨 타점 ${volAvgScore.toFixed(0)} vs 저볼륨 ${noVolAvgScore.toFixed(0)} → 볼륨 기준 상향`,
                        basedOnTrades: withVol.length + withoutVol.length,
                    });
                }
            }
        }

        return events;
    }

    /** 방향 파라미터 튜닝 */
    private tuneDirectionParams(evals: TradeEvaluation[], context: MarketContext): TuneEvent[] {
        const events: TuneEvent[] = [];
        const recent = evals.slice(-30);
        if (recent.length < 10) return events;

        // (1) 방향별 정확도 기반 바이어스
        const longTrades = recent.filter(e => e.direction === 'Long');
        const shortTrades = recent.filter(e => e.direction === 'Short');

        if (longTrades.length >= 5) {
            const longCorrect = longTrades.filter(e => e.dir.correctDirection).length;
            const longAccuracy = longCorrect / longTrades.length;
            const longAvgDirScore = longTrades.reduce((s, e) => s + e.dir.score, 0) / longTrades.length;
            const oldVal = this.config.directionBias.longMultiplier;

            let newVal = oldVal;
            if (longAccuracy < 0.35 && longAvgDirScore < 40) {
                newVal = clamp(oldVal * 0.8, 0.3, 2.0);
            } else if (longAccuracy > 0.6 && longAvgDirScore > 55) {
                newVal = clamp(oldVal * 1.15, 0.3, 2.0);
            } else {
                newVal = clamp(oldVal + (1.0 - oldVal) * 0.05, 0.3, 2.0);
            }

            if (Math.abs(newVal - oldVal) > 0.01) {
                this.config.directionBias.longMultiplier = Math.round(newVal * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'direction.longMultiplier',
                    oldValue: Math.round(oldVal * 100) / 100,
                    newValue: this.config.directionBias.longMultiplier,
                    reason: `[Direction] Long 정확도 ${(longAccuracy * 100).toFixed(0)}% 방향점수 ${longAvgDirScore.toFixed(0)}`,
                    basedOnTrades: longTrades.length,
                });
            }
        }

        if (shortTrades.length >= 5) {
            const shortCorrect = shortTrades.filter(e => e.dir.correctDirection).length;
            const shortAccuracy = shortCorrect / shortTrades.length;
            const shortAvgDirScore = shortTrades.reduce((s, e) => s + e.dir.score, 0) / shortTrades.length;
            const oldVal = this.config.directionBias.shortMultiplier;

            let newVal = oldVal;
            if (shortAccuracy < 0.35 && shortAvgDirScore < 40) {
                newVal = clamp(oldVal * 0.8, 0.3, 2.0);
            } else if (shortAccuracy > 0.6 && shortAvgDirScore > 55) {
                newVal = clamp(oldVal * 1.15, 0.3, 2.0);
            } else {
                newVal = clamp(oldVal + (1.0 - oldVal) * 0.05, 0.3, 2.0);
            }

            if (Math.abs(newVal - oldVal) > 0.01) {
                this.config.directionBias.shortMultiplier = Math.round(newVal * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'direction.shortMultiplier',
                    oldValue: Math.round(oldVal * 100) / 100,
                    newValue: this.config.directionBias.shortMultiplier,
                    reason: `[Direction] Short 정확도 ${(shortAccuracy * 100).toFixed(0)}% 방향점수 ${shortAvgDirScore.toFixed(0)}`,
                    basedOnTrades: shortTrades.length,
                });
            }
        }

        // (2) 시장 흐름 반영
        if (context.trendBias !== 'NEUTRAL') {
            const bias = context.trendBias;
            const longMul = this.config.directionBias.longMultiplier;
            const shortMul = this.config.directionBias.shortMultiplier;

            if (bias === 'BULLISH' && longMul < shortMul) {
                const adj = clamp(longMul * 1.1, 0.3, 2.0);
                if (adj !== longMul) {
                    this.config.directionBias.longMultiplier = Math.round(adj * 100) / 100;
                    events.push({
                        timestamp: Date.now(),
                        parameter: 'direction.longMultiplier',
                        oldValue: Math.round(longMul * 100) / 100,
                        newValue: this.config.directionBias.longMultiplier,
                        reason: `[Direction] 시장 BULLISH편향 → Long 멀티 보정`,
                        basedOnTrades: recent.length,
                    });
                }
            } else if (bias === 'BEARISH' && shortMul < longMul) {
                const adj = clamp(shortMul * 1.1, 0.3, 2.0);
                if (adj !== shortMul) {
                    this.config.directionBias.shortMultiplier = Math.round(adj * 100) / 100;
                    events.push({
                        timestamp: Date.now(),
                        parameter: 'direction.shortMultiplier',
                        oldValue: Math.round(shortMul * 100) / 100,
                        newValue: this.config.directionBias.shortMultiplier,
                        reason: `[Direction] 시장 BEARISH편향 → Short 멀티 보정`,
                        basedOnTrades: recent.length,
                    });
                }
            }
        }

        // (3) 반대 방향이 일관되게 더 좋은 경우
        const oppBetterPct = recent.filter(e => e.dir.oppositeWasBetter).length / recent.length;
        if (oppBetterPct > 0.5) {
            for (const key of ['longMultiplier', 'shortMultiplier'] as const) {
                const oldVal = this.config.directionBias[key];
                const newVal = clamp(oldVal * 0.9, 0.3, 2.0);
                if (Math.abs(newVal - oldVal) > 0.01) {
                    this.config.directionBias[key] = Math.round(newVal * 100) / 100;
                    events.push({
                        timestamp: Date.now(),
                        parameter: `direction.${key}`,
                        oldValue: Math.round(oldVal * 100) / 100,
                        newValue: this.config.directionBias[key],
                        reason: `[Direction] 반대방향 우월 ${(oppBetterPct * 100).toFixed(0)}% → 전체 비중 축소`,
                        basedOnTrades: recent.length,
                    });
                }
            }
        }

        return events;
    }

    /** 청산 파라미터 튜닝 */
    private tuneExitParams(evals: TradeEvaluation[]): TuneEvent[] {
        const events: TuneEvent[] = [];
        const recent = evals.slice(-30);
        if (recent.length < 10) return events;

        const avgExitScore = recent.reduce((s, e) => s + e.exit.score, 0) / recent.length;

        // (1) MFE Capture Rate → TP 조정
        const avgCapture = recent.reduce((s, e) => s + e.exit.mfeCapture, 0) / recent.length;

        if (avgCapture < 30) {
            const oldTp = this.config.tpSlRatio.tpMultiplier;
            const newTp = clamp(oldTp * 0.92, 0.3, 2.0);
            if (Math.abs(newTp - oldTp) > 0.01) {
                this.config.tpSlRatio.tpMultiplier = Math.round(newTp * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'tpSlRatio.tpMultiplier',
                    oldValue: Math.round(oldTp * 100) / 100,
                    newValue: this.config.tpSlRatio.tpMultiplier,
                    reason: `[Exit] MFE캡처 ${avgCapture.toFixed(0)}% < 30% → TP 축소 (도달 가능한 TP)`,
                    basedOnTrades: recent.length,
                });
            }
        } else if (avgCapture > 70) {
            const oldTp = this.config.tpSlRatio.tpMultiplier;
            const newTp = clamp(oldTp * 1.05, 0.3, 2.0);
            if (Math.abs(newTp - oldTp) > 0.01) {
                this.config.tpSlRatio.tpMultiplier = Math.round(newTp * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'tpSlRatio.tpMultiplier',
                    oldValue: Math.round(oldTp * 100) / 100,
                    newValue: this.config.tpSlRatio.tpMultiplier,
                    reason: `[Exit] MFE캡처 ${avgCapture.toFixed(0)}% > 70% → TP 소폭 확대`,
                    basedOnTrades: recent.length,
                });
            }
        }

        // (2) 조기 청산 비율 → SL 조정
        const tooEarlyPct = recent.filter(e => e.exit.exitedTooEarly).length / recent.length;
        if (tooEarlyPct > 0.4) {
            const oldSl = this.config.tpSlRatio.slMultiplier;
            const newSl = clamp(oldSl * 1.08, 0.3, 2.0);
            if (Math.abs(newSl - oldSl) > 0.01) {
                this.config.tpSlRatio.slMultiplier = Math.round(newSl * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'tpSlRatio.slMultiplier',
                    oldValue: Math.round(oldSl * 100) / 100,
                    newValue: this.config.tpSlRatio.slMultiplier,
                    reason: `[Exit] 조기청산 ${(tooEarlyPct * 100).toFixed(0)}% > 40% → SL 여유 확대`,
                    basedOnTrades: recent.length,
                });
            }
        }

        // (3) 지연 청산 비율 → 홀딩 시간 조정
        const tooLatePct = recent.filter(e => e.exit.exitedTooLate).length / recent.length;
        if (tooLatePct > 0.3) {
            const oldHold = this.config.filters.optimalHoldingMinutes;
            const newHold = Math.max(60, Math.round(oldHold * 0.8)); // v17: 최소 60분 (스윙)
            if (Math.abs(newHold - oldHold) >= 3) {
                this.config.filters.optimalHoldingMinutes = newHold;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.optimalHoldingMinutes',
                    oldValue: oldHold, newValue: newHold,
                    reason: `[Exit] 지연청산 ${(tooLatePct * 100).toFixed(0)}% > 30% → 홀딩 시간 축소`,
                    basedOnTrades: recent.length,
                });
            }
        } else if (tooEarlyPct > tooLatePct * 2 && avgExitScore > 50) {
            const oldHold = this.config.filters.optimalHoldingMinutes;
            const newHold = Math.min(480, Math.round(oldHold * 1.15)); // v17: 최대 8시간 (스윙)
            if (Math.abs(newHold - oldHold) >= 3) {
                this.config.filters.optimalHoldingMinutes = newHold;
                events.push({
                    timestamp: Date.now(),
                    parameter: 'filters.optimalHoldingMinutes',
                    oldValue: oldHold, newValue: newHold,
                    reason: `[Exit] 조기청산이 지연의 2배 → 홀딩 시간 확대`,
                    basedOnTrades: recent.length,
                });
            }
        }

        // (4) 존 선호도 — zoneType이 'unknown'이 아닌 경우만
        const zoneScores: Record<string, { total: number; score: number }> = {};
        for (const e of recent) {
            const record = this.findRecord(e.tradeId);
            if (!record || record.zoneType === 'unknown') continue;
            const zone = record.zoneType;
            if (!zoneScores[zone]) zoneScores[zone] = { total: 0, score: 0 };
            zoneScores[zone].total++;
            zoneScores[zone].score += e.totalScore;
        }

        for (const [zone, data] of Object.entries(zoneScores)) {
            if (data.total < 3) continue;
            const avgScore = data.score / data.total;
            const oldVal = (this.config.zonePreference as Record<string, number>)[zone] ?? 1.0;
            let newVal = oldVal;

            if (avgScore >= 60) {
                newVal = clamp(oldVal * 1.1, 0.3, 2.0);
            } else if (avgScore < 35) {
                newVal = clamp(oldVal * 0.85, 0.4, 2.0);
            }

            if (Math.abs(newVal - oldVal) > 0.02) {
                (this.config.zonePreference as Record<string, number>)[zone] = Math.round(newVal * 100) / 100;
                events.push({
                    timestamp: Date.now(),
                    parameter: `zonePreference.${zone}`,
                    oldValue: Math.round(oldVal * 100) / 100,
                    newValue: Math.round(newVal * 100) / 100,
                    reason: `[Exit] ${zone} 종합점수 ${avgScore.toFixed(0)} (${data.total}건) → 선호도 조정`,
                    basedOnTrades: data.total,
                });
            }
        }

        return events;
    }

    // ── 헬퍼 ──

    private findRecord(tradeId: string): BybitTradeRecord | undefined {
        return this.currentRecords.find(r => r.id === tradeId);
    }
}
