/**
 * Execution — 주문 실행 + TP/SL 계산 + 사이징
 *
 * tradingEngine.ts에서 추출:
 * - executeOrderWithSniperLoop()의 핵심 로직
 * - calculateDynamicPositionSize()
 * - TP/SL 계산 (8레이어 → 2레이어 간소화)
 *
 * TradingConfig의 multiplier를 반영하여 autoTuner 결과 적용.
 */

import type {
    KlineData, Trade, TradingConfig, SimpleRegime,
    CryptoMarketRegime, CryptoRegimeResult,
} from '../../types';
import * as bybitService from '../bybitService';
import { calculateATR, calculateADX, calculateRSI } from '../indicatorService';
import { v4 as uuidv4 } from 'uuid';

// ── 상수 ──

const FEE_RATE_ENTRY = 0.00055;
const FEE_RATE_EXIT = 0.00055;
const SLIPPAGE_RATE = 0.0008;  // ★ 백테스트 동기화: 전 엔진 통일 0.08%
const TOTAL_FEE_RATE = FEE_RATE_ENTRY + FEE_RATE_EXIT + SLIPPAGE_RATE;

const LIQ_BUFFER_PERCENT = 0.005;   // 청산가 안전 마진 0.5%
const MMR = 0.005;                   // Bybit 유지증거금율

// ★ v54: MLR 50%→20% (28,028건 분석: MLR20% + 20x에서 DD 58%→18% 감소)
const MAX_LOSS_RATIO = 0.20;   // 20% = SL 1%→20x, SL 2%→10x, SL 5%→4x
const MAX_LEVERAGE_CAP = 75;   // Bybit 실전 상한

// v23: 2단계 부분TP (50%+50%)
const PARTIAL_TP1_QTY_RATIO = 0.5;

// ── 타입 ──

export interface SizingResult {
    margin: number;
    leverage: number;
    quantity: number;
    positionSizePercent: number;
    reasoning: string;
}

export interface TPSLResult {
    tpPrice: number;
    slPrice: number;
    tp1Price: number;  // 부분 익절 가격 (0이면 미적용)
    tpPercent: number;
    slPercent: number;
}

function getMarketSession(): string {
    const utcHour = new Date().getUTCHours();
    if (utcHour < 8) return 'ASIA';
    if (utcHour < 13) return 'EUROPE';
    return 'US';
}

function mapToSimpleRegime(regime: string): SimpleRegime {
    const trending = ['TREND_IMPULSE', 'TREND_CONTINUATION', 'BREAKOUT_EXPANSION'];
    const volatile = ['TREND_EXHAUSTION', 'VOLATILITY_EXPLOSION', 'LIQUIDATION_CASCADE'];
    if (trending.includes(regime)) return 'TRENDING';
    if (volatile.includes(regime)) return 'VOLATILE';
    return 'RANGING';
}

export class Execution {
    constructor(
        private emit: (type: string, sender: string, msg: string, category?: string) => void,
    ) {}

