
// services/bybitWebSocket.ts
import { EventEmitter } from './eventEmitter';

type WsCallback = (data: any) => void;

class BybitWebSocket {
    private ws: WebSocket | null = null;
    private url: string = 'wss://stream.bybit.com/v5/public/linear';
    // Fallback URL
    private fallbackUrl: string = 'wss://stream.bytick.com/v5/public/linear';
    
    private priceCache: Map<string, number> = new Map();
    private activeSubscriptions: Set<string> = new Set();
    private reconnectAttempts: number = 0;
    private pingInterval: any = null;
    private eventEmitter: EventEmitter;
    private isConnected: boolean = false;

    // Sniper Data
    private recentTradesCache: Map<string, any[]> = new Map();

    // Phase 1: CVD (Cumulative Volume Delta) — 5분 롤링 윈도우
    private cvdCache: Map<string, {
        buyVolume: number;
        sellVolume: number;
        trades: Array<{ T: number; vol: number; side: string }>;
        lastCleanup: number;
    }> = new Map();

    constructor(eventEmitter: EventEmitter) {
        this.eventEmitter = eventEmitter;
    }

    public connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

        const targetUrl = this.reconnectAttempts % 2 === 0 ? this.url : this.fallbackUrl;
        console.log(`[WebSocket] Connecting to ${targetUrl}...`);

        this.ws = new WebSocket(targetUrl);

