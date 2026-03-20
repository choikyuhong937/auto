
import { z } from 'zod';
import type { ZoneStrategyType } from './services/zoneCalculator';

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

// ===== 간소화된 레짐 분류 (자동 조절용) =====
export type SimpleRegime = 'TRENDING' | 'RANGING' | 'VOLATILE';

// ===== 진입 타입 × 레짐 복합키 (3-way: 1전략 × 3레짐) =====
export type EntryType = 'IGNITION';
export const ENTRY_TYPES: EntryType[] = ['IGNITION'];

export type RegimeEntryKey =
    | 'TRENDING_IGNITION'
    | 'RANGING_IGNITION'
    | 'VOLATILE_IGNITION';

export const ALL_REGIME_ENTRY_KEYS: RegimeEntryKey[] = [
    'TRENDING_IGNITION',
    'RANGING_IGNITION',
    'VOLATILE_IGNITION',
];

export function makeRegimeEntryKey(regime: SimpleRegime, et: EntryType): RegimeEntryKey {
    return `${regime}_${et}` as RegimeEntryKey;
}

export function parseRegimeEntryKey(key: string): { regime: SimpleRegime; entryType: EntryType } {
    const idx = key.lastIndexOf('_');
    return { regime: key.slice(0, idx) as SimpleRegime, entryType: key.slice(idx + 1) as EntryType };
}

// ===== ★ v36: 세션 × 주말/평일 시간 세분화 (18-way) =====
export type Session = 'ASIA' | 'EUROPE' | 'US';
export type DayType = 'WEEKDAY' | 'WEEKEND';
export type TimeSegmentKey = `${SimpleRegime}_${EntryType}_${Session}_${DayType}`;

export const ALL_SESSIONS: Session[] = ['ASIA', 'EUROPE', 'US'];
export const ALL_DAYTYPES: DayType[] = ['WEEKDAY', 'WEEKEND'];

/** UTC 시간대 → 세션 + 주말/평일 판별 */
export function getSessionAndDayType(timestampMs: number): { session: Session; dayType: DayType } {
    const date = new Date(timestampMs);
    const utcHour = date.getUTCHours();
    const dayOfWeek = date.getUTCDay(); // 0=일, 6=토
    const session: Session = utcHour < 8 ? 'ASIA' : utcHour < 13 ? 'EUROPE' : 'US';
    const dayType: DayType = (dayOfWeek === 0 || dayOfWeek === 6) ? 'WEEKEND' : 'WEEKDAY';
    return { session, dayType };
}

export function makeTimeSegmentKey(regime: SimpleRegime, et: EntryType, session: Session, dayType: DayType): TimeSegmentKey {
    return `${regime}_${et}_${session}_${dayType}` as TimeSegmentKey;
}

export function parseTimeSegmentKey(key: string): { regime: SimpleRegime; entryType: EntryType; session: Session; dayType: DayType } {
    const parts = key.split('_');
    // e.g. 'TRENDING_IGNITION_ASIA_WEEKDAY'
    return {
        regime: parts[0] as SimpleRegime,
        entryType: parts[1] as EntryType,
        session: parts[2] as Session,
        dayType: parts[3] as DayType,
    };
}

/** 18-way 전체 키 목록 생성 */
export const ALL_TIME_SEGMENT_KEYS: TimeSegmentKey[] = (() => {
    const keys: TimeSegmentKey[] = [];
    const regimes: SimpleRegime[] = ['TRENDING', 'RANGING', 'VOLATILE'];
    for (const r of regimes) {
        for (const et of ENTRY_TYPES) {
            for (const s of ALL_SESSIONS) {
                for (const d of ALL_DAYTYPES) {
                    keys.push(makeTimeSegmentKey(r, et, s, d));
                }
            }
        }
    }
    return keys;
})();

// ★ EntryType 판별 — IGNITION only
export function getEntryTypeFromTrade(_trade: { strategyType?: string; entryDNA?: { zoneType: string } }): EntryType {
    return 'IGNITION';
}

export function getEntryTypeFromZoneType(_zoneType: string): EntryType {
    return 'IGNITION';
}

// ===== Bybit API 기반 거래 레코드 (MarketAwareTuner용) =====
export interface BybitTradeRecord {
    id: string;                    // orderId
    ticker: string;                // symbol
    direction: 'Long' | 'Short';
    entryPrice: number;            // avgEntryPrice
    exitPrice: number;             // avgExitPrice
    pnlPercent: number;            // closedPnl / (qty * entryPrice) * 100
    closedPnl: number;             // 원래 PnL (USDT)
    timestamp: number;             // createdTime (진입 시각)
    closeTimestamp: number;        // updatedTime (청산 시각)
    holdingMinutes: number;        // (updatedTime - createdTime) / 60000
    qty: number;
    leverage: string;
    // kline 기반 계산 (enrichTradeRecords에서 채움)
    rsi: number;                   // 진입 시 RSI(14)
    volumeRatio: number;           // 진입 시 볼륨 / 20봉 평균
    zoneType: string;              // 'unknown' (존 엔진 정보 없음)
    // StratTuner용 추가 지표 (enrichTradeRecords에서 계산)
    bbPosition: number;            // BB 포지션 0-100% (0=하단, 100=상단)
    momentum: number;              // 최근 5봉 모멘텀 %
    noiseRatio: number;            // 최근 3봉 avg(range/body)
    rangePosition: number;         // 최근 5봉 고저 내 위치 0-100%
    consecutiveCandles: number;    // 진입 전 같은방향 연속 캔들 수
    session: string;               // 'ASIA'|'EUROPE'|'US'|'OVERLAP_ASIA_EU'|'OVERLAP_EU_US'|'WEEKEND'
    adx: number;                   // ADX(14) from 1h klines (추세 강도)
}

// ===== StratTuner 통계 (Gemini 프롬프트용) =====
interface BucketStat { count: number; wr: number; avgPnl: number; }
export interface StratTunerStats {
    totalTrades: number;
    overallWR: number;
    overallPnl: number;
    byDirection: Record<string, BucketStat>;
    bySession: Record<string, BucketStat>;
    byMomentumBucket: Record<string, BucketStat>;
    byBBPosition: Record<string, BucketStat>;
    byNoiseRatio: Record<string, BucketStat>;
    byConsecutive: Record<string, BucketStat>;
    byRangePosition: Record<string, BucketStat>;
    byVolumeSpike: Record<string, BucketStat>;
    filterSimulation: Array<{
        filter: string;
        blockedCount: number;
        blockedWR: number;
        passedWR: number;
        verdict: string;
    }>;
    // ★ 교차분석 (Direction × Indicator)
    momentumByDirection: Record<string, BucketStat>;   // "Long+mom>0", "Short+mom<0" 등
    rsiByDirection: Record<string, BucketStat>;        // "Long+RSI<40", "Short+RSI>60" 등
    bbByDirection: Record<string, BucketStat>;         // "Long+BB<30%", "Short+BB>70%" 등
    byHoldingTime: Record<string, BucketStat>;         // "<5min", "5-15min", "15-30min" 등
    byADX: Record<string, BucketStat>;                 // "<15", "15-25", "25-40", ">40"
    topDangerCombos: Array<{ combo: string; count: number; wr: number; avgPnl: number }>;
    topOpportunityCombos: Array<{ combo: string; count: number; wr: number; avgPnl: number }>;
    // ★ v21: 레짐 컨텍스트 — 거래 실적 기반 (BTC 의존 제거)
    regimeContext: {
        marketTrend: 'BULL' | 'BEAR' | 'RANGE'; // 거래 데이터 기반 추세 판단
        longWR: number;                          // Long 승률 %
        shortWR: number;                         // Short 승률 %
        avgPnlPerTrade: number;                  // 평균 PnL per trade
        dataWindowHours: number;                 // 분석 데이터 윈도우 (시간)
    };
}

// ===== 자동 조절 파라미터 =====
export interface TuneEvent {
    timestamp: number;
    parameter: string;
    oldValue: number;
    newValue: number;
    reason: string;
    basedOnTrades: number;
}

// ===== v17: Swing 트레이딩 설정 =====
export interface SwingConfig {
    primaryTimeframe: '1h';          // 주요 분석 TF
    confirmTimeframe: '4h';          // 확인 TF
    tpAtrMultiplier: number;         // TP = ATR_1h × N (기본 3.0)
    slAtrMultiplier: number;         // 고정 SL% (예: 2 → SL 2%, 레버 = 50/2 = 25x)
    minRiskReward: number;           // R:R < N 이면 진입 거부 (기본 2.0)
    partialTp: number[];             // 2단계 TP 위치 (TP거리의 %) [0.5, 1.0]
    partialQty: number[];            // 2단계 물량 배분 [0.5, 0.5]
    maxLeverage: Record<SimpleRegime, number>;  // 레짐별 레버리지 캡
    timeExitMinutes: number;         // N분 무수익 퇴출 (기본 240)
    trailingStages: Array<{ trigger: number; lock: number }>;  // 4단계 트레일링
    atrTrailingMultiplier: number;   // ATR trailing (Stage 4+ 이후)
    scanIntervalMs: number;          // 스캔 간격 (기본 5분)
    scanTopN: number;                // 스캔 상위 종목 수 (0=무제한, 기본 10)
    maxHoldingBars?: number;         // 최대 보유 바 수 (0=무제한, 5분봉 기준)
}

