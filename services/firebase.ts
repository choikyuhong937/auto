
// services/firebase.ts
// Persistence layer now uses LocalStorage to mimic database persistence for SymbolProfiles.

import type {
    MasterAnalysisPayload,
    AiCoreConfig,
    Trade,
    TradeSession,
    SymbolProfile,
    PerformanceDiagnosticReport,
    EngineState,
    TradeJournalEntry,
    PersistedTrade,
} from '../types';

// --- Configuration ---
// No actual Firebase connection is established.

// [NEW] LocalStorage Keys
const STORAGE_KEYS = {
    PROFILES: 'cp_ai_symbol_profiles_v1',
    CONFIG: 'aiCoreConfig',
    CLOSED_TRADES: 'cp_closed_trades_v1',
};

const MAX_PERSISTED_TRADES = 500;

// [NEW] In-Memory Store for Symbol Profiles (Initialized from LocalStorage)
let symbolProfiles = new Map<string, SymbolProfile>();

// Initialize from Storage
try {
    const rawData = localStorage.getItem(STORAGE_KEYS.PROFILES);
    if (rawData) {
        const parsed = JSON.parse(rawData);
        if (Array.isArray(parsed)) {
            parsed.forEach((p: SymbolProfile) => symbolProfiles.set(p.ticker, p));
            console.log(`[Persistence] Loaded ${symbolProfiles.size} symbol profiles from storage.`);
        }
    }
} catch (e) {
    console.error("[Persistence] Failed to load profiles:", e);
}

// Helper to persist current map state
const persistProfiles = () => {
    try {
        const data = Array.from(symbolProfiles.values());
        localStorage.setItem(STORAGE_KEYS.PROFILES, JSON.stringify(data));
    } catch (e) {
        console.error("[Persistence] Failed to save profiles:", e);
    }
};

// --- Interface Implementations (LocalStorage Backed) ---

export const getAiCoreConfig = async (): Promise<AiCoreConfig | null> => {
    // Return null to trigger local storage fallback in AdminView (which handles config separately)
    return null;
};

export const saveAiCoreConfig = async (config: AiCoreConfig): Promise<void> => {
    // AdminView handles config persistence mostly, but we can sync here if needed.
};

// ★ Trade → PersistedTrade 변환
function tradeToPersistedTrade(trade: Trade): PersistedTrade {
    const closeTs = trade.closeTimestamp || Date.now();
    const openTs = trade.openTimestamp || closeTs;
    const pnl = trade.pnl ?? trade.realizedPnl ?? 0;
    const pnlPercent = trade.initialMargin > 0 ? (pnl / trade.initialMargin) * 100 : 0;
    return {
        id: trade.id,
        ticker: trade.ticker,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice ?? trade.entryPrice,
        pnl,
        pnlPercent,
        leverage: trade.leverage,
        reasonForExit: trade.reasonForExit ?? 'unknown',
        openTimestamp: openTs,
        closeTimestamp: closeTs,
        holdingMinutes: (closeTs - openTs) / 60000,
        strategyType: trade.analytics?.strategyName ?? trade.smartReverseDecision?.zoneType,
        regime: trade.analytics?.entryRegime ?? trade.marketPhase,
        session: trade.entrySession ?? trade.analytics?.marketSession,
        mfe: trade.analytics?.maxFavorableExcursion,
        mae: trade.analytics?.maxAdverseExcursion,
    };
}

function loadPersistedTrades(): PersistedTrade[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.CLOSED_TRADES);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function savePersistedTrades(trades: PersistedTrade[]): void {
    try {
        localStorage.setItem(STORAGE_KEYS.CLOSED_TRADES, JSON.stringify(trades));
    } catch {
        // quota exceeded — evict oldest 50 and retry
        try {
            const trimmed = trades.slice(-MAX_PERSISTED_TRADES + 50);
            localStorage.setItem(STORAGE_KEYS.CLOSED_TRADES, JSON.stringify(trimmed));
        } catch (e2) {
            console.error('[Persistence] Failed to save trades even after trim:', e2);
        }
    }
}

export const saveTrade = async (trade: Trade): Promise<void> => {
    const persisted = tradeToPersistedTrade(trade);
    const trades = loadPersistedTrades();
    // 중복 방지
    if (trades.some(t => t.id === persisted.id)) return;
    trades.push(persisted);
    // FIFO eviction
    while (trades.length > MAX_PERSISTED_TRADES) trades.shift();
    savePersistedTrades(trades);
    console.log(`[Persistence] 실전 거래 저장: ${persisted.ticker} ${persisted.direction} PnL=${persisted.pnl.toFixed(2)} (총 ${trades.length}건)`);
};

export const getAllTradeHistory = async (): Promise<PersistedTrade[]> => {
    return loadPersistedTrades();
};

export const getTradesByIds = async (tradeIds: string[]): Promise<PersistedTrade[]> => {
    const set = new Set(tradeIds);
    return loadPersistedTrades().filter(t => set.has(t.id));
};

export const getOpenTrades = async (): Promise<Trade[]> => {
    return [];
};

export const getClosedTradesAfter = async (timestamp: number): Promise<PersistedTrade[]> => {
    return loadPersistedTrades().filter(t => t.closeTimestamp > timestamp);
};

export const saveTradeSession = async (session: TradeSession): Promise<void> => {
    // No-op
};

export const getTradeSessions = async (limit: number = 20): Promise<TradeSession[]> => {
    return [];
};

export const getLatestRunningPaperSession = async (): Promise<TradeSession | null> => {
    return null;
};

export const deleteSessionsAndAssociatedTrades = async (sessionsToDelete: TradeSession[]): Promise<void> => {
    // No-op
};

export const getSymbolProfile = async (ticker: string): Promise<SymbolProfile | null> => {
    return symbolProfiles.get(ticker) || null;
};

export const saveSymbolProfile = async (profile: SymbolProfile): Promise<void> => {
    symbolProfiles.set(profile.ticker, profile);
    persistProfiles(); // Trigger save to disk
};

export const getAllSymbolProfiles = async (): Promise<SymbolProfile[]> => {
    return Array.from(symbolProfiles.values());
};

export const saveAnalysisPayload = async (payload: MasterAnalysisPayload): Promise<string> => {
    return payload.id || 'stub-id';
};

export const getAnalysisPayloadById = async (id: string): Promise<MasterAnalysisPayload | null> => {
    return null;
};

export const savePerformanceReport = async (report: PerformanceDiagnosticReport): Promise<void> => {
    // No-op
};

export const getLatestPerformanceReport = async (): Promise<PerformanceDiagnosticReport | null> => {
    return null;
};

export const saveTradeJournalEntry = async (entry: TradeJournalEntry): Promise<void> => {
    // No-op
};

export const getJournalEntriesForTrade = async (tradeId: string): Promise<TradeJournalEntry[]> => {
    return [];
};

export const getEngineState = async (): Promise<EngineState | null> => {
    return { initialBootstrapComplete: true };
};

export const saveEngineState = async (state: Partial<EngineState>): Promise<void> => {
    // No-op
};

// Deprecated functions kept for compatibility
export const getTradeHistory = async (limit?: number): Promise<Trade[]> => {
    return [];
};
