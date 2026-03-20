const fs = require('fs');
const path = require('path');

const csvPath = path.join('C:', 'Users', 'michj', 'Downloads', '거래내역 통계 - Decisions.csv');
const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const headers = lines[0].split(',');
const rows = [];

// CSV 파싱 (쉼표 in 따옴표 처리)
for (let i = 1; i < lines.length; i++) {
    const row = {};
    let cols = [];
    let current = '';
    let inQuotes = false;
    for (let c of lines[i]) {
        if (c === '"') { inQuotes = !inQuotes; continue; }
        if (c === ',' && !inQuotes) { cols.push(current.trim()); current = ''; continue; }
        current += c;
    }
    cols.push(current.trim());
    headers.forEach((h, idx) => { row[h.trim()] = cols[idx] || ''; });
    rows.push(row);
}

console.log('══════════════════════════════════════════════');
console.log(`  UPG7.2 이후 신규 데이터 분석 (${rows.length}건)`);
console.log('══════════════════════════════════════════════\n');

// [1] 기본 통계
const enters = rows.filter(r => r.action === 'ENTER');
const skips = rows.filter(r => r.action === 'SKIP');
console.log('━━━ [1] 기본 통계 ━━━');
console.log(`  총: ${rows.length}건 | ENTER: ${enters.length}건 (${(enters.length/rows.length*100).toFixed(1)}%) | SKIP: ${skips.length}건`);

// [2] 헤더 확인 - 새 필드 존재 여부
console.log('\n━━━ [2] 새 필드 수집 상태 ━━━');
const newFields = ['candleAge','secSinceClose','triggerTimeframe','quantity','initialMargin','positionValue',
    'wasReversed','switchCount','tradeStyle','goal','deploymentMode','expectedDuration','primaryTimeframe',
    'phase','isBerserkerMode','liquidationPrice','totalEquityAtEntry',
    'maxFavorableExcursion','maxAdverseExcursion','peakPrice','troughPrice','slAdjustCount','entryToExitPath',
    'fundingRateAtEntry','orderbookImbalanceAtEntry'];

newFields.forEach(f => {
    const filled = rows.filter(r => r[f] && r[f] !== '');
    const enterFilled = enters.filter(r => r[f] && r[f] !== '');
    if (filled.length > 0 || enterFilled.length > 0) {
        console.log(`  ✅ ${f}: ${filled.length}건 (ENTER: ${enterFilled.length}/${enters.length})`);
    } else {
        console.log(`  ❌ ${f}: 0건`);
    }
});

// [3] SKIP 사유
console.log('\n━━━ [3] SKIP 사유 분포 ━━━');
const skipReasons = {};
skips.forEach(r => { const sr = r.skipReason || 'UNKNOWN'; skipReasons[sr] = (skipReasons[sr]||0)+1; });
Object.entries(skipReasons).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log(`  ${k}: ${v}건 (${(v/skips.length*100).toFixed(1)}%)`);
});

// [4] 레짐 분포
console.log('\n━━━ [4] 레짐 분포 ━━━');
const regimes = {};
rows.forEach(r => { const rg = r.regime || 'UNKNOWN'; regimes[rg] = (regimes[rg]||0)+1; });
Object.entries(regimes).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    const regEnters = enters.filter(r => r.regime === k).length;
    console.log(`  ${k}: ${v}건 (ENTER: ${regEnters})`);
});

// [5] 티커별 분포
console.log('\n━━━ [5] 티커별 ━━━');
const tickers = {};
rows.forEach(r => { const t = r.ticker || '?'; if (!tickers[t]) tickers[t] = {total:0,enter:0}; tickers[t].total++; if(r.action==='ENTER') tickers[t].enter++; });
Object.entries(tickers).sort((a,b) => b[1].total-a[1].total).slice(0,15).forEach(([k,v]) => {
    console.log(`  ${k}: ${v.total}건 (ENTER: ${v.enter})`);
});
console.log(`  총 티커: ${Object.keys(tickers).length}개`);

