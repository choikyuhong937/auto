
// components/UnifiedChat.tsx
import React from 'react';
import type { ChatMessage, MasterAnalysisPayload, Trade, ConditionCheckItem } from '../types';
import { RobotIcon, CommandLineIcon, SparklesIcon, ArrowRightIcon, CheckCircleIcon, ShieldCheckIcon, ActivityIcon } from './Icons';

interface UnifiedChatProps {
    messages: ChatMessage[];
}

const getParticipantInfo = (participant: ChatMessage['participant']) => {
    switch (participant) {
        case 'ai':
            return { icon: <RobotIcon className="w-5 h-5" />, name: 'Master AI', color: 'text-brand-primary' };
        case 'trading_engine':
            return { icon: <CommandLineIcon className="w-5 h-5" />, name: 'Trading Engine', color: 'text-amber-400' };
        case 'system':
            return { icon: <SparklesIcon className="w-5 h-5" />, name: 'System', color: 'text-text-secondary' };
        default:
            return { icon: <div />, name: '', color: '' };
    }
};

const ConditionLogMessage: React.FC<{ payload: any }> = ({ payload }) => {
    const { ticker, direction, conditions } = payload as { ticker: string, direction: string, conditions: ConditionCheckItem[] };
    const directionColor = direction === 'Long' ? 'text-green-400' : 'text-red-400';

    return (
        <div className="text-xs p-2.5 rounded-md bg-bg-dark border border-border-color/50 mt-1.5 animate-fade-in">
            <div className="font-bold flex justify-between items-center mb-2">
                <span className="flex items-center gap-2">
                    🔍 조건 모니터링: {ticker}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded bg-bg-light ${directionColor} border border-current`}>
                    {direction}
                </span>
            </div>
            <div className="overflow-hidden rounded border border-border-color/30">
                <table className="w-full text-left">
                    <thead className="bg-bg-light/50 text-text-secondary text-[10px]">
                        <tr>
                            <th className="p-1.5 text-center w-8">상태</th>
                            <th className="p-1.5">조건 (기준)</th>
                            <th className="p-1.5 text-right">현재값</th>
                        </tr>
                    </thead>
                    <tbody className="text-[11px]">
                        {conditions.map((c, i) => (
                            <tr key={i} className={`border-t border-border-color/10 ${c.isMet ? 'bg-green-500/5' : ''}`}>
                                <td className="p-1.5 text-center">
                                    {c.isMet ? (
                                        <CheckCircleIcon className="w-3.5 h-3.5 text-green-400 mx-auto" />
                                    ) : (
                                        <div className="w-2.5 h-2.5 rounded-full border-2 border-gray-600 mx-auto" />
                                    )}
                                </td>
                                <td className="p-1.5">
                                    <div className="font-semibold text-text-primary">{c.name}</div>
                                    <div className="text-[9px] text-text-secondary opacity-80">{c.desc}</div>
                                </td>
                                <td className="p-1.5 text-right font-mono text-text-secondary">
                                    {c.actual}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// [NEW] Component for Health Check Messages
const HealthCheckMessage: React.FC<{ payload: any }> = ({ payload }) => {
    const { ticker, decision, reasoning, riskScore, newStopLoss, newTakeProfit } = payload;
    
    let decisionColor = 'text-text-primary';
    let decisionBg = 'bg-bg-light';
    let icon = <ActivityIcon className="w-4 h-4"/>;

    if (decision === 'CLOSE_IMMEDIATELY') {
        decisionColor = 'text-red-400';
        decisionBg = 'bg-red-900/20 border-red-500/30';
        icon = <ShieldCheckIcon className="w-4 h-4"/>;
    } else if (decision === 'TIGHTEN_SL') {
        decisionColor = 'text-amber-400';
        decisionBg = 'bg-amber-900/20 border-amber-500/30';
        icon = <ShieldCheckIcon className="w-4 h-4"/>;
    } else if (decision === 'HOLD') {
        decisionColor = 'text-green-400';
        decisionBg = 'bg-green-900/20 border-green-500/30';
        icon = <CheckCircleIcon className="w-4 h-4"/>;
    }

    return (
        <div className={`text-xs p-3 rounded-md bg-bg-dark border border-border-color/50 mt-1.5 space-y-2`}>
            <div className="flex justify-between items-center pb-2 border-b border-border-color/30">
                <span className="font-bold flex items-center gap-2">
                    {icon}
                    {ticker} 진단 결과
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${decisionBg} ${decisionColor}`}>
                    {decision}
                </span>
            </div>
            
            <div className="flex items-center gap-3 bg-bg-light/30 p-2 rounded">
                <span className="text-text-secondary w-16 shrink-0">리스크 점수</span>
                <div className="flex-grow bg-gray-700 h-1.5 rounded-full overflow-hidden">
                    <div 
                        className={`h-full ${riskScore > 70 ? 'bg-red-500' : riskScore > 40 ? 'bg-amber-500' : 'bg-green-500'}`} 
                        style={{ width: `${riskScore}%` }}
                    ></div>
                </div>
                <span className="font-mono font-bold w-8 text-right">{riskScore}</span>
            </div>

            <p className="text-text-secondary leading-relaxed">
                {reasoning}
            </p>

            {newStopLoss && (
                <div className="flex justify-between items-center pt-2 border-t border-border-color/20 text-amber-400 font-mono">
                    <span>추천 SL 조정:</span>
                    <span className="font-bold">{newStopLoss}</span>
                </div>
            )}
            
            {newTakeProfit && (
                <div className="flex justify-between items-center pt-2 border-t border-border-color/20 text-green-400 font-mono">
                    <span>추천 TP 조정 (익절 연장):</span>
                    <span className="font-bold">{newTakeProfit}</span>
                </div>
            )}
        </div>
    );
};

