/**
 * Smart Reverse 절차 정밀 감사
 * - 실제 거래 데이터 기반으로 리버스의 효과 분석
 * - 각 규칙별 승률/손익 추적
 * - "리버스 없었으면?" 시뮬레이션
 */

const fs = require('fs');

const raw = fs.readFileSync('C:\\Users\\michj\\Downloads\\거래내역 통계_v2.csv.csv', 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const header = lines[0].split(',');

console.log('=== COLUMN INDEX MAP ===');
const colMap = {};
header.forEach((h, i) => { colMap[h.trim()] = i; });
// 핵심 컬럼 출력
['action','direction','strategy','skipReason','wasReversed','tradeResult','tradePnl',
 'rsi','adx','regime','session','confidence','maxFavorableExcursion','maxAdverseExcursion',
 'exitReason','holdingMinutes','leverage','hurst','zoneType','smartReverseRule',
 'originalDirection','effectiveDirection','smartReverseAction'].forEach(c => {
    const idx = Object.keys(colMap).find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (idx) console.log(`  ${idx} → col ${colMap[idx]}`);
});

// 모든 컬럼명 출력
console.log('\n=== ALL COLUMNS ===');
header.forEach((h, i) => console.log(`  [${i}] ${h.trim()}`));

// 파싱
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
console.log(`\nTotal rows: ${rows.length}`);

// 컬럼 인덱스 찾기
function ci(name) {
    const exact = colMap[name];
    if (exact !== undefined) return exact;
    const key = Object.keys(colMap).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? colMap[key] : -1;
}

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
const iTimestamp = ci('timestamp');
const iConf = ci('confidence');

console.log(`\nKey indices: action=${iAction}, dir=${iDir}, strategy=${iStrategy}, reversed=${iReversed}, result=${iResult}, pnl=${iPnl}`);

// 중복 제거 (ticker + timestamp 60초 이내)
const deduped = [];
const seenKeys = new Map();
for (const r of rows) {
    const ticker = r[iTicker] || '';
    const ts = parseInt(r[iTimestamp]) || 0;
    const key = `${ticker}_${Math.floor(ts / 60000)}`;
    if (!seenKeys.has(key)) {
        seenKeys.set(key, true);
        deduped.push(r);
    }
}
console.log(`Deduplicated: ${deduped.length} records`);

// ENTER만 필터
const enters = deduped.filter(r => (r[iAction] || '').toUpperCase() === 'ENTER');
const skips = deduped.filter(r => (r[iAction] || '').toUpperCase() === 'SKIP');
console.log(`ENTER: ${enters.length}, SKIP: ${skips.length}`);

// ENTER 중 실제 거래 결과 있는 것
const tradesWithResult = enters.filter(r => r[iResult] && r[iResult] !== '');
console.log(`ENTER with tradeResult: ${tradesWithResult.length}`);

// ===============================================================
// PART 1: 방향 분포
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 1: 방향 분포 (ENTER)');
console.log('='.repeat(70));

const dirCount = {};
for (const r of enters) {
    const d = r[iDir] || 'UNKNOWN';
    dirCount[d] = (dirCount[d] || 0) + 1;
}
Object.entries(dirCount).sort((a,b) => b[1]-a[1]).forEach(([d, c]) => {
    console.log(`  ${d}: ${c} (${(c/enters.length*100).toFixed(1)}%)`);
});

// ===============================================================
// PART 2: wasReversed 분포
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 2: wasReversed 분포 (ENTER)');
console.log('='.repeat(70));

const revCount = {};
for (const r of enters) {
    const rev = r[iReversed] || 'EMPTY';
    revCount[rev] = (revCount[rev] || 0) + 1;
}
Object.entries(revCount).forEach(([r, c]) => {
    console.log(`  wasReversed=${r}: ${c} (${(c/enters.length*100).toFixed(1)}%)`);
});

// ===============================================================
// PART 3: 실제 거래 — 방향 × 리버스 × 승률
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 3: 실제 거래 — 방향 × 리버스 × 결과');
console.log('='.repeat(70));

const combos = {};
for (const r of tradesWithResult) {
    const dir = r[iDir] || '?';
    const rev = r[iReversed] || '?';
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    const key = `${dir}|rev=${rev}`;
    if (!combos[key]) combos[key] = { total: 0, wins: 0, losses: 0, totalPnl: 0, pnls: [] };
    combos[key].total++;
    if (result === 'WIN') combos[key].wins++;
    else combos[key].losses++;
    combos[key].totalPnl += pnl;
    combos[key].pnls.push(pnl);
}

Object.entries(combos).sort((a,b) => b[1].total - a[1].total).forEach(([key, v]) => {
    const wr = v.total > 0 ? (v.wins / v.total * 100).toFixed(1) : '0';
    const avg = v.total > 0 ? (v.totalPnl / v.total).toFixed(2) : '0';
    console.log(`  ${key}: ${v.total}건 | WR ${wr}% | W${v.wins}/L${v.losses} | 총PnL $${v.totalPnl.toFixed(2)} | 평균 $${avg}`);
});

// ===============================================================
// PART 4: 전략별 × 방향 × 결과
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 4: 전략(Strategy) × 방향 × 결과');
console.log('='.repeat(70));

const stratCombos = {};
for (const r of tradesWithResult) {
    const dir = r[iDir] || '?';
    const strat = r[iStrategy] || '?';
    const rev = r[iReversed] || '?';
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    const key = `${strat}|${dir}|rev=${rev}`;
    if (!stratCombos[key]) stratCombos[key] = { total: 0, wins: 0, totalPnl: 0 };
    stratCombos[key].total++;
    if (result === 'WIN') stratCombos[key].wins++;
    stratCombos[key].totalPnl += pnl;
}

Object.entries(stratCombos).sort((a,b) => b[1].total - a[1].total).forEach(([key, v]) => {
    const wr = v.total > 0 ? (v.wins / v.total * 100).toFixed(1) : '0';
    console.log(`  ${key}: ${v.total}건 | WR ${wr}% | PnL $${v.totalPnl.toFixed(2)}`);
});

// ===============================================================
// PART 5: 세션 × 리버스 × 결과
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 5: 세션 × 리버스 × 결과');
console.log('='.repeat(70));

const sessCombos = {};
for (const r of tradesWithResult) {
    const sess = r[iSession] || '?';
    const rev = r[iReversed] || '?';
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    const key = `${sess}|rev=${rev}`;
    if (!sessCombos[key]) sessCombos[key] = { total: 0, wins: 0, totalPnl: 0 };
    sessCombos[key].total++;
    if (result === 'WIN') sessCombos[key].wins++;
    sessCombos[key].totalPnl += pnl;
}

Object.entries(sessCombos).sort((a,b) => b[1].total - a[1].total).forEach(([key, v]) => {
    const wr = v.total > 0 ? (v.wins / v.total * 100).toFixed(1) : '0';
    console.log(`  ${key}: ${v.total}건 | WR ${wr}% | PnL $${v.totalPnl.toFixed(2)}`);
});

// ===============================================================
// PART 6: 레짐 × 리버스 × 결과
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 6: 레짐 × 결과');
console.log('='.repeat(70));

const regCombos = {};
for (const r of tradesWithResult) {
    const regime = r[iRegime] || '?';
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    if (!regCombos[regime]) regCombos[regime] = { total: 0, wins: 0, totalPnl: 0 };
    regCombos[regime].total++;
    if (result === 'WIN') regCombos[regime].wins++;
    regCombos[regime].totalPnl += pnl;
}

Object.entries(regCombos).sort((a,b) => b[1].total - a[1].total).forEach(([key, v]) => {
    const wr = v.total > 0 ? (v.wins / v.total * 100).toFixed(1) : '0';
    console.log(`  ${key}: ${v.total}건 | WR ${wr}% | PnL $${v.totalPnl.toFixed(2)}`);
});

// ===============================================================
// PART 7: MFE/MAE 분석 — 방향이 맞았나?
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 7: MFE vs MAE — 방향 정확도');
console.log('='.repeat(70));

let mfeTotal = 0, maeTotal = 0, mfeCount = 0;
const mfeMaeByDir = {};
for (const r of tradesWithResult) {
    const mfe = parseFloat(r[iMfe]) || 0;
    const mae = parseFloat(r[iMae]) || 0;
    if (mfe === 0 && mae === 0) continue;

    const dir = r[iDir] || '?';
    const rev = r[iReversed] || '?';
    const key = `${dir}|rev=${rev}`;
    if (!mfeMaeByDir[key]) mfeMaeByDir[key] = { mfeSum: 0, maeSum: 0, count: 0, dirCorrect: 0 };
    mfeMaeByDir[key].mfeSum += mfe;
    mfeMaeByDir[key].maeSum += mae;
    mfeMaeByDir[key].count++;
    if (mfe > mae) mfeMaeByDir[key].dirCorrect++;

    mfeTotal += mfe;
    maeTotal += mae;
    mfeCount++;
    if (mfe > mae) /* direction was correct */;
}

if (mfeCount > 0) {
    console.log(`  전체: avgMFE=${(mfeTotal/mfeCount).toFixed(4)}, avgMAE=${(maeTotal/mfeCount).toFixed(4)}`);
    console.log(`  MFE>MAE (방향 맞음): ${Object.values(mfeMaeByDir).reduce((s,v)=>s+v.dirCorrect,0)}/${mfeCount} = ${(Object.values(mfeMaeByDir).reduce((s,v)=>s+v.dirCorrect,0)/mfeCount*100).toFixed(1)}%`);

    Object.entries(mfeMaeByDir).forEach(([key, v]) => {
        const avgMfe = (v.mfeSum / v.count).toFixed(4);
        const avgMae = (v.maeSum / v.count).toFixed(4);
        const dirPct = (v.dirCorrect / v.count * 100).toFixed(1);
        console.log(`  ${key}: ${v.count}건 | avgMFE=${avgMfe} | avgMAE=${avgMae} | 방향정확=${dirPct}%`);
    });
}

// ===============================================================
// PART 8: Exit Reason 분석
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 8: Exit Reason 분석');
console.log('='.repeat(70));

const exitCombos = {};
for (const r of tradesWithResult) {
    const exit = r[iExit] || 'UNKNOWN';
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    if (!exitCombos[exit]) exitCombos[exit] = { total: 0, wins: 0, totalPnl: 0 };
    exitCombos[exit].total++;
    if (result === 'WIN') exitCombos[exit].wins++;
    exitCombos[exit].totalPnl += pnl;
}

Object.entries(exitCombos).sort((a,b) => b[1].total - a[1].total).forEach(([key, v]) => {
    const wr = v.total > 0 ? (v.wins / v.total * 100).toFixed(1) : '0';
    console.log(`  ${key}: ${v.total}건 | WR ${wr}% | PnL $${v.totalPnl.toFixed(2)}`);
});

// ===============================================================
// PART 9: 홀딩 시간 × 결과
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 9: 홀딩 시간 × 결과');
console.log('='.repeat(70));

const holdBuckets = { '0-5min': {w:0,l:0,pnl:0}, '5-15min': {w:0,l:0,pnl:0}, '15-30min': {w:0,l:0,pnl:0},
                      '30-60min': {w:0,l:0,pnl:0}, '60-120min': {w:0,l:0,pnl:0}, '120min+': {w:0,l:0,pnl:0} };
for (const r of tradesWithResult) {
    const hold = parseFloat(r[iHold]) || 0;
    const result = r[iResult] || '?';
    const pnl = parseFloat(r[iPnl]) || 0;
    let bucket;
    if (hold <= 5) bucket = '0-5min';
    else if (hold <= 15) bucket = '5-15min';
    else if (hold <= 30) bucket = '15-30min';
    else if (hold <= 60) bucket = '30-60min';
    else if (hold <= 120) bucket = '60-120min';
    else bucket = '120min+';
    if (result === 'WIN') holdBuckets[bucket].w++;
    else holdBuckets[bucket].l++;
    holdBuckets[bucket].pnl += pnl;
}

Object.entries(holdBuckets).forEach(([bucket, v]) => {
    const total = v.w + v.l;
    if (total === 0) return;
    const wr = (v.w / total * 100).toFixed(1);
    console.log(`  ${bucket}: ${total}건 | WR ${wr}% | PnL $${v.pnl.toFixed(2)}`);
});

// ===============================================================
// PART 10: SKIP 분석 — 차단된 것 중 수익가능했던 것
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 10: SKIP MFE 분석 — 차단했지만 방향은 맞았나?');
console.log('='.repeat(70));

const skipMfe = {};
for (const r of skips) {
    const skip = r[iSkip] || 'UNKNOWN';
    const mfe = parseFloat(r[iMfe]) || 0;
    const mae = parseFloat(r[iMae]) || 0;
    if (mfe === 0 && mae === 0) continue;
    if (!skipMfe[skip]) skipMfe[skip] = { count: 0, mfeSum: 0, maeSum: 0, dirCorrect: 0 };
    skipMfe[skip].count++;
    skipMfe[skip].mfeSum += mfe;
    skipMfe[skip].maeSum += mae;
    if (mfe > mae) skipMfe[skip].dirCorrect++;
}

Object.entries(skipMfe).sort((a,b) => b[1].count - a[1].count).forEach(([skip, v]) => {
    const avgMfe = (v.mfeSum / v.count).toFixed(4);
    const avgMae = (v.maeSum / v.count).toFixed(4);
    const dirPct = (v.dirCorrect / v.count * 100).toFixed(1);
    console.log(`  ${skip}: ${v.count}건 | avgMFE=${avgMfe} | avgMAE=${avgMae} | 방향맞음=${dirPct}%`);
});

// ===============================================================
// PART 11: Smart Reverse 규칙 효과 시뮬레이션
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 11: Smart Reverse 방향 전환 파이프라인 점검');
console.log('='.repeat(70));

// 실제 거래에서 direction=Long (원래방향) + wasReversed=TRUE 인 것들
// 이들은 실제로 Short으로 진입됨
const reversedLongs = tradesWithResult.filter(r => r[iDir] === 'Long' && r[iReversed] === 'TRUE');
const keptShorts = tradesWithResult.filter(r => r[iDir] === 'Short' && r[iReversed] !== 'TRUE');
const keptLongs = tradesWithResult.filter(r => r[iDir] === 'Long' && r[iReversed] !== 'TRUE');

console.log(`\n  반전된 Long→Short: ${reversedLongs.length}건`);
if (reversedLongs.length > 0) {
    const wins = reversedLongs.filter(r => r[iResult] === 'WIN').length;
    const totalPnl = reversedLongs.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);
    console.log(`    WR: ${(wins/reversedLongs.length*100).toFixed(1)}% | PnL: $${totalPnl.toFixed(2)}`);
}

