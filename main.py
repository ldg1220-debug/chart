import asyncio
import base64
import csv
import json
import os
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
import pandas as pd
import plotly.graph_objects as go
import yfinance as yf
from anthropic import AsyncAnthropic
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from plotly.subplots import make_subplots
from pydantic import BaseModel

# ── 환경변수 ──────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY", "")
FMP_API_KEY        = os.getenv("FMP_API_KEY", "")
FRED_API_KEY       = os.getenv("FRED_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

SONNET_MODEL = "claude-sonnet-4-20250514"
OPUS_MODEL   = "claude-opus-4-20250514"

LOG_FILE      = Path("analysis_logs.csv")
WATCHLIST_FILE = Path("watchlist.json")
LOG_COLUMNS   = ["id", "timestamp", "ticker", "name", "position", "confidence",
                 "entry_zone", "stop_loss", "target_prices", "current_price",
                 "timeframe", "result"]

executor = ThreadPoolExecutor(max_workers=4)

# ── 티커 매핑 ─────────────────────────────────────────────────────────────────
KR_TICKER_MAP = {
    "삼성전자": "005930.KS", "삼성": "005930.KS",
    "sk하이닉스": "000660.KS", "하이닉스": "000660.KS",
    "현대차": "005380.KS", "현대자동차": "005380.KS",
    "카카오": "035720.KS",
    "네이버": "035420.KS", "naver": "035420.KS",
    "lg에너지솔루션": "373220.KS",
    "셀트리온": "068270.KS",
    "삼성바이오로직스": "207940.KS",
    "기아": "000270.KS", "기아차": "000270.KS",
    "포스코": "005490.KS",
    "kb금융": "105560.KS",
}

CRYPTO_MAP = {
    "bitcoin": "bitcoin", "btc": "bitcoin", "비트코인": "bitcoin",
    "ethereum": "ethereum", "eth": "ethereum", "이더리움": "ethereum",
    "solana": "solana", "sol": "solana", "솔라나": "solana",
    "ripple": "ripple", "xrp": "ripple", "리플": "ripple",
    "bnb": "binancecoin", "binancecoin": "binancecoin",
    "dogecoin": "dogecoin", "doge": "dogecoin", "도지": "dogecoin",
    "cardano": "cardano", "ada": "cardano",
    "avalanche": "avalanche-2", "avax": "avalanche-2",
    "polygon": "matic-network", "matic": "matic-network",
}

def resolve_ticker(query: str) -> tuple[str, str]:
    """(ticker_or_coin_id, asset_type)  asset_type: 'stock' | 'crypto'"""
    q = query.strip().lower()
    if q in KR_TICKER_MAP:
        return KR_TICKER_MAP[q], "stock"
    if q in CRYPTO_MAP:
        return CRYPTO_MAP[q], "crypto"
    # 대소문자 원형 유지
    q_orig = query.strip().upper()
    if q_orig in {k.upper() for k in CRYPTO_MAP}:
        return CRYPTO_MAP[q], "crypto"
    return query.strip().upper(), "stock"


# ── 데이터 수집 ───────────────────────────────────────────────────────────────
async def _run_in_executor(fn, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, fn, *args)


def _fetch_yf(ticker: str, period: str) -> pd.DataFrame:
    ticker_obj = yf.Ticker(ticker)
    df = ticker_obj.history(period=period)
    return df


async def fetch_stock_data(ticker: str, period: str = "3mo") -> pd.DataFrame:
    last_exc: Exception = Exception("Unknown error")
    for attempt in range(3):
        try:
            df = await _run_in_executor(_fetch_yf, ticker, period)
            if df is None or df.empty:
                raise ValueError(f"No data returned for {ticker}")
            return df
        except Exception as e:
            last_exc = e
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    raise HTTPException(status_code=502, detail=f"Failed to fetch data for {ticker}: {last_exc}")


async def fetch_crypto_ohlcv(coin_id: str, days: int = 90) -> pd.DataFrame:
    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/ohlc"
    params = {"vs_currency": "usd", "days": days}
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"CoinGecko error: {e}")
    rows = [{"Date": datetime.fromtimestamp(r[0] / 1000),
             "Open": r[1], "High": r[2], "Low": r[3], "Close": r[4]} for r in data]
    df = pd.DataFrame(rows).set_index("Date")
    df["Volume"] = 0
    return df


