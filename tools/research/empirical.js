// 앱 화면의 "과거 실측" 표(EMPIRICAL_CRYPTO_1D)를 다시 계산해 앱 값과 대조
//   node empirical.js
// 코인 10종 일봉, 2023-01-01 ~ 2026-09-29 매일 표본, 판정 후 20일 수익률. (5일 간격 표본은 시작일만 바꿔도
// 구간 통계가 크게 흔들려 매일 표본을 쓴다. n은 일수이며 20일 보유가 겹쳐 독립 표본은 훨씬 적다.)
const {loadEngine} = require('./lib/engine');
const {key, loadCoin, btcRegimeMap} = require('./lib/data');
const E = loadEngine(), reg = btcRegimeMap();
const COINS = ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','LINK','LTC'], FROM = '2023-01-01', TO = '2026-09-29';
const rows = [];
for (const c of COINS) {
  const bars = loadCoin(c);
  for (let t = 364; t < bars.length - 21; t++) {
    const d = key(bars[t].t); if (d < FROM || d > TO) continue;
    const x = E.computeTechIndicators(bars.slice(t - 364, t + 1), {tf: '1d', price: bars[t].close, regime: reg[d] || null, market: 'crypto'});
    rows.push({score: x.score, stance: x.verdict.stance, fwd: bars[t + 20].close / bars[t].close - 1});
  }
  process.stdout.write(`\r${c} 완료      `);
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const B = {long_75: r => r.stance === 'long' && r.score >= 75, long_50: r => r.stance === 'long' && r.score >= 50 && r.score < 75,
  long_25: r => r.stance === 'long' && r.score < 50, bear: r => r.stance === 'bear', neutral: r => r.stance === 'neutral',
  avoid: r => r.stance === 'avoid', all: () => true};
console.log(`\n${rows.length}개 코인-일 (${FROM} ~ ${TO})\n구간       n      상승%   평균%  중앙값%  |  앱 표시값`);
let fail = 0;
for (const [k, f] of Object.entries(B)) {
  const a = rows.filter(f).map(r => r.fwd);
  const got = {n: a.length, up: +(a.filter(x => x > 0).length / a.length * 100).toFixed(1), avg: +(a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(1), med: +(med(a) * 100).toFixed(1)};
  const app = E.EMPIRICAL_CRYPTO_1D[k];
  const same = app && app.n === got.n && Math.abs(app.up - got.up) < 0.11 && Math.abs(app.avg - got.avg) < 0.11 && Math.abs(app.med - got.med) < 0.11;
  if (!same) fail++;
  console.log(`${k.padEnd(9)} ${String(got.n).padStart(5)}  ${got.up.toFixed(1).padStart(6)}  ${got.avg.toFixed(1).padStart(6)}  ${got.med.toFixed(1).padStart(6)}   |  ${app ? `${app.n} / ${app.up} / ${app.avg} / ${app.med}` : '없음'} ${same ? '✔' : '✘'}`);
}
console.log(fail ? `\n${fail}개 구간이 앱 표시값과 다릅니다 — 엔진을 바꿨다면 앱의 EMPIRICAL_CRYPTO_1D를 갱신하세요.` : '\n앱 표시값과 일치');
process.exit(fail ? 1 : 0);