export interface TradingConfig {
    directionBias: {
        longMultiplier: number;     // 1.0 = 중립, <1 = Long 억제, >1 = Long 선호
        shortMultiplier: number;
        reverseMode?: boolean;      // 시그널 반전 (Long↔Short)
    };
    tpSlRatio: {
        tpMultiplier: number;       // 1.0 = 기본 ATR×3
        slMultiplier: number;       // 1.0 = 기본 ATR×1.8
    };
    sizing: {
        baseSizePercent: number;    // v17: 30% (3포지션 집중)
        regimeMultipliers: Record<SimpleRegime, number>;
        sessionMultipliers: Record<string, number>;
    };
    zonePreference: Partial<Record<ZoneStrategyType, number>>;  // 0~2 가중치
    // v17: Swing 트레이딩 설정
    swing: SwingConfig;
    filters: {
        adxMinimum: number;
        volumeMinRatio: number;
        momentumMinScore: number;
        optimalHoldingMinutes: number;
        // 진입 품질 게이트 (시장데이터 기반 백테스트 결과)
        rangePositionMaxLong: number;   // Long은 레인지 하단에서만 (0=저점, 100=고점)
        rangePositionMinShort: number;  // Short은 레인지 상단에서만
        antiChasingMomentumMax: number; // 모멘텀 % 초과 시 추격 진입 차단
        // v8: BB/RSI/볼륨스파이크 필터 (45건 분석 기반)
        bbPositionMinShort: number;     // Short BB위치 하한 (BB<50% Short = 7%WR)
        rsiMinShort: number;            // Short RSI 하한 (RSI<45 Short = 10%WR)
        volumeSpikeMax: number;         // 볼륨 스파이크 상한 (>5x = 0%WR)
        // v9: 사각지대 필터 (255건 블라인드스팟 분석 기반)
        adxGateMinimum: number;         // ADX 게이트 하한 (ADX 15-25 = 40%WR(-22.37), ≥25 = 57%WR)
        noiseMaxRatio: number;          // 캔들 노이즈 상한 Range/Body (>2.5 = 28%WR(-17.88))
        consecutiveCandleMax: number;   // 순방향 연속캔들 상한 (3+ = 21%WR(-4.57))
        // v10: 타점 분석 100건 기반 (가격구조 + TF정렬 + BB데드존)
        bbDeadZoneMin: number;          // BB 60-80% = 20%WR 데드존 하한
        bbDeadZoneMax: number;          // BB 데드존 상한
        maxTfAlignment: number;         // 최대 TF 정렬 수 (0정렬=70%WR, 2+=36%WR)
        // v16: Gemini 관리 소프트블록 (시장 변화에 따라 자동 조절)
        rsiMaxShort: number;            // Short RSI 상한 (상승장=60, 하락장=80)
        momentumBlockShort: number;     // Short 모멘텀 차단 기준 (상승장=0, 하락장=0.5)
        // Phase 1: 센티먼트 필터 (autoTuner 조절 가능)
        frExtremeThreshold: number;     // 이 이상 극단 FR → 역방향 차단 (기본 0.05%)
        frHighThreshold: number;        // 이 이상 높은 FR → 소프트 패널티 (기본 0.03%)
        sentimentMinLong: number;       // Long 최소 센티먼트 점수 (기본 -30)
        sentimentMaxShort: number;      // Short 최대 센티먼트 점수 (기본 30)
        // Phase 2: L/S Ratio 필터
        lsRatioCrowdedLong: number;     // 이 이상 L/S → Long 차단 (기본 2.0)
        lsRatioCrowdedShort: number;    // 이 이하 L/S → Short 차단 (기본 0.5)
        // Phase 2: VWAP 필터
        vwapOverextendedStdDev: number; // 과확장 기준 σ (기본 2.0)
        // Phase 3: WaveTrend
        wtOverboughtThreshold: number;      // 기본 60
        wtOversoldThreshold: number;        // 기본 -60
        // Phase 3: Ichimoku
        ichimokuCloudMinThickness: number;  // 클라우드 최소 두께 % (기본 0.3)
        // ★ v36: 지표 게이트 ON/OFF (백테스트-실전 동기화)
        useWaveTrend: boolean;
        useIchimoku: boolean;
        useVWAP: boolean;
        useMFI: boolean;
        useHurst: boolean;
        // ★ v36: ignition + minTfConsensus (백테-실전 동기화)
        ignitionScoreThreshold?: number;
        ignitionVolMin?: number;
        ignitionBodyMin?: number;
        ignitionConsecMin?: number;
        minTfConsensus?: number;
    };
    lastTuneTimestamp: number;
    tuneHistory: TuneEvent[];
}

export function getDefaultTradingConfig(): TradingConfig {
    return {
        directionBias: { longMultiplier: 1.0, shortMultiplier: 0.0 },  // v28: 숏 완전 제거 (Deep 옵티마이저)
        tpSlRatio: { tpMultiplier: 1.0, slMultiplier: 0.7 },   // v6: 승리MAE 5.9%>패배MAE 3.5% → 승리는 넓은SL 필요, 0.7 유지
        sizing: {
            baseSizePercent: 10,   // v28: 10% (Deep 옵티마이저 — 분산)
            regimeMultipliers: { TRENDING: 1.0, RANGING: 1.0, VOLATILE: 1.0 },
            sessionMultipliers: {
                ASIA: 0.8, EUROPE: 1.0, US: 1.2,
                OVERLAP_ASIA_EU: 0.7, OVERLAP_EU_US: 1.0, WEEKEND: 0.6
            },
        },
        zonePreference: {},
        // v17: Swing 트레이딩 기본 설정
        swing: {
            primaryTimeframe: '1h',
            confirmTimeframe: '4h',
            tpAtrMultiplier: 7.0,            // ★ v55: TP 7x (12,763건: WR 56.4% 최고 + EV 0.631 + SL 13.2% 최저)
            slAtrMultiplier: 1,              // 고정 SL 1% → 레버리지 50x
            minRiskReward: 1.5,              // R:R ≥ 1.5
            partialTp: [1.0, 1.0],              // TP1 = 전량 청산
            partialQty: [1.0, 0],               // 100% 물량 TP1에서 청산
            maxLeverage: { TRENDING: 10, RANGING: 10, VOLATILE: 3 },  // v28: Deep 옵티마이저
            timeExitMinutes: 0,              // v24: 시간 퇴출 비활성화 (0=무제한)
            trailingStages: [
                { trigger: 0.30, lock: 0.10 },  // 30% 이동 → 10% 확보
                { trigger: 0.50, lock: 0.30 },  // 50% → 30% 확보
                { trigger: 0.70, lock: 0.50 },  // 70% → 50% 확보
                { trigger: 0.85, lock: 0.70 },  // 85% → 70% 확보
            ],
            atrTrailingMultiplier: 1.5,      // ATR×1.5 trailing (Stage 4+)
            scanIntervalMs: 5 * 60 * 1000,  // 5분 스캔
            scanTopN: 10,                   // v27: 상위 10개 종목만 스캔 (0=무제한)
        },
        filters: {
            adxMinimum: 15,
            volumeMinRatio: 1.0,            // v9b: 1.2→1.0 완화 (좋은기회 76% 저볼륨 차단 방지)
            momentumMinScore: 3,
            optimalHoldingMinutes: 240,     // v17: 60→240 (4시간 목표 보유)
            rangePositionMaxLong: 100,     // v7: Long ≤50% 0%WR vs >50% 69.2%WR → 필터 제거 (100=사실상 비활성)
            rangePositionMinShort: 0,      // v8: BB+RSI 필터가 대체 → 비활성 (거래횟수 확보)
            antiChasingMomentumMax: 0.3,
            bbPositionMinShort: 50,        // v8: Short BB<50% = 7%WR(-14.17) → 하단 Short 금지
            rsiMinShort: 50,               // v8: Short RSI<45 = 10%WR → 과매도 Short 금지
            volumeSpikeMax: 4.0,           // v8: >5x = 0%WR(-5.81) → 극단 볼륨 후 진입 금지
            adxGateMinimum: 25,            // v28: ADX<25 차단 (Deep 옵티마이저)
            noiseMaxRatio: 6.0,            // v9b: 2.5→6.0 (거래종목 평균6.7, 크립토 특성상 높음)
            consecutiveCandleMax: 0,       // v14: 2→0 (69건분석: 1+연속=7%WR, 0연속=66%WR → 역방향캔들 후만 진입)
            bbDeadZoneMin: 60,             // v10: BB 60-80% = 20%WR 데드존
            bbDeadZoneMax: 80,             // v10: BB 데드존 상한
            maxTfAlignment: 1,             // v10: 2+정렬=36%WR → 최대 1개 TF 정렬 허용
            rsiMaxShort: 80,               // v19: 60→80 완화 (WaveTrend가 과매수 필터 대체)
            momentumBlockShort: 0.3,       // v19: 0→0.3 완화 (약한 반등 +0.3% 이하는 Short 허용)
            // Phase 1: 센티먼트 필터
            frExtremeThreshold: 0.05,      // 0.05% = 극단 FR → 역방향 차단
            frHighThreshold: 0.03,         // 0.03% = 높은 FR → 소프트 패널티
            sentimentMinLong: -30,         // Long은 센티먼트 >= -30 필요
            sentimentMaxShort: 30,         // Short은 센티먼트 <= 30 필요
            // Phase 2
            lsRatioCrowdedLong: 2.0,       // L/S > 2.0 → Long 차단
            lsRatioCrowdedShort: 0.5,      // L/S < 0.5 → Short 차단
            vwapOverextendedStdDev: 2.0,   // VWAP ±2σ 초과 → 과확장
            // Phase 3
            wtOverboughtThreshold: 60,
            wtOversoldThreshold: -60,
            ichimokuCloudMinThickness: 0.3,
            // ★ v36: 지표 게이트 (기본 OFF)
            useWaveTrend: false,
            useIchimoku: false,
            useVWAP: false,
            useMFI: false,
            useHurst: false,
        },
        lastTuneTimestamp: 0,
        tuneHistory: [],
    };
}