    /**
     * v17: TP/SL 계산 — 스윙 트레이딩
     *
     * ATR_1h × swing.tpAtrMultiplier (7) / swing.slAtrMultiplier (2.75)
     * R:R ≥ 2.0 강제
     */
    calculateTPSL(params: {
        price: number;
        direction: 'Long' | 'Short';
        atr: number;
        config: TradingConfig;
        leverage: number;
        backtestLeverage?: number;
        regimeTpMultiplier?: number;
        regimeSlMultiplier?: number;
        isAggressive?: boolean;
    }): TPSLResult {
        const { price, direction, atr, config, leverage,
                backtestLeverage,
                regimeTpMultiplier = 1.0, regimeSlMultiplier = 1.0,
                isAggressive = false } = params;
        const atrPercent = atr / price;
        const swing = config.swing;

        let tpPercent: number;
        let slPercent: number;

        // ★ SL은 백테스트 레버리지 기준으로 계산 (실전-백테 SL 일치)
        // 예: 백테 50x → SL=1%, 실전 Bybit 25x여도 SL=1% 유지
        const slLeverage = backtestLeverage ?? leverage;
        slPercent = MAX_LOSS_RATIO / slLeverage;

        // ★ ATR 기반 TP — 레버리지 캡 제거 (옵티마이저가 tpAtrMultiplier를 최적화)
        tpPercent = atrPercent * (swing?.tpAtrMultiplier ?? 3.0) * regimeTpMultiplier;
        tpPercent += TOTAL_FEE_RATE;
        if (tpPercent < 0.005) tpPercent = 0.005;  // 최소 0.5%

        // 가격 산출
        const tpPrice = direction === 'Long'
            ? price * (1 + tpPercent)
            : price * (1 - tpPercent);
        const slPrice = direction === 'Long'
            ? price * (1 - slPercent)
            : price * (1 + slPercent);

        // ★ v53.1: safeSl 제거 — SL은 항상 MAX_LOSS_RATIO/leverage 고정
        // 백테스트와 실전 SL 완전 일치 (safeSl이 SL을 줄여서 PnL 불일치 유발했음)

        // TP1 = TP (전량 청산이므로 TP1 = 최종 TP)
        const tp1Price = tpPrice;

        return {
            tpPrice,
            slPrice,
            tp1Price,
            tpPercent,
            slPercent,
        };
    }

    /**
     * 포지션 사이징 — config multiplier 반영
     *
     * 기본 사이즈 × 레짐 multiplier × 세션 multiplier × 방향 multiplier
     */
    calculateSize(params: {
        equity: number;
        availableBalance: number;
        config: TradingConfig;
        direction: 'Long' | 'Short';
        regime: string;
        atr: number;
        price: number;
        leverage: number;
        maxPositions?: number;
        openPositionCount?: number;
        aggressiveSizePercent?: number;  // ★ v52.71: 탑 콤보 오버라이드
    }): SizingResult {
        const { equity, config, direction, regime, atr, price, leverage,
            maxPositions = 10, openPositionCount = 0, aggressiveSizePercent } = params;

        // ★ v52.80: 페이커봇 v2 — 5분할 (20%)
        const sizePercent = aggressiveSizePercent ?? 20;
        const margin = equity * (sizePercent / 100);
        const quantity = margin > 0 ? (margin * leverage) / price : 0;

        const reasoning = `${aggressiveSizePercent ? '🔥TopCombo' : 'Fixed'}Size=${sizePercent}% lev=${leverage}x [${openPositionCount}/${maxPositions}]`;

        return {
            margin: Math.max(0, margin),
            leverage,
            quantity,
            positionSizePercent: sizePercent,
            reasoning,
        };
    }

    /**
     * 고정 SL% 기반 레버리지 결정
     * SL% × 레버리지 = 50 → 레버리지 = 50% / SL%
     * 예: SL 1% → 50x, SL 2% → 25x, SL 5% → 10x
     */
    async determineLeverage(ticker: string, atr: number, price: number, config?: TradingConfig, regime?: string, maxPositions?: number, wfLeverage?: number, tpAtrMultiplier?: number): Promise<{ actual: number; backtest: number }> {
        let tickerMaxLev = 25;

        try {
            tickerMaxLev = await bybitService.getMaxLeverage(ticker);
        } catch {
            tickerMaxLev = 25;
        }

        // ★ v55: 전세션 20x 고정 (12,649건 분석: 20x VOLATILE WR=52.7%, EV=0.339)
        // MLR 0.20 → SL 1% (20x에서 안전), 최적 조건 Score≥5 WR=57.8%
        const leverage = Math.min(20, tickerMaxLev);
        const backtestSlPercent = MAX_LOSS_RATIO / leverage;
        this.emit('newMessage', 'system',
            `🔧 [Leverage] ${ticker} WF=${wfLeverage ?? 'N/A'}x → actual=${leverage}x SL=${(backtestSlPercent * 100).toFixed(2)}%`,
            'system_state');

        try {
            await bybitService.setLeverage(ticker, leverage);
        } catch (e: any) {
            if (e?.message && !e.message.includes('not modified') && !e.message.includes('110043')) {
                console.warn(`[Leverage Set Warn] ${ticker}: ${e.message}`);
            }
        }

        return { actual: leverage, backtest: leverage };
    }

