/**
 * TradingEngine — 오케스트레이터
 *
 * 역할: 모듈 초기화 + 메인 루프 + 이벤트 라우팅
 * 로직은 모두 core/ 모듈에 위임.
 *
 * 모듈 구조:
 *   Scanner       — 방향 감지 + 레짐 분류
 *   ZoneEngine    — 존 생성 + 선호도 필터
 *   EntryManager  — 존 모니터링 + 트리거
 *   Execution     — 주문 실행 + 사이징 + TP/SL
 *   PositionManager — 포지션 동기화 + 리스크 관리
 *   MarketAwareTuner — 시장 기회 기반 3축 파라미터 자동 조정 (5건마다 + 봇 시작 시)
 *   Gemini StratTuner — AI 기반 전략적 필터 파라미터 조정 (50건마다, Layer 2)
 */

import { EventEmitter } from './eventEmitter';
import type {
    BotState, AiCoreConfig, Trade, KlineData,
    WaitingCandidate, TradeSession, TradingConfig, TickerParamEntry,
    DnaComboStats, TickerDnaProfile, ScanStatus, ScanFilterStep, SimpleRegime, RegimeParamEntry,
    EntryType, Session, DayType, TimeSegmentKey, ShadowSignal,
} from '../types';
import { getDefaultTradingConfig, applyParamsToConfig, makeRegimeEntryKey, getEntryTypeFromZoneType, getSessionAndDayType, makeTimeSegmentKey, parseTimeSegmentKey, ALL_SESSIONS, ALL_DAYTYPES } from '../types';
import * as bybitService from './bybitService';
import { calculateATR, calculateADX, calculateRSI, calculateEMA, calculateVWAP, calculateWaveTrend, calculateIchimoku, calculateMFI, calculateHurstExponent, aggregateCandles } from './indicatorService';
// Core modules
import { Scanner } from './core/scanner';
import { ZoneEngine } from './core/zoneEngine';
import { EntryManager } from './core/entryManager';
import { Execution } from './core/execution';
import { PositionManager } from './core/positionManager';
import { MarketAwareTuner } from './core/autoTuner';
import { assessNewsImpact, type NewsImpactResult } from './geminiService';
// Phase 1: Sentiment
import { SentimentService } from './sentimentService';
import { getWsInstance } from './bybitWebSocket';
import { sendTelegramNotification } from './telegramService';
import { saveTrade as persistTrade } from './firebase';

// ── 상수 ──

const DEFAULT_MAX_POSITIONS = 5;  // v52.80: 페이커봇 v2 — 5분할, 최대 5포지션
const ROTATION_INTERVAL_MS = 5 * 60 * 1000; // v17: 3분→5분 (스윙 스캔 간격)
const ZONE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15분마다 타점존 갱신
// ★ 손실 종목 이벤트 기반 차단 (다른 종목 진입 시 해제)
const SCAN_BATCH_LIGHT = 25;            // ★ v35f: 경량스캔 배치 확대 (20→25)
const SCAN_BATCH_FULL = 10;             // ★ v35f: 풀스캔 배치 확대 (8→10)

// ★ v52.12: 신뢰도 기반 동적 TP 배수 (1.1x ~ 2.0x)
function calcDynamicTpMultiplier(confidence: number): number {
    return Math.round(Math.min(2.0, Math.max(1.1, 1.0 + (confidence - 50) / 60)) * 100) / 100;
}

// ★ v52.88: 런타임 필터 — qualified/WR/EV 체크 전부 제거
// 백테스트 수치가 실전과 역상관 → 적격 판정 무의미
// 레짐×방향 차단(SESSION_REGIME_BLOCKS)이 유일한 필터
function passesRuntimeFilter(entry?: { trades?: number; winRate?: number; avgWin?: number; avgLoss?: number; qualified?: boolean }, shadowOverride?: boolean, session?: string): boolean {
    return !!entry;  // entry 존재하면 통과
}

// v24: 변동성 기반 워치리스트 (12h 변동 3%+ 종목만 스캔, 상한 없음)
const MIN_VOLATILITY_12H_PCT = 3;   // 12시간 최소 변동률 %

const TRADING_CONFIG_KEY = 'trading_config_v1';

// ── Helper ──

function loadConfig(): TradingConfig {
    try {
        const raw = localStorage.getItem(TRADING_CONFIG_KEY);
        if (raw) {
            const config = JSON.parse(raw);
            // v2 마이그레이션: 비중 2/3 축소 (25% → 17%)
            if (!config._sizeReduced) {
                if (config.sizing && config.sizing.baseSizePercent > 20) {
                    config.sizing.baseSizePercent = Math.round(config.sizing.baseSizePercent * 2 / 3);
                }
                config._sizeReduced = true;
            }
            // v3 마이그레이션: 진입 품질 게이트 필터 추가
            if (config.filters && config.filters.rangePositionMaxLong === undefined) {
                config.filters.rangePositionMaxLong = 20;
                config.filters.rangePositionMinShort = 80;
                config.filters.antiChasingMomentumMax = 0.3;
                config.filters.volumeMinRatio = 1.2;
            }
            // v4 마이그레이션: 193건 실거래 분석 기반 조정
            if (!config._v4DataDriven) {
                config.filters.rangePositionMaxLong = 20;
                config.filters.rangePositionMinShort = 80;
                config.tpSlRatio.slMultiplier = 0.7;
                config._v4DataDriven = true;
            }
            // v5 마이그레이션 (덮어씀)
            if (!config._v5TwoBot) {
                config._v5TwoBot = true;
            }
            // v6 마이그레이션: 3봇 34건 심층분석 — SL 복원 + 레인지 완화
            if (!config._v6ThreeBot) {
                config.tpSlRatio.slMultiplier = 0.7;
                config.filters.rangePositionMaxLong = 50;
                config.filters.rangePositionMinShort = 85;
                config._v6ThreeBot = true;
            }
            // v7 마이그레이션: 38건 분석 — Long레인지 제거 + Short게이트 강화 + 시간탈출
            // 근거: Long ≤50% 0%WR vs >50% 69.2%WR → 레인지 필터 역효과
            //       Short 39.1%WR(-11.37) → gate 80으로 강화
            //       0-15분 73%WR vs 60분+ 25%WR → 20분 시간기반 탈출
            if (!config._v7TimeBased) {
                config.filters.rangePositionMaxLong = 100;
                config._v7TimeBased = true;
            }
            // v8 마이그레이션: 45건 다각도 분석 — BB/RSI/볼륨스파이크 게이트
            // 근거: Short BB<50% = 7%WR(-14.17), Short RSI<45 = 10%WR(-5.94)
            //       볼륨>5x = 0%WR(-5.81), EMA추종 전체 25%WR
            if (!config._v8BBRsiGate) {
                config.filters.bbPositionMinShort = 50;     // BB 하단 Short 금지
                config.filters.rsiMinShort = 50;            // 과매도 Short 금지
                config.filters.volumeSpikeMax = 4.0;        // 극단 볼륨 차단
                config.filters.rangePositionMinShort = 0;   // BB+RSI가 대체 → 비활성 (거래횟수 확보)
                config._v8BBRsiGate = true;
            }
            // v9 마이그레이션: 255건 블라인드스팟 분석 — ADX게이트/노이즈/순방향캔들
            // 근거: ADX 15-25 = 184건 40%WR(-22.37), R/B>2.5 = 28%WR(-17.88)
            //       순방향 3+ = 21%WR(-4.57)
            if (!config._v9BlindSpot) {
                config.filters.adxGateMinimum = 20;       // ADX<20 약한추세 차단
                config.filters.noiseMaxRatio = 6.0;        // 캔들 노이즈 상한 (거래종목 평균6.7)
                config.filters.consecutiveCandleMax = 2;   // 순방향 연속캔들 상한
                config.filters.volumeMinRatio = 1.0;       // 볼륨비 완화 (좋은기회 76% 차단 방지)
                config._v9BlindSpot = true;
            }
            // v10 마이그레이션: 100건 타점 분석 — 역추세 강화 + BB데드존
            // 근거: 0TF정렬=70%WR vs 2+정렬=36%WR, BB60-80%=20%WR
            //       pullback=41%WR, breakout=17%WR, bearishDiv=13%WR
            if (!config._v10EntryTiming) {
                config.filters.bbDeadZoneMin = 60;       // BB 데드존 60-80%
                config.filters.bbDeadZoneMax = 80;
                config.filters.maxTfAlignment = 1;        // 최대 1개 TF 정렬 허용
                config._v10EntryTiming = true;
            }
            // v12 마이그레이션: 145건 타점 전수조사 — 0% 통과 문제 해결
            // 근거: TF정렬 34% 차단, ADX 6% 차단, antiChasing 8% 차단
            //       방향불일치 50% → detectDirection 가격모멘텀 반전감지 추가
            if (!config._v12EntryExpand) {
                config.filters.maxTfAlignment = 2;        // v12: 1→2 (TF정렬 34% 차단 해소)
                config.filters.adxGateMinimum = 15;       // v12: 20→15 (추세 초반 ADX 낮음)
                config.filters.antiChasingMomentumMax = 0.5; // v12: 0.3→0.5% (8% 차단 해소)
                config._v12EntryExpand = true;
            }
            // v13 마이그레이션: 포지션 분산 — 비중 1/3 축소 + 9포지션
            // 근거: 집중 비중(17%) 5포지션 → 분산(6%) 9포지션으로 리스크 분산
            if (!config._v13PositionSpread) {
                config.sizing.baseSizePercent = 6;   // 17→6 (1/3 축소)
                config._v13PositionSpread = true;
            }
            // v14 마이그레이션: 69건 심층분석 — Short 필터 재활성화 + 역추세 타점 강화
            // 근거: Short BB>40%=0%WR(23건), 1+연속캔들=7%WR(15건), Short+양모멘텀=0%WR(15건)
            if (!config._v14CounterTrend) {
                config.filters.consecutiveCandleMax = 0;       // 2→0 (역방향 캔들 후만 진입)
                config.filters.bbPositionMinShort = 50;         // Short BB>50% 차단 재확인
                config.filters.rsiMinShort = 50;                // Short RSI<50 차단 재확인
                config._v14CounterTrend = true;
            }
            // v15 마이그레이션: 591건 심층분석 — 포지션 집중 + 비중 3배
            // 근거: 0-5min=14.5%WR(346건 58.5%) → 저품질 거래 대량 생산
            //       4포지션 집중(18%) → 9포지션 분산(6%) 대비 상위 44%만 진입
            //       Short+RSI>60=0%WR, Short+mom>0=3.6%WR → 하드블록 필요
            if (!config._v15PositionConcentrate) {
                config.sizing.baseSizePercent = 18;   // 6→18 (3배 증가, 4포지션 집중)
                config._v15PositionConcentrate = true;
            }
            // v16 마이그레이션: 소프트블록 파라미터 + 레짐 적응형 시스템
            // 근거: 시장 변화 시 하드블록이 기회를 차단 → Gemini 관리 소프트블록으로 전환
            if (!config._v16RegimeAdaptive) {
                config.filters.rsiMaxShort = 60;           // Short RSI 상한 (Gemini가 60~80 조절)
                config.filters.momentumBlockShort = 0;     // Short 모멘텀 차단 (Gemini가 0~0.5 조절)
                config._v16RegimeAdaptive = true;
            }
            // v17 마이그레이션: 스캘핑→스윙 구조변경
            // 근거: WR43.5% R:R0.89 수학적 손실 → 방향감지 우수(15min+88%WR) 활용
            //       TP=ATR×7, SL=ATR×2.75, R:R≥2:1, 3포지션×30%, 1h primary + 4h confirm
            if (!config._v17SwingRestructure) {
                config.sizing.baseSizePercent = 30;        // 18→30 (3포지션 집중)
                config.filters.optimalHoldingMinutes = 240; // 60→240 (4시간 목표 보유)
                // swing 서브객체 추가 (getDefaultTradingConfig에서 기본값 가져옴)
                const defaults = getDefaultTradingConfig();
                config.swing = defaults.swing;
                config._v17SwingRestructure = true;
            }
            // v18 마이그레이션: Phase 3 — WaveTrend + Ichimoku 필터 기본값
            if (!config._v18Phase3) {
                const defaults = getDefaultTradingConfig();
                config.filters.wtOverboughtThreshold = defaults.filters.wtOverboughtThreshold;
                config.filters.wtOversoldThreshold = defaults.filters.wtOversoldThreshold;
                config.filters.ichimokuCloudMinThickness = defaults.filters.ichimokuCloudMinThickness;
                config._v18Phase3 = true;
            }
            // v19 마이그레이션: 필터 정리 — 4(노이즈),5(연속캔들),11(BB데드존) 제거 + 3b,8b 완화
            // 근거: WaveTrend+Ichimoku가 종합적 모멘텀/추세 판단 → 중복 필터 제거로 진입 기회 확보
            if (!config._v19FilterCleanup) {
                config.filters.momentumBlockShort = 0.3;
                config.filters.rsiMaxShort = 80;
                config._v19FilterCleanup = true;
            }
            // v24 마이그레이션: 12포지션 분산 + TP 축소 + 숏 억제
            if (!(config as any)._v24Diversify) {
                config.sizing.baseSizePercent = 20;
                config.swing.tpAtrMultiplier = 2.0;
                config.swing.slAtrMultiplier = 1;
                config.swing.minRiskReward = 1.3;
                config.swing.timeExitMinutes = 0;
                config.directionBias.shortMultiplier = 0.5;
                (config as any)._v24Diversify = true;
            }
            // v27 마이그레이션: scanTopN 기본값
            if (!(config as any)._v27Optimizer) {
                config.swing.scanTopN = 10;
                config.directionBias.shortMultiplier = 0;
                (config as any)._v27Optimizer = true;
            }
            // v28 마이그레이션: Deep 옵티마이저 최적 파라미터 (124K 조합 탐색)
            if (!(config as any)._v28DeepOptimizer) {
                config.swing.tpAtrMultiplier = 6.0;  // ★ v50.1: TP2.5→6.0 (RR불량 제거)
                config.swing.slAtrMultiplier = 1;     // 고정 SL 1% → 레버리지 50x
                config.swing.minRiskReward = 1.5;
                // maxLeverage 레짐 캡 제거 — SL%가 레버리지 결정
                config.swing.partialTp = [1.0, 1.0];  // TP1 전량 청산
                config.swing.partialQty = [1.0, 0];   // 100% 물량
                config.swing.scanTopN = 10;
                config.directionBias.shortMultiplier = 0;
                config.filters.adxGateMinimum = 25;
                config.sizing.baseSizePercent = 10;
                (config as any)._v28DeepOptimizer = true;
            }
            localStorage.setItem(TRADING_CONFIG_KEY, JSON.stringify(config));
            return config;
        }
    } catch {}
    return getDefaultTradingConfig();
}

function saveConfig(config: TradingConfig): void {
    try {
        localStorage.setItem(TRADING_CONFIG_KEY, JSON.stringify(config));
    } catch {}
}

// ──────────────────────────────────────────────────────────────
// ██  TradingEngine — Orchestrator                            ██
// ──────────────────────────────────────────────────────────────

export class TradingEngine {
    private eventEmitter: EventEmitter;
    private state: BotState;
    private config: AiCoreConfig | null = null;

    // Core modules
    private scanner: Scanner;
    private zoneEngine: ZoneEngine;
    private entryManager: EntryManager;
    private execution: Execution;
    private positionManager: PositionManager;
    public tradingConfig: TradingConfig;

    // Phase 1: Sentiment
    private sentimentService: SentimentService;

    // MarketAwareTuner (시장 기회 기반 3축 파라미터 자동 조정)
    private marketTuner: MarketAwareTuner;
    // Gemini StratTuner (AI 기반 전략적 필터 조정, Layer 2)
    private lastStratTuneTimestamp: number = 0;
    // v16: 레짐 시프트 감지
    private lastKnownRegime: 'BULL' | 'BEAR' | 'RANGE' = 'RANGE';
    private lastRegimeCheckTime: number = 0;
    private cachedEnrichedRecords: import('../types').BybitTradeRecord[] = [];

    // v22: 변동성 기반 워치리스트 (고정 종목 없음)
    private watchlist: string[] = [];
    private lastWatchlistRefreshTime: number = 0;

    // Loop state
    private isMonitoring = false;
    private isTradingEnabled = false;
    private intervalId: ReturnType<typeof setTimeout> | null = null;
    private _syncInterval: ReturnType<typeof setInterval> | null = null;
    private isGlobalExecutionLocked = false;
    private executionLockedSince = 0;

    // Timing
    private lastScanTime = 0;
    private lastHealthCheck = 0;
    private lastZoneRefreshTime = 0;
    private lastStateEmitTime = 0;
    private lastEntryTime = Date.now();

    private tickerParamRegistry: Record<string, TickerParamEntry> = {};  // 종목별 최적 파라미터 (빈 객체 = 제한 없음)
    private dnaFilters: DnaComboStats[] = [];  // ★ DNA 회피 조건 (EV < 0 조합)
    private dnaPositiveFilters: DnaComboStats[] = [];  // ★ DNA 긍정 필터 (EV 상위 조건에서만 진입)
    private tickerDnaProfiles: Record<string, TickerDnaProfile> = {};  // ★ 종목별 DNA 프로파일
    private recentRegimes: string[] = [];  // ★ 최근 레짐 관측 (maxPos 조정용)
    // v31: globalScanCooldown 삭제 (3연패 쿨다운 제거)
    private globalRecentTrades: Array<{ win: boolean; timestamp: number; ticker: string }> = [];
    private tickerConsecLosses: Record<string, number> = {};  // ★ 종목별 연속 손실 추적 (2연패 → 재최적화)
    private scanStatuses: ScanStatus[] = [];  // ★ 마지막 스캔 게이트 결과 (진입 가시성)

    // ★ v52.80: 페이커봇 v2 — 모멘텀 라이더 + 쿨다운 + 블랙리스트
    private _fakerMomentum: Record<string, { result: 'tp' | 'sl'; regime: string; direction: string; timestamp: number }> = {};
    private _fakerCooldown: Record<string, number> = {};  // ticker → cooldown until timestamp
    private _fakerBlacklist: Set<string> = new Set();      // 3연패 세션 블랙리스트
    private _fakerConsecLosses: Record<string, number> = {};  // ticker → 연속 SL 수
    // ★ v55.2: 동일 종목 120분 쿨타임 (21,625건 분석: <30분 WR 42.1% 위험, >120분 WR 51.4% 안전)
    private readonly FAKER_COOLDOWN_MS = 120 * 60 * 1000;  // 120분 쿨다운
    private readonly FAKER_MOMENTUM_WINDOW_MS = 5 * 60 * 1000;  // 5분 내 재진입

    // ★ v55: 연승/연패 적응형 비중
    private _globalConsecWins = 0;   // 전체 연속 승리 수
    private _globalConsecLosses = 0; // 전체 연속 패배 수

    // ★ v55.2: 종목 블랙리스트 (21,625건 전체 분석: EV<-0.1 or WR<45% 70종목)
    private static readonly TICKER_BLACKLIST_V55: Set<string> = new Set([
        // EV < -0.3 (최악)
        'LRCUSDT', 'KASUSDT', 'INUSDT', 'CUSDT', 'IPUSDT', 'SOPHUSDT', 'HANAUSDT',
        // EV -0.3 ~ -0.2
        '1000000MOGUSDT', 'ATUSDT', 'TWTUSDT', '0GUSDT', 'ZECUSDT', 'JASMYUSDT',
        'ZENUSDT', 'ESPORTSUSDT', 'BRETTUSDT', 'SHIB1000USDT', 'QNTUSDT',
        // EV -0.2 ~ -0.15
        'JCTUSDT', 'SOONUSDT', 'NIGHTUSDT', 'PLUMEUSDT', 'QTUMUSDT', 'ALCHUSDT',
        'SXPUSDT', 'TACUSDT', 'NOMUSDT', 'ONTUSDT', 'VELOUSDT', 'TONUSDT',
        // EV -0.15 ~ -0.10
        'DUSKUSDT', 'LITUSDT', 'BANUSDT', 'CELOUSDT', 'ARCUSDT', 'HAEDALUSDT',
        'ZKUSDT', 'GUNUSDT', 'FOGOUSDT', 'NTRNUSDT', 'ZKPUSDT', 'WLDUSDT',
        'CAMPUSDT', 'APEXUSDT', 'AUSDT', 'ZROUSDT', 'BARDUSDT', 'ARIAUSDT',
        'CCUSDT', 'CFXUSDT',
        // EV -0.10 ~ -0.04 (WR<45%)
        'PYTHUSDT', 'KERNELUSDT', 'APTUSDT', 'POLYXUSDT', 'BANANAS31USDT',
        'STGUSDT', 'TRUMPUSDT', 'DOODUSDT',
        // 기존 v55 유지
        'FUSDT', 'RIVERUSDT',
    ]);

