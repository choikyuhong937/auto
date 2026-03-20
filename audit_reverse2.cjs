/**
 * Smart Reverse 정밀 감사 v2 — ID 기반 중복제거
 */
const fs = require('fs');

const raw = fs.readFileSync('C:\\Users\\michj\\Downloads\\거래내역 통계_v2.csv.csv', 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const header = lines[0].split(',');

function parseRow(line) {
    const vals = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    vals.push(cur.trim());
    return vals;
}

const rows = lines.slice(1).map(parseRow);
console.log(`Total raw rows: ${rows.length}`);

// 컬럼 인덱스
const colMap = {};
header.forEach((h, i) => { colMap[h.trim()] = i; });
const ci = (name) => {
    const exact = colMap[name];
    if (exact !== undefined) return exact;
    const key = Object.keys(colMap).find(k => k.toLowerCase() === name.toLowerCase());
    return key !== undefined ? colMap[key] : -1;
};

const iId = ci('id');
const iAction = ci('action');
const iDir = ci('direction');
const iStrategy = ci('strategy');
const iSkip = ci('skipReason');
const iReversed = ci('wasReversed');
const iResult = ci('tradeResult');
const iPnl = ci('tradePnl');
const iRsi = ci('rsi');
const iAdx = ci('adx');
const iRegime = ci('regime');
const iSession = ci('session');
const iExit = ci('exitReason');
const iHold = ci('holdingMinutes');
const iLev = ci('leverage');
const iMfe = ci('maxFavorableExcursion');
const iMae = ci('maxAdverseExcursion');
const iTicker = ci('ticker');
const iTs = ci('timestamp');
const iZone = ci('zoneType');
const iMove5 = ci('moveAfter5min');
const iMove15 = ci('moveAfter15min');
const iMove1h = ci('moveAfter1hr');
const iPrice = ci('price');

console.log(`Columns: id=${iId}, action=${iAction}, dir=${iDir}, reversed=${iReversed}, result=${iResult}, pnl=${iPnl}, mfe=${iMfe}, mae=${iMae}, move5=${iMove5}, move15=${iMove15}`);

// ID 기반 중복제거
const seenIds = new Set();
const deduped = [];
for (const r of rows) {
    const id = r[iId] || '';
    if (id && !seenIds.has(id)) {
        seenIds.add(id);
        deduped.push(r);
    }
}
console.log(`After ID dedup: ${deduped.length} records`);

// 만약 ID 기반이 너무 많으면, 추가로 ticker+timestamp 근접 제거
const deduped2 = [];
const tsMap = new Map();
for (const r of deduped) {
    const ticker = r[iTicker] || '';
    const ts = parseInt(r[iTs]) || 0;
    const action = r[iAction] || '';
    const key = `${ticker}_${action}_${Math.floor(ts / 30000)}`; // 30초 윈도우
    if (!tsMap.has(key)) {
        tsMap.set(key, true);
        deduped2.push(r);
    }
}
console.log(`After ticker+action+30s dedup: ${deduped2.length} records`);

const enters = deduped2.filter(r => (r[iAction] || '').toUpperCase() === 'ENTER');
const skips = deduped2.filter(r => (r[iAction] || '').toUpperCase() === 'SKIP');
console.log(`ENTER: ${enters.length}, SKIP: ${skips.length}`);

const tradesWithResult = enters.filter(r => r[iResult] && r[iResult] !== '' && r[iResult] !== '0');
console.log(`ENTER with tradeResult: ${tradesWithResult.length}`);

// ===============================================================
// PART 1: 방향 분포 + wasReversed
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 1: ENTER 방향 분포');
console.log('='.repeat(70));

const dirStats = {};
for (const r of enters) {
    const d = r[iDir] || 'UNKNOWN';
    const rev = r[iReversed] || 'EMPTY';
    const key = `${d}|rev=${rev}`;
    dirStats[key] = (dirStats[key] || 0) + 1;
}
Object.entries(dirStats).sort((a,b) => b[1]-a[1]).forEach(([k, c]) => {
    console.log(`  ${k}: ${c} (${(c/enters.length*100).toFixed(1)}%)`);
});

// ===============================================================
// PART 2: 실제 거래 — 모든 조합
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 2: 실제 거래 결과 (tradeResult 있는 것)');
console.log('='.repeat(70));

for (const r of tradesWithResult) {
    const ticker = r[iTicker];
    const dir = r[iDir];
    const rev = r[iReversed];
    const result = r[iResult];
    const pnl = r[iPnl];
    const exit = r[iExit];
    const hold = r[iHold];
    const lev = r[iLev];
    const regime = r[iRegime];
    const sess = r[iSession];
    const strat = r[iStrategy];
    const zone = r[iZone];
    const mfe = r[iMfe];
    const mae = r[iMae];
    const rsi = r[iRsi];
    const adx = r[iAdx];
    console.log(`  ${ticker} | ${dir} | rev=${rev} | ${result} | PnL=$${pnl} | ${exit} | ${hold}min`);
    console.log(`    Regime=${regime} | Sess=${sess} | Strat=${strat} | Zone=${zone}`);
    console.log(`    Lev=${lev}x | RSI=${rsi} | ADX=${adx} | MFE=${mfe} | MAE=${mae}`);
}

// ===============================================================
// PART 3: 5분/15분/1시간 후 가격 이동 분석 — 방향 정확도
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 3: 5min/15min/1hr 후 이동 — ENTER 방향 정확도');
console.log('='.repeat(70));

// direction이 Short인 경우: 가격 하락 = 수익 (move가 음수면 Short에 유리)
// direction이 Long인 경우: 가격 상승 = 수익 (move가 양수면 Long에 유리)
// wasReversed=TRUE이면: 실제 진입은 반대방향

const timeframes = [
    { name: '5min', col: iMove5 },
    { name: '15min', col: iMove15 },
    { name: '1hr', col: iMove1h }
];

for (const tf of timeframes) {
    console.log(`\n  === ${tf.name} 후 이동 ===`);

    const groups = { 'Long_orig': [], 'Short_orig': [], 'Long_reversed': [], 'Short_reversed': [] };

    for (const r of enters) {
        const move = parseFloat(r[tf.col]);
        if (isNaN(move) || move === 0) continue;

        const dir = r[iDir] || '';
        const rev = (r[iReversed] || '').toUpperCase() === 'TRUE';

        if (dir === 'Long' && !rev) groups['Long_orig'].push(move);
        else if (dir === 'Long' && rev) groups['Long_reversed'].push(move);
        else if (dir === 'Short' && !rev) groups['Short_orig'].push(move);
        else if (dir === 'Short' && rev) groups['Short_reversed'].push(move);
    }

    for (const [group, moves] of Object.entries(groups)) {
        if (moves.length === 0) continue;

        const isReversed = group.includes('reversed');
        const origDir = group.startsWith('Long') ? 'Long' : 'Short';
        // 실제 진입 방향
        const actualDir = isReversed ? (origDir === 'Long' ? 'Short' : 'Long') : origDir;

        // 수익 방향 계산: Long이면 양수 이동 = 수익, Short이면 음수 이동 = 수익
        const profitable = moves.filter(m => actualDir === 'Long' ? m > 0 : m < 0);
        const avgMove = moves.reduce((s, m) => s + m, 0) / moves.length;
        const dirAccuracy = (profitable.length / moves.length * 100).toFixed(1);

        // 원래 방향이 맞았는지 (반전 안했으면 어땠을까)
        const origProfitable = moves.filter(m => origDir === 'Long' ? m > 0 : m < 0);
        const origAccuracy = (origProfitable.length / moves.length * 100).toFixed(1);

        console.log(`  ${group} (실제=${actualDir}): ${moves.length}건 | avgMove=${avgMove.toFixed(3)}%`);
        console.log(`    실제방향 정확: ${dirAccuracy}% | 원래방향이었으면: ${origAccuracy}%`);
    }
}

// ===============================================================
// PART 4: 세션별 방향 정확도
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 4: 세션 × 리버스 — 15min 방향 정확도');
console.log('='.repeat(70));

const sessDir = {};
for (const r of enters) {
    const move = parseFloat(r[iMove15]);
    if (isNaN(move) || move === 0) continue;

    const sess = r[iSession] || '?';
    const dir = r[iDir] || '?';
    const rev = (r[iReversed] || '').toUpperCase() === 'TRUE';
    const actualDir = rev ? (dir === 'Long' ? 'Short' : 'Long') : dir;
    const isCorrect = actualDir === 'Long' ? move > 0 : move < 0;
    const wouldBeCorrectOrig = dir === 'Long' ? move > 0 : move < 0;

    const key = `${sess}`;
    if (!sessDir[key]) sessDir[key] = { total: 0, actualCorrect: 0, origCorrect: 0, reversed: 0 };
    sessDir[key].total++;
    if (isCorrect) sessDir[key].actualCorrect++;
    if (wouldBeCorrectOrig) sessDir[key].origCorrect++;
    if (rev) sessDir[key].reversed++;
}

console.log('  세션         | 건수 | 반전 | 반전후정확 | 원래방향정확 | 차이');
Object.entries(sessDir).sort((a,b) => b[1].total - a[1].total).forEach(([sess, v]) => {
    const actualPct = (v.actualCorrect / v.total * 100).toFixed(1);
    const origPct = (v.origCorrect / v.total * 100).toFixed(1);
    const diff = (parseFloat(actualPct) - parseFloat(origPct)).toFixed(1);
    const better = parseFloat(diff) > 0 ? '반전↑' : parseFloat(diff) < 0 ? '원래↑' : '동일';
    console.log(`  ${sess.padEnd(18)} | ${String(v.total).padStart(4)} | ${String(v.reversed).padStart(4)} | ${actualPct.padStart(10)}% | ${origPct.padStart(11)}% | ${diff.padStart(5)}% ${better}`);
});

// ===============================================================
// PART 5: 레짐별 방향 정확도
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 5: 레짐 × 리버스 — 15min 방향 정확도');
console.log('='.repeat(70));

const regDir = {};
for (const r of enters) {
    const move = parseFloat(r[iMove15]);
    if (isNaN(move) || move === 0) continue;

    const regime = r[iRegime] || '?';
    const dir = r[iDir] || '?';
    const rev = (r[iReversed] || '').toUpperCase() === 'TRUE';
    const actualDir = rev ? (dir === 'Long' ? 'Short' : 'Long') : dir;
    const isCorrect = actualDir === 'Long' ? move > 0 : move < 0;
    const wouldBeCorrectOrig = dir === 'Long' ? move > 0 : move < 0;

    if (!regDir[regime]) regDir[regime] = { total: 0, actualCorrect: 0, origCorrect: 0 };
    regDir[regime].total++;
    if (isCorrect) regDir[regime].actualCorrect++;
    if (wouldBeCorrectOrig) regDir[regime].origCorrect++;
}

console.log('  레짐                    | 건수 | 반전후정확 | 원래방향정확 | 차이');
Object.entries(regDir).sort((a,b) => b[1].total - a[1].total).forEach(([regime, v]) => {
    const actualPct = (v.actualCorrect / v.total * 100).toFixed(1);
    const origPct = (v.origCorrect / v.total * 100).toFixed(1);
    const diff = (parseFloat(actualPct) - parseFloat(origPct)).toFixed(1);
    const better = parseFloat(diff) > 0 ? '반전↑' : parseFloat(diff) < 0 ? '원래↑' : '동일';
    console.log(`  ${regime.padEnd(25)} | ${String(v.total).padStart(4)} | ${actualPct.padStart(10)}% | ${origPct.padStart(11)}% | ${diff.padStart(5)}% ${better}`);
});

// ===============================================================
// PART 6: 전략 × 방향 × 15min 정확도
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 6: 전략 × 리버스 — 15min 방향 정확도');
console.log('='.repeat(70));

const stratDir = {};
for (const r of enters) {
    const move = parseFloat(r[iMove15]);
    if (isNaN(move) || move === 0) continue;

    const strat = r[iStrategy] || '?';
    const dir = r[iDir] || '?';
    const rev = (r[iReversed] || '').toUpperCase() === 'TRUE';
    const actualDir = rev ? (dir === 'Long' ? 'Short' : 'Long') : dir;
    const isCorrect = actualDir === 'Long' ? move > 0 : move < 0;
    const wouldBeCorrectOrig = dir === 'Long' ? move > 0 : move < 0;

    if (!stratDir[strat]) stratDir[strat] = { total: 0, actualCorrect: 0, origCorrect: 0 };
    stratDir[strat].total++;
    if (isCorrect) stratDir[strat].actualCorrect++;
    if (wouldBeCorrectOrig) stratDir[strat].origCorrect++;
}

console.log('  전략              | 건수 | 반전후정확 | 원래방향정확 | 차이');
Object.entries(stratDir).sort((a,b) => b[1].total - a[1].total).forEach(([strat, v]) => {
    const actualPct = (v.actualCorrect / v.total * 100).toFixed(1);
    const origPct = (v.origCorrect / v.total * 100).toFixed(1);
    const diff = (parseFloat(actualPct) - parseFloat(origPct)).toFixed(1);
    const better = parseFloat(diff) > 0 ? '반전↑' : parseFloat(diff) < 0 ? '원래↑' : '동일';
    console.log(`  ${strat.padEnd(20)} | ${String(v.total).padStart(4)} | ${actualPct.padStart(10)}% | ${origPct.padStart(11)}% | ${diff.padStart(5)}% ${better}`);
});

// ===============================================================
// PART 7: 전체 요약 — 반전이 도움이 되었나?
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 7: 전체 요약');
console.log('='.repeat(70));

let totalWith15m = 0, actualCorrect15m = 0, origCorrect15m = 0;
let totalWith5m = 0, actualCorrect5m = 0, origCorrect5m = 0;
let totalWith1h = 0, actualCorrect1h = 0, origCorrect1h = 0;

for (const r of enters) {
    const dir = r[iDir] || '';
    const rev = (r[iReversed] || '').toUpperCase() === 'TRUE';
    const actualDir = rev ? (dir === 'Long' ? 'Short' : 'Long') : dir;

    const m5 = parseFloat(r[iMove5]);
    const m15 = parseFloat(r[iMove15]);
    const m1h = parseFloat(r[iMove1h]);

    if (!isNaN(m5) && m5 !== 0) {
        totalWith5m++;
        if ((actualDir === 'Long' && m5 > 0) || (actualDir === 'Short' && m5 < 0)) actualCorrect5m++;
        if ((dir === 'Long' && m5 > 0) || (dir === 'Short' && m5 < 0)) origCorrect5m++;
    }
    if (!isNaN(m15) && m15 !== 0) {
        totalWith15m++;
        if ((actualDir === 'Long' && m15 > 0) || (actualDir === 'Short' && m15 < 0)) actualCorrect15m++;
        if ((dir === 'Long' && m15 > 0) || (dir === 'Short' && m15 < 0)) origCorrect15m++;
    }
    if (!isNaN(m1h) && m1h !== 0) {
        totalWith1h++;
        if ((actualDir === 'Long' && m1h > 0) || (actualDir === 'Short' && m1h < 0)) actualCorrect1h++;
        if ((dir === 'Long' && m1h > 0) || (dir === 'Short' && m1h < 0)) origCorrect1h++;
    }
}

console.log(`\n  시간대   | 건수  | 반전후 정확도 | 원래방향 정확도 | 반전 효과`);
if (totalWith5m > 0)
    console.log(`  5min    | ${totalWith5m.toString().padStart(5)} | ${(actualCorrect5m/totalWith5m*100).toFixed(1).padStart(12)}% | ${(origCorrect5m/totalWith5m*100).toFixed(1).padStart(14)}% | ${((actualCorrect5m-origCorrect5m)/totalWith5m*100).toFixed(1)}%p`);
if (totalWith15m > 0)
    console.log(`  15min   | ${totalWith15m.toString().padStart(5)} | ${(actualCorrect15m/totalWith15m*100).toFixed(1).padStart(12)}% | ${(origCorrect15m/totalWith15m*100).toFixed(1).padStart(14)}% | ${((actualCorrect15m-origCorrect15m)/totalWith15m*100).toFixed(1)}%p`);
if (totalWith1h > 0)
    console.log(`  1hr     | ${totalWith1h.toString().padStart(5)} | ${(actualCorrect1h/totalWith1h*100).toFixed(1).padStart(12)}% | ${(origCorrect1h/totalWith1h*100).toFixed(1).padStart(14)}% | ${((actualCorrect1h-origCorrect1h)/totalWith1h*100).toFixed(1)}%p`);

console.log('\n✅ 감사 완료');
