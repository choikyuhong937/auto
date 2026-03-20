import React, { useState, useMemo, useEffect } from 'react';
import type { Trade, TradeAnalytics, PostTradeInsights } from '../types';
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, ShieldCheckIcon } from './Icons';

// =============================================
// Props
// =============================================
interface TradeHistoryProps {
    trades: Trade[];
    precisions: Record<string, number>;
    onViewJournal: (tradeId: string) => void;
}

// =============================================
// Constants
// =============================================
const REGIME_COLORS: Record<string, string> = {
    TREND_IMPULSE: 'bg-blue-500',
    TREND_CONTINUATION: 'bg-blue-400',
    TREND_EXHAUSTION: 'bg-amber-500',
    RANGE_ACCUMULATION: 'bg-green-400',
    RANGE_DISTRIBUTION: 'bg-red-400',
    BREAKOUT_EXPANSION: 'bg-purple-500',
    VOLATILITY_SQUEEZE: 'bg-yellow-500',
    VOLATILITY_EXPLOSION: 'bg-red-600',
    LIQUIDATION_CASCADE: 'bg-red-700',
    MEAN_REVERSION_ZONE: 'bg-teal-500',
    CHOPPY_NOISE: 'bg-gray-500',
    WEEKEND_DRIFT: 'bg-gray-400',
};

