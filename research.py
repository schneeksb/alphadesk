"""
AlphaDesk — Stock Research Engine
==================================
Powers the watchlist summary + detail pages + scored news.
Look up ANY ticker on demand.

CLI:    python research.py NVDA
        python research.py NVDA TSLA MSFT
API:    serve via FastAPI (see bottom) → GET /research?ticker=NVDA

Requires: pip install yfinance pandas numpy anthropic python-dotenv
"""

import os, sys, json, datetime
import numpy as np
import yfinance as yf
from dotenv import load_dotenv
import anthropic

# Windows consoles default to cp1252; the ✓/emoji in imported modules' print()s
# would raise UnicodeEncodeError and 500 a request. Force UTF-8 (replace on failure).
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

load_dotenv()


def technicals(ticker):
    """Price, % change, RSI, ATM IV, fundamentals from Yahoo."""
    tk = yf.Ticker(ticker)
    h  = tk.history(period="60d")
    if h.empty:
        return None
    c = h["Close"].dropna()          # latest bar may be unsettled (NaN); use last valid close
    if c.empty:
        return None
    spot = float(c.iloc[-1])
    chg  = float((spot/float(c.iloc[-2]) - 1)*100) if len(c) > 1 else 0.0

    # RSI(14)
    delta = c.diff()
    up    = delta.clip(lower=0).rolling(14).mean()
    dn    = (-delta.clip(upper=0)).rolling(14).mean()
    rsi   = float(100 - 100/(1 + up.iloc[-1]/dn.iloc[-1])) if dn.iloc[-1] else 50.0

    # ATM IV from nearest expiry
    iv = None
    try:
        exps = tk.options
        if exps:
            ch = tk.option_chain(exps[0]).calls
            iv = float(ch.iloc[(ch["strike"]-spot).abs().argsort()[:1]]["impliedVolatility"].values[0]) * 100
    except Exception:
        pass

    info = {}
    try: info = tk.info
    except Exception: pass

    def safe(v, fmt=lambda x: x):
        return fmt(v) if v not in (None, "", 0) else "—"

    mc = info.get("marketCap")
    mc_str = (f"${mc/1e12:.2f}T" if mc and mc>=1e12 else
              f"${mc/1e9:.0f}B"  if mc and mc>=1e9  else
              f"${mc/1e6:.0f}M"  if mc else "—")

    return {
        "name":    info.get("longName") or info.get("shortName") or ticker,
        "sector":  info.get("sector", "—"),
        "mktCap":  mc_str,
        "spot":    round(spot, 2),
        "chg":     round(chg, 2),
        "rsi":     round(rsi, 1),
        "iv":      round(iv, 1) if iv else None,
        "history": [round(float(x), 2) for x in c.tail(60).tolist()],
        "history_dates": [d.strftime("%Y-%m-%d") for d in c.tail(60).index],
        "fundamentals": {
            "pe":          safe(info.get("trailingPE"), lambda x: f"{x:.0f}x"),
            "revGrowth":   safe(info.get("revenueGrowth"), lambda x: f"{x*100:+.0f}% YoY"),
            "grossMargin": safe(info.get("grossMargins"), lambda x: f"{x*100:.0f}%"),
            "nextEarnings":"—",
        },
    }


