/**
 * Chart Sentinel - Cloudflare Worker (Gemini API 프록시)
 *
 * [설정 방법 - 브라우저만으로, 터미널 불필요]
 * 1. cloudflare.com 가입 → Workers & Pages → Create Worker
 * 2. 이 코드 전체를 붙여넣기 → Deploy
 * 3. Worker 페이지 → Settings → Variables → Add variable
 *    이름: GOOGLE_API_KEY  /  값: AIzaSy...  /  [Encrypt] 체크
 * 4. Workers 도메인 주소를 HTML의 PROXY_URL에 붙여넣기
 *
 * 무료 한도: 100,000 요청/일 (개인 배포에 충분)
 */

// ─── 요청 제한 설정 ───────────────────────────────────────────────────────────
const RATE_LIMIT_PER_IP = 20;   // IP당 하루 최대 요청 수
const ALLOWED_ORIGINS   = [     // 허용할 도메인 (비워두면 모두 허용)
  // 'https://yoursite.com',
  // 'https://your-app.github.io',
];

// ─── IP별 요청 카운터 (Worker 메모리, 재시작 시 초기화) ──────────────────────
const requestCounts = new Map();

function getRateLimitKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `${ip}::${today}`;
}

function checkRateLimit(ip) {
  const key = getRateLimitKey(ip);
  const count = requestCounts.get(key) || 0;
  if (count >= RATE_LIMIT_PER_IP) return false;
  requestCounts.set(key, count + 1);
  return true;
}

// ─── CORS 헤더 ───────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.length === 0 ||
    ALLOWED_ORIGINS.includes(origin);

  return {
    'Access-Control-Allow-Origin':  allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    // API 키 확인 (Worker 환경변수)
    const apiKey = env.GOOGLE_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Server API key not configured' }),
        { status: 503, headers: { ...cors, 'content-type': 'application/json' } }
      );
    }

    // 요청 제한
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: `일일 요청 한도(${RATE_LIMIT_PER_IP}회)를 초과했습니다.` }),
        { status: 429, headers: { ...cors, 'content-type': 'application/json' } }
      );
    }

    // 요청 본문 파싱
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers: { ...cors, 'content-type': 'application/json' } }
      );
    }

    // model 추출 (body에서 받거나 기본값 사용)
    const model = body.model || 'gemini-2.5-flash';
    delete body.model; // Gemini API로 전달 시 model은 URL에만

    // Gemini API 호출
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const geminiResp = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const data = await geminiResp.json();
    return new Response(JSON.stringify(data), {
      status:  geminiResp.status,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  },
};
