/**
 * simulation.ts — 순수 시뮬레이션 함수 (무상태, Worker 호환)
 *
 * optimizerEngine.ts에서 추출한 핵심 시뮬레이션 로직.
 * Web Worker와 메인 스레드 양쪽에서 import하여 사용.
 * 외부 의존성 없음 (bybitService, Scanner 등 불필요).
 */

import type {
    KlineData, TradingConfig, BacktestTrade, BacktestTickerResult,
    BacktestSummary, BacktestParams, SimpleRegime, TradeDNA,
    Session, DayType,
} from '../types';
import { getSessionAndDayType } from '../types';

// ── 상수 (optimizerEngine.ts와 동일) ──

const FEE_RATE_ENTRY = 0.00055;
const FEE_RATE_EXIT = 0.00055;
const ENTRY_SLIPPAGE_RATE = 0.0008;  // ★ 백테스트 동기화: 전 엔진 통일 0.08%
const TOTAL_FEE_RATE = FEE_RATE_ENTRY + FEE_RATE_EXIT + ENTRY_SLIPPAGE_RATE;
// ★ v54: MLR 50%→20%
const MAX_LOSS_RATIO = 0.20;
const MAX_LEVERAGE_CAP = 75;
const LIQ_BUFFER_PERCENT = 0.005;
const MMR = 0.005;

// ★ 레버리지 = 레짐캡 직접 사용 (slAtrMultiplier 제거)
// SL% = 0.50 / leverage 연속공식만 적용
function calcLeverage(_config: TradingConfig, _regime: string): number {
    // ★ v49.8: 항상 최대 레버리지 사용
    // Kelly 사이징이 포지션 크기 제어 → 레버리지 최대로 SL% 최소화
    return MAX_LEVERAGE_CAP;
}

// Ignition 기본값
const IGNITION_FAST_THRESHOLD_DEFAULT = 0.7;
const IGNITION_VOL_MIN_DEFAULT = 2.0;

// ── 타입 (optimizerEngine.ts 내부 타입 re-export) ──

export interface PrecomputedBar {
    bar: number;
    candle: KlineData;
    direction: 'Long' | 'Short' | null;
    score: number;
    regime: SimpleRegime;
    atr: number;
    adx: number;
    rsi: number;
    emaAlignment: 'BULLISH' | 'BEARISH' | 'MIXED';
    regimeTpMultiplier: number;
    regimeSlMultiplier: number;
    ignitionScore: number;
    volumeSpike: number;
    ignitionBodyRatio: number;
    ignitionConsecutive: number;
    ignitionVolAccel: boolean;
    // ★ MTF (Multi-Timeframe) — optimizerEngine.ts와 동일
    regime1h: SimpleRegime;
    direction1h: 'Long' | 'Short' | null;
    dirScore1h: number;
    adx1h: number;
    regimeTpMult1h: number;
    regimeSlMult1h: number;
    direction15m: 'Long' | 'Short' | null;
    dirScore15m: number;
    tfConsensus: number;
    // ★ v31: 변동성 필터 (실전 동기화)
    volatilityAccel: number;
    volumeRatio: number;
    // ★ Trap 전략 필드
    choppinessIndex: number;
    nearestSupport: number;
    nearestResistance: number;
    trapSubmarineDetected: boolean;
    trapSubmarineSide: 'Long' | 'Short' | null;
    trapBreakPercent: number;
    trapReclaimBarsAgo: number;
    trapEngineA: boolean;   // Trend hunting: ADX>20, price vs EMA20, PDI>MDI
    trapEngineB: boolean;   // Mean reversion: ADX<45, RSI extremes + BB touch
    trapReclaimVol: number; // ★ v47: 리클레임 봉 볼륨 / 20봉 평균
    // Flow
    flowDetected: boolean;
    flowSide: 'Long' | 'Short' | null;
    flowTrendContinuity: number;
    flowVolAccel: boolean;
    flowVolSpike: number;   // ★ v47: 현재 볼륨 / 5봉 평균
    // Wick
    wickAvgRatio: number;
    wickLastUpper: number;
    wickLastLower: number;
    wickNearSupport: boolean;
    wickNearResistance: boolean;
    // Gap
    gapDetected: boolean;
    gapSide: 'Long' | 'Short' | null;
    gapSizePct: number;
    gapMidpoint: number;
    gapAgeBars: number;
}