export interface KlineData {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface OptimizedIndicator {
    name: string;
    period: number;
    threshold?: number; // e.g., RSI Oversold limit
    stdDev?: number;    // e.g., BB StdDev
    winRate: number;    // Bayesian-shrunk winRate (실전 의사결정용)
    rawWinRate: number; // 원시 winRate (shrinkage 전, 참고용)
    sampleCount: number; // 시그널 발생 횟수 (신뢰도 기반)
    oosWinRate: number;  // Out-of-sample winRate (검증 세트)
    reliability: number; // 지표 신뢰도 0~1 (sampleCount + IS/OOS 일관성)
    score: number;      // Weighted score
}

export interface GoldenSet {
    rsi: OptimizedIndicator;
    bb: OptimizedIndicator;
    macd: OptimizedIndicator;
    stoch: OptimizedIndicator;
    adx: OptimizedIndicator;
    // CCI, Williams %R, MFI 제거 — D급 지표 (노이즈 감소)
    timestamp: number;
}

// ===== Phase 1: 시장 센티먼트 데이터 =====
// ── Phase 2: SMC (Smart Money Concepts) ──
export interface SMCContext {
    bosDetected: boolean;
    bosDirection: 'BULLISH' | 'BEARISH' | null;
    bosLevel: number;
    bosIndex: number;
    chochDetected: boolean;
    chochDirection: 'BULLISH' | 'BEARISH' | null;
    chochLevel: number;
    prevTrendDirection: 'UP' | 'DOWN' | null;
    orderBlocks: OrderBlock[];
    strongFvgCount: number;
    weakFvgCount: number;
}

export interface OrderBlock {
    type: 'BULLISH' | 'BEARISH';
    high: number;
    low: number;
    index: number;
    impulseStrength: number;  // ATR 배수
    mitigated: boolean;
}

// ── Phase 2: L/S Ratio ──
export interface LongShortRatioData {
    buyRatio: number;
    sellRatio: number;
    ratio: number;       // buyRatio / sellRatio (>1 = longs 다수)
    timestamp: number;
}

// ── Phase 2: VWAP ──
export interface VWAPData {
    vwap: number;
    upperBand: number;   // VWAP + 2σ
    lowerBand: number;   // VWAP - 2σ
    stdDev: number;
    pricePosition: 'ABOVE' | 'BELOW' | 'AT_VWAP';
    deviationPercent: number;   // 현재가-VWAP 거리 (%)
    isOverextended: boolean;    // |deviation| > 2σ
}

// ── Phase 3: WaveTrend ──
export interface WaveTrendData {
    wt1: number;
    wt2: number;
    momentum: number;       // wt1 - wt2
    crossUp: boolean;       // wt1이 wt2를 상향 돌파
    crossDown: boolean;     // wt1이 wt2를 하향 돌파
    isOverbought: boolean;  // wt1 > 60
    isOversold: boolean;    // wt1 < -60
}

// ── Phase 3: Ichimoku Cloud ──
export interface IchimokuData {
    tenkanSen: number;
    kijunSen: number;
    senkouSpanA: number;
    senkouSpanB: number;
    cloudTop: number;       // max(spanA, spanB)
    cloudBottom: number;    // min(spanA, spanB)
    cloudThickness: number; // (cloudTop - cloudBottom) / price * 100
    priceVsCloud: 'ABOVE' | 'BELOW' | 'IN_CLOUD';
    tkCross: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    cloudColor: 'GREEN' | 'RED';  // spanA > spanB = GREEN
}

export interface SentimentData {
    ticker: string;
    timestamp: number;
    // Funding Rate
    fundingRate: number;           // 현재 FR (예: 0.0001 = 0.01%)
    fundingTrend: 'RISING' | 'FALLING' | 'STABLE';
    fundingHistory: number[];      // 최근 3회 결제 (24h)
    // Open Interest
    oiCurrent: number;
    oiChange1h: number;            // 1시간 OI 변화율 (%)
    oiChange4h: number;            // 4시간 OI 변화율 (%)
    oiPriceDivergence: 'CONFIRMING' | 'WEAK_RALLY' | 'WEAK_DECLINE' | 'CONFIRMING_SHORT';
    // CVD (Cumulative Volume Delta)
    cvd5min: number;               // 5분 롤링 CVD (Buy-Sell, USDT 기준)
    cvdTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    cvdPriceDivergence: boolean;   // 가격-CVD 다이버전스
    // Phase 2: L/S Ratio
    longShortRatio?: LongShortRatioData;
}

export interface SentimentScore {
    score: number;                 // -100 ~ +100 (양수=강세, 음수=약세)
    fundingComponent: number;      // -33 ~ +33
    oiComponent: number;           // -33 ~ +33
    cvdComponent: number;          // -34 ~ +34
    signals: string[];             // 사람이 읽을 수 있는 시그널 설명
    blockLong: boolean;            // Long 하드 블록
    blockShort: boolean;           // Short 하드 블록
    lsRatioComponent: number;      // Phase 2: -15 ~ +15
}

export interface TradeSnapshot {
    rsi?: number;
    adx?: number;
    emaGapPercent?: number;
    bbPosition?: number;
    timestamp: number;
    goldenSet?: GoldenSet;
    goldenSetAge?: number; // GoldenSet 캘리브레이션 후 경과시간(ms)
    hurst?: number;
    hurstConfidence?: number;
    regime?: string;
    expectedMove?: number;
    expectedMoveBasis?: string;
    confirmedSignals?: string[];
    signalConfidence?: number;
    calibration?: { entryBias: number, tpWeight: number };
    // [UPG7.2] 진입 시점 시장 상태
    fundingRate?: number;              // 진입 시 펀딩비
    orderbookImbalance?: number;       // 진입 시 호가 불균형 (>1 매수우세, <1 매도우세)
    // Phase 1: 센티먼트 데이터
    sentimentScore?: number;           // 통합 센티먼트 점수 (-100 ~ +100)
    oiChange1h?: number;               // 진입 시 OI 1시간 변화율 (%)
    oiChange4h?: number;               // 진입 시 OI 4시간 변화율 (%)
    cvd5min?: number;                  // 진입 시 5분 CVD
    oiPriceDivergence?: string;        // OI-가격 다이버전스 상태
    cvdPriceDivergence?: boolean;      // CVD-가격 다이버전스 여부
    // Phase 2
    longShortRatio?: number;           // 진입 시 L/S Ratio
    vwapDeviation?: number;            // 진입 시 VWAP 편차 (%)
    smcBos?: boolean;                  // BOS 감지 여부
    smcChoch?: boolean;                // CHoCH 감지 여부
    smcOrderBlockNear?: boolean;       // 미티게이트되지 않은 OB 근처 여부
    // Phase 3
    waveTrendWT1?: number;
    waveTrendMomentum?: number;
    ichimokuPriceVsCloud?: string;
    ichimokuTKCross?: string;
    ichimokuCloudThickness?: number;
    improvedLiqPrice?: number;
}

// ★ 실전 vs 백테스트 검증용 — localStorage 영구 저장 타입
export interface PersistedTrade {
    id: string;
    ticker: string;
    direction: 'Long' | 'Short';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    leverage: number;
    reasonForExit: string;
    openTimestamp: number;
    closeTimestamp: number;
    holdingMinutes: number;
    strategyType?: string;
    regime?: string;
    session?: string;
    mfe?: number;
    mae?: number;
}

export interface Trade {
    id: string;
    ticker: string;
    direction: 'Long' | 'Short';
    entryPrice: number;
    quantity: number;
    leverage: number;
    initialMargin: number;
    positionValue: number;
    status: 'open' | 'closed' | 'pending_entry';
    openTimestamp: number;
    closeTimestamp?: number;
    localStartTime?: number;
    pnl?: number;
    unrealizedPnl?: number;
    realizedPnl?: number;
    totalFee?: number; // [NEW] Total fees paid (Entry + Exit)
    // isPaperTrade 제거됨 - 항상 LIVE
    reasonForExit?: 'target_hit' | 'stop_loss_hit' | 'liquidation' | 'ai_close' | 'exchange_close' | 'tp_hit' | 'entry_missed' | 'session_end' | 'partial_tp' | 'partial_close' | 'timeout' | 'analysis_snapshot' | 'opportunity_switch' | 'tp1_miss_flip';
    tp1Price?: number;
    targetPrice?: number;
    invalidationPrice: number;
    liquidationPrice?: number;
    positionIdx: number;
    category?: 'linear' | 'inverse' | 'option';
    tradeStyle?: 'SCALP' | 'SWING_RUNNER';
    expectedDuration?: string;
    switchCount?: number;
    entryStages?: { timestamp: number, qty: number, price: number }[];
    exitStages?: { timestamp: number, qty: number, price: number, reason: string, pnl: number }[];
    isTp1Hit?: boolean;
    tpCount?: number;
    postTradeInsights?: PostTradeInsights;
    analysisId?: string;
    marketPhase?: string;
    verdict?: string;
    candlesElapsed?: number;
    candleBudget?: string | number;
    equityDelta?: number;
    primaryTimeframe?: string;
    deploymentMode?: 'SCOUT' | 'STANDARD';
    tpOrders?: { price: number, qty: number }[];
    exitPrice?: number;
    hasTriggered5PercentTp?: boolean;
    sessionRegion?: string;
    goal?: string;
    currentPrice?: number;
    deadlineTimestamp?: number;
    wasReversed?: boolean;
    // ===== [Smart Reverse] 스마트 방향 반전 결정 =====
    smartReverseDecision?: {
        action: 'KEEP' | 'REVERSE' | 'BLOCK';
        ruleId: number;
        ruleName: string;
        originalDirection: 'Long' | 'Short';
        effectiveDirection: 'Long' | 'Short';
        slMultiplier: number;
        reasoning: string;
        session?: string;
        regime?: string;
        zoneType?: string;
    };
    // [NEW] Snapshot of indicators at the moment of entry
    entrySnapshot?: TradeSnapshot;

    // ===== [NEW] 빅데이터 분석용 확장 필드 =====
    analytics?: TradeAnalytics;

