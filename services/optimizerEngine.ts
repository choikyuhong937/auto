/**
 * OptimizerEngine — 파라미터 자동 최적화
 *
 * 핵심: 캔들 데이터 1회 fetch → 시그널 프리컴퓨트 → 파라미터 조합별 초고속 시뮬레이션
 * detectDirection, classifyRegime 등 무거운 연산은 config와 무관하므로 1회만 계산
 */

import type {
    KlineData, TradingConfig, BacktestTrade, BacktestTickerResult,
    BacktestSummary, BacktestParams, SimpleRegime,
    OptimizerParamRange, OptimizerComboResult, OptimizerSummary,
    WalkForwardWindow, WalkForwardSummary,
    TradeDNA, Session, DayType,
} from '../types';
import { applyParamsToConfig, getSessionAndDayType } from '../types';

import { Scanner, type RegimeResult } from './core/scanner';
import { Execution } from './core/execution';
import {
    calculateATR, calculateADX, calculateRSI, calculateEMA, aggregateCandles,
    calculateWaveTrend, calculateIchimoku, calculateVWAP, calculateMFI, calculateHurstExponent,
    calculateBollingerBands, calculateChoppinessIndex,
    detectSRLevels, detectSubmarinePattern, countEmaCrossings,
    calculateWickRatioDetailed, calculateTrendContinuity, detectFairValueGaps,
} from './indicatorService';
import * as bybitService from './bybitService';
import { packSignals } from './signalPacking';
import type { PackedSignals } from './signalPacking';

// ── Web Worker 병렬 실행 풀 ──

class SimWorkerPool {
    private workers: Worker[] = [];
    private busy: boolean[] = [];
    private pendingJobs: Array<{ job: any; resolve: (result: any) => void }> = [];

    constructor(count?: number) {
        // ★ v52.49: 워커 수 공격적 — 코어 - 1 (최소 2, 최대 12)
        const workerCount = count || Math.max(2, Math.min(12,
            (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) - 1,
        ));
        for (let i = 0; i < workerCount; i++) {
            const w = new Worker(new URL('./simulationWorker.ts', import.meta.url), { type: 'module' });
            this.workers.push(w);
            this.busy.push(false);
            w.onmessage = (e: MessageEvent) => this.handleResult(i, e.data);
        }
    }

    async initSignals(packed: PackedSignals): Promise<void> {
        const promises = this.workers.map((w, i) => {
            return new Promise<void>((resolve) => {
                const handler = (e: MessageEvent) => {
                    if (e.data.type === 'ready') {
                        w.removeEventListener('message', handler);
                        resolve();
                    }
                };
                w.addEventListener('message', handler);
                // Each worker needs its own copy of the buffer (ArrayBuffer can only be transferred once)
                const bufCopy = i < this.workers.length - 1 ? packed.buffer.slice(0) : packed.buffer;
                w.postMessage(
                    { type: 'init-packed', tickers: packed.tickers, counts: packed.counts, buffer: bufCopy },
                    [bufCopy],
                );
            });
        });
        await Promise.all(promises);
    }

    submitJob(job: any): Promise<any> {
        return new Promise((resolve) => {
            this.pendingJobs.push({ job, resolve });
            this.dispatch();
        });
    }

    private dispatch() {
        while (this.pendingJobs.length > 0) {
            const freeIdx = this.busy.indexOf(false);
            if (freeIdx === -1) break;
            const { job, resolve } = this.pendingJobs.shift()!;
            this.busy[freeIdx] = true;
            (this.workers[freeIdx] as any)._resolve = resolve;
            this.workers[freeIdx].postMessage(job);
        }
    }

    private handleResult(workerIdx: number, data: any) {
        this.busy[workerIdx] = false;
        const resolve = (this.workers[workerIdx] as any)._resolve;
        if (resolve) {
            (this.workers[workerIdx] as any)._resolve = null;
            resolve(data);
        }
        this.dispatch();
    }

    async runBatch(jobs: any[]): Promise<any[]> {
        return Promise.all(jobs.map(job => this.submitJob(job)));
    }

    terminate() {
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.busy = [];
        this.pendingJobs = [];
    }

    get workerCount() { return this.workers.length; }
}

// 수수료 + 슬리피지 (실전 반영)
const FEE_RATE_ENTRY = 0.00055;
const FEE_RATE_EXIT = 0.00055;
const ENTRY_SLIPPAGE_RATE = 0.0008;  // ★ 백테스트 동기화: 전 엔진 통일 0.08%
const TOTAL_FEE_RATE = FEE_RATE_ENTRY + FEE_RATE_EXIT + ENTRY_SLIPPAGE_RATE;

const WARMUP_BARS = 150;  // 1m × 150 = 2.5시간 워밍업
const MIN_VOLUME_USD = 500_000;

// periodDays → kline count 매핑 (1분봉 기준)
const PERIOD_KLINES: Record<number, number> = {
    4: 240, 8: 480, 12: 720, 24: 1440, 48: 2880, 72: 4320, 96: 5760, 168: 10080,
    // ★ 장기 학습: 통계적 유의성을 위한 충분한 표본
    720: 43200,     // 30일 (43,200 1m봉)
    1440: 86400,    // 60일
    2160: 129600,   // 90일
    4380: 262800,   // 182일 (6개월)
    8760: 525600,   // 365일 (1년)
    12960: 778000,  // 540일 (18개월)
};

// ★ v54: MLR 50%→20% (28,028건 분석: MLR20% + 20x에서 DD 58%→18% 감소)
const MAX_LOSS_RATIO = 0.20;  // 20% = SL 1%→20x, SL 2%→10x, SL 5%→4x
const MAX_LEVERAGE_CAP = 75;  // Bybit 실전 상한 안전장치

// ★ 레버리지 = 레짐캡 직접 사용 (slAtrMultiplier 제거)
// SL% = 0.50 / leverage 연속공식만 적용
// ★ v53.8: 레짐×세션 레버리지 맵 (11종목 7,247건 분석 결과)
const REGIME_SESSION_LEV_MAP: Record<string, Record<string, number>> = {
    VOLATILE:  { ASIA: 5,  EUROPE: 20, US: 20 },
    TRENDING:  { ASIA: 5,  EUROPE: 20, US: 14 },
    RANGING:   { ASIA: 20, EUROPE: 5,  US: 5  },
};

function calcLeverage(_config: TradingConfig, regime: string, candleTime?: number): number {
    const simpleRegime = regime === 'TRENDING' || regime === 'RANGING' || regime === 'VOLATILE'
        ? regime : 'TRENDING';
    const { session } = getSessionAndDayType(candleTime ?? Date.now());
    const lev = REGIME_SESSION_LEV_MAP[simpleRegime]?.[session] ?? 14;
    return Math.min(MAX_LEVERAGE_CAP, lev);
}

// ── 프리셋 정의 ──

export type FitnessMode = 'balanced' | 'aggressive';

// ★ 레버리지 = leverageTrending/Ranging/Volatile 직접 결정 (상한 20x)
// SL% = 0.50 / leverage 연속공식 (20x→2.5%, 12x→4.2%, 10x→5%)
export const OPTIMIZER_PRESETS = {
    'ignition-wf': {
        label: '🎯 Ignition WF',
        desc: 'IGNITION WF (1개월학습+1주검증, 9개월, 1종목순차, Lev 3단계)',
        fitnessMode: 'aggressive' as FitnessMode,
        ranges: [
            { key: 'tpAtrMultiplier' as const, values: [6.0, 8.0, 10.0, 12.0], label: 'TP' },
            { key: 'ignitionScoreThreshold' as const, values: [0.7], label: 'Ig점수' }, // ★ v53.7: 0.7 고정 (0.3 대비 EV 3.74 vs 0.95)
            { key: 'ignitionBodyMin' as const, values: [0.3, 0.5], label: 'Ig몸통' },
            { key: 'minTfConsensus' as const, values: [1, 2], label: 'TF동의' },
            // 고정값 (프리셋에 명시적으로 포함)
            { key: 'shortMultiplier' as const, values: [1], label: 'Short' },
            // ★ v53.0: 레버리지 3단계 — WF가 종목별 최적 선택, 실전에서 그대로 사용
            { key: 'leverageTrending' as const, values: [5, 14, 20], label: 'Lev' },
            { key: 'leverageRanging' as const, values: [0], label: 'Lev-R' },   // 0=Lev-T 연동
            { key: 'leverageVolatile' as const, values: [0], label: 'Lev-V' },  // 0=Lev-T 연동
            { key: 'ignitionVolMin' as const, values: [1.5], label: 'Ig거래량' },
            { key: 'ignitionConsecMin' as const, values: [1], label: 'Ig연속' },
            { key: 'topN' as const, values: [1], label: '스캔' },
            { key: 'maxPositions' as const, values: [1], label: '포지션' },
            { key: 'periodDays' as const, values: [270], label: '기간' },  // 9개월, walk-forward 윈도우가 오버라이드
            // 지표 전부 ON
            { key: 'useWaveTrend' as const, values: [true], label: 'WT' },
            { key: 'useIchimoku' as const, values: [true], label: 'Ichi' },
            { key: 'useVWAP' as const, values: [true], label: 'VWAP' },
            { key: 'useMFI' as const, values: [true], label: 'MFI' },
            { key: 'useHurst' as const, values: [true], label: 'Hurst' },
        ] as OptimizerParamRange[],  // = 3×2×2×2 = 24 (× 2방향 = 48/윈도우)
    },
} as const;

export type OptimizerPresetKey = keyof typeof OPTIMIZER_PRESETS;

export function countCombos(ranges: OptimizerParamRange[]): number {
    return ranges.reduce((acc, r) => acc * r.values.length, 1);
}

// ── 프리컴퓨트 바 ──

interface PrecomputedBar {
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
    ignitionScore: number;    // |가격변화%| × 거래량스파이크 — 급등/급락 감지
    volumeSpike: number;      // 최근 거래량 / 기준 거래량 비율
    ignitionBodyRatio: number;   // 몸통비율 평균 (0~1) — 위꼬리/아래꼬리 없을수록 1
    ignitionConsecutive: number; // 같은 방향 연속 캔들 수
    ignitionVolAccel: boolean;   // 거래량 가속 여부 (vol[t] > vol[t-1] > vol[t-2])
    // ★ MTF (Multi-Timeframe) — 1m→15m/1h 집계 기반
    regime1h: SimpleRegime;
    direction1h: 'Long' | 'Short' | null;
    dirScore1h: number;
    adx1h: number;
    regimeTpMult1h: number;
    regimeSlMult1h: number;
    direction15m: 'Long' | 'Short' | null;
    dirScore15m: number;
    tfConsensus: number;      // 0~3: 방향 동의하는 TF 수 (1m, 15m, 1h)
    // ★ v31: 변동성 필터 (실전 동기화)
    volatilityAccel: number;   // ATR now / ATR 10 bars ago
    volumeRatio: number;       // 최근 3봉 avg vol / 20봉 avg vol
    // ★ v36: 지표 게이트 (백테스트-실전 동기화)
    wtBullish: boolean;        // WaveTrend: wt1 > wt2 또는 과매도 반등
    wtBearish: boolean;        // WaveTrend: wt1 < wt2 또는 과매수 반전
    ichiLongOk: boolean;       // Ichimoku: Long 진입 허용
    ichiShortOk: boolean;      // Ichimoku: Short 진입 허용
    vwapDeviation: number;     // VWAP 편차 (σ 단위)
    mfi: number;               // MFI 값 (0-100)
    hurst: number;             // Hurst 지수 (0-1)
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
    trapReclaimVol: number; // ★ v47: 리클레임 봉 볼륨 / 20봉 평균 볼륨
    // Flow (Continuation Flow)
    flowVolSpike: number;   // ★ v47: 현재 볼륨 / 5봉 평균 볼륨
    flowDetected: boolean;
    flowSide: 'Long' | 'Short' | null;
    flowTrendContinuity: number;
    flowVolAccel: boolean;
    // Wick (Wick Fishing)
    wickAvgRatio: number;
    wickLastUpper: number;
    wickLastLower: number;
    wickNearSupport: boolean;
    wickNearResistance: boolean;
    // Gap (Gap Fill)
    gapDetected: boolean;
    gapSide: 'Long' | 'Short' | null;
    gapSizePct: number;
    gapMidpoint: number;
    gapAgeBars: number;
}

// ── 시뮬레이션 내부 포지션 ──

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
    strategyType?: string;
    trapZoneType?: 'PULLBACK' | 'NWAVE' | 'BREAKOUT' | 'MEANREV';
}

interface ExitResult {
    exitPrice: number;
    reason: 'TP1' | 'TP2' | 'SL' | 'END_OF_DATA' | 'MAX_HOLD';
    partialRealized: number;
}

// ── Fitness 함수 ──

function calculateFitness(summary: BacktestSummary, params?: BacktestParams): number {
    const { totalPnlPercent, maxDrawdownPercent, overallWinRate, profitFactor, totalTrades } = summary;
    // ★ 최소 15건 — 통계적 유의성 (기존 5건은 67% 승률이 3/5에 불과)
    if (totalTrades < 15) return -Infinity;
    const maxDD = Math.max(maxDrawdownPercent, 0.01);
    const calmar = totalPnlPercent / maxDD;
    const wrBonus = Math.sqrt(overallWinRate / 100);
    const pfBonus = Math.min(profitFactor, 5) / 5;
    let fitness = calmar * wrBonus * (0.5 + 0.5 * pfBonus);
    // ★ 거래수 보너스: 30건+ = 신뢰도 높음
    const tradeConfidence = Math.min(totalTrades / 30, 1.5);
    fitness *= tradeConfidence;
    // ★ v52.23: 레버리지 보너스 제거 — 실전 데이터에서 저배율이 흑자
    return fitness;
}

// ── Aggressive Fitness (고배 몰빵 전용) ──
// 승률² × win/loss 비율 × 거래수 보정
// Calmar 대신 승률 중심 — 고배에서는 DD보다 연패 방지가 핵심

function calculateAggressiveFitness(summary: BacktestSummary, params?: BacktestParams): number {
    const { totalTrades, overallWinRate, avgWinPercent, avgLossPercent } = summary;
    // ★ 최소 20건 — 고배에서는 더 많은 표본 필요 (기존 10건은 80% 승률이 8/10)
    if (totalTrades < 20) return -Infinity;
    // 최대 연속 손실 체크
    const maxConsec = getMaxConsecutiveLosses(summary);
    if (maxConsec >= 4) return -Infinity; // 4연패 = 고배에서 파산 위험
    const wr = overallWinRate / 100;
    const avgLoss = Math.abs(avgLossPercent) || 0.01;
    const rrRatio = Math.min(avgWinPercent / avgLoss, 10); // 상한 10
    // ★ 거래수 보너스 강화: 더 많은 거래 = 높은 신뢰도
    const tradeBonus = Math.sqrt(totalTrades / 20);
    const consecPenalty = maxConsec >= 3 ? 0.3 : maxConsec >= 2 ? 0.7 : 1.0;
    let fitness = (wr * wr) * rrRatio * tradeBonus * consecPenalty;
    // ★ v52.23: 레버리지 보너스 제거 — 실전 데이터에서 저배율이 흑자
    return fitness;
}

