

// components/LiveMonitorTable.tsx
import React from 'react';
import type { WaitingCandidate } from '../types';
import { ActivityIcon, ArrowUpIcon, ArrowDownIcon, RobotIcon, RocketIcon, EyeIcon, ClockIcon } from './Icons';

interface LiveMonitorTableProps {
    candidates: WaitingCandidate[];
    latestPrices: Record<string, number>;
    snipingTickers: string[]; // Currently executing loop
    analyzingTickers?: string[]; // Currently confirming with AI
    onDelegate?: (ticker: string) => void; // Manual override if needed
}

const PhaseBadge: React.FC<{ phase: string, timeframe?: string }> = ({ phase, timeframe }) => {
    let colorClass = 'bg-gray-700 text-gray-300 border-gray-600';
    let label = '판단중';

    if (phase === 'TREND_IMPULSE') {
        colorClass = 'bg-blue-600/20 text-blue-400 border-blue-500/50';
        label = '🌊 추세 폭발';
    } else if (phase === 'TREND_CORRECTION') {
        colorClass = 'bg-green-600/20 text-green-400 border-green-500/50';
        label = '📉 추세 조정';
    } else if (phase === 'RANGE_ACCUMULATION') {
        colorClass = 'bg-amber-600/20 text-amber-400 border-amber-500/50';
        label = '📦 박스권 (매집)';
    } else if (phase === 'RANGE_DISTRIBUTION') {
        colorClass = 'bg-purple-600/20 text-purple-400 border-purple-500/50';
        label = '📦 박스권 (분산)';
    } else if (phase === 'TRAP_HUNTING') {
        colorClass = 'bg-red-600/20 text-red-400 border-red-500/50 animate-pulse';
        label = '🪤 함정(Trap) 사냥';
    } else if (phase === 'SILENT_MELT_UP') {
        colorClass = 'bg-teal-600/20 text-teal-400 border-teal-500/50 animate-pulse';
        label = '👻 사일런트 (Melt-Up)';
    } else if (phase === 'VOLATILE_GRIND') {
        colorClass = 'bg-pink-600/20 text-pink-400 border-pink-500/50 animate-pulse';
        label = '🌪️ 와리가리 (Warigari)';
    } else if (phase === 'SIDEWAYS_STAGNATION') {
        colorClass = 'bg-gray-600/30 text-gray-400 border-gray-500/50';
        label = '💤 지루한 횡보';
    } else if (phase === 'CRAZY_VOLATILITY') {
        colorClass = 'bg-red-700/30 text-red-300 border-red-500/80 animate-pulse';
        label = '🎢 미친 변동성 (Chaos)';
    } else if (phase === 'TOP_FISHING_META') {
        colorClass = 'bg-purple-900/40 text-purple-300 border-purple-500/80 animate-pulse';
        label = '🎣 고점 메타 (Top Fishing)';
    }

    return (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 w-fit ${colorClass}`}>
            {timeframe && <span className="opacity-70 font-mono text-[9px] mr-1">[{timeframe}]</span>}
            {label}
        </span>
    );
};

const RewardBadge: React.FC<{ reward?: number }> = ({ reward }) => {
    if (reward === undefined) return null;
    
    let colorClass = 'bg-gray-700 text-gray-400 border-gray-600';
    
    if (reward >= 1.5) {
        colorClass = 'bg-green-500/20 text-green-400 border-green-500/50';
    } else if (reward >= 0.8) {
        colorClass = 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
    } else {
        colorClass = 'bg-red-500/20 text-red-400 border-red-500/50';
    }

    return (
        <span className={`text-[9px] font-mono px-1 py-0.5 rounded border ml-1 ${colorClass}`} title="Expected Reward % (Entry to Target)">
            Exp: {reward.toFixed(1)}%
        </span>
    );
};

const HitCountBadge: React.FC<{ count: number }> = ({ count }) => {
    if (count <= 0) return null;
    return (
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border ml-1 bg-purple-900/30 text-purple-300 border-purple-500/30 flex items-center gap-1" title="Accumulated Pattern Hits">
            🎯 {count}
        </span>
    );
};

const StrategyStack: React.FC<{ stack: string[], isPending: boolean }> = ({ stack, isPending }) => {
    // Dynamic stack rendering
    const visibleStack = [...stack];
    if (isPending) visibleStack.push('PENDING');

    const formatStep = (s: string) => {
        if (s === 'PENDING') return { label: '...', isLong: false, isShort: false };
        // Check if string contains "Long" or "Short"
        const isLong = s.toUpperCase().includes('LONG');
        const isShort = s.toUpperCase().includes('SHORT');
        
        let label = s;
        if (s.includes(' - ')) {
            label = s.split(' - ')[1]; // Extract strategy part e.g. "PULLBACK"
        }
        
        // Shorten label
        if (label.includes('PULLBACK')) label = 'PB';
        else if (label.includes('BREAKOUT')) label = 'BO';
        else if (label.includes('TRAP')) label = 'TRAP';
        else if (label.includes('FLOW')) label = 'FLOW';
        else if (label.includes('WICK')) label = 'WICK';
        else label = label.substring(0, 3);

        return { label, isLong, isShort };
    };

    return (
        <div className="flex flex-wrap items-center gap-1 mt-1 justify-end max-w-[200px]">
            {visibleStack.map((s, i) => {
                const { label, isLong, isShort } = formatStep(s);
                let stepClass = 'bg-bg-dark border-border-color text-text-secondary opacity-50';
                
                if (s === 'PENDING') {
                    stepClass = 'bg-amber-500/20 border-amber-500/50 text-amber-400 animate-pulse';
                } else {
                    const opacity = Math.min(1, 0.5 + (i / visibleStack.length) * 0.5);
                    if (isLong) stepClass = `bg-green-500/20 border-green-500/50 text-green-400 font-bold opacity-[${opacity}]`;
                    else if (isShort) stepClass = `bg-red-500/20 border-red-500/50 text-red-400 font-bold opacity-[${opacity}]`;
                    else stepClass = `bg-gray-500/20 border-gray-500/50 text-gray-300 font-bold opacity-[${opacity}]`;
                }

                return (
                    <div key={i} className="flex items-center">
                        <div className={`px-1.5 py-0.5 flex items-center justify-center text-[9px] rounded border ${stepClass}`} title={`Step ${i+1}: ${s}`}>
                            {label}
                        </div>
                        {i < visibleStack.length - 1 && <div className="w-1 h-0.5 bg-border-color/50 mx-0.5"></div>}
                    </div>
                );
            })}
        </div>
    );
};

const TimePredictionBadge: React.FC<{ duration?: string }> = ({ duration }) => {
    if (!duration) return null;
    return (
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border ml-1 bg-indigo-900/30 text-indigo-300 border-indigo-500/30 flex items-center gap-1" title="Expected Duration to Profit Target">
            <ClockIcon className="w-2.5 h-2.5" />
            {duration}
        </span>
    );
};

export const LiveMonitorTable: React.FC<LiveMonitorTableProps> = React.memo(({ 
    candidates, 
    latestPrices, 
    snipingTickers = [], 
    analyzingTickers = [],
    onDelegate 
}) => {
    
    if (candidates.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-bg-light/30 rounded-lg border border-border-color border-dashed">
                <div className="w-16 h-16 rounded-full bg-bg-dark flex items-center justify-center mb-4 shadow-inner">
                    <EyeIcon className="w-8 h-8 text-text-secondary opacity-50" />
                </div>
                <h3 className="text-sm font-bold text-text-primary mb-1">감시 중인 종목이 없습니다</h3>
                <p className="text-xs text-text-secondary">
                    AI가 시장을 스캔하여 유효한 추세와 타점을 찾고 있습니다.<br/>
                    잠시만 기다려주세요.
                </p>
            </div>
        );
    }

    return (
        <div className="bg-bg-light rounded-lg border border-border-color shadow-sm overflow-hidden h-full flex flex-col">
            <div className="px-4 py-3 border-b border-border-color flex justify-between items-center bg-bg-dark/50 shrink-0">
                <h3 className="text-sm font-bold flex items-center gap-2">
                    <ActivityIcon className="w-4 h-4 text-brand-primary animate-pulse" />
                    타점 감시 현황판 ({candidates.length}종목)
                </h3>
                <div className="flex items-center gap-2 text-[10px] text-text-secondary">
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-green-500"></div>대기중</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-brand-primary animate-pulse"></div>AI검증</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-red-500 animate-ping"></div>진입시도</span>
                </div>
            </div>
            
            <div className="overflow-auto custom-scrollbar flex-grow">
                <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-bg-dark z-10 shadow-sm">
                        <tr className="text-xs text-text-secondary border-b border-border-color">
                            <th className="px-4 py-2 font-semibold w-1/5">종목 / 전략</th>
                            <th className="px-4 py-2 font-semibold text-right w-1/5">현재가</th>
                            <th className="px-4 py-2 font-semibold text-center w-1/3">타점 시나리오 (Zones)</th>
                            <th className="px-4 py-2 font-semibold text-right w-1/6">상태 (Flow Chain)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {candidates.map((item) => {
                            const currentPrice = latestPrices[item.ticker] || 0;
                            const isLong = item.direction === 'Long';
                            const directionColor = isLong ? 'text-green-400' : 'text-red-400';
                            const directionLabel = isLong ? 'LONG' : 'SHORT';
                            
                            const isSniping = snipingTickers.includes(item.ticker);
                            const isConfirming = analyzingTickers.includes(`confirm_${item.ticker}`);
                            
                            // [REMOVED] Sweep Watch 상태머신 제거됨
                            const isSweepWatch = false;
                            const sweepElapsed = 0;

                            let anyZoneMatched = false;

                            const isPendingRegen = item.isPendingReanalysis;
                            const hitCount = item.hitCount || 0;
                            
                            // [MOD] Get the primary strategy type for display
                            const activeStrategy = item.entryZones.length > 0 ? item.entryZones[0].type : 'ANALYZING...';
                            
                            // [MOD] Extract timeframe from waiting candidate extended interface (need to cast or check if available)
                            // Since we updated schema but type might need loose typing here
                            const timeframe = (item as any).primaryTimeframe || '1H'; 

                            return (
                                <tr key={item.ticker} className={`border-b border-border-color/10 hover:bg-bg-dark/30 transition-colors text-xs`}>
                                    {/* 1. Ticker & Phase + Strategy */}
                                    <td className="px-4 py-3 align-top">
                                        <div className="font-bold text-text-primary text-sm flex items-center gap-2 flex-wrap mb-1">
                                            {item.ticker}
                                            <HitCountBadge count={hitCount} />
                                            <RewardBadge reward={item.expectedReward} />
                                            <TimePredictionBadge duration={item.predictedDuration} />
                                        </div>
                                        {/* [MOD] Combined Direction + Strategy Label */}
                                        <div className="flex items-center gap-1 mb-1.5">
                                            <span className={`text-[10px] font-black px-1.5 py-0.5 rounded border ${isLong ? 'bg-green-900/30 text-green-400 border-green-500/30' : 'bg-red-900/30 text-red-400 border-red-500/30'}`}>
                                                {directionLabel}
                                            </span>
                                            <span className="text-[10px] font-bold text-text-secondary px-1.5 py-0.5 bg-bg-dark rounded border border-border-color/50">
                                                {activeStrategy}
                                            </span>
                                        </div>
                                        <div>
                                            <PhaseBadge phase={item.marketPhase || 'UNCERTAIN'} timeframe={timeframe} />
                                        </div>
                                    </td>

                                    {/* 2. Current Price */}
                                    <td className="px-4 py-3 text-right align-top">
                                        <div className="font-mono font-bold text-text-primary text-sm">
                                            {currentPrice > 0 ? currentPrice.toFixed(4) : <span className="animate-pulse">...</span>}
                                        </div>
                                        <div className={`flex items-center justify-end gap-1 text-[10px] font-bold mt-1 ${directionColor}`}>
                                            {isLong ? <ArrowUpIcon className="w-3 h-3"/> : <ArrowDownIcon className="w-3 h-3"/>}
                                            {item.direction.toUpperCase()}
                                        </div>
                                    </td>

                                    {/* 3. Target Zones (Multi-Zone Display) */}
                                    <td className="px-2 py-2 align-top">
                                        <div className="flex flex-col gap-1.5">
                                            {item.entryZones.length === 0 && isPendingRegen ? (
                                                <div className="text-center text-text-secondary animate-pulse italic text-[10px] bg-bg-dark/30 p-1 rounded">
                                                    AI가 다음 시나리오(Next Zone)를 계산 중입니다...
                                                </div>
                                            ) : item.entryZones.map((zone, idx) => {
                                                const zoneMid = (zone.minPrice + zone.maxPrice) / 2;
                                                const dist = currentPrice > 0 ? ((currentPrice - zoneMid) / currentPrice) * 100 : 0;
                                                const absDist = Math.abs(dist);
                                                const isInZone = currentPrice >= zone.minPrice && currentPrice <= zone.maxPrice;
                                                if (isInZone) anyZoneMatched = true;

                                                let badgeColor = 'bg-blue-500/20 text-blue-400 border-blue-500/30';
                                                let zoneLabel = 'PB';
                                                
                                                if (zone.type === 'BREAKOUT') {
                                                    badgeColor = 'bg-amber-500/20 text-amber-400 border-amber-500/30';
                                                    zoneLabel = 'BO';
                                                } else if (zone.type === 'TRAP_REVERSAL') {
                                                    badgeColor = 'bg-red-500/20 text-red-400 border-red-500/30';
                                                    zoneLabel = 'TRAP';
                                                } else if (zone.type === 'TOP_REVERSAL') {
                                                    badgeColor = 'bg-purple-900/40 text-purple-300 border-purple-500/50';
                                                    zoneLabel = 'TOP';
                                                }
                                                
                                                // [FIX] Visual Feedback for Sweep Watch Status
                                                let borderStyle = isInZone ? 'border-green-500/50 shadow-[0_0_5px_rgba(34,197,94,0.3)]' : 'border-border-color/50';
                                                if (isSweepWatch) {
                                                    borderStyle = 'border-orange-500/50 shadow-[0_0_5px_rgba(249,115,22,0.3)] bg-orange-900/10';
                                                }

                                                return (
                                                    <div key={idx} className={`flex items-center justify-between bg-bg-dark px-2 py-1.5 rounded border ${borderStyle}`}>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${badgeColor}`}>
                                                                {zoneLabel}
                                                            </span>
                                                            <span className="font-mono text-[10px] text-text-secondary">
                                                                {zone.minPrice.toFixed(4)}~{zone.maxPrice.toFixed(4)}
                                                            </span>
                                                        </div>
                                                        <span className={`text-[9px] font-mono font-bold ${isSweepWatch ? 'text-orange-400 animate-pulse' : isInZone ? 'text-green-400 animate-pulse' : 'text-text-secondary/60'}`}>
                                                            {isSweepWatch ? "SWEEP" : isInZone ? "HIT!" : `${absDist.toFixed(2)}%`}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </td>

                                    {/* 4. Status / Action */}
                                    <td className="px-4 py-3 text-right align-top">
                                        <div className="h-full flex flex-col justify-center items-end gap-1">
                                            {isSniping ? (
                                                <div className="flex items-center gap-1 text-red-400 font-bold animate-pulse">
                                                    <RocketIcon className="w-3.5 h-3.5" />
                                                    <span>SNIPING</span>
                                                </div>
                                            ) : isConfirming ? (
                                                <div className="flex items-center gap-1 text-brand-primary font-bold animate-pulse">
                                                    <RobotIcon className="w-3.5 h-3.5" />
                                                    <span>AI 검증</span>
                                                </div>
                                            ) : isSweepWatch ? (
                                                <div className="flex flex-col items-end">
                                                    <div className="flex items-center gap-1 text-orange-400 font-bold animate-pulse">
                                                        <span className="relative flex h-2 w-2">
                                                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                                                          <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
                                                        </span>
                                                        <span>SWEEP ({sweepElapsed}s)</span>
                                                    </div>
                                                    <span className="text-[9px] text-orange-300/70">Watching...</span>
                                                </div>
                                            ) : anyZoneMatched ? (
                                                <div className="flex flex-col items-end">
                                                    <div className="flex items-center gap-1 text-amber-400 font-bold">
                                                        <span className="relative flex h-2 w-2">
                                                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                                                        </span>
                                                        <span>타점 확인</span>
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-text-secondary text-[10px]">감시 중</span>
                                            )}
                                            
                                            {/* Strategy status */}
                                            <StrategyStack stack={[]} isPending={isPendingRegen} />
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <style>{`
                .custom-scrollbar::-webkit-scrollbar { width: 4px; } 
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #374151; border-radius: 2px; }
            `}</style>
        </div>
    );
});