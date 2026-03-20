/**
 * ZoneEngine — 진입 존 생성 + 선호도 필터
 *
 * tradingEngine.ts에서 추출:
 * - analyzeForWatchlist()의 존 생성 부분
 * - detectSwingPoints()
 * - zoneCalculator.computeEntryZones() 래퍼
 *
 * TradingConfig.zonePreference를 반영하여 autoTuner 결과 적용.
 */

import type {
    KlineData, CryptoMarketRegime, TradingConfig, WaitingCandidate,
} from '../../types';
import type { ZoneStrategyType, EntryZone, SwingPoint, ZoneCalculatorResult } from '../zoneCalculator';
import { computeEntryZones } from '../zoneCalculator';
import { calculateADX, calculateATR, calculateBollingerBands } from '../indicatorService';
import * as bybitService from '../bybitService';
import * as db from '../firebase';

export interface ZoneEngineResult {
    candidate: WaitingCandidate | null;
    rejected: boolean;
    reason: string;
}

export class ZoneEngine {
    constructor(
        private emit: (type: string, sender: string, msg: string, category?: string) => void,
    ) {}

    /**
     * 존 생성: klines + 방향 + 레짐 → EntryZone[] 생성
     * zoneCalculator.computeEntryZones 래퍼
     */
    async createZones(params: {
        ticker: string;
        direction: 'Long' | 'Short';
        strategy: 'TREND' | 'REVERSION';
        klines: KlineData[];
        regime: CryptoMarketRegime;
        config: TradingConfig;
    }): Promise<ZoneCalculatorResult> {
        const { ticker, direction, strategy, klines, regime, config } = params;

        const dmiResult = this.calculateDMI(klines, 14);
        const { swingHighs, swingLows } = this.detectSwingPoints(klines, 5);

        // 존 품질 피드백 데이터 로드
        const zoneProfile = await db.getSymbolProfile(ticker);
        const zoneResult = computeEntryZones(
            klines,
            direction,
            strategy,
            regime,
            dmiResult,
            swingHighs,
            swingLows,
            zoneProfile?.zonePerformance
        );

        // 존 폭 동적 조절 — 변동성 퍼센타일 기반
        if (zoneResult.zones.length > 0) {
            zoneResult.zones = this.scaleZoneWidths(zoneResult.zones, klines);
        }

        // 존 선호도 필터 적용
        if (zoneResult.zones.length > 0) {
            zoneResult.zones = this.filterByPreference(zoneResult.zones, config);
        }

        return zoneResult;
    }

    /**
     * 존 폭 동적 조절 — 변동성 퍼센타일 기반
     * 횡보(squeeze): 좁게 → 정밀 진입
     * 폭발(explosion): 넓게 → 여유 확보
     */
    private scaleZoneWidths(zones: EntryZone[], klines: KlineData[]): EntryZone[] {
        const closes = klines.map(k => k.close);
        const bb = calculateBollingerBands(closes, 20, 2);

        // BB width 퍼센타일 계산
        const bbWidths: number[] = [];
        for (let i = 0; i < bb.length; i++) {
            if (bb[i]?.middle > 0) bbWidths.push((bb[i].upper - bb[i].lower) / bb[i].middle);
        }
        const currentBBW = bbWidths.length > 0 ? bbWidths[bbWidths.length - 1] : 0.02;
        const sorted = [...bbWidths].sort((a, b) => a - b);
        const volPercentile = sorted.length > 0
            ? (sorted.findIndex(w => w >= currentBBW) / sorted.length) * 100 : 50;

        // ATR 가속도
        const atrArr = calculateATR(klines, 14);
        const atrNow = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 0;
        const atr10ago = atrArr.length > 10 ? atrArr[atrArr.length - 11] : atrNow;
        const atrAccel = atr10ago > 0 ? atrNow / atr10ago : 1.0;

        // 스케일 팩터: 0.5 (squeeze) ~ 1.5 (explosion)
        let scaleFactor = 1.0;
        if (volPercentile < 25) scaleFactor = 0.5;          // squeeze → 좁게
        else if (volPercentile < 40) scaleFactor = 0.7;
        else if (volPercentile > 75) scaleFactor = 1.3;     // expansion → 넓게
        else if (volPercentile > 90) scaleFactor = 1.5;

        // ATR 가속 중이면 약간 넓게 (움직임 여유)
        if (atrAccel >= 1.5) scaleFactor *= 1.2;

        if (Math.abs(scaleFactor - 1.0) < 0.05) return zones; // 변화 없으면 스킵

        return zones.map(z => {
            const mid = (z.minPrice + z.maxPrice) / 2;
            const halfWidth = (z.maxPrice - z.minPrice) / 2;
            const newHalf = halfWidth * scaleFactor;
            return { ...z, minPrice: mid - newHalf, maxPrice: mid + newHalf };
        });
    }