function getMaxConsecutiveLosses(summary: BacktestSummary): number {
    const allTrades = summary.tickers.flatMap(r => r.trades).sort((a, b) => a.entryTime - b.entryTime);
    let maxConsec = 0, curConsec = 0;
    for (const t of allTrades) {
        if (t.pnlPercent <= 0) { curConsec++; if (curConsec > maxConsec) maxConsec = curConsec; }
        else curConsec = 0;
    }
    return maxConsec;
}

// ── 몬테카를로 생존 테스트 ──
// 거래를 랜덤 순서로 500번 섞어서 에쿼티가 10 이하(파산)로 떨어지는지 테스트

function monteCarloSurvival(trades: BacktestTrade[], baseSizePercent: number, numSims: number = 500): number {
    if (trades.length < 3) return 0;
    const sizeRatio = baseSizePercent / 100;
    let survived = 0;
    for (let s = 0; s < numSims; s++) {
        // Fisher-Yates shuffle
        const shuffled = [...trades];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        let equity = 100;
        let alive = true;
        for (const t of shuffled) {
            equity *= (1 + (t.pnlPercent * sizeRatio) / 100);
            if (equity <= 10) { alive = false; break; } // 90% 손실 = 파산
        }
        if (alive) survived++;
    }
    return (survived / numSims) * 100;
}

// ── 종합 점수 (Aggressive 전용) ──
// 생존 35% + 검증수익 30% + 연패제한 20% + 학습fitness 15%
// Phase 4 이후 top30 재순위에 사용

export type CompositeWeights = { val: number; survival: number; consec: number; train: number };

const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = { survival: 0.35, val: 0.30, consec: 0.20, train: 0.15 };
// ★ ignition-wf: 검증PnL 중심 (오버피팅 방지)
export const IGNITION_WF_WEIGHTS: CompositeWeights = { val: 0.50, survival: 0.25, consec: 0.15, train: 0.10 };

function calculateCompositeScore(
    result: OptimizerComboResult,
    maxFitness: number,
    weights: CompositeWeights = DEFAULT_COMPOSITE_WEIGHTS,
): number {
    // 1. 생존율 — 0~100 → 0~1 정규화
    const survivalScore = (result.survivalRate / 100) * weights.survival;

    // 2. 검증 수익률 — sigmoid 정규화 (마이너스면 크게 깎임)
    //    valPnl 0% → 0.5, +100% → ~0.88, -50% → ~0.18
    const valPnlNorm = 1 / (1 + Math.exp(-result.valPnlPercent / 50));
    const valScore = valPnlNorm * weights.val;

    // 3. 연패 패널티 — 0연패=1.0, 1=0.9, 2=0.7, 3+=0.2
    let consecScore: number;
    const mc = result.maxConsecLosses;
    if (mc <= 0) consecScore = 1.0;
    else if (mc === 1) consecScore = 0.9;
    else if (mc === 2) consecScore = 0.7;
    else if (mc === 3) consecScore = 0.2;
    else consecScore = 0;  // 4연패 이상 = 거의 0점
    const consecComponent = consecScore * weights.consec;

    // 4. 학습 fitness — maxFitness 대비 비율
    const fitnessNorm = maxFitness > 0
        ? Math.max(0, result.fitnessScore) / maxFitness
        : 0;
    const fitnessComponent = fitnessNorm * weights.train;

    return survivalScore + valScore + consecComponent + fitnessComponent;
}

// ── OptimizerEngine ──

export class OptimizerEngine {
    private scanner: Scanner;
    private execution: Execution;
    private onProgress?: (msg: string, percent: number) => void;
    private aborted = false;

    // 캐시
    private klineCache: Map<string, KlineData[]> = new Map();
    private signalCache: Map<string, PrecomputedBar[]> = new Map();
    // ★ 검증 구간 — 미세최적화 재검증용
    private lastValBarRange?: { start: number; end: number };
    private lastTrainEndBar?: number;

    constructor(onProgress?: (msg: string, percent: number) => void) {
        this.scanner = new Scanner();
        this.scanner.setSimulationMode(true); // 백테스트: 캐시/히스테리시스 비활성화
        this.execution = new Execution(() => {});
        this.onProgress = onProgress;
    }

    abort() { this.aborted = true; }

    /** ★ 메모리 해제: kline + signal 캐시 참조 해제
     * 공유 참조일 수 있으므로 clear()가 아닌 새 Map으로 교체 */
    clearCaches() {
        this.klineCache = new Map();
        this.signalCache = new Map();
    }

    /** ★ kline fetch with 진행률 콜백 — 대용량 fetch 시 UI 업데이트 */
    private async fetchKlinesWithProgress(
        ticker: string, _timeframe: string, limit: number,
        onFetchProgress: (fetched: number, total: number) => void,
    ): Promise<KlineData[]> {
        // 청크 단위로 fetchSingleTimeframeKlines 호출 + 진행률 보고
        const CHUNK = 50_000;  // 5만개씩 끊어서 진행률 업데이트
        if (limit <= CHUNK) {
            onFetchProgress(0, limit);
            const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', limit);
            onFetchProgress(limit, limit);
            return klines;
        }

        // 대용량: 시간 역순으로 청크 분할 fetch — 배열 복사 최소화
        const chunks: KlineData[][] = [];
        let endTime = Date.now();
        let fetched = 0;

        while (fetched < limit) {
            if (this.aborted) break;
            const chunkSize = Math.min(CHUNK, limit - fetched);
            const chunk = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', chunkSize, undefined, endTime);
            if (chunk.length === 0) break;

            chunks.unshift(chunk);  // 앞에 추가 (시간순)
            fetched += chunk.length;
            endTime = chunk[0].time - 1;
            onFetchProgress(fetched, limit);

            if (chunk.length < chunkSize) break;
        }

        // 청크 병합 — 1회만 concat
        const allKlines = ([] as KlineData[]).concat(...chunks);
        if (allKlines.length > limit) {
            return allKlines.slice(allKlines.length - limit);
        }
        return allKlines;
    }

    /** 옵티마이저가 수집한 kline 데이터 반환 (싱글런 재사용용) */
    getKlineCache(): Map<string, KlineData[]> {
        // ★ 참조 공유 — 깊은 복사 제거로 메모리 절약 (~25MB)
        return this.klineCache;
    }

    /** 프리컴퓨트된 시그널 캐시 반환 (병렬 엔진 공유용) */
    getSignalCache(): Map<string, PrecomputedBar[]> {
        // ★ 참조 공유 — 깊은 복사 제거로 메모리 절약 (~150MB)
        return this.signalCache;
    }

    /** 외부에서 프리컴퓨트 데이터 주입 — Phase 1-2 건너뛰기 */
    setPrecomputedData(
        klineCache: Map<string, KlineData[]>,
        signalCache: Map<string, PrecomputedBar[]>,
    ): void {
        // ★ 참조 공유 — new Map() 복사 제거로 메모리 절약
        this.klineCache = klineCache;
        this.signalCache = signalCache;
    }

    // ── 메인 최적화 ──