// [6] 봉마감 분석
console.log('\n━━━ [6] 봉마감 분석 (candleAge) ━━━');
const withCandleAge = rows.filter(r => r.candleAge && r.candleAge !== '');
if (withCandleAge.length > 0) {
    const ages = withCandleAge.map(r => parseFloat(r.candleAge));
    const avg = ages.reduce((a,b)=>a+b,0) / ages.length;
    console.log(`  데이터: ${withCandleAge.length}건 | 평균 candleAge: ${avg.toFixed(3)}`);
    // 구간별
    const bins = {'0~0.1 (마감직후)':0, '0.1~0.3':0, '0.3~0.5':0, '0.5~0.7':0, '0.7~0.9':0, '0.9~1.0 (마감직전)':0};
    ages.forEach(a => {
        if (a < 0.1) bins['0~0.1 (마감직후)']++;
        else if (a < 0.3) bins['0.1~0.3']++;
        else if (a < 0.5) bins['0.3~0.5']++;
        else if (a < 0.7) bins['0.5~0.7']++;
        else if (a < 0.9) bins['0.7~0.9']++;
        else bins['0.9~1.0 (마감직전)']++;
    });
    Object.entries(bins).forEach(([k,v]) => {
        const pct = (v/withCandleAge.length*100).toFixed(1);
        const bar = '█'.repeat(Math.round(v/withCandleAge.length*30));
        // 이 구간의 ENTER 비율
        const binEnters = withCandleAge.filter(r => {
            const a = parseFloat(r.candleAge);
            if (k.includes('0~0.1')) return a < 0.1;
            if (k.includes('0.1~0.3')) return a >= 0.1 && a < 0.3;
            if (k.includes('0.3~0.5')) return a >= 0.3 && a < 0.5;
            if (k.includes('0.5~0.7')) return a >= 0.5 && a < 0.7;
            if (k.includes('0.7~0.9')) return a >= 0.7 && a < 0.9;
            return a >= 0.9;
        }).filter(r => r.action === 'ENTER').length;
        console.log(`  ${k}: ${v}건 (${pct}%) ENTER:${binEnters} ${bar}`);
    });
} else {
    console.log('  ❌ candleAge 데이터 없음');
}

// [7] 세션별
console.log('\n━━━ [7] 세션별 ━━━');
const sessions = {};
rows.forEach(r => { const s = r.session || '?'; if (!sessions[s]) sessions[s] = {total:0,enter:0}; sessions[s].total++; if(r.action==='ENTER') sessions[s].enter++; });
Object.entries(sessions).sort((a,b) => b[1].total-a[1].total).forEach(([k,v]) => {
    console.log(`  ${k}: ${v.total}건 (ENTER: ${v.enter}, 진입률: ${(v.enter/v.total*100).toFixed(1)}%)`);
});

// [8] ENTER 상세
console.log('\n━━━ [8] ENTER 상세 ━━━');
enters.forEach(r => {
    const time = r.timestamp || '';
    const rev = r.wasReversed || '';
    const style = r.tradeStyle || '';
    const goal = r.goal || '';
    const lev = r.leverage || '';
    const margin = r.initialMargin || '';
    const equity = r.totalEquityAtEntry || '';
    const liq = r.liquidationPrice || '';
    const ca = r.candleAge || '';
    const fr = r.fundingRateAtEntry || '';
    const ob = r.orderbookImbalanceAtEntry || '';
    console.log(`  ${time} | ${r.ticker} ${r.direction} ${r.strategy}`);
    console.log(`    리버스:${rev} 스타일:${style} 목표:${goal} 레버:${lev}x`);
    console.log(`    마진:${margin} 자산:${equity} 청산가:${liq}`);
    console.log(`    캔들위치:${ca} 펀딩비:${fr} 호가불균형:${ob}`);
    console.log(`    TP:${r.tp} SL:${r.sl} EP:${r.entryPrice}`);
});