interface SimPosition {
    entryBar: number;
    direction: 'Long' | 'Short';
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    leverage: number;
    regime: string;
    session: Session;           // ★ v36: 진입 세션
    dayType: DayType;           // ★ v36: 진입 요일
    score: number;
    tp1Hit: boolean;
    tp1PnlRealized: number;
    entryTime: number;
    underwaterBars: number;
    entryDNA?: TradeDNA;
    strategyType?: string;
    trapZoneType?: 'PULLBACK' | 'NWAVE' | 'BREAKOUT' | 'MEANREV';
}

interface ExitResult {
    exitPrice: number;
    reason: 'TP1' | 'TP2' | 'SL' | 'END_OF_DATA' | 'MAX_HOLD';
    partialRealized: number;
}

interface TPSLResult {
    tpPrice: number;
    slPrice: number;
    tp1Price: number;
    tpPercent: number;
    slPercent: number;
}

// ── TP/SL 계산 (execution.ts에서 추출, standalone) ──

export function calculateTPSL(params: {
    price: number;
    direction: 'Long' | 'Short';
    atr: number;
    config: TradingConfig;
    leverage: number;
    regimeTpMultiplier?: number;
    regimeSlMultiplier?: number;
    isAggressive?: boolean;
}): TPSLResult {
    const { price, direction, atr, config, leverage,
            regimeTpMultiplier = 1.0, regimeSlMultiplier = 1.0 } = params;
    const atrPercent = atr / price;
    const swing = config.swing;

    // ★ 연속 SL 공식: SL% × 레버리지 = 정확히 50% (모든 레버리지에서 동일 손실률)
    // 20x→2.5%, 25x→2%, 30x→1.67%, 50x→1%, 75x→0.667%
    const slPercent = MAX_LOSS_RATIO / leverage;

    // ★ ATR 기반 TP — 레버리지 캡 제거 (옵티마이저가 tpAtrMultiplier를 최적화)
    let tpPercent = atrPercent * (swing?.tpAtrMultiplier ?? 3.0) * regimeTpMultiplier;
    tpPercent += TOTAL_FEE_RATE;
    if (tpPercent < 0.005) tpPercent = 0.005;

    const tpPrice = direction === 'Long' ? price * (1 + tpPercent) : price * (1 - tpPercent);
    const slPrice = direction === 'Long' ? price * (1 - slPercent) : price * (1 + slPercent);

    // 청산가 안전 검증
    const approxLiqPrice = direction === 'Long'
        ? price * (1 - 1 / leverage + MMR)
        : price * (1 + 1 / leverage - MMR);

    let safeSl = slPrice;
    if (direction === 'Long') {
        const minSafeSl = approxLiqPrice * (1 + LIQ_BUFFER_PERCENT);
        if (safeSl < minSafeSl) safeSl = minSafeSl;
    } else {
        const maxSafeSl = approxLiqPrice * (1 - LIQ_BUFFER_PERCENT);
        if (safeSl > maxSafeSl) safeSl = maxSafeSl;
    }

    return { tpPrice, slPrice: safeSl, tp1Price: tpPrice, tpPercent, slPercent };
}

// ── 시뮬레이션 헬퍼 함수들 ──

// ★ v36: First-Hit 결정론적 해결 (Bybit 실전 동기화)
function quantumResolve(position: SimPosition, candle: KlineData): boolean {
    const isLong = position.direction === 'Long';
    const { open, close } = candle;

    const body = Math.abs(close - open);
    const range = candle.high - candle.low;
    const isDoji = range > 0 ? (body / range) < 0.05 : true;

    if (isDoji) {
        const distToTP = Math.abs(open - position.tp1Price);
        const distToSL = Math.abs(open - position.slPrice);
        return distToTP <= distToSL;
    }

    const isBullish = close > open;
    return isLong !== isBullish;
}

