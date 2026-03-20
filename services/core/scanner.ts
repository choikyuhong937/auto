/**
 * Scanner — 방향 감지 + 레짐 분류
 *
 * tradingEngine.ts에서 추출:
 * - checkTrendSetup() → detectDirection()
 * - classifyCryptoRegime() → classifyRegime()
 * - calculateRegimeComponents(), scoreAllRegimes(), determineSubRegime(), getRegimeTradingParams()
 */

import type {
    KlineData, CryptoMarketRegime, CryptoRegimeComponents,
    CryptoRegimeResult, RegimeTradingParams, SimpleRegime,
} from '../../types';

import {
    calculateEMA, calculateRSI, calculateATR, calculateADX,
    calculateBollingerBands, calculateSlope, calculateChoppinessIndex,
    calculateWickRatio, calculateROC,
} from '../indicatorService';

import * as bybitService from '../bybitService';

export interface DirectionResult {
    side: 'Long' | 'Short' | null;
    score: number;
    reason: string;
    volatilityAccel?: number;   // ATR 가속도 (1.0 = 평균, >1.3 = 변동 시작)
    volumeRatio?: number;       // 볼륨 vs 평균 비율
    rsiSlope?: number;          // RSI 기울기
}

export interface TimeframeSelection {
    timeframe: '5m' | '15m' | '1h' | '4h';
    klines: KlineData[];
    quality: number;            // 신호 품질 (0-100)
    reason: string;
}

export interface RegimeResult extends CryptoRegimeResult {
    simpleRegime: SimpleRegime;
}

// SimpleRegime 매핑
function toSimpleRegime(regime: CryptoMarketRegime): SimpleRegime {
    const trending: CryptoMarketRegime[] = ['TREND_IMPULSE', 'TREND_CONTINUATION', 'BREAKOUT_EXPANSION'];
    const volatile: CryptoMarketRegime[] = ['TREND_EXHAUSTION', 'VOLATILITY_EXPLOSION', 'LIQUIDATION_CASCADE'];
    if (trending.includes(regime)) return 'TRENDING';
    if (volatile.includes(regime)) return 'VOLATILE';
    return 'RANGING';
}

export class Scanner {
    private regimeCache: Record<string, { result: RegimeResult; timestamp: number }> = {};
    private readonly REGIME_CACHE_TTL_MS = 30_000;  // ★ v35f: 60초→30초 (적응력 향상)
    private simulationMode = false;

    /** 시뮬레이션 모드: 캐시 비활성화 → 순수 계산만 (결정론적 결과) */
    setSimulationMode(enabled: boolean) {
        this.simulationMode = enabled;
        if (enabled) {
            this.regimeCache = {};
        }
    }

    // ── 적응형 타임프레임 선택 ──

    /**
     * 코인별 최적 분석 타임프레임 자동 선택 (5m/15m/1h/4h)
     *
     * 각 TF의 신호 품질을 평가:
     * - ATR 명확도: ATR이 안정적이고 충분한 크기 (노이즈 적음)
     * - 캔들 바디비: 바디 비율이 높을수록 방향성 명확
     * - 트렌드 일관성: EMA 정렬이 깨끗한지
     * - ADX 강도: 방향 강도가 읽히는지
     * - 볼륨 프로파일: 볼륨이 트렌드를 지지하는지
     *
     * @returns 최적 TF + klines + 품질 점수
     */
    async selectOptimalTimeframe(ticker: string): Promise<TimeframeSelection> {
        const timeframes: Array<'5m' | '15m' | '1h' | '4h'> = ['5m', '15m', '1h', '4h'];
        const candidates: TimeframeSelection[] = [];

        // 병렬로 모든 TF klines 가져오기
        const klinesPromises = timeframes.map(async (tf) => {
            try {
                const klines = await bybitService.fetchSingleTimeframeKlines(ticker, tf, 100);
                return { tf, klines };
            } catch {
                return { tf, klines: [] as KlineData[] };
            }
        });

        const results = await Promise.all(klinesPromises);

        for (const { tf, klines } of results) {
            if (klines.length < 50) continue;

            const quality = this.evaluateTimeframeQuality(klines);
            candidates.push({
                timeframe: tf,
                klines,
                quality: quality.total,
                reason: quality.reason,
            });
        }

        // 후보가 없으면 15m 폴백
        if (candidates.length === 0) {
            const fallbackKlines = results.find(r => r.tf === '15m')?.klines || [];
            return {
                timeframe: '15m',
                klines: fallbackKlines,
                quality: 0,
                reason: 'fallback: insufficient data',
            };
        }

        // 품질 기준 정렬, 동점이면 15m 우선 (중간 해상도 선호)
        candidates.sort((a, b) => {
            if (Math.abs(a.quality - b.quality) < 5) {
                // 5점 이내 동점이면 15m > 1h > 5m > 4h 선호
                const priority: Record<string, number> = { '15m': 4, '1h': 3, '5m': 2, '4h': 1 };
                return (priority[b.timeframe] || 0) - (priority[a.timeframe] || 0);
            }
            return b.quality - a.quality;
        });

        const best = candidates[0];
        console.log(
            `[Scanner] 📐 ${ticker} TF 선택: ${best.timeframe} (Q=${best.quality.toFixed(0)}) | ` +
            `${best.reason} | ` +
            `후보: ${candidates.map(c => `${c.timeframe}(${c.quality.toFixed(0)})`).join(', ')}`
        );

        return best;
    }

    /**
     * 타임프레임 신호 품질 평가 (0-100)
     */
    private evaluateTimeframeQuality(klines: KlineData[]): { total: number; reason: string } {
        const closes = klines.map(k => k.close);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);
        const volumes = klines.map(k => k.volume);

        let total = 0;
        const parts: string[] = [];

        // 1. ATR 명확도 (0-25) — ATR이 안정적이고 노이즈가 적을수록 좋음
        const atrArr = calculateATR(klines, 14);
        if (atrArr.length >= 20) {
            const recent = atrArr.slice(-20);
            const atrMean = recent.reduce((a, b) => a + b, 0) / recent.length;
            const atrStd = Math.sqrt(recent.reduce((a, b) => a + (b - atrMean) ** 2, 0) / recent.length);
            const cv = atrMean > 0 ? atrStd / atrMean : 1;  // coefficient of variation
            // CV가 낮을수록 ATR이 안정적 → 더 좋은 신호
            const atrScore = Math.max(0, Math.min(25, Math.round((1 - cv) * 30)));
            total += atrScore;
            parts.push(`ATR=${atrScore}`);
        }