    async run(
        baseConfig: TradingConfig,
        baseParams: BacktestParams,
        ranges: OptimizerParamRange[],
        topN: number,
        klineCount: number,
        fitnessMode: FitnessMode = 'balanced',
        excludeTickers: string[] = [],
        /** ★ Continuous 모드: 특정 종목만 강제 지정 (fetchTopMovers 건너뜀) */
        forceTickers?: string[],
    ): Promise<OptimizerSummary> {
        const startTime = Date.now();
        this.aborted = false;

        // ★ 프리컴퓨트 데이터가 주입된 경우 Phase 1-2 건너뛰기
        // ★ v48: klineCache만 있는 경우(Session Rush)도 fetch 스킵 → Phase 2(precompute)만 실행
        const hasPrecomputedData = this.signalCache.size > 0;
        const hasKlineCacheOnly = !hasPrecomputedData && this.klineCache.size > 0;

        // topN이 ranges에 있으면 최대값으로 fetch (조합별로 슬라이스)
        const topNRange = ranges.find(r => r.key === 'topN');
        const fetchTopN = topNRange
            ? Math.max(...topNRange.values.filter((v): v is number => typeof v === 'number'))
            : topN;

        // 기간이 변수이면 최대 기간으로 fetch
        const periodRange = ranges.find(r => r.key === 'periodDays');
        let maxTrainKlines = klineCount;
        if (periodRange) {
            const maxPeriodDays = Math.max(...periodRange.values.filter((v): v is number => typeof v === 'number'));
            maxTrainKlines = PERIOD_KLINES[maxPeriodDays] ?? klineCount;
        }
        // ★ 검증용 추가 데이터 — 학습의 25%, 최소 3일(4320봉)
        // 기존: 최대 24시간 캡 → 장기 학습 시 검증 부족
        // 수정: 30일 학습 → 7.5일 검증, 90일 학습 → 22.5일 검증
        const valKlines = Math.max(4320, Math.round(maxTrainKlines * 0.25));
        const totalFetchKlines = maxTrainKlines + valKlines;

        let validTickers: string[];

        if (hasPrecomputedData) {
            // ★ 프리컴퓨트 데이터 사용 — Phase 1-2 건너뛰기
            validTickers = [...this.signalCache.keys()];
            this.onProgress?.(`캐시 재사용: ${validTickers.length}개 종목`, 30);
            console.log(`[Optimizer] ★ 프리컴퓨트 캐시 재사용: ${validTickers.length}개 종목, Phase 1-2 건너뜀`);
        } else if (hasKlineCacheOnly) {
            // ★ v48: klineCache만 주입된 경우 (Session Rush) — Phase 1(fetch) 스킵, Phase 2(precompute)만 실행
            validTickers = [...this.klineCache.keys()];
            this.onProgress?.(`kline 캐시 재사용: ${validTickers.length}개 종목, 시그널 분석 시작`, 15);
            console.log(`[Optimizer] ★ klineCache 재사용: ${validTickers.length}개 종목, Phase 2만 실행`);

            // Phase 2: 시그널 프리컴퓨트
            const SIGNAL_BATCH2 = 5;
            for (let i = 0; i < validTickers.length; i += SIGNAL_BATCH2) {
                if (this.aborted) break;
                const batch = validTickers.slice(i, i + SIGNAL_BATCH2);
                this.onProgress?.(
                    `시그널 분석: ${batch.join(',')} (${Math.min(i + SIGNAL_BATCH2, validTickers.length)}/${validTickers.length})`,
                    15 + Math.round((i / validTickers.length) * 15),
                );
                const results = await Promise.all(
                    batch.map(async (ticker) => {
                        const klines = this.klineCache.get(ticker)!;
                        const signals = await this.precomputeSignals(ticker, klines);
                        return { ticker, signals };
                    }),
                );
                for (const { ticker, signals } of results) {
                    this.signalCache.set(ticker, signals);
                }
            }
            if (this.aborted) throw new Error('사용자에 의해 중단됨');
        } else {
            // Phase 1: 종목 조회 + kline fetch
            this.klineCache.clear();
            this.signalCache.clear();

            this.onProgress?.('상위 종목 조회 중...', 0);
            let tickers: string[];
            if (forceTickers && forceTickers.length > 0) {
                // ★ Continuous 모드: 강제 지정 종목 사용 (fetchTopMovers 건너뜀)
                tickers = forceTickers;
                this.onProgress?.(`강제 지정: ${tickers.join(',')}`, 1);
            } else {
            // ★ v36: 항상 fetchTopN개를 채우기 위해 넉넉하게 후보를 가져온 뒤 제외 → 상위 N개 선택
            const excludeSet = new Set(excludeTickers);
            const allTickers = await this.fetchTopMovers(fetchTopN + excludeSet.size + 10);  // 여유분 확보
            tickers = allTickers.filter(t => !excludeSet.has(t)).slice(0, fetchTopN);  // 제외 후 N개 채움
            if (excludeTickers.length > 0) {
                const skipped = allTickers.filter(t => excludeSet.has(t));
                console.log(`[Optimizer] ★ ${skipped.length}종목 스킵 (이미 최적화): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '...' : ''}`);
                this.onProgress?.(`${skipped.length}종목 스킵 → ${tickers.length}종목 선정 (항상 ${fetchTopN}개 채움)`, 1);
            }
            } // end else (non-forceTickers)

            if (tickers.length === 0) throw new Error('조건에 맞는 종목이 없습니다 (모두 최적화 완료).');

            validTickers = [];
            // ★ 1종목씩 fetch — 대용량(52만바) 시 진행률 표시를 위해 순차 처리
            for (let i = 0; i < tickers.length; i++) {
                if (this.aborted) break;
                const ticker = tickers[i];
                const totalBatches = Math.ceil(totalFetchKlines / 1000);
                this.onProgress?.(
                    `📡 ${ticker.replace('USDT', '')} 데이터 수집 (0/${totalBatches} 배치)`,
                    Math.round((i / tickers.length) * 15),
                );

                try {
                    // ★ 진행률 표시 fetch — 배치마다 콜백
                    const klines = await this.fetchKlinesWithProgress(
                        ticker, '1m', totalFetchKlines,
                        (fetched, total) => {
                            const batchDone = Math.ceil(fetched / 1000);
                            const pct = Math.round((i / tickers.length) * 15 + (fetched / total) * (15 / tickers.length));
                            this.onProgress?.(
                                `📡 ${ticker.replace('USDT', '')} ${(fetched / 1000).toFixed(0)}K/${(total / 1000).toFixed(0)}K바`,
                                pct,
                            );
                        },
                    );
                    if (klines.length >= WARMUP_BARS + 10) {
                        this.klineCache.set(ticker, klines);
                        validTickers.push(ticker);
                    }
                } catch (e) {
                    console.warn(`[Optimizer] ${ticker} kline 실패:`, e);
                }
            }

            if (this.aborted) throw new Error('사용자에 의해 중단됨');
            if (validTickers.length === 0) throw new Error('유효한 종목 데이터가 없습니다.');

            // Phase 2: 시그널 프리컴퓨트 (★ 배치 병렬화)
            const SIGNAL_BATCH = 5;  // 5종목씩 병렬 처리
            for (let i = 0; i < validTickers.length; i += SIGNAL_BATCH) {
                if (this.aborted) break;
                const batch = validTickers.slice(i, i + SIGNAL_BATCH);
                this.onProgress?.(
                    `시그널 분석: ${batch.join(',')} (${Math.min(i + SIGNAL_BATCH, validTickers.length)}/${validTickers.length})`,
                    15 + Math.round((i / validTickers.length) * 15),
                );
                const results = await Promise.all(
                    batch.map(async (ticker) => {
                        const klines = this.klineCache.get(ticker)!;
                        const signals = await this.precomputeSignals(ticker, klines);
                        return { ticker, signals };
                    }),
                );
                for (const { ticker, signals } of results) {
                    this.signalCache.set(ticker, signals);
                }
                await new Promise(r => setTimeout(r, 0));  // UI 반응성
            }

            if (this.aborted) throw new Error('사용자에 의해 중단됨');

            // ★ klineCache 즉시 해제 — 시그널 계산 완료 후 더 이상 불필요
            // 52만바 × ~50B = ~25MB 회수
            this.klineCache.clear();
        }

        // 학습/검증 경계 계산
        let globalMinBar = Infinity;
        let globalMaxBar = -Infinity;
        for (const ticker of validTickers) {
            const signals = this.signalCache.get(ticker)!;
            if (signals.length > 0) {
                globalMinBar = Math.min(globalMinBar, signals[0].bar);
                globalMaxBar = Math.max(globalMaxBar, signals[signals.length - 1].bar);
            }
        }
        const trainEndBar = globalMaxBar - valKlines;
        const valBarRange = { start: trainEndBar + 1, end: globalMaxBar };
        // ★ 미세최적화 재검증용으로 저장
        this.lastValBarRange = valBarRange;
        this.lastTrainEndBar = trainEndBar;

        // Phase 3: 파라미터 그리드 서치 (학습 구간) — Worker 병렬화
        const combos = this.generateCombos(baseParams, ranges);
        const totalCombos = combos.length;
        const results: OptimizerComboResult[] = [];

        // ★ Worker pool 생성 — 시그널 크기에 따라 동적 제한
        let totalSignalBars = 0;
        for (const signals of this.signalCache.values()) totalSignalBars += signals.length;
        const cpuCores = navigator.hardwareConcurrency || 4;
        // ★ v43: binary transfer로 워커당 메모리 ~122MB (Float64Array)
        // 5워커 × 122MB = ~610MB — 브라우저 안정성 확보
        const maxWorkers = Math.min(cpuCores, 5);
        const workerCount = Math.max(2, maxWorkers);
        const useWorkers = totalCombos >= 10; // 콤보 10개 미만은 순차 실행
        const estimatedMB = totalSignalBars * 58 * 8 / (1024 * 1024);
        console.log(`[Optimizer] 메모리 추정: ${estimatedMB.toFixed(0)}MB/워커 → ${workerCount}워커`)

        // ★ Binary packing: 262k 객체 structured clone (~30초) → Float64Array transfer (~50ms)
        const packedSource = packSignals(this.signalCache);
        console.log(`[Optimizer] 시그널 ${totalSignalBars}바 → Worker ${workerCount}개 (binary transfer)`);

        if (useWorkers && typeof Worker !== 'undefined') {
            // ★★★ Worker 병렬 실행 ★★★
            console.log(`[Optimizer] ★ Worker 병렬: ${workerCount}개 Worker × ${totalCombos}개 콤보`);
            this.onProgress?.(`Worker ${workerCount}개 초기화...`, 30);

            const workers: Worker[] = [];
            const workerReady: Promise<void>[] = [];

            for (let w = 0; w < workerCount; w++) {
                const worker = new Worker(
                    new URL('./simulationWorker.ts', import.meta.url),
                    { type: 'module' },
                );
                workers.push(worker);
                workerReady.push(new Promise<void>((resolve) => {
                    const handler = (e: MessageEvent) => {
                        if (e.data.type === 'ready') { worker.removeEventListener('message', handler); resolve(); }
                    };
                    worker.addEventListener('message', handler);
                }));
                // ★ Float64Array 복사 + transfer (structured clone 대신)
                const bufCopy = packedSource.buffer.slice(0);  // ArrayBuffer memcpy ~12ms
                worker.postMessage(
                    { type: 'init-packed', tickers: packedSource.tickers, counts: packedSource.counts, buffer: bufCopy },
                    [bufCopy],  // transfer list — zero-copy 전송
                );
            }

            // 모든 Worker 준비 대기
            await Promise.all(workerReady);
            // 주의: signalCache는 유지 — getSignalCache()로 reverseEngine에 전달 필요
            this.onProgress?.(`학습 시작 (${workerCount}x 병렬)`, 31);

            // 콤보별 작업을 Worker에 라운드로빈 분배
            let completedCombos = 0;
            const comboPromises: Promise<void>[] = [];

            for (let ci = 0; ci < combos.length; ci++) {
                if (this.aborted) break;

                const comboParams = combos[ci];
                const comboTopN = topNRange ? comboParams.topN : validTickers.length;
                const comboTickers = comboTopN > 0 && comboTopN < validTickers.length
                    ? validTickers.slice(0, comboTopN) : validTickers;
                const comboKlines = periodRange
                    ? (PERIOD_KLINES[comboParams.periodDays] ?? maxTrainKlines) : maxTrainKlines;
                const trainBarRange = {
                    start: Math.max(trainEndBar - comboKlines + 1, globalMinBar),
                    end: trainEndBar,
                };

                const worker = workers[ci % workerCount];
                const comboIndex = ci;

                comboPromises.push(new Promise<void>((resolve) => {
                    const handler = (e: MessageEvent) => {
                        if (e.data.type === 'combo-result' && e.data.comboIndex === comboIndex) {
                            worker.removeEventListener('message', handler);
                            const r = e.data;
                            results.push({
                                rank: 0, params: comboParams,
                                fitnessScore: r.fitnessScore,
                                totalPnlPercent: r.totalPnlPercent,
                                overallWinRate: r.overallWinRate,
                                maxDrawdownPercent: r.maxDrawdownPercent,
                                profitFactor: r.profitFactor,
                                totalTrades: r.totalTrades,
                                valPnlPercent: 0, valWinRate: 0, valMaxDD: 0,
                                valProfitFactor: 0, valTrades: 0,
                                survivalRate: 0, maxConsecLosses: 0,
                            });
                            completedCombos++;
                            if (completedCombos % 5 === 0 || completedCombos === totalCombos) {
                                const pct = 30 + Math.round((completedCombos / totalCombos) * 60);
                                this.onProgress?.(`학습 ${completedCombos}/${totalCombos} (${workerCount}x)`, Math.min(pct, 90));
                            }
                            resolve();
                        }
                    };
                    worker.addEventListener('message', handler);
                    worker.postMessage({
                        type: 'combo', comboIndex, comboParams,
                        baseConfig, tickers: comboTickers,
                        barRange: trainBarRange, fitnessMode,
                    });
                }));
            }

            await Promise.all(comboPromises);

            // 정렬 + 랭킹
            results.sort((a, b) => b.fitnessScore - a.fitnessScore);
            results.forEach((r, i) => r.rank = i + 1);

            // ★ Phase 4: Worker 병렬 검증
            const wTop30 = results.slice(0, 30);
            let completedVal = 0;
            const valPromises: Promise<void>[] = [];

            for (let vi = 0; vi < wTop30.length; vi++) {
                if (this.aborted) break;
                const result = wTop30[vi];
                const comboTopN2 = topNRange ? result.params.topN : validTickers.length;
                const comboTickers2 = comboTopN2 > 0 && comboTopN2 < validTickers.length
                    ? validTickers.slice(0, comboTopN2) : validTickers;
                const comboKlines2 = periodRange
                    ? (PERIOD_KLINES[result.params.periodDays] ?? maxTrainKlines) : maxTrainKlines;
                const trainBarRange2 = {
                    start: Math.max(trainEndBar - comboKlines2 + 1, globalMinBar),
                    end: trainEndBar,
                };

                const worker = workers[vi % workerCount];
                const valIndex = vi;

                valPromises.push(new Promise<void>((resolve) => {
                    const handler = (e: MessageEvent) => {
                        if (e.data.type === 'validate-result' && e.data.comboIndex === valIndex) {
                            worker.removeEventListener('message', handler);
                            const r = e.data;
                            result.trainTickerResults = r.trainTickerResults;
                            result.tickerResults = r.valTickerResults;
                            result.valPnlPercent = r.valPnlPercent;
                            result.valWinRate = r.valWinRate;
                            result.valMaxDD = r.valMaxDD;
                            result.valProfitFactor = r.valProfitFactor;
                            result.valTrades = r.valTrades;

                            // MC + maxConsecLosses (메인 스레드)
                            const trainTrades = r.trainTickerResults.flatMap((tr: any) => tr.trades);
                            const config2 = applyParamsToConfig(baseConfig, result.params);
                            result.maxConsecLosses = getMaxConsecutiveLosses(this.aggregateLight(r.trainTickerResults, config2));
                            if (fitnessMode === 'aggressive') {
                                result.survivalRate = monteCarloSurvival(trainTrades, result.params.baseSizePercent);
                            }

                            completedVal++;
                            if (completedVal % 5 === 0 || completedVal === wTop30.length) {
                                this.onProgress?.(
                                    fitnessMode === 'aggressive'
                                        ? `검증+MC ${completedVal}/${wTop30.length} (${workerCount}x)`
                                        : `검증 ${completedVal}/${wTop30.length} (${workerCount}x)`,
                                    90 + Math.round((completedVal / wTop30.length) * 9),
                                );
                            }
                            resolve();
                        }
                    };
                    worker.addEventListener('message', handler);
                    worker.postMessage({
                        type: 'validate', comboIndex: valIndex,
                        comboParams: result.params, baseConfig,
                        tickers: comboTickers2,
                        trainBarRange: trainBarRange2, valBarRange, fitnessMode,
                    });
                }));
            }

            await Promise.all(valPromises);

            // Worker 종료 + 메모리 해제
            for (const w of workers) w.terminate();
            workers.length = 0;

        } else {
            // ★★★ Fallback: 순차 실행 (Worker 미지원 또는 콤보 소수) ★★★
            for (let ci = 0; ci < combos.length; ci++) {
                if (this.aborted) break;

                const comboParams = combos[ci];
                const config = applyParamsToConfig(baseConfig, comboParams);
                const comboTopN = topNRange ? comboParams.topN : validTickers.length;
                const comboTickers = comboTopN > 0 && comboTopN < validTickers.length
                    ? validTickers.slice(0, comboTopN) : validTickers;
                const comboKlines = periodRange
                    ? (PERIOD_KLINES[comboParams.periodDays] ?? maxTrainKlines) : maxTrainKlines;
                const trainBarRange = {
                    start: Math.max(trainEndBar - comboKlines + 1, globalMinBar),
                    end: trainEndBar,
                };
                const tickerResults = this.simulateAllTickers(comboTickers, config, comboParams, trainBarRange);
                const summary = this.aggregateLight(tickerResults, config);
                const fitness = fitnessMode === 'aggressive'
                    ? calculateAggressiveFitness(summary, comboParams) : calculateFitness(summary, comboParams);

                results.push({
                    rank: 0, params: comboParams, fitnessScore: fitness,
                    totalPnlPercent: summary.totalPnlPercent,
                    overallWinRate: summary.overallWinRate,
                    maxDrawdownPercent: summary.maxDrawdownPercent,
                    profitFactor: summary.profitFactor,
                    totalTrades: summary.totalTrades,
                    valPnlPercent: 0, valWinRate: 0, valMaxDD: 0,
                    valProfitFactor: 0, valTrades: 0,
                    survivalRate: 0, maxConsecLosses: 0,
                });

                if (ci % 5 === 0 || ci === combos.length - 1) {
                    const pct = 30 + Math.round(((ci + 1) / totalCombos) * 60);
                    this.onProgress?.(`학습 ${ci + 1}/${totalCombos}`, Math.min(pct, 90));
                }
                if (ci % 20 === 0) await new Promise(r => setTimeout(r, 0));
            }

            // 정렬 + 랭킹
            results.sort((a, b) => b.fitnessScore - a.fitnessScore);
            results.forEach((r, i) => r.rank = i + 1);

            // Phase 4: 순차 검증
            const fTop30 = results.slice(0, 30);
            for (let vi = 0; vi < fTop30.length; vi++) {
                if (this.aborted) break;
                const result = fTop30[vi];
                const config = applyParamsToConfig(baseConfig, result.params);
                const comboTopN = topNRange ? result.params.topN : validTickers.length;
                const comboTickers = comboTopN > 0 && comboTopN < validTickers.length
                    ? validTickers.slice(0, comboTopN) : validTickers;
                const comboKlines2 = periodRange
                    ? (PERIOD_KLINES[result.params.periodDays] ?? maxTrainKlines) : maxTrainKlines;
                const trainBarRange2 = {
                    start: Math.max(trainEndBar - comboKlines2 + 1, globalMinBar),
                    end: trainEndBar,
                };
                const trainResults = this.simulateAllTickers(comboTickers, config, result.params, trainBarRange2);
                result.trainTickerResults = trainResults;
                const trainTrades = trainResults.flatMap(r => r.trades);
                result.maxConsecLosses = getMaxConsecutiveLosses(this.aggregateLight(trainResults, config));
                const valResults = this.simulateAllTickers(comboTickers, config, result.params, valBarRange);
                result.tickerResults = valResults;
                const valSummary = this.aggregateLight(valResults, config);
                result.valPnlPercent = valSummary.totalPnlPercent;
                result.valWinRate = valSummary.overallWinRate;
                result.valMaxDD = valSummary.maxDrawdownPercent;
                result.valProfitFactor = valSummary.profitFactor;
                result.valTrades = valSummary.totalTrades;
                if (fitnessMode === 'aggressive') {
                    result.survivalRate = monteCarloSurvival(trainTrades, result.params.baseSizePercent);
                }
                if (vi % 5 === 0) {
                    this.onProgress?.(
                        fitnessMode === 'aggressive'
                            ? `검증+MC ${vi + 1}/${fTop30.length}` : `검증 ${vi + 1}/${fTop30.length}`,
                        90 + Math.round((vi / fTop30.length) * 9),
                    );
                    await new Promise(r => setTimeout(r, 0));
                }
            }
        }

        const top30 = results.slice(0, 30);

        // Phase 5: 종합 점수 재순위 (Aggressive 모드)
        // 생존35% + 검증30% + 연패20% + 학습15%로 최종 순위 결정
        if (fitnessMode === 'aggressive') {
            const maxFitness = Math.max(...top30.map(r => r.fitnessScore).filter(f => isFinite(f)), 0.01);
            for (const result of top30) {
                result.compositeScore = calculateCompositeScore(result, maxFitness);
            }
            top30.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
            top30.forEach((r, i) => r.rank = i + 1);
        }

        // ★ 메모리 정리: klineCache는 precompute 후 불필요 (signalCache만 유지)
        // 주의: setPrecomputedData()로 주입된 경우 Reverse에서 재사용하므로 signalCache는 유지
        this.klineCache.clear();
        this.onProgress?.('완료', 100);

        return {
            results: top30,
            totalCombos,
            completedCombos: results.length,
            elapsedMs: Date.now() - startTime,
            cachedTickers: validTickers,
        };
    }

    // ── Walk-Forward Analysis ──
    //
    // 학습 기간에서 최적 파라미터를 찾고, 미래(검증) 기간에서 성과를 테스트
    // 윈도우를 슬라이딩하며 반복 → 과적합 여부를 판단할 수 있음