console.log(`  유지된 Short: ${keptShorts.length}건`);
if (keptShorts.length > 0) {
    const wins = keptShorts.filter(r => r[iResult] === 'WIN').length;
    const totalPnl = keptShorts.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);
    console.log(`    WR: ${(wins/keptShorts.length*100).toFixed(1)}% | PnL: $${totalPnl.toFixed(2)}`);
}

console.log(`  유지된 Long (리버스 안됨): ${keptLongs.length}건`);
if (keptLongs.length > 0) {
    const wins = keptLongs.filter(r => r[iResult] === 'WIN').length;
    const totalPnl = keptLongs.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);
    console.log(`    WR: ${(wins/keptLongs.length*100).toFixed(1)}% | PnL: $${totalPnl.toFixed(2)}`);
}

// ===============================================================
// PART 12: "리버스 없었으면?" 가상 분석
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 12: "리버스 없었으면?" — MFE/MAE로 역방향 시뮬레이션');
console.log('='.repeat(70));
console.log('  반전된 Long→Short 거래에서 원래 Long으로 갔으면:');
console.log('  (현재: Short으로 진입 → MFE=Short 수익방향, MAE=Short 손실방향)');
console.log('  (원래 Long이면 → MAE가 수익방향, MFE가 손실방향이 됨 = 역전)');

