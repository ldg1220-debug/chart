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
  const compiled = babel.transformSync(m[1], { presets: ['@babel/preset-react'], filename: 'app.jsx', compact: false }).code;
  const min = await minify(compiled, { compress: true, mangle: true, format: { comments: false } });
  if (min.error) throw min.error;
  html = html.replace(m[0], () => `<script>${safe(min.code)}</script>`);

  // 3) 파비콘
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E";
  html = html.replace('<title>', () => `<link rel="icon" href="${icon}"/>\n<title>`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  const kb = f => (fs.statSync(f).size / 1024).toFixed(0) + ' KB';
  console.log(`built ${path.relative(ROOT, OUT)}  ${kb(OUT)}  (source ${kb(SRC)})`);
})().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
