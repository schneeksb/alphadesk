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

# ── ANALYST PANEL ─────────────────────────────────────────────────────────
# Ordered by trust weight (1 = highest). Channel IDs are hardcoded defaults;
# override per-analyst via the env var listed in "env".
ANALYSTS = [
    {"id":"nicholas_crown",    "name":"Nicholas Crown",               "label":"Macro & Market Cycles",        "channel_id":os.getenv("YT_NICHOLAS_CROWN_CHANNEL_ID",      "UCJSICzUeXSxBvc0UAf2Up8g"), "weight":1, "focus":"macro cycles, market breathing, sector rotation",        "shorts_first":True,  "videos":3},
    {"id":"felix_friends",     "name":"FelixFriends",                 "label":"Technical Timing",              "channel_id":os.getenv("YT_FELIX_FRIENDS_CHANNEL_ID",       "UCJtfma0mE_XrBAD9uakcjfA"), "weight":2, "focus":"moving averages and predicting market shifts",             "shorts_first":False, "videos":2},
    {"id":"jerry_romine",      "name":"Jerry Romine Stocks",          "label":"Financial Analysis",            "channel_id":os.getenv("YT_JERRY_ROMINE_CHANNEL_ID",        "UCMiJUXvEpHHW5JTnW-ez9EA"), "weight":3, "focus":"deep financial analysis and business quality for long term holds", "shorts_first":False, "videos":2},
    {"id":"fin_edu_jeremy",    "name":"Financial Education",          "label":"Deep Value & Business Quality", "channel_id":os.getenv("YT_FIN_EDU_CHANNEL_ID",             "UCnMn36GT_H0X-w5_ckLtlgQ"), "weight":4, "focus":"business value analysis and 1000X stock potential",        "shorts_first":False, "videos":2},
    {"id":"ticker_symbol_you", "name":"Ticker Symbol: YOU",           "label":"Innovation & Tech",             "channel_id":os.getenv("YT_TICKER_SYMBOL_YOU_CHANNEL_ID",   "UC7kCeZ53sli_9XwuQeFxLqw"), "weight":5, "focus":"tech innovation and understanding disruptive companies",    "shorts_first":False, "videos":2},
    {"id":"stealth_wealth",    "name":"Stealth Wealth Investing",     "label":"Value & Accounting",            "channel_id":os.getenv("YT_STEALTH_WEALTH_CHANNEL_ID",      "UCjeFguVhLAsxuFK4D4Ngr9A"), "weight":6, "focus":"accounting perspective, identifying undervalued or overvalued stocks", "shorts_first":False, "videos":2},
    {"id":"jeremy_makes_money","name":"Jeremy Lefebvre Makes Money",  "label":"Market Momentum",               "channel_id":os.getenv("YT_JEREMY_MAKES_MONEY_CHANNEL_ID",  "UC12lnsYNt8_VthTNOuOGTmQ"), "weight":7, "focus":"reactive market analysis and current momentum",             "shorts_first":False, "videos":2},
    {"id":"fx_evolution",      "name":"FX Evolution Trading Academy", "label":"Short Term Setups",             "channel_id":os.getenv("YT_FX_EVOLUTION_CHANNEL_ID",        "UCvJZEG5x-DVYZKTz--pS39w"), "weight":8, "focus":"short term trading setups",                               "shorts_first":False, "videos":2},
    {"id":"figuring_out_money","name":"Figuring Out Money",           "label":"Near Term",                     "channel_id":os.getenv("YT_FIGURING_OUT_MONEY_CHANNEL_ID",  "UCfdPOTevbfCh_QHsyPeZ8MQ"), "weight":9, "focus":"near term price action and short term analysis",           "shorts_first":False, "videos":2},
]

ANALYST_WEIGHT_BLOCK = (
    "CONTENT CREATOR INSIGHT WEIGHTING — apply in descending priority when synthesizing insights:\n"
    "  1 (HIGHEST) Nicholas Crown: macro cycle & liquidity reads\n"
    "  2 FelixFriends: moving-average-based market shift signals\n"
    "  3 Jerry Romine Stocks: deep financial analysis, business quality\n"
    "  4 Financial Education by Jeremy: business value, long-term compounders\n"
    "  5 Ticker Symbol YOU: tech innovation, disruptive company analysis\n"
    "  6 Stealth Wealth Investing: accounting lens, valuation signals\n"
    "  7 Jeremy Lefebvre Makes Money: current market momentum reads\n"
    "  8 FX Evolution Trading Academy: short-term setups — LOW WEIGHT\n"
    "  9 (LOWEST) Figuring Out Money: near-term price action only"
)


