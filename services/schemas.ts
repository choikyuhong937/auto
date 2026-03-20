// services/schemas.ts
import { z } from 'zod';

const createEnumPreprocessor = <T extends string>(
    validEnums: readonly [T, ...T[]],
    synonymMap: Record<string, string> = {},
    defaultValue: T 
) => {
    const enumMap = new Map<string, string>();
    validEnums.forEach(v => enumMap.set(v.toLowerCase().replace(/[\s-]/g, ''), v));

    return z.preprocess((val) => {
        if (typeof val === 'string') {
            const sanitizedVal = val.trim().toLowerCase().replace(/[\s-]/g, '');
            if (enumMap.has(sanitizedVal)) {
                return enumMap.get(sanitizedVal);
            }
            for (const [synonym, targetEnum] of Object.entries(synonymMap)) {
                if (sanitizedVal.includes(synonym)) {
                    return targetEnum;
                }
            }
        }
        console.warn(`[Schema Preprocessing] Unrecognized enum value: "${val}". Defaulting to '${defaultValue}'.`);
        return defaultValue;
    }, z.enum(validEnums));
};

// Helper to convert string numbers to actual numbers (e.g. "100.5" -> 100.5)
const preprocessNumber = (val: unknown) => {
    if (typeof val === 'string') {
        const parsed = parseFloat(val.replace(/,/g, ''));
        return isNaN(parsed) ? 0 : parsed;
    }
    return val;
};

const coerceNumber = z.preprocess(preprocessNumber, z.number());

// [REMOVED] perspectiveAnalysisSchema — was used by analyzeTrendAndZone (now replaced by code-based zoneCalculator)

// [REMOVED] analyzeTrendAndZoneSchema — replaced by code-based zoneCalculator

// [REMOVED] confirmExecutionSchema — replaced by code-based zone hit + GoldenSet verification

// [NEW] Pulse Monitor Schema
export const momentumPulseSchema = z.object({
    momentumStatus: createEnumPreprocessor(
        ['ACCELERATING', 'HEALTHY_GRIND', 'STAGNANT_CHOP', 'DIVERGENCE_WARNING', 'EXHAUSTION_CLIMAX', 'STRUCTURAL_BREAK'],
        { 
            'pump': 'ACCELERATING', 'strong': 'ACCELERATING',
            'slow': 'HEALTHY_GRIND', 'flag': 'HEALTHY_GRIND',
            'chop': 'STAGNANT_CHOP', 'sideways': 'STAGNANT_CHOP',
            'weak': 'DIVERGENCE_WARNING', 'div': 'DIVERGENCE_WARNING',
            'top': 'EXHAUSTION_CLIMAX', 'blowoff': 'EXHAUSTION_CLIMAX',
            'dump': 'STRUCTURAL_BREAK', 'break': 'STRUCTURAL_BREAK'
        },
        'STAGNANT_CHOP'
    ),
    // [NEW] Phase Identification field for debugging and logic control
    identifiedPhase: createEnumPreprocessor(
        ['ACCUMULATION', 'IGNITION', 'TREND_RUNNING', 'DISTRIBUTION'],
        { 
            'sideways': 'ACCUMULATION', 'range': 'ACCUMULATION', 'chop': 'ACCUMULATION',
            'start': 'IGNITION', 'breakout': 'IGNITION', 'early': 'IGNITION',
            'mid': 'TREND_RUNNING', 'run': 'TREND_RUNNING', 'profit': 'TREND_RUNNING',
            'top': 'DISTRIBUTION', 'climax': 'DISTRIBUTION'
        },
        'TREND_RUNNING' // Default to sensitive
    ).describe("Current market phase. ACCUMULATION/IGNITION = Low Sensitivity (Ignore Wicks). TREND_RUNNING = High Sensitivity (Protect Profit)."),
    action: createEnumPreprocessor(
        ['HOLD_AND_WAIT', 'REMOVE_TP_LET_RUN', 'TIGHTEN_SL_TO_CANDLE', 'TAKE_PROFIT_NOW', 'PANIC_DUMP'],
        {
            'hold': 'HOLD_AND_WAIT',
            'run': 'REMOVE_TP_LET_RUN', 'remove_tp': 'REMOVE_TP_LET_RUN',
            'trail': 'TIGHTEN_SL_TO_CANDLE', 'tighten': 'TIGHTEN_SL_TO_CANDLE',
            'tp': 'TAKE_PROFIT_NOW', 'exit': 'TAKE_PROFIT_NOW',
            'sell_top': 'TAKE_PROFIT_NOW', // [NEW] Synonym for 'selling the top'
            'close': 'PANIC_DUMP', 'emergency': 'PANIC_DUMP'
        },
        'HOLD_AND_WAIT'
    ).describe("TAKE_PROFIT_NOW means selling into strength/greed (Climax). PANIC_DUMP means selling into weakness (Crash)."),
    suggestedNewSl: coerceNumber.optional().nullable().describe("If TIGHTEN_SL OR REMOVE_TP_LET_RUN, suggest specific price based on 5m structure low."),
    reasoning: z.string().describe("Short explanation of the micro-structure analysis.")
});

