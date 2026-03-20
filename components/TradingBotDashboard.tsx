
// components/TradingBotDashboard.tsx
import React, { useState, useEffect, useCallback } from 'react';
import type { BotState, AiCoreConfig, Trade, StrategyConfig, WaitingCandidate, AutoOptimizerState, AutoOptMode, TickerParamEntry, BacktestParams, OptimizerParamRange, ScanStatus, ScanFilterStep, RegimeParamEntry } from '../types';
import { ALL_REGIME_ENTRY_KEYS, parseRegimeEntryKey, ALL_TIME_SEGMENT_KEYS, parseTimeSegmentKey, getSessionAndDayType } from '../types';
import type { TimeSegmentKey, Session, DayType } from '../types';
import { PlayIcon, StopIcon, RocketIcon, ActivityIcon, ClockIcon, EyeIcon, ArrowRightLeftIcon } from './Icons';
import { LiveMonitorTable } from './LiveMonitorTable';
import { AiCoreConfig as AiCoreConfigComponent } from './AiCoreConfig';
import VerificationDashboard from './VerificationDashboard';

interface TradingBotDashboardProps {
    botStatus: 'running' | 'stopped';
    botState: BotState;
    onStart: () => void;
    onStop: () => void;
    onRefresh: () => void;
    aiConfig: AiCoreConfig;
    isPositionWidgetVisible: boolean;
    onTogglePositionWidget: () => void;
    onDelegate: (ticker: string) => void;
    isEcoMode?: boolean;
    lastLogMessage?: string;
    autoOptState?: AutoOptimizerState | null;
    onAutoOptStop?: () => void;
    onAutoOptStart?: (mode: AutoOptMode) => void;
    onGlobalParamChange?: (key: string, value: number) => void;
    onTickerParamChange?: (ticker: string, paramKey: string, value: number | boolean) => void;
    optimizerRanges?: { 'ignition-wf': OptimizerParamRange[] };
    onOptimizerRangeChange?: (mode: AutoOptMode, ranges: OptimizerParamRange[]) => void;
    onConfigChange?: (config: AiCoreConfig) => void;
    // ★ v52.36: 섀도우 모드
    isShadowMode?: boolean;
    onToggleShadow?: () => void;
    onShadowStart?: () => void;
    onShadowStop?: () => void;
}

// ★ 로컬 상태 기반 범위 입력 (onBlur 시 파싱 → 콤마/스페이스 자유롭게 타이핑 가능)
const RangeInput: React.FC<{
    values: (number | boolean)[];
    onChange: (newValues: (number | boolean)[]) => void;
    disabled?: boolean;
}> = ({ values, onChange, disabled }) => {
    // ★ v36: boolean ON/OFF 파라미터 지원
    const hasBooleans = values.some(v => typeof v === 'boolean');
    const displayText = values.map(v => typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : v).join(', ');
    const [text, setText] = useState(displayText);
    // 외부 값 변경 시 텍스트 동기화
    useEffect(() => { setText(displayText); }, [displayText]);
    return (
        <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
                if (hasBooleans) {
                    // boolean 파라미터: ON/OFF, true/false 파싱
                    const parsed = text.split(',').map(v => {
                        const trimmed = v.trim().toLowerCase();
                        if (trimmed === 'on' || trimmed === 'true') return true;
                        if (trimmed === 'off' || trimmed === 'false') return false;
                        return undefined;
                    }).filter((v): v is boolean => v !== undefined);
                    if (parsed.length > 0) {
                        onChange(parsed);
                    } else {
                        setText(displayText);
                    }
                } else {
                    const parsed = text.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
                    if (parsed.length > 0) {
                        onChange(parsed);
                    } else {
                        setText(displayText); // 무효한 입력 → 원래 값 복원
                    }
                }
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                }
            }}
            className="flex-1 text-xs font-mono text-text-primary bg-bg-dark border border-border-color/40 rounded px-2 py-0.5 focus:outline-none focus:border-brand-primary/60"
            disabled={disabled}
        />
    );
};

const RadarItem: React.FC<{ strategy: StrategyConfig }> = ({ strategy }) => (
    <div className="flex justify-between items-center p-2 border-b border-border-color/30 hover:bg-bg-light/50 transition-colors cursor-pointer group">
        <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500/50 group-hover:bg-green-400"></span>
            <span className="text-xs font-bold text-text-primary">{strategy.ticker.replace('USDT', '')}</span>
        </div>
        <span className="text-[10px] text-text-secondary font-mono">SCANNING</span>
    </div>
);

