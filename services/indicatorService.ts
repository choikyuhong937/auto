
// services/indicatorService.ts
import type { KlineData as IKlineData } from '../types';

export type KlineData = IKlineData;

export const calculateRSI = (closes: number[], period: number = 14): number[] => {
    const rsi: number[] = [];
    if (closes.length < period) return [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change; else losses -= change;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rs)));
    }
    return rsi;
};

// ATR (Average True Range)
export const calculateATR = (klines: KlineData[], period: number = 14): number[] => {
    if (klines.length < period + 1) return [];
    const tr: number[] = [];
    for (let i = 1; i < klines.length; i++) {
        const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    atr.push(sum / period);
    for (let i = period; i < tr.length; i++) {
        atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
    }
    return atr;
};

// [NEW] Choppiness Index (14 period)
// Values > 61.8 indicate consolidation (choppy), values < 38.2 indicate trend.
export const calculateChoppinessIndex = (klines: KlineData[], period: number = 14): number => {
    if (klines.length < period + 1) return 50;
    
    // Need period+1 candles to calculate period TRs
    const relevantKlines = klines.slice(-(period + 1));
    if (relevantKlines.length < period + 1) return 50;

    let trSum = 0;
    // Calculate Sum of TR over past 'period'
    for (let i = 1; i < relevantKlines.length; i++) {
        const h = relevantKlines[i].high;
        const l = relevantKlines[i].low;
        const pc = relevantKlines[i-1].close;
        const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        trSum += tr;
    }
    
    // Calculate Range (MaxHigh - MinLow) over 'period'
    const recent = klines.slice(-period);
    const highs = recent.map(k => k.high);
    const lows = recent.map(k => k.low);
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const range = maxHigh - minLow;
    
    if (range === 0) return 50;

    // Formula: 100 * LOG10(Sum(TR, n) / (MaxHigh(n) - MinLow(n))) / LOG10(n)
    const chop = 100 * Math.log10(trSum / range) / Math.log10(period);
    
    return isNaN(chop) ? 50 : chop;
};

// [NEW] Wick Ratio (Messiness Metric)
// Calculates Average Wick Ratio over body size
export const calculateWickRatio = (klines: KlineData[], period: number = 20): number => {
    if (klines.length < period) return 0;
    const recent = klines.slice(-period);
    let totalWick = 0;
    let totalRange = 0;

    for (const k of recent) {
        const body = Math.abs(k.close - k.open);
        const range = k.high - k.low;
        const wick = range - body; // Top wick + Bottom wick
        totalWick += wick;
        totalRange += range;
    }

    return totalRange > 0 ? totalWick / totalRange : 0;
};

// ADX (Average Directional Index)
export const calculateADX = (klines: KlineData[], period: number = 14): number[] => {
    if (klines.length < period * 2) return [];
    const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
    for (let i = 1; i < klines.length; i++) {
        const h = klines[i].high, l = klines[i].low, ph = klines[i-1].high, pl = klines[i-1].low, pc = klines[i-1].close;
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const um = h - ph, dm = pl - l;
        pdm.push(um > dm && um > 0 ? um : 0);
        mdm.push(dm > um && dm > 0 ? dm : 0);
    }
    const smooth = (data: number[], p: number) => {
        const s: number[] = [];
        let cur = 0;
        for (let i = 0; i < p; i++) cur += data[i];
        s.push(cur);
        for (let i = p; i < data.length; i++) s.push(s[s.length - 1] - (s[s.length - 1] / p) + data[i]);
        return s;
    };
    const str = smooth(tr, period), spdm = smooth(pdm, period), smdm = smooth(mdm, period);
    const dx: number[] = [];
    for (let i = 0; i < str.length; i++) {
        const pdi = (spdm[i] / str[i]) * 100, mdi = (smdm[i] / str[i]) * 100;
        dx.push(Math.abs(pdi - mdi) / (pdi + mdi) * 100);
    }
    const adx: number[] = [];
    let adxSum = 0;
    for (let i = 0; i < period; i++) adxSum += dx[i];
    adx.push(adxSum / period);
    for (let i = period; i < dx.length; i++) adx.push((adx[adx.length - 1] * (period - 1) + dx[i]) / period);
    return adx;
};

export const calculateEMA = (closes: number[], period: number): number[] => {
    if (closes.length < period) return [];
    const ema: number[] = [];
    const multiplier = 2 / (period + 1);
    let prevEma = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    ema.push(prevEma);
    for (let i = period; i < closes.length; i++) {
        const newEma = (closes[i] - prevEma) * multiplier + prevEma;
        ema.push(newEma);
        prevEma = newEma;
    }
    return ema;
};

export const calculateBollingerBands = (closes: number[], period: number = 20, stdDev: number = 2) => {
    const results = [];
    for (let i = period - 1; i < closes.length; i++) {
        const slice = closes.slice(i - period + 1, i + 1);
        const sma = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
        const sd = Math.sqrt(variance);
        results.push({ upper: sma + stdDev * sd, middle: sma, lower: sma - stdDev * sd });
    }
    return results;
};

export const calculateMACD = (closes: number[], fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9) => {
    if (closes.length < slowPeriod + signalPeriod) return [];

    const fastEMA = calculateEMA(closes, fastPeriod);
    const slowEMA = calculateEMA(closes, slowPeriod);
    
    const diff = slowPeriod - fastPeriod;
    const macdLine: number[] = [];
    
    for (let i = 0; i < slowEMA.length; i++) {
        if (i + diff < fastEMA.length) {
            macdLine.push(fastEMA[i + diff] - slowEMA[i]);
        }
    }
    
    const signalLine = calculateEMA(macdLine, signalPeriod);
    const result: { macd: number, signal: number, histogram: number }[] = [];
    
    for (let k = 0; k < signalLine.length; k++) {
        const m = macdLine[k + signalPeriod - 1];
        const s = signalLine[k];
        result.push({ macd: m, signal: s, histogram: m - s });
    }
    return result;
};

// [NEW] Stochastic Oscillator
export const calculateStochastic = (klines: KlineData[], period: number = 14, smoothK: number = 3): { k: number, d: number }[] => {
    if (klines.length < period) return [];
    
    const rawK: number[] = [];
    for (let i = period - 1; i < klines.length; i++) {
        const subset = klines.slice(i - period + 1, i + 1);
        const low = Math.min(...subset.map(k => k.low));
        const high = Math.max(...subset.map(k => k.high));
        const close = subset[subset.length - 1].close;
        
        const k = high === low ? 50 : ((close - low) / (high - low)) * 100;
        rawK.push(k);
    }

    // Smooth K (SMA)
    const smoothRawK = [];
    for (let i = smoothK - 1; i < rawK.length; i++) {
        const sum = rawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0);
        smoothRawK.push(sum / smoothK);
    }

    // Calculate D (SMA of Smooth K)
    const result = [];
    for (let i = smoothK - 1; i < smoothRawK.length; i++) {
        const sum = smoothRawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0);
        result.push({ k: smoothRawK[i], d: sum / smoothK });
    }
    
    return result;
};