async def fetch_crypto_price(coin_id: str) -> float:
    url = f"https://api.coingecko.com/api/v3/simple/price"
    params = {"ids": coin_id, "vs_currencies": "usd"}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            return resp.json().get(coin_id, {}).get("usd", 0.0)
        except Exception:
            return 0.0


async def fetch_news(ticker: str) -> tuple[list[dict], str]:
    if not FMP_API_KEY:
        return [], ""
    url = "https://financialmodelingprep.com/api/v3/stock_news"
    params = {"tickers": ticker, "limit": 5, "apikey": FMP_API_KEY}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            items = resp.json()
            news = [{"title": n.get("title", ""), "text": n.get("text", "")[:200]}
                    for n in items[:5]]
            return news, ""
        except Exception as e:
            return [], str(e)


async def _fetch_fred_series(series_id: str, client: httpx.AsyncClient) -> tuple[str, Optional[float]]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    if FRED_API_KEY:
        url = (f"https://api.stlouisfed.org/fred/series/observations"
               f"?series_id={series_id}&api_key={FRED_API_KEY}&file_type=json&limit=1&sort_order=desc")
    try:
        resp = await client.get(url, timeout=10)
        resp.raise_for_status()
        if FRED_API_KEY:
            obs = resp.json().get("observations", [])
            val = float(obs[-1]["value"]) if obs and obs[-1]["value"] != "." else None
        else:
            lines = resp.text.strip().split("\n")
            last = lines[-1].split(",")
            val = float(last[1]) if len(last) > 1 and last[1] not in (".", "") else None
        return series_id, val
    except Exception:
        return series_id, None


async def fetch_macro() -> tuple[dict, str]:
    series_ids = ["DFF", "T10Y2Y", "VIXCLS", "DCOILWTICO"]
    labels = {"DFF": "fed_funds_rate", "T10Y2Y": "yield_curve",
              "VIXCLS": "vix", "DCOILWTICO": "oil_price"}
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            results = await asyncio.gather(
                *[_fetch_fred_series(sid, client) for sid in series_ids],
                return_exceptions=True,
            )
            macro = {}
            for r in results:
                if isinstance(r, tuple):
                    sid, val = r
                    macro[labels.get(sid, sid)] = val
            return macro, ""
        except Exception as e:
            return {}, str(e)


# ── 차트 생성 ─────────────────────────────────────────────────────────────────
def _build_chart(df: pd.DataFrame, ticker: str) -> bytes:
    df = df.copy()
    df.index = pd.to_datetime(df.index)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    close = df["Close"].squeeze()
    ma20  = close.rolling(20).mean()
    ma60  = close.rolling(60).mean()
    upper = close.rolling(20).mean() + 2 * close.rolling(20).std()
    lower = close.rolling(20).mean() - 2 * close.rolling(20).std()

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True,
        row_heights=[0.75, 0.25],
        vertical_spacing=0.03,
    )

    fig.add_trace(go.Candlestick(
        x=df.index, open=df["Open"].squeeze(),
        high=df["High"].squeeze(), low=df["Low"].squeeze(), close=close,
        name=ticker,
        increasing_line_color="#22c55e", decreasing_line_color="#ef4444",
    ), row=1, col=1)

    fig.add_trace(go.Scatter(x=df.index, y=ma20,  name="MA20",  line=dict(color="#f59e0b", width=1)), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=ma60,  name="MA60",  line=dict(color="#3b82f6", width=1)), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=upper, name="BB Upper", line=dict(color="#8b949e", width=1, dash="dot")), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=lower, name="BB Lower", line=dict(color="#8b949e", width=1, dash="dot"),
                             fill="tonexty", fillcolor="rgba(139,148,158,0.05)"), row=1, col=1)

    volume = df["Volume"].squeeze() if "Volume" in df.columns else pd.Series(0, index=df.index)
    colors = ["#22c55e" if c >= o else "#ef4444"
              for c, o in zip(df["Close"].squeeze(), df["Open"].squeeze())]
    fig.add_trace(go.Bar(x=df.index, y=volume, name="Volume",
                         marker_color=colors, opacity=0.7), row=2, col=1)

    fig.update_layout(
        title=dict(text=f"{ticker} — 기술적 분석 차트", font=dict(color="#e6edf3")),
        paper_bgcolor="#0d1117", plot_bgcolor="#0d1117",
        font=dict(color="#8b949e"),
        xaxis_rangeslider_visible=False,
        legend=dict(bgcolor="#161b22", bordercolor="#30363d", borderwidth=1),
        height=700, width=1200,
        margin=dict(l=40, r=40, t=60, b=40),
    )
    fig.update_xaxes(gridcolor="#21262d", zerolinecolor="#30363d")
    fig.update_yaxes(gridcolor="#21262d", zerolinecolor="#30363d")

    img_bytes = fig.to_image(format="png")
    return img_bytes


