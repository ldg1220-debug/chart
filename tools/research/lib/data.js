const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const key = t => new Date(t).toISOString().slice(0, 10);

function loadCoin(sym) {
  const f = path.join(DATA, sym + '.json');
  if (!fs.existsSync(f)) throw new Error(`${f} 없음 — 먼저 npm run research:data 를 실행하세요`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function listCoins() {
  if (!fs.existsSync(DATA)) return [];
  return fs.readdirSync(DATA).filter(f => /^[A-Z0-9]+\.json$/.test(f)).map(f => f.slice(0, -5));
}
// BTC 일봉 종가 > 200일선 (날짜별)
function btcRegimeMap() {
  const btc = loadCoin('BTC'), m = {};
  let s = 0;
  btc.forEach((b, i) => { s += b.close; if (i >= 200) s -= btc[i-200].close; if (i >= 199) m[key(b.t)] = {btcAbove: b.close > s / 200}; });
  return m;
}
module.exports = {DATA, key, loadCoin, listCoins, btcRegimeMap};