// [NEW] Money Flow Index (MFI)
export const calculateMFI = (klines: KlineData[], period: number = 14): number[] => {
    if (klines.length < period + 1) return [];
    
    const typicalPrice = klines.map(k => (k.high + k.low + k.close) / 3);
    const rawMoneyFlow = typicalPrice.map((tp, i) => tp * klines[i].volume);
    
    const mfi: number[] = [];
    
    for (let i = period; i < klines.length; i++) {
        let posFlow = 0;
        let negFlow = 0;
        
        for (let j = i - period + 1; j <= i; j++) {
            if (typicalPrice[j] > typicalPrice[j - 1]) posFlow += rawMoneyFlow[j];
            else if (typicalPrice[j] < typicalPrice[j - 1]) negFlow += rawMoneyFlow[j];
        }
        
        const mfr = negFlow === 0 ? 100 : posFlow / negFlow;
        mfi.push(100 - (100 / (1 + mfr)));
    }
    return mfi;
};

// [NEW] Rate of Change (ROC)
export const calculateROC = (closes: number[], period: number = 9): number[] => {
    const roc: number[] = [];
    for (let i = period; i < closes.length; i++) {
        const prev = closes[i - period];
        if (prev === 0) roc.push(0);
        else roc.push(((closes[i] - prev) / prev) * 100);
    }
    return roc;
};

// [NEW] Slope Calculation (Percentage Change)
export const calculateSlope = (values: number[], lookback: number = 5): number => {
    if (values.length < lookback + 1) return 0;
    const current = values[values.length - 1];
    const past = values[values.length - 1 - lookback];
    if (past === 0) return 0;
    return ((current - past) / past) * 100;
};