function resolveExit(position: SimPosition, candle: KlineData): ExitResult | null {
    const { direction, tp1Price } = position;
    const isLong = direction === 'Long';

    // SL/TP 체크 (트레일링 스탑 제거 — 단순 TP/SL만 사용)
    const slHit = isLong ? candle.low <= position.slPrice : candle.high >= position.slPrice;
    const tpHit = isLong ? candle.high >= tp1Price : candle.low <= tp1Price;

    if (slHit && tpHit) {
        const tpFirst = quantumResolve(position, candle);
        if (tpFirst) return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
        return { exitPrice: position.slPrice, reason: 'SL', partialRealized: 0 };
    }
    if (slHit) return { exitPrice: position.slPrice, reason: 'SL', partialRealized: 0 };
    if (tpHit) return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
    return null;
}

function calculateTradePnl(position: SimPosition, exit: ExitResult): number {
    const { entryPrice, direction, leverage } = position;
    let pnl: number;
    if (direction === 'Long') {
        pnl = (exit.exitPrice - entryPrice) / entryPrice;
    } else {
        pnl = (entryPrice - exit.exitPrice) / entryPrice;
    }
    return (pnl - TOTAL_FEE_RATE) * leverage * 100;
}

function buildTrade(
    ticker: string, pos: SimPosition, exit: ExitResult,
    pnl: number, exitTime: number, barsHeld: number,
): BacktestTrade {
    return {
        ticker,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: exit.exitPrice,
        entryTime: pos.entryTime,
        exitTime,
        tp1Price: pos.tp1Price,
        tp2Price: pos.tp2Price,
        slPrice: pos.slPrice,
        pnlPercent: pnl,
        exitReason: exit.reason,
        regime: pos.regime,
        session: pos.session,       // ★ v36: 세션 태깅
        dayType: pos.dayType,       // ★ v36: 주말/평일 태깅
        directionScore: pos.score,
        leverage: pos.leverage,
        barsHeld,
        underwaterBars: pos.underwaterBars,
        entryDNA: pos.entryDNA,
        strategyType: pos.strategyType,
        trapZoneType: pos.trapZoneType,
    };
}

// ── 메인 시뮬레이션 (완전 무상태) ──

