
// services/tradeLifecycleService.ts
import type { Trade, MasterAnalysisPayload, SymbolProfile, PostTradeInsights, SymbolPersonalityReport, KlineData, MissedEntryInsights, TradeJournalEntry } from '../types';
import * as db from './firebase';
import * as gemini from './geminiService';
import * as bybit from './bybitService';
import { calculateSnapshot } from './indicatorService'; // [NEW]
import { v4 as uuidv4 } from 'uuid';

const PERSONALITY_ANALYSIS_THRESHOLD = 3; // Trigger analysis after this many new notes

interface LifecycleResult {
    insights: PostTradeInsights | MissedEntryInsights;
    updatedProfile: SymbolProfile;
    newPersonalityReport?: SymbolPersonalityReport;
}

async function _checkAndTriggerPersonalityAnalysis(
    profile: SymbolProfile
): Promise<{ updatedProfile: SymbolProfile; newReport?: SymbolPersonalityReport }> {
    const notesSince = (profile.notesSinceLastReport ?? 0) + 1;

    if (notesSince >= PERSONALITY_ANALYSIS_THRESHOLD) {
        console.log(`[Lifecycle] Threshold of ${PERSONALITY_ANALYSIS_THRESHOLD} new notes reached for ${profile.ticker}. Triggering automatic personality analysis.`);
        
        const reportData = await gemini.getSymbolPersonalitySummary(profile);
        const newReport: SymbolPersonalityReport = {
            ...reportData,
            lastGenerated: Date.now(),
        };

        const updatedProfile: SymbolProfile = {
            ...profile,
            personalityReport: newReport,
            notesSinceLastReport: 0,
        };
        return { updatedProfile, newReport };
    } else {
        const updatedProfile: SymbolProfile = { ...profile, notesSinceLastReport: notesSince };
        return { updatedProfile };
    }
}