def technicals(ticker):
    """Price, % change, RSI, ATM IV, fundamentals from Yahoo."""
    tk = yf.Ticker(ticker)
    h  = tk.history(period="1y")
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
        "history":      [round(float(x), 2) for x in c.tail(252).tolist()],
        "history_dates":[d.strftime("%Y-%m-%d") for d in c.tail(252).index],
        "analyst":    analyst,
        "yahoo_news": yahoo_news,
        "fundamentals": {
            "pe":          safe(info.get("trailingPE"),    lambda x: f"{x:.0f}x"),
            "revGrowth":   safe(info.get("revenueGrowth"), lambda x: f"{x*100:+.0f}% YoY"),
            "grossMargin": safe(info.get("grossMargins"),  lambda x: f"{x*100:.0f}%"),
            "nextEarnings": earnings_date,
        },
    }


def ai_analysis_and_news(ticker, tech, profile: str = ""):
    """Stage-based 30-day forward outlook: where is this stock in its current cycle?"""
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    earn_ctx = f"in {tech['daysToEarn']}d ({tech['fundamentals']['nextEarnings']})" if tech.get('daysToEarn') is not None else f"unknown ({tech['fundamentals']['nextEarnings']})"
    w52h, w52l, spot = tech.get('week52High'), tech.get('week52Low'), tech.get('spot')
    w52_ctx = ""
    if w52h and w52l and spot and w52h != w52l:
        pct = (spot - w52l) / (w52h - w52l) * 100
        w52_ctx = f"52W ${w52l}–${w52h} (at {pct:.0f}th %ile — {'near highs' if pct>80 else 'near lows' if pct<20 else 'mid-range'})"
    pc = tech.get('pcRatio')
    pc_ctx = f"P/C {pc} ({'heavy put hedging' if pc and pc>1.2 else 'call-heavy/bullish flow' if pc and pc<0.8 else 'neutral flow'})" if pc else "P/C n/a"
    analyst_ctx = ""
    a = tech.get('analyst', {})
    if a.get('targetMean') and spot:
        upside = (a['targetMean'] - spot) / spot * 100
        analyst_ctx = f"\nAnalyst consensus: {a.get('recKey','?')} · {a.get('count','?')} analysts · mean target ${a['targetMean']:.2f} ({upside:+.1f}% from here)"
    profile_block = _profile_ctx(profile)
    profile_intro = f"\n{profile_block}\n" if profile_block else ""

    prompt = f"""You are a panel of elite investors analyzing {ticker} ({tech['name']}) as of {datetime.date.today()}.

Think like: Stan Druckenmiller (macro/liquidity cycles), Phil Fisher (business quality), Howard Marks (cycle awareness), a seasoned options trader (Greeks/timing).

{ANALYST_WEIGHT_BLOCK}

Analyze through FOUR LENSES in this priority order:
1. MACRO CYCLE — where are we in the rate/liquidity cycle? Does the macro environment favor or hurt this sector and stock right now?
2. SECTOR ROTATION — is institutional money flowing into or out of {tech['sector']}? Is relative strength vs. SPY improving or deteriorating?
3. COMPANY QUALITY — is the business getting stronger (accelerating earnings/margins) or weaker? What does the fundamental trajectory say?
4. OPTIONS TIMING — what is IV {tech.get('iv','?')}% + P/C {pc} revealing about smart money positioning? Is the options market pricing too much or too little risk?

Weight macro and sector factors FIRST. Technicals signal entry/exit timing, not the primary thesis.

MARKET DATA:
Price: ${spot} ({tech['chg']:+.1f}% today) | RSI {tech['rsi']} | {w52_ctx}
Options: IV {tech.get('iv','?')}% | {pc_ctx} | Rel Vol {tech.get('relVol','?')}×
Fundamentals: P/E {tech['fundamentals']['pe']} | Rev Growth {tech['fundamentals']['revGrowth']} | Margin {tech['fundamentals']['grossMargin']} | Sector: {tech['sector']}
Earnings: {earn_ctx}{analyst_ctx}
{profile_intro}
ASSIGN ONE STAGE that best describes where this stock is RIGHT NOW in its cycle:
  Breakout — clearing resistance with volume, momentum building, likely continuation
  Trending — established uptrend, healthy pullbacks, buyers in control
  Coiling — wedging/consolidating near a key level, big directional move imminent
  Oversold Bounce — hit major support or oversold extreme, selling exhausted, mean reversion likely
  Resistance Test — approaching major ceiling, breakout-or-rejection decision point
  Running Out of Steam — momentum fading, distribution signs, rally may be ending
  Deteriorating — lower highs and lows forming, sellers gaining control
  Collapsing — aggressive selling/breakdown, avoid or consider short

CONVICTION for the next 30 days (be honest — most stocks are Watch and Wait):
  Strong Setup — clear directional edge with specific catalyst, act now
  Watch and Wait — mixed or unclear signals, let price confirm direction first
  Risky Setup — risk outweighs reward, protect capital

REASON: one line written like an experienced trader talking — name the specific technical situation or catalyst defining this moment and what likely happens next 30 days.
  Good: "Wedging above 200-day MA with earnings catalyst in 18 days — coil resolves on print."
  Good: "Failed breakout on earnings gap-down, now retesting critical $180 support with declining volume."
  Bad: "Stock is at a key level and could go up or down."

JSON ONLY — no markdown, no code fences:
{{
  "stage": "Breakout"|"Trending"|"Coiling"|"Oversold Bounce"|"Resistance Test"|"Running Out of Steam"|"Deteriorating"|"Collapsing",
  "conviction": "Strong Setup"|"Watch and Wait"|"Risky Setup",
  "reason": "<one specific trader-voice line: current technical situation + 30-day likely outcome>",
  "signal": "hot"|"cold"|"neutral",
  "outlook_30d": "<2-3 sentences: forward 30-day outlook, specific and directional, not hedged>",
  "catalysts": ["<specific named event that could push price UP>", "<second catalyst>"],
  "risks": ["<specific named risk in next 30 days>", "<second risk>"],
  "options_read": "<2 sentences: what IV {tech['iv']}% + P/C {pc} says about smart money positioning>",
  "news": [
    {{"score":<0-10>,"sentiment":"bullish"|"bearish"|"neutral","headline":"<specific plausible recent headline>","source":"<e.g. Bloomberg>","time":"<e.g. 2h ago>"}}
  ],
  "trade_levels": {{"entry":<current spot or best entry price>,"target":<30-day price target>,"stop":<stop loss price>,"risk_reward":"<e.g. 1:2.5>"}},
  "play": null | {{"direction":"CALL"|"PUT","strike":<near ATM>,"expiry":"YYYY-MM-DD","dte":<int>,"premium":<est float>,"conviction":"HIGH"|"MEDIUM"|"LOW","thesis":"<1 sentence: structure rationale>"}}
}}

Exactly 3 news items. PLAY only if genuine asymmetric edge — otherwise null."""

    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=1700,
        messages=[{"role": "user", "content": prompt}])
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