        // 2. 캔들 바디비 (0-25) — 바디가 클수록 방향성 명확
        const recentCandles = klines.slice(-20);
        const bodyRatios = recentCandles.map(k => {
            const fullRange = k.high - k.low;
            return fullRange > 0 ? Math.abs(k.close - k.open) / fullRange : 0;
        });
        const avgBodyRatio = bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length;
        const bodyScore = Math.round(avgBodyRatio * 25);  // 0~25
        total += bodyScore;
        parts.push(`Body=${bodyScore}`);

        // 3. 트렌드 일관성 (0-20) — EMA20/50 정렬 + 방향 일관
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        if (ema20.length >= 10 && ema50.length >= 10) {
            let aligned = 0;
            for (let i = Math.max(ema20.length, ema50.length) - 10; i < Math.max(ema20.length, ema50.length); i++) {
                const e20 = ema20[Math.min(i, ema20.length - 1)];
                const e50 = ema50[Math.min(i, ema50.length - 1)];
                if (e20 !== undefined && e50 !== undefined) {
                    // 같은 방향으로 계속 정렬되면 가산
                    const diff = e20 - e50;
                    const prevI = Math.max(0, i - 1);
                    const prevE20 = ema20[Math.min(prevI, ema20.length - 1)];
                    const prevE50 = ema50[Math.min(prevI, ema50.length - 1)];
                    if (prevE20 !== undefined && prevE50 !== undefined) {
                        const prevDiff = prevE20 - prevE50;
                        if ((diff > 0 && prevDiff > 0) || (diff < 0 && prevDiff < 0)) aligned++;
                    }
                }
            }
            const trendScore = Math.round((aligned / 9) * 20);
            total += trendScore;
            parts.push(`Trend=${trendScore}`);
        }

        // 4. ADX 강도 (0-15) — 방향 명확도
        const adxArr = calculateADX(klines, 14);
        const lastAdx = adxArr.length > 0 ? adxArr[adxArr.length - 1] : 0;
        const adxScore = Math.min(15, Math.round(lastAdx / 3));  // ADX 45+ → 15점 만점
        total += adxScore;
        parts.push(`ADX=${adxScore}`);

        // 5. 볼륨 트렌드 지지 (0-15) — 트렌드 방향에 볼륨이 동반되는지
        if (volumes.length >= 20) {
            const vol20 = volumes.slice(-20);
            const avgVol = vol20.reduce((a, b) => a + b, 0) / vol20.length;
            const recentVol = vol20.slice(-5).reduce((a, b) => a + b, 0) / 5;
            const volTrend = avgVol > 0 ? recentVol / avgVol : 1;

            // 최근 가격 방향과 볼륨이 일치하면 가산
            const volUp = volTrend > 1.0;
            const volScore = volUp ? Math.min(15, Math.round(volTrend * 8)) : Math.round(volTrend * 4);
            total += volScore;
            parts.push(`Vol=${volScore}`);
        }

