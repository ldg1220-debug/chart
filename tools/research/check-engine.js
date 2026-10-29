// 엔진 검사: 앱을 고친 뒤 실행하세요.
//   node check-engine.js          → 단위 테스트 + (데이터가 있으면) 앱 화면의 과거 성과 표 재현 검사
//   node check-engine.js --full   → + 54종 포트폴리오 행까지 재현 (1~2분)
const {loadEngine, loadTrackRecord} = require('./lib/engine');
const {key, loadCoin, listCoins, btcRegimeMap} = require('./lib/data');
const E = loadEngine();
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  ✘ ' + m); fail++; } else console.log('  ✔ ' + m); };

console.log('[1] 엔진 단위 테스트 (합성 데이터)');
function series(n, drift, vol = 0.02, seed = 1) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const o = p, c = o * (1 + drift + (rnd() - 0.5) * vol); out.push({t: i * 864e5, open: o, high: Math.max(o, c) * (1 + rnd() * vol / 2), low: Math.min(o, c) * (1 - rnd() * vol / 2), close: c, volume: 1000 * (1 + rnd())}); p = c; }
  return out;
}
const up = E.computeTechIndicators(series(260, 0.004), {tf: '1d'}), dn = E.computeTechIndicators(series(260, -0.004), {tf: '1d'});
ok(up.score > 25 && up.verdict.stance === 'long', `상승 추세 → 롱 (점수 ${up.score})`);
ok(dn.score < 0 && dn.verdict.stance !== 'long', `하락 추세 → 롱 아님 (점수 ${dn.score}, ${dn.verdict.stance})`);
ok(E.computeTechIndicators(series(260, 0.004), {tf: '1d', regime: {btcAbove: false}}).verdict.stance === 'bear', 'BTC 200일선 아래면 롱 → 하락장 필터');
const p = up.tradePlan;
ok(p.planType === 'trail' && Math.abs(p.entry1 - p.stopLoss - 3 * up.atr) < 1e-9, '플랜: 진입 = 현재가, 초기 손절 = −3 ATR');

console.log('[2] 추적 손절 채점 (손계산 대조)');
const bar = (o, h, l, c) => ({open: o, high: h, low: l, close: c});
const L = {price: 100, entry: 100, stop: 94, planType: 'trail', atr: 2, trailMult: 3, stance: 'long'};
const t1 = E.gradeLog(L, [bar(100,102,99,101), bar(101,106,100,105), bar(105,111,104,110), bar(110,110,100,104)]).trade;
const expR = (110 - 3 * ((((2*13+3)/14*13+6)/14*13+7)/14) - 100) / 6;    // ATR 2→2.071→2.352→2.684
ok(t1.state === 'exit' && Math.abs(t1.R - expR) < 1e-9 && t1.bars === 3, `추적 청산 R ${t1.R?.toFixed(4)} = 손계산 ${expR.toFixed(4)}`);
ok(Math.abs(E.gradeLog(L, [bar(100,101,99,100), bar(99,100,93,95)]).trade.R + 1) < 1e-9, '초기 손절 R = −1');
ok(Math.abs(E.gradeLog(L, [bar(100,101,99,100), bar(90,91,88,89)]).trade.R - (-10/6)) < 1e-9, '갭 하락은 시가 체결');
ok(E.gradeLog(L, [bar(100,102,99,101)]).trade.state === 'open', '손절 전이면 진행 중');