// [9] 거래 결과
console.log('\n━━━ [9] 거래 결과 (outcome) ━━━');
const withResult = enters.filter(r => r.tradeResult && r.tradeResult !== '');
if (withResult.length > 0) {
    const wins = withResult.filter(r => r.tradeResult === 'WIN').length;
    const losses = withResult.filter(r => r.tradeResult === 'LOSS').length;
    const be = withResult.filter(r => r.tradeResult === 'BREAKEVEN').length;
    console.log(`  결과 있음: ${withResult.length}건`);
    console.log(`  WIN: ${wins} | LOSS: ${losses} | BE: ${be} | 승률: ${(wins/withResult.length*100).toFixed(1)}%`);

    withResult.forEach(r => {
        console.log(`  ${r.ticker} ${r.direction}: ${r.tradeResult} PnL:${r.tradePnl} (${r.tradePnlPercent}%) ${r.holdingMinutes}분 MFE:${r.maxFavorableExcursion}% MAE:${r.maxAdverseExcursion}% 경로:${r.entryToExitPath} SL조정:${r.slAdjustCount}회 종료:${r.exitReason}`);
    });
} else {
    console.log('  거래 결과 데이터 없음');
}

// [10] 사후 가격추적
console.log('\n━━━ [10] 사후 가격추적 ━━━');
const with5min = rows.filter(r => r.moveAfter5min && r.moveAfter5min !== '');
const with15min = rows.filter(r => r.moveAfter15min && r.moveAfter15min !== '');
const with1hr = rows.filter(r => r.moveAfter1hr && r.moveAfter1hr !== '');
console.log(`  5분후: ${with5min.length}건 | 15분후: ${with15min.length}건 | 1시간후: ${with1hr.length}건`);

if (with5min.length > 0) {
    // SKIP vs ENTER 비교
    const skip5 = with5min.filter(r => r.action === 'SKIP');
    const enter5 = with5min.filter(r => r.action === 'ENTER');
    if (skip5.length > 0) {
        const avgSkip = skip5.reduce((s,r) => s + parseFloat(r.moveAfter5min), 0) / skip5.length;
        console.log(`  SKIP 5분후 평균이동: ${avgSkip >= 0 ? '+' : ''}${avgSkip.toFixed(3)}%`);
        const wouldWin = skip5.filter(r => parseFloat(r.moveAfter5min) > 0.3).length;
        console.log(`  SKIP 중 5분후 +0.3% 이상(기회놓침): ${wouldWin}건 (${(wouldWin/skip5.length*100).toFixed(1)}%)`);
    }
    if (enter5.length > 0) {
        const avgEnter = enter5.reduce((s,r) => s + parseFloat(r.moveAfter5min), 0) / enter5.length;
        console.log(`  ENTER 5분후 평균이동: ${avgEnter >= 0 ? '+' : ''}${avgEnter.toFixed(3)}%`);
    }
}

// [11] AI SKIP 분석
console.log('\n━━━ [11] AI SKIP 상세 ━━━');
const aiSkips = skips.filter(r => r.skipReason === 'AI_SKIP');
if (aiSkips.length > 0) {
    console.log(`  총 ${aiSkips.length}건`);
    // 티커별
    const aiTickers = {};
    aiSkips.forEach(r => { aiTickers[r.ticker] = (aiTickers[r.ticker]||0)+1; });
    Object.entries(aiTickers).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`    ${k}: ${v}건`));
    // 5분후 이동 (기회놓침 체크)
    const ai5min = aiSkips.filter(r => r.moveAfter5min && r.moveAfter5min !== '');
    if (ai5min.length > 0) {
        const avgMove = ai5min.reduce((s,r) => s + parseFloat(r.moveAfter5min), 0) / ai5min.length;
        const missedOpp = ai5min.filter(r => parseFloat(r.moveAfter5min) > 0.5).length;
        console.log(`  5분후 평균: ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(3)}% | 놓친기회(>0.5%): ${missedOpp}건`);
    }
    // 이유 샘플
    console.log('  사유 샘플:');
    aiSkips.slice(0, 3).forEach(r => {
        console.log(`    ${r.ticker}: ${(r.reason||'').substring(0, 100)}`);
    });
} else {
    console.log('  AI SKIP 없음');
}

