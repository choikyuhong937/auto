/**
 * Zone 계산 + DMI + 진입 트리거 데이터 검증 스크립트
 *
 * 핵심 가설:
 * 1. Long 시그널 → Zone은 Long용으로 계산 → Smart Reverse가 Short으로 뒤집음
 *    → Zone 방향 불일치 (Long PULLBACK zone에서 Short 진입 = 지지선에서 숏)
 * 2. CONTINUATION_FLOW는 현재가 근처 zone → 사실상 "즉시 진입" = zone 필터링 없음
 * 3. zoneCalculator에서 Hurst 아직 호출 중 (성능 낭비)
 */

const fs = require('fs');

// CSV 파싱
const csvPath = 'C:\\Users\\michj\\Downloads\\거래내역 통계_v2.csv.csv';
const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

console.log('=== COLUMN MAPPING ===');
const colMap = {};
headers.forEach((h, i) => { colMap[h] = i; });
// 핵심 컬럼 찾기
const keyColumns = [
    'id', 'action', 'direction', 'strategy', 'zoneType', 'regime', 'session',
    'wasReversed', 'tradeResult', 'tradePnl', 'tradePnlPercent',
    'smartReverseRule', 'smartReverseAction', 'originalDirection',
    'entryZoneType', 'leverage', 'holdingMinutes'
];
for (const col of keyColumns) {
    const idx = headers.findIndex(h => h.toLowerCase().includes(col.toLowerCase()));
    if (idx >= 0) console.log(`  ${col} → col ${idx} (${headers[idx]})`);
}

console.log('\n=== FULL HEADER LIST ===');
headers.forEach((h, i) => console.log(`  [${i}] ${h}`));

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

// ID 기반 dedup
const byId = new Map();
for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]);
    const id = vals[colMap['id']] || '';
    if (!id) continue;
    byId.set(id, vals); // 마지막 값 유지 (업데이트된 버전)
}
console.log(`\n총 행: ${lines.length - 1} → ID dedup: ${byId.size}`);

// ticker+action+30초 dedup
const finalDedup = new Map();
for (const [id, vals] of byId) {
    const ts = parseInt(vals[colMap['timestamp']] || '0');
    const ticker = vals[colMap['ticker']] || '';
    const action = vals[colMap['action']] || '';
    const key30 = `${ticker}_${action}_${Math.floor(ts / 30000)}`;

    if (!finalDedup.has(key30) || ts > parseInt(finalDedup.get(key30)[colMap['timestamp']] || '0')) {
        finalDedup.set(key30, vals);
    }
}
console.log(`30초 dedup: ${finalDedup.size}`);

const records = [...finalDedup.values()];

// ===== 분석 1: Zone Type 분포 및 성과 =====
console.log('\n' + '='.repeat(60));
console.log('=== ZONE TYPE 분포 및 성과 ===');
console.log('='.repeat(60));

const enterRecords = records.filter(r => r[colMap['action']] === 'ENTER');
const skipRecords = records.filter(r => r[colMap['action']] === 'SKIP');
const withResult = enterRecords.filter(r => r[colMap['tradeResult']]);

console.log(`\nENTER: ${enterRecords.length} | SKIP: ${skipRecords.length} | 결과있음: ${withResult.length}`);

// Zone type별 성과
const byZone = {};
for (const r of withResult) {
    const zone = r[colMap['strategy']] || r[colMap['zoneType']] || r[colMap['entryZoneType']] || 'UNKNOWN';
    const result = r[colMap['tradeResult']];
    const pnl = parseFloat(r[colMap['tradePnl']] || '0');
    const dir = r[colMap['direction']] || '';
    const reversed = r[colMap['wasReversed']] || '';
    const origDir = r[colMap['originalDirection']] || '';
    const srRule = r[colMap['smartReverseRule']] || r[colMap['smartReverseAction']] || '';

    if (!byZone[zone]) byZone[zone] = { wins: 0, losses: 0, pnl: 0, records: [] };
    if (result === 'WIN') byZone[zone].wins++;
    else byZone[zone].losses++;
    byZone[zone].pnl += pnl;
    byZone[zone].records.push({ result, pnl, dir, reversed, origDir, srRule });
}

for (const [zone, data] of Object.entries(byZone)) {
    const total = data.wins + data.losses;
    const wr = total > 0 ? (data.wins / total * 100).toFixed(1) : '-';
    console.log(`\n  ${zone}: ${total}건 (${data.wins}W/${data.losses}L) WR=${wr}% PnL=$${data.pnl.toFixed(2)}`);
    // 방향 분석
    const dirBreakdown = {};
    for (const rec of data.records) {
        const key = `${rec.dir}${rec.reversed === 'TRUE' ? '(reversed)' : ''}`;
        if (!dirBreakdown[key]) dirBreakdown[key] = { wins: 0, losses: 0, pnl: 0 };
        if (rec.result === 'WIN') dirBreakdown[key].wins++;
        else dirBreakdown[key].losses++;
        dirBreakdown[key].pnl += rec.pnl;
    }
    for (const [dirKey, dd] of Object.entries(dirBreakdown)) {
        const ddTotal = dd.wins + dd.losses;
        const ddWr = ddTotal > 0 ? (dd.wins / ddTotal * 100).toFixed(1) : '-';
        console.log(`    → ${dirKey}: ${ddTotal}건 WR=${ddWr}% PnL=$${dd.pnl.toFixed(2)}`);
    }
}

