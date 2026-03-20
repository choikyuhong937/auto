// audit_pipeline.cjs — 전체 진입 파이프라인 절차별 유효성 검증
// 핵심: 각 절차가 실제로 수익에 기여하는가, 아니면 시간/API만 낭비하는가?

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', '거래내역 통계_v2.csv.csv');

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
        if (r.tradeResult && !existing.tradeResult) map.set(key, r);
        else if (r.tradeResult && existing.tradeResult) {
            if (Math.abs(parseFloat(r.tradePnl) || 0) > Math.abs(parseFloat(existing.tradePnl) || 0))
                map.set(key, r);
        }
    }
    return [...map.values()];
}

function num(v) { return parseFloat(v) || 0; }

function main() {
    const raw = parseCSV(CSV_PATH);
    const rows = dedup(raw);
    const enters = rows.filter(r => r.action === 'ENTER');
    const skips = rows.filter(r => r.action === 'SKIP');
    const entersWithResult = enters.filter(r => r.tradeResult);

    console.log('═'.repeat(120));
    console.log('  전체 파이프라인 절차별 유효성 검증 — 불필요한 절차 식별');
    console.log('═'.repeat(120));
    console.log(`\n  전체: ${rows.length}건 | ENTER: ${enters.length} | SKIP: ${skips.length} | 결과있음: ${entersWithResult.length}`);

    // ═══════════════════════════════════════════════════════
    // 1. HURST 지수 — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  1. HURST 지수 — 유효한가? (3회 이상 계산됨, ~50ms/회)');
    console.log('█'.repeat(120));

    const hurstValues = rows.map(r => num(r.hurst)).filter(h => h > 0);
    const hurstUnique = [...new Set(hurstValues.map(h => h.toFixed(3)))];
    console.log(`  총 Hurst 데이터: ${hurstValues.length}건`);
    console.log(`  고유 값: ${hurstUnique.length}개 → ${hurstUnique.slice(0, 10).join(', ')}`);
    console.log(`  평균: ${(hurstValues.reduce((s, v) => s + v, 0) / hurstValues.length).toFixed(4)}`);
    console.log(`  최소~최대: ${Math.min(...hurstValues).toFixed(4)} ~ ${Math.max(...hurstValues).toFixed(4)}`);

    const hurst05 = hurstValues.filter(h => h >= 0.49 && h <= 0.51).length;
    console.log(`  0.49~0.51 범위: ${hurst05}건 (${(hurst05/hurstValues.length*100).toFixed(1)}%)`);

    if (hurst05 / hurstValues.length > 0.9) {
        console.log(`  🔴 판정: 완전 무용 — 90%+ 가 0.5 디폴트. Hurst 계산 3회×50ms = 150ms 낭비`);
    }

    // ENTER 데이터에서 Hurst별 성과
    const hurstRanges = [
        { label: '<0.4', min: 0, max: 0.4 },
        { label: '0.4-0.5', min: 0.4, max: 0.5 },
        { label: '0.5', min: 0.5, max: 0.50001 },
        { label: '0.5-0.6', min: 0.50001, max: 0.6 },
        { label: '>0.6', min: 0.6, max: 1.01 },
    ];
    for (const range of hurstRanges) {
        const trades = entersWithResult.filter(r => num(r.hurst) >= range.min && num(r.hurst) < range.max);
        if (trades.length === 0) continue;
        const wins = trades.filter(r => r.tradeResult === 'WIN').length;
        console.log(`  Hurst ${range.label}: ${trades.length}건, WR=${((wins/trades.length)*100).toFixed(1)}%`);
    }

    // ═══════════════════════════════════════════════════════
    // 2. CONFIDENCE — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  2. CONFIDENCE — 유효한가? (GoldenSet 기반 계산, ~200ms)');
    console.log('█'.repeat(120));

    const confValues = rows.map(r => num(r.confidence));
    const confNonZero = confValues.filter(c => c > 0);
    console.log(`  총 Confidence 데이터: ${confValues.length}건`);
    console.log(`  0인 건: ${confValues.filter(c => c === 0).length}건 (${(confValues.filter(c => c === 0).length / confValues.length * 100).toFixed(1)}%)`);
    console.log(`  1+ 인 건: ${confNonZero.length}건`);
    if (confNonZero.length > 0) {
        console.log(`  평균 (>0): ${(confNonZero.reduce((s, v) => s + v, 0) / confNonZero.length).toFixed(1)}`);
    }

    const confAllZero = confValues.filter(c => c === 0).length / confValues.length;
    if (confAllZero > 0.9) {
        console.log(`  🔴 판정: 완전 무용 — ${(confAllZero*100).toFixed(0)}%가 0. 사이징 ×(0.5+0/100×0.7)=×0.5 고정`);
        console.log(`  → GoldenSet confidence 계산 절차 전체가 낭비`);
    }

    // ═══════════════════════════════════════════════════════
    // 3. GOLDENSET 시스템 — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  3. GOLDENSET 시스템 — 유효한가? (runDeepParameterTuning ~200ms + veto ~300ms)');
    console.log('█'.repeat(120));

    const gsVetoSkips = skips.filter(r => r.skipReason === 'GOLDSET_VETO');
    console.log(`  GoldenSet Veto 차단: ${gsVetoSkips.length}건`);

    // SKIP 중 GoldenSet veto의 사후 성과
    const gsVetoWithMove = gsVetoSkips.filter(r => num(r.moveAfter5min) !== 0);
    if (gsVetoWithMove.length > 0) {
        const correctBlock = gsVetoWithMove.filter(r => {
            const dir = r.direction;
            const move = num(r.moveAfter5min);
            return (dir === 'Long' && move < 0) || (dir === 'Short' && move > 0);
        }).length;
        console.log(`  사후 데이터: ${gsVetoWithMove.length}건, 정확한 차단: ${correctBlock}건 (${(correctBlock/gsVetoWithMove.length*100).toFixed(1)}%)`);
    } else {
        console.log(`  사후 데이터 없음 (moveAfter5min=0)`);
    }

    // GoldenSet 데이터 품질: RSI/ADX/ATR이 0인 비율
    const gsVetoRsi0 = gsVetoSkips.filter(r => num(r.rsi) === 0).length;
    const gsVetoAdx0 = gsVetoSkips.filter(r => num(r.adx) === 0).length;
    console.log(`  RSI=0: ${gsVetoRsi0}/${gsVetoSkips.length}, ADX=0: ${gsVetoAdx0}/${gsVetoSkips.length}`);
    if (gsVetoRsi0 / gsVetoSkips.length > 0.8) {
        console.log(`  🔴 판정: 깨진 데이터 기반 — RSI=0이 ${(gsVetoRsi0/gsVetoSkips.length*100).toFixed(0)}%. F3으로 품질 게이트 추가됨`);
    }
    console.log(`  → GoldenSet 전체 비용: 200ms(tuning) + 300ms(veto) + 350캔들(20분마다 재조정) = 약 500ms+`);
    console.log(`  → F3 수정 후에도 데이터 품질이 개선되지 않으면 전체 제거 고려`);

    // ═══════════════════════════════════════════════════════
    // 4. REGIME 재분류 — 3회나 필요한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  4. REGIME 재분류 — 3회 필요한가? (scan→analyze→execute 각각 ~100ms)');
    console.log('█'.repeat(120));

    // 레짐별 분포 확인
    const regimeDist = {};
    for (const r of rows) {
        const reg = r.regime || 'EMPTY';
        regimeDist[reg] = (regimeDist[reg] || 0) + 1;
    }
    console.log(`  레짐 분포:`);
    Object.entries(regimeDist).sort((a, b) => b[1] - a[1]).forEach(([reg, cnt]) => {
        console.log(`    ${reg}: ${cnt}건 (${(cnt/rows.length*100).toFixed(1)}%)`);
    });

    // ENTER에서 레짐별 성과
    const regimePerf = {};
    for (const r of entersWithResult) {
        const reg = r.regime || 'EMPTY';
        if (!regimePerf[reg]) regimePerf[reg] = { w: 0, l: 0, pnl: 0 };
        if (r.tradeResult === 'WIN') regimePerf[reg].w++;
        else regimePerf[reg].l++;
        regimePerf[reg].pnl += num(r.tradePnl);
    }
    console.log(`\n  레짐별 성과 (실제 진입):`);
    for (const [reg, p] of Object.entries(regimePerf)) {
        const total = p.w + p.l;
        console.log(`    ${reg}: ${total}건, WR=${((p.w/total)*100).toFixed(1)}%, PnL=$${p.pnl.toFixed(2)}`);
    }
    console.log(`\n  → 레짐이 2종류만 진입 (TREND_IMPULSE, TREND_CORRECTION). 12-레짐 분류는 과잉`);
    console.log(`  → 3회 재분류 → 1회 캐시로 충분 (300ms → 100ms 절약)`);

    // ═══════════════════════════════════════════════════════
    // 5. MTF 합의 — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  5. MTF 합의 체크 — 유효한가? (3TF fetch = ~600ms)');
    console.log('█'.repeat(120));

    // MTF는 CSV에 직접 안 나옴. 하지만 3개 TF fetch가 scan 시작에 필수
    console.log(`  scanSignals에서 항상 3TF(15m, 1h, 4h) fetch = 약 600ms 블로킹`);
    console.log(`  MTF 합의 기준:`);
    console.log(`    - TREND: alignment ≥ 1 필요 (1개 TF 동의)`);
    console.log(`    - REVERSION: alignment 0 허용`);
    console.log(`    - Full conflict(3/3 반대): SKIP`);
    console.log(`  → 4h TF는 대부분의 Short 스캘프에 불필요 (15분~1시간 홀딩)`);

    // 홀딩 시간 분석 → 4h TF 필요성
    const avgHold = entersWithResult.filter(r => num(r.holdingMinutes) > 0);
    if (avgHold.length > 0) {
        const holdTimes = avgHold.map(r => num(r.holdingMinutes));
        const mean = holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length;
        const max = Math.max(...holdTimes);
        const under30 = holdTimes.filter(h => h <= 30).length;
        const under60 = holdTimes.filter(h => h <= 60).length;
        console.log(`\n  실제 홀딩 시간: 평균 ${mean.toFixed(1)}분, 최대 ${max.toFixed(1)}분`);
        console.log(`  30분 이내: ${under30}/${holdTimes.length} (${(under30/holdTimes.length*100).toFixed(1)}%)`);
        console.log(`  60분 이내: ${under60}/${holdTimes.length} (${(under60/holdTimes.length*100).toFixed(1)}%)`);
        if (mean < 60) {
            console.log(`  🟡 판정: 평균 홀딩 ${mean.toFixed(0)}분 → 4h TF 불필요, 2TF(15m+1h)로 충분`);
            console.log(`  → API 1회 절약 (~200ms), 4h 데이터 수집은 참고용으로만`);
        }
    }

    // ═══════════════════════════════════════════════════════
    // 6. SMART REVERSE — 실질적 효과
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  6. SMART REVERSE — 실질적 효과 분석');
    console.log('█'.repeat(120));

    const reversed = enters.filter(r => r.wasReversed === 'true' || r.wasReversed === '1');
    const notReversed = enters.filter(r => r.wasReversed !== 'true' && r.wasReversed !== '1');
    console.log(`  반전된 거래: ${reversed.length}, 미반전: ${notReversed.length}`);

    // 방향별 결과
    const byDir = {};
    for (const r of entersWithResult) {
        const dir = r.direction || 'UNKNOWN';
        if (!byDir[dir]) byDir[dir] = { w: 0, l: 0, pnl: 0 };
        if (r.tradeResult === 'WIN') byDir[dir].w++;
        else byDir[dir].l++;
        byDir[dir].pnl += num(r.tradePnl);
    }
    console.log(`\n  방향별 결과:`);
    for (const [dir, p] of Object.entries(byDir)) {
        const total = p.w + p.l;
        console.log(`    ${dir}: ${total}건, WR=${((p.w/total)*100).toFixed(1)}%, PnL=$${p.pnl.toFixed(2)}`);
    }

    // Rule #2는 모든 Long→Short. 데이터에 Long이 있으면 Smart Reverse가 꺼진 상태
    const longTrades = entersWithResult.filter(r => r.direction === 'Long');
    const shortTrades = entersWithResult.filter(r => r.direction === 'Short');
    console.log(`\n  Long 진입: ${longTrades.length}건, Short 진입: ${shortTrades.length}건`);

    if (longTrades.length > 0) {
        const longWR = longTrades.filter(r => r.tradeResult === 'WIN').length / longTrades.length * 100;
        const longPnl = longTrades.reduce((s, r) => s + num(r.tradePnl), 0);
        console.log(`  Long 성과: WR=${longWR.toFixed(1)}%, PnL=$${longPnl.toFixed(2)}`);
    }
    if (shortTrades.length > 0) {
        const shortWR = shortTrades.filter(r => r.tradeResult === 'WIN').length / shortTrades.length * 100;
        const shortPnl = shortTrades.reduce((s, r) => s + num(r.tradePnl), 0);
        console.log(`  Short 성과: WR=${shortWR.toFixed(1)}%, PnL=$${shortPnl.toFixed(2)}`);
    }

    console.log(`\n  Rule #2: 모든 Long → Short 무조건 반전`);
    console.log(`  → Long 감지/필터링에 쓰이는 로직이 최종적으로 Short로 반전됨`);
    console.log(`  → Long 방향 checkTrendSetup의 Long 분기는 사실상 무의미 (어차피 Short)`);
    console.log(`  → 단, GoldenSet veto가 Long 기준으로 실행된 후 Smart Reverse가 Short로 바꾸는 문제`);
    console.log(`  → analyzeForWatchlist의 GoldenSet 검증이 반전 전 방향(Long) 기준 = 잘못된 검증`);

    // ═══════════════════════════════════════════════════════
    // 7. 구조적 TP/SL 오버레이 — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  7. 구조적 TP/SL 오버레이 — 유효한가? (~500-700ms, 1-2 API)');
    console.log('█'.repeat(120));

    // TP/SL 설정 레이어: 8단계 조정 후 구조적 오버레이
    console.log(`  TP/SL 조정 파이프라인 (8단계):`);
    console.log(`    1. Base TP (ATR × tpRatio) + Base SL (ATR-based)`);
    console.log(`    2. Regime Dynamic Adjust (신뢰도 기반)`);
    console.log(`    3. Berserker Override (×0.6/0.7)`);
    console.log(`    4. Session TP/SL (세션 보정)`);
    console.log(`    5. Long/Short Asymmetry (Long SL×1.2, Short TP×0.85)`);
    console.log(`    6. Smart Reverse SL (PULLBACK ×1.2)`);
    console.log(`    7. Leverage TP Cap (20x: max 1.5%)`);
    console.log(`    8. RR Cap (TP ≤ SL×2.0)`);
    console.log(`    +α. 구조적 TP/SL 오버레이 (500-700ms 추가)`);

    // 레버리지 캡과 RR 캡이 대부분의 이전 조정을 무효화하는지 확인
    const tpValues = entersWithResult.map(r => num(r.tpPercent)).filter(v => v > 0);
    const slValues = entersWithResult.map(r => num(r.slPercent)).filter(v => v > 0);
    if (tpValues.length > 0) {
        const avgTp = tpValues.reduce((s, v) => s + v, 0) / tpValues.length;
        const avgSl = slValues.reduce((s, v) => s + v, 0) / slValues.length;
        const avgRR = avgTp / avgSl;
        console.log(`\n  실제 TP/SL 값:`);
        console.log(`    평균 TP%: ${avgTp.toFixed(4)}, 평균 SL%: ${avgSl.toFixed(4)}`);
        console.log(`    평균 RR: ${avgRR.toFixed(2)}:1`);
        console.log(`    TP 범위: ${Math.min(...tpValues).toFixed(4)} ~ ${Math.max(...tpValues).toFixed(4)}`);
        console.log(`    SL 범위: ${Math.min(...slValues).toFixed(4)} ~ ${Math.max(...slValues).toFixed(4)}`);

        // G3 20x캡이면 leverageTpCap = 1.5%. 이 캡에 걸리는 비율은?
        const tpOverCap = tpValues.filter(v => v > 0.015).length;
        console.log(`\n    TP > 1.5% (20x 캡 초과): ${tpOverCap}/${tpValues.length} (${(tpOverCap/tpValues.length*100).toFixed(1)}%)`);
        console.log(`    → 이 비율이 높으면 이전 8단계 조정이 대부분 Leverage Cap에 의해 무효화됨`);
    }

    console.log(`\n  → 구조적 오버레이: 스윙 포인트 기반 S/R 레벨을 TP/SL에 반영`);
    console.log(`  → 비용: 500-700ms (1-2 API), 하지만 이미 8단계 조정 + 캡으로 TP/SL이 정해진 후`);
    console.log(`  → 오버레이가 캡된 값을 다시 바꿀 수 있는지 확인 필요`);

    // ═══════════════════════════════════════════════════════
    // 8. findDominantTimeframe — 유효한가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  8. findDominantTimeframe — 유효한가? (~400-1000ms, 1-2 API)');
    console.log('█'.repeat(120));

    const tfDist = {};
    for (const r of rows) {
        const tf = r.triggerTimeframe || 'EMPTY';
        tfDist[tf] = (tfDist[tf] || 0) + 1;
    }
    console.log(`  triggerTimeframe 분포:`);
    Object.entries(tfDist).sort((a, b) => b[1] - a[1]).forEach(([tf, cnt]) => {
        console.log(`    ${tf}: ${cnt}건 (${(cnt/rows.length*100).toFixed(1)}%)`);
    });

    // ENTER에서 TF별 성과
    const tfPerf = {};
    for (const r of entersWithResult) {
        const tf = r.triggerTimeframe || 'EMPTY';
        if (!tfPerf[tf]) tfPerf[tf] = { w: 0, l: 0, pnl: 0 };
        if (r.tradeResult === 'WIN') tfPerf[tf].w++;
        else tfPerf[tf].l++;
        tfPerf[tf].pnl += num(r.tradePnl);
    }
    if (Object.keys(tfPerf).length > 0) {
        console.log(`\n  TF별 성과:`);
        for (const [tf, p] of Object.entries(tfPerf)) {
            const total = p.w + p.l;
            console.log(`    ${tf}: ${total}건, WR=${((p.w/total)*100).toFixed(1)}%, PnL=$${p.pnl.toFixed(2)}`);
        }
    }

    // TF가 1종류만 사용되면 findDominantTimeframe은 낭비
    const tfTypes = Object.keys(tfDist).filter(t => t !== 'EMPTY');
    if (tfTypes.length <= 2) {
        console.log(`\n  🟡 판정: TF ${tfTypes.length}종류만 사용 → findDominantTimeframe이 복잡한 점수 계산 불필요`);
        console.log(`  → 15m 고정으로 충분할 수 있음 (400-1000ms → 0ms 절약)`);
    }

    // ═══════════════════════════════════════════════════════
    // 9. ENTRY SNAPSHOT — 어떤 필드가 실제 사용되는가?
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  9. ENTRY SNAPSHOT — 어떤 필드가 실제 사용/유효한가? (~700-1000ms)');
    console.log('█'.repeat(120));

    // snapshot에 들어가는 필드들의 데이터 품질
    const fieldQuality = [
        { name: 'rsi', field: 'rsi' },
        { name: 'adx', field: 'adx' },
        { name: 'hurst', field: 'hurst' },
        { name: 'atrPercent', field: 'atrPercent' },
        { name: 'fatigueScore', field: 'fatigueScore' },
        { name: 'regimeScore', field: 'regimeScore' },
        { name: 'confidence', field: 'confidence' },
        { name: 'candleAge', field: 'candleAge' },
        { name: 'secSinceClose', field: 'secSinceClose' },
        { name: 'fundingRateAtEntry', field: 'fundingRateAtEntry' },
        { name: 'orderbookImbalanceAtEntry', field: 'orderbookImbalanceAtEntry' },
    ];

    for (const f of fieldQuality) {
        const vals = entersWithResult.map(r => num(r[f.field]));
        const nonZero = vals.filter(v => v !== 0);
        const unique = [...new Set(vals.map(v => v.toFixed(4)))];
        const quality = nonZero.length > 0 ? 'OK' : 'EMPTY';
        const flag = nonZero.length === 0 ? '🔴' : unique.length <= 2 ? '🟡' : '🟢';
        console.log(`  ${flag} ${f.name}: ${nonZero.length}/${vals.length} 비zero, ${unique.length} 고유값 [${quality}]`);
    }

    console.log(`\n  Snapshot 비용: klines(1 API) + Hurst(50ms) + ADX(10ms) + FR(1 API) + OB(1 API) + Regime(100ms)`);
    console.log(`  → 0인 필드들은 계산 비용만 소모하고 결과에 기여 없음`);

    // ═══════════════════════════════════════════════════════
    // 10. EXECUTION PHASE API 낭비 식별
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  10. EXECUTION PHASE — 중복/불필요 API 호출');
    console.log('█'.repeat(120));

    console.log(`\n  executeOrderWithSniperLoop에서 API 호출 목록:`);
    console.log(`    1. Regime klines (100캔들, primaryTF) — 이미 scan에서 계산됨. 중복?`);
    console.log(`    2. BTC trend (BTCUSDT 15m klines) — 60초 캐시. Short에만 사용`);
    console.log(`    3. Funding rate (fetchTickerStats) — Short에만 사용`);
    console.log(`    4. Balance refresh (fetchAccountState) — 필수`);
    console.log(`    5. Max leverage (getMaxLeverage) — 필수`);
    console.log(`    6. Set leverage (setLeverage) — 필수`);
    console.log(`    7. Current price (fetchCurrentPrices) — 이미 모니터링에서 가져옴`);
    console.log(`    8. Instrument info (fetchInstrumentInfo) — 캐시 가능`);
    console.log(`    9. Entry snapshot klines (100캔들) — #1과 중복!`);
    console.log(`   10. FR supplement (fetchTickerStats) — #3과 중복!`);
    console.log(`   11. OB supplement (fetchOrderBook) — 진입 결정에 영향 없음?`);
    console.log(`   12. Structural overlay klines (100캔들) — #1/#9와 중복!`);
    console.log(`   13. HTF klines (1h, 100캔들) — scan에서 이미 가져옴`);
    console.log(`   14. Set TPSL (setPositionTPSL) — 필수`);
    console.log(`   15. Place order (placeOrder) — 필수`);

    // 중복 식별
    console.log(`\n  🔴 중복 API 호출:`);
    console.log(`    - Regime klines (#1) = Entry snapshot klines (#9) = Structural klines (#12) → 3회 → 1회로`);
    console.log(`    - Funding rate (#3) = FR supplement (#10) → 2회 → 1회로`);
    console.log(`    - HTF klines (#13) = scan에서 이미 fetch → 패스 가능`);
    console.log(`    - Current price (#7) = 모니터링에서 이미 fetch → 패스 가능`);
    console.log(`\n  절약 가능 API: 최소 4-5회 (~800-1200ms)`);

    // ═══════════════════════════════════════════════════════
    // 11. EXIT 분석 — SL/TP 비율 정밀 분석
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  11. EXIT 패턴 분석 — SL vs TP vs exchange_close');
    console.log('█'.repeat(120));

    const exitDist = {};
    for (const r of entersWithResult) {
        const ex = r.exitReason || 'UNKNOWN';
        exitDist[ex] = (exitDist[ex] || 0) + 1;
    }
    for (const [ex, cnt] of Object.entries(exitDist).sort((a, b) => b[1] - a[1])) {
        const trades = entersWithResult.filter(r => r.exitReason === ex);
        const pnl = trades.reduce((s, r) => s + num(r.tradePnl), 0);
        const avgHold = trades.reduce((s, r) => s + num(r.holdingMinutes), 0) / trades.length;
        console.log(`  ${ex}: ${cnt}건, PnL=$${pnl.toFixed(2)}, avgHold=${avgHold.toFixed(1)}분`);
    }

    // exchange_close의 패턴 분석
    const exchangeCloses = entersWithResult.filter(r => r.exitReason === 'exchange_close');
    if (exchangeCloses.length > 0) {
        console.log(`\n  exchange_close 세부 분석:`);
        const ecBySession = {};
        for (const r of exchangeCloses) {
            const sess = r.session || 'UNKNOWN';
            if (!ecBySession[sess]) ecBySession[sess] = { cnt: 0, pnl: 0, holds: [] };
            ecBySession[sess].cnt++;
            ecBySession[sess].pnl += num(r.tradePnl);
            ecBySession[sess].holds.push(num(r.holdingMinutes));
        }
        for (const [sess, d] of Object.entries(ecBySession)) {
            const avgH = d.holds.reduce((s, v) => s + v, 0) / d.holds.length;
            console.log(`    ${sess}: ${d.cnt}건, PnL=$${d.pnl.toFixed(2)}, avgHold=${avgH.toFixed(1)}분`);
        }

        // MFE 분석 — 수익권에 진입했었는가?
        const ecWithMfe = exchangeCloses.filter(r => num(r.maxFavorableExcursion) > 0);
        console.log(`\n    방향 맞았으나 TP 미도달: ${ecWithMfe.length}/${exchangeCloses.length} (${(ecWithMfe.length/exchangeCloses.length*100).toFixed(1)}%)`);
        if (ecWithMfe.length > 0) {
            const avgMfe = ecWithMfe.reduce((s, r) => s + num(r.maxFavorableExcursion), 0) / ecWithMfe.length;
            const avgTp = ecWithMfe.reduce((s, r) => s + num(r.tpPercent), 0) / ecWithMfe.length;
            console.log(`    평균 MFE: ${avgMfe.toFixed(4)}%, 평균 TP: ${avgTp.toFixed(4)}%`);
            console.log(`    MFE/TP: ${(avgMfe/avgTp).toFixed(2)}x (1.0이면 TP에 도달)`);
        }
    }

    // ═══════════════════════════════════════════════════════
    // 12. 전체 타임라인 — 신호→주문까지 걸리는 시간
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  12. 전체 파이프라인 예상 레이턴시 (신호→주문)');
    console.log('█'.repeat(120));

    console.log(`\n  Phase 1: scanSignals`);
    console.log(`    3TF kline fetch ────────── ~600ms  (15m+1h+4h parallel)`);
    console.log(`    Indicator calc ─────────── ~50ms   (ATR, RSI, BB, ADX)`);
    console.log(`    Regime scoring ─────────── ~50ms   (12-regime)`);
    console.log(`    Session + filters ────────  ~5ms`);
    console.log(`    MTF consensus ─────────── ~20ms`);
    console.log(`    ─────────────────────────── ~725ms total`);

    console.log(`\n  Phase 2: analyzeForWatchlist`);
    console.log(`    findDominantTimeframe ──── ~600ms  (1-2 API + scoring)`);
    console.log(`    Hurst calculation ──────── ~50ms   (CPU) ← 항상 0.5`);
    console.log(`    Regime classify (2nd) ──── ~100ms  ← 중복!`);
    console.log(`    GoldenSet tuning ───────── ~200ms  (backtest) ← 무용?`);
    console.log(`    Zone calculation ───────── ~30ms`);
    console.log(`    ─────────────────────────── ~980ms total`);

    console.log(`\n  Phase 3: Zone Monitoring (variable, ~1-5초 per cycle)`);
    console.log(`    Price batch ────────────── ~200ms  (all candidates)`);
    console.log(`    1h ADX fetch ──────────── ~300ms  (per trigger)`);
    console.log(`    GoldenSet veto ─────────── ~300ms  (5m klines) ← 무용?`);
    console.log(`    Volume/Wick check ──────── ~300ms  (1m klines)`);

    console.log(`\n  Phase 4: Execution`);
    console.log(`    Regime (3rd!) ──────────── ~500ms  ← 중복!`);
    console.log(`    BTC trend ──────────────── ~300ms  (캐시 시 0ms)`);
    console.log(`    Funding rate ──────────── ~100ms`);
    console.log(`    Balance refresh ────────── ~150ms  (필수)`);
    console.log(`    Leverage ──────────────── ~350ms  (필수)`);
    console.log(`    Qty calc ──────────────── ~400ms  (필수)`);
    console.log(`    Entry snapshot ─────────── ~800ms  ← 중복!`);
    console.log(`    TP/SL 8-layer ─────────── ~50ms   (CPU)`);
    console.log(`    Structural overlay ──────── ~600ms  ← 중복!`);
    console.log(`    Order placement ────────── ~300ms  (필수)`);
    console.log(`    ─────────────────────────── ~3550ms total`);

    const totalMs = 725 + 980 + 300 + 3550;
    console.log(`\n  ★ 총 예상 레이턴시 (모니터링 제외): ~${totalMs}ms = ~${(totalMs/1000).toFixed(1)}초`);
    console.log(`  ★ 제거 가능 레이턴시:`);
    console.log(`    Hurst 3회: ~150ms`);
    console.log(`    Regime 중복 2회: ~600ms`);
    console.log(`    GoldenSet (tuning+veto): ~500ms`);
    console.log(`    findDominantTimeframe: ~600ms (15m 고정 시)`);
    console.log(`    중복 API (klines, FR): ~1200ms`);
    console.log(`    ──────────────────────── ~3050ms 절약 가능`);
    console.log(`    → 현재 ~${(totalMs/1000).toFixed(1)}초 → ~${((totalMs - 3050)/1000).toFixed(1)}초 (${((3050/totalMs)*100).toFixed(0)}% 단축)`);

    // ═══════════════════════════════════════════════════════
    // 13. 최종 판정
    // ═══════════════════════════════════════════════════════
    console.log('\n\n' + '█'.repeat(120));
    console.log('  13. 최종 판정 — 절차별 유효성 + 제거/간소화 권고');
    console.log('█'.repeat(120));

    const verdicts = [
        { proc: 'Hurst Exponent (3회 계산)', cost: '150ms', verdict: '🔴 제거', reason: '100% 0.5 디폴트, 분기 없음, 성과 차이 없음' },
        { proc: 'Confidence Score', cost: '200ms', verdict: '🔴 제거', reason: '100% 0값, 사이징에 ×0.5 고정 효과만' },
        { proc: 'GoldenSet tuning', cost: '200ms', verdict: '🔴 제거', reason: 'RSI=0/ADX=0 데이터, veto 부정확, F3으로 우회됨' },
        { proc: 'GoldenSet veto', cost: '300ms', verdict: '🔴 제거', reason: '74건 차단 중 62% 수익 기회, 데이터 품질 미달' },
        { proc: 'GoldenSet 20분 재조정', cost: '200ms/20분', verdict: '🔴 제거', reason: '350캔들 fetch 후 같은 가비지 파라미터 생성' },
        { proc: 'findDominantTimeframe', cost: '600ms', verdict: '🟡 간소화', reason: '실질 사용 TF 1-2종, 15m 기본으로 충분' },
        { proc: 'Regime 3회 재분류', cost: '600ms', verdict: '🟡 간소화', reason: '1회만 계산 → 결과 캐시 전달' },
        { proc: '4h TF fetch (scanSignals)', cost: '200ms', verdict: '🟡 간소화', reason: '평균 홀딩 <60분, 4h 불필요' },
        { proc: 'Entry Snapshot 중복 klines', cost: '400ms', verdict: '🔴 제거', reason: 'Regime klines와 동일 fetch. 캐시 사용' },
        { proc: 'Structural TP/SL klines', cost: '400ms', verdict: '🟡 간소화', reason: '이미 fetch된 klines 재사용 가능' },
        { proc: 'FR 중복 fetch', cost: '100ms', verdict: '🔴 제거', reason: '같은 tickerStats 2회 호출' },
        { proc: 'OB fetch (entry snapshot)', cost: '150ms', verdict: '🟡 간소화', reason: '진입 결정에 미사용, 데이터 수집용만' },
        { proc: 'TP/SL 8단계 조정', cost: '50ms', verdict: '🟡 간소화', reason: 'Leverage Cap + RR Cap이 대부분 무효화' },
        { proc: 'Smart Reverse Final Guard', cost: '0ms', verdict: '🟢 유지', reason: '비용 없음, 방어 프로그래밍 유지' },
        { proc: 'MTF 합의 체크', cost: '20ms', verdict: '🟢 유지', reason: '이미 fetch된 데이터 사용, CPU만 소모' },
        { proc: 'Session 파라미터', cost: '0ms', verdict: '🟢 유지', reason: 'G4로 OVERLAP_EU_US 수정 완료' },
        { proc: 'RSI Guard', cost: '0ms', verdict: '🟢 유지', reason: '0% WR 데이터 기반 유효한 차단' },
        { proc: 'Fatigue Block', cost: '0ms', verdict: '🟢 유지', reason: '0% WR 데이터 기반 유효한 차단' },
        { proc: 'Leverage Cap', cost: '0ms', verdict: '🟢 유지', reason: '데이터: 1-10x만 수익' },
    ];

    console.log(`\n  ${'절차'.padEnd(35)} ${'비용'.padEnd(15)} ${'판정'.padEnd(10)} 이유`);
    console.log(`  ${'─'.repeat(35)} ${'─'.repeat(15)} ${'─'.repeat(10)} ${'─'.repeat(50)}`);
    for (const v of verdicts) {
        console.log(`  ${v.proc.padEnd(35)} ${v.cost.padEnd(15)} ${v.verdict.padEnd(10)} ${v.reason}`);
    }

    const removeMs = 150 + 200 + 200 + 300 + 200 + 400 + 100;
    const simplifyMs = 600 + 600 + 200 + 400 + 150;
    console.log(`\n  🔴 제거 가능: ~${removeMs}ms`);
    console.log(`  🟡 간소화 가능: ~${simplifyMs}ms`);
    console.log(`  ★ 총 절약: ~${removeMs + simplifyMs * 0.5}ms (간소화 50% 효율 가정)`);
}

main();
