// 포트폴리오 워크포워드 시뮬레이터
//   node portfolio.js                 → 학습(2020~2022)·검증(2023~2026-10) 구간, 54종 10슬롯
//   node portfolio.js --coin BTC      → 단일 코인 전액 운용
//   node portfolio.js --period train  → 학습 구간만 (규칙을 고를 때는 이것만 보세요)
// 규칙: 종가 신호 → 다음 날 시가 체결, 손절은 장중 저가(갭이면 시가), 편도 비용 COST, 30일 평균 거래대금 MIN_QV 미만은 진입 안 함.
const fs = require('fs');
const path = require('path');
const {DATA, key, loadCoin, listCoins} = require('./lib/data');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const COST = +arg('cost', 0.0015), MIN_QV = 2e6;
const PERIODS = {train: ['학습', '2020-01-01', '2022-12-31'], test: ['검증', '2023-01-01', '2026-10-20']};

const featFile = path.join(DATA, 'feat_engine.json');
if (!fs.existsSync(featFile)) { console.error('data/feat_engine.json 없음 — 먼저 npm run research:precompute'); process.exit(1); }
const feat = JSON.parse(fs.readFileSync(featFile, 'utf8'));
const coins = {};
for (const c of listCoins()) {
  const bars = loadCoin(c), idx = {}; bars.forEach((b, i) => idx[key(b.t)] = i);
  const n = bars.length, cl = bars.map(b => b.close);
  const sma = p => { const o = Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += cl[i]; if (i >= p) s -= cl[i-p]; if (i >= p-1) o[i] = s / p; } return o; };
  const qv30 = Array(n).fill(null); { let s = 0; for (let i = 0; i < n; i++) { s += bars[i].qv; if (i >= 30) s -= bars[i-30].qv; if (i >= 29) qv30[i] = s / 30; } }
  const hh20 = Array(n).fill(null), ll10 = Array(n).fill(null);
  for (let i = 20; i < n; i++) { let h = -Infinity; for (let j = i - 20; j < i; j++) h = Math.max(h, bars[j].high); hh20[i] = h; }
  for (let i = 10; i < n; i++) { let l = Infinity; for (let j = i - 10; j < i; j++) l = Math.min(l, bars[j].low); ll10[i] = l; }
  const ef = {}; (feat[c] || []).forEach(r => ef[key(r[0])] = {score: r[1], stance: r[2], atr: r[3]});
  coins[c] = {bars, idx, ma50: sma(50), ma200: sma(200), qv30, hh20, ll10, ef};
}
const btc = coins.BTC, btcUp = {};
btc.bars.forEach((b, i) => { if (btc.ma200[i] != null) btcUp[key(b.t)] = b.close > btc.ma200[i]; });
const calendar = btc.bars.map(b => key(b.t));
const ret20 = (c, i) => i >= 20 ? coins[c].bars[i].close / coins[c].bars[i-20].close - 1 : 0;

function metrics(name, eq, extra = {}) {
  const rets = eq.slice(1).map((x, i) => x.v / eq[i].v - 1), fin = eq[eq.length-1].v / eq[0].v;
  let peak = 0, mdd = 0; eq.forEach(x => { peak = Math.max(peak, x.v); mdd = Math.min(mdd, x.v / peak - 1); });
  const m = rets.reduce((a,b)=>a+b,0) / rets.length, sd = Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0) / (rets.length-1));
  return {name, cagr: Math.pow(fin, 365 / eq.length) - 1, mdd, sharpe: sd ? m / sd * Math.sqrt(365) : 0, final: fin, ...extra};
}