    async runWalkForward(
        baseConfig: TradingConfig,
        baseParams: BacktestParams,
        ranges: OptimizerParamRange[],
        topN: number,
    ): Promise<WalkForwardSummary> {
        const startTime = Date.now();
        this.aborted = false;
        this.klineCache.clear();
        this.signalCache.clear();

        const TOTAL_KLINES = 8640;  // 6일 (1m × 1440 × 6)
        const TRAIN_BARS = 4320;    // 3일 (1m × 1440 × 3)
        const TEST_BARS = 1440;     // 1일 (1m × 1440)
        const STEP_BARS = 720;      // 12시간 스텝

        // topN이 ranges에 있으면 최대값으로 fetch
        const topNRange = ranges.find(r => r.key === 'topN');
        const fetchTopN = topNRange ? Math.max(...topNRange.values.filter((v): v is number => typeof v === 'number')) : topN;

        // Phase 1: 데이터 수집 (7일치)
        this.onProgress?.('WF: 종목 조회 중...', 0);
        const tickers = await this.fetchTopMovers(fetchTopN);
        if (tickers.length === 0) throw new Error('조건에 맞는 종목이 없습니다.');

        const validTickers: string[] = [];
        const WF_FETCH_BATCH = 5;
        for (let i = 0; i < tickers.length; i += WF_FETCH_BATCH) {
            if (this.aborted) break;
            const batch = tickers.slice(i, i + WF_FETCH_BATCH);
            this.onProgress?.(
                `WF 데이터: ${batch.join(',')} (${Math.min(i + WF_FETCH_BATCH, tickers.length)}/${tickers.length})`,
                Math.round((i / tickers.length) * 10),
            );
            const results = await Promise.all(
                batch.map(async (ticker) => {
                    try {
                        const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', TOTAL_KLINES);
                        if (klines.length >= WARMUP_BARS + 10) {
                            return { ticker, klines };
                        }
                    } catch (e) {
                        console.warn(`[WF] ${ticker} kline 실패:`, e);
                    }
                    return null;
                }),
            );
            for (const r of results) {
                if (r) {
                    this.klineCache.set(r.ticker, r.klines);
                    validTickers.push(r.ticker);
                }
            }
            if (i + WF_FETCH_BATCH < tickers.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');
        if (validTickers.length === 0) throw new Error('유효한 종목 데이터가 없습니다.');

        // Phase 2: 시그널 프리컴퓨트 (★ 배치 병렬화)
        const WF_SIGNAL_BATCH = 5;
        for (let i = 0; i < validTickers.length; i += WF_SIGNAL_BATCH) {
            if (this.aborted) break;
            const batch = validTickers.slice(i, i + WF_SIGNAL_BATCH);
            this.onProgress?.(
                `WF 시그널: ${batch.join(',')} (${Math.min(i + WF_SIGNAL_BATCH, validTickers.length)}/${validTickers.length})`,
                10 + Math.round((i / validTickers.length) * 10),
            );
            const results = await Promise.all(
                batch.map(async (ticker) => {
                    const klines = this.klineCache.get(ticker)!;
                    const signals = await this.precomputeSignals(ticker, klines);
                    return { ticker, signals };
                }),
            );
            for (const { ticker, signals } of results) {
                this.signalCache.set(ticker, signals);
            }
            await new Promise(r => setTimeout(r, 0));
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');

        // Phase 3: 윈도우 생성
        let actualMinBar = Infinity;
        let actualMaxBar = -Infinity;
        for (const ticker of validTickers) {
            const signals = this.signalCache.get(ticker)!;
            if (signals.length === 0) continue;
            actualMinBar = Math.min(actualMinBar, signals[0].bar);
            actualMaxBar = Math.max(actualMaxBar, signals[signals.length - 1].bar);
        }

        const windowDefs: { trainStart: number; trainEnd: number; testStart: number; testEnd: number }[] = [];
        let wStart = actualMinBar;
        while (wStart + TRAIN_BARS + TEST_BARS - 1 <= actualMaxBar) {
            windowDefs.push({
                trainStart: wStart,
                trainEnd: wStart + TRAIN_BARS - 1,
                testStart: wStart + TRAIN_BARS,
                testEnd: wStart + TRAIN_BARS + TEST_BARS - 1,
            });
            wStart += STEP_BARS;
        }

        if (windowDefs.length === 0) {
            throw new Error(`데이터 부족: ${actualMaxBar - actualMinBar + 1}바 (최소 ${TRAIN_BARS + TEST_BARS}바 = 4일 필요)`);
        }

        // Phase 4: 윈도우별 학습→검증
        const combos = this.generateCombos(baseParams, ranges);
        const totalCombos = combos.length;
        const wfResults: WalkForwardWindow[] = [];

        for (let wi = 0; wi < windowDefs.length; wi++) {
            if (this.aborted) break;
            const w = windowDefs[wi];

            // ── 학습: 모든 조합 시뮬 → 최적 파라미터 선택 ──
            let bestFitness = -Infinity;
            let bestParams = baseParams;
            let bestTrainPnl = 0;

            for (let ci = 0; ci < combos.length; ci++) {
                if (this.aborted) break;
                const comboParams = combos[ci];
                const config = applyParamsToConfig(baseConfig, comboParams);
                const comboTopN = topNRange ? comboParams.topN : validTickers.length;
                const comboTickers = comboTopN > 0 && comboTopN < validTickers.length
                    ? validTickers.slice(0, comboTopN) : validTickers;

                const tickerResults = this.simulateAllTickers(
                    comboTickers, config, comboParams,
                    { start: w.trainStart, end: w.trainEnd },
                );
                const summary = this.aggregateLight(tickerResults, config);
                const fitness = calculateFitness(summary, comboParams);

                if (fitness > bestFitness) {
                    bestFitness = fitness;
                    bestParams = comboParams;
                    bestTrainPnl = summary.totalPnlPercent;
                }

                // 진행률 업데이트
                if (ci % 10 === 0) {
                    const windowPct = 20 + Math.round(((wi + ci / combos.length) / windowDefs.length) * 75);
                    this.onProgress?.(
                        `WF ${wi + 1}/${windowDefs.length}: 학습 ${ci + 1}/${totalCombos}`,
                        Math.min(windowPct, 95),
                    );
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (this.aborted) break;

            // ── 검증: 학습에서 찾은 최적 파라미터로 미래(unseen) 데이터 테스트 ──
            const testConfig = applyParamsToConfig(baseConfig, bestParams);
            const testTopN = topNRange ? bestParams.topN : validTickers.length;
            const testTickers = testTopN > 0 && testTopN < validTickers.length
                ? validTickers.slice(0, testTopN) : validTickers;

            const testTickerResults = this.simulateAllTickers(
                testTickers, testConfig, bestParams,
                { start: w.testStart, end: w.testEnd },
            );
            const testSummary = this.aggregateLight(testTickerResults, testConfig);

            wfResults.push({
                windowIndex: wi,
                trainBarRange: [w.trainStart, w.trainEnd],
                testBarRange: [w.testStart, w.testEnd],
                bestParams,
                bestFitness,
                trainPnl: bestTrainPnl,
                testPnl: testSummary.totalPnlPercent,
                testWinRate: testSummary.overallWinRate,
                testTrades: testSummary.totalTrades,
                testMaxDD: testSummary.maxDrawdownPercent,
                testProfitFactor: testSummary.profitFactor,
            });

            this.onProgress?.(
                `WF ${wi + 1}/${windowDefs.length} 완료: 학습 ${bestTrainPnl >= 0 ? '+' : ''}${bestTrainPnl.toFixed(1)}% → 검증 ${testSummary.totalPnlPercent >= 0 ? '+' : ''}${testSummary.totalPnlPercent.toFixed(1)}%`,
                20 + Math.round(((wi + 1) / windowDefs.length) * 75),
            );
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');

        // Phase 5: 집계
        const len = wfResults.length;
        const avgTrainPnl = wfResults.reduce((s, w) => s + w.trainPnl, 0) / len;
        const avgTestPnl = wfResults.reduce((s, w) => s + w.testPnl, 0) / len;
        const avgTestWinRate = wfResults.reduce((s, w) => s + w.testWinRate, 0) / len;
        const totalTestTrades = wfResults.reduce((s, w) => s + w.testTrades, 0);
        const avgTestMaxDD = wfResults.reduce((s, w) => s + w.testMaxDD, 0) / len;

        // 과적합 비율: 학습 수익 대비 검증 수익의 괴리
        // 높을수록 과적합 (학습에서만 잘 되고 검증에서 안 됨)
        const overfitRatio = avgTestPnl !== 0
            ? Math.abs(avgTrainPnl) / Math.abs(avgTestPnl)
            : avgTrainPnl > 0 ? Infinity : 1;

        this.onProgress?.('Walk-Forward 완료', 100);

        return {
            windows: wfResults,
            avgTrainPnl,
            avgTestPnl,
            avgTestWinRate,
            totalTestTrades,
            avgTestMaxDD,
            overfitRatio,
            elapsedMs: Date.now() - startTime,
            totalCombosPerWindow: totalCombos,
            cachedTickers: validTickers,
        };
    }

    // ── Walk-Forward Long (IGNITION 전용, 1개월 학습 + 1주 검증 × 18개월) ──
    //
    // 기존 runWalkForward()는 6일 단기. 이 메서드는 18개월 장기 데이터로
    // 72개 롤링 윈도우를 생성하고, 각 윈도우마다 normal+reverse 양방향 Grid Search 수행.
    // median testPnl 윈도우의 파라미터를 최종 선택하여 과적합을 최소화한다.

    async runWalkForwardLong(
        baseConfig: TradingConfig,
        baseParams: BacktestParams,
        ranges: OptimizerParamRange[],
        topN: number,
        options: {
            totalKlines: number;     // 389,000 (9개월)
            trainBars: number;       // 43,200 (30일)
            testBars: number;        // 10,080 (7일)
            stepBars: number;        // 10,080 (7일)
            fitnessMode: FitnessMode;
            minTestTrades: number;   // 10
            excludeTickers?: string[];  // ★ 이미 처리한 종목 제외
            forceTickers?: string[];    // ★ v52.42: 마스터 리스트에서 직접 전달 (fetchTopMovers 스킵)
        },
    ): Promise<WalkForwardSummary> {
        const startTime = Date.now();
        this.aborted = false;
        this.klineCache.clear();
        this.signalCache.clear();

        const { totalKlines, trainBars, testBars, stepBars, fitnessMode, minTestTrades, excludeTickers, forceTickers } = options;
        const fitnessFn = fitnessMode === 'aggressive' ? calculateAggressiveFitness : calculateFitness;

        // ★ v52.25: topN 파라미터 직접 사용 (1종목씩 순차 처리)
        const fetchTopN = topN;

        // Phase 1: 데이터 수집 (9개월치)
        const excludeSet = new Set(excludeTickers ?? []);
        let allTickers: string[];
        let tickers: string[];
        if (forceTickers && forceTickers.length > 0) {
            // ★ v52.42: 마스터 리스트에서 직접 전달 — fetchTopMovers 스킵
            allTickers = forceTickers;
            tickers = forceTickers;
            this.onProgress?.(`WF-Long: ${forceTickers.join(',')} 직접 지정`, 0);
        } else {
            this.onProgress?.(`WF-Long: 종목 조회 중... (${excludeSet.size}종목 스킵)`, 0);
            allTickers = await this.fetchTopMovers(fetchTopN + excludeSet.size + 10);
            tickers = allTickers.filter(t => !excludeSet.has(t)).slice(0, fetchTopN);
            if (excludeSet.size > 0) {
                const skipped = allTickers.filter(t => excludeSet.has(t));
                console.log(`[WF-Long] ★ ${skipped.length}종목 스킵 (이미 최적화): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '...' : ''}`);
                this.onProgress?.(`${skipped.length}종목 스킵 → ${tickers.length}종목 선정`, 1);
            }
        }
        if (tickers.length === 0) throw new Error('조건에 맞는 종목이 없습니다 (모두 최적화 완료).');

        const validTickers: string[] = [];
        // ★ v52.45: 병렬 kline 수집 (4스트림)
        for (let i = 0; i < tickers.length; i++) {
            if (this.aborted) break;
            const ticker = tickers[i];
            this.onProgress?.(
                `WF-Long 데이터: ${ticker.replace('USDT', '')} 병렬수집 중...`,
                Math.round((i / tickers.length) * 5),
            );
            const results = await Promise.all([
                (async () => {
                    try {
                        const klines = await bybitService.fetchKlinesParallel(
                            ticker, '1m', totalKlines, 6,
                            (fetched, total) => {
                                this.onProgress?.(
                                    `📡 ${ticker.replace('USDT', '')} ${(fetched / 1000).toFixed(0)}K/${(total / 1000).toFixed(0)}K바 (6스트림)`,
                                    Math.round((i / tickers.length) * 5 + (fetched / total) * (5 / tickers.length)),
                                );
                            },
                        );
                        if (klines.length >= WARMUP_BARS + trainBars) {
                            return { ticker, klines };
                        }
                    } catch (e) {
                        console.warn(`[WF-Long] ${ticker} kline 실패:`, e);
                    }
                    return null;
                })(),
            ]);
            for (const r of results) {
                if (r) {
                    this.klineCache.set(r.ticker, r.klines);
                    validTickers.push(r.ticker);
                }
            }
            // 다음 종목 전 짧은 대기 (rate limit)
            if (i + 1 < tickers.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');
        if (validTickers.length === 0) {
            const err = new Error(`유효한 종목 데이터가 없습니다. (시도: ${tickers.join(',')})`);
            (err as any).attemptedTickers = tickers;
            throw err;
        }

        // Phase 2: 시그널 프리컴퓨트 (전체 1회 — 캐시)
        const WF_SIGNAL_BATCH = 2;  // 메모리 관리
        for (let i = 0; i < validTickers.length; i += WF_SIGNAL_BATCH) {
            if (this.aborted) break;
            const batch = validTickers.slice(i, i + WF_SIGNAL_BATCH);
            this.onProgress?.(
                `WF-Long 시그널: ${batch.join(',')} (${Math.min(i + WF_SIGNAL_BATCH, validTickers.length)}/${validTickers.length})`,
                5 + Math.round((i / validTickers.length) * 15),
            );
            const results = await Promise.all(
                batch.map(async (ticker) => {
                    const klines = this.klineCache.get(ticker)!;
                    const signals = await this.precomputeSignals(ticker, klines);
                    return { ticker, signals };
                }),
            );
            for (const { ticker, signals } of results) {
                this.signalCache.set(ticker, signals);
            }
            await new Promise(r => setTimeout(r, 0));
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');

        // ★ kline 캐시 해제 (signal 캐시만 유지 — 메모리 절약)
        this.klineCache.clear();

        // Phase 2.5: Worker pool 초기화 (병렬 시뮬레이션)
        let pool: SimWorkerPool | null = null;
        try {
            const packed = packSignals(this.signalCache);
            pool = new SimWorkerPool();
            this.onProgress?.(`워커 ${pool.workerCount}개 초기화 중...`, 22);
            await pool.initSignals(packed);
            this.onProgress?.(`워커 ${pool.workerCount}개 준비 완료`, 25);
        } catch (workerErr) {
            console.warn('[WF-Long] Worker 초기화 실패, 순차 실행 폴백:', workerErr);
            pool?.terminate();
            pool = null;
        }

        // Phase 3: 윈도우 생성
        let actualMinBar = Infinity;
        let actualMaxBar = -Infinity;
        for (const ticker of validTickers) {
            const signals = this.signalCache.get(ticker)!;
            if (signals.length === 0) continue;
            actualMinBar = Math.min(actualMinBar, signals[0].bar);
            actualMaxBar = Math.max(actualMaxBar, signals[signals.length - 1].bar);
        }

        const windowDefs: { trainStart: number; trainEnd: number; testStart: number; testEnd: number }[] = [];
        let wStart = actualMinBar;
        while (wStart + trainBars + testBars - 1 <= actualMaxBar) {
            windowDefs.push({
                trainStart: wStart,
                trainEnd: wStart + trainBars - 1,
                testStart: wStart + trainBars,
                testEnd: wStart + trainBars + testBars - 1,
            });
            wStart += stepBars;
        }

        if (windowDefs.length === 0) {
            const err = new Error(`데이터 부족: ${actualMaxBar - actualMinBar + 1}바 (최소 ${trainBars + testBars}바 필요) [${validTickers.join(',')}]`);
            (err as any).attemptedTickers = validTickers;
            throw err;
        }

        // Phase 4: 윈도우별 학습→검증 (Normal only)
        // ★ v52.54: Reverse 제거 확정 (802건 분석: reverse 전 레짐 적자)
        const combosNormal = this.generateCombos({ ...baseParams, reverseMode: false }, ranges);
        const combosReverse: typeof combosNormal = [];
        const totalCombosPerDir = combosNormal.length;
        const wfResults: WalkForwardWindow[] = [];

        try {
        for (let wi = 0; wi < windowDefs.length; wi++) {
            if (this.aborted) break;
            const w = windowDefs[wi];

            if (pool) {
                // ═══════════════════════════════════════════════════════
                // ★ Worker 병렬 실행 경로
                // ═══════════════════════════════════════════════════════

                // ── 4a. Normal 방향 Grid Search (병렬) ──
                const normalJobs = combosNormal.map((combo, ci) => ({
                    type: 'combo' as const,
                    comboIndex: ci,
                    comboParams: combo,
                    baseConfig,
                    tickers: validTickers,
                    barRange: { start: w.trainStart, end: w.trainEnd },
                    fitnessMode,
                }));
                const normalResults = await pool.runBatch(normalJobs);

                let bestNormalFitness = -Infinity;
                let bestNormalParams = baseParams;
                let bestNormalTrainPnl = 0;
                for (const r of normalResults) {
                    if (r.fitnessScore > bestNormalFitness) {
                        bestNormalFitness = r.fitnessScore;
                        bestNormalParams = combosNormal[r.comboIndex];
                        bestNormalTrainPnl = r.totalPnlPercent;
                    }
                }

                if (this.aborted) break;

                // ── 4b. Reverse 방향 Grid Search (병렬) ──
                const reverseJobs = combosReverse.map((combo, ci) => ({
                    type: 'combo' as const,
                    comboIndex: ci,
                    comboParams: combo,
                    baseConfig,
                    tickers: validTickers,
                    barRange: { start: w.trainStart, end: w.trainEnd },
                    fitnessMode,
                }));
                const reverseResults = await pool.runBatch(reverseJobs);

                let bestReverseFitness = -Infinity;
                let bestReverseParams = { ...baseParams, reverseMode: true };
                let bestReverseTrainPnl = 0;
                for (const r of reverseResults) {
                    if (r.fitnessScore > bestReverseFitness) {
                        bestReverseFitness = r.fitnessScore;
                        bestReverseParams = combosReverse[r.comboIndex];
                        bestReverseTrainPnl = r.totalPnlPercent;
                    }
                }

                if (this.aborted) break;

                // ── 4c. Normal vs Reverse 비교 → 윈도우 승자 선택 ──
                const useReverse = bestReverseFitness > bestNormalFitness;
                const bestParams = useReverse ? bestReverseParams : bestNormalParams;
                const bestFitness = useReverse ? bestReverseFitness : bestNormalFitness;
                const bestTrainPnl = useReverse ? bestReverseTrainPnl : bestNormalTrainPnl;
                const selectedMode: 'normal' | 'reverse' = useReverse ? 'reverse' : 'normal';

                // ── 4d. 승자 파라미터로 검증 구간 시뮬 (메인 스레드 — 단일 콤보) ──
                const testConfig = applyParamsToConfig(baseConfig, bestParams);
                const testTickerResults = this.simulateAllTickers(
                    validTickers, testConfig, bestParams,
                    { start: w.testStart, end: w.testEnd },
                );
                const testSummary = this.aggregateLight(testTickerResults, testConfig);

                // ── 4e. 최소 거래수 체크 ──
                const meetsMinTrades = testSummary.totalTrades >= minTestTrades;

                wfResults.push({
                    windowIndex: wi,
                    trainBarRange: [w.trainStart, w.trainEnd],
                    testBarRange: [w.testStart, w.testEnd],
                    bestParams,
                    bestFitness,
                    trainPnl: bestTrainPnl,
                    testPnl: testSummary.totalPnlPercent,
                    testWinRate: testSummary.overallWinRate,
                    testTrades: testSummary.totalTrades,
                    testMaxDD: testSummary.maxDrawdownPercent,
                    testProfitFactor: testSummary.profitFactor,
                    minTestTradesMet: meetsMinTrades,
                    selectedMode,
                });

                // 진행률 업데이트
                const windowPct = 20 + Math.round(((wi + 1) / windowDefs.length) * 75);
                this.onProgress?.(
                    `WF-Long ${wi + 1}/${windowDefs.length} (${selectedMode}): 학습 ${bestTrainPnl >= 0 ? '+' : ''}${bestTrainPnl.toFixed(1)}% → 검증 ${testSummary.totalPnlPercent >= 0 ? '+' : ''}${testSummary.totalPnlPercent.toFixed(1)}% (${testSummary.totalTrades}건${meetsMinTrades ? '' : ' ⚠️<' + minTestTrades})`,
                    Math.min(windowPct, 95),
                );

                // ★ v52.62: 조기탈락 제거 — EV/PnL이 실전과 역상관이므로 끝까지 시뮬

            } else {
                // ═══════════════════════════════════════════════════════
                // ★ 순차 실행 폴백 (Worker 사용 불가 시)
                // ═══════════════════════════════════════════════════════

                // ── 4a. Normal 방향 Grid Search ──
                let bestNormalFitness = -Infinity;
                let bestNormalParams = baseParams;
                let bestNormalTrainPnl = 0;

                for (let ci = 0; ci < combosNormal.length; ci++) {
                    if (this.aborted) break;
                    const comboParams = combosNormal[ci];
                    const config = applyParamsToConfig(baseConfig, comboParams);
                    const tickerResults = this.simulateAllTickers(
                        validTickers, config, comboParams,
                        { start: w.trainStart, end: w.trainEnd },
                    );
                    const summary = this.aggregateLight(tickerResults, config);
                    const fitness = fitnessFn(summary, comboParams);

                    if (fitness > bestNormalFitness) {
                        bestNormalFitness = fitness;
                        bestNormalParams = comboParams;
                        bestNormalTrainPnl = summary.totalPnlPercent;
                    }
                }

                // ── 4b. Reverse 방향 Grid Search ──
                let bestReverseFitness = -Infinity;
                let bestReverseParams = { ...baseParams, reverseMode: true };
                let bestReverseTrainPnl = 0;

                for (let ci = 0; ci < combosReverse.length; ci++) {
                    if (this.aborted) break;
                    const comboParams = combosReverse[ci];
                    const config = applyParamsToConfig(baseConfig, comboParams);
                    const tickerResults = this.simulateAllTickers(
                        validTickers, config, comboParams,
                        { start: w.trainStart, end: w.trainEnd },
                    );
                    const summary = this.aggregateLight(tickerResults, config);
                    const fitness = fitnessFn(summary, comboParams);

                    if (fitness > bestReverseFitness) {
                        bestReverseFitness = fitness;
                        bestReverseParams = comboParams;
                        bestReverseTrainPnl = summary.totalPnlPercent;
                    }
                }

                if (this.aborted) break;

                // ── 4c. Normal vs Reverse 비교 → 윈도우 승자 선택 ──
                const useReverse = bestReverseFitness > bestNormalFitness;
                const bestParams = useReverse ? bestReverseParams : bestNormalParams;
                const bestFitness = useReverse ? bestReverseFitness : bestNormalFitness;
                const bestTrainPnl = useReverse ? bestReverseTrainPnl : bestNormalTrainPnl;
                const selectedMode: 'normal' | 'reverse' = useReverse ? 'reverse' : 'normal';

                // ── 4d. 승자 파라미터로 검증 구간 시뮬 ──
                const testConfig = applyParamsToConfig(baseConfig, bestParams);
                const testTickerResults = this.simulateAllTickers(
                    validTickers, testConfig, bestParams,
                    { start: w.testStart, end: w.testEnd },
                );
                const testSummary = this.aggregateLight(testTickerResults, testConfig);

                // ── 4e. 최소 거래수 체크 ──
                const meetsMinTrades = testSummary.totalTrades >= minTestTrades;

                wfResults.push({
                    windowIndex: wi,
                    trainBarRange: [w.trainStart, w.trainEnd],
                    testBarRange: [w.testStart, w.testEnd],
                    bestParams,
                    bestFitness,
                    trainPnl: bestTrainPnl,
                    testPnl: testSummary.totalPnlPercent,
                    testWinRate: testSummary.overallWinRate,
                    testTrades: testSummary.totalTrades,
                    testMaxDD: testSummary.maxDrawdownPercent,
                    testProfitFactor: testSummary.profitFactor,
                    minTestTradesMet: meetsMinTrades,
                    selectedMode,
                });

                // 진행률 업데이트
                const windowPct = 20 + Math.round(((wi + 1) / windowDefs.length) * 75);
                this.onProgress?.(
                    `WF-Long ${wi + 1}/${windowDefs.length} (${selectedMode}): 학습 ${bestTrainPnl >= 0 ? '+' : ''}${bestTrainPnl.toFixed(1)}% → 검증 ${testSummary.totalPnlPercent >= 0 ? '+' : ''}${testSummary.totalPnlPercent.toFixed(1)}% (${testSummary.totalTrades}건${meetsMinTrades ? '' : ' ⚠️<' + minTestTrades})`,
                    Math.min(windowPct, 95),
                );

                // ★ v52.62: 조기탈락 제거 — EV/PnL이 실전과 역상관이므로 끝까지 시뮬
            }

            await new Promise(r => setTimeout(r, 0));
        }
        } finally {
            // ★ Worker pool 정리 (에러/중단 시에도 반드시 해제)
            pool?.terminate();
        }

        if (this.aborted) throw new Error('사용자에 의해 중단됨');

        // Phase 5: 집계
        const len = wfResults.length;
        const avgTrainPnl = wfResults.reduce((s, w) => s + w.trainPnl, 0) / len;
        const avgTestPnl = wfResults.reduce((s, w) => s + w.testPnl, 0) / len;
        const avgTestWinRate = wfResults.reduce((s, w) => s + w.testWinRate, 0) / len;
        const totalTestTrades = wfResults.reduce((s, w) => s + w.testTrades, 0);
        const avgTestMaxDD = wfResults.reduce((s, w) => s + w.testMaxDD, 0) / len;
        const windowsPassingMinTrades = wfResults.filter(w => w.minTestTradesMet).length;

        const overfitRatio = avgTestPnl !== 0
            ? Math.abs(avgTrainPnl) / Math.abs(avgTestPnl)
            : avgTrainPnl > 0 ? Infinity : 1;

        // Phase 6: median testPnl 윈도우의 파라미터를 최종 선택
        const sortedByTestPnl = [...wfResults]
            .filter(w => w.minTestTradesMet)
            .sort((a, b) => a.testPnl - b.testPnl);
        const medianWindow = sortedByTestPnl.length > 0
            ? sortedByTestPnl[Math.floor(sortedByTestPnl.length / 2)]
            : wfResults[Math.floor(len / 2)];  // 전부 미달이면 전체 median 사용
        const selectedParams = medianWindow.bestParams;

        this.onProgress?.(
            `WF-Long 완료: ${len}윈도우, 합격 ${windowsPassingMinTrades}/${len}, 평균검증PnL ${avgTestPnl >= 0 ? '+' : ''}${avgTestPnl.toFixed(2)}%, 과적합비 ${overfitRatio.toFixed(1)}`,
            100,
        );

        return {
            windows: wfResults,
            avgTrainPnl,
            avgTestPnl,
            avgTestWinRate,
            totalTestTrades,
            avgTestMaxDD,
            overfitRatio,
            elapsedMs: Date.now() - startTime,
            totalCombosPerWindow: totalCombosPerDir * 2,  // normal + reverse
            cachedTickers: validTickers,
            processedTickers: tickers,  // ★ 선정된 종목 (스킵 전 기준 — 로테이션 추적용)
            selectedParams,
            windowsPassingMinTrades,
        };
    }

    // ── 시그널 프리컴퓨트 ──

    private async precomputeSignals(ticker: string, klines: KlineData[]): Promise<PrecomputedBar[]> {
        const N = klines.length;
        const bars: PrecomputedBar[] = [];

        // ═══════════════════════════════════════════════════════════════════
        // ★★★ PHASE 0: 전체 배열 지표 선계산 (O(n) 각각, 1회만) ★★★
        // 기존: 매 bar마다 slice+재계산 → O(n²), 52만바 = 5~10분
        // 개선: 전체 배열 1회 계산 → O(n), ~1초
        // ═══════════════════════════════════════════════════════════════════
        const allCloses = klines.map(k => k.close);

        const rawATR = calculateATR(klines, 14);
        const rawADX = calculateADX(klines, 14);
        const rawRSI = calculateRSI(allCloses, 14);
        const rawEMA20 = calculateEMA(allCloses, 20);
        const rawEMA50 = calculateEMA(allCloses, 50);
        const rawEMA200 = calculateEMA(allCloses, 200);
        const rawBB = calculateBollingerBands(allCloses, 20, 2);
        const rawMFI = calculateMFI(klines, 14);

        // 오프셋: 지표 배열은 warmup 기간만큼 짧음 → 뒤에서 정렬
        // rawATR[i] ↔ klines[i + (N - rawATR.length)]
        const atrOff = N - rawATR.length;
        const adxOff = N - rawADX.length;
        const rsiOff = N - rawRSI.length;
        const e20Off = N - rawEMA20.length;
        const e50Off = N - rawEMA50.length;
        const e200Off = N - rawEMA200.length;
        const bbOff = N - rawBB.length;
        const mfiOff = N - rawMFI.length;

        // O(1) 룩업 헬퍼
        const atrAt = (b: number) => b >= atrOff ? rawATR[b - atrOff] : klines[b].close * 0.01;
        const adxAt = (b: number) => b >= adxOff ? rawADX[b - adxOff] : 0;
        const rsiAt = (b: number) => b >= rsiOff ? rawRSI[b - rsiOff] : 50;
        const ema20At = (b: number) => b >= e20Off ? rawEMA20[b - e20Off] : klines[b].close;
        const ema50At = (b: number) => b >= e50Off ? rawEMA50[b - e50Off] : klines[b].close;
        const ema200At = (b: number) => b >= e200Off ? rawEMA200[b - e200Off] : klines[b].close;
        const bbAt = (b: number) => b >= bbOff ? rawBB[b - bbOff] : null;
        const mfiAt = (b: number) => b >= mfiOff ? rawMFI[b - mfiOff] : 50;

        // ★ PDI/MDI 전체 배열 (detectDirection 인라인용)
        const { pdiArr, mdiArr } = (() => {
            const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
            for (let i = 1; i < N; i++) {
                const h = klines[i].high, l = klines[i].low;
                const ph = klines[i - 1].high, pl = klines[i - 1].low, pc = klines[i - 1].close;
                tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
                const um = h - ph, dm = pl - l;
                pdm.push(um > dm && um > 0 ? um : 0);
                mdm.push(dm > um && dm > 0 ? dm : 0);
            }
            const P = 14;
            if (tr.length < P) return { pdiArr: [] as number[], mdiArr: [] as number[] };
            const smooth = (data: number[], p: number) => {
                const s: number[] = [];
                let cur = 0;
                for (let i = 0; i < p; i++) cur += data[i];
                s.push(cur);
                for (let i = p; i < data.length; i++) s.push(s[s.length - 1] - (s[s.length - 1] / p) + data[i]);
                return s;
            };
            const strA = smooth(tr, P), spdmA = smooth(pdm, P), smdmA = smooth(mdm, P);
            const pdi: number[] = [], mdi: number[] = [];
            for (let i = 0; i < strA.length; i++) {
                pdi.push(strA[i] > 0 ? (spdmA[i] / strA[i]) * 100 : 0);
                mdi.push(strA[i] > 0 ? (smdmA[i] / strA[i]) * 100 : 0);
            }
            return { pdiArr: pdi, mdiArr: mdi };
        })();
        const pdiOff = N - pdiArr.length;
        const pdiAt = (b: number) => b >= pdiOff ? pdiArr[b - pdiOff] : 0;
        const mdiAt = (b: number) => b >= pdiOff ? mdiArr[b - pdiOff] : 0;

        // ═══════════════════════════════════════════════════════════════════
        // MTF: 15m/1h (기존 캐싱 유지 — 이미 효율적)
        // ═══════════════════════════════════════════════════════════════════
        const klines15m = aggregateCandles(klines, 15);
        const klines1h = aggregateCandles(klines, 60);

        let cached15mIdx = -1, cached15mDir: 'Long' | 'Short' | null = null, cached15mScore = 0;
        let cached1hIdx = -1, cached1hDir: 'Long' | 'Short' | null = null, cached1hScore = 0;
        let cached1hAdx = 0, cached1hRegime: SimpleRegime = 'RANGING';
        let cached1hTpMult = 1.0, cached1hSlMult = 1.0;
        let running15mIdx = 0, running1hIdx = 0;

        // 1m 레짐 캐시 — ★ 60bar마다 재계산 (15→60, 4x 감소)
        let cached1mRegime: SimpleRegime = 'RANGING';
        let cached1mTpMult = 1.0, cached1mSlMult = 1.0;

        // ★ IIFE 지표 캐시 — 15bar마다 재계산 (기존: 매 bar)
        let cachedWtBullish = true, cachedWtBearish = true;
        let cachedIchiLongOk = true, cachedIchiShortOk = true;
        let cachedVwapDev = 0, cachedHurst = 0.5;

        for (let bar = WARMUP_BARS; bar < N; bar++) {
            const candle = klines[bar];

            // ── MTF 증분 인덱스 (기존 유지) ──
            const barTime = candle.time;
            while (running15mIdx < klines15m.length - 2 && klines15m[running15mIdx + 1].time <= barTime) running15mIdx++;
            const effective15mIdx = running15mIdx;
            while (running1hIdx < klines1h.length - 2 && klines1h[running1hIdx + 1].time <= barTime) running1hIdx++;
            const effective1hIdx = running1hIdx;

            if (effective15mIdx !== cached15mIdx && effective15mIdx >= 0 && klines15m.length > 52) {
                cached15mIdx = effective15mIdx;
                const w15m = klines15m.slice(Math.max(0, effective15mIdx - 60), effective15mIdx + 1);
                if (w15m.length >= 20) {
                    const d15m = this.scanner.detectDirection(w15m, w15m[w15m.length - 1].close);
                    cached15mDir = d15m.side || null;
                    cached15mScore = d15m.score;
                }
            }

            if (effective1hIdx !== cached1hIdx && effective1hIdx >= 0 && klines1h.length > 52) {
                cached1hIdx = effective1hIdx;
                const w1h = klines1h.slice(Math.max(0, effective1hIdx - 60), effective1hIdx + 1);
                if (w1h.length >= 20) {
                    const d1h = this.scanner.detectDirection(w1h, w1h[w1h.length - 1].close);
                    cached1hDir = d1h.side || null;
                    cached1hScore = d1h.score;
                    const adxArr1h = calculateADX(w1h, 14);
                    cached1hAdx = adxArr1h.length > 0 ? adxArr1h[adxArr1h.length - 1] : 0;
                    try {
                        const reg1h = await this.scanner.classifyRegime(ticker, w1h);
                        cached1hRegime = reg1h.simpleRegime;
                        cached1hTpMult = reg1h.tradingImplications?.tpMultiplier ?? 1.0;
                        cached1hSlMult = reg1h.tradingImplications?.slMultiplier ?? 1.0;
                    } catch { /* default */ }
                }
            }

            // ── O(1) 지표 룩업 (기존: slice+재계산) ──
            const atr = atrAt(bar);
            const adx = adxAt(bar);
            const rsi = rsiAt(bar);
            const ema20 = ema20At(bar);
            const ema50 = ema50At(bar);
            const ema200 = ema200At(bar);
            const bbLast = bbAt(bar);
            const mfi = mfiAt(bar);
            const pdi = pdiAt(bar);
            const mdi = mdiAt(bar);

            // EMA alignment
            const emaAlignment: 'BULLISH' | 'BEARISH' | 'MIXED' =
                ema20 > ema50 && ema50 > ema200 ? 'BULLISH'
                : ema200 > ema50 && ema50 > ema20 ? 'BEARISH' : 'MIXED';

            // ── detectDirection 인라인 (기존: scanner.detectDirection(window)) ──
            const atr10ago = bar >= atrOff + 10 ? rawATR[bar - atrOff - 10] : atr;
            const volatilityAccel = atr10ago > 0 ? atr / atr10ago : 1.0;
            // RSI slope
            const rsiNow = rsi;
            const rsi5ago = bar - 5 >= rsiOff ? rawRSI[bar - 5 - rsiOff] : rsiNow;
            const rsiSlope = rsi5ago !== 0 ? ((rsiNow - rsi5ago) / rsi5ago) * 100 : 0;
            // Volume ratio
            let vol20avg = 1, vol3avg = 1;
            if (bar >= 20) {
                let s20 = 0; for (let vi = bar - 19; vi <= bar; vi++) s20 += klines[vi].volume;
                vol20avg = s20 / 20;
                let s3 = 0; for (let vi = bar - 2; vi <= bar; vi++) s3 += klines[vi].volume;
                vol3avg = s3 / 3;
            }
            const volumeRatio = vol20avg > 0 ? vol3avg / vol20avg : 1.0;
            // Price momentum
            let priceMomentumSide: 'Long' | 'Short' | null = null;
            let priceMomPct = 0;
            if (bar >= 5) {
                priceMomPct = ((allCloses[bar] - allCloses[bar - 5]) / allCloses[bar - 5]) * 100;
                if (priceMomPct > 0.15) priceMomentumSide = 'Long';
                else if (priceMomPct < -0.15) priceMomentumSide = 'Short';
            }
            // DMI side
            let dmiSide: 'Long' | 'Short' | null = null;
            if (pdi > mdi) dmiSide = 'Long';
            else if (mdi > pdi) dmiSide = 'Short';
            // Direction resolution
            let dir1m: 'Long' | 'Short' | null = null;
            let dirScore = 0;
            let isReversal = false;
            if (dmiSide && priceMomentumSide && dmiSide !== priceMomentumSide) {
                dir1m = priceMomentumSide; isReversal = true;
            } else if (dmiSide) { dir1m = dmiSide; }
            else if (priceMomentumSide) { dir1m = priceMomentumSide; }
            if (!dir1m && adx < 10 && volatilityAccel < 1.3) { dir1m = null; }
            else if (!dir1m && volatilityAccel >= 1.3) {
                if (rsiSlope > 0.5) dir1m = 'Long';
                else if (rsiSlope < -0.5) dir1m = 'Short';
            }
            if (dir1m) {
                dirScore = 50 + adx;
                if (isReversal) dirScore += 15;
                if (volatilityAccel >= 1.5) dirScore += 20; else if (volatilityAccel >= 1.3) dirScore += 10;
                if (volumeRatio >= 2.0) dirScore += 15; else if (volumeRatio >= 1.5) dirScore += 8;
                const rsiDirMatch = (dir1m === 'Long' && rsiSlope > 0.3) || (dir1m === 'Short' && rsiSlope < -0.3);
                if (rsiDirMatch) dirScore += 10;
            }

            // ── Regime (60bar마다 캐시, 기존: 15bar) ──
            if (bar % 60 === 0 || bar === WARMUP_BARS) {
                try {
                    const window = klines.slice(Math.max(0, bar - 100), bar + 1);
                    const regimeResult = await this.scanner.classifyRegime(ticker, window);
                    cached1mRegime = regimeResult.simpleRegime;
                    cached1mTpMult = regimeResult.tradingImplications?.tpMultiplier ?? 1.0;
                    cached1mSlMult = regimeResult.tradingImplications?.slMultiplier ?? 1.0;
                } catch { /* default */ }
            }

            // ── Ignition (기존 로직 유지 — 이미 O(1) per bar) ──
            let ignitionScore = 0, volumeSpike = 0, ignitionBodyRatio = 0, ignitionConsecutive = 0;
            let ignitionVolAccel = false;
            const IGNITION_BASELINE = 7, IGNITION_RECENT = 3;
            if (bar >= WARMUP_BARS + IGNITION_BASELINE + IGNITION_RECENT) {
                let baselineVolSum = 0;
                for (let b = bar - IGNITION_BASELINE - IGNITION_RECENT; b < bar - IGNITION_RECENT; b++) baselineVolSum += klines[b].volume;
                let recentVolSum = 0;
                for (let b = bar - IGNITION_RECENT; b <= bar; b++) recentVolSum += klines[b].volume;
                const baselineAvgVol = baselineVolSum / IGNITION_BASELINE;
                const recentAvgVol = recentVolSum / IGNITION_RECENT;
                volumeSpike = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : 0;
                const prevClose = klines[bar - IGNITION_RECENT].close;
                const priceChangePct = prevClose > 0 ? Math.abs((candle.close - prevClose) / prevClose) * 100 : 0;
                ignitionScore = priceChangePct * volumeSpike;
                let bodyRatioSum = 0;
                for (let b = bar - IGNITION_RECENT; b <= bar; b++) {
                    const k = klines[b]; const range = k.high - k.low;
                    bodyRatioSum += range > 0 ? Math.abs(k.close - k.open) / range : 0;
                }
                ignitionBodyRatio = bodyRatioSum / IGNITION_RECENT;
                const lastDir = candle.close >= candle.open ? 1 : -1;
                ignitionConsecutive = 0;
                for (let b = bar; b > bar - IGNITION_RECENT - 1 && b >= 0; b--) {
                    const d = klines[b].close >= klines[b].open ? 1 : -1;
                    if (d === lastDir) ignitionConsecutive++; else break;
                }
                ignitionVolAccel = bar >= 2 && klines[bar].volume > klines[bar - 1].volume && klines[bar - 1].volume > klines[bar - 2].volume;
            }

            // ── TF Consensus ──
            let tfConsensus = 0;
            const refDir = cached1hDir;
            if (refDir) {
                if (dir1m === refDir) tfConsensus++;
                if (cached15mDir === refDir) tfConsensus++;
                tfConsensus++;
            } else {
                tfConsensus = 1;
                if (cached15mDir === dir1m) tfConsensus++;
            }

            // ── Trap: S/R + Submarine (기존 유지 — 이미 O(lookback)) ──
            // ★ Choppiness Index 인라인 (기존: slice+재계산 → 직접 O(14) 계산)
            let choppinessIndex = 50;
            if (bar >= 15) {
                let trSum = 0, hh = -Infinity, ll = Infinity;
                for (let ci = bar - 14; ci <= bar; ci++) {
                    if (klines[ci].high > hh) hh = klines[ci].high;
                    if (klines[ci].low < ll) ll = klines[ci].low;
                    if (ci > bar - 14) {
                        const h = klines[ci].high, l = klines[ci].low, pc = klines[ci - 1].close;
                        trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
                    }
                }
                const range = hh - ll;
                if (range > 0) choppinessIndex = 100 * Math.log10(trSum / range) / Math.log10(14);
                if (isNaN(choppinessIndex)) choppinessIndex = 50;
            }

            const srLevels = detectSRLevels(klines, bar);
            const nearestSupport = srLevels.support;
            const nearestResistance = srLevels.resistance;
            const submarine = detectSubmarinePattern(klines, bar, nearestSupport, nearestResistance);

            // Engine A: Trend hunting (PDI/MDI 선계산 룩업)
            const pdiGtMdi = pdi > mdi;
            const trapEngineA = adx > 20 && (
                (pdiGtMdi && candle.close > ema20) || (!pdiGtMdi && candle.close < ema20)
            );
            // Engine B: Mean reversion (BB 선계산 룩업)
            const trapEngineB = adx < 45 && bbLast !== null && (
                (rsi < 35 && candle.close <= bbLast.lower) || (rsi > 65 && candle.close >= bbLast.upper)
            );

            // ★ v47: Trap 리클레임 봉 볼륨 비율 (현재 vol / 20봉 평균)
            let trapReclaimVol = 0;
            if (bar >= 20) {
                let volSum20 = 0;
                for (let vi = bar - 20; vi < bar; vi++) volSum20 += klines[vi].volume;
                const avgVol20 = volSum20 / 20;
                trapReclaimVol = avgVol20 > 0 ? candle.volume / avgVol20 : 0;
            }

            // ── Flow (기존 유지 — 이미 O(1)) ──
            const flowVolAccel = bar >= 2 && klines[bar].volume > klines[bar - 1].volume && klines[bar - 1].volume > klines[bar - 2].volume;
            // ★ v47: Flow 볼륨 스파이크 (현재 vol / 5봉 평균)
            let flowVolSpike = 0;
            if (bar >= 5) {
                let volSum5 = 0;
                for (let vi = bar - 5; vi < bar; vi++) volSum5 += klines[vi].volume;
                const avgVol5 = volSum5 / 5;
                flowVolSpike = avgVol5 > 0 ? candle.volume / avgVol5 : 0;
            }
            const flowDir = dir1m;
            const flowTrendCont = bar >= 10 && flowDir ? calculateTrendContinuity(klines, bar, flowDir, 10) : 0;
            // ★ v47: flowVolAccel OR flowVolSpike >= flowVolSpikeMin (표본 확대)
            const flowDetected = adx > 25 && flowDir !== null && (flowVolAccel || flowVolSpike >= 1.3) && flowTrendCont >= 0.4;

            // ── Wick (기존 유지) ──
            const wickResult = bar >= 10 ? calculateWickRatioDetailed(klines, bar, 10) : { avgWickRatio: 0, lastUpperWick: 0, lastLowerWick: 0 };
            const wickProxPct = 0.005;
            const wickNearSupport = nearestSupport > 0 && candle.close > 0 && Math.abs(candle.close - nearestSupport) / candle.close < wickProxPct;
            const wickNearResistance = nearestResistance > 0 && candle.close > 0 && Math.abs(candle.close - nearestResistance) / candle.close < wickProxPct;

            // ── Gap: FVG 인라인 (slice 최소화) ──
            let gapDetected = false, gapSide: 'Long' | 'Short' | null = null;
            let gapSizePct = 0, gapMidpoint = 0, gapAgeBars = 0;
            {
                const gapStart = Math.max(2, bar - 50);
                // FVG 인라인 — 50바만 순회, 외부 함수 호출 제거
                for (let gi = bar; gi >= gapStart; gi--) {
                    // Bullish FVG: klines[gi-2].high < klines[gi].low
                    if (gi >= 2 && klines[gi - 2].high < klines[gi].low) {
                        const fvgHigh = klines[gi].low, fvgLow = klines[gi - 2].high;
                        const isFilled = candle.close <= fvgLow;
                        const sz = candle.close > 0 ? (fvgHigh - fvgLow) / candle.close * 100 : 0;
                        if (!isFilled && sz >= 0.1) {
                            gapDetected = true; gapSide = 'Long';
                            gapSizePct = sz; gapMidpoint = (fvgHigh + fvgLow) / 2;
                            gapAgeBars = bar - gi; break;
                        }
                    }
                    // Bearish FVG: klines[gi-2].low > klines[gi].high
                    if (gi >= 2 && klines[gi - 2].low > klines[gi].high) {
                        const fvgHigh = klines[gi - 2].low, fvgLow = klines[gi].high;
                        const isFilled = candle.close >= fvgHigh;
                        const sz = candle.close > 0 ? (fvgHigh - fvgLow) / candle.close * 100 : 0;
                        if (!isFilled && sz >= 0.1) {
                            gapDetected = true; gapSide = 'Short';
                            gapSizePct = sz; gapMidpoint = (fvgHigh + fvgLow) / 2;
                            gapAgeBars = bar - gi; break;
                        }
                    }
                }
            }

            // ── IIFE 지표 캐시 (15bar마다 재계산, Hurst 60bar마다) ──
            if (bar % 15 === 0 || bar === WARMUP_BARS) {
                const window = klines.slice(Math.max(0, bar - 100), bar + 1);
                const wt = calculateWaveTrend(window);
                const ichi = calculateIchimoku(window);
                const vwapData = calculateVWAP(window, 24);
                cachedWtBullish = wt ? (wt.wt1 > wt.wt2 || wt.wt1 < -53) : true;
                cachedWtBearish = wt ? (wt.wt1 < wt.wt2 || wt.wt1 > 53) : true;
                cachedIchiLongOk = ichi ? (ichi.priceVsCloud === 'ABOVE' && ichi.tkCross !== 'BEARISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BULLISH') : true;
                cachedIchiShortOk = ichi ? (ichi.priceVsCloud === 'BELOW' && ichi.tkCross !== 'BULLISH') || (ichi.priceVsCloud === 'IN_CLOUD' && ichi.tkCross === 'BEARISH') : true;
                cachedVwapDev = vwapData ? (candle.close - vwapData.vwap) / (vwapData.stdDev || 1) : 0;
            }
            if (bar % 60 === 0 || bar === WARMUP_BARS) {
                const closes100 = allCloses.slice(Math.max(0, bar - 99), bar + 1);
                cachedHurst = closes100.length >= 100 ? calculateHurstExponent(closes100) : 0.5;
            }

            bars.push({
                bar, candle,
                direction: dir1m, score: dirScore,
                regime: cached1mRegime, atr, adx, rsi, emaAlignment,
                regimeTpMultiplier: cached1mTpMult, regimeSlMultiplier: cached1mSlMult,
                ignitionScore, volumeSpike, ignitionBodyRatio, ignitionConsecutive, ignitionVolAccel,
                regime1h: cached1hRegime, direction1h: cached1hDir, dirScore1h: cached1hScore,
                adx1h: cached1hAdx, regimeTpMult1h: cached1hTpMult, regimeSlMult1h: cached1hSlMult,
                direction15m: cached15mDir, dirScore15m: cached15mScore, tfConsensus,
                volatilityAccel, volumeRatio,
                wtBullish: cachedWtBullish, wtBearish: cachedWtBearish,
                ichiLongOk: cachedIchiLongOk, ichiShortOk: cachedIchiShortOk,
                vwapDeviation: cachedVwapDev, mfi, hurst: cachedHurst,
                choppinessIndex, nearestSupport, nearestResistance,
                trapSubmarineDetected: submarine.detected, trapSubmarineSide: submarine.side,
                trapBreakPercent: submarine.breakPercent, trapReclaimBarsAgo: submarine.reclaimBarsAgo,
                trapEngineA, trapEngineB, trapReclaimVol,
                flowDetected, flowSide: flowDir, flowTrendContinuity: flowTrendCont, flowVolAccel, flowVolSpike,
                wickAvgRatio: wickResult.avgWickRatio, wickLastUpper: wickResult.lastUpperWick,
                wickLastLower: wickResult.lastLowerWick, wickNearSupport, wickNearResistance,
                gapDetected, gapSide, gapSizePct, gapMidpoint, gapAgeBars,
            });

            // ★ 10000바마다 이벤트 루프 양보 (UI 반응성)
            if (bar % 10000 === 0) await new Promise(r => setTimeout(r, 0));
        }

        return bars;
    }

    // ── 시간 동기화 크로스-종목 시뮬레이션 ──
    //
    // v30: 종목별 독립 시뮬 → 시간축 동기화 시뮬 전환
    // maxPositions > 1: 동시 보유 포지션 수를 maxPositions으로 제한 (포트폴리오)
    // maxPositions = 1: 종목별 독립 시뮬 (고배 몰빵 — 종목 간 경쟁 없음)

    private simulateAllTickers(
        tickers: string[],
        config: TradingConfig,
        params: BacktestParams,
        barRange?: { start: number; end: number },
    ): BacktestTickerResult[] {
        const maxPos = params.maxPositions;
        const adxGateMin = params.adxGateMinimum;
        // maxHoldingBars 삭제 — TP/SL로만 청산

        // 종목별 시그널 + 바 범위 수집
        const tickerList: string[] = [];
        const signalArrays: PrecomputedBar[][] = [];
        const firstBars: number[] = [];
        let globalMinBar = Infinity;
        let globalMaxBar = -Infinity;

        for (const ticker of tickers) {
            const signals = this.signalCache.get(ticker);
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

        // Walk-Forward: 바 범위 제한
        const effectiveMinBar = barRange ? Math.max(globalMinBar, barRange.start) : globalMinBar;
        const effectiveMaxBar = barRange ? Math.min(globalMaxBar, barRange.end) : globalMaxBar;

        // O(1) 종목 인덱스 룩업
        const tickerToIdx = new Map<string, number>();
        tickerList.forEach((t, i) => tickerToIdx.set(t, i));

        const openPositions = new Map<string, SimPosition>();
        const tickerTradesMap = new Map<string, BacktestTrade[]>();

        // ★ Ignition-only: 존 대기/모멘텀 바이패스 제거 — 즉시 진입만

        for (let bar = effectiveMinBar; bar <= effectiveMaxBar; bar++) {
            // --- Pass 1: 기존 포지션 출구 체크 ---
            for (const [ticker, pos] of [...openPositions.entries()]) {
                const ti = tickerToIdx.get(ticker)!;
                const signals = signalArrays[ti];
                const idx = bar - firstBars[ti];
                if (idx < 0 || idx >= signals.length) continue;
                const sig = signals[idx];

                const exit = this.resolveExit(pos, sig.candle);
                if (exit) {
                    const pnl = this.calculateTradePnl(pos, exit);
                    if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                    tickerTradesMap.get(ticker)!.push(
                        this.buildTrade(ticker, pos, exit, pnl, sig.candle.time, bar - pos.entryBar),
                    );
                    openPositions.delete(ticker);
                    continue;
                }

                // ★ v53.8: 60분(60바) 타임아웃 — 11종목 분석: 30-60분 스윗스팟, 60분+ 음의 EV
                const MAX_HOLD_BARS = 60;
                const barsHeld = bar - pos.entryBar;
                if (barsHeld >= MAX_HOLD_BARS) {
                    const forcedExit: ExitResult = {
                        exitPrice: sig.candle.close,
                        reason: 'MAX_HOLD' as any,
                        partialRealized: pos.tp1PnlRealized,
                    };
                    const pnl = this.calculateTradePnl(pos, forcedExit);
                    if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                    tickerTradesMap.get(ticker)!.push(
                        this.buildTrade(ticker, pos, forcedExit, pnl, sig.candle.time, barsHeld),
                    );
                    openPositions.delete(ticker);
                    continue;
                }

                // ★ 물려있는 시간 카운트 (포지션 생존 & 손실 상태인 바)
                const isLong = pos.direction === 'Long';
                if ((isLong && sig.candle.close < pos.entryPrice) || (!isLong && sig.candle.close > pos.entryPrice)) {
                    pos.underwaterBars++;
                }

                // 해당 종목의 마지막 바 → 강제 청산
                if (idx === signals.length - 1) {
                    const forcedExit: ExitResult = {
                        exitPrice: sig.candle.close,
                        reason: 'END_OF_DATA',
                        partialRealized: pos.tp1PnlRealized,
                    };
                    const pnl = this.calculateTradePnl(pos, forcedExit);
                    if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                    tickerTradesMap.get(ticker)!.push(
                        this.buildTrade(ticker, pos, forcedExit, pnl, sig.candle.time, bar - pos.entryBar),
                    );
                    openPositions.delete(ticker);
                }
            }

            // --- Pass 2: 신규 진입 (Ignition + Trap) ---
            // maxPositions = 1: 종목별 독립 (글로벌 제한 없음, 각 종목 개별 거래)
            // maxPositions > 1: 포트폴리오 (동시 보유 수 제한)
            for (let ti = 0; ti < tickerList.length; ti++) {
                if (maxPos > 1 && openPositions.size >= maxPos) break;
                const ticker = tickerList[ti];
                if (openPositions.has(ticker)) continue;

                const signals = signalArrays[ti];
                const idx = bar - firstBars[ti];
                if (idx < 0 || idx >= signals.length) continue;
                const sig = signals[idx];

                const isAggressive = maxPos <= 1;
                const effectiveRegime = sig.regime1h || sig.regime || 'TRENDING';
                const leverage = calcLeverage(config, effectiveRegime, sig.candle.time);

                let enteredThisBar = false;

                // ═══ Strategy 1: Ignition ═══
                do {
                    const minTfConsensus = params.minTfConsensus ?? 2;
                    const useDir = sig.direction1h ?? sig.direction;
                    const useDirScore = sig.direction1h ? sig.dirScore1h : sig.score;
                    if (!useDir) break;
                    if (sig.tfConsensus < minTfConsensus) break;

                    const direction: 'Long' | 'Short' = params.reverseMode
                        ? (useDir === 'Long' ? 'Short' : 'Long')
                        : useDir;

                    const dirMultiplier = direction === 'Long'
                        ? (config.directionBias?.longMultiplier ?? 1.0)
                        : params.shortMultiplier;
                    if (useDirScore * dirMultiplier < 25) break;

                    if (sig.adx > 0 && sig.adx < adxGateMin) break;
                    if (direction === 'Long' && sig.rsi > 85) break;
                    if (direction === 'Short' && sig.rsi < 25) break;

                    // ★ v53.7: RSI 45-70 게이트 (v53.5에서 35-70 → 45-70 축소)
                    // 35-45 구간 EV +0.21로 약함, 45-70만 유지
                    if (sig.rsi < 45 || sig.rsi > 70) break;

                    // ★ v53.5: EMA alignment 필터 사용 금지
                    // 포워드테스트 분석 결과: EMA 역방향 거래가 오히려 수익원
                    // 역EMA 제거 시 PnL -2230 손실 → 절대 필터링하면 안 됨

                    if (params.useWaveTrend) {
                        if (direction === 'Long' && !sig.wtBullish) break;
                        if (direction === 'Short' && !sig.wtBearish) break;
                    }
                    if (params.useIchimoku) {
                        if (direction === 'Long' && !sig.ichiLongOk) break;
                        if (direction === 'Short' && !sig.ichiShortOk) break;
                    }
                    if (params.useVWAP) {
                        if (direction === 'Long' && sig.vwapDeviation > 2.0) break;
                        if (direction === 'Short' && sig.vwapDeviation < -2.0) break;
                    }
                    if (params.useMFI) {
                        if (direction === 'Long' && sig.mfi > 80) break;
                        if (direction === 'Short' && sig.mfi < 20) break;
                    }
                    if (params.useHurst) {
                        if (sig.hurst < 0.35) break;
                    }

                    const igThreshold = params.ignitionScoreThreshold ?? 0.7;
                    const igVolMin = params.ignitionVolMin ?? 2.0;
                    const igBodyMin = params.ignitionBodyMin ?? 0.5;
                    const igConsecMin = params.ignitionConsecMin ?? 2;

                    if (sig.ignitionScore < igThreshold) break;
                    if (sig.volumeSpike < igVolMin) break;
                    if (sig.ignitionBodyRatio < igBodyMin) break;
                    if (sig.ignitionConsecutive < igConsecMin) break;

                    const nextIdx = idx + 1;
                    if (nextIdx >= signals.length) break;
                    const nextBar = signals[nextIdx];
                    const nextOpen = nextBar.candle.open;

                    // ★ v53.2: regimeTpMultiplier=1.0 통일 (실전과 동일)
                    // 백테에서도 WF tpAtrMultiplier만 사용 — 레짐 multiplier 제거
                    const tpslNext = this.execution.calculateTPSL({
                        price: nextOpen, direction, atr: sig.atr, config, leverage,
                        regimeTpMultiplier: 1.0,
                        regimeSlMultiplier: 1.0,
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

                    const { session: entrySession, dayType: entryDayType } = getSessionAndDayType(nextBar.candle.time);
                    openPositions.set(ticker, {
                        entryBar: bar + 1,
                        direction,
                        entryPrice: nextOpen,
                        tp1Price: tpslNext.tp1Price,
                        tp2Price: tpslNext.tpPrice,
                        slPrice: tpslNext.slPrice,
                        leverage,
                        regime: effectiveRegime,
                        session: entrySession,
                        dayType: entryDayType,
                        score: useDirScore,
                        tp1Hit: false,
                        tp1PnlRealized: 0,
                        entryTime: nextBar.candle.time,
                        underwaterBars: 0,
                        entryDNA,
                        strategyType: 'IGNITION',
                    });
                    enteredThisBar = true;
                } while (false);

                // ★ v53.2: Strategy 2 (Trap) 완전 삭제 — IGNITION only
                // 포워드테스트 분석 결과: TRAP WR=36.7% EV=-2.96 (전체 손실의 주범)

            }
        }

        // barRange 또는 데이터 끝: 미청산 포지션 강제 청산
        for (const [ticker, pos] of [...openPositions.entries()]) {
            const ti = tickerToIdx.get(ticker)!;
            const signals = signalArrays[ti];
            const lastIdx = Math.min(effectiveMaxBar - firstBars[ti], signals.length - 1);
            if (lastIdx >= 0 && lastIdx < signals.length) {
                const sig = signals[lastIdx];
                const forcedExit: ExitResult = {
                    exitPrice: sig.candle.close,
                    reason: 'END_OF_DATA',
                    partialRealized: pos.tp1PnlRealized,
                };
                const pnl = this.calculateTradePnl(pos, forcedExit);
                if (!tickerTradesMap.has(ticker)) tickerTradesMap.set(ticker, []);
                tickerTradesMap.get(ticker)!.push(
                    this.buildTrade(ticker, pos, forcedExit, pnl, sig.candle.time, effectiveMaxBar - pos.entryBar),
                );
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
            // ★ per-ticker PnL: 평균 수익률 (합산 → 평균: 실전과 일치시키기 위해)
            const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPercent, 0) / trades.length : 0;
            // DD 계산은 간단한 누적 방식
            let peak = 0, maxDD = 0, cumPnl = 0;
            for (const t of trades) {
                cumPnl += t.pnlPercent;
                if (cumPnl > peak) peak = cumPnl;
                const dd = peak - cumPnl;
                if (dd > maxDD) maxDD = dd;
            }

            // ★ 평균 물려있는 시간 (분) = avg(underwaterBars) × 5분
            const avgUnderwaterMinutes = trades.length > 0
                ? (trades.reduce((s, t) => s + t.underwaterBars, 0) / trades.length) * 1
                : 0;
            // ★ 평균 보유시간 (분) = avg(barsHeld) × 5분
            const avgHoldingMinutes = trades.length > 0
                ? (trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) * 1
                : 0;

            results.push({
                ticker,
                trades,
                totalTrades: trades.length,
                wins,
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

    // ── 헬퍼 ──

    private buildTrade(
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

    // ── 양자역학적 바 해결 (BacktestEngine과 동일 로직) ──

    // TP1 전량 청산 + 트레일링 스탑
    private resolveExit(position: SimPosition, candle: KlineData): ExitResult | null {
        const { direction, tp1Price } = position;
        const isLong = direction === 'Long';

        // SL/TP 체크 (트레일링 스탑 제거 — 단순 TP/SL만 사용)
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
    private quantumResolve(position: SimPosition, candle: KlineData): boolean {
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

    // TP1 전량 청산 (실전과 동일 — partialQty1 = 1.0)
    private processTP(position: SimPosition, candle: KlineData): ExitResult | null {
        const { direction, tp1Price, tp1Hit } = position;
        const isLong = direction === 'Long';

        if (!tp1Hit) {
            const tpReached = isLong ? candle.high >= tp1Price : candle.low <= tp1Price;
            if (tpReached) {
                return { exitPrice: tp1Price, reason: 'TP1', partialRealized: 0 };
            }
        }
        return null;
    }

    // PnL 계산 — 전량 TP/SL (부분 익절 로직 제거)
    private calculateTradePnl(position: SimPosition, exit: ExitResult): number {
        const { entryPrice, direction, leverage } = position;
        const { exitPrice } = exit;

        let pnl: number;
        if (direction === 'Long') {
            pnl = (exitPrice - entryPrice) / entryPrice;
        } else {
            pnl = (entryPrice - exitPrice) / entryPrice;
        }

        return (pnl - TOTAL_FEE_RATE) * leverage * 100;
    }

    private buildEquityCurve(trades: BacktestTrade[], baseSizePercent: number = 20): {
        curve: { time: number; equity: number }[];
        ddStats: { tradesSkipped: number; tradesReduced: number; maxConsecutiveLosses: number; circuitBreakerHits: number };
    } {
        const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
        let equity = 100;
        let peak = 100;
        let consecutiveLosses = 0;
        let maxConsecLosses = 0;
        let tradesSkipped = 0;
        let tradesReduced = 0;
        let circuitBreakerHits = 0;
        const sizeRatio = baseSizePercent / 100;
        const curve: { time: number; equity: number }[] = [{ time: sorted[0]?.entryTime || 0, equity: 100 }];

        // ★ v36: DD관리 제거 — 백테/시뮬과 동일하게 플랫 사이징 (실전 동기화)
        for (const trade of sorted) {
            const portfolioImpact = trade.pnlPercent * sizeRatio;
            equity = Math.max(0, equity * (1 + portfolioImpact / 100));

            if (trade.pnlPercent > 0) {
                consecutiveLosses = 0;
            } else {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
            }

            if (equity > peak) peak = equity;
            curve.push({ time: trade.exitTime, equity });
        }

        return {
            curve,
            ddStats: { tradesSkipped, tradesReduced, maxConsecutiveLosses: maxConsecLosses, circuitBreakerHits },
        };
    }

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

    // ── 경량 집계 (에쿼티 커브 포함하지 않음) ──

    private aggregateLight(tickerResults: BacktestTickerResult[], config: TradingConfig): BacktestSummary {
        const allTrades = tickerResults.flatMap(r => r.trades).sort((a, b) => a.entryTime - b.entryTime);
        const totalTrades = allTrades.length;
        const totalWins = allTrades.filter(t => t.pnlPercent > 0).length;
        const totalLosses = totalTrades - totalWins;
        const winPnls = allTrades.filter(t => t.pnlPercent > 0).map(t => t.pnlPercent);
        const lossPnls = allTrades.filter(t => t.pnlPercent <= 0).map(t => t.pnlPercent);

        const baseSizePercent = config.sizing?.baseSizePercent ?? 20;
        const { curve: equityCurve, ddStats } = this.buildEquityCurve(allTrades, baseSizePercent);
        const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : 100;

        return {
            tickers: tickerResults,
            totalTrades,
            totalWins,
            totalLosses,
            overallWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
            totalPnlPercent: totalTrades > 0 ? allTrades.reduce((s, t) => s + t.pnlPercent, 0) / totalTrades : 0,  // 평균 수익률
            avgWinPercent: winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0,
            avgLossPercent: lossPnls.length > 0 ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length : 0,
            maxDrawdownPercent: this.calculateDrawdown(equityCurve),
            profitFactor: lossPnls.length > 0
                ? Math.abs(winPnls.reduce((s, v) => s + v, 0)) / Math.abs(lossPnls.reduce((s, v) => s + v, 0))
                : winPnls.length > 0 ? 999 : 0,
            equityCurve: [], // 경량: 에쿼티 커브 비포함
            startTime: 0,
            endTime: 0,
            durationMs: 0,
            ddManagement: ddStats,
        };
    }

    // ── 조합 생성 (카르테시안 곱) ──

    private generateCombos(base: BacktestParams, ranges: OptimizerParamRange[]): BacktestParams[] {
        let combos: BacktestParams[] = [{ ...base }];
        for (const range of ranges) {
            const expanded: BacktestParams[] = [];
            for (const combo of combos) {
                for (const val of range.values) {
                    expanded.push({ ...combo, [range.key]: val });
                }
            }
            combos = expanded;
        }
        // ★ v52.29: Lev-R/V가 0이면 Lev-T 값으로 연동
        for (const c of combos) {
            if (c.leverageRanging === 0) c.leverageRanging = c.leverageTrending;
            if (c.leverageVolatile === 0) c.leverageVolatile = c.leverageTrending;
        }
        return combos;
    }

    // ── 2차 미세 최적화 (Fine-tuning) ──
    // 1차 최적화에서 찾은 최적값 주변을 미세 탐색하여 더 나은 파라미터 발견

    runSingleTickerFineTune(
        ticker: string,
        baseParams: BacktestParams,
        config: TradingConfig,
    ): { params: BacktestParams; pnl: number; winRate: number; trades: number; avgWin: number; avgLoss: number } | null {
        const signals = this.signalCache.get(ticker);
        if (!signals || signals.length < 50) return null;

        // ★ TP: 기존값 ±40% 범위에서 7단계 (미세최적화 강화)
        const baseTP = baseParams.tpAtrMultiplier;
        const tpValues = [
            +(baseTP * 0.6).toFixed(2),
            +(baseTP * 0.75).toFixed(2),
            +(baseTP * 0.9).toFixed(2),
            +baseTP.toFixed(2),
            +(baseTP * 1.1).toFixed(2),
            +(baseTP * 1.25).toFixed(2),
            +(baseTP * 1.4).toFixed(2),
        ].filter((v, i, a) => a.indexOf(v) === i);  // 중복 제거

        // ★ v52.23: Lev (레짐별): 기존값 ±40% 범위에서 5단계 (상한 20x)
        const MAX_LEVERAGE = 20;
        const MIN_LEVERAGE = 5;
        const makeLevRange = (base: number) => {
            const capped = Math.min(Math.max(base, MIN_LEVERAGE), MAX_LEVERAGE);
            return [
                Math.max(MIN_LEVERAGE, Math.round(capped * 0.6)),
                Math.max(MIN_LEVERAGE, Math.round(capped * 0.8)),
                Math.round(capped),
                Math.min(MAX_LEVERAGE, Math.round(capped * 1.2)),
                Math.min(MAX_LEVERAGE, Math.round(capped * 1.4)),
            ].filter((v, i, a) => a.indexOf(v) === i);
        };
        const levValues = makeLevRange(baseParams.leverageTrending);

        // ★ v52.29: 레버리지 통합 — TP(7) × Lev(5) = 최대 35개 (기존 875개)

        // ★ 학습 구간 barRange 계산 (검증 데이터 제외)
        const trainBarRange = this.lastTrainEndBar ? (() => {
            const signals = this.signalCache.get(ticker);
            if (!signals || signals.length === 0) return undefined;
            return { start: signals[0].bar, end: this.lastTrainEndBar! };
        })() : undefined;

        let bestEV = -Infinity;
        let bestResult: { params: BacktestParams; pnl: number; winRate: number; trades: number; avgWin: number; avgLoss: number } | null = null;

        for (const tp of tpValues) {
            for (const lev of levValues) {
                        const testParams: BacktestParams = {
                            ...baseParams,
                            tpAtrMultiplier: tp,
                            leverageTrending: lev,
                            leverageRanging: lev,
                            leverageVolatile: lev,
                        };
                        const testConfig = applyParamsToConfig(config, testParams);
                        // ★ 학습 데이터에서만 시뮬레이션 (검증 데이터 오염 방지)
                        const results = this.simulateAllTickers([ticker], testConfig, testParams, trainBarRange);
                        if (results.length === 0) continue;
                        const r = results[0];
                        if (r.totalTrades < 2) continue;
                        // ★ EV 기준 선택 (WR × R:R 동시 반영)
                        const winTrades = r.trades.filter(t => t.pnlPercent > 0);
                        const lossTrades = r.trades.filter(t => t.pnlPercent <= 0);
                        const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnlPercent, 0) / winTrades.length : 0;
                        const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnlPercent, 0) / lossTrades.length : 0;
                        const ev = (r.winRate / 100) * avgWin + ((100 - r.winRate) / 100) * avgLoss;
                        if (ev > bestEV) {
                            bestEV = ev;
                            bestResult = {
                                params: testParams,
                                pnl: r.totalTrades > 0 ? r.totalPnlPercent / r.totalTrades : 0,
                                winRate: r.winRate,
                                trades: r.totalTrades,
                                avgWin,
                                avgLoss,
                            };
                        }
            }
        }

        // ★ 검증 재실행: 미세최적화 결과를 검증 데이터에서 재검증
        if (bestResult && this.lastValBarRange) {
            const valConfig = applyParamsToConfig(config, bestResult.params);
            const valResults = this.simulateAllTickers([ticker], valConfig, bestResult.params, this.lastValBarRange);
            if (valResults.length > 0 && valResults[0].totalTrades >= 1) {
                const valR = valResults[0];
                const valWinTrades = valR.trades.filter(t => t.pnlPercent > 0);
                const valLossTrades = valR.trades.filter(t => t.pnlPercent <= 0);
                const valAvgWin = valWinTrades.length > 0 ? valWinTrades.reduce((s, t) => s + t.pnlPercent, 0) / valWinTrades.length : 0;
                const valAvgLoss = valLossTrades.length > 0 ? valLossTrades.reduce((s, t) => s + t.pnlPercent, 0) / valLossTrades.length : 0;
                const valEV = (valR.winRate / 100) * valAvgWin + ((100 - valR.winRate) / 100) * valAvgLoss;
                // ★ 검증 EV > 0이면 검증 수치로 교체, 아니면 미세최적화 기각
                if (valEV > 0) {
                    bestResult = {
                        params: bestResult.params,
                        pnl: valR.totalTrades > 0 ? valR.totalPnlPercent / valR.totalTrades : 0,
                        winRate: valR.winRate,
                        trades: valR.totalTrades,
                        avgWin: valAvgWin,
                        avgLoss: valAvgLoss,
                    };
                } else {
                    return null;  // ★ 검증 EV ≤ 0 → 미세최적화 기각, 원본 유지
                }
            }
            // 검증 데이터에 트레이드가 없으면 → 학습 결과 그대로 반환 (보수적 유지)
        }

        return bestResult;
    }

    // ── 상위 급등/급락 종목 (Ignition Scanner 통합) ──

    private async fetchTopMovers(topN: number): Promise<string[]> {
        const tickers = await bybitService.fetchMarketTickers();
        const filtered = tickers
            .filter((t: any) => t.symbol.endsWith('USDT') && t.volume >= MIN_VOLUME_USD)
            .sort((a: any, b: any) => Math.abs(b.rawChangePercent) - Math.abs(a.rawChangePercent));

        // ★ v52.11: 후보 풀 50→150개로 확대 (500+ 종목 중 더 많이 탐색)
        const CANDIDATE_POOL = Math.min(150, filtered.length);
        const candidates = filtered.slice(0, CANDIDATE_POOL).map((t: any) => t.symbol);
        const ignitionMap = await calculateIgnitionScores(candidates);

        // 정렬: igniting (score ≥ 0.5) 우선 → score 내림차순, 나머지는 24h 변동률 순
        const withScores = filtered.slice(0, CANDIDATE_POOL).map((t: any) => ({
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
}

// ── Ignition Score 계산 (5분봉 기반 실시간 급등/급락 감지) ──

const IGNITION_THRESHOLD = 0.5;
const IGNITION_KLINE_COUNT = 10;  // 7 baseline + 3 recent

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
                    sym, '5m', IGNITION_KLINE_COUNT
                );
                if (klines.length < IGNITION_KLINE_COUNT) return;

                const baseline = klines.slice(0, 7);  // 이전 7봉
                const recent = klines.slice(7);        // 최근 3봉

                // 가격 변화율 (최근 3봉)
                const priceChange = ((recent[2].close - recent[0].open) / recent[0].open) * 100;

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
