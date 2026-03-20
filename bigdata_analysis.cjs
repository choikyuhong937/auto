const fs = require('fs');
const path = 'C:\\Users\\michj\\Downloads\\거래내역 통계 - Decisions.csv';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n').filter(l => l.trim());

function parseLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const vals = parseLine(lines[i]);
  if (vals.length < 5) continue;
  let raw = {};
  try { raw = JSON.parse(vals[13] || '{}'); } catch(e) {}
  const market = raw.market || {};
  const decision = raw.decision || {};
  const outcome = raw.outcome || {};

  // 시간 파싱
  let hour = -1, dateStr = '';
  const ts = vals[0];
  const dm = ts.match(/(\d+)\.\s*(\d+)\.\s*(\d+)/);
  if (dm) dateStr = `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`;
  const tm = ts.match(/(\d+):(\d+):(\d+)/);
  if (tm) {
    hour = parseInt(tm[1]);
    if (ts.includes('오후') && hour !== 12) hour += 12;
    if (ts.includes('오전') && hour === 12) hour = 0;
  }

  rows.push({
    timestamp: ts, hour, dateStr,
    ticker: vals[1], action: vals[2], direction: vals[3],
    strategy: vals[4], reason: vals[5],
    confidence: parseFloat(vals[6]) || 0,
    price: parseFloat(vals[7]) || 0,
    rsi: parseFloat(vals[8]) || 0,
    atr: parseFloat(vals[9]) || 0,
    regime: vals[10], session: vals[11],
    regimeScore: market.regimeScore || 0,
    fatigueScore: market.fatigueScore || 0,
    adx: market.adx || 0,
    volumeVsAvg: market.volumeVsAvg || 0,
    bbWidth: market.bbWidth || 0,
    skipReason: decision.skipReason || '',
    movePercent: market.movePercent || 0,
    trendDirection: market.trendDirection || '',
    hurst: market.hurst || 0,
    zoneType: decision.zoneType || '',
    trendStrength: market.trendStrength || 0,
    // outcome
    tradeResult: outcome.tradeResult || '',
    tradePnl: outcome.tradePnl || 0,
    tradePnlPercent: outcome.tradePnlPercent || 0,
    holdingMinutes: outcome.holdingMinutes || 0,
    exitReason: outcome.exitReason || '',
    price5m: outcome.price5m || 0,
    price15m: outcome.price15m || 0,
    price1h: outcome.price1h || 0,
  });
}

console.log('══════════════════════════════════════════════');
console.log('  BIGDATA 분석 리포트 (' + rows.length + '건)');
console.log('══════════════════════════════════════════════\n');

// ========== 1. 기본 통계 ==========
const actions = {};
rows.forEach(r => { actions[r.action] = (actions[r.action]||0)+1; });
const enters = rows.filter(r => r.action === 'ENTER');
const skips = rows.filter(r => r.action === 'SKIP');
console.log('━━━ [1] 기본 통계 ━━━');
console.log('  총 레코드: ' + rows.length);
Object.entries(actions).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  console.log('  ' + k + ': ' + v + '건 (' + (v/rows.length*100).toFixed(1) + '%)');
});
console.log('  진입률: ' + ((enters.length)/rows.length*100).toFixed(2) + '%');
console.log('');

// ========== 2. 날짜별 분포 ==========
const dates = {};
rows.forEach(r => { if(r.dateStr) dates[r.dateStr] = (dates[r.dateStr]||0)+1; });
const dateEnters = {};
enters.forEach(r => { if(r.dateStr) dateEnters[r.dateStr] = (dateEnters[r.dateStr]||0)+1; });
console.log('━━━ [2] 날짜별 분포 ━━━');
Object.entries(dates).sort().forEach(([d,v]) => {
  const ent = dateEnters[d] || 0;
  console.log('  ' + d + ': ' + v + '건 (ENTER:' + ent + ')');
});
console.log('');