let reverseSimCount = 0, reverseSimWouldWin = 0;
for (const r of reversedLongs) {
    const mfe = parseFloat(r[iMfe]) || 0;
    const mae = parseFloat(r[iMae]) || 0;
    if (mfe === 0 && mae === 0) continue;
    reverseSimCount++;
    // 현재 Short 기준 MFE/MAE → Long이었으면 MAE가 수익(가격 상승=Long 수익, Short 손실)
    if (mae > mfe) reverseSimWouldWin++;
}

if (reverseSimCount > 0) {
    console.log(`  총 ${reverseSimCount}건 분석 가능`);
    console.log(`  Long이었으면 방향 맞았을 것: ${reverseSimWouldWin}/${reverseSimCount} = ${(reverseSimWouldWin/reverseSimCount*100).toFixed(1)}%`);
    console.log(`  Short(현재): 방향 맞았을 것: ${reverseSimCount-reverseSimWouldWin}/${reverseSimCount} = ${((reverseSimCount-reverseSimWouldWin)/reverseSimCount*100).toFixed(1)}%`);
} else {
    console.log('  MFE/MAE 데이터 없음');
}

// ===============================================================
// PART 13: 리버스 파이프라인 내 중복/불필요 절차 식별
// ===============================================================
console.log('\n' + '='.repeat(70));
console.log('PART 13: 리버스 파이프라인 절차 점검');
console.log('='.repeat(70));

