// 사용법:  cd tools && npm install && npm run build
// 결과:    ../dist/chart-sentinel.html  (React 내장 · JSX 사전 컴파일 · CDN 불필요)
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'chart-sentinel-standalone.html');
const OUT  = path.join(ROOT, 'dist', 'chart-sentinel.html');
const nm   = p => fs.readFileSync(path.join(__dirname, 'node_modules', p), 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');   // 인라인 <script> 안전 처리

(async () => {
  let html = fs.readFileSync(SRC, 'utf8');

  // 1) CDN 스크립트 → 인라인 React (production)
  const cdn = [
    /<script src="https:\/\/unpkg\.com\/react@18\/umd\/react\.development\.js"><\/script>\n?/,
    /<script src="https:\/\/unpkg\.com\/react-dom@18\/umd\/react-dom\.development\.js"><\/script>\n?/,
    /<script src="https:\/\/unpkg\.com\/@babel\/standalone\/babel\.min\.js"><\/script>\n?/,
  ];
  cdn.forEach((re, i) => { if (!re.test(html)) throw new Error('CDN 태그를 찾지 못함: #' + i); });
  const react    = nm('react/umd/react.production.min.js');
  const reactDom = nm('react-dom/umd/react-dom.production.min.js');
  // 주의: 문자열 치환은 $& 등을 해석하므로 반드시 함수 치환자 사용
  html = html.replace(cdn[0], () => `<script>${safe(react)}</script>\n<script>${safe(reactDom)}</script>\n`)
             .replace(cdn[1], () => '').replace(cdn[2], () => '');

  // 2) text/babel → 컴파일 + 압축
  const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('text/babel 스크립트를 찾지 못함');
  const compiled = babel.transformSync(m[1], { presets: [require('@babel/preset-react')], filename: 'app.jsx', compact: false }).code;
  const min = await minify(compiled, { compress: true, mangle: true, format: { comments: false } });
  if (min.error) throw min.error;
  html = html.replace(m[0], () => `<script>${safe(min.code)}</script>`);

  // 3) 파비콘
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E";
  html = html.replace('<title>', () => `<link rel="icon" href="${icon}"/>\n<title>`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);   // 공개용: 키 없음

  // 개인용: GOOGLE_API_KEY 환경변수 또는 tools/.env.local 의 GOOGLE_API_KEY=... 가 있으면
  // 키가 내장된 dist/chart-sentinel.local.html 을 추가로 생성 (.gitignore 대상 → 커밋되지 않음)
  let key = (process.env.GOOGLE_API_KEY || '').trim();
  const envFile = path.join(__dirname, '.env.local');
  if (!key && fs.existsSync(envFile)) {
    const mm = fs.readFileSync(envFile, 'utf8').match(/^\s*GOOGLE_API_KEY\s*=\s*(.+?)\s*$/m);
    if (mm) key = mm[1].replace(/^["']|["']$/g, '');
  }
  if (key) {
    const slot = /GOOGLE_API_KEY:\s*'[^']*'/;
    if (!slot.test(html)) throw new Error('DEPLOY_CONFIG의 GOOGLE_API_KEY 자리를 찾지 못함');
    const localOut = path.join(ROOT, 'dist', 'chart-sentinel.local.html');
    fs.writeFileSync(localOut, html.replace(slot, () => `GOOGLE_API_KEY: '${key.replace(/'/g, "")}'`));
    console.log('built dist/chart-sentinel.local.html  (API 키 내장 · 개인용 · 공유/커밋 금지)');
  }
  const kb = f => (fs.statSync(f).size / 1024).toFixed(0) + ' KB';
  console.log(`built ${path.relative(ROOT, OUT)}  ${kb(OUT)}  (source ${kb(SRC)})`);
})().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
