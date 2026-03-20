import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import type {
    TradingConfig, BacktestSummary, BacktestStatus, BacktestTickerResult, BacktestTrade,
    BacktestParams, OptimizerSummary, OptimizerStatus, OptimizerComboResult,
    WalkForwardSummary, AutoOptimizerState,
} from '../types';
import { getDefaultBacktestParams, applyParamsToConfig, getDefaultTradingConfig } from '../types';
import { backtestState } from '../services/backtestStateService';
import { BacktestEngine } from '../services/backtestEngine';
import { OptimizerEngine, OPTIMIZER_PRESETS, countCombos, type OptimizerPresetKey, type FitnessMode } from '../services/optimizerEngine';
import type { AutoOptimizerService } from '../services/autoOptimizerService';
import { BeakerIcon, PlayIcon, StopIcon } from './Icons';

// ── 추천 파라미터 분석 ──

interface Recommendation {
    id: string;
    title: string;
    reason: string;
    impact: 'high' | 'medium' | 'low';
    changes: Partial<BacktestParams>;
}

function generateRecommendations(summary: BacktestSummary, currentParams: BacktestParams): Recommendation[] {
    const recs: Recommendation[] = [];
    const allTrades = summary.tickers.flatMap(t => t.trades);
    if (allTrades.length < 3) return recs;

    const slTrades = allTrades.filter(t => t.exitReason === 'SL');
    const tp1Trades = allTrades.filter(t => t.exitReason === 'TP1');
    const tp2Trades = allTrades.filter(t => t.exitReason === 'TP2');
    const slRate = slTrades.length / allTrades.length;
    const tp2Rate = tp2Trades.length / allTrades.length;

    const longTrades = allTrades.filter(t => t.direction === 'Long');
    const shortTrades = allTrades.filter(t => t.direction === 'Short');
    const longWR = longTrades.length > 0 ? longTrades.filter(t => t.pnlPercent > 0).length / longTrades.length : 0;
    const shortWR = shortTrades.length > 0 ? shortTrades.filter(t => t.pnlPercent > 0).length / shortTrades.length : 0;

    // 레짐별 분석
    const regimeStats: Record<string, { trades: number; wins: number; totalPnl: number }> = {};
    for (const t of allTrades) {
        if (!regimeStats[t.regime]) regimeStats[t.regime] = { trades: 0, wins: 0, totalPnl: 0 };
        regimeStats[t.regime].trades++;
        if (t.pnlPercent > 0) regimeStats[t.regime].wins++;
        regimeStats[t.regime].totalPnl += t.pnlPercent;
    }

    // 1. SL 비율 너무 높으면 → SL 넓히기 or TP 줄이기
    if (slRate > 0.55) {
        const newSl = Math.min(currentParams.slAtrMultiplier + 0.3, 4.0);
        recs.push({
            id: 'widen-sl',
            title: 'SL 확대',
            reason: `SL 비율 ${(slRate * 100).toFixed(0)}%로 높음 → SL을 넓혀 조기 청산 감소`,
            impact: 'high',
            changes: { slAtrMultiplier: +newSl.toFixed(1) as unknown as number },
        });
    }

    // 2. TP2 도달률 낮으면 → TP 줄이기
    if (tp2Rate < 0.15 && tp1Trades.length + tp2Trades.length > 0) {
        const newTp = Math.max(currentParams.tpAtrMultiplier - 0.3, 0.5);
        recs.push({
            id: 'tighten-tp',
            title: 'TP 축소',
            reason: `TP2 도달률 ${(tp2Rate * 100).toFixed(0)}%로 낮음 → TP를 줄여 익절 확보`,
            impact: 'high',
            changes: { tpAtrMultiplier: +newTp.toFixed(1) as unknown as number },
        });
    }

    // 3. TP2 도달률 높으면 → TP 확대 (수익 극대화)
    if (tp2Rate > 0.4) {
        const newTp = Math.min(currentParams.tpAtrMultiplier + 0.5, 5.0);
        recs.push({
            id: 'widen-tp',
            title: 'TP 확대',
            reason: `TP2 도달률 ${(tp2Rate * 100).toFixed(0)}%로 높음 → TP를 늘려 수익 극대화`,
            impact: 'medium',
            changes: { tpAtrMultiplier: +newTp.toFixed(1) as unknown as number },
        });
    }

    // 4. Short 승률 나쁘면 → Short 배수 낮추기
    if (shortTrades.length >= 3 && shortWR < 0.35) {
        const newMult = Math.max(currentParams.shortMultiplier - 0.2, 0);
        recs.push({
            id: 'reduce-short',
            title: 'Short 억제',
            reason: `Short 승률 ${(shortWR * 100).toFixed(0)}% (${shortTrades.length}건) → Short 배수 감소`,
            impact: 'medium',
            changes: { shortMultiplier: +newMult.toFixed(2) as unknown as number },
        });
    }

    // 5. Short 승률 좋으면 → Short 배수 올리기
    if (shortTrades.length >= 3 && shortWR > 0.55 && currentParams.shortMultiplier < 1.0) {
        const newMult = Math.min(currentParams.shortMultiplier + 0.2, 1.5);
        recs.push({
            id: 'boost-short',
            title: 'Short 강화',
            reason: `Short 승률 ${(shortWR * 100).toFixed(0)}% (${shortTrades.length}건) → Short 배수 증가`,
            impact: 'medium',
            changes: { shortMultiplier: +newMult.toFixed(2) as unknown as number },
        });
    }

    // 6. 특정 레짐에서 손실 집중 → 해당 레버리지 낮추기
    for (const [regime, stat] of Object.entries(regimeStats)) {
        const wr = stat.trades > 0 ? stat.wins / stat.trades : 0;
        if (stat.trades >= 3 && wr < 0.35 && stat.totalPnl < 0) {
            const levKey = regime === 'TRENDING' ? 'leverageTrending' : regime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';
            const current = currentParams[levKey];
            const newLev = Math.max(Math.round(current * 0.6), 1);
            if (newLev < current) {
                recs.push({
                    id: `reduce-lev-${regime}`,
                    title: `${regime} 레버리지 ↓`,
                    reason: `${regime} 승률 ${(wr * 100).toFixed(0)}% (${stat.trades}건, PnL ${stat.totalPnl.toFixed(1)}%) → 레버리지 감소`,
                    impact: 'high',
                    changes: { [levKey]: newLev } as Partial<BacktestParams>,
                });
            }
        }
    }

    // 7. ADX 필터 조절
    const lowScoreTrades = allTrades.filter(t => t.directionScore < 60);
    const lowScoreWR = lowScoreTrades.length > 0 ? lowScoreTrades.filter(t => t.pnlPercent > 0).length / lowScoreTrades.length : 0;
    if (lowScoreTrades.length >= 5 && lowScoreWR < 0.35) {
        const newAdx = Math.min(currentParams.adxGateMinimum + 5, 35);
        recs.push({
            id: 'raise-adx',
            title: 'ADX 기준 상향',
            reason: `약한 시그널(점수<60) 승률 ${(lowScoreWR * 100).toFixed(0)}% → ADX 최소값 올려 필터 강화`,
            impact: 'medium',
            changes: { adxGateMinimum: newAdx },
        });
    }

    // 8. TP1 물량 최적화 - SL이 많고 TP1은 체결되는 경우 → TP1에서 더 많이 익절
    const tp1HitAndThenSL = allTrades.filter(t => t.exitReason === 'SL' && t.pnlPercent > -5); // TP1 후 SL
    if (tp1HitAndThenSL.length > slTrades.length * 0.3 && currentParams.partialQty1 < 0.7) {
        recs.push({
            id: 'more-tp1-qty',
            title: 'TP1 물량 증가',
            reason: `TP1 체결 후 SL 빈번 → TP1에서 더 많이 익절하여 수익 확보`,
            impact: 'medium',
            changes: { partialQty1: Math.min(currentParams.partialQty1 + 0.1, 0.8) },
        });
    }

    // 9. 종합 추천: 수익이면 보수적, 손실이면 공격적 조절 제안
    if (summary.totalPnlPercent > 5 && summary.maxDrawdownPercent > 15) {
        recs.push({
            id: 'conservative',
            title: '보수적 세팅',
            reason: `수익 ${summary.totalPnlPercent.toFixed(1)}%이나 낙폭 ${summary.maxDrawdownPercent.toFixed(1)}% → 리스크 줄이기`,
            impact: 'low',
            changes: {
                leverageTrending: Math.max(Math.round(currentParams.leverageTrending * 0.7), 1),
                leverageRanging: Math.max(Math.round(currentParams.leverageRanging * 0.7), 1),
                leverageVolatile: Math.max(Math.round(currentParams.leverageVolatile * 0.7), 1),
            },
        });
    }

    return recs.slice(0, 5); // 최대 5개
}

// 정렬 키 타입
type SortKey = 'ticker' | 'totalTrades' | 'winRate' | 'totalPnlPercent' | 'avgWinPercent' | 'avgLossPercent' | 'maxDrawdownPercent';
type SortDir = 'asc' | 'desc';

const TOP_N_OPTIONS = [10, 20, 50, 100, 0]; // 0=전체
function topNLabel(n: number): string {
    return n === 0 ? '전체' : `${n}개`;
}

// v29: 5분봉 기준 기간 옵션 (klines = hours × 12)
const PERIOD_OPTIONS = [
    { days: 4, label: '4시간', klines: 48 },
    { days: 8, label: '8시간', klines: 96 },
    { days: 12, label: '12시간', klines: 144 },
    { days: 24, label: '1일', klines: 288 },
    { days: 72, label: '3일', klines: 864 },
    { days: 168, label: '7일', klines: 2016 },
];

interface BacktestTabProps {
    tradingConfig?: TradingConfig;
    onApplyLive?: (config: TradingConfig, extra?: { maxPositions?: number }) => void;
    autoOptimizer?: AutoOptimizerService | null;
}