// ========== 3. 시간대별 분포 ==========
console.log('━━━ [3] 시간대별 (KST) ━━━');
const hourBuckets = {};
const hourEnters = {};
rows.forEach(r => { if(r.hour>=0) { hourBuckets[r.hour] = (hourBuckets[r.hour]||0)+1; }});
enters.forEach(r => { if(r.hour>=0) { hourEnters[r.hour] = (hourEnters[r.hour]||0)+1; }});
for (let h = 0; h < 24; h++) {
  const total = hourBuckets[h] || 0;
  const ent = hourEnters[h] || 0;
  if (total > 0) {
    const bar = '█'.repeat(Math.min(Math.round(total/rows.length*200), 40));
    console.log('  ' + String(h).padStart(2,'0') + '시: ' + String(total).padStart(5) + '건 E:' + String(ent).padStart(3) + ' ' + bar);
  }
}
console.log('');

// ========== 4. SKIP 사유 ==========
const skipR = {};
skips.forEach(r => { const k = r.skipReason || 'UNKNOWN'; skipR[k] = (skipR[k]||0)+1; });
console.log('━━━ [4] SKIP 사유 (' + skips.length + '건) ━━━');
Object.entries(skipR).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v]) => {
  const pct = (v/skips.length*100).toFixed(1);
  const bar = '█'.repeat(Math.min(Math.round(v/skips.length*50), 40));
  console.log('  ' + k.padEnd(25) + ': ' + String(v).padStart(5) + '건 (' + pct.padStart(5) + '%) ' + bar);
});
console.log('');

// ========== 5. 레짐 분포 ==========
const regimes = {};
rows.forEach(r => { regimes[r.regime] = (regimes[r.regime]||0)+1; });
console.log('━━━ [5] 레짐 분포 ━━━');
Object.entries(regimes).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  // 레짐별 진입률
  const regRows = rows.filter(r => r.regime === k);
  const regEnters = regRows.filter(r => r.action === 'ENTER').length;
  const entryRate = regRows.length > 0 ? (regEnters/regRows.length*100).toFixed(1) : '0';
  console.log('  ' + k.padEnd(25) + ': ' + String(v).padStart(5) + '건 (' + (v/rows.length*100).toFixed(1) + '%) 진입률:' + entryRate + '%');
});
console.log('');

// ========== 6. 티커별 ==========
const tickers = {};
rows.forEach(r => { tickers[r.ticker] = (tickers[r.ticker]||0)+1; });
console.log('━━━ [6] 티커별 TOP 15 ━━━');
Object.entries(tickers).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v]) => {
  const ent = rows.filter(r => r.ticker === k && r.action === 'ENTER').length;
  console.log('  ' + k.padEnd(15) + ': ' + String(v).padStart(5) + '건 ENTER:' + ent);
});
console.log('  총 티커 수: ' + Object.keys(tickers).length + '개');
console.log('');

// ========== 7. ENTER 상세 (중복 제거) ==========
const uniqueEnters = [];
const seenEnters = new Set();
enters.forEach(e => {
  const key = e.timestamp + '_' + e.ticker;
  if (!seenEnters.has(key)) {
    seenEnters.add(key);
    uniqueEnters.push(e);
  }
});
console.log('━━━ [7] ENTER 유니크 (' + uniqueEnters.length + '건, 중복제거) ━━━');
uniqueEnters.forEach(e => {
  const resultTag = e.tradeResult ? ` → ${e.tradeResult} ${e.tradePnlPercent.toFixed(2)}%` : '';
  console.log('  ' + e.dateStr + ' ' + String(e.hour).padStart(2,'0') + '시 | ' +
    e.ticker.padEnd(12) + ' ' + e.direction.padEnd(5) + ' | ' +
    e.strategy.padEnd(18) + ' | 레짐:' + e.regime.padEnd(15) + ' | RSI:' + e.rsi.toFixed(1) +
    ' ADX:' + e.adx.toFixed(0) + resultTag);
});
console.log('');

