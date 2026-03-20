const fs = require('fs');
const path = 'C:\\Users\\michj\\Downloads\\거래내역 통계_v2.csv.csv';
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

const headers = parseLine(lines[0]);
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const vals = parseLine(lines[i]);
  if (vals.length < 10) continue;
  const obj = {};
  headers.forEach((h, idx) => { obj[h.trim()] = vals[idx] || ''; });
  rows.push(obj);
}

console.log('총 레코드:', rows.length);
console.log('헤더:', headers.join(' | '));

// ===== Parse fields =====
const parsed = rows.map(r => ({
  id: r.id,
  ticker: r.ticker,
  action: r.action,
  direction: r.direction,
  strategy: r.strategy,
  reason: r.reason,
  skipReason: r.skipReason,
  confidence: parseFloat(r.confidence) || 0,
  price: parseFloat(r.price) || 0,
  rsi: parseFloat(r.rsi) || 0,
  adx: parseFloat(r.adx) || 0,
  atrPercent: parseFloat(r.atrPercent) || 0,
  hurst: parseFloat(r.hurst) || 0,
  regime: r.regime,
  regimeScore: parseFloat(r.regimeScore) || 0,
  fatigueScore: parseFloat(r.fatigueScore) || 0,
  session: r.session,
  zoneType: r.zoneType,
  entryPrice: parseFloat(r.entryPrice) || 0,
  tp: parseFloat(r.tp) || 0,
  sl: parseFloat(r.sl) || 0,
  tpPercent: parseFloat(r.tpPercent) || 0,
  slPercent: parseFloat(r.slPercent) || 0,
  leverage: parseFloat(r.leverage) || 0,
  positionSizePercent: parseFloat(r.positionSizePercent) || 0,
  wasReversed: r.wasReversed === 'TRUE',
  tradeStyle: r.tradeStyle,
  tradeResult: r.tradeResult,
  tradePnl: parseFloat(r.tradePnl) || 0,
  tradePnlPercent: parseFloat(r.tradePnlPercent) || 0,
  holdingMinutes: parseFloat(r.holdingMinutes) || 0,
  exitReason: r.exitReason,
  moveAfter5min: parseFloat(r.moveAfter5min) || 0,
  moveAfter15min: parseFloat(r.moveAfter15min) || 0,
  moveAfter1hr: parseFloat(r.moveAfter1hr) || 0,
  maxFavorableExcursion: parseFloat(r.maxFavorableExcursion) || 0,
  maxAdverseExcursion: parseFloat(r.maxAdverseExcursion) || 0,
  fundingRate: parseFloat(r.fundingRateAtEntry) || 0,
  orderbookImbalance: parseFloat(r.orderbookImbalanceAtEntry) || 0,
  primaryTimeframe: r.primaryTimeframe,
  goal: r.goal,
}));

// Dedup by id (keep last)
const deduped = new Map();
parsed.forEach(r => { if (r.id) deduped.set(r.id, r); });
const data = Array.from(deduped.values());

console.log('중복 제거 후:', data.length, '건\n');

const enters = data.filter(r => r.action === 'ENTER');
const skips = data.filter(r => r.action === 'SKIP');
const withResult = enters.filter(r => r.tradeResult === 'WIN' || r.tradeResult === 'LOSS');

console.log('ENTER:', enters.length, '건 | SKIP:', skips.length, '건 | 결과있음:', withResult.length, '건\n');

// ===== Helper =====
function analyze(label, items) {
  if (items.length === 0) return { label, count: 0, wins: 0, losses: 0, wr: 0, avgPnl: 0, totalPnl: 0 };
  const wins = items.filter(r => r.tradeResult === 'WIN').length;
  const losses = items.filter(r => r.tradeResult === 'LOSS').length;
  const total = wins + losses;
  const wr = total > 0 ? (wins / total * 100) : 0;
  const avgPnl = items.reduce((s, r) => s + r.tradePnl, 0) / Math.max(items.length, 1);
  const totalPnl = items.reduce((s, r) => s + r.tradePnl, 0);
  return { label, count: items.length, wins, losses, wr: wr.toFixed(1), avgPnl: avgPnl.toFixed(3), totalPnl: totalPnl.toFixed(2) };
}