async def generate_chart(df: pd.DataFrame, ticker: str) -> bytes:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _build_chart, df, ticker)


# ── AI 분석 ───────────────────────────────────────────────────────────────────
VISION_PROMPT = """당신은 전문 기술적 분석가입니다. 제공된 주식/코인 차트를 분석하고 아래 항목을 한국어로 상세히 설명하세요:

1. 추세 방향 (상승/하락/횡보) 및 강도
2. 주요 지지선과 저항선 (가격 수준 명시)
3. 이동평균선 분석 (MA20, MA60 크로스, 배열)
4. 볼린저 밴드 상태 (수축/확장, 현재 위치)
5. 거래량 분석 (추세 확인 여부)
6. 차트 패턴 (있다면: 헤드앤숄더, 이중바닥, 삼각형 등)
7. 단기 전망 요약 (1-2문장)"""

REPORT_PROMPT_TEMPLATE = """당신은 전문 금융 분석가입니다. 아래 정보를 바탕으로 종합 투자 분석 리포트를 JSON 형식으로 작성하세요.

## 기술적 분석 결과
{vision_text}

## 최신 뉴스
{news_text}

## 매크로 지표
{macro_text}

## 종목 정보
- 티커: {ticker}
- 현재가: {current_price}

아래 JSON 스키마를 정확히 따라 응답하세요. JSON 외 다른 텍스트는 출력하지 마세요:

{{
  "ticker": "{ticker}",
  "name": "종목명",
  "timeframe": "일봉",
  "current_price": "{current_price}",
  "technical_analysis": {{
    "trend": "추세 방향과 강도",
    "support": "주요 지지선",
    "resistance": "주요 저항선",
    "indicators": "지표 분석",
    "pattern": "차트 패턴",
    "summary": "기술적 분석 요약"
  }},
  "fundamental_analysis": {{
    "news_sentiment": "뉴스 감성 (긍정/부정/중립)",
    "key_catalysts": "주요 촉매 요인",
    "macro_impact": "매크로 영향",
    "summary": "기본적 분석 요약"
  }},
  "strategy": {{
    "position": "매수 또는 매도 또는 관망",
    "entry_zone": "진입 구간",
    "stop_loss": "손절 기준",
    "target_prices": ["1차 목표가", "2차 목표가"],
    "risk_reward": "리스크/리워드 비율",
    "confidence": 7,
    "rationale": "전략 근거"
  }}
}}"""


async def analyze_chart_vision(img_bytes: bytes, api_key: str = "") -> str:
    key = api_key or ANTHROPIC_API_KEY
    if not key:
        return "Vision 분석 불가 (API 키 없음)"
    client = AsyncAnthropic(api_key=key)
    img_b64 = base64.standard_b64encode(img_bytes).decode()
    message = await client.messages.create(
        model=SONNET_MODEL,
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}},
                {"type": "text", "text": VISION_PROMPT},
            ],
        }],
    )
    return message.content[0].text