    // ★ 18-way: 진입 시 세션/요일 세그먼트
    entrySession?: Session;     // ASIA / EUROPE / US
    entryDayType?: DayType;     // WEEKDAY / WEEKEND
    entryTimeSegmentKey?: string; // e.g. 'TRENDING_IGNITION_ASIA_WEEKDAY'

    // ★ v36: 레지스트리 통계 (대시보드 포지션 카드 표시용)
    registryStats?: {
        winRate: number;       // 예상 승률 (%)
        pnl: number;           // 예상 PnL (%)
        trades: number;        // 표본 수
        avgWin: number;        // 평균 익절 (%)
        avgLoss: number;       // 평균 손절 (%)
        ev: number;            // 기대값 (%)
        maxDD: number;         // 최대 낙폭 (%)
        avgHoldMin: number;    // 평균 보유시간 (분)
    };
}

export interface TradeAnalytics {
    // === 진입 품질 분석 ===
    entryMethod: 'FAST_EXEC' | 'AI_CONFIRMED' | 'SNIPER_LIMIT' | 'MARKET_CHASE';
    entryConfidence: number;                 // 진입 시 신뢰도 (0~100)
    entryStrategy: 'TREND' | 'REVERSION' | 'COUNTER_TREND' | 'BREAKOUT';
    entryRegime: string;                     // 진입 시 CryptoMarketRegime
    entryRegimeConfidence: number;           // 진입 시 레짐 신뢰도
    inflectionScore: number;                 // 변곡점 점수
    mtfDirection: 'ALIGNED' | 'CONFLICTED' | 'NEUTRAL'; // MTF 합류 상태

    // === 가격 행동 분석 ===
    maxFavorableExcursion: number;           // MFE: 보유 중 최대 유리 이동 (%)
    maxAdverseExcursion: number;             // MAE: 보유 중 최대 불리 이동 (%)
    entryToHighPercent: number;              // 진입가 대비 최고가까지 (%)
    entryToLowPercent: number;              // 진입가 대비 최저가까지 (%)
    exitEfficiency: number;                  // 탈출 효율 = 실현PnL / MFE × 100 (%)
    pricePathSummary: number[];              // 5분 간격 가격 경로 (진입가 기준 %)

    // === 타이밍 분석 ===
    holdingDurationMinutes: number;          // 실제 보유 시간
    timeToMaxProfit: number;                 // 최대 수익까지 걸린 시간 (분)
    timeToExit: number;                      // 탈출까지 걸린 시간 (분)
    wasEarlyExit: boolean;                    // 진입 후 15분 이내 조기 탈출?
    marketSession: 'ASIA' | 'EUROPE' | 'US' | 'OVERLAP_EU_US' | 'OVERLAP_ASIA_EU' | 'WEEKEND';

    // === 탈출 분석 ===
    exitTrigger: string;                     // 정확한 탈출 사유 (Factor A~G, SL Hit, TP Hit 등)
    exitScore: number;                       // Dynamic Exit Score (탈출 시점)
    exitRegime: string;                      // 탈출 시 레짐
    slDistanceAtEntry: number;               // 진입 시 SL까지 거리 (%)
    slDistanceAtExit: number;                // 탈출 시 SL까지 거리 (%) (조여졌는지 확인)
    slTightenCount: number;                  // SL이 조여진 횟수
    wasRegimeShiftExit: boolean;             // 레짐 변경으로 탈출했는지

    // === 시장 환경 ===
    atrAtEntry: number;                      // 진입 시 ATR
    atrAtExit: number;                       // 탈출 시 ATR
    volumeAtEntry: number;                   // 진입 시 거래량 (vs 평균)
    spreadAtEntry: number;                   // 진입 시 스프레드
    volatilityPercentile: number;            // 진입 시 변동성 백분위 (0~100)

    // === 전략 성과 지표 ===
    riskRewardRatio: number;                 // 실현된 Risk:Reward 비율
    expectedRR: number;                      // 계획된 RR 비율 (TP/SL)
    kellyFraction: number;                   // 이 거래의 Kelly 적정 비중
    edgePercent: number;                     // 기대수익 = (승률×TP) - (패율×SL)

    // === 전략 & 진입 파라미터 ===
    strategyName: string;                    // 전략 이름 (예: "CT_REVERSAL", "TREND_1H")
    tradingGoal: string;                     // 거래 목표 (TREND_FOLLOWING, MEAN_REVERSION 등)
    tradeStyle: 'SCALP' | 'SWING_RUNNER';   // 거래 스타일
    positionSizePercent: number;             // 진입 시 에쿼티 투입 비율 (%)
    expectedWinRate: number;                 // 예상 승률 (0~1)
    mtfMultiplier: number;                   // MTF 합류 사이즈 보정 배수
    regimeSizeMultiplier: number;            // 레짐 사이즈 보정 배수
    riskLevel: string;                       // 리스크 레벨 (ULTRA_SAFE, LOW, MEDIUM, HIGH, EXTREME)

    // === 수수료 상세 ===
    entryFee: number;                        // 진입 수수료 (USDT)
    exitFee: number;                         // 종료 수수료 (USDT)
    totalFees: number;                       // 총 수수료 (entry + exit)
    feeImpactPercent: number;                // 수수료가 PnL에 미친 비율 (%)

    // === 진입 직후 분석 (체결 5분 후 산출) ===
    entryZoneType: string;                   // 진입 존 타입 (PULLBACK, BREAKOUT 등)
    priceAfter5minEntry: number;             // 진입 후 5분 뒤 순방향 이동 (%) — 양수=유리, 음수=불리
    entryDirectionCorrect: boolean;          // 5분 후 순방향으로 갔는지

    // === 사후 분석 (거래 종료 후 산출) ===
    priceAfter5min: number;                  // 탈출 후 5분 뒤 가격 변화 (%)
    priceAfter15min: number;                 // 탈출 후 15분 뒤 가격 변화 (%)
    priceAfter1hr: number;                   // 탈출 후 1시간 뒤 가격 변화 (%)
    wasExitPremature: boolean;               // 탈출 후 원래 방향으로 갔는지 (사후 판단)
}

export interface PublicTrade {
    id: string;
    T: number;
    p: number;
    q: number;
    S: string;
}

export interface OrderBookData {
    s: string;
    b: [string, string][];
    a: [string, string][];
    ts: number;
    u: number;
    seq: number;
    cts: number;
}

export interface NewsArticle {
    id: string;
    headline: string;
    source: string;
    timestamp: number;
    impact: 'high' | 'medium' | 'low';
}

export interface AiCoreConfig {
    championPrompt: string;
    exclusionList: string;
    focusList: string;
    telegramBotToken?: string;
    telegramChatId?: string;
    telegramReportInterval?: number;
    scanTopN?: number;              // v27: 스캔 상위 종목 수 (0=무제한, 기본 10)
    baseSizePercent?: number;       // v27: 포지션 비중 % (기본 20)
    maxPositions?: number;          // v27: 최대 동시 포지션 수 (기본 12)
    // 전략 파라미터 (편집 가능)
    tpAtrMultiplier?: number;
    slAtrMultiplier?: number;
    leverageTrending?: number;
    leverageRanging?: number;
    leverageVolatile?: number;
    partialTp1Ratio?: number;
    partialQty1?: number;
    minRiskReward?: number;
    scoreThreshold?: number;
}

export interface ChatMessage {
    id: string;
    participant: 'user' | 'ai' | 'system' | 'trading_engine';
    text: string;
    type: 'text' | 'error' | 'system_state' | 'analysis' | 'trade' | 'trade_update' | 'condition_log' | 'health_check';
    payload?: any;
    timestamp: number;
}

export type SystemStatus = 'idle' | 'analyzing' | 'trading' | 'error' | 'paused';

export interface StrategyConfig {
    name: string;
    ticker: string;
    direction: 'Long' | 'Short' | 'Both';
    tp: number;
    sl: number;
    leverage: number;
    goal: TradingGoal;
    windowHours: number;
    holdingTimeMinutes: number;
}

export type TradingGoal = 'TREND_FOLLOWING' | 'MEAN_REVERSION' | 'SCALPING' | 'BREAKOUT' | 'TRAP_HUNTING' | 'UNKNOWN';

export interface BotState {
    totalEquity: number;
    availableBalance: number;
    openPositions: Trade[];
    openOrders: any[];
    lastActivity: string;
    sessionTradeHistory: Trade[];
    sessionStats: {
        initialEquity: number;
        currentEquity: number;
        sessionReturnPercent: number;
        sessionPnl: number;
        totalTrades: number;
        winRate: number;
        unrealizedPnl: number;
        realizedPnl: number;
        profitFactor: number;
    };
    liveKlines: Record<string, KlineData[]>;
    latestPrices: Record<string, number>;
    isFilterActive: boolean;
    filterResults: any[];
    sessionMaxEquity: number;
    reservedProfits: number;  // 수익 리밸런싱: 보호된 수익 누적 (USDT)
    activeStrategies: Record<string, StrategyConfig>;
    tradesSinceLastOptimization: number;
    analyzingTickers: string[];
    analysisStatus: 'running' | 'paused' | 'stopped';
    lastScanResult: any;
    optimizationVersion: number;
    isLeverageOverrideActive: boolean;
    isReverseTradingActive: boolean;
    isSmartReverseActive: boolean;  // [Smart Reverse] 스마트 방향 반전 ON/OFF
    isBerserkerMode: boolean;
    isAutoBerserker: boolean; // 자동 버서커: 레짐 기반 ON/OFF
    allInPercentage: number;
    tpClosePercentage: number;
    snipingTickers: string[];
    waitingCandidates: WaitingCandidate[];
    nextRotationTime?: number;
    priorityCandidate?: WaitingCandidate;
    selectionWindowEndTime?: number;
    candidatesInZone?: any[];
    currentSession: TradeSession | null;
    maxPositions?: number;  // 현재 최대 포지션 수 (auto-opt 변경 반영)
    tickerParamRegistry?: Record<string, TickerParamEntry>;  // 종목별 최적 파라미터 (per-ticker registry)
    lastScanStatuses?: ScanStatus[];  // ★ 마지막 스캔 결과 (종목별 게이트 통과/차단)
    shadowSignals?: ShadowSignal[];   // ★ v52.36: 섀도우 시그널 (모든 Ignition 기록)
    lastWfWindows?: WfWindowRecord[]; // ★ v52.56: WF 윈도우별 bestParams 기록 (선택방식 비교용)
}

/** ★ WF 윈도우별 bestParams 기록 */
export interface WfWindowRecord {
    ticker: string;
    windowIndex: number;
    trainPnl: number;
    testPnl: number;
    testWinRate: number;
    testTrades: number;
    testMaxDD: number;
    selectedMode: string;
    leverageT: number;
    leverageR: number;
    leverageV: number;
    tpMultiplier: number;
    slMultiplier: number;
    shortMultiplier: number;
    igThreshold: number;
    tfConsensus: number;
}

/** ★ 개별 필터 단계 결과 */
export interface ScanFilterStep {
    gate: string;           // 'direction', 'dir_multiplier', 'short_gate', 'adx', 'ignition', 'rsi_extreme', 'tf_consensus', 'ignition_required', 'regime'
    label: string;          // UI 표시명
    passed: boolean;
    value: number;          // 실제 값
    threshold: number;      // 임계값
    detail?: string;        // 추가 정보 (e.g., "Long", "TRENDING")
    skipped?: boolean;      // 평가 안 됨 (선행 필터에서 데이터 없음 등)
}

/** ★ v52.36: 섀도우 시그널 — 필터 무관하게 모든 Ignition 시그널을 가상 기록 */
export interface ShadowSignal {
    id: string;
    ticker: string;
    direction: 'Long' | 'Short';
    signalPrice: number;
    signalTimestamp: number;
    regime: string;
    session: string;
    dayType: string;

