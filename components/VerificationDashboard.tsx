/**
 * VerificationDashboard — 실전 vs 백테스트 검증 대시보드
 *
 * 실전 거래 기록(localStorage)과 백테스트 결과를 나란히 비교하여
 * 백테스트 성과가 실전에서 재현되는지 검증.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { PersistedTrade, BacktestSummary, BacktestTrade, BybitTradeRecord } from '../types';
import { getAllTradeHistory } from '../services/firebase';
import { fetchClosedPnlRecords, fetchAllClosedPnlRecords } from '../services/bybitService';
import { backtestState } from '../services/backtestStateService';
import * as XLSX from 'xlsx';

// ── 타입 ──

interface ComparisonStats {
    totalTrades: number;
    winRate: number;
    avgPnlPercent: number;
    totalPnlPercent: number;
    avgHoldingMinutes: number;
    avgWinPercent: number;
    avgLossPercent: number;
    profitFactor: number;
    maxConsecutiveLosses: number;
    exitReasonDist: Record<string, number>;
    strategyBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number }>;
    longWinRate: number;
    shortWinRate: number;
    avgMFE?: number;
    avgMAE?: number;
}

// ── 유틸 ──

function wilsonCI(wins: number, n: number): [number, number] {
    if (n === 0) return [0, 0];
    const p = wins / n;
    const z = 1.96;
    const d = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / d;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [Math.max(0, (center - margin) * 100), Math.min(100, (center + margin) * 100)];
}

function normalizeExitReason(reason: string): string {
    if (!reason) return 'OTHER';
    if (reason.includes('tp') || reason.includes('target') || reason.includes('partial')) return 'TP';
    if (reason.includes('stop') || reason.includes('sl') || reason === 'SL') return 'SL';
    if (reason === 'TP1' || reason === 'TP2') return 'TP';
    if (reason === 'END_OF_DATA') return 'OTHER';
    return 'OTHER';
}

function computeStats(
    trades: { pnlPercent: number; direction: string; holdingMinutes?: number; reasonForExit?: string; exitReason?: string; strategyType?: string; mfe?: number; mae?: number }[]
): ComparisonStats {
    const n = trades.length;
    if (n === 0) return {
        totalTrades: 0, winRate: 0, avgPnlPercent: 0, totalPnlPercent: 0,
        avgHoldingMinutes: 0, avgWinPercent: 0, avgLossPercent: 0, profitFactor: 0,
        maxConsecutiveLosses: 0, exitReasonDist: {}, strategyBreakdown: {},
        longWinRate: 0, shortWinRate: 0,
    };

    const wins = trades.filter(t => t.pnlPercent > 0);
    const losses = trades.filter(t => t.pnlPercent <= 0);
    const longs = trades.filter(t => t.direction === 'Long');
    const shorts = trades.filter(t => t.direction === 'Short');
    const longWins = longs.filter(t => t.pnlPercent > 0).length;
    const shortWins = shorts.filter(t => t.pnlPercent > 0).length;

    const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnlPercent, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0));

    // max consecutive losses
    let maxConsec = 0, curConsec = 0;
    for (const t of trades) {
        if (t.pnlPercent <= 0) { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
        else curConsec = 0;
    }

    // exit reason distribution
    const exitDist: Record<string, number> = {};
    for (const t of trades) {
        const reason = normalizeExitReason((t as any).reasonForExit || (t as any).exitReason || '');
        exitDist[reason] = (exitDist[reason] || 0) + 1;
    }

    // strategy breakdown
    const stratMap = new Map<string, { w: number; total: number; pnlSum: number }>();
    for (const t of trades) {
        const st = t.strategyType || 'UNKNOWN';
        const cur = stratMap.get(st) || { w: 0, total: 0, pnlSum: 0 };
        cur.total++;
        if (t.pnlPercent > 0) cur.w++;
        cur.pnlSum += t.pnlPercent;
        stratMap.set(st, cur);
    }
    const strategyBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number }> = {};
    for (const [k, v] of stratMap) {
        strategyBreakdown[k] = { trades: v.total, winRate: v.total > 0 ? (v.w / v.total) * 100 : 0, avgPnl: v.total > 0 ? v.pnlSum / v.total : 0 };
    }

    // MFE/MAE (only if available)
    const mfeTrades = trades.filter(t => t.mfe != null);
    const maeTrades = trades.filter(t => t.mae != null);

    return {
        totalTrades: n,
        winRate: (wins.length / n) * 100,
        avgPnlPercent: totalPnl / n,
        totalPnlPercent: totalPnl,
        // ★ v52.9: 비정상 보유시간(>24h) 제외하고 평균 계산
        avgHoldingMinutes: (() => {
            const valid = trades.filter(t => t.holdingMinutes > 0 && t.holdingMinutes <= 24 * 60);
            return valid.length > 0 ? valid.reduce((s, t) => s + t.holdingMinutes, 0) / valid.length : 0;
        })(),
        avgWinPercent: wins.length > 0 ? grossWin / wins.length : 0,
        avgLossPercent: losses.length > 0 ? -(grossLoss / losses.length) : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
        maxConsecutiveLosses: maxConsec,
        exitReasonDist: exitDist,
        strategyBreakdown,
        longWinRate: longs.length > 0 ? (longWins / longs.length) * 100 : 0,
        shortWinRate: shorts.length > 0 ? (shortWins / shorts.length) * 100 : 0,
        avgMFE: mfeTrades.length > 0 ? mfeTrades.reduce((s, t) => s + (t.mfe || 0), 0) / mfeTrades.length : undefined,
        avgMAE: maeTrades.length > 0 ? maeTrades.reduce((s, t) => s + (t.mae || 0), 0) / maeTrades.length : undefined,
    };
}

function backtestTradesToGeneric(trades: BacktestTrade[]) {
    return trades.map(t => ({
        pnlPercent: t.pnlPercent,
        direction: t.direction,
        holdingMinutes: t.barsHeld,  // 1-min bars
        exitReason: t.exitReason,
        strategyType: t.strategyType,
    }));
}

// ── 컴포넌트 ──

function DeltaIndicator({ live, backtest, suffix = '%', higherBetter = true }: {
    live: number; backtest: number; suffix?: string; higherBetter?: boolean;
}) {
    const delta = live - backtest;
    const pct = backtest !== 0 ? (delta / Math.abs(backtest)) * 100 : 0;
    const isGood = higherBetter ? delta >= 0 : delta <= 0;
    const isClose = Math.abs(pct) < 20;
    const color = isGood ? 'text-green-400' : isClose ? 'text-yellow-400' : 'text-red-400';
    const arrow = delta >= 0 ? '▲' : '▼';
    return (
        <span className={`text-xs ${color} font-mono`}>
            {arrow} {Math.abs(delta).toFixed(1)}{suffix}
        </span>
    );
}

function StatCard({ label, liveValue, backtestValue, suffix = '%', higherBetter = true, liveCI }: {
    label: string; liveValue: number; backtestValue: number; suffix?: string; higherBetter?: boolean;
    liveCI?: [number, number];
}) {
    return (
        <div className="bg-bg-dark border border-border-color rounded-lg p-3 flex-1 min-w-[140px]">
            <div className="text-text-secondary text-xs mb-2">{label}</div>
            <div className="flex items-baseline gap-2 mb-1">
                <span className="text-text-primary text-lg font-bold">{liveValue.toFixed(1)}{suffix}</span>
                <DeltaIndicator live={liveValue} backtest={backtestValue} suffix={suffix} higherBetter={higherBetter} />
            </div>
            {liveCI && (
                <div className="text-[10px] text-text-secondary">
                    95% CI: {liveCI[0].toFixed(1)}~{liveCI[1].toFixed(1)}{suffix}
                </div>
            )}
            <div className="text-xs text-text-secondary mt-1">
                백테: {backtestValue.toFixed(1)}{suffix}
            </div>
        </div>
    );
}

/** BybitTradeRecord → PersistedTrade 변환 (Bybit 실거래 → 대시보드 통일 포맷) */
function bybitToPersistedTrade(r: BybitTradeRecord): PersistedTrade {
    return {
        id: r.id,
        ticker: r.ticker,
        direction: r.direction,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        pnl: r.closedPnl,
        pnlPercent: r.pnlPercent,
        leverage: typeof r.leverage === 'string' ? parseFloat(r.leverage) || 1 : r.leverage,
        reasonForExit: 'unknown',
        openTimestamp: r.timestamp,
        closeTimestamp: r.closeTimestamp,
        holdingMinutes: r.holdingMinutes,
    };
}