// ========== 8. 거래 결과 (outcome) ==========
const withResult = rows.filter(r => r.tradeResult);
console.log('━━━ [8] 거래 결과 ━━━');
if (withResult.length > 0) {
  const wins = withResult.filter(r => r.tradeResult === 'WIN');
  const losses = withResult.filter(r => r.tradeResult === 'LOSS');
  const be = withResult.filter(r => r.tradeResult === 'BREAKEVEN');
  console.log('  WIN: ' + wins.length + ' | LOSS: ' + losses.length + ' | BE: ' + be.length);
  console.log('  승률: ' + (wins.length/(wins.length+losses.length)*100).toFixed(1) + '%');
  const totalPnl = withResult.reduce((s,r) => s + r.tradePnl, 0);
  const avgPnlPct = withResult.reduce((s,r) => s + r.tradePnlPercent, 0) / withResult.length;
  console.log('  총 PnL: $' + totalPnl.toFixed(2));
  console.log('  평균 PnL%: ' + avgPnlPct.toFixed(3) + '%');
  console.log('  평균 보유시간: ' + (withResult.reduce((s,r) => s + r.holdingMinutes, 0) / withResult.length).toFixed(1) + '분');
  withResult.forEach(r => {
    console.log('    ' + r.ticker + ' ' + r.direction + ' → ' + r.tradeResult + ' ' + r.tradePnlPercent.toFixed(3) + '% $' + r.tradePnl.toFixed(2) + ' (' + r.holdingMinutes.toFixed(0) + '분) 사유:' + r.exitReason);
  });
} else {
  console.log('  거래 결과 데이터 없음 (outcome 미기록)');
}
console.log('');

// ========== 9. 사후 가격 추적 (5m/15m/1h) ==========
const with5m = rows.filter(r => r.price5m > 0 && r.price > 0);
console.log('━━━ [9] 사후 가격 추적 ━━━');
if (with5m.length > 0) {
  // SKIP했는데 가격이 좋아진 경우 (놓친 기회)
  const skipsWith5m = with5m.filter(r => r.action === 'SKIP');
  let missedLong = 0, missedShort = 0;
  skipsWith5m.forEach(r => {
    const move5m = (r.price5m - r.price) / r.price * 100;
    if (r.direction === 'Long' && move5m > 0.3) missedLong++;
    if (r.direction === 'Short' && move5m < -0.3) missedShort++;
  });
  console.log('  5분 후 추적 데이터: ' + with5m.length + '건');
  console.log('  SKIP 중 놓친 기회(0.3%+ 이동): Long ' + missedLong + '건, Short ' + missedShort + '건');
  console.log('  놓친 기회 비율: ' + ((missedLong+missedShort)/Math.max(skipsWith5m.length,1)*100).toFixed(1) + '%');
} else {
  console.log('  사후 가격 추적 데이터 없음');
}
console.log('');

// ========== 10. WEEKEND_DRIFT 점수 분포 ==========
const wd = rows.filter(r => r.regime === 'WEEKEND_DRIFT');
if (wd.length > 0) {
  const scores = wd.map(r => r.regimeScore);
  console.log('━━━ [10] WEEKEND_DRIFT 점수 (' + wd.length + '건) ━━━');
  [[0,40],[41,45],[46,50],[51,55],[56,60],[61,65],[66,70],[71,80],[81,100]].forEach(([lo,hi]) => {
    const cnt = scores.filter(s => s >= lo && s <= hi).length;
    const bar = '█'.repeat(Math.round(cnt/wd.length*50));
    console.log('  ' + String(lo).padStart(3) + '-' + String(hi).padEnd(3) + ': ' + String(cnt).padStart(5) + '건 ' + bar);
  });
  console.log('  평균: ' + (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1));
  console.log('  <=60 통과: ' + scores.filter(s=>s<=60).length + '건 (' + (scores.filter(s=>s<=60).length/wd.length*100).toFixed(1) + '%)');
  console.log('  <=65 통과: ' + scores.filter(s=>s<=65).length + '건 (' + (scores.filter(s=>s<=65).length/wd.length*100).toFixed(1) + '%)');
}
console.log('');