        this.ws.onopen = () => {
            console.log('[WebSocket] Connected.');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.resubscribe();
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                
                // Handle Heartbeat response
                if (msg.op === 'pong') return;

                if (msg.topic && msg.data) {
                    this.handleData(msg);
                }
            } catch (e) {
                console.error('[WebSocket] Parse error:', e);
            }
        };

        this.ws.onclose = () => {
            console.warn('[WebSocket] Closed. Reconnecting...');
            this.isConnected = false;
            this.stopHeartbeat();
            setTimeout(() => {
                this.reconnectAttempts++;
                this.connect();
            }, Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000)); // Exponential backoff
        };

        this.ws.onerror = (err) => {
            console.error('[WebSocket] Error:', err);
            this.ws?.close();
        };
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 'ping' }));
            }
        }, 20000); // 20s interval
    }

    private stopHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);
    }

    private handleData(msg: any) {
        // 1. Ticker Data (Real-time Price)
        if (msg.topic.startsWith('tickers.')) {
            const data = msg.data;
            const ticker = data.symbol;
            const price = parseFloat(data.lastPrice);
            
            if (!isNaN(price)) {
                this.priceCache.set(ticker, price);
            }
        }
        
        // 2. Public Trade Data (For Sniper Loop)
        if (msg.topic.startsWith('publicTrade.')) {
            // msg.data is an array of trades
            const ticker = msg.topic.split('.')[1];
            if (!this.recentTradesCache.has(ticker)) {
                this.recentTradesCache.set(ticker, []);
            }
            
            const trades = msg.data.map((t: any) => ({
                T: parseInt(t.T),
                p: parseFloat(t.p),
                q: parseFloat(t.v),
                S: t.S
            }));

            // Keep last 100 trades only for memory efficiency
            const currentCache = this.recentTradesCache.get(ticker)!;
            const updatedCache = [...trades, ...currentCache].slice(0, 100);
            this.recentTradesCache.set(ticker, updatedCache);

            // Phase 1: CVD 누적 (5분 롤링 윈도우)
            if (!this.cvdCache.has(ticker)) {
                this.cvdCache.set(ticker, { buyVolume: 0, sellVolume: 0, trades: [], lastCleanup: Date.now() });
            }
            const cvdEntry = this.cvdCache.get(ticker)!;
            for (const t of trades) {
                const vol = t.q * t.p; // USDT 기준 거래량
                cvdEntry.trades.push({ T: t.T, vol, side: t.S });
                if (t.S === 'Buy') cvdEntry.buyVolume += vol;
                else cvdEntry.sellVolume += vol;
            }
            // 5분 윈도우 정리 (10초마다 실행하여 성능 유지)
            if (Date.now() - cvdEntry.lastCleanup > 10_000) {
                const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                const oldTrades = cvdEntry.trades.filter(t => t.T < fiveMinAgo);
                for (const old of oldTrades) {
                    if (old.side === 'Buy') cvdEntry.buyVolume -= old.vol;
                    else cvdEntry.sellVolume -= old.vol;
                }
                cvdEntry.trades = cvdEntry.trades.filter(t => t.T >= fiveMinAgo);
                cvdEntry.lastCleanup = Date.now();
            }
        }
    }

    public subscribeTicker(ticker: string) {
        const topic = `tickers.${ticker}`;
        if (!this.activeSubscriptions.has(topic)) {
            this.activeSubscriptions.add(topic);
            this.sendSubscription([topic]);
        }
    }

    public subscribeTrades(ticker: string) {
        const topic = `publicTrade.${ticker}`;
        if (!this.activeSubscriptions.has(topic)) {
            this.activeSubscriptions.add(topic);
            this.sendSubscription([topic]);
        }
    }

    public unsubscribeTicker(ticker: string) {
        const topic = `tickers.${ticker}`;
        if (this.activeSubscriptions.has(topic)) {
            this.activeSubscriptions.delete(topic);
            this.sendUnsubscription([topic]);
        }
    }
    
    public unsubscribeTrades(ticker: string) {
        const topic = `publicTrade.${ticker}`;
        if (this.activeSubscriptions.has(topic)) {
            this.activeSubscriptions.delete(topic);
            this.sendUnsubscription([topic]);
            this.recentTradesCache.delete(ticker);
        }
    }

    public subscribeMultipleTickers(tickers: string[]) {
        const newTopics = tickers.map(t => `tickers.${t}`).filter(t => !this.activeSubscriptions.has(t));
        if (newTopics.length > 0) {
            newTopics.forEach(t => this.activeSubscriptions.add(t));
            // Send in batches of 10 to avoid payload limit
            for (let i = 0; i < newTopics.length; i += 10) {
                this.sendSubscription(newTopics.slice(i, i + 10));
            }
        }
    }

    private sendSubscription(topics: string[]) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 'subscribe', args: topics }));
        }
    }

    private sendUnsubscription(topics: string[]) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 'unsubscribe', args: topics }));
        }
    }

    private resubscribe() {
        const topics = Array.from(this.activeSubscriptions);
        if (topics.length > 0) {
            for (let i = 0; i < topics.length; i += 10) {
                this.sendSubscription(topics.slice(i, i + 10));
            }
        }
    }

    // --- Accessors for Engine ---

    public getPrice(ticker: string): number | undefined {
        return this.priceCache.get(ticker);
    }

    public getAllPrices(): Record<string, number> {
        return Object.fromEntries(this.priceCache);
    }

    public getRecentTrades(ticker: string): any[] {
        return this.recentTradesCache.get(ticker) || [];
    }

    /**
     * Phase 1: 5분 롤링 CVD (Cumulative Volume Delta) 조회
     * delta > 0 = 순매수 (buying pressure), delta < 0 = 순매도 (selling pressure)
     */
    public getCVD(ticker: string): { delta: number; buyVolume: number; sellVolume: number } {
        const entry = this.cvdCache.get(ticker);
        if (!entry) return { delta: 0, buyVolume: 0, sellVolume: 0 };
        return {
            delta: entry.buyVolume - entry.sellVolume,
            buyVolume: entry.buyVolume,
            sellVolume: entry.sellVolume,
        };
    }
}

// Singleton Instance
let instance: BybitWebSocket | null = null;

export const getWsInstance = (eventEmitter: EventEmitter) => {
    if (!instance) {
        instance = new BybitWebSocket(eventEmitter);
        instance.connect();
    }
    return instance;
};