// 랜덤워크: 추세가 없으면 "항상 진입"은 0R 근처여야 함 (채점기 편향 검사)
let seed = 99; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const rw = [];
for (let w = 0; w < 10; w++) {
  let pr = 100; const bars = [];
  for (let i = 0; i < 900; i++) { const o = pr, c = o * Math.exp(0.03 * g()); bars.push({t: i * 864e5, open: o, high: Math.max(o, c) * Math.exp(Math.abs(0.012 * g())), low: Math.min(o, c) * Math.exp(-Math.abs(0.012 * g())), close: c, volume: 1000 * (1 + rnd())}); pr = c; }
  const S = []; for (let t = 364; t < bars.length - 21; t += 5) S.push(E.verdictSampleAt(bars, t, {tf: '1d', window: 365, regimeAt: null}));
  rw.push(E.summarizeBacktest(S, 5, 0).always.avgR);
}
const rwm = rw.reduce((a, b) => a + b, 0) / rw.length;
ok(Math.abs(rwm) < 0.15, `랜덤워크 10개 "항상 진입" 평균 ${rwm.toFixed(3)}R (0 근처)`);

const coins = listCoins();
if (!coins.includes('BTC')) { console.log('\n[3] 건너뜀 — 데이터 없음 (npm run research:data)'); }
else {
  console.log('[3] 앱 화면 "과거 성과" 표 재현 (앱 엔진 simulateEquity, 편도 0.15%)');
  const TR = loadTrackRecord(), reg = btcRegimeMap();
  const P = {train: ['2020-01-01', '2022-12-31'], test: ['2023-01-01', '2026-10-20']};
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  for (const c of ['BTC', 'ETH'].filter(x => coins.includes(x))) {
    const bars = loadCoin(c), all = [];
    for (let t = 364; t < bars.length; t++) all.push(E.verdictSampleAt(bars, t, {tf: '1d', window: 365, regimeAt: x => reg[key(x)] || null}));
    const row = TR.find(r => r.label === `${c}에 이 규칙 적용`), hold = TR.find(r => r.label === `${c} 그냥 보유`);
    for (const [k, [from, to]] of Object.entries(P)) {
      const prev = key(new Date(from).getTime() - 864e5);
      const r = E.simulateEquity(bars, all.filter(s => key(s.t) >= prev && key(s.t) <= to), 0.0015, 365);
      const got = [r.strat.cagr * 100, r.strat.mdd * 100, r.strat.sharpe], gotH = [r.hold.cagr * 100, r.hold.mdd * 100, r.hold.sharpe];
      ok(near(got[0], row[k][0], 0.15) && near(got[1], row[k][1], 0.15) && near(got[2], row[k][2], 0.01),
         `${c} 규칙 ${k}: 계산 ${got[0].toFixed(1)}% / ${got[1].toFixed(1)}% / ${got[2].toFixed(2)} vs 화면 ${row[k].join(' / ')}`);
      ok(near(gotH[0], hold[k][0], 0.6) && near(gotH[1], hold[k][1], 0.6),
         `${c} 보유 ${k}: 계산 ${gotH[0].toFixed(1)}% / ${gotH[1].toFixed(1)}% vs 화면 ${hold[k].slice(0, 2).join(' / ')}`);
    }
  }
  if (process.argv.includes('--full')) {
    console.log('[4] 54종 포트폴리오 행 재현 (portfolio.js)');
    const PF = require('./portfolio.js');
    const rule = TR.find(r => r.label.startsWith('코인 54종')), ew = TR.find(r => r.label.startsWith('코인 동일비중'));
    for (const [k, [from, to]] of Object.entries(P)) {
      const a = PF.simulate(PF.STRATS[0], from, to), b = PF.metrics('ew', PF.benchEW(from, to));
      ok(near(a.cagr * 100, rule[k][0], 0.15) && near(a.sharpe, rule[k][2], 0.01), `규칙 ${k}: ${(a.cagr*100).toFixed(1)}% / 샤프 ${a.sharpe.toFixed(2)} vs 화면 ${rule[k][0]} / ${rule[k][2]}`);
      ok(near(b.cagr * 100, ew[k][0], 0.15) && near(b.sharpe, ew[k][2], 0.01), `동일비중 ${k}: ${(b.cagr*100).toFixed(1)}% / 샤프 ${b.sharpe.toFixed(2)} vs 화면 ${ew[k][0]} / ${ew[k][2]}`);
    }
  }
}
console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
