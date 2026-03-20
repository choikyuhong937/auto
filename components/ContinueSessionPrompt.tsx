// NEW FILE: components/ContinueSessionPrompt.tsx
import React from 'react';
import type { TradeSession } from '../types';
import { HistoryIcon, PlayIcon, ArrowPathIcon } from './Icons';

interface ContinueSessionPromptProps {
    session: TradeSession;
    onContinue: () => void;
    onNewSession: () => void;
    onDismiss: () => void;
}

export const ContinueSessionPrompt: React.FC<ContinueSessionPromptProps> = ({ session, onContinue, onNewSession, onDismiss }) => {
    const pnl = session.sessionPnl ?? 0;
    const pnlColor = pnl >= 0 ? 'text-green-400' : 'text-red-400';
    const returnPercent = session.initialEquity > 0 ? (pnl / session.initialEquity) * 100 : 0;

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
            <div className="p-6 bg-bg-light rounded-lg border border-border-color max-w-md w-full mx-auto shadow-2xl animate-fade-in">
                <h2 className="text-xl font-bold text-text-primary mb-2 flex items-center gap-2">
                    <HistoryIcon className="w-6 h-6 text-brand-primary"/>
                    진행 중인 세션 발견
                </h2>
                <p className="text-sm text-text-secondary mb-6">
                    이전에 중단된 모의 거래 세션이 있습니다. 이어서 진행하시겠습니까?
                </p>

                <div className="p-4 bg-bg-dark rounded-md border border-border-color space-y-2 mb-6">
                    <div className="flex justify-between text-xs">
                        <span className="text-text-secondary">세션 시작 시간:</span>
                        <span className="font-semibold">{new Date(session.startTime).toLocaleString()}</span>
                    </div>
                     <div className="flex justify-between text-xs">
                        <span className="text-text-secondary">총 거래 수:</span>
                        <span className="font-semibold">{session.totalTrades}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-text-secondary">현재 손익 (PNL):</span>
                        <span className={`font-semibold font-mono ${pnlColor}`}>{pnl.toFixed(2)} USDT</span>
                    </div>
                     <div className="flex justify-between text-xs">
                        <span className="text-text-secondary">현재 수익률:</span>
                        <span className={`font-semibold font-mono ${pnlColor}`}>{returnPercent.toFixed(2)}%</span>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                    <button
                        onClick={onContinue}
                        className="w-full px-4 py-2 text-sm font-bold text-white bg-brand-primary rounded-md hover:bg-brand-secondary flex items-center justify-center gap-2 transition-colors"
                    >
                        <PlayIcon className="w-5 h-5"/>
                        세션 이어하기
                    </button>
                    <button
                        onClick={onNewSession}
                        className="w-full px-4 py-2 text-sm font-bold text-text-secondary bg-bg-dark rounded-md hover:bg-border-color flex items-center justify-center gap-2 transition-colors"
                    >
                        <ArrowPathIcon className="w-5 h-5"/>
                        새로운 세션 시작
                    </button>
                </div>
                <div className="mt-4 text-center">
                    <button
                        onClick={onDismiss}
                        className="text-xs text-text-secondary hover:text-text-primary underline transition-colors"
                    >
                        나중에 결정
                    </button>
                </div>
            </div>
             <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
                .animate-fade-in {
                    animation: fadeIn 0.3s ease-out forwards;
                }
            `}</style>
        </div>
    );
};