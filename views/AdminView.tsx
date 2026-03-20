
// views/AdminView.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { Header } from '../components/Header';
import { TradingBotDashboard } from '../components/TradingBotDashboard';
import { UnifiedChat } from '../components/UnifiedChat';
// AiCoreConfig is now rendered inside TradingBotDashboard
import type { SystemStatus, AiCoreConfig, ChatMessage, BotState, AutoOptimizerState, OptimizerParamRange, AutoOptMode } from '../types';
import { masterPromptTemplate } from '../prompt-template';
import { EventEmitter } from '../services/eventEmitter';
import { TradingEngine } from '../services/tradingEngine';
import { CommandLineIcon, EyeIcon } from '../components/Icons';
import { AutoOptimizerService } from '../services/autoOptimizerService';

const DEFAULT_AI_CONFIG: AiCoreConfig = {
    championPrompt: masterPromptTemplate,
    exclusionList: '',
    focusList: '',
    telegramBotToken: '7868096288:AAHIefVaLGSmri_V3UJTk18WGgKGzDvuAr0',
    telegramChatId: '7868096288',
    telegramReportInterval: 0
};

export const AdminView: React.FC = () => {
    const [systemStatus, setSystemStatus] = useState<SystemStatus>('idle');
    const [aiConfig, setAiConfig] = useState<AiCoreConfig>(DEFAULT_AI_CONFIG);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    
    const eventEmitter = useRef(new EventEmitter()).current;
    const tradingEngine = useRef<TradingEngine | null>(null);
    const autoOptimizer = useRef<AutoOptimizerService | null>(null);
    const botStateRef = useRef<BotState | null>(null);
    const [botStatus, setBotStatus] = useState<'running' | 'stopped'>('stopped');
    const [botState, setBotState] = useState<BotState>({ 
        totalEquity: 0, availableBalance: 0, openPositions: [], openOrders: [],
        lastActivity: 'N/A', sessionTradeHistory: [], analysisStatus: 'paused', currentSession: null,
        sessionStats: { 
            initialEquity: 0, currentEquity: 0, sessionReturnPercent: 0, sessionPnl: 0, totalTrades: 0, winRate: 0,
            unrealizedPnl: 0, realizedPnl: 0, profitFactor: 0 
        },
        liveKlines: {}, latestPrices: {}, analyzingTickers: [], lastScanResult: null, isFilterActive: false, filterResults: [],
        activeStrategies: {}, sessionMaxEquity: 0, reservedProfits: 0,
        tradesSinceLastOptimization: 0,
        optimizationVersion: 1,
        snipingTickers: [], 
        waitingCandidates: [], 
        isLeverageOverrideActive: false,
        isReverseTradingActive: false,
        isSmartReverseActive: false,
        isBerserkerMode: false,
        isAutoBerserker: false,
        allInPercentage: 80,
        tpClosePercentage: 50,
    });

    const [isPositionWidgetVisible, setIsPositionWidgetVisible] = useState(true);
    const [isEcoMode, setIsEcoMode] = useState(false);
    const [isShadowMode, setIsShadowMode] = useState(false);
    const [autoOptState, setAutoOptState] = useState<AutoOptimizerState | null>(null);
    const [optRanges, setOptRanges] = useState<{ 'ignition-wf': OptimizerParamRange[] }>({
        'ignition-wf': [],
    });
    
    const addMessage = useCallback((participant: ChatMessage['participant'], text: string, type: ChatMessage['type'] = 'text', payload: any = {}) => {
        setMessages(prev => {
            if (prev.length > 0) {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg.text === text && lastMsg.participant === participant) {
                    return prev;
                }
                if (type === 'system_state' && text.includes('모니터링') && lastMsg.text.includes('모니터링')) {
                    return prev;
                }
            }

            const newMessage: ChatMessage = { id: uuidv4(), participant, text, type, payload, timestamp: Date.now() };
            return [...prev, newMessage].slice(-3);
        });
    }, []);
    
    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
    }, []);

    const loadCoreData = useCallback(async () => {
        const localConfigStr = localStorage.getItem('aiCoreConfig');
        if (localConfigStr) { try { const localConfig = JSON.parse(localConfigStr); setAiConfig({ ...DEFAULT_AI_CONFIG, ...localConfig }); } catch (e) { setAiConfig(DEFAULT_AI_CONFIG); } }
        else { setAiConfig(DEFAULT_AI_CONFIG); }
    }, []);
    
    useEffect(() => { loadCoreData(); }, [loadCoreData]);

    useEffect(() => {
        if (!tradingEngine.current) {
            tradingEngine.current = new TradingEngine(eventEmitter);
            (window as any).tradingEngine = tradingEngine.current;
        }
        if (!autoOptimizer.current) {
            autoOptimizer.current = new AutoOptimizerService({
                applyLiveParams: (config, extra) => {
                    tradingEngine.current?.applyLiveParams(config, extra);
                    setAiConfig(prev => ({
                        ...prev,
                        scanTopN: config.swing?.scanTopN,
                        baseSizePercent: config.sizing?.baseSizePercent,
                        ...(extra?.maxPositions !== undefined ? { maxPositions: extra.maxPositions } : {}),
                    }));
                },
                getTradingConfig: () => tradingEngine.current!.tradingConfig,
                emitMessage: (p, t, type) => eventEmitter.emit('newMessage', p, t, type as any),
                getPositionCount: () => botStateRef.current?.openPositions?.filter(p => p.status === 'open')?.length ?? 0,
            });
            // ★ v52.56: WF 윈도우별 bestParams → state에 누적
            autoOptimizer.current.emitWfWindows = (records) => {
                tradingEngine.current?.addWfWindows(records);
            };
            // ★ v52.96: 20x 레지스트리를 window에 노출 (섀도우 시그널 기록용)
            (window as any).tradingEngine = (window as any).tradingEngine || {};
            Object.defineProperty((window as any).tradingEngine, 'autoOpt20xRegistry', {
                get: () => autoOptimizer.current?.getShadow20xRegistry() ?? {},
                configurable: true,
            });
            // Dashboard에 실시간 상태 전달
            autoOptimizer.current.subscribe((state) => setAutoOptState(state));
            setAutoOptState(autoOptimizer.current.getState());
            // 옵티마이저 변수 초기화
            setOptRanges({
                'ignition-wf': autoOptimizer.current.getCustomRanges('ignition-wf'),
            });
        }
        // ★ 2연패 → autoOptimizer에 재최적화 요청 연결
        const handleTickerReopt = (ticker: string) => {
            autoOptimizer.current?.requestTickerReopt(ticker);
        };

        const handleBotStateUpdate = (state: BotState) => { botStateRef.current = state; setBotState({ ...state }); };
        const handleBotStatusUpdate = (status: 'running' | 'stopped') => setBotStatus(status);
        const handleNewMessage = (participant: ChatMessage['participant'], text: string, type: ChatMessage['type'], payload: any) => addMessage(participant, text, type, payload);
        eventEmitter.on('tickerReoptRequest', handleTickerReopt);
        eventEmitter.on('botStateUpdate', handleBotStateUpdate);
        eventEmitter.on('botStatusUpdate', handleBotStatusUpdate);
        eventEmitter.on('newMessage', handleNewMessage);
        return () => {
            eventEmitter.off('tickerReoptRequest', handleTickerReopt);
            eventEmitter.off('botStateUpdate', handleBotStateUpdate);
            eventEmitter.off('botStatusUpdate', handleBotStatusUpdate);
            eventEmitter.off('newMessage', handleNewMessage);
        };
    }, [eventEmitter, addMessage]);

    const handleConfigSave = async (newConfig: AiCoreConfig) => {
        setAiConfig(newConfig);
        localStorage.setItem('aiCoreConfig', JSON.stringify(newConfig));
        tradingEngine.current?.updateConfig(newConfig);
    };

    const startBot = () => {
        tradingEngine.current?.start(aiConfig, null);
    };

    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

    // ── 전략 파라미터 변경 핸들러 (글로벌) ──
    const handleGlobalParamChange = useCallback((key: string, value: number) => {
        // aiConfig에 저장
        setAiConfig(prev => {
            const updated = { ...prev, [key]: value };
            localStorage.setItem('aiCoreConfig', JSON.stringify(updated));
            return updated;
        });
        // tradingEngine에도 반영
        if (tradingEngine.current) {
            const cfg = tradingEngine.current.tradingConfig;
            if (cfg) {
                if (key === 'scanTopN') { if (cfg.swing) cfg.swing.scanTopN = value; }
                else if (key === 'baseSizePercent') { if (cfg.sizing) cfg.sizing.baseSizePercent = value; }
                else if (key === 'maxPositions') { tradingEngine.current.applyLiveParams(cfg, { maxPositions: value }); }
                else if (key === 'tpAtrMultiplier') { if (cfg.swing) cfg.swing.tpAtrMultiplier = value; }
                else if (key === 'leverageTrending') { if (cfg.swing?.maxLeverage) cfg.swing.maxLeverage.TRENDING = value; }
                else if (key === 'leverageRanging') { if (cfg.swing?.maxLeverage) cfg.swing.maxLeverage.RANGING = value; }
                else if (key === 'leverageVolatile') { if (cfg.swing?.maxLeverage) cfg.swing.maxLeverage.VOLATILE = value; }
                else if (key === 'partialTp1Ratio') { if (cfg.swing?.partialTp) cfg.swing.partialTp[0] = value; }
                else if (key === 'partialQty1') { if (cfg.swing?.partialQty) cfg.swing.partialQty[0] = value; }
                else if (key === 'minRiskReward') { if (cfg.swing) cfg.swing.minRiskReward = value; }
                else if (key === 'scoreThreshold') { if (cfg.swing) (cfg.swing as any).scoreThreshold = value; }
                else if (key === 'activeSession') { if (cfg.swing) (cfg.swing as any).activeSession = value; }
            }
        }
    }, []);

    // ── 종목별 파라미터 변경 핸들러 (window.tradingEngine 통해 private registry 접근) ──
    const handleTickerParamChange = useCallback((ticker: string, paramKey: string, value: number | boolean) => {
        const engine = (window as any).tradingEngine;
        if (engine && engine.tickerParamRegistry && engine.tickerParamRegistry[ticker]) {
            (engine.tickerParamRegistry[ticker].params as any)[paramKey] = value;
            engine.tickerParamRegistry[ticker].updatedAt = Date.now();
            engine.refreshState?.();
        }
    }, []);

    // ── 옵티마이저 변수 범위 변경 핸들러 ──
    const handleOptimizerRangeChange = useCallback((mode: AutoOptMode, ranges: OptimizerParamRange[]) => {
        setOptRanges(prev => ({ ...prev, [mode]: ranges }));
        autoOptimizer.current?.setCustomRanges(mode, ranges);
    }, []);

    return (
        <div className="flex flex-col h-screen bg-bg-main text-text-primary font-sans">
            <Header />
            {!isOnline && <div className="bg-red-500 text-white text-center py-1 text-sm">Offline: Internet connection lost.</div>}

            <main className="flex-grow grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 overflow-hidden min-h-0 relative">
                <div className={`flex flex-col min-h-0 border-r border-border-color transition-all duration-300 ${isEcoMode ? 'lg:col-span-3 xl:col-span-4' : 'lg:col-span-2 xl:col-span-3'}`}>
                    {/* 단일 페이지 헤더 */}
                    <div className="flex items-center bg-bg-light border-b border-border-color justify-between px-4 py-2 shrink-0">
                        <span className="text-sm font-bold text-text-primary flex items-center gap-2">
                            <CommandLineIcon className="w-5 h-5 text-brand-primary" /> Strategy Bot
                        </span>
                        <button
                            onClick={() => setIsEcoMode(!isEcoMode)}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold transition-all border ${isEcoMode ? 'bg-green-900/30 text-green-400 border-green-500/50' : 'bg-bg-dark text-text-secondary border-border-color hover:border-text-secondary'}`}
                            title="화면 렌더링을 최소화하여 발열을 줄입니다."
                        >
                            <EyeIcon className="w-4 h-4" />
                            {isEcoMode ? '🍃 ON' : 'ECO'}
                        </button>
                    </div>

                    <div className="flex-grow overflow-y-auto min-h-0 bg-bg-main/50">
                        {/* 1. 메인 대시보드 + 전략 파라미터 */}
                        <div className={isEcoMode ? "h-full" : "p-4"}>
                            <TradingBotDashboard
                                botStatus={botStatus}
                                botState={botState}
                                onStart={() => startBot()}
                                onStop={() => tradingEngine.current?.stop()}
                                onRefresh={() => tradingEngine.current?.refreshState()}
                                aiConfig={aiConfig}
                                isPositionWidgetVisible={isPositionWidgetVisible}
                                onTogglePositionWidget={() => setIsPositionWidgetVisible(!isPositionWidgetVisible)}
                                onDelegate={(ticker) => tradingEngine.current?.analyzeForWatchlist(ticker, 'Manual Delegation', 'Long', 'TREND')}
                                isEcoMode={isEcoMode}
                                lastLogMessage={lastMessage?.text}
                                autoOptState={autoOptState}
                                onAutoOptStop={() => autoOptimizer.current?.stop()}
                                onAutoOptStart={(mode) => autoOptimizer.current?.start(mode)}
                                onGlobalParamChange={handleGlobalParamChange}
                                onTickerParamChange={handleTickerParamChange}
                                optimizerRanges={optRanges}
                                onOptimizerRangeChange={handleOptimizerRangeChange}
                                onConfigChange={handleConfigSave}
                                isShadowMode={isShadowMode}
                                onToggleShadow={() => {
                                    const next = !isShadowMode;
                                    setIsShadowMode(next);
                                    tradingEngine.current?.setShadowMode(next);
                                }}
                                onShadowStart={() => {
                                    // 섀도우 모드: 봇 시작 + 오토옵티 시작 + 섀도우 ON + 실전 진입 차단
                                    setIsShadowMode(true);
                                    tradingEngine.current?.setShadowMode(true);
                                    autoOptimizer.current?.setShadowMode(true);
                                    startBot();
                                    autoOptimizer.current?.start('ignition-wf');
                                }}
                                onShadowStop={() => {
                                    // 섀도우 모드 중지
                                    setIsShadowMode(false);
                                    tradingEngine.current?.setShadowMode(false);
                                    autoOptimizer.current?.setShadowMode(false);
                                    tradingEngine.current?.stop();
                                    autoOptimizer.current?.stop();
                                }}
                            />
                        </div>
                    </div>
                </div>

                {!isEcoMode && (
                    <div className="lg:col-span-1 xl:col-span-1 bg-bg-light border-l border-border-color flex flex-col min-h-0 animate-fade-in">
                        <UnifiedChat messages={messages} />
                    </div>
                )}
            </main>
        </div>
    );
};
