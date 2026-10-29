// 코인별·날짜별 판정을 미리 계산 → data/feat_engine.json
// 각 날짜에서 "그날까지의 365봉"만 엔진에 넣는다(미래 정보 없음). 앱과 같은 엔진·같은 BTC 200일선 필터.
const fs = require('fs');
const path = require('path');
const {loadEngine} = require('./lib/engine');
const {DATA, key, loadCoin, listCoins, btcRegimeMap} = require('./lib/data');

const E = loadEngine();
const reg = btcRegimeMap();
const coins = listCoins();
const out = {};
const t0 = Date.now();
for (const [n, c] of coins.entries()) {
  const bars = loadCoin(c), rows = [];
  for (let t = 364; t < bars.length; t++) {
    const x = E.computeTechIndicators(bars.slice(t - 364, t + 1), {tf: '1d', price: bars[t].close, regime: reg[key(bars[t].t)] || null, market: 'crypto'});
    rows.push([bars[t].t, x.score, x.verdict.stance, x.atr]);
  }
  out[c] = rows;
  process.stdout.write(`\r판정 계산 ${n + 1}/${coins.length} (${c})        `);
}
fs.writeFileSync(path.join(DATA, 'feat_engine.json'), JSON.stringify(out));
console.log(`\n완료: ${coins.length}종, ${((Date.now() - t0) / 1000).toFixed(0)}초 → data/feat_engine.json`);
