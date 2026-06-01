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
