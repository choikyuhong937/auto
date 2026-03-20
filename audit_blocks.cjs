// audit_blocks.cjs — 모든 블록/리젝 메커니즘의 실제 유효성 데이터 분석
// 핵심 질문: 이 차단이 나쁜 진입을 막았는가, 아니면 좋은 기회를 길막했는가?

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', '거래내역 통계_v2.csv.csv');

// ═══════════════════════════════════════════
// 1. CSV 파싱 + 중복 제거
// ═══════════════════════════════════════════
function parseCSV(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim());

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',');
        const row = {};
        headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
        rows.push(row);
    }
    return rows;
}

function dedup(rows) {
    const map = new Map();
    for (const r of rows) {
        const key = r.id;
        if (!key) continue;
        const existing = map.get(key);
        if (!existing) { map.set(key, r); continue; }
        // tradeResult가 있는 레코드 우선
        if (r.tradeResult && !existing.tradeResult) { map.set(key, r); }
        else if (r.tradeResult && existing.tradeResult) {
            // tradePnl이 더 큰(절대값) 레코드 = 최종 결과
            if (Math.abs(parseFloat(r.tradePnl) || 0) > Math.abs(parseFloat(existing.tradePnl) || 0)) {
                map.set(key, r);
            }
        }
    }
    return [...map.values()];
}

// ═══════════════════════════════════════════
// 2. 헬퍼 함수
// ═══════════════════════════════════════════
function num(v) { return parseFloat(v) || 0; }

// SKIP된 진입이 수익이었을지 판단 (방향 기반)
function wouldHaveWon(row, timeframe = '5min') {
    const dir = row.direction;
    const move = num(row[`moveAfter${timeframe}`]);
    if (!dir || move === 0) return null; // 데이터 없음
    if (dir === 'Long') return move > 0;
    if (dir === 'Short') return move < 0;
    return null;
}

// 예상 수익률 계산 (%)
function expectedReturn(row, timeframe = '5min') {
    const dir = row.direction;
    const move = num(row[`moveAfter${timeframe}`]);
    if (!dir || move === 0) return 0;
    return dir === 'Long' ? move : -move; // Short이면 반대
}

function printTable(title, data, columns) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log(`  ${title}`);
    console.log(`${'═'.repeat(100)}`);

    // 컬럼 폭 계산
    const widths = columns.map(c => Math.max(c.label.length, ...data.map(r => String(r[c.key] ?? '').length)));

    // 헤더
    const header = columns.map((c, i) => c.label.padEnd(widths[i])).join(' │ ');
    console.log(`  ${header}`);
    console.log(`  ${widths.map(w => '─'.repeat(w)).join('─┼─')}`);

    // 행
    for (const row of data) {
        const line = columns.map((c, i) => {
            const val = String(row[c.key] ?? '');
            return c.align === 'right' ? val.padStart(widths[i]) : val.padEnd(widths[i]);
        }).join(' │ ');
        console.log(`  ${line}`);
    }
}