export function simulateAllTickers(
    tickers: string[],
    signalMap: Map<string, PrecomputedBar[]> | { [key: string]: PrecomputedBar[] },
    config: TradingConfig,
    params: BacktestParams,
    barRange?: { start: number; end: number },
): BacktestTickerResult[] {
    const maxPos = params.maxPositions;
    const adxGateMin = params.adxGateMinimum;
    // v31: maxHoldBars 삭제 (실전 비활성화)
    const ignitionThreshold = params.ignitionScoreThreshold ?? IGNITION_FAST_THRESHOLD_DEFAULT;
    const ignitionVolMin = params.ignitionVolMin ?? IGNITION_VOL_MIN_DEFAULT;

    // signalMap을 통합 접근 (Map 또는 plain object 지원)
    const getSignals = (ticker: string): PrecomputedBar[] | undefined => {
        if (signalMap instanceof Map) return signalMap.get(ticker);
        return (signalMap as any)[ticker];
    };

    const tickerList: string[] = [];
    const signalArrays: PrecomputedBar[][] = [];
    const firstBars: number[] = [];
    let globalMinBar = Infinity;
    let globalMaxBar = -Infinity;

    for (const ticker of tickers) {
        const signals = getSignals(ticker);
        if (!signals || signals.length === 0) continue;
        tickerList.push(ticker);
        signalArrays.push(signals);
        const first = signals[0].bar;
        firstBars.push(first);
        const last = signals[signals.length - 1].bar;
        if (first < globalMinBar) globalMinBar = first;
        if (last > globalMaxBar) globalMaxBar = last;
    }

    if (tickerList.length === 0) return [];

    const effectiveMinBar = barRange ? Math.max(globalMinBar, barRange.start) : globalMinBar;
    const effectiveMaxBar = barRange ? Math.min(globalMaxBar, barRange.end) : globalMaxBar;

    const tickerToIdx = new Map<string, number>();
    tickerList.forEach((t, i) => tickerToIdx.set(t, i));

    const openPositions = new Map<string, SimPosition>();
    const tickerTradesMap = new Map<string, BacktestTrade[]>();
    // ★ SL 쿨다운 제거

    for (let bar = effectiveMinBar; bar <= effectiveMaxBar; bar++) {
        // --- Pass 1: 기존 포지션 출구 체크 ---
        for (const [ticker, pos] of [...openPositions.entries()]) {
            const ti = tickerToIdx.get(ticker)!;
            const signals = signalArrays[ti];
            const idx = bar - firstBars[ti];
            if (idx < 0 || idx >= signals.length) continue;
            const sig = signals[idx];

            const exit = resolveExit(pos, sig.candle);
            if (exit) {
                const pnl = calculateTradePnl(pos, exit);
                if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                tickerTradesMap.get(ticker)!.push(buildTrade(ticker, pos, exit, pnl, sig.candle.time, bar - pos.entryBar));
                openPositions.delete(ticker);
                // ★ SL 쿨다운 제거
                continue;
            }

            // v31: maxHoldBars 삭제 — 실전에서 비활성화됨

            const isLong = pos.direction === 'Long';
            if ((isLong && sig.candle.close < pos.entryPrice) || (!isLong && sig.candle.close > pos.entryPrice)) {
                pos.underwaterBars++;
            }

            if (idx === signals.length - 1) {
                const forcedExit: ExitResult = { exitPrice: sig.candle.close, reason: 'END_OF_DATA', partialRealized: pos.tp1PnlRealized };
                const pnl = calculateTradePnl(pos, forcedExit);
                if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                tickerTradesMap.get(ticker)!.push(buildTrade(ticker, pos, forcedExit, pnl, sig.candle.time, bar - pos.entryBar));
                openPositions.delete(ticker);
            }
        }

        // --- Pass 2: 신규 진입 (Ignition → Trap 우선순위) ---
        for (let ti = 0; ti < tickerList.length; ti++) {
            if (maxPos > 1 && openPositions.size >= maxPos) break;
            const ticker = tickerList[ti];
            if (openPositions.has(ticker)) continue;
            // ★ SL 쿨다운 제거

            const signals = signalArrays[ti];
            const idx = bar - firstBars[ti];
            if (idx < 0 || idx >= signals.length) continue;
            const sig = signals[idx];

            let enteredThisBar = false;

            const minTfConsensus = params.minTfConsensus ?? 2;

            // ★ MTF 기반 진입: 1h 방향 + TF 동의도 (optimizerEngine.ts 동일)
            const useDir = sig.direction1h ?? sig.direction;  // 1h 우선, 없으면 1m 폴백
            const useDirScore = sig.direction1h ? sig.dirScore1h : sig.score; // 기록용

            // ── Ignition 진입 체크 ──
            const ignitionPassBasic = useDir
                && sig.tfConsensus >= minTfConsensus;

            if (ignitionPassBasic) {
                // 리버스 모드: 시그널 방향 반전 (1h 방향 기준)
                const direction: 'Long' | 'Short' = params.reverseMode
                    ? (useDir === 'Long' ? 'Short' : 'Long')
                    : useDir;

                // ★ 백테스트 동기화: score × dirMultiplier < 25 이면 차단 (backtestEngine/live 동일)
                const dirMultiplier = direction === 'Long'
                    ? (config.directionBias?.longMultiplier ?? 1.0)
                    : params.shortMultiplier;

                const ignitionPassFilters = useDirScore * dirMultiplier >= 25
                    && !(sig.adx > 0 && sig.adx < adxGateMin)
                    && !(direction === 'Long' && sig.rsi > 85)
                    && !(direction === 'Short' && sig.rsi < 25);

                if (ignitionPassFilters) {
                    // ★ v36: 지표 게이트 (ON/OFF 파라미터화)
                    let indicatorGatePass = true;
                    if (params.useWaveTrend) {
                        if (direction === 'Long' && !(sig as any).wtBullish) indicatorGatePass = false;
                        if (direction === 'Short' && !(sig as any).wtBearish) indicatorGatePass = false;
                    }
                    if (indicatorGatePass && params.useIchimoku) {
                        if (direction === 'Long' && !(sig as any).ichiLongOk) indicatorGatePass = false;
                        if (direction === 'Short' && !(sig as any).ichiShortOk) indicatorGatePass = false;
                    }
                    if (indicatorGatePass && params.useVWAP) {
                        if (direction === 'Long' && ((sig as any).vwapDeviation ?? 0) > 2.0) indicatorGatePass = false;
                        if (direction === 'Short' && ((sig as any).vwapDeviation ?? 0) < -2.0) indicatorGatePass = false;
                    }
                    if (indicatorGatePass && params.useMFI) {
                        if (direction === 'Long' && ((sig as any).mfi ?? 50) > 80) indicatorGatePass = false;
                        if (direction === 'Short' && ((sig as any).mfi ?? 50) < 20) indicatorGatePass = false;
                    }
                    if (indicatorGatePass && params.useHurst) {
                        if (((sig as any).hurst ?? 0.5) < 0.35) indicatorGatePass = false;
                    }

                    if (indicatorGatePass) {
                        const isAggressive = maxPos <= 1;

                        // ★ 실전 동일: regime1h 기반 레버리지 결정
                        const effectiveRegime = sig.regime1h || sig.regime || 'TRENDING';
                        const leverage = calcLeverage(config, effectiveRegime);

                        // ★ Ignition 필수 게이트: 모든 조건 충족해야 진입
                        const igThreshold = params.ignitionScoreThreshold ?? 0.7;
                        const igVolMin = params.ignitionVolMin ?? 2.0;
                        const igBodyMin = params.ignitionBodyMin ?? 0.5;
                        const igConsecMin = params.ignitionConsecMin ?? 2;

                        if (sig.ignitionScore >= igThreshold
                            && sig.volumeSpike >= igVolMin
                            && sig.ignitionBodyRatio >= igBodyMin
                            && sig.ignitionConsecutive >= igConsecMin) {

                            // ★ Look-ahead bias 제거: 다음 캔들 시가로 진입
                            const nextIdx = idx + 1;
                            if (nextIdx < signals.length) {
                                const nextBar = signals[nextIdx];
                                const nextOpen = nextBar.candle.open;

                                // TPSL 계산 (다음 캔들 시가 기준, 1h regime 사용)
                                const tpslNext = calculateTPSL({
                                    price: nextOpen, direction, atr: sig.atr, config, leverage,
                                    regimeTpMultiplier: sig.regimeTpMult1h ?? sig.regimeTpMultiplier,
                                    regimeSlMultiplier: sig.regimeSlMult1h ?? sig.regimeSlMultiplier,
                                    isAggressive,
                                });

                                const atrPercent = sig.atr / sig.candle.close;
                                const entryDNA: TradeDNA = {
                                    zoneType: 'IGNITION_FAST',
                                    adx: sig.adx,
                                    adxRange: sig.adx < 20 ? 'WEAK' : sig.adx < 30 ? 'MID' : 'STRONG',
                                    rsi: sig.rsi,
                                    rsiZone: sig.rsi < 35 ? 'OVERSOLD' : sig.rsi > 65 ? 'OVERBOUGHT' : 'NEUTRAL',
                                    emaAlignment: sig.emaAlignment,
                                    volatility: atrPercent < 0.008 ? 'LOW' : atrPercent > 0.02 ? 'HIGH' : 'NORMAL',
                                    atrPercent,
                                };

                                // ★ v36: 진입 시점 세션/주말평일 태깅
                                const { session: entrySession, dayType: entryDayType } = getSessionAndDayType(nextBar.candle.time);
                                openPositions.set(ticker, {
                                    entryBar: bar + 1, direction, entryPrice: nextOpen,
                                    tp1Price: tpslNext.tp1Price, tp2Price: tpslNext.tpPrice, slPrice: tpslNext.slPrice,
                                    leverage, regime: effectiveRegime, session: entrySession, dayType: entryDayType,
                                    score: useDirScore,
                                    tp1Hit: false, tp1PnlRealized: 0, entryTime: nextBar.candle.time, underwaterBars: 0,
                                    entryDNA,
                                    strategyType: 'IGNITION',
                                });
                                enteredThisBar = true;
                            }
                        }
                    }
                }
            }

            // ★ Trap 전략 진입 (Ignition이 진입하지 않은 경우에만)
            if (!enteredThisBar && sig.trapSubmarineDetected && sig.trapSubmarineSide) {
                const close = sig.candle.close;
                // ★ v47: RANGING 레짐 제외
                const effectiveRegime = sig.regime1h || sig.regime || 'TRENDING';
                if ((params.trapExcludeRanging ?? true) && effectiveRegime === 'RANGING') { /* skip */ }
                else {
                const isTrend = sig.adx > (params.trapAdxTrendThreshold ?? 20);
                const isClean = sig.choppinessIndex < (params.trapChopThreshold ?? 38);
                const engineAOk = isTrend && sig.trapEngineA;
                const engineBOk = !isTrend && sig.trapEngineB;

                // ★ v47: 강화 모드
                let enginePass = engineAOk || engineBOk;
                if (params.trapRequireBothEngines && !(sig.trapEngineA && sig.trapEngineB)) enginePass = false;
                if (!params.trapRequireBothEngines && enginePass) {
                    if (engineAOk && !engineBOk && !isClean) enginePass = false;
                    if (engineBOk && !engineAOk && sig.trapBreakPercent < 0.5) enginePass = false;
                }

                // ★ v47: 리클레임 봉 볼륨 확인
                const trapVolMin = params.trapReclaimVolMin ?? 1.2;
                const volPass = !sig.trapReclaimVol || sig.trapReclaimVol >= trapVolMin;

                if (enginePass && volPass && sig.trapReclaimBarsAgo <= (params.trapReclaimMaxBars ?? 15)) {
                    const trapSide = sig.trapSubmarineSide;
                    // Check direction matches (reverseMode flips)
                    const effectiveSide: 'Long' | 'Short' = params.reverseMode
                        ? (trapSide === 'Long' ? 'Short' : 'Long')
                        : trapSide;

                    // Short multiplier 적용
                    const trapDirMultiplier = effectiveSide === 'Short' ? params.shortMultiplier : 1.0;
                    if (trapDirMultiplier <= 0) { /* skip if short disabled */ }
                    else {
                        // Determine quadrant zone type
                        let trapZoneType: 'PULLBACK' | 'NWAVE' | 'BREAKOUT' | 'MEANREV';
                        if (isTrend && isClean) trapZoneType = 'PULLBACK';
                        else if (isTrend && !isClean) trapZoneType = 'NWAVE';
                        else if (!isTrend && isClean) trapZoneType = 'BREAKOUT';
                        else trapZoneType = 'MEANREV';

                        // ★ Look-ahead bias 제거: 다음 캔들 시가로 진입
                        const nextIdx = idx + 1;
                        if (nextIdx < signals.length) {
                            const nextBar = signals[nextIdx];
                            const nextOpen = nextBar.candle.open;

                            // ★ 실전 동일: regime1h 기반 레버리지 결정
                            const effectiveRegime = sig.regime1h || sig.regime || 'TRENDING';
                            const leverage = calcLeverage(config, effectiveRegime);

                            // TP/SL based on ATR
                            const atr = sig.atr || (close * 0.01);
                            const trapTpMult = params.trapAtrTpMultiplier ?? 3.0;
                            const trapSlMult = params.trapAtrSlMultiplier ?? 2.0;
                            const trapTP = nextOpen + (effectiveSide === 'Long' ? 1 : -1) * atr * trapTpMult;
                            const trapSL = nextOpen - (effectiveSide === 'Long' ? 1 : -1) * atr * trapSlMult;

                            // 청산가 안전 검증 (Ignition과 동일)
                            const approxLiqPrice = effectiveSide === 'Long'
                                ? nextOpen * (1 - 1 / leverage + MMR)
                                : nextOpen * (1 + 1 / leverage - MMR);
                            let safeSl = trapSL;
                            if (effectiveSide === 'Long') {
                                const minSafeSl = approxLiqPrice * (1 + LIQ_BUFFER_PERCENT);
                                if (safeSl < minSafeSl) safeSl = minSafeSl;
                            } else {
                                const maxSafeSl = approxLiqPrice * (1 - LIQ_BUFFER_PERCENT);
                                if (safeSl > maxSafeSl) safeSl = maxSafeSl;
                            }

                            const atrPercent = atr / close;
                            const entryDNA: TradeDNA = {
                                zoneType: 'TRAP',
                                adx: sig.adx,
                                adxRange: sig.adx < 20 ? 'WEAK' : sig.adx < 30 ? 'MID' : 'STRONG',
                                rsi: sig.rsi,
                                rsiZone: sig.rsi < 35 ? 'OVERSOLD' : sig.rsi > 65 ? 'OVERBOUGHT' : 'NEUTRAL',
                                emaAlignment: sig.emaAlignment,
                                volatility: atrPercent < 0.008 ? 'LOW' : atrPercent > 0.02 ? 'HIGH' : 'NORMAL',
                                atrPercent,
                            };

                            const { session: entrySession, dayType: entryDayType } = getSessionAndDayType(nextBar.candle.time);
                            openPositions.set(ticker, {
                                entryBar: bar + 1, direction: effectiveSide, entryPrice: nextOpen,
                                tp1Price: trapTP, tp2Price: trapTP, slPrice: safeSl,
                                leverage, regime: effectiveRegime, session: entrySession, dayType: entryDayType,
                                score: sig.score,
                                tp1Hit: false, tp1PnlRealized: 0, entryTime: nextBar.candle.time, underwaterBars: 0,
                                entryDNA,
                                strategyType: 'TRAP',
                                trapZoneType,
                            });
                            enteredThisBar = true;
                        }
                    }
                }
                } // ★ v47: else { (RANGING skip) 닫기
            }

        }
    }
    // 미청산 포지션 강제 청산
    for (const [ticker, pos] of [...openPositions.entries()]) {
        const ti = tickerToIdx.get(ticker)!;
        const signals = signalArrays[ti];
        const lastIdx = Math.min(effectiveMaxBar - firstBars[ti], signals.length - 1);
        if (lastIdx >= 0 && lastIdx < signals.length) {
            const sig = signals[lastIdx];
            const forcedExit: ExitResult = { exitPrice: sig.candle.close, reason: 'END_OF_DATA', partialRealized: pos.tp1PnlRealized };
            const pnl = calculateTradePnl(pos, forcedExit);
            if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
            tickerTradesMap.get(ticker)!.push(buildTrade(ticker, pos, forcedExit, pnl, sig.candle.time, effectiveMaxBar - pos.entryBar));
        }
    }
    openPositions.clear();

    // 종목별 결과 집계
    const results: BacktestTickerResult[] = [];
    for (let ti = 0; ti < tickerList.length; ti++) {
        const ticker = tickerList[ti];
        const trades = tickerTradesMap.get(ticker) || [];
        const wins = trades.filter(t => t.pnlPercent > 0).length;
        const winPnls = trades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
        const lossPnls = trades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);
        const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPercent, 0) / trades.length : 0;

        let peak = 0, maxDD = 0, cumPnl = 0;
        for (const t of trades) {
            cumPnl += t.pnlPercent;
            if (cumPnl > peak) peak = cumPnl;
            const dd = peak - cumPnl;
            if (dd > maxDD) maxDD = dd;
        }

        const avgUnderwaterMinutes = trades.length > 0
            ? (trades.reduce((s, t) => s + t.underwaterBars, 0) / trades.length) * 1 : 0;
        const avgHoldingMinutes = trades.length > 0
            ? (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) * 1 : 0;

        results.push({
            ticker, trades, totalTrades: trades.length, wins,
            losses: trades.length - wins,
            winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
            totalPnlPercent: avgPnl,
            avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
            avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
            maxDrawdownPercent: maxDD,
            avgUnderwaterMinutes,
            avgHoldingMinutes,
        });
    }

    return results;
}