// [NEW] Snapshot Calculation for Entry
export const calculateSnapshot = (klines: KlineData[]) => {
    if (klines.length < 20) return null;
    const closes = klines.map(k => k.close);
    const lastClose = closes[closes.length - 1];
    
    const rsi = calculateRSI(closes, 14).pop() || 50;
    const adx = calculateADX(klines, 14).pop() || 0;
    const ema20 = calculateEMA(closes, 20).pop() || lastClose;
    const bb = calculateBollingerBands(closes, 20, 2).pop();
    
    const emaGapPercent = ema20 !== 0 ? ((lastClose - ema20) / ema20) * 100 : 0;
    
    let bbPosition = 0.5;
    if (bb && (bb.upper - bb.lower) !== 0) {
        bbPosition = (lastClose - bb.lower) / (bb.upper - bb.lower);
    }

    return { 
        rsi, 
        adx, 
        emaGapPercent, 
        bbPosition,
        timestamp: klines[klines.length-1].time 
    };
};

// [NEW] Hurst Exponent
export const calculateHurstExponent = (data: number[]): number => {
    if (data.length < 100) return 0.5;

    const logReturns: number[] = [];
    for (let i = 1; i < data.length; i++) {
        logReturns.push(Math.log(data[i] / data[i - 1]));
    }

    const maxWindow = Math.floor(logReturns.length / 4);
    if (maxWindow < 8) return 0.5;

    const windowSizes = [8, 16, 32, 64].filter(w => w <= maxWindow);
    if (windowSizes.length < 2) return 0.5;

    const rsValues: number[] = [];

    for (const w of windowSizes) {
        const numChunks = Math.floor(logReturns.length / w);
        let sumRS = 0;

        for (let i = 0; i < numChunks; i++) {
            const start = i * w;
            const chunk = logReturns.slice(start, start + w);
            
            const mean = chunk.reduce((a, b) => a + b, 0) / w;
            const variance = chunk.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / w;
            const stdDev = Math.sqrt(variance);

            if (stdDev === 0) continue;

            const deviations = chunk.map(val => val - mean);
            let currentSum = 0;
            const cumulativeDeviations: number[] = [];
            for (const dev of deviations) {
                currentSum += dev;
                cumulativeDeviations.push(currentSum);
            }

            const maxDev = Math.max(...cumulativeDeviations);
            const minDev = Math.min(...cumulativeDeviations);
            const range = maxDev - minDev;

            sumRS += range / stdDev;
        }
        
        const avgRS = sumRS / numChunks;
        if (avgRS > 0) rsValues.push(avgRS);
    }

    if (rsValues.length !== windowSizes.length) return 0.5;

    const logN = windowSizes.map(Math.log);
    const logRS = rsValues.map(Math.log);

    const nLen = logN.length;
    const sumX = logN.reduce((a, b) => a + b, 0);
    const sumY = logRS.reduce((a, b) => a + b, 0);
    const sumXY = logN.map((x, i) => x * logRS[i]).reduce((a, b) => a + b, 0);
    const sumXX = logN.map(x => x * x).reduce((a, b) => a + b, 0);

    const slope = (nLen * sumXY - sumX * sumY) / (nLen * sumXX - sumX * sumX);
    
    return isNaN(slope) ? 0.5 : slope;
};

// [NEW] Fibonacci Retracement Levels
export const calculateFibonacciLevels = (
    swingHigh: number, swingLow: number
): { level: number, price: number }[] => {
    const diff = swingHigh - swingLow;
    return [
        { level: 0.236, price: swingLow + diff * 0.236 },
        { level: 0.382, price: swingLow + diff * 0.382 },
        { level: 0.500, price: swingLow + diff * 0.500 },
        { level: 0.618, price: swingLow + diff * 0.618 },
        { level: 0.786, price: swingLow + diff * 0.786 }
    ];
};

// ========== Phase 2: SMC Detection Functions ==========

/**
 * BOS (Break of Structure) 감지
 * Bullish BOS: 최근 swing high 이후 close > swing high → 상승 구조 확인
 * Bearish BOS: 최근 swing low 이후 close < swing low → 하락 구조 확인
 */
export function detectBOS(
    klines: KlineData[],
    swingHighs: { index: number; price: number }[],
    swingLows: { index: number; price: number }[],
): { detected: boolean; direction: 'BULLISH' | 'BEARISH' | null; level: number; index: number } {
    const result = { detected: false, direction: null as 'BULLISH' | 'BEARISH' | null, level: 0, index: 0 };
    if (klines.length < 10) return result;

    // 최근 30캔들 내 swing point만 사용
    const cutoff = Math.max(0, klines.length - 30);
    const recentHighs = swingHighs.filter(s => s.index >= cutoff).sort((a, b) => a.index - b.index);
    const recentLows = swingLows.filter(s => s.index >= cutoff).sort((a, b) => a.index - b.index);

    // Bullish BOS: close above most recent swing high
    if (recentHighs.length >= 1) {
        const latestSH = recentHighs[recentHighs.length - 1];
        for (let i = latestSH.index + 1; i < klines.length; i++) {
            if (klines[i].close > latestSH.price) {
                result.detected = true;
                result.direction = 'BULLISH';
                result.level = latestSH.price;
                result.index = i;
                break;
            }
        }
    }

    // Bearish BOS: close below most recent swing low (only if no bullish BOS)
    if (!result.detected && recentLows.length >= 1) {
        const latestSL = recentLows[recentLows.length - 1];
        for (let i = latestSL.index + 1; i < klines.length; i++) {
            if (klines[i].close < latestSL.price) {
                result.detected = true;
                result.direction = 'BEARISH';
                result.level = latestSL.price;
                result.index = i;
                break;
            }
        }
    }

    return result;
}