// ===== 분석 2: 방향 불일치 검사 (핵심!) =====
console.log('\n' + '='.repeat(60));
console.log('=== 방향 불일치 검사 (Zone vs Actual Direction) ===');
console.log('='.repeat(60));

let dirMismatchCount = 0;
let dirMatchCount = 0;
const mismatchDetails = [];

for (const r of enterRecords) {
    const direction = r[colMap['direction']] || '';
    const origDir = r[colMap['originalDirection']] || '';
    const reversed = r[colMap['wasReversed']] || '';
    const zone = r[colMap['strategy']] || r[colMap['entryZoneType']] || '';
    const result = r[colMap['tradeResult']] || '';
    const pnl = parseFloat(r[colMap['tradePnl']] || '0');

    // reversed=TRUE이면 Zone은 origDir로 계산됐지만 실제 direction으로 진입
    if (reversed === 'TRUE' && origDir && origDir !== direction) {
        dirMismatchCount++;
        mismatchDetails.push({
            ticker: r[colMap['ticker']], zone, origDir, actualDir: direction,
            result, pnl
        });
    } else {
        dirMatchCount++;
    }
}

console.log(`\n방향 일치: ${dirMatchCount} | 불일치(Zone≠실제방향): ${dirMismatchCount}`);
if (mismatchDetails.length > 0) {
    console.log('\n불일치 상세:');
    for (const d of mismatchDetails) {
        const emoji = d.result === 'WIN' ? '✅' : d.result === 'LOSS' ? '❌' : '⏳';
        console.log(`  ${emoji} ${d.ticker} Zone=${d.zone}(${d.origDir}용) → 실제=${d.actualDir} | ${d.result} $${d.pnl.toFixed(2)}`);
    }

    // 불일치 그룹 성과
    const mismatchWithResult = mismatchDetails.filter(d => d.result);
    const mmWins = mismatchWithResult.filter(d => d.result === 'WIN').length;
    const mmLosses = mismatchWithResult.filter(d => d.result === 'LOSS').length;
    const mmPnl = mismatchWithResult.reduce((s, d) => s + d.pnl, 0);
    if (mismatchWithResult.length > 0) {
        console.log(`\n  불일치 그룹 성과: ${mmWins}W/${mmLosses}L WR=${(mmWins/(mmWins+mmLosses)*100).toFixed(1)}% PnL=$${mmPnl.toFixed(2)}`);
    }
}

// ===== 분석 3: SKIP 이유별 분포 =====
console.log('\n' + '='.repeat(60));
console.log('=== SKIP 이유별 분포 ===');
console.log('='.repeat(60));

const skipReasons = {};
for (const r of skipRecords) {
    // skipReason 컬럼 찾기
    const reason = r[colMap['skipReason']] || r[colMap['reason']] || 'UNKNOWN';
    if (!skipReasons[reason]) skipReasons[reason] = 0;
    skipReasons[reason]++;
}
const sortedSkips = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
for (const [reason, count] of sortedSkips) {
    console.log(`  ${reason}: ${count}건 (${(count/skipRecords.length*100).toFixed(1)}%)`);
}

// ===== 분석 4: 전체 방향 분포 =====
console.log('\n' + '='.repeat(60));
console.log('=== 전체 방향 + reversed 분포 ===');
console.log('='.repeat(60));

