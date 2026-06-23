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

    info = {}
    try: info = tk.info
    except Exception: pass

    def safe(v, fmt=lambda x: x):
        return fmt(v) if v not in (None, "", 0) else "—"

    mc = info.get("marketCap")
    mc_str = (f"${mc/1e12:.2f}T" if mc and mc>=1e12 else
              f"${mc/1e9:.0f}B"  if mc and mc>=1e9  else
              f"${mc/1e6:.0f}M"  if mc else "—")

    # ATM IV + P/C ratio — single options chain fetch for both
    iv, pc_ratio = None, None
    try:
        exps = tk.options
        if exps:
            chain = tk.option_chain(exps[0])
            calls, puts = chain.calls, chain.puts
            iv = float(calls.iloc[(calls["strike"]-spot).abs().argsort()[:1]]["impliedVolatility"].values[0]) * 100
            c_vol = float(calls["volume"].sum() or 0)
            p_vol = float(puts["volume"].sum()  or 0)
            if c_vol > 0:
                pc_ratio = round(p_vol / c_vol, 2)
    except Exception:
        pass

    # Relative volume (current vs 20-day average)
    rel_vol = None
    try:
        avg_vol = info.get("averageVolume") or info.get("averageDailyVolume10Day") or 0
        cur_vol = info.get("volume") or info.get("regularMarketVolume") or 0
        if avg_vol > 0 and cur_vol > 0:
            rel_vol = round(cur_vol / avg_vol, 1)
    except Exception:
        pass

    # 52-week range
    week52_high = info.get("fiftyTwoWeekHigh")
    week52_low  = info.get("fiftyTwoWeekLow")

    # Next earnings date — human label + days-until integer
    earnings_date, days_to_earn = "—", None
    try:
        ed_list = info.get("earningsDate") or []
        if ed_list:
            earn_dt = datetime.datetime.utcfromtimestamp(ed_list[0]).date()
            earnings_date = earn_dt.strftime("%b %d")
            delta = (earn_dt - datetime.date.today()).days
            if delta >= 0:
                days_to_earn = delta
    except Exception:
        pass

    # Analyst consensus (free from yfinance info)
    analyst = {
        "targetMean": info.get("targetMeanPrice"),
        "targetHigh": info.get("targetHighPrice"),
        "targetLow":  info.get("targetLowPrice"),
        "count":      info.get("numberOfAnalystOpinions"),
        "recKey":     info.get("recommendationKey"),
    }

    # Top-3 Yahoo Finance RSS headlines — stdlib only, no AI cost
    yahoo_news = []
    try:
        import urllib.request, xml.etree.ElementTree as _ET
        from email.utils import parsedate_to_datetime as _parse_date
        _rss_url = (f"https://feeds.finance.yahoo.com/rss/2.0/headline"
                    f"?s={ticker}&region=US&lang=en-US")
        _req = urllib.request.Request(_rss_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(_req, timeout=6) as _resp:
            _root = _ET.fromstring(_resp.read())
        _now_utc = datetime.datetime.now(datetime.timezone.utc)
        for _item in _root.iter("item"):
            _title = _item.find("title")
            if not (_title is not None and _title.text):
                continue
            _age = "recent"
            _pub  = _item.find("pubDate")
            if _pub is not None and _pub.text:
                try:
                    _dt  = _parse_date(_pub.text)
                    _m   = int((_now_utc - _dt).total_seconds() / 60)
                    _age = (f"{_m}m ago"       if _m < 60   else
                            f"{_m//60}h ago"   if _m < 1440 else
                            f"{_m//1440}d ago")
                except Exception:
                    pass
            _src = _item.find("source")
            yahoo_news.append({
                "headline": _title.text.strip(),
                "source":   (_src.text if (_src is not None and _src.text) else "Yahoo Finance"),
                "time":     _age,
            })
            if len(yahoo_news) == 3:
                break
    except Exception:
        pass

    return {
        "name":       info.get("longName") or info.get("shortName") or ticker,
        "sector":     info.get("sector", "—"),
        "mktCap":     mc_str,
        "spot":       round(spot, 2),
        "chg":        round(chg, 2),
        "rsi":        round(rsi, 1),
        "iv":         round(iv, 1)         if iv         else None,
        "pcRatio":    pc_ratio,
        "relVol":     rel_vol,
        "week52High": round(week52_high, 2) if week52_high else None,
        "week52Low":  round(week52_low, 2)  if week52_low  else None,
        "daysToEarn": days_to_earn,
        "history":      [round(float(x), 2) for x in c.tail(60).tolist()],
        "history_dates":[d.strftime("%Y-%m-%d") for d in c.tail(60).index],
        "analyst":    analyst,
        "yahoo_news": yahoo_news,
        "fundamentals": {
            "pe":          safe(info.get("trailingPE"),    lambda x: f"{x:.0f}x"),
            "revGrowth":   safe(info.get("revenueGrowth"), lambda x: f"{x*100:+.0f}% YoY"),
            "grossMargin": safe(info.get("grossMargins"),  lambda x: f"{x*100:.0f}%"),
            "nextEarnings": earnings_date,
        },
    }


def ai_analysis_and_news(ticker, tech):
    """Claude generates the analysis summary + 3 scored news items + a 0-10 score."""
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    prompt = f"""Equity + options analyst. Research {ticker} ({tech['name']}) as of {datetime.date.today()}.

Data: ${tech['spot']} ({tech['chg']:+.1f}% today), RSI {tech['rsi']}, IV {tech['iv']}%, P/E {tech['fundamentals']['pe']}, rev {tech['fundamentals']['revGrowth']}, sector {tech['sector']}.

Score 0-10 DECISIVELY (use the full range, avoid 4-6 clustering):
  0-2 strongly bearish · 3-4 lean bearish · 5 truly balanced only
  6-7 lean bullish · 8-10 strongly bullish

JSON ONLY:
{{
  "score": <float 0-10, one decimal>,
  "signal": "hot"|"cold"|"neutral",
  "summary": "<3 sentences: (1) current setup/catalyst, (2) key technical level, (3) what IV {tech['iv']}% means for premium buying vs selling>",
  "news": [
    {{"score":<0-10>,"sentiment":"bullish"|"bearish"|"neutral","headline":"<specific>","source":"<e.g. Reuters>","time":"<e.g. 3h ago>"}}
  ],
  "play": null | {{"direction":"CALL"|"PUT","strike":<near spot>,"expiry":"YYYY-MM-DD","dte":<int>,"premium":<est>,"conviction":"HIGH"|"MEDIUM"|"LOW"}}
}}

Exactly 3 news items with spread-out scores. Play only if genuine edge, else null."""

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


def research(ticker, ai=False):
    """Full research bundle for one ticker. AI layer only runs when ai=True.
    Always returns price/technicals so the card loads even when AI is off."""
    ticker = ticker.upper().strip()
    tech = technicals(ticker)
    if tech is None:
        return {"ticker": ticker, "error": "No market data found"}
    if not ai:
        stub = {"score": None, "signal": "neutral", "summary": None,
                "news": [], "play": None, "ai_error": "ai_disabled"}
        return _json_safe({"ticker": ticker, **tech, **stub})
    try:
        ai_data = ai_analysis_and_news(ticker, tech)
    except Exception as e:
        ai_data = {"score": None, "signal": "neutral", "summary": None,
                   "news": [], "play": None, "ai_error": str(e)}
    return _json_safe({"ticker": ticker, **tech, **ai_data})


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

def _cached_swr(key, producer, ttl=600, stale_ttl=7200):
    """Return cached value immediately; refresh in background thread if stale."""
    import threading
    now = _time.time()
    hit = _CACHE.get(key)
    if hit:
        age = now - hit[0]
        if age < ttl:
            return hit[1]
        if age < stale_ttl:
            def _bg():
                try: _CACHE[key] = (_time.time(), producer())
                except Exception: pass
            threading.Thread(target=_bg, daemon=True).start()
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


# ── PORTFOLIO SETTINGS (margin, etc.) — persisted server-side like positions ──
_SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")

def _read_settings():
    try:
        with open(_SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _write_settings(s):
    with open(_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


def _apply_margin(analytics, margin, rate):
    """Fold a margin balance + annual rate into analytics: equity (net value) and daily carry."""
    a = dict(analytics)
    a["margin"] = round(margin, 2)
    a["margin_rate"] = rate
    a["margin_interest_daily"] = round(margin * (rate / 100.0) / 365.0, 2) if (margin and rate) else 0
    a["net_value"] = round(a.get("total_value", 0) - margin, 2)
    return a


def _stop_recommendation(pos_type, spot):
    """A starting-suggestion stop level: ~8% below spot for shares, ~15% for (leveraged) options."""
    if not spot:
        return None
    band = 0.15 if pos_type != "SHARES" else 0.08
    return round(spot * (1 - band), 2)


# ── ECONOMIC CALENDAR (hardcoded 2026 — update annually) ────────────────
_ECO_CALENDAR = [
    {"date":"2026-06-26","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-07-10","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-07-15","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-07-17","event":"Monthly OPEX","type":"opex","impact":"medium","detail":"Monthly options expiration"},
    {"date":"2026-07-30","event":"FOMC Decision","type":"fomc","impact":"high","detail":"Federal Reserve rate decision + press conference"},
    {"date":"2026-07-31","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-08-07","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-08-13","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-08-21","event":"Monthly OPEX","type":"opex","impact":"medium","detail":"Monthly options expiration"},
    {"date":"2026-08-28","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-09-04","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-09-11","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-09-17","event":"FOMC Decision","type":"fomc","impact":"high","detail":"Federal Reserve rate decision + press conference"},
    {"date":"2026-09-18","event":"Quarterly OPEX","type":"opex","impact":"high","detail":"Quarterly options + futures expiration (triple witching)"},
    {"date":"2026-09-25","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-10-02","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-10-14","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-10-16","event":"Monthly OPEX","type":"opex","impact":"medium","detail":"Monthly options expiration"},
    {"date":"2026-10-29","event":"FOMC Decision","type":"fomc","impact":"high","detail":"Federal Reserve rate decision + press conference"},
    {"date":"2026-10-30","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-11-06","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-11-13","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-11-20","event":"Monthly OPEX","type":"opex","impact":"medium","detail":"Monthly options expiration"},
    {"date":"2026-11-25","event":"PCE Inflation","type":"pce","impact":"high","detail":"Core PCE — Fed's preferred inflation gauge"},
    {"date":"2026-12-04","event":"Jobs Report","type":"nfp","impact":"high","detail":"Non-Farm Payrolls + unemployment rate"},
    {"date":"2026-12-10","event":"FOMC Decision","type":"fomc","impact":"high","detail":"Federal Reserve rate decision + press conference"},
    {"date":"2026-12-11","event":"CPI Inflation","type":"cpi","impact":"high","detail":"Consumer Price Index — core + headline"},
    {"date":"2026-12-18","event":"Quarterly OPEX","type":"opex","impact":"high","detail":"Quarterly options + futures expiration (triple witching)"},
]


try:
    from fastapi import FastAPI, Body
    from fastapi.middleware.cors import CORSMiddleware

    _ZERO_ANALYTICS = {"total_value":0, "total_cost":0, "total_pnl":0, "total_pnl_pct":0,
                       "daily_theta":0, "net_delta":0, "sector_alloc":{}}

    from fastapi.middleware.gzip import GZipMiddleware

    app = FastAPI(title="AlphaDesk")
    app.add_middleware(GZipMiddleware, minimum_size=500)
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.get("/health")
    def health():
        return {"ok": True, "time": datetime.datetime.now().isoformat()}

    @app.get("/research")
    def research_endpoint(ticker: str, ai: int = 0):
        t = ticker.upper().strip()
        return _cached(f"research:{t}:ai{ai}", lambda: research(t, ai=bool(ai)))

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

    @app.get("/calendar")
    def calendar_endpoint():
        today = datetime.date.today()
        upcoming = []
        for e in _ECO_CALENDAR:
            dt = datetime.date.fromisoformat(e["date"])
            days_away = (dt - today).days
            if 0 <= days_away <= 90:
                upcoming.append({**e, "days_away": days_away})
        upcoming.sort(key=lambda x: x["date"])
        return {"events": upcoming}

    _ROTATION_ETFS = {
        "Technology":"XLK","Communication":"XLC","Financials":"XLF",
        "Health Care":"XLV","Industrials":"XLI","Materials":"XLB",
        "Real Estate":"XLRE","Energy":"XLE","Utilities":"XLU",
        "Staples":"XLP","Discretionary":"XLY",
    }

    @app.get("/sectors/rotation")
    def sector_rotation_endpoint():
        def produce():
            try:
                import pandas as pd
                tickers = ["SPY"] + list(_ROTATION_ETFS.values())
                raw = yf.download(tickers, period="60d", auto_adjust=True,
                                  progress=False, show_errors=False)
                # Handle both flat and MultiIndex columns
                closes = raw["Close"] if "Close" in raw.columns else raw
                if hasattr(closes.columns, 'levels'):
                    closes = closes.droplevel(0, axis=1) if closes.columns.nlevels > 1 else closes
                spy = closes["SPY"].dropna() if "SPY" in closes.columns else None
                if spy is None or len(spy) < 21:
                    return {"error": "SPY data insufficient"}
                result = []
                for sector, etf in _ROTATION_ETFS.items():
                    if etf not in closes.columns: continue
                    s = closes[etf].dropna()
                    if len(s) < 21: continue
                    common = spy.index.intersection(s.index)
                    if len(common) < 20: continue
                    sp, sc = spy.loc[common], s.loc[common]
                    rs_20 = float((sc.iloc[-1]/sc.iloc[-20]-1) - (sp.iloc[-1]/sp.iloc[-20]-1)) * 100
                    rs_r  = float((sc.iloc[-1]/sc.iloc[-10]-1) - (sp.iloc[-1]/sp.iloc[-10]-1)) * 100
                    rs_p  = float((sc.iloc[-10]/sc.iloc[-20]-1) - (sp.iloc[-10]/sp.iloc[-20]-1)) * 100
                    rs_mom = rs_r - rs_p
                    q = ("Leading"   if rs_20>=0 and rs_mom>=0 else
                         "Weakening" if rs_20>=0 else
                         "Improving" if rs_mom>=0 else "Lagging")
                    result.append({"sector":sector,"etf":etf,
                        "rs":round(rs_20,2),"rs_mom":round(rs_mom,2),
                        "quadrant":q,"perf_1m":round(float((sc.iloc[-1]/sc.iloc[-20]-1)*100),2),
                        "spot":round(float(sc.iloc[-1]),2)})
                return _json_safe({"sectors":result,"generated_at":datetime.datetime.now().isoformat()})
            except Exception as e:
                return {"error": str(e)}
        return _cached("sectors_rotation", produce)

    @app.get("/outlook")
    def outlook_endpoint():
        def produce():
            try:
                from scanner import _lenient_json, fetch_climate, fetch_sectors
                climate = fetch_climate()
                sectors = fetch_sectors()
                top = sorted(sectors, key=lambda s: s.get("month",0), reverse=True)[:3]
                bot = sorted(sectors, key=lambda s: s.get("month",0))[:2]
                sc  = climate.get("macro_score", 50)
                client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
                prompt = f"""Market strategist. Date: {datetime.date.today()}. Macro: {sc}/100 ({climate.get('posture','neutral')}).
Top sectors (1mo): {', '.join(s['name']+' '+str(s.get('month',0))+'%' for s in top)}
Lagging: {', '.join(s['name']+' '+str(s.get('month',0))+'%' for s in bot)}

1-3 month forward market outlook. JSON ONLY:
{{"headline":"<bold 10-word directional call>","regime":"bull"|"bear"|"neutral"|"volatile",
"summary":"<3-4 sentences: macro regime, biggest risk, biggest opportunity>",
"overweight":["<sector/theme>","<sector/theme>","<sector/theme>"],
"underweight":["<sector/theme>","<sector/theme>"],
"key_risks":["<specific risk>","<specific risk>","<specific risk>"],
"positioning":"<2 sentences: specific options structure advice given current IV regime>",
"horizon":"1-3 months"}}
Be directional and specific. No hedging."""
                r = client.messages.create(model="claude-sonnet-4-6", max_tokens=700,
                    messages=[{"role":"user","content":prompt}])
                data = _lenient_json(r.content[0].text)
                return _json_safe({"generated_at":datetime.datetime.now().isoformat(), **data})
            except Exception as e:
                return {"error": str(e)}
        return _cached_swr("outlook", produce, ttl=3600, stale_ttl=14400)

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
                prompt = f"""Sector strategist. {name} sector (ETF {etf}) as of {datetime.date.today()}. Performance: {perf}.

JSON ONLY:
{{
  "summary":"3-4 sentences on current {name} drivers",
  "drivers":[{{"factor":"<name>","impact":"positive"|"negative"|"mixed","detail":"1-2 sentences"}}],
  "forecast":{{"horizon":"30-90 days","bias":"bullish"|"neutral"|"bearish","confidence":"high"|"medium"|"low","expected_range":"<e.g. +3% to +8%>","rationale":"2-3 sentences"}},
  "catalysts":["<upcoming catalyst>"]
}}
3-4 drivers, 2-3 catalysts. Be specific."""
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
        margin = float(payload.get("margin") or 0)
        rate   = float(payload.get("margin_rate") or 0)
        from run_daily import (layer1_data_valuation, layer2_portfolio_analytics,
                               get_macro_score, layer4_alerts)
        macro = get_macro_score()
        if not positions_in:
            return _json_safe({"generated_at": datetime.datetime.now().isoformat(),
                               "positions": [], "expired": [], "errored": [],
                               "analytics": _apply_margin(dict(_ZERO_ANALYTICS), margin, rate),
                               "macro": macro, "alerts": []})
        valued  = layer1_data_valuation(positions_in)
        expired = [p for p in valued if p.get("expired")]
        errored = [p for p in valued if p.get("error")]
        active  = [p for p in valued if not p.get("expired") and not p.get("error")]
        # Enrich each active position: 0-100 bullishness score (cached AI sentiment),
        # a HOLD/BUY/SELL rec, a recommended stop, and analysis of the user's entered stop.
        for p in active:
            sc = None
            try:
                rb = _cached(f"research:{p['ticker']}", lambda t=p['ticker']: research(t))
                sc = rb.get("score")
            except Exception:
                pass
            p["score"]    = round(sc * 10) if isinstance(sc, (int, float)) else None
            rec = _recommend(sc, p.get("pnl_pct"), p.get("dte"))
            spot = p.get("spot")
            p["stop_rec"] = _stop_recommendation(p.get("type"), spot)
            st = p.get("stop")
            if st and spot:
                p["stop_dist"] = round((spot - st) / spot, 4)   # cushion above the stop (fraction)
                p["stop_hit"]  = spot <= st
                if p["stop_hit"]:
                    rec = "SELL"
            else:
                p["stop_dist"] = None
                p["stop_hit"]  = False
            p["rec"] = rec
        if active:
            analytics = layer2_portfolio_analytics(active)
            alerts    = list(layer4_alerts(active, analytics, macro, {}))
        else:
            analytics, alerts = dict(_ZERO_ANALYTICS), []
        analytics = _apply_margin(analytics, margin, rate)
        for p in active:                       # stop-hit alerts
            if p.get("stop_hit"):
                alerts.append({"ticker": p["ticker"], "type": "STOP_HIT", "severity": "red",
                               "message": f"{p['ticker']} hit your stop ${p.get('stop')}"})
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

    @app.get("/settings")
    def get_settings():
        return {"settings": _read_settings()}

    @app.put("/settings")
    def put_settings(payload: dict = Body(default={})):
        s = payload.get("settings") or {}
        _write_settings(s)
        return {"ok": True}

    @app.get("/indicator")
    def indicator_endpoint(symbol: str, label: str = ""):
        # Macro indicator drill-down: 60-day history + AI summary/outlook/news.
        def produce():
            try:
                from scanner import _lenient_json
                h = yf.Ticker(symbol).history(period="60d")["Close"].dropna()
                if h.empty:
                    return {"error": f"no data for {symbol}"}
                hist  = [round(float(x), 2) for x in h.tail(60).tolist()]
                dates = [d.strftime("%Y-%m-%d") for d in h.tail(60).index]
                cur   = hist[-1] if hist else None
                chg   = round((hist[-1] / hist[-2] - 1) * 100, 2) if len(hist) > 1 and hist[-2] else 0.0
                nm    = label or symbol
                out = {"label": nm, "symbol": symbol, "current": cur, "change": chg,
                       "history": hist, "history_dates": dates, "news": [],
                       "generated_at": datetime.datetime.now().isoformat()}
                # AI is a bonus — the chart still renders if it's unavailable (e.g. no API credit).
                try:
                    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
                    prompt = f"""Macro strategist. "{nm}" ({symbol}) at {cur} ({chg:+.2f}% today) as of {datetime.date.today()}.

JSON ONLY:
{{
  "summary":"2-3 sentences: what {nm} signals now and why it's moving",
  "outlook":"2-3 sentences: 30-90 day view and what changes it",
  "regime":"calm"|"neutral"|"stress"|"rising"|"falling",
  "implication":"1-2 sentences: what this means for stocks/options",
  "news":[{{"headline":"<specific driver>","source":"<e.g. Reuters>","time":"<e.g. 3h ago>"}}]
}}
Exactly 3 news items. Be specific."""
                    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=1000,
                        messages=[{"role":"user","content":prompt}])
                    out.update(_lenient_json(r.content[0].text))
                except Exception as ai_e:
                    out["ai_error"] = str(ai_e)
                return _json_safe(out)
            except Exception as e:
                return {"error": str(e)}
        return _cached(f"indicator:{symbol}", produce)

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
        return _cached_swr("briefing", produce, ttl=600, stale_ttl=7200)

except ImportError:
    app = None