    // 백테스트 파라미터 (18-way)
    registryN?: number;
    registryWR?: number;
    registryEV?: number;
    registryQualified?: boolean;
    leverage?: number;

    // 필터 결과
    filterSteps: ScanFilterStep[];
    passedAllFilters: boolean;
    rejectedGate?: string;

    // TP/SL 가상 가격
    virtualTp?: number;
    virtualSl?: number;
    atr?: number;

    // 결과 (모니터링으로 업데이트)
    status: 'open' | 'closed';
    exitPrice?: number;
    exitTimestamp?: number;
    pnlPercent?: number;       // 가격 변동률 (레버리지 미반영)
    pnlLevPercent?: number;    // 레버리지 반영 PnL%
    pnlDollar?: number;        // $100 가상 증거금 기준 PnL$
    reasonForExit?: string;   // 'shadow_tp' | 'shadow_sl' | 'shadow_timeout'
}

/** ★ 스캔 게이트 결과 — 종목별로 왜 진입했거나 차단됐는지 추적 */
export interface ScanStatus {
    ticker: string;
    status: 'passed' | 'blocked' | 'waiting';
    gate?: string;       // 차단한 게이트 이름 (e.g., 'volatility', 'direction', 'adx', 'regime', 'dna', 'score')
    detail?: string;     // 상세 설명 (e.g., "12h vol 0.8% < 1.5%")
    timestamp: number;
    filterSteps?: ScanFilterStep[];  // ★ 모든 필터 단계 결과
}

export interface WaitingCandidate {
    ticker: string;
    direction: 'Long' | 'Short';
    entryZones: { type: string, minPrice: number, maxPrice: number, strategyName?: string }[];
    marketPhase: string;
    reasoning: string;
    timestamp: number;
    expectedReward?: number;
    hitCount?: number;
    isPendingReanalysis?: boolean;
    // [REMOVED] Zone 상태머신 + Sweep Defense 필드 제거
    // trapState, zoneTouchTimestamp, zoneTouchPrice, zoneExtremePrice,
    // sweepWatchStartTime, sweepDetected, sweepLowPrice, sweepHighPrice,
    // firstBouncePrice, sweepRecoveryConfirmed → 데이터 근거 없음, 진입만 지연
    // 대체: 통합 빠른 트리거 + 데이터 태그 수집
    _entryDataTags?: {
        zoneDriftPct?: number;               // 존 중심에서의 이탈률
        zoneProximityPct?: number;           // 존 진입 시 깊이
        directionGuardWouldBlock?: boolean;  // ADX<25+MTF<1 이었으면 차단됐을 경우
        cfChoppyWouldBlock?: boolean;        // CF+CHOPPY_NOISE 이었으면 차단됐을 경우
        zoneDriftWouldBlock?: boolean;       // 3%+ drift 이었으면 차단됐을 경우
        // [UNBLOCK] 모든 블록 → 로그전용 전환 — 데이터 수집용
        volatileGrindWouldBlock?: boolean;   // VOLATILE_GRIND + ADX<30
        lowAdxWouldBlock?: boolean;          // ADX < 임계값
        lowAdxValue?: number;                // ADX 실제값
        lowVolumeWouldBlock?: boolean;       // 거래량 < 1.2x
        candleTimingWouldBlock?: boolean;    // 봉마감 후 < 300초
        candleTimingSec?: number;            // 봉마감 후 경과초
        momentumWouldBlock?: boolean;        // 모멘텀 게이트 실패
        momentumReason?: string;             // 모멘텀 차단 사유
        aiSkipWouldBlock?: boolean;          // AI 검증 SKIP (70%+)
        aiSkipConfidence?: number;           // AI SKIP 확신도
        fatigue75WouldBlock?: boolean;       // 피로도 75+ 순방향
        fatigue50WouldBlock?: boolean;       // 피로도 50+ 전면
        fatigueDeadZoneWouldBlock?: boolean; // 피로도 30-50 + ADX<50 + ATR≥3%
        fatigueScore?: number;               // 피로도 실제값
        priceDriftWouldBlock?: boolean;      // 가격 존 이탈
        priceDriftPct?: number;              // 이탈 비율
        counterCandleWouldBlock?: boolean;   // 역방향 강한 캔들
        counterCandleBodyPct?: number;       // 캔들 body 비율
        obImbalanceWouldBlock?: boolean;     // 오더북 역방향
        obRatio?: number;                    // Bid/Ask 비율
        exhaustionWouldBlock?: boolean;      // 변동성 소진
        exhaustionRatio?: number;            // 변동성 감소 배율
    };
    predictedDuration?: string;
    technicalContext?: {
        calibration?: { entryBias: number, tpWeight: number };
        shadowVerdict?: any;
        lastShadowTime?: number;
        goldenSet?: GoldenSet; // [NEW] The Optimized Parameters for this specific ticker
    };
    primaryTimeframe?: string;
    mtfAlignment?: 0 | 1 | 2 | 3;   // [UPG1] MTF 방향 합의 (0=없음 ~ 3=완전일치)
    mtfDetails?: string;              // [UPG1] MTF 세부 로그
    // [UPG8-DATA v3] Fatigue 30-50 데스존 레버리지 절반 플래그
    _fatigueLevHalved?: boolean;
    // [UPG8-DATA v3] 경량 Sweep Wick 대기: Direct 전략에서도 꼬리 확인 후 진입
    _wickWaitStart?: number;        // wick 대기 시작 시간 (ms)
    _wickConfirmed?: boolean;       // wick 확인 완료 여부
}

export interface TradeSession {
    id: string;
    startTime: number;
    endTime?: number;
    initialEquity: number;
    finalEquity?: number;
    totalTrades: number;
    winRate: number;
    sessionPnl: number;
    sessionPnlPercent: number;
    tradeIds: string[];
    tradingMode: 'LIVE';
    currentEquity: number;
}

export interface SymbolProfile {
    ticker: string;
    lastAnalyzed: number;
    lastUpdated?: number;
    historicalDNA: any[];
    performance: {
        trades: number;
        pnl: number;
        winRate: number;
    };
    behavioralNotes: string[];
    validationInsights: string[];
    notesSinceLastReport?: number;
    personalityReport?: SymbolPersonalityReport;
    calibrationData?: {
        drawdownBias: number;
        rsiBias: number;
        tpWeight?: number;
        updatedAt: number;
    };
    // Added fields
    strategyWinRate?: {
        trend_long: number;
        trend_short: number;
        reversion_long: number;
        reversion_short: number;
        overall: number;
    };
    volatilityAccuracy?: {
        predicted_move: number;
        actual_move: number;
        mape: number;
        rmse: number;
        prediction_count: number;
        lastUpdated: number;
    };
    regimeAccuracy?: {
        hurst_predictions: {
            timestamp: number;
            predicted: number;
            actual: number;
            regime_correct: boolean;
        }[];
        regime_correct_count: number;
        regime_total_count: number;
        accuracy_rate: number;
        lastUpdated: number;
    };
    entryPatterns?: {
        timestamp: number;
        marketPhase: string;
        hurst: number;
        adx: number;
        direction: 'Long' | 'Short';
        pnl: number;
        isProfitable: boolean;
    }[];
    recommendedTimeframe?: {
        primary: string;
        backup: string;
        lastUpdated: number;
    };
    zonePerformance?: {
        [zoneType: string]: {             // 'PULLBACK' | 'BREAKOUT' | 'TOP_REVERSAL' | ...
            totalTrades: number;          // 해당 존으로 진입한 총 거래 수
            directionCorrectCount: number; // 5분 후 순방향 횟수
            avgMovePercent: number;       // 5분 후 평균 이동 (%) — EWMA
            winRate: number;              // 최종 승률 (거래 종료 후)
            lastUpdated: number;
        };
    };
}

export interface SymbolPersonalityReport {
    personalitySummary: string;
    strengths: string[];
    weaknesses: string[];
    recommendedParameters: { parameter: string, adjustment_reasoning: string }[];
    lastGenerated: number;
}

export interface PostTradeInsights {
    mainTakeaway: string;
    patternObserved: string;
    suggestionForNextTime: string;
    parameterAdjustment: {
        parameter: string;
        suggestion: string;
    };
    maxPotentialPnl: number;
    maxPotentialRoiPercent: number;
}

export interface MissedEntryInsights {
    reasonForFailure: string;
    suggestionForNextTime: string;
    parameterAdjustment: {
        parameter: string;
        suggestion: string;
    };
}

export interface MasterAnalysisPayload {
    id?: string;
    marketDNA: any;
    analysisResult: {
        ticker: string;
        confidence: number;
        summary: string;
        predictedScenario: string;
        entryTrigger: any;
        planInvalidationLevel: number;
        recommendedAction: string;
    };
    pricePrediction: any;
    suggestedTpRatio: number;
    suggestedSlRatio: number;
    priceScenarios: { probability: string, path: { timeMinutes: number }[] }[];
}

export interface TradeJournalEntry {
    id: string;
    tradeId: string;
    timestamp: number;
    eventType: 'PLAN_CREATED' | 'ENTRY_EXECUTED' | 'PARTIAL_TP_EXECUTED' | 'SITUATIONAL_ANALYSIS' | 'TRADE_CLOSED' | 'ENTRY_MISSED';
    payload: any;
}

export interface PerformanceDiagnosticReport {
    id: string;
    timestamp: number;
    identifiedProblem: string;
    rootCauseAnalysis: string;
    strategicRecommendation: string;
}

export interface EngineState {
    initialBootstrapComplete: boolean;
}

export interface ConditionCheckItem {
    name: string;
    desc: string;
    isMet: boolean;
    actual: string | number;
}

// ===== Crypto Market Regime Classification System =====
export type CryptoMarketRegime =
    | 'TREND_IMPULSE'          // 강한 추세 임펄스 (ADX>30, Hurst>0.6, 거래량 증가)
    | 'TREND_CONTINUATION'     // 추세 지속 (추세 방향 유지, 조정파 내)
    | 'TREND_EXHAUSTION'       // 추세 소진 (다이버전스, 거래량 감소, RSI 극단)
    | 'RANGE_ACCUMULATION'     // 횡보 축적 (좁은 BB, 낮은 변동성, 거래량 감소)
    | 'RANGE_DISTRIBUTION'     // 횡보 분배 (상위 레벨에서 횡보, 매도 압력)
    | 'BREAKOUT_EXPANSION'     // 돌파 확장 (BB 브레이크, 거래량 폭증)
    | 'VOLATILITY_SQUEEZE'     // 변동성 압축 (Choppiness 높음, BB 좁아짐 → 돌파 임박)
    | 'VOLATILITY_EXPLOSION'   // 변동성 폭발 (ATR 급등, 위아래 긴 꼬리)
    | 'LIQUIDATION_CASCADE'    // 청산 연쇄 (급격한 가격 이동 + 거래량 스파이크)
    | 'MEAN_REVERSION_ZONE'    // 평균 회귀 구간 (Hurst<0.45, BB 밴드 이탈)
    | 'CHOPPY_NOISE'           // 노이즈 구간 (Choppiness>65, ADX<15, 랜덤워크)
    | 'WEEKEND_DRIFT';         // 주말 저유동성 드리프트 (주말 시간대, 낮은 거래량)

export interface CryptoRegimeComponents {
    // 추세 성분
    trendStrength: number;        // 0~100: ADX + Hurst 조합
    trendDirection: 'UP' | 'DOWN' | 'FLAT';
    trendAge: number;             // 추세 지속 캔들 수