/**
 * CHoCH (Change of Character) 감지
 * 하락추세(LH+LL) 중 close > swing high → Bullish CHoCH (추세 전환)
 * 상승추세(HH+HL) 중 close < swing low → Bearish CHoCH (추세 전환)
 */
export function detectCHoCH(
    klines: KlineData[],
    swingHighs: { index: number; price: number }[],
    swingLows: { index: number; price: number }[],
): { detected: boolean; direction: 'BULLISH' | 'BEARISH' | null; level: number; prevTrend: 'UP' | 'DOWN' | null } {
    const result = { detected: false, direction: null as 'BULLISH' | 'BEARISH' | null, level: 0, prevTrend: null as 'UP' | 'DOWN' | null };

    const cutoff = Math.max(0, klines.length - 40);
    const rH = swingHighs.filter(s => s.index >= cutoff).sort((a, b) => a.index - b.index);
    const rL = swingLows.filter(s => s.index >= cutoff).sort((a, b) => a.index - b.index);

    if (rH.length < 2 || rL.length < 2) return result;

    // 하락추세 체크: Lower Highs + Lower Lows
    const isDowntrend = rH[rH.length - 1].price < rH[rH.length - 2].price &&
                        rL[rL.length - 1].price < rL[rL.length - 2].price;

    if (isDowntrend) {
        const targetHigh = rH[rH.length - 1].price;
        for (let i = rH[rH.length - 1].index + 1; i < klines.length; i++) {
            if (klines[i].close > targetHigh) {
                return { detected: true, direction: 'BULLISH', level: targetHigh, prevTrend: 'DOWN' };
            }
        }
    }

    // 상승추세 체크: Higher Highs + Higher Lows
    const isUptrend = rH[rH.length - 1].price > rH[rH.length - 2].price &&
                      rL[rL.length - 1].price > rL[rL.length - 2].price;

    if (isUptrend) {
        const targetLow = rL[rL.length - 1].price;
        for (let i = rL[rL.length - 1].index + 1; i < klines.length; i++) {
            if (klines[i].close < targetLow) {
                return { detected: true, direction: 'BEARISH', level: targetLow, prevTrend: 'UP' };
            }
        }
    }

    return result;
}

/**
 * Order Block 감지
 * Bullish OB: 음봉 직후 1.5×ATR 이상 상승 impulse → 그 음봉이 OB
 * Bearish OB: 양봉 직후 1.5×ATR 이상 하락 impulse → 그 양봉이 OB
 */
export function detectOrderBlocks(
    klines: KlineData[],
    atr: number,
    lookback: number = 30,
): import('../types').OrderBlock[] {
    const blocks: import('../types').OrderBlock[] = [];
    if (klines.length < 5 || atr <= 0) return blocks;

    const start = Math.max(1, klines.length - lookback);

    for (let i = start; i < klines.length - 3; i++) {
        const candle = klines[i];

        // Bullish OB: 음봉 → bullish impulse
        if (candle.close < candle.open) {
            const impulseHigh = Math.max(klines[i + 1].high, klines[i + 2].high,
                i + 3 < klines.length ? klines[i + 3].high : 0);
            const impulseMove = impulseHigh - candle.low;

            if (impulseMove > 1.5 * atr) {
                // Mitigation 체크: OB 이후 가격이 OB high에 도달했는지
                let mitigated = false;
                for (let j = i + 3; j < klines.length; j++) {
                    if (klines[j].low <= candle.high) {
                        mitigated = true;
                        break;
                    }
                }
                blocks.push({
                    type: 'BULLISH', high: candle.high, low: candle.low,
                    index: i, impulseStrength: impulseMove / atr, mitigated,
                });
            }
        }

        // Bearish OB: 양봉 → bearish impulse
        if (candle.close > candle.open) {
            const impulseLow = Math.min(klines[i + 1].low, klines[i + 2].low,
                i + 3 < klines.length ? klines[i + 3].low : Infinity);
            const impulseMove = candle.high - impulseLow;

            if (impulseMove > 1.5 * atr) {
                let mitigated = false;
                for (let j = i + 3; j < klines.length; j++) {
                    if (klines[j].high >= candle.low) {
                        mitigated = true;
                        break;
                    }
                }
                blocks.push({
                    type: 'BEARISH', high: candle.high, low: candle.low,
                    index: i, impulseStrength: impulseMove / atr, mitigated,
                });
            }
        }
    }

    // 미티게이트되지 않은 것만, 최신순
    return blocks.filter(b => !b.mitigated).sort((a, b) => b.index - a.index);
}

