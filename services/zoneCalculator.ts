// services/zoneCalculator.ts
// 코드 기반 존 계산기 - Gemini AI의 analyzeTrendAndZone을 대체
// 실제 차트 데이터(EMA, BB, ATR, Swing Points, Fibonacci, FVG)에 기반한 결정론적 존 생성

import type { KlineData, SMCContext, OrderBlock } from '../types';
import {
    calculateEMA,
    calculateBollingerBands,
    calculateATR,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    // calculateHurstExponent, // [FIX-I2] 제거 — zone 계산에 미사용
    calculateFibonacciLevels,
    detectFairValueGaps,
    // Phase 2: SMC
    detectBOS,
    detectCHoCH,
    detectOrderBlocks,
    classifyFVGStrength,
} from './indicatorService';

// ===== Type Definitions =====

export interface SwingPoint {
    index: number;
    price: number;
    timestamp: number;
}

export type ZoneStrategyType =
    'PULLBACK' | 'BREAKOUT' |
    'TOP_REVERSAL' |
    'BOS_RETEST';  // Phase 2: SMC

export interface EntryZone {
    type: ZoneStrategyType;
    minPrice: number;
    maxPrice: number;
    reasoning?: string;
}

interface FairValueGap {
    type: 'bullish' | 'bearish';
    high: number;
    low: number;
    midpoint: number;
    index: number;
}

interface IndicatorBundle {
    currentPrice: number;
    closes: number[];
    klines: KlineData[];
    ema20: number;
    ema50: number;
    ema200: number;
    bb: { upper: number; middle: number; lower: number };
    atr: number;
    atrPercent: number;
    rsi: number;
    adx: number;
    pdi: number;
    mdi: number;
    macd: { line: number; signal: number; histogram: number };
    stoch: { k: number; d: number };
    hurst: number;
    swingHighs: SwingPoint[];
    swingLows: SwingPoint[];
    fibLevels: { level: number; price: number }[];
    fvgs: FairValueGap[];
    zScore: number;
    volumeNodes: VolumeNode[]; // 고거래량 가격대
    // Phase 2: SMC
    smcContext: SMCContext;
}

export interface ZoneCalculatorResult {
    zones: EntryZone[];
    marketPhase: string;
    reasoning: string;
    expectedReward: number;
    // Phase 2: SMC context (execution snapshot용)
    smcContext?: SMCContext;
}

// ===== Phase 2: SMC Context Builder =====