export default function VerificationDashboard() {
    const [liveTrades, setLiveTrades] = useState<PersistedTrade[]>([]);
    const [btSummary, setBtSummary] = useState<BacktestSummary | null>(backtestState.summary);
    const [isExpanded, setIsExpanded] = useState(true);
    const [dataSource, setDataSource] = useState<'bybit' | 'local'>('bybit');

    // ★ v52.9: 엑셀 다운로드 상태
    const [xlsxStartDate, setXlsxStartDate] = useState(() => {
        // 기본값: 7일 전
        const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 16); // datetime-local 포맷
    });
    const [xlsxLoading, setXlsxLoading] = useState(false);
    const [xlsxStatus, setXlsxStatus] = useState('');

    // ★ 엑셀 다운로드 핸들러
    const handleExcelDownload = useCallback(async () => {
        setXlsxLoading(true);
        setXlsxStatus('Bybit에서 거래내역 조회 중...');
        try {
            const since = new Date(xlsxStartDate).getTime();
            if (isNaN(since)) {
                setXlsxStatus('❌ 유효한 날짜를 입력하세요');
                setXlsxLoading(false);
                return;
            }

            const records = await fetchAllClosedPnlRecords(since);
            if (records.length === 0) {
                setXlsxStatus('⚠️ 해당 기간에 거래내역이 없습니다');
                setXlsxLoading(false);
                return;
            }

            setXlsxStatus(`${records.length}건 조회 완료, 엑셀 생성 중...`);

            // 엑셀 데이터 생성
            const rows = records.map(r => ({
                '종목': r.ticker,
                '방향': r.direction,
                '진입가': r.entryPrice,
                '청산가': r.exitPrice,
                '수량': r.qty,
                '레버리지': r.leverage,
                'PnL$': Number((r.closedPnl).toFixed(4)),
                'PnL%': Number((r.pnlPercent).toFixed(2)),
                '보유시간(분)': Number((r.holdingMinutes).toFixed(1)),
                '진입시간': new Date(r.timestamp).toLocaleString('ko-KR'),
                '청산시간': new Date(r.closeTimestamp).toLocaleString('ko-KR'),
                '진입시간(ISO)': new Date(r.timestamp).toISOString(),
                '청산시간(ISO)': new Date(r.closeTimestamp).toISOString(),
            }));

            // 종목별 요약 시트
            const tickerMap = new Map<string, { wins: number; total: number; totalPnl: number; totalPnlDollar: number; avgWin: number[]; avgLoss: number[] }>();
            for (const r of records) {
                const ticker = r.ticker;
                const cur = tickerMap.get(ticker) || { wins: 0, total: 0, totalPnl: 0, totalPnlDollar: 0, avgWin: [], avgLoss: [] };
                cur.total++;
                cur.totalPnl += r.pnlPercent;
                cur.totalPnlDollar += r.closedPnl;
                if (r.pnlPercent > 0) { cur.wins++; cur.avgWin.push(r.pnlPercent); }
                else { cur.avgLoss.push(r.pnlPercent); }
                tickerMap.set(ticker, cur);
            }

            const summaryRows = Array.from(tickerMap.entries())
                .sort((a, b) => b[1].totalPnlDollar - a[1].totalPnlDollar)
                .map(([ticker, s]) => ({
                    '종목': ticker,
                    '총거래수': s.total,
                    '승': s.wins,
                    '패': s.total - s.wins,
                    '승률%': Number(((s.wins / s.total) * 100).toFixed(1)),
                    '총PnL$': Number(s.totalPnlDollar.toFixed(4)),
                    '총PnL%': Number(s.totalPnl.toFixed(2)),
                    '평균익%': s.avgWin.length > 0 ? Number((s.avgWin.reduce((a, b) => a + b, 0) / s.avgWin.length).toFixed(2)) : 0,
                    '평균손%': s.avgLoss.length > 0 ? Number((s.avgLoss.reduce((a, b) => a + b, 0) / s.avgLoss.length).toFixed(2)) : 0,
                    'W:L비율': s.avgLoss.length > 0 && s.avgWin.length > 0
                        ? Number((Math.abs(s.avgWin.reduce((a, b) => a + b, 0) / s.avgWin.length) / Math.abs(s.avgLoss.reduce((a, b) => a + b, 0) / s.avgLoss.length)).toFixed(2))
                        : '-',
                }));

            // 워크북 생성
            const wb = XLSX.utils.book_new();
            const ws1 = XLSX.utils.json_to_sheet(rows);
            const ws2 = XLSX.utils.json_to_sheet(summaryRows);

            // 컬럼 폭 설정
            ws1['!cols'] = [
                { wch: 14 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
                { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
                { wch: 20 }, { wch: 20 }, { wch: 24 }, { wch: 24 },
            ];
            ws2['!cols'] = [
                { wch: 14 }, { wch: 8 }, { wch: 6 }, { wch: 6 }, { wch: 8 },
                { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
            ];

            XLSX.utils.book_append_sheet(wb, ws1, '거래내역');
            XLSX.utils.book_append_sheet(wb, ws2, '종목별요약');

            // 다운로드
            const startStr = new Date(since).toISOString().slice(0, 10);
            const filename = `GZBot_trades_${startStr}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            XLSX.writeFile(wb, filename);

            setXlsxStatus(`✅ ${records.length}건 다운로드 완료 → ${filename}`);
        } catch (e: any) {
            console.error('[XLSX] Error:', e);
            setXlsxStatus(`❌ 오류: ${e.message || e}`);
        } finally {
            setXlsxLoading(false);
        }
    }, [xlsxStartDate]);

    // Load live trades — Bybit API 우선, 실패 시 localStorage 폴백
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            if (dataSource === 'bybit') {
                try {
                    // 최근 90일치 가져오기
                    const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
                    const records = await fetchClosedPnlRecords(since, 500);
                    if (!cancelled && records.length > 0) {
                        // ★ v52.9: Bybit closed-pnl의 createdTime은 포지션 최초 생성 시간이라
                        // 보유시간이 부풀려짐 → 로컬 거래 기록의 정확한 보유시간으로 병합
                        const localTrades = await getAllTradeHistory();
                        const merged = records.map(r => {
                            const pt = bybitToPersistedTrade(r);
                            // 로컬 기록에서 같은 종목 + 청산 시간 ±5분 내 매칭
                            const localMatch = localTrades.find(lt =>
                                lt.ticker === pt.ticker &&
                                Math.abs((lt.closeTimestamp || 0) - (pt.closeTimestamp || 0)) < 5 * 60000
                            );
                            if (localMatch && localMatch.holdingMinutes != null && localMatch.holdingMinutes > 0) {
                                pt.holdingMinutes = localMatch.holdingMinutes;
                                // 로컬에 exitReason 있으면 그것도 사용
                                if (localMatch.reasonForExit && localMatch.reasonForExit !== 'unknown') {
                                    pt.reasonForExit = localMatch.reasonForExit;
                                }
                            }
                            return pt;
                        });
                        setLiveTrades(merged);
                        return;
                    }
                } catch (e) {
                    console.warn('[VerificationDashboard] Bybit API 실패, localStorage 폴백:', e);
                }
            }
            // 폴백: localStorage
            if (!cancelled) {
                const local = await getAllTradeHistory();
                setLiveTrades(local);
            }
        };
        load();
        const interval = setInterval(load, 60000); // 1분마다 갱신
        return () => { cancelled = true; clearInterval(interval); };
    }, [dataSource]);

    // Subscribe to backtest state
    useEffect(() => {
        const unsub = backtestState.subscribe(() => {
            setBtSummary(backtestState.summary);
        });
        return unsub;
    }, []);

    // Compute stats
    const liveStats = useMemo(() => computeStats(liveTrades), [liveTrades]);
    const backtestTrades = useMemo(() => {
        if (!btSummary) return [];
        return btSummary.tickers.flatMap(t => t.trades);
    }, [btSummary]);
    const btStats = useMemo(() => computeStats(backtestTradesToGeneric(backtestTrades)), [backtestTrades]);

    const liveWinCI = useMemo(() => {
        const wins = liveTrades.filter(t => t.pnlPercent > 0).length;
        return wilsonCI(wins, liveTrades.length);
    }, [liveTrades]);

    // Strategy comparison chart data
    const stratChartData = useMemo(() => {
        const allKeys = new Set([...Object.keys(liveStats.strategyBreakdown), ...Object.keys(btStats.strategyBreakdown)]);
        allKeys.delete('UNKNOWN');
        return Array.from(allKeys).map(key => ({
            name: key,
            liveWR: liveStats.strategyBreakdown[key]?.winRate ?? 0,
            btWR: btStats.strategyBreakdown[key]?.winRate ?? 0,
            liveTrades: liveStats.strategyBreakdown[key]?.trades ?? 0,
            btTrades: btStats.strategyBreakdown[key]?.trades ?? 0,
        }));
    }, [liveStats, btStats]);

    // Exit reason chart
    const exitChartData = useMemo(() => {
        const allReasons = new Set([...Object.keys(liveStats.exitReasonDist), ...Object.keys(btStats.exitReasonDist)]);
        return Array.from(allReasons).map(reason => ({
            name: reason,
            live: liveStats.totalTrades > 0 ? ((liveStats.exitReasonDist[reason] || 0) / liveStats.totalTrades) * 100 : 0,
            backtest: btStats.totalTrades > 0 ? ((btStats.exitReasonDist[reason] || 0) / btStats.totalTrades) * 100 : 0,
        }));
    }, [liveStats, btStats]);

    const hasLive = liveTrades.length > 0;
    const hasBt = btSummary != null;

    return (
        <div className="mt-4">
            {/* ── 헤더 ── */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between bg-bg-light border border-border-color rounded-lg px-4 py-2 hover:bg-opacity-80 transition"
            >
                <div className="flex items-center gap-3">
                    <span className="text-base">📊</span>
                    <span className="text-text-primary text-sm font-semibold">실전 vs 백테스트 검증</span>
                    <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded"
                        onClick={(e) => { e.stopPropagation(); setDataSource(d => d === 'bybit' ? 'local' : 'bybit'); }}
                        title="클릭: 데이터 소스 전환">
                        {dataSource === 'bybit' ? '🔗Bybit' : '💾Local'}: {liveTrades.length}건
                    </span>
                    <span className="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded">
                        Backtest: {backtestTrades.length}건
                    </span>
                </div>
                <span className="text-text-secondary text-sm">{isExpanded ? '▲ 접기' : '▼ 펼치기'}</span>
            </button>

            {isExpanded && (
                <div className="border border-border-color border-t-0 rounded-b-lg bg-bg-dark p-4 space-y-4">
                    {/* ── 📥 Bybit 거래내역 엑셀 다운로드 ── */}
                    <div className="bg-bg-light border border-border-color rounded-lg p-3">
                        <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-xs text-text-secondary font-semibold">📥 거래내역 엑셀</span>
                            <label className="text-[10px] text-text-secondary">시작시간:</label>
                            <input
                                type="datetime-local"
                                value={xlsxStartDate}
                                onChange={e => setXlsxStartDate(e.target.value)}
                                className="bg-bg-dark border border-border-color text-text-primary text-xs px-2 py-1 rounded"
                            />
                            <button
                                onClick={handleExcelDownload}
                                disabled={xlsxLoading}
                                className={`px-3 py-1 text-xs font-bold rounded transition-colors ${
                                    xlsxLoading
                                        ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                        : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                }`}
                            >
                                {xlsxLoading ? '⏳ 조회 중...' : '📥 XLSX 다운로드'}
                            </button>
                            {xlsxStatus && (
                                <span className="text-[10px] text-text-secondary">{xlsxStatus}</span>
                            )}
                        </div>
                    </div>

                    {/* ── 데이터 없음 안내 ── */}
                    {!hasLive && !hasBt && (
                        <div className="text-center text-text-secondary py-8">
                            <p className="text-lg mb-2">📭 데이터 없음</p>
                            <p className="text-sm">실전 거래가 쌓이면 여기에서 백테스트와 비교합니다.</p>
                            <p className="text-sm">백테스트를 먼저 실행하고, 봇을 가동하세요.</p>
                        </div>
                    )}

                    {!hasLive && hasBt && (
                        <div className="text-center text-text-secondary py-4">
                            <p className="text-sm">⏳ 실전 거래 대기 중... 봇이 거래를 시작하면 자동으로 비교됩니다.</p>
                        </div>
                    )}

                    {/* ── 요약 카드 ── */}
                    {(hasLive || hasBt) && (
                        <div className="flex gap-3 flex-wrap">
                            <StatCard
                                label="승률"
                                liveValue={liveStats.winRate}
                                backtestValue={btStats.winRate}
                                liveCI={hasLive && liveTrades.length < 100 ? liveWinCI : undefined}
                            />
                            <StatCard
                                label="평균 PnL"
                                liveValue={liveStats.avgPnlPercent}
                                backtestValue={btStats.avgPnlPercent}
                            />
                            <StatCard
                                label="프로핏 팩터"
                                liveValue={liveStats.profitFactor === Infinity ? 99 : liveStats.profitFactor}
                                backtestValue={btStats.profitFactor === Infinity ? 99 : btStats.profitFactor}
                                suffix=""
                            />
                            <StatCard
                                label="최대 연속 손실"
                                liveValue={liveStats.maxConsecutiveLosses}
                                backtestValue={btStats.maxConsecutiveLosses}
                                suffix="건"
                                higherBetter={false}
                            />
                        </div>
                    )}

                    {/* ── 방향별 승률 ── */}
                    {hasLive && (
                        <div className="flex gap-3">
                            <div className="bg-bg-light border border-border-color rounded-lg p-3 flex-1">
                                <div className="text-xs text-text-secondary mb-1">🟢 Long 승률</div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-text-primary font-bold">{liveStats.longWinRate.toFixed(1)}%</span>
                                    {hasBt && <DeltaIndicator live={liveStats.longWinRate} backtest={btStats.longWinRate} />}
                                </div>
                            </div>
                            <div className="bg-bg-light border border-border-color rounded-lg p-3 flex-1">
                                <div className="text-xs text-text-secondary mb-1">🔴 Short 승률</div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-text-primary font-bold">{liveStats.shortWinRate.toFixed(1)}%</span>
                                    {hasBt && <DeltaIndicator live={liveStats.shortWinRate} backtest={btStats.shortWinRate} />}
                                </div>
                            </div>
                            <div className="bg-bg-light border border-border-color rounded-lg p-3 flex-1">
                                <div className="text-xs text-text-secondary mb-1">⏱️ 평균 보유시간</div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-text-primary font-bold">
                                        {liveStats.avgHoldingMinutes < 60
                                            ? `${liveStats.avgHoldingMinutes.toFixed(0)}분`
                                            : `${(liveStats.avgHoldingMinutes / 60).toFixed(1)}시간`}
                                    </span>
                                    {hasBt && (
                                        <span className="text-xs text-text-secondary">
                                            (백테: {btStats.avgHoldingMinutes < 60
                                                ? `${btStats.avgHoldingMinutes.toFixed(0)}분`
                                                : `${(btStats.avgHoldingMinutes / 60).toFixed(1)}시간`})
                                        </span>
                                    )}
                                </div>
                            </div>
                            {liveStats.avgMFE != null && (
                                <div className="bg-bg-light border border-border-color rounded-lg p-3 flex-1">
                                    <div className="text-xs text-text-secondary mb-1">📈 MFE / MAE</div>
                                    <div className="text-text-primary font-bold text-sm">
                                        <span className="text-green-400">+{liveStats.avgMFE!.toFixed(1)}%</span>
                                        {' / '}
                                        <span className="text-red-400">-{Math.abs(liveStats.avgMAE || 0).toFixed(1)}%</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── 전략별 승률 비교 차트 ── */}
                    {stratChartData.length > 0 && (
                        <div className="bg-bg-light border border-border-color rounded-lg p-3">
                            <div className="text-xs text-text-secondary mb-2">전략별 승률 비교</div>
                            <ResponsiveContainer width="100%" height={180}>
                                <BarChart data={stratChartData} barGap={2}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                    <XAxis dataKey="name" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                                    <YAxis tick={{ fill: '#9CA3AF', fontSize: 11 }} domain={[0, 100]} />
                                    <Tooltip
                                        contentStyle={{ background: '#1F2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                                        formatter={(value: number, name: string) => [
                                            `${value.toFixed(1)}%`,
                                            name === 'btWR' ? '백테스트' : '실전'
                                        ]}
                                    />
                                    <Bar dataKey="btWR" name="백테스트" fill="#3B82F6" radius={[2, 2, 0, 0]} maxBarSize={30} />
                                    <Bar dataKey="liveWR" name="실전" fill="#10B981" radius={[2, 2, 0, 0]} maxBarSize={30} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* ── 청산사유 분포 ── */}
                    {exitChartData.length > 0 && (
                        <div className="bg-bg-light border border-border-color rounded-lg p-3">
                            <div className="text-xs text-text-secondary mb-2">청산사유 분포 (%)</div>
                            <ResponsiveContainer width="100%" height={140}>
                                <BarChart data={exitChartData} layout="vertical" barGap={2}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                    <XAxis type="number" tick={{ fill: '#9CA3AF', fontSize: 11 }} domain={[0, 100]} />
                                    <YAxis dataKey="name" type="category" tick={{ fill: '#9CA3AF', fontSize: 11 }} width={50} />
                                    <Tooltip
                                        contentStyle={{ background: '#1F2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                                        formatter={(value: number, name: string) => [
                                            `${value.toFixed(1)}%`,
                                            name === 'backtest' ? '백테스트' : '실전'
                                        ]}
                                    />
                                    <Bar dataKey="backtest" name="백테스트" fill="#3B82F6" radius={[0, 2, 2, 0]} maxBarSize={16} />
                                    <Bar dataKey="live" name="실전" fill="#10B981" radius={[0, 2, 2, 0]} maxBarSize={16} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {/* ── 최근 거래 테이블 ── */}
                    {hasLive && (
                        <div className="bg-bg-light border border-border-color rounded-lg p-3">
                            <div className="text-xs text-text-secondary mb-2">최근 실전 거래 (최대 20건)</div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="text-text-secondary border-b border-border-color">
                                            <th className="text-left py-1 px-2">시간</th>
                                            <th className="text-left py-1 px-2">종목</th>
                                            <th className="text-center py-1 px-2">방향</th>
                                            <th className="text-right py-1 px-2">진입가</th>
                                            <th className="text-right py-1 px-2">청산가</th>
                                            <th className="text-right py-1 px-2">PnL%</th>
                                            <th className="text-right py-1 px-2">PnL$</th>
                                            <th className="text-center py-1 px-2">사유</th>
                                            <th className="text-right py-1 px-2">보유</th>
                                            <th className="text-center py-1 px-2">전략</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {liveTrades.slice(-20).reverse().map(t => (
                                            <tr key={t.id} className="border-b border-border-color/30 hover:bg-bg-dark/50">
                                                <td className="py-1 px-2 text-text-secondary">
                                                    {new Date(t.closeTimestamp).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                                                    {' '}
                                                    {new Date(t.closeTimestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                                </td>
                                                <td className="py-1 px-2 text-text-primary font-mono">{t.ticker.replace('USDT', '')}</td>
                                                <td className={`py-1 px-2 text-center ${t.direction === 'Long' ? 'text-green-400' : 'text-red-400'}`}>
                                                    {t.direction === 'Long' ? '🟢L' : '🔴S'}
                                                </td>
                                                <td className="py-1 px-2 text-right text-text-secondary font-mono">{t.entryPrice.toPrecision(5)}</td>
                                                <td className="py-1 px-2 text-right text-text-secondary font-mono">{t.exitPrice.toPrecision(5)}</td>
                                                <td className={`py-1 px-2 text-right font-bold font-mono ${t.pnlPercent > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {t.pnlPercent > 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%
                                                </td>
                                                <td className={`py-1 px-2 text-right font-mono ${t.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                                                </td>
                                                <td className="py-1 px-2 text-center">
                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                                        normalizeExitReason(t.reasonForExit) === 'TP'
                                                            ? 'bg-green-900/50 text-green-300'
                                                            : normalizeExitReason(t.reasonForExit) === 'SL'
                                                            ? 'bg-red-900/50 text-red-300'
                                                            : 'bg-gray-700 text-gray-300'
                                                    }`}>
                                                        {normalizeExitReason(t.reasonForExit)}
                                                    </span>
                                                </td>
                                                <td className="py-1 px-2 text-right text-text-secondary">
                                                    {/* ★ v52.9: 비정상 보유시간(>24h) 필터 — Bybit API 부정확 대응 */}
                                                    {t.holdingMinutes <= 0 || t.holdingMinutes > 24 * 60
                                                        ? '—'
                                                        : t.holdingMinutes < 60
                                                            ? `${t.holdingMinutes.toFixed(0)}분`
                                                            : `${(t.holdingMinutes / 60).toFixed(1)}h`}
                                                </td>
                                                <td className="py-1 px-2 text-center">
                                                    <span className="text-[10px] text-text-secondary">{t.strategyType || '-'}</span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* ── 신뢰도 안내 ── */}
                    {hasLive && liveTrades.length < 30 && (
                        <div className="text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-800/30 rounded-lg p-2">
                            ⚠️ 실전 거래 {liveTrades.length}건 — 최소 30건 이상이어야 통계적 의미가 있습니다.
                            100건 이상 모이면 Wilson CI 범위가 좁아집니다.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