    // 변동성 성분
    volatilityLevel: number;      // 0~100: ATR/Price 정규화
    volatilityTrend: 'EXPANDING' | 'CONTRACTING' | 'STABLE';
    bbWidth: number;              // BB 밴드폭 (% 기준)
    bbWidthPercentile: number;    // BB 밴드폭의 과거 백분위

    // 모멘텀 성분
    momentumScore: number;        // -100~+100
    divergenceDetected: boolean;
    volumeProfile: 'CLIMAX' | 'DRYING' | 'NORMAL' | 'SURGE';

    // 시장 구조 성분
    choppinessIndex: number;      // 0~100
    hurstExponent: number;        // 0~1
    wickRatio: number;            // 심지 비율 (높으면 거부 구간)

    // 코인 특화 성분
    isWeekend: boolean;           // 주말 여부
    hourOfDay: number;            // UTC 시간대 (0-23)
    volumeVsAvg: number;          // 현재 거래량 / 20일 평균 거래량 비율
    priceDistFromEma: number;     // 가격이 EMA에서 얼마나 떨어져 있는지 (%)

    // 추세 피로도 성분
    trendFatigue: {
        movePercent: number;          // 최근 스윙 저점/고점 대비 이동 비율 (%)
        trendDurationHours: number;   // 실제 추세 경과 시간 (시간)
        velocityDecay: number;        // 속도 감속 비율 (1.0=일정, <1=감속, >1=가속)
        fatigueScore: number;         // 종합 피로도 (0~100)
    };
}

export interface CryptoRegimeResult {
    regime: CryptoMarketRegime;
    confidence: number;           // 0~100
    components: CryptoRegimeComponents;
    subRegime?: string;           // 세부 하위 국면 (예: "Late Stage Impulse")
    tradingImplications: RegimeTradingParams;
    reasoning: string;
}

export interface RegimeTradingParams {
    // 추천 파라미터
    recommendedLeverage: { min: number; max: number };
    tpMultiplier: number;         // 기본 TP 대비 배수 (0.5~2.0)
    slMultiplier: number;         // 기본 SL 대비 배수 (0.5~2.0)
    positionSizeMultiplier: number; // 기본 사이즈 대비 배수 (0.3~1.5)

    // 전략 적합도
    trendFollowingFit: number;    // 0~100
    meanReversionFit: number;     // 0~100
    breakoutFit: number;          // 0~100
    scalpingFit: number;          // 0~100