/**
 * FVG 강도 분류 — impulse 크기 / ATR 기반
 * strong FVG: impulse > 2×ATR
 */
export function classifyFVGStrength(
    fvgs: { type: 'bullish' | 'bearish'; high: number; low: number; midpoint: number; index: number }[],
    klines: KlineData[],
    atr: number,
): ({ type: 'bullish' | 'bearish'; high: number; low: number; midpoint: number; index: number } & { isStrong: boolean; impulseMultiple: number })[] {
    if (atr <= 0) return fvgs.map(f => ({ ...f, isStrong: false, impulseMultiple: 0 }));

    return fvgs.map(fvg => {
        // FVG의 중간 캔들(impulse)의 range
        const impulseIdx = fvg.index - 1;
        if (impulseIdx < 0 || impulseIdx >= klines.length) {
            return { ...fvg, isStrong: false, impulseMultiple: 0 };
        }
        const impulseRange = klines[impulseIdx].high - klines[impulseIdx].low;
        const multiple = impulseRange / atr;
        return { ...fvg, isStrong: multiple > 2.0, impulseMultiple: multiple };
    });
}

// ========== Phase 2: VWAP ==========

/**
 * VWAP (Volume Weighted Average Price) + 밴드 계산
 * TP = (H+L+C)/3, VWAP = Σ(TP×V) / Σ(V)
 */
export function calculateVWAP(
    klines: KlineData[],
    period: number = 24,
): { vwap: number; upperBand: number; lowerBand: number; stdDev: number } | null {
    if (klines.length < period) return null;

    const recent = klines.slice(-period);
    let sumTPV = 0;
    let sumV = 0;

    for (const k of recent) {
        const tp = (k.high + k.low + k.close) / 3;
        sumTPV += tp * k.volume;
        sumV += k.volume;
    }

    if (sumV === 0) return null;

    const vwap = sumTPV / sumV;

    // Standard deviation
    let sumVariance = 0;
    for (const k of recent) {
        const tp = (k.high + k.low + k.close) / 3;
        sumVariance += k.volume * Math.pow(tp - vwap, 2);
    }
    const stdDev = Math.sqrt(sumVariance / sumV);

    return {
        vwap,
        upperBand: vwap + 2 * stdDev,
        lowerBand: vwap - 2 * stdDev,
        stdDev,
    };
}

// ========== Phase 3: WaveTrend Oscillator ==========

/**
 * WaveTrend 오실레이터 (LazyBear 알고리즘)
 * hl2 = (high + low) / 2
 * esa = EMA(hl2, channelLen)
 * d = EMA(|hl2 - esa|, channelLen)
 * ci = (hl2 - esa) / (0.015 × d)
 * wt1 = EMA(ci, avgLen)
 * wt2 = SMA(wt1, 4)
 */