        return { total: Math.min(100, total), reason: parts.join(' ') };
    }

    // ── 방향 감지 (v12: DMI + 가격모멘텀 반전감지 + ATR가속 + RSI슬로프 + 볼륨) ──

    detectDirection(klines: KlineData[], _currentPrice: number): DirectionResult {
        const { pdi, mdi, adx } = this.calculateDMI(klines, 14);

        // ATR 가속도 — 최근 ATR vs 10봉 전 ATR
        const atrArr = calculateATR(klines, 14);
        const atrNow = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 0;
        const atr10ago = atrArr.length > 10 ? atrArr[atrArr.length - 11] : atrNow;
        const volatilityAccel = atr10ago > 0 ? atrNow / atr10ago : 1.0;

        // RSI 슬로프 — 최근 5봉 RSI 변화율
        const closes = klines.map(k => k.close);
        const rsiArr = calculateRSI(closes, 14);
        const rsiSlope = calculateSlope(rsiArr.slice(-10), 5);

        // 볼륨 비율 — 최근 3봉 평균 vs 20봉 평균
        const volumes = klines.map(k => k.volume);
        const vol20avg = volumes.length >= 20
            ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : 1;
        const vol3avg = volumes.length >= 3
            ? volumes.slice(-3).reduce((a, b) => a + b, 0) / 3 : 1;
        const volumeRatio = vol20avg > 0 ? vol3avg / vol20avg : 1.0;

        // ── v12: 가격 모멘텀 (최근 5봉 close 방향) — DMI보다 빠른 반전 감지 ──
        let priceMomentumSide: 'Long' | 'Short' | null = null;
        let priceMomPct = 0;
        if (closes.length >= 5) {
            const recent5 = closes.slice(-5);
            priceMomPct = ((recent5[recent5.length - 1] - recent5[0]) / recent5[0]) * 100;
            if (priceMomPct > 0.15) priceMomentumSide = 'Long';
            else if (priceMomPct < -0.15) priceMomentumSide = 'Short';
        }

        // DMI 방향
        let dmiSide: 'Long' | 'Short' | null = null;
        if (pdi > mdi) dmiSide = 'Long';
        else if (mdi > pdi) dmiSide = 'Short';

        // ── v12: 반전 감지 — DMI와 가격모멘텀이 다르면 가격모멘텀 우선 ──
        // DMI는 후행, 가격모멘텀은 현재 → 불일치 = 반전 시그널
        let side: 'Long' | 'Short' | null = null;
        let isReversal = false;

        if (dmiSide && priceMomentumSide && dmiSide !== priceMomentumSide) {
            // 반전 감지: DMI≠모멘텀 → 모멘텀(현재 방향) 채택
            side = priceMomentumSide;
            isReversal = true;
        } else if (dmiSide) {
            side = dmiSide;
        } else if (priceMomentumSide) {
            side = priceMomentumSide;
        }

        // ADX < 10이고 모멘텀도 없으면 방향 없음 (v12: 15→10 완화)
        if (!side && adx < 10 && volatilityAccel < 1.3) {
            return { side: null, score: 0, reason: '', volatilityAccel, volumeRatio, rsiSlope };
        }

        // ADX 약한데 RSI 슬로프가 방향 보강하면 허용
        if (!side && volatilityAccel >= 1.3) {
            if (rsiSlope > 0.5) side = 'Long';
            else if (rsiSlope < -0.5) side = 'Short';
        }

        if (!side) {
            return { side: null, score: 0, reason: '', volatilityAccel, volumeRatio, rsiSlope };
        }

        // 점수 = DMI기반 + 반전보너스 + 변동성가속 보너스 + 볼륨 보너스 + RSI방향일치 보너스
        let score = 50 + adx;
        // v12: 반전 감지 시 보너스 (DMI와 모멘텀 불일치 = 빠른 반전)
        if (isReversal) score += 15;
        if (volatilityAccel >= 1.5) score += 20;
        else if (volatilityAccel >= 1.3) score += 10;
        if (volumeRatio >= 2.0) score += 15;
        else if (volumeRatio >= 1.5) score += 8;
        const rsiDirectionMatch = (side === 'Long' && rsiSlope > 0.3) || (side === 'Short' && rsiSlope < -0.3);
        if (rsiDirectionMatch) score += 10;

        const reason = `${side}${isReversal ? '(반전)' : ''}: PDI=${pdi.toFixed(0)} MDI=${mdi.toFixed(0)} ADX=${adx.toFixed(0)} | ` +
            `mom=${priceMomPct.toFixed(2)}% ATRaccel=${volatilityAccel.toFixed(2)} Vol=${volumeRatio.toFixed(1)}x RSIslope=${rsiSlope.toFixed(2)}`;

        return { side, score, reason, volatilityAccel, volumeRatio, rsiSlope };
    }

    // ── 레짐 분류 ──

    async classifyRegime(ticker: string, klines?: KlineData[]): Promise<RegimeResult> {
        // 시뮬레이션 모드가 아닐 때만 캐시 사용
        if (!this.simulationMode) {
            const cached = this.regimeCache[ticker];
            if (cached && Date.now() - cached.timestamp < this.REGIME_CACHE_TTL_MS) {
                return cached.result;
            }
        }

        if (!klines || klines.length < 50) {
            try {
                klines = await bybitService.fetchSingleTimeframeKlines(ticker, '15m', 100);
            } catch {
                return this.getDefaultRegimeResult();
            }
        }
        if (klines.length < 50) return this.getDefaultRegimeResult();

        const closes = klines.map(k => k.close);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);
        const volumes = klines.map(k => k.volume);
        const currentPrice = closes[closes.length - 1];

        const components = this.calculateRegimeComponents(klines, closes, highs, lows, volumes, currentPrice);
        const scores = this.scoreAllRegimes(components, klines, closes, currentPrice);

        const sortedRegimes = Object.entries(scores).sort(([, a], [, b]) => (b as number) - (a as number));
        const [bestRegime, bestScore] = sortedRegimes[0] as [CryptoMarketRegime, number];
        const secondScore = sortedRegimes.length > 1 ? (sortedRegimes[1][1] as number) : 0;

        const scorePart = Math.min(bestScore / 100 * 60, 60);
        const marginPart = bestScore > 0
            ? Math.min(((bestScore - secondScore) / bestScore) * 60, 35)
            : 0;
        const confidence = Math.min(Math.round(scorePart + marginPart), 95);

        const subRegime = this.determineSubRegime(bestRegime, components);
        const tradingImplications = this.getRegimeTradingParams(bestRegime, components);

        const top3 = sortedRegimes.slice(0, 3).map(([r, s]) => `${r}(${Math.round(s as number)})`).join(', ');
        const reasoning =
            `[Regime] ${bestRegime}(${confidence}%) | Sub: ${subRegime || 'N/A'}\n` +
            `Top3: ${top3}\n` +
            `Trend: ${components.trendStrength.toFixed(0)}/100 ${components.trendDirection} | ` +
            `Vol: ${components.volatilityLevel.toFixed(0)}/100 ${components.volatilityTrend} | ` +
            `Hurst: ${components.hurstExponent.toFixed(2)} | Chop: ${components.choppinessIndex.toFixed(1)} | ` +
            `VolProfile: ${components.volumeProfile} | BB%: ${components.bbWidthPercentile.toFixed(0)}`;

        // v31: 히스테리시스 제거 — 백테스트/실전 동일하게 즉시 레짐 전환
        const result: RegimeResult = {
            regime: bestRegime,
            simpleRegime: toSimpleRegime(bestRegime),
            confidence,
            components,
            subRegime,
            tradingImplications,
            reasoning,
        };

        if (!this.simulationMode) {
            // ★ v35f: 레짐 급변 감지 — 이전 캐시와 레짐이 다르면 인접 종목 캐시도 무효화
            const prevCached = this.regimeCache[ticker];
            if (prevCached && prevCached.result.simpleRegime !== result.simpleRegime) {
                // 레짐 변경 = 시장 전체 변동 가능성 → 전체 캐시 초기화
                this.regimeCache = {};
            }
            this.regimeCache[ticker] = { result, timestamp: Date.now() };
        }
        return result;
    }

    // ── Private: DMI ──

    private calculateDMI(klines: KlineData[], period = 14): { pdi: number; mdi: number; adx: number } {
        if (klines.length < period * 2) return { pdi: 0, mdi: 0, adx: 0 };

        const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
        for (let i = 1; i < klines.length; i++) {
            const h = klines[i].high, l = klines[i].low;
            const ph = klines[i - 1].high, pl = klines[i - 1].low, pc = klines[i - 1].close;
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
        const lastTr = str[str.length - 1];
        const pdi = lastTr > 0 ? (spdm[spdm.length - 1] / lastTr) * 100 : 0;
        const mdi = lastTr > 0 ? (smdm[smdm.length - 1] / lastTr) * 100 : 0;
        const adxArray = calculateADX(klines, period);
        const adx = adxArray.length > 0 ? adxArray[adxArray.length - 1] : 0;

        return { pdi, mdi, adx };
    }

    // ── Private: 레짐 컴포넌트 계산 ──

    private calculateRegimeComponents(
        klines: KlineData[], closes: number[], highs: number[],
        lows: number[], volumes: number[], currentPrice: number,
    ): CryptoRegimeComponents {
        // 추세
        const adxArray = calculateADX(klines, 14);
        const currentAdx = adxArray.length > 0 ? adxArray[adxArray.length - 1] : 0;
        const adxComponent = Math.min(currentAdx / 50, 1) * 60;
        const trendStrength = Math.min(adxComponent, 100);

        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const currentEma20 = ema20[ema20.length - 1] || currentPrice;
        const currentEma50 = ema50[ema50.length - 1] || currentPrice;
        const emaGap = (currentEma20 - currentEma50) / currentEma50;

        let trendDirection: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
        if (emaGap > 0.002 && currentPrice > currentEma20) trendDirection = 'UP';
        else if (emaGap < -0.002 && currentPrice < currentEma20) trendDirection = 'DOWN';

        let trendAge = 0;
        for (let i = closes.length - 1; i > 0; i--) {
            const isUp = closes[i] > closes[i - 1];
            if ((trendDirection === 'UP' && isUp) || (trendDirection === 'DOWN' && !isUp)) trendAge++;
            else break;
        }

        // 변동성
        const atrArray = calculateATR(klines, 14);
        const currentAtr = atrArray.length > 0 ? atrArray[atrArray.length - 1] : 0;
        const volatilityRatio = currentPrice > 0 ? currentAtr / currentPrice : 0.01;
        const volatilityLevel = Math.min(volatilityRatio / 0.05 * 100, 100);

        const atr10ago = atrArray.length > 10 ? atrArray[atrArray.length - 11] : currentAtr;
        const atrChange = atr10ago > 0 ? (currentAtr - atr10ago) / atr10ago : 0;
        let volatilityTrend: 'EXPANDING' | 'CONTRACTING' | 'STABLE' = 'STABLE';
        if (atrChange > 0.15) volatilityTrend = 'EXPANDING';
        else if (atrChange < -0.15) volatilityTrend = 'CONTRACTING';

        const bb = calculateBollingerBands(closes, 20, 2);
        const currentBB = bb[bb.length - 1];
        const bbWidth = currentBB && currentBB.middle > 0
            ? ((currentBB.upper - currentBB.lower) / currentBB.middle) * 100 : 2;

        const recentBBWidths: number[] = [];
        for (let i = Math.max(0, bb.length - 50); i < bb.length; i++) {
            if (bb[i]?.middle > 0) recentBBWidths.push(((bb[i].upper - bb[i].lower) / bb[i].middle) * 100);
        }
        const sorted = [...recentBBWidths].sort((a, b) => a - b);
        const bbWidthPercentile = sorted.length > 0
            ? (sorted.findIndex(w => w >= bbWidth) / sorted.length) * 100 : 50;

        // 모멘텀
        const rsiArray = calculateRSI(closes, 14);
        const currentRsi = rsiArray.length > 0 ? rsiArray[rsiArray.length - 1] : 50;
        const rsiSlope = calculateSlope(rsiArray.slice(-10), 5);
        const rocArray = calculateROC(closes, 9);
        const currentRoc = rocArray.length > 0 ? rocArray[rocArray.length - 1] : 0;

        let divergenceDetected = false;
        if (closes.length >= 20) {
            const priceHigh = Math.max(...closes.slice(-20));
            const priceLow = Math.min(...closes.slice(-20));
            const rsiHigh = Math.max(...rsiArray.slice(-20));
            const rsiLow = Math.min(...rsiArray.slice(-20));
            if (currentPrice >= priceHigh * 0.998 && currentRsi < rsiHigh * 0.95) divergenceDetected = true;
            if (currentPrice <= priceLow * 1.002 && currentRsi > rsiLow * 1.05) divergenceDetected = true;
        }

        const momentumScore = Math.max(-100, Math.min(100, currentRoc * 5 + rsiSlope * 10 + (currentRsi - 50)));

        const avgVolume = volumes.length >= 20
            ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : volumes[volumes.length - 1] || 1;
        const volumeVsAvg = avgVolume > 0 ? (volumes[volumes.length - 1] || 0) / avgVolume : 1;

        let volumeProfile: 'CLIMAX' | 'DRYING' | 'NORMAL' | 'SURGE' = 'NORMAL';
        if (volumeVsAvg > 3.0) volumeProfile = 'CLIMAX';
        else if (volumeVsAvg > 1.8) volumeProfile = 'SURGE';
        else if (volumeVsAvg < 0.4) volumeProfile = 'DRYING';

        // 구조
        const choppinessIndex = calculateChoppinessIndex(klines, 14);
        const wickRatio = calculateWickRatio(klines, 20);
        const now = new Date();
        const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
        const hourOfDay = now.getUTCHours();
        const priceDistFromEma = currentEma50 > 0
            ? ((currentPrice - currentEma50) / currentEma50) * 100 : 0;

        // 피로도
        let movePercent = 0, trendDurationHours = 0, velocityDecay = 1.0, fatigueScore = 0;

        if (trendDirection !== 'FLAT' && klines.length >= 20) {
            const lookback = Math.min(klines.length, 50);
            const swingHigh = Math.max(...highs.slice(-lookback));
            const swingLow = Math.min(...lows.slice(-lookback));

            if (trendDirection === 'UP') movePercent = ((currentPrice - swingLow) / swingLow) * 100;
            else movePercent = ((swingHigh - currentPrice) / swingHigh) * 100;

            const ema20Full = calculateEMA(closes, 20);
            const ema50Full = calculateEMA(closes, 50);
            let crossIdx = klines.length - 1;
            for (let i = klines.length - 1; i >= 1; i--) {
                const curAbove = (ema20Full[i] || 0) > (ema50Full[i] || 0);
                const prevAbove = (ema20Full[i - 1] || 0) > (ema50Full[i - 1] || 0);
                if (curAbove !== prevAbove) { crossIdx = i; break; }
            }
            trendDurationHours = Math.max(0,
                ((klines[klines.length - 1].time) - (klines[crossIdx]?.time || klines[klines.length - 1].time)) / 3_600_000);

            const trendCandles = klines.length - crossIdx;
            if (trendCandles >= 6) {
                const half = crossIdx + Math.floor(trendCandles / 2);
                const v1Move = Math.abs(closes[half] - closes[crossIdx]);
                const v2Move = Math.abs(closes[klines.length - 1] - closes[half]);
                const t1 = (klines[half]?.time || 0) - (klines[crossIdx]?.time || 0);
                const t2 = (klines[klines.length - 1]?.time || 0) - (klines[half]?.time || 0);
                if (v1Move > 0 && t1 > 0 && t2 > 0) velocityDecay = (v2Move / t2) / (v1Move / t1);
            }

            // 풀백 할인
            let pullbackDiscount = 0;
            if (closes.length >= 3) {
                const recentPeak = trendDirection === 'UP' ? Math.max(...highs.slice(-10)) : Math.min(...lows.slice(-10));
                if (trendDirection === 'UP' && recentPeak > 0) {
                    const pb = ((recentPeak - currentPrice) / recentPeak) * 100;
                    if (pb > 0.5) pullbackDiscount = Math.min(pb * 10, 30);
                } else if (trendDirection === 'DOWN' && recentPeak > 0) {
                    const pb = ((currentPrice - recentPeak) / recentPeak) * 100;
                    if (pb > 0.5) pullbackDiscount = Math.min(pb * 10, 30);
                }
            }

            const moveFat = Math.min(movePercent / 15 * 30, 30);
            const timeFat = Math.min(trendDurationHours / 24 * 30, 30);
            const decayFat = velocityDecay < 0.3 ? 40 : velocityDecay < 0.5 ? 25 : velocityDecay < 0.8 ? 10 : 0;

            let overheat = 0;
            if (trendDurationHours > 0 && trendDurationHours <= 6) {
                const mph = movePercent / trendDurationHours;
                if (mph >= 8) overheat = 40;
                else if (mph >= 5) overheat = 30;
                else if (mph >= 3) overheat = 20;
                else if (mph >= 2) overheat = 10;
            }
            if (movePercent >= 12) overheat = Math.max(overheat, 35);
            else if (movePercent >= 8) overheat = Math.max(overheat, 25);
            else if (movePercent >= 5) overheat = Math.max(overheat, 15);

            fatigueScore = Math.min(Math.max(Math.round(moveFat + timeFat + decayFat + overheat - pullbackDiscount), 0), 100);
        }

        return {
            trendStrength, trendDirection, trendAge,
            volatilityLevel, volatilityTrend, bbWidth, bbWidthPercentile,
            momentumScore, divergenceDetected, volumeProfile,
            choppinessIndex, hurstExponent: 0.5, wickRatio,
            isWeekend, hourOfDay, volumeVsAvg, priceDistFromEma,
            trendFatigue: { movePercent, trendDurationHours, velocityDecay, fatigueScore },
        };
    }

    // ── Private: 레짐 점수 ──

    private scoreAllRegimes(
        c: CryptoRegimeComponents, klines: KlineData[], closes: number[], currentPrice: number,
    ): Record<CryptoMarketRegime, number> {
        const s: Record<CryptoMarketRegime, number> = {
            'TREND_IMPULSE': 0, 'TREND_CONTINUATION': 0, 'TREND_EXHAUSTION': 0,
            'RANGE_ACCUMULATION': 0, 'RANGE_DISTRIBUTION': 0, 'BREAKOUT_EXPANSION': 0,
            'VOLATILITY_SQUEEZE': 0, 'VOLATILITY_EXPLOSION': 0, 'LIQUIDATION_CASCADE': 0,
            'MEAN_REVERSION_ZONE': 0, 'CHOPPY_NOISE': 0, 'WEEKEND_DRIFT': 0,
        };

        const rsiArr = calculateRSI(closes, 14);
        const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
        const bb = calculateBollingerBands(closes, 20, 2);
        const currentBB = bb[bb.length - 1];

        // TREND_IMPULSE
        if (c.trendStrength > 60) s['TREND_IMPULSE'] += 30; else if (c.trendStrength > 40) s['TREND_IMPULSE'] += 15;
        if (c.hurstExponent > 0.6) s['TREND_IMPULSE'] += 20; else if (c.hurstExponent > 0.55) s['TREND_IMPULSE'] += 10;
        if (c.trendDirection !== 'FLAT') s['TREND_IMPULSE'] += 15;
        if (c.volumeProfile === 'SURGE' || c.volumeProfile === 'CLIMAX') s['TREND_IMPULSE'] += 15;
        if (c.choppinessIndex < 40) s['TREND_IMPULSE'] += 10;
        if (Math.abs(c.momentumScore) > 50) s['TREND_IMPULSE'] += 10;
        if (c.trendAge >= 3 && c.trendAge <= 15) s['TREND_IMPULSE'] += 5;
        if (c.trendFatigue.fatigueScore >= 80) s['TREND_IMPULSE'] -= 30;
        else if (c.trendFatigue.fatigueScore >= 60) s['TREND_IMPULSE'] -= 15;
        else if (c.trendFatigue.fatigueScore >= 40) s['TREND_IMPULSE'] -= 5;
        const impulseRate = c.trendFatigue.trendDurationHours > 0 ? c.trendFatigue.movePercent / c.trendFatigue.trendDurationHours : 0;
        if (impulseRate >= 5) s['TREND_IMPULSE'] -= 20; else if (impulseRate >= 3) s['TREND_IMPULSE'] -= 10;

        // TREND_CONTINUATION
        if (c.trendStrength > 30 && c.trendStrength <= 60) s['TREND_CONTINUATION'] += 25;
        if (c.hurstExponent > 0.52 && c.hurstExponent <= 0.65) s['TREND_CONTINUATION'] += 15;
        if (c.trendDirection !== 'FLAT') s['TREND_CONTINUATION'] += 15;
        if (c.volumeProfile === 'NORMAL' || c.volumeProfile === 'DRYING') s['TREND_CONTINUATION'] += 10;
        if (c.choppinessIndex >= 40 && c.choppinessIndex <= 55) s['TREND_CONTINUATION'] += 10;
        if (Math.abs(c.priceDistFromEma) < 1.5 && c.trendDirection !== 'FLAT') s['TREND_CONTINUATION'] += 10;
        if (c.trendAge > 5) s['TREND_CONTINUATION'] += 5;
        if (c.trendFatigue.fatigueScore >= 80) s['TREND_CONTINUATION'] -= 25;
        else if (c.trendFatigue.fatigueScore >= 60) s['TREND_CONTINUATION'] -= 10;

        // TREND_EXHAUSTION
        if (c.divergenceDetected) s['TREND_EXHAUSTION'] += 30;
        if (c.trendStrength > 40 && c.volatilityTrend === 'CONTRACTING') s['TREND_EXHAUSTION'] += 15;
        if (c.volumeProfile === 'DRYING' && c.trendDirection !== 'FLAT') s['TREND_EXHAUSTION'] += 15;
        if (rsi > 75 || rsi < 25) s['TREND_EXHAUSTION'] += 15; else if (rsi > 70 || rsi < 30) s['TREND_EXHAUSTION'] += 8;
        if (c.trendAge > 15) s['TREND_EXHAUSTION'] += 10;
        if (c.wickRatio > 0.6) s['TREND_EXHAUSTION'] += 10;
        if (c.trendFatigue.fatigueScore >= 80) s['TREND_EXHAUSTION'] += 30;
        else if (c.trendFatigue.fatigueScore >= 60) s['TREND_EXHAUSTION'] += 20;
        else if (c.trendFatigue.fatigueScore >= 40) s['TREND_EXHAUSTION'] += 10;
        const mph = c.trendFatigue.trendDurationHours > 0 ? c.trendFatigue.movePercent / c.trendFatigue.trendDurationHours : 0;
        if (mph >= 8) s['TREND_EXHAUSTION'] += 25; else if (mph >= 5) s['TREND_EXHAUSTION'] += 18; else if (mph >= 3) s['TREND_EXHAUSTION'] += 10;
        if (c.trendFatigue.movePercent >= 12) s['TREND_EXHAUSTION'] += 20;
        else if (c.trendFatigue.movePercent >= 8) s['TREND_EXHAUSTION'] += 12;
        else if (c.trendFatigue.movePercent >= 5) s['TREND_EXHAUSTION'] += 5;

        // RANGE_ACCUMULATION
        if (c.trendStrength < 25) s['RANGE_ACCUMULATION'] += 20;
        if (c.bbWidthPercentile < 25) s['RANGE_ACCUMULATION'] += 20;
        if (c.volatilityLevel < 30) s['RANGE_ACCUMULATION'] += 15;
        if (c.volumeProfile === 'DRYING') s['RANGE_ACCUMULATION'] += 15;
        if (c.choppinessIndex > 55) s['RANGE_ACCUMULATION'] += 10;
        if (c.hurstExponent < 0.5) s['RANGE_ACCUMULATION'] += 10;
        if (Math.abs(c.priceDistFromEma) < 0.8) s['RANGE_ACCUMULATION'] += 5;

        // RANGE_DISTRIBUTION
        if (c.trendStrength < 30) s['RANGE_DISTRIBUTION'] += 15;
        if (c.priceDistFromEma > 2.0) s['RANGE_DISTRIBUTION'] += 20;
        if (c.volumeProfile === 'SURGE' && c.trendDirection !== 'UP') s['RANGE_DISTRIBUTION'] += 15;
        if (c.choppinessIndex > 50) s['RANGE_DISTRIBUTION'] += 10;
        if (rsi > 55 && rsi < 70 && c.momentumScore < 0) s['RANGE_DISTRIBUTION'] += 15;
        if (c.wickRatio > 0.5 && c.priceDistFromEma > 1.0) s['RANGE_DISTRIBUTION'] += 10;
        if (c.divergenceDetected && c.priceDistFromEma > 1.5) s['RANGE_DISTRIBUTION'] += 10;

        // BREAKOUT_EXPANSION
        if (currentBB) {
            if (currentPrice > currentBB.upper || currentPrice < currentBB.lower) s['BREAKOUT_EXPANSION'] += 25;
        }
        if (c.volumeProfile === 'CLIMAX' || c.volumeProfile === 'SURGE') s['BREAKOUT_EXPANSION'] += 20;
        if (c.volatilityTrend === 'EXPANDING') s['BREAKOUT_EXPANSION'] += 15;
        if (c.bbWidthPercentile < 30 && c.volatilityTrend === 'EXPANDING') s['BREAKOUT_EXPANSION'] += 15;
        if (Math.abs(c.momentumScore) > 60) s['BREAKOUT_EXPANSION'] += 10;
        if (c.trendDirection !== 'FLAT') s['BREAKOUT_EXPANSION'] += 10;

        // VOLATILITY_SQUEEZE
        if (c.bbWidthPercentile < 15) s['VOLATILITY_SQUEEZE'] += 30; else if (c.bbWidthPercentile < 25) s['VOLATILITY_SQUEEZE'] += 20;
        if (c.volatilityTrend === 'CONTRACTING') s['VOLATILITY_SQUEEZE'] += 20;
        if (c.choppinessIndex > 60) s['VOLATILITY_SQUEEZE'] += 15;
        if (c.volatilityLevel < 25) s['VOLATILITY_SQUEEZE'] += 10;
        if (c.volumeProfile === 'DRYING') s['VOLATILITY_SQUEEZE'] += 10;
        if (c.trendStrength < 20) s['VOLATILITY_SQUEEZE'] += 5;
        if (c.isWeekend) s['VOLATILITY_SQUEEZE'] -= 10;

        // VOLATILITY_EXPLOSION
        if (c.volatilityLevel > 70) s['VOLATILITY_EXPLOSION'] += 25; else if (c.volatilityLevel > 50) s['VOLATILITY_EXPLOSION'] += 15;
        if (c.volatilityTrend === 'EXPANDING') s['VOLATILITY_EXPLOSION'] += 20;
        if (c.wickRatio > 0.5) s['VOLATILITY_EXPLOSION'] += 15;
        if (c.volumeProfile === 'CLIMAX') s['VOLATILITY_EXPLOSION'] += 15;
        if (c.bbWidthPercentile > 80) s['VOLATILITY_EXPLOSION'] += 10;

        // LIQUIDATION_CASCADE
        if (c.volumeProfile === 'CLIMAX') s['LIQUIDATION_CASCADE'] += 25; else if (c.volumeProfile === 'SURGE') s['LIQUIDATION_CASCADE'] += 10;
        if (c.volatilityLevel > 80) s['LIQUIDATION_CASCADE'] += 25; else if (c.volatilityLevel > 60) s['LIQUIDATION_CASCADE'] += 10;
        if (c.volatilityTrend === 'EXPANDING') s['LIQUIDATION_CASCADE'] += 15;
        if (klines.length >= 3) {
            const r3 = klines.slice(-3);
            const mv = Math.abs(r3[2].close - r3[0].open) / r3[0].open * 100;
            if (mv > 5) s['LIQUIDATION_CASCADE'] += 35; else if (mv > 3) s['LIQUIDATION_CASCADE'] += 25; else if (mv > 2) s['LIQUIDATION_CASCADE'] += 15;
            const allDir = r3.every(k => k.close < k.open) || r3.every(k => k.close > k.open);
            if (allDir) s['LIQUIDATION_CASCADE'] += 15;
        }

        // MEAN_REVERSION_ZONE
        if (c.hurstExponent < 0.45) s['MEAN_REVERSION_ZONE'] += 25; else if (c.hurstExponent < 0.48) s['MEAN_REVERSION_ZONE'] += 15;
        if (Math.abs(c.priceDistFromEma) > 3.0) s['MEAN_REVERSION_ZONE'] += 20; else if (Math.abs(c.priceDistFromEma) > 2.0) s['MEAN_REVERSION_ZONE'] += 10;
        if ((rsi > 70 || rsi < 30) && c.hurstExponent < 0.5) s['MEAN_REVERSION_ZONE'] += 15;
        if (c.wickRatio > 0.5) s['MEAN_REVERSION_ZONE'] += 10;
        if (currentBB && (currentPrice > currentBB.upper || currentPrice < currentBB.lower) && c.hurstExponent < 0.5) s['MEAN_REVERSION_ZONE'] += 15;

        // CHOPPY_NOISE
        if (c.choppinessIndex > 65) s['CHOPPY_NOISE'] += 25; else if (c.choppinessIndex > 60) s['CHOPPY_NOISE'] += 15;
        if (c.trendStrength < 15) s['CHOPPY_NOISE'] += 20;
        if (c.hurstExponent > 0.45 && c.hurstExponent < 0.55) s['CHOPPY_NOISE'] += 15;
        if (c.volumeProfile === 'DRYING' || c.volumeProfile === 'NORMAL') s['CHOPPY_NOISE'] += 10;
        if (c.volatilityLevel < 30 && c.trendStrength < 20) s['CHOPPY_NOISE'] += 10;

        // WEEKEND_DRIFT
        if (c.isWeekend) s['WEEKEND_DRIFT'] += 35;
        if (c.volumeVsAvg < 0.5) s['WEEKEND_DRIFT'] += 20; else if (c.volumeVsAvg < 0.7) s['WEEKEND_DRIFT'] += 10;
        if (c.isWeekend && c.volatilityLevel < 30) s['WEEKEND_DRIFT'] += 15;
        if (c.isWeekend && c.volumeProfile === 'DRYING') s['WEEKEND_DRIFT'] += 10;
        if (!c.isWeekend) s['WEEKEND_DRIFT'] = Math.min(s['WEEKEND_DRIFT'], 20);

        return s;
    }

    // ── Private: 서브 레짐 ──

    private determineSubRegime(regime: CryptoMarketRegime, c: CryptoRegimeComponents): string {
        switch (regime) {
            case 'TREND_IMPULSE':
                return c.trendAge <= 5 ? 'Early Impulse' : c.trendAge <= 12 ? 'Mid Impulse' : 'Late Impulse';
            case 'TREND_CONTINUATION':
                if (Math.abs(c.priceDistFromEma) < 0.5) return 'EMA Pullback';
                return c.choppinessIndex > 55 ? 'Consolidation Flag' : 'Shallow Retracement';
            case 'TREND_EXHAUSTION':
                if (c.divergenceDetected) return 'Divergence Exhaustion';
                return c.volumeProfile === 'DRYING' ? 'Volume Dry-Up' : 'Momentum Fade';
            case 'RANGE_ACCUMULATION':
                if (c.bbWidthPercentile < 10) return 'Tight Compression';
                return c.volumeProfile === 'DRYING' ? 'Silent Accumulation' : 'Base Building';
            case 'RANGE_DISTRIBUTION':
                if (c.divergenceDetected) return 'Distribution with Divergence';
                return c.wickRatio > 0.6 ? 'Wick Rejection Distribution' : 'High-Level Distribution';
            case 'BREAKOUT_EXPANSION':
                if (c.volumeProfile === 'CLIMAX') return 'Volume Climax Breakout';
                return c.bbWidthPercentile < 25 ? 'Squeeze Breakout' : 'Momentum Breakout';
            case 'VOLATILITY_SQUEEZE':
                if (c.bbWidthPercentile < 10) return 'Extreme Squeeze (Imminent)';
                return c.choppinessIndex > 65 ? 'Coiled Squeeze' : 'Gradual Compression';
            case 'VOLATILITY_EXPLOSION':
                if (c.wickRatio > 0.6) return 'Whipsaw Explosion';
                return c.trendDirection !== 'FLAT' ? 'Directional Explosion' : 'Bilateral Explosion';
            case 'LIQUIDATION_CASCADE':
                if (c.trendDirection === 'DOWN') return 'Long Liquidation Cascade';
                return c.trendDirection === 'UP' ? 'Short Squeeze Cascade' : 'Mixed Cascade';
            case 'MEAN_REVERSION_ZONE':
                if (c.priceDistFromEma > 3) return 'Overextended Long';
                return c.priceDistFromEma < -3 ? 'Overextended Short' : 'Mild Mean Reversion';
            case 'CHOPPY_NOISE':
                return c.volumeProfile === 'DRYING' ? 'Low-Liquidity Noise' : 'Random Walk Noise';
            case 'WEEKEND_DRIFT':
                return c.hourOfDay >= 0 && c.hourOfDay <= 6 ? 'Dead Zone (Asia Sleep)' : 'Weekend Thin Trading';
            default: return '';
        }
    }

    // ── Private: 레짐별 트레이딩 파라미터 ──

    private getRegimeTradingParams(regime: CryptoMarketRegime, c: CryptoRegimeComponents): RegimeTradingParams {
        const table: Record<CryptoMarketRegime, RegimeTradingParams> = {
            // ★ v34b: tpMultiplier 하한 1.0 — 옵티마이저가 tpAtrMultiplier로 TP 크기 제어
            'TREND_IMPULSE': { recommendedLeverage: { min: 5, max: 15 }, tpMultiplier: 2.0, slMultiplier: 0.8, positionSizeMultiplier: 1.3, trendFollowingFit: 95, meanReversionFit: 5, breakoutFit: 70, scalpingFit: 40, riskLevel: 'MODERATE', shouldReduceExposure: false, maxHoldingMinutes: 240 },
            'TREND_CONTINUATION': { recommendedLeverage: { min: 5, max: 12 }, tpMultiplier: 1.5, slMultiplier: 0.9, positionSizeMultiplier: 1.1, trendFollowingFit: 85, meanReversionFit: 15, breakoutFit: 40, scalpingFit: 50, riskLevel: 'LOW', shouldReduceExposure: false, maxHoldingMinutes: 180 },
            'TREND_EXHAUSTION': { recommendedLeverage: { min: 3, max: 8 }, tpMultiplier: 1.0, slMultiplier: 1.3, positionSizeMultiplier: 0.6, trendFollowingFit: 20, meanReversionFit: 75, breakoutFit: 15, scalpingFit: 60, riskLevel: 'HIGH', shouldReduceExposure: true, maxHoldingMinutes: 60 },
            'RANGE_ACCUMULATION': { recommendedLeverage: { min: 3, max: 8 }, tpMultiplier: 1.0, slMultiplier: 1.0, positionSizeMultiplier: 0.7, trendFollowingFit: 10, meanReversionFit: 60, breakoutFit: 80, scalpingFit: 70, riskLevel: 'LOW', shouldReduceExposure: false, maxHoldingMinutes: 120 },
            'RANGE_DISTRIBUTION': { recommendedLeverage: { min: 3, max: 7 }, tpMultiplier: 1.0, slMultiplier: 1.2, positionSizeMultiplier: 0.6, trendFollowingFit: 15, meanReversionFit: 55, breakoutFit: 40, scalpingFit: 65, riskLevel: 'MODERATE', shouldReduceExposure: true, maxHoldingMinutes: 90 },
            'BREAKOUT_EXPANSION': { recommendedLeverage: { min: 5, max: 15 }, tpMultiplier: 2.5, slMultiplier: 0.7, positionSizeMultiplier: 1.2, trendFollowingFit: 80, meanReversionFit: 5, breakoutFit: 95, scalpingFit: 30, riskLevel: 'MODERATE', shouldReduceExposure: false, maxHoldingMinutes: 120 },
            'VOLATILITY_SQUEEZE': { recommendedLeverage: { min: 3, max: 10 }, tpMultiplier: 2.0, slMultiplier: 0.8, positionSizeMultiplier: 0.8, trendFollowingFit: 30, meanReversionFit: 20, breakoutFit: 90, scalpingFit: 40, riskLevel: 'LOW', shouldReduceExposure: false, maxHoldingMinutes: 180 },
            'VOLATILITY_EXPLOSION': { recommendedLeverage: { min: 2, max: 5 }, tpMultiplier: 1.2, slMultiplier: 1.5, positionSizeMultiplier: 0.5, trendFollowingFit: 40, meanReversionFit: 30, breakoutFit: 50, scalpingFit: 70, riskLevel: 'HIGH', shouldReduceExposure: true, maxHoldingMinutes: 30 },
            'LIQUIDATION_CASCADE': { recommendedLeverage: { min: 1, max: 3 }, tpMultiplier: 1.0, slMultiplier: 2.0, positionSizeMultiplier: 0.3, trendFollowingFit: 30, meanReversionFit: 70, breakoutFit: 10, scalpingFit: 80, riskLevel: 'EXTREME', shouldReduceExposure: true, maxHoldingMinutes: 15 },
            'MEAN_REVERSION_ZONE': { recommendedLeverage: { min: 3, max: 8 }, tpMultiplier: 1.2, slMultiplier: 1.0, positionSizeMultiplier: 0.9, trendFollowingFit: 10, meanReversionFit: 90, breakoutFit: 10, scalpingFit: 60, riskLevel: 'MODERATE', shouldReduceExposure: false, maxHoldingMinutes: 60 },
            'CHOPPY_NOISE': { recommendedLeverage: { min: 2, max: 5 }, tpMultiplier: 1.0, slMultiplier: 1.5, positionSizeMultiplier: 0.4, trendFollowingFit: 5, meanReversionFit: 30, breakoutFit: 10, scalpingFit: 40, riskLevel: 'HIGH', shouldReduceExposure: true, maxHoldingMinutes: 30 },
            'WEEKEND_DRIFT': { recommendedLeverage: { min: 2, max: 5 }, tpMultiplier: 1.0, slMultiplier: 1.3, positionSizeMultiplier: 0.4, trendFollowingFit: 10, meanReversionFit: 40, breakoutFit: 5, scalpingFit: 30, riskLevel: 'MODERATE', shouldReduceExposure: true, maxHoldingMinutes: 60 },
        };

        const base = { ...table[regime] };
        base.recommendedLeverage = { ...base.recommendedLeverage };
        if (c.volatilityLevel > 60) {
            base.recommendedLeverage.max = Math.min(base.recommendedLeverage.max, 5);
            base.positionSizeMultiplier *= 0.8;
        }
        if (c.isWeekend && regime !== 'WEEKEND_DRIFT') {
            base.positionSizeMultiplier *= 0.85;
            base.maxHoldingMinutes = Math.min(base.maxHoldingMinutes, 90);
        }
        return base;
    }

    // ── Private: 기본값 ──

    private getDefaultRegimeResult(): RegimeResult {
        return {
            regime: 'CHOPPY_NOISE',
            simpleRegime: 'RANGING',
            confidence: 30,
            components: {
                trendStrength: 0, trendDirection: 'FLAT', trendAge: 0,
                volatilityLevel: 50, volatilityTrend: 'STABLE', bbWidth: 2, bbWidthPercentile: 50,
                momentumScore: 0, divergenceDetected: false, volumeProfile: 'NORMAL',
                choppinessIndex: 50, hurstExponent: 0.5, wickRatio: 0.3,
                isWeekend: false, hourOfDay: 12, volumeVsAvg: 1, priceDistFromEma: 0,
                trendFatigue: { movePercent: 0, trendDurationHours: 0, velocityDecay: 1.0, fatigueScore: 0 },
            },
            tradingImplications: {
                recommendedLeverage: { min: 2, max: 5 }, tpMultiplier: 1.0, slMultiplier: 1.5,
                positionSizeMultiplier: 0.4, trendFollowingFit: 5, meanReversionFit: 30,
                breakoutFit: 10, scalpingFit: 40, riskLevel: 'HIGH',
                shouldReduceExposure: true, maxHoldingMinutes: 30,
            },
            reasoning: '[Regime] Default fallback - insufficient data',
        };
    }
}
