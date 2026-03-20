import type { BacktestSummary, BacktestStatus } from '../types';

type BacktestListener = () => void;

class BacktestState {
    status: BacktestStatus = 'idle';
    summary: BacktestSummary | null = null;
    progressMessage: string = '';
    progressPercent: number = 0;
    error: string | null = null;
    private listeners: BacktestListener[] = [];

    subscribe(listener: BacktestListener): () => void {
        this.listeners.push(listener);
        return () => { this.listeners = this.listeners.filter(l => l !== listener); };
    }

    private notify() { this.listeners.forEach(l => l()); }

    setRunning(msg: string, pct: number) {
        this.status = 'running';
        this.progressMessage = msg;
        this.progressPercent = pct;
        this.error = null;
        this.notify();
    }

    setCompleted(summary: BacktestSummary) {
        this.status = 'completed';
        this.summary = summary;
        this.progressPercent = 100;
        this.progressMessage = 'Done';
        this.notify();
    }

    setError(err: string) {
        this.status = 'error';
        this.error = err;
        this.notify();
    }

    reset() {
        this.status = 'idle';
        this.summary = null;
        this.progressMessage = '';
        this.progressPercent = 0;
        this.error = null;
        this.notify();
    }
}

export const backtestState = new BacktestState();