function buildSMCContext(
    klines: KlineData[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    atr: number,
    fvgs: FairValueGap[]
): SMCContext {
    const swingHighsMapped = swingHighs.map(s => ({ index: s.index, price: s.price }));
    const swingLowsMapped = swingLows.map(s => ({ index: s.index, price: s.price }));

    const bos = detectBOS(klines, swingHighsMapped, swingLowsMapped);
    const choch = detectCHoCH(klines, swingHighsMapped, swingLowsMapped);
    const orderBlocks = detectOrderBlocks(klines, atr);
    const classifiedFvgs = classifyFVGStrength(
        fvgs.map(f => ({ ...f })),
        klines,
        atr
    );

    return {
        bosDetected: bos.detected,
        bosDirection: bos.direction,
        bosLevel: bos.level,
        bosIndex: bos.index,
        chochDetected: choch.detected,
        chochDirection: choch.direction,
        chochLevel: choch.level,
        prevTrendDirection: choch.prevTrend,
        orderBlocks,
        strongFvgCount: classifiedFvgs.filter(f => f.isStrong).length,
        weakFvgCount: classifiedFvgs.filter(f => !f.isStrong).length,
    };
}

// ===== Indicator Bundle Builder =====

function buildIndicatorBundle(
    klines: KlineData[],
    dmi: { pdi: number; mdi: number; adx: number },
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[]
): IndicatorBundle {
    const closes = klines.map(k => k.close);
    const currentPrice = closes[closes.length - 1];

    // EMA
    const ema20Arr = calculateEMA(closes, 20);
    const ema50Arr = calculateEMA(closes, 50);
    const ema200Arr = calculateEMA(closes, 200);
    const ema20 = ema20Arr[ema20Arr.length - 1] || currentPrice;
    const ema50 = ema50Arr[ema50Arr.length - 1] || currentPrice;
    const ema200 = ema200Arr[ema200Arr.length - 1] || currentPrice;

    // Bollinger Bands
    const bbArr = calculateBollingerBands(closes, 20, 2);
    const bb = bbArr[bbArr.length - 1] || { upper: currentPrice, middle: currentPrice, lower: currentPrice };

    // ATR
    const atrArr = calculateATR(klines, 14);
    const atr = atrArr[atrArr.length - 1] || currentPrice * 0.01;
    const atrPercent = atr / currentPrice;

    // RSI
    const rsiArr = calculateRSI(closes, 14);
    const rsi = rsiArr[rsiArr.length - 1] || 50;

    // MACD
    const macdResult = calculateMACD(closes, 12, 26, 9);
    const lastMacd = macdResult[macdResult.length - 1] || { macd: 0, signal: 0, histogram: 0 };
    const macd = { line: lastMacd.macd, signal: lastMacd.signal, histogram: lastMacd.histogram };

    // Stochastic
    const stochArr = calculateStochastic(klines, 14, 3);
    const stoch = stochArr[stochArr.length - 1] || { k: 50, d: 50 };

    // [FIX-I2] Hurst 제거 — tradingEngine H1과 동일, zone 계산에 미사용
    const hurst = 0.5;

    // Fibonacci — 최근 스윙 하이/로우에서 계산
    const recentHighs = swingHighs.filter(s => s.index >= klines.length - 30);
    const recentLows = swingLows.filter(s => s.index >= klines.length - 30);

    let fibLevels: { level: number; price: number }[] = [];
    if (recentHighs.length > 0 && recentLows.length > 0) {
        const highestSwing = Math.max(...recentHighs.map(s => s.price));
        const lowestSwing = Math.min(...recentLows.map(s => s.price));
        if (highestSwing > lowestSwing) {
            fibLevels = calculateFibonacciLevels(highestSwing, lowestSwing);
        }
    }

    // FVG
    const fvgs = detectFairValueGaps(klines, 30);

    // Z-Score
    const stdDev = (bb.upper - bb.middle) / 2;
    const zScore = stdDev > 0 ? (currentPrice - bb.middle) / stdDev : 0;

    // Volume Profile — 고거래량 가격대 감지
    const volumeNodes = findHighVolumeNodes(klines);

    // Phase 2: SMC Context 빌드
    const smcContext = buildSMCContext(klines, swingHighs, swingLows, atr, fvgs);

    return {
        currentPrice, closes, klines,
        ema20, ema50, ema200,
        bb, atr, atrPercent,
        rsi, adx: dmi.adx, pdi: dmi.pdi, mdi: dmi.mdi,
        macd, stoch, hurst,
        swingHighs, swingLows,
        fibLevels, fvgs, zScore,
        volumeNodes,
        smcContext,
    };
}

// ===== Strategy Selection =====

function selectZoneStrategies(
    bundle: IndicatorBundle,
    direction: 'Long' | 'Short',
    strategy: 'TREND' | 'REVERSION',
    regime: string
): ZoneStrategyType[] {
    const strategies: ZoneStrategyType[] = [];
    const { currentPrice, ema20, ema50, adx, rsi, macd, zScore, fvgs } = bundle;

    if (strategy === 'TREND') {
        if (direction === 'Long') {
            // 가격이 EMA20 위에 있으면 → 되돌림 대기 (PULLBACK)
            if (currentPrice > ema20) {
                strategies.push('PULLBACK');
            }
            // 가격이 EMA20 아래지만 EMA50 위 → EMA50 되돌림
            else if (currentPrice > ema50) {
                strategies.push('PULLBACK');
            }

            // ADX 강하고 모멘텀 양수 → BREAKOUT
            if (adx > 30 && macd.histogram > 0) {
                strategies.push('BREAKOUT');
            }
        } else {
            // Short 추세
            if (currentPrice < ema20) {
                strategies.push('PULLBACK');
            } else if (currentPrice < ema50) {
                strategies.push('PULLBACK');
            }

            if (adx > 30 && macd.histogram < 0) {
                strategies.push('BREAKOUT');
            }
        }
    } else {
        // REVERSION — 평균회귀/역추세: 다양한 조건에서 존 생성
        if (direction === 'Short') {
            if (rsi > 55 || zScore > 0.5) {
                strategies.push('TOP_REVERSAL');
            }
            // 가격이 EMA20 위면 되돌림 숏도 가능
            if (currentPrice > ema20) {
                strategies.push('PULLBACK');
            }
        }
        if (direction === 'Long') {
            // 가격이 EMA20 아래면 되돌림 롱도 가능
            if (currentPrice < ema20) {
                strategies.push('PULLBACK');
            }
        }
        // REVERSION 기본 전략: 조건 불충족해도 PULLBACK 허용
        if (strategies.length === 0) {
            strategies.push('PULLBACK');
        }
    }

    // Phase 2: BOS_RETEST 전략 추가
    const { smcContext } = bundle;
    if (smcContext.bosDetected) {
        if ((direction === 'Long' && smcContext.bosDirection === 'BULLISH') ||
            (direction === 'Short' && smcContext.bosDirection === 'BEARISH')) {
            if (!strategies.includes('BOS_RETEST')) strategies.push('BOS_RETEST');
        }
    }

    // Phase 2: CHoCH → 리버설 전략 부스트 (CHoCH 발생 시 해당 방향 리버설을 0번 인덱스로)
    if (smcContext.chochDetected) {
        if (direction === 'Short' && smcContext.chochDirection === 'BEARISH') {
            const topIdx = strategies.indexOf('TOP_REVERSAL');
            if (topIdx > 0) {
                strategies.splice(topIdx, 1);
                strategies.unshift('TOP_REVERSAL');
            }
        }
    }

    // 최소 보장: 전략이 비어있으면 기본 PULLBACK
    if (strategies.length === 0) {
        strategies.push(strategy === 'TREND' ? 'PULLBACK' :
                        direction === 'Long' ? 'PULLBACK' : 'TOP_REVERSAL');
    }

    // 최대 3개 존만 반환 (Phase 2: 2→3 확장, SMC 전략 수용)
    return strategies.slice(0, 3);
}

// ===== Zone Calculators by Type =====

function calculatePullbackZone(bundle: IndicatorBundle, direction: 'Long' | 'Short'): EntryZone | null {
    const { currentPrice, ema20, ema50, atr, fibLevels, volumeNodes } = bundle;

    if (direction === 'Long') {
        // 기본: EMA20 근처 되돌림
        let anchor = ema20;
        let anchorLabel = 'EMA20';

        // 가격이 이미 EMA20 아래면 EMA50 사용
        if (currentPrice < ema20 && ema50 < currentPrice) {
            anchor = ema50;
            anchorLabel = 'EMA50';
        }

        // Fibonacci 38.2%가 있으면 비교해서 가까운 것 선택
        const fib382 = fibLevels.find(f => f.level === 0.382);
        if (fib382 && Math.abs(fib382.price - currentPrice) < Math.abs(anchor - currentPrice)) {
            anchor = fib382.price;
            anchorLabel = 'Fib 38.2%';
        }

        // Volume Profile 보정: 고거래량 가격대로 앵커 이동
        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${volumeNodeUsed.price.toFixed(4)},${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        const minPrice = anchor - atr * 0.3;
        const maxPrice = anchor + atr * 0.2;

        return {
            type: 'PULLBACK',
            minPrice: Math.max(minPrice, currentPrice * 0.95), // 최대 5% 아래까지
            maxPrice,
            reasoning: `Long Pullback to ${anchorLabel}(${anchor.toFixed(4)}) ± ATR(${atr.toFixed(4)})`
        };
    } else {
        // Short Pullback
        let anchor = ema20;
        let anchorLabel = 'EMA20';

        if (currentPrice > ema20 && ema50 > currentPrice) {
            anchor = ema50;
            anchorLabel = 'EMA50';
        }

        const fib382 = fibLevels.find(f => f.level === 0.382);
        if (fib382 && Math.abs(fib382.price - currentPrice) < Math.abs(anchor - currentPrice)) {
            anchor = fib382.price;
            anchorLabel = 'Fib 38.2%';
        }

        // Volume Profile 보정: 고거래량 가격대로 앵커 이동
        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${volumeNodeUsed.price.toFixed(4)},${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        const minPrice = anchor - atr * 0.2;
        const maxPrice = anchor + atr * 0.3;

        return {
            type: 'PULLBACK',
            minPrice,
            maxPrice: Math.min(maxPrice, currentPrice * 1.05),
            reasoning: `Short Pullback to ${anchorLabel}(${anchor.toFixed(4)}) ± ATR(${atr.toFixed(4)})`
        };
    }
}

function calculateBreakoutZone(bundle: IndicatorBundle, direction: 'Long' | 'Short'): EntryZone | null {
    const { currentPrice, atr, swingHighs, swingLows, klines, bb, volumeNodes } = bundle;

    if (direction === 'Long') {
        // 최근 스윙 하이 돌파 존
        const recentHighs = swingHighs.filter(s => s.index >= klines.length - 20);
        if (recentHighs.length === 0) {
            // 스윙 하이 없으면 BB 상단 사용
            let anchor = bb.upper;
            let anchorLabel = `BB Upper(${bb.upper.toFixed(4)})`;

            // Volume Profile 보정: 돌파 레벨을 고거래량 노드에 맞춤
            const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
            if (volumeNodeUsed) {
                anchor = adjustedAnchor;
                anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
            }

            return {
                type: 'BREAKOUT',
                minPrice: anchor - atr * 0.1,
                maxPrice: anchor + atr * 0.5,
                reasoning: `Long Breakout above ${anchorLabel}`
            };
        }
        const latestHigh = recentHighs[recentHighs.length - 1];
        let anchor = latestHigh.price;
        let anchorLabel = `SwingHigh(${latestHigh.price.toFixed(4)})`;

        // Volume Profile 보정
        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        return {
            type: 'BREAKOUT',
            minPrice: anchor,
            maxPrice: anchor + atr * 0.5,
            reasoning: `Long Breakout above ${anchorLabel}`
        };
    } else {
        // Short Breakout: 스윙 로우 붕괴
        const recentLows = swingLows.filter(s => s.index >= klines.length - 20);
        if (recentLows.length === 0) {
            let anchor = bb.lower;
            let anchorLabel = `BB Lower(${bb.lower.toFixed(4)})`;

            const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
            if (volumeNodeUsed) {
                anchor = adjustedAnchor;
                anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
            }

            return {
                type: 'BREAKOUT',
                minPrice: anchor - atr * 0.5,
                maxPrice: anchor + atr * 0.1,
                reasoning: `Short Breakout below ${anchorLabel}`
            };
        }
        const latestLow = recentLows[recentLows.length - 1];
        let anchor = latestLow.price;
        let anchorLabel = `SwingLow(${latestLow.price.toFixed(4)})`;

        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        return {
            type: 'BREAKOUT',
            minPrice: anchor - atr * 0.5,
            maxPrice: anchor,
            reasoning: `Short Breakout below ${anchorLabel}`
        };
    }
}

function calculateTopReversalZone(bundle: IndicatorBundle): EntryZone | null {
    const { bb, atr, swingHighs, klines, volumeNodes } = bundle;

    // 최근 스윙 하이가 BB 상단 근처에 있으면 더 정밀한 존
    const recentHighs = swingHighs.filter(s => s.index >= klines.length - 15);
    let anchor = bb.upper;
    let anchorLabel = 'BB Upper';

    if (recentHighs.length > 0) {
        const latestHigh = recentHighs[recentHighs.length - 1];
        if (Math.abs(latestHigh.price - bb.upper) < atr) {
            anchor = Math.max(latestHigh.price, bb.upper);
            anchorLabel = `SwingHigh+BB(${anchor.toFixed(4)})`;
        }
    }

    // Volume Profile 보정: 고거래량 저항대로 앵커 이동
    const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
    if (volumeNodeUsed) {
        anchor = adjustedAnchor;
        anchorLabel += `+Vol(${volumeNodeUsed.price.toFixed(4)},${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
    }

    return {
        type: 'TOP_REVERSAL',
        minPrice: anchor - atr * 0.2,
        maxPrice: anchor + atr * 0.3,
        reasoning: `Short Reversal at ${anchorLabel} ± ATR`
    };
}

// Phase 2: BOS Retest Zone — BOS 레벨 리테스트 영역
function calculateBosRetestZone(bundle: IndicatorBundle, direction: 'Long' | 'Short'): EntryZone | null {
    const { smcContext, atr, currentPrice, volumeNodes } = bundle;
    if (!smcContext.bosDetected) return null;

    if (direction === 'Long' && smcContext.bosDirection === 'BULLISH') {
        let anchor = smcContext.bosLevel;
        let anchorLabel = `BOS(${anchor.toFixed(4)})`;

        // Volume Profile 보정
        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        // OB confluence 체크: BOS 레벨 근처 미티게이트되지 않은 Bullish OB
        const nearbyOB = smcContext.orderBlocks.find(ob =>
            !ob.mitigated && ob.type === 'BULLISH' &&
            Math.abs((ob.high + ob.low) / 2 - anchor) < atr * 1.5
        );
        if (nearbyOB) {
            // OB 영역으로 존 확장
            anchor = (anchor + (nearbyOB.high + nearbyOB.low) / 2) / 2;
            anchorLabel += ' [OB]';
        }

        return {
            type: 'BOS_RETEST',
            minPrice: anchor - atr * 0.2,
            maxPrice: anchor + atr * 0.3,
            reasoning: `Long BOS Retest at ${anchorLabel} ± ATR`
        };
    }

    if (direction === 'Short' && smcContext.bosDirection === 'BEARISH') {
        let anchor = smcContext.bosLevel;
        let anchorLabel = `BOS(${anchor.toFixed(4)})`;

        const { adjustedAnchor, volumeNodeUsed } = adjustAnchorToVolumeNode(anchor, volumeNodes, atr);
        if (volumeNodeUsed) {
            anchor = adjustedAnchor;
            anchorLabel += `+Vol(${(volumeNodeUsed.strength * 100).toFixed(0)}%)`;
        }

        const nearbyOB = smcContext.orderBlocks.find(ob =>
            !ob.mitigated && ob.type === 'BEARISH' &&
            Math.abs((ob.high + ob.low) / 2 - anchor) < atr * 1.5
        );
        if (nearbyOB) {
            anchor = (anchor + (nearbyOB.high + nearbyOB.low) / 2) / 2;
            anchorLabel += ' [OB]';
        }

        return {
            type: 'BOS_RETEST',
            minPrice: anchor - atr * 0.3,
            maxPrice: anchor + atr * 0.2,
            reasoning: `Short BOS Retest at ${anchorLabel} ± ATR`
        };
    }

    return null;
}

// ===== Volume Profile: 고거래량 가격대 감지 =====

interface VolumeNode {
    price: number;       // 가격대 중심
    volume: number;      // 해당 가격대 총 거래량
    strength: number;    // 0~1 (전체 대비 비율)
}

function findHighVolumeNodes(klines: KlineData[], numBins: number = 20): VolumeNode[] {
    if (klines.length < 10) return [];

    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const priceMax = Math.max(...highs);
    const priceMin = Math.min(...lows);
    const range = priceMax - priceMin;

    if (range <= 0) return [];

    const binSize = range / numBins;
    const bins: { price: number; volume: number }[] = [];
    for (let i = 0; i < numBins; i++) {
        bins.push({ price: priceMin + binSize * (i + 0.5), volume: 0 });
    }

    // 각 캔들의 거래량을 해당 가격 범위 빈에 분배
    for (const k of klines) {
        const candleRange = k.high - k.low;
        if (candleRange <= 0) continue;

        for (let i = 0; i < numBins; i++) {
            const binLow = priceMin + binSize * i;
            const binHigh = binLow + binSize;
            // 캔들과 빈의 겹치는 비율
            const overlap = Math.max(0, Math.min(k.high, binHigh) - Math.max(k.low, binLow));
            const overlapRatio = overlap / candleRange;
            bins[i].volume += k.volume * overlapRatio;
        }
    }

    const maxVol = Math.max(...bins.map(b => b.volume));
    if (maxVol <= 0) return [];

    // 상위 거래량 빈만 반환 (평균의 1.5배 이상)
    const avgVol = bins.reduce((s, b) => s + b.volume, 0) / bins.length;
    return bins
        .filter(b => b.volume > avgVol * 1.5)
        .map(b => ({
            price: b.price,
            volume: b.volume,
            strength: b.volume / maxVol
        }))
        .sort((a, b) => b.volume - a.volume);
}

// 존 앵커를 가장 가까운 고거래량 노드로 보정
function adjustAnchorToVolumeNode(
    anchor: number,
    volumeNodes: VolumeNode[],
    atr: number,
    maxShift: number = 0.5 // ATR의 최대 이동 비율
): { adjustedAnchor: number; volumeNodeUsed: VolumeNode | null } {
    if (volumeNodes.length === 0) return { adjustedAnchor: anchor, volumeNodeUsed: null };

    // ATR * maxShift 이내의 가장 강한 노드 찾기
    const maxDist = atr * maxShift;
    let best: VolumeNode | null = null;

    for (const node of volumeNodes) {
        const dist = Math.abs(node.price - anchor);
        if (dist <= maxDist) {
            if (!best || node.strength > best.strength) {
                best = node;
            }
        }
    }

    if (best) {
        // 앵커를 노드 방향으로 이동 (강도에 비례)
        const shift = (best.price - anchor) * best.strength * 0.7;
        return { adjustedAnchor: anchor + shift, volumeNodeUsed: best };
    }

    return { adjustedAnchor: anchor, volumeNodeUsed: null };
}

// ===== Zone Dispatch =====

function calculateZoneForStrategy(
    strategyType: ZoneStrategyType,
    bundle: IndicatorBundle,
    direction: 'Long' | 'Short'
): EntryZone | null {
    switch (strategyType) {
        case 'PULLBACK':
            return calculatePullbackZone(bundle, direction);
        case 'BREAKOUT':
            return calculateBreakoutZone(bundle, direction);
        case 'TOP_REVERSAL':
            return calculateTopReversalZone(bundle);
        case 'BOS_RETEST':
            return calculateBosRetestZone(bundle, direction);
        default:
            return null;
    }
}

// ===== Zone Validation =====

function validateZone(zone: EntryZone, bundle: IndicatorBundle): boolean {
    const { currentPrice, atr } = bundle;

    // min < max
    if (zone.minPrice >= zone.maxPrice) return false;

    // 존 폭이 ATR의 5% ~ 300% 이내 (완화: 10~150% → 5~300%)
    const zoneWidth = zone.maxPrice - zone.minPrice;
    if (zoneWidth < atr * 0.05 || zoneWidth > atr * 3.0) return false;

    // 현재가에서 너무 멀지 않은지 (ATR * 7 이내, 완화: 5→7)
    const zoneMid = (zone.minPrice + zone.maxPrice) / 2;
    const distFromCurrent = Math.abs(zoneMid - currentPrice);
    if (distFromCurrent > atr * 7) return false;

    // 존 거리 절대 상한: 현재가의 8% 초과 (완화: 5%→8%)
    const distPct = distFromCurrent / currentPrice;
    if (distPct > 0.08) return false;

    // 가격이 양수인지
    if (zone.minPrice <= 0 || zone.maxPrice <= 0) return false;

    return true;
}

// ===== Market Phase Derivation =====

function deriveMarketPhase(regime: string, strategy: string, zoneType: string): string {
    if (strategy === 'TREND') {
        if (zoneType === 'BREAKOUT') return 'TREND_IMPULSE';
        if (zoneType === 'BOS_RETEST') return 'TREND_CONTINUATION';  // Phase 2: SMC
        return 'TREND_CORRECTION'; // PULLBACK
    }
    if (strategy === 'REVERSION') {
        if (zoneType === 'TOP_REVERSAL') return 'RANGE_DISTRIBUTION';
        // [FIX-F1] REVERSION + PULLBACK → 실제 레짐 기반 매핑
        if (zoneType === 'PULLBACK') return regime || 'TREND_CORRECTION';
        if (zoneType === 'STRUCTURAL_COLLAPSE') return regime || 'TREND_EXHAUSTION';
        // 기타 REVERSION 존 → 원래 레짐 유지, 없으면 MEAN_REVERSION_ZONE
        return regime || 'MEAN_REVERSION_ZONE';
    }
    return regime || 'UNCERTAIN';
}

// ===== Main Entry Point =====

export function computeEntryZones(
    klines: KlineData[],
    direction: 'Long' | 'Short',
    strategy: 'TREND' | 'REVERSION',
    regime: string,
    dmi: { pdi: number; mdi: number; adx: number },
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    zonePerformance?: { [zoneType: string]: { avgMovePercent: number; totalTrades: number; winRate: number } }
): ZoneCalculatorResult {
    // 1. 지표 번들 구성
    const bundle = buildIndicatorBundle(klines, dmi, swingHighs, swingLows);

    // 2. 전략 선택 (1~2개)
    const selectedStrategies = selectZoneStrategies(bundle, direction, strategy, regime);

    // 3. 각 전략에 대해 존 계산
    const zones: EntryZone[] = [];
    const reasoningParts: string[] = [];

    for (const stratType of selectedStrategies) {
        const zone = calculateZoneForStrategy(stratType, bundle, direction);
        if (!zone) continue;

        if (validateZone(zone, bundle)) {
            zones.push(zone);
            reasoningParts.push(zone.reasoning || stratType);
        }
    }

    // 3.5. Phase 2: OB Confluence 태깅 — unmitigated Order Block과 겹치는 존에 표시
    for (const zone of zones) {
        if (zone.type === 'BOS_RETEST') continue; // BOS_RETEST는 이미 OB 반영됨
        const overlapsOB = bundle.smcContext.orderBlocks.some(ob =>
            !ob.mitigated && zone.maxPrice >= ob.low && zone.minPrice <= ob.high
        );
        if (overlapsOB) {
            zone.reasoning = (zone.reasoning || '') + ' [OB Confluence]';
        }
    }

    // 3.6. 존 품질 피드백 반영: 과거 성과 기반 정렬 & 필터링
    if (zonePerformance && zones.length > 1) {
        // 품질 높은 존 우선 정렬 (데이터 5개 이상만 평가)
        zones.sort((a, b) => {
            const perfA = zonePerformance[a.type];
            const perfB = zonePerformance[b.type];
            const scoreA = (perfA && perfA.totalTrades >= 5) ? perfA.avgMovePercent : 0;
            const scoreB = (perfB && perfB.totalTrades >= 5) ? perfB.avgMovePercent : 0;
            return scoreB - scoreA; // 높은 순방향 이동률 우선
        });

        // 평균 역방향 0.3% 초과 + 데이터 10개 이상인 존 제거
        const filtered = zones.filter(z => {
            const perf = zonePerformance[z.type];
            if (!perf || perf.totalTrades < 10) return true; // 데이터 부족 → 유지
            return perf.avgMovePercent > -0.3; // 평균 역방향 0.3% 이하 → 제거
        });
        if (filtered.length > 0) {
            zones.splice(0, zones.length, ...filtered);
        }
    }

    // 4. marketPhase 결정
    const primaryZoneType = zones.length > 0 ? zones[0].type : selectedStrategies[0];
    const marketPhase = deriveMarketPhase(regime, strategy, primaryZoneType);

    // 5. expectedReward 계산 (ATR 기반)
    const expectedReward = Math.min(bundle.atrPercent * 2.0 * 100, 8.0); // ATR의 2배, 최대 8%

    // 6. reasoning 조합
    const reasoning = [
        `[${strategy}/${direction}]`,
        `Regime: ${regime}`,
        `EMA20=${bundle.ema20.toFixed(4)}, BB=(${bundle.bb.lower.toFixed(4)}~${bundle.bb.upper.toFixed(4)})`,
        `ATR=${bundle.atr.toFixed(4)}(${(bundle.atrPercent * 100).toFixed(2)}%)`,
        `RSI=${bundle.rsi.toFixed(0)}, Z=${bundle.zScore.toFixed(2)}`,
        ...reasoningParts
    ].join(' | ');

    return { zones, marketPhase, reasoning, expectedReward, smcContext: bundle.smcContext };
}