// [NEW] Entry Validation Gate Schema (AI 진입 최종검증)
export const entryValidationSchema = z.object({
    decision: createEnumPreprocessor(
        ['EXECUTE', 'SKIP'],
        { 'go': 'EXECUTE', 'enter': 'EXECUTE', 'buy': 'EXECUTE', 'sell': 'EXECUTE',
          'pass': 'SKIP', 'wait': 'SKIP', 'avoid': 'SKIP', 'no': 'SKIP', 'reject': 'SKIP' },
        'EXECUTE'  // 기본값 = 실행 (공격적 바이어스)
    ),
    confidence: coerceNumber,
    reasoning: z.string()
});

// [NEW] Consolidated Position Risk Schema (SL + Switch + Escape + TP Adjustment)
export const positionRiskSchema = z.object({
    action: createEnumPreprocessor(
        ['HOLD', 'TIGHTEN_SL', 'ADJUST_TP', 'ESCAPE_IMMEDIATELY', 'SWITCH_TO_REVERSE'],
        { 
            'keep': 'HOLD', 'maintain': 'HOLD',
            'tighten': 'TIGHTEN_SL', 'adjust_sl': 'TIGHTEN_SL', 'move_sl': 'TIGHTEN_SL',
            'adjust_tp': 'ADJUST_TP', 'move_tp': 'ADJUST_TP', 'update_tp': 'ADJUST_TP', 'extend': 'ADJUST_TP',
            'close': 'ESCAPE_IMMEDIATELY', 'exit': 'ESCAPE_IMMEDIATELY', 'dump': 'ESCAPE_IMMEDIATELY',
            'switch': 'SWITCH_TO_REVERSE', 'reverse': 'SWITCH_TO_REVERSE', 'flip': 'SWITCH_TO_REVERSE'
        },
        'HOLD'
    ),
    newStopLossPrice: coerceNumber.optional().nullable().describe("If TIGHTEN_SL, provide the new specific SL price."),
    newTakeProfitPrice: coerceNumber.optional().nullable().describe("If ADJUST_TP, provide the new target price based on changed market structure."),
    predictedReversalMovePercent: coerceNumber.optional().describe("MANDATORY if action is SWITCH_TO_REVERSE. The expected % move in the NEW direction (e.g. 5.5 for 5.5%)."),
    reasoning: z.string().describe("Logic explaining the decision."),
    contingencySetup: z.object({
        direction: z.enum(['Long', 'Short']),
        minEntryPrice: coerceNumber,
        maxEntryPrice: coerceNumber,
        strategyName: z.string()
    }).optional().describe("If action is HOLD but market looks shaky, provide the immediate reversal entry zone here (Pre-planning).")
});

// [MOD] Range Danger Schema: Added SWITCH action (Kept for compatibility, but positionRiskSchema is preferred)
export const rangeDangerSchema = z.object({
    isRanging: z.boolean().describe("True if market is in range, choppy, or correction phase."),
    positionStatus: createEnumPreprocessor(
        ['SAFE', 'BAD_LOCATION', 'NEUTRAL'],
        { 'stuck': 'BAD_LOCATION', 'trapped': 'BAD_LOCATION', 'good': 'SAFE' },
        'NEUTRAL'
    ).describe("Evaluate if the current position is trapped at a bad location (e.g. Long at Range Top)."),
    action: createEnumPreprocessor(
        ['HOLD', 'ESCAPE_IMMEDIATELY', 'TIGHTEN_TP_TO_BE', 'SWITCH_TO_RANGE_CONTRA'],
        { 'close': 'ESCAPE_IMMEDIATELY', 'exit': 'ESCAPE_IMMEDIATELY', 'tighten': 'TIGHTEN_TP_TO_BE', 'switch': 'SWITCH_TO_RANGE_CONTRA', 'reverse': 'SWITCH_TO_RANGE_CONTRA' },
        'HOLD'
    ).describe("Recommended action. Use SWITCH_TO_RANGE_CONTRA only if 1 switch is allowed and profitable."),
    suggestedTargetPrice: coerceNumber.optional().nullable().describe("If TIGHTEN_TP_TO_BE, provide the new safe target price."),
    reasoning: z.string().describe("Explanation focused on range structure and reversion risk."),
});

