/**
 * SentimentService — Funding Rate + OI + CVD 통합 감성 분석
 *
 * Phase 1: 진입 필터 + 점수 산출
 * - Funding Rate: 극단 FR → 역방향 차단, 높은 FR → 감점
 * - Open Interest: OI-가격 다이버전스 감지
 * - CVD: 매수/매도 불균형 → 가격 다이버전스 감지
 *
 * 사용처:
 *   1. tradingEngine.ts fullScanTicker (스캔 시 센티먼트 수집)
 *   2. entryManager.ts checkEntryQuality (12번 필터: 센티먼트 게이트)
 *   3. execution.ts entrySnapshot (사후 분석용 기록)
 */

import type { SentimentData, SentimentScore, TradingConfig, LongShortRatioData } from '../types';
import * as bybitService from './bybitService';

export class SentimentService {
    // 종목별 캐시 (4분 TTL — 5분 스캔 사이클 내 재사용)
    private cache: Map<string, { data: SentimentData; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 4 * 60 * 1000;

    // WebSocket CVD 접근자 (tradingEngine에서 주입)
    private getCVD: ((ticker: string) => { delta: number; buyVolume: number; sellVolume: number }) | null = null;

    constructor() {}

    /**
     * WebSocket CVD 접근자 주입 (TradingEngine 초기화 시 1회 호출)
     */
    setWsCVDAccessor(fn: (ticker: string) => { delta: number; buyVolume: number; sellVolume: number }) {
        this.getCVD = fn;
    }

    /**
     * 센티먼트 원시 데이터 수집
     * - 병렬: fetchTickerStats + fetchFundingHistory(3) + fetchOpenInterest('1h', 5)
     * - CVD: WebSocket 캐시에서 즉시 조회 (0 API 콜)
     *
     * @param ticker 심볼
     * @param currentPrice 현재가
     * @param priceChange1h 최근 1시간 가격 변화율 (%)
     */
    async fetchSentimentData(
        ticker: string,
        currentPrice: number,
        priceChange1h: number,
    ): Promise<SentimentData> {
        // 캐시 확인
        const cached = this.cache.get(ticker);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached.data;
        }

        // 병렬 API 호출 (4 calls — Phase 2: +1 L/S Ratio)
        const [tickerStats, fundingHistory, oiData, lsRatioData] = await Promise.all([
            bybitService.fetchTickerStats(ticker),
            bybitService.fetchFundingHistory(ticker, 3),
            bybitService.fetchOpenInterest(ticker, '1h', 5),
            bybitService.fetchLongShortRatio(ticker, '1h', 1),  // Phase 2
        ]);

        // ── Funding Rate ──
        const fundingRate = tickerStats?.fundingRate || 0;
        const frHistory = fundingHistory.map(f => f.fundingRate);

        let fundingTrend: SentimentData['fundingTrend'] = 'STABLE';
        if (frHistory.length >= 2) {
            // Bybit: list는 최신순 → frHistory[0] = 가장 최근
            const newest = frHistory[0];
            const oldest = frHistory[frHistory.length - 1];
            const diff = newest - oldest;
            if (diff > 0.0001) fundingTrend = 'RISING';
            else if (diff < -0.0001) fundingTrend = 'FALLING';
        }

        // ── Open Interest ──
        let oiCurrent = 0, oiChange1h = 0, oiChange4h = 0;
        if (oiData.length >= 2) {
            // Bybit OI: list는 최신순 → oiData[0] = 가장 최근
            oiCurrent = oiData[0].openInterest;
            const oi1hAgo = oiData[1]?.openInterest || oiCurrent;
            oiChange1h = oi1hAgo > 0 ? ((oiCurrent - oi1hAgo) / oi1hAgo) * 100 : 0;

            const oi4hIdx = Math.min(4, oiData.length - 1);
            const oi4hAgo = oiData[oi4hIdx]?.openInterest || oiCurrent;
            oiChange4h = oi4hAgo > 0 ? ((oiCurrent - oi4hAgo) / oi4hAgo) * 100 : 0;
        }

        // OI-가격 다이버전스 판별
        const priceUp = priceChange1h > 0.1;    // 가격 상승 > 0.1%
        const priceDown = priceChange1h < -0.1;  // 가격 하락 > 0.1%
        const oiUp = oiChange1h > 0.5;           // OI 상승 > 0.5%
        const oiDown = oiChange1h < -0.5;        // OI 하락 > 0.5%

        let oiPriceDivergence: SentimentData['oiPriceDivergence'] = 'CONFIRMING';
        if (priceUp && oiUp) oiPriceDivergence = 'CONFIRMING';           // 강한 상승 (신규 롱)
        else if (priceUp && oiDown) oiPriceDivergence = 'WEAK_RALLY';    // 약한 상승 (숏 커버링)
        else if (priceDown && oiUp) oiPriceDivergence = 'CONFIRMING_SHORT'; // 강한 하락 (신규 숏)
        else if (priceDown && oiDown) oiPriceDivergence = 'WEAK_DECLINE';   // 약한 하락 (롱 정리)

        // ── CVD ──
        let cvd5min = 0;
        let cvdTrend: SentimentData['cvdTrend'] = 'NEUTRAL';
        let cvdPriceDivergence = false;

        if (this.getCVD) {
            const cvdResult = this.getCVD(ticker);
            cvd5min = cvdResult.delta;
            const totalVol = cvdResult.buyVolume + cvdResult.sellVolume;
            if (totalVol > 0) {
                const cvdRatio = cvd5min / totalVol; // -1 ~ +1
                if (cvdRatio > 0.05) cvdTrend = 'BULLISH';
                else if (cvdRatio < -0.05) cvdTrend = 'BEARISH';
            }
            // CVD-가격 다이버전스: 가격 상승인데 매도 우세, 또는 반대
            cvdPriceDivergence = (priceUp && cvdTrend === 'BEARISH') ||
                                 (priceDown && cvdTrend === 'BULLISH');
        }

        // ── Phase 2: L/S Ratio ──
        let longShortRatio: LongShortRatioData | undefined;
        if (lsRatioData.length > 0) {
            const ls = lsRatioData[0];
            longShortRatio = {
                buyRatio: ls.buyRatio,
                sellRatio: ls.sellRatio,
                ratio: ls.sellRatio > 0 ? ls.buyRatio / ls.sellRatio : 1.0,
                timestamp: ls.timestamp,
            };
        }

        const data: SentimentData = {
            ticker,
            timestamp: Date.now(),
            fundingRate,
            fundingTrend,
            fundingHistory: frHistory,
            oiCurrent,
            oiChange1h,
            oiChange4h,
            oiPriceDivergence,
            cvd5min,
            cvdTrend,
            cvdPriceDivergence,
            // Phase 2
            longShortRatio,
        };

        // 캐시 저장
        this.cache.set(ticker, { data, timestamp: Date.now() });
        return data;
    }

