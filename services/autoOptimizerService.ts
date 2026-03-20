/**
 * AutoOptimizerService — Ignition Walk-Forward 자동 최적화 루프
 *
 * 사이클:
 *   1. IGNITION Walk-Forward (1개월학습+1주검증, 9개월, 1종목순차)
 *   2. 합격 기준 충족 → 레지스트리 적용
 *   3. 미달 → 3초 후 다음 종목 로테이션
 */

import { OptimizerEngine, OPTIMIZER_PRESETS, IGNITION_WF_WEIGHTS, type FitnessMode } from './optimizerEngine';
import * as bybitService from './bybitService';
import type {
    TradingConfig, BacktestParams, OptimizerComboResult,
    OptimizerSummary, AutoOptimizerState, AutoOptMode, TickerParamEntry,
    OptimizerParamRange, TradeDNA, DnaStats, DnaComboStats, DnaAnalysis,
    BacktestTrade, BacktestTickerResult, SimpleRegime, TickerDnaProfile,
    RegimeParamEntry, EntryType, RegimeEntryKey, WalkForwardSummary,
    Session, DayType, TimeSegmentKey, KlineData,
} from '../types';
import {
    getDefaultBacktestParams, applyParamsToConfig,
    makeRegimeEntryKey, getEntryTypeFromTrade, ALL_REGIME_ENTRY_KEYS, parseRegimeEntryKey,
    ALL_SESSIONS, ALL_DAYTYPES, makeTimeSegmentKey, ALL_TIME_SEGMENT_KEYS,
    getSessionAndDayType,
} from '../types';

const HALTED_WAIT_MS = 3 * 60 * 1000;    // 기준 미달 → 3분 후 재시도
const REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 레지스트리 TTL 7일 (전종목 한바퀴 충분)
const POSITION_POLL_MS = 3000;            // 포지션 감시 주기 3초
const WATCH_TIMEOUT_MS = 60 * 60 * 1000;  // 포지션 감시 최대 1시간
const VAL_PNL_THRESHOLD = 60;             // valPnlPercent >= 60% (compositeScore 없을 때 fallback)
const COMPOSITE_SCORE_THRESHOLD = 0.45;   // 종합점수 0.45 이상 (max ~1.0)
const TICKER_MONITOR_MS = 60 * 1000;      // 종목 모니터링 주기 60초
const TICKER_CHANGE_THRESHOLD = 0.5;      // 50% 이상 종목 변경 시 재최적화
const MIN_VOLUME_USD = 500_000;           // ★ 최소 거래량 50만$ → 바이빗 전종목 커버
const REGISTRY_STORAGE_KEY = 'ticker_param_registry_v1';  // ★ v36: 레지스트리 영속화

// ★ EV(기대값) 계산 — 승률 × R:R 동시 반영, 건당 기대 수익률
function calcEV(winRate: number, avgWin: number, avgLoss: number): number {
    return (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
}

// ★ v52.62: WR/EV 필터 제거 — 레짐×방향 차단이 주 필터
// reverse만 차단 유지 (섀도우 데이터에서 reverse 적자 확인)
function evaluateQualification(trades: number, winRate: number, ev: number, shadowOverride?: boolean, mode?: string, _regime?: string): { qualified: boolean; disqualifyReason?: string } {
    if (shadowOverride) return { qualified: true };
    if (trades < 1) return { qualified: false, disqualifyReason: `거래 0건` };
    if (mode === 'reverse') return { qualified: false, disqualifyReason: `reverse 모드 차단` };
    return { qualified: true };
}

// ★ v36: 레지스트리 localStorage 저장/로드
function saveRegistryToStorage(registry: Record<string, TickerParamEntry>): void {
    try {
        localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(registry));
    } catch {}
}