    /**
     * 존 선호도 필터 — autoTuner 설정 반영
     * preference < 0.3이면 해당 존 타입 비활성화
     */
    filterByPreference(zones: EntryZone[], config: TradingConfig): EntryZone[] {
        return zones.filter(z => {
            const pref = config.zonePreference[z.type as ZoneStrategyType] ?? 1.0;
            if (pref < 0.3) {
                this.emit('newMessage', 'system',
                    `🚫 [Zone Pref] ${z.type} 선호도 ${pref.toFixed(2)} < 0.3 → 비활성화`,
                    'system_state'
                );
                return false;
            }
            return true;
        });
    }

    /**
     * WaitingCandidate 생성 — 존 결과를 후보 객체로 변환
     */
    buildCandidate(params: {
        ticker: string;
        direction: 'Long' | 'Short';
        zoneResult: ZoneCalculatorResult;
        mtfAlignment?: 0 | 1 | 2 | 3;
        mtfDetails?: string;
    }): WaitingCandidate {
        const { ticker, direction, zoneResult, mtfAlignment, mtfDetails } = params;

        const newZones = zoneResult.zones.map(z => ({
            type: z.type,
            minPrice: z.minPrice,
            maxPrice: z.maxPrice,
        }));

        return {
            ticker,
            direction,
            entryZones: newZones,
            marketPhase: zoneResult.marketPhase || 'UNCERTAIN',
            reasoning: zoneResult.reasoning,
            timestamp: Date.now(),
            expectedReward: zoneResult.expectedReward,
            hitCount: 0,
            isPendingReanalysis: false,
            primaryTimeframe: '1h',
            technicalContext: {},
            mtfAlignment,
            mtfDetails,
        } as any;
    }

    // ── Swing Point 감지 ──

    detectSwingPoints(klines: KlineData[], lookback: number): {
        swingHighs: SwingPoint[];
        swingLows: SwingPoint[];
    } {
        const swingHighs: SwingPoint[] = [];
        const swingLows: SwingPoint[] = [];

        for (let i = lookback; i < klines.length - lookback; i++) {
            const current = klines[i];
            let isSwingHigh = true;
            let isSwingLow = true;

            for (let j = 1; j <= lookback; j++) {
                const left = klines[i - j];
                const right = klines[i + j];

                if (current.high <= left.high || current.high <= right.high) {
                    isSwingHigh = false;
                }
                if (current.low >= left.low || current.low >= right.low) {
                    isSwingLow = false;
                }
            }

            if (isSwingHigh) {
                swingHighs.push({ index: i, price: current.high, timestamp: current.time });
            }
            if (isSwingLow) {
                swingLows.push({ index: i, price: current.low, timestamp: current.time });
            }
        }

        return { swingHighs, swingLows };
    }

    // ── DMI 계산 ──

    private calculateDMI(klines: KlineData[], period: number = 14): { pdi: number; mdi: number; adx: number } {
        if (klines.length < period * 2) return { pdi: 0, mdi: 0, adx: 0 };

        const tr: number[] = [];
        const pdm: number[] = [];
        const mdm: number[] = [];

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

        const str = smooth(tr, period);
        const spdm = smooth(pdm, period);
        const smdm = smooth(mdm, period);

        const lastTr = str[str.length - 1];
        const pdi = lastTr > 0 ? (spdm[spdm.length - 1] / lastTr) * 100 : 0;
        const mdi = lastTr > 0 ? (smdm[smdm.length - 1] / lastTr) * 100 : 0;

        const adxArray = calculateADX(klines, period);
        const adx = adxArray.length > 0 ? adxArray[adxArray.length - 1] : 0;

        return { pdi, mdi, adx };
    }
}