// ═══════════════════════════════════════════
// 3. 메인 분석
// ═══════════════════════════════════════════
function main() {
    console.log('블록/리젝 메커니즘 유효성 분석');
    console.log('=' .repeat(100));

    const raw = parseCSV(CSV_PATH);
    console.log(`원본 레코드: ${raw.length}`);

    const rows = dedup(raw);
    console.log(`중복 제거 후: ${rows.length}`);

    const enters = rows.filter(r => r.action === 'ENTER');
    const skips = rows.filter(r => r.action === 'SKIP');

    console.log(`ENTER: ${enters.length}, SKIP: ${skips.length}`);

    // ══════════════════════════════════════
    // PART 1: SKIP 분석 — 각 skipReason별 "차단이 올바른 결정이었는가?"
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 1: SKIP 분석 — 차단된 진입이 수익이었을까?');
    console.log('█'.repeat(100));

    const skipByReason = {};
    for (const s of skips) {
        const reason = s.skipReason || s.reason || 'UNKNOWN';
        if (!skipByReason[reason]) skipByReason[reason] = [];
        skipByReason[reason].push(s);
    }

    const skipAnalysis = [];
    for (const [reason, group] of Object.entries(skipByReason)) {
        const withData5 = group.filter(r => num(r.moveAfter5min) !== 0);
        const withData15 = group.filter(r => num(r.moveAfter15min) !== 0);
        const withData1h = group.filter(r => num(r.moveAfter1hr) !== 0);

        const wouldWin5 = withData5.filter(r => wouldHaveWon(r, '5min') === true).length;
        const wouldWin15 = withData15.filter(r => wouldHaveWon(r, '15min') === true).length;
        const wouldWin1h = withData1h.filter(r => wouldHaveWon(r, '1hr') === true).length;

        const avgReturn5 = withData5.length > 0
            ? withData5.reduce((sum, r) => sum + expectedReturn(r, '5min'), 0) / withData5.length : 0;
        const avgReturn15 = withData15.length > 0
            ? withData15.reduce((sum, r) => sum + expectedReturn(r, '15min'), 0) / withData15.length : 0;
        const avgReturn1h = withData1h.length > 0
            ? withData1h.reduce((sum, r) => sum + expectedReturn(r, '1hr'), 0) / withData1h.length : 0;

        // 세션별 분포
        const sessions = {};
        for (const r of group) { sessions[r.session] = (sessions[r.session] || 0) + 1; }

        // 레짐 분포
        const regimes = {};
        for (const r of group) { regimes[r.regime] = (regimes[r.regime] || 0) + 1; }

        // 방향 분포
        const dirs = {};
        for (const r of group) { dirs[r.direction] = (dirs[r.direction] || 0) + 1; }

        // 전략 분포
        const strategies = {};
        for (const r of group) {
            const strat = r.strategy || r.zoneType || 'UNKNOWN';
            strategies[strat] = (strategies[strat] || 0) + 1;
        }

        skipAnalysis.push({
            reason,
            count: group.length,
            withData5: withData5.length,
            wouldWin5, wouldWin15, wouldWin1h,
            wr5: withData5.length > 0 ? (wouldWin5 / withData5.length * 100).toFixed(1) : 'N/A',
            wr15: withData15.length > 0 ? (wouldWin15 / withData15.length * 100).toFixed(1) : 'N/A',
            wr1h: withData1h.length > 0 ? (wouldWin1h / withData1h.length * 100).toFixed(1) : 'N/A',
            avgRet5: avgReturn5.toFixed(3),
            avgRet15: avgReturn15.toFixed(3),
            avgRet1h: avgReturn1h.toFixed(3),
            sessions, regimes, dirs, strategies,
            avgRsi: (group.reduce((s, r) => s + num(r.rsi), 0) / group.length).toFixed(1),
            avgAdx: (group.reduce((s, r) => s + num(r.adx), 0) / group.length).toFixed(1),
            avgAtr: (group.reduce((s, r) => s + num(r.atrPercent), 0) / group.length).toFixed(4),
            avgConfidence: (group.reduce((s, r) => s + num(r.confidence), 0) / group.length).toFixed(1),
        });
    }

    skipAnalysis.sort((a, b) => b.count - a.count);

    printTable('SKIP Reason별 "차단하지 않았으면?" 분석', skipAnalysis.slice(0, 20), [
        { key: 'reason', label: 'Skip Reason', align: 'left' },
        { key: 'count', label: 'Count', align: 'right' },
        { key: 'withData5', label: 'w/Data', align: 'right' },
        { key: 'wr5', label: 'WR@5m', align: 'right' },
        { key: 'wr15', label: 'WR@15m', align: 'right' },
        { key: 'wr1h', label: 'WR@1h', align: 'right' },
        { key: 'avgRet5', label: 'Ret@5m%', align: 'right' },
        { key: 'avgRet15', label: 'Ret@15m%', align: 'right' },
        { key: 'avgRet1h', label: 'Ret@1h%', align: 'right' },
    ]);

    // 각 SKIP 이유별 세부 분석
    for (const sa of skipAnalysis) {
        if (sa.count < 5) continue;
        console.log(`\n--- ${sa.reason} (${sa.count}건) 세부 ---`);
        console.log(`  평균 RSI: ${sa.avgRsi}, 평균 ADX: ${sa.avgAdx}, 평균 ATR%: ${sa.avgAtr}, 평균 Confidence: ${sa.avgConfidence}`);
        console.log(`  방향: ${JSON.stringify(sa.dirs)}`);
        console.log(`  전략/존: ${JSON.stringify(sa.strategies)}`);
        console.log(`  레짐: ${JSON.stringify(sa.regimes)}`);
        console.log(`  세션: ${JSON.stringify(sa.sessions)}`);

        // 판정
        const wr5 = parseFloat(sa.wr5);
        if (!isNaN(wr5)) {
            if (wr5 > 55) console.log(`  🔴 판정: 나쁜 블록 — WR ${wr5}%로 수익 기회를 차단 중!`);
            else if (wr5 > 45) console.log(`  🟡 판정: 효과 불분명 — WR ${wr5}% (동전 던지기 수준)`);
            else if (wr5 > 35) console.log(`  🟢 판정: 약간 유효 — WR ${wr5}%로 손실 성향 차단`);
            else console.log(`  🟢 판정: 유효한 블록 — WR ${wr5}%로 손실 진입을 정확히 차단`);
        }
    }

    // ══════════════════════════════════════
    // PART 2: ENTER 분석 — 실제 진입한 거래의 조건별 승률
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 2: ENTER 분석 — 실제 진입 거래의 조건별 성과');
    console.log('█'.repeat(100));

    const entersWithResult = enters.filter(r => r.tradeResult);
    console.log(`\n결과 있는 진입: ${entersWithResult.length} / ${enters.length}`);

    // 2a. 전략별 성과
    const byStrategy = {};
    for (const r of entersWithResult) {
        const key = r.strategy || 'UNKNOWN';
        if (!byStrategy[key]) byStrategy[key] = { wins: 0, losses: 0, pnl: 0, trades: [] };
        byStrategy[key].trades.push(r);
        if (r.tradeResult === 'WIN') byStrategy[key].wins++;
        else byStrategy[key].losses++;
        byStrategy[key].pnl += num(r.tradePnl);
    }

    const stratData = Object.entries(byStrategy).map(([strat, d]) => ({
        strategy: strat,
        count: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        wr: ((d.wins / d.trades.length) * 100).toFixed(1),
        pnl: d.pnl.toFixed(2),
        avgPnl: (d.pnl / d.trades.length).toFixed(3),
        avgHold: (d.trades.reduce((s, r) => s + num(r.holdingMinutes), 0) / d.trades.length).toFixed(1),
    }));

    printTable('전략별 성과', stratData, [
        { key: 'strategy', label: 'Strategy', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
        { key: 'avgHold', label: 'AvgHold', align: 'right' },
    ]);

    // 2b. 레짐별 성과
    const byRegime = {};
    for (const r of entersWithResult) {
        const key = r.regime || 'UNKNOWN';
        if (!byRegime[key]) byRegime[key] = { wins: 0, losses: 0, pnl: 0, trades: [] };
        byRegime[key].trades.push(r);
        if (r.tradeResult === 'WIN') byRegime[key].wins++;
        else byRegime[key].losses++;
        byRegime[key].pnl += num(r.tradePnl);
    }

    const regimeData = Object.entries(byRegime).map(([reg, d]) => ({
        regime: reg,
        count: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        wr: ((d.wins / d.trades.length) * 100).toFixed(1),
        pnl: d.pnl.toFixed(2),
        avgPnl: (d.pnl / d.trades.length).toFixed(3),
    })).sort((a, b) => b.count - a.count);

    printTable('레짐별 성과', regimeData, [
        { key: 'regime', label: 'Regime', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // 2c. 세션별 성과
    const bySession = {};
    for (const r of entersWithResult) {
        const key = r.session || 'UNKNOWN';
        if (!bySession[key]) bySession[key] = { wins: 0, losses: 0, pnl: 0, trades: [] };
        bySession[key].trades.push(r);
        if (r.tradeResult === 'WIN') bySession[key].wins++;
        else bySession[key].losses++;
        bySession[key].pnl += num(r.tradePnl);
    }

    const sessionData = Object.entries(bySession).map(([sess, d]) => ({
        session: sess,
        count: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        wr: ((d.wins / d.trades.length) * 100).toFixed(1),
        pnl: d.pnl.toFixed(2),
        avgPnl: (d.pnl / d.trades.length).toFixed(3),
    })).sort((a, b) => b.count - a.count);

    printTable('세션별 성과', sessionData, [
        { key: 'session', label: 'Session', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // 2d. 존타입별 성과
    const byZone = {};
    for (const r of entersWithResult) {
        const key = r.zoneType || 'UNKNOWN';
        if (!byZone[key]) byZone[key] = { wins: 0, losses: 0, pnl: 0, trades: [] };
        byZone[key].trades.push(r);
        if (r.tradeResult === 'WIN') byZone[key].wins++;
        else byZone[key].losses++;
        byZone[key].pnl += num(r.tradePnl);
    }

    const zoneData = Object.entries(byZone).map(([zone, d]) => ({
        zone: zone,
        count: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        wr: ((d.wins / d.trades.length) * 100).toFixed(1),
        pnl: d.pnl.toFixed(2),
        avgPnl: (d.pnl / d.trades.length).toFixed(3),
    })).sort((a, b) => b.count - a.count);

    printTable('존타입별 성과', zoneData, [
        { key: 'zone', label: 'Zone Type', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // 2e. Exit Reason별 성과
    const byExit = {};
    for (const r of entersWithResult) {
        const key = r.exitReason || 'UNKNOWN';
        if (!byExit[key]) byExit[key] = { wins: 0, losses: 0, pnl: 0, trades: [] };
        byExit[key].trades.push(r);
        if (r.tradeResult === 'WIN') byExit[key].wins++;
        else byExit[key].losses++;
        byExit[key].pnl += num(r.tradePnl);
    }

    const exitData = Object.entries(byExit).map(([ex, d]) => ({
        exit: ex,
        count: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        wr: ((d.wins / d.trades.length) * 100).toFixed(1),
        pnl: d.pnl.toFixed(2),
        avgPnl: (d.pnl / d.trades.length).toFixed(3),
        avgHold: (d.trades.reduce((s, r) => s + num(r.holdingMinutes), 0) / d.trades.length).toFixed(1),
    })).sort((a, b) => b.count - a.count);

    printTable('Exit Reason별 성과', exitData, [
        { key: 'exit', label: 'Exit Reason', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
        { key: 'avgHold', label: 'AvgHold', align: 'right' },
    ]);

    // ══════════════════════════════════════
    // PART 3: 조건 교차 분석 — 어떤 조건 조합이 수익/손실인가?
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 3: 조건 교차 분석 — 실제 진입에서 "이 블록이 있었으면 막았을까?"');
    console.log('█'.repeat(100));

    // RSI 구간별
    const rsiRanges = [
        { label: '0-20 (과매도)', min: 0, max: 20 },
        { label: '20-30', min: 20, max: 30 },
        { label: '30-40', min: 30, max: 40 },
        { label: '40-50', min: 40, max: 50 },
        { label: '50-60', min: 50, max: 60 },
        { label: '60-70', min: 60, max: 70 },
        { label: '70-80', min: 70, max: 80 },
        { label: '80-100 (과매수)', min: 80, max: 100 },
    ];

    const rsiData = rsiRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const rsi = num(r.rsi);
            return rsi >= range.min && rsi < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('RSI 구간별 진입 성과 (실제 진입만)', rsiData, [
        { key: 'range', label: 'RSI Range', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // RSI × Direction 교차
    console.log('\n--- RSI × Direction 교차 ---');
    for (const dir of ['Long', 'Short']) {
        const dirTrades = entersWithResult.filter(r => r.direction === dir);
        for (const range of rsiRanges) {
            const trades = dirTrades.filter(r => {
                const rsi = num(r.rsi);
                return rsi >= range.min && rsi < range.max;
            });
            if (trades.length === 0) continue;
            const wins = trades.filter(r => r.tradeResult === 'WIN').length;
            const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
            const wr = ((wins / trades.length) * 100).toFixed(1);
            const flag = parseFloat(wr) < 25 ? '🔴' : parseFloat(wr) < 40 ? '🟡' : '🟢';
            console.log(`  ${flag} ${dir} RSI ${range.label}: ${trades.length}건, WR=${wr}%, PnL=$${pnl.toFixed(2)}, Avg=$${(pnl / trades.length).toFixed(3)}`);
        }
    }

    // ADX 구간별
    const adxRanges = [
        { label: '0 (데이터 없음)', min: 0, max: 0.01 },
        { label: '0-15 (약한 추세)', min: 0.01, max: 15 },
        { label: '15-25 (보통)', min: 15, max: 25 },
        { label: '25-35 (강한)', min: 25, max: 35 },
        { label: '35-50 (매우 강한)', min: 35, max: 50 },
        { label: '50+ (극단)', min: 50, max: 999 },
    ];

    const adxData = adxRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const adx = num(r.adx);
            return adx >= range.min && adx < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('ADX 구간별 진입 성과', adxData, [
        { key: 'range', label: 'ADX Range', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // ATR% 구간별
    const atrRanges = [
        { label: '<1% (저변동)', min: 0, max: 0.01 },
        { label: '1-2%', min: 0.01, max: 0.02 },
        { label: '2-3%', min: 0.02, max: 0.03 },
        { label: '3-4% (위험)', min: 0.03, max: 0.04 },
        { label: '4-6%', min: 0.04, max: 0.06 },
        { label: '6%+ (극단)', min: 0.06, max: 999 },
    ];

    const atrData = atrRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const atr = num(r.atrPercent);
            return atr >= range.min && atr < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('ATR% 구간별 진입 성과', atrData, [
        { key: 'range', label: 'ATR% Range', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // Leverage 구간별
    const levRanges = [
        { label: '1-10x', min: 1, max: 11 },
        { label: '11-20x', min: 11, max: 21 },
        { label: '21-30x', min: 21, max: 31 },
        { label: '31-50x', min: 31, max: 51 },
        { label: '51-75x', min: 51, max: 76 },
        { label: '75x+', min: 76, max: 999 },
    ];

    const levData = levRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const lev = num(r.leverage);
            return lev >= range.min && lev < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('레버리지 구간별 진입 성과', levData, [
        { key: 'range', label: 'Leverage', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // Holding Time 구간별
    const holdRanges = [
        { label: '0-2분', min: 0, max: 2 },
        { label: '2-5분', min: 2, max: 5 },
        { label: '5-15분', min: 5, max: 15 },
        { label: '15-30분', min: 15, max: 30 },
        { label: '30-60분', min: 30, max: 60 },
        { label: '60-120분', min: 60, max: 120 },
        { label: '120분+', min: 120, max: 99999 },
    ];

    const holdData = holdRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const hold = num(r.holdingMinutes);
            return hold >= range.min && hold < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('홀딩 시간별 성과', holdData, [
        { key: 'range', label: 'Holding', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // Fatigue Score 구간별
    const fatRanges = [
        { label: '0', min: 0, max: 0.01 },
        { label: '1-20', min: 0.01, max: 20.01 },
        { label: '20-30', min: 20.01, max: 30.01 },
        { label: '30-50 (데스존)', min: 30.01, max: 50.01 },
        { label: '50-75', min: 50.01, max: 75.01 },
        { label: '75+', min: 75.01, max: 999 },
    ];

    const fatData = fatRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const fat = num(r.fatigueScore);
            return fat >= range.min && fat < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('피로도 구간별 성과', fatData, [
        { key: 'range', label: 'Fatigue', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // Confidence 구간별
    const confRanges = [
        { label: '0', min: 0, max: 0.01 },
        { label: '1-30', min: 0.01, max: 30.01 },
        { label: '30-50', min: 30.01, max: 50.01 },
        { label: '50-70', min: 50.01, max: 70.01 },
        { label: '70-85', min: 70.01, max: 85.01 },
        { label: '85+', min: 85.01, max: 999 },
    ];

    const confData = confRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const conf = num(r.confidence);
            return conf >= range.min && conf < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('Confidence 구간별 성과', confData, [
        { key: 'range', label: 'Confidence', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // Hurst 구간별
    const hurstRanges = [
        { label: '0-0.3 (평균회귀)', min: 0, max: 0.3 },
        { label: '0.3-0.45', min: 0.3, max: 0.45 },
        { label: '0.45-0.55 (랜덤)', min: 0.45, max: 0.55 },
        { label: '0.55-0.7', min: 0.55, max: 0.7 },
        { label: '0.7-1.0 (추세)', min: 0.7, max: 1.01 },
    ];

    const hurstData = hurstRanges.map(range => {
        const trades = entersWithResult.filter(r => {
            const h = num(r.hurst);
            return h >= range.min && h < range.max;
        });
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        return {
            range: range.label,
            count: trades.length,
            wins,
            losses: trades.length - wins,
            wr: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 'N/A',
            pnl: pnl.toFixed(2),
            avgPnl: trades.length > 0 ? (pnl / trades.length).toFixed(3) : '0',
        };
    });

    printTable('Hurst 구간별 성과', hurstData, [
        { key: 'range', label: 'Hurst', align: 'left' },
        { key: 'count', label: 'Trades', align: 'right' },
        { key: 'wins', label: 'Wins', align: 'right' },
        { key: 'losses', label: 'Losses', align: 'right' },
        { key: 'wr', label: 'WR%', align: 'right' },
        { key: 'pnl', label: 'PnL$', align: 'right' },
        { key: 'avgPnl', label: 'Avg$', align: 'right' },
    ]);

    // ══════════════════════════════════════
    // PART 4: "이 블록이 있었다면?" 시뮬레이션
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 4: 가상 블록 시뮬레이션 — "이 조건으로 차단했으면?"');
    console.log('█'.repeat(100));

    const simBlocks = [
        { name: 'RSI>70 Long 차단', test: r => r.direction === 'Long' && num(r.rsi) > 70 },
        { name: 'RSI>80 Long 차단', test: r => r.direction === 'Long' && num(r.rsi) > 80 },
        { name: 'RSI<30 Short 차단', test: r => r.direction === 'Short' && num(r.rsi) < 30 },
        { name: 'RSI<20 Short 차단', test: r => r.direction === 'Short' && num(r.rsi) < 20 },
        { name: 'ADX<15 전체 차단', test: r => num(r.adx) > 0 && num(r.adx) < 15 },
        { name: 'ADX<20 전체 차단', test: r => num(r.adx) > 0 && num(r.adx) < 20 },
        { name: 'ADX>50 전체 차단', test: r => num(r.adx) > 50 },
        { name: 'ATR>4% 차단', test: r => num(r.atrPercent) > 0.04 },
        { name: 'ATR>5% 차단', test: r => num(r.atrPercent) > 0.05 },
        { name: 'ATR<1% 차단', test: r => num(r.atrPercent) > 0 && num(r.atrPercent) < 0.01 },
        { name: 'Fatigue 30-50 차단', test: r => num(r.fatigueScore) >= 30 && num(r.fatigueScore) <= 50 },
        { name: 'Fatigue>50 차단', test: r => num(r.fatigueScore) > 50 },
        { name: 'Lev>50x 차단', test: r => num(r.leverage) > 50 },
        { name: 'Lev>30x 차단', test: r => num(r.leverage) > 30 },
        { name: 'Hurst 0.45-0.55 차단', test: r => num(r.hurst) >= 0.45 && num(r.hurst) <= 0.55 },
        { name: 'Confidence<30 차단', test: r => num(r.confidence) > 0 && num(r.confidence) < 30 },
        { name: 'OVERLAP_ASIA_EU 차단', test: r => r.session === 'OVERLAP_ASIA_EU' },
        { name: 'WEEKEND 차단', test: r => r.session === 'WEEKEND' },
        { name: 'Hold>60분 차단 (가상)', test: r => num(r.holdingMinutes) > 60 },
        { name: 'Hold<2분 차단 (가상)', test: r => num(r.holdingMinutes) > 0 && num(r.holdingMinutes) < 2 },
        { name: 'exchange_close 거래 차단', test: r => r.exitReason === 'exchange_close' },
        { name: 'Long RSI>65 + ADX<25', test: r => r.direction === 'Long' && num(r.rsi) > 65 && num(r.adx) < 25 && num(r.adx) > 0 },
        { name: 'Short RSI<35 + ADX<25', test: r => r.direction === 'Short' && num(r.rsi) < 35 && num(r.adx) < 25 && num(r.adx) > 0 },
    ];

    const simResults = simBlocks.map(block => {
        const wouldBlock = entersWithResult.filter(block.test);
        const wouldPass = entersWithResult.filter(r => !block.test(r));

        const blockWins = wouldBlock.filter(r => r.tradeResult === 'WIN').length;
        const blockPnl = wouldBlock.reduce((s, r) => s + num(r.tradePnl), 0);
        const passWins = wouldPass.filter(r => r.tradeResult === 'WIN').length;
        const passPnl = wouldPass.reduce((s, r) => s + num(r.tradePnl), 0);

        const totalPnlNow = entersWithResult.reduce((s, r) => s + num(r.tradePnl), 0);
        const pnlImprovement = passPnl - totalPnlNow; // 양수 = 개선

        return {
            block: block.name,
            blocked: wouldBlock.length,
            blockWR: wouldBlock.length > 0 ? ((blockWins / wouldBlock.length) * 100).toFixed(1) : 'N/A',
            blockPnl: blockPnl.toFixed(2),
            remaining: wouldPass.length,
            passWR: wouldPass.length > 0 ? ((passWins / wouldPass.length) * 100).toFixed(1) : 'N/A',
            passPnl: passPnl.toFixed(2),
            improvement: pnlImprovement.toFixed(2),
            effective: blockPnl < 0 ? '✅ 유효' : blockPnl >= 0 ? '❌ 역효과' : '➖',
        };
    });

    // PnL improvement 순으로 정렬
    simResults.sort((a, b) => parseFloat(b.improvement) - parseFloat(a.improvement));

    printTable('가상 블록 시뮬레이션 (차단했을 때 PnL 개선도)', simResults, [
        { key: 'block', label: 'Block Rule', align: 'left' },
        { key: 'blocked', label: 'Blocked', align: 'right' },
        { key: 'blockWR', label: 'BlkWR%', align: 'right' },
        { key: 'blockPnl', label: 'BlkPnL$', align: 'right' },
        { key: 'remaining', label: 'Remain', align: 'right' },
        { key: 'passWR', label: 'PassWR%', align: 'right' },
        { key: 'passPnl', label: 'PassPnL$', align: 'right' },
        { key: 'improvement', label: 'Improve$', align: 'right' },
        { key: 'effective', label: 'Judge', align: 'left' },
    ]);

    // ══════════════════════════════════════
    // PART 5: 복합 분석 — 기존 블록 vs 실제 통과된 거래
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 5: 기존 블록 유효성 종합 판정');
    console.log('█'.repeat(100));

    // SKIP된 것들의 사후 움직임 분석 요약
    console.log('\n--- SKIP 사후 움직임 종합 ---');
    const allSkipsWithMove = skips.filter(r => num(r.moveAfter5min) !== 0 || num(r.moveAfter15min) !== 0);

    if (allSkipsWithMove.length > 0) {
        // 방향별로 SKIP이 올바른 결정이었는지
        for (const reason of Object.keys(skipByReason).sort((a,b) => skipByReason[b].length - skipByReason[a].length)) {
            const group = skipByReason[reason];
            const withMove = group.filter(r => num(r.moveAfter5min) !== 0);
            if (withMove.length === 0) continue;

            const correctBlock = withMove.filter(r => wouldHaveWon(r, '5min') === false).length;
            const wrongBlock = withMove.filter(r => wouldHaveWon(r, '5min') === true).length;
            const accuracy = ((correctBlock / withMove.length) * 100).toFixed(1);

            const avgMissedGain = wrongBlock > 0
                ? withMove.filter(r => wouldHaveWon(r, '5min') === true)
                    .reduce((s, r) => s + Math.abs(expectedReturn(r, '5min')), 0) / wrongBlock
                : 0;

            const avgSavedLoss = correctBlock > 0
                ? withMove.filter(r => wouldHaveWon(r, '5min') === false)
                    .reduce((s, r) => s + Math.abs(expectedReturn(r, '5min')), 0) / correctBlock
                : 0;

            const verdict = parseFloat(accuracy) > 55 ? '✅ 유효한 블록'
                : parseFloat(accuracy) > 45 ? '🟡 효과 미미'
                : '❌ 역효과 블록';

            console.log(`\n  ${verdict} [${reason}] (${group.length}건, 사후데이터 ${withMove.length}건)`);
            console.log(`    정확한 차단: ${correctBlock}건 (${accuracy}%) — 평균 방지 손실: ${avgSavedLoss.toFixed(3)}%`);
            console.log(`    잘못된 차단: ${wrongBlock}건 (${(100 - parseFloat(accuracy)).toFixed(1)}%) — 평균 놓친 수익: ${avgMissedGain.toFixed(3)}%`);
        }
    } else {
        console.log('  SKIP 레코드에 사후 움직임 데이터 없음 (moveAfter5min/15min/1hr 모두 0)');
        console.log('  → B3 수정 (SKIP 데이터 풍부화) 적용 후 재분석 필요');
    }

    // ══════════════════════════════════════
    // PART 6: MFE/MAE 분석 — TP/SL 설정이 적절한가?
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 6: MFE/MAE 분석 — TP/SL 설정 적절성');
    console.log('█'.repeat(100));

    const withMfe = entersWithResult.filter(r => num(r.maxFavorableExcursion) > 0 || num(r.maxAdverseExcursion) > 0);

    if (withMfe.length > 0) {
        const wins = withMfe.filter(r => r.tradeResult === 'WIN');
        const losses = withMfe.filter(r => r.tradeResult === 'LOSS');

        console.log(`\n  MFE/MAE 데이터 있는 거래: ${withMfe.length}건`);

        if (wins.length > 0) {
            const avgWinMfe = wins.reduce((s, r) => s + num(r.maxFavorableExcursion), 0) / wins.length;
            const avgWinMae = wins.reduce((s, r) => s + num(r.maxAdverseExcursion), 0) / wins.length;
            const avgWinTp = wins.reduce((s, r) => s + num(r.tpPercent), 0) / wins.length;
            console.log(`\n  WIN 거래 (${wins.length}건):`);
            console.log(`    평균 MFE: ${avgWinMfe.toFixed(4)} (최대 유리 움직임)`);
            console.log(`    평균 MAE: ${avgWinMae.toFixed(4)} (최대 불리 움직임)`);
            console.log(`    평균 TP%: ${avgWinTp.toFixed(4)}`);
            console.log(`    MFE/TP 비율: ${(avgWinMfe / avgWinTp).toFixed(2)}x (1.0+면 더 큰 TP 가능)`);
        }

        if (losses.length > 0) {
            const avgLossMfe = losses.reduce((s, r) => s + num(r.maxFavorableExcursion), 0) / losses.length;
            const avgLossMae = losses.reduce((s, r) => s + num(r.maxAdverseExcursion), 0) / losses.length;
            const avgLossSl = losses.reduce((s, r) => s + num(r.slPercent), 0) / losses.length;
            const avgLossTp = losses.reduce((s, r) => s + num(r.tpPercent), 0) / losses.length;
            console.log(`\n  LOSS 거래 (${losses.length}건):`);
            console.log(`    평균 MFE: ${avgLossMfe.toFixed(4)} (SL 전에 수익권 진입 여부)`);
            console.log(`    평균 MAE: ${avgLossMae.toFixed(4)}`);
            console.log(`    평균 TP%: ${avgLossTp.toFixed(4)}, 평균 SL%: ${avgLossSl.toFixed(4)}`);

            // SL 전에 TP 닿을 뻔한 거래
            const almostWon = losses.filter(r => {
                const mfe = num(r.maxFavorableExcursion);
                const tp = num(r.tpPercent);
                return tp > 0 && mfe > 0 && mfe >= tp * 0.7; // TP의 70% 이상 도달
            });
            console.log(`    TP의 70%+ 도달 후 SL: ${almostWon.length}건 (${((almostWon.length/losses.length)*100).toFixed(1)}%) — TP가 너무 크거나 트레일링 필요`);

            // MFE > 0이지만 SL 맞은 거래 (방향은 맞았으나)
            const rightDirLoss = losses.filter(r => num(r.maxFavorableExcursion) > 0);
            console.log(`    방향은 맞았으나 SL: ${rightDirLoss.length}건 (${((rightDirLoss.length/losses.length)*100).toFixed(1)}%)`);

            // MFE가 매우 작은 (방향 자체가 틀린) 거래
            const wrongDir = losses.filter(r => num(r.maxFavorableExcursion) <= 0.001);
            console.log(`    방향 자체가 틀린 (MFE≈0): ${wrongDir.length}건 (${((wrongDir.length/losses.length)*100).toFixed(1)}%) — 진입 타이밍/방향 문제`);
        }
    } else {
        console.log('  MFE/MAE 데이터 없음');
    }

    // TP/SL 비율 분석
    console.log('\n--- TP vs SL 비율 분석 ---');
    const withTpSl = entersWithResult.filter(r => num(r.tpPercent) > 0 && num(r.slPercent) > 0);
    if (withTpSl.length > 0) {
        const rrRatios = withTpSl.map(r => num(r.tpPercent) / num(r.slPercent));
        const avgRR = rrRatios.reduce((s, v) => s + v, 0) / rrRatios.length;
        console.log(`  평균 TP/SL 비율: ${avgRR.toFixed(2)}:1`);

        const rrBuckets = [
            { label: '<0.5:1', min: 0, max: 0.5 },
            { label: '0.5-1:1', min: 0.5, max: 1 },
            { label: '1-1.5:1', min: 1, max: 1.5 },
            { label: '1.5-2:1', min: 1.5, max: 2 },
            { label: '2-3:1', min: 2, max: 3 },
            { label: '3+:1', min: 3, max: 999 },
        ];

        for (const bucket of rrBuckets) {
            const trades = withTpSl.filter(r => {
                const rr = num(r.tpPercent) / num(r.slPercent);
                return rr >= bucket.min && rr < bucket.max;
            });
            if (trades.length === 0) continue;
            const wins = trades.filter(r => r.tradeResult === 'WIN').length;
            const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
            console.log(`  RR ${bucket.label}: ${trades.length}건, WR=${((wins/trades.length)*100).toFixed(1)}%, PnL=$${pnl.toFixed(2)}`);
        }
    }

    // ══════════════════════════════════════
    // PART 7: 최종 권고사항
    // ══════════════════════════════════════
    console.log('\n\n' + '█'.repeat(100));
    console.log('  PART 7: 최종 권고사항');
    console.log('█'.repeat(100));

    console.log('\n분석 완료. 위 데이터를 기반으로 블록 유효성을 판단해주세요.');
    console.log('\n핵심 질문:');
    console.log('  1. SKIP 데이터에 사후 움직임(moveAfter*)이 있는가? → 없으면 B3 수정 후 재분석');
    console.log('  2. 각 블록의 "정확한 차단율"이 50% 이상인가? → 미만이면 역효과');
    console.log('  3. 가상 블록 시뮬레이션에서 PnL 개선이 양수인가? → 양수면 해당 블록 추가 권고');
    console.log('  4. MFE 분석에서 "방향은 맞았으나 SL"이 높으면 → SL 너무 좁음');
    console.log('  5. "TP 70%+ 도달 후 SL"이 높으면 → TP 너무 크거나 트레일링 없음');
}

main();