console.log(`
[현재 리버스 파이프라인 — 9개 절차]

1. scanSignals: 레짐 기반 auto-reverse 태깅 (TREND_EXHAUSTION/RANGE에서 방향 반전)
   → isAutoReversed 플래그 + [AUTO-REVERSE] 태그

2. momentumGate (line 4383): Smart Reverse ON + Long → Short 방향으로 모멘텀 체크
   ⚠️ 문제: 스캔이 Long 감지 → Long 모멘텀 있음 → 하지만 Short 모멘텀 테스트 → 모멘텀 없으면 차단
   → 좋은 Long 진입을 차단할 수 있음

3. AI Validation (line 4421): Smart Reverse ON + Long → Short 방향으로 AI 검증
   ⚠️ 문제: 동일 — Short 근거 부족 시 좋은 Long 진입 차단

4. evaluateSmartReverse(): 9개 우선순위 규칙 순회
   Rule 1: OVERLAP_ASIA_EU → REVERSE (전세션 반전)
   Rule 2: ALL Long → REVERSE (무조건 Short) ← 핵심 규칙
   Rules 3-8: Short 유지 (각종 조건)
   Rule 9: DEFAULT KEEP

5. REVERSE/BLOCK/KEEP 분기:
   - REVERSE → effectiveDirection 전환
   - BLOCK → 진입 취소
   - KEEP → SL 조정만

6. Manual Reverse (isReverseTradingActive): Smart Reverse OFF일 때만 동작
   → Smart Reverse ON이면 영향 없음 (사실상 비활성)

7. FINAL GUARD (line 7400): Smart Reverse ON + Long → 강제 Short
   → Rule 2와 100% 중복 (벨트+멜빵)

8. BTC Trend Short Adjustment: Short일 때 BTC 상승 → 포지션 50% 축소

9. Funding Rate Short Adjustment: Short일 때 FR에 따라 포지션 조정
`);

