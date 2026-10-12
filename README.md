# Chart Sentinel

AI 기반 금융 차트 분석 웹 애플리케이션. 주식/코인 종목 검색 또는 차트 이미지 업로드로 Claude AI 종합 분석 리포트를 생성합니다.

## 빠른 시작

### 1. 의존성 설치

```bash
pip install -r requirements.txt
```

### 2. 환경변수 설정

```bash
export ANTHROPIC_API_KEY="sk-ant-..."          # 필수
export FMP_API_KEY="..."                        # 선택 (뉴스 헤드라인)
export FRED_API_KEY="..."                       # 선택 (매크로 지표)
export TELEGRAM_BOT_TOKEN="..."                 # 선택 (알림)
export TELEGRAM_CHAT_ID="..."                   # 선택 (알림)
```

### 3. 서버 실행

```bash
uvicorn main:app --reload --port 8000
```

### 4. 브라우저 접속

`chart-sentinel.html` 파일을 브라우저에서 열거나 `http://localhost:8000` 에 접속하세요.

---

## 가장 쉬운 사용법 — 파일 하나 (Gemini 버전)

**`dist/chart-sentinel.html` 을 더블클릭해서 브라우저로 열면 끝입니다.** 설치·서버·인터넷 CDN이 필요 없습니다 (React 내장, 로딩 약 0.1초).

1. 첫 실행 시 뜨는 창에 **Google Gemini API 키**를 입력 (무료 발급: https://aistudio.google.com/apikey)
2. 종목(예: `AAPL`, `삼성전자`, `BTC`)을 검색하면 지표 점수·매매 플랜이 즉시 나오고, AI 해설이 뒤이어 붙습니다.

- 키는 사용 중인 브라우저의 localStorage에만 저장됩니다. 파일에 키를 넣어 공유하지 마세요.
- 데이터는 Binance / Yahoo Finance 등 외부 API를 브라우저에서 직접 호출하므로 인터넷 연결은 필요합니다.
- 백테스트 탭의 차트만 처음 실행할 때 Plotly를 내려받습니다.

### 나만 쓸 때: API 키를 파일에 내장하기

매번 키를 입력하기 싫다면 키가 박힌 개인용 파일을 만들 수 있습니다.

```bash
cd tools && npm install
echo "GOOGLE_API_KEY=여기에_키" > .env.local   # 이 파일은 git에서 제외됩니다
npm run build                                   # → dist/chart-sentinel.local.html
```

`dist/chart-sentinel.local.html`을 열면 키 입력 창 없이 바로 동작합니다. 이 파일은 `.gitignore` 대상이라 커밋되지 않지만, **파일 자체를 남에게 보내거나 공개 저장소·메신저에 올리면 키가 그대로 노출**됩니다. 공개용 `dist/chart-sentinel.html`에는 키가 들어가지 않습니다.

### 소스 수정 후 다시 만들기

`dist/chart-sentinel.html`은 `chart-sentinel-standalone.html`(원본, 수정은 여기서)을 빌드한 결과물입니다.

```bash
cd tools && npm install && npm run build   # → dist/chart-sentinel.html
```

---

## 독립 실행 (백엔드 없이)

`chart-sentinel.html`을 브라우저에서 직접 열면 Anthropic API를 브라우저에서 직접 호출합니다.
- API 키 입력 모달에서 Anthropic API 키를 입력
- 텍스트 기반 분석만 가능 (Plotly 차트, 이미지 분석은 백엔드 필요)
- 성과 로그는 `localStorage`에 자동 저장 (새로고침 후에도 유지)

---

## 기능 목록

| 기능 | 설명 | 필요 조건 |
|------|------|----------|
| 종목 검색 분석 | yfinance/CoinGecko → Plotly 차트 → Vision → Opus 리포트 | 백엔드 + ANTHROPIC_API_KEY |
| 이미지 업로드 분석 | 차트 이미지 → Vision → Opus 리포트 | 백엔드 + ANTHROPIC_API_KEY |
| 텍스트 직접 분석 | Anthropic API 직접 호출 | ANTHROPIC_API_KEY (브라우저) |
| 성과 추적 | W/L 마킹, 승률 통계, 확신도 추이 | 없음 (localStorage) |
| 워치리스트 모니터 | 60분 주기 자동 분석 + 텔레그램 알림 | 백엔드 + Telegram |
| 뉴스 감성 분석 | 최신 헤드라인 5건 통합 | FMP_API_KEY |
| 매크로 지표 | Fed Rate, VIX, 수익률 곡선, 유가 | FRED_API_KEY |

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/analyze-full?q=NVDA` | 전체 파이프라인 분석 |
| POST | `/api/analyze` | 이미지 업로드 분석 |
| POST | `/api/analyze-text` | 텍스트 데이터 분석 |
| GET | `/api/search?q=AAPL` | 종목 정보 조회 |
| GET | `/api/performance` | 승률 통계 조회 |
| POST | `/api/performance/update` | win/loss 업데이트 |
| GET | `/api/watchlist` | 워치리스트 조회 |
| POST | `/api/watchlist` | 종목 추가 |
| DELETE | `/api/watchlist/{ticker}` | 종목 제거 |
| POST | `/api/monitor/start` | 모니터 시작 |
| POST | `/api/monitor/stop` | 모니터 중지 |
| GET | `/api/macro` | 매크로 지표 조회 |
| GET | `/api/health` | 서버 상태 확인 |

---

## 파일 구조

```
chart/
├── main.py                 # FastAPI v4 백엔드
├── chart-sentinel.html     # 단일 HTML 프론트엔드
├── requirements.txt        # Python 의존성
├── README.md
├── analysis_logs.csv       # 자동 생성 — 분석 기록
└── watchlist.json          # 자동 생성 — 워치리스트
```

---

## 지원 종목

- **미국 주식**: AAPL, NVDA, TSLA, MSFT 등 yfinance 지원 티커
- **한국 주식**: 삼성전자, SK하이닉스, 현대차, 카카오, 네이버 등 한국어 입력 지원
- **암호화폐**: BTC, ETH, SOL, XRP, DOGE 등 CoinGecko 지원 코인