export function calculateWaveTrend(
    klines: KlineData[],
    channelLen: number = 10,
    avgLen: number = 21,
): import('../types').WaveTrendData | null {
    const minLen = channelLen + avgLen + 10;
    if (klines.length < minLen) return null;

    const hl2 = klines.map(k => (k.high + k.low) / 2);

    // EMA helper (반복 계산)
    const emaCalc = (src: number[], period: number): number[] => {
        if (src.length < period) return [];
        const k = 2 / (period + 1);
        const result: number[] = [];
        // SMA seed
        let prev = 0;
        for (let i = 0; i < period; i++) prev += src[i];
        prev /= period;
        result.push(prev);
        for (let i = period; i < src.length; i++) {
            prev = src[i] * k + prev * (1 - k);
            result.push(prev);
        }
        return result;
    };

    // esa = EMA(hl2, channelLen)
    const esa = emaCalc(hl2, channelLen);
    if (esa.length === 0) return null;

    // d = EMA(|hl2 - esa|, channelLen)
    // esa는 hl2[channelLen-1]부터 시작 → 인덱스 오프셋 = channelLen - 1
    const absD: number[] = [];
    for (let i = 0; i < esa.length; i++) {
        absD.push(Math.abs(hl2[i + channelLen - 1] - esa[i]));
    }
    const d = emaCalc(absD, channelLen);
    if (d.length === 0) return null;

    // ci = (hl2 - esa) / (0.015 * d)
    // d는 absD[channelLen-1]부터 시작, absD는 esa 기준 → 총 오프셋 = 2*(channelLen-1)
    const ciOffset = channelLen - 1;  // d의 오프셋 within esa
    const ci: number[] = [];
    for (let i = 0; i < d.length; i++) {
        const esaIdx = i + ciOffset;
        const hl2Idx = esaIdx + channelLen - 1;
        const denom = 0.015 * d[i];
        ci.push(denom !== 0 ? (hl2[hl2Idx] - esa[esaIdx]) / denom : 0);
    }

    // wt1 = EMA(ci, avgLen)
    const wt1Arr = emaCalc(ci, avgLen);
    if (wt1Arr.length < 4) return null;

    // wt2 = SMA(wt1, 4)
    const wt2Arr: number[] = [];
    for (let i = 3; i < wt1Arr.length; i++) {
        wt2Arr.push((wt1Arr[i] + wt1Arr[i - 1] + wt1Arr[i - 2] + wt1Arr[i - 3]) / 4);
    }
    if (wt2Arr.length < 2) return null;

    const wt1 = wt1Arr[wt1Arr.length - 1];
    const wt2 = wt2Arr[wt2Arr.length - 1];
    const prevWt1 = wt1Arr[wt1Arr.length - 2];
    const prevWt2 = wt2Arr[wt2Arr.length - 2];

    return {
        wt1,
        wt2,
        momentum: wt1 - wt2,
        crossUp: prevWt1 <= prevWt2 && wt1 > wt2,
        crossDown: prevWt1 >= prevWt2 && wt1 < wt2,
        isOverbought: wt1 > 60,
        isOversold: wt1 < -60,
    };
}

// ========== Phase 3: Ichimoku Cloud ==========

/**
 * Ichimoku Kinko Hyo (표준 설정)
 * tenkan = (highest(high,9) + lowest(low,9)) / 2
 * kijun  = (highest(high,26) + lowest(low,26)) / 2
 * spanA  = (tenkan + kijun) / 2
 * spanB  = (highest(high,52) + lowest(low,52)) / 2
 */
export function calculateIchimoku(
    klines: KlineData[],
    tenkanPeriod: number = 9,
    kijunPeriod: number = 26,
    senkouBPeriod: number = 52,
): import('../types').IchimokuData | null {
    if (klines.length < senkouBPeriod) return null;

    const highLowMid = (data: KlineData[], period: number, endIdx: number): number => {
        const start = Math.max(0, endIdx - period + 1);
        let hi = -Infinity, lo = Infinity;
        for (let i = start; i <= endIdx; i++) {
            if (data[i].high > hi) hi = data[i].high;
            if (data[i].low < lo) lo = data[i].low;
        }
        return (hi + lo) / 2;
    };

    const last = klines.length - 1;
    const prev = last - 1;

    // Current values
    const tenkanSen = highLowMid(klines, tenkanPeriod, last);
    const kijunSen = highLowMid(klines, kijunPeriod, last);
    const senkouSpanA = (tenkanSen + kijunSen) / 2;
    const senkouSpanB = highLowMid(klines, senkouBPeriod, last);

    // Previous values (for TK cross detection)
    const prevTenkan = highLowMid(klines, tenkanPeriod, prev);
    const prevKijun = highLowMid(klines, kijunPeriod, prev);

    const cloudTop = Math.max(senkouSpanA, senkouSpanB);
    const cloudBottom = Math.min(senkouSpanA, senkouSpanB);
    const price = klines[last].close;
    const cloudThickness = price > 0 ? ((cloudTop - cloudBottom) / price) * 100 : 0;

    // Price vs Cloud
    let priceVsCloud: 'ABOVE' | 'BELOW' | 'IN_CLOUD' = 'IN_CLOUD';
    if (price > cloudTop) priceVsCloud = 'ABOVE';
    else if (price < cloudBottom) priceVsCloud = 'BELOW';

    // TK Cross
    let tkCross: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (prevTenkan <= prevKijun && tenkanSen > kijunSen) tkCross = 'BULLISH';
    else if (prevTenkan >= prevKijun && tenkanSen < kijunSen) tkCross = 'BEARISH';

    // Cloud Color
    const cloudColor: 'GREEN' | 'RED' = senkouSpanA > senkouSpanB ? 'GREEN' : 'RED';

    return {
        tenkanSen,
        kijunSen,
        senkouSpanA,
        senkouSpanB,
        cloudTop,
        cloudBottom,
        cloudThickness,
        priceVsCloud,
        tkCross,
        cloudColor,
    };
}