function loadRegistryFromStorage(): Record<string, TickerParamEntry> | null {
    try {
        const raw = localStorage.getItem(REGISTRY_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, TickerParamEntry>;
        // TTL 체크: 너무 오래된 항목 제거
        const now = Date.now();
        for (const [ticker, entry] of Object.entries(parsed)) {
            if (now - entry.updatedAt > REGISTRY_TTL_MS) {
                delete parsed[ticker];
            }
        }
        return Object.keys(parsed).length > 0 ? parsed : null;
    } catch { return null; }
}

function clearRegistryStorage(): void {
    try { localStorage.removeItem(REGISTRY_STORAGE_KEY); } catch {}
}

type StatusListener = (state: AutoOptimizerState) => void;

export class AutoOptimizerService {
    private enabled = false;
    private mode: AutoOptMode = 'ignition-wf';
    private running = false;
    private aborted = false;
    private cycleCount = 0;
    private lastCycleTime: number | null = null;
    private nextCycleTime: number | null = null;
    private waitTimerId: ReturnType<typeof setTimeout> | null = null;
    private countdownId: ReturnType<typeof setInterval> | null = null;
    private positionWatchId: ReturnType<typeof setInterval> | null = null;
    private currentEngine: OptimizerEngine | null = null;
    private error: string | null = null;
    private progressMsg = '';
    private progressPct = 0;
    private lastResult: AutoOptimizerState['lastResult'] = null;
    private phase: AutoOptimizerState['phase'] = 'idle';
    private positionCountAtApply = 0; // 적용 시점 포지션 수 기록
    private targetPositionCount = 0;  // 목표 포지션 수 (maxPositions)

    // 종목 모니터
    private tickerMonitorId: ReturnType<typeof setInterval> | null = null;
    private lastTopTickers: string[] = [];   // 마지막으로 감지한 상위 종목
    private tickerMonitorTopN = 20;          // 모니터링 종목 수

    // 마지막 사이클 전체 결과 (Top 10 랭킹 표시용)
    private lastSummaries: AutoOptimizerState['lastSummaries'] = null;
    // ★ DNA 분석 결과 (UI 표시용)
    private lastDnaAnalysis: DnaAnalysis | null = null;

    // ★ 누적 종목별 파라미터 레지스트리 (사이클마다 머지, stop() 시 초기화)
    private accumulatedRegistry: Record<string, TickerParamEntry> = {};
    // ★ v53.0: dual 20x 레지스트리 제거 — WF가 [5,14,20] 중 최적 1개 선택

    // ★ 사용자 커스텀 옵티마이저 변수 범위 (UI에서 편집)
    private customRanges: Record<string, OptimizerParamRange[]> = {};

    // ★ 미세 최적화 진행 상황 (UI 표시용)
    private fineTuneProgress: AutoOptimizerState['fineTuneProgress'] = undefined;


    private listeners: Set<StatusListener> = new Set();

    // 외부 의존성 (AdminView에서 주입)
    private applyLiveParams: (config: TradingConfig, extra?: { maxPositions?: number; tickerParamRegistry?: Record<string, TickerParamEntry>; dnaFilters?: DnaComboStats[]; dnaPositiveFilters?: DnaComboStats[]; tickerDnaProfiles?: Record<string, TickerDnaProfile> }) => void;
    private getTradingConfig: () => TradingConfig;
    private emitMessage: (participant: string, text: string, type: string) => void;
    private getPositionCount: () => number;
    private lastDnaFilters: DnaComboStats[] = [];  // ★ DNA 회피 조건 저장
    private lastDnaPositiveFilters: DnaComboStats[] = [];  // ★ DNA 긍정 필터 (EV 상위 조건)

    // ★ v52.11: 종목 로테이션 — 타임스탬프 포함 (6시간 후 만료 → 재탐색)
    private _wfProcessedTickers: Map<string, number> = new Map();  // ticker → processedAt (ms)
    private static readonly WF_TICKER_EXPIRY_MS = 6 * 60 * 60 * 1000;  // 6시간
    private lastTickerDnaProfiles: Record<string, TickerDnaProfile> = {};  // ★ 종목별 DNA 프로파일

    // ★ v52.13: 세션 전환 — 30분 전 자동저장 + 캐시 클리어 + 새 세션 WF 시작
    private _currentSession: string | null = null;
    private _sessionTransitionTimerId: ReturnType<typeof setTimeout> | null = null;

    // ★ v52.42: 마스터 종목 리스트 — 시작 시 1회 조회, 순차 소비
    private _masterTickerList: string[] = [];
    private _masterTickerIndex: number = 0;

    // ★ v52.47: 섀도우 모드 — WF 기준 완화 (데이터 수집 목적)
    private _shadowMode = false;
    public setShadowMode(enabled: boolean): void { this._shadowMode = enabled; }

    // ★ v52.56: WF 윈도우별 bestParams 콜백
    public emitWfWindows?: (records: import('../types').WfWindowRecord[]) => void;

    constructor(deps: {
        applyLiveParams: (config: TradingConfig, extra?: { maxPositions?: number; tickerParamRegistry?: Record<string, TickerParamEntry>; dnaFilters?: DnaComboStats[]; dnaPositiveFilters?: DnaComboStats[]; tickerDnaProfiles?: Record<string, TickerDnaProfile> }) => void;
        getTradingConfig: () => TradingConfig;
        emitMessage: (participant: string, text: string, type: string) => void;
        getPositionCount: () => number;
    }) {
        this.applyLiveParams = deps.applyLiveParams;
        this.getTradingConfig = deps.getTradingConfig;
        this.emitMessage = deps.emitMessage;
        this.getPositionCount = deps.getPositionCount;
    }

    // ── v52.13: 세션 전환 자동 관리 ──

    /** 세션 전환 타이머 시작 — 매 세션 시작 30분 전에 저장 + 캐시 클리어 + 재스캔 */
    startSessionTransitionTimer(): void {
        if (this._sessionTransitionTimerId) return;  // 이미 실행 중
        const { session } = getSessionAndDayType(Date.now());
        this._currentSession = session;

        const scheduleNext = () => {
            const now = new Date();
            const utcH = now.getUTCHours();
            const utcM = now.getUTCMinutes();
            const currentMin = utcH * 60 + utcM;

            // 세션 시작 시간 (UTC): ASIA=0:00, EUROPE=8:00, US=13:00
            // 30분 전: ASIA=23:30, EUROPE=7:30, US=12:30
            const transitions = [
                { session: 'ASIA' as const, triggerMin: 23 * 60 + 30 },   // UTC 23:30
                { session: 'EUROPE' as const, triggerMin: 7 * 60 + 30 },  // UTC 07:30
                { session: 'US' as const, triggerMin: 12 * 60 + 30 },     // UTC 12:30
            ];

            // 다음 트리거 시간 계산
            let minWait = Infinity;
            let nextSession = '';
            for (const t of transitions) {
                let waitMin = t.triggerMin - currentMin;
                if (waitMin <= 0) waitMin += 24 * 60;  // 내일
                if (waitMin < minWait) {
                    minWait = waitMin;
                    nextSession = t.session;
                }
            }

            const waitMs = minWait * 60 * 1000;
            this.emitMessage('system',
                `🕐 [세션전환] 다음 전환: ${nextSession}장 시작 30분 전 (${minWait}분 후)`,
                'system_state');

            this._sessionTransitionTimerId = setTimeout(() => {
                this._sessionTransitionTimerId = null;
                this.handleSessionTransition(nextSession);
                // 다음 전환 스케줄
                setTimeout(() => scheduleNext(), 35 * 60 * 1000);  // 35분 후 다음 스케줄
            }, waitMs);
        };

        scheduleNext();
    }

    /** ★ v52.92: 세션 전환 — 캐시 유지 + 누적 (WF 결과가 세션 무관하므로 클리어 불필요) */
    private handleSessionTransition(nextSession: string): void {
        const prevSession = this._currentSession || 'UNKNOWN';
        const regCount = Object.keys(this.accumulatedRegistry).length;
        this.emitMessage('system',
            `🔄 [세션전환] ${prevSession}장 → ${nextSession}장 (레지스트리 ${regCount}종목 유지, 캐시 클리어 없음)`,
            'system_state');

        // ★ v52.92: 캐시 클리어 완전 제거 — 종목별 파라미터 누적 유지
        // 세션 전환해도 기존 레지스트리 그대로 사용
        this._currentSession = nextSession;

        // ★ v52.92: 150종목 전부 완료 시에만 새 WF 시작 (미완료 종목 계속)
        this._currentSession = nextSession;
        if (this.enabled && this.phase === 'completed') {
            // 마스터 리스트 소진 시에만 새로 조회
            this._masterTickerList = [];
            this._masterTickerIndex = 0;
            this._wfProcessedTickers.clear();
            this.runIgnitionWfCycle();
        }
    }

    stopSessionTransitionTimer(): void {
        if (this._sessionTransitionTimerId) {
            clearTimeout(this._sessionTransitionTimerId);
            this._sessionTransitionTimerId = null;
        }
    }

    // ── 구독 (React 연동) ──

    subscribe(listener: StatusListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** ★ 종목 재최적화 요청 — 2연패 등으로 해당 종목 파라미터 삭제 후 재탐색 유도 */
    requestTickerReopt(ticker: string): void {
        if (this.accumulatedRegistry[ticker]) {
            delete this.accumulatedRegistry[ticker];
            this.emitMessage('system',
                `🔄 [재최적화] ${ticker} 레지스트리에서 삭제 → 다음 사이클에서 재탐색`,
                'system_state',
            );
        }
    }

    getState(): AutoOptimizerState {
        return {
            enabled: this.enabled,
            mode: this.mode,
            phase: this.phase,
            cycleCount: this.cycleCount,
            lastCycleTime: this.lastCycleTime,
            nextCycleTime: this.nextCycleTime,
            waitRemainingMs: this.nextCycleTime ? Math.max(0, this.nextCycleTime - Date.now()) : 0,
            lastResult: this.lastResult,
            error: this.error,
            progressMsg: this.progressMsg,
            progressPct: this.progressPct,
            lastSummaries: this.lastSummaries,
            dnaAnalysis: this.lastDnaAnalysis,
            fineTuneProgress: this.fineTuneProgress,
        };
    }

    private emitStatus(): void {
        const state = this.getState();
        for (const listener of this.listeners) {
            try { listener(state); } catch { /* ignore */ }
        }
    }

    // ── 커스텀 옵티마이저 변수 ──

    /** UI에서 편집한 변수 범위 설정 */
    setCustomRanges(_mode: AutoOptMode, ranges: OptimizerParamRange[]): void {
        this.customRanges['ignition-wf'] = ranges;
        // localStorage에도 저장
        try { localStorage.setItem(`optRanges_ignition-wf`, JSON.stringify(ranges)); } catch { /* ignore */ }
    }

    /** 현재 커스텀 변수 범위 반환 (없으면 프리셋 기본값) */
    getCustomRanges(_mode?: AutoOptMode): OptimizerParamRange[] {
        if (this.customRanges['ignition-wf']) return this.customRanges['ignition-wf'];
        // localStorage에서 복원 시도
        try {
            const saved = localStorage.getItem(`optRanges_ignition-wf`);
            if (saved) {
                const parsed = JSON.parse(saved) as OptimizerParamRange[];
                this.customRanges['ignition-wf'] = parsed;
                return parsed;
            }
        } catch { /* ignore */ }
        // 기본 프리셋
        return [...OPTIMIZER_PRESETS['ignition-wf'].ranges] as unknown as OptimizerParamRange[];
    }

    // ── 제어 ──

    start(mode: AutoOptMode = 'ignition-wf'): void {
        if (this.enabled) return;
        this.enabled = true;
        this.mode = mode;
        this.phase = 'idle';
        this.error = null;
        try {
            localStorage.setItem('autoOptEnabled', 'true');
            localStorage.setItem('autoOptMode', mode);
        } catch { /* ignore */ }

        // ★ v36: 저장된 레지스트리 로드 → 즉시 진입 가능
        const savedRegistry = loadRegistryFromStorage();
        if (savedRegistry && Object.keys(savedRegistry).length > 0) {
            this.accumulatedRegistry = savedRegistry;
            const baseConfig = this.getTradingConfig();
            const qualifiedCount = Object.values(savedRegistry).filter(e => e.qualified).length;
            const maxPos = 1;
            this.applyLiveParams(baseConfig, { maxPositions: maxPos, tickerParamRegistry: savedRegistry });
            this.emitMessage('system',
                `🤖 [AutoOpt] 💾 저장된 레지스트리 로드 (${qualifiedCount}종목) → 즉시 진입 가능`,
                'system_state');
        } else {
            // 첫 백테스팅 완료 전까지 진입 차단
            const baseConfig = this.getTradingConfig();
            this.applyLiveParams(baseConfig, { maxPositions: 0 });
        }

        this.emitStatus();
        // ★ IGNITION Walk-Forward — 1개월 학습 + 1주 검증 × 72윈도우 롤링
        this.emitMessage('system', `🤖 [AutoOpt] 🎯 Ignition WF 시작 — 9개월, 1종목순차${savedRegistry ? ' (캐시 즉시 적용)' : ' (백테스팅 완료 전 진입 차단)'}`, 'system_state');
        this.startTickerMonitor();
        this.startSessionTransitionTimer();  // ★ v52.13: 세션 전환 타이머
        this.runIgnitionWfCycle();
    }

    stop(): void {
        this.enabled = false;
        this.aborted = true;
        if (this.currentEngine) {
            this.currentEngine.abort();
        }
        this.clearAllTimers();
        this.stopTickerMonitor();
        this.stopSessionTransitionTimer();  // ★ v52.13
        this.phase = 'idle';
        this.nextCycleTime = null;
        this.accumulatedRegistry = {};  // ★ 누적 레지스트리 초기화
        this._wfProcessedTickers.clear();  // ★ WF 로테이션 리셋
        try { localStorage.setItem('autoOptEnabled', 'false'); localStorage.removeItem('autoOptMode'); } catch { /* ignore */ }
        this.emitStatus();
        this.emitMessage('system', '🤖 [AutoOpt] 자동 최적화 중지 (레지스트리 초기화)', 'system_state');
    }

    destroy(): void {
        this.stop();
        this.stopTickerMonitor();
        this.listeners.clear();
    }

    private clearAllTimers(): void {
        if (this.waitTimerId) { clearTimeout(this.waitTimerId); this.waitTimerId = null; }
        if (this.countdownId) { clearInterval(this.countdownId); this.countdownId = null; }
        if (this.positionWatchId) { clearInterval(this.positionWatchId); this.positionWatchId = null; }
    }

    // ── ★ IGNITION Walk-Forward 전용 사이클 ──
    //
    // 9개월 데이터를 1개월 학습 + 1주 검증으로 롤링.
    // 각 윈도우에서 normal+reverse 양방향 32조합 Grid Search.
    // median testPnl 윈도우의 파라미터를 최종 선택.
    // IGNITION 진입타입만 6way/18way 세그먼트 생성.

    private async runIgnitionWfCycle(): Promise<void> {
        if (!this.enabled || this.running) return;
        this.running = true;
        this.aborted = false;
        this.cycleCount++;
        this.error = null;

        const baseConfig = this.getTradingConfig();
        const baseParams = {
            ...getDefaultBacktestParams(baseConfig),
            maxPositions: 1,
            baseSizePercent: 85,
            scoreThreshold: 60,
            reverseMode: false,
        };
        const preset = OPTIMIZER_PRESETS['ignition-wf'];
        const ranges = [...preset.ranges] as unknown as OptimizerParamRange[];

        // ★ v52.96: 섀도우 모드 → WF 2회 실행 (5x + 20x 각각 최적화)
        // 레버리지에 따라 최적 TP배수가 달라지므로 별도 WF 필요
        // 각 결과를 _shadowLevRegistries에 저장 → 시그널 기록 시 2건씩
        // ★ v53.0: shadowDualLev 제거 — WF [5,14,20] 범위가 자동 처리

        let wasApplied = false;

        try {
            this.phase = 'running-wf';

            // ★ v52.42: 마스터 종목 리스트 — 처음이거나 소진되면 150개 조회
            if (this._masterTickerList.length === 0 || this._masterTickerIndex >= this._masterTickerList.length) {
                this.progressMsg = '변동성 상위 150개 종목 조회 중...';
                this.progressPct = 0;
                this.emitStatus();
                const bybit = await import('./bybitService');
                const tickers = await bybit.fetchMarketTickers();
                const allMovers = tickers
                    .filter((t: any) => t.symbol.endsWith('USDT') && t.volume >= 500000)
                    .sort((a: any, b: any) => Math.abs(b.rawChangePercent) - Math.abs(a.rawChangePercent))
                    .slice(0, 150)
                    .map((t: any) => t.symbol);
                this._masterTickerList = allMovers;
                this._masterTickerIndex = 0;
                this.emitMessage('system',
                    `📋 [종목리스트] 변동성 상위 ${allMovers.length}개 종목 조회 완료`,
                    'system_state',
                );
            }

            // 이미 처리한 종목 스킵하며 다음 종목 선택
            const processedKeys = [...this._wfProcessedTickers.keys()];
            const registryKeys = Object.keys(this.accumulatedRegistry);
            const savedReg = loadRegistryFromStorage();
            const savedKeys = savedReg ? Object.keys(savedReg) : [];
            const allExclude = new Set([...processedKeys, ...registryKeys, ...savedKeys]);

            let nextTicker: string | null = null;
            while (this._masterTickerIndex < this._masterTickerList.length) {
                const candidate = this._masterTickerList[this._masterTickerIndex];
                this._masterTickerIndex++;
                if (!allExclude.has(candidate)) {
                    nextTicker = candidate;
                    break;
                }
            }

            if (!nextTicker) {
                // ★ v52.43: 150개 소진 → WF 완료, 스캔만 유지 (리셋 안 함)
                this.phase = 'completed';
                this.progressMsg = '✅ 150종목 최적화 완료 — 스캔 모드';
                this.progressPct = 100;
                this.emitStatus();
                this.emitMessage('system',
                    `✅ [종목리스트] 150개 종목 최적화 전체 완료\n` +
                    `  레지스트리: ${Object.keys(this.accumulatedRegistry).filter(k => this.accumulatedRegistry[k].qualified).length}종목 적격\n` +
                    `  → 신규 WF 중단, 기존 파라미터로 스캔+진입만 유지`,
                    'system_state',
                );
                return;
            }

            this.progressMsg = `WF 시작: ${nextTicker} (${this._masterTickerIndex}/${this._masterTickerList.length}) | ${allExclude.size}종목 완료`;
            this.progressPct = 0;
            this.emitStatus();

            // Walk-Forward Long 실행 — forceTickers로 1종목 직접 전달
            const engine = new OptimizerEngine((msg, pct) => {
                this.progressMsg = `WF: ${msg}`;
                this.progressPct = Math.round(pct * 0.85);
                this.emitStatus();
            });
            this.currentEngine = engine;

            const wfSummary: WalkForwardSummary = await engine.runWalkForwardLong(
                baseConfig, baseParams, ranges, 1,
                {
                    totalKlines: 389000,    // 9개월
                    trainBars: 43200,       // 30일
                    testBars: 10080,        // 7일
                    stepBars: 10080,        // 7일 (★ v52.52: 실전 동일 촘촘한 검증)
                    fitnessMode: preset.fitnessMode as FitnessMode,
                    minTestTrades: 10,
                    forceTickers: [nextTicker],  // ★ v52.42: 마스터 리스트에서 1종목 직접 전달
                },
            );

            // ★ v52.11: 처리한 종목 기록 (타임스탬프 포함) → 6시간 후 만료
            const processedAt = Date.now();
            for (const t of wfSummary.processedTickers ?? wfSummary.cachedTickers) {
                this._wfProcessedTickers.set(t, processedAt);
            }

            if (this.aborted) throw new Error('중단됨');

            // ★ v52.56: WF 윈도우별 bestParams 기록 (선택방식 비교용)
            const wfTicker = (wfSummary.processedTickers ?? wfSummary.cachedTickers)?.[0] ?? '?';
            const wfWindowRecords: import('../types').WfWindowRecord[] = wfSummary.windows.map(w => ({
                ticker: wfTicker,
                windowIndex: w.windowIndex,
                trainPnl: w.trainPnl,
                testPnl: w.testPnl,
                testWinRate: w.testWinRate,
                testTrades: w.testTrades,
                testMaxDD: w.testMaxDD,
                selectedMode: w.selectedMode ?? 'normal',
                leverageT: w.bestParams.leverageTrending,
                leverageR: w.bestParams.leverageRanging,
                leverageV: w.bestParams.leverageVolatile,
                tpMultiplier: w.bestParams.tpAtrMultiplier,
                slMultiplier: w.bestParams.slAtrMultiplier,
                shortMultiplier: w.bestParams.shortMultiplier,
                igThreshold: w.bestParams.ignitionScoreThreshold,
                tfConsensus: w.bestParams.minTfConsensus,
            }));
            // state에 누적 (기존 + 신규)
            if (this.emitWfWindows) {
                this.emitWfWindows(wfWindowRecords);
            }

            // ── Walk-Forward 합격 기준 ──
            const totalWindows = wfSummary.windows.length;
            const passingWindows = wfSummary.windowsPassingMinTrades ?? 0;
            const halfWindows = Math.ceil(totalWindows / 2);
            const passesMinTradesCheck = passingWindows >= halfWindows;
            const passesOverfitCheck = wfSummary.overfitRatio < 5.0;

            // 윈도우별 결과 로깅
            const windowLog = wfSummary.windows.map(w =>
                `W${w.windowIndex + 1}(${w.selectedMode === 'reverse' ? '🔄' : '📈'}): ` +
                `학${w.trainPnl >= 0 ? '+' : ''}${w.trainPnl.toFixed(1)}%→검${w.testPnl >= 0 ? '+' : ''}${w.testPnl.toFixed(1)}% ` +
                `(${w.testTrades}건${w.minTestTradesMet ? '' : '⚠️'})`
            ).join('\n  ');

            this.emitMessage('system',
                `🎯 [WF-Long] ${totalWindows}윈도우 완료\n` +
                `  합격: ${passingWindows}/${totalWindows} (최소 ${halfWindows}필요)\n` +
                `  과적합비: ${wfSummary.overfitRatio.toFixed(2)} (${passesOverfitCheck ? '✅<5.0' : '⚠️≥5.0'})\n` +
                `  평균: 학습 ${wfSummary.avgTrainPnl >= 0 ? '+' : ''}${wfSummary.avgTrainPnl.toFixed(2)}% → 검증 ${wfSummary.avgTestPnl >= 0 ? '+' : ''}${wfSummary.avgTestPnl.toFixed(2)}%\n` +
                `  ${windowLog}`,
                'system_state',
            );

            // ★ v52.88: WF 합격 기준 제거 — 백테스트 수치가 실전과 역상관이므로 전부 등록
            // 레짐×방향 차단이 유일한 필터 (세션별 SESSION_REGIME_BLOCKS)
            if (!passesMinTradesCheck || !passesOverfitCheck) {
                this.emitMessage('system',
                    `ℹ️ [WF-Long] 기준 미달이지만 전부 등록 (레짐×방향 필터가 주 필터)\n` +
                    `  거래수: ${passesMinTradesCheck ? '✅' : '⚠️'} (${passingWindows}/${totalWindows})\n` +
                    `  과적합: ${passesOverfitCheck ? '✅' : '⚠️'} (비율 ${wfSummary.overfitRatio.toFixed(2)})`,
                    'system_state',
                );
            }

            // ── 항상 파라미터 레지스트리 구성 (합격/미달 무관) ──
            {
                const selectedParams = wfSummary.selectedParams ?? baseParams;
                this.progressMsg = 'WF 합격 — 레지스트리 구성 중...';
                this.progressPct = 90;
                this.emitStatus();

                // ★ v52.32: WF에서 처리한 종목을 forceTickers로 직접 전달 (fetchTopMovers 스킵)
                const wfTickers = wfSummary.processedTickers ?? wfSummary.cachedTickers ?? [];
                // ★ v53.2: 레버리지 3단계 독립 시뮬 — WF가 5x만 선택해도 14x/20x도 포워드테스트 수집
                const normalParams = { ...selectedParams, reverseMode: false, leverageRanging: 0, leverageVolatile: 0 };
                const reverseParams = { ...selectedParams, reverseMode: true };

                const normalEngine = new OptimizerEngine((msg, pct) => {
                    this.progressMsg = `WF Final Normal: ${msg}`;
                    this.progressPct = 90 + Math.round(pct * 0.05);
                    this.emitStatus();
                });
                this.currentEngine = normalEngine;

                // ★ leverageTrending=[5,14,20] 범위 전달 → 3개 콤보 독립 시뮬 + generateCombos가 R/V 연동
                const leverageRanges: OptimizerParamRange[] = [
                    { key: 'leverageTrending' as const, values: [5, 14, 20], label: 'Lev' },
                ];
                const normalSummary = await normalEngine.run(
                    baseConfig, normalParams, leverageRanges,
                    1, 43200, preset.fitnessMode as FitnessMode,
                    [], wfTickers,
                );
                normalEngine.clearCaches();

                if (this.aborted) throw new Error('중단됨');

                // ★ v53.1: 포워드테스트 항상 기록 (30일 전체, 종목별 엣지 분석용)
                {
                    const reverseSummary = { results: [] as any[], elapsedMs: 0 } as any;
                    this.saveForwardTestTrades(normalSummary, reverseSummary, wfTickers);
                }

                const tickerParamRegistry = this.mergeTickerParamRegistry(
                    normalSummary.results,
                    [],
                );

                const registrySize = Object.keys(tickerParamRegistry).length;
                console.log(`[WF-Debug] mergeResult: ${registrySize}종목, keys: ${Object.keys(tickerParamRegistry).join(',')}`);

                if (registrySize > 0) {
                    // ★ v52.44: 누적 레지스트리에 합산 → 전체 전달
                    for (const [ticker, entry] of Object.entries(tickerParamRegistry)) {
                        this.accumulatedRegistry[ticker] = entry;
                    }
                    const fullRegistry = { ...this.accumulatedRegistry };
                    // ★ v52.88: qualified 무관하게 전체 종목 수 기준
                    const totalCount = Object.keys(fullRegistry).length;

                    const infraConfig = applyParamsToConfig(baseConfig, selectedParams);
                    infraConfig.sizing.baseSizePercent = 85;
                    this.applyLiveParams(infraConfig, {
                        maxPositions: Math.max(1, totalCount),
                        tickerParamRegistry: fullRegistry,
                    });
                    saveRegistryToStorage(fullRegistry);
                    wasApplied = true;

                    // ★ v53.0: dual 20x WF 제거 — WF가 [5,14,20] 범위에서 자동 선택

                    const newTickers = Object.keys(tickerParamRegistry).map(t => t.replace('USDT', '')).join(', ');
                    this.emitMessage('system',
                        `🤖 [WF-Long] ✅ ${newTickers} 추가 → 누적 ${totalCount}종목\n` +
                        `  진행: ${this._masterTickerIndex}/${this._masterTickerList.length}\n` +
                        `  ⏱️ ${(wfSummary.elapsedMs / 60000).toFixed(1)}분 소요`,
                        'system_state',
                    );
                } else {
                    // ★ v52.35: 자격 종목 0개라도 기존 누적 레지스트리 유지
                    this.phase = 'halted';
                    const existingReg2 = { ...this.accumulatedRegistry };
                    const existCount2 = Object.keys(existingReg2).length;
                    if (existCount2 > 0) {
                        this.applyLiveParams(baseConfig, { maxPositions: existCount2, tickerParamRegistry: existingReg2 });
                        this.emitMessage('system',
                            `ℹ️ [WF-Long] 이번 종목 레지스트리 없음 → 기존 ${existCount2}종목 유지`,
                            'system_state',
                        );
                    } else {
                        this.applyLiveParams(baseConfig, { maxPositions: 0, tickerParamRegistry: {} });
                        this.emitMessage('system',
                            `⛔ [WF-Long] 레지스트리 0개 → 신규 진입 차단`,
                            'system_state',
                        );
                    }
                }
            }

            this.lastCycleTime = Date.now();
            this.progressPct = 100;
            this.error = null;

        } catch (err) {
            if (this.aborted) {
                // 사용자 중단
            } else {
                const errMsg = (err as Error).message;
                // ★ v52.11: 모든 종목 소진 → 1시간 쿨다운 후 재스캔 (변동성 상위 종목 갱신)
                // ★ v52.26: 데이터 부족 → 해당 종목 스킵, 즉시 다음 종목
                if (errMsg.includes('데이터 부족') || errMsg.includes('유효한 종목 데이터가 없습니다')) {
                    // ★ v52.33: 에러 종목을 processedTickers에 기록 → 다음 사이클에서 스킵
                    const attempted = (err as any).attemptedTickers as string[] | undefined;
                    if (attempted && attempted.length > 0) {
                        const skipAt = Date.now();
                        for (const t of attempted) {
                            this._wfProcessedTickers.set(t, skipAt);
                        }
                        this.emitMessage('system', `⏭️ [WF-Long] ${attempted.join(',')} 데이터 부족 → 스킵 등록, 다음 종목으로`, 'system_state');
                    } else {
                        this.emitMessage('system', `⏭️ [WF-Long] ${errMsg} → 스킵, 다음 종목으로`, 'system_state');
                    }
                    return;  // scheduleNext에서 3초 후 재시작
                }

                if (errMsg.includes('모두 최적화 완료') || errMsg.includes('조건에 맞는 종목이 없습니다')) {
                    const cooldownMin = 60;
                    this.emitMessage('system',
                        `✅ [WF-Long] ${this._wfProcessedTickers.size}종목 전체 로테이션 완료\n` +
                        `  레지스트리 종목은 재최적화 안 함\n` +
                        `  🔄 ${cooldownMin}분 후 변동성 상위 종목 재스캔 (6시간 지난 종목 자동 만료)`,
                        'system_state',
                    );
                    // 1시간 쿨다운 후 재스캔 스케줄
                    this.phase = 'watching';
                    this.nextCycleTime = Date.now() + cooldownMin * 60 * 1000;
                    this.emitStatus();
                    this.waitTimerId = setTimeout(() => {
                        this.clearAllTimers();
                        if (this.enabled) this.runIgnitionWfCycle();
                    }, cooldownMin * 60 * 1000);
                    return;  // scheduleNext 호출 방지
                } else {
                    this.error = errMsg;
                    this.emitMessage('system', `⚠️ [WF-Long] 오류: ${this.error}`, 'system_state');
                }
            }
        } finally {
            this.running = false;
            this.currentEngine = null;
            this.scheduleNext(wasApplied);
        }
    }

    private pickBest(summary: OptimizerSummary): OptimizerComboResult | null {
        if (!summary.results.length) return null;
        // 우선순위: 수익률 > 생존율 > 종합점수
        const sorted = [...summary.results].sort((a, b) => {
            const pnlDiff = b.valPnlPercent - a.valPnlPercent;
            if (Math.abs(pnlDiff) > 0.1) return pnlDiff;
            const survDiff = b.survivalRate - a.survivalRate;
            if (Math.abs(survDiff) > 0.1) return survDiff;
            return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
        });
        return sorted[0];
    }

    // ── 레짐 일관성 점수 계산 ──

    /**
     * 학습/검증 기간 레짐 일관성 점수 계산 (0-100)
     *
     *  1) 레짐 분포 유사도 (40점) — train/test 레짐 비율 오버랩
     *  2) PnL 방향 일치도  (40점) — 양쪽 PnL 부호 일치 여부
     *  3) 레짐별 PnL 일치도 (20점) — 각 레짐에서 PnL 부호 동일
     */
    private calcRegimeConsistency(
        trainResult: BacktestTickerResult | undefined,
        testResult: BacktestTickerResult,
    ): number {
        if (!trainResult || trainResult.trades.length < 2 || testResult.trades.length < 2) {
            return 0; // 데이터 부족 → 제외
        }

        const REGIMES: SimpleRegime[] = ['TRENDING', 'RANGING', 'VOLATILE'];

        // --- 1) 레짐 분포 유사도 (0-40) ---
        const trainDist = this.getRegimeDist(trainResult.trades);
        const testDist  = this.getRegimeDist(testResult.trades);
        // overlap = 1 - Σ|trainPct - testPct| / 2
        let diffSum = 0;
        for (const r of REGIMES) {
            diffSum += Math.abs((trainDist[r] || 0) - (testDist[r] || 0));
        }
        const overlap = 1 - diffSum / 2; // 0~1
        const distScore = overlap * 40;

        // --- 2) PnL 방향 일치도 (0-40) ---
        const trainPnl = trainResult.totalPnlPercent;
        const testPnl  = testResult.totalPnlPercent;
        let pnlScore: number;
        if (trainPnl >= 0 && testPnl >= 0) {
            pnlScore = 40;      // 양쪽 다 수익 → 최고
        } else if (trainPnl < 0 && testPnl < 0) {
            pnlScore = 20;      // 양쪽 다 손실 → 일관성은 있음
        } else if (trainPnl < 0 && testPnl >= 0) {
            pnlScore = 0;       // ★ 핵심: 학습 손실 + 검증 수익 = 불신
        } else {
            pnlScore = 10;      // 학습 수익 + 검증 손실 = 약간 불신
        }

        // --- 3) 레짐별 PnL 일치도 (0-20) ---
        const trainRegimePnl = this.getRegimePnl(trainResult.trades);
        const testRegimePnl  = this.getRegimePnl(testResult.trades);
        let matchCount = 0;
        let totalRegimes = 0;
        for (const r of REGIMES) {
            if (trainRegimePnl[r] !== undefined && testRegimePnl[r] !== undefined) {
                totalRegimes++;
                if ((trainRegimePnl[r]! >= 0) === (testRegimePnl[r]! >= 0)) {
                    matchCount++;
                }
            }
        }
        const regimePnlScore = totalRegimes > 0
            ? (matchCount / totalRegimes) * 20
            : 10; // 비교 불가 → 중립

        return Math.round(distScore + pnlScore + regimePnlScore);
    }

    /** 레짐 분포 비율 계산 */
    private getRegimeDist(trades: BacktestTrade[]): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const t of trades) {
            counts[t.regime] = (counts[t.regime] || 0) + 1;
        }
        const total = trades.length;
        const dist: Record<string, number> = {};
        for (const [r, c] of Object.entries(counts)) {
            dist[r] = c / total;
        }
        return dist;
    }

    /** 레짐별 합산 PnL */
    private getRegimePnl(trades: BacktestTrade[]): Record<string, number> {
        const pnl: Record<string, number> = {};
        for (const t of trades) {
            pnl[t.regime] = (pnl[t.regime] || 0) + t.pnlPercent;
        }
        return pnl;
    }

    /** ★ 종목별 레짐 성과 집계 (TRENDING/RANGING/VOLATILE별 승률, 평균PnL) */
    private computeRegimeStats(trades: BacktestTrade[]): Record<string, { trades: number; winRate: number; avgPnl: number }> {
        const stats: Record<string, { trades: number; winRate: number; avgPnl: number }> = {};
        const byRegime: Record<string, BacktestTrade[]> = {};
        for (const t of trades) {
            if (!byRegime[t.regime]) byRegime[t.regime] = [];
            byRegime[t.regime].push(t);
        }
        for (const [regime, regTrades] of Object.entries(byRegime)) {
            const wins = regTrades.filter(t => t.pnlPercent > 0).length;
            stats[regime] = {
                trades: regTrades.length,
                winRate: regTrades.length > 0 ? (wins / regTrades.length) * 100 : 0,
                avgPnl: regTrades.length > 0
                    ? regTrades.reduce((s, t) => s + t.pnlPercent, 0) / regTrades.length
                    : 0,
            };
        }
        return stats;
    }

    /** ★ v52.37: 마지막 30일 포워드 테스트 거래 기록 저장 */
    private saveForwardTestTrades(
        normalSummary: OptimizerSummary,
        reverseSummary: OptimizerSummary,
        tickers: string[],
    ): void {
        try {
            const allTrades: any[] = [];
            const addTrades = (summary: OptimizerSummary, mode: string) => {
                for (const combo of summary.results) {
                    // ★ FIX: 학습+검증 구간 모두 포함 (30일 전체)
                    const allResults = [
                        ...((combo as any).trainTickerResults ?? []),
                        ...(combo.tickerResults ?? []),
                    ];
                    if (allResults.length === 0) continue;
                    // ★ v53.2: 콤보 파라미터 기록 (필터/파라미터 유효성 분석용)
                    const cp = combo.params;
                    for (const tr of allResults) {
                        for (const t of tr.trades) {
                            const lev = t.leverage || 1;
                            const rawPct = lev > 0 ? t.pnlPercent / lev : t.pnlPercent; // 레버 제거한 raw%
                            const dna = t.entryDNA;
                            allTrades.push({
                                ticker: t.ticker,
                                direction: t.direction,
                                entryPrice: t.entryPrice,
                                exitPrice: t.exitPrice,
                                entryTime: new Date(t.entryTime).toISOString(),
                                exitTime: new Date(t.exitTime).toISOString(),
                                'pnlPercent(raw)': +rawPct.toFixed(4),
                                'pnlPercent(lev)': +t.pnlPercent.toFixed(4),
                                exitReason: t.exitReason,
                                regime: t.regime,
                                session: t.session ?? '',
                                dayType: t.dayType ?? '',
                                leverage: lev,
                                barsHeld: t.barsHeld,
                                holdingMinutes: t.barsHeld, // 1분봉 기준
                                mode,
                                tp1Price: t.tp1Price,
                                tp2Price: t.tp2Price,
                                slPrice: t.slPrice,
                                directionScore: t.directionScore ?? '',
                                tpDist: t.tp1Price && t.entryPrice ? +((Math.abs(t.tp1Price - t.entryPrice) / t.entryPrice) * 100).toFixed(4) : '',
                                slDist: t.slPrice && t.entryPrice ? +((Math.abs(t.slPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(4) : '',
                                RR: t.tp1Price && t.slPrice && t.entryPrice ?
                                    +(Math.abs(t.tp1Price - t.entryPrice) / Math.abs(t.slPrice - t.entryPrice)).toFixed(3) : '',
                                strategyType: t.strategyType ?? 'IGNITION',
                                // ★ v53.2: DNA 필드 (시장조건 스냅샷 — 필터 분석용)
                                dna_adx: dna?.adx ?? '',
                                dna_adxRange: dna?.adxRange ?? '',
                                dna_rsi: dna?.rsi ?? '',
                                dna_rsiZone: dna?.rsiZone ?? '',
                                dna_emaAlignment: dna?.emaAlignment ?? '',
                                dna_volatility: dna?.volatility ?? '',
                                dna_atrPercent: dna?.atrPercent ? +(dna.atrPercent * 100).toFixed(4) : '',
                                // ★ v53.2: 콤보 파라미터 (어떤 파라미터로 이 거래가 나왔는지)
                                param_tpAtrMult: cp.tpAtrMultiplier,
                                param_igThreshold: cp.ignitionScoreThreshold,
                                param_igBodyMin: cp.ignitionBodyMin,
                                param_tfConsensus: cp.minTfConsensus,
                                param_levT: cp.leverageTrending,
                                param_levR: cp.leverageRanging,
                                param_levV: cp.leverageVolatile,
                            });
                        }
                    }
                }
            };
            addTrades(normalSummary, 'normal');
            addTrades(reverseSummary, 'reverse');

            // ★ 종목별 최신 30일 데이터 유지 — 같은 종목 재최적화 시 기존 데이터 교체
            let existing: any[] = [];
            try {
                const raw = localStorage.getItem('forward_test_trades_v1');
                if (raw) existing = JSON.parse(raw);
            } catch {}
            // ★ v53.2: 종목×레버리지 조합별 교체 (5x/14x/20x 독립 보존)
            const newKeys = new Set(allTrades.map((t: any) => `${t.ticker}_${t.leverage}`));
            const filtered = existing.filter((t: any) => !newKeys.has(`${t.ticker}_${t.leverage}`));
            const merged = [...filtered, ...allTrades].slice(-5000); // ★ v53.2: 5000건 (3x 레버 + DNA 필드로 용량 증가)
            try {
                localStorage.setItem('forward_test_trades_v1', JSON.stringify(merged));
            } catch (quotaErr) {
                // localStorage 5MB 초과 시 절반으로 줄여서 재시도
                console.warn('[ForwardTest] localStorage 용량 초과, 절반으로 축소:', quotaErr);
                const half = merged.slice(-Math.floor(merged.length / 2));
                localStorage.setItem('forward_test_trades_v1', JSON.stringify(half));
            }
            const tickerCounts = new Map<string, number>();
            for (const t of allTrades) { tickerCounts.set(t.ticker, (tickerCounts.get(t.ticker) || 0) + 1); }
            const tickerSummary = [...tickerCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
            console.log(`[ForwardTest] ${allTrades.length}건 저장 (누적 ${merged.length}건) — ${tickerSummary}`);
            this.emitMessage('system',
                `📊 [포워드테스트] ${allTrades.length}건 기록 (${tickers.length}종목 × 30일, 누적 ${merged.length}건)`,
                'system_state',
            );

            // ★ v53.6: 종목별 개별 CSV 자동 내보내기 — localStorage 용량 절약
            this.autoExportTickerCSV(allTrades, tickers);
        } catch (e) {
            console.error('[ForwardTest] 저장 실패:', e);
        }
    }

    /** ★ v53.6: 종목별 개별 CSV 자동 내보내기 — 1종목 WF 완료 시 해당 종목만 파일로 다운로드 */
    private autoExportTickerCSV(trades: any[], tickers: string[]): void {
        if (trades.length === 0) return;
        try {
            // 종목별로 분리
            const byTicker = new Map<string, any[]>();
            for (const t of trades) {
                const tk = t.ticker || 'UNKNOWN';
                if (!byTicker.has(tk)) byTicker.set(tk, []);
                byTicker.get(tk)!.push(t);
            }

            const dateStr = new Date().toISOString().slice(0, 10);
            const headers = Object.keys(trades[0]);
            const bom = '\uFEFF';

            for (const [ticker, tickerTrades] of byTicker) {
                const rows = tickerTrades.map(t =>
                    headers.map(h => JSON.stringify(String(t[h] ?? ''))).join(',')
                );
                const csv = bom + headers.join(',') + '\n' + rows.join('\n');
                const safeTicker = ticker.replace('USDT', '');
                const filename = `fwd_${safeTicker}_${dateStr}.csv`;

                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                console.log(`[ForwardTest] 📥 ${ticker}: ${tickerTrades.length}건 → ${filename}`);
            }
        } catch (e) {
            console.error('[ForwardTest] CSV 내보내기 실패:', e);
        }
    }

    /** ★ 레짐별 독립 콤보 선택 — T/R/V 각각 최적 params + mode 독립 결정 */
    private mergeTickerParamRegistry(
        normalResults: OptimizerComboResult[],
        reverseResults: OptimizerComboResult[],
    ): Record<string, TickerParamEntry> {
        const now = Date.now();
        // TTL은 모듈 상수 REGISTRY_TTL_MS (12시간) 사용
        const REGIMES: SimpleRegime[] = ['TRENDING', 'RANGING', 'VOLATILE'];

        // ★ 1시간 이상 업데이트 없는 종목 폐기
        let expiredCount = 0;
        for (const [ticker, entry] of Object.entries(this.accumulatedRegistry)) {
            if (now - entry.updatedAt > REGISTRY_TTL_MS) {
                delete this.accumulatedRegistry[ticker];
                expiredCount++;
            }
        }
        if (expiredCount > 0) {
            this.emitMessage('system',
                `🗑️ [Registry] ${expiredCount}종목 만료 폐기 (1시간 미갱신)`,
                'system_state',
            );
        }

        let newCount = 0;
        let updatedCount = 0;
        const CONSISTENCY_THRESHOLD = 40;

        // ★ 1단계: 레짐×진입타입 3-way 독립 후보 수집 (Ignition Only)
        // 키: ticker → RegimeEntryKey (예: 'TRENDING_IGNITION') → 최적 RegimeParamEntry
        type RegimeCandidate = RegimeParamEntry & { _comboParams: BacktestParams };
        const regimeCandidateMap = new Map<string, Map<string, RegimeCandidate>>();
        // ★ v36: 18-way 시간 세분화 후보 맵 (ticker → TimeSegmentKey → RegimeCandidate)
        const timeSegmentCandidateMap = new Map<string, Map<TimeSegmentKey, RegimeCandidate>>();
        // ★ ignition-wf 모드: IGNITION만, 기존 모드: 전체
        const ENTRY_TYPES: EntryType[] = ['IGNITION'];
        // 종목별 전체(overall) 최적 후보도 수집 (폴백용 + 기존 필드 채우기)
        type OverallCandidate = {
            params: BacktestParams; mode: 'normal' | 'reverse';
            pnl: number; winRate: number; trades: number;
            trainPnl: number; trainWinRate: number;
            maxDD: number; avgUnderwaterMin: number; avgHoldingMin: number;
            regimeConsistency: number;
            dominantRegime?: SimpleRegime; dominantRegimeRatio?: number;
            regimeStats: Record<string, { trades: number; winRate: number; avgPnl: number }>;
            trainRegimeStats: Record<string, { trades: number; winRate: number; avgPnl: number }>;
            valRegimeStats: Record<string, { trades: number; winRate: number; avgPnl: number }>;
        };
        const overallMap = new Map<string, OverallCandidate>();

        for (const { results, mode } of [
            { results: normalResults, mode: 'normal' as const },
            { results: reverseResults, mode: 'reverse' as const },
        ]) {
            for (const combo of results) {
                if (!combo.tickerResults) continue;
                const trainResultMap = new Map<string, BacktestTickerResult>();
                if (combo.trainTickerResults) {
                    for (const ttr of combo.trainTickerResults) {
                        trainResultMap.set(ttr.ticker, ttr);
                    }
                }
                for (const tr of combo.tickerResults) {
                    if (tr.totalTrades < 1) continue;
                    const trainResult = trainResultMap.get(tr.ticker);
                    const consistency = this.calcRegimeConsistency(trainResult, tr);

                    // ── 레짐×진입타입 6-way 독립 후보 수집 ──
                    const valTrades = tr.trades || [];
                    const trainTrades = trainResult?.trades || [];

                    for (const regime of REGIMES) {
                      for (const entryType of ENTRY_TYPES) {
                        const compositeKey = makeRegimeEntryKey(regime, entryType);
                        const valFiltered = valTrades.filter(t => t.regime === regime && getEntryTypeFromTrade(t) === entryType);
                        const trainFiltered = trainTrades.filter(t => t.regime === regime && getEntryTypeFromTrade(t) === entryType);
                        if (valFiltered.length === 0) continue;

                        const valWinTrades = valFiltered.filter(t => t.pnlPercent > 0);
                        const valLossTrades = valFiltered.filter(t => t.pnlPercent <= 0);
                        const valWins = valWinTrades.length;
                        const valPnl = valFiltered.reduce((s, t) => s + t.pnlPercent, 0);
                        const valWR = (valWins / valFiltered.length) * 100;
                        const valAvgPnl = valPnl / valFiltered.length;
                        const valAvgWin = valWinTrades.length > 0
                            ? valWinTrades.reduce((s, t) => s + t.pnlPercent, 0) / valWinTrades.length : 0;
                        const valAvgLoss = valLossTrades.length > 0
                            ? valLossTrades.reduce((s, t) => s + t.pnlPercent, 0) / valLossTrades.length : 0;
                        const trainWins = trainFiltered.length > 0
                            ? trainFiltered.filter(t => t.pnlPercent > 0).length : 0;
                        const trainPnl = trainFiltered.reduce((s, t) => s + t.pnlPercent, 0);
                        const trainWR = trainFiltered.length > 0
                            ? (trainWins / trainFiltered.length) * 100 : 0;

                        // ★ v52.12: 실전 데이터 기반 필터 — 3≤n≤10 + WR≥60% + EV>0
                        // 42건 분석 결과: 소표본(n≤10) + 고승률(WR≥60%) 조합이 실전 성적 최고 (60%WR, +$0.50)
                        // Kelly 사이징 폐지에 따라 Kelly 기반 자격도 단순화
                        const ev = calcEV(valWR, valAvgWin, valAvgLoss);
                        const { qualified: regimeQualified, disqualifyReason } = evaluateQualification(valFiltered.length, valWR, ev, this._shadowMode, mode, regime);

                        // ★ 평균 PnL 저장 (합산이 아닌 건당 평균 — 직관적 비교)
                        const trainAvgPnl = trainFiltered.length > 0
                            ? trainPnl / trainFiltered.length : 0;

                        const candidate: RegimeCandidate = {
                            params: combo.params,
                            mode,
                            qualified: regimeQualified,
                            disqualifyReason,
                            pnl: valAvgPnl,           // ★ 합산 → 건당 평균
                            winRate: valWR,
                            trades: valFiltered.length,
                            avgWin: valAvgWin,         // ★ 수익 거래 평균 PnL %
                            avgLoss: valAvgLoss,       // ★ 손실 거래 평균 PnL %
                            kellyFraction: 0,
                            confidenceScore: 0,
                            trainPnl: trainAvgPnl,     // ★ 합산 → 건당 평균
                            trainWinRate: trainWR,
                            trainTrades: trainFiltered.length,
                            _comboParams: combo.params,
                        };

                        // ★ EV 기준 비교: WR × R:R 동시 반영
                        const candidateEV = calcEV(valWR, valAvgWin, valAvgLoss);
                        if (!regimeCandidateMap.has(tr.ticker)) {
                            regimeCandidateMap.set(tr.ticker, new Map());
                        }
                        const tickerMap = regimeCandidateMap.get(tr.ticker)!;
                        const prev = tickerMap.get(compositeKey);
                        const prevEV = prev ? calcEV(prev.winRate, prev.avgWin ?? 0, prev.avgLoss ?? 0) : -Infinity;
                        if (!prev || candidateEV > prevEV) {
                            tickerMap.set(compositeKey, candidate);
                        }
                      }
                    }

                    // ── ★ v36: 18-way 시간 세분화 후보 수집 ──
                    for (const regime of REGIMES) {
                      for (const entryType of ENTRY_TYPES) {
                        for (const session of ALL_SESSIONS) {
                          for (const dayType of ALL_DAYTYPES) {
                            const tsKey = makeTimeSegmentKey(regime, entryType, session, dayType);
                            const tsFiltered = valTrades.filter(t =>
                                t.regime === regime &&
                                getEntryTypeFromTrade(t) === entryType &&
                                t.session === session &&
                                t.dayType === dayType
                            );
                            const tsTrainFiltered = trainTrades.filter(t =>
                                t.regime === regime &&
                                getEntryTypeFromTrade(t) === entryType &&
                                t.session === session &&
                                t.dayType === dayType
                            );
                            if (tsFiltered.length === 0) continue;

                            const tsWinTrades = tsFiltered.filter(t => t.pnlPercent > 0);
                            const tsLossTrades = tsFiltered.filter(t => t.pnlPercent <= 0);
                            const tsWins = tsWinTrades.length;
                            const tsWR = (tsWins / tsFiltered.length) * 100;
                            const tsAvgWin = tsWinTrades.length > 0
                                ? tsWinTrades.reduce((s, t) => s + t.pnlPercent, 0) / tsWinTrades.length : 0;
                            const tsAvgLoss = tsLossTrades.length > 0
                                ? tsLossTrades.reduce((s, t) => s + t.pnlPercent, 0) / tsLossTrades.length : 0;
                            const tsAvgPnl = tsFiltered.reduce((s, t) => s + t.pnlPercent, 0) / tsFiltered.length;
                            const tsTrainWins = tsTrainFiltered.length > 0
                                ? tsTrainFiltered.filter(t => t.pnlPercent > 0).length : 0;
                            const tsTrainWR = tsTrainFiltered.length > 0
                                ? (tsTrainWins / tsTrainFiltered.length) * 100 : 0;
                            const tsTrainPnl = tsTrainFiltered.length > 0
                                ? tsTrainFiltered.reduce((s, t) => s + t.pnlPercent, 0) / tsTrainFiltered.length : 0;

                            // ★ v52.12: 실전 데이터 기반 필터 — n≤10 + WR≥60% + EV>0
                            const tsEv = calcEV(tsWR, tsAvgWin, tsAvgLoss);
                            const { qualified: tsQualified, disqualifyReason: tsDisqualifyReason } = evaluateQualification(tsFiltered.length, tsWR, tsEv, this._shadowMode, mode, regime);

                            const tsCandidate: RegimeCandidate = {
                                params: combo.params,
                                mode,
                                qualified: tsQualified,
                                disqualifyReason: tsDisqualifyReason,
                                pnl: tsAvgPnl,
                                winRate: tsWR,
                                trades: tsFiltered.length,
                                avgWin: tsAvgWin,
                                avgLoss: tsAvgLoss,
                                kellyFraction: 0,
                                confidenceScore: 0,
                                trainPnl: tsTrainPnl,
                                trainWinRate: tsTrainWR,
                                trainTrades: tsTrainFiltered.length,
                                _comboParams: combo.params,
                            };

                            const tsCandidateEV = calcEV(tsWR, tsAvgWin, tsAvgLoss);
                            if (!timeSegmentCandidateMap.has(tr.ticker)) {
                                timeSegmentCandidateMap.set(tr.ticker, new Map());
                            }
                            const tsTickerMap = timeSegmentCandidateMap.get(tr.ticker)!;
                            const tsPrev = tsTickerMap.get(tsKey);
                            const tsPrevEV = tsPrev ? calcEV(tsPrev.winRate, tsPrev.avgWin ?? 0, tsPrev.avgLoss ?? 0) : -Infinity;
                            if (!tsPrev || tsCandidateEV > tsPrevEV) {
                                tsTickerMap.set(tsKey, tsCandidate);
                            }
                          }
                        }
                      }
                    }

                    // ── 전체(overall) 최적 후보 (폴백용, EV 기준) ──
                    const prevOverall = overallMap.get(tr.ticker);
                    const overallAvgPnl = tr.totalTrades > 0 ? tr.totalPnlPercent / tr.totalTrades : 0;
                    // ★ EV 비교 — 전체 검증 트레이드 기준
                    const overallWinT = tr.trades.filter(t => t.pnlPercent > 0);
                    const overallLossT = tr.trades.filter(t => t.pnlPercent <= 0);
                    const overallAvgWin = overallWinT.length > 0 ? overallWinT.reduce((s, t) => s + t.pnlPercent, 0) / overallWinT.length : 0;
                    const overallAvgLoss = overallLossT.length > 0 ? overallLossT.reduce((s, t) => s + t.pnlPercent, 0) / overallLossT.length : 0;
                    const overallEV = (tr.winRate / 100) * overallAvgWin + ((100 - tr.winRate) / 100) * overallAvgLoss;
                    const prevOverallEV = prevOverall
                        ? (prevOverall.winRate / 100) * overallAvgWin + ((100 - prevOverall.winRate) / 100) * overallAvgLoss
                        : -Infinity;
                    if (!prevOverall || overallEV > prevOverallEV) {
                        let dominantRegime: SimpleRegime | undefined;
                        let dominantRegimeRatio = 0;
                        if (trainResult && trainResult.trades.length > 0) {
                            const dist = this.getRegimeDist(trainResult.trades);
                            const sorted = Object.entries(dist).sort(([,a], [,b]) => b - a);
                            if (sorted.length > 0) {
                                dominantRegime = sorted[0][0] as SimpleRegime;
                                dominantRegimeRatio = sorted[0][1];
                            }
                        }
                        const trainAvgPnlOverall = (trainResult && trainResult.totalTrades > 0)
                            ? trainResult.totalPnlPercent / trainResult.totalTrades : 0;
                        overallMap.set(tr.ticker, {
                            params: combo.params, mode,
                            pnl: overallAvgPnl, winRate: tr.winRate, trades: tr.totalTrades,
                            trainPnl: trainAvgPnlOverall,
                            trainWinRate: trainResult?.winRate ?? 0,
                            maxDD: tr.maxDrawdownPercent,
                            avgUnderwaterMin: tr.avgUnderwaterMinutes,
                            avgHoldingMin: tr.avgHoldingMinutes,
                            regimeConsistency: consistency,
                            dominantRegime, dominantRegimeRatio,
                            regimeStats: this.computeRegimeStats([...(trainResult?.trades || []), ...tr.trades]),
                            trainRegimeStats: trainResult ? this.computeRegimeStats(trainResult.trades) : {},
                            valRegimeStats: this.computeRegimeStats(tr.trades),
                        });
                    }
                }
            }
        }

        // ★ 2단계: TickerParamEntry 조립 (regimeEntries + 기존 필드)
        type CandidateEntry = TickerParamEntry & { _isNew: boolean };
        const candidateMap = new Map<string, CandidateEntry>();

        for (const [ticker, regimeMap] of regimeCandidateMap) {
            const regimeEntries: Partial<Record<string, RegimeParamEntry>> = {};
            const allowedRegimeKeys: string[] = [];

            for (const compositeKey of ALL_REGIME_ENTRY_KEYS) {
                const rc = regimeMap.get(compositeKey);
                if (!rc) continue;
                const { _comboParams, ...regimeEntry } = rc;
                regimeEntries[compositeKey] = regimeEntry;
                if (regimeEntry.qualified) {
                    allowedRegimeKeys.push(compositeKey);
                }
            }

            // ★ v36 개선: 18-way = 3-way 최적 콤보의 거래를 세션/요일로 분해
            // (독립 콤보 선택 → 3-way 하위 분해로 변경)
            const timeSegmentEntries: Partial<Record<TimeSegmentKey, RegimeParamEntry>> = {};
            const allowedTimeSegmentKeys: string[] = [];
            for (const compositeKey of ALL_REGIME_ENTRY_KEYS) {
                const rc = regimeMap.get(compositeKey);
                if (!rc) continue;
                const { regime, entryType } = parseRegimeEntryKey(compositeKey);
                // 이 3-way 항목의 콤보 파라미터로 해당 콤보의 거래를 세션/요일로 분해
                for (const session of ALL_SESSIONS) {
                    for (const dayType of ALL_DAYTYPES) {
                        const tsKey = makeTimeSegmentKey(regime, entryType, session, dayType);
                        // 3-way의 콤보에서 이미 수집된 거래를 사용 (독립 콤보가 아님)
                        const tsCandFromIndependent = timeSegmentCandidateMap.get(ticker)?.get(tsKey);
                        // 3-way 콤보 파라미터와 매칭되는 18-way 후보가 있으면 사용
                        // 없으면 3-way 통계를 세션/요일 균등 표시 (정보 목적)
                        if (tsCandFromIndependent) {
                            const { _comboParams: _, ...tsEntry } = tsCandFromIndependent;
                            // ★ v52.12: 실전 필터 requalification
                            const reEv = calcEV(tsEntry.winRate, tsEntry.avgWin, tsEntry.avgLoss);
                            const tsMode = tsCandFromIndependent.mode ?? 'normal';
                            const tsRegime = tsKey.split('_')[0] ?? '';
                            const { qualified: requalified, disqualifyReason: reDisqualifyReason } = evaluateQualification(tsEntry.trades, tsEntry.winRate, reEv, this._shadowMode, tsMode, tsRegime);
                            tsEntry.qualified = requalified;
                            if (!requalified) {
                                tsEntry.disqualifyReason = reDisqualifyReason;
                            } else {
                                tsEntry.disqualifyReason = undefined;
                            }
                            timeSegmentEntries[tsKey] = tsEntry;
                            if (requalified) {
                                allowedTimeSegmentKeys.push(tsKey);
                            }
                        }
                    }
                }
            }

            // ★ v50: Normal/Reverse 충돌 — compositeKey/tsKey는 모드 구분 없으므로
            //   EV 비교에서 이미 best 모드만 살아남음 (추가 처리 불필요)

            // backward compat: unique regimes from qualified keys
            const allowedRegimes = [...new Set(
                allowedRegimeKeys.map(k => parseRegimeEntryKey(k).regime)
            )];

            // ★ 3-way regimeEntries 또는 18-way timeSegmentEntries 중 하나라도 적격이면 종목 전체 적격
            const anyQualified = allowedRegimeKeys.length > 0 || allowedTimeSegmentKeys.length > 0;
            const overall = overallMap.get(ticker);

            // ★ 최고 레짐의 params를 폴백으로 사용 (EV 기준 정렬)
            // 3-way regimeEntries + 18-way timeSegmentEntries 모두에서 적격 항목 수집
            const bestRegime = [...Object.values(regimeEntries)]
                .filter(e => e.qualified)
                .sort((a, b) => calcEV(b.winRate, b.avgWin ?? 0, b.avgLoss ?? 0) - calcEV(a.winRate, a.avgWin ?? 0, a.avgLoss ?? 0))[0];
            const bestTimeSegment = !bestRegime
                ? [...Object.values(timeSegmentEntries)]
                    .filter(e => e.qualified)
                    .sort((a, b) => calcEV(b.winRate, b.avgWin ?? 0, b.avgLoss ?? 0) - calcEV(a.winRate, a.avgWin ?? 0, a.avgLoss ?? 0))[0]
                : undefined;

            // 가중평균 WR + 가중평균 PnL (qualified 레짐만, 건당 평균 기준)
            // 3-way가 없으면 18-way 적격 세그먼트로 대체
            const qualifiedRegimes = Object.values(regimeEntries).filter(e => e.qualified);
            const qualifiedTimeSegs = qualifiedRegimes.length === 0
                ? Object.values(timeSegmentEntries).filter(e => e.qualified)
                : [];
            const allQualifiedEntries = qualifiedRegimes.length > 0 ? qualifiedRegimes : qualifiedTimeSegs;
            const totalQTrades = allQualifiedEntries.reduce((s, e) => s + e.trades, 0);
            const aggWR = totalQTrades > 0
                ? allQualifiedEntries.reduce((s, e) => s + e.winRate * e.trades, 0) / totalQTrades
                : (overall?.winRate ?? 0);
            // ★ 가중평균 PnL (건당 평균 × 거래수로 가중)
            const aggPnl = totalQTrades > 0
                ? allQualifiedEntries.reduce((s, e) => s + e.pnl * e.trades, 0) / totalQTrades
                : (overall?.pnl ?? 0);
            // ★ 가중평균 avgWin/avgLoss
            const totalQWinTrades = allQualifiedEntries.reduce((s, e) => s + Math.round(e.trades * e.winRate / 100), 0);
            const totalQLossTrades = allQualifiedEntries.reduce((s, e) => s + (e.trades - Math.round(e.trades * e.winRate / 100)), 0);
            const aggAvgWin = totalQWinTrades > 0
                ? allQualifiedEntries.reduce((s, e) => {
                    const wins = Math.round(e.trades * e.winRate / 100);
                    return s + (e.avgWin ?? 0) * wins;
                }, 0) / totalQWinTrades : 0;
            const aggAvgLoss = totalQLossTrades > 0
                ? allQualifiedEntries.reduce((s, e) => {
                    const losses = e.trades - Math.round(e.trades * e.winRate / 100);
                    return s + (e.avgLoss ?? 0) * losses;
                }, 0) / totalQLossTrades : 0;

            const entry: CandidateEntry = {
                ticker,
                params: bestRegime?.params ?? bestTimeSegment?.params ?? overall?.params ?? {} as BacktestParams,
                mode: bestRegime?.mode ?? bestTimeSegment?.mode ?? overall?.mode ?? 'normal',
                pnl: aggPnl,
                winRate: aggWR,
                avgWin: aggAvgWin,
                avgLoss: aggAvgLoss,
                trainPnl: overall?.trainPnl ?? 0,
                trainWinRate: overall?.trainWinRate ?? 0,
                trades: totalQTrades || (overall?.trades ?? 0),
                maxDD: overall?.maxDD ?? 0,
                avgUnderwaterMin: overall?.avgUnderwaterMin ?? 0,
                avgHoldingMin: overall?.avgHoldingMin ?? 0,
                regimeConsistency: overall?.regimeConsistency ?? 0,
                dominantRegime: overall?.dominantRegime,
                dominantRegimeRatio: overall?.dominantRegimeRatio,
                regimeStats: overall?.regimeStats ?? {},
                trainRegimeStats: overall?.trainRegimeStats ?? {},
                valRegimeStats: overall?.valRegimeStats ?? {},
                qualified: anyQualified,
                disqualifyReason: anyQualified ? undefined : '레짐별 자격 미달',
                allowedRegimes: anyQualified ? allowedRegimes : undefined,
                allowedRegimeKeys: anyQualified ? allowedRegimeKeys : undefined,
                regimeEntries,
                // ★ v36: 18-way 시간 세분화
                timeSegmentEntries: Object.keys(timeSegmentEntries).length > 0 ? timeSegmentEntries : undefined,
                allowedTimeSegmentKeys: allowedTimeSegmentKeys.length > 0 ? allowedTimeSegmentKeys : undefined,
                // ★ v52.12: Kelly 폐지 — kellyFraction 0 고정 (호환성)
                kellyFraction: 0,
                // ★ v50: 전천후 지수 — 적격 세션×요일 커버리지 (6개 중 몇 개, 거래3+)
                sessionCoverage: (() => {
                    const covered = new Set<string>();
                    const tsEntries = Object.entries(timeSegmentEntries);
                    for (const [k, e] of tsEntries) {
                        if (e.qualified && e.trades >= 3) {
                            // tsKey = REGIME_ENTRYTYPE_SESSION_DAYTYPE → extract session_daytype
                            const parts = k.split('_');
                            if (parts.length >= 4) {
                                covered.add(parts[parts.length - 2] + '_' + parts[parts.length - 1]);
                            }
                        }
                    }
                    return covered.size;  // 0~6
                })(),
                updatedAt: now,
                _isNew: false,
            };

            candidateMap.set(ticker, entry);
        }

        // ★ 3단계: 레지스트리에 반영
        for (const [ticker, candidate] of candidateMap) {
            const existing = this.accumulatedRegistry[ticker];

            if (candidate.qualified) {
                // ★ EV 기준 비교 (WR × R:R 동시 반영)
                const candidateEV = calcEV(candidate.winRate, candidate.avgWin ?? 0, candidate.avgLoss ?? 0);
                const existingEV = existing ? calcEV(existing.winRate, existing.avgWin ?? 0, existing.avgLoss ?? 0) : -Infinity;
                if (!existing) {
                    const { _isNew, ...entry } = candidate;
                    this.accumulatedRegistry[ticker] = entry;
                    newCount++;
                } else if (candidateEV > existingEV) {
                    const { _isNew, ...entry } = candidate;
                    this.accumulatedRegistry[ticker] = entry;
                    updatedCount++;
                } else {
                    // EV가 낮아도 regimeEntries는 업데이트 (레짐별 개선 반영)
                    existing.regimeEntries = candidate.regimeEntries;
                    existing.allowedRegimes = candidate.allowedRegimes;
                    // ★ v36: 18-way도 갱신
                    existing.timeSegmentEntries = candidate.timeSegmentEntries;
                    existing.allowedTimeSegmentKeys = candidate.allowedTimeSegmentKeys;
                    existing.updatedAt = now;
                }
            } else {
                // ★ 미달 종목도 registry에 기록 → 재시작 시 스킵 가능
                if (existing) {
                    // 기존 등록 종목이 재최적화에서 미달 → 자격 박탈
                    existing.qualified = false;
                    existing.disqualifyReason = candidate.disqualifyReason ?? '재최적화 미달';
                    existing.regimeEntries = candidate.regimeEntries;
                    existing.allowedRegimes = undefined;
                    existing.allowedRegimeKeys = undefined;
                    existing.timeSegmentEntries = candidate.timeSegmentEntries;
                    existing.allowedTimeSegmentKeys = undefined;
                } else {
                    // 처음부터 미달 → 미달 상태로 등록 (스킵용)
                    const { _isNew, ...entry } = candidate;
                    entry.qualified = false;
                    entry.disqualifyReason = candidate.disqualifyReason ?? '최적화 미달';
                    this.accumulatedRegistry[ticker] = entry;
                }
                this.emitMessage('system',
                    `🚫 [Registry] ${ticker} 재최적화 미달 → 자격 박탈 (WR=${candidate.winRate?.toFixed(0)}%)`,
                    'system_state');
            }
        }

        // ★ 4단계: 자격 미달 종목은 레지스트리에 등록하지 않음
        // 기존: 참고용으로 등록 → 실전 3순위 폴백으로 미자격 종목 진입 가능 → 제거
        const unqualifiedCount = [...candidateMap.values()].filter(c => !c.qualified).length;

        if (newCount > 0 || updatedCount > 0 || unqualifiedCount > 0) {
            const totalQualified = Object.values(this.accumulatedRegistry).filter(e => e.qualified).length;
            const totalUnqualified = Object.values(this.accumulatedRegistry).filter(e => !e.qualified).length;
            const unqMsg = totalUnqualified > 0 ? ` + 참고용 ${totalUnqualified}` : '';

            // 6-way 통계 로그
            let regimeLog = '';
            const keyCounts: Record<string, number> = {};
            for (const entry of Object.values(this.accumulatedRegistry)) {
                if (!entry.qualified || !entry.regimeEntries) continue;
                for (const key of ALL_REGIME_ENTRY_KEYS) {
                    if (entry.regimeEntries[key]?.qualified) {
                        keyCounts[key] = (keyCounts[key] || 0) + 1;
                    }
                }
            }
            const ti = keyCounts['TRENDING_IGNITION'] || 0;
            const ri = keyCounts['RANGING_IGNITION'] || 0;
            const vi = keyCounts['VOLATILE_IGNITION'] || 0;
            regimeLog = ` (T:${ti} R:${ri} V:${vi})`;

            // ★ v36: 18-way 적격 세그먼트 수
            let totalTsQualified = 0;
            for (const entry of Object.values(this.accumulatedRegistry)) {
                if (!entry.qualified || !entry.timeSegmentEntries) continue;
                for (const tsKey of ALL_TIME_SEGMENT_KEYS) {
                    if (entry.timeSegmentEntries[tsKey]?.qualified) totalTsQualified++;
                }
            }
            if (totalTsQualified > 0) {
                regimeLog += ` | 18-way: ${totalTsQualified}세그먼트`;
            }

            this.emitMessage('system',
                `📋 [Registry] 적격 ${totalQualified}종목${regimeLog}${unqMsg} (신규 +${newCount}, 갱신 ${updatedCount})`,
                'system_state',
            );
        }

        return this.accumulatedRegistry;
    }

    /** ★ 2차 미세 최적화 — 종목별 × 레짐별 독립 미세 탐색 */
    private fineTuneRegistry(engine: OptimizerEngine): void {
        const baseConfig = this.getTradingConfig();
        const entries = Object.entries(this.accumulatedRegistry);
        if (entries.length === 0) return;

        // ★ Fine-tuning phase 시작 — UI에 진행 상황 표시
        this.phase = 'fine-tuning';
        this.fineTuneProgress = {
            total: entries.length,
            current: 0,
            currentTicker: '',
            results: [],
        };
        this.progressMsg = `Fine-tune: ${entries.length}종목 미세 최적화 시작...`;
        this.progressPct = 96;
        this.emitStatus();

        let improvedCount = 0;
        for (let i = 0; i < entries.length; i++) {
            const [ticker, entry] = entries[i];
            const beforePnl = entry.pnl;
            const beforeWR = entry.winRate;

            // UI 업데이트: 현재 처리중인 종목
            this.fineTuneProgress = {
                ...this.fineTuneProgress!,
                current: i + 1,
                currentTicker: ticker,
            };
            this.progressMsg = `Fine-tune: ${ticker.replace('USDT', '')} (${i + 1}/${entries.length})`;
            this.progressPct = 96 + Math.round((i / entries.length) * 3);  // 96-99%
            this.emitStatus();

            // ★ 레짐별 독립 미세최적화 + EV 기준 비교 (regimeEntries가 있으면)
            let entryImproved = false;
            if (entry.regimeEntries) {
                for (const [regime, re] of Object.entries(entry.regimeEntries)) {
                    if (!re || !re.qualified) continue;
                    const result = engine.runSingleTickerFineTune(
                        ticker,
                        re.params,
                        applyParamsToConfig(baseConfig, re.params),
                    );
                    if (result) {
                        const resultEV = calcEV(result.winRate, result.avgWin, result.avgLoss);
                        const existingEV = calcEV(re.winRate, re.avgWin ?? 0, re.avgLoss ?? 0);
                        if (resultEV > existingEV) {
                            entry.regimeEntries[regime] = {
                                ...re,
                                params: result.params,
                                pnl: result.pnl,
                                winRate: result.winRate,
                                trades: result.trades,
                                avgWin: result.avgWin,
                                avgLoss: result.avgLoss,
                            };
                            entryImproved = true;
                        }
                    }
                }
                // ★ 18-way timeSegmentEntries 미세최적화
                if (entry.timeSegmentEntries) {
                    for (const [tsKey, tsEntry] of Object.entries(entry.timeSegmentEntries)) {
                        if (!tsEntry || !tsEntry.qualified) continue;
                        const tsResult = engine.runSingleTickerFineTune(
                            ticker,
                            tsEntry.params,
                            applyParamsToConfig(baseConfig, tsEntry.params),
                        );
                        if (tsResult) {
                            const tsResultEV = calcEV(tsResult.winRate, tsResult.avgWin, tsResult.avgLoss);
                            const tsExistingEV = calcEV(tsEntry.winRate, tsEntry.avgWin ?? 0, tsEntry.avgLoss ?? 0);
                            if (tsResultEV > tsExistingEV) {
                                entry.timeSegmentEntries[tsKey] = {
                                    ...tsEntry,
                                    params: tsResult.params,
                                    pnl: tsResult.pnl,
                                    winRate: tsResult.winRate,
                                    trades: tsResult.trades,
                                    avgWin: tsResult.avgWin,
                                    avgLoss: tsResult.avgLoss,
                                };
                                entryImproved = true;
                            }
                        }
                    }
                }

                // 레짐별 개선 후 전체 stats 재계산
                if (entryImproved) {
                    const qualifiedRegimes = Object.values(entry.regimeEntries).filter(e => e?.qualified);
                    const totalQT = qualifiedRegimes.reduce((s, e) => s + (e?.trades ?? 0), 0);
                    if (totalQT > 0) {
                        entry.winRate = qualifiedRegimes.reduce((s, e) => s + (e?.winRate ?? 0) * (e?.trades ?? 0), 0) / totalQT;
                        entry.pnl = qualifiedRegimes.reduce((s, e) => s + (e?.pnl ?? 0) * (e?.trades ?? 0), 0) / totalQT;
                    }
                    // ★ avgWin/avgLoss도 가중평균 재계산
                    const totalQWinT = qualifiedRegimes.reduce((s, e) => s + Math.round((e?.trades ?? 0) * (e?.winRate ?? 0) / 100), 0);
                    const totalQLossT = qualifiedRegimes.reduce((s, e) => s + ((e?.trades ?? 0) - Math.round((e?.trades ?? 0) * (e?.winRate ?? 0) / 100)), 0);
                    entry.avgWin = totalQWinT > 0
                        ? qualifiedRegimes.reduce((s, e) => s + (e?.avgWin ?? 0) * Math.round((e?.trades ?? 0) * (e?.winRate ?? 0) / 100), 0) / totalQWinT : 0;
                    entry.avgLoss = totalQLossT > 0
                        ? qualifiedRegimes.reduce((s, e) => s + (e?.avgLoss ?? 0) * ((e?.trades ?? 0) - Math.round((e?.trades ?? 0) * (e?.winRate ?? 0) / 100)), 0) / totalQLossT : 0;
                    // ★ EV 기준으로 best 레짐 선택
                    const bestRe = qualifiedRegimes.sort((a, b) =>
                        calcEV(b?.winRate ?? 0, b?.avgWin ?? 0, b?.avgLoss ?? 0) -
                        calcEV(a?.winRate ?? 0, a?.avgWin ?? 0, a?.avgLoss ?? 0)
                    )[0];
                    if (bestRe) {
                        entry.params = bestRe.params;
                        entry.mode = bestRe.mode;
                    }
                    entry.updatedAt = Date.now();
                    improvedCount++;
                }
            } else {
                // 폴백: 기존 단일 params 미세최적화
                const result = engine.runSingleTickerFineTune(
                    ticker,
                    entry.params,
                    applyParamsToConfig(baseConfig, entry.params),
                );
                if (result) {
                    const resultEV = calcEV(result.winRate, result.avgWin, result.avgLoss);
                    const existingEV = calcEV(entry.winRate, entry.avgWin ?? 0, entry.avgLoss ?? 0);
                    if (resultEV > existingEV) {
                        this.accumulatedRegistry[ticker] = {
                            ...entry,
                            params: result.params,
                            pnl: result.pnl,
                            winRate: result.winRate,
                            trades: result.trades,
                            avgWin: result.avgWin,
                            avgLoss: result.avgLoss,
                            updatedAt: Date.now(),
                        };
                        entryImproved = true;
                        improvedCount++;
                    }
                }
            }

            const afterPnl = this.accumulatedRegistry[ticker]?.pnl ?? entry.pnl;
            const afterWR = this.accumulatedRegistry[ticker]?.winRate ?? entry.winRate;

            // 결과 배열에 추가
            this.fineTuneProgress = {
                ...this.fineTuneProgress!,
                results: [
                    ...this.fineTuneProgress!.results,
                    { ticker, beforePnl, afterPnl, beforeWR, afterWR, improved: entryImproved },
                ],
            };
            this.emitStatus();
        }

        this.emitMessage('system',
            `🔬 [Fine-tune] ${entries.length}종목 미세최적화+재검증 완료 → ${improvedCount}종목 EV 개선 (검증 EV>0 통과만 적용)`,
            'system_state',
        );

        // phase를 comparing으로 복원 (applyLiveParams 직전)
        this.phase = 'comparing';
        this.progressPct = 99;
        this.emitStatus();
    }

    /** ★ Top 10 검증 성과 종목 로그 — 필터 통과 여부 무관, RC 점수 포함 */
    private emitTop10Tickers(
        normalResults: OptimizerComboResult[],
        reverseResults: OptimizerComboResult[],
    ): void {
        // 모든 콤보의 tickerResults에서 종목별 최고 검증 PnL 추출
        const bestByTicker = new Map<string, { pnl: number; wr: number; trades: number; trainPnl: number; mode: string; rc: number }>();

        for (const { results, mode } of [
            { results: normalResults, mode: '📈' },
            { results: reverseResults, mode: '🔄' },
        ]) {
            for (const combo of results) {
                if (!combo.tickerResults) continue;
                // 학습 결과 맵 (전체 BacktestTickerResult)
                const trainResultMap = new Map<string, BacktestTickerResult>();
                if (combo.trainTickerResults) {
                    for (const ttr of combo.trainTickerResults) {
                        trainResultMap.set(ttr.ticker, ttr);
                    }
                }
                for (const tr of combo.tickerResults) {
                    if (tr.totalTrades < 1) continue;
                    const existing = bestByTicker.get(tr.ticker);
                    const avgPnl = tr.totalTrades > 0 ? tr.totalPnlPercent / tr.totalTrades : 0;
                    if (!existing || avgPnl > existing.pnl) {
                        const trainResult = trainResultMap.get(tr.ticker);
                        const trainAvgPnl2 = (trainResult && trainResult.totalTrades > 0)
                            ? trainResult.totalPnlPercent / trainResult.totalTrades : 0;
                        bestByTicker.set(tr.ticker, {
                            pnl: avgPnl,
                            wr: tr.winRate,
                            trades: tr.totalTrades,
                            trainPnl: trainAvgPnl2,
                            mode,
                            rc: this.calcRegimeConsistency(trainResult, tr),
                        });
                    }
                }
            }
        }

        if (bestByTicker.size === 0) return;

        const sorted = [...bestByTicker.entries()]
            .sort(([, a], [, b]) => b.pnl - a.pnl)
            .slice(0, 10);

        const lines = sorted.map(([ticker, d], i) =>
            `  ${i + 1}. ${d.mode}${ticker.replace('USDT', '')} — 학습${d.trainPnl >= 0 ? '+' : ''}${d.trainPnl.toFixed(0)}% → 검증${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}% (WR${d.wr.toFixed(0)}%, ${d.trades}회, RC${d.rc})`
        );

        this.emitMessage('system',
            `🏆 [Top 10 검증 성과]\n${lines.join('\n')}`,
            'system_state',
        );
    }

    // ── Trade DNA 교차분석: 조건별 EV 계산 + 플레이북 생성 ──

    private emitDnaAnalysis(
        normalResults: OptimizerComboResult[],
        reverseResults: OptimizerComboResult[],
    ): void {
        // 1. 모든 거래에서 DNA가 있는 것만 수집
        const allTrades: BacktestTrade[] = [];
        for (const results of [normalResults, reverseResults]) {
            for (const combo of results) {
                if (combo.tickerResults) {
                    for (const tr of combo.tickerResults) {
                        for (const trade of tr.trades) {
                            if (trade.entryDNA) allTrades.push(trade);
                        }
                    }
                }
            }
        }

        if (allTrades.length < 10) return;

        // 2. 기존 6개 차원별 통계
        const byZoneType = this.computeDnaStatsByKey(allTrades, t => t.entryDNA!.zoneType);
        const byRegime = this.computeDnaStatsByKey(allTrades, t => t.regime);
        const byAdxRange = this.computeDnaStatsByKey(allTrades, t => t.entryDNA!.adxRange);
        const byRsiZone = this.computeDnaStatsByKey(allTrades, t => t.entryDNA!.rsiZone);
        const byEmaAlignment = this.computeDnaStatsByKey(allTrades, t => t.entryDNA!.emaAlignment);
        const byVolatility = this.computeDnaStatsByKey(allTrades, t => t.entryDNA!.volatility);

        // ★ 신규: 방향별 + 방향×레짐 분석
        const byDirection = this.computeDnaStatsByKey(allTrades, t => t.direction);
        const byDirectionRegime = this.computeDnaStatsByKey(allTrades, t => `${t.direction}|${t.regime}`);

        // 3. 3차원 조합 분석 (regime × adxRange × zoneType) + exitBreakdown
        const comboMap = new Map<string, BacktestTrade[]>();
        for (const t of allTrades) {
            const key = `${t.regime}|${t.entryDNA!.adxRange}|${t.entryDNA!.zoneType}`;
            if (!comboMap.has(key)) comboMap.set(key, []);
            comboMap.get(key)!.push(t);
        }

        const comboStats: DnaComboStats[] = [];
        for (const [key, trades] of comboMap) {
            if (trades.length < 3) continue;
            const [regime, adxRange, zoneType] = key.split('|');
            const stats = this.calcStats(trades);
            const adxLabel = adxRange === 'WEAK' ? 'ADX약' : adxRange === 'MID' ? 'ADX중' : 'ADX강';
            const total = trades.length;
            comboStats.push({
                ...stats,
                label: `${regime} + ${adxLabel} + ${zoneType}`,
                conditions: { regime, adxRange, zoneType },
                exitBreakdown: {
                    tp1Rate:     trades.filter(t => t.exitReason === 'TP1').length / total,
                    tp2Rate:     trades.filter(t => t.exitReason === 'TP2').length / total,
                    slRate:      trades.filter(t => t.exitReason === 'SL').length / total,
                },
            });
        }

        const topCombos = [...comboStats].sort((a, b) => b.ev - a.ev).slice(0, 5);
        const worstCombos = [...comboStats].sort((a, b) => a.ev - b.ev).slice(0, 5);

        // ★ 회피 필터 — 3종류 합산
        const filters: DnaComboStats[] = [];

        // (1) 기존: EV < 0 콤보 (방향 무관)
        for (const c of worstCombos) {
            if (c.ev < 0) filters.push(c);
        }

        // (2) SL rate > 70% 콤보 (방향 무관) — EV 양수여도 SL 터짐 비율 높으면 회피
        for (const c of comboStats) {
            if (c.exitBreakdown && c.exitBreakdown.slRate > 0.70 && !filters.find(f => f.label === c.label)) {
                filters.push(c);
            }
        }

        // (3) 방향×레짐 EV < -0.5% → direction-specific 필터
        for (const [key, stats] of Object.entries(byDirectionRegime)) {
            if (stats.ev < -0.5 && stats.count >= 3) {
                const [direction, regime] = key.split('|');
                filters.push({
                    ...stats,
                    label: `${direction} in ${regime}`,
                    conditions: {
                        regime,
                        adxRange: '',  // 빈 문자열 = 매칭 안 함 (direction 기반 필터)
                        zoneType: '',
                        direction: direction as 'Long' | 'Short',
                    },
                });
            }
        }

        this.lastDnaFilters = filters;

        // ★ 긍정 DNA 필터 — EV > 1% && count >= 3인 상위 조합만 진입 허용
        this.lastDnaPositiveFilters = topCombos.filter(c => c.ev > 1 && c.count >= 3);

        // ★ 종목별 DNA 프로파일
        const tickerDnaMap = new Map<string, BacktestTrade[]>();
        for (const t of allTrades) {
            if (!tickerDnaMap.has(t.ticker)) tickerDnaMap.set(t.ticker, []);
            tickerDnaMap.get(t.ticker)!.push(t);
        }

        const byTicker: Record<string, TickerDnaProfile> = {};
        for (const [ticker, trades] of tickerDnaMap) {
            if (trades.length < 3) continue;
            const tickerByRegime = this.computeDnaStatsByKey(trades, t => t.regime);
            const regimeEntries = Object.entries(tickerByRegime).sort(([, a], [, b]) => b.ev - a.ev);
            const longTrades = trades.filter(t => t.direction === 'Long');
            const shortTrades = trades.filter(t => t.direction === 'Short');
            const longWins = longTrades.filter(t => t.pnlPercent > 0).length;
            const shortWins = shortTrades.filter(t => t.pnlPercent > 0).length;

            byTicker[ticker] = {
                topCondition: regimeEntries[0]?.[0] ?? '-',
                topEv: regimeEntries[0]?.[1]?.ev ?? 0,
                worstCondition: regimeEntries[regimeEntries.length - 1]?.[0] ?? '-',
                worstEv: regimeEntries[regimeEntries.length - 1]?.[1]?.ev ?? 0,
                longWinRate: longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0,
                shortWinRate: shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0,
                totalTrades: trades.length,
            };
        }

        // ★ 종목별 DNA 프로파일 저장 (tradingEngine에 전달용)
        this.lastTickerDnaProfiles = byTicker;

        // ★ DnaAnalysis 객체 저장
        this.lastDnaAnalysis = {
            byZoneType, byRegime, byAdxRange, byRsiZone, byEmaAlignment, byVolatility,
            byDirection, byDirectionRegime, byTicker,
            topCombos, worstCombos, totalAnalyzed: allTrades.length,
        };
        this.emitStatus();

        // 4. 로그 출력
        const lines: string[] = [`🧬 [Trade DNA] 전체 ${allTrades.length}건 분석\n`];

        const formatDim = (title: string, data: Record<string, DnaStats>) => {
            const entries = Object.entries(data).sort(([, a], [, b]) => b.ev - a.ev);
            lines.push(`📊 ${title}:`);
            for (const [key, s] of entries) {
                const stars = s.ev > 1.5 ? '★★★' : s.ev > 0.5 ? '★★' : s.ev > 0 ? '★' : '☆';
                lines.push(`  ${key.padEnd(18)} ${s.count}건 WR ${s.winRate.toFixed(0)}% EV ${s.ev >= 0 ? '+' : ''}${s.ev.toFixed(1)}%  ${stars}`);
            }
            lines.push('');
        };

        formatDim('존 타입별', byZoneType);
        formatDim('레짐별', byRegime);
        formatDim('ADX 구간별', byAdxRange);
        formatDim('EMA 정렬별', byEmaAlignment);
        formatDim('변동성별', byVolatility);
        formatDim('방향별', byDirection);
        formatDim('방향×레짐', byDirectionRegime);

        // ★ 최적/회피 조건 (exitBreakdown 포함)
        if (topCombos.length > 0) {
            lines.push('🏆 최적 진입 조건 TOP 5:');
            for (let i = 0; i < topCombos.length; i++) {
                const c = topCombos[i];
                const eb = c.exitBreakdown;
                const exitStr = eb ? ` [TP${Math.round((eb.tp1Rate + eb.tp2Rate) * 100)}% SL${Math.round(eb.slRate * 100)}%]` : '';
                lines.push(`  ${i + 1}. ${c.label} → ${c.count}건 WR ${c.winRate.toFixed(0)}% EV ${c.ev >= 0 ? '+' : ''}${c.ev.toFixed(1)}%${exitStr}`);
            }
            lines.push('');
        }

        if (worstCombos.length > 0 && worstCombos[0].ev < 0) {
            lines.push('⚠️ 회피 조건:');
            for (let i = 0; i < Math.min(worstCombos.length, 5); i++) {
                const c = worstCombos[i];
                if (c.ev >= 0) break;
                const eb = c.exitBreakdown;
                const slWarn = eb && eb.slRate > 0.70 ? ' ⚠SL' + Math.round(eb.slRate * 100) + '%!!' : '';
                const exitStr = eb ? ` [TP${Math.round((eb.tp1Rate + eb.tp2Rate) * 100)}% SL${Math.round(eb.slRate * 100)}%]` : '';
                lines.push(`  ${i + 1}. ${c.label} → ${c.count}건 WR ${c.winRate.toFixed(0)}% EV ${c.ev.toFixed(1)}%${exitStr}${slWarn}`);
            }
            lines.push('');
        }

        // ★ 종목별 DNA 프로파일
        const tickerProfiles = Object.entries(byTicker)
            .sort(([, a], [, b]) => b.topEv - a.topEv)
            .slice(0, 15);

        if (tickerProfiles.length > 0) {
            lines.push('🔍 [종목별 DNA]');
            for (const [ticker, p] of tickerProfiles) {
                const short = ticker.replace('USDT', '');
                lines.push(`  ${short.padEnd(8)} L:WR${p.longWinRate.toFixed(0)}% S:WR${p.shortWinRate.toFixed(0)}% | 최적:${p.topCondition}(EV${p.topEv >= 0 ? '+' : ''}${p.topEv.toFixed(1)}%) 최악:${p.worstCondition}(EV${p.worstEv >= 0 ? '+' : ''}${p.worstEv.toFixed(1)}%)`);
            }
            lines.push('');
        }

        // ★ 긍정 필터 로그
        if (this.lastDnaPositiveFilters.length > 0) {
            lines.push('✅ 긍정 DNA 필터 (이 조건에서만 진입 허용):');
            for (const c of this.lastDnaPositiveFilters) {
                lines.push(`  ${c.label} → ${c.count}건 WR ${c.winRate.toFixed(0)}% EV +${c.ev.toFixed(1)}%`);
            }
            lines.push('');
        }

        // 필터 요약
        const dirFilters = filters.filter(f => f.conditions.direction);
        const comboFilters = filters.filter(f => !f.conditions.direction);
        lines.push(`🛡️ 실전 필터: 긍정 ${this.lastDnaPositiveFilters.length}개 + 회피콤보 ${comboFilters.length}개 + 방향회피 ${dirFilters.length}개`);

        this.emitMessage('system', lines.join('\n'), 'system_state');
    }

    /** 거래 배열에서 키 추출 함수로 그룹화 → DnaStats 맵 */
    private computeDnaStatsByKey(
        trades: BacktestTrade[],
        keyFn: (t: BacktestTrade) => string,
    ): Record<string, DnaStats> {
        const groups = new Map<string, BacktestTrade[]>();
        for (const t of trades) {
            const key = keyFn(t);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(t);
        }
        const result: Record<string, DnaStats> = {};
        for (const [key, group] of groups) {
            result[key] = this.calcStats(group);
        }
        return result;
    }

    /** 거래 배열 → DnaStats 계산 */
    private calcStats(trades: BacktestTrade[]): DnaStats {
        const wins = trades.filter(t => t.pnlPercent > 0);
        const losses = trades.filter(t => t.pnlPercent <= 0);
        const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0;
        const wr = winRate / 100;
        const ev = (wr * avgWin) + ((1 - wr) * avgLoss);
        const sumWins = wins.reduce((s, t) => s + t.pnlPercent, 0);
        const sumLosses = Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0));
        const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 999 : 0;

        return { count: trades.length, winRate, avgWin, avgLoss, ev, profitFactor };
    }

    private scheduleNext(_wasApplied: boolean): void {
        if (!this.enabled) {
            this.phase = 'idle';
            this.emitStatus();
            return;
        }

        // ★ v52.43: 150개 소진 시 더 이상 WF 안 돌림
        if (this.phase === 'completed') {
            this.emitStatus();
            return;
        }

        this.clearAllTimers();

        this.phase = 'watching';
        this.nextCycleTime = Date.now() + 3000;
        this.emitStatus();
        const remaining = this._masterTickerList.length - this._masterTickerIndex;
        this.emitMessage('system', `🤖 [WF] 🔄 3초 후 다음 종목 (남은: ${remaining}/${this._masterTickerList.length})`, 'system_state');
        this.waitTimerId = setTimeout(() => {
            this.clearAllTimers();
            if (this.enabled) this.runIgnitionWfCycle();
        }, 3000);
    }

    // ── 종목 모니터 (사이클과 독립적으로 60초마다 체크) ──

    private startTickerMonitor(): void {
        this.stopTickerMonitor();
        this.lastTopTickers = [];

        // 즉시 1회 체크
        this.checkTopTickers().catch(() => {});

        this.tickerMonitorId = setInterval(() => {
            if (!this.enabled) {
                this.stopTickerMonitor();
                return;
            }
            this.checkTopTickers().catch(() => {});
        }, TICKER_MONITOR_MS);
    }

    private stopTickerMonitor(): void {
        if (this.tickerMonitorId) {
            clearInterval(this.tickerMonitorId);
            this.tickerMonitorId = null;
        }
    }

    private async checkTopTickers(): Promise<void> {
        try {
            const tickers = await bybitService.fetchMarketTickers();
            const sorted = tickers
                .filter((t: any) => t.symbol.endsWith('USDT') && t.volume >= MIN_VOLUME_USD)
                .sort((a: any, b: any) => Math.abs(b.rawChangePercent) - Math.abs(a.rawChangePercent))
                .slice(0, this.tickerMonitorTopN);

            const symbols = sorted.map((t: any) => t.symbol);

            // Ignition score 계산 (5분봉 기반 실시간 급등/급락 감지)
            const ignitionMap = await calculateIgnitionScores(symbols);
            const ignitingTickers = symbols.filter(
                s => (ignitionMap.get(s)?.score ?? 0) >= IGNITION_THRESHOLD
            );

            if (this.lastTopTickers.length === 0) {
                // 첫 번째 체크 — 기준선 설정
                this.lastTopTickers = symbols;
                this.emitMessage('system',
                    `📡 [종목모니터] 감시 시작: ${symbols.slice(0, 5).join(', ')} 외 ${Math.max(0, symbols.length - 5)}개` +
                    (ignitingTickers.length > 0 ? `\n  🔥 Igniting: ${ignitingTickers.join(', ')}` : ''),
                    'system_state',
                );
                return;
            }

            // 변경 감지: 새로 진입한 종목 / 빠진 종목
            const prevSet = new Set(this.lastTopTickers);
            const newSet = new Set(symbols);
            const entered = symbols.filter(t => !prevSet.has(t));
            const exited = this.lastTopTickers.filter(t => !newSet.has(t));

            if (entered.length > 0 || exited.length > 0 || ignitingTickers.length > 0) {
                this.emitMessage('system',
                    `📡 [종목모니터] 변동 감지\n` +
                    (entered.length > 0 ? `  🆕 신규: ${entered.join(', ')}\n` : '') +
                    (exited.length > 0 ? `  🔻 이탈: ${exited.join(', ')}\n` : '') +
                    (ignitingTickers.length > 0 ? `  🔥 Igniting(${ignitingTickers.length}): ${ignitingTickers.slice(0, 5).map(s => {
                        const ig = ignitionMap.get(s)!;
                        return `${s}(${ig.direction === 'up' ? '↑' : '↓'}${ig.score.toFixed(1)})`;
                    }).join(', ')}` : ''),
                    'system_state',
                );
            }

            // 재최적화 트리거 조건: 기존(50%변동) OR 새로운(3+개 igniting)
            const changeRatio = entered.length / this.tickerMonitorTopN;
            const shouldRetrigger = (changeRatio >= TICKER_CHANGE_THRESHOLD) || (ignitingTickers.length >= 3);

            if (shouldRetrigger && !this.running) {
                if (this.phase === 'watching' || this.phase === 'halted' || this.phase === 'waiting') {
                    const reason = ignitingTickers.length >= 3
                        ? `🔥 ${ignitingTickers.length}개 종목 Ignition 감지`
                        : `상위 종목 ${(changeRatio * 100).toFixed(0)}% 변경`;
                    this.emitMessage('system',
                        `📡 [종목모니터] ⚡ ${reason} → 재최적화 트리거`,
                        'system_state',
                    );
                    this.clearAllTimers();
                    this.runIgnitionWfCycle();
                }
            }

            this.lastTopTickers = symbols;
        } catch (e) {
            // 네트워크 에러 등 무시 (다음 주기에 재시도)
            console.warn('[TickerMonitor] 체크 실패:', e);
        }
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