def _profile_ctx(profile: str) -> str:
    """Convert profile string 'risk|goal|style|level' into an AI instruction block."""
    if not profile:
        return ""
    parts = profile.split("|")
    risk  = parts[0] if len(parts) > 0 else "moderate"
    goal  = parts[1] if len(parts) > 1 else "growth"
    style = parts[2] if len(parts) > 2 else "swing"
    level = parts[3] if len(parts) > 3 else "intermediate"
    risk_map  = {"conservative":"Conservative — capital preservation first, prefers wide stops and low-risk setups",
                 "moderate":"Moderate — balanced risk/reward, comfortable with occasional volatility",
                 "aggressive":"Aggressive — high risk/reward seeker, comfortable with large swings",
                 "degen":"Degen — maximum risk, options-heavy, loves big asymmetric swings"}
    goal_map  = {"growth":"Growth — maximize portfolio value long-term",
                 "income":"Income — generate consistent premium / dividend returns",
                 "speculation":"Speculation — find big asymmetric opportunities",
                 "hedging":"Hedging — protect existing positions from downside"}
    style_map = {"longterm":"Long-Term Investor — months to years horizon",
                 "swing":"Swing Trader — days to weeks, technical setups",
                 "options":"Options Trader — leverage and Greeks-focused",
                 "daytrader":"Day Trader — intraday moves, tight stops"}
    level_map = {"beginner":"Beginner","intermediate":"Intermediate","advanced":"Advanced","professional":"Professional"}
    lines = [
        f"TRADER PROFILE (tailor ALL analysis and recommendations to this user):",
        f"  Risk Tolerance: {risk_map.get(risk, risk)}",
        f"  Primary Goal: {goal_map.get(goal, goal)}",
        f"  Trading Style: {style_map.get(style, style)}",
        f"  Experience: {level_map.get(level, level)}",
        f"",
        f"ANALYSIS FRAMEWORK — evaluate through these four lenses in strict priority order:",
        f"  1. MACRO CYCLE (Druckenmiller lens): Where are we in the liquidity and rate cycle? Which sectors and factor styles benefit right now? Is this a risk-on or risk-off environment?",
        f"  2. SECTOR ROTATION (institutional money flow): Where is smart money flowing in vs. out? Is this stock's sector gaining or losing relative strength vs. SPY over the last 5–20 days?",
        f"  3. COMPANY QUALITY (Fisher lens): Is the business compounding or deteriorating? Are earnings, margins, and revenue growth accelerating or decelerating?",
        f"  4. OPTIONS TIMING (derivatives lens): What is IV rank saying? Is smart money positioned bullishly or bearishly via options? Is the P/C ratio showing unusual flow?",
        f"  PRIORITY: Macro and sector tide come FIRST. Technicals serve as entry timing, not as the primary thesis. This trader times entries based on macro tides, not chart patterns alone.",
        f"  ANALYST PANEL MINDSET: Think like Stan Druckenmiller on macro/liquidity, Phil Fisher on business quality, Howard Marks on cycle awareness, and a seasoned options trader on Greeks and timing.",
    ]
    if risk in ("aggressive","degen"):
        lines.append("  → Prefer higher risk/reward setups, shorter DTE, further OTM strikes, concentrated bets.")
    if risk == "conservative":
        lines.append("  → Prefer LEAPS, blue chips, wide stops, defined-risk trades, smaller sizing.")
    if goal == "income":
        lines.append("  → Lean toward premium-selling ideas (covered calls, cash-secured puts, credit spreads).")
    if style == "options":
        lines.append("  → Emphasize Greeks analysis, IV rank, options structure, and theta management.")
    if style == "daytrader":
        lines.append("  → Focus on intraday setups, momentum, and tight stops. Ignore long-term fundamentals.")
    lines.append("")
    lines.append(ANALYST_WEIGHT_BLOCK)
    return "\n".join(lines)