export async function performPostTradeAnalysis(closedTrade: Trade, tradeJournal: TradeJournalEntry[]): Promise<LifecycleResult> {
    if (closedTrade.category === 'option') {
        // ... (option handling remains same)
        const insights: PostTradeInsights = {
            mainTakeaway: "Post-trade analysis is not currently supported for option trades.",
            patternObserved: "Option trade.",
            suggestionForNextTime: "No strategic changes suggested for this asset type.",
            parameterAdjustment: { parameter: 'none', suggestion: "Analysis skipped for option trade." },
            maxPotentialPnl: 0,
            maxPotentialRoiPercent: 0,
        };
        const profile = await db.getSymbolProfile(closedTrade.ticker) || {
            ticker: closedTrade.ticker, lastAnalyzed: Date.now(), historicalDNA: [],
            performance: { trades: 0, pnl: 0, winRate: 0 }, behavioralNotes: [], validationInsights: []
        };
        return { insights, updatedProfile: profile };
    }

    const originalAnalysisEntry = tradeJournal.find(j => j.eventType === 'PLAN_CREATED');
    // Note: analysis might be missing if trade wasn't based on full plan
    // const originalAnalysis = originalAnalysisEntry?.payload.masterAnalysis; 

    if (closedTrade.reasonForExit === 'exchange_close' || closedTrade.reasonForExit === 'liquidation' || closedTrade.reasonForExit === 'session_end') {
        // ... (abnormal exit handling remains same)
        const insights: PostTradeInsights = {
            mainTakeaway: `The trade was prematurely closed by an external event ('${closedTrade.reasonForExit}').`,
            patternObserved: "External interruption.",
            suggestionForNextTime: "No strategic changes suggested.",
            parameterAdjustment: { parameter: 'none', suggestion: "Interrupted." },
            maxPotentialPnl: 0,
            maxPotentialRoiPercent: 0,
        };
        const profile = await db.getSymbolProfile(closedTrade.ticker) || {
            ticker: closedTrade.ticker, lastAnalyzed: Date.now(), historicalDNA: [],
            performance: { trades: 0, pnl: 0, winRate: 0 }, behavioralNotes: [], validationInsights: []
        };
        return { insights, updatedProfile: profile };
    }
    
    // Lookahead for analysis
    const lookaheadEndTime = (closedTrade.closeTimestamp || Date.now()); 
    // Extend slightly to capture the very last moment properly if needed, but closedTimestamp is exact.

    // Fetch 1m klines covering trade duration
    const actualKlines = await bybit.fetchSingleTimeframeKlines(
        closedTrade.ticker, '1m', 1000, closedTrade.openTimestamp, lookaheadEndTime, closedTrade.category as ('linear' | 'inverse')
    );

    let maxPotentialPnl = 0;
    let maxPotentialRoiPercent = 0;
    
    // [NEW] God Mode: Find Optimal Entry
    let optimalEntryPrice = closedTrade.entryPrice;
    let optimalCandleIndex = -1;

    if (actualKlines.length > 0) {
        let maxFavorablePrice = closedTrade.entryPrice;
        
        // Find best possible price during the trade (for drawdown calculation)
        // For Long: Lowest Low BEFORE it went up to TP. 
        // Actually, "Optimal Entry" is the lowest price hit *after* our entry but *before* the exit/pump.
        // Simplified: The lowest point during the trade duration.
        
        let lowestLow = actualKlines[0].low;
        let highestHigh = actualKlines[0].high;
        
        actualKlines.forEach((k, idx) => {
            if (k.low < lowestLow) { lowestLow = k.low; optimalCandleIndex = idx; }
            if (k.high > highestHigh) { highestHigh = k.high; if (closedTrade.direction === 'Short') optimalCandleIndex = idx; }
            
            if (closedTrade.direction === 'Long') maxFavorablePrice = Math.max(maxFavorablePrice, k.high);
            else maxFavorablePrice = Math.min(maxFavorablePrice, k.low);
        });

        if (closedTrade.direction === 'Long') optimalEntryPrice = lowestLow;
        else optimalEntryPrice = highestHigh;

        const pnlMultiplier = closedTrade.direction === 'Long' ? 1 : -1;
        maxPotentialPnl = (maxFavorablePrice - closedTrade.entryPrice) * closedTrade.quantity * pnlMultiplier;
        const initialMargin = closedTrade.initialMargin || (closedTrade.entryPrice * closedTrade.quantity / closedTrade.leverage);
        if (initialMargin > 0) maxPotentialRoiPercent = (maxPotentialPnl / initialMargin) * 100;
    }

    // [NEW] Self-Correction Logic with Adaptive Shock Learning
    const profile = await db.getSymbolProfile(closedTrade.ticker) || {
        ticker: closedTrade.ticker,
        lastAnalyzed: 0,
        historicalDNA: [],
        performance: { trades: 0, pnl: 0, winRate: 0 },
        behavioralNotes: [],
        validationInsights: [],
        notesSinceLastReport: 0,
        calibrationData: { drawdownBias: 0, rsiBias: 0, updatedAt: 0 }
    };

    if (closedTrade.entrySnapshot && optimalCandleIndex !== -1) {
        // Calculate Drawdown Bias
        // Long: (Entry - Optimal) / Entry. (e.g. Bought 100, Low 99. Diff 1. Bias = 0.01)
        // Short: (Optimal - Entry) / Entry. (e.g. Sold 100, High 101. Diff 1. Bias = 0.01)
        const rawDrawdownPct = Math.abs(closedTrade.entryPrice - optimalEntryPrice) / closedTrade.entryPrice;
        
        // [MOD] Adaptive Learning Rate (Alpha)
        // Pain Learning: If loss, learn aggressively (0.8). If win, learn gently (0.2).
        const isLoss = (closedTrade.pnl || 0) < 0;
        const learningRate = isLoss ? 0.8 : 0.2;
        
        const oldBias = profile.calibrationData?.drawdownBias || 0;
        const newBias = (oldBias * (1 - learningRate)) + (rawDrawdownPct * learningRate);
        
        // Update RSI Bias? (Requires fetching indicators for optimal candle, skipped for complexity/rate limits, focus on Price Bias first)
        
        profile.calibrationData = {
            drawdownBias: newBias,
            rsiBias: 0, // Placeholder
            updatedAt: Date.now()
        };
        
        console.log(`[Adaptive Learning] ${closedTrade.ticker} Bias Updated: ${oldBias.toFixed(4)} -> ${newBias.toFixed(4)} (Alpha: ${learningRate})`);
    }

    const insightsFromGemini = await gemini.generatePostTradeInsights(closedTrade, tradeJournal, actualKlines, { maxPotentialPnl, maxPotentialRoiPercent });

    const insights: PostTradeInsights = {
        ...insightsFromGemini,
        maxPotentialPnl,
        maxPotentialRoiPercent,
    };

    const { parameter, suggestion } = insights.parameterAdjustment;
    const behavioralNote = parameter !== 'none'
        ? `[ADJUST ${parameter.toUpperCase()}] ${suggestion}`
        : `[CONFIRMED] ${insights.suggestionForNextTime}`;
    
    profile.behavioralNotes = [behavioralNote, ...profile.behavioralNotes].slice(0, 20);
    
    const newTotalTrades = profile.performance.trades + 1;
    const newTotalPnl = profile.performance.pnl + (closedTrade.pnl || 0);
    const newWins = ((profile.performance.winRate / 100) * profile.performance.trades) + ((closedTrade.pnl || 0) > 0 ? 1 : 0);
    
    profile.performance = {
        trades: newTotalTrades,
        pnl: newTotalPnl,
        winRate: newTotalTrades > 0 ? (newWins / newTotalTrades) * 100 : 0,
    };
    profile.lastAnalyzed = Date.now();

    const { updatedProfile, newReport } = await _checkAndTriggerPersonalityAnalysis(profile);

    return { insights, updatedProfile, newPersonalityReport: newReport };
}