def ai_analysis_and_news(ticker, tech):
    """Claude generates the analysis summary + 3 scored news items + a 0-10 score."""
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    prompt = f"""You are a sharp equity + options analyst. Research {ticker} ({tech['name']}) as of {datetime.date.today()}.

LIVE DATA: spot ${tech['spot']}, {tech['chg']:+.1f}% today, RSI {tech['rsi']}, ATM IV {tech['iv']}%, sector {tech['sector']}, P/E {tech['fundamentals']['pe']}, rev growth {tech['fundamentals']['revGrowth']}.

Score this name DECISIVELY on a 0-10 conviction scale. Use the WHOLE range and let the data drive it — do NOT cluster in the 4-6 neutral zone. Calibrate to this rubric:
  0-2  strongly bearish (broken trend, deteriorating fundamentals, distribution)
  3-4  lean bearish (headwinds dominate, weak RSI, fading momentum)
  5    genuinely balanced — use ONLY when bull and bear cases are truly even
  6-7  lean bullish (constructive setup, momentum/catalysts building)
  8-10 strongly bullish (trend + fundamentals + catalysts aligned)
Anchor the score to specifics: RSI {tech['rsi']} (>70 overbought, <30 oversold), today's {tech['chg']:+.1f}% move, the IV regime, and recent developments you know of. Two different tickers should rarely land on the same score.

Produce JSON ONLY (no markdown):
{{
  "score": <float 0-10, one decimal, calibrated as above>,
  "signal": "hot" | "cold" | "neutral",
  "summary": "<3 sentences, SPECIFIC to {ticker}: (1) the concrete setup/catalyst right now, (2) the technical read including a key price level, (3) what ATM IV {tech['iv']}% implies for buying vs selling premium>",
  "news": [
    {{
      "score": <int 0-10, 0=most bearish 10=most bullish — spread these out>,
      "sentiment": "bullish" | "bearish" | "neutral",
      "headline": "<specific, concrete headline in your own words>",
      "source": "<plausible source, e.g. Reuters, Bloomberg>",
      "time": "<e.g. '3h ago', '1d ago'>"
    }}
  ],
  "play": null OR {{
    "direction":"CALL"|"PUT", "strike":<number near spot>, "expiry":"YYYY-MM-DD",
    "dte":<int>, "premium":<est number>, "conviction":"HIGH"|"MEDIUM"|"LOW"
  }}
}}

EXACTLY 3 news items, mixing bullish and bearish with genuinely different scores. Only suggest a play if there's a real edge; otherwise null. Be concrete and honest about downside."""

    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=1200,
        messages=[{"role":"user","content":prompt}])
    from scanner import _lenient_json
    return _lenient_json(r.content[0].text)


def _json_safe(o):
    """Recursively replace NaN/inf (not valid JSON) with None so responses never 500."""
    if isinstance(o, float):
        return o if np.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _json_safe(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_json_safe(v) for v in o]
    return o


def research(ticker):
    """Full research bundle for one ticker."""
    ticker = ticker.upper().strip()
    tech = technicals(ticker)
    if tech is None:
        return {"ticker": ticker, "error": "No market data found"}
    ai = ai_analysis_and_news(ticker, tech)
    return _json_safe({"ticker": ticker, **tech, **ai})


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    tickers = sys.argv[1:] or ["NVDA"]
    for t in tickers:
        print("="*56)
        data = research(t)
        if "error" in data:
            print(f"{t}: {data['error']}"); continue
        print(f"{data['ticker']} — {data['name']}  (${data['spot']}, {data['chg']:+.1f}%)")
        print(f"  Score: {data['score']}/10  [{data['signal']}]")
        print(f"  {data['summary']}")
        print(f"  RSI {data['rsi']} | IV {data['iv']}% | P/E {data['fundamentals']['pe']}")
        print("  News:")
        for n in data["news"]:
            print(f"    [{n['score']}/10 {n['sentiment']:>7}] {n['headline']}  ({n['source']}, {n['time']})")
        if data.get("play"):
            p = data["play"]
            print(f"  Play: ${p['strike']} {p['direction']} exp {p['expiry']} ({p['conviction']})")
        # Save
        with open(f"research_{t.upper()}_{datetime.date.today()}.json","w") as f:
            json.dump(data, f, indent=2)


# ── LIVE API SERVER (research + briefing, with caching) ───────────────────────
# pip install fastapi uvicorn
# uvicorn research:app --port 8000
#
# Endpoints:
#   GET /research?ticker=NVDA   → full research bundle (cached 10 min)
#   GET /briefing               → The Briefing Room (cached 10 min, refreshes on open)
#   GET /health                 → simple ok check
#
# The 8 AM ALERT is separate: scanner.py runs via cron and pushes Slack/SMS.
# The Briefing Room re-runs whenever the app is opened (frontend calls /briefing),
# and this server caches for 10 min so rapid re-opens stay fast and cheap.

