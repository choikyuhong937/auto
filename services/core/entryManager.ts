/**
 * EntryManager — 존 모니터링 + 트리거 + 필터
 *
 * tradingEngine.ts에서 추출:
 * - monitorWaitingCandidates()의 핵심 로직
 * - 가격 트리거 체크
 * - Wick 확인 (데이터 근거: 50-53% vs 31% WR)
 * - 필터 데이터 태그 수집 (log-only)
 */

import type {
    KlineData, WaitingCandidate, TradingConfig,
} from '../../types';
import * as bybitService from '../bybitService';
import { calculateADX, calculateATR, calculateRSI } from '../indicatorService';

// ── 상수 ──

const CANDIDATE_ROTATION_MS = 2 * 60 * 60 * 1000; // v17: 45분→2시간 (스윙 후보 유효기간)
// ★ 존 대기 완전 제거 — 모든 후보 즉시진입 (_immediateEntry=true)
const WICK_CHECK_CANDLES = 3;
const WICK_MIN_RATIO = 0.25;
// ★ 모멘텀 바이패스: 풀백 없이 TP 방향으로 이탈 시 시장 진입
const MOMENTUM_BYPASS_MIN_MS = 30 * 60 * 1000;    // 30분 대기 후 허용
const MOMENTUM_BYPASS_MAX_ZONE_MULT = 5.0;         // 존 폭의 5배까지 허용
// v17: 15초 타임아웃 완전 제거 — 모멘텀 score 미달 시 진입 거부

// ── 타입 ──

export interface MonitorResult {
    triggered: WaitingCandidate[];   // 실행 대상
    expired: string[];               // 만료된 ticker
}

export class EntryManager {
    private lastPriceFetchTime = 0;
    private latestPrices: Record<string, number> = {};

    constructor(
        private emit: (type: string, sender: string, msg: string, category?: string) => void,
    ) {}

    /**
     * 대기 후보 모니터링 — 메인 루프에서 200ms 간격 호출
     * ★ 즉시진입 후보: 바로 트리거 (스캔 통과 = 진입)
     * ★ 존 대기 후보: 1분봉 마감가 기준으로 존 HIT 체크
     */
    async monitorCandidates(
        candidates: WaitingCandidate[],
        openPositionCount: number,
        maxPositions: number,
        config: TradingConfig,
    ): Promise<MonitorResult> {
        const now = Date.now();
        const result: MonitorResult = { triggered: [], expired: [] };

        if (candidates.length === 0) return result;

        // 동시 포지션 상한 도달 시 모니터링 중단
        if (openPositionCount >= maxPositions) {
            return result;
        }

        // 가격 갱신 (2초 간격)
        if (now - this.lastPriceFetchTime > 2000) {
            const tickers = candidates.map(c => c.ticker);
            try {
                const prices = await bybitService.fetchCurrentPrices(tickers);
                this.latestPrices = { ...this.latestPrices, ...prices };
                this.lastPriceFetchTime = now;
            } catch {}
        }

        for (const candidate of [...candidates]) {
            const currentPrice = this.latestPrices[candidate.ticker];
            if (!currentPrice) continue;

            // v17: 2시간 만료 체크 (스윙)
            if (now - candidate.timestamp > CANDIDATE_ROTATION_MS) {
                result.expired.push(candidate.ticker);
                this.emit('newMessage', 'system',
                    `♻️ [Rotation] ${candidate.ticker} 2시간 경과: 반응 없는 후보 교체.`,
                    'system_state'
                );
                continue;
            }

            const zone = candidate.entryZones[0];
            if (!zone) continue;

            // 트리거 체크
            const triggered = this.checkTrigger(candidate, currentPrice);
            if (!triggered) continue;

            // v22: 모멘텀 확인 제거 — WaveTrend+Ichimoku가 품질 게이트 대체
            // 데이터 태그 수집 (log-only, 차단 없음)
            await this.collectFilterTags(candidate, currentPrice);

            result.triggered.push(candidate);

            // 1개 트리거되면 이번 루프에서는 종료 (연속 실행 방지)
            break;
        }

        return result;
    }

