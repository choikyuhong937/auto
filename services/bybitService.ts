
// services/bybitService.ts
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import type { Timeframe, KlineData, Trade, OrderBookData, PublicTrade, BybitTradeRecord } from '../types';

// [CHANGE] Switched priority: api.bybit.com first for better compatibility.
const API_CANDIDATES = ['https://api.bybit.com', 'https://api.bytick.com'];
const RECV_WINDOW = 20000; // [OPTIMIZATION] Increased recvWindow to 20s to be very generous with time drift
const REQUEST_TIMEOUT_MS = 10000; // [OPTIMIZATION] Relaxed timeout to 10s

let apiKey: string | null = null;
let apiSecret: string | null = null;
let currentBaseUrl = API_CANDIDATES[0]; 
let serverTimeOffset = 0; // Local Time - Server Time

export const setApiKeys = (newApiKey: string, newApiSecret: string) => {
    apiKey = newApiKey;
    apiSecret = newApiSecret;
};

export const clearApiKeys = () => {
    apiKey = null;
    apiSecret = null;
};

export const areApiKeysSet = (): boolean => !!apiKey && !!apiSecret;

// [NEW] Latency Racing & Time Sync
export const syncTimeAndSelectEndpoint = async (): Promise<string> => {
    console.log("[Bybit] Syncing time and selecting fastest endpoint...");
    let bestEndpoint = currentBaseUrl;
    let minLatency = Infinity;
    let bestOffset = 0;
    let successCount = 0;

    const checks = API_CANDIDATES.map(async (url) => {
        const start = Date.now();
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 5000); // 5s timeout for initial check
            
            // Use no-cache to prevent stale time data
            const res = await fetch(`${url}/v5/market/time?t=${start}`, { signal: controller.signal, cache: 'no-store' });
            clearTimeout(id);
            
            const end = Date.now();
            const latency = end - start;
            const data = await res.json();
            
            if (data.retCode === 0) {
                let serverTimeMs = 0;
                
                if (data.result && data.result.timeNano) {
                    serverTimeMs = Math.floor(parseInt(data.result.timeNano) / 1000000);
                } else if (data.result && data.result.timeSecond) {
                    serverTimeMs = parseInt(data.result.timeSecond) * 1000;
                } else if (data.time) {
                    serverTimeMs = parseInt(data.time); 
                } else {
                    serverTimeMs = Date.now(); 
                }

                const offset = serverTimeMs - end; 
                
                return { url, latency, offset, serverTimeMs };
            }
        } catch (e) {
            console.warn(`[Bybit] Check failed for ${url}:`, e);
            return null;
        }
        return null;
    });

    const results = await Promise.all(checks);
    
    results.forEach(res => {
        if (res) {
            successCount++;
            console.log(`[Bybit] ${res.url} - Latency: ${res.latency}ms, ServerTime: ${new Date(res.serverTimeMs).toISOString()}, Offset: ${res.offset}ms`);
            
            if (res.latency < minLatency) {
                minLatency = res.latency;
                bestEndpoint = res.url;
                bestOffset = res.offset;
            }
        }
    });

    if (successCount === 0) {
        console.error("All time sync requests failed. Using local time.");
        serverTimeOffset = 0;
        return "⚠️ All API endpoints failed to respond. Using local time.";
    }

    if (bestEndpoint.includes('bytick') && minLatency > 200) {
         const standard = results.find(r => r?.url.includes('api.bybit.com'));
         if (standard) {
             bestEndpoint = standard.url;
             bestOffset = standard.offset;
             minLatency = standard.latency;
         }
    }

    currentBaseUrl = bestEndpoint;
    serverTimeOffset = bestOffset;
    
    console.log(`[Bybit] Selected: ${currentBaseUrl} (Offset: ${serverTimeOffset}ms)`);
    return `Connected to ${currentBaseUrl.replace('https://', '')} (${minLatency}ms)`;
};

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            keepalive: true, 
            // @ts-ignore
            priority: 'high' 
        });
        clearTimeout(id);
        return response;
    } catch (error: any) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw error;
    }
}

async function createAuthenticatedRequest(method: 'GET' | 'POST', endpoint: string, params: Record<string, any> = {}): Promise<any> {
    if (!apiKey || !apiSecret) throw new Error("API 키가 설정되지 않았습니다.");
    
    const now = Date.now() + serverTimeOffset - 1000; 
    const timestamp = now.toString();
    const recvWindow = RECV_WINDOW.toString();
    
    const requestParams = { ...params };
    
    let payload = method === 'POST' ? JSON.stringify(requestParams) : new URLSearchParams(requestParams).toString();

    const signData = timestamp + apiKey + recvWindow + payload;
    const signature = CryptoJS.HmacSHA256(signData, apiSecret).toString();

    const headers: Record<string, string> = {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN-TYPE': '2',
        'Accept': 'application/json'
    };

    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const url = (method === 'GET' && payload) ? `${currentBaseUrl}${endpoint}?${payload}` : `${currentBaseUrl}${endpoint}`;

    try {
        const response = await fetchWithTimeout(url, { method, headers, body: method === 'POST' ? payload : undefined });

        if (!response.ok) {
             if (response.status >= 500) {
                 const altUrl = API_CANDIDATES.find(u => u !== currentBaseUrl);
                 if (altUrl) {
                     console.warn(`[Bybit] Failover: Switching to ${altUrl} due to ${response.status}`);
                     currentBaseUrl = altUrl;
                 }
             }
             console.error(`[Bybit API Error] ${response.status} ${response.statusText} on ${url}`);
             throw new Error(`HTTP Error ${response.status}`);
        }

        const responseText = await response.text();
        if (!responseText) throw new Error("Empty server response");

        const data = JSON.parse(responseText);
        
        if (data.retCode !== 0 && data.retCode !== 110043) { 
            if (data.retCode === 10002) {
                console.warn("[Bybit] Timestamp error detected. Triggering time re-sync.");
                syncTimeAndSelectEndpoint().catch(console.error);
            }
            throw new Error(data.retMsg || `API Error ${data.retCode}`);
        }
        return data.result || data;
    } catch (error) {
        throw error;
    }
}