function printTable(rows) {
  rows.filter(r => r.count > 0).forEach(r => {
    console.log(`  ${r.label.padEnd(25)} ${String(r.count).padStart(5)}건 W:${String(r.wins).padStart(3)} L:${String(r.losses).padStart(3)} WR:${String(r.wr+'').padStart(6)}% avg$:${String(r.avgPnl+'').padStart(8)} tot$:${String(r.totalPnl+'').padStart(10)}`);
  });
}

// ========== 1. 전략별 성과 ==========
console.log('══════════════════════════════════════════════');
console.log('  [1] 전략별 성과 (ENTER+결과)');
console.log('══════════════════════════════════════════════');
const strategies = [...new Set(withResult.map(r => r.strategy))];
const stratResults = strategies.map(s => analyze(s, withResult.filter(r => r.strategy === s)));
stratResults.sort((a, b) => parseFloat(b.totalPnl) - parseFloat(a.totalPnl));
printTable(stratResults);

// ========== 2. 존 타입별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [2] 존 타입별 성과');
console.log('══════════════════════════════════════════════');
const zoneTypes = [...new Set(withResult.filter(r => r.zoneType).map(r => r.zoneType))];
const zoneResults = zoneTypes.map(z => analyze(z, withResult.filter(r => r.zoneType === z)));
zoneResults.sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));
printTable(zoneResults);

// ========== 3. 레짐별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [3] 레짐별 성과');
console.log('══════════════════════════════════════════════');
const regimes = [...new Set(withResult.filter(r => r.regime).map(r => r.regime))];
const regimeResults = regimes.map(reg => analyze(reg, withResult.filter(r => r.regime === reg)));
regimeResults.sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));
printTable(regimeResults);

// ========== 4. 세션별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [4] 세션별 성과');
console.log('══════════════════════════════════════════════');
const sessions = [...new Set(withResult.filter(r => r.session).map(r => r.session))];
const sessResults = sessions.map(s => analyze(s, withResult.filter(r => r.session === s)));
sessResults.sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));
printTable(sessResults);

// ========== 5. GoldenSet 관련: wasReversed 분석 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [5] SmartReverse (wasReversed) 성과');
console.log('══════════════════════════════════════════════');
printTable([
  analyze('wasReversed=TRUE', withResult.filter(r => r.wasReversed)),
  analyze('wasReversed=FALSE', withResult.filter(r => !r.wasReversed)),
]);

// ========== 6. 레버리지 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [6] 레버리지 구간별 성과');
console.log('══════════════════════════════════════════════');
const levBuckets = [[1,10,'1-10x'],[11,20,'11-20x'],[21,30,'21-30x'],[31,50,'31-50x'],[51,200,'51x+']];
const levResults = levBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.leverage >= lo && r.leverage <= hi)));
printTable(levResults);

// ========== 7. RSI 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [7] RSI 구간별 성과');
console.log('══════════════════════════════════════════════');
const rsiBuckets = [[0,30,'0-30 (과매도)'],[30,40,'30-40'],[40,50,'40-50'],[50,60,'50-60'],[60,70,'60-70'],[70,100,'70-100 (과매수)']];
const rsiResults = rsiBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.rsi >= lo && r.rsi < hi)));
printTable(rsiResults);

// ========== 8. ADX 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [8] ADX 구간별 성과');
console.log('══════════════════════════════════════════════');
const adxBuckets = [[0,15,'0-15 (약)'],[15,25,'15-25 (보통)'],[25,35,'25-35 (강)'],[35,50,'35-50 (매우강)'],[50,100,'50+ (극강)']];
const adxResults = adxBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.adx >= lo && r.adx < hi)));
printTable(adxResults);