// [12] 방향별
console.log('\n━━━ [12] 방향별 ━━━');
const longs = rows.filter(r => r.direction === 'Long');
const shorts = rows.filter(r => r.direction === 'Short');
const longEnters = enters.filter(r => r.direction === 'Long');
const shortEnters = enters.filter(r => r.direction === 'Short');
console.log(`  Long: ${longs.length}건 (ENTER: ${longEnters.length}) | Short: ${shorts.length}건 (ENTER: ${shortEnters.length})`);

// [13] 전략별
console.log('\n━━━ [13] ENTER 전략별 ━━━');
const strategies = {};
enters.forEach(r => { const s = r.strategy || '?'; strategies[s] = (strategies[s]||0)+1; });
Object.entries(strategies).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}건`));

// [14] 리버스 분석
console.log('\n━━━ [14] 리버스 진입 분석 ━━━');
const reversed = enters.filter(r => r.wasReversed === 'true' || r.wasReversed === 'TRUE');
const normal = enters.filter(r => r.wasReversed === 'false' || r.wasReversed === 'FALSE' || r.wasReversed === '');
console.log(`  리버스: ${reversed.length}건 | 일반: ${normal.length}건`);
if (reversed.length > 0) {
    reversed.forEach(r => {
        console.log(`    ${r.ticker} ${r.direction} ${r.strategy} 결과:${r.tradeResult||'미정'} PnL:${r.tradePnlPercent||'?'}%`);
    });
}

// [15] 데이터 품질
console.log('\n━━━ [15] 데이터 품질 점검 ━━━');
const quality = {
    'candleAge': rows.filter(r => r.candleAge && r.candleAge !== '').length,
    'secSinceClose': rows.filter(r => r.secSinceClose && r.secSinceClose !== '').length,
    'triggerTimeframe': rows.filter(r => r.triggerTimeframe && r.triggerTimeframe !== '').length,
    'rsi (>0)': rows.filter(r => r.rsi && r.rsi !== '' && parseFloat(r.rsi) > 0).length,
    'adx (>0)': rows.filter(r => r.adx && r.adx !== '' && parseFloat(r.adx) > 0).length,
    'regime': rows.filter(r => r.regime && r.regime !== '').length,
    'execution(ENTER)': enters.filter(r => r.entryPrice && r.entryPrice !== '').length,
    'wasReversed(ENTER)': enters.filter(r => r.wasReversed && r.wasReversed !== '').length,
    'leverage(ENTER)': enters.filter(r => r.leverage && r.leverage !== '').length,
    'totalEquityAtEntry(ENTER)': enters.filter(r => r.totalEquityAtEntry && r.totalEquityAtEntry !== '').length,
    'outcome(ENTER)': enters.filter(r => r.tradeResult && r.tradeResult !== '').length,
    'MFE(ENTER)': enters.filter(r => r.maxFavorableExcursion && r.maxFavorableExcursion !== '').length,
    'fundingRate(ENTER)': enters.filter(r => r.fundingRateAtEntry && r.fundingRateAtEntry !== '').length,
    'orderbookImbalance(ENTER)': enters.filter(r => r.orderbookImbalanceAtEntry && r.orderbookImbalanceAtEntry !== '').length,
    'priceAfter5min': with5min.length,
    'priceAfter15min': with15min.length,
    'priceAfter1hr': with1hr.length,
};
Object.entries(quality).forEach(([k, v]) => {
    const total = k.includes('ENTER') ? enters.length : rows.length;
    const pct = total > 0 ? (v/total*100).toFixed(1) : '0.0';
    const emoji = parseFloat(pct) >= 80 ? '✅' : parseFloat(pct) >= 30 ? '⚠️' : '❌';
    console.log(`  ${emoji} ${k}: ${v}/${total} (${pct}%)`);
});

console.log('\n══════════════════════════════════════════════');
console.log('  분석 완료');
console.log('══════════════════════════════════════════════');
