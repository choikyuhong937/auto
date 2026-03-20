/**
 * PositionManager — 포지션 동기화 + 리스크 관리 + 트레일링 + 청산
 *
 * tradingEngine.ts에서 추출:
 * - syncPositions()
 * - managePositionRisk()
 * - updateTrailingStop()
 * - closePositionAndCancelOrders()
 * - Time-Decay TP
 */

import type { Trade, TradingConfig, SwingConfig, TickerParamEntry } from '../../types';
import * as bybitService from '../bybitService';
import { calculateATR } from '../indicatorService';

// ── 상수 ──

const PARTIAL_TP1_QTY_RATIO = 0.5;  // v23: 2단계 (50%+50%)

// ── 타입 ──

export interface SyncResult {
    closedTrades: Trade[];
    importedTrades: Trade[];   // 고아 포지션 (Bybit에 있지만 로컬에 없던 것)
    totalEquity: number;
    availableBalance: number;
    livePositionCount: number; // Bybit 실제 포지션 수 (불일치 감지용)
}

// API 응답 지연/누락 시 잘못된 포지션 종료 방지용
const MISSING_GRACE_MS = 8_000;        // 8초간 API에 없어도 종료하지 않음
const MISSING_RECONFIRM_COUNT = 4;     // 4회 연속 없어야 종료 (1.5s × 4 = 6초)
const MIN_POSITION_AGE_MS = 30_000;    // 진입 후 30초 이내에는 종료 판단 안 함

export class PositionManager {
    private lastPulseCheckTime: Record<string, number> = {};
    private lastLogTime: Record<string, number> = {};

    // 포지션이 API에서 사라진 횟수 추적 (grace period)
    private missingCount: Record<string, number> = {};
    private firstMissingTime: Record<string, number> = {};

    private emit: (type: string, sender: string, msg: string, category?: string) => void;
    private getRegistry: () => Record<string, TickerParamEntry>;

    constructor(
        emit: (type: string, sender: string, msg: string, category?: string) => void,
        getRegistry?: () => Record<string, TickerParamEntry>,
    ) {
        this.emit = emit;
        this.getRegistry = getRegistry ?? (() => ({}));
    }