// ========== 9. Fatigue 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [9] Fatigue 구간별 성과');
console.log('══════════════════════════════════════════════');
const fatBuckets = [[0,25,'0-25 (낮음)'],[25,50,'25-50 (보통)'],[50,75,'50-75 (높음)'],[75,101,'75+ (위험)']];
const fatResults = fatBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.fatigueScore >= lo && r.fatigueScore < hi)));
printTable(fatResults);

// ========== 10. ATR% 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [10] ATR% 구간별 성과');
console.log('══════════════════════════════════════════════');
const atrBuckets = [[0,0.01,'0-1% (낮음)'],[0.01,0.02,'1-2%'],[0.02,0.03,'2-3%'],[0.03,0.05,'3-5% (위험)'],[0.05,1,'5%+ (극위험)']];
const atrResults = atrBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.atrPercent >= lo && r.atrPercent < hi)));
printTable(atrResults);

// ========== 11. Hurst 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [11] Hurst 구간별 성과');
console.log('══════════════════════════════════════════════');
const hurstBuckets = [[0,0.4,'<0.4 (반전)'],[0.4,0.5,'0.4-0.5 (랜덤)'],[0.5,0.6,'0.5-0.6 (약추세)'],[0.6,1.01,'0.6+ (강추세)']];
const hurstResults = hurstBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.hurst >= lo && r.hurst < hi)));
printTable(hurstResults);

// ========== 12. Confidence 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [12] Confidence 구간별 성과');
console.log('══════════════════════════════════════════════');
const confBuckets = [[0,30,'0-30 (낮음)'],[30,50,'30-50'],[50,70,'50-70'],[70,100,'70-100 (높음)']];
const confResults = confBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.confidence >= lo && r.confidence < hi)));
printTable(confResults);

// ========== 13. SKIP 사유 TOP + 사후 이동 분석 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [13] SKIP 사유 + 사후 이동 (놓친 기회?)');
console.log('══════════════════════════════════════════════');
const skipReasons = {};
skips.forEach(r => { const k = r.skipReason || r.reason?.slice(0,30) || 'UNKNOWN'; skipReasons[k] = (skipReasons[k]||[]); skipReasons[k].push(r); });
Object.entries(skipReasons).sort((a,b) => b[1].length - a[1].length).slice(0,15).forEach(([reason, items]) => {
  const with5m = items.filter(r => r.moveAfter5min !== 0);
  const avgMove5m = with5m.length > 0 ? (with5m.reduce((s,r) => s + r.moveAfter5min, 0) / with5m.length) : 0;
  // Short 관점: 가격 하락이 수익
  const wouldWinShort = with5m.filter(r => r.moveAfter5min < -0.3).length;
  console.log(`  ${reason.padEnd(30)} ${String(items.length).padStart(4)}건 | 5min평균이동:${avgMove5m.toFixed(3)}% | Short수익가능:${wouldWinShort}건`);
});

// ========== 14. 방향별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [14] 방향별 성과');
console.log('══════════════════════════════════════════════');
printTable([
  analyze('Long', withResult.filter(r => r.direction === 'Long')),
  analyze('Short', withResult.filter(r => r.direction === 'Short')),
]);

// ========== 15. 보유시간 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [15] 보유시간 구간별 성과');
console.log('══════════════════════════════════════════════');
const holdBuckets = [[0,5,'0-5분'],[5,15,'5-15분'],[15,30,'15-30분'],[30,60,'30-60분'],[60,180,'1-3시간'],[180,9999,'3시간+']];
const holdResults = holdBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.holdingMinutes >= lo && r.holdingMinutes < hi)));
printTable(holdResults);

// ========== 16. TP/SL 비율 구간별 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [16] TP% 구간별 성과');
console.log('══════════════════════════════════════════════');
const tpBuckets = [[0,1,'0-1%'],[1,2,'1-2%'],[2,3,'2-3%'],[3,5,'3-5%'],[5,100,'5%+']];
const tpResults = tpBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.tpPercent >= lo && r.tpPercent < hi)));
printTable(tpResults);