// [NEW] Fair Value Gap (FVG) Detection
export const detectFairValueGaps = (
    klines: KlineData[], lookback: number = 30
): { type: 'bullish' | 'bearish', high: number, low: number, midpoint: number, index: number }[] => {
    const gaps: { type: 'bullish' | 'bearish', high: number, low: number, midpoint: number, index: number }[] = [];
    const start = Math.max(2, klines.length - lookback);
    for (let i = start; i < klines.length; i++) {
        // Bullish FVG: candle[i-2].high < candle[i].low (gap up)
        if (klines[i - 2].high < klines[i].low) {
            gaps.push({
                type: 'bullish',
                high: klines[i].low,
                low: klines[i - 2].high,
                midpoint: (klines[i].low + klines[i - 2].high) / 2,
                index: i
            });
        }
        // Bearish FVG: candle[i-2].low > candle[i].high (gap down)
        if (klines[i - 2].low > klines[i].high) {
            gaps.push({
                type: 'bearish',
                high: klines[i - 2].low,
                low: klines[i].high,
                midpoint: (klines[i - 2].low + klines[i].high) / 2,
                index: i
            });
        }
    }
    return gaps;
};

// ★ 1m 캔들 → 상위 TF 집계 (15m, 1h 등) — 백테스트 MTF용
export function aggregateCandles(klines1m: KlineData[], targetMinutes: number): KlineData[] {
    if (klines1m.length === 0 || targetMinutes <= 1) return klines1m;
    const msPerBar = targetMinutes * 60_000;
    const result: KlineData[] = [];
    let bucket: KlineData[] = [];
    let currentBoundary = -1;

    for (const k of klines1m) {
        const boundary = Math.floor(k.time / msPerBar) * msPerBar;
        if (boundary !== currentBoundary) {
            if (bucket.length > 0) {
                result.push({
                    time: currentBoundary,
                    open: bucket[0].open,
                    high: Math.max(...bucket.map(b => b.high)),
                    low: Math.min(...bucket.map(b => b.low)),
                    close: bucket[bucket.length - 1].close,
                    volume: bucket.reduce((s, b) => s + b.volume, 0),
                });
            }
            bucket = [k];
            currentBoundary = boundary;
        } else {
            bucket.push(k);
        }
    }
    // 마지막 완성된 버킷만 포함 (미완성 제외)
    if (bucket.length >= targetMinutes) {
        result.push({
            time: currentBoundary,
            open: bucket[0].open,
            high: Math.max(...bucket.map(b => b.high)),
            low: Math.min(...bucket.map(b => b.low)),
            close: bucket[bucket.length - 1].close,
            volume: bucket.reduce((s, b) => s + b.volume, 0),
        });
    }
    return result;
}

// ★ Trap 전략: Pivot Point 기반 S/R 감지
export function detectSRLevels(
    klines: KlineData[],
    currentIdx: number,
    lookback: number = 100,
    pivotStrength: number = 5,
): { support: number; resistance: number } {
    const start = Math.max(0, currentIdx - lookback);
    const end = currentIdx;
    const price = klines[currentIdx]?.close ?? 0;
    let nearestSupport = 0;
    let nearestResistance = Infinity;

    for (let i = start + pivotStrength; i < end - pivotStrength; i++) {
        let isHigh = true;
        let isLow = true;
        for (let j = 1; j <= pivotStrength; j++) {
            if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
            if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
            if (!isHigh && !isLow) break;
        }
        if (isHigh && klines[i].high > price && klines[i].high < nearestResistance) {
            nearestResistance = klines[i].high;
        }
        if (isLow && klines[i].low < price && klines[i].low > nearestSupport) {
            nearestSupport = klines[i].low;
        }
    }
    if (nearestSupport === 0) {
        nearestSupport = Math.min(...klines.slice(start, end + 1).map(k => k.low));
    }
    if (nearestResistance === Infinity) {
        nearestResistance = Math.max(...klines.slice(start, end + 1).map(k => k.high));
    }
    return { support: nearestSupport, resistance: nearestResistance };
}