// ========== 11. RSI 분석 (SKIP vs ENTER) ==========
console.log('━━━ [11] RSI 분석 ━━━');
const skipRsi = skips.filter(r => r.rsi > 0).map(r => r.rsi);
const enterRsi = enters.filter(r => r.rsi > 0).map(r => r.rsi);
if (skipRsi.length) console.log('  SKIP 평균 RSI: ' + (skipRsi.reduce((a,b)=>a+b,0)/skipRsi.length).toFixed(1));
if (enterRsi.length) console.log('  ENTER 평균 RSI: ' + (enterRsi.reduce((a,b)=>a+b,0)/enterRsi.length).toFixed(1));

// Long/Short별 RSI 분포
const skipLongRsi = skips.filter(r => r.direction === 'Long' && r.rsi > 0).map(r => r.rsi);
const skipShortRsi = skips.filter(r => r.direction === 'Short' && r.rsi > 0).map(r => r.rsi);
if (skipLongRsi.length) {
  const good = skipLongRsi.filter(v => v < 35).length;
  console.log('  SKIP Long RSI 평균: ' + (skipLongRsi.reduce((a,b)=>a+b,0)/skipLongRsi.length).toFixed(1) + ' (RSI<35 좋은자리: ' + good + '건)');
}
if (skipShortRsi.length) {
  const good = skipShortRsi.filter(v => v > 65).length;
  console.log('  SKIP Short RSI 평균: ' + (skipShortRsi.reduce((a,b)=>a+b,0)/skipShortRsi.length).toFixed(1) + ' (RSI>65 좋은자리: ' + good + '건)');
}
console.log('');

// ========== 12. ADX & 볼륨 ==========
console.log('━━━ [12] ADX & 볼륨 ━━━');
const adxVals = rows.filter(r => r.adx > 0).map(r => r.adx);
const volVals = rows.filter(r => r.volumeVsAvg > 0).map(r => r.volumeVsAvg);
if (adxVals.length) console.log('  ADX 평균: ' + (adxVals.reduce((a,b)=>a+b,0)/adxVals.length).toFixed(1));
if (volVals.length) {
  console.log('  거래량 평균: ' + (volVals.reduce((a,b)=>a+b,0)/volVals.length).toFixed(2) + 'x');
  console.log('  <0.3x: ' + volVals.filter(v=>v<0.3).length + '건 | 0.3-0.5x: ' + volVals.filter(v=>v>=0.3&&v<0.5).length + '건 | 0.5-1x: ' + volVals.filter(v=>v>=0.5&&v<1).length + '건 | >1x: ' + volVals.filter(v=>v>=1).length + '건');
}
console.log('');

// ========== 13. 방향 분석 ==========
console.log('━━━ [13] 방향 ━━━');
const dirs = {};
rows.forEach(r => { dirs[r.direction] = (dirs[r.direction]||0)+1; });
Object.entries(dirs).forEach(([k,v]) => console.log('  ' + k + ': ' + v + '건 (' + (v/rows.length*100).toFixed(1) + '%)'));
// 방향별 ENTER
const dirEnters = {};
enters.forEach(r => { dirEnters[r.direction] = (dirEnters[r.direction]||0)+1; });
console.log('  ENTER: ' + Object.entries(dirEnters).map(([k,v]) => k+':'+v).join(' '));
console.log('');

// ========== 14. 전략별 ==========
const strategies = {};
enters.forEach(r => { strategies[r.strategy] = (strategies[r.strategy]||0)+1; });
console.log('━━━ [14] ENTER 전략 ━━━');
Object.entries(strategies).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  console.log('  ' + k + ': ' + v + '건');
});
console.log('');

// ========== 15. 피로도 분석 ==========
console.log('━━━ [15] 피로도 ━━━');
[[0,25,'낮음'],[25,50,'보통'],[50,75,'높음'],[75,101,'위험']].forEach(([lo,hi,label]) => {
  const cnt = rows.filter(r => r.fatigueScore >= lo && r.fatigueScore < hi).length;
  console.log('  ' + label.padEnd(6) + ' (' + lo + '-' + hi + '): ' + cnt + '건');
});
console.log('');