const dirStats = {};
for (const r of enterRecords) {
    const dir = r[colMap['direction']] || 'UNK';
    const rev = r[colMap['wasReversed']] || 'FALSE';
    const origDir = r[colMap['originalDirection']] || dir;
    const key = `${origDir}→${dir} (reversed=${rev})`;
    if (!dirStats[key]) dirStats[key] = 0;
    dirStats[key]++;
}
for (const [key, count] of Object.entries(dirStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}건`);
}

// ===== 분석 5: Zone Type별 원래 방향 =====
console.log('\n' + '='.repeat(60));
console.log('=== Zone Type + Original Direction 조합 ===');
console.log('='.repeat(60));

const zoneDir = {};
for (const r of enterRecords) {
    const zone = r[colMap['strategy']] || r[colMap['entryZoneType']] || 'UNK';
    const origDir = r[colMap['originalDirection']] || r[colMap['direction']] || 'UNK';
    const actualDir = r[colMap['direction']] || 'UNK';
    const result = r[colMap['tradeResult']] || '';
    const pnl = parseFloat(r[colMap['tradePnl']] || '0');
    const key = `${zone}(${origDir}→${actualDir})`;
    if (!zoneDir[key]) zoneDir[key] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    zoneDir[key].count++;
    if (result === 'WIN') zoneDir[key].wins++;
    else if (result === 'LOSS') zoneDir[key].losses++;
    zoneDir[key].pnl += pnl;
}
for (const [key, d] of Object.entries(zoneDir).sort((a, b) => b[1].count - a[1].count)) {
    const total = d.wins + d.losses;
    const wr = total > 0 ? (d.wins / total * 100).toFixed(1) : '-';
    console.log(`  ${key}: ${d.count}건 | ${total > 0 ? `${d.wins}W/${d.losses}L WR=${wr}%` : '결과대기'} | PnL=$${d.pnl.toFixed(2)}`);
}

// ===== 분석 6: 레버리지별 성과 (Short만) =====
console.log('\n' + '='.repeat(60));
console.log('=== Short 레버리지별 성과 ===');
console.log('='.repeat(60));

const levBuckets = {};
for (const r of withResult) {
    const dir = r[colMap['direction']] || '';
    if (dir !== 'Short') continue;
    const lev = parseInt(r[colMap['leverage']] || '0');
    let bucket = lev <= 10 ? '1-10x' : lev <= 20 ? '11-20x' : lev <= 30 ? '21-30x' : lev <= 50 ? '31-50x' : '50x+';
    if (!levBuckets[bucket]) levBuckets[bucket] = { wins: 0, losses: 0, pnl: 0 };
    if (r[colMap['tradeResult']] === 'WIN') levBuckets[bucket].wins++;
    else levBuckets[bucket].losses++;
    levBuckets[bucket].pnl += parseFloat(r[colMap['tradePnl']] || '0');
}
for (const [bucket, d] of Object.entries(levBuckets).sort()) {
    const total = d.wins + d.losses;
    const wr = total > 0 ? (d.wins / total * 100).toFixed(1) : '-';
    console.log(`  ${bucket}: ${total}건 WR=${wr}% PnL=$${d.pnl.toFixed(2)}`);
}

// ===== 분석 7: Holding Time 분포 =====
console.log('\n' + '='.repeat(60));
console.log('=== 홀딩 시간별 승률 ===');
console.log('='.repeat(60));

const holdBuckets = {};
for (const r of withResult) {
    const holdMin = parseFloat(r[colMap['holdingMinutes']] || '0');
    let bucket = holdMin <= 5 ? '0-5m' : holdMin <= 15 ? '5-15m' : holdMin <= 30 ? '15-30m' : holdMin <= 60 ? '30-60m' : holdMin <= 120 ? '1-2h' : '2h+';
    if (!holdBuckets[bucket]) holdBuckets[bucket] = { wins: 0, losses: 0, pnl: 0 };
    if (r[colMap['tradeResult']] === 'WIN') holdBuckets[bucket].wins++;
    else holdBuckets[bucket].losses++;
    holdBuckets[bucket].pnl += parseFloat(r[colMap['tradePnl']] || '0');
}
for (const [bucket, d] of Object.entries(holdBuckets)) {
    const total = d.wins + d.losses;
    const wr = total > 0 ? (d.wins / total * 100).toFixed(1) : '-';
    console.log(`  ${bucket}: ${total}건 WR=${wr}% PnL=$${d.pnl.toFixed(2)}`);
}

console.log('\n' + '='.repeat(60));
console.log('=== 코드 분석에서 발견된 문제점 ===');
console.log('='.repeat(60));
console.log(`
🔴 [CRITICAL] Zone 방향 불일치 버그
   - scanSignals가 Long 감지 → Zone을 Long용으로 계산 (예: 지지선 PULLBACK)
   - Smart Reverse가 Long→Short으로 뒤집음
   - 결과: Short을 지지선에서 진입 = 방향 반대
   - 영향: 모든 Long→Short 반전 거래

🔴 [CRITICAL] CONTINUATION_FLOW = "즉시 진입" (Zone 필터링 무력화)
   - Long CF: zone = currentPrice - ATR*0.3 ~ currentPrice + ATR*0.1
   - Short CF: zone = currentPrice - ATR*0.1 ~ currentPrice + ATR*0.3
   - 가격이 zone 안에서 시작 → 모멘텀 트리거 거의 즉시 발동

🟡 [PERF] zoneCalculator.ts line 119: calculateHurstExponent(closes) 아직 호출
   - tradingEngine.ts에서 H1으로 제거했지만 zoneCalculator는 미수정
   - bundle에 들어가지만 zone 계산에서 사용 안됨 → 순수 낭비

🟡 [LOGIC] isTechnicalSignalValid = 항상 true (GoldenSet 제거 후)
   - line 3787: let isTechnicalSignalValid = true
   - line 3796: if (!isTechnicalSignalValid) → 절대 실행 안됨
   - GoldenSet veto 체크가 데드코드화 (line 3796-3810)
`);