function simulate(strat, from, to, opt = {}) {
  const K = opt.K || 10, UNIV = opt.universe ? new Set(opt.universe) : null;
  let cash = 1, pos = [], pend = [];
  const exitsNext = new Set(), eq = [], trades = [];
  const days = calendar.filter(d => d >= from && d <= to);
  const close = (p, px) => { cash += p.units * px * (1 - COST); trades.push({c: p.c, r: px * (1 - COST) / p.cost - 1}); };
  for (let di = 0; di < days.length; di++) {
    const d = days[di];
    pos = pos.filter(p => { if (!exitsNext.has(p.c)) return true; const x = coins[p.c], i = x.idx[d]; if (i == null) return true; close(p, x.bars[i].open); return false; });
    exitsNext.clear();
    for (const o of pend) {                                   // 시장가 진입 (다음 날 시가)
      const x = coins[o.c], i = x.idx[d]; if (i == null) continue;
      const fill = x.bars[i].open, alloc = Math.min(cash, o.alloc); if (alloc <= 0) continue;
      cash -= alloc;
      pos.push({c: o.c, units: alloc * (1 - COST) / fill, cost: fill / (1 - COST), hi: fill, fillDay: d,
                stop: strat.trail && o.atr ? fill - strat.trail * o.atr : null});
    }
    pend = [];
    pos = pos.filter(p => {                                   // 장중 손절
      const x = coins[p.c], i = x.idx[d]; if (i == null) return true;
      const b = x.bars[i];
      if (p.stop != null && b.low <= p.stop) { close(p, p.fillDay !== d && b.open < p.stop ? b.open : p.stop); return false; }
      return true;
    });
    let val = cash;
    pos = pos.filter(p => {                                   // 종가 평가 · 추적 손절 갱신 · 상장폐지 정리
      const x = coins[p.c], i = x.idx[d];
      if (i == null) { val += p.units * (p.last || 0); return true; }
      const b = x.bars[i]; p.last = b.close;
      if (i === x.bars.length - 1) { close(p, b.close); val += p.units * b.close * (1 - COST); return false; }
      if (strat.trail) { p.hi = Math.max(p.hi, b.close); const a = x.ef[d]?.atr; if (a) p.stop = Math.max(p.stop ?? -Infinity, p.hi - strat.trail * a); }
      val += p.units * b.close; return true;
    });
    eq.push({d, v: val});
    for (const p of pos) { const i = coins[p.c].idx[d]; if (i != null && strat.exitSignal && strat.exitSignal(p.c, i, d)) exitsNext.add(p.c); }
    const held = new Set(pos.map(p => p.c)), free = K - held.size;
    if (free > 0 && di < days.length - 1) {
      const cands = [];
      for (const c of Object.keys(coins)) {
        if (held.has(c) || (UNIV && !UNIV.has(c))) continue;
        const x = coins[c], i = x.idx[d];
        if (i == null || i >= x.bars.length - 1 || !(x.qv30[i] >= MIN_QV)) continue;
        const s = strat.signal(c, i, d); if (s != null) cands.push({c, s});
      }
      cands.sort((a, b) => b.s - a.s);
      for (const k of cands.slice(0, free)) pend.push({c: k.c, alloc: val / K, atr: coins[k.c].ef[d]?.atr});
    }
  }
  return metrics(strat.name, eq, {trades: trades.length, win: trades.length ? trades.filter(t => t.r > 0).length / trades.length : 0, tradeList: trades});
}

function benchHold(c, from, to, timing) {
  const x = coins[c], days = calendar.filter(d => d >= from && d <= to);
  let v = 1, inMkt = false; const eq = [];
  days.forEach((d, k) => {
    const i = x.idx[d], b = x.bars[i];
    const want = timing ? btcUp[k ? days[k-1] : d] : true;   // 전일 종가 신호
    if (want && !inMkt) { v *= (1 - COST) * b.close / b.open; inMkt = true; }
    else if (!want && inMkt) { v *= b.open / x.bars[i-1].close * (1 - COST); inMkt = false; }
    else if (inMkt && k > 0) v *= b.close / x.bars[i-1].close;
    eq.push({d, v});
  });
  return eq;
}
function benchEW(from, to) {                                    // 매월 초 유동성 통과 코인 동일비중
  const days = calendar.filter(d => d >= from && d <= to); let v = 1, w = {}; const eq = [];
  days.forEach((d, k) => {
    if (k === 0 || d.slice(8) === '01') {
      const prev = k ? days[k-1] : d;
      const avail = Object.keys(coins).filter(c => { const i = coins[c].idx[prev]; return i != null && i < coins[c].bars.length - 1 && coins[c].qv30[i] >= MIN_QV; });
      w = Object.fromEntries(avail.map(c => [c, 1 / avail.length])); v *= (1 - COST);
    }
    if (k > 0) { let r = 0; for (const [c, wt] of Object.entries(w)) { const x = coins[c], i = x.idx[d], j = x.idx[days[k-1]]; if (i != null && j != null) r += wt * (x.bars[i].close / x.bars[j].close - 1); } v *= 1 + r; }
    eq.push({d, v});
  });
  return eq;
}