    // ★ v52.36: 섀도우 트레이딩 — 모든 Ignition 시그널을 가상 기록
    private shadowSignals: ShadowSignal[] = [];
    private _shadowEnabled = false;
    private readonly SHADOW_MAX_SIGNALS = 7000;
    // ★ v52.92: 타임아웃 제거 — 실전과 동일하게 TP/SL만으로 청산
    // ★ v53.4: 섀도우 자동 CSV 내보내기
    private _shadowLastExportTime = 0;
    private _shadowExportedIds = new Set<string>();  // 이미 내보낸 시그널 ID 추적
    private readonly SHADOW_EXPORT_COOLDOWN_MS = 30 * 60 * 1000; // 30분 쿨다운

    // ★ v35: 뉴스 방어 + FUD 역매매
    private _newsCache: NewsImpactResult | null = null;
    private _newsCacheTimestamp: number = 0;
    private readonly NEWS_CACHE_TTL = 2 * 60 * 60 * 1000;  // 2시간 캐시

    // ★ v34: 동시 시그널 시 수익률 높은 종목 우선 진입
    private _pendingFullScanEntries: Array<{
        ticker: string; direction: 'Long' | 'Short';
        config: TradingConfig; atr: number; currentPrice: number;
        equity: number; availableBalance: number;
        regime: string; regimeResult: any;
        zoneMinPrice: number; zoneMaxPrice: number; zoneType: string;
        reasoning: string; selectedTimeframe: string;
        isIgnitionFast: boolean; _entryType?: EntryType;
        tfConsensus: number;
        registryWinRate: number; registryPnL: number; registryLeverage: number;
        // ★ v35e: 진입 시 통계 표시용
        registryTrades: number; registryAvgWin: number; registryAvgLoss: number;
        registryMaxDD: number; registryAvgHoldMin: number;
        registryKellyFraction: number; registryConfidenceScore: number;  // ★ v49
        registrySessionCoverage: number;  // ★ v50: 전천후 지수
        existingScan: ScanStatus | undefined;
    }> = [];

    constructor(eventEmitter: EventEmitter) {
        this.eventEmitter = eventEmitter;

        // Emit helper bound to eventEmitter
        const emit = (type: string, sender: string, msg: string, category?: string) => {
            this.eventEmitter.emit(type, sender, msg, category);
        };

        // Initialize modules
        this.scanner = new Scanner();
        this.zoneEngine = new ZoneEngine(emit);
        this.entryManager = new EntryManager(emit);
        this.execution = new Execution(emit);
        this.positionManager = new PositionManager(emit, () => this.tickerParamRegistry);
        this.tradingConfig = loadConfig();
        this.marketTuner = new MarketAwareTuner(this.tradingConfig);

        // Phase 1: Sentiment Service + WebSocket CVD 연결
        this.sentimentService = new SentimentService();
        const ws = getWsInstance(this.eventEmitter);
        this.sentimentService.setWsCVDAccessor((ticker) => ws.getCVD(ticker));

        // Initialize state
        this.state = {
            totalEquity: 0, availableBalance: 0, openPositions: [], openOrders: [],
            lastActivity: 'Initialized', sessionTradeHistory: [], currentSession: null,
            sessionStats: {
                initialEquity: 0, currentEquity: 0, sessionReturnPercent: 0,
                sessionPnl: 0, totalTrades: 0, winRate: 0, unrealizedPnl: 0,
                realizedPnl: 0, profitFactor: 0,
            },
            liveKlines: {}, latestPrices: {}, isFilterActive: false, filterResults: [],
            sessionMaxEquity: 0, reservedProfits: 0,
            activeStrategies: {}, tradesSinceLastOptimization: 0,
            analyzingTickers: [], analysisStatus: 'running', lastScanResult: null,
            optimizationVersion: 1,
            isLeverageOverrideActive: false, isReverseTradingActive: false,
            isSmartReverseActive: false, isBerserkerMode: false, isAutoBerserker: false,
            allInPercentage: 50, tpClosePercentage: 50,
            snipingTickers: [], waitingCandidates: [],
            nextRotationTime: Date.now() + ROTATION_INTERVAL_MS,
            priorityCandidate: undefined, selectionWindowEndTime: 0,
            candidatesInZone: [],
            shadowSignals: [],
        };

        console.log(`[TradingEngine] 오케스트레이터 초기화 | Config loaded`);
    }

    // ── Public API (UI 호환) ──

    /** v27: 최대 동시 포지션 수 (config 우선, 없으면 기본값) + 레짐 기반 감소 */
    private get maxPositions(): number {
        const base = (this.config as any)?.maxPositions ?? DEFAULT_MAX_POSITIONS;
        // ★ Feature 5: 레짐 기반 포지션 한도 — 시장 대부분이 RANGING이면 maxPos 절반
        if (this.recentRegimes.length >= 5) {
            const rangingCount = this.recentRegimes.filter(r => r === 'RANGING').length;
            const rangingRatio = rangingCount / this.recentRegimes.length;
            if (rangingRatio > 0.6) {
                return Math.max(1, Math.floor(base * 0.5));
            }
        }
        return base;
    }

    public updateConfig(config: AiCoreConfig) {
        this.config = config;
        // v27: scanTopN 실시간 반영
        if (config.scanTopN !== undefined && this.tradingConfig.swing) {
            const oldTopN = this.tradingConfig.swing.scanTopN;
            this.tradingConfig.swing.scanTopN = config.scanTopN;
            if (oldTopN !== config.scanTopN) {
                this.lastWatchlistRefreshTime = 0;
            }
        }
        // v27: baseSizePercent 실시간 반영
        if (config.baseSizePercent !== undefined) {
            this.tradingConfig.sizing.baseSizePercent = config.baseSizePercent;
        }
    }

    /** v29: 백테스트/옵티마이저 파라미터를 실전 거래에 즉시 적용 */
    public applyLiveParams(newConfig: TradingConfig, extra?: { maxPositions?: number; tickerParamRegistry?: Record<string, TickerParamEntry>; dnaFilters?: DnaComboStats[]; dnaPositiveFilters?: DnaComboStats[]; tickerDnaProfiles?: Record<string, TickerDnaProfile> }): void {
        this.tradingConfig = newConfig;
        saveConfig(newConfig);
        this.lastWatchlistRefreshTime = 0; // 워치리스트 즉시 갱신
        // AiCoreConfig 쪽도 동기화 (UI 슬라이더 반영)
        if (this.config) {
            this.config.scanTopN = newConfig.swing?.scanTopN;
            this.config.baseSizePercent = newConfig.sizing?.baseSizePercent;
            if (extra?.maxPositions !== undefined) {
                (this.config as any).maxPositions = extra.maxPositions;
            }
        }
        // 종목별 파라미터 레지스트리 적용 (per-ticker params)
        if (extra?.tickerParamRegistry !== undefined) {
            const oldRegistry = this.tickerParamRegistry;
            this.tickerParamRegistry = extra.tickerParamRegistry;

            // ★ 레지스트리 교체 시 좀비 후보 청소:
            // 이전 최적화에서 qualified였지만 새 최적화에서 탈락한 종목이
            // waitingCandidates에 남아 스캔 preFilter를 막는 문제 해결
            const qualifiedTickers = new Set(
                Object.entries(this.tickerParamRegistry)
                    .filter(([, e]) => e.qualified !== false)
                    .map(([t]) => t)
            );
            const beforeCount = this.state.waitingCandidates.length;
            this.state.waitingCandidates = this.state.waitingCandidates.filter(
                c => qualifiedTickers.has(c.ticker)
            );
            const removed = beforeCount - this.state.waitingCandidates.length;
            if (removed > 0) {
                this.eventEmitter.emit('newMessage', 'system',
                    `🧹 [Registry] 대기 후보 ${removed}개 제거 (레지스트리 탈락)`,
                    'system_state');
            }

            // 레지스트리 탈락 시 포지션 유지 — TP/SL로만 청산 (백테스트 동일)
        }
        // ★ DNA 회피 필터 적용
        if (extra?.dnaFilters !== undefined) {
            this.dnaFilters = extra.dnaFilters;
        }
        // ★ DNA 긍정 필터 적용 (Feature 1)
        if (extra?.dnaPositiveFilters !== undefined) {
            this.dnaPositiveFilters = extra.dnaPositiveFilters;
        }
        // ★ 종목별 DNA 프로파일 적용 (Feature 3)
        if (extra?.tickerDnaProfiles !== undefined) {
            this.tickerDnaProfiles = extra.tickerDnaProfiles;
        }
        const s = newConfig.swing;
        const f = newConfig.filters;
        const d = newConfig.directionBias;
        const maxPos = extra?.maxPositions ?? this.maxPositions;
        const regKeys = Object.keys(this.tickerParamRegistry);
        const regMsg = regKeys.length > 0
            ? ` 종목파라미터:${regKeys.map(t => t.replace('USDT', '')).join(',')}`
            : '';
        const dnaMsg = this.dnaFilters.length > 0
            ? ` DNA회피:${this.dnaFilters.length}개`
            : '';
        const posMsg = this.dnaPositiveFilters.length > 0
            ? ` DNA긍정:${this.dnaPositiveFilters.length}개`
            : '';
        const tickerDnaCount = Object.keys(this.tickerDnaProfiles).length;
        const tickerDnaMsg = tickerDnaCount > 0
            ? ` 종목DNA:${tickerDnaCount}개`
            : '';
        this.eventEmitter.emit('newMessage', 'system',
            `🔧 [LiveParams] 실전 적용 — TP:${s.tpAtrMultiplier} SL:${s.slAtrMultiplier} R:R:${s.minRiskReward} Short:${d.shortMultiplier} ADX:${f.adxGateMinimum} Lev:동적(SL→50%) 비중:${newConfig.sizing.baseSizePercent}% 스캔:${s.scanTopN ?? 10}개 포지션:${maxPos}개${regMsg}${dnaMsg}${posMsg}${tickerDnaMsg}`,
            'system_state');
    }

    public start(config: AiCoreConfig, session: TradeSession | null) {
        this.updateConfig(config);
        this.state.currentSession = session;
        this.isTradingEnabled = true;
        this.state.analysisStatus = 'running';
        this.startMonitoring();
        this.emitState(true);
        this.eventEmitter.emit('botStatusUpdate', 'running');
    }

    public stop() {
        this.isTradingEnabled = false;
        this.isMonitoring = false;
        this.state.analysisStatus = 'stopped';
        if (this.intervalId) clearTimeout(this.intervalId);
        this.intervalId = null;
        if (this._syncInterval) clearInterval(this._syncInterval);
        this._syncInterval = null;
        this.emitState(true);
        this.eventEmitter.emit('botStatusUpdate', 'stopped');
    }

    public toggleVolatilityFilter() {
        this.state.isFilterActive = !this.state.isFilterActive;
        this.emitState(true);
    }

    public toggleLeverageOverride() {
        this.state.isLeverageOverrideActive = !this.state.isLeverageOverrideActive;
        this.emitState(true);
    }

    public setAllInPercentage(percent: number) {
        this.state.allInPercentage = percent;
        this.emitState(true);
    }

    public toggleReverseTrading() {
        this.state.isReverseTradingActive = !this.state.isReverseTradingActive;
        this.emitState(true);
    }

    public toggleBerserkerMode() {
        this.state.isBerserkerMode = !this.state.isBerserkerMode;
        if (this.state.isBerserkerMode) {
            this.eventEmitter.emit('newMessage', 'system',
                '🔥 [BERSERKER MODE] 활성화', 'system_state');
        }
        this.emitState(true);
    }

    public toggleAutoBerserker() {
        this.state.isAutoBerserker = !this.state.isAutoBerserker;
        if (this.state.isAutoBerserker) {
            this.state.isBerserkerMode = true;
        }
        this.emitState(true);
    }

    public setTpClosePercentage(val: number) {
        this.state.tpClosePercentage = val;
        this.emitState(true);
    }

    public refreshState() { this.emitState(true); }

    /**
     * 수동 종목 분석 → 대기 후보 등록
     */
    public async analyzeForWatchlist(
        ticker: string,
        reason: string,
        direction: 'Long' | 'Short',
        strategy: 'TREND' | 'REVERSION',
    ) {
        try {
            const klines = await bybitService.fetchSingleTimeframeKlines(ticker, '15m', 50);
            if (klines.length < 20) {
                this.eventEmitter.emit('newMessage', 'system', `[${ticker}] 데이터 부족`, 'error');
                return;
            }

            const regimeResult = await this.scanner.classifyRegime(ticker, klines);

            const zoneResult = await this.zoneEngine.createZones({
                ticker, direction, strategy, klines,
                regime: regimeResult.regime,
                config: this.tradingConfig,
            });

            if (zoneResult.zones.length === 0) {
                this.eventEmitter.emit('newMessage', 'system',
                    `[${ticker}] 유효한 존 없음`, 'system_state');
                return;
            }

            const candidate = this.zoneEngine.buildCandidate({
                ticker, direction, zoneResult,
            });

            // 기존 후보 교체
            this.state.waitingCandidates = this.state.waitingCandidates.filter(c => c.ticker !== ticker);
            this.state.waitingCandidates.push(candidate);

            this.eventEmitter.emit('newMessage', 'system',
                `✅ [Watchlist] ${ticker} ${direction} | ${zoneResult.zones.length}개 존 등록\n` +
                `  레짐: ${regimeResult.regime} (${regimeResult.confidence}%)\n` +
                `  ${zoneResult.zones.map(z => `${z.type}: ${z.minPrice.toFixed(4)}~${z.maxPrice.toFixed(4)}`).join('\n  ')}`,
                'system_state'
            );

            this.emitState(true);
        } catch (e) {
            console.error(`[analyzeForWatchlist] ${ticker} error:`, e);
        }
    }

    // ── 메인 루프 ──

    public async startMonitoring() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        console.log('[TradingEngine] Monitoring started.');

        // Boot diagnostics
        this.bootDiagnostics();

        // ★ v53.5 FIX: 섀도우 시그널 항상 로드 (실전에서도 섀도우 기록+모니터링)
        this.loadShadowSignals();

        // 포지션 동기화 (1.5초 독립) — 섀도우에서는 바이빗 동기화 불필요
        this._syncInterval = setInterval(async () => {
            if (!this.isMonitoring) return;

            // ★ v53.5 FIX: 섀도우 모니터링은 항상 실행 (syncInterval 분리)
            // 기존 버그: _shadowEnabled=true → return → monitorShadow 미실행
            //           _shadowEnabled=false → monitorShadow 내부 return
            if (this.shadowSignals.length > 0) {
                await this.monitorShadowPositions();
            }

            if (this._shadowEnabled) return; // 섀도우 모드에선 바이빗 동기화 스킵
            try {
                const syncResult = await this.positionManager.syncPositions(
                    this.state.openPositions,
                    this.state.latestPrices,
                );

                // 에쿼티/잔고 실시간 반영
                if (syncResult.totalEquity > 0) {
                    this.state.totalEquity = syncResult.totalEquity;
                }
                if (syncResult.availableBalance >= 0) {
                    this.state.availableBalance = syncResult.availableBalance;
                }

                // 세션 통계 업데이트
                if (this.state.sessionStats.initialEquity > 0 && syncResult.totalEquity > 0) {
                    this.state.sessionStats.currentEquity = syncResult.totalEquity;
                    this.state.sessionStats.sessionReturnPercent =
                        ((syncResult.totalEquity - this.state.sessionStats.initialEquity) / this.state.sessionStats.initialEquity) * 100;
                }

                // 미실현 PnL 합산
                const openPosArr = this.state.openPositions.filter(p => p.status === 'open');
                this.state.sessionStats.unrealizedPnl = openPosArr.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

                // ★ v34c: 고아 포지션 임포트 제거 — 진입 시 TP/SL 동시 설정하므로 불필요

                // ★ v55.4: 45분 타임아웃 (21,625건: H≤45 WR=88.2% EV=0.211 SL=11.1%, H≤60 WR=76.5%)
                const MAX_HOLD_MS = 45 * 60 * 1000; // 45분
                const now2h = Date.now();
                for (const pos of this.state.openPositions) {
                    if (pos.status !== 'open') continue;
                    const holdMs = now2h - (pos.openTimestamp || pos.localStartTime || now2h);
                    if (holdMs >= MAX_HOLD_MS) {
                        console.log(`[Timeout] ⏰ ${pos.ticker} ${pos.direction} — ${Math.round(holdMs / 60000)}분 보유 → 45분 타임아웃 청산`);
                        this.eventEmitter.emit('newMessage', 'system',
                            `⏰ [타임아웃] ${pos.ticker} ${pos.direction} — ${Math.round(holdMs / 60000)}분 보유 → 45분 강제 청산`,
                            'system_state');
                        await this.positionManager.closePosition(pos, 'timeout');
                    }
                }

                // 종료된 거래 처리
                for (const trade of syncResult.closedTrades) {
                    await this.onTradeClose(trade);
                }

                // ── 포지션 배열 정리 (고스트 방지 + 메모리 관리) ──
                // 1. 닫힌 포지션 제거
                // 2. 같은 티커의 중복 open 포지션 제거 (레이스컨디션 대응)
                const openSeen = new Set<string>();
                const beforeCount = this.state.openPositions.filter(p => p.status === 'open').length;
                this.state.openPositions = this.state.openPositions.filter(p => {
                    if (p.status !== 'open') return false; // 닫힌 건 즉시 제거
                    if (openSeen.has(p.ticker)) {
                        console.warn(`[SyncClean] 🧹 중복 제거: ${p.ticker} (duplicate open)`);
                        return false;
                    }
                    openSeen.add(p.ticker);
                    return true;
                });
                const afterCount = this.state.openPositions.length;
                if (beforeCount !== afterCount) {
                    console.log(`[SyncClean] 정리: ${beforeCount} → ${afterCount} open positions`);
                    this.eventEmitter.emit('newMessage', 'system',
                        `🧹 [SyncClean] 고스트 포지션 정리: ${beforeCount} → ${afterCount}`,
                        'system_state');
                }

                // Bybit vs 로컬 불일치 감지
                if (syncResult.livePositionCount !== afterCount && afterCount > 0) {
                    console.warn(
                        `[SyncReconcile] ⚠️ Bybit: ${syncResult.livePositionCount} vs Local: ${afterCount}`
                    );
                }

                // ★ v53.5: 섀도우 모니터링은 상단에서 _shadowEnabled 무관하게 항상 실행

                // 대시보드에 실시간 반영
                this.emitState();
            } catch (e) {
                console.error('[SyncPositions] Error:', e);
            }
        }, 1500);

        // 메인 루프 (200ms)
        const loop = async () => {
            if (!this.isMonitoring) return;
            try {
                const now = Date.now();

                // Health check (60초)
                if (now - this.lastHealthCheck > 60000) {
                    this.heartbeat();
                    this.lastHealthCheck = now;
                }

                // ★ v53.1: 섀도우 모드에서는 스캔/진입/포지션관리 전부 스킵
                if (!this._shadowEnabled) {
                    // 존 모니터링 → 트리거 → 실행
                    await this.monitorAndExecute();

                    // 포지션 관리
                    const activePositions = this.state.openPositions.filter(p => p.status === 'open');
                    for (const pos of activePositions) {
                        await this.positionManager.manageRisk(pos);
                    }

                    // ★ 15분마다: 대기 후보 존 갱신
                    if (now - this.lastZoneRefreshTime > ZONE_REFRESH_INTERVAL_MS) {
                        await this.refreshCandidateZones();
                        this.lastZoneRefreshTime = now;
                    }
                }

                // ★ v53.1: 섀도우 모드에서는 스캔 스킵 — WF 포워드테스트 수집에만 집중
                if (!this._shadowEnabled) {
                    // ★ 1분봉 마감 기준 스캔: 백테스트 동일 — 매 1m 봉 마감마다 체크
                    const scanInterval = 60_000; // 1분 (백테스트: 매 1m bar)
                    if (now - this.lastScanTime > scanInterval) {
                        const nowSeconds = new Date(now).getUTCSeconds();
                        const is1mClose = nowSeconds < 10;
                        if (is1mClose) {
                            await this.refreshWatchlist();
                            await this.scanSignals();
                            this.lastScanTime = now;
                            this.emitState();
                        }
                    }
                }
            } catch (e) {
                console.error('Monitoring loop error:', e);
            }

            this.intervalId = setTimeout(loop, 200);
        };
        loop();