// ── 집계 함수 (경량) ──

export function aggregateLight(
    tickerResults: BacktestTickerResult[],
    config: TradingConfig,
): BacktestSummary {
    const allTrades = tickerResults.flatMap(r => r.trades).sort((a, b) => a.entryTime - b.entryTime);
    const totalTrades = allTrades.length;
    const totalWins = allTrades.filter(t => t.pnlPercent > 0).length;
    const totalLosses = totalTrades - totalWins;
    const winPnls = allTrades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
    const lossPnls = allTrades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);

    const baseSizePercent = config.sizing?.baseSizePercent ?? 20;
    const { curve: equityCurve, ddStats } = buildEquityCurve(allTrades, baseSizePercent);

    return {
        tickers: tickerResults,
        totalTrades, totalWins, totalLosses,
        overallWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
        totalPnlPercent: totalTrades > 0 ? allTrades.reduce((s, t) => s + t.pnlPercent, 0) / totalTrades : 0,
        avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
        avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
        maxDrawdownPercent: calculateDrawdown(equityCurve),
        profitFactor: lossPnls.length > 0
            ? Math.abs(winPnls.reduce((s, v) => s + v, 0)) / Math.abs(lossPnls.reduce((s, v) => s + v, 0))
            : winPnls.length > 0 ? 999 : 0,
        equityCurve: [],
        startTime: 0, endTime: 0, durationMs: 0,
        ddManagement: ddStats,
    };
}