async def generate_report(
    vision_text: str, news: list[dict], macro: dict,
    ticker: str, current_price: str, api_key: str = "",
) -> dict:
    key = api_key or ANTHROPIC_API_KEY
    if not key:
        raise HTTPException(status_code=401, detail="API 키가 필요합니다")
    client = AsyncAnthropic(api_key=key)

    news_text = "\n".join(f"- {n['title']}" for n in news) if news else "뉴스 데이터 없음"
    macro_text = (
        f"- Fed Funds Rate: {macro.get('fed_funds_rate', 'N/A')}%\n"
        f"- 수익률 곡선 (10Y-2Y): {macro.get('yield_curve', 'N/A')}\n"
        f"- VIX: {macro.get('vix', 'N/A')}\n"
        f"- WTI 유가: {macro.get('oil_price', 'N/A')}"
    )

    prompt = REPORT_PROMPT_TEMPLATE.format(
        vision_text=vision_text, news_text=news_text, macro_text=macro_text,
        ticker=ticker, current_price=current_price,
    )

    for attempt in range(2):
        message = await client.messages.create(
            model=OPUS_MODEL,
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        # JSON 블록 추출
        if "```" in raw:
            raw = raw.split("```json")[-1].split("```")[0].strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 1:
                return _fallback_report(ticker, current_price)
    return _fallback_report(ticker, current_price)


def _fallback_report(ticker: str, current_price: str) -> dict:
    return {
        "ticker": ticker, "name": ticker, "timeframe": "일봉",
        "current_price": current_price,
        "technical_analysis": {"trend": "분석 불가", "support": "-", "resistance": "-",
                                "indicators": "-", "pattern": "-", "summary": "JSON 파싱 실패"},
        "fundamental_analysis": {"news_sentiment": "중립", "key_catalysts": "-",
                                  "macro_impact": "-", "summary": "-"},
        "strategy": {"position": "관망", "entry_zone": "-", "stop_loss": "-",
                     "target_prices": ["-", "-"], "risk_reward": "-",
                     "confidence": 5, "rationale": "분석 오류로 인한 기본값"},
    }


# ── Telegram 알림 ─────────────────────────────────────────────────────────────
async def send_telegram_alert(report: dict) -> None:
    if not (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID):
        return
    strategy = report.get("strategy", {})
    position   = strategy.get("position", "")
    confidence = strategy.get("confidence", 0)
    if str(position).lower() not in ("매수", "buy", "long"):
        return
    try:
        confidence = int(confidence)
    except (ValueError, TypeError):
        confidence = 0
    if confidence < 7:
        return

    text = (
        f"🚨 *Chart Sentinel Alert*\n\n"
        f"📊 *{report.get('ticker')}* — {report.get('name')}\n"
        f"💰 현재가: {report.get('current_price')}\n"
        f"🎯 *{position}* 신호 | 확신도: *{confidence}/10*\n\n"
        f"진입: {strategy.get('entry_zone', '-')}\n"
        f"목표: {', '.join(strategy.get('target_prices', ['-']))}\n"
        f"손절: {strategy.get('stop_loss', '-')}\n"
        f"R/R: {strategy.get('risk_reward', '-')}"
    )
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "Markdown"})
        except Exception:
            pass


# ── CSV 성과 로깅 ──────────────────────────────────────────────────────────────
_csv_lock = asyncio.Lock()


def _ensure_log_file():
    if not LOG_FILE.exists():
        with open(LOG_FILE, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=LOG_COLUMNS).writeheader()


def append_analysis_log(report: dict) -> None:
    _ensure_log_file()
    strategy = report.get("strategy", {})
    row = {
        "id": str(datetime.utcnow().timestamp()),
        "timestamp": datetime.utcnow().isoformat(),
        "ticker": report.get("ticker", ""),
        "name": report.get("name", ""),
        "position": strategy.get("position", ""),
        "confidence": strategy.get("confidence", ""),
        "entry_zone": strategy.get("entry_zone", ""),
        "stop_loss": strategy.get("stop_loss", ""),
        "target_prices": json.dumps(strategy.get("target_prices", []), ensure_ascii=False),
        "current_price": report.get("current_price", ""),
        "timeframe": report.get("timeframe", ""),
        "result": "pending",
    }
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=LOG_COLUMNS).writerow(row)