async function createPublicRequest(endpoint: string, params: Record<string, any> = {}): Promise<any> {
    try {
        const queryParams = new URLSearchParams(params);
        queryParams.append('_t', Date.now().toString());
        
        const url = `${currentBaseUrl}${endpoint}?${queryParams.toString()}`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            return { list: [] };
        }
        const data = await response.json();
        return data.result || { list: [] };
    } catch (e) {
        return { list: [] };
    }
}

export const fetchServerTime = async (): Promise<number> => {
    try {
        const res = await createPublicRequest('/v5/market/time');
        if (res.timeNano) {
            return Math.floor(parseInt(res.timeNano) / 1000000);
        } else if (res.timeSecond) {
            return parseInt(res.timeSecond) * 1000;
        }
        return Date.now() + serverTimeOffset;
    } catch (e) {
        return Date.now() + serverTimeOffset;
    }
};

export const fetchOrderBook = async (ticker: string, limit: number = 50): Promise<OrderBookData | null> => {
    try {
        const res = await createPublicRequest('/v5/market/orderbook', {
            category: 'linear',
            symbol: ticker,
            limit: limit
        });
        if (res.s && res.b && res.a) {
            return { s: res.s, b: res.b, a: res.a, ts: res.ts, u: res.u, seq: res.seq, cts: res.cts };
        }
        return null;
    } catch (e) {
        return null;
    }
};

export const fetchPublicTradingHistory = async (ticker: string, limit: number = 500): Promise<PublicTrade[]> => {
    try {
        const res = await createPublicRequest('/v5/market/recent-trade', {
            category: 'linear',
            symbol: ticker,
            limit: limit
        });
        if (res.list) {
            return res.list.map((t: any) => ({
                id: t.execId, T: parseInt(t.time), p: t.price, q: t.size, S: t.side
            }));
        }
        return [];
    } catch (e) {
        return [];
    }
};

export const fetchAccountState = async () => {
    let openPositions: Trade[] = [];
    try {
        openPositions = await fetchOpenPositions();
    } catch (e) {
        return null;
    }

    let totalEquity = 0;
    let totalWalletBalance = 0; 
    let availableBalance = 0;
    let balanceFetchSuccess = false;

    const processBalanceResponse = (res: any) => {
        if (!res.list || res.list.length === 0) return false;

        const account = res.list[0];
        totalEquity = parseFloat(account.totalEquity || '0');
        totalWalletBalance = parseFloat(account.totalWalletBalance || '0');

        // totalAvailableBalance = 실제 주문 가능 잔고 (에쿼티 - 개시증거금)
        // availableToWithdraw는 출금 가능액이라 거래 가능 잔고와 다름
        let avail = parseFloat(account.totalAvailableBalance || '0');

        if (avail === 0 && account.coin) {
             // fallback: 코인별 walletBalance 합산
             for (const coinName of ['USDT', 'USDC']) {
                 const coinData = account.coin.find((c: any) => c.coin === coinName);
                 if (coinData) {
                     const coinWallet = parseFloat(coinData.walletBalance || '0');
                     avail += coinWallet;
                     if (totalWalletBalance === 0) {
                         totalWalletBalance += coinWallet;
                     }
                 }
             }
        }

        availableBalance = avail;
        return true;
    };

    try {
        const resUTA = await createAuthenticatedRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        balanceFetchSuccess = processBalanceResponse(resUTA);
    } catch (e) { }

    if (!balanceFetchSuccess) {
        try {
            const resClassic = await createAuthenticatedRequest('GET', '/v5/account/wallet-balance', { accountType: 'CONTRACT' });
            balanceFetchSuccess = processBalanceResponse(resClassic);
        } catch (e) { }
    }

    return { totalEquity, totalWalletBalance, availableBalance, openPositions };
};

export const fetchTotalClosedPnl = async (ticker: string, since: number) => {
    try {
        let totalPnl = 0;
        let cursor = "";
        do {
            const params: any = {
                category: 'linear', symbol: ticker, startTime: since, limit: 50, cursor
            };
            const res = await createAuthenticatedRequest('GET', '/v5/position/closed-pnl', params);
            if (res.list) {
                res.list.forEach((item: any) => { totalPnl += parseFloat(item.closedPnl); });
                cursor = res.nextPageCursor;
            } else {
                cursor = "";
            }
        } while (cursor);
        return totalPnl;
    } catch (e) {
        return null;
    }
};

/**
 * Bybit closed-pnl API에서 개별 거래 레코드를 가져옴 (MarketAwareTuner용)
 * @param since  이 시각 이후의 거래만 (ms timestamp)
 * @param limit  최대 반환 건수 (기본 50)
 */