export const BacktestTab: React.FC<BacktestTabProps> = ({ tradingConfig, onApplyLive, autoOptimizer }) => {
    const [status, setStatus] = useState<BacktestStatus>('idle');
    const [summary, setSummary] = useState<BacktestSummary | null>(null);
    const [progressMsg, setProgressMsg] = useState('');
    const [progressPct, setProgressPct] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
    const [sortKey, setSortKey] = useState<SortKey>('totalPnlPercent');
    const [sortDir, setSortDir] = useState<SortDir>('desc');
    const [showParams, setShowParams] = useState(true);
    const [pendingRun, setPendingRun] = useState(false);
    const [btMode, setBtMode] = useState<'static' | 'rolling'>('rolling');
    const [liveAppliedMsg, setLiveAppliedMsg] = useState<string | null>(null);
    const engineRef = useRef<BacktestEngine | null>(null);
    const useOptDataRef = useRef(false); // 옵티마이저 데이터로 싱글런 검증 플래그

    const baseConfig = tradingConfig || getDefaultTradingConfig();
    const [params, setParams] = useState<BacktestParams>(() => getDefaultBacktestParams(baseConfig));

    // 외부 config 변경 시 파라미터 동기화
    useEffect(() => {
        setParams(getDefaultBacktestParams(baseConfig));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tradingConfig]);

    useEffect(() => {
        const unsub = backtestState.subscribe(() => {
            setStatus(backtestState.status);
            setSummary(backtestState.summary);
            setProgressMsg(backtestState.progressMessage);
            setProgressPct(backtestState.progressPercent);
            setError(backtestState.error);
        });
        return unsub;
    }, []);

    const runBacktest = useCallback(async (runParams: BacktestParams) => {
        const config = applyParamsToConfig(baseConfig, runParams);
        backtestState.reset();
        const engine = new BacktestEngine((msg, pct) => backtestState.setRunning(msg, pct));
        engineRef.current = engine;

        // 옵티마이저 데이터 재사용 (검증 모드)
        const preloaded = useOptDataRef.current ? optimizerRef.current?.getKlineCache() : undefined;
        useOptDataRef.current = false; // 한번만 사용

        try {
            backtestState.setRunning(preloaded ? '옵티마이저 데이터로 검증 중...' : '초기화...', 0);
            const klineCount = PERIOD_OPTIONS.find(p => p.days === runParams.periodDays)?.klines ?? 288;
            let result;
            if (btMode === 'rolling') {
                // Rolling Scanner: 시점별 동적 종목 스캔 (봇 실제 동작과 동일)
                result = await engine.runRolling(config, runParams.topN, klineCount, 24, runParams.maxPositions);
            } else {
                // Static: 옵티마이저 데이터 있으면 재사용 → 동일 데이터로 검증
                result = await engine.run(config, runParams.topN, klineCount, runParams.maxPositions, preloaded);
            }
            backtestState.setCompleted(result);
        } catch (err) {
            backtestState.setError((err as Error).message);
        }
    }, [baseConfig, btMode]);

    const handleRun = useCallback(() => {
        runBacktest(params);
    }, [runBacktest, params]);

    // 추천 적용 후 자동 재실행
    useEffect(() => {
        if (pendingRun) {
            setPendingRun(false);
            runBacktest(params);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingRun, params]);

    const handleAbort = useCallback(() => {
        engineRef.current?.abort();
        backtestState.setError('사용자에 의해 중단됨');
    }, []);

    const handleResetParams = useCallback(() => {
        setParams(getDefaultBacktestParams(baseConfig));
    }, [baseConfig]);

    const updateParam = useCallback(<K extends keyof BacktestParams>(key: K, value: BacktestParams[K]) => {
        setParams(prev => ({ ...prev, [key]: value }));
    }, []);

    const handleSort = useCallback((key: SortKey) => {
        setSortDir(prev => sortKey === key ? (prev === 'asc' ? 'desc' : 'asc') : 'desc');
        setSortKey(key);
    }, [sortKey]);

    const sortedTickers = useMemo(() => {
        if (!summary) return [];
        const arr = [...summary.tickers];
        arr.sort((a, b) => {
            let cmp: number;
            if (sortKey === 'ticker') {
                cmp = a.ticker.localeCompare(b.ticker);
            } else {
                cmp = (a[sortKey] as number) - (b[sortKey] as number);
            }
            return sortDir === 'asc' ? cmp : -cmp;
        });
        return arr;
    }, [summary, sortKey, sortDir]);

    const recommendations = useMemo(() => {
        if (!summary || status !== 'completed') return [];
        return generateRecommendations(summary, params);
    }, [summary, status, params]);

    const applyRecommendation = useCallback((rec: Recommendation) => {
        setParams(prev => ({ ...prev, ...rec.changes }));
        setShowParams(true); // 파라미터 패널 펼쳐서 변경 확인
    }, []);

    const applyAllAndRun = useCallback(() => {
        const merged: Partial<BacktestParams> = {};
        for (const rec of recommendations) {
            Object.assign(merged, rec.changes);
        }
        setParams(prev => ({ ...prev, ...merged }));
        setPendingRun(true); // 다음 렌더에서 새 params로 자동 실행
    }, [recommendations]);

    // ── Optimizer 상태 ──
    const [mode, setMode] = useState<'single' | 'optimizer'>('single');
    const [optPreset, setOptPreset] = useState<OptimizerPresetKey>('ignition-wf');
    const [optStatus, setOptStatus] = useState<OptimizerStatus>('idle');
    const [optSummary, setOptSummary] = useState<OptimizerSummary | null>(null);
    const [optProgressMsg, setOptProgressMsg] = useState('');
    const [optProgressPct, setOptProgressPct] = useState(0);
    const [optError, setOptError] = useState<string | null>(null);
    const optimizerRef = useRef<OptimizerEngine | null>(null);

    // ── Walk-Forward 상태 ──
    const [wfStatus, setWfStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
    const [wfSummary, setWfSummary] = useState<WalkForwardSummary | null>(null);
    const [wfProgressMsg, setWfProgressMsg] = useState('');
    const [wfProgressPct, setWfProgressPct] = useState(0);
    const [wfError, setWfError] = useState<string | null>(null);

    // ── Auto-Optimizer 상태 ──
    const [autoOptState, setAutoOptState] = useState<AutoOptimizerState | null>(() => autoOptimizer?.getState() ?? null);
    useEffect(() => {
        if (!autoOptimizer) return;
        setAutoOptState(autoOptimizer.getState());
        const unsub = autoOptimizer.subscribe((state) => setAutoOptState(state));
        return unsub;
    }, [autoOptimizer]);

    const handleOptRun = useCallback(async () => {
        const preset = OPTIMIZER_PRESETS[optPreset];
        const klineCount = PERIOD_OPTIONS.find(p => p.days === params.periodDays)?.klines ?? 288;

        setOptStatus('fetching');
        setOptSummary(null);
        setOptError(null);
        setOptProgressMsg('시작 중...');
        setOptProgressPct(0);

        const engine = new OptimizerEngine((msg, pct) => {
            setOptProgressMsg(msg);
            setOptProgressPct(pct);
            setOptStatus(pct <= 30 ? 'fetching' : 'optimizing');
        });
        optimizerRef.current = engine;

        try {
            const result = await engine.run(baseConfig, params, [...preset.ranges], params.topN, klineCount, preset.fitnessMode as FitnessMode);
            setOptSummary(result);
            setOptStatus('completed');
            setOptProgressPct(100);
        } catch (err) {
            setOptError((err as Error).message);
            setOptStatus('error');
        }
    }, [baseConfig, params, optPreset]);

    const handleOptAbort = useCallback(() => {
        optimizerRef.current?.abort();
        setOptError('사용자에 의해 중단됨');
        setOptStatus('error');
        if (wfStatus === 'running') {
            setWfError('사용자에 의해 중단됨');
            setWfStatus('error');
        }
    }, [wfStatus]);

    // ── Walk-Forward 실행 ──
    const handleWalkForward = useCallback(async () => {
        const preset = OPTIMIZER_PRESETS[optPreset];

        setWfStatus('running');
        setWfSummary(null);
        setWfError(null);
        setWfProgressMsg('시작 중...');
        setWfProgressPct(0);
        // optimizer 결과 초기화
        setOptSummary(null);
        setOptStatus('idle');

        const engine = new OptimizerEngine((msg, pct) => {
            setWfProgressMsg(msg);
            setWfProgressPct(pct);
        });
        optimizerRef.current = engine;

        try {
            const result = await engine.runWalkForward(baseConfig, params, [...preset.ranges], params.topN);
            setWfSummary(result);
            setWfStatus('completed');
            setWfProgressPct(100);
        } catch (err) {
            setWfError((err as Error).message);
            setWfStatus('error');
        }
    }, [baseConfig, params, optPreset]);

    const handleApplyCombo = useCallback((combo: OptimizerComboResult) => {
        setParams(combo.params);
        setMode('single');
        setShowParams(true);
        useOptDataRef.current = true; // 다음 싱글런에서 옵티마이저 데이터로 검증
    }, []);

    const handleApplyLive = useCallback((combo: OptimizerComboResult) => {
        if (!onApplyLive) return;
        const newConfig = applyParamsToConfig(baseConfig, combo.params);
        const p = combo.params;
        onApplyLive(newConfig, { maxPositions: p.maxPositions });
        setParams(p);
        setLiveAppliedMsg(
            `${p.reverseMode ? '🔄 REVERSE ' : ''}실전 적용 완료: TP=${p.tpAtrMultiplier} SL=${p.slAtrMultiplier} R:R=${p.minRiskReward} Short=${p.shortMultiplier} ADX=${p.adxGateMinimum} ` +
            `Lev=동적(SL→50%) 비중=${p.baseSizePercent}% 스캔=${p.topN}개 포지션=${p.maxPositions}개`
        );
        setTimeout(() => setLiveAppliedMsg(null), 8000);
    }, [onApplyLive, baseConfig]);

    // v29: 싱글런 결과에서 실전 적용
    const handleSingleApplyLive = useCallback(() => {
        if (!onApplyLive) return;
        if (!confirm(`${params.reverseMode ? '🔄 REVERSE 모드로 ' : ''}현재 파라미터를 실전 거래에 적용합니다. 계속하시겠습니까?`)) return;
        const newConfig = applyParamsToConfig(baseConfig, params);
        onApplyLive(newConfig, { maxPositions: params.maxPositions });
        setLiveAppliedMsg(
            `${params.reverseMode ? '🔄 REVERSE ' : ''}실전 적용 완료: TP=${params.tpAtrMultiplier} SL=${params.slAtrMultiplier} R:R=${params.minRiskReward} Short=${params.shortMultiplier} ADX=${params.adxGateMinimum} ` +
            `Lev=동적(SL→50%) 비중=${params.baseSizePercent}% 스캔=${params.topN}개 포지션=${params.maxPositions}개`
        );
        setTimeout(() => setLiveAppliedMsg(null), 8000);
    }, [onApplyLive, baseConfig, params]);

    const isRunning = status === 'running';
    const isOptRunning = optStatus === 'fetching' || optStatus === 'optimizing';
    const isWfRunning = wfStatus === 'running';
    const isAutoOptActive = autoOptState?.enabled ?? false;
    const isAutoOptRunning = isAutoOptActive && (autoOptState?.phase === 'running-normal' || autoOptState?.phase === 'running-reverse' || autoOptState?.phase === 'comparing' || autoOptState?.phase === 'fine-tuning');
    const isAnyRunning = isRunning || isOptRunning || isWfRunning || isAutoOptRunning;

    return (
        <div className="p-6 max-w-6xl mx-auto space-y-6">
            {/* 헤더 + 모드 토글 + 컨트롤 */}
            <div className="bg-bg-dark border border-border-color rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <BeakerIcon className="w-6 h-6 text-brand-primary" />
                        <h2 className="text-lg font-bold">Backtest</h2>
                        {/* 모드 토글 */}
                        <div className="flex gap-0.5 bg-bg-light rounded-lg p-0.5 ml-2">
                            <button
                                onClick={() => setMode('single')}
                                disabled={isAnyRunning}
                                className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                                    mode === 'single' ? 'bg-brand-primary text-white' : 'text-text-secondary hover:text-text-primary'
                                } disabled:opacity-40`}
                            >
                                Single Run
                            </button>
                            <button
                                onClick={() => setMode('optimizer')}
                                disabled={isAnyRunning}
                                className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                                    mode === 'optimizer' ? 'bg-purple-600 text-white' : 'text-text-secondary hover:text-text-primary'
                                } disabled:opacity-40`}
                            >
                                ⚡ Optimizer
                            </button>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        {mode === 'single' && (
                            <>
                                <button
                                    onClick={() => setShowParams(p => !p)}
                                    className="px-3 py-2 bg-bg-light hover:bg-bg-light/80 text-text-secondary rounded-lg text-xs font-semibold transition-colors"
                                >
                                    {showParams ? '▼ 파라미터 접기' : '▶ 파라미터 펼치기'}
                                </button>
                                {isRunning ? (
                                    <button onClick={handleAbort} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold flex items-center gap-2">
                                        <StopIcon className="w-4 h-4" /> 중지
                                    </button>
                                ) : (
                                    <button onClick={handleRun} disabled={isOptRunning} className="px-4 py-2 bg-brand-primary hover:bg-blue-600 text-white rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-40">
                                        <PlayIcon className="w-4 h-4" /> 백테스트 실행
                                    </button>
                                )}
                            </>
                        )}
                        {mode === 'optimizer' && (
                            <>
                                {(isOptRunning || isWfRunning) ? (
                                    <button onClick={handleOptAbort} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold flex items-center gap-2">
                                        <StopIcon className="w-4 h-4" /> 중지
                                    </button>
                                ) : (
                                    <>
                                        <button onClick={handleOptRun} disabled={isRunning} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-40">
                                            ⚡ 최적화
                                        </button>
                                        <button onClick={handleWalkForward} disabled={isRunning} className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-40">
                                            🔬 Walk-Forward
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* Auto-Optimizer 패널 */}
                {mode === 'optimizer' && autoOptimizer && (
                    <div className={`border rounded-lg p-3 mb-3 ${isAutoOptActive ? 'border-amber-500/50 bg-amber-900/10' : 'border-border-color bg-bg-light/30'}`}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-bold">🤖 Auto-Optimizer</span>
                                {isAutoOptActive && autoOptState && (
                                    <>
                                        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-rose-900/40 text-rose-300">
                                            🎯 Ignition WF
                                        </span>
                                        {autoOptState.phase !== 'idle' && (
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                                                autoOptState.phase === 'waiting' ? 'bg-blue-900/40 text-blue-300' :
                                                autoOptState.phase === 'halted' ? 'bg-red-900/40 text-red-300' :
                                                autoOptState.phase === 'watching' ? 'bg-green-900/40 text-green-300' :
                                                'bg-amber-900/40 text-amber-300 animate-pulse'
                                            }`}>
                                                {autoOptState.phase === 'running-normal' ? '▶ Normal' :
                                                 autoOptState.phase === 'running-reverse' ? '▶ Reverse' :
                                                 autoOptState.phase === 'comparing' ? '⚖️ 비교 중' :
                                                 autoOptState.phase === 'waiting' ? '⏳ 대기' :
                                                 autoOptState.phase === 'watching' ? '👀 포지션 감시' :
                                                 autoOptState.phase === 'halted' ? '⛔ 진입중단' : ''}
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                            {isAutoOptActive ? (
                                <button
                                    onClick={() => autoOptimizer!.stop()}
                                    className="px-4 py-1.5 rounded-lg text-xs font-bold transition-colors bg-red-600 hover:bg-red-700 text-white"
                                >
                                    ⏹ 중지
                                </button>
                            ) : (
                                <button
                                    onClick={() => autoOptimizer!.start('ignition-wf')}
                                    className="px-3 py-1.5 rounded-lg text-xs font-bold transition-colors bg-rose-600 hover:bg-rose-700 text-white"
                                >
                                    🎯 Ignition WF
                                </button>
                            )}
                        </div>

                        {isAutoOptActive && autoOptState && (
                            <div className="mt-2 space-y-2">
                                {/* 프로그레스 바 */}
                                {(autoOptState.phase === 'running-normal' || autoOptState.phase === 'running-reverse' || autoOptState.phase === 'comparing' || autoOptState.phase === 'fine-tuning') && (
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px] text-text-secondary">
                                            <span>{autoOptState.progressMsg}</span>
                                            <span>{autoOptState.progressPct}%</span>
                                        </div>
                                        <div className="w-full bg-bg-light rounded-full h-1.5">
                                            <div className={`${autoOptState.phase === 'fine-tuning' ? 'bg-purple-500' : 'bg-amber-500'} h-1.5 rounded-full transition-all duration-300`} style={{ width: `${autoOptState.progressPct}%` }} />
                                        </div>
                                    </div>
                                )}

                                {/* 마지막 결과 */}
                                {autoOptState.lastResult && (
                                    <div className="text-[10px] bg-bg-dark/50 rounded p-2 space-y-0.5">
                                        <div className="text-text-secondary">
                                            마지막 결과 ({new Date(autoOptState.lastResult.timestamp).toLocaleTimeString('ko-KR')})
                                        </div>
                                        <div className="flex gap-4">
                                            <span>
                                                Normal: {autoOptState.lastResult.normalBest
                                                    ? <span className={autoOptState.lastResult.normalBest.valPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                                                        {autoOptState.lastResult.normalBest.valPnlPercent >= 0 ? '+' : ''}{autoOptState.lastResult.normalBest.valPnlPercent.toFixed(1)}% WR={autoOptState.lastResult.normalBest.valWinRate.toFixed(0)}%
                                                      </span>
                                                    : <span className="text-text-secondary/50">N/A</span>}
                                            </span>
                                            <span>
                                                Reverse: {autoOptState.lastResult.reverseBest
                                                    ? <span className={autoOptState.lastResult.reverseBest.valPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                                                        {autoOptState.lastResult.reverseBest.valPnlPercent >= 0 ? '+' : ''}{autoOptState.lastResult.reverseBest.valPnlPercent.toFixed(1)}% WR={autoOptState.lastResult.reverseBest.valWinRate.toFixed(0)}%
                                                      </span>
                                                    : <span className="text-text-secondary/50">N/A</span>}
                                            </span>
                                        </div>
                                        <div className={`font-bold ${
                                            autoOptState.lastResult.applied === 'halted' ? 'text-red-400' : 'text-green-400'
                                        }`}>
                                            {autoOptState.lastResult.applied === 'halted'
                                                ? '⛔ 기준 미달 → 진입 중단'
                                                : `✅ ${autoOptState.lastResult.applied === 'reverse' ? '🔄 REVERSE' : 'NORMAL'} 자동 적용됨`}
                                        </div>
                                    </div>
                                )}

                                {/* 카운트 + 대기 */}
                                <div className="flex items-center gap-3 text-[10px] text-text-secondary">
                                    <span>사이클: {autoOptState.cycleCount}회</span>
                                    {(autoOptState.phase === 'waiting' || autoOptState.phase === 'halted') && autoOptState.waitRemainingMs > 0 && (
                                        <span>{autoOptState.phase === 'halted' ? '재시도' : '다음'}: {Math.ceil(autoOptState.waitRemainingMs / 60000)}분 후</span>
                                    )}
                                    {autoOptState.phase === 'watching' && (
                                        <span className="text-green-400">👀 포지션 진입 대기 → 진입 시 재최적화</span>
                                    )}
                                    {autoOptState.error && (
                                        <span className="text-red-400">⚠️ {autoOptState.error}</span>
                                    )}
                                </div>
                            </div>
                        )}

                        {!isAutoOptActive && (
                            <div className="mt-1 text-[10px] text-text-secondary/60">
                                🎯 Ignition WF: Walk-Forward 최적화 — Normal + Reverse 자동 적용
                            </div>
                        )}
                    </div>
                )}

                {/* Optimizer 설정 */}
                {mode === 'optimizer' && !isOptRunning && !isWfRunning && optStatus !== 'completed' && wfStatus !== 'completed' && (
                    <div className="space-y-3 mb-3">
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-text-secondary whitespace-nowrap">프리셋</span>
                            <div className="flex gap-1.5">
                                {(Object.keys(OPTIMIZER_PRESETS) as OptimizerPresetKey[]).map(key => {
                                    const preset = OPTIMIZER_PRESETS[key];
                                    const combos = countCombos(preset.ranges);
                                    return (
                                        <button
                                            key={key}
                                            onClick={() => setOptPreset(key)}
                                            className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                                optPreset === key
                                                    ? 'bg-rose-600 text-white'
                                                    : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                            }`}
                                        >
                                            {preset.label} ({combos})
                                        </button>
                                    );
                                })}
                            </div>
                            <button
                                onClick={() => setParams(p => ({ ...p, reverseMode: !p.reverseMode }))}
                                className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                    params.reverseMode
                                        ? 'bg-orange-600 text-white animate-pulse'
                                        : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                }`}
                            >
                                🔄 Reverse
                            </button>
                        </div>
                        <div className="text-[10px] text-text-secondary/60">
                            {OPTIMIZER_PRESETS[optPreset].desc} = {countCombos(OPTIMIZER_PRESETS[optPreset].ranges)}개 조합
                            {' | '}종목: {topNLabel(params.topN)} | 기간: {params.periodDays}일
                            {params.reverseMode && <span className="text-orange-400 font-bold"> | 🔄 REVERSE 모드 (시그널 반전)</span>}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {OPTIMIZER_PRESETS[optPreset].ranges.map(r => (
                                <span key={r.key} className="text-[10px] bg-purple-900/30 text-purple-300 px-2 py-0.5 rounded font-mono">
                                    {r.label}: [{r.values.join(', ')}]
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* 프로그레스 (Single Run) */}
                {mode === 'single' && isRunning && (
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs text-text-secondary">
                            <span>{progressMsg}</span>
                            <span>{progressPct}%</span>
                        </div>
                        <div className="w-full bg-bg-light rounded-full h-2">
                            <div className="bg-brand-primary h-2 rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
                        </div>
                    </div>
                )}

                {/* 프로그레스 (Optimizer) */}
                {mode === 'optimizer' && isOptRunning && (
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs text-text-secondary">
                            <span>{optProgressMsg}</span>
                            <span>{optProgressPct}%</span>
                        </div>
                        <div className="w-full bg-bg-light rounded-full h-2">
                            <div className="bg-purple-500 h-2 rounded-full transition-all duration-300" style={{ width: `${optProgressPct}%` }} />
                        </div>
                    </div>
                )}

                {/* 프로그레스 (Walk-Forward) */}
                {mode === 'optimizer' && isWfRunning && (
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs text-text-secondary">
                            <span>🔬 {wfProgressMsg}</span>
                            <span>{wfProgressPct}%</span>
                        </div>
                        <div className="w-full bg-bg-light rounded-full h-2">
                            <div className="bg-teal-500 h-2 rounded-full transition-all duration-300" style={{ width: `${wfProgressPct}%` }} />
                        </div>
                    </div>
                )}

                {mode === 'single' && error && (
                    <div className="mt-2 text-red-400 text-sm">{error}</div>
                )}
                {mode === 'optimizer' && optError && (
                    <div className="mt-2 text-red-400 text-sm">{optError}</div>
                )}
                {mode === 'optimizer' && wfError && (
                    <div className="mt-2 text-red-400 text-sm">WF: {wfError}</div>
                )}
            </div>

            {/* 파라미터 패널 (Single Run 전용 또는 Optimizer 스캔 범위 설정) */}
            {showParams && mode === 'single' && (
                <div className="bg-bg-dark border border-border-color rounded-lg p-4 space-y-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-text-secondary">전략 파라미터</h3>
                        <button
                            onClick={handleResetParams}
                            className="text-[10px] text-text-secondary hover:text-text-primary px-2 py-1 bg-bg-light rounded transition-colors"
                        >
                            기본값 복원
                        </button>
                    </div>

                    {/* TP/SL 그룹 */}
                    <div className="space-y-2">
                        <div className="text-xs font-semibold text-brand-primary">TP / SL</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <ParamSlider
                                label="TP ATR 배수"
                                value={params.tpAtrMultiplier}
                                min={0.5} max={5.0} step={0.1}
                                onChange={v => updateParam('tpAtrMultiplier', v)}
                                disabled={isRunning}
                                hint="익절 목표 = ATR × N"
                            />
                            <ParamSlider
                                label="SL ATR 배수"
                                value={params.slAtrMultiplier}
                                min={0.5} max={4.0} step={0.1}
                                onChange={v => updateParam('slAtrMultiplier', v)}
                                disabled={isRunning}
                                hint="손절 기준 = ATR × N"
                            />
                            <ParamSlider
                                label="최소 R:R"
                                value={params.minRiskReward}
                                min={0.5} max={4.0} step={0.1}
                                onChange={v => updateParam('minRiskReward', v)}
                                disabled={isRunning}
                                hint="리스크/리워드 최소 비율"
                            />
                            <ParamSlider
                                label="TP1 위치"
                                value={params.partialTp1Ratio}
                                min={0.2} max={0.9} step={0.05}
                                onChange={v => updateParam('partialTp1Ratio', v)}
                                disabled={isRunning}
                                format={v => `${(v * 100).toFixed(0)}%`}
                                hint={`TP 거리의 ${(params.partialTp1Ratio * 100).toFixed(0)}%에서 1차 익절`}
                            />
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <ParamSlider
                                label="TP1 물량"
                                value={params.partialQty1}
                                min={0.2} max={0.8} step={0.05}
                                onChange={v => updateParam('partialQty1', v)}
                                disabled={isRunning}
                                format={v => `${(v * 100).toFixed(0)}%`}
                                hint={`1차에서 ${(params.partialQty1 * 100).toFixed(0)}% 익절, 나머지 ${((1 - params.partialQty1) * 100).toFixed(0)}%는 TP2`}
                            />
                        </div>
                    </div>

                    {/* 비중 + 포지션 그룹 */}
                    <div className="space-y-2">
                        <div className="text-xs font-semibold text-brand-primary">비중 / 포지션</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <ParamSlider
                                label="포지션 비중"
                                value={params.baseSizePercent}
                                min={5} max={50} step={5}
                                onChange={v => updateParam('baseSizePercent', v)}
                                disabled={isRunning}
                                format={v => `${v}%`}
                                hint={`각 포지션에 자본의 ${params.baseSizePercent}% 투입`}
                            />
                            <ParamSlider
                                label="최대 포지션"
                                value={params.maxPositions}
                                min={1} max={20} step={1}
                                onChange={v => updateParam('maxPositions', v)}
                                disabled={isRunning}
                                format={v => `${v}개`}
                                hint={`동시 최대 ${params.maxPositions}개 포지션`}
                            />
                        </div>
                    </div>

                    {/* 방향 + 필터 그룹 */}
                    <div className="space-y-2">
                        <div className="text-xs font-semibold text-brand-primary">방향 / 필터</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <ParamSlider
                                label="Short 배수"
                                value={params.shortMultiplier}
                                min={0} max={1.5} step={0.05}
                                onChange={v => updateParam('shortMultiplier', v)}
                                disabled={isRunning}
                                hint="Short 신호 가중치 (0=차단, 1=중립)"
                            />
                            <ParamSlider
                                label="ADX 최소값"
                                value={params.adxGateMinimum}
                                min={10} max={40} step={1}
                                onChange={v => updateParam('adxGateMinimum', v)}
                                disabled={isRunning}
                                hint="추세 강도 최소값 (낮을수록 진입 잦음)"
                            />
                        </div>
                    </div>

                    {/* 레버리지 그룹 */}
                    <div className="space-y-2">
                        <div className="text-xs font-semibold text-brand-primary">레버리지 (레짐별)</div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            <ParamSlider
                                label="TRENDING"
                                value={params.leverageTrending}
                                min={1} max={30} step={1}
                                onChange={v => updateParam('leverageTrending', v)}
                                disabled={isRunning}
                                format={v => `${v}x`}
                                hint="추세장 최대 레버리지"
                            />
                            <ParamSlider
                                label="RANGING"
                                value={params.leverageRanging}
                                min={1} max={20} step={1}
                                onChange={v => updateParam('leverageRanging', v)}
                                disabled={isRunning}
                                format={v => `${v}x`}
                                hint="횡보장 최대 레버리지"
                            />
                            <ParamSlider
                                label="VOLATILE"
                                value={params.leverageVolatile}
                                min={1} max={15} step={1}
                                onChange={v => updateParam('leverageVolatile', v)}
                                disabled={isRunning}
                                format={v => `${v}x`}
                                hint="변동장 최대 레버리지"
                            />
                        </div>
                    </div>

                    {/* 스캔 범위 */}
                    <div className="space-y-3">
                        <div className="text-xs font-semibold text-brand-primary">스캔 범위</div>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-text-secondary whitespace-nowrap w-12">방식</span>
                            <div className="flex gap-1.5">
                                <button
                                    onClick={() => setBtMode('rolling')}
                                    disabled={isAnyRunning}
                                    className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                        btMode === 'rolling'
                                            ? 'bg-green-600 text-white'
                                            : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                    } disabled:opacity-40`}
                                >
                                    Rolling Scan
                                </button>
                                <button
                                    onClick={() => setBtMode('static')}
                                    disabled={isAnyRunning}
                                    className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                        btMode === 'static'
                                            ? 'bg-brand-primary text-white'
                                            : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                    } disabled:opacity-40`}
                                >
                                    Static (현재 종목 고정)
                                </button>
                            </div>
                            <span className="text-[10px] text-text-secondary/50">
                                {btMode === 'rolling'
                                    ? '매 24h마다 급등/급락 종목 재스캔 (현실적)'
                                    : '현재 급등/급락 종목 고정 (과거 적용)'
                                }
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-text-secondary whitespace-nowrap w-12">기간</span>
                            <div className="flex gap-1.5">
                                {PERIOD_OPTIONS.map(p => (
                                    <button
                                        key={p.days}
                                        onClick={() => updateParam('periodDays', p.days)}
                                        disabled={isRunning}
                                        className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                            params.periodDays === p.days
                                                ? 'bg-brand-primary text-white'
                                                : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <span className="text-[10px] text-text-secondary/50">
                                {PERIOD_OPTIONS.find(p => p.days === params.periodDays)?.klines ?? 0} 캔들 (5m)
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-text-secondary whitespace-nowrap w-12">종목 수</span>
                            <div className="flex gap-1.5">
                                {TOP_N_OPTIONS.map(n => (
                                    <button
                                        key={n}
                                        onClick={() => updateParam('topN', n)}
                                        disabled={isRunning}
                                        className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                                            params.topN === n
                                                ? 'bg-brand-primary text-white'
                                                : 'bg-bg-light text-text-secondary hover:text-text-primary'
                                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                                    >
                                        {topNLabel(n)}
                                    </button>
                                ))}
                            </div>
                            <span className="text-[10px] text-text-secondary/50">
                                {params.topN === 0
                                    ? '거래량 $2M+ 전체 (~100-200개)'
                                    : `|변동률| 상위 ${params.topN}개`
                                }
                            </span>
                        </div>
                    </div>

                    {/* 현재 설정 요약 */}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <ParamBadge label="TP" value={`ATR×${params.tpAtrMultiplier}`} />
                        <ParamBadge label="SL" value={`ATR×${params.slAtrMultiplier}`} />
                        <ParamBadge label="R:R" value={`≥${params.minRiskReward}`} />
                        <ParamBadge label="Short" value={`×${params.shortMultiplier}`} />
                        <ParamBadge label="ADX" value={`≥${params.adxGateMinimum}`} />
                        <ParamBadge label="Lev" value="동적(SL→50%)" />
                        <ParamBadge label="TP1" value={`${(params.partialTp1Ratio * 100).toFixed(0)}%@${(params.partialQty1 * 100).toFixed(0)}%`} />
                        <ParamBadge label="비중" value={`${params.baseSizePercent}%`} />
                        <ParamBadge label="포지션" value={`${params.maxPositions}개`} />
                        <ParamBadge label="종목" value={topNLabel(params.topN)} />
                        <ParamBadge label="기간" value={PERIOD_OPTIONS.find(p => p.days === params.periodDays)?.label ?? `${params.periodDays}h`} />
                    </div>
                </div>
            )}

            {/* Single Run 결과 */}
            {mode === 'single' && summary && status === 'completed' && (
                <>
                    {/* 서머리 카드 + 실전 적용 */}
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-text-secondary">백테스트 결과</h3>
                        {onApplyLive && (
                            <button
                                onClick={handleSingleApplyLive}
                                disabled={isAutoOptActive}
                                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
                                    isAutoOptActive
                                        ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                        : 'bg-red-600 hover:bg-red-700 text-white'
                                }`}
                                title={isAutoOptActive ? 'Auto-Optimizer 활성화 중에는 수동 적용 불가' : ''}
                            >
                                🔴 실전 적용
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <StatCard label="총 거래" value={`${summary.totalTrades}`} />
                        <StatCard label="승률" value={`${summary.overallWinRate.toFixed(1)}%`} color={summary.overallWinRate >= 50 ? 'green' : 'red'} />
                        <StatCard label="총 PnL" value={`${summary.totalPnlPercent >= 0 ? '+' : ''}${summary.totalPnlPercent.toFixed(2)}%`} color={summary.totalPnlPercent >= 0 ? 'green' : 'red'} />
                        <StatCard label="최대 낙폭" value={`-${summary.maxDrawdownPercent.toFixed(2)}%`} color="red" />
                        <StatCard label="평균 수익" value={`+${summary.avgWinPercent.toFixed(2)}%`} color="green" />
                        <StatCard label="평균 손실" value={`${summary.avgLossPercent.toFixed(2)}%`} color="red" />
                        <StatCard label="Profit Factor" value={summary.profitFactor >= 999 ? '∞' : summary.profitFactor.toFixed(2)} color={summary.profitFactor >= 1.5 ? 'green' : summary.profitFactor >= 1 ? 'yellow' : 'red'} />
                        <StatCard label="소요시간" value={`${(summary.durationMs / 1000).toFixed(1)}초`} />
                    </div>

                    {/* DD 관리 통계 */}
                    {summary.ddManagement && (summary.ddManagement.tradesSkipped > 0 || summary.ddManagement.tradesReduced > 0) && (
                        <div className="bg-bg-dark border border-blue-600/30 rounded-lg p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-blue-400 text-sm">🛡</span>
                                <h3 className="text-xs font-semibold text-blue-400">DD 관리 적용됨</h3>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                <div className="text-text-secondary">스킵 거래: <span className="text-yellow-400 font-mono">{summary.ddManagement.tradesSkipped}</span></div>
                                <div className="text-text-secondary">축소 진입: <span className="text-yellow-400 font-mono">{summary.ddManagement.tradesReduced}</span></div>
                                <div className="text-text-secondary">최대 연패: <span className="text-red-400 font-mono">{summary.ddManagement.maxConsecutiveLosses}</span></div>
                                <div className="text-text-secondary">서킷브레이커: <span className="text-red-400 font-mono">{summary.ddManagement.circuitBreakerHits}회</span></div>
                            </div>
                        </div>
                    )}

                    {/* 추천 파라미터 */}
                    {recommendations.length > 0 && (
                        <div className="bg-bg-dark border border-yellow-600/30 rounded-lg p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="text-yellow-400 text-sm">💡</span>
                                    <h3 className="text-sm font-semibold text-yellow-400">추천 파라미터 변경</h3>
                                    <span className="text-[10px] text-text-secondary">백테스트 결과 기반</span>
                                </div>
                                <button
                                    onClick={applyAllAndRun}
                                    disabled={isRunning}
                                    className="text-[10px] px-2 py-1 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 rounded transition-colors font-semibold disabled:opacity-40"
                                >
                                    전체 적용 + 재실행 →
                                </button>
                            </div>
                            <div className="space-y-2">
                                {recommendations.map(rec => (
                                    <div key={rec.id} className="flex items-start gap-3 bg-bg-light/30 rounded-lg px-3 py-2">
                                        <span className={`text-[10px] mt-0.5 px-1.5 py-0.5 rounded font-bold shrink-0 ${
                                            rec.impact === 'high' ? 'bg-red-900/40 text-red-400' :
                                            rec.impact === 'medium' ? 'bg-yellow-900/40 text-yellow-400' :
                                            'bg-blue-900/40 text-blue-400'
                                        }`}>
                                            {rec.impact === 'high' ? '높음' : rec.impact === 'medium' ? '중간' : '낮음'}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-semibold text-text-primary">{rec.title}</div>
                                            <div className="text-[10px] text-text-secondary mt-0.5">{rec.reason}</div>
                                            <div className="flex flex-wrap gap-1 mt-1">
                                                {Object.entries(rec.changes).map(([key, val]) => (
                                                    <span key={key} className="text-[9px] font-mono bg-bg-light px-1.5 py-0.5 rounded text-brand-primary">
                                                        {key}: {typeof val === 'number' ? val : val}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-1 shrink-0">
                                            <button
                                                onClick={() => applyRecommendation(rec)}
                                                className="text-[10px] px-2 py-1 bg-brand-primary/20 hover:bg-brand-primary/30 text-brand-primary rounded transition-colors font-semibold"
                                            >
                                                적용
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="text-[10px] text-text-secondary/50 pt-1">
                                파라미터 적용 후 "백테스트 실행"을 눌러 결과를 비교하세요
                            </div>
                        </div>
                    )}

                    {/* 에쿼티 커브 */}
                    {summary.equityCurve.length > 1 && (
                        <div className="bg-bg-dark border border-border-color rounded-lg p-4">
                            <h3 className="text-sm font-semibold mb-3 text-text-secondary">에쿼티 커브</h3>
                            <ResponsiveContainer width="100%" height={250}>
                                <LineChart data={summary.equityCurve}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                    <XAxis
                                        dataKey="time"
                                        tickFormatter={(t) => new Date(t).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                                        stroke="#6B7280" fontSize={10}
                                    />
                                    <YAxis stroke="#6B7280" fontSize={10} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                                        labelFormatter={(t) => new Date(t as number).toLocaleString('ko-KR')}
                                        formatter={(v: number) => [`${v.toFixed(2)}%`, '에쿼티']}
                                    />
                                    <ReferenceLine y={100} stroke="#6B7280" strokeDasharray="3 3" />
                                    <Line type="monotone" dataKey="equity" stroke="#10B981" dot={false} strokeWidth={2} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* 종목별 랭킹 (정렬 가능) */}
                    <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
                        <div className="px-4 py-2 bg-bg-light/50 border-b border-border-color flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-text-secondary">종목별 랭킹</h3>
                            <span className="text-[10px] text-text-secondary">헤더 클릭으로 정렬</span>
                        </div>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-bg-light text-text-secondary text-xs">
                                    <SortHeader label="종목" sortKey="ticker" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="left" className="px-4" />
                                    <SortHeader label="거래" sortKey="totalTrades" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="center" />
                                    <SortHeader label="승률" sortKey="winRate" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="center" />
                                    <SortHeader label="PnL%" sortKey="totalPnlPercent" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                                    <SortHeader label="평균수익" sortKey="avgWinPercent" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                                    <SortHeader label="평균손실" sortKey="avgLossPercent" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                                    <SortHeader label="MaxDD" sortKey="maxDrawdownPercent" currentKey={sortKey} dir={sortDir} onSort={handleSort} align="right" className="px-4" />
                                </tr>
                            </thead>
                            <tbody>
                                {sortedTickers.map((tr, rank) => (
                                    <React.Fragment key={tr.ticker}>
                                        <tr
                                            className="border-t border-border-color hover:bg-bg-light/50 cursor-pointer transition-colors"
                                            onClick={() => setExpandedTicker(expandedTicker === tr.ticker ? null : tr.ticker)}
                                        >
                                            <td className="px-4 py-2 font-mono font-semibold">
                                                <span className="text-text-secondary text-xs mr-1.5">#{rank + 1}</span>
                                                {expandedTicker === tr.ticker ? '▼' : '▶'} {tr.ticker.replace('USDT', '')}
                                            </td>
                                            <td className="text-center px-2 py-2">{tr.totalTrades}</td>
                                            <td className="text-center px-2 py-2">
                                                <span className={tr.winRate >= 50 ? 'text-green-400' : 'text-red-400'}>
                                                    {tr.winRate.toFixed(0)}%
                                                </span>
                                            </td>
                                            <td className={`text-right px-2 py-2 font-mono ${tr.totalPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {tr.totalPnlPercent >= 0 ? '+' : ''}{tr.totalPnlPercent.toFixed(2)}%
                                            </td>
                                            <td className="text-right px-2 py-2 text-green-400 font-mono">+{tr.avgWinPercent.toFixed(2)}%</td>
                                            <td className="text-right px-2 py-2 text-red-400 font-mono">{tr.avgLossPercent.toFixed(2)}%</td>
                                            <td className="text-right px-4 py-2 text-red-400 font-mono">-{tr.maxDrawdownPercent.toFixed(2)}%</td>
                                        </tr>
                                        {expandedTicker === tr.ticker && (
                                            <tr>
                                                <td colSpan={7} className="bg-bg-main/50">
                                                    <TradeDetailTable result={tr} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {/* 실전 적용 알림 */}
            {liveAppliedMsg && (
                <div className="bg-green-900/30 border border-green-500/50 rounded-lg p-3 animate-fade-in">
                    <span className="text-green-400 text-sm font-semibold">✅ {liveAppliedMsg}</span>
                </div>
            )}

            {/* Optimizer 결과 */}
            {mode === 'optimizer' && optSummary && optStatus === 'completed' && (
                <OptimizerResults
                    summary={optSummary}
                    currentParams={params}
                    onApply={handleApplyCombo}
                    onApplyLive={onApplyLive && !isAutoOptActive ? handleApplyLive : undefined}
                />
            )}

            {/* Walk-Forward 결과 */}
            {mode === 'optimizer' && wfSummary && wfStatus === 'completed' && (
                <WalkForwardResults summary={wfSummary} />
            )}

            {/* 대기 상태 */}
            {mode === 'single' && status === 'idle' && !summary && (
                <div className="text-center py-16 text-text-secondary">
                    <BeakerIcon className="w-12 h-12 mx-auto mb-4 opacity-30" />
                    <p className="text-sm">백테스트를 실행하면 급등/급락 상위 {topNLabel(params.topN)} 종목의<br/>과거 {params.periodDays}일 데이터를 분석합니다.</p>
                    <p className="text-xs mt-2 text-text-secondary/60">위 파라미터를 조절한 뒤 실행하세요</p>
                </div>
            )}
            {mode === 'optimizer' && optStatus === 'idle' && wfStatus !== 'completed' && !optSummary && (
                <div className="text-center py-16 text-text-secondary">
                    <div className="text-4xl mb-4 opacity-30">⚡</div>
                    <p className="text-sm">프리셋을 선택하고 실행하세요</p>
                    <p className="text-xs mt-2 text-text-secondary/60">
                        <span className="text-purple-300">⚡ 최적화</span>: 최적 파라미터 탐색 |{' '}
                        <span className="text-teal-300">🔬 Walk-Forward</span>: 과적합 검증 (7일 데이터, 학습→검증 반복)
                    </p>
                </div>
            )}
        </div>
    );
};

// ── 서브 컴포넌트 ──

const ParamSlider: React.FC<{
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (v: number) => void;
    disabled?: boolean;
    format?: (v: number) => string;
    hint?: string;
}> = ({ label, value, min, max, step, onChange, disabled, format, hint }) => {
    const display = format ? format(value) : (Number.isInteger(step) ? value.toString() : value.toFixed(step < 0.1 ? 2 : 1));
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <label className="text-xs text-text-secondary">{label}</label>
                <span className="text-xs font-mono font-semibold text-text-primary">{display}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(parseFloat(e.target.value))}
                disabled={disabled}
                className="w-full h-1.5 bg-bg-light rounded-lg appearance-none cursor-pointer accent-brand-primary disabled:opacity-40 disabled:cursor-not-allowed"
            />
            {hint && <div className="text-[10px] text-text-secondary/50 leading-tight">{hint}</div>}
        </div>
    );
};

const ParamBadge: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <span className="text-[10px] bg-bg-light px-2 py-0.5 rounded font-mono">
        <span className="text-text-secondary">{label}</span>{' '}
        <span className="text-text-primary font-semibold">{value}</span>
    </span>
);

const SortHeader: React.FC<{
    label: string;
    sortKey: SortKey;
    currentKey: SortKey;
    dir: SortDir;
    onSort: (key: SortKey) => void;
    align: 'left' | 'center' | 'right';
    className?: string;
}> = ({ label, sortKey, currentKey, dir, onSort, align, className }) => {
    const isActive = sortKey === currentKey;
    const arrow = isActive ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const alignClass = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
    return (
        <th
            className={`${alignClass} px-2 py-2 cursor-pointer select-none hover:text-text-primary transition-colors ${isActive ? 'text-brand-primary' : ''} ${className || ''}`}
            onClick={() => onSort(sortKey)}
        >
            {label}{arrow}
        </th>
    );
};

const StatCard: React.FC<{ label: string; value: string; color?: 'green' | 'red' | 'yellow' }> = ({ label, value, color }) => (
    <div className="bg-bg-dark border border-border-color rounded-lg p-3 text-center">
        <div className="text-xs text-text-secondary mb-1">{label}</div>
        <div className={`text-lg font-bold font-mono ${
            color === 'green' ? 'text-green-400' :
            color === 'red' ? 'text-red-400' :
            color === 'yellow' ? 'text-yellow-400' : 'text-text-primary'
        }`}>{value}</div>
    </div>
);

const TradeDetailTable: React.FC<{ result: BacktestTickerResult }> = ({ result }) => (
    <div className="px-6 py-2">
        <table className="w-full text-xs">
            <thead>
                <tr className="text-text-secondary">
                    <th className="text-left py-1">방향</th>
                    <th className="text-right py-1">진입가</th>
                    <th className="text-right py-1">청산가</th>
                    <th className="text-right py-1">PnL%</th>
                    <th className="text-center py-1">이유</th>
                    <th className="text-center py-1">레짐</th>
                    <th className="text-center py-1">봉수</th>
                    <th className="text-right py-1">시간</th>
                </tr>
            </thead>
            <tbody>
                {result.trades.map((t, i) => (
                    <tr key={i} className="border-t border-border-color/30">
                        <td className="py-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                t.direction === 'Long' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
                            }`}>
                                {t.direction === 'Long' ? 'L' : 'S'}
                            </span>
                        </td>
                        <td className="text-right py-1 font-mono">{formatPrice(t.entryPrice)}</td>
                        <td className="text-right py-1 font-mono">{formatPrice(t.exitPrice)}</td>
                        <td className={`text-right py-1 font-mono font-semibold ${t.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%
                        </td>
                        <td className="text-center py-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                t.exitReason === 'TP2' ? 'bg-green-900/40 text-green-400' :
                                t.exitReason === 'TP1' ? 'bg-blue-900/40 text-blue-400' :
                                t.exitReason === 'TRAILING_SL' ? 'bg-yellow-900/40 text-yellow-400' :
                                t.exitReason === 'SL' ? 'bg-red-900/40 text-red-400' :
                                'bg-gray-700 text-gray-400'
                            }`}>
                                {t.exitReason === 'TRAILING_SL' ? 'T-SL' : t.exitReason}
                            </span>
                        </td>
                        <td className="text-center py-1 text-text-secondary">{t.regime}</td>
                        <td className="text-center py-1">{t.barsHeld}h</td>
                        <td className="text-right py-1 text-text-secondary">{new Date(t.entryTime).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

function formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(1);
    if (price >= 1) return price.toFixed(3);
    return price.toFixed(6);
}

// ── Optimizer 결과 컴포넌트 ──

const PARAM_LABELS: Record<string, string> = {
    tpAtrMultiplier: 'TP',
    slAtrMultiplier: 'SL',
    minRiskReward: 'R:R',
    shortMultiplier: 'Short',
    adxGateMinimum: 'ADX',
    leverageTrending: 'Lev-T',
    leverageRanging: 'Lev-R',
    leverageVolatile: 'Lev-V',
    partialTp1Ratio: 'TP1%',
    partialQty1: 'TP1Qty',
    baseSizePercent: '비중%',
    maxPositions: '포지션',
    topN: '스캔',
    periodDays: '기간',
    scoreThreshold: '확신도',
    activeSession: '시간대',
};

type OptSortKey = 'rank' | 'fitnessScore' | 'compositeScore' | 'totalPnlPercent' | 'overallWinRate' | 'maxDrawdownPercent' | 'profitFactor' | 'totalTrades' | 'valPnlPercent' | 'valWinRate' | 'valMaxDD' | 'valProfitFactor' | 'valTrades' | 'survivalRate' | 'maxConsecLosses';

const PERIOD_DISPLAY: Record<number, string> = { 4: '4h', 8: '8h', 12: '12h', 24: '1일', 72: '3일', 168: '7일' };
function fmtPeriod(days: number): string { return PERIOD_DISPLAY[days] ?? `${days}h`; }

const OptimizerResults: React.FC<{
    summary: OptimizerSummary;
    currentParams: BacktestParams;
    onApply: (combo: OptimizerComboResult) => void;
    onApplyLive?: (combo: OptimizerComboResult) => void;
}> = ({ summary, currentParams, onApply, onApplyLive }) => {
    const [optSortKey, setOptSortKey] = useState<OptSortKey>('valPnlPercent');
    const [optSortDir, setOptSortDir] = useState<'asc' | 'desc'>('desc');

    const handleOptSort = useCallback((key: OptSortKey) => {
        setOptSortDir(prev => optSortKey === key ? (prev === 'asc' ? 'desc' : 'asc') : (key === 'rank' ? 'asc' : 'desc'));
        setOptSortKey(key);
    }, [optSortKey]);

    const sorted = useMemo(() => {
        const arr = [...summary.results];
        arr.sort((a, b) => {
            const aVal = optSortKey === 'compositeScore' ? (a.compositeScore ?? a.fitnessScore) : (a[optSortKey] as number);
            const bVal = optSortKey === 'compositeScore' ? (b.compositeScore ?? b.fitnessScore) : (b[optSortKey] as number);
            const cmp = aVal - bVal;
            return optSortDir === 'asc' ? cmp : -cmp;
        });
        return arr;
    }, [summary.results, optSortKey, optSortDir]);

    const best = summary.results[0];
    if (!best) return null;
    const hasMC = summary.results.some(r => r.survivalRate > 0);

    // 변경된 파라미터 키들
    const changedKeys = Object.keys(PARAM_LABELS).filter(key => {
        const k = key as keyof BacktestParams;
        return best.params[k] !== currentParams[k];
    });

    return (
        <>
            {/* Best 카드 */}
            <div className="bg-bg-dark border border-purple-600/40 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🏆</span>
                        <h3 className="text-sm font-bold text-purple-300">최적 파라미터</h3>
                        <span className="text-[10px] text-text-secondary">
                            {summary.completedCombos}/{summary.totalCombos}개 조합 | {(summary.elapsedMs / 1000).toFixed(1)}초
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => onApply(best)}
                            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold transition-colors"
                        >
                            백테스트 적용
                        </button>
                        {onApplyLive && (
                            <button
                                onClick={() => { if (confirm('이 파라미터를 실전 거래에 적용합니다. 계속하시겠습니까?')) onApplyLive(best); }}
                                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition-colors"
                            >
                                🔴 실전 적용
                            </button>
                        )}
                    </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <MiniStat label="학습 PnL" value={`${best.totalPnlPercent >= 0 ? '+' : ''}${best.totalPnlPercent.toFixed(1)}%`} color={best.totalPnlPercent >= 0 ? 'green' : 'red'} />
                    <MiniStat label="학습 승률" value={`${best.overallWinRate.toFixed(0)}%`} color={best.overallWinRate >= 50 ? 'green' : 'red'} />
                    <MiniStat label={best.compositeScore != null ? '종합' : 'Score'} value={(best.compositeScore ?? best.fitnessScore).toFixed(2)} color="purple" />
                    <MiniStat label="검증 PnL" value={`${best.valPnlPercent >= 0 ? '+' : ''}${best.valPnlPercent.toFixed(1)}%`} color={best.valPnlPercent >= 0 ? 'green' : 'red'} />
                    <MiniStat label="검증 승률" value={`${best.valWinRate.toFixed(0)}%`} color={best.valWinRate >= 50 ? 'green' : 'red'} />
                    {hasMC && <MiniStat label="생존율" value={`${best.survivalRate.toFixed(0)}%`} color={best.survivalRate >= 90 ? 'green' : best.survivalRate >= 70 ? 'yellow' : 'red'} />}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {Object.entries(PARAM_LABELS).map(([key, label]) => {
                        const k = key as keyof BacktestParams;
                        const val = best.params[k];
                        const changed = val !== currentParams[k];
                        const SESSION_LABELS_BEST: Record<number, string> = { 0: '전체', 1: '아시아', 2: '유럽', 3: '미국' };
                        const display = key === 'periodDays' ? fmtPeriod(val as number) : key === 'activeSession' ? (SESSION_LABELS_BEST[val as number] ?? val) : (typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(1)) : val);
                        return (
                            <span
                                key={key}
                                className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                                    changed
                                        ? 'bg-yellow-900/40 text-yellow-300 ring-1 ring-yellow-600/50'
                                        : 'bg-bg-light text-text-secondary'
                                }`}
                            >
                                {label}: {display}
                            </span>
                        );
                    })}
                </div>
                {changedKeys.length > 0 && (
                    <div className="text-[10px] text-yellow-400/60">
                        🟡 현재 설정과 다른 값이 하이라이트됩니다
                    </div>
                )}
            </div>

            {/* 랭킹 테이블 */}
            <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-bg-light/50 border-b border-border-color flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-text-secondary">파라미터 랭킹 (상위 {summary.results.length}개)</h3>
                    <span className="text-[10px] text-text-secondary">
                        {summary.cachedTickers.length}종목 기준 | 헤더 클릭으로 정렬
                    </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table className="text-xs" style={{ width: 'max-content', minWidth: '100%' }}>
                        <thead>
                            <tr className="bg-bg-light text-text-secondary">
                                <OptHeader label="#" sortKey="rank" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" />
                                {Object.entries(PARAM_LABELS).map(([key, label]) => (
                                    <th key={key} className="px-2 py-2 text-center font-semibold whitespace-nowrap">{label}</th>
                                ))}
                                <OptHeader label="학습PnL" sortKey="totalPnlPercent" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="right" />
                                <OptHeader label="학습WR" sortKey="overallWinRate" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" />
                                {hasMC
                                    ? <OptHeader label="종합" sortKey="compositeScore" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="right" />
                                    : <OptHeader label="Score" sortKey="fitnessScore" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="right" />
                                }
                                <th className="px-1 py-2 text-center text-text-secondary/30">│</th>
                                <OptHeader label="검증PnL" sortKey="valPnlPercent" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="right" />
                                <OptHeader label="검증WR" sortKey="valWinRate" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" />
                                <OptHeader label="검증DD" sortKey="valMaxDD" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="right" />
                                <OptHeader label="검증PF" sortKey="valProfitFactor" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" />
                                {hasMC && <><th className="px-1 py-2 text-center text-text-secondary/30">│</th>
                                <OptHeader label="생존율" sortKey="survivalRate" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" />
                                <OptHeader label="연패" sortKey="maxConsecLosses" current={optSortKey} dir={optSortDir} onSort={handleOptSort} align="center" /></>}
                                <th className="px-2 py-2 text-center"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map(combo => (
                                <tr key={combo.rank} className={`border-t border-border-color hover:bg-bg-light/50 transition-colors ${combo.rank <= 3 ? 'bg-purple-900/10' : ''}`}>
                                    <td className="text-center px-2 py-1.5 font-bold">
                                        {combo.rank <= 3 ? ['🥇', '🥈', '🥉'][combo.rank - 1] : combo.rank}
                                    </td>
                                    {Object.keys(PARAM_LABELS).map(key => {
                                        const k = key as keyof BacktestParams;
                                        const val = combo.params[k] as number;
                                        const changed = val !== currentParams[k];
                                        const SESSION_LABELS: Record<number, string> = { 0: '전체', 1: '아시아', 2: '유럽', 3: '미국' };
                                        const display = key === 'periodDays' ? fmtPeriod(val) : key === 'activeSession' ? (SESSION_LABELS[val] ?? val) : (Number.isInteger(val) ? val : val.toFixed(1));
                                        return (
                                            <td key={key} className={`text-center px-1 py-1.5 font-mono whitespace-nowrap ${changed ? 'text-yellow-300' : 'text-text-secondary'}`}>
                                                {display}
                                            </td>
                                        );
                                    })}
                                    <td className={`text-right px-2 py-1.5 font-mono font-semibold ${combo.totalPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {combo.totalPnlPercent >= 0 ? '+' : ''}{combo.totalPnlPercent.toFixed(1)}%
                                    </td>
                                    <td className={`text-center px-2 py-1.5 ${combo.overallWinRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                        {combo.overallWinRate.toFixed(0)}%
                                    </td>
                                    <td className="text-right px-2 py-1.5 font-mono text-purple-300 font-semibold">{(combo.compositeScore ?? combo.fitnessScore).toFixed(2)}</td>
                                    <td className="px-1 py-1.5 text-center text-text-secondary/20">│</td>
                                    <td className={`text-right px-2 py-1.5 font-mono font-semibold ${combo.valPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {combo.valPnlPercent >= 0 ? '+' : ''}{combo.valPnlPercent.toFixed(1)}%
                                    </td>
                                    <td className={`text-center px-2 py-1.5 ${combo.valWinRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                        {combo.valWinRate.toFixed(0)}%
                                    </td>
                                    <td className="text-right px-2 py-1.5 text-red-400 font-mono">-{combo.valMaxDD.toFixed(1)}%</td>
                                    <td className={`text-center px-2 py-1.5 ${combo.valProfitFactor >= 1.5 ? 'text-green-400' : combo.valProfitFactor >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                                        {combo.valProfitFactor >= 999 ? '∞' : combo.valProfitFactor.toFixed(1)}
                                    </td>
                                    {hasMC && <>
                                    <td className="px-1 py-1.5 text-center text-text-secondary/20">│</td>
                                    <td className={`text-center px-2 py-1.5 font-mono font-semibold ${combo.survivalRate >= 90 ? 'text-green-400' : combo.survivalRate >= 70 ? 'text-yellow-400' : 'text-red-400'}`}>
                                        {combo.survivalRate.toFixed(0)}%
                                    </td>
                                    <td className={`text-center px-2 py-1.5 font-mono ${combo.maxConsecLosses >= 4 ? 'text-red-400' : combo.maxConsecLosses >= 3 ? 'text-yellow-400' : 'text-green-400'}`}>
                                        {combo.maxConsecLosses}
                                    </td>
                                    </>}
                                    <td className="text-center px-2 py-1.5">
                                        <div className="flex items-center gap-1 justify-center">
                                            <button
                                                onClick={() => onApply(combo)}
                                                className="text-[10px] px-2 py-0.5 bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 rounded transition-colors font-semibold"
                                            >
                                                적용
                                            </button>
                                            {onApplyLive && (
                                                <button
                                                    onClick={() => { if (confirm('실전 적용?')) onApplyLive(combo); }}
                                                    className="text-[10px] px-2 py-0.5 bg-red-600/20 hover:bg-red-600/40 text-red-300 rounded transition-colors font-semibold"
                                                >
                                                    실전
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 과적합 경고 */}
            <div className="text-[10px] text-text-secondary/40 text-center">
                과거 데이터 기반 최적화 결과이며, 미래 수익을 보장하지 않습니다. 과적합(overfitting)에 주의하세요.
            </div>
        </>
    );
};

const MiniStat: React.FC<{ label: string; value: string; color: 'green' | 'red' | 'yellow' | 'purple' }> = ({ label, value, color }) => (
    <div className="bg-bg-light rounded px-3 py-1.5 text-center">
        <div className="text-[10px] text-text-secondary">{label}</div>
        <div className={`text-sm font-bold font-mono ${
            color === 'green' ? 'text-green-400' :
            color === 'red' ? 'text-red-400' :
            color === 'yellow' ? 'text-yellow-400' :
            'text-purple-300'
        }`}>{value}</div>
    </div>
);

const OptHeader: React.FC<{
    label: string;
    sortKey: OptSortKey;
    current: OptSortKey;
    dir: 'asc' | 'desc';
    onSort: (key: OptSortKey) => void;
    align: 'left' | 'center' | 'right';
}> = ({ label, sortKey, current, dir, onSort, align }) => {
    const isActive = sortKey === current;
    const arrow = isActive ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const alignClass = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
    return (
        <th
            className={`${alignClass} px-2 py-2 cursor-pointer select-none hover:text-text-primary transition-colors font-semibold ${isActive ? 'text-purple-300' : ''}`}
            onClick={() => onSort(sortKey)}
        >
            {label}{arrow}
        </th>
    );
};

// ── Walk-Forward 결과 컴포넌트 ──

const WalkForwardResults: React.FC<{ summary: WalkForwardSummary }> = ({ summary }) => {
    const { windows, avgTrainPnl, avgTestPnl, avgTestWinRate, totalTestTrades, avgTestMaxDD, overfitRatio, elapsedMs, totalCombosPerWindow, cachedTickers } = summary;

    // 과적합 등급 판정
    const getOverfitGrade = (ratio: number): { label: string; color: string; desc: string } => {
        if (ratio <= 1.5) return { label: '양호', color: 'text-green-400', desc: '학습/검증 성과 일관성 높음' };
        if (ratio <= 3.0) return { label: '주의', color: 'text-yellow-400', desc: '약간의 과적합 징후' };
        if (ratio <= 5.0) return { label: '위험', color: 'text-orange-400', desc: '상당한 과적합 — 파라미터 단순화 권장' };
        return { label: '심각', color: 'text-red-400', desc: '과적합 심각 — 실전 사용 비권장' };
    };

    const grade = getOverfitGrade(overfitRatio);
    const consistency = windows.filter(w => w.testPnl > 0).length;

    return (
        <>
            {/* 핵심 요약 카드 */}
            <div className="bg-bg-dark border border-teal-600/40 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🔬</span>
                        <h3 className="text-sm font-bold text-teal-300">Walk-Forward 분석 결과</h3>
                        <span className="text-[10px] text-text-secondary">
                            {windows.length}윈도우 × {totalCombosPerWindow}조합 | {cachedTickers.length}종목 | {(elapsedMs / 1000).toFixed(0)}초
                        </span>
                    </div>
                </div>

                {/* 과적합 게이지 */}
                <div className={`rounded-lg p-3 ${
                    overfitRatio <= 1.5 ? 'bg-green-900/20 border border-green-500/30' :
                    overfitRatio <= 3.0 ? 'bg-yellow-900/20 border border-yellow-500/30' :
                    overfitRatio <= 5.0 ? 'bg-orange-900/20 border border-orange-500/30' :
                    'bg-red-900/20 border border-red-500/30'
                }`}>
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-text-secondary">과적합 비율 (학습PnL / 검증PnL)</span>
                        <span className={`text-sm font-bold font-mono ${grade.color}`}>
                            {overfitRatio === Infinity ? '∞' : overfitRatio.toFixed(2)}x — {grade.label}
                        </span>
                    </div>
                    <div className="text-[10px] text-text-secondary/60">{grade.desc}</div>
                    <div className="w-full bg-bg-light rounded-full h-1.5 mt-2">
                        <div
                            className={`h-1.5 rounded-full transition-all ${
                                overfitRatio <= 1.5 ? 'bg-green-500' :
                                overfitRatio <= 3.0 ? 'bg-yellow-500' :
                                overfitRatio <= 5.0 ? 'bg-orange-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${Math.min((overfitRatio / 6) * 100, 100)}%` }}
                        />
                    </div>
                </div>

                {/* 핵심 지표 */}
                <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                    <MiniStat label="학습 PnL" value={`${avgTrainPnl >= 0 ? '+' : ''}${avgTrainPnl.toFixed(1)}%`} color={avgTrainPnl >= 0 ? 'green' : 'red'} />
                    <MiniStat label="검증 PnL" value={`${avgTestPnl >= 0 ? '+' : ''}${avgTestPnl.toFixed(1)}%`} color={avgTestPnl >= 0 ? 'green' : 'red'} />
                    <MiniStat label="검증 승률" value={`${avgTestWinRate.toFixed(0)}%`} color={avgTestWinRate >= 50 ? 'green' : 'red'} />
                    <MiniStat label="검증 거래" value={`${totalTestTrades}`} color="purple" />
                    <MiniStat label="검증 MaxDD" value={`-${avgTestMaxDD.toFixed(1)}%`} color="red" />
                    <MiniStat label="일관성" value={`${consistency}/${windows.length}`} color={consistency >= windows.length * 0.5 ? 'green' : 'red'} />
                </div>
            </div>

            {/* 윈도우별 상세 */}
            <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-bg-light/50 border-b border-border-color">
                    <h3 className="text-sm font-semibold text-text-secondary">윈도우별 학습 → 검증 결과</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="bg-bg-light text-text-secondary">
                                <th className="px-3 py-2 text-center">#</th>
                                <th className="px-3 py-2 text-center">학습 PnL</th>
                                <th className="px-3 py-2 text-center">→</th>
                                <th className="px-3 py-2 text-center">검증 PnL</th>
                                <th className="px-3 py-2 text-center">검증 WR</th>
                                <th className="px-3 py-2 text-center">검증 DD</th>
                                <th className="px-3 py-2 text-center">검증 PF</th>
                                <th className="px-3 py-2 text-center">거래수</th>
                                <th className="px-3 py-2 text-left">최적 파라미터</th>
                            </tr>
                        </thead>
                        <tbody>
                            {windows.map(w => {
                                const degradation = w.trainPnl > 0 && w.testPnl < w.trainPnl;
                                return (
                                    <tr key={w.windowIndex} className={`border-t border-border-color ${degradation ? 'bg-yellow-900/5' : ''}`}>
                                        <td className="text-center px-3 py-2 font-bold">{w.windowIndex + 1}</td>
                                        <td className={`text-center px-3 py-2 font-mono ${w.trainPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {w.trainPnl >= 0 ? '+' : ''}{w.trainPnl.toFixed(1)}%
                                        </td>
                                        <td className="text-center px-1 py-2 text-text-secondary/40">→</td>
                                        <td className={`text-center px-3 py-2 font-mono font-semibold ${w.testPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {w.testPnl >= 0 ? '+' : ''}{w.testPnl.toFixed(1)}%
                                        </td>
                                        <td className={`text-center px-3 py-2 ${w.testWinRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                            {w.testWinRate.toFixed(0)}%
                                        </td>
                                        <td className="text-center px-3 py-2 text-red-400 font-mono">
                                            -{w.testMaxDD.toFixed(1)}%
                                        </td>
                                        <td className={`text-center px-3 py-2 ${w.testProfitFactor >= 1.5 ? 'text-green-400' : w.testProfitFactor >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                                            {w.testProfitFactor >= 999 ? '∞' : w.testProfitFactor.toFixed(1)}
                                        </td>
                                        <td className="text-center px-3 py-2">{w.testTrades}</td>
                                        <td className="text-left px-3 py-2">
                                            <div className="flex flex-wrap gap-1">
                                                <span className="text-[10px] bg-bg-light px-1.5 py-0.5 rounded font-mono text-text-secondary">
                                                    TP {w.bestParams.tpAtrMultiplier} SL {w.bestParams.slAtrMultiplier} R:R {w.bestParams.minRiskReward}
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            <tr className="bg-bg-light/50 border-t-2 border-teal-600/40 font-semibold">
                                <td className="text-center px-3 py-2 text-teal-300">AVG</td>
                                <td className={`text-center px-3 py-2 font-mono ${avgTrainPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {avgTrainPnl >= 0 ? '+' : ''}{avgTrainPnl.toFixed(1)}%
                                </td>
                                <td className="text-center px-1 py-2 text-text-secondary/40">→</td>
                                <td className={`text-center px-3 py-2 font-mono ${avgTestPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {avgTestPnl >= 0 ? '+' : ''}{avgTestPnl.toFixed(1)}%
                                </td>
                                <td className={`text-center px-3 py-2 ${avgTestWinRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                    {avgTestWinRate.toFixed(0)}%
                                </td>
                                <td className="text-center px-3 py-2 text-red-400 font-mono">-{avgTestMaxDD.toFixed(1)}%</td>
                                <td className="text-center px-3 py-2 text-text-secondary">—</td>
                                <td className="text-center px-3 py-2">{totalTestTrades}</td>
                                <td></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>

            {/* 해석 가이드 */}
            <div className="text-[10px] text-text-secondary/50 text-center space-y-0.5">
                <p>Walk-Forward: 학습(3일)에서 찾은 최적 파라미터를 미래(1일) 데이터로 검증. 4개 윈도우 슬라이딩.</p>
                <p>과적합 비율 1.5x 이하 = 양호 | 3x 이상 = 과적합 위험 | 검증 PnL이 양수면 실전 적용 가능성 높음</p>
            </div>
        </>
    );
};