    /**
     * 가격 트리거 체크 (★ 1분봉 마감가 기준)
     * 즉시진입: 시그널 발생 후 첫 1분봉 마감 시 바로 트리거
     * 존 대기: 1분봉 마감가가 존 안에 있으면 트리거
     */
    private checkTrigger(candidate: WaitingCandidate, currentPrice: number): boolean {
        // ★ 즉시 진입: 다음 1분봉 마감 시 트리거 (백테스팅의 다음 캔들 시장가 진입과 동일)
        if ((candidate as any)._immediateEntry) return true;

        // ★ 모든 존 체크 (PB, FLOW, BREAKOUT 등 어느 존이든 HIT이면 트리거)
        for (let i = 0; i < candidate.entryZones.length; i++) {
            const zone = candidate.entryZones[i];
            if (!zone) continue;

            // 존 안에 있으면 즉시 트리거
            if (currentPrice >= zone.minPrice && currentPrice <= zone.maxPrice) {
                (candidate as any)._triggeredZoneIdx = i;
                return true;
            }

            // ★ 추격진입: 존을 벗어났지만 방향이 맞고, 존 폭의 50% 이내면 추격 진입
            const zoneWidth = Math.max(zone.maxPrice - zone.minPrice, currentPrice * 0.001); // 최소 0.1%
            const chaseMargin = zoneWidth * 0.5;

            if (candidate.direction === 'Long' && currentPrice > zone.maxPrice) {
                if (currentPrice <= zone.maxPrice + chaseMargin) {
                    (candidate as any)._chaseEntry = true;
                    (candidate as any)._triggeredZoneIdx = i;
                    return true;
                }
            } else if (candidate.direction === 'Short' && currentPrice < zone.minPrice) {
                if (currentPrice >= zone.minPrice - chaseMargin) {
                    (candidate as any)._chaseEntry = true;
                    (candidate as any)._triggeredZoneIdx = i;
                    return true;
                }
            }

            // ★ 모멘텀 바이패스: 체이스 범위 초과 + 30분 경과 → TP 방향 모멘텀 확인 시 진입
            const elapsed = Date.now() - candidate.timestamp;
            if (elapsed >= MOMENTUM_BYPASS_MIN_MS) {
                const maxChaseDistance = zoneWidth * MOMENTUM_BYPASS_MAX_ZONE_MULT;

                if (candidate.direction === 'Long' && currentPrice > zone.maxPrice) {
                    const dist = currentPrice - zone.maxPrice;
                    if (dist > chaseMargin && dist <= maxChaseDistance) {
                        (candidate as any)._momentumChase = true;
                        (candidate as any)._triggeredZoneIdx = i;
                        return true;
                    }
                } else if (candidate.direction === 'Short' && currentPrice < zone.minPrice) {
                    const dist = zone.minPrice - currentPrice;
                    if (dist > chaseMargin && dist <= maxChaseDistance) {
                        (candidate as any)._momentumChase = true;
                        (candidate as any)._triggeredZoneIdx = i;
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * 필터 데이터 태그 수집 — log-only, 차단 없음
     * 추후 autoTuner 분석 근거 확보
     */
    private async collectFilterTags(
        candidate: WaitingCandidate,
        currentPrice: number,
    ): Promise<void> {
        if (!(candidate as any)._entryDataTags) {
            (candidate as any)._entryDataTags = {};
        }
        const tags = (candidate as any)._entryDataTags;

        // ADX 체크
        try {
            const klines1h = await bybitService.fetchSingleTimeframeKlines(candidate.ticker, '1h', 30);
            const adxArray = calculateADX(klines1h, 14);
            const currentAdx = adxArray.pop() || 0;
            const zone = candidate.entryZones[0];
            const adxThreshold = 20;
            if (currentAdx < adxThreshold) {
                tags.lowAdxWouldBlock = true;
                tags.lowAdxValue = currentAdx;
            }
        } catch {}

        // 존 근접도
        const zone = candidate.entryZones[0];
        if (zone) {
            const zoneMid = (zone.minPrice + zone.maxPrice) / 2;
            tags.zoneProximityPct = Math.abs(currentPrice - zoneMid) / zoneMid;
        }
    }

    /**
     * 진입 품질 게이트 — 레인지 위치 + 볼륨비 + 추격 차단
     *
     * 백테스트 결과 (252건, 24시간):
     *   레인지 필터 (L≤30%, S≥70%): WR 44%→60%, PnL -$15.5→+$2.85
     *   볼륨 ≥1.2x: WR 44%→54%, PnL -$15.5→-$1.05
     *   추격 차단 (0.3%): 단독 효과 약하지만 복합 시 시너지
     *
     * @returns null이면 통과, string이면 차단 사유
     */
    async checkEntryQuality(
        ticker: string,
        direction: 'Long' | 'Short',
        currentPrice: number,
        config: TradingConfig,
        sentimentScore?: import('../../types').SentimentScore,
        sentimentData?: import('../../types').SentimentData,     // Phase 2: L/S ratio 접근용
        vwapData?: import('../../types').VWAPData,               // Phase 2: VWAP 접근용
        waveTrendData?: import('../../types').WaveTrendData,     // Phase 3: WaveTrend 모멘텀
        ichimokuData?: import('../../types').IchimokuData,       // Phase 3: Ichimoku Cloud
        simpleRegime?: string,                                           // v24: 레짐 적응형
    ): Promise<{ pass: boolean; reason: string; rangePos?: number; momentum?: number; volumeRatio?: number }> {
        // v24: 레짐 적응형 품질 게이트
        const isRanging = simpleRegime === 'RANGING';

        try {
            const klines1h = await bybitService.fetchSingleTimeframeKlines(ticker, '1h', 15);

            if (isRanging) {
                // ── RANGING 전용: 레인지 포지션 체크 (ADX/WaveTrend 스킵) ──
                // 레인지 내 위치 확인 → Long은 하단 40% 이내, Short은 상단 40% 이내
                if (klines1h.length >= 5) {
                    const recent = klines1h.slice(-10);
                    const high = Math.max(...recent.map(k => k.high));
                    const low = Math.min(...recent.map(k => k.low));
                    const range = high - low;
                    if (range > 0) {
                        const rangePos = ((currentPrice - low) / range) * 100;
                        if (direction === 'Long' && rangePos > 50) {
                            return {
                                pass: false,
                                reason: `range_high_long: 레인지 ${rangePos.toFixed(0)}% > 50% (Long은 하단 진입)`,
                                rangePos,
                            };
                        }
                        if (direction === 'Short' && rangePos < 50) {
                            return {
                                pass: false,
                                reason: `range_low_short: 레인지 ${rangePos.toFixed(0)}% < 50% (Short은 상단 진입)`,
                                rangePos,
                            };
                        }
                        return { pass: true, reason: 'ranging_position_ok', rangePos };
                    }
                }
                return { pass: true, reason: 'ranging_pass' };
            }

            // WaveTrend 필터 제거: 존 진입과 구조적 충돌 (존 도달 = 모멘텀 반대 = 항상 차단)
            // ADX는 스캔 단계에서 이미 체크, WT 데이터는 analytics용으로만 보존

            return { pass: true, reason: 'quality_pass' };
        } catch (e) {
            return { pass: true, reason: 'quality_check_error' };
        }
    }

    /**
     * 최신 가격 조회
     */
    getLatestPrice(ticker: string): number | undefined {
        return this.latestPrices[ticker];
    }

    /**
     * 전체 가격 맵 반환 (UI 동기화용)
     */
    getAllLatestPrices(): Record<string, number> {
        return { ...this.latestPrices };
    }

    /**
     * 가격 맵 업데이트 (외부에서 설정)
     */
    updatePrices(prices: Record<string, number>): void {
        this.latestPrices = { ...this.latestPrices, ...prices };
    }
}