import time as _time

_CACHE = {}            # key -> (timestamp, value)
_TTL   = 600           # seconds (10 min)

def _cached(key, producer):
    now = _time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    val = producer()
    _CACHE[key] = (now, val)
    return val


# ── PERSISTENT POSITIONS (server-side store so the portfolio syncs across browsers) ──
_POSITIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "positions.json")

def _read_positions():
    try:
        with open(_POSITIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("positions", [])
    except Exception:
        return []

def _write_positions(positions):
    with open(_POSITIONS_FILE, "w", encoding="utf-8") as f:
        json.dump(positions, f, indent=2)


def _recommend(score, pnl_pct, dte):
    """HOLD / BUY / SELL from conviction (AI score 0-10) + the position's own state."""
    if pnl_pct is not None and pnl_pct <= -0.25:
        return "SELL"                                  # stop-loss discipline
    if dte is not None and dte < 21 and (score is None or score < 6):
        return "SELL"                                  # option bleeding theta with no conviction
    if score is None:
        return "HOLD"
    if score >= 7:
        return "HOLD" if (pnl_pct or 0) >= 0.6 else "BUY"   # bullish, but don't chase a huge winner
    if score <= 3.5:
        return "SELL"
    if pnl_pct is not None and pnl_pct >= 0.5:
        return "SELL"                                  # neutral conviction + big gain → take profits
    return "HOLD"

try:
    from fastapi import FastAPI, Body
    from fastapi.middleware.cors import CORSMiddleware

    _ZERO_ANALYTICS = {"total_value":0, "total_cost":0, "total_pnl":0, "total_pnl_pct":0,
                       "daily_theta":0, "net_delta":0, "sector_alloc":{}}

    app = FastAPI(title="AlphaDesk")
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.get("/health")
    def health():
        return {"ok": True, "time": datetime.datetime.now().isoformat()}

    @app.get("/research")
    def research_endpoint(ticker: str):
        t = ticker.upper().strip()
        return _cached(f"research:{t}", lambda: research(t))

    @app.get("/sectors")
    def sectors_endpoint():
        # Fast, standalone sector heatmap (no AI, no full watchlist scan).
        def produce():
            try:
                from scanner import fetch_sectors
                return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                                   "sectors": fetch_sectors()})
            except Exception as e:
                return {"error": str(e)}
        return _cached("sectors", produce)

    @app.get("/sector")
    def sector_endpoint(name: str):
        # Drill-down: AI explanation of what's driving a sector + 30-90 day forecast.
        def produce():
            try:
                from scanner import fetch_sectors, SECTOR_ETFS, _lenient_json
                sectors = fetch_sectors()
                s   = next((x for x in sectors if x["name"].lower() == name.lower()), None)
                etf = next((k for k, v in SECTOR_ETFS.items() if v.lower() == name.lower()), "—")
                perf = f"today {s['day']:+.2f}%, 1-month {s['month']:+.1f}%" if s else "recent performance unavailable"
                client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
                prompt = f"""You are a sector strategist. Analyze the {name} sector (proxy ETF {etf}) as of {datetime.date.today()}.
Recent performance: {perf}.

Produce JSON ONLY (no markdown):
{{
  "summary": "3-4 sentences on what is driving {name} performance right now",
  "drivers": [
    {{"factor":"<short name>", "impact":"positive"|"negative"|"mixed", "detail":"1-2 sentences"}}
  ],
  "forecast": {{
    "horizon":"30-90 days",
    "bias":"bullish"|"neutral"|"bearish",
    "confidence":"high"|"medium"|"low",
    "expected_range":"<e.g. +3% to +8%>",
    "rationale":"2-3 sentences tying the drivers to the outlook"
  }},
  "catalysts": ["<upcoming catalyst to watch>"]
}}
Provide 3-4 drivers and 2-3 catalysts. Be specific and honest about risks."""
                r = client.messages.create(model="claude-sonnet-4-6", max_tokens=1500,
                    messages=[{"role":"user","content":prompt}])
                ai = _lenient_json(r.content[0].text)
                return _json_safe({"name": name, "etf": etf,
                                   "day": (s or {}).get("day"), "month": (s or {}).get("month"),
                                   "status": (s or {}).get("status"),
                                   "generated_at": datetime.datetime.now().isoformat(), **ai})
            except Exception as e:
                return {"error": str(e)}
        return _cached(f"sector:{name.lower()}", produce)

    @app.get("/climate")
    def climate_endpoint():
        # Macro/micro gauges for the top ribbon (VIX, 10Y, credit, breadth, DXY, IG).
        def produce():
            try:
                from scanner import fetch_climate
                return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                                   **fetch_climate()})
            except Exception as e:
                return {"error": str(e)}
        return _cached("climate", produce)

    @app.get("/portfolio")
    def portfolio_endpoint():
        # Live portfolio: positions + Greeks + analytics + alerts (reuses run_daily.py).
        def produce():
            try:
                from run_daily import (layer1_data_valuation, layer2_portfolio_analytics,
                                       get_macro_score, layer4_alerts)
                positions = layer1_data_valuation()
                analytics = layer2_portfolio_analytics(positions)
                macro     = get_macro_score()
                alerts    = layer4_alerts(positions, analytics, macro, {})
                return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                                   "positions": positions, "analytics": analytics,
                                   "macro": macro, "alerts": alerts})
            except Exception as e:
                return {"error": str(e)}
        return _cached("portfolio", produce)

    @app.post("/value")
    def value_endpoint(payload: dict = Body(default={})):
        # Value a user-supplied list of positions (entered/persisted in the browser).
        # Splits results into active / expired / errored; analytics & alerts use active only.
        positions_in = payload.get("positions") or []
        from run_daily import (layer1_data_valuation, layer2_portfolio_analytics,
                               get_macro_score, layer4_alerts)
        macro = get_macro_score()
        if not positions_in:
            return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                               "positions": [], "expired": [], "errored": [],
                               "analytics": dict(_ZERO_ANALYTICS), "macro": macro, "alerts": []})
        valued  = layer1_data_valuation(positions_in)
        expired = [p for p in valued if p.get("expired")]
        errored = [p for p in valued if p.get("error")]
        active  = [p for p in valued if not p.get("expired") and not p.get("error")]
        # Enrich each active position with a 0-100 bullishness score (reusing the cached
        # AI research sentiment) and a HOLD/BUY/SELL recommendation.
        for p in active:
            sc = None
            try:
                rb = _cached(f"research:{p['ticker']}", lambda t=p['ticker']: research(t))
                sc = rb.get("score")
            except Exception:
                pass
            p["score"] = round(sc * 10) if isinstance(sc, (int, float)) else None
            p["rec"]   = _recommend(sc, p.get("pnl_pct"), p.get("dte"))
        if active:
            analytics = layer2_portfolio_analytics(active)
            alerts    = layer4_alerts(active, analytics, macro, {})
        else:
            analytics, alerts = dict(_ZERO_ANALYTICS), []
        return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                           "positions": active, "expired": expired, "errored": errored,
                           "analytics": analytics, "macro": macro, "alerts": alerts})

    @app.get("/positions")
    def get_positions():
        return {"positions": _read_positions()}

    @app.put("/positions")
    def put_positions(payload: dict = Body(default={})):
        positions = payload.get("positions") or []
        _write_positions(positions)
        return {"ok": True, "count": len(positions)}

    @app.get("/briefing")
    def briefing_endpoint():
        # Reuses scanner.py's brief generation so logic stays in one place.
        def produce():
            try:
                from scanner import fetch_climate, fetch_sectors, fetch_snapshot, ai_brief
                climate  = fetch_climate()
                sectors  = fetch_sectors()
                snapshot = fetch_snapshot()
                brief    = ai_brief(snapshot, sectors, climate)
                return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                        "climate": climate, "sectors": sectors, **brief})
            except Exception as e:
                return {"error": str(e)}
        return _cached("briefing", produce)

except ImportError:
    app = None