// ★ v49: 에쿼티 커브 — Kelly 비중 또는 고정 비중
function buildEquityCurve(trades: BacktestTrade[], baseSizePercent: number = 20, kellyFraction?: number) {
    const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
    let equity = 100, peak = 100, maxConsecLosses = 0, consecutiveLosses = 0;
    // Kelly 있으면 Kelly 비중, 없으면 고정 baseSizePercent
    // ★ v52 가즈아: 실전 동기화 — cap 50%
    const sizeRatio = kellyFraction && kellyFraction > 0
        ? Math.min(kellyFraction, 0.50)
        : baseSizePercent / 100;
    const curve: { time: number; equity: number }[] = [{ time: sorted[0]?.entryTime || 0, equity: 100 }];

    for (const trade of sorted) {
        // ★ 모든 거래 동일 비중 — 연패/DD 기반 사이즈 조절 없음
        const portfolioImpact = trade.pnlPercent * sizeRatio;
        equity = Math.max(0, equity * (1 + portfolioImpact / 100));

        if (trade.pnlPercent > 0) consecutiveLosses = 0;
        else { consecutiveLosses++; if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses; }

        if (equity > peak) peak = equity;
        curve.push({ time: trade.exitTime, equity });
    }

    return { curve, ddStats: { tradesSkipped: 0, tradesReduced: 0, maxConsecutiveLosses: maxConsecLosses, circuitBreakerHits: 0 } };
}