// =============================================
// Utility Functions
// =============================================
const formatDuration = (start: number, end?: number): string => {
    if (!start) return '--';
    const endTime = end || Date.now();
    const ms = endTime - start;
    if (ms < 0) return '0s';

    const totalMinutes = ms / 60000;
    if (totalMinutes < 1) return `${(ms / 1000).toFixed(0)}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = Math.floor(totalMinutes % 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

const safe = (val: number | undefined | null, decimals: number = 2, fallback: string = '--'): string => {
    if (val === undefined || val === null || isNaN(val)) return fallback;
    return val.toFixed(decimals);
};

const pnlColor = (val: number | undefined | null): string => {
    if (val === undefined || val === null) return 'text-gray-400';
    if (val > 0) return 'text-green-400';
    if (val < 0) return 'text-red-400';
    return 'text-gray-400';
};

// =============================================
// Sub-component: RegimeBadge
// =============================================
const RegimeBadge: React.FC<{ regime: string | undefined | null; size?: 'sm' | 'md' }> = ({ regime, size = 'sm' }) => {
    if (!regime) return <span className="text-gray-500 text-xs">N/A</span>;
    const bgColor = REGIME_COLORS[regime] || 'bg-gray-600';
    const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1';
    const label = regime.replace(/_/g, ' ');
    return (
        <span className={`${bgColor} text-white ${sizeClass} rounded font-semibold whitespace-nowrap`}>
            {label}
        </span>
    );
};

// =============================================
// Sub-component: ConfidenceBar
// =============================================
const ConfidenceBar: React.FC<{ value: number | undefined | null; label?: string }> = ({ value, label }) => {
    const v = value ?? 0;
    const barColor = v >= 70 ? 'bg-green-500' : v >= 40 ? 'bg-amber-500' : 'bg-red-500';
    return (
        <div className="flex items-center gap-2 w-full">
            {label && <span className="text-[10px] text-gray-400 min-w-[60px]">{label}</span>}
            <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                    className={`h-full ${barColor} rounded-full transition-all duration-300`}
                    style={{ width: `${Math.min(Math.max(v, 0), 100)}%` }}
                />
            </div>
            <span className="text-[10px] font-mono text-gray-300 min-w-[32px] text-right">
                {value !== undefined && value !== null ? `${v.toFixed(0)}%` : '--'}
            </span>
        </div>
    );
};

// =============================================
// Sub-component: MfeMaeBar
// =============================================
const MfeMaeBar: React.FC<{ mfe: number | undefined; mae: number | undefined; compact?: boolean }> = ({ mfe, mae, compact = false }) => {
    const mfeVal = mfe ?? 0;
    const maeVal = mae ?? 0;
    const maxExtent = Math.max(Math.abs(mfeVal), Math.abs(maeVal), 0.01);
    const mfeWidth = (Math.abs(mfeVal) / maxExtent) * 100;
    const maeWidth = (Math.abs(maeVal) / maxExtent) * 100;

    if (compact) {
        return (
            <div className="flex items-center gap-0.5 w-full h-3">
                {/* MAE (red, left) */}
                <div className="flex-1 flex justify-end">
                    <div
                        className="h-2 bg-red-500/70 rounded-l"
                        style={{ width: `${maeWidth}%`, minWidth: maeVal > 0 ? '2px' : '0px' }}
                        title={`MAE: -${safe(maeVal)}%`}
                    />
                </div>
                <div className="w-px h-3 bg-gray-500" />
                {/* MFE (green, right) */}
                <div className="flex-1 flex justify-start">
                    <div
                        className="h-2 bg-green-500/70 rounded-r"
                        style={{ width: `${mfeWidth}%`, minWidth: mfeVal > 0 ? '2px' : '0px' }}
                        title={`MFE: +${safe(mfeVal)}%`}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-green-400 w-8">MFE</span>
                <div className="flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-green-500/80 rounded-full"
                        style={{ width: `${mfeWidth}%` }}
                    />
                </div>
                <span className="text-[10px] font-mono text-green-400 w-12 text-right">+{safe(mfeVal)}%</span>
            </div>
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-red-400 w-8">MAE</span>
                <div className="flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-red-500/80 rounded-full"
                        style={{ width: `${maeWidth}%` }}
                    />
                </div>
                <span className="text-[10px] font-mono text-red-400 w-12 text-right">-{safe(maeVal)}%</span>
            </div>
        </div>
    );
};

// =============================================
// Sub-component: PricePathSparkline
// =============================================
const PricePathSparkline: React.FC<{ data: number[] | undefined; width?: number; height?: number }> = ({
    data,
    width = 200,
    height = 48,
}) => {
    if (!data || data.length < 2) {
        return (
            <div
                className="flex items-center justify-center bg-gray-800/50 rounded text-gray-500 text-[10px]"
                style={{ width, height }}
            >
                No path data
            </div>
        );
    }

    const padding = 2;
    const chartW = width - padding * 2;
    const chartH = height - padding * 2;
    const minVal = Math.min(...data);
    const maxVal = Math.max(...data);
    const range = maxVal - minVal || 1;

    const points = data.map((v, i) => {
        const x = padding + (i / (data.length - 1)) * chartW;
        const y = padding + chartH - ((v - minVal) / range) * chartH;
        return `${x},${y}`;
    });

    const zeroY = padding + chartH - ((0 - minVal) / range) * chartH;
    const lastVal = data[data.length - 1];
    const lineColor = lastVal >= 0 ? '#4ade80' : '#f87171';
    const fillColor = lastVal >= 0 ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)';

    const fillPoints = [
        `${padding},${zeroY}`,
        ...points,
        `${padding + chartW},${zeroY}`,
    ].join(' ');

    return (
        <svg width={width} height={height} className="block">
            {/* Zero line */}
            <line
                x1={padding} y1={zeroY} x2={padding + chartW} y2={zeroY}
                stroke="#4b5563" strokeWidth={0.5} strokeDasharray="3,3"
            />
            {/* Fill area */}
            <polygon points={fillPoints} fill={fillColor} />
            {/* Price line */}
            <polyline
                points={points.join(' ')}
                fill="none"
                stroke={lineColor}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    );
};

// =============================================
// Sub-component: ExitTriggerBadge
// =============================================
const ExitTriggerBadge: React.FC<{ trigger: string | undefined; trade: Trade }> = ({ trigger, trade }) => {
    if (!trigger && !trade.reasonForExit) {
        if (trade.status !== 'closed') return <span className="text-gray-400 text-[10px]">--</span>;
        return <span className="text-gray-400 text-[10px]">N/A</span>;
    }

    const raw = (trigger || trade.reasonForExit || '').toLowerCase();

    if (raw.includes('tp') || raw.includes('target_hit')) {
        return <span className="bg-green-500/20 text-green-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">TP Hit</span>;
    }
    if (raw.includes('sl') || raw.includes('stop_loss')) {
        return <span className="bg-red-500/20 text-red-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">SL Hit</span>;
    }
    if (raw.includes('ai') || raw.includes('ai_close')) {
        return <span className="bg-blue-500/20 text-blue-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">AI Exit</span>;
    }
    if (raw.includes('timeout') || raw.includes('time_out')) {
        return <span className="bg-gray-500/20 text-gray-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">Time Out</span>;
    }
    if (raw.includes('regime') || raw.includes('regime_shift')) {
        return <span className="bg-purple-500/20 text-purple-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">Regime Shift</span>;
    }
    if (raw.includes('counter') || raw.includes('counter_trend')) {
        return <span className="bg-orange-500/20 text-orange-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">Counter-Trend</span>;
    }
    if (raw.includes('liquidation')) {
        return <span className="bg-red-700/30 text-red-500 text-[10px] px-1.5 py-0.5 rounded font-bold">Liquidated</span>;
    }
    if (raw.includes('opportunity_switch')) {
        return <span className="bg-purple-500/20 text-purple-300 text-[10px] px-1.5 py-0.5 rounded font-semibold">Switch</span>;
    }
    if (raw.includes('session_end')) {
        return <span className="bg-gray-500/20 text-gray-300 text-[10px] px-1.5 py-0.5 rounded font-semibold">Session End</span>;
    }

    // Fallback: show the raw trigger text
    const displayText = trigger || trade.reasonForExit || 'Unknown';
    return <span className="bg-gray-600/30 text-gray-300 text-[10px] px-1.5 py-0.5 rounded">{displayText}</span>;
};

// =============================================
// Sub-component: Panel A - Entry Quality
// =============================================
const PanelEntryQuality: React.FC<{ trade: Trade; analytics: TradeAnalytics | undefined }> = ({ trade, analytics }) => {
    const snap = trade.entrySnapshot;
    const mtfStatus = analytics?.mtfDirection;
    const mtfColor = mtfStatus === 'ALIGNED' ? 'text-green-400' : mtfStatus === 'CONFLICTED' ? 'text-red-400' : 'text-gray-400';

    return (
        <div className="bg-gray-800/60 rounded-lg p-3 space-y-3">
            <h5 className="text-xs font-bold text-gray-200 border-b border-gray-700 pb-1">
                진입 품질 (Entry Quality)
            </h5>

            {/* Entry Regime */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Entry Regime</span>
                <RegimeBadge regime={analytics?.entryRegime || snap?.regime} />
            </div>

            {/* Entry Confidence */}
            <ConfidenceBar value={analytics?.entryConfidence ?? snap?.signalConfidence} label="Confidence" />

            {/* Entry Indicators */}
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">RSI</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(snap?.rsi, 1)}</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">ADX</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(snap?.adx, 1)}</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Hurst</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(snap?.hurst, 3)}</div>
                </div>
            </div>

            {/* MTF Confluence */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">MTF Confluence</span>
                <span className={`text-[10px] font-bold ${mtfColor}`}>
                    {mtfStatus || 'N/A'}
                </span>
            </div>

            {/* Entry Method & Strategy */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <div className="text-[9px] text-gray-500">Entry Method</div>
                    <div className="text-[10px] font-mono text-gray-200">{analytics?.entryMethod || 'N/A'}</div>
                </div>
                <div>
                    <div className="text-[9px] text-gray-500">Strategy</div>
                    <div className="text-[10px] font-mono text-gray-200">{analytics?.entryStrategy || 'N/A'}</div>
                </div>
            </div>

            {/* Volatility & Volume */}
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">ATR</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.atrAtEntry, 4)}</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Vol %ile</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.volatilityPercentile, 0)}</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Vol Ratio</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.volumeAtEntry, 2)}x</div>
                </div>
            </div>

            {/* Inflection & Regime Confidence */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <ConfidenceBar value={analytics?.inflectionScore} label="Inflection" />
                </div>
                <div>
                    <ConfidenceBar value={analytics?.entryRegimeConfidence} label="Regime" />
                </div>
            </div>
        </div>
    );
};

// =============================================
// Sub-component: Panel B - Trade Execution
// =============================================
const PanelTradeExecution: React.FC<{ trade: Trade; analytics: TradeAnalytics | undefined; precision: number }> = ({ trade, analytics, precision }) => {
    const exitEfficiency = analytics?.exitEfficiency;
    const effColor = (exitEfficiency ?? 0) >= 80 ? 'text-green-400' : (exitEfficiency ?? 0) >= 50 ? 'text-amber-400' : 'text-red-400';

    return (
        <div className="bg-gray-800/60 rounded-lg p-3 space-y-3">
            <h5 className="text-xs font-bold text-gray-200 border-b border-gray-700 pb-1">
                거래 실행 (Trade Execution)
            </h5>

            {/* Price Path Sparkline */}
            <div className="flex justify-center">
                <PricePathSparkline data={analytics?.pricePathSummary} width={220} height={52} />
            </div>

            {/* MFE / MAE */}
            <MfeMaeBar mfe={analytics?.maxFavorableExcursion} mae={analytics?.maxAdverseExcursion} />

            {/* Exit Efficiency */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Exit Efficiency</span>
                <span className={`text-[11px] font-mono font-bold ${effColor}`}>
                    {exitEfficiency !== undefined && exitEfficiency !== null ? `${safe(exitEfficiency, 1)}%` : '--'}
                </span>
            </div>

            {/* SL Tighten Count */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">SL Tighten Count</span>
                <span className="text-[11px] font-mono text-gray-200">{analytics?.slTightenCount ?? '--'}</span>
            </div>

            {/* Expected vs Actual RR */}
            <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Expected RR</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.expectedRR, 2)}x</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Actual RR</div>
                    <div className={`text-[11px] font-mono ${pnlColor(analytics?.riskRewardRatio)}`}>
                        {safe(analytics?.riskRewardRatio, 2)}x
                    </div>
                </div>
            </div>

            {/* SL Distance Entry vs Exit */}
            <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">SL Dist (Entry)</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.slDistanceAtEntry)}%</div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">SL Dist (Exit)</div>
                    <div className="text-[11px] font-mono text-gray-200">{safe(analytics?.slDistanceAtExit)}%</div>
                </div>
            </div>
        </div>
    );
};

// =============================================
// Sub-component: Panel C - Strategy & Cost
// =============================================
const PanelStrategyCost: React.FC<{ trade: Trade; analytics: TradeAnalytics | undefined }> = ({ trade, analytics }) => {
    const goalLabel = (g: string | undefined) => {
        if (!g) return 'N/A';
        const map: Record<string, string> = {
            'TREND_FOLLOWING': '추세추종', 'MEAN_REVERSION': '평균회귀',
            'SCALPING': '스캘핑', 'BREAKOUT': '돌파', 'TRAP_HUNTING': '함정사냥',
        };
        return map[g] || g;
    };

    const riskColor = (r: string | undefined) => {
        if (!r) return 'text-gray-400';
        if (r === 'EXTREME') return 'text-red-500';
        if (r === 'HIGH') return 'text-red-400';
        if (r === 'MEDIUM') return 'text-amber-400';
        return 'text-green-400';
    };

    const totalFees = analytics?.totalFees ?? trade.totalFee ?? 0;
    const grossPnl = trade.pnl !== undefined && trade.pnl !== null ? trade.pnl + totalFees : 0;
    const netPnl = trade.pnl ?? 0;

    return (
        <div className="bg-gray-800/60 rounded-lg p-3 space-y-3">
            <h5 className="text-xs font-bold text-gray-200 border-b border-gray-700 pb-1">
                전략 & 비용 (Strategy & Cost)
            </h5>

            {/* Strategy Name & Goal */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <div className="text-[9px] text-gray-500">전략명</div>
                    <div className="text-[10px] font-mono text-cyan-300 truncate" title={analytics?.strategyName}>
                        {analytics?.strategyName || trade.marketPhase || 'N/A'}
                    </div>
                </div>
                <div>
                    <div className="text-[9px] text-gray-500">목표</div>
                    <div className="text-[10px] font-mono text-gray-200">
                        {goalLabel(analytics?.tradingGoal || trade.goal)}
                    </div>
                </div>
            </div>

            {/* Trade Style & Risk */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <div className="text-[9px] text-gray-500">거래 스타일</div>
                    <div className="text-[10px] font-mono text-gray-200">
                        {analytics?.tradeStyle || trade.tradeStyle || 'N/A'}
                    </div>
                </div>
                <div>
                    <div className="text-[9px] text-gray-500">리스크</div>
                    <div className={`text-[10px] font-mono font-bold ${riskColor(analytics?.riskLevel)}`}>
                        {analytics?.riskLevel || 'N/A'}
                    </div>
                </div>
            </div>

            {/* Position Sizing Parameters */}
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">투입 비율</div>
                    <div className="text-[11px] font-mono text-gray-200">
                        {analytics?.positionSizePercent != null ? `${safe(analytics.positionSizePercent, 1)}%` : '--'}
                    </div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">예상 승률</div>
                    <div className="text-[11px] font-mono text-gray-200">
                        {analytics?.expectedWinRate != null ? `${(analytics.expectedWinRate * 100).toFixed(1)}%` : '--'}
                    </div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">Kelly</div>
                    <div className={`text-[11px] font-mono ${analytics?.kellyFraction != null && analytics.kellyFraction <= 0 ? 'text-red-400' : 'text-gray-200'}`}>
                        {analytics?.kellyFraction != null ? `${(analytics.kellyFraction * 100).toFixed(1)}%` : '--'}
                    </div>
                </div>
            </div>

            {/* Size Multipliers */}
            <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">MTF 보정</div>
                    <div className="text-[11px] font-mono text-gray-200">
                        ×{safe(analytics?.mtfMultiplier, 2) || '--'}
                    </div>
                </div>
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">레짐 보정</div>
                    <div className="text-[11px] font-mono text-gray-200">
                        ×{safe(analytics?.regimeSizeMultiplier, 2) || '--'}
                    </div>
                </div>
            </div>

            {/* Fee Breakdown */}
            <div className="bg-gray-900/50 rounded p-2 space-y-1.5 border border-gray-700/50">
                <div className="text-[10px] text-amber-400 font-bold">수수료 상세</div>
                <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div className="text-center">
                        <div className="text-gray-500">진입</div>
                        <div className="font-mono text-gray-300">{safe(analytics?.entryFee ?? trade.totalFee, 4)}</div>
                    </div>
                    <div className="text-center">
                        <div className="text-gray-500">청산</div>
                        <div className="font-mono text-gray-300">{safe(analytics?.exitFee, 4)}</div>
                    </div>
                    <div className="text-center">
                        <div className="text-gray-500">합계</div>
                        <div className="font-mono text-amber-300 font-bold">{safe(totalFees, 4)}</div>
                    </div>
                </div>
                {/* Fee Impact */}
                {analytics?.feeImpactPercent !== undefined && analytics.feeImpactPercent > 0 && (
                    <div className="flex items-center justify-between pt-1 border-t border-gray-700/30">
                        <span className="text-[9px] text-gray-500">수수료 영향</span>
                        <span className={`text-[10px] font-mono font-bold ${analytics.feeImpactPercent > 50 ? 'text-red-400' : analytics.feeImpactPercent > 20 ? 'text-amber-400' : 'text-green-400'}`}>
                            {safe(analytics.feeImpactPercent, 1)}% of Gross
                        </span>
                    </div>
                )}
                {/* Gross → Net breakdown */}
                {trade.status === 'closed' && (
                    <div className="flex items-center justify-between pt-1 border-t border-gray-700/30">
                        <span className="text-[9px] text-gray-500">Gross→Net</span>
                        <span className="text-[10px] font-mono text-gray-300">
                            <span className={pnlColor(grossPnl)}>{grossPnl >= 0 ? '+' : ''}{safe(grossPnl, 2)}</span>
                            <span className="text-gray-600 mx-0.5">→</span>
                            <span className={`font-bold ${pnlColor(netPnl)}`}>{netPnl >= 0 ? '+' : ''}{safe(netPnl, 2)}</span>
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
};

// =============================================
// Sub-component: Panel D - Post-Trade Analysis
// =============================================
const PanelPostTrade: React.FC<{ trade: Trade; analytics: TradeAnalytics | undefined }> = ({ trade, analytics }) => {
    const insights = trade.postTradeInsights as PostTradeInsights | undefined;

    const PriceChangeArrow: React.FC<{ label: string; value: number | undefined }> = ({ label, value }) => {
        if (value === undefined || value === null) {
            return (
                <div className="bg-gray-900/50 rounded p-1.5 text-center">
                    <div className="text-[9px] text-gray-500">{label}</div>
                    <div className="text-[11px] font-mono text-gray-500">--</div>
                </div>
            );
        }
        const color = value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-gray-400';
        const arrow = value > 0 ? '\u2191' : value < 0 ? '\u2193' : '\u2192';
        return (
            <div className="bg-gray-900/50 rounded p-1.5 text-center">
                <div className="text-[9px] text-gray-500">{label}</div>
                <div className={`text-[11px] font-mono font-bold ${color}`}>
                    {arrow} {safe(value)}%
                </div>
            </div>
        );
    };

    const sessionBadge = (session: string | undefined) => {
        if (!session) return <span className="text-gray-500 text-[10px]">N/A</span>;
        const sessionColors: Record<string, string> = {
            ASIA: 'bg-yellow-600/20 text-yellow-400',
            EUROPE: 'bg-blue-600/20 text-blue-400',
            US: 'bg-green-600/20 text-green-400',
            OVERLAP_EU_US: 'bg-purple-600/20 text-purple-400',
            OVERLAP_ASIA_EU: 'bg-teal-600/20 text-teal-400',
            WEEKEND: 'bg-gray-600/20 text-gray-400',
        };
        const cls = sessionColors[session] || 'bg-gray-600/20 text-gray-300';
        return <span className={`${cls} text-[10px] px-1.5 py-0.5 rounded font-semibold`}>{session}</span>;
    };

    return (
        <div className="bg-gray-800/60 rounded-lg p-3 space-y-3">
            <h5 className="text-xs font-bold text-gray-200 border-b border-gray-700 pb-1">
                사후 분석 (Post-Trade)
            </h5>

            {/* Post-Exit Price Changes */}
            <div className="grid grid-cols-3 gap-2">
                <PriceChangeArrow label="5min" value={analytics?.priceAfter5min} />
                <PriceChangeArrow label="15min" value={analytics?.priceAfter15min} />
                <PriceChangeArrow label="1hr" value={analytics?.priceAfter1hr} />
            </div>

            {/* Was Exit Premature */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Premature Exit?</span>
                {analytics?.wasExitPremature !== undefined ? (
                    <span className={`text-[10px] font-bold ${analytics.wasExitPremature ? 'text-amber-400' : 'text-green-400'}`}>
                        {analytics.wasExitPremature ? 'YES - Could have held longer' : 'NO - Good timing'}
                    </span>
                ) : (
                    <span className="text-[10px] text-gray-500">--</span>
                )}
            </div>

            {/* Regime Change */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-gray-400">Regime:</span>
                <RegimeBadge regime={analytics?.entryRegime} size="sm" />
                <span className="text-gray-500 text-xs">{'\u2192'}</span>
                <RegimeBadge regime={analytics?.exitRegime} size="sm" />
            </div>

            {/* AI Post-Trade Insights */}
            {insights && (
                <div className="bg-gray-900/50 rounded p-2 space-y-1 border border-gray-700/50">
                    <div className="text-[10px] text-cyan-400 font-bold">AI Insights</div>
                    <p className="text-[10px] text-gray-300 italic leading-relaxed">
                        &quot;{insights.mainTakeaway}&quot;
                    </p>
                    {insights.suggestionForNextTime && (
                        <p className="text-[10px] text-gray-400">
                            Tip: {insights.suggestionForNextTime}
                        </p>
                    )}
                </div>
            )}

            {/* Exit Trigger Detail */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Exit Trigger</span>
                <span className="text-[10px] font-mono text-gray-200">{analytics?.exitTrigger || trade.reasonForExit || 'N/A'}</span>
            </div>

            {/* Market Session */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Market Session</span>
                {sessionBadge(analytics?.marketSession)}
            </div>
        </div>
    );
};

// =============================================
// Main Trade Row Component
// =============================================
const TradeRow: React.FC<{
    trade: Trade;
    precision: number;
    onViewJournal: (tradeId: string) => void;
}> = ({ trade, precision, onViewJournal }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    const isOpen = trade.status === 'open' || trade.status === 'pending_entry';
    const isMissed = trade.reasonForExit === 'entry_missed';
    const analytics = trade.analytics;

    // PnL
    const pnlDollar = isOpen ? (trade.unrealizedPnl ?? 0) : (trade.pnl ?? 0);
    const pnlPercent = (() => {
        if (trade.initialMargin && trade.initialMargin > 0) {
            return (pnlDollar / trade.initialMargin) * 100;
        }
        return 0;
    })();

    // Prices
    const entryPrice = trade.entryPrice;
    const exitPrice = trade.exitPrice ?? trade.currentPrice;

    // Duration with live updates for open trades
    const startTime = trade.localStartTime || trade.openTimestamp;
    const [duration, setDuration] = useState(() => {
        if (trade.status === 'open') return formatDuration(startTime);
        if (trade.status === 'closed') return formatDuration(startTime, trade.closeTimestamp);
        return '--';
    });

    useEffect(() => {
        let interval: number | undefined;
        if (trade.status === 'open') {
            interval = window.setInterval(() => {
                setDuration(formatDuration(startTime));
            }, 1000);
        } else {
            setDuration(formatDuration(startTime, trade.closeTimestamp));
        }
        return () => { if (interval) window.clearInterval(interval); };
    }, [trade.status, startTime, trade.closeTimestamp]);

    // Direction styling
    const dirColor = trade.direction === 'Long' ? 'text-green-400' : 'text-red-400';
    const dirBg = trade.direction === 'Long' ? 'bg-green-500/20' : 'bg-red-500/20';

    return (
        <div className={`border-b border-gray-700/40 ${isMissed ? 'opacity-40' : ''}`}>
            {/* ===== MAIN ROW (8 columns) ===== */}
            <div
                className={`grid grid-cols-[1.2fr_1.4fr_0.8fr_0.7fr_0.7fr_1fr_0.9fr_0.4fr] gap-1 text-xs py-2 px-1 items-center ${!isMissed ? 'cursor-pointer hover:bg-gray-800/40 transition-colors duration-150' : ''}`}
                onClick={() => !isMissed && setIsExpanded(!isExpanded)}
            >
                {/* Col 1: Ticker / Direction / Leverage */}
                <div className="flex flex-col gap-0.5">
                    <div className="font-semibold text-gray-100 flex items-center gap-1">
                        {trade.ticker}
                        {trade.wasReversed && (
                            <span className="text-[8px] bg-purple-900/50 text-purple-300 px-1 rounded border border-purple-500/40">REV</span>
                        )}
                        {trade.deploymentMode === 'SCOUT' && (
                            <span className="text-[8px] bg-blue-900/50 text-blue-300 px-1 rounded">S</span>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        <span className={`${dirBg} ${dirColor} text-[10px] px-1 py-px rounded font-bold flex items-center gap-0.5`}>
                            {trade.direction === 'Long' ? <ArrowUpIcon className="w-2.5 h-2.5" /> : <ArrowDownIcon className="w-2.5 h-2.5" />}
                            {trade.direction}
                        </span>
                        <span className="text-[10px] text-gray-500">{trade.leverage}x</span>
                    </div>
                </div>

                {/* Col 2: Entry -> Exit Price */}
                <div className="font-mono text-[11px] text-gray-300">
                    <span>{entryPrice ? entryPrice.toFixed(precision) : '--'}</span>
                    <span className="text-gray-600 mx-0.5">{'\u2192'}</span>
                    <span className={isOpen ? 'text-amber-300' : 'text-gray-300'}>
                        {exitPrice ? exitPrice.toFixed(precision) : '--'}
                    </span>
                    {isOpen && <span className="text-amber-400 text-[8px] ml-0.5">LIVE</span>}
                </div>

                {/* Col 3: PnL ($) + Fee */}
                <div className="text-right">
                    <div className={`font-mono font-bold text-[11px] ${pnlColor(pnlDollar)}`}>
                        {isMissed ? '--' : `${pnlDollar >= 0 ? '+' : ''}${safe(pnlDollar)}`}
                    </div>
                    {!isMissed && (trade.totalFee ?? 0) > 0 && (
                        <div className="text-[8px] font-mono text-amber-500/70">
                            fee: {safe(trade.totalFee, 3)}
                        </div>
                    )}
                </div>

                {/* Col 4: PnL (%) */}
                <div className={`font-mono font-bold text-[11px] text-right ${pnlColor(pnlPercent)}`}>
                    {isMissed ? '--' : `${pnlPercent >= 0 ? '+' : ''}${safe(pnlPercent, 1)}%`}
                </div>

                {/* Col 5: Holding Duration */}
                <div className="text-center font-mono text-[11px] text-gray-300">
                    {trade.status === 'open' ? (
                        <span className="text-amber-300">{duration}...</span>
                    ) : (
                        duration
                    )}
                </div>

                {/* Col 6: MFE/MAE Bar */}
                <div className="px-1">
                    {analytics ? (
                        <MfeMaeBar mfe={analytics.maxFavorableExcursion} mae={analytics.maxAdverseExcursion} compact />
                    ) : (
                        <div className="text-[10px] text-gray-600 text-center">--</div>
                    )}
                </div>

                {/* Col 7: Exit Trigger Badge */}
                <div className="flex justify-center">
                    <ExitTriggerBadge trigger={analytics?.exitTrigger} trade={trade} />
                </div>

                {/* Col 8: Journal Toggle */}
                <div className="flex items-center justify-center gap-1">
                    <button
                        onClick={(e) => { e.stopPropagation(); onViewJournal(trade.id); }}
                        className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-cyan-400 transition-colors"
                        title="View Journal"
                    >
                        <EyeIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                        className={`p-1 rounded hover:bg-gray-700 transition-all duration-200 ${isExpanded ? 'text-cyan-400 rotate-180' : 'text-gray-500'}`}
                        title={isExpanded ? 'Collapse' : 'Expand'}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* ===== EXPANDED PANELS ===== */}
            <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}
            >
                {isExpanded && !isMissed && (
                    <div className="px-2 pb-3 pt-1">
                        {/* TP1 Hit banner */}
                        {trade.isTp1Hit && (
                            <div className="mb-2 p-1.5 bg-blue-500/10 border border-blue-500/30 rounded flex items-center gap-2 text-xs">
                                <ShieldCheckIcon className="w-3.5 h-3.5 text-blue-400" />
                                <span className="text-blue-200">
                                    TP1 Achieved (TP Count: {trade.tpCount || 1})
                                </span>
                            </div>
                        )}

                        {/* 4-Panel Grid (2x2) */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <PanelEntryQuality trade={trade} analytics={analytics} />
                            <PanelStrategyCost trade={trade} analytics={analytics} />
                            <PanelTradeExecution trade={trade} analytics={analytics} precision={precision} />
                            <PanelPostTrade trade={trade} analytics={analytics} />
                        </div>

                        {/* Existing Combat Log Metadata Row (kept for backwards compat) */}
                        {(trade.marketPhase || trade.verdict || trade.candlesElapsed !== undefined || trade.equityDelta !== undefined) && (
                            <div className="mt-2 grid grid-cols-4 gap-2 text-[10px] font-mono text-gray-400 p-2 bg-gray-900/40 rounded">
                                <div>
                                    <span className="text-gray-600 block">MARKET PHASE</span>
                                    <span className="text-gray-300">{trade.marketPhase || 'N/A'}</span>
                                </div>
                                <div>
                                    <span className="text-gray-600 block">VERDICT</span>
                                    <span className={`font-bold ${trade.verdict?.includes('WIN') ? 'text-green-400' : trade.verdict?.includes('LOSS') ? 'text-red-400' : 'text-amber-400'}`}>
                                        {trade.verdict || 'PENDING'}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-gray-600 block">CANDLE EFF</span>
                                    <span className="text-gray-300">{trade.candlesElapsed ?? 0} / {trade.candleBudget ?? '-'}</span>
                                </div>
                                <div>
                                    <span className="text-gray-600 block">EQUITY DELTA</span>
                                    <span className={pnlColor(trade.equityDelta)}>
                                        {trade.equityDelta ? `${trade.equityDelta.toFixed(2)} USDT` : '-'}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// =============================================
// Exported Component: TradeHistory
// =============================================
export const TradeHistory: React.FC<TradeHistoryProps> = ({ trades, precisions, onViewJournal }) => {
    const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');

    // Deduplicate and sort
    const uniqueTrades = useMemo(() => {
        const uniqueMap = new Map<string, Trade>();
        trades.forEach(t => uniqueMap.set(t.id, t));
        return Array.from(uniqueMap.values()).sort((a, b) => (b.openTimestamp || 0) - (a.openTimestamp || 0));
    }, [trades]);

    // Apply filter
    const filteredTrades = useMemo(() => {
        if (filter === 'all') return uniqueTrades;
        if (filter === 'open') return uniqueTrades.filter(t => t.status === 'open' || t.status === 'pending_entry');
        return uniqueTrades.filter(t => t.status === 'closed');
    }, [uniqueTrades, filter]);

    const openCount = uniqueTrades.filter(t => t.status === 'open' || t.status === 'pending_entry').length;
    const closedCount = uniqueTrades.filter(t => t.status === 'closed').length;

    return (
        <div className="flex flex-col h-full">
            {/* Filter Bar */}
            <div className="flex items-center gap-1 px-1 py-1 border-b border-gray-700/50 flex-shrink-0">
                <button
                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === 'all' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                    onClick={() => setFilter('all')}
                >
                    All ({uniqueTrades.length})
                </button>
                <button
                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === 'open' ? 'bg-amber-600/50 text-amber-200' : 'text-gray-400 hover:text-gray-200'}`}
                    onClick={() => setFilter('open')}
                >
                    Open ({openCount})
                </button>
                <button
                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === 'closed' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                    onClick={() => setFilter('closed')}
                >
                    Closed ({closedCount})
                </button>
            </div>

            {/* Table Container */}
            <div className="flex-1 overflow-y-auto pr-1 -mr-1">
                {filteredTrades.length === 0 ? (
                    <p className="text-gray-500 text-center py-8 text-sm">
                        {filter === 'all'
                            ? '현재 세션의 거래 내역이 없습니다.'
                            : filter === 'open'
                                ? '진행 중인 거래가 없습니다.'
                                : '종료된 거래가 없습니다.'}
                    </p>
                ) : (
                    <>
                        {/* Header */}
                        <div className="grid grid-cols-[1.2fr_1.4fr_0.8fr_0.7fr_0.7fr_1fr_0.9fr_0.4fr] gap-1 text-[10px] text-gray-500 font-bold sticky top-0 bg-gray-900 py-1.5 px-1 z-10 border-b border-gray-700/50">
                            <div>종목/방향/레버</div>
                            <div>진입{'\u2192'}종료가</div>
                            <div className="text-right">PnL($)</div>
                            <div className="text-right">PnL(%)</div>
                            <div className="text-center">보유시간</div>
                            <div className="text-center">MFE/MAE</div>
                            <div className="text-center">탈출사유</div>
                            <div className="text-center">일지</div>
                        </div>

                        {/* Rows */}
                        <div>
                            {filteredTrades.map(trade => (
                                <TradeRow
                                    key={trade.id}
                                    trade={trade}
                                    precision={precisions[trade.ticker] ?? 4}
                                    onViewJournal={onViewJournal}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