    /**
     * 포지션 동기화 — 거래소 상태와 로컬 상태 동기화
     */
    async syncPositions(
        openPositions: Trade[],
        latestPrices: Record<string, number>,
    ): Promise<SyncResult> {
        const result: SyncResult = { closedTrades: [], importedTrades: [], totalEquity: 0, availableBalance: 0, livePositionCount: 0 };

        try {
            const accountState = await bybitService.fetchAccountState();
            if (!accountState) {
                console.warn('[Sync] ⚠️ fetchAccountState() 실패 → 이번 사이클 스킵 (포지션 상태 유지)');
                return result;
            }

            // 에쿼티/잔고를 SyncResult에 전달 → tradingEngine이 state 갱신
            result.totalEquity = accountState.totalEquity;
            result.availableBalance = accountState.availableBalance;

            const livePositions = accountState.openPositions;
            result.livePositionCount = livePositions.length;

            for (const pos of openPositions) {
                if (pos.status !== 'open') continue;

                const liveP = livePositions.find((lp: any) => lp.ticker === pos.ticker);

                const posKey = `${pos.ticker}_${pos.openTimestamp}`;

                if (liveP) {
                    // 포지션 살아있음 → 업데이트 + grace counter 리셋
                    delete this.missingCount[posKey];
                    delete this.firstMissingTime[posKey];

                    pos.unrealizedPnl = liveP.unrealizedPnl;
                    pos.currentPrice = liveP.currentPrice;

                    // TP1 체결 감지
                    const prevQty = pos.quantity;
                    if (liveP.quantity < prevQty * 0.95 && !pos.isTp1Hit && pos.tp1Price && pos.tp1Price > 0) {
                        const closedQty = prevQty - liveP.quantity;
                        const tp1Pnl = pos.direction === 'Long'
                            ? (pos.tp1Price - pos.entryPrice) * closedQty
                            : (pos.entryPrice - pos.tp1Price) * closedQty;
                        pos.isTp1Hit = true;
                        pos.tpCount = (pos.tpCount || 0) + 1;
                        pos.realizedPnl = (pos.realizedPnl || 0) + tp1Pnl;
                        if (!pos.exitStages) pos.exitStages = [];
                        pos.exitStages.push({
                            timestamp: Date.now(),
                            qty: closedQty,
                            price: pos.tp1Price,
                            reason: 'partial_tp',
                            pnl: tp1Pnl,
                        });
                        this.emit('newMessage', 'system',
                            `🎯 [TP1 체결] ${pos.ticker} ${(PARTIAL_TP1_QTY_RATIO * 100).toFixed(0)}% 익절! $${tp1Pnl.toFixed(4)}`,
                            'system_state'
                        );
                    }

                    pos.quantity = liveP.quantity;
                    pos.entryPrice = liveP.entryPrice;
                    pos.leverage = liveP.leverage;

                    // MFE/MAE 실시간 업데이트
                    if (pos.analytics) {
                        const localStart = pos.localStartTime || pos.openTimestamp;
                        const pnlPct = ((liveP.currentPrice - pos.entryPrice) / pos.entryPrice) *
                            (pos.direction === 'Long' ? 1 : -1) * 100;
                        if (pnlPct > pos.analytics.maxFavorableExcursion) {
                            pos.analytics.maxFavorableExcursion = pnlPct;
                            pos.analytics.timeToMaxProfit = (Date.now() - localStart) / 60000;
                        }
                        if (pnlPct < -pos.analytics.maxAdverseExcursion) {
                            pos.analytics.maxAdverseExcursion = Math.abs(pnlPct);
                        }
                        // 가격 경로 기록 (5분 간격)
                        const elapsedMin = (Date.now() - localStart) / 60000;
                        const expectedPoints = Math.floor(elapsedMin / 5);
                        if (pos.analytics.pricePathSummary.length < expectedPoints) {
                            const priceChangePct = ((liveP.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                            pos.analytics.pricePathSummary.push(parseFloat(priceChangePct.toFixed(3)));
                        }
                    }

                    // Time-Decay TP — 제거됨 (position-level TP 미사용)
                } else {
                    // ── 포지션이 API에 없음 → grace period로 재확인 ──
                    // API 지연/누락으로 잘못 종료하는 것을 방지
                    const now = Date.now();

                    // ★ 진입 직후 보호: 60초 이내 포지션은 종료 판단 안 함
                    const posAge = now - (pos.openTimestamp || pos.localStartTime || 0);
                    if (posAge < MIN_POSITION_AGE_MS) {
                        console.log(`[Sync] 🛡️ ${pos.ticker} 진입 ${(posAge / 1000).toFixed(0)}s → 보호 기간 (${(MIN_POSITION_AGE_MS / 1000)}s) 내 종료 판단 건너뜀`);
                        continue;
                    }

                    this.missingCount[posKey] = (this.missingCount[posKey] || 0) + 1;
                    if (!this.firstMissingTime[posKey]) {
                        this.firstMissingTime[posKey] = now;
                    }

                    const elapsed = now - this.firstMissingTime[posKey];
                    const count = this.missingCount[posKey];

                    // 30초 미경과 또는 10회 미만 → 아직 종료 확정하지 않음
                    if (elapsed < MISSING_GRACE_MS || count < MISSING_RECONFIRM_COUNT) {
                        console.log(
                            `[Sync] ⏳ ${pos.ticker} API에 없음 (${count}/${MISSING_RECONFIRM_COUNT}회, ${(elapsed / 1000).toFixed(1)}s) → 재확인 대기`
                        );
                        continue;
                    }

                    // Grace period 만료 → 포지션 종료 확정
                    delete this.missingCount[posKey];
                    delete this.firstMissingTime[posKey];

                    console.log(`[Sync] ✅ ${pos.ticker} ${count}회 연속 미확인 (${(elapsed / 1000).toFixed(1)}s) → 종료 확정`);

                    pos.status = 'closed';
                    pos.closeTimestamp = now;

                    // TP hit 자동 감지
                    let detectedAsTpHit = false;
                    if (pos.targetPrice && pos.entryPrice) {
                        const tpDistPercent = Math.abs(pos.targetPrice - pos.entryPrice) / pos.entryPrice;
                        const mfePct = (pos.analytics?.maxFavorableExcursion || 0) / 100;
                        if (tpDistPercent > 0 && mfePct >= tpDistPercent * 0.85) {
                            detectedAsTpHit = true;
                        }
                    }

                    pos.reasonForExit = pos.isTp1Hit
                        ? (detectedAsTpHit ? 'tp_hit' : 'partial_tp')
                        : (detectedAsTpHit ? 'tp_hit' : 'exchange_close');

                    // PnL 조회
                    await this.fetchClosedPnl(pos);

                    // analytics 기록
                    this.recordCloseAnalytics(pos);

                    result.closedTrades.push(pos);
                }
            }

            // ★ v34c: 고아 포지션 처리 제거 — 진입 시 TP/SL 동시 설정하므로 불필요
        } catch (e) {
            console.error('[PositionManager] syncPositions error:', e);
        }

        return result;
    }

    /**
     * 리스크 관리 — SL 이탈 → 즉시 청산
     * SL은 Bybit 서버 SL에 위임 (이중 안전장치)
     */
    async manageRisk(pos: Trade): Promise<boolean> {
        try {
            const currentPrice = pos.currentPrice || pos.entryPrice;

            let isSlBroken = false;
            if (pos.direction === 'Long' && currentPrice <= pos.invalidationPrice) isSlBroken = true;
            if (pos.direction === 'Short' && currentPrice >= pos.invalidationPrice) isSlBroken = true;

            if (isSlBroken) {
                this.emit('newMessage', 'system',
                    `🚨 [SL Hit] ${pos.ticker} SL 이탈 → 즉시 청산 (SL: ${pos.invalidationPrice}, 현재: ${currentPrice})`,
                    'system_state'
                );
                await this.closePosition(pos, 'stop_loss_hit');
                return true;
            }
        } catch (e) {
            console.error(`[PositionManager] manageRisk error for ${pos.ticker}:`, e);
        }

        return false;
    }

    // ★ 트레일링 스탑 제거 — 백테스트 동기화: TP 1개만 사용, SL 고정

    /**
     * 포지션 청산 + 주문 취소
     */
    async closePosition(pos: Trade, reason: string): Promise<void> {
        try {
            await bybitService.cancelAllOrders(pos.ticker);

            const realPos = await bybitService.fetchPosition(pos.ticker);

            if (realPos && realPos.size > 0) {
                const closeSide = realPos.side === 'Buy' ? 'Sell' : 'Buy';
                const closeRes = await bybitService.closePosition(pos.ticker, realPos.size, closeSide);
                const orderId = closeRes.orderId;

                await new Promise(resolve => setTimeout(resolve, 2000));

                const execDetails = await bybitService.fetchOrderHistory(pos.ticker, orderId);
                if (execDetails && execDetails.orderStatus === 'Filled') {
                    const exitPrice = parseFloat(execDetails.avgPrice);
                    const exitFee = parseFloat(execDetails.cumExecFee);
                    const filledQty = parseFloat(execDetails.cumExecQty);

                    let grossPnl = 0;
                    if (pos.direction === 'Long') {
                        grossPnl = (exitPrice - pos.entryPrice) * filledQty;
                    } else {
                        grossPnl = (pos.entryPrice - exitPrice) * filledQty;
                    }

                    const entryFee = pos.totalFee || (filledQty * pos.entryPrice * 0.0006);
                    const netPnl = grossPnl - exitFee - entryFee;

                    pos.pnl = netPnl;
                    pos.realizedPnl = netPnl;
                    pos.exitPrice = exitPrice;
                    pos.totalFee = (pos.totalFee || 0) + exitFee;

                    if (pos.analytics) {
                        pos.analytics.exitFee = exitFee;
                        pos.analytics.totalFees = entryFee + exitFee;
                        pos.analytics.feeImpactPercent = grossPnl !== 0
                            ? parseFloat((((entryFee + exitFee) / Math.abs(grossPnl)) * 100).toFixed(2))
                            : 0;
                    }
                }

                // Dust 청산
                const dustPos = await bybitService.fetchPosition(pos.ticker);
                if (dustPos && dustPos.size > 0) {
                    await bybitService.closePosition(pos.ticker, dustPos.size, closeSide);
                }
            } else {
                // 이미 거래소에서 닫힘
                await this.fetchClosedPnl(pos);
            }
        } catch (e) {
            console.error('[PositionManager] closePosition error:', e);
        }

        this.recordCloseAnalytics(pos);

        pos.status = 'closed';
        pos.closeTimestamp = Date.now();
        pos.reasonForExit = reason as any;
    }

    /**
     * v17: 시간기반 탈출 — 스윙: 4시간 경과 + MFE ≤ 1% + PnL ≤ 0% → 청산
     * 수익 달리는 포지션(MFE > 1%)은 유지
     */
    async checkTimeExit(pos: Trade, config?: TradingConfig): Promise<boolean> {
        if (pos.status !== 'open') return false;

        // 로컬 인지 시점 기준 (가장 정확: 봇이 실제로 포지션을 인지한 순간)
        const startTime = pos.localStartTime || pos.openTimestamp || Date.now();
        const holdingMinutes = (Date.now() - startTime) / 60000;
        const timeExitMinutes = config?.swing?.timeExitMinutes ?? 240; // v17: 4시간
        if (holdingMinutes < timeExitMinutes) return false;

        const mfe = pos.analytics?.maxFavorableExcursion || 0;
        const currentPnlPct = pos.currentPrice && pos.entryPrice
            ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) *
              (pos.direction === 'Long' ? 1 : -1) * 100
            : 0;

        // v17: MFE > 1% 이면 수익 진행 중 → 시간 탈출 안 함 (트레일링에 맡김)
        if (mfe > 1.0 && currentPnlPct > 0) return false;

        // 4시간 경과 + 정체/손실 → 청산
        this.emit('newMessage', 'system',
            `⏱️ [Time Exit] ${pos.ticker} ${holdingMinutes.toFixed(0)}분 보유 | ` +
            `MFE ${mfe.toFixed(2)}% | 현재 ${currentPnlPct.toFixed(2)}% → 시간기반 청산`,
            'system_state'
        );
        await this.closePosition(pos, 'time_exit_swing');
        return true;
    }

    // ★ v34c: setupOrphanTPSL 제거 — 진입 시 TP/SL 동시 설정하므로 고아 포지션 불필요

    // ── Private helpers ──

    // Time-Decay TP — 제거됨 (position-level TP 미사용, TP1 지정가만 사용)

    /**
     * 종료된 포지션의 PnL 조회
     */
    private async fetchClosedPnl(pos: Trade): Promise<void> {
        try {
            const closedPnl = await bybitService.fetchTotalClosedPnl(
                pos.ticker,
                pos.openTimestamp,
            );

            if (closedPnl !== null && closedPnl !== 0) {
                pos.pnl = closedPnl;
                pos.realizedPnl = closedPnl;
                this.emit('newMessage', 'system',
                    `🧮 [PnL] ${pos.ticker} 실현손익: ${closedPnl.toFixed(4)} USDT`,
                    'system_state'
                );
            } else {
                // 마지막 가격으로 추정
                const lastPrice = pos.currentPrice || pos.entryPrice;
                const grossPnl = pos.direction === 'Long'
                    ? (lastPrice - pos.entryPrice) * pos.quantity
                    : (pos.entryPrice - lastPrice) * pos.quantity;
                const estimatedFee = pos.entryPrice * pos.quantity * 0.0012;
                pos.pnl = grossPnl - estimatedFee;
                pos.realizedPnl = pos.pnl;
                pos.exitPrice = lastPrice;
            }
        } catch (e) {
            console.error(`[PositionManager] fetchClosedPnl error:`, e);
            if (pos.unrealizedPnl && pos.unrealizedPnl !== 0) {
                pos.pnl = pos.unrealizedPnl;
                pos.realizedPnl = pos.unrealizedPnl;
            }
        }
    }

    /**
     * 종료 시점 analytics 기록
     */
    private recordCloseAnalytics(pos: Trade): void {
        if (!pos.analytics) return;

        const exitPrice = pos.exitPrice || pos.currentPrice || pos.entryPrice;
        const startTime = pos.localStartTime || pos.openTimestamp || Date.now();
        pos.analytics.holdingDurationMinutes = (Date.now() - startTime) / 60000;
        pos.analytics.timeToExit = pos.analytics.holdingDurationMinutes;
        pos.analytics.wasEarlyExit = pos.analytics.holdingDurationMinutes < 15;
        pos.analytics.exitTrigger = pos.reasonForExit || 'unknown';
        pos.analytics.exitRegime = pos.entrySnapshot?.regime || 'UNKNOWN';
        pos.analytics.slDistanceAtExit = pos.invalidationPrice
            ? Math.abs(exitPrice - pos.invalidationPrice) / exitPrice * 100
            : 0;
        pos.analytics.wasRegimeShiftExit = false;

        const realizedPnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) *
            (pos.direction === 'Long' ? 1 : -1) * 100;
        if (pos.analytics.maxFavorableExcursion > 0) {
            pos.analytics.exitEfficiency = (realizedPnlPct / pos.analytics.maxFavorableExcursion) * 100;
        }
        if (pos.analytics.maxAdverseExcursion > 0) {
            pos.analytics.riskRewardRatio = realizedPnlPct / pos.analytics.maxAdverseExcursion;
        }

        if (pos.pnl !== undefined) {
            const pnlPct = pos.initialMargin ? (pos.pnl / pos.initialMargin) * 100 : 0;
            pos.verdict = pnlPct > 0 ? `WIN (+${pnlPct.toFixed(1)}%)` : `LOSS (${pnlPct.toFixed(1)}%)`;
        }
    }
}