    /**
     * 통합 센티먼트 점수 산출
     *
     * 점수 범위: -100 (극강 약세) ~ +100 (극강 강세)
     * - fundingComponent: -33 ~ +33 (역상관 — 높은 FR = 약세)
     * - oiComponent: -33 ~ +33
     * - cvdComponent: -34 ~ +34
     *
     * blockLong/blockShort: 극단 펀딩비 시 해당 방향 하드 블록
     */
    calculateSentimentScore(
        data: SentimentData,
        direction: 'Long' | 'Short',
        config: TradingConfig,
    ): SentimentScore {
        const signals: string[] = [];
        let fundingComponent = 0;
        let oiComponent = 0;
        let cvdComponent = 0;
        let blockLong = false;
        let blockShort = false;

        const frExtreme = config.filters.frExtremeThreshold ?? 0.05;
        const frHigh = config.filters.frHighThreshold ?? 0.03;
        // FR은 소수점 그대로 (예: 0.0001 = 0.01%)
        // 퍼센트로 변환: × 100
        const frPercent = data.fundingRate * 100;

        // ── Funding Rate Component (-33 ~ +33) ──
        // 역상관: 극단 positive FR = longs 과밀 = 약세 시그널
        if (frPercent > frExtreme) {
            fundingComponent = -33;
            blockLong = true;
            signals.push(`🔴 FR 극단 양수 (${frPercent.toFixed(3)}%): Long 차단`);
        } else if (frPercent < -frExtreme) {
            fundingComponent = 33;
            blockShort = true;
            signals.push(`🔴 FR 극단 음수 (${frPercent.toFixed(3)}%): Short 차단`);
        } else if (frPercent > frHigh) {
            fundingComponent = -Math.round((frPercent / frExtreme) * 25);
            signals.push(`🟡 FR 높음 (${frPercent.toFixed(3)}%): Long 감점`);
        } else if (frPercent < -frHigh) {
            fundingComponent = Math.round((Math.abs(frPercent) / frExtreme) * 25);
            signals.push(`🟡 FR 낮음 (${frPercent.toFixed(3)}%): Short 감점`);
        } else {
            // 약한 FR: 미세 역상관
            fundingComponent = Math.round(-frPercent / frHigh * 8);
        }

        // FR 트렌드 보너스
        if (data.fundingTrend === 'RISING') {
            fundingComponent -= 5; // FR 상승 = 롱 과밀화 중 → 약세
            signals.push('FR 트렌드 상승 중');
        } else if (data.fundingTrend === 'FALLING') {
            fundingComponent += 5;
            signals.push('FR 트렌드 하락 중');
        }

        fundingComponent = Math.max(-33, Math.min(33, fundingComponent));

        // ── OI Component (-33 ~ +33) ──
        switch (data.oiPriceDivergence) {
            case 'CONFIRMING':
                oiComponent = 20; // 가격↑+OI↑ = 강한 상승
                signals.push('✅ OI 확인: 가격↑+OI↑ (강한 상승)');
                break;
            case 'WEAK_RALLY':
                oiComponent = -15; // 가격↑+OI↓ = 약한 상승 (숏 커버링)
                signals.push('⚠️ 약한 랠리: 가격↑+OI↓ (숏 커버링)');
                break;
            case 'CONFIRMING_SHORT':
                oiComponent = -20; // 가격↓+OI↑ = 강한 하락
                signals.push('✅ OI 확인: 가격↓+OI↑ (강한 하락)');
                break;
            case 'WEAK_DECLINE':
                oiComponent = 15; // 가격↓+OI↓ = 약한 하락 (롱 정리)
                signals.push('⚠️ 약한 하락: 가격↓+OI↓ (롱 정리)');
                break;
        }

        // OI 급변 보너스 (1시간 3% 이상 변화)
        if (Math.abs(data.oiChange1h) > 3) {
            const oiBonus = data.oiChange1h > 0 ? 10 : -10;
            oiComponent += oiBonus;
            signals.push(`OI 급변: ${data.oiChange1h.toFixed(1)}%/1h`);
        }

        oiComponent = Math.max(-33, Math.min(33, oiComponent));

        // ── CVD Component (-34 ~ +34) ──
        if (data.cvdTrend === 'BULLISH') cvdComponent = 20;
        else if (data.cvdTrend === 'BEARISH') cvdComponent = -20;

        if (data.cvdPriceDivergence) {
            if (data.cvdTrend === 'BEARISH') {
                cvdComponent = -30;
                signals.push('🔴 CVD 약세 다이버전스: 가격↑인데 매도 우세');
            } else if (data.cvdTrend === 'BULLISH') {
                cvdComponent = 30;
                signals.push('🟢 CVD 강세 다이버전스: 가격↓인데 매수 우세');
            }
        } else if (data.cvdTrend !== 'NEUTRAL') {
            signals.push(`CVD ${data.cvdTrend}: 방향 일치`);
        }

        cvdComponent = Math.max(-34, Math.min(34, cvdComponent));

        // ── Phase 2: L/S Ratio Component (-15 ~ +15) ── (역상관: 군중 반대편)
        let lsRatioComponent = 0;
        if (data.longShortRatio) {
            const r = data.longShortRatio.ratio;
            const crowdedLong = config.filters.lsRatioCrowdedLong ?? 2.0;
            const crowdedShort = config.filters.lsRatioCrowdedShort ?? 0.5;

            if (r > crowdedLong) {
                lsRatioComponent = -15;
                signals.push(`🔴 L/S=${r.toFixed(2)}: Longs 과밀 (역방향)`);
            } else if (r < crowdedShort) {
                lsRatioComponent = 15;
                signals.push(`🔴 L/S=${r.toFixed(2)}: Shorts 과밀 (역방향)`);
            } else if (r > 1.5) {
                lsRatioComponent = -8;
            } else if (r < 0.67) {
                lsRatioComponent = 8;
            }
        }

        // ── 합산 (기존 100점 + LS 15점 = 115점 가능 → clamp -100~+100) ──
        const score = Math.max(-100, Math.min(100,
            fundingComponent + oiComponent + cvdComponent + lsRatioComponent
        ));

        return {
            score,
            fundingComponent,
            oiComponent,
            cvdComponent,
            lsRatioComponent,
            signals,
            blockLong,
            blockShort,
        };
    }

    /**
     * 캐시 정리 (특정 종목 또는 전체)
     */
    clearCache(ticker?: string) {
        if (ticker) this.cache.delete(ticker);
        else this.cache.clear();
    }
}