function calculateDrawdown(curve: { time: number; equity: number }[]): number {
    if (curve.length === 0) return 0;
    let peak = curve[0].equity, maxDD = 0;
    for (const point of curve) {
        if (point.equity > peak) peak = point.equity;
        const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
        if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
}

// ── Fitness 함수 ──

export function calculateFitness(summary: BacktestSummary, params?: BacktestParams): number {
    const { totalPnlPercent, maxDrawdownPercent, overallWinRate, profitFactor, totalTrades } = summary;
    // ★ 최소 15건 — optimizerEngine.ts와 동일 (통계적 유의성)
    if (totalTrades < 15) return -Infinity;
    const maxDD = Math.max(maxDrawdownPercent, 0.01);
    const calmar = totalPnlPercent / maxDD;
    const wrBonus = Math.sqrt(overallWinRate / 100);
    const pfBonus = Math.min(profitFactor, 5) / 5;
    let fitness = calmar * wrBonus * (0.5 + 0.5 * pfBonus);
    // ★ 거래수 보너스: 30건+ = 신뢰도 높음 (optimizerEngine.ts 동일)
    const tradeConfidence = Math.min(totalTrades / 30, 1.5);
    fitness *= tradeConfidence;
    // 레버리지 보너스: 거래20+, 승률60%+ → 고배 선호
    if (params && totalTrades >= 20 && overallWinRate >= 60) {
        const avgLev = (params.leverageTrending + params.leverageRanging + params.leverageVolatile) / 3;
        fitness *= 1.0 + (avgLev / 75) * 0.15;
    }
    return fitness;
}

export function calculateAggressiveFitness(summary: BacktestSummary, params?: BacktestParams): number {
    const { overallWinRate, avgWinPercent, avgLossPercent, totalTrades } = summary;
    // ★ 최소 20건 — optimizerEngine.ts와 동일 (고배에서는 더 많은 표본 필요)
    if (totalTrades < 20) return -Infinity;
    const wr = overallWinRate / 100;
    const avgLoss = Math.max(Math.abs(avgLossPercent), 0.01);
    const rrRatio = Math.min(avgWinPercent / avgLoss, 10);  // 상한 10
    // ★ 거래수 보너스 강화 (optimizerEngine.ts 동일)
    const tradeBonus = Math.sqrt(totalTrades / 20);
    let fitness = wr * wr * rrRatio * tradeBonus;
    // 레버리지 보너스: 거래30+, 승률60%+ → 고배 선호
    if (params && totalTrades >= 30 && overallWinRate >= 60) {
        const avgLev = (params.leverageTrending + params.leverageRanging + params.leverageVolatile) / 3;
        fitness *= 1.0 + (avgLev / 75) * 0.25;
    }
    return fitness;
}