export const fetchClosedPnlRecords = async (since: number, limit: number = 50): Promise<BybitTradeRecord[]> => {
    try {
        const all: BybitTradeRecord[] = [];
        let cursor = '';
        let page = 0;

        do {
            page++;
            const params: any = {
                category: 'linear',
                limit: 100,
                startTime: since.toString(),
            };
            if (cursor) params.cursor = cursor;

            const res = await createAuthenticatedRequest('GET', '/v5/position/closed-pnl', params);
            if (!res.list || res.list.length === 0) break;

            for (const item of res.list) {
                const createdTime = parseInt(item.createdTime) || 0;
                const updatedTime = parseInt(item.updatedTime) || 0;
                const qty = parseFloat(item.qty) || 0;
                const entryPrice = parseFloat(item.avgEntryPrice) || 0;
                const exitPrice = parseFloat(item.avgExitPrice) || 0;
                const closedPnl = parseFloat(item.closedPnl) || 0;
                const leverage = parseFloat(item.leverage) || 1;
                const direction = item.side === 'Buy' ? 'Short' : 'Long';

                // ★ v52.7: 가격 기반 PnL% (closedPnl 의존 제거)
                // closedPnl은 bybit 내부 계산이라 앱과 다를 수 있음
                // 가격 변동률 × 레버리지 = 마진 대비 수익률
                let pnlPercent = 0;
                if (entryPrice > 0 && exitPrice > 0 && exitPrice !== entryPrice) {
                    // 가격 기반 계산 (가장 정확)
                    const priceChange = direction === 'Long'
                        ? ((exitPrice - entryPrice) / entryPrice)
                        : ((entryPrice - exitPrice) / entryPrice);
                    pnlPercent = priceChange * leverage * 100;
                } else if (entryPrice > 0 && qty > 0) {
                    // 폴백: closedPnl 기반 (exitPrice 없을 때)
                    pnlPercent = (closedPnl / (qty * entryPrice)) * leverage * 100;
                }

                // ★ 실제 달러 PnL: 가격 기반으로 재계산 (수수료 제외 순수 가격변동)
                const actualPnlDollar = (exitPrice > 0 && exitPrice !== entryPrice)
                    ? (direction === 'Long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty)
                    : closedPnl;

                // ★ 보유시간: closed-pnl의 createdTime은 포지션 오픈시간이라 부정확할 수 있음
                // updatedTime(청산시간)만 신뢰 가능. 보유시간은 로컬 기록이나 별도 API로 보완 필요.
                const holdingMs = (createdTime > 0 && updatedTime > 0) ? (updatedTime - createdTime) : 0;
                const holdingMinutes = holdingMs / 60000;

                // ★ 디버그 로그
                console.log(`[ClosedPnl] ${item.symbol} ${direction} | entry=${entryPrice} exit=${exitPrice} qty=${qty} lev=${leverage} | API closedPnl=${closedPnl} | calc PnL$=${actualPnlDollar.toFixed(4)} PnL%=${pnlPercent.toFixed(2)}% | created=${new Date(createdTime).toISOString()} updated=${new Date(updatedTime).toISOString()} hold=${holdingMinutes.toFixed(1)}min`);

                all.push({
                    id: item.orderId || `${item.symbol}_${createdTime}`,
                    ticker: item.symbol,
                    direction,
                    entryPrice,
                    exitPrice,
                    pnlPercent,
                    closedPnl: actualPnlDollar,  // ★ 가격 기반 달러 PnL 사용
                    timestamp: createdTime,
                    closeTimestamp: updatedTime,
                    holdingMinutes,
                    qty,
                    leverage: item.leverage || '1',
                    // kline 기반 지표 — enrichTradeRecords()에서 채움
                    rsi: 0,
                    volumeRatio: 0,
                    zoneType: 'unknown',
                    // StratTuner용 — enrichTradeRecords()에서 채움
                    bbPosition: 50,
                    momentum: 0,
                    noiseRatio: 5,
                    rangePosition: 50,
                    consecutiveCandles: 0,
                    session: 'UNKNOWN',
                    adx: 20,
                });
            }

            cursor = res.nextPageCursor || '';
            if (page > 10) break; // 안전장치: 최대 10페이지
        } while (cursor);

        // 시간순 정렬 + limit 적용
        all.sort((a, b) => a.timestamp - b.timestamp);
        return all.slice(-limit);
    } catch (e) {
        console.error('[bybitService] fetchClosedPnlRecords error:', e);
        return [];
    }
};

/**
 * ★ v52.9: Bybit 전체 거래내역 조회 (엑셀 다운로드용)
 * limit 없이 startTime부터 모든 페이지를 순회하여 전체 내역을 반환
 * @param since  이 시각 이후의 거래 (ms timestamp)
 */
export const fetchAllClosedPnlRecords = async (since: number): Promise<BybitTradeRecord[]> => {
    try {
        const all: BybitTradeRecord[] = [];
        let cursor = '';
        let page = 0;

        do {
            page++;
            const params: any = {
                category: 'linear',
                limit: 100,
                startTime: since.toString(),
            };
            if (cursor) params.cursor = cursor;

            const res = await createAuthenticatedRequest('GET', '/v5/position/closed-pnl', params);
            if (!res.list || res.list.length === 0) break;

            for (const item of res.list) {
                const createdTime = parseInt(item.createdTime) || 0;
                const updatedTime = parseInt(item.updatedTime) || 0;
                const qty = parseFloat(item.qty) || 0;
                const entryPrice = parseFloat(item.avgEntryPrice) || 0;
                const exitPrice = parseFloat(item.avgExitPrice) || 0;
                const closedPnl = parseFloat(item.closedPnl) || 0;
                const leverage = parseFloat(item.leverage) || 1;
                const direction = item.side === 'Buy' ? 'Short' : 'Long';

                let pnlPercent = 0;
                if (entryPrice > 0 && exitPrice > 0 && exitPrice !== entryPrice) {
                    const priceChange = direction === 'Long'
                        ? ((exitPrice - entryPrice) / entryPrice)
                        : ((entryPrice - exitPrice) / entryPrice);
                    pnlPercent = priceChange * leverage * 100;
                } else if (entryPrice > 0 && qty > 0) {
                    pnlPercent = (closedPnl / (qty * entryPrice)) * leverage * 100;
                }

                const actualPnlDollar = (exitPrice > 0 && exitPrice !== entryPrice)
                    ? (direction === 'Long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty)
                    : closedPnl;

                const holdingMs = (createdTime > 0 && updatedTime > 0) ? (updatedTime - createdTime) : 0;
                const holdingMinutes = holdingMs / 60000;

                all.push({
                    id: item.orderId || `${item.symbol}_${createdTime}`,
                    ticker: item.symbol,
                    direction,
                    entryPrice,
                    exitPrice,
                    pnlPercent,
                    closedPnl: actualPnlDollar,
                    timestamp: createdTime,
                    closeTimestamp: updatedTime,
                    holdingMinutes,
                    qty,
                    leverage: item.leverage || '1',
                    rsi: 0, volumeRatio: 0, zoneType: 'unknown',
                    bbPosition: 50, momentum: 0, noiseRatio: 5,
                    rangePosition: 50, consecutiveCandles: 0,
                    session: 'UNKNOWN', adx: 20,
                });
            }

            cursor = res.nextPageCursor || '';
            if (page > 50) break; // 안전장치: 최대 50페이지 (5000건)
        } while (cursor);

        all.sort((a, b) => a.timestamp - b.timestamp);
        return all;
    } catch (e) {
        console.error('[bybitService] fetchAllClosedPnlRecords error:', e);
        return [];
    }
};

export const fetchOpenPositions = async (): Promise<Trade[]> => {
    let allItems: any[] = [];

    // USDT + USDC 포지션 모두 조회
    for (const coin of ['USDT', 'USDC']) {
        let cursor = "";
        let pageCount = 0;
        do {
            const params: any = { category: 'linear', limit: 200, settleCoin: coin };
            if (cursor) params.cursor = cursor;

            const res = await createAuthenticatedRequest('GET', '/v5/position/list', params);

            if (!res.list) break;

            allItems = [...allItems, ...res.list];
            cursor = res.nextPageCursor;
            pageCount++;

            if (pageCount > 10) break;
        } while (cursor);
    }

    const trades = allItems.filter((p: any) => parseFloat(p.size) > 0).map((p: any) => {
        let openTs = parseInt(p.createdTime);
        // FIX: If timestamp is invalid or 0, default to NOW to prevent huge age calculations.
        if (isNaN(openTs) || openTs <= 0) {
            openTs = parseInt(p.updatedTime) || Date.now();
        }

        const safeMarkPrice = parseFloat(p.markPrice) || 0;

        return {
            id: p.symbol, ticker: p.symbol, direction: p.side === 'Buy' ? 'Long' : 'Short',
            entryPrice: parseFloat(p.avgPrice), quantity: parseFloat(p.size),
            unrealizedPnl: parseFloat(p.unrealisedPnl || '0'), leverage: parseFloat(p.leverage), 
            status: 'open', realizedPnl: parseFloat(p.cumRealisedPnl || '0'), category: 'linear',
            openTimestamp: openTs, createdTime: parseInt(p.createdTime) || 0, updatedTime: parseInt(p.updatedTime) || 0,
            targetPrice: p.takeProfit && p.takeProfit !== "0" ? parseFloat(p.takeProfit) : 0,
            invalidationPrice: p.stopLoss && p.stopLoss !== "0" ? parseFloat(p.stopLoss) : 0,
            liquidationPrice: p.liqPrice && p.liqPrice !== "0" ? parseFloat(p.liqPrice) : 0,
            currentPrice: safeMarkPrice, 
            positionValue: parseFloat(p.positionValue) || (parseFloat(p.avgPrice) * parseFloat(p.size)),
            positionIdx: p.positionIdx !== undefined ? parseInt(p.positionIdx) : 0,
            initialMargin: (parseFloat(p.avgPrice) * parseFloat(p.size)) / parseFloat(p.leverage)
        } as Trade;
    });

    return trades;
};

// [NEW] Fetch specific ticker stats (Last & Mark Price)
// Used for Discrepancy Check before entry
export const fetchTickerStats = async (ticker: string) => {
    try {
        const res = await createPublicRequest('/v5/market/tickers', { 
            category: 'linear', 
            symbol: ticker 
        });
        
        if (res.list && res.list.length > 0) {
            const t = res.list[0];
            return {
                lastPrice: parseFloat(t.lastPrice),
                markPrice: parseFloat(t.markPrice),
                fundingRate: parseFloat(t.fundingRate) || 0,
                nextFundingTime: parseInt(t.nextFundingTime) || 0,
                openInterest: parseFloat(t.openInterest) || 0,
            };
        }
        return null;
    } catch (e) {
        console.error(`[Bybit] fetchTickerStats error for ${ticker}:`, e);
        return null;
    }
};

// [Phase 1] Fetch funding rate history (최근 N회 결제)
export const fetchFundingHistory = async (
    ticker: string, limit: number = 3
): Promise<{ fundingRate: number; timestamp: number }[]> => {
    try {
        const res = await createPublicRequest('/v5/market/funding/history', {
            category: 'linear', symbol: ticker, limit: limit.toString(),
        });
        return (res.list || []).map((item: any) => ({
            fundingRate: parseFloat(item.fundingRate),
            timestamp: parseInt(item.fundingRateTimestamp),
        }));
    } catch (e) {
        console.error(`[Bybit] fetchFundingHistory error for ${ticker}:`, e);
        return [];
    }
};

// [Phase 1] Fetch open interest data (1h/4h/1d 간격)
export const fetchOpenInterest = async (
    ticker: string,
    intervalTime: '5min' | '15min' | '30min' | '1h' | '4h' | '1d' = '1h',
    limit: number = 10
): Promise<{ openInterest: number; timestamp: number }[]> => {
    try {
        const res = await createPublicRequest('/v5/market/open-interest', {
            category: 'linear', symbol: ticker, intervalTime, limit: limit.toString(),
        });
        return (res.list || []).map((item: any) => ({
            openInterest: parseFloat(item.openInterest),
            timestamp: parseInt(item.timestamp),
        }));
    } catch (e) {
        console.error(`[Bybit] fetchOpenInterest error for ${ticker}:`, e);
        return [];
    }
};

// [Phase 2] Fetch Long/Short ratio (account ratio)
export const fetchLongShortRatio = async (
    ticker: string,
    period: '5min' | '15min' | '30min' | '1h' | '4h' | '1d' = '1h',
    limit: number = 1,
): Promise<{ buyRatio: number; sellRatio: number; timestamp: number }[]> => {
    try {
        const res = await createPublicRequest('/v5/market/account-ratio', {
            category: 'linear', symbol: ticker, period, limit: limit.toString(),
        });
        return (res.list || []).map((item: any) => ({
            buyRatio: parseFloat(item.buyRatio),
            sellRatio: parseFloat(item.sellRatio),
            timestamp: parseInt(item.timestamp),
        }));
    } catch (e) {
        console.error(`[Bybit] fetchLongShortRatio error for ${ticker}:`, e);
        return [];
    }
};

// [NEW] Fetch Single Position with Strict Details (Fact Check)
// Added liqPrice & markPrice to return object for Liquidation Guard logic
export const fetchPosition = async (ticker: string) => {
    try {
        const res = await createAuthenticatedRequest('GET', '/v5/position/list', {
            category: 'linear',
            symbol: ticker
        });
        
        if (res.list && res.list.length > 0) {
            const p = res.list[0];
            return {
                symbol: p.symbol,
                side: p.side, // 'Buy' or 'Sell' indicates direction of the POSITION
                direction: p.side === 'Buy' ? 'Long' : 'Short',
                size: parseFloat(p.size),
                entryPrice: parseFloat(p.avgPrice),
                leverage: parseFloat(p.leverage || '0'),
                liqPrice: parseFloat(p.liqPrice || '0'),
                markPrice: parseFloat(p.markPrice || '0'),
                stopLoss: parseFloat(p.stopLoss || '0'),
                takeProfit: parseFloat(p.takeProfit || '0'),
            };
        }
        return null;
    } catch(e) {
        console.error(`[Bybit] fetchPosition error for ${ticker}:`, e);
        return null;
    }
};

// [NEW] Fetch single order execution history to calculate exact PnL
export const fetchOrderHistory = async (ticker: string, orderId: string) => {
    const res = await createAuthenticatedRequest('GET', '/v5/order/history', {
        category: 'linear',
        symbol: ticker,
        orderId: orderId,
        limit: 1 // Fetch only the specific order
    });
    return res.list && res.list.length > 0 ? res.list[0] : null;
};

export const fetchAllOpenOrders = async () => {
    // USDT + USDC 주문 모두 조회
    const usdtRes = await createAuthenticatedRequest('GET', '/v5/order/realtime', { category: 'linear', limit: 50, settleCoin: 'USDT' });
    const usdcRes = await createAuthenticatedRequest('GET', '/v5/order/realtime', { category: 'linear', limit: 50, settleCoin: 'USDC' });
    return [...(usdtRes.list || []), ...(usdcRes.list || [])];
};

export const fetchOpenOrders = async (ticker: string) => {
    const res = await createAuthenticatedRequest('GET', '/v5/order/realtime', {
        category: 'linear',
        symbol: ticker,
        openOnly: 0 
    });
    return res.list || [];
};

export const fetchOpenOrdersForSymbol = async (ticker: string) => {
    const res = await createAuthenticatedRequest('GET', '/v5/order/realtime', { 
        category: 'linear', 
        symbol: ticker
    });
    return res.list || [];
};

export const fetchOpenStopOrders = async (ticker: string) => {
    const res = await createAuthenticatedRequest('GET', '/v5/order/realtime', { 
        category: 'linear', 
        symbol: ticker,
        orderFilter: 'StopOrder',
        limit: 50 
    });
    return res.list || [];
};

export const setLeverage = async (ticker: string, leverage: number) => {
    return createAuthenticatedRequest('POST', '/v5/position/set-leverage', {
        category: 'linear', symbol: ticker, buyLeverage: leverage.toString(), sellLeverage: leverage.toString()
    });
};

export const setPositionTPSL = async (params: {
    ticker: string, takeProfit?: string, stopLoss?: string, positionIdx?: number, tpslMode?: 'Full' | 'Partial'
}) => {
    const payload: any = {
        category: 'linear', symbol: params.ticker, positionIdx: params.positionIdx !== undefined ? params.positionIdx : 0,
        tpslMode: params.tpslMode || 'Full'
    };

    if (params.takeProfit && !isNaN(parseFloat(params.takeProfit)) && parseFloat(params.takeProfit) > 0) {
        payload.takeProfit = params.takeProfit;
        payload.tpTriggerBy = 'LastPrice';
    }
    if (params.stopLoss && !isNaN(parseFloat(params.stopLoss)) && parseFloat(params.stopLoss) > 0) {
        payload.stopLoss = params.stopLoss;
        payload.slTriggerBy = 'LastPrice';
    }

    return createAuthenticatedRequest('POST', '/v5/position/trading-stop', payload);
};

// ── Instrument Info 캐시 (5분 TTL) — public API rate limit 방지 ──
const _instrumentCache: Record<string, { data: any; ts: number }> = {};
const INSTRUMENT_CACHE_TTL = 5 * 60 * 1000; // 5분

export const getInstrumentInfoCached = async (ticker: string): Promise<any> => {
    const cached = _instrumentCache[ticker];
    if (cached && Date.now() - cached.ts < INSTRUMENT_CACHE_TTL) {
        return cached.data;
    }
    const res = await createPublicRequest('/v5/market/instruments-info', { category: 'linear', symbol: ticker });
    const info = res.list?.[0];
    if (info) {
        _instrumentCache[ticker] = { data: info, ts: Date.now() };
    }
    return info;
};

export const fetchInstrumentInfo = async (ticker: string) => {
    return getInstrumentInfoCached(ticker);
};

export const fetchAllInstrumentsInfo = async () => {
    let allItems: any[] = [];
    let cursor = "";
    do {
        const params: any = { category: 'linear', limit: 1000 }; 
        if (cursor) params.cursor = cursor;
        try {
            const res = await createPublicRequest('/v5/market/instruments-info', params);
            if (!res.list) break;
            allItems = [...allItems, ...res.list];
            cursor = res.nextPageCursor;
        } catch (e) { break; }
    } while(cursor);
    return allItems;
};

export const getMaxLeverage = async (ticker: string): Promise<number> => {
    try {
        const info = await fetchInstrumentInfo(ticker);
        if (info && info.leverageFilter && info.leverageFilter.maxLeverage) {
            return parseFloat(info.leverageFilter.maxLeverage);
        }
        return 10; 
    } catch (e) {
        return 10; 
    }
};

export const fetchRiskLimit = async (ticker: string) => {
    const res = await createPublicRequest('/v5/market/risk-limit', { category: 'linear', symbol: ticker });
    return res.list || [];
};

export const adjustLeverageToFitRiskLimit = async (ticker: string, margin: number, targetLeverage: number): Promise<number> => {
    try {
        const maxLev = await getMaxLeverage(ticker);
        const allowedLeverage = Math.min(targetLeverage, maxLev);
        return allowedLeverage;
    } catch (e) {
        return targetLeverage; 
    }
};

export const getPricePrecisionForTicker = async (ticker: string) => {
    const res = await createPublicRequest('/v5/market/instruments-info', { category: 'linear', symbol: ticker });
    return res.list?.[0]?.priceScale || 4;
};

export const fetchCurrentPrices = async (tickers: string[]) => {
    const uniqueTickers = [...new Set(tickers)];
    if (uniqueTickers.length === 0) return {};

    if (uniqueTickers.length > 1 && uniqueTickers.length <= 5) {
        try {
            const prices: Record<string, number> = {};
            await Promise.all(uniqueTickers.map(async (sym) => {
                const res = await createPublicRequest('/v5/market/tickers', { category: 'linear', symbol: sym });
                if (res.list && res.list.length > 0) {
                    prices[sym] = parseFloat(res.list[0].lastPrice);
                }
            }));
            return prices;
        } catch (e) {
            console.warn("Parallel ticker fetch failed, falling back to bulk.");
        }
    }

    let res;
    if (uniqueTickers.length === 1) {
        res = await createPublicRequest('/v5/market/tickers', { category: 'linear', symbol: uniqueTickers[0] });
    } else {
        res = await createPublicRequest('/v5/market/tickers', { category: 'linear' });
    }

    const prices: Record<string, number> = {};
    if (res.list) {
        res.list.forEach((t: any) => {
            if (uniqueTickers.length === 1 || uniqueTickers.includes(t.symbol)) {
                prices[t.symbol] = parseFloat(t.lastPrice);
            }
        });
    }
    return prices;
};

export const fetchSingleTimeframeKlines = async (
    ticker: string, timeframe: Timeframe, limit: number = 200,
    startTime?: number, endTime?: number, category: 'linear' | 'inverse' = 'linear'
) => {
    const tfMap: any = { 
        '1m': '1', '5m': '5', '15m': '15', '30m': '30', 
        '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D' 
    };
    const interval = tfMap[timeframe] || '60'; // Default to 1h if not found
    
    if (limit <= 200) {
        const params: any = { category, symbol: ticker, interval, limit };
        if (startTime) params.start = startTime;
        if (endTime) params.end = endTime;

        const res = await createPublicRequest('/v5/market/kline', params);
        if (!res.list || res.list.length === 0) return [];
        return res.list.map((k: any) => ({
            time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
        })).reverse();
    }

    const chunks: KlineData[][] = [];
    let currentEnd = endTime || Date.now();
    let remaining = limit;
    const BATCH_LIMIT = 1000;  // ★ 바이빗 API 최대 1000개 지원 → fetch 5배 빠름

    while (remaining > 0) {
        const batchSize = Math.min(remaining, BATCH_LIMIT);
        const params: any = { category, symbol: ticker, interval, limit: batchSize, end: currentEnd };
        if (startTime) params.start = startTime;

        const res = await createPublicRequest('/v5/market/kline', params);
        if (!res.list || res.list.length === 0) break;

        const batch = res.list.map((k: any) => ({
            time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
        })).reverse();

        chunks.unshift(batch);  // ★ 스프레드 복사 대신 청크 저장
        remaining -= batch.length;
        currentEnd = batch[0].time - 1;

        if (batch.length < batchSize) break;
        if (startTime && batch[0].time <= startTime) break;

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    // ★ 1회만 concat — 매 루프마다 전체 배열 복사하던 문제 해결
    let gathered = ([] as KlineData[]).concat(...chunks);
    if (gathered.length > limit) {
        gathered = gathered.slice(gathered.length - limit);
    }
    
    return gathered;
};

/**
 * ★ v52.45: 병렬 kline 수집 — 시간 범위를 N등분해서 동시에 받은 후 합치기
 * 389,000바 기준: 순차 390회 → 병렬 4스트림 × 98회 = ~4배 빠름
 */
export const fetchKlinesParallel = async (
    ticker: string, timeframe: Timeframe, totalBars: number,
    streams: number = 4,
    onProgress?: (fetched: number, total: number) => void,
): Promise<KlineData[]> => {
    const tfMs: Record<string, number> = {
        '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000,
    };
    const barMs = tfMs[timeframe] || 60000;
    const now = Date.now();
    const totalMs = totalBars * barMs;
    const startMs = now - totalMs;

    // 시간 범위를 streams 등분
    const segmentMs = Math.ceil(totalMs / streams);
    const segmentBars = Math.ceil(totalBars / streams);

    let totalFetched = 0;

    const fetchSegment = async (segStart: number, segEnd: number, maxBars: number): Promise<KlineData[]> => {
        const chunks: KlineData[][] = [];
        let currentEnd = segEnd;
        let remaining = maxBars;
        const BATCH_LIMIT = 1000;

        while (remaining > 0) {
            const batchSize = Math.min(remaining, BATCH_LIMIT);
            const params: any = {
                category: 'linear', symbol: ticker,
                interval: ({ '1m': '1', '5m': '5', '15m': '15', '1h': '60' } as any)[timeframe] || '1',
                limit: batchSize, end: currentEnd, start: segStart,
            };

            const res = await createPublicRequest('/v5/market/kline', params);
            if (!res.list || res.list.length === 0) break;

            const batch = res.list.map((k: any) => ({
                time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
                low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
            })).reverse();

            chunks.unshift(batch);
            remaining -= batch.length;
            totalFetched += batch.length;
            onProgress?.(totalFetched, totalBars);
            currentEnd = batch[0].time - 1;

            if (batch.length < batchSize) break;
            if (batch[0].time <= segStart) break;

            await new Promise(r => setTimeout(r, 30));
        }
        return ([] as KlineData[]).concat(...chunks);
    };

    // 병렬 실행
    const promises: Promise<KlineData[]>[] = [];
    for (let i = 0; i < streams; i++) {
        const segStart = startMs + i * segmentMs;
        const segEnd = i < streams - 1 ? startMs + (i + 1) * segmentMs : now;
        // 각 스트림 시작 시 약간의 딜레이 (rate limit 방지)
        const delay = i * 100;
        promises.push(
            new Promise(r => setTimeout(r, delay)).then(() => fetchSegment(segStart, segEnd, segmentBars + 100))
        );
    }

    const segments = await Promise.all(promises);
    // 시간순 합치기 + 중복 제거
    const merged = ([] as KlineData[]).concat(...segments)
        .sort((a, b) => a.time - b.time);

    // 중복 시간 제거
    const deduped: KlineData[] = [];
    let lastTime = 0;
    for (const k of merged) {
        if (k.time !== lastTime) {
            deduped.push(k);
            lastTime = k.time;
        }
    }

    return deduped.slice(-totalBars);
};

export const fetchLongHistoryKlines = async (ticker: string, timeframe: Timeframe, limitDays: number = 7): Promise<KlineData[]> => {
    const totalMinutes = limitDays * 24 * 60;
    return fetchSingleTimeframeKlines(ticker, timeframe, totalMinutes);
};

export const fetchMarketTickers = async () => {
    const res = await createPublicRequest('/v5/market/tickers', { category: 'linear' });
    if (!res.list) return [];
    return res.list.map((t: any) => {
        const high24h = parseFloat(t.highPrice24h);
        const low24h = parseFloat(t.lowPrice24h);
        const volatility24h = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;
        
        // [NEW] Calculate 1h change
        // prevPrice1h is available in v5 linear tickers
        const lastPrice = parseFloat(t.lastPrice);
        const prevPrice1h = parseFloat(t.prevPrice1h);
        let change1hPercent = 0;
        if (!isNaN(prevPrice1h) && prevPrice1h > 0) {
            change1hPercent = ((lastPrice - prevPrice1h) / prevPrice1h) * 100;
        }

        return {
            symbol: t.symbol, 
            lastPrice: lastPrice, 
            volume: parseFloat(t.turnover24h), 
            change: Math.abs(parseFloat(t.price24hPcnt) * 100), 
            rawChangePercent: parseFloat(t.price24hPcnt) * 100, 
            volatility24h: volatility24h,
            change1hPercent: change1hPercent // [NEW] Added 1h Change for Ignition Track
        };
    });
};

export const adjustQuantityByStep = async (ticker: string, quantity: number, cachedInfo?: any): Promise<string> => {
    let info = cachedInfo;
    if (!info) {
        info = await getInstrumentInfoCached(ticker);
    }

    if (!info) return quantity.toString();
    const qtyStep = parseFloat(info.lotSizeFilter.qtyStep);
    const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
    const maxQty = parseFloat(info.lotSizeFilter.maxOrderQty);

    if (quantity < minQty) {
        throw new Error(`주문 수량(${quantity.toFixed(4)})이 최소 주문 수량(${minQty})보다 작습니다.`);
    }
    if (quantity > maxQty) quantity = maxQty; 

    const stepStr = info.lotSizeFilter.qtyStep;
    const decimals = stepStr.indexOf('.') >= 0 ? stepStr.split('.')[1].length : 0;
    const steps = Math.floor(quantity / qtyStep);
    const steppedQty = steps * qtyStep;

    return steppedQty.toFixed(decimals);
};

export const placeLinearOrder = async (params: {
    ticker: string; side: 'Buy' | 'Sell'; quantity: string | number; orderType?: 'Market' | 'Limit';
    price?: string; reduceOnly?: boolean; takeProfit?: string; stopLoss?: string; timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
}) => {
    const rawQty = typeof params.quantity === 'string' ? parseFloat(params.quantity) : params.quantity;
    const validatedQty = await adjustQuantityByStep(params.ticker, rawQty);
        
    const orderType = params.orderType || 'Market';
    let timeInForce = params.timeInForce;
    if (!timeInForce) timeInForce = orderType === 'Market' ? 'IOC' : 'GTC';

    const payload: any = {
        category: 'linear', symbol: params.ticker, side: params.side, orderType: orderType, 
        qty: validatedQty, timeInForce: timeInForce, positionIdx: 0, 
    };

    if (params.price) payload.price = params.price;
    if (params.reduceOnly) payload.reduceOnly = params.reduceOnly;
    if (params.takeProfit) {
        payload.takeProfit = params.takeProfit;
        payload.tpslMode = 'Full';
    }
    if (params.stopLoss) {
        payload.stopLoss = params.stopLoss;
        payload.tpslMode = 'Full';
    }

    const result = await createAuthenticatedRequest('POST', '/v5/order/create', payload);

    // 주문 생성 확인 — orderId 없으면 실패로 간주
    if (!result?.orderId) {
        console.error(`[Bybit] placeLinearOrder: orderId 없음`, JSON.stringify(result).slice(0, 200));
        throw new Error(`Order creation failed: no orderId returned (${params.ticker} ${params.side} ${params.orderType || 'Market'})`);
    }

    return result;
};

export const amendOrder = async (params: {
    category: 'linear' | 'inverse'; symbol: string; orderId?: string; orderLinkId?: string;
    triggerPrice?: string; qty?: string; price?: string; takeProfit?: string; stopLoss?: string; tpslMode?: 'Full' | 'Partial';
}) => {
    return createAuthenticatedRequest('POST', '/v5/order/amend', params);
};

export const cancelOrder = async (ticker: string, orderId: string) => {
    return createAuthenticatedRequest('POST', '/v5/order/cancel', {
        category: 'linear', symbol: ticker, orderId: orderId
    });
};

export const closePosition = async (ticker: string, qty: string | number, side: 'Buy' | 'Sell') => {
    const val = typeof qty === 'string' ? parseFloat(qty) : qty;
    const validatedQty = await adjustQuantityByStep(ticker, val);
    
    return createAuthenticatedRequest('POST', '/v5/order/create', {
        category: 'linear', symbol: ticker, side: side, orderType: 'Market', 
        qty: validatedQty, timeInForce: 'IOC', positionIdx: 0, reduceOnly: true 
    });
};

export const cancelAllOrders = async (ticker: string) => {
    try {
        return await createAuthenticatedRequest('POST', '/v5/order/cancel-all', {
            category: 'linear', symbol: ticker,
        });
    } catch (e: any) {
        console.warn(`[Bybit] /cancel-all failed (${e.message}), falling back to individual cancel.`);
        try {
            const orders = await fetchOpenOrdersForSymbol(ticker);
            const results = [];
            for (const order of orders) {
                results.push(await cancelOrder(ticker, order.orderId));
            }
            return results;
        } catch (innerError) {
            console.error(`[Bybit] Individual cancel fallback also failed:`, innerError);
            throw e;
        }
    }
};

export const adjustPriceByTick = async (ticker: string, price: number, cachedInfo?: any): Promise<string> => {
    const info = cachedInfo || await getInstrumentInfoCached(ticker);
    if (!info) return price.toString();
    
    const tickSize = parseFloat(info.priceFilter.tickSize);
    const precision = info.priceScale; 
    const steppedPrice = Math.round(price / tickSize) * tickSize;
    return steppedPrice.toFixed(parseInt(precision));
};

export const validateApiKeys = async () => {
    try { 
        const res = await fetchAccountState(); 
        return res !== null; 
    } catch { return false; }
};