// ========== 17. Exit Reason 분석 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [17] Exit Reason 분석');
console.log('══════════════════════════════════════════════');
const exitReasons = [...new Set(withResult.map(r => r.exitReason))];
const exitResults = exitReasons.map(e => analyze(e || 'UNKNOWN', withResult.filter(r => r.exitReason === e)));
exitResults.sort((a, b) => b.count - a.count);
printTable(exitResults);

// ========== 18. 레짐+전략 교차 분석 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [18] 레짐 × 전략 교차 분석');
console.log('══════════════════════════════════════════════');
const crossKeys = [...new Set(withResult.map(r => `${r.regime}|${r.strategy}`))];
const crossResults = crossKeys.map(k => {
  const [reg, strat] = k.split('|');
  return analyze(`${reg}+${strat}`, withResult.filter(r => r.regime === reg && r.strategy === strat));
});
crossResults.sort((a, b) => b.count - a.count);
printTable(crossResults.filter(r => r.count >= 2));

// ========== 19. regimeScore 구간별 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [19] regimeScore 구간별 성과');
console.log('══════════════════════════════════════════════');
const rsBuckets = [[0,30,'0-30'],[30,50,'30-50'],[50,70,'50-70'],[70,100,'70-100']];
const rsResults = rsBuckets.map(([lo,hi,label]) => analyze(label, withResult.filter(r => r.regimeScore >= lo && r.regimeScore < hi)));
printTable(rsResults);

// ========== 20. GoldenSet Veto 사후 분석 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [20] GoldenSet Veto 사후 분석 (SKIP인데 이동한 경우)');
console.log('══════════════════════════════════════════════');
const gsVetos = skips.filter(r => r.skipReason === 'GOLDSET_VETO');
console.log('  GoldenSet Veto 총:', gsVetos.length, '건');
const gs5m = gsVetos.filter(r => r.moveAfter5min !== 0);
if (gs5m.length > 0) {
  const avgMove = gs5m.reduce((s,r) => s + r.moveAfter5min, 0) / gs5m.length;
  const wouldWin = gs5m.filter(r => {
    if (r.direction === 'Short') return r.moveAfter5min < -0.3;
    return r.moveAfter5min > 0.3;
  }).length;
  console.log('  5분 후 평균 이동:', avgMove.toFixed(3), '%');
  console.log('  진입했으면 수익:', wouldWin, '/', gs5m.length, '건');
}
gsVetos.forEach(r => {
  console.log(`  ${r.ticker} ${r.direction} RSI:${r.rsi.toFixed(1)} ADX:${r.adx.toFixed(0)} regime:${r.regime} 5min:${r.moveAfter5min.toFixed(3)}%`);
});

// ========== 21. 트레이드 스타일 성과 ==========
console.log('\n══════════════════════════════════════════════');
console.log('  [21] 트레이드 스타일 성과');
console.log('══════════════════════════════════════════════');
const styles = [...new Set(withResult.filter(r => r.tradeStyle).map(r => r.tradeStyle))];
const styleResults = styles.map(s => analyze(s, withResult.filter(r => r.tradeStyle === s)));
printTable(styleResults);

console.log('\n══════════════════════════════════════════════');
console.log('  [22] 모든 ENTER 상세 리스트');
console.log('══════════════════════════════════════════════');
withResult.forEach(r => {
  console.log(`  ${r.ticker.padEnd(12)} ${r.direction.padEnd(5)} ${r.strategy.padEnd(14)} zone:${(r.zoneType||'-').padEnd(18)} regime:${(r.regime||'-').padEnd(20)} ` +
    `RSI:${r.rsi.toFixed(0).padStart(3)} ADX:${r.adx.toFixed(0).padStart(3)} Fat:${r.fatigueScore.toFixed(0).padStart(3)} Lev:${r.leverage.toFixed(0).padStart(3)}x ` +
    `TP:${r.tpPercent.toFixed(1).padStart(5)}% SL:${r.slPercent.toFixed(1).padStart(5)}% → ${r.tradeResult.padEnd(4)} $${r.tradePnl.toFixed(2).padStart(8)} (${r.holdingMinutes.toFixed(0)}min) ${r.exitReason}`);
});