const ef = (c, d) => coins[c].ef[d];
const isLong = (c, d) => { const e = ef(c, d); return e && e.stance === 'long' ? e.score : null; };
const STRATS = [
  {name: 'B1 현재 앱 규칙 (판정+3ATR 추적)', trail: 3, signal: (c, i, d) => isLong(c, d)},
  {name: 'B2 B1 + 판정 악화 시 청산', trail: 3, signal: (c, i, d) => isLong(c, d),
   exitSignal: (c, i, d) => { const e = ef(c, d); return e && (e.stance === 'avoid' || e.stance === 'bear'); }},
  {name: 'C 추세 (종가>MA50>MA200)', signal: (c, i, d) => { const x = coins[c]; return x.ma200[i] != null && x.bars[i].close > x.ma50[i] && x.ma50[i] > x.ma200[i] && btcUp[d] ? ret20(c, i) : null; },
   exitSignal: (c, i) => coins[c].bars[i].close < coins[c].ma50[i]},
  {name: 'D 20일 돌파 / 10일 이탈', signal: (c, i, d) => { const x = coins[c]; return x.hh20[i] != null && x.bars[i].close > x.hh20[i] && btcUp[d] ? ret20(c, i) : null; },
   exitSignal: (c, i) => { const x = coins[c]; return x.ll10[i] != null && x.bars[i].close < x.ll10[i]; }},
];
module.exports = {simulate, STRATS, benchHold, benchEW, metrics, coins, PERIODS};

if (require.main === module) {
  const fmt = r => `${r.name.padEnd(30)} 연수익 ${(r.cagr*100).toFixed(1).padStart(6)}% | 최대낙폭 ${(r.mdd*100).toFixed(1).padStart(6)}% | 샤프 ${r.sharpe.toFixed(2).padStart(5)} | ${r.final.toFixed(2).padStart(5)}배${r.trades != null ? ` | 거래 ${r.trades} 승률 ${(r.win*100).toFixed(0)}%` : ''}`;
  const coin = arg('coin', null)?.toUpperCase(), which = arg('period', 'both');
  for (const [k, [lab, from, to]] of Object.entries(PERIODS)) {
    if (which !== 'both' && which !== k) continue;
    console.log(`\n[${lab} ${from} ~ ${to}] 편도 비용 ${(COST*100).toFixed(2)}% · ${coin ? coin + ' 단일 (전액)' : `${Object.keys(coins).length}종 · 10슬롯`}`);
    if (coin) {
      console.log('  ' + fmt(metrics(`${coin} 그냥 보유`, benchHold(coin, from, to, false))));
      for (const s of STRATS) console.log('  ' + fmt(simulate(s, from, to, {K: 1, universe: [coin]})));
    } else {
      console.log('  ' + fmt(metrics('BTC 그냥 보유', benchHold('BTC', from, to, false))));
      console.log('  ' + fmt(metrics('BTC 200일선 타이밍', benchHold('BTC', from, to, true))));
      console.log('  ' + fmt(metrics('코인 동일비중 보유', benchEW(from, to))));
      for (const s of STRATS) console.log('  ' + fmt(simulate(s, from, to)));
    }
  }
}
