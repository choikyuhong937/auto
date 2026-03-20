/**
 * simulationWorker.ts — Web Worker for parallel combo grid simulation
 *
 * ★ v43: Binary transfer (Float64Array) — structured clone 30초 → ~50ms
 * 메인 스레드에서 packSignals()로 패킹된 ArrayBuffer를 수신,
 * unpackSignals()로 PrecomputedBar[] 복원 후 시뮬레이션 실행.
 */

import {
    simulateAllTickers,
    aggregateLight,
    calculateFitness,
    calculateAggressiveFitness,
} from './simulation';
import type { PrecomputedBar } from './simulation';
import { applyParamsToConfig } from '../types';
import type { TradingConfig, BacktestParams, BacktestTickerResult } from '../types';
import { unpackSignals } from './signalPacking';

// ── Worker 메시지 타입 ──

interface InitPackedMessage {
    type: 'init-packed';
    tickers: string[];
    counts: number[];
    buffer: ArrayBuffer;
}

interface ComboJob {
    type: 'combo';
    comboIndex: number;
    comboParams: BacktestParams;
    baseConfig: TradingConfig;
    tickers: string[];
    barRange: { start: number; end: number };
    fitnessMode: 'balanced' | 'aggressive';
}

interface ValidateJob {
    type: 'validate';
    comboIndex: number;
    comboParams: BacktestParams;
    baseConfig: TradingConfig;
    tickers: string[];
    trainBarRange: { start: number; end: number };
    valBarRange: { start: number; end: number };
    fitnessMode: 'balanced' | 'aggressive';
}

interface ComboResult {
    type: 'combo-result';
    comboIndex: number;
    fitnessScore: number;
    totalPnlPercent: number;
    overallWinRate: number;
    maxDrawdownPercent: number;
    profitFactor: number;
    totalTrades: number;
}

interface ValidateResult {
    type: 'validate-result';
    comboIndex: number;
    trainTickerResults: BacktestTickerResult[];
    valPnlPercent: number;
    valWinRate: number;
    valMaxDD: number;
    valProfitFactor: number;
    valTrades: number;
    valTickerResults: BacktestTickerResult[];
}

// ── Worker 로직 ──

let signalData: { [ticker: string]: PrecomputedBar[] } = {};

self.onmessage = (e: MessageEvent) => {
    const msg = e.data;

    if (msg.type === 'init-packed') {
        // ★ Binary unpack: Float64Array → PrecomputedBar[] (~80ms vs structured clone ~10초)
        signalData = unpackSignals({
            tickers: msg.tickers,
            counts: msg.counts,
            buffer: msg.buffer,
        });
        self.postMessage({ type: 'ready' });
        return;
    }

    // Legacy fallback (backward compatibility)
    if (msg.type === 'init') {
        signalData = msg.signalData;
        self.postMessage({ type: 'ready' });
        return;
    }

    if (msg.type === 'combo') {
        const job = msg as ComboJob;
        const config = applyParamsToConfig(job.baseConfig, job.comboParams);
        const tickerResults = simulateAllTickers(
            job.tickers, signalData, config, job.comboParams, job.barRange,
        );
        const summary = aggregateLight(tickerResults, config);
        const fitness = job.fitnessMode === 'aggressive'
            ? calculateAggressiveFitness(summary, job.comboParams)
            : calculateFitness(summary, job.comboParams);

        const result: ComboResult = {
            type: 'combo-result',
            comboIndex: job.comboIndex,
            fitnessScore: fitness,
            totalPnlPercent: summary.totalPnlPercent,
            overallWinRate: summary.overallWinRate,
            maxDrawdownPercent: summary.maxDrawdownPercent,
            profitFactor: summary.profitFactor,
            totalTrades: summary.totalTrades,
        };
        self.postMessage(result);
        return;
    }

    if (msg.type === 'validate') {
        const job = msg as ValidateJob;
        const config = applyParamsToConfig(job.baseConfig, job.comboParams);

        // 학습 구간 시뮬
        const trainResults = simulateAllTickers(
            job.tickers, signalData, config, job.comboParams, job.trainBarRange,
        );

        // 검증 구간 시뮬
        const valResults = simulateAllTickers(
            job.tickers, signalData, config, job.comboParams, job.valBarRange,
        );
        const valSummary = aggregateLight(valResults, config);

        const result: ValidateResult = {
            type: 'validate-result',
            comboIndex: job.comboIndex,
            trainTickerResults: trainResults,
            valPnlPercent: valSummary.totalPnlPercent,
            valWinRate: valSummary.overallWinRate,
            valMaxDD: valSummary.maxDrawdownPercent,
            valProfitFactor: valSummary.profitFactor,
            valTrades: valSummary.totalTrades,
            valTickerResults: valResults,
        };
        self.postMessage(result);
        return;
    }
};