async def get_performance_stats() -> dict:
    _ensure_log_file()
    async with _csv_lock:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))

    total = len(rows)
    evaluated = [r for r in rows if r.get("result") in ("win", "loss")]
    wins  = sum(1 for r in evaluated if r.get("result") == "win")
    win_rate = round(wins / len(evaluated) * 100, 1) if evaluated else 0.0

    positions: dict[str, dict] = {}
    confidences = []
    for r in rows:
        p = r.get("position", "기타")
        positions.setdefault(p, {"count": 0, "wins": 0})
        positions[p]["count"] += 1
        if r.get("result") == "win":
            positions[p]["wins"] += 1
        try:
            confidences.append(float(r.get("confidence", 0) or 0))
        except (ValueError, TypeError):
            pass

    avg_confidence = round(sum(confidences) / len(confidences), 1) if confidences else 0.0
    recent = rows[-20:][::-1]

    return {
        "total": total,
        "evaluated": len(evaluated),
        "wins": wins,
        "losses": len(evaluated) - wins,
        "win_rate": win_rate,
        "avg_confidence": avg_confidence,
        "positions": positions,
        "recent": recent,
    }


async def update_log_result(log_id: str, result: str) -> bool:
    _ensure_log_file()
    async with _csv_lock:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        updated = False
        for r in rows:
            if r.get("id") == log_id or r.get("timestamp") == log_id:
                r["result"] = result
                updated = True
        if updated:
            with open(LOG_FILE, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=LOG_COLUMNS)
                w.writeheader()
                w.writerows(rows)
    return updated


# ── 워치리스트 & 모니터 ───────────────────────────────────────────────────────
watchlist_data: list[dict] = []
monitor_tasks: dict[str, asyncio.Task] = {}


def _load_watchlist():
    global watchlist_data
    if WATCHLIST_FILE.exists():
        try:
            watchlist_data = json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
        except Exception:
            watchlist_data = []


def _save_watchlist():
    WATCHLIST_FILE.write_text(json.dumps(watchlist_data, ensure_ascii=False, indent=2), encoding="utf-8")


# ── FastAPI 앱 ────────────────────────────────────────────────────────────────
app = FastAPI(title="Chart Sentinel API", version="4.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    _ensure_log_file()
    _load_watchlist()


# ── Pydantic 모델 ─────────────────────────────────────────────────────────────
class TextAnalysisRequest(BaseModel):
    ticker: str
    price_data: Optional[str] = ""
    notes: Optional[str] = ""
    api_key: Optional[str] = ""


class PerformanceUpdateRequest(BaseModel):
    log_id: str
    result: str  # "win" | "loss"


class WatchlistItem(BaseModel):
    ticker: str
    name: Optional[str] = ""


class MonitorRequest(BaseModel):
    interval_minutes: Optional[int] = 60


class MonitorStopRequest(BaseModel):
    ticker: Optional[str] = ""


# ── 엔드포인트 ─────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "anthropic_key": bool(ANTHROPIC_API_KEY),
        "fmp_key": bool(FMP_API_KEY),
        "fred_key": bool(FRED_API_KEY),
        "telegram": bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID),
    }


@app.get("/api/analyze-full")
async def analyze_full(q: str = Query(..., description="종목 검색어 (한글/영문/코인)")):
    ticker, asset_type = resolve_ticker(q)

    # 1. 가격 데이터
    if asset_type == "crypto":
        df = await fetch_crypto_ohlcv(ticker)
        current_price = str(await fetch_crypto_price(ticker))
    else:
        df = await fetch_stock_data(ticker)
        try:
            cp = df["Close"].squeeze().iloc[-1]
            current_price = f"{cp:,.2f}"
        except Exception:
            current_price = "N/A"

    # 2. 병렬 수집
    chart_task  = generate_chart(df, ticker)
    news_task   = fetch_news(ticker)
    macro_task  = fetch_macro()

    img_bytes, (news_list, _), (macro_data, _) = await asyncio.gather(
        chart_task, news_task, macro_task,
    )

    # 3. Vision 분석
    vision_text = await analyze_chart_vision(img_bytes)

    # 4. Opus 리포트
    report = await generate_report(vision_text, news_list, macro_data, ticker, current_price)

    # 5. 로깅
    try:
        append_analysis_log(report)
    except Exception:
        pass

    # 6. Telegram
    asyncio.create_task(send_telegram_alert(report))

    chart_b64 = base64.standard_b64encode(img_bytes).decode()
    return {"report": report, "chart_image": chart_b64}