const CompactTradeCard: React.FC<{ trade: Trade }> = ({ trade }) => {
    const pnl = trade.unrealizedPnl || 0;
    const pnlColor = pnl >= 0 ? 'text-green-400' : 'text-red-400';
    const percent = trade.initialMargin > 0 ? (pnl / trade.initialMargin) * 100 : 0;
    const entryPrice = trade.entryPrice;
    const currentPrice = trade.currentPrice || entryPrice;
    
    const isLong = trade.direction === 'Long';
    const dist = (currentPrice - entryPrice) / entryPrice * 100;
    const barWidth = Math.min(Math.abs(dist) * 10, 100); 
    
    const isRunner = trade.tradeStyle === 'SWING_RUNNER';
    const isScalp = trade.tradeStyle === 'SCALP';

    const tpOrders = trade.tpOrders || [];
    const tp1 = tpOrders.length > 0 ? tpOrders[0].price : (trade.tp1Price || 0);
    const tp2 = trade.targetPrice || 0;

    return (
        <div className="bg-bg-dark border border-border-color rounded-lg p-3 flex flex-col relative overflow-hidden shadow-sm hover:border-brand-primary/50 transition-colors h-full">
             <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,255,255,0.02)_50%,transparent_75%,transparent_100%)] bg-[length:10px_10px]"></div>
             
             <div className="z-10 flex justify-between items-start mb-2">
                <div className="flex flex-col">
                    <span className="font-bold text-base text-text-primary flex items-center gap-2">
                        {trade.ticker}
                        {trade.wasReversed && (
                            <span title="Reverse Trade" className="px-1.5 py-0.5 bg-purple-900/50 rounded text-[9px] font-bold text-purple-300 border border-purple-500/50">
                                REV
                            </span>
                        )}
                        {isRunner && (
                            <span title="Trend Runner Mode">
                                <RocketIcon className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                            </span>
                        )}
                        {isScalp && (
                            <span title="Scalping Mode" className="px-1.5 py-0.5 bg-red-900/50 rounded text-[9px] font-bold text-red-400 animate-pulse border border-red-500/50">
                                FAST
                            </span>
                        )}
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded w-fit mt-1 border ${isLong ? 'bg-green-900/20 text-green-400 border-green-900/30' : 'bg-red-900/20 text-red-400 border-red-900/30'}`}>
                        {trade.direction} {trade.leverage}X
                    </span>
                    {/* ★ v52.16: 사용된 파라미터 키 + 세션 표시 */}
                    {trade.entrySession && (
                        <span className="text-[8px] px-1 py-0.5 rounded bg-indigo-900/30 text-indigo-300 border border-indigo-700/30 w-fit mt-0.5">
                            {trade.entrySession === 'ASIA' ? '🌏아시아' : trade.entrySession === 'EUROPE' ? '🌍유럽' : '🌎미국'}
                            {trade.entryDayType === 'WEEKEND' ? ' 주말' : ''}
                        </span>
                    )}
                    {trade.entryTimeSegmentKey && (
                        <span className="text-[7px] px-1 py-0.5 rounded bg-cyan-900/30 text-cyan-300 border border-cyan-700/30 w-fit mt-0.5 font-mono truncate max-w-[180px]"
                              title={trade.entryTimeSegmentKey}>
                            {trade.entryTimeSegmentKey.replace(/_/g, ' ')}
                        </span>
                    )}
                </div>
                <div className="text-right">
                    <div className={`text-xl font-black tracking-tighter ${pnlColor}`}>
                        {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </div>
                    <div className={`text-xs font-mono font-bold ${percent >= 0 ? 'text-green-500/80' : 'text-red-500/80'}`}>
                        {percent.toFixed(2)}%
                    </div>
                </div>
             </div>

             <div className="grid grid-cols-2 gap-2 text-[10px] text-text-secondary font-mono bg-bg-light/30 p-2 rounded z-10 mb-2">
                <div>
                    <span className="opacity-60 block">ENTRY</span>
                    <span className="text-text-primary">{entryPrice.toFixed(4)}</span>
                </div>
                <div className="text-right">
                    <span className="opacity-60 block">MARK</span>
                    <span className="text-text-primary font-bold">{currentPrice.toFixed(4)}</span>
                </div>
             </div>

             <div className="flex justify-between items-center text-[10px] bg-bg-dark/50 px-2 py-1 rounded z-10 border border-border-color/30">
                <div className="flex gap-2">
                    {tp1 > 0 && (
                        <span className={`flex items-center gap-1 ${trade.isTp1Hit ? 'text-blue-400 line-through opacity-50' : 'text-blue-300'}`}>
                            <span className="font-bold">TP1:</span> {tp1.toFixed(4)}
                        </span>
                    )}
                    {tp2 > 0 && (
                        <span className="text-green-400 flex items-center gap-1">
                            <span className="font-bold">TP2:</span> {tp2.toFixed(4)}
                        </span>
                    )}
                    {tp1 === 0 && tp2 === 0 && <span className="text-text-secondary opacity-50">TP 미설정</span>}
                </div>
             </div>

             {/* ★ v36: 레지스트리 통계 표시 */}
             {trade.registryStats && (
                <div className="grid grid-cols-4 gap-1 text-[9px] font-mono bg-brand-primary/5 border border-brand-primary/20 p-1.5 rounded z-10 mt-1">
                    <div className="text-center">
                        <span className="opacity-50 block">WR</span>
                        <span className={`font-bold ${trade.registryStats.winRate >= 65 ? 'text-green-400' : trade.registryStats.winRate >= 55 ? 'text-yellow-400' : 'text-red-400'}`}>
                            {trade.registryStats.winRate.toFixed(0)}%
                        </span>
                    </div>
                    <div className="text-center">
                        <span className="opacity-50 block">EV</span>
                        <span className={`font-bold ${trade.registryStats.ev >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {trade.registryStats.ev >= 0 ? '+' : ''}{trade.registryStats.ev.toFixed(1)}%
                        </span>
                    </div>
                    <div className="text-center">
                        <span className="opacity-50 block">표본</span>
                        <span className="text-text-primary font-bold">{trade.registryStats.trades}</span>
                    </div>
                    <div className="text-center">
                        <span className="opacity-50 block">PnL</span>
                        <span className={`font-bold ${trade.registryStats.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {trade.registryStats.pnl >= 0 ? '+' : ''}{trade.registryStats.pnl.toFixed(0)}%
                        </span>
                    </div>
                </div>
             )}

             <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-auto relative z-10">
                 <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/50"></div>
                 <div 
                    className={`h-full ${pnl >= 0 ? 'bg-green-500' : 'bg-red-500'} transition-all duration-300`}
                    style={{ 
                        width: `${barWidth}%`, 
                        marginLeft: dist < 0 ? 'auto' : '50%',
                        marginRight: dist > 0 ? 'auto' : '50%',
                        transformOrigin: dist > 0 ? 'left' : 'right'
                    }}
                 ></div>
             </div>
        </div>
    );
}

const IdleScanner: React.FC<{ botState: BotState; onDelegate: (ticker: string) => void }> = ({ botState, onDelegate }) => {
    const { waitingCandidates, snipingTickers, latestPrices, analyzingTickers, activeStrategies } = botState;
    
    const sniperCandidates: WaitingCandidate[] = snipingTickers
        .filter(ticker => !waitingCandidates.some(c => c.ticker === ticker))
        .map(ticker => {
            const strategies = activeStrategies ? (Object.values(activeStrategies) as StrategyConfig[]) : [];
            const strat = strategies.find(s => s.ticker === ticker);
            const direction = strat && strat.direction !== 'Both' ? strat.direction : 'Long';
            
            return {
                ticker,
                direction: direction as 'Long' | 'Short',
                entryZones: [], 
                marketPhase: 'TRAP_HUNTING', 
                reasoning: 'Sniper Loop Active - Executing Momentum Strategy',
                timestamp: Date.now(),
                technicalContext: {}
            };
        });

    const displayCandidates = [...waitingCandidates, ...sniperCandidates];

    return (
        <div className="h-full flex flex-col bg-bg-dark/30 rounded-lg border border-border-color/30 overflow-hidden relative">
             <LiveMonitorTable 
                 candidates={displayCandidates} 
                 latestPrices={latestPrices}
                 snipingTickers={snipingTickers}
                 analyzingTickers={analyzingTickers}
                 onDelegate={onDelegate} 
             />
        </div>
    );
};

const EcoView: React.FC<{ botState: BotState; lastLog?: string; onStop: () => void }> = ({ botState, lastLog, onStop }) => {
    // [FIX] totalPnl = 실현 + 미실현 PnL (에쿼티 기반이 가장 정확)
    const initialEq = botState.sessionStats.initialEquity;
    const totalPnl = initialEq > 0
        ? botState.totalEquity - initialEq  // 에쿼티 변동 = 실제 총 PnL
        : (botState.sessionStats.sessionPnl || 0) + (botState.sessionStats.unrealizedPnl || 0);  // 폴백
    const pnlColor = totalPnl >= 0 ? 'text-green-500' : 'text-red-500';
    const activePositions = botState.openPositions
        .filter(p => p.status === 'open')
        .reduce((acc, pos) => {
            const existing = acc.findIndex(p => p.ticker === pos.ticker);
            if (existing >= 0) acc[existing] = pos;
            else acc.push(pos);
            return acc;
        }, [] as typeof botState.openPositions);
    const waitingCount = botState.waitingCandidates.length;

    return (
        <div className="h-full flex flex-col items-center justify-center bg-black text-gray-400 p-8 space-y-8 select-none">
            <div className="text-center space-y-2">
                <div className="text-xs font-mono uppercase tracking-widest text-green-700 animate-pulse">● System Operational (Eco Mode)</div>
                <h1 className="text-6xl font-black text-white tracking-tighter tabular-nums">
                    ${botState.totalEquity.toFixed(2)}
                </h1>
                <div className={`text-2xl font-mono font-bold ${pnlColor}`}>
                    {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)} USDT ({botState.sessionStats.sessionReturnPercent.toFixed(2)}%)
                </div>
            </div>

            <div className="grid grid-cols-2 gap-8 w-full max-w-2xl text-center border-t border-gray-800 pt-8">
                <div>
                    <div className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-2">Active Positions</div>
                    {activePositions.length > 0 ? (
                        <div className="space-y-1">
                            {activePositions.map(p => (
                                <div key={p.id} className="text-lg font-mono text-white">
                                    {p.ticker} {p.wasReversed && <span className="text-xs bg-purple-600/40 text-purple-300 px-1 rounded ml-1">REV</span>} <span className={p.unrealizedPnl! >= 0 ? 'text-green-500' : 'text-red-500'}>{p.unrealizedPnl! >= 0 ? '+' : ''}{p.unrealizedPnl?.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-lg font-mono text-gray-600">-- IDLE --</div>
                    )}
                </div>
                <div>
                    <div className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-2">Watchlist</div>
                    <div className="text-lg font-mono text-white">{waitingCount} Candidates</div>
                </div>
            </div>

            <div className="w-full max-w-3xl text-center pt-8 border-t border-gray-800">
                <div className="text-xs text-gray-600 font-mono mb-1">LAST LOG ENTRY</div>
                <div className="text-sm text-gray-300 font-mono break-words bg-gray-900/50 p-2 rounded">
                    {lastLog || "Waiting for system logs..."}
                </div>
            </div>

            <button 
                onClick={onStop}
                className="mt-8 px-6 py-2 border border-red-900 text-red-700 hover:bg-red-900/20 hover:text-red-500 rounded text-xs font-bold transition-colors uppercase tracking-widest"
            >
                Emergency Stop
            </button>
        </div>
    );
};

export const TradingBotDashboard: React.FC<TradingBotDashboardProps> = ({
    botStatus, botState, onStart, onStop,
    aiConfig,
    isPositionWidgetVisible, onTogglePositionWidget,
    onDelegate,
    isEcoMode, lastLogMessage,
    autoOptState, onAutoOptStop, onAutoOptStart,
    onGlobalParamChange, onTickerParamChange,
    optimizerRanges, onOptimizerRangeChange,
    onConfigChange,
    isShadowMode, onToggleShadow, onShadowStart, onShadowStop,
}) => {
    const [timeLeft, setTimeLeft] = useState<string>('--:--');
    const [viewMode, setViewMode] = useState<'monitor' | 'waiting'>('monitor');
    const [optimizationTimeLeft, setOptimizationTimeLeft] = useState<string>('');
    useEffect(() => {
        if (isEcoMode) return;

        const timer = setInterval(() => {
            if (botState.nextRotationTime) {
                const diff = botState.nextRotationTime - Date.now();
                if (diff > 0) {
                    const m = Math.floor(diff / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    setTimeLeft(`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
                } else {
                    setTimeLeft('ROTATING...');
                }
            }

            if (botState.selectionWindowEndTime && botState.selectionWindowEndTime > 0) {
                const optDiff = botState.selectionWindowEndTime - Date.now();
                if (optDiff > 0) {
                    const m = Math.floor(optDiff / 60000);
                    const s = Math.floor((optDiff % 60000) / 1000);
                    setOptimizationTimeLeft(`${m}:${s.toString().padStart(2, '0')}`);
                } else {
                    setOptimizationTimeLeft('Ranking...');
                }
            } else {
                setOptimizationTimeLeft('');
            }

        }, 1000);
        return () => clearInterval(timer);
    }, [botState.nextRotationTime, botState.selectionWindowEndTime, isEcoMode]);

    if (isEcoMode) {
        return <EcoView botState={botState} lastLog={lastLogMessage} onStop={onStop} />;
    }

    // [FIX] 같은 ticker 중복 포지션 방지: ticker 기준 dedup (마지막 것만 유지)
    const activePositions = botState.openPositions
        .filter(p => p.status === 'open')
        .reduce((acc, pos) => {
            const existing = acc.findIndex(p => p.ticker === pos.ticker);
            if (existing >= 0) acc[existing] = pos; // 같은 ticker면 최신으로 교체
            else acc.push(pos);
            return acc;
        }, [] as typeof botState.openPositions);
    const strategies = Object.values(botState.activeStrategies || {}) as StrategyConfig[];

    const historyTrades = [
        ...(botState.openPositions || []).filter(p => p.status === 'open'),
        ...(botState.sessionTradeHistory || [])
    ];
    const historyPrecisions: Record<string, number> = {};
    historyTrades.forEach(t => historyPrecisions[t.ticker] = 4);

    const initEquity = botState.sessionStats.initialEquity || 0;
    const displayEquity = botState.totalEquity;
    const walletBalance = botState.availableBalance;

    const roi = botState.sessionStats.sessionReturnPercent || 0;
    const winRate = botState.sessionStats.winRate || 0;
    const totalTrades = botState.sessionStats.totalTrades || 0;
    const pf = botState.sessionStats.profitFactor || 0;

    // ── Optimizer Preset 탭 ──
    const presetTab: AutoOptMode = 'ignition-wf';
    const [addTickerInput, setAddTickerInput] = useState('');
    const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
    const [showRanges, setShowRanges] = useState(false);
    const [showDisqualified, setShowDisqualified] = useState(false);
    const [showInactiveSession, setShowInactiveSession] = useState(false);
    const [tickerParamCollapsed, setTickerParamCollapsed] = useState(true);  // ★ v49.10: 기본 접힘 (렉 방지)
    const [scanDetailCollapsed, setScanDetailCollapsed] = useState(false);
    const [scanMonitorCollapsed, setScanMonitorCollapsed] = useState(true);

    // 프리셋 기본값
    const currentPreset = { topN: 1, baseSizePercent: 85, maxPositions: 1, label: '🎯 Ignition WF', desc: 'IGNITION WF (1개월학습+1주검증, 9개월, 1종목순차)' };

    // 종목 추가/삭제 — tradingEngine의 tickerParamRegistry 직접 조작
    const handleAddTicker = useCallback(() => {
        const raw = addTickerInput.trim().toUpperCase();
        if (!raw) return;
        const ticker = raw.endsWith('USDT') ? raw : raw + 'USDT';
        if ((window as any).tradingEngine) {
            const engine = (window as any).tradingEngine;
            if (!engine.tickerParamRegistry) engine.tickerParamRegistry = {};
            if (!engine.tickerParamRegistry[ticker]) {
                engine.tickerParamRegistry[ticker] = {
                    ticker, mode: 'normal', pnl: 0, winRate: 0, trainPnl: 0, trainWinRate: 0,
                    trades: 0, maxDD: 0, avgUnderwaterMin: 0, avgHoldingMin: 0, regimeConsistency: 0, qualified: true, updatedAt: Date.now(),
                    params: { tpAtrMultiplier: 3, slAtrMultiplier: 0, minRiskReward: 0.8,
                        shortMultiplier: 0.5, adxGateMinimum: 20, leverageTrending: 20,
                        leverageRanging: 15, leverageVolatile: 3, partialTp1Ratio: 1.0,
                        partialQty1: 1.0, baseSizePercent: currentPreset.baseSizePercent,
                        maxPositions: currentPreset.maxPositions, topN: 30, periodDays: 72,
                        scoreThreshold: 50, activeSession: 0, reverseMode: false, maxHoldingBars: 0 },
                };
                engine.refreshState?.();
            }
        }
        setAddTickerInput('');
    }, [addTickerInput, currentPreset]);

    const handleRemoveTicker = useCallback((ticker: string) => {
        if ((window as any).tradingEngine) {
            const engine = (window as any).tradingEngine;
            if (engine.tickerParamRegistry && engine.tickerParamRegistry[ticker]) {
                delete engine.tickerParamRegistry[ticker];
                engine.refreshState?.();
            }
        }
    }, []);

    const registry = botState.tickerParamRegistry || {};
    const registryEntries = Object.values(registry).sort((a: any, b: any) => b.pnl - a.pnl) as TickerParamEntry[];

    // ★ 현재 세션+요일 판별 → 적격 종목 vs 비적격 종목 분리
    const { session: nowSession, dayType: nowDayType } = getSessionAndDayType(Date.now());
    const sessLabel = nowSession === 'ASIA' ? '🌏아시아' : nowSession === 'EUROPE' ? '🌍유럽' : '🌎미국';
    const dtLabel = nowDayType === 'WEEKEND' ? '주말' : '평일';

    const isTickerActiveNow = (entry: TickerParamEntry): boolean => {
        // 포지션 열려있으면 항상 표시
        if (botState.openPositions.some(p => p.ticker === entry.ticker && p.status === 'open')) return true;
        // 대기 중이면 항상 표시
        if (botState.waitingCandidates.some(c => c.ticker === entry.ticker)) return true;
        // ★ Rush 세션 태그: 해당 세션으로 Rush 최적화된 종목은 항상 활성
        if ((entry as any).optimizedSession === nowSession) return true;
        // 36-way 세그먼트에서 현재 세션+요일에 적격인 것이 있는지
        const tsEntries = (entry as any).timeSegmentEntries as Partial<Record<string, RegimeParamEntry>> | undefined;
        if (!tsEntries) return false;
        return Object.keys(tsEntries).some(key => {
            const parsed = parseTimeSegmentKey(key as any);
            return parsed.session === nowSession && parsed.dayType === nowDayType && tsEntries[key]?.qualified;
        });
    };

    const activeSessionEntries = registryEntries.filter(e => e.qualified !== false && isTickerActiveNow(e));
    const inactiveSessionEntries = registryEntries.filter(e => e.qualified !== false && !isTickerActiveNow(e));
    const disqualifiedEntries = registryEntries.filter(e => e.qualified === false);

    return (
        <div className="flex flex-col gap-4 bg-bg-main">
            {/* ── 1. 헤더: 총자산 + Start/Stop ── */}
            <header className="flex items-center justify-between bg-bg-dark border border-border-color p-3 rounded-lg shadow-md">
                <div className="flex items-center gap-4">
                    <div className={`flex items-center gap-2 px-3 py-1 rounded border ${botStatus === 'running' ? 'bg-green-900/20 border-green-500 text-green-400' : 'bg-red-900/20 border-red-500 text-red-400'}`}>
                        <div className={`w-2 h-2 rounded-full ${botStatus === 'running' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                        <span className="text-xs font-black tracking-widest">{botStatus === 'running' ? 'ONLINE' : 'OFFLINE'}</span>
                    </div>
                    <div>
                        <div className="text-[10px] text-text-secondary font-bold tracking-wider">총 자산</div>
                        <div className={`text-lg font-mono font-black ${displayEquity >= initEquity ? 'text-white' : 'text-amber-200'}`}>
                            ${displayEquity.toFixed(2)}
                            <span className={`text-xs ml-2 ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* 실전 모드: 봇 + 오토옵티 (WF 끝까지) → 실제 거래 */}
                    {botStatus === 'stopped' && !isShadowMode ? (
                        <button onClick={onStart} className="px-5 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-bold rounded shadow-lg shadow-green-900/20 transition-all flex items-center gap-2">
                            <PlayIcon className="w-4 h-4"/> 실전
                        </button>
                    ) : botStatus === 'running' && !isShadowMode ? (
                        <button onClick={onStop} className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-bold rounded shadow-lg shadow-red-900/20 transition-all flex items-center gap-2">
                            <StopIcon className="w-4 h-4"/> STOP
                        </button>
                    ) : null}
                    {/* 구분선 */}
                    {!isShadowMode && botStatus === 'stopped' && <span className="text-gray-600">|</span>}
                    {/* 섀도우 모드: 봇 + 오토옵티 + 시그널 기록 (실전 진입 없음) */}
                    {!isShadowMode && botStatus === 'stopped' ? (
                        <button onClick={onShadowStart} className="px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-bold rounded shadow-lg shadow-purple-900/20 transition-all flex items-center gap-2">
                            👻 섀도우
                        </button>
                    ) : isShadowMode ? (
                        <button onClick={onShadowStop} className="px-5 py-2 bg-purple-800 hover:bg-purple-700 text-white text-sm font-bold rounded shadow-lg shadow-purple-900/30 transition-all flex items-center gap-2 animate-pulse">
                            👻 섀도우 중지
                        </button>
                    ) : null}
                </div>
            </header>

            {/* ── 2. Optimizer Presets (Ignition WF) ── */}
            <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
                {/* 탭 헤더 + 옵티마이저 상태 + Start/Stop */}
                <div className="flex items-center justify-between border-b border-border-color bg-bg-light/10 px-3 py-2">
                    <div className="flex items-center gap-1">
                        <span className="px-4 py-2 text-xs font-bold rounded-lg bg-rose-600 text-white shadow-lg shadow-rose-900/30">
                            🎯 Ignition WF
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* 옵티마이저 상태 배지 */}
                        {autoOptState?.enabled ? (
                            <div className="flex items-center gap-1.5">
                                <span className={`text-[10px] font-bold px-2 py-1 rounded ${
                                    autoOptState.phase === 'halted' ? 'bg-red-900/50 text-red-400' :
                                    autoOptState.phase === 'waiting' ? 'bg-blue-900/50 text-blue-400' :
                                    autoOptState.phase === 'watching' ? 'bg-green-900/50 text-green-400' :
                                    autoOptState.phase === 'fine-tuning' ? 'bg-purple-900/50 text-purple-400 animate-pulse' :
                                    autoOptState.phase === 'idle' ? 'bg-gray-800 text-text-secondary' :
                                    'bg-amber-900/50 text-amber-400 animate-pulse'
                                }`}>
                                    {autoOptState.phase === 'running-normal' ? '▶ 최적화중' :
                                     autoOptState.phase === 'running-reverse' ? '▶ 리버스' :
                                     autoOptState.phase === 'comparing' ? '⚖️ 비교' :
                                     autoOptState.phase === 'fine-tuning' ? `🔬 미세최적화${autoOptState.fineTuneProgress ? ` (${autoOptState.fineTuneProgress.current}/${autoOptState.fineTuneProgress.total})` : ''}` :
                                     autoOptState.phase === 'waiting' ? '⏳ 대기' :
                                     autoOptState.phase === 'watching' ? '👀 감시' :
                                     autoOptState.phase === 'halted' ? '⛔ 중단' : 'OFF'}
                                    {autoOptState.phase !== 'fine-tuning' && autoOptState.progressPct > 0 && autoOptState.progressPct < 100 ? ` ${autoOptState.progressPct}%` : ''}
                                </span>
                                {autoOptState.cycleCount > 0 && (
                                    <span className="text-[10px] text-text-secondary/60 font-mono">#{autoOptState.cycleCount}</span>
                                )}
                                {onAutoOptStop && (
                                    <button onClick={onAutoOptStop} className="text-[10px] px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-bold">■ 중단</button>
                                )}
                            </div>
                        ) : onAutoOptStart ? (
                            <button
                                onClick={() => onAutoOptStart(presetTab)}
                                className="px-4 py-2 text-xs font-bold rounded-lg transition-colors text-white bg-rose-600 hover:bg-rose-700"
                            >
                                ▶ {currentPreset.label} 시작
                            </button>
                        ) : null}
                    </div>
                </div>

                {/* 프리셋 내용 */}
                <div className="p-4">
                    {/* 프리셋 설명 + 상태 요약 */}
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] text-text-secondary">{currentPreset.desc}</span>
                        <div className="flex items-center gap-3 text-[10px] text-text-secondary/60">
                            <span>포지션: <strong className="text-amber-300">{botState.openPositions?.filter(p => p.status === 'open').length || 0}/{aiConfig.maxPositions ?? currentPreset.maxPositions}</strong></span>
                            <span>승률: <strong className="text-text-primary">{winRate.toFixed(0)}%</strong> ({totalTrades})</span>
                            <span>PF: <strong className={pf >= 1.5 ? 'text-green-400' : pf >= 1.0 ? 'text-text-primary' : 'text-red-400'}>{pf.toFixed(2)}</strong></span>
                        </div>
                    </div>

                    {/* ★ Ignition WF 진행률 */}
                    {autoOptState && autoOptState.progressMsg && autoOptState.phase !== 'idle' && (
                        <div className="mb-3 border rounded-lg p-3 bg-rose-900/20 border-rose-700/30">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold flex-shrink-0 text-rose-300">
                                    🎯 WF
                                </span>
                                <span className="text-[10px] font-mono truncate flex-1 text-rose-400/70">
                                    {autoOptState.progressMsg}
                                </span>
                                {autoOptState.progressPct > 0 && autoOptState.progressPct < 100 && (
                                    <span className="text-[10px] font-bold flex-shrink-0 text-rose-400">
                                        {autoOptState.progressPct}%
                                    </span>
                                )}
                            </div>
                            {autoOptState.progressPct > 0 && autoOptState.progressPct < 100 && (
                                <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-1.5">
                                    <div className="h-full transition-all duration-500 bg-rose-500"
                                        style={{ width: `${autoOptState.progressPct}%` }} />
                                </div>
                            )}
                            {/* ★ Ignition WF: 사이클 결과 요약 */}
                            {autoOptState.lastResult && (
                                <div className="mt-2 text-[9px] text-rose-300/70 font-mono">
                                    마지막 결과: {autoOptState.lastResult.applied === 'halted' ? '⛔ 미달' :
                                        `✅ ${autoOptState.lastResult.applied === 'normal' ? 'Normal' : 'Reverse'} 적용`}
                                    {autoOptState.lastResult.normalBest && (
                                        <span className="ml-2">N: PnL={autoOptState.lastResult.normalBest.valPnlPercent.toFixed(0)}% WR={autoOptState.lastResult.normalBest.valWinRate.toFixed(0)}%</span>
                                    )}
                                    {autoOptState.cycleCount > 0 && <span className="ml-2">#{autoOptState.cycleCount}사이클</span>}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── 옵티마이저 변수 (접기/펼치기) ── */}
                    <div className="mb-4">
                        <button onClick={() => setShowRanges(!showRanges)}
                            className="w-full flex items-center justify-between text-[9px] text-text-secondary/50 font-bold uppercase tracking-wider py-1 hover:text-text-secondary/70 transition-colors">
                            <span>탐색변수: {(optimizerRanges?.[presetTab] || []).length}개 변수, {(optimizerRanges?.[presetTab] || []).reduce((acc, r) => acc * r.values.length, 1).toLocaleString()}개 조합</span>
                            <span className="text-[10px]">{showRanges ? '▲' : '▼'}</span>
                        </button>
                        {showRanges && (
                            <div className="space-y-1 mt-1">
                                {(optimizerRanges?.[presetTab] || []).map((range, idx) => (
                                    <div key={range.key} className="flex items-center gap-2 bg-bg-light/20 border border-border-color/20 rounded px-2 py-1.5">
                                        <span className="text-[10px] font-bold text-text-secondary w-16 shrink-0">{range.label}</span>
                                        <RangeInput
                                            values={range.values}
                                            onChange={(newValues) => {
                                                if (optimizerRanges) {
                                                    const updatedRanges = [...optimizerRanges[presetTab]];
                                                    updatedRanges[idx] = { ...range, values: newValues };
                                                    onOptimizerRangeChange?.(presetTab, updatedRanges);
                                                }
                                            }}
                                            disabled={autoOptState?.enabled}
                                        />
                                        <span className="text-[9px] text-text-secondary/30 font-mono shrink-0">{range.values.length}개</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* ── 마지막 최적화 결과 (compact) ── */}
                    {autoOptState?.lastResult && (
                        <div className="flex items-center gap-3 mb-4 p-2 rounded bg-bg-light/20 border border-border-color/20 text-[10px]">
                            <span className="text-text-secondary">마지막 최적화:</span>
                            <span className="text-text-secondary/60">{new Date(autoOptState.lastResult.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                            {autoOptState.lastResult.normalBest && (
                                <span className={`font-mono font-bold ${autoOptState.lastResult.normalBest.valPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    Normal {autoOptState.lastResult.normalBest.valPnlPercent >= 0 ? '+' : ''}{autoOptState.lastResult.normalBest.valPnlPercent.toFixed(1)}%
                                </span>
                            )}
                            {autoOptState.lastResult.reverseBest && (
                                <span className={`font-mono font-bold ${autoOptState.lastResult.reverseBest.valPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    Reverse {autoOptState.lastResult.reverseBest.valPnlPercent >= 0 ? '+' : ''}{autoOptState.lastResult.reverseBest.valPnlPercent.toFixed(1)}%
                                </span>
                            )}
                            <span className={`font-bold px-1.5 py-0.5 rounded ${autoOptState.lastResult.applied === 'halted' ? 'bg-red-900/30 text-red-400' : 'bg-green-900/30 text-green-400'}`}>
                                {autoOptState.lastResult.applied === 'halted' ? '⛔ 중단' : `✅ ${autoOptState.lastResult.applied === 'reverse' ? '🔄REV' : 'NOR'}`}
                            </span>
                        </div>
                    )}

                    {/* ── 미세 최적화 한 줄 요약 ── */}
                    {autoOptState && (autoOptState.phase === 'fine-tuning' || (autoOptState.fineTuneProgress?.results && autoOptState.fineTuneProgress.results.length > 0)) && (
                        <div className="bg-purple-900/10 border border-purple-600/30 rounded-lg p-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-purple-400">
                                    🔬 미세 최적화 {autoOptState.phase === 'fine-tuning'
                                        ? `진행중 (${autoOptState.fineTuneProgress?.current ?? 0}/${autoOptState.fineTuneProgress?.total ?? 0})`
                                        : `완료 — ${autoOptState.fineTuneProgress?.results.filter(r => r.improved).length ?? 0}종목 개선, ${autoOptState.fineTuneProgress?.results.filter(r => !r.improved).length ?? 0}종목 유지`}
                                </span>
                                {autoOptState.phase === 'fine-tuning' && autoOptState.fineTuneProgress && (
                                    <span className="text-[10px] text-purple-300 font-mono animate-pulse">
                                        {autoOptState.fineTuneProgress.currentTicker.replace('USDT', '')}...
                                    </span>
                                )}
                            </div>
                            {autoOptState.phase === 'fine-tuning' && autoOptState.fineTuneProgress && (
                                <div className="w-full bg-bg-dark rounded-full h-1 mt-1.5">
                                    <div className="bg-purple-500 h-1 rounded-full transition-all duration-300"
                                        style={{ width: `${(autoOptState.fineTuneProgress.current / autoOptState.fineTuneProgress.total) * 100}%` }} />
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── 종목별 파라미터 레지스트리 ── */}
                    <div className="bg-bg-light/10 border border-border-color/30 rounded-lg overflow-hidden">
                        <div className="flex items-center justify-between p-2 border-b border-border-color/20 cursor-pointer select-none"
                            onClick={() => setTickerParamCollapsed(!tickerParamCollapsed)}>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-text-secondary/60">{tickerParamCollapsed ? '▶' : '▼'}</span>
                                <span className="text-[10px] font-bold text-emerald-400">🎯 종목별 파라미터</span>
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-300 border border-cyan-700/30 font-bold">
                                    {sessLabel} {dtLabel}
                                </span>
                                <span className="text-[9px] text-text-secondary/50">
                                    활성 <strong className="text-cyan-300">{activeSessionEntries.length}</strong> / 전체 {registryEntries.length}
                                </span>
                            </div>
                            <div className="flex items-center gap-1">
                                <button onClick={() => setShowInactiveSession(!showInactiveSession)}
                                    className={`px-2 py-1 text-[9px] font-bold rounded transition-colors ${showInactiveSession ? 'bg-amber-600/30 text-amber-300 border border-amber-600/50' : 'bg-bg-dark text-text-secondary/50 border border-border-color'}`}
                                    title="현재 세션 비활성 종목 표시/숨기기">
                                    {showInactiveSession ? '💤비활성 숨기기' : `💤비활성 ${inactiveSessionEntries.length}`}
                                </button>
                                <button onClick={() => setShowDisqualified(!showDisqualified)}
                                    className={`px-2 py-1 text-[9px] font-bold rounded transition-colors ${showDisqualified ? 'bg-red-600/30 text-red-300 border border-red-600/50' : 'bg-bg-dark text-text-secondary/50 border border-border-color'}`}
                                    title="미달 종목 표시/숨기기">
                                    {showDisqualified ? '❌미달 숨기기' : `❌미달 ${disqualifiedEntries.length}`}
                                </button>
                                <input
                                    type="text"
                                    value={addTickerInput}
                                    onChange={(e) => setAddTickerInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddTicker()}
                                    placeholder="종목 추가 (예: BTC)"
                                    className="px-2 py-1 text-[10px] bg-bg-dark border border-border-color rounded w-28 text-text-primary placeholder-text-secondary/30 focus:outline-none focus:border-emerald-500"
                                />
                                <button onClick={handleAddTicker} className="px-2 py-1 text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded transition-colors">+ 추가</button>
                                <button onClick={() => {
                                    // ★ 종목별 파라미터 CSV 다운로드
                                    const rows: string[] = [];
                                    rows.push('종목,적격,레짐,전략,세션,요일,모드,승률%,거래수,평균익%,평균손%,EV%,Kelly%,레버리지,TP배수,PnL%');
                                    for (const entry of registryEntries) {
                                        const tsE = (entry as any).timeSegmentEntries as Record<string, RegimeParamEntry> | undefined;
                                        const reE = (entry as any).regimeEntries as Record<string, RegimeParamEntry> | undefined;
                                        const ticker = entry.ticker.replace('USDT', '');
                                        // 90-way entries
                                        if (tsE) {
                                            for (const [key, e] of Object.entries(tsE)) {
                                                if (!e) continue;
                                                const parts = key.split('_');
                                                const regime = parts[0]; const et = parts[1]; const sess = parts[2]; const dt = parts[3];
                                                const lf = regime === 'TRENDING' ? 'leverageTrending' : regime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';
                                                const lev = (e.params as any)?.[lf] ?? 0;
                                                const ev = (e.winRate / 100 * (e.avgWin ?? 0)) + ((100 - e.winRate) / 100 * (e.avgLoss ?? 0));
                                                rows.push(`${ticker},${e.qualified ? 'Y' : 'N'},${regime},${et},${sess},${dt},${e.mode},${e.winRate.toFixed(1)},${e.trades},${(e.avgWin ?? 0).toFixed(1)},${(e.avgLoss ?? 0).toFixed(1)},${ev.toFixed(2)},${((e.kellyFraction ?? 0) * 100).toFixed(1)},${lev},${e.params?.tpAtrMultiplier ?? 0},${e.pnl?.toFixed(1) ?? ''}`);
                                            }
                                        }
                                        // 15-way fallback
                                        if (reE && !tsE) {
                                            for (const [key, e] of Object.entries(reE)) {
                                                if (!e) continue;
                                                const [regime, et] = key.split('_');
                                                const lf = regime === 'TRENDING' ? 'leverageTrending' : regime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';
                                                const lev = (e.params as any)?.[lf] ?? 0;
                                                const ev = (e.winRate / 100 * (e.avgWin ?? 0)) + ((100 - e.winRate) / 100 * (e.avgLoss ?? 0));
                                                rows.push(`${ticker},${e.qualified ? 'Y' : 'N'},${regime},${et},-,-,${e.mode},${e.winRate.toFixed(1)},${e.trades},${(e.avgWin ?? 0).toFixed(1)},${(e.avgLoss ?? 0).toFixed(1)},${ev.toFixed(2)},${((e.kellyFraction ?? 0) * 100).toFixed(1)},${lev},${e.params?.tpAtrMultiplier ?? 0},${e.pnl?.toFixed(1) ?? ''}`);
                                            }
                                        }
                                    }
                                    const bom = '\uFEFF';
                                    const blob = new Blob([bom + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a'); a.href = url;
                                    a.download = `ticker_params_${new Date().toISOString().slice(0, 10)}.csv`;
                                    a.click(); URL.revokeObjectURL(url);
                                }} className="px-2 py-1 text-[10px] font-bold bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors" title="종목별 파라미터 CSV 다운로드">📥 CSV</button>
                                <button onClick={(e) => {
                                    e.stopPropagation();
                                    // ★ v55.1: 레지스트리 전체 JSON 내보내기 (복원용)
                                    try {
                                        const raw = localStorage.getItem('ticker_param_registry_v1');
                                        if (!raw) { alert('저장된 레지스트리가 없습니다.'); return; }
                                        const parsed = JSON.parse(raw);
                                        const count = Object.keys(parsed).length;
                                        const blob = new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json;charset=utf-8' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a'); a.href = url;
                                        a.download = `ticker_registry_${count}종목_${new Date().toISOString().slice(0, 10)}.json`;
                                        a.click(); URL.revokeObjectURL(url);
                                    } catch (err) { alert('내보내기 실패: ' + err); }
                                }} className="px-2 py-1 text-[10px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors" title="레지스트리 JSON 내보내기 (전체 복원용)">💾 백업</button>
                                <button onClick={(e) => {
                                    e.stopPropagation();
                                    // ★ v55.1: 레지스트리 JSON 가져오기 (복원)
                                    const input = document.createElement('input');
                                    input.type = 'file';
                                    input.accept = '.json';
                                    input.onchange = async (ev) => {
                                        const file = (ev.target as HTMLInputElement).files?.[0];
                                        if (!file) return;
                                        try {
                                            const text = await file.text();
                                            const imported = JSON.parse(text) as Record<string, any>;
                                            const importCount = Object.keys(imported).length;
                                            if (importCount === 0) { alert('빈 파일입니다.'); return; }
                                            // 기존 레지스트리와 병합 (가져온 것이 우선, updatedAt 갱신)
                                            const existingRaw = localStorage.getItem('ticker_param_registry_v1');
                                            const existing = existingRaw ? JSON.parse(existingRaw) : {};
                                            const existingCount = Object.keys(existing).length;
                                            const now = Date.now();
                                            let newCount = 0;
                                            let updateCount = 0;
                                            for (const [ticker, entry] of Object.entries(imported)) {
                                                if (!existing[ticker]) newCount++;
                                                else updateCount++;
                                                (entry as any).updatedAt = now; // TTL 리셋
                                                existing[ticker] = entry;
                                            }
                                            localStorage.setItem('ticker_param_registry_v1', JSON.stringify(existing));
                                            window.dispatchEvent(new Event('tickerParamRegistryUpdated'));
                                            alert(`✅ 레지스트리 복원 완료!\n\n가져온 종목: ${importCount}개\n- 신규: ${newCount}개\n- 갱신: ${updateCount}개\n- 기존 유지: ${existingCount - updateCount}개\n→ 총: ${Object.keys(existing).length}개\n\n페이지를 새로고침합니다.`);
                                            window.location.reload();
                                        } catch (err) { alert('가져오기 실패: ' + err); }
                                    };
                                    input.click();
                                }} className="px-2 py-1 text-[10px] font-bold bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors" title="레지스트리 JSON 가져오기 (백업 복원)">📤 복원</button>
                                <button onClick={() => {
                                    if (!window.confirm('거래내역을 초기화하시겠습니까? (종목별 파라미터는 유지됩니다)')) return;
                                    try {
                                        localStorage.removeItem('cp_closed_trades_v1');
                                        window.location.reload();
                                    } catch (e) { console.error('거래내역 초기화 실패:', e); }
                                }} className="px-2 py-1 text-[10px] font-bold bg-red-600 hover:bg-red-700 text-white rounded transition-colors" title="거래내역만 초기화 (파라미터 유지)">🗑️ 거래내역 초기화</button>
                                <button onClick={() => {
                                    // ★ v50: 종목별 파라미터 강제 재적용 — 저장된 레지스트리를 다시 로드
                                    try {
                                        const raw = localStorage.getItem('ticker_param_registry_v1');
                                        if (raw) {
                                            const registry = JSON.parse(raw);
                                            const count = Object.keys(registry).length;
                                            // force re-emit by triggering a storage event
                                            localStorage.setItem('ticker_param_registry_v1', raw);
                                            window.dispatchEvent(new Event('tickerParamRegistryUpdated'));
                                            alert(`✅ ${count}개 종목 파라미터 재적용 완료! 페이지를 새로고침합니다.`);
                                            window.location.reload();
                                        } else {
                                            alert('저장된 종목별 파라미터가 없습니다.');
                                        }
                                    } catch (e) { console.error('파라미터 재적용 실패:', e); alert('재적용 실패: ' + e); }
                                }} className="px-2 py-1 text-[10px] font-bold bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors" title="저장된 종목별 파라미터 강제 재적용">🔄 파라미터 재적용</button>
                                <button onClick={() => {
                                    if (!window.confirm('⚠️ 종목별 파라미터 레지스트리를 완전 초기화합니다.\n\n모든 최적화 결과가 삭제되고 WF가 처음부터 다시 돌아야 합니다.\n\n정말 초기화하시겠습니까?')) return;
                                    try {
                                        localStorage.removeItem('ticker_param_registry_v1');
                                        alert('✅ 레지스트리 초기화 완료! 페이지를 새로고침합니다.\nIgnition WF가 처음부터 다시 최적화합니다.');
                                        window.location.reload();
                                    } catch (e) { console.error('레지스트리 초기화 실패:', e); }
                                }} className="px-2 py-1 text-[10px] font-bold bg-rose-700 hover:bg-rose-800 text-white rounded transition-colors" title="종목별 파라미터 레지스트리 완전 초기화 (WF 재시작 필요)">💣 레지스트리 초기화</button>
                            </div>
                        </div>
                        {!tickerParamCollapsed && registryEntries.length > 0 ? (
                            <div className="overflow-x-auto">
                                <table className="w-full text-[10px]">
                                    <thead>
                                        <tr className="border-b border-border-color/20 text-text-secondary/50">
                                            <th className="text-left px-2 py-1.5">종목</th>
                                            <th className="text-center px-1 py-1.5" title="TRENDING: Score/Ignition별 모드 승률(거래) 레버리지 TP배수 PnL">T</th>
                                            <th className="text-center px-1 py-1.5" title="RANGING: Score/Ignition별 모드 승률(거래) 레버리지 TP배수 PnL">R</th>
                                            <th className="text-center px-1 py-1.5" title="VOLATILE: Score/Ignition별 모드 승률(거래) 레버리지 TP배수 PnL">V</th>
                                            <th className="text-center px-1 py-1.5" title="마지막 스캔 상태">상태</th>
                                            <th className="text-center px-2 py-1.5"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {/* ★ 활성 세션 종목 → 비활성 세션 종목 → 미달 종목 순서 */}
                                        {[
                                            ...activeSessionEntries,
                                            ...(showInactiveSession ? inactiveSessionEntries : []),
                                            ...(showDisqualified ? disqualifiedEntries : []),
                                        ].map((entry, idx) => {
                                            const isActive = activeSessionEntries.includes(entry);
                                            const isInactive = inactiveSessionEntries.includes(entry);
                                            const isDisq = entry.qualified === false;
                                            // 그룹 구분선: 활성→비활성 경계, 비활성→미달 경계
                                            const showGroupHeader = (
                                                (isInactive && idx === activeSessionEntries.length) ||
                                                (isDisq && idx === activeSessionEntries.length + (showInactiveSession ? inactiveSessionEntries.length : 0))
                                            );
                                            return (<React.Fragment key={entry.ticker}>
                                            {showGroupHeader && (
                                                <tr>
                                                    <td colSpan={6} className={`px-2 py-1 text-[8px] font-bold border-t-2 ${isDisq ? 'border-red-700/40 text-red-400/60 bg-red-900/10' : 'border-amber-700/40 text-amber-400/60 bg-amber-900/10'}`}>
                                                        {isDisq ? `❌ 미달 종목 (${disqualifiedEntries.length})` : `💤 현재 세션 비활성 (${inactiveSessionEntries.length})`}
                                                    </td>
                                                </tr>
                                            )}
                                            <tr className={`border-b border-border-color/10 hover:bg-bg-light/20 transition-colors ${isDisq ? 'opacity-40' : isInactive ? 'opacity-50' : ''} ${isActive && idx % 2 === 0 ? 'bg-emerald-900/10' : ''}`}>
                                                <td className={`px-2 py-1.5 font-bold font-mono cursor-pointer hover:text-emerald-200 ${entry.qualified === false ? 'text-red-400/60' : 'text-emerald-300'}`}
                                                    onClick={() => setExpandedTicker(expandedTicker === entry.ticker ? null : entry.ticker)}
                                                    title="클릭하여 세분화 파라미터 보기">
                                                    {entry.ticker.replace('USDT', '')}
                                                    {/* ★ Rush 세션 태그 */}
                                                    {(entry as any).optimizedSession && (
                                                        <span className="text-[7px] ml-0.5 px-1 py-0 rounded bg-yellow-900/40 text-yellow-300 border border-yellow-700/30"
                                                            title={`⚡ ${(entry as any).optimizedSession}장 Rush 최적화`}>
                                                            ⚡{(entry as any).optimizedSession === 'ASIA' ? '아' : (entry as any).optimizedSession === 'EUROPE' ? '유' : '미'}
                                                        </span>
                                                    )}
                                                    {/* ★ 18-way 적격 세션 배지 */}
                                                    {(() => {
                                                        const tsEntries = (entry as any).timeSegmentEntries as Partial<Record<string, RegimeParamEntry>> | undefined;
                                                        if (!tsEntries) return null;
                                                        const qualifiedTsEntries = Object.entries(tsEntries).filter(([, e]) => e?.qualified);
                                                        if (qualifiedTsEntries.length === 0) return null;
                                                        // 적격 세션 추출
                                                        const sessions = new Set<string>();
                                                        qualifiedTsEntries.forEach(([key]) => {
                                                            if (key.includes('ASIA')) sessions.add('🌏');
                                                            if (key.includes('EUROPE')) sessions.add('🌍');
                                                            if (key.includes('US')) sessions.add('🌎');
                                                        });
                                                        return <span className="text-[7px] ml-0.5 px-1 py-0 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-700/30"
                                                            title={`적격 세그먼트: ${qualifiedTsEntries.length}개 (${[...sessions].join('')})`}>
                                                            {[...sessions].join('')}{qualifiedTsEntries.length}
                                                        </span>;
                                                    })()}
                                                    {/* 레짐별×진입타입 모드 배지 (6-way composite keys) */}
                                                    {(entry as any).regimeEntries && Object.keys((entry as any).regimeEntries).length > 0 ? (
                                                        <span className="text-[7px] ml-0.5">
                                                            {ALL_REGIME_ENTRY_KEYS.map(rek => {
                                                                const re = (entry as any).regimeEntries?.[rek];
                                                                if (!re?.qualified) return null;
                                                                const { regime, entryType } = parseRegimeEntryKey(rek);
                                                                const rLetter = regime === 'TRENDING' ? 'T' : regime === 'RANGING' ? 'R' : 'V';
                                                                const eLetter = 'i'; // IGNITION only
                                                                return <span key={rek} className={re.mode === 'reverse' ? 'text-purple-400 mr-0.5' : 'text-emerald-400 mr-0.5'}>
                                                                    {rLetter}{eLetter}
                                                                </span>;
                                                            })}
                                                        </span>
                                                    ) : (
                                                        <>
                                                            {entry.allowedRegimes && entry.allowedRegimes.length > 0 && (
                                                                <span className="text-[7px] text-cyan-400/80 ml-0.5">
                                                                    {entry.allowedRegimes.map(r => r === 'TRENDING' ? 'T' : r === 'RANGING' ? 'R' : 'V').join('+')}
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                                </td>
                                                {/* ★ 레짐별 성과: T/R/V — 5전략 (I/T/F/W/G) 15-way 표시 */}
                                                {(['TRENDING', 'RANGING', 'VOLATILE'] as const).map(regime => {
                                                    const stratKeys = ['IGNITION', 'TRAP', 'FLOW', 'WICK', 'GAP'] as const;
                                                    const stratLabels = { IGNITION: 'I', TRAP: 'T', FLOW: 'F', WICK: 'W', GAP: 'G' } as const;
                                                    const stratEntries = stratKeys.map(sk => ({
                                                        key: sk,
                                                        label: stratLabels[sk],
                                                        re: entry.regimeEntries?.[`${regime}_${sk}`] as RegimeParamEntry | undefined,
                                                    }));
                                                    const ignitionRe = stratEntries[0].re;
                                                    const trapRe = stratEntries[1].re;

                                                    // 레짐별 레버리지 필드 선택
                                                    const levField = regime === 'TRENDING' ? 'leverageTrending'
                                                        : regime === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';

                                                    const renderSubRow = (re: RegimeParamEntry | undefined, label: string) => {
                                                        if (!re) return <div className="text-[7px] leading-tight text-text-secondary/20">─</div>;
                                                        const modeChar = re.mode === 'reverse' ? 'R' : 'N';
                                                        const modeColor = re.mode === 'reverse' ? 'text-purple-400' : 'text-emerald-400';
                                                        const pnlColor = re.pnl >= 0 ? 'text-green-400' : 'text-red-400';
                                                        const wrColor = re.qualified
                                                            ? (re.winRate >= 60 ? 'text-green-400' : 'text-yellow-400')
                                                            : 'text-text-secondary/40';
                                                        const lev = (re.params as any)?.[levField] ?? 0;
                                                        const tp = re.params?.tpAtrMultiplier ?? 0;
                                                        // Ignition 전용 파라미터
                                                        const igScore = label === 'I' ? (re.params as any)?.ignitionScoreThreshold : undefined;
                                                        const igVol = label === 'I' ? (re.params as any)?.ignitionVolMin : undefined;
                                                        const avgW = (re as any).avgWin ?? 0;
                                                        const avgL = (re as any).avgLoss ?? 0;
                                                        return (
                                                            <div className={`leading-tight whitespace-nowrap ${re.qualified ? '' : 'opacity-40'}`}>
                                                                <span className={`text-[7px] font-bold ${modeColor}`}>{label}{modeChar}</span>
                                                                <span className={`text-[8px] ml-0.5 font-semibold ${wrColor}`}>
                                                                    {re.winRate.toFixed(0)}%
                                                                </span>
                                                                <span className="text-[6px] text-text-secondary/50">({re.trades})</span>
                                                                <span className="text-[7px] ml-0.5 text-cyan-400">{lev}x</span>
                                                                <span className="text-[7px] ml-0.5 text-amber-400">T{tp}</span>
                                                                <span className="text-[7px] ml-0.5 font-semibold text-green-400" title="수익 거래 평균">
                                                                    +{avgW.toFixed(0)}%
                                                                </span>
                                                                <span className="text-[7px] font-semibold text-red-400" title="손실 거래 평균">
                                                                    {avgL.toFixed(0)}%
                                                                </span>
                                                                {igScore != null && (
                                                                    <span className="text-[6px] ml-0.5 text-orange-400" title={`igScore≥${igScore} igVol≥${igVol}`}>
                                                                        ig{igScore}/{igVol}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        );
                                                    };

                                                    const anyQualified = stratEntries.some(se => se.re?.qualified);
                                                    const bgClass = anyQualified ? 'ring-1 ring-cyan-500/50 rounded bg-cyan-500/10' : '';

                                                    // 15-way 데이터가 없으면 폴백: 기존 val 통계
                                                    if (stratEntries.every(se => !se.re)) {
                                                        const valRs = entry.valRegimeStats?.[regime];
                                                        const hasVal = valRs && valRs.trades > 0;
                                                        return (
                                                            <td key={regime} className="px-1 py-0.5 text-center font-mono text-[9px] text-text-secondary/30"
                                                                title={hasVal ? `${regime}: WR=${valRs!.winRate.toFixed(0)}% (${valRs!.trades}건)` : regime}>
                                                                {hasVal ? <>{valRs!.winRate.toFixed(0)}%<span className="text-[6px] opacity-60">({valRs!.trades})</span></> : '─'}
                                                            </td>
                                                        );
                                                    }

                                                    // 상세 tooltip: 학습/검증 분리 + 파라미터
                                                    const fmtRe = (re: RegimeParamEntry | undefined, name: string) => {
                                                        if (!re) return `${name}: -`;
                                                        const lev = (re.params as any)?.[levField] ?? 0;
                                                        const rAvgW = (re as any).avgWin ?? 0;
                                                        const rAvgL = (re as any).avgLoss ?? 0;
                                                        return `${name}(${re.mode === 'reverse' ? 'REV' : 'NOR'}): WR=${re.winRate.toFixed(0)}%(${re.trades}건) +${rAvgW.toFixed(1)}%/${rAvgL.toFixed(1)}%` +
                                                            ` Lev=${lev}x${re.qualified ? ' [적격]' : ' [미달]'}`;
                                                    };
                                                    // ★ 90-way 세그먼트 tooltip (5전략)
                                                    const tsEntries = (entry as any).timeSegmentEntries as Partial<Record<string, RegimeParamEntry>> | undefined;
                                                    const etEmojis: Record<string, string> = { IGNITION: '🔥', TRAP: '🎯', FLOW: '🌊', WICK: '🕯️', GAP: '📊' };
                                                    const tsLines: string[] = [];
                                                    if (tsEntries) {
                                                        for (const et of stratKeys) {
                                                            for (const sess of ['ASIA', 'EUROPE', 'US'] as const) {
                                                                for (const dt of ['WEEKDAY', 'WEEKEND'] as const) {
                                                                    const tsKey = `${regime}_${et}_${sess}_${dt}`;
                                                                    const tsE = tsEntries[tsKey];
                                                                    if (tsE?.qualified) {
                                                                        const tsEv = (tsE.winRate / 100 * (tsE.avgWin ?? 0)) + ((100 - tsE.winRate) / 100 * (tsE.avgLoss ?? 0));
                                                                        tsLines.push(`  ${etEmojis[et] || ''}${et.slice(0,2)}_${sess}_${dt}: WR=${tsE.winRate.toFixed(0)}%(${tsE.trades}건) EV=${tsEv.toFixed(1)}%`);
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                    const tsSection = tsLines.length > 0 ? `\n[90-way]\n${tsLines.join('\n')}` : '';
                                                    const tooltip = [regime, ...stratEntries.map(se => fmtRe(se.re, se.key)), tsSection].join('\n');

                                                    // ★ 90-way 미니 그리드: 세션×요일 적격 (적격 전략 수에 따라 밝기)
                                                    const tsGrid = (() => {
                                                        if (!tsEntries) return null;
                                                        const sessions = ['ASIA', 'EUROPE', 'US'] as const;
                                                        const dayTypes = ['WEEKDAY', 'WEEKEND'] as const;
                                                        const hasAny = sessions.some(s => dayTypes.some(d => stratKeys.some(et => tsEntries[`${regime}_${et}_${s}_${d}`]?.qualified)));
                                                        if (!hasAny) return null;
                                                        return (
                                                            <div className="flex gap-px mt-0.5">
                                                                {sessions.map(s => {
                                                                    const label = s === 'ASIA' ? 'A' : s === 'EUROPE' ? 'E' : 'U';
                                                                    return (
                                                                        <div key={s} className="flex flex-col items-center">
                                                                            <span className="text-[5px] text-text-secondary/40">{label}</span>
                                                                            {dayTypes.map(d => {
                                                                                const qCount = stratKeys.filter(et => tsEntries[`${regime}_${et}_${s}_${d}`]?.qualified).length;
                                                                                const bgColor = qCount >= 3 ? 'bg-cyan-400' : qCount === 2 ? 'bg-indigo-400' : qCount === 1 ? 'bg-purple-400' : 'bg-gray-700/50';
                                                                                const ttl = stratKeys.map(et => {
                                                                                    const e = tsEntries[`${regime}_${et}_${s}_${d}`];
                                                                                    return e?.qualified ? `${etEmojis[et]}${et.slice(0,2)}: WR=${e.winRate.toFixed(0)}%(${e.trades}건)` : '';
                                                                                }).filter(Boolean).join(' ') || `${s}_${d}: 미적격`;
                                                                                return <span key={d} className={`w-2 h-1.5 rounded-sm ${bgColor}`} title={ttl} />;
                                                                            })}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        );
                                                    })();

                                                    return (
                                                        <td key={regime} className={`px-1 py-0.5 font-mono ${bgClass}`} title={tooltip}>
                                                            {stratEntries.filter(se => se.re).map(se => renderSubRow(se.re, se.label))}
                                                            {stratEntries.every(se => !se.re) && <div className="text-[7px] text-text-secondary/20">─</div>}
                                                            {tsGrid}
                                                        </td>
                                                    );
                                                })}
                                                {/* ★ 스캔 상태 표시 — 어떤 게이트에서 차단/통과됐는지 */}
                                                {(() => {
                                                    const scanStatus = botState.lastScanStatuses?.find(s => s.ticker === entry.ticker);
                                                    const isWaiting = botState.waitingCandidates.some(c => c.ticker === entry.ticker);
                                                    const isOpen = botState.openPositions.some(p => p.ticker === entry.ticker && p.status === 'open');
                                                    if (isOpen) return <td className="px-1 py-1.5 text-center font-mono text-[8px] text-green-400" title="포지션 보유중">🟢보유</td>;
                                                    if (isWaiting) return <td className="px-1 py-1.5 text-center font-mono text-[8px] text-yellow-400" title={scanStatus?.detail || '존 대기중'}>⏳대기</td>;
                                                    if (!scanStatus) return <td className="px-1 py-1.5 text-center font-mono text-[8px] text-text-secondary/30" title="미스캔">─</td>;
                                                    if (scanStatus.status === 'passed') return <td className="px-1 py-1.5 text-center font-mono text-[8px] text-blue-400" title={scanStatus.detail || '통과'}>✓통과</td>;
                                                    // blocked — 게이트별 아이콘 + 설명
                                                    const gateIcons: Record<string, string> = {
                                                        volatility: '📉', direction: '🧭', adx: '📊', adx_full: '📊',
                                                        regime: '🏷️', regime_stats: '🏷️', short_gate: '⬇️', rsi_slope: '📈',
                                                        session: '🕐', data: '📡',
                                                    };
                                                    const icon = gateIcons[scanStatus.gate || ''] || '🚫';
                                                    const gateNames: Record<string, string> = {
                                                        volatility: '변동성', direction: '방향', adx: 'ADX', adx_full: 'ADX',
                                                        regime: '레짐', regime_stats: '레짐', short_gate: 'Short', rsi_slope: 'RSI',
                                                        session: '세션', data: '데이터',
                                                    };
                                                    const gateName = gateNames[scanStatus.gate || ''] || scanStatus.gate || '차단';
                                                    return (
                                                        <td className="px-1 py-1.5 text-center font-mono text-[8px] text-red-400/80" title={`${scanStatus.gate}: ${scanStatus.detail}`}>
                                                            {icon}{gateName}
                                                        </td>
                                                    );
                                                })()}
                                                <td className="px-2 py-1.5 text-center">
                                                    <button onClick={() => handleRemoveTicker(entry.ticker)} className="text-red-400/50 hover:text-red-400 transition-colors font-bold" title="종목 제거">✕</button>
                                                </td>
                                            </tr>
                                            {/* ★ 18-way 확장 패널 — 종목 클릭 시 세션×요일별 파라미터 상세 */}
                                            {expandedTicker === entry.ticker && (() => {
                                                const tsEntries = (entry as any).timeSegmentEntries as Partial<Record<string, RegimeParamEntry>> | undefined;
                                                const regimeEntries = (entry as any).regimeEntries as Record<string, RegimeParamEntry> | undefined;
                                                if (!tsEntries && !regimeEntries) return null;
                                                const sessions = ['ASIA', 'EUROPE', 'US'] as const;
                                                const dayTypes = ['WEEKDAY', 'WEEKEND'] as const;
                                                const regimes = ['TRENDING', 'RANGING', 'VOLATILE'] as const;
                                                const sessLabel = { ASIA: '🌏아시아', EUROPE: '🌍유럽', US: '🌎미국' } as const;
                                                const dtLabel = { WEEKDAY: '평일', WEEKEND: '주말' } as const;
                                                const rLabel = { TRENDING: 'T', RANGING: 'R', VOLATILE: 'V' } as const;
                                                const levField = (r: string) => r === 'TRENDING' ? 'leverageTrending' : r === 'RANGING' ? 'leverageRanging' : 'leverageVolatile';

                                                return (
                                                    <tr>
                                                        <td colSpan={6} className="p-0">
                                                            <div className="bg-indigo-900/20 border-t border-b border-indigo-700/30 px-2 py-1.5">
                                                                <div className="text-[8px] font-bold text-indigo-300 mb-1">📊 {entry.ticker.replace('USDT', '')} 세분화 파라미터 (세션 × 요일 × 레짐 × 전략)</div>
                                                                <table className="w-full text-[8px]">
                                                                    <thead>
                                                                        <tr className="text-text-secondary/50 border-b border-indigo-700/20">
                                                                            <th className="text-left px-1 py-0.5">세션</th>
                                                                            <th className="text-left px-1 py-0.5">요일</th>
                                                                            <th className="text-left px-1 py-0.5">전략</th>
                                                                            {regimes.map(r => (
                                                                                <th key={r} className="text-center px-1 py-0.5">{rLabel[r]}</th>
                                                                            ))}
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {sessions.map(sess =>
                                                                            dayTypes.map((dt, di) => {
                                                                                // ★ v52.24: IGNITION만 사용
                                                                                const entryTypes = ['IGNITION'] as const;
                                                                                const etColors: Record<string, string> = { IGNITION: 'text-orange-400' };
                                                                                const etIcons: Record<string, string> = { IGNITION: '🔥' };
                                                                                return entryTypes.map((et, ei) => (
                                                                                    <tr key={`${sess}_${dt}_${et}`} className={`border-b border-indigo-700/10 ${di === 0 && ei === 0 ? 'border-t border-indigo-700/20' : ''}`}>
                                                                                        {di === 0 && ei === 0 && (
                                                                                            <td rowSpan={entryTypes.length * 2} className="px-1 py-0.5 font-bold text-indigo-300 whitespace-nowrap">
                                                                                                {sessLabel[sess]}
                                                                                            </td>
                                                                                        )}
                                                                                        {ei === 0 && (
                                                                                            <td rowSpan={entryTypes.length} className="px-1 py-0.5 text-text-secondary/60">{dtLabel[dt]}</td>
                                                                                        )}
                                                                                        <td className={`px-1 py-0.5 text-[7px] ${etColors[et] || 'text-text-secondary'}`}>
                                                                                            {etIcons[et] || et}
                                                                                        </td>
                                                                                        {regimes.map(regime => {
                                                                                            const tsKey = `${regime}_${et}_${sess}_${dt}`;
                                                                                            const tsE = tsEntries?.[tsKey];
                                                                                            if (!tsE) {
                                                                                                // 폴백: 6-way regimeEntries
                                                                                                const fallbackRe = regimeEntries?.[`${regime}_${et}`];
                                                                                                if (fallbackRe?.qualified) {
                                                                                                    const lev = (fallbackRe.params as any)?.[levField(regime)] ?? 0;
                                                                                                    return (
                                                                                                        <td key={regime} className="px-1 py-0.5 text-center text-text-secondary/30" title="6-way 폴백">
                                                                                                            <span className="text-[7px] opacity-50">{fallbackRe.winRate.toFixed(0)}% {lev}x T{fallbackRe.params?.tpAtrMultiplier ?? 0}</span>
                                                                                                            <span className="text-[5px] ml-0.5 text-yellow-600">fb</span>
                                                                                                        </td>
                                                                                                    );
                                                                                                }
                                                                                                return <td key={regime} className="px-1 py-0.5 text-center text-text-secondary/20">─</td>;
                                                                                            }
                                                                                            const lev = (tsE.params as any)?.[levField(regime)] ?? 0;
                                                                                            const tp = tsE.params?.tpAtrMultiplier ?? 0;
                                                                                            const ev = (tsE.winRate / 100 * (tsE.avgWin ?? 0)) + ((100 - tsE.winRate) / 100 * (tsE.avgLoss ?? 0));
                                                                                            const modeChar = tsE.mode === 'reverse' ? 'R' : 'N';
                                                                                            const modeColor = tsE.mode === 'reverse' ? 'text-purple-400' : 'text-emerald-400';
                                                                                            const bgQ = tsE.qualified ? 'bg-indigo-500/15' : 'bg-red-900/10';
                                                                                            return (
                                                                                                <td key={regime} className={`px-1 py-0.5 text-center font-mono ${bgQ}`}
                                                                                                    title={`${tsKey}\nWR=${tsE.winRate.toFixed(1)}% (${tsE.trades}건)\nEV=${ev.toFixed(2)}%\nLev=${lev}x TP=${tp}\n+${(tsE.avgWin ?? 0).toFixed(1)}% / ${(tsE.avgLoss ?? 0).toFixed(1)}%`}>
                                                                                                    <span className={`text-[7px] font-bold ${modeColor}`}>{modeChar}</span>
                                                                                                    <span className={`text-[7px] ml-0.5 ${tsE.qualified ? 'text-green-400' : 'text-red-400/60'}`}>
                                                                                                        {tsE.winRate.toFixed(0)}%
                                                                                                    </span>
                                                                                                    <span className="text-[6px] text-text-secondary/40">({tsE.trades})</span>
                                                                                                    <span className="text-[6px] ml-0.5 text-cyan-400">{lev}x</span>
                                                                                                    <span className="text-[6px] ml-0.5 text-amber-400">T{tp}</span>
                                                                                                    {tsE.qualified && <span className="text-[6px] ml-0.5 text-blue-300">EV{ev.toFixed(1)}</span>}
                                                                                                </td>
                                                                                            );
                                                                                        })}
                                                                                    </tr>
                                                                                ));
                                                                            })
                                                                        )}
                                                                    </tbody>
                                                                </table>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })()}
                                            </React.Fragment>);
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="p-4 text-center text-[10px] text-text-secondary/40">
                                옵티마이저를 시작하면 종목이 자동 등록됩니다
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── 2.5. 스캔 현황 — 종목별 진입 상태 모니터 ── */}
            {registryEntries.filter(e => e.qualified !== false).length > 0 && botStatus === 'running' && (
                <ScanStatusMonitor
                    registryEntries={registryEntries.filter(e => e.qualified !== false)}
                    scanStatuses={botState.lastScanStatuses || []}
                    waitingCandidates={botState.waitingCandidates}
                    openPositions={botState.openPositions}
                    collapsed={scanMonitorCollapsed}
                    onToggleCollapse={() => setScanMonitorCollapsed(!scanMonitorCollapsed)}
                />
            )}

            {/* ── 2.6. 스캔 필터 상세 테이블 ── */}
            {botStatus === 'running' && (botState.lastScanStatuses || []).length > 0 && (
                <ScanDetailTable
                    scanStatuses={botState.lastScanStatuses || []}
                    openPositions={botState.openPositions}
                    collapsed={scanDetailCollapsed}
                    onToggleCollapse={() => setScanDetailCollapsed(!scanDetailCollapsed)}
                />
            )}

            {/* ── 3. Monitor / Waiting ── */}
            <div className="flex flex-col gap-2 min-h-[200px]">
                <div className="flex items-center gap-2 pl-2">
                    <button
                        onClick={() => setViewMode('monitor')}
                        className={`px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-t border-l border-r ${viewMode === 'monitor' ? 'bg-bg-light border-border-color text-text-primary' : 'bg-bg-dark border-transparent text-text-secondary hover:text-text-primary'}`}
                    >
                        <span className="flex items-center gap-2"><ActivityIcon className="w-3 h-3"/> MONITOR</span>
                    </button>
                    <button
                        onClick={() => setViewMode('waiting')}
                        className={`px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-t border-l border-r ${viewMode === 'waiting' ? 'bg-bg-light border-border-color text-text-primary' : 'bg-bg-dark border-transparent text-text-secondary hover:text-text-primary'}`}
                    >
                        <span className="flex items-center gap-2">
                            <ClockIcon className="w-3 h-3"/>
                            WAITING
                            {botState.waitingCandidates.length > 0 && (
                                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-brand-primary text-white text-[9px]">{botState.waitingCandidates.length}</span>
                            )}
                        </span>
                    </button>
                    {/* ★ v53.1: 포워드테스트 통계 탭 (항상 표시) */}
                    <button
                        onClick={() => setViewMode('forward' as any)}
                        className={`px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-t border-l border-r ${(viewMode as string) === 'forward' ? 'bg-bg-light border-border-color text-cyan-300' : 'bg-bg-dark border-transparent text-text-secondary hover:text-cyan-300'}`}
                    >
                        <span className="flex items-center gap-2">
                            📊 FWD TEST
                        </span>
                    </button>
                    {/* 섀도우 탭 (섀도우 모드에서만) */}
                    {isShadowMode && (
                        <button
                            onClick={() => setViewMode('shadow' as any)}
                            className={`px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-t border-l border-r ${(viewMode as string) === 'shadow' ? 'bg-bg-light border-border-color text-purple-300' : 'bg-bg-dark border-transparent text-text-secondary hover:text-purple-300'}`}
                        >
                            👻 SHADOW
                        </button>
                    )}
                </div>

                <div className="bg-bg-light border border-border-color rounded-lg overflow-hidden shadow-inner p-1 min-h-[180px]">
                    {(viewMode as string) === 'forward' ? (
                        <ForwardTestStats />
                    ) : (viewMode as string) === 'shadow' ? (
                        <ShadowSignalTable signals={botState.shadowSignals ?? []} registry={botState.tickerParamRegistry} wfWindows={botState.lastWfWindows} />
                    ) : viewMode === 'waiting' ? (
                        <IdleScanner botState={botState} onDelegate={onDelegate} />
                    ) : (
                        <>
                            {activePositions.length > 0 ? (
                                <div className="overflow-y-auto pr-2 custom-scrollbar">
                                    <div className={`grid gap-3 ${activePositions.length > 1 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1'}`}>
                                        {activePositions.map(pos => (
                                            <div key={pos.id}>
                                                <CompactTradeCard trade={pos} />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <IdleScanner botState={botState} onDelegate={onDelegate} />
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* ── AI Configuration (접기) ── */}
            <details className="bg-bg-dark border border-border-color/30 rounded-lg overflow-hidden">
                <summary className="px-3 py-2 text-[10px] font-bold text-text-secondary/60 cursor-pointer hover:bg-bg-light/10 transition-colors flex items-center gap-2">
                    <span>⚙️ AI Configuration</span>
                    <span className="text-text-secondary/30 font-normal">(클릭하여 열기)</span>
                </summary>
                <div className="p-3 border-t border-border-color/20">
                    <AiCoreConfigComponent config={aiConfig} botState={botState} onConfigChange={onConfigChange ?? (() => {})} disabled={botStatus === 'running'} />
                </div>
            </details>

            {/* ── 실전 vs 백테스트 검증 대시보드 ── */}
            <VerificationDashboard />

            <style>{`.custom-scrollbar::-webkit-scrollbar { width: 4px; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #374151; border-radius: 2px; }`}</style>
        </div>
    );
};

// ── 포워드테스트 통계 ──

const ForwardTestStats: React.FC = () => {
    const [trades, setTrades] = React.useState<any[]>([]);
    const [view, setView] = React.useState<'summary' | 'session' | 'ticker' | 'regime'>('summary');

    // ★ 5초마다 localStorage 폴링 (WF 완료 시 자동 갱신)
    const [tradeHash, setTradeHash] = React.useState('');
    React.useEffect(() => {
        const load = () => {
            try {
                const raw = localStorage.getItem('forward_test_trades_v1');
                if (raw) {
                    // ★ v53.2: 길이+마지막거래 해시로 변경 감지 (교체도 감지)
                    const hash = raw.length + '_' + raw.slice(-100);
                    if (hash !== tradeHash) {
                        setTrades(JSON.parse(raw));
                        setTradeHash(hash);
                    }
                }
            } catch {}
        };
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
    }, [tradeHash]);

    if (trades.length === 0) {
        return <div className="text-center text-text-secondary/50 text-xs py-4">포워드테스트 데이터 없음 — WF 최적화 실행 시 자동 수집</div>;
    }

    // 기본 집계
    const closed = trades.filter(t => t.exitReason !== 'END_OF_DATA');
    const tpTrades = trades.filter(t => t.exitReason === 'TP1');
    const slTrades = trades.filter(t => t.exitReason === 'SL');
    const totalPnl = closed.reduce((s: number, t: any) => s + (t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0), 0);
    const wins = closed.filter(t => (t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0).length;
    const wr = closed.length > 0 ? (wins / closed.length * 100) : 0;

    // 종목별 집계
    const byTicker: Record<string, { trades: number; wins: number; pnl: number; tp: number; sl: number }> = {};
    for (const t of closed) {
        const tk = t.ticker || 'UNKNOWN';
        if (!byTicker[tk]) byTicker[tk] = { trades: 0, wins: 0, pnl: 0, tp: 0, sl: 0 };
        byTicker[tk].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) byTicker[tk].wins++;
        byTicker[tk].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
        if (t.exitReason === 'TP1') byTicker[tk].tp++;
        if (t.exitReason === 'SL') byTicker[tk].sl++;
    }

    // 레짐×방향 집계
    const byRegimeDir: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const key = `${t.regime || '?'}×${t.direction || '?'}`;
        if (!byRegimeDir[key]) byRegimeDir[key] = { trades: 0, wins: 0, pnl: 0 };
        byRegimeDir[key].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) byRegimeDir[key].wins++;
        byRegimeDir[key].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    // 세션별 집계
    const bySession: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const s = t.session || '?';
        if (!bySession[s]) bySession[s] = { trades: 0, wins: 0, pnl: 0 };
        bySession[s].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) bySession[s].wins++;
        bySession[s].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    // 레버리지별 집계
    const byLev: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const lv = String(t.leverage || '?') + 'x';
        if (!byLev[lv]) byLev[lv] = { trades: 0, wins: 0, pnl: 0 };
        byLev[lv].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) byLev[lv].wins++;
        byLev[lv].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    const statRow = (label: string, stat: { trades: number; wins: number; pnl: number }, highlight = false) => {
        const wrv = stat.trades > 0 ? (stat.wins / stat.trades * 100) : 0;
        return (
            <tr key={label} className={`border-t border-border-color/10 ${highlight ? 'bg-cyan-900/10' : ''}`}>
                <td className="px-1 py-0.5 font-mono text-text-primary font-bold">{label}</td>
                <td className="px-1 py-0.5 text-center">{stat.trades}</td>
                <td className={`px-1 py-0.5 text-center font-bold ${wrv >= 60 ? 'text-green-400' : wrv >= 45 ? 'text-amber-400' : 'text-red-400'}`}>{wrv.toFixed(0)}%</td>
                <td className={`px-1 py-0.5 text-right font-mono font-bold ${stat.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{stat.pnl >= 0 ? '+' : ''}{stat.pnl.toFixed(1)}</td>
                <td className={`px-1 py-0.5 text-right font-mono text-text-secondary`}>{stat.trades > 0 ? (stat.pnl / stat.trades).toFixed(2) : '—'}</td>
            </tr>
        );
    };

    // ★ v53.2: 세션×방향 교차 집계
    const bySessionDir: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const key = `${t.session || '?'}×${t.direction || '?'}`;
        if (!bySessionDir[key]) bySessionDir[key] = { trades: 0, wins: 0, pnl: 0 };
        bySessionDir[key].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) bySessionDir[key].wins++;
        bySessionDir[key].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    // 세션×레버 교차 집계
    const bySessionLev: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const key = `${t.session || '?'}×${t.leverage || '?'}x`;
        if (!bySessionLev[key]) bySessionLev[key] = { trades: 0, wins: 0, pnl: 0 };
        bySessionLev[key].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) bySessionLev[key].wins++;
        bySessionLev[key].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    // 세션×레짐 교차 집계
    const bySessionRegime: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closed) {
        const key = `${t.session || '?'}×${t.regime || '?'}`;
        if (!bySessionRegime[key]) bySessionRegime[key] = { trades: 0, wins: 0, pnl: 0 };
        bySessionRegime[key].trades++;
        if ((t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0) > 0) bySessionRegime[key].wins++;
        bySessionRegime[key].pnl += t['pnlPercent(lev)'] ?? t.pnlPercent ?? 0;
    }

    const sortedTickers = Object.entries(byTicker).sort((a, b) => b[1].pnl - a[1].pnl);
    const sortedRegime = Object.entries(byRegimeDir).sort((a, b) => b[1].pnl - a[1].pnl);
    const uniqueTickers = new Set(closed.map(t => t.ticker)).size;

    return (
        <div className="space-y-2 p-2">
            {/* 요약 헤더 */}
            <div className="grid grid-cols-5 gap-2 text-[10px]">
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">총 거래</div>
                    <div className="text-cyan-300 font-bold text-sm">{closed.length}<span className="text-[9px] text-text-secondary ml-1">({uniqueTickers}종목)</span></div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">승률</div>
                    <div className={`font-bold text-sm ${wr >= 60 ? 'text-green-400' : wr >= 45 ? 'text-amber-400' : 'text-red-400'}`}>{wr.toFixed(1)}%</div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">PnL%(lev)</div>
                    <div className={`font-bold text-sm ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(1)}</div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">TP / SL</div>
                    <div className="font-bold text-sm text-text-primary">{tpTrades.length} / {slTrades.length}</div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">평균PnL</div>
                    <div className={`font-bold text-sm ${totalPnl / Math.max(1, closed.length) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{(totalPnl / Math.max(1, closed.length)).toFixed(2)}%</div>
                </div>
            </div>

            {/* 뷰 토글 */}
            <div className="flex gap-1">
                {(['summary', 'session', 'ticker', 'regime'] as const).map(v => (
                    <button key={v} onClick={() => setView(v)}
                        className={`px-3 py-1 text-[10px] rounded font-bold transition-colors ${view === v ? 'bg-cyan-700 text-white' : 'bg-bg-dark text-text-secondary hover:text-cyan-300'}`}>
                        {v === 'summary' ? '요약' : v === 'session' ? '장별' : v === 'ticker' ? '종목별' : '레짐×방향'}
                    </button>
                ))}
                <button onClick={() => {
                    let ftData: any[] = [];
                    try { const raw = localStorage.getItem('forward_test_trades_v1'); if (raw) ftData = JSON.parse(raw); } catch {}
                    if (ftData.length === 0) { alert('데이터 없음'); return; }
                    exportToXlsx(ftData, `forward_test_${new Date().toISOString().slice(0,10)}.xlsx`);
                }} className="ml-auto px-3 py-1 text-[10px] bg-cyan-700 hover:bg-cyan-600 text-white rounded font-bold">
                    📥 내보내기
                </button>
                <button onClick={() => { if (confirm('포워드테스트 데이터를 초기화합니까?')) { localStorage.removeItem('forward_test_trades_v1'); setTrades([]); } }}
                    className="px-3 py-1 text-[10px] bg-red-800 hover:bg-red-700 text-white rounded font-bold">🗑️</button>
            </div>

            {/* 뷰 콘텐츠 */}
            <div className="overflow-x-auto max-h-[350px] overflow-y-auto custom-scrollbar">
                <table className="w-full text-[9px]">
                    <thead className="sticky top-0 bg-bg-dark z-10">
                        <tr className="text-text-secondary/70">
                            <th className="px-1 py-1 text-left">{view === 'summary' ? '구분' : view === 'ticker' ? '종목' : view === 'regime' ? '레짐×방향' : '구분'}</th>
                            <th className="px-1 py-1 text-center">거래수</th>
                            <th className="px-1 py-1 text-center">WR</th>
                            <th className="px-1 py-1 text-right">PnL%(lev)</th>
                            <th className="px-1 py-1 text-right">평균PnL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {view === 'summary' && (<>
                            <tr className="bg-cyan-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-cyan-300 font-bold">세션별 (ASIA/EUROPE/US)</td></tr>
                            {Object.entries(bySession).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v))}
                            <tr className="bg-cyan-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-cyan-300 font-bold">레버리지별</td></tr>
                            {Object.entries(byLev).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v))}
                        </>)}
                        {view === 'session' && (<>
                            <tr className="bg-cyan-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-cyan-300 font-bold">📊 세션 총합</td></tr>
                            {Object.entries(bySession).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v, true))}
                            <tr className="bg-green-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-green-300 font-bold">세션×방향</td></tr>
                            {Object.entries(bySessionDir).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v))}
                            <tr className="bg-amber-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-amber-300 font-bold">세션×레버리지</td></tr>
                            {Object.entries(bySessionLev).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v))}
                            <tr className="bg-purple-900/20"><td colSpan={5} className="px-1 py-0.5 text-[9px] text-purple-300 font-bold">세션×레짐</td></tr>
                            {Object.entries(bySessionRegime).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => statRow(k, v))}
                        </>)}
                        {view === 'ticker' && sortedTickers.map(([k, v]) => statRow(k.replace('USDT', ''), v, v.pnl > 0))}
                        {view === 'regime' && sortedRegime.map(([k, v]) => statRow(k, v, v.pnl > 0))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// ── 섀도우 시그널 테이블 ──

// ★ XLSX 내보내기 유틸 (멀티시트 지원)
function exportToXlsx(data: any[], filename: string) {
    try {
        const XLSX = require('xlsx');
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        XLSX.writeFile(wb, filename);
    } catch (e) {
        if (data.length === 0) return;
        const headers = Object.keys(data[0]);
        const csv = [headers.join(','), ...data.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename.replace('.xlsx', '.csv'); a.click();
        URL.revokeObjectURL(url);
    }
}

function exportMultiSheetXlsx(sheets: { name: string; data: any[] }[], filename: string) {
    try {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        for (const sheet of sheets) {
            const ws = sheet.data.length > 0
                ? XLSX.utils.json_to_sheet(sheet.data)
                : XLSX.utils.aoa_to_sheet([['데이터 없음']]);
            XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
        }
        XLSX.writeFile(wb, filename);
    } catch (e) {
        // XLSX 없으면 각 시트를 별도 CSV로 내보내기
        const base = filename.replace('.xlsx', '');
        for (const sheet of sheets) {
            if (sheet.data.length === 0) continue;
            const headers = Object.keys(sheet.data[0]);
            const csv = '\uFEFF' + [headers.join(','), ...sheet.data.map(r => headers.map(h => {
                const v = r[h];
                if (v === undefined || v === null) return '';
                if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) return `"${v.replace(/"/g, '""')}"`;
                return String(v);
            }).join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `${base}_${sheet.name}.csv`; a.click();
            URL.revokeObjectURL(url);
        }
    }
}

const ShadowSignalTable: React.FC<{ signals: import('../types').ShadowSignal[]; registry?: Record<string, TickerParamEntry>; wfWindows?: import('../types').WfWindowRecord[] }> = ({ signals, registry, wfWindows }) => {
    const closed = signals.filter(s => s.status === 'closed');
    const open = signals.filter(s => s.status === 'open');
    const passed = closed.filter(s => s.passedAllFilters);
    const rejected = closed.filter(s => !s.passedAllFilters);
    const passedWin = passed.filter(s => (s.pnlPercent ?? 0) > 0).length;
    const rejectedWin = rejected.filter(s => (s.pnlPercent ?? 0) > 0).length;

    // 거부 게이트별 집계
    const gateStats: Record<string, { total: number; wins: number; avgPnl: number }> = {};
    for (const s of rejected) {
        const gate = s.rejectedGate ?? 'unknown';
        if (!gateStats[gate]) gateStats[gate] = { total: 0, wins: 0, avgPnl: 0 };
        gateStats[gate].total++;
        if ((s.pnlPercent ?? 0) > 0) gateStats[gate].wins++;
        gateStats[gate].avgPnl += s.pnlPercent ?? 0;
    }
    for (const g of Object.values(gateStats)) g.avgPnl = g.total > 0 ? g.avgPnl / g.total : 0;

    const sorted = [...signals].sort((a, b) => b.signalTimestamp - a.signalTimestamp).slice(0, 100);

    return (
        <div className="space-y-2 p-2">
            {/* 집계 요약 */}
            {signals.length > 0 && (
            <div className="grid grid-cols-4 gap-2 text-[10px]">
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">열림</div>
                    <div className="text-purple-300 font-bold">{open.length}</div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">필터통과</div>
                    <div className="text-green-400 font-bold">{passed.length > 0 ? `${(passedWin/passed.length*100).toFixed(0)}% WR` : '—'} <span className="text-text-secondary/50">({passed.length}건)</span></div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">필터거부</div>
                    <div className="text-amber-400 font-bold">{rejected.length > 0 ? `${(rejectedWin/rejected.length*100).toFixed(0)}% WR` : '—'} <span className="text-text-secondary/50">({rejected.length}건)</span></div>
                </div>
                <div className="bg-bg-dark rounded p-2 text-center">
                    <div className="text-text-secondary">총 기록</div>
                    <div className="text-text-primary font-bold">{signals.length}</div>
                </div>
            </div>
            )}

            {/* ★ v52.63: 미실현PnL 스냅샷 버튼 */}
            {open.length > 0 && (
                <div className="bg-bg-dark rounded p-2">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => {
                                const engine = (window as any).tradingEngine;
                                if (!engine?.snapshotShadowUnrealized) return;
                                const result = engine.snapshotShadowUnrealized();
                                const s = result.stats;
                                alert(
                                    `📊 섀도우 미실현PnL 스냅샷\n\n` +
                                    `조회: ${s.total}건 (가격 있는 오픈 포지션)\n` +
                                    `수익: ${s.winning}건 | 손실: ${s.losing}건\n` +
                                    `WR: ${s.total > 0 ? (s.winning/s.total*100).toFixed(0) : 0}%\n` +
                                    `평균 PnL%: ${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(2)}%\n` +
                                    `총 PnL%(레버): ${s.totalPnlLevPct >= 0 ? '+' : ''}${s.totalPnlLevPct.toFixed(1)}%`
                                );
                            }}
                            className="px-3 py-1 text-[10px] bg-purple-700 hover:bg-purple-600 text-white rounded transition-colors font-bold"
                        >
                            📊 미실현PnL 조회
                        </button>
                        <button
                            onClick={async () => {
                                const engine = (window as any).tradingEngine;
                                if (!engine?.retroactiveTPSLCheck) { alert('엔진 없음'); return; }
                                const btn = document.activeElement as HTMLButtonElement;
                                if (btn) btn.textContent = '⏳ 추적 중...';
                                try {
                                    const r = await engine.retroactiveTPSLCheck();
                                    alert(
                                        `🔍 소급 TP/SL 추적 완료\n\n` +
                                        `확인: ${r.checked}건\n` +
                                        `TP 도달: ${r.tpHit}건 ✅\n` +
                                        `SL 도달: ${r.slHit}건 ❌\n` +
                                        `미도달: ${r.unchanged}건\n` +
                                        `에러: ${r.errors}건`
                                    );
                                } catch (e: any) { alert('에러: ' + e.message); }
                                if (btn) btn.textContent = '🔍 소급 TP/SL 추적';
                            }}
                            className="px-3 py-1 text-[10px] bg-amber-700 hover:bg-amber-600 text-white rounded transition-colors font-bold"
                        >
                            🔍 소급 TP/SL 추적
                        </button>
                        <span className="text-[9px] text-text-secondary">오픈 {open.length}건의 현재가 기준 미실현 손익 조회</span>
                    </div>
                    {/* 오픈 포지션 개별 리스트 + 요약 */}
                    {(() => {
                        const withUnr = open.filter(s => (s as any)._unrealizedPct !== undefined);
                        if (withUnr.length === 0) return null;
                        const winning = withUnr.filter(s => (s as any)._unrealizedPct > 0).length;
                        const totalLev = withUnr.reduce((sum, s) => sum + ((s as any)._unrealizedLevPct || 0), 0);
                        const avgPct = withUnr.reduce((sum, s) => sum + ((s as any)._unrealizedPct || 0), 0) / withUnr.length;
                        const sorted = [...withUnr].sort((a, b) => ((b as any)._unrealizedLevPct || 0) - ((a as any)._unrealizedLevPct || 0));
                        const tickers = new Set(withUnr.map(s => s.ticker));
                        const elapsed = (ts: number) => { const m = Math.floor((Date.now() - ts) / 60000); return m < 60 ? m + 'm' : Math.floor(m/60) + 'h' + (m%60) + 'm'; };

                        return (
                            <>
                                <div className="mt-1 flex gap-3 text-[9px]">
                                    <span className="text-text-secondary">미실현:</span>
                                    <span className={totalLev >= 0 ? 'text-green-400' : 'text-red-400'}>
                                        PnL%(lev) {totalLev >= 0 ? '+' : ''}{totalLev.toFixed(1)}%
                                    </span>
                                    <span className="text-text-secondary">
                                        WR {(winning/withUnr.length*100).toFixed(0)}% ({winning}/{withUnr.length})
                                    </span>
                                    <span className="text-text-secondary">
                                        avg {avgPct >= 0 ? '+' : ''}{avgPct.toFixed(2)}%
                                    </span>
                                    <span className="text-text-secondary">{tickers.size}종목</span>
                                </div>
                                <div className="mt-1 max-h-[300px] overflow-y-auto custom-scrollbar">
                                    <table className="w-full text-[9px]">
                                        <thead className="sticky top-0 bg-bg-dark">
                                            <tr className="text-text-secondary/70">
                                                <th className="px-1 py-0.5 text-left">종목</th>
                                                <th className="px-1 py-0.5 text-center">방향</th>
                                                <th className="px-1 py-0.5 text-center">레짐</th>
                                                <th className="px-1 py-0.5 text-right">진입가</th>
                                                <th className="px-1 py-0.5 text-right">현재가</th>
                                                <th className="px-1 py-0.5 text-right">PnL%</th>
                                                <th className="px-1 py-0.5 text-right">PnL%(lev)</th>
                                                <th className="px-1 py-0.5 text-center">필터</th>
                                                <th className="px-1 py-0.5 text-center">경과</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {sorted.map(s => {
                                                const pct = (s as any)._unrealizedPct || 0;
                                                const levPct = (s as any)._unrealizedLevPct || 0;
                                                const cur = (s as any)._currentPrice || 0;
                                                return (
                                                    <tr key={s.id} className="border-t border-border-color/10">
                                                        <td className="px-1 py-0.5 font-mono font-bold text-text-primary">{s.ticker.replace('USDT','')}</td>
                                                        <td className={`px-1 py-0.5 text-center ${s.direction === 'Long' ? 'text-green-400' : 'text-red-400'}`}>{s.direction === 'Long' ? 'L' : 'S'}</td>
                                                        <td className="px-1 py-0.5 text-center text-text-secondary/70">{(s.regime || '').replace('TREND_','T_').replace('VOLATILITY_','V_').replace('BREAKOUT_','B_').replace('RANGE_','R_').replace('LIQUIDATION_','LC_').replace('CHOPPY_','C_').slice(0,8)}</td>
                                                        <td className="px-1 py-0.5 text-right font-mono text-text-secondary">{s.signalPrice.toPrecision(4)}</td>
                                                        <td className="px-1 py-0.5 text-right font-mono">{cur.toPrecision(4)}</td>
                                                        <td className={`px-1 py-0.5 text-right font-mono ${pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}</td>
                                                        <td className={`px-1 py-0.5 text-right font-mono font-bold ${levPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{levPct >= 0 ? '+' : ''}{levPct.toFixed(1)}</td>
                                                        <td className="px-1 py-0.5 text-center">{s.passedAllFilters ? <span className="text-green-400">✅</span> : <span className="text-red-400">❌</span>}</td>
                                                        <td className="px-1 py-0.5 text-center text-text-secondary/50">{elapsed(s.signalTimestamp)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        );
                    })()}
                </div>
            )}

            {/* 게이트별 거부 분석 */}
            {Object.keys(gateStats).length > 0 && (
                <div className="bg-bg-dark rounded p-2">
                    <div className="text-[9px] text-text-secondary mb-1 font-bold">거부 게이트별 실제 성과</div>
                    <div className="flex flex-wrap gap-1">
                        {Object.entries(gateStats).sort((a, b) => b[1].total - a[1].total).map(([gate, stat]) => (
                            <span key={gate} className={`text-[9px] px-1.5 py-0.5 rounded ${stat.avgPnl > 0 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                                {gate}: {stat.wins}/{stat.total} ({(stat.wins/stat.total*100).toFixed(0)}%) avg{stat.avgPnl >= 0 ? '+' : ''}{stat.avgPnl.toFixed(1)}%
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* 통합 내보내기 */}
            <button
                onClick={() => {
                    // 시트1: 섀도우 시그널
                    const shadowData = signals.map(s => ({
                        종목: s.ticker, 방향: s.direction, 시그널가격: s.signalPrice,
                        시간: new Date(s.signalTimestamp).toISOString(),
                        레짐: s.regime, 세션: s.session, 요일: s.dayType,
                        '18way_n': s.registryN ?? '', '18way_WR': s.registryWR ?? '',
                        '18way_EV': s.registryEV ?? '', 적격: s.registryQualified ?? '',
                        레버리지: s.leverage ?? '',
                        필터통과: s.passedAllFilters ? 'Y' : 'N', 거부게이트: s.rejectedGate ?? '',
                        TP가격: s.virtualTp ?? '', SL가격: s.virtualSl ?? '',
                        상태: s.status, 종료가격: s.exitPrice ?? '',
                        'PnL%': s.pnlPercent ?? '', 'PnL%(레버)': (s as any).pnlLevPercent ?? '',
                        'PnL$': (s as any).pnlDollar ?? '', 종료사유: s.reasonForExit ?? '',
                        현재가: (s as any)._currentPrice ?? '',
                        '미실현PnL%': (s as any)._unrealizedPct != null ? ((s as any)._unrealizedPct as number).toFixed(4) : '',
                        '미실현PnL%(레버)': (s as any)._unrealizedLevPct != null ? ((s as any)._unrealizedLevPct as number).toFixed(4) : '',
                    }));

                    // 시트2: 포워드테스트 거래
                    let ftData: any[] = [];
                    try { const raw = localStorage.getItem('forward_test_trades_v1'); if (raw) ftData = JSON.parse(raw); } catch {}

                    // 시트3: 종목별 파라미터 — props 또는 localStorage에서 로드
                    const paramData: any[] = [];
                    let regSource = registry;
                    if (!regSource || Object.keys(regSource).length === 0) {
                        try {
                            const raw = localStorage.getItem('ticker_param_registry_v1');
                            if (raw) regSource = JSON.parse(raw);
                        } catch {}
                    }
                    // params에서 핵심 파라미터 추출
                    const getP = (ea: any) => {
                        const p = ea?.params || {};
                        return {
                            레버리지T: p.leverageTrending ?? '', 레버리지R: p.leverageRanging ?? '', 레버리지V: p.leverageVolatile ?? '',
                            TP배수: p.tpAtrMultiplier ?? '', SL배수: p.slAtrMultiplier ?? '',
                            Short배율: p.shortMultiplier ?? '', IG임계값: p.ignitionScoreThreshold ?? '',
                            TF합의: p.minTfConsensus ?? '',
                        };
                    };
                    const evCalc = (wr: number, avgW: number, avgL: number) =>
                        wr > 0 ? ((wr / 100 * avgW) + ((100 - wr) / 100 * avgL)) : 0;

                    if (regSource) {
                        for (const [ticker, entry] of Object.entries(regSource)) {
                            const ea = entry as any;
                            const ep = getP(ea);
                            paramData.push({
                                종목: ticker, 적격: ea.qualified ? 'Y' : 'N',
                                모드: ea.mode, '승률%': ea.winRate, 거래수: ea.trades,
                                '평균익%': ea.avgWin, '평균손%': ea.avgLoss,
                                'EV%': evCalc(ea.winRate ?? 0, ea.avgWin ?? 0, ea.avgLoss ?? 0).toFixed(2),
                                'PnL%': ea.pnl, 'maxDD%': ea.maxDD ?? '',
                                '보유시간(분)': ea.avgHoldingMin ?? '',
                                ...ep, 레짐: '', 세션: '', 요일: '', 구분: '종목전체',
                                학습PnL: ea.trainPnl ?? '', 학습WR: ea.trainWinRate ?? '',
                            });
                            if (ea.timeSegmentEntries) {
                                for (const [key, tsEntry] of Object.entries(ea.timeSegmentEntries)) {
                                    const parts = key.split('_');
                                    const tsa = tsEntry as any;
                                    const tp = getP(tsa);
                                    paramData.push({
                                        종목: ticker, 적격: tsa.qualified ? 'Y' : 'N',
                                        모드: tsa.mode ?? ea.mode,
                                        '승률%': tsa.winRate, 거래수: tsa.trades,
                                        '평균익%': tsa.avgWin, '평균손%': tsa.avgLoss,
                                        'EV%': evCalc(tsa.winRate ?? 0, tsa.avgWin ?? 0, tsa.avgLoss ?? 0).toFixed(2),
                                        'PnL%': tsa.pnl, 'maxDD%': '',
                                        '보유시간(분)': '',
                                        ...tp, 레짐: parts[0] ?? '', 세션: parts[2] ?? '', 요일: parts[3] ?? '',
                                        구분: key,
                                        학습PnL: tsa.trainPnl ?? '', 학습WR: tsa.trainWinRate ?? '',
                                    });
                                }
                            }
                        }
                    }

                    // ★ v52.56: WF 윈도우별 bestParams 시트
                    const wfWindowData = (wfWindows ?? []).map(w => ({
                        종목: w.ticker, 윈도우: w.windowIndex,
                        학습PnL: w.trainPnl.toFixed(2), 검증PnL: w.testPnl.toFixed(2),
                        검증WR: w.testWinRate.toFixed(1), 검증거래수: w.testTrades,
                        검증maxDD: w.testMaxDD.toFixed(2), 모드: w.selectedMode,
                        '레버T': w.leverageT, '레버R': w.leverageR, '레버V': w.leverageV,
                        TP배수: w.tpMultiplier, SL배수: w.slMultiplier,
                        Short배율: w.shortMultiplier, IG임계값: w.igThreshold, TF합의: w.tfConsensus,
                    }));

                    const sheets = [
                        { name: '종목별파라미터', data: paramData },
                        { name: '섀도우시그널', data: shadowData },
                        { name: '포워드테스트', data: ftData },
                        { name: 'WF윈도우', data: wfWindowData },
                    ];
                    const totalCount = shadowData.length + ftData.length + paramData.length;
                    if (totalCount === 0) { alert('내보낼 데이터 없음'); return; }
                    exportMultiSheetXlsx(sheets, `shadow_data_${new Date().toISOString().slice(0,10)}.xlsx`);
                }}
                className="px-4 py-1.5 text-[10px] bg-purple-700 hover:bg-purple-600 text-white rounded transition-colors font-bold"
            >
                📥 전체 내보내기 (섀도우 + 포워드테스트 + 종목파라미터)
            </button>

            {/* 시그널 목록 */}
            {signals.length === 0 ? (
                <div className="text-center text-text-secondary/50 text-xs py-4">섀도우 시그널 대기 중 — Ignition 시그널 발생 시 자동 기록</div>
            ) : (
            <div className="overflow-x-auto max-h-[300px] overflow-y-auto custom-scrollbar">
                <table className="w-full text-[9px]">
                    <thead className="sticky top-0 bg-bg-dark">
                        <tr className="text-text-secondary/70">
                            <th className="px-1 py-1 text-left">종목</th>
                            <th className="px-1 py-1 text-center">방향</th>
                            <th className="px-1 py-1 text-center">필터</th>
                            <th className="px-1 py-1 text-center">거부게이트</th>
                            <th className="px-1 py-1 text-center">n</th>
                            <th className="px-1 py-1 text-center">WR</th>
                            <th className="px-1 py-1 text-center">EV</th>
                            <th className="px-1 py-1 text-center">상태</th>
                            <th className="px-1 py-1 text-right">PnL%</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map(s => (
                            <tr key={s.id} className="border-t border-border-color/10 hover:bg-bg-dark/50">
                                <td className="px-1 py-1 font-mono font-bold text-text-primary">{s.ticker.replace('USDT','')}</td>
                                <td className={`px-1 py-1 text-center ${s.direction === 'Long' ? 'text-green-400' : 'text-red-400'}`}>{s.direction === 'Long' ? 'L' : 'S'}</td>
                                <td className="px-1 py-1 text-center">{s.passedAllFilters ? <span className="text-green-400">✅</span> : <span className="text-red-400">❌</span>}</td>
                                <td className="px-1 py-1 text-center text-text-secondary">{s.rejectedGate ?? '—'}</td>
                                <td className="px-1 py-1 text-center font-mono">{s.registryN ?? '—'}</td>
                                <td className="px-1 py-1 text-center font-mono">{s.registryWR != null ? `${s.registryWR.toFixed(0)}%` : '—'}</td>
                                <td className="px-1 py-1 text-center font-mono">{s.registryEV != null ? `${s.registryEV >= 0 ? '+' : ''}${s.registryEV.toFixed(1)}` : '—'}</td>
                                <td className="px-1 py-1 text-center">{s.status === 'open' ? <span className="text-purple-400">⏳</span> : s.reasonForExit === 'shadow_tp' ? '🎯' : s.reasonForExit === 'shadow_sl' ? '🛑' : '⏰'}</td>
                                <td className={`px-1 py-1 text-right font-mono ${(s.pnlPercent ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{s.pnlPercent != null ? `${s.pnlPercent >= 0 ? '+' : ''}${s.pnlPercent.toFixed(2)}%` : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            )}
        </div>
    );
};

// ── 스캔 상세 테이블 ──

/** ★ 스캔 필터 상세 테이블 — 종목×필터 매트릭스 (소수점 3자리) */
const LIGHT_GATES = ['direction', 'dir_multiplier', 'short_gate', 'adx', 'ignition', 'rsi_extreme', 'rsi_band'] as const;
const FULL_GATES = ['tf_consensus', 'signal_required', 'regime', 'ev_prefilter', 'rr_filter', 'atr_band', 'vol_level', 'ticker_blacklist', 'rsi_direction', 'entry_score', 'safe_hour', 'faker_blacklist', 'faker_cooldown', 'margin_check', 'open_position'] as const;
const ALL_GATES = [...LIGHT_GATES, ...FULL_GATES];
const GATE_LABELS: Record<string, string> = {
    direction: '방향', dir_multiplier: 'Short배율', short_gate: 'Short게이트',
    adx: 'ADX', ignition: 'Ignition', rsi_extreme: 'RSI극단', rsi_band: 'RSI밴드',
    tf_consensus: 'TF동의', signal_required: 'Ignition필수', regime: '레짐',
    ev_prefilter: 'EV', rr_filter: 'RR', atr_band: 'ATR밴드', vol_level: 'volLv', ticker_blacklist: '블랙', rsi_direction: 'RSI방향', entry_score: '스코어',
    safe_hour: '시간대', faker_blacklist: '3연패BL', faker_cooldown: '쿨다운', margin_check: '증거금', open_position: '기존포지션',
    max_positions: '포지션한도', execution: '주문실행', execution_error: '주문오류',
};

const ScanDetailTable: React.FC<{
    scanStatuses: ScanStatus[];
    openPositions: Trade[];
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}> = ({ scanStatuses, openPositions, collapsed = false, onToggleCollapse }) => {
    if (scanStatuses.length === 0) return null;

    // filterSteps 가 있는 종목만 표시
    const withSteps = scanStatuses.filter(s => s.filterSteps && s.filterSteps.length > 0);
    if (withSteps.length === 0) return null;

    // 정렬: passed > blocked, 이름순
    const sorted = [...withSteps].sort((a, b) => {
        if (a.status === 'passed' && b.status !== 'passed') return -1;
        if (a.status !== 'passed' && b.status === 'passed') return 1;
        return a.ticker.localeCompare(b.ticker);
    });

    const fmtVal = (v: number) => {
        if (Number.isInteger(v) || Math.abs(v) >= 100) return v.toFixed(0);
        return v.toFixed(3);
    };

    return (
        <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border-color/30 flex items-center gap-2 cursor-pointer select-none"
                onClick={onToggleCollapse}>
                <span className="text-[10px] text-text-secondary/60">{collapsed ? '▶' : '▼'}</span>
                <span className="text-sm">🔬</span>
                <span className="text-xs font-bold text-text-primary">스캔 필터 상세</span>
                <span className="text-[10px] text-text-secondary font-mono">Light({LIGHT_GATES.length}) + Full({FULL_GATES.length})</span>
            </div>
            {!collapsed && <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono border-collapse min-w-[700px]">
                    <thead>
                        <tr className="border-b border-border-color/30 bg-bg-light/10">
                            <th className="sticky left-0 z-10 bg-bg-dark px-2 py-1.5 text-left text-text-secondary font-bold border-r border-border-color/20 min-w-[90px]">종목</th>
                            {ALL_GATES.map((g, i) => (
                                <th key={g} className={`px-1.5 py-1.5 text-center text-text-secondary font-normal whitespace-nowrap ${i === LIGHT_GATES.length - 1 ? 'border-r-2 border-blue-500/30' : ''}`}>
                                    {GATE_LABELS[g] || g}
                                </th>
                            ))}
                            <th className="px-2 py-1.5 text-center text-text-secondary font-normal">결과</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map(scan => {
                            const isOpen = openPositions.some(p => p.ticker === scan.ticker && p.status === 'open');
                            const stepMap = new Map<string, ScanFilterStep>();
                            (scan.filterSteps || []).forEach(s => stepMap.set(s.gate, s));

                            return (
                                <tr key={scan.ticker} className={`border-b border-border-color/10 hover:bg-bg-light/5 ${isOpen ? 'bg-green-900/10' : ''}`}>
                                    <td className="sticky left-0 z-10 bg-bg-dark px-2 py-1 font-bold text-text-primary border-r border-border-color/20 whitespace-nowrap">
                                        {isOpen && <span className="mr-1">🟢</span>}
                                        {scan.ticker.replace('USDT', '')}
                                    </td>
                                    {ALL_GATES.map((g, i) => {
                                        const step = stepMap.get(g);
                                        if (!step) {
                                            return (
                                                <td key={g} className={`px-1.5 py-1 text-center text-text-secondary/30 ${i === LIGHT_GATES.length - 1 ? 'border-r-2 border-blue-500/30' : ''}`}>
                                                    —
                                                </td>
                                            );
                                        }
                                        const bg = step.skipped ? '' : step.passed ? 'bg-green-900/15' : 'bg-red-900/15';
                                        const icon = step.skipped ? '⏭️' : step.passed ? '✅' : '❌';
                                        return (
                                            <td key={g}
                                                className={`px-1.5 py-1 text-center ${bg} ${i === LIGHT_GATES.length - 1 ? 'border-r-2 border-blue-500/30' : ''}`}
                                                title={`${step.label}: ${step.detail || ''}\n값=${step.value} 임계=${step.threshold}`}
                                            >
                                                <div className="flex flex-col items-center gap-0">
                                                    <span className="text-[9px]">{icon}</span>
                                                    <span className={`text-[9px] ${step.passed ? 'text-green-400' : 'text-red-400'}`}>
                                                        {fmtVal(step.value)}
                                                    </span>
                                                </div>
                                            </td>
                                        );
                                    })}
                                    <td className="px-2 py-1 text-center whitespace-nowrap">
                                        {scan.status === 'passed' ? (
                                            <span className="px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 text-[9px]">통과</span>
                                        ) : (
                                            <span className="px-1.5 py-0.5 rounded bg-red-900/20 text-red-400 text-[9px]">{scan.gate}</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>}
        </div>
    );
};

// ── DNA 분석 결과 패널 ──

/** ★ 스캔 현황 모니터 — 종목별로 왜 진입/차단/대기 중인지 한눈에 표시 */
const ScanStatusMonitor: React.FC<{
    registryEntries: TickerParamEntry[];
    scanStatuses: ScanStatus[];
    waitingCandidates: WaitingCandidate[];
    openPositions: Trade[];
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}> = ({ registryEntries, scanStatuses, waitingCandidates, openPositions, collapsed = false, onToggleCollapse }) => {
    if (registryEntries.length === 0) return null;

    const statusEntries = registryEntries.map(entry => {
        const ticker = entry.ticker;
        const openPos = openPositions.find(p => p.ticker === ticker && p.status === 'open');
        const waiting = waitingCandidates.find(c => c.ticker === ticker);
        const scan = scanStatuses.find(s => s.ticker === ticker);
        const cooldown = waiting ? false : openPos ? false : true;

        let status: 'open' | 'waiting' | 'blocked' | 'idle';
        let icon: string;
        let color: string;
        let detail: string;

        if (openPos) {
            status = 'open';
            icon = '🟢';
            color = 'text-green-400';
            const pnl = openPos.pnl ?? 0;
            detail = `${openPos.direction} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
        } else if (waiting) {
            status = 'waiting';
            icon = '⏳';
            color = 'text-yellow-400';
            detail = `${waiting.direction} ${waiting.entryZones?.[0]?.type === 'IMMEDIATE' || waiting.entryZones?.[0]?.type === 'IGNITION_FAST' ? '즉시진입' : '존대기'}`;
        } else if (scan && scan.status === 'blocked') {
            status = 'blocked';
            icon = '🚫';
            color = 'text-red-400/80';
            // 게이트별 사용자 친화적 메시지
            const gateMsg: Record<string, string> = {
                volatility: '변동성 부족',
                direction: '방향 미감지',
                adx: 'ADX 약함',
                regime: '레짐 불일치',
                regime_stats: '레짐 수익 낮음',
                short_gate: 'Short 점수 낮음',
                rsi_slope: 'RSI 반대',
                session: '세션 시간대 밖',
                data: '데이터 부족',
            };
            detail = gateMsg[scan.gate || ''] || scan.detail || '차단';
        } else {
            status = 'idle';
            icon = '⬜';
            color = 'text-text-secondary/40';
            detail = '스캔 대기';
        }

        const allowedRegimeTags = entry.allowedRegimes?.map(r =>
            r === 'TRENDING' ? 'T' : r === 'RANGING' ? 'R' : 'V'
        ).join('') || 'TRV';

        return { ticker, status, icon, color, detail, allowedRegimeTags, scan };
    });

    const openCount = statusEntries.filter(e => e.status === 'open').length;
    const waitingCount = statusEntries.filter(e => e.status === 'waiting').length;
    const blockedCount = statusEntries.filter(e => e.status === 'blocked').length;

    return (
        <div className="bg-bg-dark border border-border-color rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-color/30 cursor-pointer select-none" onClick={onToggleCollapse}>
                <div className="flex items-center gap-2">
                    <span className="text-sm">📡</span>
                    <span className="text-xs font-bold text-text-primary">스캔 현황</span>
                    <span className="text-[10px] font-mono text-text-secondary">{registryEntries.length}종목</span>
                </div>
                <div className="flex items-center gap-2 text-[9px] font-mono">
                    {openCount > 0 && <span className="px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">🟢 {openCount}</span>}
                    {waitingCount > 0 && <span className="px-1.5 py-0.5 rounded bg-yellow-900/30 text-yellow-400">⏳ {waitingCount}</span>}
                    {blockedCount > 0 && <span className="px-1.5 py-0.5 rounded bg-red-900/20 text-red-400/70">🚫 {blockedCount}</span>}
                    <span className="text-text-secondary/50 ml-1">{collapsed ? '▶' : '▼'}</span>
                </div>
            </div>
            {!collapsed && <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1 p-2">
                {statusEntries.map(e => (
                    <div key={e.ticker}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] transition-colors ${
                            e.status === 'open' ? 'bg-green-900/20 border border-green-800/30' :
                            e.status === 'waiting' ? 'bg-yellow-900/15 border border-yellow-800/20' :
                            e.status === 'blocked' ? 'bg-red-900/10 border border-red-900/15' :
                            'bg-bg-light/5 border border-border-color/10'
                        }`}
                        title={`${e.ticker} | 허용레짐: ${e.allowedRegimeTags} | ${e.detail}${e.scan?.detail ? ` (${e.scan.detail})` : ''}`}
                    >
                        <span>{e.icon}</span>
                        <span className="font-mono font-bold text-text-primary truncate">{e.ticker.replace('USDT', '')}</span>
                        <span className={`font-mono truncate ${e.color}`}>{e.detail}</span>
                    </div>
                ))}
            </div>}
        </div>
    );
};