const TradeMessage: React.FC<{ trade: Trade }> = ({ trade }) => {
    if (!trade || !trade.ticker) {
        return <div className="text-xs text-text-secondary p-2 border border-border-color rounded bg-bg-dark italic">주문 상세 정보가 없습니다.</div>;
    }

    const pnl = trade.pnl ?? 0;
    const pnlColor = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-text-secondary';
    const directionColor = trade.direction === 'Long' ? 'text-green-400' : 'text-red-400';
    
    return (
        <div className="text-xs p-2.5 rounded-md bg-bg-dark border border-border-color/50 mt-1.5 animate-fade-in">
            <div className="font-bold flex justify-between items-center">
                <span>{trade.status === 'open' ? '🚀 포지션 진입' : '🏁 포지션 마감'}</span>
                <span className={directionColor}>{trade.direction?.toUpperCase()}</span>
            </div>
            <div className="mt-1.5 space-y-1">
                <div className="flex justify-between"><span className="text-text-secondary">종목:</span> <span>{trade.ticker}</span></div>
                <div className="flex justify-between"><span className="text-text-secondary">가격:</span> <span>{(trade.entryPrice ?? 0).toFixed(4)}</span></div>
                <div className="flex justify-between"><span className="text-text-secondary">레버리지:</span> <span>{trade.leverage}x</span></div>
                {trade.status === 'closed' && (
                    <div className="flex justify-between font-semibold border-t border-border-color/30 pt-1 mt-1">
                        <span className="text-text-secondary">손익(PNL):</span> <span className={pnlColor}>{pnl.toFixed(2)} USDT</span>
                    </div>
                )}
            </div>
        </div>
    );
};

const AnalysisMessage: React.FC<{ analysis: MasterAnalysisPayload }> = ({ analysis }) => {
    if (!analysis || !analysis.analysisResult) return null;
    const { ticker, confidence, summary } = analysis.analysisResult;
    return (
        <div className="text-xs p-2.5 rounded-md bg-bg-dark border border-border-color/50 mt-1.5">
            <div className="font-bold flex justify-between items-center">
                <span>AI 분석 완료: {ticker}</span>
                <span className="text-brand-secondary">{confidence.toFixed(1)}%</span>
            </div>
            <p className="mt-1.5 text-text-secondary italic">"{summary}"</p>
        </div>
    );
};

export const UnifiedChat: React.FC<UnifiedChatProps> = ({ messages }) => {
    const renderMessageContent = (msg: ChatMessage) => {
        switch (msg.type) {
            case 'error':
                return <p className="text-red-400 font-semibold">{msg.text}</p>;
            case 'system_state':
                return <p className="text-text-secondary italic bg-bg-dark/30 p-1 rounded">{msg.text}</p>;
            case 'analysis':
                return <AnalysisMessage analysis={msg.payload} />;
            case 'trade':
            case 'trade_update':
                return <TradeMessage trade={msg.payload} />;
            case 'condition_log':
                return <ConditionLogMessage payload={msg.payload} />;
            case 'health_check':
                return <HealthCheckMessage payload={msg.payload} />;
            default:
                return <p className="text-text-primary whitespace-pre-wrap">{msg.text}</p>;
        }
    };

    return (
        <div className="flex-grow flex flex-col p-3 overflow-hidden min-h-0">
            <h3 className="text-base font-semibold mb-3 px-1 text-text-secondary">활동 로그</h3>
            <div className="flex-grow overflow-y-auto pr-2 -mr-2 space-y-4 min-h-0 scrollbar-thin scrollbar-thumb-border-color">
                {messages.map((msg) => {
                    const { icon, name, color } = getParticipantInfo(msg.participant);
                    return (
                        <div key={msg.id} className="flex flex-col text-sm border-l-2 border-transparent hover:border-border-color pl-2 transition-colors">
                            <div className={`flex items-center gap-2 text-xs font-bold ${color} opacity-80 uppercase tracking-tighter`}>
                                {icon}
                                <span>{name}</span>
                                <span className="ml-auto text-[10px] text-text-secondary/40 font-mono">
                                    {/* FIX: Use fixed timestamp from message object instead of new Date() to prevent re-render updates */}
                                    {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                                </span>
                            </div>
                            <div className="mt-1 leading-relaxed">
                                {renderMessageContent(msg)}
                            </div>
                        </div>
                    );
                })}
            </div>
             <div className="mt-4 flex-shrink-0">
                <input
                    type="text"
                    placeholder="채팅 기능 비활성화"
                    disabled
                    className="w-full bg-bg-dark border border-border-color rounded-md p-2 text-xs opacity-50 cursor-not-allowed"
                />
            </div>
        </div>
    );
};