@app.post("/api/analyze")
async def analyze_image(
    file: UploadFile = File(...),
    api_key: str = Form(""),
):
    img_bytes = await file.read()

    vision_text = await analyze_chart_vision(img_bytes, api_key)
    report = await generate_report(vision_text, [], {}, "UNKNOWN", "N/A", api_key)

    try:
        append_analysis_log(report)
    except Exception:
        pass

    asyncio.create_task(send_telegram_alert(report))
    chart_b64 = base64.standard_b64encode(img_bytes).decode()
    return {"report": report, "chart_image": chart_b64}


@app.post("/api/analyze-text")
async def analyze_text(body: TextAnalysisRequest):
    vision_text = f"종목: {body.ticker}\n{body.price_data}\n{body.notes}"
    report = await generate_report(vision_text, [], {}, body.ticker, "N/A", body.api_key or "")
    try:
        append_analysis_log(report)
    except Exception:
        pass
    return {"report": report}


@app.get("/api/search")
async def search(q: str):
    ticker, asset_type = resolve_ticker(q)
    if asset_type == "crypto":
        price = await fetch_crypto_price(ticker)
        return {"ticker": ticker, "name": ticker.capitalize(), "price": price,
                "asset_type": "crypto", "currency": "USD"}
    try:
        info = await _run_in_executor(lambda: yf.Ticker(ticker).fast_info)
        return {
            "ticker": ticker,
            "name": getattr(info, "name", ticker),
            "price": getattr(info, "last_price", 0),
            "market_cap": getattr(info, "market_cap", 0),
            "asset_type": "stock",
            "currency": getattr(info, "currency", "USD"),
        }
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/performance")
async def get_performance():
    return await get_performance_stats()


@app.post("/api/performance/update")
async def update_performance(body: PerformanceUpdateRequest):
    if body.result not in ("win", "loss"):
        raise HTTPException(status_code=422, detail="result must be 'win' or 'loss'")
    updated = await update_log_result(body.log_id, body.result)
    stats = await get_performance_stats()
    return {"updated": updated, "stats": stats}


@app.get("/api/watchlist")
async def get_watchlist():
    return {"watchlist": watchlist_data}


@app.post("/api/watchlist")
async def add_to_watchlist(item: WatchlistItem):
    ticker, _ = resolve_ticker(item.ticker)
    entry = {"ticker": ticker, "name": item.name or ticker, "added_at": datetime.utcnow().isoformat()}
    watchlist_data.append(entry)
    _save_watchlist()
    return {"watchlist": watchlist_data}


@app.delete("/api/watchlist/{ticker}")
async def remove_from_watchlist(ticker: str):
    global watchlist_data
    watchlist_data = [w for w in watchlist_data if w["ticker"] != ticker.upper()]
    _save_watchlist()
    return {"watchlist": watchlist_data}


async def _monitor_loop(interval_minutes: int):
    while True:
        await asyncio.sleep(interval_minutes * 60)
        for item in watchlist_data:
            try:
                ticker, asset_type = resolve_ticker(item["ticker"])
                if asset_type == "crypto":
                    df = await fetch_crypto_ohlcv(ticker)
                    current_price = str(await fetch_crypto_price(ticker))
                else:
                    df = await fetch_stock_data(ticker)
                    current_price = f"{df['Close'].iloc[-1]:,.2f}"
                img_bytes = await generate_chart(df, ticker)
                vision_text = await analyze_chart_vision(img_bytes)
                report = await generate_report(vision_text, [], {}, ticker, current_price)
                append_analysis_log(report)
                await send_telegram_alert(report)
            except Exception:
                continue


_monitor_task: Optional[asyncio.Task] = None


@app.post("/api/monitor/start")
async def monitor_start(body: MonitorRequest):
    global _monitor_task
    if _monitor_task and not _monitor_task.done():
        return {"status": "already_running", "interval_minutes": body.interval_minutes}
    _monitor_task = asyncio.create_task(_monitor_loop(body.interval_minutes or 60))
    return {"status": "started", "interval_minutes": body.interval_minutes}


@app.post("/api/monitor/stop")
async def monitor_stop():
    global _monitor_task
    if _monitor_task and not _monitor_task.done():
        _monitor_task.cancel()
        return {"status": "stopped"}
    return {"status": "not_running"}


@app.get("/api/macro")
async def get_macro():
    data, err = await fetch_macro()
    return {"macro": data, "error": err}


# ── 진입점 ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