// [NEW] SL Adjustment Schema (Legacy, can be deprecated in favor of positionRiskSchema)
export const slAdjustmentSchema = z.object({
    decision: createEnumPreprocessor(
        ['HOLD', 'TIGHTEN', 'WIDEN'], 
        { 'keep': 'HOLD', 'adjust': 'TIGHTEN', 'move': 'TIGHTEN' },
        'HOLD'
    ),
    newStopLossPrice: coerceNumber.optional().nullable().describe("The specific new SL price. Must be safer than Liquidation Price."),
    reasoning: z.string().describe("Logic based on 15m trend strength vs whipsaw risk."),
});

// --- Existing Schemas (Preserved & Modified) ---

export const positionHealthSchema = z.preprocess((val: any) => {
    if (typeof val !== 'object' || val === null) return val;
    const curr = { ...val };
    
    // Key Mapping (snake_case to camelCase & Synonyms)
    if (curr.recommendation && !curr.decision) curr.decision = curr.recommendation;
    if (curr.action && !curr.decision) curr.decision = curr.action; 
    
    if (curr.rationale && !curr.reasoning) curr.reasoning = curr.rationale;
    if (curr.analysis && !curr.reasoning) curr.reasoning = curr.analysis;
    if (curr.reason && !curr.reasoning) curr.reasoning = curr.reason;

    if (curr.risk_score !== undefined && curr.riskScore === undefined) curr.riskScore = curr.risk_score;
    
    if (curr.velocity_profile && !curr.velocityProfile) curr.velocityProfile = curr.velocity_profile;
    if (curr.trailing_speed && !curr.trailingSpeed) curr.trailingSpeed = curr.trailing_speed;

    if (curr.updates) {
        if (curr.updates.new_stop_loss && !curr.updates.newStopLoss) curr.updates.newStopLoss = curr.updates.new_stop_loss;
        if (curr.updates.add_quantity && !curr.updates.addQuantity) curr.updates.addQuantity = curr.updates.add_quantity;
    }

    if (curr.riskScore === undefined || curr.riskScore === null) {
        const d = String(curr.decision || '').toUpperCase();
        if (d.includes('CLOSE') || d.includes('SWITCH') || d.includes('DUMP')) curr.riskScore = 85;
        else if (d.includes('UPDATE') || d.includes('ADJUST')) curr.riskScore = 55;
        else curr.riskScore = 25; 
    }
    return curr;
}, z.object({
    decision: createEnumPreprocessor(
        ['HOLD', 'CLOSE_IMMEDIATELY', 'UPDATE_ORDERS', 'ADD_POSITION', 'SWITCH_TO_OPPORTUNITY', 'SWITCH_TO_REVERSE', 'EXTEND_TP', 'DUMP_NOW'],
        { 
            'close': 'CLOSE_IMMEDIATELY', 
            'update': 'UPDATE_ORDERS', 
            'pyramid': 'ADD_POSITION', 
            'add': 'ADD_POSITION',
            'switch': 'SWITCH_TO_OPPORTUNITY',
            'swap': 'SWITCH_TO_REVERSE', 
            'reverse': 'SWITCH_TO_REVERSE',
            'extend': 'EXTEND_TP',
            'dump': 'DUMP_NOW'
        },
        'HOLD'
    ),
    velocityProfile: createEnumPreprocessor(
        ['EXPLOSIVE_PUMP', 'STEADY_GRIND', 'CHOPPY_NOISE', 'REVERSAL_DANGER', 'SILENT_CRAWLER', 'NO_BOUNCE_SKYROCKET', 'NO_BOUNCE_SHEARING'],
        { 
            'pump': 'EXPLOSIVE_PUMP', 'grind': 'STEADY_GRIND', 'chop': 'CHOPPY_NOISE', 
            'danger': 'REVERSAL_DANGER', 'crawl': 'SILENT_CRAWLER',
            'nobounce_up': 'NO_BOUNCE_SKYROCKET', 'skyrocket': 'NO_BOUNCE_SKYROCKET',
            'nobounce_down': 'NO_BOUNCE_SHEARING', 'shearing': 'NO_BOUNCE_SHEARING'
        },
        'STEADY_GRIND'
    ).optional().describe("Character of the current price movement."),
    
    trailingSpeed: createEnumPreprocessor(
        ['FAST', 'NORMAL', 'SLOW'],
        { 'aggressive': 'FAST', 'standard': 'NORMAL', 'loose': 'SLOW' },
        'NORMAL'
    ).optional().describe("FAST: Tight SL for pumps. SLOW: Wide SL for grinds/retests."),

    reasoning: z.string().default("No reasoning provided."),
    updates: z.object({
        newStopLoss: coerceNumber.nullable().optional(),
        addQuantity: coerceNumber.nullable().optional(), 
        tpUpdates: z.array(z.object({
            index: coerceNumber, 
            newPrice: coerceNumber
        })).nullable().optional()
    }).nullable().optional(), 
    riskScore: z.preprocess(preprocessNumber, z.number().min(0).max(100)),
}));