    // 위험도
    riskLevel: 'MINIMAL' | 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
    shouldReduceExposure: boolean;
    maxHoldingMinutes: number;    // 권장 최대 보유 시간
}

// (DecisionRecord 제거됨 — 바이빗에서 직접 확인)

// ===== Backtest Types =====

// ── Trade DNA: 진입 시점의 시장 조건 스냅샷 ──

export interface TradeDNA {
    zoneType: string;           // PULLBACK | BREAKOUT | CONTINUATION_FLOW | ... | IMMEDIATE
    adx: number;
    adxRange: 'WEAK' | 'MID' | 'STRONG';           // <20 | 20-30 | >30
    rsi: number;
    rsiZone: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT'; // <35 | 35-65 | >65
    emaAlignment: 'BULLISH' | 'BEARISH' | 'MIXED';  // 20>50>200 | 200>50>20 | else
    volatility: 'LOW' | 'NORMAL' | 'HIGH';          // atrPct <0.8% | 0.8-2% | >2%
    atrPercent: number;
}

export interface DnaStats {
    count: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    ev: number;           // (WR × avgWin) + ((1-WR) × avgLoss)
    profitFactor: number; // sumWins / |sumLosses|
}

export interface DnaComboStats extends DnaStats {
    label: string;        // e.g. "TRENDING + ADX강 + PULLBACK"
    conditions: {
        regime: string;
        adxRange: string;
        zoneType: string;
        direction?: 'Long' | 'Short';  // 방향별 필터용 (없으면 양방향 차단)
    };
    exitBreakdown?: {                   // 청산 사유 분포
        tp1Rate: number;    // 0~1
        tp2Rate: number;
        slRate: number;
    };
}

export interface TickerDnaProfile {
    topCondition: string;      // 최고 EV 조건 라벨
    topEv: number;
    worstCondition: string;    // 최악 EV 조건 라벨
    worstEv: number;
    longWinRate: number;       // Long 승률
    shortWinRate: number;      // Short 승률
    totalTrades: number;
}

export interface DnaAnalysis {
    byZoneType: Record<string, DnaStats>;
    byRegime: Record<string, DnaStats>;
    byAdxRange: Record<string, DnaStats>;
    byRsiZone: Record<string, DnaStats>;
    byEmaAlignment: Record<string, DnaStats>;
    byVolatility: Record<string, DnaStats>;
    byDirection: Record<string, DnaStats>;              // Long vs Short
    byDirectionRegime: Record<string, DnaStats>;        // Long×TRENDING 등
    byTicker: Record<string, TickerDnaProfile>;         // 종목별 DNA 프로파일
    topCombos: DnaComboStats[];    // EV 상위 5
    worstCombos: DnaComboStats[];  // EV 하위 5
    totalAnalyzed: number;
}

export interface BacktestTrade {
    ticker: string;
    direction: 'Long' | 'Short';
    entryPrice: number;
    exitPrice: number;
    entryTime: number;
    exitTime: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    pnlPercent: number;
    exitReason: 'TP1' | 'TP2' | 'SL' | 'END_OF_DATA';
    regime: string;
    session?: Session;               // ★ v36: 진입 세션 (ASIA/EUROPE/US)
    dayType?: DayType;               // ★ v36: 진입 요일 (WEEKDAY/WEEKEND)
    directionScore: number;
    leverage: number;
    barsHeld: number;
    underwaterBars: number;          // 물려있는 바 수 (손실 상태인 바)
    entryDNA?: TradeDNA;             // 진입 시점 시장 조건 스냅샷
    strategyType?: string;  // ★ 전략 타입 (IGNITION only)
    trapZoneType?: 'PULLBACK' | 'NWAVE' | 'BREAKOUT' | 'MEANREV';  // ★ Trap 4-Quadrant 타입
}

export interface BacktestTickerResult {
    ticker: string;
    trades: BacktestTrade[];
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlPercent: number;
    avgWinPercent: number;
    avgLossPercent: number;
    maxDrawdownPercent: number;
    avgUnderwaterMinutes: number;    // 평균 물려있는 시간 (분)
    avgHoldingMinutes: number;       // 평균 보유시간 (분)
}

/** ★ 레짐별 파라미터 엔트리 (T/R/V 각각 독립 params + mode) */
export interface RegimeParamEntry {
    params: BacktestParams;              // 해당 레짐 최적 파라미터
    mode: 'normal' | 'reverse';          // 해당 레짐 독립 모드
    qualified: boolean;                  // 해당 레짐 자격 여부
    disqualifyReason?: string;
    // 검증(val) 성과
    pnl: number;                         // val PnL % (레짐 필터링)
    winRate: number;                     // val 승률 % (레짐 필터링)
    trades: number;                      // val 거래 수 (레짐 필터링)
    avgWin: number;                      // val 수익 거래 평균 PnL %
    avgLoss: number;                     // val 손실 거래 평균 PnL %
    // ★ v49: Kelly Criterion
    kellyFraction?: number;          // 실효 Kelly 비중 (0~0.30, half-Kelly + 신뢰도 스케일링)
    confidenceScore?: number;        // 신뢰도 = min(trades/50, 1.0)
    // 학습(train) 성과
    trainPnl: number;
    trainWinRate: number;
    trainTrades: number;
}

/** 종목별 최적 파라미터 + 성과 메트릭 (Auto-Optimizer per-ticker registry) */
export interface TickerParamEntry {
    ticker: string;
    params: BacktestParams;          // 이 종목에 최적인 콤보의 파라미터
    mode: 'normal' | 'reverse';      // normal / reverse 어느 모드에서 나왔는지
    pnl: number;                     // 검증기간 PnL %
    winRate: number;                  // 검증기간 승률 %
    avgWin: number;                  // 검증기간 수익 거래 평균 PnL %
    avgLoss: number;                 // 검증기간 손실 거래 평균 PnL %
    trainPnl: number;                // 학습기간 PnL %
    trainWinRate: number;            // 학습기간 승률 %
    trades: number;                   // 거래 수
    maxDD: number;                    // 최대 낙폭 %
    avgUnderwaterMin: number;         // 평균 물려있는 시간 (분)
    avgHoldingMin: number;            // 평균 보유시간 (분)
    regimeConsistency: number;        // 레짐 일관성 점수 (0-100)
    dominantRegime?: SimpleRegime;    // 학습 시 주요 레짐 (TRENDING/RANGING/VOLATILE)
    dominantRegimeRatio?: number;     // 주요 레짐 비율 (0-1, 0.6 = 60%)
    regimeStats?: Record<string, {   // 종목별 레짐 성과 — 합산 (학습+검증)
        trades: number;
        winRate: number;
        avgPnl: number;
    }>;
    trainRegimeStats?: Record<string, {  // ★ 학습기간 레짐별 성과
        trades: number;
        winRate: number;
        avgPnl: number;
    }>;
    valRegimeStats?: Record<string, {    // ★ 검증기간 레짐별 성과
        trades: number;
        winRate: number;
        avgPnl: number;
    }>;
    kellyFraction?: number;          // ★ v49: 종목-레벨 Kelly 비중 (폴백용)
    qualified: boolean;               // 실전 진입 허용 여부 (false = 참고용, 기준 미달)
    disqualifyReason?: string;        // 미달 사유 (표시용)
    allowedRegimes?: string[];        // 허용 레짐 목록 (레거시, backward compat)
    allowedRegimeKeys?: string[];     // ★ 6-way 허용 키 (예: ['TRENDING_SCORE', 'TRENDING_IGNITION'])
    // ★ 레짐×진입타입 독립 파라미터 (T/R/V × Score/Ignition = 6-way)
    regimeEntries?: Partial<Record<string, RegimeParamEntry>>;
    // ★ v36: 18-way 시간 세분화 (레짐 × 세션 × 주말평일)
    timeSegmentEntries?: Partial<Record<TimeSegmentKey, RegimeParamEntry>>;
    allowedTimeSegmentKeys?: string[];  // qualified 18-way 키 목록
    optimizedSession?: Session;       // ★ v48: Rush 세션 태그 (ASIA/EUROPE/US) — Rush로 최적화된 경우만
    sessionCoverage?: number;         // ★ v50: 전천후 지수 (0~6, 적격 세션×요일 커버 수)
    updatedAt: number;                // 등록/갱신 timestamp
}

export interface BacktestSummary {
    tickers: BacktestTickerResult[];
    totalTrades: number;
    totalWins: number;
    totalLosses: number;
    overallWinRate: number;
    totalPnlPercent: number;
    avgWinPercent: number;
    avgLossPercent: number;
    maxDrawdownPercent: number;
    profitFactor: number;
    equityCurve: { time: number; equity: number }[];
    startTime: number;
    endTime: number;
    durationMs: number;
    // DD 관리 통계
    ddManagement?: {
        tradesSkipped: number;          // DD/연속손실로 스킵(사이즈=0)된 거래 수
        tradesReduced: number;          // 축소 진입된 거래 수
        maxConsecutiveLosses: number;   // 최대 연속 손실
        circuitBreakerHits: number;     // DD 서킷 브레이커 발동 횟수
    };
}

export type BacktestStatus = 'idle' | 'running' | 'completed' | 'error';

// ===== Backtest Params (shared between BacktestTab & OptimizerEngine) =====

export interface BacktestParams {
    tpAtrMultiplier: number;
    slAtrMultiplier: number;
    minRiskReward: number;
    shortMultiplier: number;
    adxGateMinimum: number;
    leverageTrending: number;
    leverageRanging: number;
    leverageVolatile: number;
    partialTp1Ratio: number;    // TP1 위치 (TP거리의 %)
    partialQty1: number;        // TP1 물량 비율
    baseSizePercent: number;    // 포지션 비중 %
    maxPositions: number;       // 최대 동시 포지션 수
    topN: number;               // 종목 수 (0=전체)
    periodDays: number;         // 기간 (시간 단위, v29: 5분봉 전환)
    scoreThreshold: number;     // 진입 시그널 최소 점수 (기본 50)
    activeSession: number;      // 시간대 필터: 0=전시간, 1=아시아(00-08UTC), 2=유럽(08-16UTC), 3=미국(16-24UTC)
    reverseMode: boolean;       // 시그널 반전 (Long↔Short)
    maxHoldingBars: number;     // 최대 보유 바 수 (0=무제한, 5분봉 기준)
    // ★ Ignition 감지 임계값 (종목별 최적화)
    ignitionScoreThreshold: number;  // igScore ≥ threshold → Ignition (기본 0.7)
    ignitionVolMin: number;          // igVolSpike ≥ min → Ignition (기본 2.0)
    ignitionBodyMin: number;         // 몸통비율 최소 (0~1, 기본 0.5) — 위꼬리/아래꼬리 필터
    ignitionConsecMin: number;       // 연속 같은방향 캔들 최소 (기본 2)
    // ★ Multi-Timeframe 동의도
    minTfConsensus: number;          // 최소 TF 동의 수: 1=단일TF, 2=2개이상, 3=전체 (기본 2)
    // ★ v36: 지표 게이트 ON/OFF (백테스트-실전 동기화)
    useWaveTrend: boolean;           // WaveTrend 방향 필터
    useIchimoku: boolean;            // Ichimoku 클라우드 필터
    useVWAP: boolean;                // VWAP 과확장 필터
    useMFI: boolean;                 // MFI 볼륨 확인 필터
    useHurst: boolean;               // Hurst 추세/회귀 분류 보강
    // ★ Trap 전략 파라미터 (쏘시지요 봇 기반)
    trapAtrSlMultiplier: number;     // SL = ATR × N (기본 2.0)
    trapAtrTpMultiplier: number;     // TP = ATR × N (기본 3.0)
    trapAdxTrendThreshold: number;   // ADX > N = 추세장 (기본 20)
    trapChopThreshold: number;       // Choppiness > N = messy (기본 38)
    trapReclaimMaxBars: number;      // S/R 재탈환 최대 대기 바 (기본 15)
    trapExcludeRanging: boolean;     // ★ v47: RANGING 레짐에서 Trap 제외 (기본 true)
    trapRequireBothEngines: boolean; // ★ v47: Engine A AND B 동시 충족 필수 (기본 false — 대신 강화 필터 적용)
    trapReclaimVolMin: number;       // ★ v47: 리클레임 봉 볼륨 > 20봉 평균 × N (기본 1.2)

    // ★ Flow (Continuation Flow) 전략 파라미터
    flowAdxMin: number;              // ADX > N (기본 25)
    flowBodyRatioMin: number;        // 추세 연속성 비율 (기본 0.4 ← v47)
    flowVolSpikeMin: number;         // 볼륨 스파이크 최소 (기본 1.3 ← v47)
    flowAtrTpMultiplier: number;     // TP = ATR × N (기본 3.0)
    flowAtrSlMultiplier: number;     // SL = ATR × N (기본 2.0)

    // ★ Wick (Wick Fishing) 전략 파라미터
    wickRatioMin: number;            // 위킹 비율 임계 (기본 0.35)
    wickSrProximityPct: number;      // S/R 근접 % (기본 0.5)
    wickAtrTpMultiplier: number;     // TP = ATR × N (기본 2.5)
    wickAtrSlMultiplier: number;     // SL = ATR × N (기본 1.5)