        // MarketTune: 5건마다 자동 트리거 (onTradeClose에서 관리, 시작 직후 1회는 위에서 실행)
    }

    // ── 스캔 ──

    // v22: 변동성 기반 워치리스트 갱신 (30분마다)
    // 변동 상위 20개 + Ignition 상위 10개 = 총 30개
    private async refreshWatchlist() {
        const now = Date.now();
        if (now - this.lastWatchlistRefreshTime < 30 * 60 * 1000) return; // 30분 캐시
        this.lastWatchlistRefreshTime = now;

        try {
            const tickers = await bybitService.fetchMarketTickers();
            // USDT 선물 중 변동성 3%+ & 거래량 $2M+ 선별
            const valid = tickers
                .filter((t: any) =>
                    t.symbol.endsWith('USDT') &&
                    (t.volatility24h || 0) >= MIN_VOLATILITY_12H_PCT &&
                    t.volume >= 500_000
                )
                .sort((a: any, b: any) => (b.volatility24h || 0) - (a.volatility24h || 0))
                .map((t: any) => t.symbol);

            // ★ 변동 상위 20개
            const volatilityTop = valid.slice(0, 20);

            // ★ Ignition 상위 10개 (5분봉 급등/급락, 변동 top20에 없는 것만)
            let ignitionTop: string[] = [];
            try {
                const ignitionCandidates = valid.slice(0, 50); // 상위 50개에서 ignition 체크
                const ignitionMap = await this.calculateIgnitionScores(ignitionCandidates);
                const ignitionSorted = [...ignitionMap.entries()]
                    .filter(([sym]) => !volatilityTop.includes(sym))
                    .sort(([, a], [, b]) => b.score - a.score)
                    .slice(0, 10)
                    .filter(([, v]) => v.score >= 0.5)
                    .map(([sym]) => sym);
                ignitionTop = ignitionSorted;
            } catch (e) {
                console.warn('[Watchlist] ignition scan error:', e);
            }

            this.watchlist = [...volatilityTop, ...ignitionTop];
            const igMsg = ignitionTop.length > 0 ? ` + 🔥${ignitionTop.length}개 Ignition` : '';
            this.eventEmitter.emit('newMessage', 'system',
                `📋 [Watchlist] ${this.watchlist.length}개 (변동 상위20${igMsg}): ${this.watchlist.join(', ')}`,
                'system_state');
        } catch (e) {
            console.error('[Watchlist] refresh error:', e);
        }
    }

    // Ignition Score 계산 (5분봉 기반 급등/급락 감지)
    private async calculateIgnitionScores(symbols: string[]): Promise<Map<string, { score: number; direction: 'up' | 'down' }>> {
        const result = new Map<string, { score: number; direction: 'up' | 'down' }>();
        const BATCH = 10, KLINE_COUNT = 10;
        for (let i = 0; i < symbols.length; i += BATCH) {
            const batch = symbols.slice(i, i + BATCH);
            await Promise.all(batch.map(async (sym) => {
                try {
                    const klines = await bybitService.fetchSingleTimeframeKlines(sym, '5m', KLINE_COUNT);
                    if (klines.length < KLINE_COUNT) return;
                    const baseline = klines.slice(0, 7);
                    const recent = klines.slice(7);
                    const priceChange = ((recent[2].close - recent[0].open) / recent[0].open) * 100;
                    const baseAvgVol = baseline.reduce((s, k) => s + k.volume, 0) / baseline.length;
                    const recentAvgVol = recent.reduce((s, k) => s + k.volume, 0) / recent.length;
                    const volumeSpike = baseAvgVol > 0 ? recentAvgVol / baseAvgVol : 1;
                    result.set(sym, { score: Math.abs(priceChange) * volumeSpike, direction: priceChange >= 0 ? 'up' : 'down' });
                } catch {}
            }));
            if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 500));
        }
        return result;
    }

    /** ★ 레짐별 파라미터 조회 — regimeEntries 우선, 없으면 폴백 */
    private resolveTickerConfig(ticker: string, regime: SimpleRegime, entryType?: EntryType, session?: Session, dayType?: DayType): {
        config: TradingConfig;
        tickerEntry?: TickerParamEntry;
        regimeEntry?: RegimeParamEntry;
    } {
        const tickerEntry = this.tickerParamRegistry[ticker];
        if (!tickerEntry) {
            return { config: { ...this.tradingConfig } };
        }

        // ★ v52.22: 필터+파라미터 모두 18-way 기준 (3≤n≤10, WR≥60%, EV>0)
        // 1순위: 18-way 정확 매칭 (regime + entryType + session + dayType)
        if (entryType && session && dayType && tickerEntry.timeSegmentEntries) {
            const tsKey = makeTimeSegmentKey(regime, entryType, session, dayType);
            const tsEntry = tickerEntry.timeSegmentEntries[tsKey];
            if (passesRuntimeFilter(tsEntry, this._shadowEnabled, session)) {
                const config = applyParamsToConfig(this.tradingConfig, tsEntry.params);
                config.directionBias = { ...config.directionBias, reverseMode: tsEntry.mode === 'reverse' };
                return { config, tickerEntry, regimeEntry: tsEntry };
            }
        }

        // 2순위: 같은 regime+session, 다른 dayType (폴백)
        if (entryType && session && tickerEntry.timeSegmentEntries) {
            for (const dt of ALL_DAYTYPES) {
                const tsKey = makeTimeSegmentKey(regime, entryType, session, dt);
                const tsEntry = tickerEntry.timeSegmentEntries[tsKey];
                if (passesRuntimeFilter(tsEntry, this._shadowEnabled, session)) {
                    const config = applyParamsToConfig(this.tradingConfig, tsEntry.params);
                    config.directionBias = { ...config.directionBias, reverseMode: tsEntry.mode === 'reverse' };
                    return { config, tickerEntry, regimeEntry: tsEntry };
                }
            }
        }

        // ★ v52.22: 6-way/종목전체 폴백 제거 — 18-way 필터 통과한 것만 진입
        return { config: { ...this.tradingConfig } };
    }

    // v17: 워치리스트 15개 딥스캔 (5분 간격, 1h+4h klines)
    private async scanSignals() {

        // ★ v49.3: 스캔은 항상 실행 — 증거금 체크는 executePendingEntries에서만
        // v17: 워치리스트 기반 (330+종목 대신 15개)
        let targets = [...this.watchlist];

        // focusList도 추가 (사용자 수동 설정)
        if (this.config?.focusList) {
            targets.push(...this.config.focusList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
        }

        // ★ qualified registry 종목을 스캔 대상에 항상 포함 (참고용 제외)
        const registryTickers = Object.entries(this.tickerParamRegistry)
            .filter(([, entry]) => entry.qualified !== false)
            .map(([ticker]) => ticker);
        if (registryTickers.length > 0) {
            targets.push(...registryTickers);
        }

        targets = [...new Set(targets)];
        if (targets.length === 0) return;

        // Phase 1: 워치리스트 WebSocket publicTrade 구독 (CVD 데이터 수집)
        const ws = getWsInstance(this.eventEmitter);
        for (const ticker of targets) {
            ws.subscribeTrades(ticker);
        }

        // 사전 필터: 이미 대기/쿨다운 중인 종목 제외 (오픈 포지션은 허용 → 반대 신호 감지용)
        const now = Date.now();
        const preFiltered = targets.filter(ticker => {
            if (this.state.waitingCandidates.some(c => c.ticker === ticker)) return false;
            // ★ SL 쿨다운 제거
            return true;
        });

        // ★ 백테스트 결과 나오기 전까지 진입 금지
        // 레지스트리가 비어있으면 옵티마이저가 아직 안 돌았거나 결과 없음 → 스캔 차단
        const qualifiedKeys = Object.entries(this.tickerParamRegistry)
            .filter(([, entry]) => entry.qualified !== false)
            .map(([ticker]) => ticker);
        if (qualifiedKeys.length === 0) {
            return;  // 검증된 종목 없음 → 진입 금지
        }
        // ★ v34e: 수익률 > 승률 > 레버리지 순 스캔
        const filteredTargets = preFiltered
            .filter(ticker => qualifiedKeys.includes(ticker))
            .sort((a, b) => {
                const pnlA = this.tickerParamRegistry[a]?.pnl ?? 0;
                const pnlB = this.tickerParamRegistry[b]?.pnl ?? 0;
                if (pnlA !== pnlB) return pnlB - pnlA;  // 수익률 우선
                const wrA = this.tickerParamRegistry[a]?.winRate ?? 0;
                const wrB = this.tickerParamRegistry[b]?.winRate ?? 0;
                if (wrA !== wrB) return wrB - wrA;
                const levA = this.tickerParamRegistry[a]?.params?.leverageTrending ?? 0;
                const levB = this.tickerParamRegistry[b]?.params?.leverageTrending ?? 0;
                return levB - levA;
            });

        if (preFiltered.length !== filteredTargets.length) {
            const blocked = preFiltered.length - filteredTargets.length;
            if (blocked > 0) {
                this.eventEmitter.emit('newMessage', 'system',
                    `🎯 [종목레지스트리] ${preFiltered.length}종목 중 ${filteredTargets.length}개만 허용 (${blocked}개 차단, 참고용 제외)`,
                    'system_state');
            }
        }

        // ── ★ v38: 세션 필터 스캔 — 현재 세션+요일에 적격인 종목만 스캔 ──
        const { session: nowSession, dayType: nowDayType } = getSessionAndDayType(Date.now());
        const sessionFilteredTargets = filteredTargets.filter(ticker => {
            const entry = this.tickerParamRegistry[ticker];
            // ★ Rush 세션 종목: 해당 세션으로 최적화되었으면 항상 통과
            if ((entry as any)?.optimizedSession === nowSession) return true;
            if (!entry?.allowedTimeSegmentKeys?.length) return false;
            return entry.allowedTimeSegmentKeys.some(key => {
                const parsed = parseTimeSegmentKey(key);
                return parsed.session === nowSession && parsed.dayType === nowDayType;
            });
        });
        if (sessionFilteredTargets.length !== filteredTargets.length) {
            const sessionBlocked = filteredTargets.length - sessionFilteredTargets.length;
            this.eventEmitter.emit('newMessage', 'system',
                `🕐 [세션필터] ${nowSession}/${nowDayType}: ${filteredTargets.length}종목 중 ${sessionFilteredTargets.length}개 통과 (${sessionBlocked}개 세션 미적격)`,
                'system_state');
        }

        // ── ★ v35d: 파이프라인 스캔 (lightScan 통과 즉시 fullScan 시작) ──
        type LightResult = { ticker: string; klines: KlineData[]; side: 'Long' | 'Short'; score: number; ignitionFast?: boolean; ignitionScore?: number; ignitionVolSpike?: number; volatilityAccel?: number; volumeRatio?: number };
        const globalAdxGateMin = this.tradingConfig.filters?.adxGateMinimum ?? 20;
        const scanResults: ScanStatus[] = [];

        // ★ v35d: pending 초기화 + 뉴스 병렬 시작
        this._pendingFullScanEntries = [];
        const newsPromise = this.refreshNewsCache();

        // ★ v35d: fullScan 큐 — lightScan 통과 즉시 fullScan에 투입
        const fullScanQueue: LightResult[] = [];
        let fullScanRunning = 0;
        const MAX_CONCURRENT_FULL = SCAN_BATCH_FULL;  // 동시 fullScan 최대 8개
        const fullScanDone: Promise<void>[] = [];

        const tryDrainFullScanQueue = () => {
            while (fullScanQueue.length > 0 && fullScanRunning < MAX_CONCURRENT_FULL) {
                const item = fullScanQueue.shift()!;
                fullScanRunning++;
                const p = this.fullScanTicker(item).catch(() => {}).finally(() => { fullScanRunning--; tryDrainFullScanQueue(); });
                fullScanDone.push(p);
            }
        };

        // ── 1+2단계 파이프라인: lightScan 배치 → 통과 즉시 fullScan 큐 투입 ──
        // ★ v38: sessionFilteredTargets 사용 (현재 세션+요일 적격 종목만)
        for (let i = 0; i < sessionFilteredTargets.length; i += SCAN_BATCH_LIGHT) {
            const batch = sessionFilteredTargets.slice(i, i + SCAN_BATCH_LIGHT);
            const results = await Promise.allSettled(
                batch.map(async (ticker): Promise<LightResult | null> => {
                    try {
                        const filterSteps: ScanFilterStep[] = [];
                        let blocked = false;

                        const rawKlines = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', 102);
                        const klines = rawKlines.length > 1 ? rawKlines.slice(0, -1) : rawKlines;
                        if (klines.length < 52) {
                            scanResults.push({ ticker, status: 'blocked', gate: 'data', detail: `klines ${klines.length} < 52`, timestamp: Date.now(), filterSteps: [] });
                            return null;
                        }
                        const price = klines[klines.length - 1].close;

                        // ── Gate 1: Direction ──
                        const dir = this.scanner.detectDirection(klines, price);
                        const dirScore = dir.score ?? 0;
                        const dirPassed = !!(dir.side && dirScore >= 50);
                        filterSteps.push({ gate: 'direction', label: '방향감지', passed: dirPassed, value: dirScore, threshold: 50, detail: dir.side || '미감지' });
                        if (!dirPassed) blocked = true;

                        // ── Gate 2: Dir Multiplier ──
                        const tickerReg = this.tickerParamRegistry[ticker];
                        const direction: 'Long' | 'Short' = (!dir.side || blocked)
                            ? 'Long'
                            : (this.tradingConfig.directionBias?.reverseMode ? (dir.side === 'Long' ? 'Short' : 'Long') : dir.side);
                        const dirMultiplier = direction === 'Long' ? 1.0 : (tickerReg?.params?.shortMultiplier ?? 0.0);
                        const dirMultValue = dirScore * dirMultiplier;
                        const dirMultPassed = dirMultValue >= 25;
                        filterSteps.push({ gate: 'dir_multiplier', label: 'Short배율', passed: dirMultPassed, value: dirMultValue, threshold: 25, detail: `${direction} mult=${dirMultiplier.toFixed(2)}` });
                        if (!dirMultPassed) blocked = true;

                        // ── Gate 4: ADX ──
                        const adxArr = calculateADX(klines, 14);
                        const adx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
                        const adxPassed = !(adx > 0 && adx < globalAdxGateMin);
                        filterSteps.push({ gate: 'adx', label: 'ADX', passed: adxPassed, value: adx, threshold: globalAdxGateMin, detail: adx === 0 ? 'N/A' : undefined });
                        if (!adxPassed) blocked = true;

                        // ── Gate 5: Ignition 4-Gate ──
                        let ignitionFast = false;
                        let igScore = 0;
                        let igVolSpike = 0;
                        let bodyRatio = 0;
                        let consecutive = 0;
                        const IGNITION_BASELINE = 7;
                        const IGNITION_RECENT = 3;
                        // ★ v36: 종목별 최적화된 이그니션 파라미터 사용 (백테스트 동기화)
                        const igThreshold = tickerReg?.params?.ignitionScoreThreshold ?? 0.7;
                        const igVolMin = tickerReg?.params?.ignitionVolMin ?? 2.0;
                        const igBodyMin = tickerReg?.params?.ignitionBodyMin ?? 0.5;
                        const igConsecMin = tickerReg?.params?.ignitionConsecMin ?? 2;
                        if (klines.length >= IGNITION_BASELINE + IGNITION_RECENT + 1) {
                            const baseStart = klines.length - 1 - IGNITION_BASELINE - IGNITION_RECENT;
                            let baselineVolSum = 0;
                            for (let b = baseStart; b < baseStart + IGNITION_BASELINE; b++) baselineVolSum += klines[b].volume;
                            let recentVolSum = 0;
                            for (let b = klines.length - 1 - IGNITION_RECENT; b < klines.length; b++) recentVolSum += klines[b].volume;
                            const baselineAvgVol = baselineVolSum / IGNITION_BASELINE;
                            const recentAvgVol = recentVolSum / IGNITION_RECENT;
                            igVolSpike = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : 0;
                            const prevClose = klines[klines.length - 1 - IGNITION_RECENT].close;
                            const curClose = klines[klines.length - 1].close;
                            const priceChangePct = prevClose > 0 ? Math.abs((curClose - prevClose) / prevClose) * 100 : 0;
                            igScore = priceChangePct * igVolSpike;

                            let bodyRatioSum = 0;
                            for (let b = klines.length - 1 - IGNITION_RECENT; b < klines.length; b++) {
                                const k = klines[b];
                                const range = k.high - k.low;
                                bodyRatioSum += range > 0 ? Math.abs(k.close - k.open) / range : 0;
                            }
                            bodyRatio = bodyRatioSum / IGNITION_RECENT;

                            const lastK = klines[klines.length - 1];
                            const lastDir = lastK.close >= lastK.open ? 1 : -1;
                            for (let b = klines.length - 1; b > klines.length - 2 - IGNITION_RECENT && b >= 0; b--) {
                                const k = klines[b];
                                const d = k.close >= k.open ? 1 : -1;
                                if (d === lastDir) consecutive++;
                                else break;
                            }

                            if (igScore >= igThreshold && igVolSpike >= igVolMin && bodyRatio >= igBodyMin && consecutive >= igConsecMin) {
                                ignitionFast = true;
                            }
                        }
                        filterSteps.push({ gate: 'ignition', label: 'Ignition', passed: ignitionFast, value: igScore, threshold: igThreshold, detail: `vol=${igVolSpike.toFixed(2)} body=${bodyRatio.toFixed(2)} consec=${consecutive}` });

                        // ── RSI 사전 계산 (Gate 6에서 사용) ──
                        const closes = klines.map(k => k.close);
                        const rsiArr = calculateRSI(closes, 14);
                        const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;

                        // ★ Ignition 통과해야 함
                        if (!ignitionFast) blocked = true;

                        // ── Gate 6: RSI Extreme (rsi는 위에서 사전 계산 완료) ──
                        const rsiThreshold = direction === 'Long' ? 85 : 25;
                        const rsiPassed = direction === 'Long' ? rsi <= 85 : rsi >= 25;
                        filterSteps.push({ gate: 'rsi_extreme', label: 'RSI극단', passed: rsiPassed, value: rsi, threshold: rsiThreshold, detail: `${direction} RSI=${rsi.toFixed(1)}` });
                        if (!rsiPassed) blocked = true;

                        // ── Gate 6b: RSI 45-70 밴드 (v53.7) ──
                        // v53.5: 35-70 → v53.7: 45-70 (35-45 구간 EV +0.21로 약함)
                        const rsiBandPassed = rsi >= 45 && rsi <= 70;
                        filterSteps.push({ gate: 'rsi_band', label: 'RSI밴드', passed: rsiBandPassed, value: rsi, threshold: 45, detail: `RSI=${rsi.toFixed(1)} (45-70)` });
                        if (!rsiBandPassed) blocked = true;

                        if (blocked) {
                            const firstFail = filterSteps.find(s => !s.passed && !s.skipped);
                            scanResults.push({ ticker, status: 'blocked', gate: firstFail?.gate || 'unknown', detail: firstFail?.detail || '차단', timestamp: Date.now(), filterSteps });
                            return null;
                        }

                        scanResults.push({ ticker, status: 'passed', detail: `${dir.side} score=${dir.score}${ignitionFast ? ' 🔥Ignition' : ''}`, timestamp: Date.now(), filterSteps });
                        return { ticker, klines, side: dir.side!, score: dir.score, ignitionFast, ignitionScore: igScore, ignitionVolSpike: igVolSpike, volatilityAccel: dir.volatilityAccel, volumeRatio: dir.volumeRatio };
                    } catch { return null; }
                })
            );

            // ★ v35d: lightScan 통과 결과를 즉시 fullScan 큐에 투입
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                    fullScanQueue.push(r.value);
                }
            }
            tryDrainFullScanQueue();  // 즉시 fullScan 시작

            // ★ v35f: 배치 간 100ms (배치 확대에 맞춰 딜레이 축소)
            if (i + SCAN_BATCH_LIGHT < sessionFilteredTargets.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        this.scanStatuses = scanResults;
        const totalLightPassed = fullScanQueue.length + fullScanRunning + fullScanDone.length;

        if (totalLightPassed > 0 || fullScanDone.length > 0) {
            this.eventEmitter.emit('newMessage', 'system',
                `🔍 [파이프라인] ${sessionFilteredTargets.length}종목 스캔 → ${fullScanDone.length + fullScanRunning + fullScanQueue.length}개 풀스캔 진행중`,
                'system_state'
            );
        }

        // ★ v35d: 남은 fullScan 큐 완전 소진 대기
        tryDrainFullScanQueue();
        await Promise.allSettled(fullScanDone);

        // ★ v52.6: 뉴스는 스캔 시작 시 병렬로 시작, 각 fullScan에서 캐시 사용
        // executePendingEntries 제거 — 각 fullScan 통과 즉시 진입
        await newsPromise;
    }

    /** ★ v35: 뉴스 캐시 갱신 (2시간마다 또는 강제) */
    private async refreshNewsCache(force = false): Promise<NewsImpactResult> {
        const now = Date.now();
        if (!force && this._newsCache && (now - this._newsCacheTimestamp) < this.NEWS_CACHE_TTL) {
            return this._newsCache;
        }

        try {
            const openTickers = this.state.openPositions
                .filter(p => p.status === 'open')
                .map(p => p.ticker.replace('USDT', ''))
                .join(', ');
            const context = `Active positions: ${openTickers || 'none'}. Watching ${Object.keys(this.tickerParamRegistry).length} tickers.`;

            this.eventEmitter.emit('newMessage', 'system',
                `📰 [NewsGuard] 실시간 뉴스 스캔 중...`, 'system_state');

            const result = await assessNewsImpact(context);
            this._newsCache = result;
            this._newsCacheTimestamp = now;

            if (result.impact !== 'NONE') {
                const emoji = result.impact === 'CRISIS' ? '🚨' :
                    result.impact === 'FUD_OVERREACTION' ? '💡' :
                    result.impact === 'MACRO_EVENT' ? '📊' : '🚀';
                this.eventEmitter.emit('newMessage', 'system',
                    `${emoji} [NewsGuard] ${result.impact} (신뢰도${result.confidence}%) — ${result.reasoning} → ${result.suggestedAction}`,
                    'system_state');
            } else {
                this.eventEmitter.emit('newMessage', 'system',
                    `📰 [NewsGuard] 시장 정상 — 특이 뉴스 없음`, 'system_state');
            }

            return result;
        } catch (e) {
            console.error('[NewsGuard] error:', e);
            return { impact: 'NONE', confidence: 0, affectedTickers: [],
                dumpDirection: 'NEUTRAL', severity: 0, reasoning: 'Error',
                suggestedAction: 'PROCEED' } as NewsImpactResult;
        }
    }

    /** ★ v34+v35: 풀스캔 통과 후보를 수익률 기준 정렬 + 뉴스 게이트 적용 후 진입 */
    private async executePendingEntries(): Promise<void> {
        if (this._pendingFullScanEntries.length === 0) return;

        // ★ v35: 진입 전 뉴스 체크 (캐시 2시간)
        const news = await this.refreshNewsCache();

        // ★ v34e: 수익률 > 승률 > 레버리지 순 정렬 (PnL 우선)
        this._pendingFullScanEntries.sort((a, b) => {
            if (a.registryPnL !== b.registryPnL) return b.registryPnL - a.registryPnL;
            if (a.registryWinRate !== b.registryWinRate) return b.registryWinRate - a.registryWinRate;
            if (a.registryLeverage !== b.registryLeverage) return b.registryLeverage - a.registryLeverage;
            return b.tfConsensus - a.tfConsensus;
        });

        const sortedNames = this._pendingFullScanEntries.map(
            e => `${e.ticker}(PnL${e.registryPnL.toFixed(0)}%,WR${e.registryWinRate.toFixed(0)}%)`
        ).join(' > ');
        this.eventEmitter.emit('newMessage', 'system',
            `🏆 [진입우선순위] ${this._pendingFullScanEntries.length}개 후보 수익률순: ${sortedNames}`,
            'system_state'
        );

        for (const entry of this._pendingFullScanEntries) {
            const openCount = this.state.openPositions.filter(p => p.status === 'open').length;
            // ★ v52.49: 섀도우 모드에서는 증거금/중복 체크 스킵
            if (!this._shadowEnabled) {
                const usedMargin = this.state.openPositions
                    .filter(p => p.status === 'open')
                    .reduce((sum, p) => sum + (p.initialMargin || 0), 0);
                const availableMargin = this.state.totalEquity - usedMargin;
                const MIN_POSITION_MARGIN = 5;
                if (availableMargin < MIN_POSITION_MARGIN) {
                    if (entry.existingScan) {
                        entry.existingScan.status = 'blocked';
                        entry.existingScan.gate = 'margin_insufficient';
                        entry.existingScan.detail = `증거금 여유 $${availableMargin.toFixed(0)} < $${MIN_POSITION_MARGIN} (equity $${this.state.totalEquity.toFixed(0)})`;
                    }
                    continue;
                }

                const alreadyOpen = this.state.openPositions.find(
                    p => p.ticker === entry.ticker && p.status === 'open'
                );
                if (alreadyOpen) continue;
            }

            // ★ v35: 뉴스 게이트 — CRISIS 차단, FUD 역매매 부스트
            const tickerBase = entry.ticker.replace('USDT', '');
            const isAffected = news.affectedTickers.some(
                t => t.toUpperCase() === tickerBase.toUpperCase() || t === 'ALL' || t === 'CRYPTO'
            );

            if (news.impact === 'CRISIS' && news.confidence >= 70 && isAffected) {
                if (entry.existingScan) {
                    entry.existingScan.status = 'blocked';
                    entry.existingScan.gate = 'news_crisis';
                    entry.existingScan.detail = `🚨 위기: ${news.reasoning}`;
                }
                this.eventEmitter.emit('newMessage', 'system',
                    `🚨 [NewsGuard] ${entry.ticker} 진입 차단 — CRISIS: ${news.reasoning}`,
                    'system_state');
                continue;
            }

            // ★ v44: NewsGuard 실전 적용 — 사이즈/TP 실제 수정
            let newsBoost = '';
            let newsSizeMultiplier = 1.0;  // 포지션 사이즈 배수
            let newsTpMultiplier = 1.0;    // TP 배수

            if (news.impact === 'FUD_OVERREACTION' && news.confidence >= 80 && isAffected) {
                const isFading = (news.dumpDirection === 'LONG_DANGER' && entry.direction === 'Long')
                    || (news.dumpDirection === 'SHORT_DANGER' && entry.direction === 'Short');
                if (isFading) {
                    // 패닉 방향과 같으면 위험 → 차단
                    if (entry.existingScan) {
                        entry.existingScan.status = 'blocked';
                        entry.existingScan.gate = 'news_fud_same_dir';
                        entry.existingScan.detail = `💡 FUD 방향 동일 — 차단`;
                    }
                    continue;
                }
                // 패닉 반대 = 역매매 기회 → 사이즈 +50%
                newsSizeMultiplier = 1.5;
                newsBoost = ` | 💡FUD역매매(사이즈×1.5)`;
            }

            if (news.suggestedAction === 'REDUCE_SIZE' && isAffected) {
                // 리스크 감소 → 사이즈 50% 축소
                newsSizeMultiplier = 0.5;
                newsBoost = ` | ⚠️리스크감소(사이즈×0.5)`;
            }

            if ((news.impact === 'MACRO_EVENT' || news.suggestedAction === 'WIDEN_TP') && news.confidence >= 60) {
                newsTpMultiplier = calcDynamicTpMultiplier(news.confidence);
                newsBoost += ` | 📊매크로(TP×${newsTpMultiplier.toFixed(2)})`;
            }

            const expectedLoss = (100 - entry.registryWinRate);
            const ev = (entry.registryWinRate / 100 * entry.registryAvgWin) + ((100 - entry.registryWinRate) / 100 * entry.registryAvgLoss);
            this.eventEmitter.emit('newMessage', 'system',
                `🎯 [Scan→진입] ${entry.ticker} ${entry.direction}${newsBoost}\n` +
                `  📊 예상WR=${entry.registryWinRate.toFixed(0)}% | 예상PnL=${entry.registryPnL.toFixed(0)}% | 예상손실=${expectedLoss.toFixed(0)}%\n` +
                `  📈 평균익=${entry.registryAvgWin.toFixed(1)}% | 평균손=${entry.registryAvgLoss.toFixed(1)}% | EV=${ev.toFixed(1)}%\n` +
                `  🔬 표본=${entry.registryTrades}건 | MaxDD=${entry.registryMaxDD.toFixed(1)}% | 평균보유=${entry.registryAvgHoldMin.toFixed(0)}분`,
                'system_state'
            );

            // ★ v52.38: 섀도우 모드에서는 실전 진입 차단
            if (this._shadowEnabled) {
                console.log(`[Shadow] 🚫 ${entry.ticker} ${entry.direction} 실전 진입 차단 (섀도우 모드 — pending)`);
                continue;
            }

            try {
                const ev = (entry.registryWinRate / 100 * entry.registryAvgWin) + ((100 - entry.registryWinRate) / 100 * entry.registryAvgLoss);
                const trade = await this.execution.executeEntry({
                    ticker: entry.ticker,
                    direction: entry.direction,
                    config: entry.config,
                    atr: entry.atr,
                    currentPrice: entry.currentPrice,
                    equity: entry.equity,
                    availableBalance: entry.availableBalance,
                    regime: entry.regime,
                    regimeResult: entry.regimeResult,
                    zoneMinPrice: entry.zoneMinPrice,
                    zoneMaxPrice: entry.zoneMaxPrice,
                    zoneType: entry.zoneType,
                    reasoning: entry.reasoning,
                    selectedTimeframe: entry.selectedTimeframe,
                    maxPositions: this.maxPositions,
                    openPositionCount: openCount,
                    // ★ v44: NewsGuard 수정자 — 실제 사이즈/TP 변경
                    newsSizeMultiplier,
                    newsTpMultiplier,
                    // ★ v52.72: WF 파라미터 레버리지 (최대 레버리지 대신)
                    wfLeverage: entry.registryLeverage || undefined,
                    // ★ v55.4: 연승/연패 적응형 비중 + 시간대 배율
                    aggressiveSizePercent: (() => {
                        const base = this._globalConsecWins >= 2 ? 35 : this._globalConsecLosses >= 2 ? 10 : 20;
                        const utcH = new Date().getUTCHours();
                        const safe = new Set([0,1,5,7,10,11,14,18]);
                        const danger = new Set([3,4,15,16,22,23]);
                        const mult = safe.has(utcH) ? 2.0 : danger.has(utcH) ? 0.5 : 1.0;
                        return Math.round(base * mult);
                    })(),
                    // ★ v36: 레지스트리 통계 → Trade 객체에 저장 → 대시보드 표시
                    registryStats: {
                        winRate: entry.registryWinRate,
                        pnl: entry.registryPnL,
                        trades: entry.registryTrades,
                        avgWin: entry.registryAvgWin,
                        avgLoss: entry.registryAvgLoss,
                        ev,
                        maxDD: entry.registryMaxDD,
                        avgHoldMin: entry.registryAvgHoldMin,
                    },
                });

                if (trade) {
                    // ★ 18-way: 진입 세그먼트 정보 태깅
                    const { session: entrySess, dayType: entryDT } = getSessionAndDayType(Date.now());
                    trade.entrySession = entrySess;
                    trade.entryDayType = entryDT;
                    const sr = entry.regime?.replace('CryptoMarketRegime.', '') as SimpleRegime;
                    const tradeEntryType: EntryType = (entry as any)._entryType || 'IGNITION';
                    if (sr) trade.entryTimeSegmentKey = makeTimeSegmentKey(sr, tradeEntryType, entrySess, entryDT);

                    const exists = this.state.openPositions.find(
                        p => p.ticker === trade.ticker && p.status === 'open'
                    );
                    if (exists) {
                        Object.assign(exists, trade);
                    } else {
                        this.state.openPositions.push(trade);
                    }
                    this.lastEntryTime = Date.now();

                    const lev = trade.leverage ?? 0;
                    const tpPct = trade.targetPrice && trade.entryPrice
                        ? (Math.abs(trade.targetPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(1)
                        : '?';
                    this.notifyTelegram(
                        `📈 <b>진입</b> ${trade.ticker}\n` +
                        `${trade.direction} ${lev.toFixed(0)}x @ $${trade.entryPrice.toFixed(4)}\n` +
                        `TP ${tpPct}% | SL $${trade.invalidationPrice?.toFixed(4) ?? 'N/A'}`
                    );

                    this.emitState(true);
                } else {
                    if (entry.existingScan) { entry.existingScan.status = 'blocked'; entry.existingScan.gate = 'execution'; entry.existingScan.detail = '진입실패(레버리지/잔고/수량)'; }
                    this.eventEmitter.emit('newMessage', 'system',
                        `⚠️ [Entry Failed] ${entry.ticker} 진입 실패 (레버리지/잔고/수량 문제)`,
                        'system_state'
                    );
                }
            } catch (e: any) {
                if (entry.existingScan) { entry.existingScan.status = 'blocked'; entry.existingScan.gate = 'execution_error'; entry.existingScan.detail = `예외: ${e?.message || e}`; }
                console.error(`[Execute] ${entry.ticker} error:`, e);
            }
        }

        this._pendingFullScanEntries = [];
    }

    // v31: 역방향 시그널 탈출 삭제 — 백테스트에 없음, TP/SL로만 청산

    /** ★ 15분마다 대기중 후보의 타점존 갱신 */
    private async refreshCandidateZones(): Promise<void> {
        const candidates = this.state.waitingCandidates.filter(
            c => !(c as any)._immediateEntry // 즉시진입 후보는 스킵 (현재 모든 후보가 즉시진입)
        );
        if (candidates.length === 0) return;

        this.eventEmitter.emit('newMessage', 'system',
            `🔄 [Zone Refresh] ${candidates.length}개 후보 타점존 갱신 중...`,
            'system_state'
        );

        for (const candidate of candidates) {
            try {
                const klines = await bybitService.fetchSingleTimeframeKlines(candidate.ticker, '1m', 200);
                if (klines.length < 52) continue;

                const regimeResult = await this.scanner.classifyRegime(candidate.ticker, klines);
                const strategy: 'TREND' | 'REVERSION' = regimeResult.regime === 'RANGING' ? 'REVERSION' : 'TREND';

                const { config: tickerConfig } = this.resolveTickerConfig(
                    candidate.ticker, regimeResult.simpleRegime
                );

                const zoneResult = await this.zoneEngine.createZones({
                    ticker: candidate.ticker,
                    direction: candidate.direction,
                    strategy,
                    klines,
                    regime: regimeResult.regime as any,
                    config: tickerConfig,
                });

                if (zoneResult.zones.length > 0) {
                    const oldZones = candidate.entryZones.map(z => `${z.type}(${z.minPrice.toFixed(2)}~${z.maxPrice.toFixed(2)})`).join(', ');
                    candidate.entryZones = zoneResult.zones.map(z => ({
                        type: z.type, minPrice: z.minPrice, maxPrice: z.maxPrice,
                    }));
                    const newZones = candidate.entryZones.map(z => `${z.type}(${z.minPrice.toFixed(2)}~${z.maxPrice.toFixed(2)})`).join(', ');
                    candidate.reasoning = `Zone refreshed: ${newZones}`;

                    this.eventEmitter.emit('newMessage', 'system',
                        `🔄 [Zone] ${candidate.ticker} ${candidate.direction} 존 갱신\n  이전: ${oldZones}\n  갱신: ${newZones}`,
                        'system_state'
                    );
                }

                await new Promise(r => setTimeout(r, 300)); // API 속도 제한
            } catch (e) {
                console.warn(`[Zone Refresh] ${candidate.ticker} error:`, e);
            }
        }
    }

    /** v17: 단일 종목 딥스캔 (1h primary + 4h confirmation) — Ignition + Trap 듀얼 전략 */
    private async fullScanTicker(light: { ticker: string; klines: KlineData[]; side: 'Long' | 'Short'; score: number; ignitionFast?: boolean; ignitionScore?: number; ignitionVolSpike?: number }): Promise<void> {
        const { ticker } = light;
        try {
            // ★ Per-ticker 기본 조회 (레짐 분류 전 — 방향 감지용)
            const tickerEntry = this.tickerParamRegistry[ticker];
            let tickerConfig = tickerEntry
                ? applyParamsToConfig(this.tradingConfig, tickerEntry.params)
                : { ...this.tradingConfig };
            // ★ baseSizePercent는 execution.ts calculateSize에서 레버리지 기반 자동 계산

            // ★ MTF: 1m klines에서 15m/1h 집계 (백테스트 동기화: aggregateCandles 사용)
            const klines1m = light.klines;
            if (klines1m.length < 20) return;
            const currentPrice = klines1m[klines1m.length - 1].close;

            // 1h 방향 감지에 52봉 필요 = 1m 3120개. 충분한 1m 데이터 fetch
            let klines1mFull: KlineData[] = klines1m;
            try {
                const raw1mFull = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', 3200);
                klines1mFull = raw1mFull.length > 1 ? raw1mFull.slice(0, -1) : raw1mFull;  // 불완전 봉 제거
            } catch (e) {
                console.warn(`[MTF] ${ticker} 1m full fetch error, using lightScan klines:`, e);
            }

            // ★ 백테스트 동기화: aggregateCandles로 15m/1h 생성 (API fetch 대신)
            const klines15m = aggregateCandles(klines1mFull, 15);
            const klines1h = aggregateCandles(klines1mFull, 60);

            // ★ 1m 방향 (경량스캔에서 이미 감지)
            const dir1m: 'Long' | 'Short' = light.side;

            // ★ 1h 방향 감지 (주 시그널 — 백테스트 MTF와 동일)
            let dir1h: 'Long' | 'Short' | null = null;
            let dir1hScore = 0;
            let dirResult1h: ReturnType<typeof this.scanner.detectDirection> | null = null;
            if (klines1h.length >= 52) {
                // ★ v46: 백테스트 동기화 — 최근 61봉만 사용 (백테스트: slice(-60, idx+1))
                const w1h = klines1h.slice(-61);
                dirResult1h = this.scanner.detectDirection(w1h, currentPrice);
                dir1h = dirResult1h.side;
                dir1hScore = dirResult1h.score;
            }

            // ★ 15m 방향 감지 (보조 확인)
            let dir15m: 'Long' | 'Short' | null = null;
            let dir15mScore = 0;
            if (klines15m.length >= 52) {
                // ★ v46: 백테스트 동기화 — 최근 61봉만 사용
                const w15m = klines15m.slice(-61);
                const dirResult15m = this.scanner.detectDirection(w15m, currentPrice);
                dir15m = dirResult15m.side;
                dir15mScore = dirResult15m.score;
            }

            // ★ 주 방향: 1h 우선, 없으면 1m 폴백 (백테스트 동일)
            const primaryDir = dir1h || dir1m;
            const primaryScore = dir1h ? dir1hScore : light.score;

            // ★ TF Consensus 계산 (동의하는 TF 수: 0~3)
            let tfConsensus = 0;
            if (dir1h === primaryDir) tfConsensus++;
            if (dir15m === primaryDir) tfConsensus++;
            if (dir1m === primaryDir) tfConsensus++;
            // 1h 데이터 없으면 1m 기준
            if (!dir1h) {
                tfConsensus = 1; // 1m 자신
                if (dir15m === dir1m) tfConsensus++;
            }

            // ★ fullScan filterSteps: lightScan의 filterSteps에 이어서 추가
            const existingScan = this.scanStatuses.find(s => s.ticker === ticker);
            const fullSteps: ScanFilterStep[] = existingScan?.filterSteps ? [...existingScan.filterSteps] : [];

            // ★ 백테스트 동기화: TF Consensus 게이트 — config.filters 기준 (레지스트리 종목별값 제거)
            const minTfConsensus = (this.tradingConfig.filters as any)?.minTfConsensus ?? 2;
            const tfConsPassed = tfConsensus >= minTfConsensus;
            fullSteps.push({ gate: 'tf_consensus', label: 'TF동의', passed: tfConsPassed, value: tfConsensus, threshold: minTfConsensus, detail: `1h=${dir1h||'N/A'} 15m=${dir15m||'N/A'} 1m=${dir1m}` });
            if (!tfConsPassed) {
                if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'tf_consensus'; existingScan.detail = `TF동의 ${tfConsensus}/${minTfConsensus}`; existingScan.filterSteps = fullSteps; }
                return;
            }

            // ★ 백테스트 동기화: Short gate 재확인/rsiSlope/EMA 정렬 제거 — 백테스트에 없음

            // 1m 방향 결과 (보조 필드용)
            const dirResult = this.scanner.detectDirection(klines1m, currentPrice);

            // ★ MTF 기반 klines 선택: 1h 충분하면 1h(최근 61봉), 아니면 1m 폴백
            const klines = klines1h.length >= 52 ? klines1h.slice(-61) : klines1m;
            const selectedTF = klines1h.length >= 52 ? '1h' : '1m';

            // ★ TF 정렬 = tfConsensus 기반 (MTF 통합)
            let tfAlignCount = tfConsensus;

            // 레짐 분류
            const regimeResult = await this.scanner.classifyRegime(ticker, klines);

            // ★ Ignition 시그널 확인
            const isIgnition = !!light.ignitionFast;
            const signalDetected = isIgnition;
            fullSteps.push({ gate: 'signal_required', label: '전략시그널', passed: signalDetected, value: light.ignitionScore ?? 0, threshold: 0, detail: isIgnition ? '🔥 Ignition' : '미감지' });
            if (!signalDetected) {
                if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'signal_required'; existingScan.detail = '시그널 미감지'; existingScan.filterSteps = fullSteps; }
                return;
            }

            // ★ 진입 전략 타입: IGNITION만 사용
            const detectedEntryType: EntryType = 'IGNITION';

            // ★ v52.84: 섀도우 TP/SL을 실전과 완전 동일하게 계산
            const _shadowAtrArr = calculateATR(klines1m, 14);
            const _shadowAtr = _shadowAtrArr.length > 0 ? _shadowAtrArr[_shadowAtrArr.length - 1] : currentPrice * 0.01;
            const _shadowParams = tickerEntry?.params;
            // ★ v55: 전세션 20x 고정 (레짐/세션 무관)
            const _shadowSimpleRegime = regimeResult?.simpleRegime ?? 'TRENDING';
            const _shadowLev = 20;
            // ★ v55: tpMult 6→7 (12,763건: WR 56.4% 최고 + EV 0.631 + SL 13.2%)
            const _shadowTpMult = (this.tradingConfig?.swing as any)?.tpAtrMultiplier ?? _shadowParams?.tpAtrMultiplier ?? 7;
            const _shadowAtrPct = _shadowAtr / currentPrice;
            // ★ v52.85: regimeTpMultiplier 제거 — ATR × tpAtrMultiplier만 사용 (수수료 0.0019)
            const _shadowTpPct = _shadowAtrPct * _shadowTpMult + 0.0019;
            // ★ v54: MLR 0.50→0.20 (실전과 동기화)
            const _shadowSlPct = 0.20 / _shadowLev;
            const _shadowTp = primaryDir === 'Long' ? currentPrice * (1 + _shadowTpPct) : currentPrice * (1 - _shadowTpPct);
            const _shadowSl = primaryDir === 'Long' ? currentPrice * (1 - _shadowSlPct) : currentPrice * (1 + _shadowSlPct);

            // ★ 레짐×진입타입별 파라미터 조회 — 36-way 시간 세분화 (폴백: 6-way)
            {
                const currentRegime = regimeResult.simpleRegime;
                const currentEntryType: EntryType = detectedEntryType;
                // ★ v36: 현재 시간 기준 세션/주말평일 판별
                const { session: currentSession, dayType: currentDayType } = getSessionAndDayType(Date.now());
                const resolved = this.resolveTickerConfig(ticker, currentRegime, currentEntryType, currentSession, currentDayType);

                let regimePassed = true;
                let regimeDetail = `${currentRegime}_${currentEntryType}`;

                // ★ v52.70: TE×Short는 regime 게이트 바이패스 (1200건 +331 흑자 확인)
                const isTeShortBypass = regimeResult?.regime === 'TREND_EXHAUSTION' && primaryDir === 'Short';

                if (resolved.regimeEntry) {
                    tickerConfig = resolved.config;
                    regimeDetail += ' ✓적격';
                } else if (isTeShortBypass) {
                    // TE×Short → regime 게이트 무시, 기본 config로 진입 허용
                    regimeDetail += ' TE×Short 바이패스';
                } else if (tickerEntry?.regimeEntries && Object.keys(tickerEntry.regimeEntries).length > 0) {
                    regimePassed = false;
                    regimeDetail += ' 미적격';
                    this.eventEmitter.emit('newMessage', 'system',
                        `🚫 [레짐필터] ${ticker} ${currentRegime}_${currentEntryType}: 해당 레짐+진입타입 미적격 → 스킵`,
                        'system_state'
                    );
                } else if (tickerEntry?.allowedRegimes && tickerEntry.allowedRegimes.length > 0) {
                    if (!tickerEntry.allowedRegimes.includes(currentRegime)) {
                        regimePassed = false;
                        regimeDetail = `${currentRegime} ∉ [${tickerEntry.allowedRegimes.join(',')}]`;
                    }
                }

                fullSteps.push({ gate: 'regime', label: '레짐', passed: regimePassed, value: regimeResult.confidence ?? 0, threshold: 0, detail: regimeDetail });
                if (!regimePassed) {
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'regime'; existingScan.detail = regimeDetail; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: primaryDir, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'regime', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, registryEV: undefined, registryQualified: false, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }

                // ★ v52.65: 세션별 최적 레짐×방향 차단 (섀도우 2,472건 분석 기반)
                const detailedRegime = regimeResult.regime;
                // ★ v52.99: 블록 제거 — EV>0 프리필터만 사용
                // 세션별 블록이 매일 바뀌어서 과적합 위험. 무블록+EV>0이 +52% 더 수익적
                // TC×S만 유니버설 차단 (전 세션 적자 확인됨)
                const SESSION_REGIME_BLOCKS: Record<string, Set<string>> = {
                    US: new Set(['TREND_CONTINUATION_Short']),
                    ASIA: new Set(['TREND_CONTINUATION_Short']),
                    EUROPE: new Set(['TREND_CONTINUATION_Short']),
                };
                const blockSet = SESSION_REGIME_BLOCKS[currentSession] ?? SESSION_REGIME_BLOCKS.US;
                const regimeDirKey = `${detailedRegime}_${primaryDir}`;
                const blocked = blockSet.has(regimeDirKey) ? [detailedRegime, primaryDir, 'session-specific'] : null;
                if (blocked) {
                    const blockDetail = `[${currentSession}] ${blocked[0]}×${blocked[1]} 차단`;
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'regime_dir'; existingScan.detail = blockDetail; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: primaryDir, price: currentPrice, regime: detailedRegime, atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'regime_dir', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
            }

            // ★ v52.74: 탑콤보 제거 — 전부 균등 10% (탑콤보가 매일 바뀌므로 과적합 위험)
            const isTopCombo = false;
            const _aggressiveSizeOverride = isTopCombo ? 40 : undefined;

            // ★ 모든 fullScan 필터 통과 — filterSteps 저장
            if (existingScan) { existingScan.filterSteps = fullSteps; }

            // ★ 백테스트 동기화: DNA 필터, fullScan ADX 재확인 제거 — 백테스트에 없음
            // ADX는 lightScan에서 이미 1회 체크 완료

            // 리버스 모드: 시그널 방향 반전 — per-ticker config 사용 (★ 1h 우선 방향 기준)
            const finalDirection: 'Long' | 'Short' = tickerConfig.directionBias?.reverseMode
                ? (primaryDir === 'Long' ? 'Short' : 'Long')
                : primaryDir;

            // ★ 타점존 생성 — zoneEngine으로 실제 존 계산
            const strategy: 'TREND' | 'REVERSION' = regimeResult.regime === 'RANGING' ? 'REVERSION' : 'TREND';
            let entryZones: { type: string; minPrice: number; maxPrice: number }[] = [];
            let zoneMarketPhase = regimeResult.regime;
            try {
                const zoneResult = await this.zoneEngine.createZones({
                    ticker, direction: finalDirection, strategy, klines,
                    regime: regimeResult.regime as any,
                    config: tickerConfig,
                });
                if (zoneResult.zones.length > 0) {
                    entryZones = zoneResult.zones.map(z => ({
                        type: z.type, minPrice: z.minPrice, maxPrice: z.maxPrice,
                    }));
                }
                if (zoneResult.marketPhase) {
                    zoneMarketPhase = zoneResult.marketPhase;
                }
            } catch (e) {
                console.warn(`[Zone] ${ticker} createZones error:`, e);
            }

            // ★ Ignition Fast Entry: 시그널 감지 시 존 결과와 무관하게 즉시 진입
            const isIgnitionFast = !!light.ignitionFast;

            // 존이 0개면 현재가 기반 즉시 진입 (폴백)
            const isImmediate = entryZones.length === 0 || isIgnitionFast;
            if (isImmediate) {
                const zoneType = isIgnitionFast ? 'IGNITION_FAST' : 'IMMEDIATE';
                entryZones = [{ type: zoneType, minPrice: currentPrice, maxPrice: currentPrice }];
            }

            const ignitionMsg = isIgnitionFast
                ? `🔥 Ignition Fast: score=${(light.ignitionScore || 0).toFixed(2)}, vol=${(light.ignitionVolSpike || 0).toFixed(1)}x`
                : '';
            const tfLabel = `TF${tfConsensus}(1h=${dir1h||'-'}/15m=${dir15m||'-'}/1m=${dir1m})`;
            const candidate: WaitingCandidate = {
                ticker,
                direction: finalDirection,
                entryZones,
                marketPhase: zoneMarketPhase,
                reasoning: isIgnitionFast
                    ? `${ignitionMsg} | ${primaryDir} score=${primaryScore} ${tfLabel}`
                    : isImmediate
                        ? `Immediate: ${primaryDir} score=${primaryScore} ${tfLabel}`
                        : `Zone: ${entryZones.map(z => `${z.type}(${z.minPrice.toFixed(2)}~${z.maxPrice.toFixed(2)})`).join(', ')} ${tfLabel}`,
                timestamp: Date.now(),
                expectedReward: 0,
                hitCount: 0,
                isPendingReanalysis: false,
            };

            // ★ 모든 후보 즉시진입 — 스캔 통과 = 바로 시장가 진입 (존 대기 제거)
            // 존 정보는 참고용으로 보존, 실제 진입은 시장가
            (candidate as any)._immediateEntry = true;
            (candidate as any)._simpleRegime = regimeResult.simpleRegime;  // 스캔 시 레짐 저장
            (candidate as any)._isIgnition = isIgnitionFast;  // ★ Ignition 여부 (우선순위용)
            (candidate as any)._tfConsensus = tfConsensus;  // ★ MTF 동의도

            // ★ 6-way regime×entryType별 승률/레버리지 (글로벌 폴백)
            const candEntryType: import('../types').EntryType = detectedEntryType;
            const candRegimeKey = makeRegimeEntryKey(regimeResult.simpleRegime, candEntryType);
            const candRegimeEntry = tickerEntry?.regimeEntries?.[candRegimeKey];
            const levField = regimeResult.simpleRegime === 'TRENDING' ? 'leverageTrending'
                : regimeResult.simpleRegime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';
            (candidate as any)._registryWinRate = candRegimeEntry?.winRate ?? tickerEntry?.winRate ?? 0;
            (candidate as any)._registryPnl = candRegimeEntry?.pnl ?? tickerEntry?.pnl ?? 0;
            (candidate as any)._registryLeverage = candRegimeEntry?.params?.[levField] ?? tickerEntry?.params?.[levField] ?? 0;
            // ★ v52.13: 세분화된 regimeEntry stats 보존 → UI 표시용
            (candidate as any)._candRegimeEntry = candRegimeEntry;

            if (dirResult.volatilityAccel) {
                (candidate as any)._volatilityAccel = dirResult.volatilityAccel;
            }
            (candidate as any)._selectedTimeframe = selectedTF;
            (candidate as any)._tfQuality = tfAlignCount;

            // ── v22: 센티먼트 하드블록 제거 — 데이터만 수집 (참고용, 차단 없음) ──
            try {
                const closes1h = klines.map(k => k.close);
                const priceChange1h = closes1h.length >= 2
                    ? ((closes1h[closes1h.length - 1] - closes1h[closes1h.length - 2]) / closes1h[closes1h.length - 2]) * 100
                    : 0;

                const sentimentData = await this.sentimentService.fetchSentimentData(
                    ticker, currentPrice, priceChange1h
                );
                const sentimentScore = this.sentimentService.calculateSentimentScore(
                    sentimentData, primaryDir, tickerConfig
                );

                // 데이터만 부착 (차단 없음)
                (candidate as any)._sentimentData = sentimentData;
                (candidate as any)._sentimentScore = sentimentScore;
            } catch (e) {
                console.warn(`[Sentiment] ${ticker} fetch error:`, e);
            }

            // ── Phase 2: VWAP 계산 (기존 1h klines 사용, 0 API) ──
            try {
                const vwapResult = calculateVWAP(klines, 24);
                if (vwapResult) {
                    const dev = ((currentPrice - vwapResult.vwap) / vwapResult.vwap) * 100;
                    const vwapStdDev = tickerConfig.filters.vwapOverextendedStdDev ?? 2.0;
                    (candidate as any)._vwapData = {
                        ...vwapResult,
                        pricePosition: currentPrice > vwapResult.vwap ? 'ABOVE'
                            : currentPrice < vwapResult.vwap ? 'BELOW' : 'AT_VWAP',
                        deviationPercent: dev,
                        isOverextended: Math.abs(currentPrice - vwapResult.vwap) > vwapStdDev * vwapResult.stdDev,
                    };
                }
            } catch {}

            // Phase 2: SMC context — 즉시진입 모드에서는 zone 미생성이므로 생략

            // ── Phase 3: WaveTrend + Ichimoku (기존 1h klines, 0 API) ──
            try { const wt = calculateWaveTrend(klines); if (wt) (candidate as any)._waveTrendData = wt; } catch {}
            try { const ichi = calculateIchimoku(klines); if (ichi) (candidate as any)._ichimokuData = ichi; } catch {}

            // ★ v36: WaveTrend 게이트 (백테스트 동기화)
            if (tickerConfig.filters?.useWaveTrend) {
                const wt = (candidate as any)._waveTrendData;
                if (wt) {
                    if (finalDirection === 'Long' && !(wt.wt1 > wt.wt2 || wt.wt1 < -53)) {
                        if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'wt_bearish'; existingScan.detail = `WT1=${wt.wt1.toFixed(1)}<WT2=${wt.wt2.toFixed(1)}`; }
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'wt_bearish', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                    if (finalDirection === 'Short' && !(wt.wt1 < wt.wt2 || wt.wt1 > 53)) {
                        if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'wt_bullish'; existingScan.detail = `WT1=${wt.wt1.toFixed(1)}>WT2=${wt.wt2.toFixed(1)}`; }
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'wt_bullish', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                }
            }

            // ★ v52.60: Ichimoku 게이트 제거 — 섀도우 데이터에서 ichi_below가 +583 PnL%(lev) 흑자 확인
            // 차단하면 오히려 수익 기회를 놓침

            // ★ v36: VWAP 게이트 (백테스트 동기화)
            if (tickerConfig.filters?.useVWAP) {
                const vwapResult = calculateVWAP(klines, 24);
                if (vwapResult && vwapResult.stdDev > 0) {
                    const vwapDev = (currentPrice - vwapResult.vwap) / vwapResult.stdDev;
                    if (finalDirection === 'Long' && vwapDev > 2.0) {
                        if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'vwap_overext'; existingScan.detail = `VWAP σ=${vwapDev.toFixed(1)}`; }
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'vwap_overext', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                    if (finalDirection === 'Short' && vwapDev < -2.0) {
                        if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'vwap_overext'; existingScan.detail = `VWAP σ=${vwapDev.toFixed(1)}`; }
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'vwap_overext', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                }
            }

            // ★ v52.60: MFI 게이트 제거 — 섀도우 데이터에서 mfi_oversold가 +230 PnL%(lev) 흑자 확인
            // 과매도 Short 진입이 오히려 수익 기회

            // ★ v36: Hurst 게이트 (백테스트 동기화)
            if (tickerConfig.filters?.useHurst) {
                try {
                    const closes = klines.map(k => k.close);
                    const hurst = calculateHurstExponent(closes);
                    if (hurst < 0.35) {
                        if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'hurst_noise'; existingScan.detail = `Hurst=${hurst.toFixed(2)} 노이즈`; }
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'hurst_noise', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                } catch {}
            }

            // ★ 백테스트 동기화: 스캔 통과 → 즉시 시장가 진입 (WAITING 단계 제거)
            // 백테스트는 시그널 → 다음봉 open 즉시 진입. 실전도 동일하게 스캔 통과 = 바로 진입.

            // 오픈 포지션 있으면 신규 진입 차단 (TP/SL로만 청산 — 백테스트 동일)
            const openPos = this.state.openPositions.find(p => p.ticker === ticker && p.status === 'open');
            if (openPos) {
                if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'open_position'; existingScan.detail = `이미 ${openPos.direction} 포지션 보유`; }
                this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'open_position', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                return;
            }

            // ★ v52.6: FullScan 통과 → 즉시 시장가 진입 (배치 대기 제거)
            const zone = entryZones[0];
            const entryAtrArr = calculateATR(klines1m, 14);
            const entryAtr = entryAtrArr.length > 0 ? entryAtrArr[entryAtrArr.length - 1] : currentPrice * 0.01;

            const execEntryType: EntryType = detectedEntryType;
            const { session: execSession, dayType: execDayType } = getSessionAndDayType(Date.now());
            const resolved = this.resolveTickerConfig(ticker, regimeResult.simpleRegime, execEntryType, execSession, execDayType);
            const execConfig = resolved.config;

            // ★ v52.22: 18-way 런타임 필터 — regimeEntry 없으면 필터 미통과 → 진입 차단
            if (!resolved.regimeEntry) {
                if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'runtime_filter'; existingScan.detail = `18-way 필터 미통과 (3≤n≤10 & WR≥60% & EV>0)`; }
                this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'runtime_filter', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                return;
            }

            const tradableEquity = Math.max(
                this.state.totalEquity * 0.30,
                this.state.totalEquity - this.state.reservedProfits
            );

            const tickerReg = this.tickerParamRegistry[ticker];
            // ★ v52.20: 로그에도 resolved.regimeEntry(18-way) 세분화 stats 사용
            // ★ v52.22: 18-way 기준 stats 로그
            const _regSrc = resolved.regimeEntry ?? tickerReg;
            const _regTrades = _regSrc?.trades ?? 0;
            const _regAvgWin = _regSrc?.avgWin ?? 0;
            const _regAvgLoss = _regSrc?.avgLoss ?? 0;
            const _regWr = _regSrc?.winRate ?? 0;
            const ev = (_regWr / 100 * _regAvgWin) + ((100 - _regWr) / 100 * _regAvgLoss);

            // ★ v52.92: EV>0 프리필터 — 5포지션 보호 (실전만, 섀도우는 바이패스)
            // 5슬롯이 채워지면 안 비어서 첫 5개 선택이 승패를 결정
            // EV≤0 시그널이 슬롯 차지하면 수익 기회 상실
            if (!this._shadowEnabled && _regSrc && ev <= 0) {
                fullSteps.push({ gate: 'ev_prefilter', label: 'EV필터', passed: false, value: ev, threshold: 0, detail: `EV=${ev.toFixed(2)}%≤0` });
                if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'ev_prefilter'; existingScan.detail = `EV=${ev.toFixed(2)}%≤0 (슬롯 보호)`; existingScan.filterSteps = fullSteps; }
                this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'ev_prefilter', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                return;
            }
            if (!this._shadowEnabled && _regSrc) {
                fullSteps.push({ gate: 'ev_prefilter', label: 'EV필터', passed: true, value: ev, threshold: 0, detail: `EV=${ev.toFixed(2)}%` });
            }

            // ★ v53.0: RR 필터 — TP거리/SL거리 > 1.5이면 차단 (WR 14.3%)
            // RR < 0.5 = 91.8% WR, RR > 1.5 = 14.3% WR (섀도우 2918건 검증)
            if (_shadowTp && _shadowSl) {
                const tpDist = Math.abs(_shadowTp - currentPrice);
                const slDist = Math.abs(_shadowSl - currentPrice);
                const rr = slDist > 0 ? tpDist / slDist : 999;
                if (rr > 1.5) {
                    fullSteps.push({ gate: 'rr_filter', label: 'RR비율', passed: false, value: rr, threshold: 1.5, detail: `RR=${rr.toFixed(2)}>1.5` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'rr_filter'; existingScan.detail = `RR=${rr.toFixed(2)}>1.5 (TP 너무 멀음)`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'rr_filter', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'rr_filter', label: 'RR비율', passed: true, value: rr, threshold: 1.5, detail: `RR=${rr.toFixed(2)}` });
            }

            // ★ v55: ATR% 밴드 필터 — 0.15-0.60 (dirScore×ATR 분석: ATR 0.4-0.6 + DS 80-110 스위트스팟)
            // ATR < 0.15: 변동 없어 TP 못 침 (EV -0.06)
            // ATR 0.60+: SL 44%+, 20x에서 파산 위험 (0.50→0.60 확장: DS80-110 구간 EV +0.23)
            if (_shadowAtrPct > 0) {
                const atrPctForFilter = _shadowAtrPct * 100; // 0.0015 → 0.15
                const atrBandPassed = atrPctForFilter >= 0.15 && atrPctForFilter <= 0.60;
                if (!atrBandPassed) {
                    fullSteps.push({ gate: 'atr_band', label: 'ATR밴드', passed: false, value: atrPctForFilter, threshold: 0.15, detail: `ATR%=${atrPctForFilter.toFixed(3)} 밴드외 (0.15-0.60)` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'atr_band'; existingScan.detail = `ATR%=${atrPctForFilter.toFixed(3)} 밴드외 (0.15-0.60)`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'atr_band', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'atr_band', label: 'ATR밴드', passed: true, value: atrPctForFilter, threshold: 0.15, detail: `ATR%=${atrPctForFilter.toFixed(3)} (0.15-0.60)` });
            }

            // ★ v55.2: volLevel 차단 — VOLATILE 레짐 + NORMAL/HIGH volLevel = 즉사
            // 21,625건: NORMAL+VOLATILE WR=25.0% SL=72.4%, HIGH+VOLATILE WR=12.5% SL=87.5%
            // volLevel: LOW=ATR%<0.30, NORMAL=0.30-0.50, HIGH=0.50+
            if (_shadowSimpleRegime === 'VOLATILE' && _shadowAtrPct > 0) {
                const atrPctVol = _shadowAtrPct * 100;
                const volLevel = atrPctVol < 0.30 ? 'LOW' : atrPctVol < 0.50 ? 'NORMAL' : 'HIGH';
                if (volLevel === 'NORMAL' || volLevel === 'HIGH') {
                    fullSteps.push({ gate: 'vol_level', label: 'volLevel', passed: false, value: atrPctVol, threshold: 0.30, detail: `VOLATILE+${volLevel} ATR%=${atrPctVol.toFixed(3)} → 즉사차단` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'vol_level'; existingScan.detail = `VOLATILE+${volLevel} (SL ${volLevel === 'HIGH' ? '87.5' : '72.4'}%)`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'vol_level', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'vol_level', label: 'volLevel', passed: true, value: atrPctVol, threshold: 0.30, detail: `VOLATILE+${volLevel} ATR%=${atrPctVol.toFixed(3)}` });
            }

            // ★ v55.2: 종목 블랙리스트 — 21,625건 분석 EV<-0.1 or WR<45% (70종목)
            {
                const isBlacklisted = TradingEngine.TICKER_BLACKLIST_V55.has(ticker);
                if (isBlacklisted) {
                    fullSteps.push({ gate: 'ticker_blacklist', label: '블랙리스트', passed: false, value: 1, threshold: 0, detail: `v55 블랙리스트 (EV<-0.1)` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'ticker_blacklist'; existingScan.detail = `v55 블랙리스트 (EV<-0.1)`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'ticker_blacklist', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'ticker_blacklist', label: '블랙리스트', passed: true, value: 0, threshold: 0, detail: '통과' });
            }

            // ★ v55.2: RSI 방향별 최적 구간 필터
            // Short RSI 65-75: WR=76.3% EV=17.97, Short RSI 55-65: WR=69.2% EV=10.71
            // Long RSI 40-50: WR=64.2% EV=12.54
            {
                const closes1hForRsi = klines1h.map(k => k.close);
                const rsiArr1h = calculateRSI(closes1hForRsi, 14);
                const rsi1h = rsiArr1h.length > 0 ? rsiArr1h[rsiArr1h.length - 1] : 50;
                let rsiDirPassed = true;
                let rsiDirDetail = '';
                if (finalDirection === 'Short') {
                    // Short: RSI 55-75 최적 (55 미만이면 너무 과매도, 75 초과면 극단)
                    rsiDirPassed = rsi1h >= 55 && rsi1h <= 75;
                    rsiDirDetail = `Short RSI=${rsi1h.toFixed(1)} (최적 55-75)`;
                } else {
                    // Long: RSI 30-50 최적 (40-50 최강, 30-40도 괜찮음)
                    rsiDirPassed = rsi1h >= 30 && rsi1h <= 50;
                    rsiDirDetail = `Long RSI=${rsi1h.toFixed(1)} (최적 30-50)`;
                }
                if (!rsiDirPassed) {
                    fullSteps.push({ gate: 'rsi_direction', label: 'RSI방향', passed: false, value: rsi1h, threshold: finalDirection === 'Short' ? 55 : 30, detail: rsiDirDetail });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'rsi_direction'; existingScan.detail = rsiDirDetail; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'rsi_direction', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'rsi_direction', label: 'RSI방향', passed: true, value: rsi1h, threshold: finalDirection === 'Short' ? 55 : 30, detail: rsiDirDetail });
            }

            // ★ v55.2: 멀티팩터 진입 스코어 ≥5 게이트 (21,625건: Score≥5 WR=57.8%, EV=0.285)
            {
                let entryScore = 0;
                // 팩터1: VOLATILE +3
                if (_shadowSimpleRegime === 'VOLATILE') entryScore += 3;
                // 팩터2: EMA alignment 역추세/MIXED +2 (MIXED WR=61.1% EV=8.40, 역추세 WR=63.4% EV=9.46)
                const closes1hForEma = klines1h.map(k => k.close);
                const ema20 = calculateEMA(closes1hForEma, 20);
                const ema50 = calculateEMA(closes1hForEma, 50);
                const ema200 = calculateEMA(closes1hForEma, 200);
                let emaAlign: 'BULLISH' | 'BEARISH' | 'MIXED' = 'MIXED';
                if (ema20.length > 0 && ema50.length > 0 && ema200.length > 0) {
                    const e20 = ema20[ema20.length - 1];
                    const e50 = ema50[ema50.length - 1];
                    const e200 = ema200[ema200.length - 1];
                    if (e20 > e50 && e50 > e200) emaAlign = 'BULLISH';
                    else if (e20 < e50 && e50 < e200) emaAlign = 'BEARISH';
                    else emaAlign = 'MIXED';
                }
                if (emaAlign === 'MIXED') entryScore += 2;
                if ((emaAlign === 'BULLISH' && finalDirection === 'Short') || (emaAlign === 'BEARISH' && finalDirection === 'Long')) entryScore += 2;
                // 팩터3: ATR 스윗스팟 (0.20-0.25 최강 +3, 0.25-0.50 +2, 0.15-0.20 +1)
                const atrPctScore = _shadowAtrPct * 100;
                if (atrPctScore >= 0.20 && atrPctScore <= 0.25) entryScore += 3;
                else if (atrPctScore >= 0.25 && atrPctScore <= 0.50) entryScore += 2;
                else if (atrPctScore >= 0.15 && atrPctScore < 0.20) entryScore += 1;
                // 팩터4: Short +1
                if (finalDirection === 'Short') entryScore += 1;

                const atrScoreVal = atrPctScore >= 0.20 && atrPctScore <= 0.25 ? 3 : atrPctScore >= 0.25 && atrPctScore <= 0.50 ? 2 : atrPctScore >= 0.15 ? 1 : 0;
                const scoreDetail = `VOL=${_shadowSimpleRegime === 'VOLATILE' ? 3 : 0}+EMA=${emaAlign}+ATR=${atrScoreVal}+${finalDirection === 'Short' ? 'S=1' : 'L=0'}`;
                if (entryScore < 5) {
                    fullSteps.push({ gate: 'entry_score', label: '진입스코어', passed: false, value: entryScore, threshold: 5, detail: `Score=${entryScore} (${scoreDetail})` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'entry_score'; existingScan.detail = `Score=${entryScore} < 5 (${scoreDetail})`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'entry_score', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                fullSteps.push({ gate: 'entry_score', label: '진입스코어', passed: true, value: entryScore, threshold: 5, detail: `Score=${entryScore} (${scoreDetail})` });
            }

            // ★ v55.4: 시간대별 비중 배율 (21,625건 분석)
            // 안전: UTC 0,1,5,7,10,11,14,18 (WR 70-78%) → 비중 x2
            // 위험: UTC 3,4,15,16,22,23 (WR 51-57%) → 비중 x0.5
            // 보통: 나머지 → 비중 x1
            let _hourSizeMultiplier = 1.0;
            {
                const utcHour = new Date().getUTCHours();
                const safeHours = new Set([0, 1, 5, 7, 10, 11, 14, 18]);
                const dangerHours = new Set([3, 4, 15, 16, 22, 23]);
                if (safeHours.has(utcHour)) _hourSizeMultiplier = 2.0;
                else if (dangerHours.has(utcHour)) _hourSizeMultiplier = 0.5;
                const label = _hourSizeMultiplier > 1 ? '안전x2' : _hourSizeMultiplier < 1 ? '위험x0.5' : '보통x1';
                fullSteps.push({ gate: 'safe_hour', label: '시간대', passed: true, value: utcHour, threshold: 0, detail: `UTC ${utcHour}시 (한국 ${(utcHour+9)%24}시) ${label}` });
            }

            // ★ v52.80: 페이커봇 v2 — 모멘텀/쿨다운/블랙리스트 (실전만)
            if (!this._shadowEnabled) {
                const now = Date.now();
                const detailedRegime = regimeResult?.regime ?? 'UNKNOWN';

                // 3연패 블랙리스트 체크
                if (this._fakerBlacklist.has(ticker)) {
                    fullSteps.push({ gate: 'faker_blacklist', label: '3연패BL', passed: false, value: 1, threshold: 0, detail: `3연패 블랙리스트` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'faker_blacklist'; existingScan.detail = `3연패 블랙리스트`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: detailedRegime, atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'faker_blacklist', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }

                // ★ v55.2: 쿨다운 체크 (동일 종목 120분 간격)
                const cooldownUntil = this._fakerCooldown[ticker] ?? 0;
                if (now < cooldownUntil) {
                    const remainMin = Math.ceil((cooldownUntil - now) / 60000);
                    fullSteps.push({ gate: 'faker_cooldown', label: '쿨다운', passed: false, value: remainMin, threshold: 0, detail: `쿨다운 ${remainMin}분 남음` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'faker_cooldown'; existingScan.detail = `쿨다운 ${remainMin}분 남음`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: detailedRegime, atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'faker_cooldown', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }

                // 모멘텀 라이더 체크 — 이전 TP + 같은 레짐 + 같은 방향 + 5분 이내
                const prevResult = this._fakerMomentum[ticker];
                if (prevResult) {
                    if (prevResult.result === 'sl') {
                        // SL 후 → 쿨다운 중이 아니면 첫 진입 허용 (씨앗 거래)
                    } else if (prevResult.result === 'tp') {
                        const timeSinceTp = now - prevResult.timestamp;
                        const sameRegime = prevResult.regime === detailedRegime;
                        const sameDir = prevResult.direction === finalDirection;

                        if (!sameRegime || !sameDir) {
                            // 레짐/방향 바뀌면 모멘텀 리셋 → 씨앗 거래로 진입 허용
                            delete this._fakerMomentum[ticker];
                        }
                        // 5분 이내 + 같은 레짐 + 같은 방향 → 모멘텀 진입 (최고 WR)
                        // 5분 초과 → 씨앗 거래로 허용 (모멘텀 소멸했지만 진입 자체는 OK)
                    }
                }
                // 첫 진입(prevResult 없음) → 씨앗 거래로 허용
            }

            // ★ v52.49: 섀도우 모드에서는 증거금/중복포지션 체크 스킵
            if (!this._shadowEnabled) {
                // ★ 증거금 체크
                const imUsedMargin = this.state.openPositions
                    .filter(p => p.status === 'open')
                    .reduce((sum, p) => sum + (p.initialMargin || 0), 0);
                const imAvailableMargin = this.state.totalEquity - imUsedMargin;
                if (imAvailableMargin < 1) {
                    fullSteps.push({ gate: 'margin_check', label: '증거금', passed: false, value: imAvailableMargin, threshold: 1, detail: `증거금 $${imAvailableMargin.toFixed(2)} < $1` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'margin_check'; existingScan.detail = `증거금 $${imAvailableMargin.toFixed(2)} < $1`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'margin_check', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }

                // ★ 이미 해당 종목 포지션 있으면 스킵
                const imAlreadyOpen = this.state.openPositions.find(p => p.ticker === ticker && p.status === 'open');
                if (imAlreadyOpen) {
                    fullSteps.push({ gate: 'open_position', label: '기존포지션', passed: false, value: 1, threshold: 0, detail: `${ticker} 이미 보유중` });
                    if (existingScan) { existingScan.status = 'blocked'; existingScan.gate = 'open_position'; existingScan.detail = `${ticker} 이미 보유중`; existingScan.filterSteps = fullSteps; }
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'open_position', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
            }

            // ★ 뉴스 게이트 (캐시 사용 — 스캔 시작 시 병렬로 이미 시작됨)
            let newsSizeMultiplier = 1.0;
            let newsTpMultiplier = 1.0;
            if (this._newsCache) {
                const tickerBase = ticker.replace('USDT', '');
                const isAffected = this._newsCache.affectedTickers.some(
                    t => t.toUpperCase() === tickerBase.toUpperCase() || t === 'ALL' || t === 'CRYPTO'
                );
                if (this._newsCache.impact === 'CRISIS' && this._newsCache.confidence >= 70 && isAffected) {
                    this.eventEmitter.emit('newMessage', 'system', `🚨 [NewsGuard] ${ticker} 진입 차단 — CRISIS`, 'system_state');
                    this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'news_crisis', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                    return;
                }
                if (this._newsCache.impact === 'FUD_OVERREACTION' && this._newsCache.confidence >= 80 && isAffected) {
                    const isFading = (this._newsCache.dumpDirection === 'LONG_DANGER' && finalDirection === 'Long')
                        || (this._newsCache.dumpDirection === 'SHORT_DANGER' && finalDirection === 'Short');
                    if (isFading) {
                        this.recordShadowSignal({ ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN', atr: _shadowAtr, leverage: _shadowLev, filterSteps: fullSteps, passedAllFilters: false, rejectedGate: 'news_fud', registryN: tickerEntry?.trades, registryWR: tickerEntry?.winRate, tpPrice: _shadowTp, slPrice: _shadowSl });
                        return;
                    }
                    newsSizeMultiplier = 1.5;
                }
                if (this._newsCache.suggestedAction === 'REDUCE_SIZE' && isAffected) newsSizeMultiplier = 0.5;
                if ((this._newsCache.impact === 'MACRO_EVENT' || this._newsCache.suggestedAction === 'WIDEN_TP') && this._newsCache.confidence >= 60) {
                    newsTpMultiplier = calcDynamicTpMultiplier(this._newsCache.confidence);
                }
            }

            this.eventEmitter.emit('newMessage', 'system',
                `✅ [FullScan→즉시진입] ${ticker} ${finalDirection} 🔥Ig | WR=${_regWr.toFixed(0)}% PnL=${(_regSrc?.pnl ?? 0).toFixed(0)}% EV=${ev.toFixed(1)}% | 표본=${_regTrades}`,
                'system_state'
            );

            // ★ v52.36: 섀도우 기록 — 모든 필터 통과 (passedAllFilters=true)
            this.recordShadowSignal({
                ticker, direction: finalDirection, price: currentPrice, regime: regimeResult?.regime ?? 'UNKNOWN',
                atr: entryAtr, leverage: resolved.regimeEntry?.params?.leverageTrending ?? resolved.regimeEntry?.params?.leverageRanging ?? 0,
                filterSteps: fullSteps, passedAllFilters: true,
                registryN: _regSrc?.trades, registryWR: _regWr, registryEV: ev, registryQualified: true,
                tpPrice: _shadowTp, slPrice: _shadowSl,
            });

            // ★ v53.0: dual 20x 시그널 제거 — WF가 [5,14,20] 자동 선택

            // ★ v52.38: 섀도우 모드에서는 실전 진입 차단
            if (this._shadowEnabled) {
                console.log(`[Shadow] 🚫 ${ticker} ${finalDirection} 실전 진입 차단 (섀도우 모드)`);
                return;
            }

            try {
                const trade = await this.execution.executeEntry({
                    ticker,
                    direction: finalDirection,
                    config: execConfig,
                    atr: entryAtr,
                    currentPrice,
                    equity: tradableEquity,
                    availableBalance: this.state.availableBalance,
                    regime: regimeResult.regime,
                    regimeResult,
                    zoneMinPrice: zone.minPrice,
                    zoneMaxPrice: zone.maxPrice,
                    zoneType: zone.type,
                    reasoning: candidate.reasoning || '',
                    selectedTimeframe: selectedTF,
                    maxPositions: this.maxPositions,
                    openPositionCount: this.state.openPositions.filter(p => p.status === 'open').length,
                    newsSizeMultiplier: _aggressiveSizeOverride ? 1.0 : newsSizeMultiplier,
                    newsTpMultiplier,
                    // ★ v55.4: 연승/연패 적응형 비중 (21,625건: 20/35/10이 22%↑) + 시간대 배율
                    aggressiveSizePercent: _aggressiveSizeOverride ?? Math.round((
                        this._globalConsecWins >= 2 ? 35 :
                        this._globalConsecLosses >= 2 ? 10 :
                        20
                    ) * _hourSizeMultiplier),
                    // ★ v52.72: WF 파라미터 레버리지
                    wfLeverage: resolved.regimeEntry?.params?.[levField] || undefined,
                    // ★ v52.22: 18-way 기준 stats 표시
                    registryStats: (() => {
                        const src = resolved.regimeEntry ?? tickerReg;
                        if (!src) return undefined;
                        const wr = src.winRate ?? 0;
                        const avgW = src.avgWin ?? 0;
                        const avgL = src.avgLoss ?? 0;
                        return {
                            winRate: wr, pnl: src.pnl ?? 0, trades: src.trades ?? 0,
                            avgWin: avgW, avgLoss: avgL,
                            ev: (wr / 100 * avgW) + ((100 - wr) / 100 * avgL),
                            maxDD: (src as any).maxDD ?? 0, avgHoldMin: (src as any).avgHoldingMin ?? 0,
                        };
                    })(),
                });

                if (trade) {
                    const { session: entrySess, dayType: entryDT } = getSessionAndDayType(Date.now());
                    trade.entrySession = entrySess;
                    trade.entryDayType = entryDT;
                    const sr = regimeResult.simpleRegime;
                    trade.entryTimeSegmentKey = makeTimeSegmentKey(sr as any, execEntryType, entrySess, entryDT);
                    this.state.openPositions.push(trade);
                    this.lastEntryTime = Date.now();
                }
            } catch (e) {
                this.eventEmitter.emit('newMessage', 'system',
                    `⚠️ [Entry Failed] ${ticker} 즉시진입 실패: ${(e as Error).message}`, 'system_state');
            }
        } catch (e) {
            console.error(`[Scan] ${ticker} error:`, e);
        }
    }

    // ── 모니터링 + 실행 ──

    private async monitorAndExecute() {
        const openCount = this.state.openPositions.filter(p => p.status === 'open').length;

        // ★ 대기 후보 정렬: Ignition > TF동의도 > 승률 > PnL > 레버리지 (최고 우선순위로 진입)
        this.state.waitingCandidates.sort((a, b) => {
            const igA = (a as any)._isIgnition ? 1 : 0;
            const igB = (b as any)._isIgnition ? 1 : 0;
            if (igA !== igB) return igB - igA;  // Ignition 우선
            const tfA = (a as any)._tfConsensus ?? 0;
            const tfB = (b as any)._tfConsensus ?? 0;
            if (tfA !== tfB) return tfB - tfA;  // TF 동의도 높은 종목 우선
            const wrDiff = ((b as any)._registryWinRate ?? 0) - ((a as any)._registryWinRate ?? 0);
            if (wrDiff !== 0) return wrDiff;  // 승률 우선
            const pnlDiff = ((b as any)._registryPnl ?? 0) - ((a as any)._registryPnl ?? 0);
            if (pnlDiff !== 0) return pnlDiff;  // 수익률 우선
            return ((b as any)._registryLeverage ?? 0) - ((a as any)._registryLeverage ?? 0);  // 레버리지 우선
        });

        const result = await this.entryManager.monitorCandidates(
            this.state.waitingCandidates,
            openCount,
            this.maxPositions,
            this.tradingConfig,
        );

        // 가격 동기화 → UI (타점감시 현황판에 현재가 표시)
        const freshPrices = this.entryManager.getAllLatestPrices();
        if (Object.keys(freshPrices).length > 0) {
            this.state.latestPrices = { ...this.state.latestPrices, ...freshPrices };
        }

        // 만료 제거
        if (result.expired.length > 0) {
            this.state.waitingCandidates = this.state.waitingCandidates.filter(
                c => !result.expired.includes(c.ticker)
            );
        }

        // 트리거 → 실행
        for (const candidate of result.triggered) {
            if (this.isGlobalExecutionLocked) break;



            this.isGlobalExecutionLocked = true;
            this.executionLockedSince = Date.now();

            try {
                // ★ v49: 증거금 기반 멀티포지션 게이트
                const openCount = this.state.openPositions.filter(p => p.status === 'open').length;
                const usedMargin2 = this.state.openPositions
                    .filter(p => p.status === 'open')
                    .reduce((sum, p) => sum + (p.initialMargin || 0), 0);
                const availableMargin2 = this.state.totalEquity - usedMargin2;
                // ★ v52.11: 최소 증거금 $5 → $1로 완화
                if (availableMargin2 < 1) {
                    this.state.waitingCandidates = this.state.waitingCandidates.filter(c => c.ticker !== candidate.ticker);
                    continue;
                }

                const triggeredIdx = (candidate as any)._triggeredZoneIdx ?? 0;
                const zone = candidate.entryZones[triggeredIdx] || candidate.entryZones[0];
                const currentPrice = this.entryManager.getLatestPrice(candidate.ticker);
                if (!currentPrice || !zone) continue;

                // v14-fix: 실행 직전 중복 포지션 재확인
                if (this.state.openPositions.some(p => p.ticker === candidate.ticker && p.status === 'open')) {
                    this.state.waitingCandidates = this.state.waitingCandidates.filter(c => c.ticker !== candidate.ticker);
                    continue;
                }

                // ★ 백테스트 동일: 1분봉 기반 ATR (TP/SL용)
                const klines = await bybitService.fetchSingleTimeframeKlines(candidate.ticker, '1m', 200);
                const atrArr = calculateATR(klines, 14);
                const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : currentPrice * 0.01;

                // 레짐 (캐시)
                const regimeResult = await this.scanner.classifyRegime(candidate.ticker, klines);
                const simpleRegime = regimeResult.simpleRegime;

                // ★ 레짐×진입타입별 파라미터 조회 (진입 시 최종 적용) — 18-way 시간 세분화 포함
                const execEntryType: EntryType = getEntryTypeFromZoneType(candidate.entryZones?.[0]?.type || 'ZONE_SIM');
                const { session: execSession2, dayType: execDayType2 } = getSessionAndDayType(Date.now());
                const { config: tickerConfig, tickerEntry, regimeEntry } = this.resolveTickerConfig(
                    candidate.ticker, simpleRegime, execEntryType, execSession2, execDayType2
                );
                // ★ baseSizePercent는 execution.ts calculateSize에서 레버리지 기반 자동 계산

                // 레짐별 미적격이면 스킵 (스캔 이후 레짐 변경 가능)
                if (tickerEntry?.regimeEntries && Object.keys(tickerEntry.regimeEntries).length > 0 && !regimeEntry) {
                    this.state.waitingCandidates = this.state.waitingCandidates.filter(c => c.ticker !== candidate.ticker);
                    this.eventEmitter.emit('newMessage', 'system',
                        `🚫 [진입취소] ${candidate.ticker} ${simpleRegime}_${execEntryType}: 레짐+진입타입 미적격 → 후보 제거`,
                        'system_state'
                    );
                    continue;
                }

                // 레짐 관측 기록 (로그용)
                this.recentRegimes.push(simpleRegime);
                if (this.recentRegimes.length > 20) this.recentRegimes.shift();

                const regimeMismatch = false;  // 필터 제거 — 호환성 유지

                // ★ 추격진입 로그
                if ((candidate as any)._chaseEntry) {
                    this.eventEmitter.emit('newMessage', 'system',
                        `🏃 [추격진입] ${candidate.ticker} ${candidate.direction} — 존 벗어남, 추격 허용 범위 내 진입`,
                        'system_state'
                    );
                }

                // ★ 모멘텀 바이패스 로그 + zoneType 변경
                if ((candidate as any)._momentumChase) {
                    this.eventEmitter.emit('newMessage', 'system',
                        `🚀 [모멘텀바이패스] ${candidate.ticker} ${candidate.direction} — 풀백 없이 TP 방향 이동, 시장가 진입`,
                        'system_state'
                    );
                    zone.type = 'MOMENTUM_CHASE';
                }


                // ★ RANGING TP cap 제거 — 옵티마이저가 레짐별 tpAtrMultiplier를 이미 최적화

                // ★ v52.38: 섀도우 모드에서는 실전 진입 차단
                if (this._shadowEnabled) {
                    console.log(`[Shadow] 🚫 ${candidate.ticker} ${candidate.direction} 실전 진입 차단 (섀도우 모드 — monitor)`);
                    return;
                }

                // 실행 — per-ticker config 사용
                // ★ 수익 리밸런싱: 보호된 수익을 사이징에서 제외 (최소 30% 바닥 보장)
                const tradableEquity = Math.max(
                    this.state.totalEquity * 0.30,
                    this.state.totalEquity - this.state.reservedProfits
                );
                const trade = await this.execution.executeEntry({
                    ticker: candidate.ticker,
                    direction: candidate.direction,
                    config: tickerConfig,
                    atr,
                    currentPrice,
                    equity: tradableEquity,
                    availableBalance: Math.min(this.state.availableBalance, availableMargin2),  // ★ v49: 증거금 여유분
                    regime: regimeResult.regime,
                    regimeResult,
                    zoneMinPrice: zone.minPrice,
                    zoneMaxPrice: zone.maxPrice,
                    zoneType: zone.type,
                    reasoning: candidate.reasoning || '',
                    // 데이터 수집: candidate 태그 전달
                    momentumScore: (candidate as any)._momentumScore || 0,
                    volumeRatio: (candidate as any)._momentumVolumeRatio || 1.0,
                    volatilityAccel: (candidate as any)._volatilityAccel || 1.0,
                    zoneCenterPrice: (zone.minPrice + zone.maxPrice) / 2,
                    // Quality Gate 데이터
                    qualityGateRangePos: (candidate as any)._qualityGateRangePos,
                    qualityGateMomentum: (candidate as any)._qualityGateMomentum,
                    qualityGateVolRatio: (candidate as any)._qualityGateVolRatio,
                    // 적응형 TF
                    selectedTimeframe: (candidate as any)._selectedTimeframe || '15m',
                    // Phase 1: Sentiment
                    sentimentData: (candidate as any)._sentimentData,
                    sentimentScore: (candidate as any)._sentimentScore,
                    // Phase 2: VWAP + SMC
                    vwapData: (candidate as any)._vwapData,
                    smcContext: (candidate as any)._smcContext,
                    // Phase 3: WaveTrend + Ichimoku
                    waveTrendData: (candidate as any)._waveTrendData,
                    ichimokuData: (candidate as any)._ichimokuData,
                    // v35: 포지션 균등 분배
                    maxPositions: this.maxPositions,
                    openPositionCount: this.state.openPositions.filter(p => p.status === 'open').length,
                    // ★ v52.72: WF 파라미터 레버리지
                    wfLeverage: (() => {
                        const lf = regimeResult.simpleRegime === 'TRENDING' ? 'leverageTrending'
                            : regimeResult.simpleRegime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';
                        return regimeEntry?.params?.[lf] || tickerEntry?.params?.[lf] || undefined;
                    })(),
                    // ★ v52.22: 18-way 기준 stats
                    registryStats: (() => {
                        const src = regimeEntry ?? tickerEntry;
                        if (!src) return undefined;
                        const wr = src.winRate ?? 0;
                        const avgW = src.avgWin ?? 0;
                        const avgL = src.avgLoss ?? 0;
                        return {
                            winRate: wr, pnl: src.pnl ?? 0, trades: src.trades ?? 0,
                            avgWin: avgW, avgLoss: avgL,
                            ev: (wr / 100 * avgW) + ((100 - wr) / 100 * avgL),
                            maxDD: (src as any).maxDD ?? 0, avgHoldMin: (src as any).avgHoldingMin ?? 0,
                        };
                    })(),
                });

                if (trade) {
                    this.state.openPositions.push(trade);
                    this.lastEntryTime = Date.now();

                    // 텔레그램 진입 알림
                    const lev = trade.leverage ?? 0;
                    const tpPct = trade.targetPrice && trade.entryPrice
                        ? (Math.abs(trade.targetPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(1)
                        : '?';
                    this.notifyTelegram(
                        `📈 <b>진입</b> ${trade.ticker}\n` +
                        `${trade.direction} ${lev.toFixed(0)}x @ $${trade.entryPrice.toFixed(4)}\n` +
                        `TP ${tpPct}% | SL $${trade.invalidationPrice?.toFixed(4) ?? 'N/A'}`
                    );

                    // 후보 제거
                    this.state.waitingCandidates = this.state.waitingCandidates.filter(
                        c => c.ticker !== candidate.ticker
                    );

                    this.emitState(true);
                } else {
                    // ★ 진입 실패 (Leverage Gate, 잔고 부족, 수량 0 등) → 후보 제거
                    // 안 지우면 매 사이클 같은 종목이 트리거돼서 다른 종목 차단
                    this.eventEmitter.emit('newMessage', 'system',
                        `⚠️ [Entry Failed] ${candidate.ticker} 진입 실패 → 후보 제거 (재스캔 대기)`,
                        'system_state'
                    );
                    this.state.waitingCandidates = this.state.waitingCandidates.filter(
                        c => c.ticker !== candidate.ticker
                    );
                }
            } catch (e) {
                console.error(`[Execute] ${candidate.ticker} error:`, e);
            } finally {
                this.isGlobalExecutionLocked = false;
                this.executionLockedSince = 0;
            }
        }
    }

    // ── 텔레그램 알림 ──

    private notifyTelegram(message: string) {
        if (!this.config?.telegramBotToken || !this.config?.telegramChatId) return;
        sendTelegramNotification(this.config.telegramBotToken, this.config.telegramChatId, message)
            .catch(e => console.warn('[Telegram] send failed:', e));
    }

    // ── 거래 종료 처리 ──

    private async onTradeClose(trade: Trade) {
        // 텔레그램 청산 알림
        const pnl = trade.pnl || 0;
        const pnlEmoji = pnl > 0 ? '✅' : '❌';
        const holdMin = trade.openTimestamp
            ? Math.round((Date.now() - trade.openTimestamp) / 60000)
            : 0;
        this.notifyTelegram(
            `${pnlEmoji} <b>청산</b> ${trade.ticker}\n` +
            `${trade.direction} | ${trade.reasonForExit ?? 'closed'}\n` +
            `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${holdMin}분 보유)\n` +
            `총자산: $${this.state.totalEquity.toFixed(2)}`
        );

        // 1. 승/패 추적
        const won = pnl > 0;
        this.globalRecentTrades.push({ win: won, timestamp: Date.now(), ticker: trade.ticker });
        if (this.globalRecentTrades.length > 30) this.globalRecentTrades.shift();

        // ★ v55: 연승/연패 글로벌 카운트 업데이트
        if (won) {
            this._globalConsecWins++;
            this._globalConsecLosses = 0;
        } else {
            this._globalConsecLosses++;
            this._globalConsecWins = 0;
        }

        // ★ v52.80: 페이커봇 v2 — 모멘텀/쿨다운/블랙리스트 업데이트
        const detailedRegime = (trade as any).regime ?? 'UNKNOWN';
        if (won) {
            // TP → 모멘텀 기록
            this._fakerMomentum[trade.ticker] = {
                result: 'tp', regime: detailedRegime,
                direction: trade.direction, timestamp: Date.now(),
            };
            this._fakerConsecLosses[trade.ticker] = 0;
            // ★ v55.2: TP 후에도 120분 쿨타임 (21,625건: <30분 WR 42.1%, >120분 WR 51.4%)
            this._fakerCooldown[trade.ticker] = Date.now() + this.FAKER_COOLDOWN_MS;
        } else {
            // SL → 쿨다운 120분 + 연패 추적
            this._fakerMomentum[trade.ticker] = {
                result: 'sl', regime: detailedRegime,
                direction: trade.direction, timestamp: Date.now(),
            };
            this._fakerCooldown[trade.ticker] = Date.now() + this.FAKER_COOLDOWN_MS;
            this._fakerConsecLosses[trade.ticker] = (this._fakerConsecLosses[trade.ticker] || 0) + 1;
            // 3연패 → 세션 블랙리스트
            if (this._fakerConsecLosses[trade.ticker] >= 3) {
                this._fakerBlacklist.add(trade.ticker);
                this.eventEmitter.emit('newMessage', 'system',
                    `🚫 [페이커봇] ${trade.ticker} 3연패 → 세션 블랙리스트`,
                    'system_state');
            }
        }

        // ★ SL 쿨다운 제거 — 손실 시 2연패 재최적화만 유지
        if (!won) {
            this.tickerConsecLosses[trade.ticker] = (this.tickerConsecLosses[trade.ticker] || 0) + 1;
            // 대기 후보에서 제거 (즉시 재진입 방지)
            this.state.waitingCandidates = this.state.waitingCandidates.filter(c => c.ticker !== trade.ticker);
            // ★ 2연패 → 해당 종목 재최적화 요청
            if (this.tickerConsecLosses[trade.ticker] >= 2) {
                this.eventEmitter.emit('tickerReoptRequest', trade.ticker);
                this.eventEmitter.emit('newMessage', 'system',
                    `🔄 [2연패] ${trade.ticker} 재최적화 요청 → 다음 사이클에서 재탐색`,
                    'system_state');
            }
        } else {
            this.tickerConsecLosses[trade.ticker] = 0;
        }

        // 2. ★ 수익 리밸런싱: 승리 시 수익의 25%를 보호 영역으로 이전
        const PROFIT_RESERVE_RATIO = 0.25;
        if (pnl > 0) {
            const reserveAmount = pnl * PROFIT_RESERVE_RATIO;
            this.state.reservedProfits += reserveAmount;
            this.eventEmitter.emit('newMessage', 'system',
                `🛡️ [Rebalance] +$${reserveAmount.toFixed(2)} 보호 (${(PROFIT_RESERVE_RATIO * 100).toFixed(0)}% of $${pnl.toFixed(2)}) | 누적 보호: $${this.state.reservedProfits.toFixed(2)}`,
                'system_state');
        }

        // 4. 세션 통계 업데이트
        this.updateSessionStats();

        // 5. ★ 실전 거래 localStorage 영구 저장 (검증 대시보드용)
        persistTrade(trade).catch(() => {});

        this.eventEmitter.emit('newMessage', 'system',
            `📊 [Trade Closed] ${trade.ticker} ${trade.direction} | ` +
            `PnL: ${(trade.pnl || 0).toFixed(4)} USDT | ${trade.reasonForExit || 'unknown'}`,
            'system_state'
        );

        this.emitState(true);
    }

    // ── 섀도우 트레이딩 ──

    public setShadowMode(enabled: boolean): void {
        this._shadowEnabled = enabled;
        if (enabled) {
            this.loadShadowSignals();
            console.log('[Shadow] 섀도우 모드 활성화');
        } else {
            console.log('[Shadow] 섀도우 모드 비활성화');
        }
    }

    public isShadowMode(): boolean { return this._shadowEnabled; }

    // ★ v52.80: 페이커봇 세션 전환 시 리셋
    public resetFakerState(): void {
        this._fakerMomentum = {};
        this._fakerCooldown = {};
        this._fakerBlacklist.clear();
        this._fakerConsecLosses = {};
        console.log('[FakerBot] 세션 전환 → 모멘텀/쿨다운/블랙리스트 리셋');
    }

    // ★ v52.63: 섀도우 오픈 포지션 미실현PnL 스냅샷
    public snapshotShadowUnrealized(): { updated: number; stats: { total: number; winning: number; losing: number; totalPnlPct: number; totalPnlLevPct: number; avgPnlPct: number } } {
        let updated = 0;
        const openSigs = this.shadowSignals.filter(s => s.status === 'open');
        for (const sig of openSigs) {
            const price = this.state.latestPrices[sig.ticker];
            if (!price) continue;
            const rawPct = sig.direction === 'Long'
                ? (price - sig.signalPrice) / sig.signalPrice * 100
                : (sig.signalPrice - price) / sig.signalPrice * 100;
            const lev = sig.leverage || 1;
            (sig as any)._unrealizedPct = rawPct;
            (sig as any)._unrealizedLevPct = rawPct * lev;
            (sig as any)._currentPrice = price;
            updated++;
        }
        const withData = openSigs.filter(s => (s as any)._unrealizedPct !== undefined);
        const winning = withData.filter(s => (s as any)._unrealizedPct > 0).length;
        const losing = withData.filter(s => (s as any)._unrealizedPct <= 0).length;
        const totalPnlPct = withData.reduce((sum, s) => sum + ((s as any)._unrealizedPct || 0), 0);
        const totalPnlLevPct = withData.reduce((sum, s) => sum + ((s as any)._unrealizedLevPct || 0), 0);
        this.state.shadowSignals = this.shadowSignals;
        return {
            updated,
            stats: {
                total: withData.length,
                winning, losing,
                totalPnlPct,
                totalPnlLevPct,
                avgPnlPct: withData.length > 0 ? totalPnlPct / withData.length : 0,
            }
        };
    }

    // ★ v52.56: WF 윈도우별 bestParams 누적
    public addWfWindows(records: import('../types').WfWindowRecord[]): void {
        const prev = this.state.lastWfWindows ?? [];
        this.state.lastWfWindows = [...prev, ...records];
    }

    private loadShadowSignals(): void {
        try {
            const raw = localStorage.getItem('shadow_signals_v1');
            if (raw) {
                this.shadowSignals = JSON.parse(raw);
                this.state.shadowSignals = this.shadowSignals;
                console.log(`[Shadow] ${this.shadowSignals.length}건 로드`);
            }
        } catch { this.shadowSignals = []; }
    }

    private saveShadowSignals(): void {
        try {
            // 최근 7000건만 유지
            if (this.shadowSignals.length > this.SHADOW_MAX_SIGNALS) {
                this.shadowSignals = this.shadowSignals.slice(-this.SHADOW_MAX_SIGNALS);
            }
            localStorage.setItem('shadow_signals_v1', JSON.stringify(this.shadowSignals));
        } catch {}
    }

    /** ★ v53.4: 섀도우 시그널 자동 CSV 내보내기 — 30분 쿨다운, 새로 닫힌 건만 append */
    private autoExportShadowCSV(): void {
        const now = Date.now();
        if (now - this._shadowLastExportTime < this.SHADOW_EXPORT_COOLDOWN_MS) return;

        // 새로 닫힌 시그널만 추출
        const newClosed = this.shadowSignals.filter(
            s => s.status === 'closed' && !this._shadowExportedIds.has(s.id)
        );
        if (newClosed.length === 0) return;

        // CSV 헤더 + 데이터 생성
        const headers = [
            'id', 'ticker', 'direction', 'signalPrice', 'signalTime', 'regime', 'session', 'dayType',
            'registryN', 'registryWR', 'registryEV', 'registryQualified', 'leverage',
            'passedAllFilters', 'rejectedGate',
            'virtualTp', 'virtualSl', 'atr',
            'exitPrice', 'exitTime', 'pnlPercent', 'pnlLevPercent', 'pnlDollar', 'reasonForExit',
            'filterGates',
        ];

        // 기존 파일에 append할 수 있도록 — 첫 내보내기면 헤더 포함, 이후는 데이터만
        const isFirst = this._shadowExportedIds.size === 0;
        const rows = newClosed.map(s => [
            s.id, s.ticker, s.direction, s.signalPrice,
            new Date(s.signalTimestamp).toISOString(),
            s.regime, s.session, s.dayType,
            s.registryN ?? '', s.registryWR ?? '', s.registryEV ?? '', s.registryQualified ?? '',
            s.leverage ?? '',
            s.passedAllFilters, s.rejectedGate ?? '',
            s.virtualTp ?? '', s.virtualSl ?? '', s.atr ?? '',
            s.exitPrice ?? '', s.exitTimestamp ? new Date(s.exitTimestamp).toISOString() : '',
            s.pnlPercent?.toFixed(4) ?? '', s.pnlLevPercent?.toFixed(4) ?? '',
            s.pnlDollar?.toFixed(2) ?? '', s.reasonForExit ?? '',
            // 필터 게이트 요약: "gate1:pass,gate2:fail" 형태
            (s.filterSteps || []).map(f => `${f.gate}:${f.passed ? 'P' : 'F'}`).join('|'),
        ].map(v => JSON.stringify(String(v))).join(','));

        const bom = '\uFEFF';
        const csvContent = isFirst
            ? bom + headers.join(',') + '\n' + rows.join('\n')
            : rows.join('\n');

        // 날짜별 파일명 (같은 날 여러 번 내보내기 → 브라우저가 (1), (2) 붙임)
        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `shadow_signals_${dateStr}.csv`;

        try {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('[Shadow] CSV 내보내기 실패:', e);
            return;
        }

        // 내보낸 ID 기록 & 타임스탬프 갱신
        for (const s of newClosed) {
            this._shadowExportedIds.add(s.id);
        }
        this._shadowLastExportTime = now;
        console.log(`[Shadow] 📥 자동 CSV 내보내기: ${newClosed.length}건 (누적 ${this._shadowExportedIds.size}건)`);
    }

    public recordShadowSignal(params: {
        ticker: string;
        direction: 'Long' | 'Short';
        price: number;
        regime: string;
        atr: number;
        leverage: number;
        filterSteps: import('../types').ScanFilterStep[];
        passedAllFilters: boolean;
        rejectedGate?: string;
        registryN?: number;
        registryWR?: number;
        registryEV?: number;
        registryQualified?: boolean;
        tpPrice?: number;
        slPrice?: number;
    }): void {
        // ★ v53.5 FIX: _shadowEnabled 체크 제거 — 실전에서도 항상 섀도우 기록
        // 기존 버그: 실전 모드(_shadowEnabled=false)에서 섀도우 기록 안 됨

        // ★ v52.59: 7000건 꽉 차면 신규 기록 스킵 (기존 TP/SL 추적은 monitorShadowPositions에서 계속)
        if (this.shadowSignals.length >= this.SHADOW_MAX_SIGNALS) return;

        // ★ v52.56: TP/SL을 direction에 맞게 재계산 (reverse에서 방향 뒤집힘 대응)
        const atr = params.atr || params.price * 0.01;
        let tp = params.tpPrice;
        let sl = params.slPrice;
        if (tp && sl) {
            // TP/SL 방향 검증 — 역전이면 재계산
            if (params.direction === 'Long' && tp < params.price) {
                tp = params.price + atr * 7;
                sl = params.price - atr * 2.75;
            } else if (params.direction === 'Short' && tp > params.price) {
                tp = params.price - atr * 7;
                sl = params.price + atr * 2.75;
            }
        }

        const { session, dayType } = getSessionAndDayType(Date.now());
        const signal: ShadowSignal = {
            id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ticker: params.ticker,
            direction: params.direction,
            signalPrice: params.price,
            signalTimestamp: Date.now(),
            regime: params.regime,
            session,
            dayType,
            registryN: params.registryN,
            registryWR: params.registryWR,
            registryEV: params.registryEV,
            registryQualified: params.registryQualified,
            leverage: params.leverage,
            filterSteps: params.filterSteps,
            passedAllFilters: params.passedAllFilters,
            rejectedGate: params.rejectedGate,
            virtualTp: tp,
            virtualSl: sl,
            atr: params.atr,
            status: 'open',
        };

        this.shadowSignals.push(signal);
        this.state.shadowSignals = this.shadowSignals;
        this.saveShadowSignals();
        console.log(`[Shadow] 📊 ${params.ticker} ${params.direction} @ ${params.price} | filters: ${params.passedAllFilters ? '✅통과' : '❌' + params.rejectedGate}`);
    }

    private async monitorShadowPositions(): Promise<void> {
        if (this.shadowSignals.length === 0) return;
        const now = Date.now();
        let changed = false;

        // ★ v52.52: 오픈 섀도우 포지션의 가격을 직접 조회 (latestPrices에 없는 종목 대응)
        const openTickers = [...new Set(this.shadowSignals.filter(s => s.status === 'open').map(s => s.ticker))];
        if (openTickers.length > 0) {
            try {
                const prices = await bybitService.fetchCurrentPrices(openTickers);
                for (const [sym, price] of Object.entries(prices)) {
                    if (price > 0) {
                        this.state.latestPrices[sym] = price;
                    }
                }
            } catch (e) {
                // 조회 실패 시 기존 latestPrices 사용
            }
        }

        for (const sig of this.shadowSignals) {
            if (sig.status !== 'open') continue;

            const price = this.state.latestPrices[sig.ticker];
            if (!price) continue;

            const SHADOW_MARGIN = 100; // 가상 증거금 $100
            const SHADOW_FEE_PCT = 0.19; // ★ FIX #5: 수수료 0.19% 차감 (왕복 0.055%×2 + 슬리피지 0.08%)
            const closeShadow = (exitP: number, reason: string) => {
                const rawPct = sig.direction === 'Long'
                    ? (exitP - sig.signalPrice) / sig.signalPrice * 100
                    : (sig.signalPrice - exitP) / sig.signalPrice * 100;
                const netPct = rawPct - SHADOW_FEE_PCT; // 수수료 차감
                const lev = sig.leverage || 1;
                sig.status = 'closed';
                sig.exitPrice = exitP;
                sig.exitTimestamp = now;
                sig.pnlPercent = netPct;
                sig.pnlLevPercent = netPct * lev;
                sig.pnlDollar = SHADOW_MARGIN * (netPct / 100) * lev;
                sig.reasonForExit = reason;
                changed = true;
            };

            // ★ v52.84: FIX #1 — 24h 타임아웃 제거 (실전과 동일: TP/SL로만 청산)

            // TP/SL 체크
            if (sig.virtualTp && sig.virtualSl) {
                if (sig.direction === 'Long') {
                    if (price >= sig.virtualTp) {
                        closeShadow(sig.virtualTp, 'shadow_tp');
                    } else if (price <= sig.virtualSl) {
                        closeShadow(sig.virtualSl, 'shadow_sl');
                    }
                } else { // Short
                    if (price <= sig.virtualTp) {
                        closeShadow(sig.virtualTp, 'shadow_tp');
                    } else if (price >= sig.virtualSl) {
                        closeShadow(sig.virtualSl, 'shadow_sl');
                    }
                }
            }
        }

        if (changed) {
            this.state.shadowSignals = this.shadowSignals;
            this.saveShadowSignals();
            // ★ v53.4: 자동 CSV 내보내기 (30분 쿨다운)
            this.autoExportShadowCSV();
        }
    }

    // ★ v52.94: 소급 TP/SL 추적 — 진입 시점부터 현재까지 1분봉으로 확인
    public async retroactiveTPSLCheck(): Promise<{ checked: number; tpHit: number; slHit: number; unchanged: number; errors: number }> {
        const openSigs = this.shadowSignals.filter(s => s.status === 'open' && s.virtualTp && s.virtualSl);
        let tpHit = 0, slHit = 0, unchanged = 0, errors = 0;
        const BATCH = 3;
        const SHADOW_MARGIN = 100;
        const SHADOW_FEE_PCT = 0.19;

        for (let i = 0; i < openSigs.length; i += BATCH) {
            const batch = openSigs.slice(i, i + BATCH);
            await Promise.all(batch.map(async (sig) => {
                try {
                    const entryTime = sig.signalTimestamp;
                    const now = Date.now();
                    const minutesSinceEntry = Math.ceil((now - entryTime) / 60000);
                    if (minutesSinceEntry < 2) { unchanged++; return; }

                    // 최대 1000바 (API 제한), 오래된 건 여러 번 요청
                    const limit = Math.min(minutesSinceEntry, 1000);
                    const klines = await bybitService.fetchSingleTimeframeKlines(
                        sig.ticker, '1m' as any, limit, entryTime
                    );
                    if (!klines || klines.length === 0) { unchanged++; return; }

                    // 시간순으로 TP/SL 도달 여부 확인
                    for (const bar of klines) {
                        let hitTp = false, hitSl = false;
                        if (sig.direction === 'Long') {
                            hitTp = bar.high >= sig.virtualTp!;
                            hitSl = bar.low <= sig.virtualSl!;
                        } else {
                            hitTp = bar.low <= sig.virtualTp!;
                            hitSl = bar.high >= sig.virtualSl!;
                        }

                        // 같은 바에서 TP/SL 동시 도달 시 — SL 우선 (보수적)
                        if (hitTp && hitSl) {
                            hitSl = true; hitTp = false;
                        }

                        if (hitTp || hitSl) {
                            const exitP = hitTp ? sig.virtualTp! : sig.virtualSl!;
                            const rawPct = sig.direction === 'Long'
                                ? (exitP - sig.signalPrice) / sig.signalPrice * 100
                                : (sig.signalPrice - exitP) / sig.signalPrice * 100;
                            const netPct = rawPct - SHADOW_FEE_PCT;
                            const lev = sig.leverage || 1;
                            sig.status = 'closed';
                            sig.exitPrice = exitP;
                            sig.exitTimestamp = bar.time;
                            sig.pnlPercent = netPct;
                            sig.pnlLevPercent = netPct * lev;
                            sig.pnlDollar = SHADOW_MARGIN * (netPct / 100) * lev;
                            sig.reasonForExit = hitTp ? 'shadow_tp' : 'shadow_sl';
                            if (hitTp) tpHit++; else slHit++;
                            break;
                        }
                    }
                    if (sig.status === 'open') unchanged++;
                } catch {
                    errors++;
                }
            }));
            // API 레이트 리밋 방지
            if (i + BATCH < openSigs.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        this.state.shadowSignals = this.shadowSignals;
        this.saveShadowSignals();
        this.emitState(true);
        return { checked: openSigs.length, tpHit, slHit, unchanged, errors };
    }

    // ── Utility ──

    private emitState(force = false) {
        const now = Date.now();
        if (!force && now - this.lastStateEmitTime < 200) return;
        this.lastStateEmitTime = now;
        this.eventEmitter.emit('botStateUpdate', { ...this.state, maxPositions: this.maxPositions, tickerParamRegistry: this.tickerParamRegistry, lastScanStatuses: this.scanStatuses });
    }

    private updateSessionStats() {
        const closed = this.state.openPositions.filter(p => p.status === 'closed');
        const wins = closed.filter(p => (p.pnl || 0) > 0).length;
        const total = closed.length;
        this.state.sessionStats.totalTrades = total;
        this.state.sessionStats.winRate = total > 0 ? (wins / total) * 100 : 0;
        this.state.sessionStats.realizedPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
        this.state.sessionStats.sessionPnl = this.state.sessionStats.realizedPnl;
    }

    private heartbeat() {
        const now = Date.now();
        const openCount = this.state.openPositions.filter(p => p.status === 'open').length;
        const waitingCount = this.state.waitingCandidates.length;
        const timeSinceEntry = Math.floor((now - this.lastEntryTime) / 60000);
        const reserved = this.state.reservedProfits;
        const tradable = Math.max(this.state.totalEquity * 0.30, this.state.totalEquity - reserved);
        this.eventEmitter.emit('newMessage', 'system',
            `🩺 [Heartbeat] Equity=$${this.state.totalEquity.toFixed(2)} | ` +
            `Tradable=$${tradable.toFixed(2)}${reserved > 0 ? ` (보호=$${reserved.toFixed(2)})` : ''} | ` +
            `Pos=${openCount}/${this.maxPositions} | Waiting=${waitingCount} | ` +
            `LastEntry=${timeSinceEntry}분전`,
            'system_state'
        );

        // ExecLock 자동 해제 (60초+)
        if (this.isGlobalExecutionLocked && this.executionLockedSince > 0 &&
            now - this.executionLockedSince > 60000) {
            this.isGlobalExecutionLocked = false;
            this.executionLockedSince = 0;
        }
    }

    private async bootDiagnostics() {
        try {
            const acct = await bybitService.fetchAccountState();
            if (acct) {
                this.state.totalEquity = acct.totalEquity;
                this.state.availableBalance = acct.availableBalance;
                if (this.state.sessionStats.initialEquity === 0) {
                    this.state.sessionStats.initialEquity = acct.totalEquity;
                }

                // ── 부팅 시 기존 포지션 동기화 ──
                // 봇 시작 전에 이미 열려있는 포지션을 state에 반영
                const livePositions = acct.openPositions || [];
                if (livePositions.length > 0) {
                    const existingTickers = new Set(
                        this.state.openPositions
                            .filter(p => p.status === 'open')
                            .map(p => p.ticker)
                    );

                    let imported = 0;
                    for (const liveP of livePositions) {
                        if (existingTickers.has(liveP.ticker)) continue;

                        // 거래소에서 가져온 포지션을 state에 추가
                        liveP.status = 'open';
                        if (!liveP.openTimestamp || liveP.openTimestamp <= 0) {
                            liveP.openTimestamp = Date.now();
                        }
                        if (!liveP.localStartTime) {
                            liveP.localStartTime = Date.now();
                        }
                        // analytics 초기화 (없을 경우)
                        if (!liveP.analytics) {
                            (liveP as any).analytics = {
                                entryMethod: 'BOOT_SYNC',
                                maxFavorableExcursion: 0,
                                maxAdverseExcursion: 0,
                                timeToMaxProfit: 0,
                                holdingDurationMinutes: 0,
                                pricePathSummary: [],
                            };
                        }

                        // ★ v52.22: 부팅 시 18-way 기준 stats 주입
                        if (!liveP.registryStats) {
                            const tickerReg = this.tickerParamRegistry[liveP.ticker];
                            if (tickerReg) {
                                // entryTimeSegmentKey → 18-way 정확 매칭
                                let src: any = tickerReg;
                                if (liveP.entryTimeSegmentKey && tickerReg.timeSegmentEntries) {
                                    const tsEntry = tickerReg.timeSegmentEntries[liveP.entryTimeSegmentKey];
                                    if (tsEntry) src = tsEntry;
                                }
                                const wr = src.winRate ?? 0;
                                const avgW = src.avgWin ?? 0;
                                const avgL = src.avgLoss ?? 0;
                                liveP.registryStats = {
                                    winRate: wr,
                                    pnl: src.pnl ?? 0,
                                    trades: src.trades ?? 0,
                                    avgWin: avgW,
                                    avgLoss: avgL,
                                    ev: (wr / 100 * avgW) + ((100 - wr) / 100 * avgL),
                                    maxDD: (src as any).maxDD ?? 0,
                                    avgHoldMin: (src as any).avgHoldingMin ?? 0,
                                };
                            }
                        }

                        this.state.openPositions.push(liveP);
                        imported++;
                    }

                    if (imported > 0) {
                        this.eventEmitter.emit('newMessage', 'system',
                            `🔄 [Boot Sync] 기존 포지션 ${imported}건 동기화 완료\n` +
                            `  ${livePositions.map(p => `${p.ticker} ${p.direction} @${p.entryPrice}`).join('\n  ')}`,
                            'system_state'
                        );
                    }
                }

                this.eventEmitter.emit('newMessage', 'system',
                    `🔑 [Boot] 계정 연결 OK | Equity: $${acct.totalEquity.toFixed(2)} | Pos: ${livePositions.length}건`,
                    'system_state'
                );

                // ── 부팅 시 SL 누락 포지션 자동 보호 ──
                if (livePositions.length > 0) {
                    let slFixed = 0;
                    for (const liveP of livePositions) {
                        try {
                            const posInfo = await bybitService.fetchPosition(liveP.ticker);
                            if (!posInfo || posInfo.size === 0) continue;
                            if (posInfo.stopLoss && posInfo.stopLoss > 0) continue; // SL 있음 → OK

                            // SL 없음 → 백테스트 레버리지 기준 SL 설정
                            const entry = posInfo.entryPrice;
                            const direction = posInfo.direction as 'Long' | 'Short';
                            const leverage = posInfo.leverage || 20;

                            // ★ 백테스트 레버리지 조회 (레지스트리에서)
                            const regEntry = this.tickerParamRegistry[liveP.ticker];
                            const backtestLev = regEntry?.params?.leverageTrending ?? leverage;
                            // ★ SL은 백테스트 레버리지 기준 (실전-백테 SL 일치)
                            const slPercent = 0.50 / backtestLev;
                            const slDist = entry * slPercent;

                            const slPrice = direction === 'Long'
                                ? entry - slDist
                                : entry + slDist;
                            const slStr = await bybitService.adjustPriceByTick(liveP.ticker, slPrice);

                            await bybitService.setPositionTPSL({
                                ticker: liveP.ticker,
                                stopLoss: slStr,
                                tpslMode: 'Full',
                            });

                            // 로컬 Trade 객체에도 반영
                            const localPos = this.state.openPositions.find(
                                p => p.ticker === liveP.ticker && p.status === 'open'
                            );
                            if (localPos) localPos.invalidationPrice = parseFloat(slStr);

                            slFixed++;
                            this.eventEmitter.emit('newMessage', 'system',
                                `🛡️ [Boot SL] ${liveP.ticker} ${direction} SL 누락 → 자동 설정: ${slStr} (백테${backtestLev}x→SL ${(slPercent * 100).toFixed(2)}%)`,
                                'system_state');
                        } catch (e) {
                            console.error(`[Boot SL] ${liveP.ticker} SL 점검 실패:`, e);
                        }
                    }
                    if (slFixed > 0) {
                        this.eventEmitter.emit('newMessage', 'system',
                            `🛡️ [Boot SL] ${slFixed}건 포지션 SL 자동 보호 완료`, 'system_state');
                    }
                }
            }
        } catch (e) {
            this.eventEmitter.emit('newMessage', 'system',
                `🚨 [Boot] 계정 연결 실패: ${(e as Error).message}`, 'error');
        }

        // Config 상태 출력
        const cfg = this.tradingConfig;
        this.eventEmitter.emit('newMessage', 'system',
            `🔧 [Config] Direction: L×${cfg.directionBias.longMultiplier} S×${cfg.directionBias.shortMultiplier} | ` +
            `TP/SL: TP×${cfg.tpSlRatio.tpMultiplier} SL×${cfg.tpSlRatio.slMultiplier}`,
            'system_state'
        );
    }
}