    /**
     * 주문 실행 — 시장가 즉시 진입 + TP/SL 설정 + 부분 익절
     */
    async executeEntry(params: {
        ticker: string;
        direction: 'Long' | 'Short';
        config: TradingConfig;
        atr: number;
        currentPrice: number;
        equity: number;
        availableBalance: number;
        regime: string;
        regimeResult?: CryptoRegimeResult;
        zoneMinPrice: number;
        zoneMaxPrice: number;
        zoneType: string;
        reasoning: string;
        momentumScore?: number;
        volumeRatio?: number;
        volatilityAccel?: number;
        zoneCenterPrice?: number;
        // Quality Gate 데이터
        qualityGateRangePos?: number;
        qualityGateMomentum?: number;
        qualityGateVolRatio?: number;
        // 적응형 TF
        selectedTimeframe?: string;
        // Phase 1: Sentiment
        sentimentData?: import('../../types').SentimentData;
        sentimentScore?: import('../../types').SentimentScore;
        // Phase 2: VWAP + SMC
        vwapData?: import('../../types').VWAPData;
        smcContext?: import('../../types').SMCContext;
        // Phase 3: WaveTrend + Ichimoku
        waveTrendData?: import('../../types').WaveTrendData;
        ichimokuData?: import('../../types').IchimokuData;
        // v35: 포지션 균등 분배
        maxPositions?: number;
        openPositionCount?: number;
        // ★ v36: 레지스트리 통계 (대시보드 표시용)
        registryStats?: Trade['registryStats'];
        // ★ v44: NewsGuard 수정자
        newsSizeMultiplier?: number;  // 포지션 사이즈 배수 (기본 1.0)
        newsTpMultiplier?: number;    // TP 배수 (기본 1.0)
        // ★ v52.71: 탑 콤보 공격적 사이징
        aggressiveSizePercent?: number;  // 탑 콤보면 40%, 아니면 undefined
        // ★ v52.72: WF 최적화 레버리지
        wfLeverage?: number;
    }): Promise<Trade | null> {
        const {
            ticker, direction, config, atr, currentPrice,
            equity, availableBalance, regime, regimeResult,
            zoneMinPrice, zoneMaxPrice, zoneType, reasoning,
        } = params;

        // 1. v52.72: WF 파라미터 레버리지 사용 (최대 레버리지 아닌)
        const levResult = await this.determineLeverage(ticker, atr, currentPrice, config, regime, params.maxPositions, params.wfLeverage, config.swing?.tpAtrMultiplier);
        if (levResult.actual < 0) return null;  // ★ 레버리지 10배 미만 종목 차단
        const leverage = levResult.actual;
        const backtestLeverage = levResult.backtest;

        // 2. 사이징 — v52.71: 탑 콤보 40% / 일반 10%
        const sizing = this.calculateSize({
            equity, availableBalance, config, direction,
            regime, atr, price: currentPrice, leverage,
            maxPositions: params.maxPositions,
            openPositionCount: params.openPositionCount,
            aggressiveSizePercent: params.aggressiveSizePercent,
        });

        if (sizing.margin <= 0) {
            this.emit('newMessage', 'system',
                `⚠️ [${ticker}] 가용 잔고 부족으로 진입 불가`,
                'system_state'
            );
            return null;
        }

        // ★ v44: NewsGuard 사이즈 수정자 적용
        const newsSizeMult = params.newsSizeMultiplier ?? 1.0;
        const newsTpMult = params.newsTpMultiplier ?? 1.0;
        const adjustedQty = sizing.quantity * newsSizeMult;

        // 3. 수량 조정
        const instrumentInfo = await bybitService.fetchInstrumentInfo(ticker);
        const qtyStr = await bybitService.adjustQuantityByStep(ticker, adjustedQty, instrumentInfo);
        const finalQty = parseFloat(qtyStr);
        if (finalQty <= 0) {
            this.emit('newMessage', 'system', `❌ [${ticker}] 수량 0 → 진입 불가`, 'error');
            return null;
        }

        // 4. TP/SL 계산 — Aggressive 전용
        const maxPos = params.maxPositions ?? 1;
        const isAgg = true;

        // ★ RANGING TP cap 제거 — 옵티마이저가 레짐별 tpAtrMultiplier를 이미 최적화
        const entryConfig = config;

        // ★ v52.14: TP/SL 기준가를 1분봉 open으로 (백테스트 동기화)
        let tpslBasePrice = currentPrice;  // 폴백: 현재가
        try {
            const klines1m = await bybitService.fetchSingleTimeframeKlines(ticker, '1m', 1);
            if (klines1m.length > 0) {
                tpslBasePrice = klines1m[klines1m.length - 1].open;
            }
        } catch (e) {
            // 1분봉 조회 실패 시 현재가 폴백
        }

        let tpsl = this.calculateTPSL({
            price: tpslBasePrice, direction, atr, config: entryConfig, leverage,
            backtestLeverage,
            regimeTpMultiplier: 1.0,  // ★ v52.85: 제거 — WF tpAtrMultiplier만 사용
            regimeSlMultiplier: 1.0,
            isAggressive: isAgg,
        });

        // ★ v44: NewsGuard TP 확대 적용 (WIDEN_TP / MACRO_EVENT)
        if (newsTpMult !== 1.0) {
            const tpDist = Math.abs(tpsl.tpPrice - tpslBasePrice);
            const newTpDist = tpDist * newsTpMult;
            tpsl.tpPrice = direction === 'Long'
                ? tpslBasePrice + newTpDist
                : tpslBasePrice - newTpDist;
            tpsl.tpPercent = tpsl.tpPercent * newsTpMult;
            // tp1도 같이 확대
            if (tpsl.tp1Price) {
                const tp1Dist = Math.abs(tpsl.tp1Price - tpslBasePrice);
                tpsl.tp1Price = direction === 'Long'
                    ? tpslBasePrice + tp1Dist * newsTpMult
                    : tpslBasePrice - tp1Dist * newsTpMult;
            }
        }

        const tpStr = await bybitService.adjustPriceByTick(ticker, tpsl.tpPrice, instrumentInfo);
        const slStr = await bybitService.adjustPriceByTick(ticker, tpsl.slPrice, instrumentInfo);

        const newsLabel = newsSizeMult !== 1.0 || newsTpMult !== 1.0
            ? `\n  📰 NewsGuard: 사이즈×${newsSizeMult} TP×${newsTpMult}`
            : '';
        this.emit('newMessage', 'system',
            `📊 [Execution] ${ticker} ${direction}\n` +
            `  🔍 maxPos=${maxPos} isAgg=${isAgg} baseSizePct=${config.sizing.baseSizePercent}\n` +
            `  사이즈: ${sizing.positionSizePercent.toFixed(0)}% (${sizing.reasoning})\n` +
            `  레버리지: ${leverage}x (백테${backtestLeverage}x) | 수량: ${finalQty}\n` +
            `  TP: ${tpStr} (${(tpsl.tpPercent * 100).toFixed(2)}%) | SL: ${slStr} (${(tpsl.slPercent * 100).toFixed(2)}%)\n` +
            `  📐 TP/SL기준: 1m open ${tpslBasePrice}${tpslBasePrice !== currentPrice ? ` (현재가 ${currentPrice})` : ''}${newsLabel}`,
            'system_state'
        );

        // ★ 백테스트 동기화: RSI recheck 제거 — lightScan에서 이미 1회 체크, 백테스트도 1회만
        let rsiAtEntry = 0;

        // 6. 시장가 주문
        let orderId = '';
        let executedPrice = currentPrice;
        let entryFee = 0;

        // ★ TP 가격 미리 계산 (시장가 주문에 TP+SL 동시 포함)
        const tp1PriceStr = await bybitService.adjustPriceByTick(ticker, tpsl.tp1Price, instrumentInfo);

        // ★ v35f: Limit IOC 우선 → 실패 시 Market 폴백 (슬리피지 절감)
        const limitSide = direction === 'Long' ? 'Buy' : 'Sell';
        const limitSlippagePct = 0.0002;  // ±0.02% 허용 범위
        const limitPrice = direction === 'Long'
            ? currentPrice * (1 + limitSlippagePct)
            : currentPrice * (1 - limitSlippagePct);
        const limitPriceStr = await bybitService.adjustPriceByTick(ticker, limitPrice, instrumentInfo);

        let orderAttempt = 0;
        const MAX_ORDER_ATTEMPTS = 2;  // 최대 2회 (Limit IOC → Market 폴백)

        while (orderAttempt < MAX_ORDER_ATTEMPTS) {
            orderAttempt++;
            const isLimitAttempt = orderAttempt === 1;

            try {
                const response = await bybitService.placeLinearOrder({
                    ticker,
                    side: limitSide,
                    quantity: finalQty,
                    orderType: isLimitAttempt ? 'Limit' : 'Market',
                    price: isLimitAttempt ? limitPriceStr : undefined,
                    takeProfit: tp1PriceStr,
                    stopLoss: slStr,
                    timeInForce: 'IOC',
                });
                orderId = response.orderId;

                // ★ v35f: 체결 확인 — 1초 후 1회 체크 (이중주문 방지)
                await new Promise(resolve => setTimeout(resolve, 1000));
                const execDetails = await bybitService.fetchOrderHistory(ticker, orderId);

                if (execDetails && execDetails.orderStatus === 'Filled') {
                    executedPrice = parseFloat(execDetails.avgPrice);
                    entryFee = parseFloat(execDetails.cumExecFee);
                    if (isLimitAttempt) {
                        this.emit('newMessage', 'system',
                            `⚡ [${ticker}] Limit IOC 체결 @ ${executedPrice.toFixed(4)} (슬리피지 절감)`, 'system_state');
                    }
                    break;  // 체결 성공 → 루프 탈출
                }

                // 미체결 → 주문 취소 후 재시도
                try { await bybitService.cancelOrder(ticker, orderId); } catch {}

                if (isLimitAttempt) {
                    this.emit('newMessage', 'system',
                        `⏳ [${ticker}] Limit IOC 미체결 → Market 폴백`, 'system_state');
                    continue;  // 2차 시도 (Market)
                } else {
                    this.emit('newMessage', 'system', `❌ [${ticker}] Market 주문도 미체결 → 포기`, 'error');
                    return null;
                }
            } catch (e) {
                if (isLimitAttempt) {
                    this.emit('newMessage', 'system',
                        `⚠️ [${ticker}] Limit 주문 실패 → Market 폴백: ${(e as Error).message}`, 'system_state');
                    continue;
                }
                this.emit('newMessage', 'system', `❌ [${ticker}] 주문 실패: ${(e as Error).message}`, 'error');
                return null;
            }
        }

        // ★ 백테스트 동기화: TP/SL을 체결가(executedPrice) 기준으로 재계산
        const finalLeverage = leverage;

        // 체결가가 시그널가와 다르면 TP/SL 재계산
        let finalTpsl = tpsl;
        let finalTpStr = tpStr;
        let finalSlStr = slStr;
        if (Math.abs(executedPrice - currentPrice) / currentPrice > 0.0001) {  // 0.01% 이상 차이
            finalTpsl = this.calculateTPSL({
                price: executedPrice, direction, atr, config: entryConfig, leverage,
                backtestLeverage,
                regimeTpMultiplier: 1.0,  // ★ v52.85: 제거
                regimeSlMultiplier: 1.0,
                isAggressive: isAgg,
            });
            finalTpStr = await bybitService.adjustPriceByTick(ticker, finalTpsl.tpPrice, instrumentInfo);
            finalSlStr = await bybitService.adjustPriceByTick(ticker, finalTpsl.slPrice, instrumentInfo);

            // Bybit TP/SL 수정
            try {
                await bybitService.setTradingStop({
                    ticker,
                    takeProfit: finalTpStr,
                    stopLoss: finalSlStr,
                    positionIdx: 0,
                });
                this.emit('newMessage', 'system',
                    `🔄 [${ticker}] TP/SL 체결가 기준 재설정: TP=${finalTpStr} SL=${finalSlStr}`,
                    'system_state');
            } catch (e) {
                this.emit('newMessage', 'system',
                    `⚠️ [${ticker}] TP/SL 재설정 실패 (기존 유지): ${(e as Error).message}`,
                    'error');
            }
        }

        // TP 정보 기록
        const tp1PriceStrFinal = await bybitService.adjustPriceByTick(ticker, finalTpsl.tp1Price, instrumentInfo);
        let tp1PriceNum = parseFloat(tp1PriceStrFinal);
        let partialTpApplied = true;
        let tp1Qty = finalQty;
        let tp2Qty = 0;
        const tpOrderPrices: Array<{ price: number; qty: number }> = [{ price: tp1PriceNum, qty: finalQty }];
        const closeSide = direction === 'Long' ? 'Sell' : 'Buy';

        // 8. Trade 객체 생성

        // Phase 3: 개선된 청산가 공식 (실제 마진/수수료 반영)
        let approxLiqPrice: number;
        try {
            const positionValue = finalQty * executedPrice;
            const effectiveMargin = sizing.margin - entryFee;
            let improvedLiqPrice: number;
            if (direction === 'Long') {
                improvedLiqPrice = executedPrice * (1 - (effectiveMargin / positionValue - MMR));
            } else {
                improvedLiqPrice = executedPrice * (1 + (effectiveMargin / positionValue - MMR));
            }
            // Fallback: NaN/음수/Infinity → 기존 공식
            approxLiqPrice = (improvedLiqPrice > 0 && isFinite(improvedLiqPrice))
                ? improvedLiqPrice
                : direction === 'Long'
                    ? executedPrice * (1 - 1 / finalLeverage + MMR)
                    : executedPrice * (1 + 1 / finalLeverage - MMR);
        } catch {
            approxLiqPrice = direction === 'Long'
                ? executedPrice * (1 - 1 / finalLeverage + MMR)
                : executedPrice * (1 + 1 / finalLeverage - MMR);
        }

        const trade: Trade = {
            id: uuidv4(),
            orderId,              // 바이빗 주문 ID (동기화용)
            ticker,
            direction,
            entryPrice: executedPrice,
            quantity: finalQty,
            leverage: finalLeverage,
            initialMargin: sizing.margin,
            positionValue: sizing.margin * finalLeverage,
            status: 'open',
            openTimestamp: Date.now(),
            localStartTime: Date.now(),
            unrealizedPnl: 0,
            realizedPnl: 0,
            totalFee: entryFee,
            tp1Price: partialTpApplied ? tp1PriceNum : 0,
            targetPrice: parseFloat(finalTpStr),
            invalidationPrice: parseFloat(finalSlStr),
            isTp1Hit: false,
            tpOrders: tpOrderPrices.length > 0
                ? tpOrderPrices
                : [{ price: parseFloat(finalTpStr), qty: finalQty }],
            exitStages: [],
            liquidationPrice: approxLiqPrice,
            positionIdx: 0,
            category: 'linear',
            tradeStyle: 'SWING_RUNNER',
            expectedDuration: '4h',
            switchCount: 0,
            primaryTimeframe: params.selectedTimeframe || '15m',
            marketPhase: regime,
            wasReversed: false,
            entrySnapshot: {
                timestamp: Date.now(),
                hurst: 0.5,
                hurstConfidence: 0.5,
                adx: regimeResult?.components?.trendStrength || 0,
                rsi: rsiAtEntry,
                regime: regime || 'UNKNOWN',
                expectedMove: finalTpsl.tpPercent,
                expectedMoveBasis: 'atr',
                confirmedSignals: [],
                signalConfidence: regimeResult?.confidence || 50,
                // Phase 1: Sentiment
                fundingRate: params.sentimentData?.fundingRate,
                sentimentScore: params.sentimentScore?.score,
                oiChange1h: params.sentimentData?.oiChange1h,
                oiChange4h: params.sentimentData?.oiChange4h,
                cvd5min: params.sentimentData?.cvd5min,
                oiPriceDivergence: params.sentimentData?.oiPriceDivergence,
                cvdPriceDivergence: params.sentimentData?.cvdPriceDivergence,
                // Phase 2: L/S Ratio + VWAP + SMC
                longShortRatio: params.sentimentData?.longShortRatio?.ratio,
                vwapDeviation: params.vwapData?.deviationPercent,
                smcBos: params.smcContext?.bosDetected,
                smcChoch: params.smcContext?.chochDetected,
                smcOrderBlockNear: params.smcContext?.orderBlocks?.some(
                    ob => !ob.mitigated && Math.abs((ob.high + ob.low) / 2 - currentPrice) < atr
                ),
                // Phase 3
                waveTrendWT1: params.waveTrendData?.wt1,
                waveTrendMomentum: params.waveTrendData?.momentum,
                ichimokuPriceVsCloud: params.ichimokuData?.priceVsCloud,
                ichimokuTKCross: params.ichimokuData?.tkCross,
                ichimokuCloudThickness: params.ichimokuData?.cloudThickness,
                improvedLiqPrice: approxLiqPrice,
            },
            analytics: {
                entryMethod: 'FAST_EXEC' as const,
                entryConfidence: regimeResult?.confidence || 0,
                entryStrategy: 'TREND' as const,
                entryRegime: regime || 'UNKNOWN',
                entryRegimeConfidence: regimeResult?.confidence || 0,
                inflectionScore: 0,
                mtfDirection: 'NEUTRAL' as const,
                maxFavorableExcursion: 0,
                maxAdverseExcursion: 0,
                entryToHighPercent: 0,
                entryToLowPercent: 0,
                holdingDurationMinutes: 0,
                timeToMaxProfit: 0,
                pricePathSummary: [],
                exitEfficiency: 0,
                riskRewardRatio: 0,
                timeToExit: 0,
                wasEarlyExit: false,
                exitTrigger: '',
                exitRegime: '',
                slDistanceAtExit: 0,
                wasRegimeShiftExit: false,
                marketSession: getMarketSession(),
                entryZoneType: zoneType,
                entryVolatilityPercentile: 50,
                entryVolumeRatio: params.volumeRatio || 1.0,
                // 데이터 수집 강화
                atrPercentAtEntry: atr / currentPrice,
                volumeRatioAtEntry: params.volumeRatio || 1.0,
                momentumScoreAtEntry: params.momentumScore || 0,
                volatilityAccelAtEntry: params.volatilityAccel || 1.0,
                zoneCenterPrice: params.zoneCenterPrice || currentPrice,
                trailingStopAdjustments: 0,
                // Quality Gate 데이터
                qualityGateRangePos: params.qualityGateRangePos,
                qualityGateMomentum: params.qualityGateMomentum,
                qualityGateVolRatio: params.qualityGateVolRatio,
            },
            // ★ v36: 레지스트리 통계 (대시보드 포지션 카드 표시용)
            registryStats: params.registryStats,
        } as unknown as Trade;

        this.emit('newMessage', 'system',
            `✅ [Executed] ${ticker} ${direction} @ ${executedPrice.toFixed(4)}\n` +
            `  Qty: ${finalQty} | Margin: $${sizing.margin.toFixed(2)} | Lev: ${finalLeverage}x\n` +
            `  TP: ${tpStr} | SL: ${slStr}${partialTpApplied ? ` | TP1: ${tp1PriceNum.toFixed(4)} (${(PARTIAL_TP1_QTY_RATIO * 100).toFixed(0)}%)` : ''}`,
            'system_state'
        );

        return trade;
    }
}