// ========== 16. AI SKIP 분석 ==========
const aiSkips = skips.filter(r => r.skipReason === 'AI_SKIP');
console.log('━━━ [16] AI SKIP 분석 (' + aiSkips.length + '건) ━━━');
if (aiSkips.length > 0) {
  const aiTickers = {};
  aiSkips.forEach(r => { aiTickers[r.ticker] = (aiTickers[r.ticker]||0)+1; });
  Object.entries(aiTickers).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
    console.log('  ' + k + ': ' + v + '건');
  });
  const aiRegimes = {};
  aiSkips.forEach(r => { aiRegimes[r.regime] = (aiRegimes[r.regime]||0)+1; });
  console.log('  레짐: ' + Object.entries(aiRegimes).map(([k,v]) => k+':'+v).join(' '));
  console.log('  RSI 평균: ' + (aiSkips.filter(r=>r.rsi>0).map(r=>r.rsi).reduce((a,b)=>a+b,0)/Math.max(aiSkips.filter(r=>r.rsi>0).length,1)).toFixed(1));
}
console.log('');

// ========== 17. GoldenSet Veto 분석 ==========
const gsVetos = skips.filter(r => r.skipReason === 'GOLDSET_VETO');
console.log('━━━ [17] GoldenSet Veto (' + gsVetos.length + '건) ━━━');
if (gsVetos.length > 0) {
  gsVetos.slice(0,10).forEach(r => {
    console.log('  ' + r.ticker + ' ' + r.direction + ' RSI:' + r.rsi.toFixed(1) + ' ADX:' + r.adx.toFixed(0) + ' regime:' + r.regime);
  });
}
console.log('');

// ========== 18. Momentum Block 분석 ==========
const momBlocks = skips.filter(r => r.skipReason === 'MOMENTUM_BLOCK');
console.log('━━━ [18] Momentum Block (' + momBlocks.length + '건) ━━━');
if (momBlocks.length > 0) {
  momBlocks.slice(0,10).forEach(r => {
    console.log('  ' + r.ticker + ' ' + r.direction + ' reason: ' + r.reason);
  });
}
console.log('');

// ========== 19. 세션별 ==========
const sessions = {};
rows.forEach(r => { sessions[r.session] = (sessions[r.session]||0)+1; });
console.log('━━━ [19] 세션 ━━━');
Object.entries(sessions).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  const sEnters = rows.filter(r => r.session === k && r.action === 'ENTER').length;
  console.log('  ' + k.padEnd(12) + ': ' + v + '건 (ENTER:' + sEnters + ')');
});
console.log('');

// ========== 20. 현재 수집 데이터 품질 점검 ==========
console.log('━━━ [20] 데이터 품질 점검 ━━━');
const hasOutcome = rows.filter(r => r.tradeResult || r.price5m > 0).length;
const hasRsi = rows.filter(r => r.rsi > 0).length;
const hasAdx = rows.filter(r => r.adx > 0).length;
const hasVol = rows.filter(r => r.volumeVsAvg > 0).length;
console.log('  outcome(거래결과): ' + hasOutcome + '/' + rows.length + ' (' + (hasOutcome/rows.length*100).toFixed(1) + '%)');
console.log('  RSI: ' + hasRsi + '/' + rows.length + ' (' + (hasRsi/rows.length*100).toFixed(1) + '%)');
console.log('  ADX: ' + hasAdx + '/' + rows.length + ' (' + (hasAdx/rows.length*100).toFixed(1) + '%)');
console.log('  거래량: ' + hasVol + '/' + rows.length + ' (' + (hasVol/rows.length*100).toFixed(1) + '%)');
console.log('  5분후가격: ' + rows.filter(r => r.price5m > 0).length + '건');
console.log('  15분후가격: ' + rows.filter(r => r.price15m > 0).length + '건');
console.log('  1시간후가격: ' + rows.filter(r => r.price1h > 0).length + '건');