    // ★ Gap (Gap Fill) 전략 파라미터
    gapSizeMinPct: number;           // 최소 갭 크기 % (기본 0.3)
    gapMaxAgeBars: number;           // 갭 최대 나이 바 (기본 50)
    gapAtrTpMultiplier: number;      // TP = ATR × N (기본 2.0)
    gapAtrSlMultiplier: number;      // SL = ATR × N (기본 1.5)
}

export function getDefaultBacktestParams(cfg: TradingConfig): BacktestParams {
    return {
        tpAtrMultiplier: cfg.swing?.tpAtrMultiplier ?? 7.0,  // ★ v55: 7x
        slAtrMultiplier: cfg.swing?.slAtrMultiplier ?? 1,  // 고정 SL 1% → 50x
        minRiskReward: cfg.swing?.minRiskReward ?? 0.8,
        shortMultiplier: cfg.directionBias?.shortMultiplier ?? 0.5,
        adxGateMinimum: cfg.filters?.adxGateMinimum ?? 20,
        leverageTrending: cfg.swing?.maxLeverage?.TRENDING ?? 10,
        leverageRanging: cfg.swing?.maxLeverage?.RANGING ?? 10,
        leverageVolatile: cfg.swing?.maxLeverage?.VOLATILE ?? 3,
        partialTp1Ratio: 1.0,   // TP1 = TP 위치 (100%)
        partialQty1: 1.0,       // TP1에서 100% 물량 청산
        baseSizePercent: cfg.sizing?.baseSizePercent ?? 25,
        maxPositions: 12,
        topN: 30,
        periodDays: 72,  // 3일
        scoreThreshold: 50,
        activeSession: 0,       // 전시간 (필터 없음)
        reverseMode: false,
        maxHoldingBars: 0,  // 무제한
        ignitionScoreThreshold: 0.7,  // 기본 Ignition score 임계값
        ignitionVolMin: 2.0,          // 기본 거래량 스파이크 최소값
        ignitionBodyMin: 0.5,         // 기본 몸통비율 최소 50%
        ignitionConsecMin: 2,         // 기본 연속방향 최소 2봉
        minTfConsensus: 2,            // 기본: 최소 2개 TF 동의 필요
        // ★ v36: 지표 게이트 (기본 OFF — 옵티마이저가 결정)
        useWaveTrend: false,
        useIchimoku: false,
        useVWAP: false,
        useMFI: false,
        useHurst: false,
        // ★ Trap 전략 기본값
        trapAtrSlMultiplier: 2.0,
        trapAtrTpMultiplier: 3.0,
        trapAdxTrendThreshold: 20,
        trapChopThreshold: 38,
        trapReclaimMaxBars: 15,
        trapExcludeRanging: true,
        trapRequireBothEngines: false,
        trapReclaimVolMin: 1.2,
        // ★ Flow 전략 기본값
        flowAdxMin: 25,
        flowBodyRatioMin: 0.4,
        flowVolSpikeMin: 1.3,
        flowAtrTpMultiplier: 3.0,
        flowAtrSlMultiplier: 2.0,
        // ★ Wick 전략 기본값
        wickRatioMin: 0.35,
        wickSrProximityPct: 0.5,
        wickAtrTpMultiplier: 2.5,
        wickAtrSlMultiplier: 1.5,
        // ★ Gap 전략 기본값
        gapSizeMinPct: 0.3,
        gapMaxAgeBars: 50,
        gapAtrTpMultiplier: 2.0,
        gapAtrSlMultiplier: 1.5,
    };
}

export function applyParamsToConfig(base: TradingConfig, params: BacktestParams): TradingConfig {
    return {
        ...base,
        directionBias: {
            ...base.directionBias,
            shortMultiplier: params.shortMultiplier,
            reverseMode: params.reverseMode,
        },
        sizing: {
            ...base.sizing,
            baseSizePercent: params.baseSizePercent,
        },
        swing: {
            ...base.swing,
            tpAtrMultiplier: params.tpAtrMultiplier,
            slAtrMultiplier: params.slAtrMultiplier,  // 고정 SL% → 레버리지 자동 결정
            minRiskReward: params.minRiskReward,
            maxLeverage: {
                TRENDING: params.leverageTrending,
                RANGING: params.leverageRanging,
                VOLATILE: params.leverageVolatile,
            },
            partialTp: [params.partialTp1Ratio, 1.0],
            partialQty: [params.partialQty1, +(1 - params.partialQty1).toFixed(2)],
            scanTopN: params.topN,  // 스캔 범위 → 실전 scanTopN
            maxHoldingBars: params.maxHoldingBars,
            // ★ maxHoldingBars(5분봉) → timeExitMinutes 변환: 백테스트 인사이트 실전 연결
            timeExitMinutes: params.maxHoldingBars > 0 ? params.maxHoldingBars * 5 : base.swing.timeExitMinutes,
        },
        filters: {
            ...base.filters,
            adxGateMinimum: params.adxGateMinimum,
            // ★ v36: 지표 게이트 ON/OFF 전달
            useWaveTrend: params.useWaveTrend ?? false,
            useIchimoku: params.useIchimoku ?? false,
            useVWAP: params.useVWAP ?? false,
            useMFI: params.useMFI ?? false,
            useHurst: params.useHurst ?? false,
            // ★ v36: ignition + minTfConsensus 전달 (백테-실전 동기화)
            ignitionScoreThreshold: params.ignitionScoreThreshold,
            ignitionVolMin: params.ignitionVolMin,
            ignitionBodyMin: params.ignitionBodyMin,
            ignitionConsecMin: params.ignitionConsecMin,
            minTfConsensus: params.minTfConsensus,
        },
    };
}

// ===== Optimizer Types =====

export interface OptimizerParamRange {
    key: keyof BacktestParams;
    values: (number | boolean)[];
    label: string;
}

export interface OptimizerComboResult {
    rank: number;
    params: BacktestParams;
    fitnessScore: number;
    totalPnlPercent: number;
    overallWinRate: number;
    maxDrawdownPercent: number;
    profitFactor: number;
    totalTrades: number;
    // 자동 검증 (학습 후 미래 데이터)
    valPnlPercent: number;
    valWinRate: number;
    valMaxDD: number;
    valProfitFactor: number;
    valTrades: number;
    // 몬테카를로 생존 분석 (Aggressive 모드)
    survivalRate: number;       // 생존율 (0-100%)
    maxConsecLosses: number;    // 최대 연속 손실
    // 종합 점수 (Aggressive: 생존35% + 검증30% + 연패20% + 학습15%)
    compositeScore?: number;
    // 검증기간 종목별 결과 (거래내역 포함, UI 표시용)
    tickerResults?: BacktestTickerResult[];
    // 학습기간 종목별 결과 (학습/검증 비교용)
    trainTickerResults?: BacktestTickerResult[];
}

export interface OptimizerSummary {
    results: OptimizerComboResult[];
    totalCombos: number;
    completedCombos: number;
    elapsedMs: number;
    cachedTickers: string[];
}

export type OptimizerStatus = 'idle' | 'fetching' | 'optimizing' | 'completed' | 'error';

// ===== Auto-Optimizer =====

export type AutoOptMode = 'ignition-wf';

export interface AutoOptimizerState {
    enabled: boolean;
    mode: AutoOptMode;
    phase: 'idle' | 'running-normal' | 'running-reverse' | 'comparing' | 'fine-tuning' | 'waiting' | 'halted' | 'watching' | 'running-wf' | 'completed';
    cycleCount: number;
    lastCycleTime: number | null;
    nextCycleTime: number | null;
    waitRemainingMs: number;
    lastResult: {
        normalBest: { valPnlPercent: number; valWinRate: number; compositeScore?: number; survivalRate?: number } | null;
        reverseBest: { valPnlPercent: number; valWinRate: number; compositeScore?: number; survivalRate?: number } | null;
        applied: 'normal' | 'reverse' | 'halted';
        timestamp: number;
    } | null;
    error: string | null;
    progressMsg: string;
    progressPct: number;
    // 마지막 사이클 전체 결과 (Top 10 랭킹 표시용)
    lastSummaries?: {
        normalResults: OptimizerComboResult[];
        reverseResults: OptimizerComboResult[];
    } | null;
    // ★ DNA 분석 결과 (시장 구조 인사이트)
    dnaAnalysis?: DnaAnalysis | null;
    // ★ 미세 최적화 진행 상황
    fineTuneProgress?: {
        total: number;           // 전체 종목 수
        current: number;         // 현재 처리중인 종목 인덱스 (1-based)
        currentTicker: string;   // 현재 종목명
        results: Array<{         // 완료된 종목들의 before/after
            ticker: string;
            beforePnl: number;
            afterPnl: number;
            beforeWR: number;
            afterWR: number;
            improved: boolean;
        }>;
    };
}

// ===== Walk-Forward Analysis =====

export interface WalkForwardWindow {
    windowIndex: number;
    trainBarRange: [number, number];
    testBarRange: [number, number];
    bestParams: BacktestParams;
    bestFitness: number;
    trainPnl: number;
    testPnl: number;
    testWinRate: number;
    testTrades: number;
    testMaxDD: number;
    testProfitFactor: number;
    // ★ ignition-wf 확장
    minTestTradesMet?: boolean;                  // 최소 검증 거래수 충족 여부
    selectedMode?: 'normal' | 'reverse';         // 선택된 방향
}

export interface WalkForwardSummary {
    windows: WalkForwardWindow[];
    avgTrainPnl: number;
    avgTestPnl: number;
    avgTestWinRate: number;
    totalTestTrades: number;
    avgTestMaxDD: number;
    overfitRatio: number;       // |학습 평균 PnL| / |검증 평균 PnL| — 높을수록 과적합
    elapsedMs: number;
    totalCombosPerWindow: number;
    cachedTickers: string[];
    processedTickers?: string[];             // ★ 로테이션 추적: 이번 사이클에서 처리한 종목
    // ★ ignition-wf 확장
    selectedParams?: BacktestParams;         // median 윈도우의 최종 선택 파라미터
    windowsPassingMinTrades?: number;        // 최소 거래수 충족 윈도우 수
}
