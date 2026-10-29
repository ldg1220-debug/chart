// 앱 원본(chart-sentinel-standalone.html)에서 판정 엔진 코드를 그대로 잘라 Node 모듈로 쓴다.
// 앱과 연구 도구가 항상 같은 엔진을 쓰도록, 복사본을 두지 않고 매번 원본에서 추출한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'chart-sentinel-standalone.html');
const OUT = path.join(__dirname, '..', '.cache', 'engine.generated.js');

function grab(src, startRe) {          // 선언 시작부터 짝이 맞는 닫는 괄호까지
  const m = src.match(startRe);
  if (!m) throw new Error('엔진 추출 실패: ' + startRe);
  let i = m.index, depth = 0, started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '[') { depth++; started = true; }
    else if (ch === '}' || ch === ']') { depth--; if (started && depth === 0) { i++; break; } }
  }
  if (src[i] === ';') i++;
  return src.slice(m.index, i);
}

function loadEngine() {
  const src = fs.readFileSync(SRC, 'utf8');
  const parts = [
    'const ls_get = (k, d) => d;',   // 브라우저 저장소 대체 (수수료 기본값 등)
    grab(src, /const TIMEFRAMES = \[/), grab(src, /function movingAverage\(/), grab(src, /function vwma\(/),
    grab(src, /function roundNumbers\(/), grab(src, /function bollingerBands\(/), grab(src, /function rsi\(/),
  ];
  const a = src.indexOf('// ─── Timeframe presets');
  const b = src.indexOf('function buildLocalReport(p1)');
  if (a < 0 || b < 0) throw new Error('엔진 구간 표식을 찾지 못함');
  parts.push(src.slice(a, src.indexOf('\n}\n', b) + 3));
  const names = ['TIMEFRAMES','TF_PRESETS','EMPIRICAL_CRYPTO_1D','GRADE_RULES','TRAIL_MULT','BT_WINDOW','computeTechIndicators',
    'decideStance','buildTrailPlan','buildPositionAdvice','prepareCandles','buildLocalReport','gradeLog','trailTrade',
    'summarizeGrades','verdictSampleAt','summarizeBacktest','simulateEquity','equityMetrics','netR','feeInR'];
  const exportsLine = `module.exports = {${names.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')}};`;
  fs.mkdirSync(path.dirname(OUT), {recursive: true});
  fs.writeFileSync(OUT, parts.join('\n\n') + '\n\n' + exportsLine + '\n');
  delete require.cache[require.resolve(OUT)];
  return require(OUT);
}

// 앱 화면에 하드코딩된 과거 성과 표(RULE_TRACK_RECORD)를 읽어 재현 검사에 쓴다
function loadTrackRecord() {
  const src = fs.readFileSync(SRC, 'utf8');
  const block = grab(src, /const RULE_TRACK_RECORD = \[/);
  return new Function(block + '\nreturn RULE_TRACK_RECORD;')();
}

module.exports = {loadEngine, loadTrackRecord, ROOT};