export async function performMissedEntryAnalysis(
    analysis: MasterAnalysisPayload,
    reason: MissedEntryInsights['reasonForFailure'],
    tradeJournal: TradeJournalEntry[]
): Promise<LifecycleResult> {
    const originalAnalysis = analysis;
     if (!originalAnalysis) {
        throw new Error(`[Lifecycle] Missed entry has no analysis, cannot perform analysis.`);
    }

    const highProbScenario = originalAnalysis.priceScenarios.find(s => s.probability === 'High') || originalAnalysis.priceScenarios[0];
    const plannedDurationMs = (highProbScenario.path[highProbScenario.path.length - 1]?.timeMinutes || 60) * 60 * 1000;
    const lookaheadEndTime = Date.now() + plannedDurationMs;
    const category = (await bybit.fetchInstrumentInfo(originalAnalysis.analysisResult.ticker))?.category || 'linear';

    const actualKlines = await bybit.fetchSingleTimeframeKlines(
        originalAnalysis.analysisResult.ticker, '1m', 1000, Date.now() - (5 * 60 * 1000), lookaheadEndTime, category as ('linear' | 'inverse')
    );

    const insights = await gemini.generateMissedEntryInsights(tradeJournal, actualKlines);

    const profile = await db.getSymbolProfile(originalAnalysis.analysisResult.ticker) || {
        ticker: originalAnalysis.analysisResult.ticker,
        lastAnalyzed: 0,
        historicalDNA: [],
        performance: { trades: 0, pnl: 0, winRate: 0 },
        behavioralNotes: [],
        validationInsights: [],
        notesSinceLastReport: 0,
    };

    const { parameter, suggestion } = insights.parameterAdjustment;
    const missedEntryReason = tradeJournal.find(j => j.eventType === 'ENTRY_MISSED')?.payload.summary || 'UNKNOWN_REASON';
    const validationInsight = parameter !== 'none'
        ? `[${missedEntryReason}][ADJUST ${parameter.toUpperCase()}] ${suggestion}`
        : `[${missedEntryReason}][CONFIRMED] ${insights.suggestionForNextTime}`;
        
    profile.validationInsights = [validationInsight, ...profile.validationInsights].slice(0, 20);
    profile.lastAnalyzed = Date.now();

    const { updatedProfile, newReport } = await _checkAndTriggerPersonalityAnalysis(profile);

    return { insights, updatedProfile, newPersonalityReport: newReport };
}