// 실제 데이터 기반 판단
console.log('\n=== 데이터 기반 판단 ===');

const totalTrades = tradesWithResult.length;
const totalWins = tradesWithResult.filter(r => r[iResult] === 'WIN').length;
const totalPnl = tradesWithResult.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);

console.log(`전체 실거래: ${totalTrades}건, WR: ${(totalWins/totalTrades*100).toFixed(1)}%, PnL: $${totalPnl.toFixed(2)}`);
console.log(`  → 현재 100% Short (Smart Reverse Rule 2)`);

// 어떤 smartReverseRule 관련 컬럼이 있는지 추가 검색
const possibleRevCols = header.filter(h => h.toLowerCase().includes('smart') || h.toLowerCase().includes('reverse') || h.toLowerCase().includes('rule'));
console.log(`\nSmartReverse 관련 컬럼: ${possibleRevCols.join(', ') || '없음'}`);

// 원래 방향이 Short인 거래만
const origShort = tradesWithResult.filter(r => r[iDir] === 'Short');
const origLong = tradesWithResult.filter(r => r[iDir] === 'Long');
console.log(`\n원래 방향 Long: ${origLong.length}건 (→ 모두 Short으로 반전됨)`);
console.log(`원래 방향 Short: ${origShort.length}건 (→ Short 유지)`);

if (origShort.length > 0) {
    const sWins = origShort.filter(r => r[iResult] === 'WIN').length;
    const sPnl = origShort.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);
    console.log(`  → Short 유지 WR: ${(sWins/origShort.length*100).toFixed(1)}%, PnL: $${sPnl.toFixed(2)}`);
}
if (origLong.length > 0) {
    const lWins = origLong.filter(r => r[iResult] === 'WIN').length;
    const lPnl = origLong.reduce((s, r) => s + (parseFloat(r[iPnl]) || 0), 0);
    console.log(`  → Long→Short 반전 WR: ${(lWins/origLong.length*100).toFixed(1)}%, PnL: $${lPnl.toFixed(2)}`);
}

console.log('\n=== 리버스 절차 최적화 권고 ===');
console.log(`
1. Rule 1 (OVERLAP_ASIA_EU → REVERSE): G4에서 이미 Size×0.50/TP×0.70/SL×0.80/홀딩30분으로 제한
   → 리버스 대신 이미 충분히 보수적 → 중복 가능성

2. Rule 2 (ALL Long → REVERSE): 모든 스캔 최적화 후에도 100% 반전 필요한지?
   → 스캔 정확도가 개선되었으면 원래 방향이 맞을 수 있음

3. momentumGate 방향 플립 (line 4383): Short 모멘텀 체크 → 불일치 가능
   → 모멘텀은 원래 방향으로 체크하는 게 논리적

4. AI Validation 방향 플립 (line 4421): 동일 문제

5. FINAL GUARD (line 7400): Rule 2와 100% 중복 → 제거 가능
   (Rule 2가 작동하면 Long이 올 수 없음)

6. Post-SL Reverse (line 6757): 독립적 메커니즘, Smart Reverse와 무관 → 유지
`);

console.log('\n✅ 감사 완료');
