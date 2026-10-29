// 검증용 일봉 데이터 받기 (Binance 공개 데이터 미러, 키 불필요)
//   node fetch-data.js            → 54종 유니버스 전체
//   node fetch-data.js BTC ETH    → 지정한 코인만
// 생존 편향을 줄이기 위해 2020~2021년에 거래가 많았던 코인을 "지금 살아있는지와 무관하게" 포함한다
// (WAVES, SRM, MULTI, FTT, LUNA 등 상장폐지·폭락 코인 포함).
// 프록시 환경이면 NODE_USE_ENV_PROXY=1 과 HTTPS_PROXY 를 설정해 실행하세요.
const fs = require('fs');
const path = require('path');
const {DATA} = require('./lib/data');

const UNIVERSE = ('BTC ETH BNB XRP ADA DOGE SOL DOT LINK LTC BCH EOS TRX XLM ATOM VET THETA FIL UNI AAVE MATIC FTM AVAX ' +
  'ALGO NEO IOTA ETC ZEC DASH XTZ WAVES OMG KNC ZIL ICX ONT QTUM BAT ENJ SNX COMP MKR CRV SUSHI YFI SRM FTT KLAY BTS ANT ' +
  'REEF XEM MULTI LUNA').split(' ');
const BASE = 'https://data-api.binance.vision/api/v3/klines';
const START = Date.UTC(2019, 0, 1);

async function fetchAll(sym) {
  let start = START, rows = [];
  for (;;) {
    const r = await fetch(`${BASE}?symbol=${sym}USDT&interval=1d&limit=1000&startTime=${start}`);
    if (!r.ok) { if (rows.length) break; throw new Error(`HTTP ${r.status}`); }
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    rows = rows.concat(d);
    start = d[d.length - 1][0] + 1;
    if (d.length < 1000) break;
  }
  const now = Date.now();
  rows = rows.filter(k => k[6] < now);                         // 완성된 캔들만
  // 5일 넘는 공백(상장폐지 후 같은 심볼 재사용 등)이 있으면 공백 이전까지만 사용 → 폭락·상장폐지가 그대로 반영됨
  let cut = rows.length;
  for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i-1][0] > 5 * 864e5) { cut = i; break; }
  return rows.slice(0, cut).map(k => ({t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], qv: +k[7]}));
}

(async () => {
  const list = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toUpperCase()) : UNIVERSE;
  fs.mkdirSync(DATA, {recursive: true});
  const queue = [...list]; let ok = 0;
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const bars = await fetchAll(s);
        if (bars.length < 400) { console.log(`${s.padEnd(6)} 건너뜀 (${bars.length}봉)`); continue; }
        fs.writeFileSync(path.join(DATA, s + '.json'), JSON.stringify(bars));
        ok++;
        console.log(`${s.padEnd(6)} ${bars.length}봉  ${new Date(bars[0].t).toISOString().slice(0,10)} ~ ${new Date(bars[bars.length-1].t).toISOString().slice(0,10)}`);
      } catch (e) { console.log(`${s.padEnd(6)} 실패: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({length: 6}, worker));
  console.log(`완료: ${ok}/${list.length}종 → ${DATA}`);
})();