def research(ticker, ai=False, profile: str = ""):
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
        ai_data = ai_analysis_and_news(ticker, tech, profile)
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


def _recommend(score, pnl_pct, dte, conviction=None):
    """HOLD / BUY / SELL from stage conviction + position state."""
    if pnl_pct is not None and pnl_pct <= -0.25:
        return "SELL"                                   # stop-loss discipline always
    if conviction == "Risky Setup":
        return "SELL"                                   # AI says risk > reward
    if dte is not None and dte < 21 and conviction != "Strong Setup" and (score is None or score < 6):
        return "SELL"                                   # theta bleeding, no conviction to hold
    if conviction == "Strong Setup":
        return "HOLD" if (pnl_pct or 0) >= 0.6 else "BUY"
    # Fallback: numeric score (backward compat with cached research)
    if score is None:
        return "HOLD"
    if score >= 7:
        return "HOLD" if (pnl_pct or 0) >= 0.6 else "BUY"
    if score <= 3.5:
        return "SELL"
    if pnl_pct is not None and pnl_pct >= 0.5:
        return "SELL"                                   # neutral conviction + big gain → take profits
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
    def research_endpoint(ticker: str, ai: int = 0, profile: str = ""):
        t = ticker.upper().strip()
        return _cached(f"research:{t}:{ai}:{profile}", lambda: research(t, ai=bool(ai), profile=profile))

    @app.get("/chart")
    def chart_endpoint(ticker: str, range: str = "3m"):
        """Price history for any timeframe with correct yfinance params per range."""
        t = ticker.upper().strip()
        # (period, interval, date_format, cache_ttl_s, stale_ttl_s)
        RANGE_MAP = {
            "1d":  ("1d",  "5m",  "%H:%M",       300,   900),
            "1w":  ("5d",  "1h",  "%m/%d %H:%M", 900,  3600),
            "1m":  ("1mo", "1d",  "%Y-%m-%d",    600,  7200),
            "3m":  ("3mo", "1d",  "%Y-%m-%d",    600,  7200),
            "6m":  ("6mo", "1d",  "%Y-%m-%d",    600,  7200),
            "ytd": ("ytd", "1d",  "%Y-%m-%d",    600,  7200),
            "1y":  ("1y",  "1d",  "%Y-%m-%d",   3600, 86400),
            "2y":  ("2y",  "1wk", "%Y-%m-%d",   3600, 86400),
            "5y":  ("5y",  "1wk", "%Y-%m-%d",   3600, 86400),
        }
        if range not in RANGE_MAP:
            return {"error": f"range must be one of: {', '.join(RANGE_MAP)}"}
        period, interval, date_fmt, ttl, stale = RANGE_MAP[range]
        def produce():
            try:
                tk = yf.Ticker(t)
                h = tk.history(period=period, interval=interval)
                if h.empty:
                    return {"error": "no data"}
                c = h["Close"].dropna()
                return _json_safe({
                    "history":       [round(float(x), 2) for x in c.tolist()],
                    "history_dates": [d.strftime(date_fmt) for d in c.index],
                })
            except Exception as e:
                return {"error": str(e)}
        return _cached_swr(f"chart:{t}:{range}", produce, ttl=ttl, stale_ttl=stale)

    @app.get("/map-data")
    def map_data_endpoint(tickers: str = ""):
        """Macro events calendar + options flow for comma-separated tickers."""
        ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()][:12]
        def produce():
            today = datetime.date.today()
            # Upcoming FOMC, CPI, NFP dates for 2026 (sorted ascending)
            raw_events = [
                ("2026-07-03",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-07-15",  "CPI",  "CPI Inflation Report",   "high"),
                ("2026-07-29",  "FOMC", "Fed Rate Decision",       "high"),
                ("2026-08-07",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-08-12",  "CPI",  "CPI Inflation Report",   "high"),
                ("2026-09-04",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-09-10",  "CPI",  "CPI Inflation Report",   "high"),
                ("2026-09-16",  "FOMC", "Fed Rate Decision",       "high"),
                ("2026-10-02",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-10-14",  "CPI",  "CPI Inflation Report",   "high"),
                ("2026-10-28",  "FOMC", "Fed Rate Decision",       "high"),
                ("2026-11-06",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-11-12",  "CPI",  "CPI Inflation Report",   "high"),
                ("2026-12-04",  "NFP",  "Jobs Report (NFP)",      "high"),
                ("2026-12-09",  "FOMC", "Fed Rate Decision",       "high"),
                ("2026-12-10",  "CPI",  "CPI Inflation Report",   "high"),
            ]
            upcoming = []
            for date_str, ev_type, name, impact in raw_events:
                ev_date = datetime.date.fromisoformat(date_str)
                days_away = (ev_date - today).days
                if 0 <= days_away <= 90:
                    upcoming.append({"date": date_str, "type": ev_type, "name": name,
                                     "impact": impact, "days_away": days_away})

            # Options flow for provided tickers
            options_flow = []
            for t in ticker_list:
                try:
                    tk = yf.Ticker(t)
                    h = tk.history(period="1d")
                    if h.empty: continue
                    spot = float(h["Close"].dropna().iloc[-1])
                    info = tk.fast_info or {}
                    expiries = tk.options
                    if not expiries: continue
                    chain = tk.option_chain(expiries[0])
                    calls_vol = float(chain.calls["volume"].fillna(0).sum())
                    puts_vol  = float(chain.puts["volume"].fillna(0).sum())
                    pc_ratio  = round(puts_vol / calls_vol, 2) if calls_vol > 0 else 1.0
                    avg_vol   = getattr(info, "three_month_average_volume", None) or 1
                    curr_vol  = getattr(info, "last_volume", None) or 0
                    rel_vol   = round(curr_vol / avg_vol, 1) if avg_vol else 1.0
                    unusual   = rel_vol > 2.0 or (calls_vol + puts_vol) > 50000
                    bias = "bearish" if pc_ratio > 1.5 else ("bullish" if pc_ratio < 0.7 else "neutral")
                    options_flow.append({"ticker": t, "spot": round(spot, 2),
                        "calls_vol": int(calls_vol), "puts_vol": int(puts_vol),
                        "pc_ratio": pc_ratio, "rel_vol": rel_vol,
                        "unusual": unusual, "bias": bias})
                except Exception:
                    pass

            return _json_safe({"macro_events": upcoming, "options_flow": options_flow})

        cache_key = f"map-data:{','.join(sorted(ticker_list))}"
        return _cached_swr(cache_key, produce, ttl=600, stale_ttl=3600)

    @app.get("/yt-insights")
    def yt_insights_endpoint():
        """Market Pulse: RSS for recent video IDs/titles + YouTube Data API v3 for
        description/tags, then Claude expands the thesis implied by the title.
        Transcripts are NOT used — YouTube blocks timedtext from datacenter IPs."""
        def produce():
            import json as _json, re as _re, urllib.request, urllib.parse
            import xml.etree.ElementTree as _ET
            from concurrent.futures import ThreadPoolExecutor, wait as _wait

            # YouTube blocks transcript fetching (timedtext) from datacenter IPs like
            # Render, but the Data API v3 and RSS feeds are NOT blocked. Approach:
            #   RSS  -> recent video IDs + titles (free, no quota)
            #   Data API videos.list -> full description + tags (1 unit/call, batched)
            #   Claude -> expand the thesis implied by the title using market knowledge
            YT_API_KEY = os.getenv("YT_API_KEY", "").strip()

            _YT_NS = {
                "atom":  "http://www.w3.org/2005/Atom",
                "yt":    "http://www.youtube.com/xml/schemas/2015",
                "media": "http://search.yahoo.com/mrss/",
            }
            def _fetch_rss(channel_id):
                url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=5) as r:   # tight 5s socket timeout
                    return _ET.fromstring(r.read())

            def _parse_entries(root):
                entries = []
                for entry in root.findall("atom:entry", _YT_NS)[:10]:
                    vid   = entry.findtext("yt:videoId",  namespaces=_YT_NS) or ""
                    title = entry.findtext("atom:title",  namespaces=_YT_NS) or ""
                    pub   = (entry.findtext("atom:published", namespaces=_YT_NS) or "")[:10]
                    link_el = entry.find("atom:link[@rel='alternate']", _YT_NS)
                    link  = link_el.get("href") if link_el is not None else f"https://youtube.com/watch?v={vid}"
                    raw   = entry.findtext("media:group/media:description", namespaces=_YT_NS) or ""
                    desc  = _re.sub(r"<[^>]+>", "", raw).strip()
                    combo = (title + " " + desc + " " + link).lower()
                    is_short = "#short" in combo or "/shorts/" in link
                    entries.append({"vid": vid, "title": title, "link": link,
                                    "pub": pub, "desc": desc, "is_short": is_short})
                return entries

            def _fetch_video_meta(vids):
                """Batch-fetch description + tags from YouTube Data API v3 (videos.list).
                Costs 1 quota unit per call regardless of how many IDs (up to 50).
                Returns {vid: {"description": str, "tags": [..]}}. {} if no key/error."""
                vids = [v for v in vids if v]
                if not YT_API_KEY or not vids:
                    return {}
                params = urllib.parse.urlencode({
                    "part": "snippet",
                    "id": ",".join(vids[:50]),
                    "key": YT_API_KEY,
                })
                url = f"https://www.googleapis.com/youtube/v3/videos?{params}"
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                try:
                    with urllib.request.urlopen(req, timeout=6) as r:
                        payload = _json.loads(r.read())
                except Exception:
                    return {}
                out = {}
                for item in payload.get("items", []):
                    sn = item.get("snippet", {}) or {}
                    out[item.get("id", "")] = {
                        "description": (sn.get("description") or "").strip(),
                        "tags": sn.get("tags") or [],
                    }
                return out

            ai_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

            def _expand_thesis(analyst, v):
                """Claude reads the title + tags + description (NO transcript — blocked on
                Render) and expands the implied thesis using its market knowledge."""
                tags = ", ".join(v.get("tags", [])[:15])
                desc = (v.get("desc") or "")[:600]
                prompt = (
                    f"You are a market strategist interpreting a finance YouTube video for a "
                    f"stock investor. You are given the video's title, tags, and description — "
                    f"NOT a transcript. For this analyst the TITLE typically states the actual "
                    f"thesis (e.g. 'Bonds are telling you where stocks rotate next' IS the call).\n\n"
                    f"Analyst: {analyst['name']} — focus: {analyst['focus']}\n"
                    f"Video title: {v['title']}\n"
                    f"Tags: {tags or '(none)'}\n"
                    f"Description (often mostly promo — ignore links, codes, and CTAs): {desc or '(none)'}\n\n"
                    f"TASK: Infer the thesis the analyst is making and EXPAND it using your own "
                    f"knowledge of current markets. Produce 2-3 concrete, actionable insights for "
                    f"an investor — name the specific stocks, sectors, asset classes, rates, or "
                    f"macro forces implied. Frame as: given the analyst said X, here is what that "
                    f"means for investors. Be specific; do not restate the title verbatim.\n\n"
                    f"Respond with JSON only, no markdown:\n"
                    f'{{"insights": ["insight 1", "insight 2", "insight 3"], '
                    f'"takeaway": "one sentence — the single most important implication for an investor", '
                    f'"sentiment": "bullish" | "bearish" | "neutral"}}'
                )
                try:
                    rsp = ai_client.messages.create(
                        model="claude-haiku-4-5-20251001", max_tokens=450,
                        messages=[{"role": "user", "content": prompt}]
                    )
                    raw = rsp.content[0].text.strip()
                    if raw.startswith("```"):
                        raw = _re.sub(r"^```(?:json)?\s*|\s*```$", "", raw).strip()
                    data = _json.loads(raw)
                except Exception:
                    data = {}

                points = [str(p).strip() for p in (data.get("insights") or []) if str(p).strip()]
                if not points:
                    points = [v["title"]]   # title alone is the thesis — never drop the video
                sent = str(data.get("sentiment", "neutral")).lower()
                if sent not in ("bullish", "bearish", "neutral"):
                    sent = "neutral"
                takeaway = str(data.get("takeaway", "")).strip() or points[0]
                return {
                    "title": v["title"], "link": v["link"], "published": v["pub"],
                    "source": "data-api",
                    "points": points[:3],
                    "summary": points[0],          # back-compat for older frontend
                    "takeaway": takeaway,
                    "sentiment": sent,
                }

            # Per analyst: take the 2 most relevant recent uploads (Shorts first for
            # analysts who post them), enrich with Data API metadata, expand each thesis.
            TARGET = 2

            def _process_analyst(analyst):
                try:
                    root = _fetch_rss(analyst["channel_id"])
                except Exception as e:
                    return {"id": analyst["id"], "name": analyst["name"],
                            "label": analyst["label"], "weight": analyst["weight"],
                            "error": f"RSS: {e}", "insights": []}

                candidates = _parse_entries(root)
                if analyst.get("shorts_first"):
                    shorts = [c for c in candidates if c["is_short"]]
                    others = [c for c in candidates if not c["is_short"]]
                    candidates = shorts + others  # prioritize Shorts, keep rest as fallback

                target = candidates[:TARGET]
                if not target:
                    return {"id": analyst["id"], "name": analyst["name"],
                            "label": analyst["label"], "weight": analyst["weight"],
                            "insights": []}

                # One batched Data API call enriches all target videos with tags + full desc
                meta = _fetch_video_meta([v["vid"] for v in target])
                insights = []
                for v in target:
                    m = meta.get(v["vid"])
                    if m:
                        if m.get("description"):
                            v["desc"] = m["description"]   # Data API desc is fuller than RSS
                        v["tags"] = m.get("tags", [])
                    insights.append(_expand_thesis(analyst, v))

                return {"id": analyst["id"], "name": analyst["name"],
                        "label": analyst["label"], "weight": analyst["weight"],
                        "insights": insights}

            # Run all 9 analysts in parallel but cap total wall-clock at 22s
            # (leaves 8s buffer before Render's 30s request timeout)
            results_map = {}
            deadline = 22  # seconds
            with ThreadPoolExecutor(max_workers=5) as pool:
                futures = {pool.submit(_process_analyst, a): a["id"] for a in ANALYSTS}
                done, pending = _wait(list(futures), timeout=deadline)
                for fut in pending:
                    fut.cancel()
                    aid = futures[fut]
                    results_map[aid] = {"id": aid, "error": "timeout", "insights": []}
                for fut in done:
                    aid = futures[fut]
                    try:
                        results_map[aid] = fut.result()
                    except Exception as e:
                        results_map[aid] = {"id": aid, "error": str(e), "insights": []}

            analysts_out = [results_map.get(a["id"], {"id": a["id"], "name": a["name"],
                "label": a["label"], "weight": a["weight"], "insights": []}) for a in ANALYSTS]
            return _json_safe({"analysts": analysts_out, "data_api": bool(YT_API_KEY)})

        # Data API metadata + Claude thesis expansion is expensive — cache 6h, serve stale up to 24h.
        return _cached_swr("yt-insights", produce, ttl=21600, stale_ttl=86400)

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
    def outlook_endpoint(profile: str = ""):
        def produce():
            try:
                from scanner import _lenient_json, fetch_climate, fetch_sectors
                climate = fetch_climate()
                sectors = fetch_sectors()
                top = sorted(sectors, key=lambda s: s.get("month",0), reverse=True)[:3]
                bot = sorted(sectors, key=lambda s: s.get("month",0))[:2]
                sc  = climate.get("macro_score", 50)
                profile_block = _profile_ctx(profile)
                profile_line = f"\n{profile_block}" if profile_block else ""
                client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
                prompt = f"""Market strategist. Date: {datetime.date.today()}. Macro: {sc}/100 ({climate.get('posture','neutral')}).
Top sectors (1mo): {', '.join(s['name']+' '+str(s.get('month',0))+'%' for s in top)}
Lagging: {', '.join(s['name']+' '+str(s.get('month',0))+'%' for s in bot)}{profile_line}

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

    @app.get("/why-now")
    def why_now_endpoint(ticker: str, profile: str = ""):
        """Fresh AI take on today's specific price action — no caching."""
        ticker = ticker.upper().strip()
        tech = technicals(ticker)
        if tech is None:
            return {"error": "No data found"}
        try:
            client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
            w52h, w52l, spot = tech.get('week52High'), tech.get('week52Low'), tech.get('spot')
            w52_pct = ""
            if w52h and w52l and spot and w52h != w52l:
                pct = (spot - w52l) / (w52h - w52l) * 100
                w52_pct = f"(52W: {pct:.0f}th %ile)"
            earn_ctx = f"earnings in {tech['daysToEarn']}d" if tech.get('daysToEarn') is not None else ""
            profile_block = _profile_ctx(profile)
            profile_line = f"\n{profile_block}" if profile_block else ""
            prompt = f"""Sharp market analyst. Today: {datetime.date.today()}.

{ticker} ({tech['name']}) is at ${spot} ({tech['chg']:+.1f}% TODAY) {w52_pct}.
RSI {tech['rsi']} | IV {tech['iv']}% | P/C {tech.get('pcRatio','n/a')} | Rel Vol {tech.get('relVol','?')}× {earn_ctx}{profile_line}

Write ONE crisp paragraph (under 110 words) answering:
What is happening to this stock TODAY specifically? Is today's move meaningful signal or just noise?
What should a trader watching this right now pay attention to or do?

Be direct. Specific numbers. No hedging. No "it could go either way." Take a position."""
            r = client.messages.create(model="claude-sonnet-4-6", max_tokens=220,
                messages=[{"role":"user","content":prompt}])
            return _json_safe({"ticker":ticker,"take":r.content[0].text.strip(),
                               "spot":tech['spot'],"chg":tech['chg']})
        except Exception as e:
            return {"error":str(e)}

    @app.post("/portfolio-analysis")
    def portfolio_analysis_endpoint(payload: dict = Body(default={})):
        """AI analysis of the full portfolio as a book. Not cached — always fresh."""
        positions_in = payload.get("positions") or []
        analytics    = payload.get("analytics") or {}
        cash_val     = float(payload.get("cash") or 0)
        profile_str  = payload.get("profile") or ""

        if not positions_in:
            return {"error": "No positions provided"}
        try:
            client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

            profile_block = _profile_ctx(profile_str)
            profile_parts = profile_str.split("|") if profile_str else []
            risk  = profile_parts[0] if len(profile_parts) > 0 else "moderate"
            goal  = profile_parts[1] if len(profile_parts) > 1 else "growth"
            style = profile_parts[2] if len(profile_parts) > 2 else "swing"

            # Summarize positions
            pos_lines = []
            for p in positions_in:
                ticker = p.get("ticker","?")
                typ    = p.get("type","?")
                strike = p.get("strike")
                expiry = p.get("expiry","")
                qty    = p.get("qty",0)
                pnl    = p.get("pnl") or 0
                pnl_pct= (p.get("pnl_pct") or 0)*100
                val    = p.get("current_val") or 0
                dte    = p.get("dte")
                stage  = p.get("stage","")
                conv   = p.get("conviction","")
                delta  = p.get("delta")
                theta  = p.get("theta")
                iv_raw = p.get("iv")
                iv     = f"{iv_raw*100:.0f}%" if iv_raw else "—"

                label = f"{ticker} ${strike}{typ[0]}" if strike else f"{ticker} {typ}"
                dte_s = f"DTE {dte}d · " if dte else ""
                greeks_s = ""
                if delta is not None and theta is not None:
                    greeks_s = f" | Δ{delta:.2f} Θ${theta:.2f}/day"
                pos_lines.append(
                    f"  • {label} qty={qty} | ${val:,.0f} val | P&L ${pnl:+,.0f} ({pnl_pct:+.1f}%) | "
                    f"{dte_s}IV {iv} | {stage} {conv}{greeks_s}"
                )

            total_val  = analytics.get("total_value") or 0
            total_pnl  = analytics.get("total_pnl") or 0
            net_delta  = analytics.get("net_delta") or 0
            daily_theta= analytics.get("daily_theta") or 0
            sector_alloc = analytics.get("sector_alloc") or {}
            sector_s   = " · ".join(f"{k} {v*100:.0f}%" for k,v in sorted(sector_alloc.items(), key=lambda x:-x[1]))

            prompt = f"""You are a senior portfolio manager reviewing a client's holdings on {datetime.date.today()}.

{profile_block}

PORTFOLIO SNAPSHOT:
Total Value: ${total_val:,.0f} | Cash: ${cash_val:,.0f} | Combined: ${total_val+cash_val:,.0f}
Total P&L: ${total_pnl:+,.0f} | Net Delta: {net_delta:.0f} | Daily Theta: ${daily_theta:.2f}/day
Sector Exposure: {sector_s or "—"}

POSITIONS:
{chr(10).join(pos_lines)}

Analyze this portfolio as a WHOLE BOOK — not individual stocks. Think like a portfolio manager.
Personalize every insight to the trader's profile above.

JSON ONLY — no markdown:
{{
  "health_score": "Strong"|"Balanced"|"At Risk"|"Needs Attention",
  "health_summary": "<one-line overall portfolio health — specific, not generic>",
  "concentration": "<concentration risk in plain English: what is too heavy, what % it is, why it matters for THIS trader's profile>",
  "greeks_plain": "<Greeks in plain English: what the net delta and daily theta MEAN in real terms — e.g. 'You lose $X/day to theta and need X% up move in Y days to break even'. Calibrate urgency to trader profile.>",
  "opportunity": {{"ticker":"<ticker>","reason":"<1-2 sentences: why THIS position has the most upside right now, specific>"}},
  "risk": {{"ticker":"<ticker>","reason":"<1-2 sentences: what makes THIS the most vulnerable right now, what to watch>"}},
  "recommendation": "<2-3 sentences: what this specific portfolio needs right now — specific action, e.g. trim X to reduce concentration, add hedge in Y, take profits on Z. Calibrated to their risk profile.>"
}}

Be direct, specific, and personalized. Do NOT flag concentration as a problem for aggressive/degen traders — that's their style."""

            r = client.messages.create(model="claude-sonnet-4-6", max_tokens=1000,
                messages=[{"role":"user","content":prompt}])
            from scanner import _lenient_json
            data = _lenient_json(r.content[0].text)
            return _json_safe({"generated_at": datetime.datetime.now().isoformat(), **data})
        except Exception as e:
            return {"error": str(e)}

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
        # NOTE: This endpoint is for the standalone monitor (run_daily.py) and uses the
        # hardcoded PORTFOLIO constant. The frontend uses POST /value instead, which accepts
        # user-entered positions. This endpoint is NOT called by App.jsx.
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
        # Enrich each active position with stage/conviction from cached research.
        for p in active:
            sc, conviction, stage = None, None, None
            rb = {}
            try:
                rb = _cached(f"research:{p['ticker']}", lambda t=p['ticker']: research(t))
                sc         = rb.get("score")
                conviction = rb.get("conviction")
                stage      = rb.get("stage")
            except Exception:
                pass
            # Map conviction to 0-100 for the Signal column; fall back to numeric score
            if   conviction == "Strong Setup":    sc_num = 80
            elif conviction == "Risky Setup":     sc_num = 20
            elif conviction == "Watch and Wait":  sc_num = 50
            else: sc_num = round(sc * 10) if isinstance(sc, (int, float)) else None
            p["score"]      = sc_num
            p["stage"]      = stage
            p["conviction"] = conviction
            p["reason"]       = rb.get("reason")
            p["trade_levels"] = rb.get("trade_levels")
            rec = _recommend(sc, p.get("pnl_pct"), p.get("dte"), conviction)
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