// [NEW] AutoTuner Schema — Gemini AI 파라미터 조정 응답
export const autoTuneSchema = z.object({
    changes: z.array(z.object({
        parameter: z.string(),
        newValue: z.preprocess(preprocessNumber, z.number()),
        reason: z.string(),
    })),
    overallAssessment: z.string(),
});

// ★ v35: News Impact Assessment Schema (뉴스 방어 + FUD 역매매)
export const newsImpactSchema = z.object({
    impact: createEnumPreprocessor(
        ['NONE', 'FUD_OVERREACTION', 'MACRO_EVENT', 'CRISIS', 'BULLISH_CATALYST'],
        {
            'fud': 'FUD_OVERREACTION', 'overreaction': 'FUD_OVERREACTION', 'panic': 'FUD_OVERREACTION', 'rumor': 'FUD_OVERREACTION',
            'cpi': 'MACRO_EVENT', 'fomc': 'MACRO_EVENT', 'fed': 'MACRO_EVENT', 'macro': 'MACRO_EVENT', 'nfp': 'MACRO_EVENT',
            'hack': 'CRISIS', 'exploit': 'CRISIS', 'delist': 'CRISIS', 'ban': 'CRISIS', 'bankrupt': 'CRISIS', 'scam': 'CRISIS',
            'partner': 'BULLISH_CATALYST', 'listing': 'BULLISH_CATALYST', 'upgrade': 'BULLISH_CATALYST', 'etf': 'BULLISH_CATALYST',
            'normal': 'NONE', 'quiet': 'NONE', 'nothing': 'NONE',
        },
        'NONE'
    ),
    confidence: coerceNumber.describe("0-100 how confident in this assessment"),
    affectedTickers: z.array(z.string()).describe("List of tickers most affected (e.g. ['BTC','ETH','SOL'])"),
    dumpDirection: createEnumPreprocessor(
        ['LONG_DANGER', 'SHORT_DANGER', 'BOTH_DANGER', 'NEUTRAL'],
        { 'bearish': 'LONG_DANGER', 'bullish': 'SHORT_DANGER', 'both': 'BOTH_DANGER', 'none': 'NEUTRAL' },
        'NEUTRAL'
    ).describe("Which direction is dangerous? LONG_DANGER = price likely to drop"),
    severity: coerceNumber.describe("1-10 scale, 10 = most severe"),
    reasoning: z.string().describe("1-2 sentence explanation"),
    suggestedAction: createEnumPreprocessor(
        ['PROCEED', 'BLOCK_ENTRY', 'AGGRESSIVE_REVERSAL', 'REDUCE_SIZE', 'WIDEN_TP'],
        {
            'go': 'PROCEED', 'ok': 'PROCEED',
            'block': 'BLOCK_ENTRY', 'skip': 'BLOCK_ENTRY', 'stop': 'BLOCK_ENTRY',
            'reverse': 'AGGRESSIVE_REVERSAL', 'fade': 'AGGRESSIVE_REVERSAL',
            'reduce': 'REDUCE_SIZE', 'small': 'REDUCE_SIZE',
            'widen': 'WIDEN_TP', 'extend': 'WIDEN_TP',
        },
        'PROCEED'
    ),
});

export const performanceDiagnosticReportSchema = z.any();
export const symbolPersonalityReportSchema = z.any();
export const postTradeInsightsSchema = z.any();
export const missedEntryInsightsSchema = z.any();