// ★ Trap 전략: Submarine 패턴 감지 (S/R 돌파 → 재탈환 = V-shape)
export function detectSubmarinePattern(
    klines: KlineData[],
    currentIdx: number,
    support: number,
    resistance: number,
    maxLookbackBars: number = 30,
): { detected: boolean; side: 'Long' | 'Short' | null; breakPercent: number; reclaimBarsAgo: number } {
    const current = klines[currentIdx];
    if (!current) return { detected: false, side: null, breakPercent: 0, reclaimBarsAgo: 0 };
    const start = Math.max(0, currentIdx - maxLookbackBars);

    // Long Submarine: support 아래 돌파 후 재탈환
    for (let i = currentIdx - 1; i >= start; i--) {
        const bar = klines[i];
        if (bar.low < support) {
            const breakPct = ((support - bar.low) / support) * 100;
            if (breakPct > 1.5) continue;
            if (current.close > support) {
                return { detected: true, side: 'Long', breakPercent: breakPct, reclaimBarsAgo: currentIdx - i };
            }
        }
    }
    // Short Submarine: resistance 위 돌파 후 재탈환
    for (let i = currentIdx - 1; i >= start; i--) {
        const bar = klines[i];
        if (bar.high > resistance) {
            const breakPct = ((bar.high - resistance) / resistance) * 100;
            if (breakPct > 1.5) continue;
            if (current.close < resistance) {
                return { detected: true, side: 'Short', breakPercent: breakPct, reclaimBarsAgo: currentIdx - i };
            }
        }
    }
    return { detected: false, side: null, breakPercent: 0, reclaimBarsAgo: 0 };
}

// ★ Trap 전략: EMA20 크로스 빈도 (높을수록 messy/choppy)
export function countEmaCrossings(closes: number[], ema20: number[], currentIdx: number, lookback: number = 50): number {
    const start = Math.max(0, currentIdx - lookback);
    let crossings = 0;
    for (let i = start + 1; i <= currentIdx; i++) {
        if (i >= ema20.length || i - 1 >= ema20.length) continue;
        const prevAbove = closes[i - 1] > ema20[i - 1];
        const currAbove = closes[i] > ema20[i];
        if (prevAbove !== currAbove) crossings++;
    }
    return crossings;
}

/** ★ Wick Fishing: 위킹 비율 상세 계산 (최근 lookback 바의 위킹 통계) */
export function calculateWickRatioDetailed(klines: any[], idx: number, lookback: number = 10): { avgWickRatio: number; lastUpperWick: number; lastLowerWick: number } {
    const start = Math.max(0, idx - lookback + 1);
    let totalWickRatio = 0;
    let count = 0;
    for (let i = start; i <= idx; i++) {
        const k = klines[i];
        const high = parseFloat(k.high ?? k[2]);
        const low = parseFloat(k.low ?? k[3]);
        const open = parseFloat(k.open ?? k[1]);
        const close = parseFloat(k.close ?? k[4]);
        const range = high - low;
        if (range <= 0) continue;
        const body = Math.abs(close - open);
        const wickTotal = range - body;
        totalWickRatio += wickTotal / range;
        count++;
    }
    // Last candle wick details
    const lastK = klines[idx];
    const lHigh = parseFloat(lastK.high ?? lastK[2]);
    const lLow = parseFloat(lastK.low ?? lastK[3]);
    const lOpen = parseFloat(lastK.open ?? lastK[1]);
    const lClose = parseFloat(lastK.close ?? lastK[4]);
    const lRange = lHigh - lLow;
    const bodyTop = Math.max(lOpen, lClose);
    const bodyBottom = Math.min(lOpen, lClose);
    const lastUpperWick = lRange > 0 ? (lHigh - bodyTop) / lRange : 0;
    const lastLowerWick = lRange > 0 ? (bodyBottom - lLow) / lRange : 0;
    return {
        avgWickRatio: count > 0 ? totalWickRatio / count : 0,
        lastUpperWick,
        lastLowerWick,
    };
}

/** ★ Flow: 추세 연속성 비율 (최근 lookback 바 중 direction과 같은 방향 비율) */
export function calculateTrendContinuity(klines: any[], idx: number, direction: 'Long' | 'Short', lookback: number = 10): number {
    const start = Math.max(0, idx - lookback + 1);
    let sameDir = 0;
    let total = 0;
    for (let i = start; i <= idx; i++) {
        const k = klines[i];
        const open = parseFloat(k.open ?? k[1]);
        const close = parseFloat(k.close ?? k[4]);
        total++;
        if (direction === 'Long' && close > open) sameDir++;
        else if (direction === 'Short' && close < open) sameDir++;
    }
    return total > 0 ? sameDir / total : 0;
}
