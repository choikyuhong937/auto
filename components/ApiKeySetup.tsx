
// components/ApiKeySetup.tsx
import React, { useState } from 'react';
import * as bybitService from '../services/bybitService';
import { Spinner } from './Spinner';
import { ChartIcon, WrenchIcon, CheckCircleIcon } from './Icons';

interface ApiKeySetupProps {
    onComplete: () => void;
}

export const ApiKeySetup: React.FC<ApiKeySetupProps> = ({ onComplete }) => {
    const [apiKey, setApiKey] = useState('');
    const [apiSecret, setApiSecret] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsValidating(true);

        try {
            if (!apiKey.trim() || !apiSecret.trim()) {
                throw new Error("API Key와 API Secret을 모두 입력해주세요.");
            }

            // Set keys in the service
            bybitService.setApiKeys(apiKey.trim(), apiSecret.trim());

            // Validate by making a real request
            const isValid = await bybitService.validateApiKeys();
            if (isValid) {
                onComplete();
            } else {
                throw new Error("API 연결에 실패했습니다. 키 권한과 잔고를 확인해주세요.");
            }
        } catch (err: any) {
            setError(err.message || "연결 실패. 입력한 키를 다시 확인해주세요.");
            // Clear keys on failure to prevent accidental usage of bad keys
            bybitService.clearApiKeys();
        } finally {
            setIsValidating(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-bg-dark p-4">
            <div className="w-full max-w-md bg-bg-light rounded-lg border border-border-color shadow-2xl p-8 animate-fade-in">
                <div className="flex flex-col items-center mb-8">
                    <ChartIcon className="w-12 h-12 text-brand-primary mb-3" />
                    <h1 className="text-2xl font-bold text-text-primary text-center">GZBot 🚀</h1>
                    <p className="text-text-secondary text-sm mt-2 text-center">
                        Bybit API 키를 연결하여 봇을 시작하세요.
                    </p>
                </div>

                <form onSubmit={handleConnect} className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-1">
                            API Key
                        </label>
                        <input
                            type="text"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="w-full bg-bg-dark border border-border-color rounded-md px-4 py-2 text-text-primary focus:ring-2 focus:ring-brand-primary focus:outline-none transition-colors"
                            placeholder="Enter your API Key"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-1">
                            API Secret
                        </label>
                        <input
                            type="password"
                            value={apiSecret}
                            onChange={(e) => setApiSecret(e.target.value)}
                            className="w-full bg-bg-dark border border-border-color rounded-md px-4 py-2 text-text-primary focus:ring-2 focus:ring-brand-primary focus:outline-none transition-colors"
                            placeholder="Enter your API Secret"
                            required
                        />
                    </div>

                    {error && (
                        <div className="p-3 bg-red-900/30 border border-red-500/50 rounded-md flex items-start gap-2">
                            <span className="text-red-400 text-sm">{error}</span>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isValidating}
                        className="w-full bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-4 rounded-md transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                    >
                        {isValidating ? (
                            <>
                                <Spinner className="w-5 h-5 text-white" />
                                <span>연결 확인 중...</span>
                            </>
                        ) : (
                            <>
                                <WrenchIcon className="w-5 h-5" />
                                <span>API 연결하기</span>
                            </>
                        )}
                    </button>
                </form>

                <div className="mt-6 pt-6 border-t border-border-color/50 text-center">
                    <p className="text-xs text-text-secondary">
                        <span className="font-semibold text-amber-400">주의:</span> API 키는 브라우저 메모리에만 저장되며, 새로고침 시 초기화됩니다. 안전을 위해 '읽기' 및 '거래' 권한만 부여된 키를 사용하세요.
                    </p>
                </div>
            </div>
            <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in {
                    animation: fadeIn 0.5s ease-out forwards;
                }
            `}</style>
        </div>
    );
};
