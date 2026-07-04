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

    # RSI(14), Wilder's smoothing (the standard used by TradingView/brokers —
    # an SMA variant here previously read ~2pts off those platforms). Keep the
    # rolling series so the UI can draw the RSI graph, not just the last value.
    delta = c.diff()
    up    = delta.clip(lower=0).ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    dn    = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    rsi_series = (100 - 100/(1 + up/dn)).where(dn != 0, 100.0)
    rsi   = float(rsi_series.iloc[-1]) if rsi_series.iloc[-1] == rsi_series.iloc[-1] else 50.0
    rsi_history = [round(float(x), 1) for x in rsi_series.tail(252).tolist() if x == x]  # full year, drop NaN

    # ── Moving averages (SMA 20/50/200) + trend read ────────────────────────
    def _sma_last(n):
        return float(c.rolling(n).mean().iloc[-1]) if len(c) >= n else None
    ma20, ma50, ma200 = _sma_last(20), _sma_last(50), _sma_last(200)
    def _pct(v):   # price vs a MA, as a signed %
        return round((spot / v - 1) * 100, 2) if (v and spot) else None
    # 50/200 cross within the last ~15 sessions → golden / death cross
    cross = None
    if len(c) >= 200:
        s50, s200 = c.rolling(50).mean(), c.rolling(200).mean()
        diff = (s50 - s200).dropna()
        if len(diff) >= 16:
            recent = diff.iloc[-15:]
            now_pos = recent.iloc[-1] > 0
            was_pos = recent.iloc[0] > 0
            if now_pos and not was_pos:   cross = "golden"   # 50 crossed above 200 (bullish)
            elif not now_pos and was_pos: cross = "death"    # 50 crossed below 200 (bearish)
    # Trend read from the stack of price vs 50 vs 200
    above50  = ma50  is not None and spot >  ma50
    above200 = ma200 is not None and spot >  ma200
    if ma50 and ma200:
        if above50 and above200 and ma50 > ma200:      ma_trend = "uptrend"      # bullish stack
        elif not above50 and not above200 and ma50 < ma200: ma_trend = "downtrend"
        else:                                          ma_trend = "mixed"
    elif ma50 is not None:
        ma_trend = "uptrend" if above50 else "downtrend"
    else:
        ma_trend = "n/a"
    ma_block = {
        "ma20": round(ma20, 2) if ma20 else None,
        "ma50": round(ma50, 2) if ma50 else None,
        "ma200": round(ma200, 2) if ma200 else None,
        "vs20": _pct(ma20), "vs50": _pct(ma50), "vs200": _pct(ma200),
        "trend": ma_trend, "cross": cross,
    }

    # ── Tactical setup: mean reversion filtered by trend ────────────────────
    # The edge isn't "oversold" alone — it's WHERE the oversold reading happens.
    # Oversold inside an uptrend (still above the 200-day) is a high-odds
    # buy-the-dip; oversold in a downtrend is a falling knife. This deterministic
    # read is always available (no AI), from RSI × the 200-day trend filter.
    tactical = None
    rsi_v = rsi
    vs200 = ma_block.get("vs200")
    if rsi_v is not None and vs200 is not None:
        uptrend = vs200 > 0
        if rsi_v < 35 and uptrend:
            tactical = {"key": "dip_in_uptrend", "label": "Buy-the-Dip Setup", "tone": "bullish",
                        "note": "Oversold, but price is still above its 200-day — a pullback within an intact "
                                "uptrend. The higher-odds side of mean reversion."}
        elif rsi_v < 35 and not uptrend:
            tactical = {"key": "falling_knife", "label": "Falling-Knife Risk", "tone": "bearish",
                        "note": "Oversold AND below the 200-day — a downtrend, where cheap often gets cheaper. "
                                "The low-odds side of mean reversion."}
        elif rsi_v > 70 and uptrend:
            tactical = {"key": "extended", "label": "Extended / Overbought", "tone": "caution",
                        "note": "Strong uptrend but stretched — momentum is real, though chasing here risks "
                                "buying a near-term top. Wait for a pullback."}
        elif rsi_v > 70 and not uptrend:
            tactical = {"key": "bounce_fading", "label": "Counter-Trend Bounce", "tone": "bearish",
                        "note": "Overbought inside a downtrend — a relief rally into resistance that often fades."}
        else:
            tactical = {"key": "neutral", "label": "No Setup", "tone": "neutral",
                        "note": "RSI mid-range — no tactical mean-reversion edge right now."}

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

    _T = ticker.upper().strip()
    is_crypto = _T.endswith("-USD")
    _METAL_TICKERS = {
        "GLD","IAU","SGOL","GLDM","BAR","OUNZ","AAAU","SLV","SIVR","PSLV","PPLT","PALL",
        "GLTR","DBP","GDX","GDXJ","SIL","SILJ","RING","NUGT",
        "GC=F","MGC=F","SI=F","SIL=F","PL=F","PA=F","HG=F",
    }
    sector = ("Crypto" if is_crypto else
              "Precious Metals" if _T in _METAL_TICKERS else
              info.get("sector", "—"))
    return {
        "name":       info.get("longName") or info.get("shortName") or ticker,
        "sector":     sector,
        "mktCap":     mc_str,
        "spot":       round(spot, 2),
        "chg":        round(chg, 2),
        "rsi":        round(rsi, 1),
        "rsi_history": rsi_history,
        "ma": ma_block,
        "tactical": tactical,
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
    """Convert profile string 'risk|goal|style|level' into an AI instruction block.
    Goal and style segments may be comma lists (the profiler is multi-select),
    e.g. 'moderate|growth|swing,longterm|intermediate' for a swing + long-term blend."""
    if not profile:
        return ""
    parts = profile.split("|")
    risk   = (parts[0] if len(parts) > 0 else "").strip() or "moderate"
    goals  = [g.strip() for g in (parts[1] if len(parts) > 1 else "").split(",") if g.strip()] or ["growth"]
    styles = [s.strip() for s in (parts[2] if len(parts) > 2 else "").split(",") if s.strip()] or ["swing"]
    level  = (parts[3] if len(parts) > 3 else "").strip() or "intermediate"
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
    goal_txt  = " + ".join(goal_map.get(g, g) for g in goals)
    style_txt = " + ".join(style_map.get(s, s) for s in styles)
    lines = [
        f"TRADER PROFILE (tailor ALL analysis and recommendations to this user):",
        f"  Risk Tolerance: {risk_map.get(risk, risk)}",
        f"  Primary Goal{'s' if len(goals)>1 else ''}: {goal_txt}",
        f"  Trading Style{'s' if len(styles)>1 else ''}: {style_txt}",
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
    if "income" in goals:
        lines.append("  → Lean toward premium-selling ideas (covered calls, cash-secured puts, credit spreads).")
    if "options" in styles:
        lines.append("  → Emphasize Greeks analysis, IV rank, options structure, and theta management.")
    if "daytrader" in styles:
        lines.append("  → Focus on intraday setups, momentum, and tight stops. Ignore long-term fundamentals.")
    if "longterm" in styles and (set(styles) & {"swing","daytrader"}):
        lines.append("  → BLENDED HORIZON: this user runs long-term core holdings AND shorter tactical trades. "
                     "For every recommendation, say WHICH horizon it serves — a core-holding thesis change vs. "
                     "a tactical entry/exit — and never apply short-term exit logic to a long-term core position.")
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


# ── FINANCIALS / FUNDAMENTALS (free, yfinance) ────────────────────────────────
# Approximate sector-median valuation multiples used as a fast, free reference so
# a single-ticker view can flag "cheap vs sector" without fetching a whole peer
# group. Ballpark market figures — refine over time; kept intentionally simple.
_SECTOR_MULTIPLES = {
    "Technology":             {"forwardPE":27, "trailingPE":32, "peg":2.0, "ps":7.0, "pb":8.0, "evEbitda":20},
    "Communication Services": {"forwardPE":18, "trailingPE":21, "peg":1.5, "ps":3.5, "pb":3.5, "evEbitda":11},
    "Consumer Cyclical":      {"forwardPE":20, "trailingPE":24, "peg":1.6, "ps":1.8, "pb":5.0, "evEbitda":13},
    "Consumer Defensive":     {"forwardPE":20, "trailingPE":22, "peg":2.5, "ps":1.5, "pb":4.0, "evEbitda":13},
    "Healthcare":             {"forwardPE":18, "trailingPE":24, "peg":1.8, "ps":4.0, "pb":4.0, "evEbitda":14},
    "Financial Services":     {"forwardPE":14, "trailingPE":15, "peg":1.4, "ps":3.0, "pb":1.6, "evEbitda":11},
    "Industrials":            {"forwardPE":20, "trailingPE":24, "peg":2.0, "ps":2.2, "pb":5.0, "evEbitda":14},
    "Energy":                 {"forwardPE":12, "trailingPE":13, "peg":1.2, "ps":1.4, "pb":1.8, "evEbitda":6},
    "Utilities":              {"forwardPE":17, "trailingPE":19, "peg":3.0, "ps":2.5, "pb":1.8, "evEbitda":11},
    "Real Estate":            {"forwardPE":30, "trailingPE":35, "peg":2.5, "ps":6.0, "pb":2.2, "evEbitda":17},
    "Basic Materials":        {"forwardPE":15, "trailingPE":18, "peg":1.6, "ps":1.6, "pb":2.0, "evEbitda":8},
}
_SECTOR_DEFAULT = {"forwardPE":20, "trailingPE":22, "peg":1.8, "ps":3.0, "pb":3.0, "evEbitda":13}


def _num(x):
    """Coerce to a finite float or None."""
    try:
        f = float(x)
        return f if np.isfinite(f) else None
    except Exception:
        return None


def _stmt_row(df, *names):
    """Return a statement row (list, newest→oldest) by trying several label spellings."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            return [_num(v) for v in df.loc[n].tolist()]
    return None


def fundamentals(ticker):
    """Full fundamentals + valuation bundle for the Financials page. Free (yfinance)."""
    ticker = ticker.upper().strip()
    tk = yf.Ticker(ticker)
    info = {}
    try: info = tk.info or {}
    except Exception: info = {}
    if not info.get("longName") and not info.get("shortName") and not info.get("regularMarketPrice"):
        # Might still have statements; but with nothing, bail
        pass

    try: inc = tk.income_stmt
    except Exception: inc = None
    try: bal = tk.balance_sheet
    except Exception: bal = None
    try: cf  = tk.cashflow
    except Exception: cf  = None

    # Annual series (yfinance columns are newest→oldest). Reverse to oldest→newest.
    dates = []
    try:
        if inc is not None and not inc.empty:
            dates = [c.strftime("%Y") for c in inc.columns][::-1]
    except Exception:
        dates = []

    rev   = _stmt_row(inc, "Total Revenue", "Operating Revenue")
    ni    = _stmt_row(inc, "Net Income", "Net Income Common Stockholders", "Net Income Continuous Operations")
    eps   = _stmt_row(inc, "Diluted EPS", "Basic EPS")
    gp    = _stmt_row(inc, "Gross Profit")
    cor   = _stmt_row(inc, "Cost Of Revenue", "Reconciled Cost Of Revenue")
    opinc = _stmt_row(inc, "Operating Income", "Total Operating Income As Reported")
    fcf   = _stmt_row(cf,  "Free Cash Flow")
    ocf   = _stmt_row(cf,  "Operating Cash Flow", "Cash Flow From Continuing Operating Activities")
    capex = _stmt_row(cf,  "Capital Expenditure")
    sh    = _stmt_row(bal, "Ordinary Shares Number", "Share Issued")

    def rev_at(i):
        return rev[i] if rev and i < len(rev) and rev[i] else None

    # Derive FCF if missing (OCF + capex, capex is negative in yfinance)
    if not fcf and ocf and capex:
        fcf = [ (ocf[i] + capex[i]) if (ocf[i] is not None and capex[i] is not None) else None
                for i in range(min(len(ocf), len(capex))) ]

    def series(vals):
        return list(reversed(vals)) if vals else []

    # Per-year margins
    gross_m, op_m, net_m = [], [], []
    n = len(rev) if rev else 0
    for i in range(n):
        r = rev[i]
        g = gp[i] if gp and i < len(gp) else (
            (r - cor[i]) if (cor and i < len(cor) and r is not None and cor[i] is not None) else None)
        gross_m.append((g / r) if (g is not None and r) else None)
        op_m.append((opinc[i] / r) if (opinc and i < len(opinc) and opinc[i] is not None and r) else None)
        net_m.append((ni[i] / r) if (ni and i < len(ni) and ni[i] is not None and r) else None)

    # Revenue growth YoY (oldest→newest order)
    rev_o = series(rev)
    rev_growth = []
    for i in range(1, len(rev_o)):
        p, c = rev_o[i-1], rev_o[i]
        rev_growth.append(((c / p - 1) * 100) if (p and c) else None)

    # Dilution: shares oldest→newest. Use first/last NON-None (yfinance leaves the
    # oldest balance-sheet column NaN for some names), so buybacks show as negative.
    sh_o = series(sh)
    dilution = None
    sh_valid = [x for x in sh_o if x]
    if len(sh_valid) >= 2:
        dilution = (sh_valid[-1] / sh_valid[0] - 1) * 100  # % change in share count over the window

    spot = _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice"))
    if spot is None:
        try:
            h = tk.history(period="5d")["Close"].dropna()
            spot = float(h.iloc[-1]) if not h.empty else None
        except Exception:
            spot = None

    sector = info.get("sector") or "—"
    smed = _SECTOR_MULTIPLES.get(sector, _SECTOR_DEFAULT)

    # ── Own-history valuation bands (approx): P/E and P/S per statement year ──
    # historical P/E = price at year-end / that year's diluted EPS
    # historical P/S = (price * shares) / revenue at year-end
    pe_hist, ps_hist = [], []
    try:
        ph = tk.history(period="6y", interval="1mo")["Close"].dropna()
        if inc is not None and not inc.empty and not ph.empty:
            for idx, col in enumerate(inc.columns):
                # nearest monthly close to the statement period end
                try:
                    price_at = float(ph[ph.index <= col.tz_localize(ph.index.tz) if ph.index.tz else col].iloc[-1]) \
                               if len(ph[ph.index <= (col.tz_localize(ph.index.tz) if ph.index.tz else col)]) else None
                except Exception:
                    price_at = None
                if price_at is None:
                    continue
                e = eps[idx] if eps and idx < len(eps) else None
                r = rev[idx] if rev and idx < len(rev) else None
                s = sh[idx] if sh and idx < len(sh) else None
                if e and e > 0:
                    pe_hist.append(price_at / e)
                if r and s:
                    ps_hist.append((price_at * s) / r)
    except Exception:
        pass

    def band(vals):
        vals = [v for v in vals if v is not None and np.isfinite(v) and v > 0]
        if not vals:
            return None
        return {"min": round(min(vals), 1), "avg": round(sum(vals) / len(vals), 1), "max": round(max(vals), 1)}

    pe_band = band(pe_hist)
    ps_band = band(ps_hist)

    def verdict(value, ref):
        """green(cheap)/yellow(fair)/red(expensive) for a lower-is-cheaper multiple."""
        if value is None or ref is None or ref <= 0:
            return None
        ratio = value / ref
        tag = "cheap" if ratio < 0.85 else ("expensive" if ratio > 1.15 else "fair")
        return {"ratio": round(ratio, 2), "verdict": tag}

    def metric(value, sector_ref, own_band):
        own_avg = own_band["avg"] if own_band else None
        return {
            "value": _num(value),
            "sector": sector_ref,
            "vs_sector": verdict(_num(value), sector_ref),
            "own_avg": own_avg,
            "own_band": own_band,
            "vs_own": verdict(_num(value), own_avg),
        }

    fpe = _num(info.get("forwardPE")); tpe = _num(info.get("trailingPE"))
    peg = _num(info.get("trailingPegRatio")) or _num(info.get("pegRatio"))
    ps  = _num(info.get("priceToSalesTrailing12Months"))
    pb  = _num(info.get("priceToBook")); ev = _num(info.get("enterpriseToEbitda"))

    valuation = {
        "forwardPE": metric(fpe, smed["forwardPE"], None),
        "trailingPE": metric(tpe, smed["trailingPE"], pe_band),
        "peg":       metric(peg, smed["peg"], None),
        "ps":        metric(ps,  smed["ps"],  ps_band),
        "pb":        metric(pb,  smed["pb"],  None),
        "evEbitda":  metric(ev,  smed["evEbitda"], None),
    }

    # ── Plain-English verdict line (no AI) ──
    def _x(v): return f"{v:.0f}x" if v is not None else "—"
    verdict_line = None
    if fpe:
        ref_sec = smed["forwardPE"]
        own_txt = f" and its own ~5yr avg of {pe_band['avg']:.0f}x" if pe_band else ""
        own_ref = pe_band["avg"] if pe_band else ref_sec
        blended = (ref_sec + own_ref) / 2
        if fpe < blended * 0.85:
            read = "undervalued, trading at a discount with room to re-rate higher"
        elif fpe > blended * 1.15:
            read = "richly valued, priced for strong execution with limited margin of safety"
        else:
            read = "reasonably valued, roughly in line with peers and its own history"
        verdict_line = (f"{ticker} trades at {_x(fpe)} forward earnings vs a "
                        f"{sector} sector median of {_x(ref_sec)}{own_txt} — {read}.")

    health = {
        "totalCash":  _num(info.get("totalCash")),
        "totalDebt":  _num(info.get("totalDebt")),
        "debtToEquity": _num(info.get("debtToEquity")),
        "currentRatio": _num(info.get("currentRatio")),
        "roe":        _num(info.get("returnOnEquity")),
        "roa":        _num(info.get("returnOnAssets")),
        "fcf":        _num(info.get("freeCashflow")),
        "grossMargin": _num(info.get("grossMargins")),
        "operatingMargin": _num(info.get("operatingMargins")),
        "netMargin":  _num(info.get("profitMargins")),
    }

    # ── Forward analyst estimates (avg/low/high per period: 0q,+1q,0y,+1y) ──
    # Powers the forward bars on the Financials charts, 2yr-forward P/E, and
    # the EPS/revenue growth rows in advanced metrics.
    def _est_dict(df):
        out = {}
        try:
            for period, row in df.iterrows():
                out[str(period)] = {"avg": _num(row.get("avg")), "low": _num(row.get("low")),
                                    "high": _num(row.get("high")), "growth": _num(row.get("growth"))}
        except Exception:
            pass
        return out
    est_rev, est_eps = {}, {}
    try: est_rev = _est_dict(tk.revenue_estimate)
    except Exception: pass
    try: est_eps = _est_dict(tk.earnings_estimate)
    except Exception: pass
    eps_1y = (est_eps.get("+1y") or {}).get("avg")
    eps_0y = (est_eps.get("0y") or {}).get("avg")
    advanced = {
        "fwd2PE":          (spot / eps_1y) if (spot and eps_1y and eps_1y > 0) else None,
        "epsGrowthTTM":    _num(info.get("earningsGrowth")),
        "epsGrowthCurrYr": (est_eps.get("0y") or {}).get("growth"),
        "epsGrowthNextYr": (est_eps.get("+1y") or {}).get("growth"),
        "revGrowthTTM":    _num(info.get("revenueGrowth")),
        "revGrowthCurrYr": (est_rev.get("0y") or {}).get("growth"),
        "revGrowthNextYr": (est_rev.get("+1y") or {}).get("growth"),
        "epsCurrYrEst":    eps_0y, "epsNextYrEst": eps_1y,
    }

    return _json_safe({
        "ticker": ticker,
        "name":   info.get("longName") or info.get("shortName") or ticker,
        "sector": sector,
        "industry": info.get("industry") or "—",
        "spot":   spot,
        "marketCap": _num(info.get("marketCap")),
        "years": dates,
        "trends": {
            "revenue":     series(rev),
            "netIncome":   series(ni),
            "eps":         series(eps),
            "grossMargin": series(gross_m),
            "operatingMargin": series(op_m),
            "netMargin":   series(net_m),
            "fcf":         series(fcf),
            "shares":      sh_o,
            "revenueGrowth": rev_growth,
        },
        "ttm": {
            "revenue":      _num(info.get("totalRevenue")),
            "revenueGrowth": _num(info.get("revenueGrowth")),
            "earningsGrowth": _num(info.get("earningsGrowth")),
            "trailingEps":  _num(info.get("trailingEps")),
            "forwardEps":   _num(info.get("forwardEps")),
        },
        "dilution": dilution,
        "health": health,
        "valuation": valuation,
        "estimates": {"revenue": est_rev, "eps": est_eps},
        "advanced": advanced,
        "verdict": verdict_line,
        # Base inputs for the editable fair-value model (frontend recomputes live)
        "fairValueInputs": {
            "revenue":     _num(info.get("totalRevenue")),
            "revenueGrowth": (_num(info.get("revenueGrowth")) or 0.10),
            "netMargin":   (_num(info.get("profitMargins")) or 0.15),
            "shares":      _num(info.get("sharesOutstanding")),
            "fcf":         _num(info.get("freeCashflow")),
            "spot":        spot,
            "exitPE":      smed["forwardPE"],
        },
    })


def business_quality(ticker, fund, profile: str = ""):
    """AI business-quality analysis for a 3-5yr core holding. Runs only when ai=1."""
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    t = fund.get("trends", {}); h = fund.get("health", {}); v = fund.get("valuation", {})
    def last(lst):
        lst = [x for x in (lst or []) if x is not None]
        return lst[-1] if lst else None
    def pct(x): return f"{x*100:.1f}%" if x is not None else "—"
    rev_series = t.get("revenue") or []
    prof_block = _profile_ctx(profile)
    prof_line = f"\n{prof_block}\n" if prof_block else ""
    fpe = (v.get("forwardPE") or {}).get("value")
    prompt = f"""You are a long-term business-quality analyst evaluating {fund.get('name')} ({ticker}) as a
POTENTIAL 3-5 YEAR CORE HOLDING — not a swing trade. Sector: {fund.get('sector')}, {fund.get('industry')}.
{prof_line}
FUNDAMENTALS (yfinance):
- Revenue trend ({', '.join(fund.get('years',[]))}): {rev_series}
- Revenue growth TTM: {pct((fund.get('ttm') or {}).get('revenueGrowth'))}
- Gross margin: {pct(h.get('grossMargin'))} · Operating margin: {pct(h.get('operatingMargin'))} · Net margin: {pct(h.get('netMargin'))}
- ROE: {pct(h.get('roe'))} · Free cash flow: {h.get('fcf')}
- Total cash: {h.get('totalCash')} · Total debt: {h.get('totalDebt')} · Current ratio: {h.get('currentRatio')}
- Share count trend (dilution % over window): {fund.get('dilution')}
- Forward P/E: {fpe} · Valuation verdict: {fund.get('verdict')}

Weight your analysis toward BUSINESS QUALITY and MOAT DURABILITY. Channel the frameworks of
trusted long-term analysts: Financial Education (Jeremy) on management & growth runway, Jerry Romine
on deep financial quality, Stealth Wealth on disciplined valuation, and Ticker Symbol YOU on the
durability of a tech/product moat.

Respond with JSON only, no markdown:
{{
  "quality_score": <1-10 integer, business quality & durability>,
  "direction": "strengthening" | "stable" | "weakening",
  "moat": "<1-2 sentences: what the moat is and whether it's widening or eroding>",
  "market_opportunity": "<1-2 sentences: is the TAM large and growing?>",
  "entry_read": "<1-2 sentences: is the CURRENT price a good long-term entry for this trader?>",
  "bull": "<the single strongest reason to own this for 5 years>",
  "bear": "<the single biggest long-term risk>",
  "verdict": "<one plain-English sentence: high-quality compounder, fair, or avoid — and why>"
}}"""
    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=900,
        messages=[{"role": "user", "content": prompt}])
    from scanner import _lenient_json
    return _lenient_json(r.content[0].text)


# ── STOCK SCREENER (free, yfinance) ───────────────────────────────────────────
# Preset market universe. Starts with major S&P 500 constituents; expand freely —
# the screener batches through this list so a longer list just takes more passes.
_SP500 = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","BRK-B","LLY","AVGO","TSLA","JPM","WMT","V",
    "UNH","XOM","MA","ORCL","JNJ","HD","PG","COST","ABBV","BAC","KO","MRK","CVX","CRM","NFLX","AMD",
    "PEP","TMO","LIN","ADBE","ACN","MCD","CSCO","ABT","WFC","DHR","GE","QCOM","TXN","IBM","NOW","PM",
    "CAT","INTU","VZ","DIS","AXP","AMGN","ISRG","MS","PFE","GS","RTX","SPGI","NEE","UNP","T","LOW",
    "HON","BKNG","COP","UBER","BLK","SYK","PLD","TJX","VRTX","C","MDT","ADP","GILD","LMT","MMC","CB",
    "BSX","AMAT","ADI","BA","SBUX","MDLZ","DE","REGN","ETN","PANW","CI","BMY","SO","MU","KLAC","SCHW",
    "DUK","ANET","ICE","SHW","APH","MO","ZTS","PGR","CL","EQIX","SNPS","CMG","USB","WM","AON","ITW",
    "CDNS","TT","PYPL","MSI","CME","GD","EOG","CVS","BDX","MCK","NOC","FCX","EMR","PH","MAR","CRWD",
    "MMM","ORLY","APD","ROP","PNC","TDG","ECL","COF","CARR","AJG","NXPI","HCA","WELL","PCAR","SPG",
    "OXY","AFL","MET","TFC","AIG","F","GM","DHI","HLT","NSC","PSA","AEP","TEL","O","SLB","KMB","D",
    "ADSK","FTNT","ROST","GWW","MCHP","JCI","IDXX","AMP","CCI","FIS","DLR","CTAS","EW","KVUE","VLO",
    "PSX","MPC","TRV","SRE","A","FDX","URI","CPRT","NEM","KMI","OKE","DOW","EXC","HUM","BK","GEHC",
    "PRU","XEL","CMI","LEN","VRSK","YUM","GIS","KR","ODFL","MLM","ACGL","CTVA","VMC","MNST"," WMB",
    "ED","IR","OTIS","EA","HES","DD","CSGP","KHC","AME","PWR","RSG","DFS","FICO","PPG","ON","ROK",
]
_SP500 = [t.strip() for t in _SP500 if t.strip()]


def screen_metrics(ticker):
    """Compact metric bundle for the screener. Cached long (~3h) — screening is free."""
    def produce():
        tk = yf.Ticker(ticker)
        try: info = tk.info or {}
        except Exception: info = {}
        if not info:
            return None
        return {
            "ticker": ticker,
            "name": info.get("shortName") or info.get("longName") or ticker,
            "sector": info.get("sector") or "—",
            "price": _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice")),
            "marketCap": _num(info.get("marketCap")),
            "forwardPE": _num(info.get("forwardPE")),
            "trailingPE": _num(info.get("trailingPE")),
            "peg": _num(info.get("trailingPegRatio")) or _num(info.get("pegRatio")),
            "ps": _num(info.get("priceToSalesTrailing12Months")),
            "evEbitda": _num(info.get("enterpriseToEbitda")),
            "revenueGrowth": _num(info.get("revenueGrowth")),
            "epsGrowth": _num(info.get("earningsGrowth")),
            "grossMargin": _num(info.get("grossMargins")),
            "roe": _num(info.get("returnOnEquity")),
            "fcf": _num(info.get("freeCashflow")),
            "debtToEquity": _num(info.get("debtToEquity")),
            "currentRatio": _num(info.get("currentRatio")),
        }
    return _cached_swr(f"screen:{ticker}", produce, ttl=10800, stale_ttl=86400)


def _passes(m, f):
    """True if metrics dict m passes every provided filter f. Missing data fails a set filter."""
    if m is None:
        return False
    def need(key, cond):
        v = m.get(key)
        return v is not None and cond(v)
    if f.get("fpe_max")     is not None and not need("forwardPE",  lambda v: v <= f["fpe_max"]):     return False
    if f.get("peg_max")     is not None and not need("peg",        lambda v: 0 < v <= f["peg_max"]):  return False
    if f.get("ps_max")      is not None and not need("ps",         lambda v: v <= f["ps_max"]):       return False
    if f.get("ev_max")      is not None and not need("evEbitda",   lambda v: v <= f["ev_max"]):       return False
    if f.get("rev_growth_min") is not None and not need("revenueGrowth", lambda v: v*100 >= f["rev_growth_min"]): return False
    if f.get("eps_growth_min") is not None and not need("epsGrowth",     lambda v: v*100 >= f["eps_growth_min"]): return False
    if f.get("gross_min")   is not None and not need("grossMargin",lambda v: v*100 >= f["gross_min"]): return False
    if f.get("roe_min")     is not None and not need("roe",        lambda v: v*100 >= f["roe_min"]):   return False
    if f.get("fcf_positive")               and not need("fcf",        lambda v: v > 0):                 return False
    if f.get("de_max")      is not None and not need("debtToEquity",lambda v: v <= f["de_max"]):       return False
    if f.get("cr_min")      is not None and not need("currentRatio",lambda v: v >= f["cr_min"]):       return False
    if f.get("cheap_vs_sector"):
        smed = _SECTOR_MULTIPLES.get(m.get("sector"), _SECTOR_DEFAULT)["forwardPE"]
        if not need("forwardPE", lambda v: 0 < v < smed):
            return False
    if f.get("mcap_min")    is not None and not need("marketCap",  lambda v: v >= f["mcap_min"]*1e9):  return False
    if f.get("mcap_max")    is not None and not need("marketCap",  lambda v: v <= f["mcap_max"]*1e9):  return False
    if f.get("sectors"):
        secs = [s.strip().lower() for s in f["sectors"] if s.strip()]
        if secs and (m.get("sector") or "").lower() not in secs:
            return False
    return True


# ── CHAT ASSISTANT (grounded Q&A over live data; runs only when ai=1) ─────────
_TICKER_STOP = {
    "A","I","THE","AND","OR","IS","IT","IF","TO","OF","IN","ON","AT","BE","DO","GO","MY","ME","AN",
    "AS","AI","US","PE","P","E","CEO","CFO","ETF","YOY","USD","DCF","EPS","ROE","ROA","TTM","IPO",
    "OK","VS","AM","PM","EV","FCF","PEG","RSI","IV","ATH","YTD","Q1","Q2","Q3","Q4","DTE","CALL","PUT",
    "BUY","SELL","HOLD","NOW","WHY","HOW","WHAT","WHEN","GET","OUT","UP","ALL","FOR","ARE","CAN","YOU",
}

def extract_tickers(text, extra=None):
    """Best-effort ticker detection: uppercase 1-5 letter tokens, plus any word (any
    case) that matches a ticker the user already tracks (watchlist/portfolio)."""
    import re
    out = []
    for c in re.findall(r"\b[A-Z]{1,5}\b", text or ""):
        if c not in _TICKER_STOP and c not in out:
            out.append(c)
    known = {str(t).upper() for t in (extra or [])}
    if known:
        for w in re.findall(r"\b[A-Za-z]{1,6}\b", text or ""):
            u = w.upper()
            if u in known and u not in out:
                out.append(u)
    return out[:4]


def _chat_ticker_context(t):
    """Compact, factual snapshot for one ticker pulled from cached research + fundamentals."""
    try:
        rb = _cached(f"research:{t}:0:", lambda: research(t, ai=False))
    except Exception:
        rb = None
    if not rb or rb.get("error"):
        return None
    parts = [f"{t}: ${rb.get('spot')} ({rb.get('chg')}% today), RSI {rb.get('rsi')}"]
    if rb.get("week52Low") and rb.get("week52High"):
        parts.append(f"52wk ${rb['week52Low']}–${rb['week52High']}")
    an = rb.get("analyst") or {}
    if an.get("targetMean"):
        parts.append(f"analyst target ${an['targetMean']} ({(an.get('recKey') or '').replace('_',' ')})")
    if rb.get("daysToEarn") is not None:
        parts.append(f"earnings in {rb['daysToEarn']}d")
    if rb.get("iv"):
        parts.append(f"IV {rb['iv']}%")
    line = " · ".join(str(p) for p in parts)
    try:
        fb = _cached_swr(f"fundamentals:{t}", lambda: fundamentals(t), ttl=3600, stale_ttl=21600)
        if fb and not fb.get("error"):
            v = fb.get("valuation") or {}
            fpe = (v.get("forwardPE") or {}).get("value")
            vs  = (v.get("forwardPE") or {}).get("vs_sector") or {}
            extra = []
            if fpe: extra.append(f"fwd P/E {round(fpe,1)}" + (f" ({vs.get('verdict')} vs sector)" if vs.get('verdict') else ""))
            if (fb.get('ttm') or {}).get('revenueGrowth') is not None:
                extra.append(f"rev growth {round(fb['ttm']['revenueGrowth']*100,1)}%")
            if fb.get("verdict"): extra.append(fb["verdict"])
            if extra: line += " | " + " · ".join(extra)
    except Exception:
        pass
    return line


def chat_reply(message, history=None, profile="", portfolio=None, watchlist=None):
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    known = list(watchlist or []) + [p.get("ticker") for p in (portfolio or []) if p.get("ticker")]
    tickers = extract_tickers(message, extra=known)
    # Also pull recent tickers referenced earlier in the conversation
    for h in (history or [])[-4:]:
        for c in extract_tickers(h.get("content",""), extra=known):
            if c not in tickers and len(tickers) < 4:
                tickers.append(c)

    ctx_blocks = []
    for t in tickers[:4]:
        c = _chat_ticker_context(t)
        if c: ctx_blocks.append(c)

    port_ctx = ""
    if portfolio:
        rows = []
        for p in portfolio[:20]:
            if p.get("error"): continue
            sym = p.get("ticker"); typ = p.get("type","")
            pnl = p.get("pnl"); dpnl = p.get("day_change")
            rows.append(f"{sym} {typ} x{p.get('qty')}: val ${p.get('current_val')}, P&L ${pnl}"
                        + (f", today ${dpnl}" if dpnl is not None else ""))
        if rows:
            port_ctx = "USER PORTFOLIO (live):\n" + "\n".join(rows)

    data_ctx = ""
    if ctx_blocks:
        data_ctx += "LIVE DATA CONTEXT (use these exact numbers):\n" + "\n".join(ctx_blocks) + "\n"
    if port_ctx:
        data_ctx += "\n" + port_ctx + "\n"
    if watchlist:
        data_ctx += f"\nWatchlist: {', '.join(watchlist[:40])}\n"
    if not data_ctx:
        data_ctx = "(No specific ticker data resolved for this question — answer from general market knowledge and ask for a ticker if needed.)"

    prof_block = _profile_ctx(profile)
    system = (
        "You are AlphaDesk's research assistant — a sharp, concise markets analyst helping a retail "
        "investor reason about their watchlist, holdings, and specific stocks using the LIVE DATA provided.\n\n"
        + (prof_block + "\n\n" if prof_block else "")
        + ANALYST_WEIGHT_BLOCK + "\n\n"
        "RULES:\n"
        "- Ground every claim in the LIVE DATA CONTEXT. Cite the actual numbers (price, RSI, P/E, targets, P&L).\n"
        "- If the data needed isn't in context, say so plainly and ask for the ticker rather than inventing figures.\n"
        "- For buy/sell/timing questions, give a BALANCED read: the bull case, the bear case, the key levels "
        "(entry / stop / target if inferable), and what would change the thesis — not a bare 'yes/no'.\n"
        "- Tailor the lens to the user's trader profile above.\n"
        "- Be tight and conversational: 2-4 short paragraphs or a few bullets, no filler.\n"
        "- FORMAT for a narrow chat window: short paragraphs and simple '- ' bullet lists only. "
        "Use **bold** sparingly for key numbers/tickers. Do NOT use markdown headers (#) or tables.\n"
        "- For any specific buy/sell/timing question, END with exactly one line: "
        "\"This is analysis to inform your own decision — not personalized financial advice.\"\n"
    )
    msgs = []
    for h in (history or [])[-8:]:
        role = h.get("role"); content = (h.get("content") or "").strip()
        if role in ("user","assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": f"{data_ctx}\n\nQUESTION: {message}"})
    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=900, system=system, messages=msgs)
    return {"reply": r.content[0].text, "tickers": tickers}


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


# NOTE: the old server-side positions.json / settings.json store and its
# /positions & /settings endpoints were REMOVED for security — they were an
# unauthenticated, single-shared-file read/write surface (any caller could read
# or overwrite whatever was there, and two anonymous users would collide).
# Real persistence is per-user Supabase (RLS-protected) for signed-in users and
# browser localStorage for the local/anonymous path.

def _valid_ticker(t):
    """Defensive symbol allowlist — letters/digits and the few punctuation marks
    real symbols use (BRK-B, GC=F, ^VIX, BTC-USD, 9988.HK). Rejects junk before
    it ever reaches an outbound request."""
    import re
    return bool(t) and bool(re.fullmatch(r"[A-Za-z0-9.\-=^:]{1,15}", t))


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
    from fastapi import FastAPI, Body, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware

    _ZERO_ANALYTICS = {"total_value":0, "total_cost":0, "total_pnl":0, "total_pnl_pct":0,
                       "daily_theta":0, "net_delta":0, "sector_alloc":{}}

    from fastapi.middleware.gzip import GZipMiddleware

    app = FastAPI(title="AlphaDesk")
    app.add_middleware(GZipMiddleware, minimum_size=500)
    # Lock the API to the frontend origin(s). Set CORS_ORIGINS in the Render
    # dashboard to your Vercel URL(s), comma-separated, e.g.
    #   CORS_ORIGINS=https://alphadesk.vercel.app,https://www.yourdomain.com
    # Defaults to "*" only if unset (all endpoints serve public market data or
    # process the caller's own posted data — no stored per-user data is exposed).
    _cors = os.getenv("CORS_ORIGINS", "").strip()
    _origins = [o.strip() for o in _cors.split(",") if o.strip()] or ["*"]
    app.add_middleware(CORSMiddleware, allow_origins=_origins,
                       allow_methods=["*"], allow_headers=["*"])

    # ── Auth gate for the paid AI endpoints ──────────────────────────────────
    # Only signed-in users may trigger Claude calls, so nobody can bypass the
    # login screen and burn the API budget. Enforced automatically on Render
    # (RENDER is set there) or when REQUIRE_AUTH=1; OPEN on localhost dev (no
    # session token there). Verifies the caller's Supabase access token by asking
    # Supabase who it belongs to — no extra secret needed (reuses SUPABASE_ANON_KEY).
    _AUTH_REQUIRED = (os.getenv("REQUIRE_AUTH", "").lower() in ("1", "true", "yes")
                      or bool(os.getenv("RENDER")))

    def require_user(authorization: str = Header(None)):
        if not _AUTH_REQUIRED:
            return None
        sb_url = os.getenv("SUPABASE_URL", "").rstrip("/")
        sb_key = (os.getenv("SUPABASE_ANON_KEY") or "").strip()
        if not sb_url or not sb_key:
            # Auth required but backend can't verify → fail closed.
            raise HTTPException(status_code=503, detail="auth not configured")
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Sign in to use AI features")
        token = authorization.split(" ", 1)[1].strip()
        import urllib.request as _ur
        req = _ur.Request(f"{sb_url}/auth/v1/user",
                          headers={"apikey": sb_key, "Authorization": f"Bearer {token}"})
        try:
            with _ur.urlopen(req, timeout=8) as r:
                u = json.loads(r.read())
            uid = u.get("id")
            if not uid:
                raise ValueError("no user")
            return uid
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid or expired session — sign in again")

    @app.get("/health")
    def health():
        return {"ok": True, "time": datetime.datetime.now().isoformat()}

    @app.get("/research")
    def research_endpoint(ticker: str, ai: int = 0, profile: str = "", authorization: str = Header(None)):
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"ticker": t, "error": "invalid ticker"}
        if ai: require_user(authorization)   # AI conviction/stage needs a login
        return _cached(f"research:{t}:{ai}:{profile}", lambda: research(t, ai=bool(ai), profile=profile))

    @app.get("/fundamentals")
    def fundamentals_endpoint(ticker: str):
        """Full fundamentals + valuation bundle for the Financials page (free)."""
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"ticker": t, "error": "invalid ticker"}
        return _cached_swr(f"fundamentals:{t}", lambda: fundamentals(t), ttl=3600, stale_ttl=21600)

    @app.get("/financials-detail")
    def financials_detail_endpoint(ticker: str):
        """Quarterly + annual statement series (revenue, net income, FCF, EPS,
        gross margin) plus forward analyst estimates — powers the Financials
        bar charts with estimate bars extending into future periods."""
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"ticker": t, "error": "invalid ticker"}
        def produce():
            try:
                tk = yf.Ticker(t)
                def rows(df, *names):
                    if df is None or getattr(df, "empty", True):
                        return None
                    for n in names:
                        if n in df.index:
                            return df.loc[n]
                    return None
                def series(df, *names, per="Q"):
                    r = rows(df, *names)
                    if r is None:
                        return []
                    out = []
                    for col in list(df.columns)[::-1]:                     # oldest → newest
                        v = _num(r[col])
                        lbl = (f"Q{col.quarter} '{str(col.year)[2:]}" if per == "Q" else str(col.year))
                        out.append({"label": lbl, "value": v})
                    return [o for o in out if o["value"] is not None]
                qi, qc = None, None
                ai_, ac = None, None
                try: qi = tk.quarterly_income_stmt
                except Exception: pass
                try: qc = tk.quarterly_cashflow
                except Exception: pass
                try: ai_ = tk.income_stmt
                except Exception: pass
                try: ac = tk.cashflow
                except Exception: pass
                def margin_series(df, per="Q"):
                    rev, gp = rows(df, "Total Revenue"), rows(df, "Gross Profit")
                    if rev is None or gp is None:
                        return []
                    out = []
                    for col in list(df.columns)[::-1]:
                        r, g = _num(rev[col]), _num(gp[col])
                        if r and g is not None:
                            lbl = (f"Q{col.quarter} '{str(col.year)[2:]}" if per == "Q" else str(col.year))
                            out.append({"label": lbl, "value": g / r})
                    return out
                def est_block(df):
                    out = {}
                    try:
                        for period, row in df.iterrows():
                            out[str(period)] = {"avg": _num(row.get("avg")), "low": _num(row.get("low")),
                                                "high": _num(row.get("high"))}
                    except Exception:
                        pass
                    return out
                est_rev, est_eps = {}, {}
                try: est_rev = est_block(tk.revenue_estimate)
                except Exception: pass
                try: est_eps = est_block(tk.earnings_estimate)
                except Exception: pass
                info = {}
                try: info = tk.info or {}
                except Exception: pass
                next_earn = None
                try:
                    cal = tk.calendar or {}
                    ed = cal.get("Earnings Date") or []
                    if ed: next_earn = str(ed[0])
                except Exception:
                    pass
                return _json_safe({
                    "ticker": t,
                    "quarterly": {
                        "revenue":    series(qi, "Total Revenue", "Operating Revenue"),
                        "netIncome":  series(qi, "Net Income", "Net Income Common Stockholders"),
                        "eps":        series(qi, "Diluted EPS", "Basic EPS"),
                        "fcf":        series(qc, "Free Cash Flow"),
                        "grossMargin": margin_series(qi),
                    },
                    "annual": {
                        "revenue":    series(ai_, "Total Revenue", "Operating Revenue", per="Y"),
                        "netIncome":  series(ai_, "Net Income", "Net Income Common Stockholders", per="Y"),
                        "eps":        series(ai_, "Diluted EPS", "Basic EPS", per="Y"),
                        "fcf":        series(ac, "Free Cash Flow", per="Y"),
                        "grossMargin": margin_series(ai_, per="Y"),
                    },
                    "estimates": {"revenue": est_rev, "eps": est_eps},
                    "shares": _num(info.get("sharesOutstanding")),
                    "next_earnings": next_earn,
                })
            except Exception as e:
                return {"error": str(e)}
        return _cached_swr(f"findet:{t}", produce, ttl=10800, stale_ttl=86400)

    _CIK_MAP = {}
    @app.get("/filings")
    def filings_endpoint(ticker: str):
        """Recent SEC filings (10-K, 10-Q, 8-K, proxies) straight from EDGAR — free."""
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"ticker": t, "filings": [], "error": "invalid ticker"}
        def produce():
            import urllib.request as _ur, json as _json
            ua = {"User-Agent": "AlphaDesk personal research contact@alphadesk.local"}
            try:
                if not _CIK_MAP:
                    req = _ur.Request("https://www.sec.gov/files/company_tickers.json", headers=ua)
                    data = _json.loads(_ur.urlopen(req, timeout=20).read())
                    for v in data.values():
                        _CIK_MAP[str(v.get("ticker", "")).upper()] = int(v.get("cik_str", 0))
                cik = _CIK_MAP.get(t)
                if not cik:
                    return {"ticker": t, "filings": [], "error": f"{t} not found on EDGAR (non-US listings and some ETFs aren't there)"}
                req = _ur.Request(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", headers=ua)
                sub = _json.loads(_ur.urlopen(req, timeout=20).read())
                rec = (sub.get("filings") or {}).get("recent") or {}
                keep = {"10-K", "10-Q", "8-K", "DEF 14A", "S-1", "20-F", "6-K", "4"}
                out = []
                for form, date, acc, doc, desc in zip(rec.get("form", []), rec.get("filingDate", []),
                                                      rec.get("accessionNumber", []), rec.get("primaryDocument", []),
                                                      rec.get("primaryDocDescription", [])):
                    if form not in keep or form == "4":   # skip insider Form 4s (too noisy)
                        continue
                    out.append({"form": form, "date": date, "desc": desc or form,
                                "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}"})
                    if len(out) >= 14:
                        break
                return _json_safe({"ticker": t, "company": sub.get("name"), "filings": out})
            except Exception as e:
                return {"ticker": t, "filings": [], "error": str(e)}
        return _cached_swr(f"filings:{t}", produce, ttl=21600, stale_ttl=172800)

    @app.get("/business-quality")
    def business_quality_endpoint(ticker: str, profile: str = "", authorization: str = Header(None)):
        """AI business-quality read for a long-term holding. Costs a Claude call."""
        require_user(authorization)
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"ticker": t, "ai_error": "invalid ticker"}
        def produce():
            try:
                fund = _cached_swr(f"fundamentals:{t}", lambda: fundamentals(t), ttl=3600, stale_ttl=21600)
                return _json_safe({"ticker": t, **(business_quality(t, fund, profile) or {})})
            except Exception as e:
                return {"ticker": t, "ai_error": str(e)}
        return _cached(f"bizq:{t}:{profile}", produce)

    @app.get("/screen")
    def screen_endpoint(
        mode: str = "market", tickers: str = "", offset: int = 0, limit: int = 40,
        fpe_max: float = None, peg_max: float = None, ps_max: float = None, ev_max: float = None,
        rev_growth_min: float = None, eps_growth_min: float = None, gross_min: float = None,
        roe_min: float = None, fcf_positive: int = 0, de_max: float = None, cr_min: float = None,
        mcap_min: float = None, mcap_max: float = None, sectors: str = "", cheap_vs_sector: int = 0,
    ):
        """Screen a batch of the universe (market) or the user's watchlist against the filters.
        Market mode is paged via offset/limit so the frontend can show progress and avoid timeouts."""
        f = {"fpe_max":fpe_max, "peg_max":peg_max, "ps_max":ps_max, "ev_max":ev_max,
             "rev_growth_min":rev_growth_min, "eps_growth_min":eps_growth_min, "gross_min":gross_min,
             "roe_min":roe_min, "fcf_positive":bool(fcf_positive), "de_max":de_max, "cr_min":cr_min,
             "mcap_min":mcap_min, "mcap_max":mcap_max, "cheap_vs_sector":bool(cheap_vs_sector),
             "sectors":[s for s in sectors.split(",") if s.strip()] if sectors else None}
        if mode == "watchlist":
            universe = [t.strip().upper() for t in tickers.split(",") if t.strip()]
            batch, done = universe, True
        else:
            universe = _SP500
            batch = universe[offset:offset+limit]
            done = (offset + limit) >= len(universe)
        matches = []
        for t in batch:
            try:
                m = screen_metrics(t)
                if _passes(m, f):
                    matches.append(m)
            except Exception:
                pass
        return _json_safe({
            "matches": matches, "scanned": len(batch),
            "offset": offset, "next_offset": (None if done else offset + limit),
            "total_universe": len(universe), "done": done,
        })

    @app.post("/chat")
    def chat_endpoint(body: dict = Body(...), authorization: str = Header(None)):
        """Grounded research-assistant chat. Costs a Claude call — frontend gates on AI Insights."""
        require_user(authorization)
        if not os.getenv("ANTHROPIC_API_KEY"):
            return {"reply": "AI is off — enable AI Insights (and set the API key) to chat.", "ai_error": "no_key"}
        msg = (body.get("message") or "").strip()
        if not msg:
            return {"reply": "Ask me anything about your watchlist, holdings, or a specific ticker."}
        try:
            return chat_reply(
                msg,
                history=body.get("history") or [],
                profile=body.get("profile") or "",
                portfolio=body.get("portfolio") or [],
                watchlist=body.get("watchlist") or [],
            )
        except Exception as e:
            return {"reply": f"Sorry — I hit an error answering that ({str(e)[:80]}). Try again.", "ai_error": str(e)}

    @app.post("/brief/refresh")
    def brief_refresh_endpoint(body: dict = Body(...), authorization: str = Header(None)):
        """On-demand Market Brief: values the posted positions, runs the agent
        (tool-use loop, ~1-4 min), returns {brief, tool_log, ...}. The frontend
        persists the result (Supabase when signed in, localStorage otherwise) —
        this service never holds the Supabase service key."""
        require_user(authorization)
        if not os.getenv("ANTHROPIC_API_KEY"):
            return {"error": "ANTHROPIC_API_KEY not set on the backend."}
        try:
            from market_brief_agent import run_market_brief
            positions = body.get("positions") or []
            valued, analytics = [], {}
            if positions:
                from run_daily import layer1_data_valuation, layer2_portfolio_analytics
                valued = layer1_data_valuation(positions)
                ok = [p for p in valued if not p.get("error") and not p.get("expired")]
                if ok:
                    analytics = layer2_portfolio_analytics(ok)
            out = run_market_brief(
                positions=valued, analytics=analytics,
                conviction=body.get("conviction") or body.get("watchlist") or [],
                radar=body.get("radar") or [],
                profile=body.get("profile") or "")
            if not out.get("brief"):
                return {"error": "agent finished without submitting a brief", "tool_log": out.get("tool_log")}
            return _json_safe(out)
        except Exception as e:
            return {"error": str(e)}

    @app.get("/chart")
    def chart_endpoint(ticker: str, range: str = "3m"):
        """Price history for any timeframe with correct yfinance params per range."""
        t = ticker.upper().strip()
        if not _valid_ticker(t): return {"error": "invalid ticker"}
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
        """Market Pulse: serve pre-processed insights from the Supabase
        `market_pulse` table. YouTube blocks transcript fetching from datacenter
        IPs (Render), so the heavy lifting runs locally via fetch_transcripts.py
        on a residential IP; this endpoint just reads the cached results in
        trust-weight order."""
        import json as _json, urllib.request, datetime as _dt

        SB_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
        SB_KEY = (os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY") or "").strip()
        STALE_MSG = "Run fetch_transcripts.py to populate Market Pulse."

        def produce():
            if not SB_URL or not SB_KEY:
                return {"analysts": [], "message": STALE_MSG,
                        "error": "Supabase not configured on the backend (set SUPABASE_URL + SUPABASE_ANON_KEY)."}

            url = f"{SB_URL}/rest/v1/market_pulse?select=*&order=weight.asc"
            req = urllib.request.Request(url, headers={
                "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    rows = _json.loads(r.read())
            except Exception as e:
                return {"analysts": [], "message": STALE_MSG, "error": f"market_pulse read failed: {e}"}

            if not rows:                                   # table empty
                return {"analysts": [], "message": STALE_MSG, "stale": True}

            # Staleness: is the newest fetched_at older than 24h?
            def _parse(ts):
                try:
                    return _dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                except Exception:
                    return None
            stamps = [s for s in (_parse(r.get("fetched_at")) for r in rows) if s]
            newest = max(stamps) if stamps else None
            now    = _dt.datetime.now(_dt.timezone.utc)
            stale  = (newest is None) or ((now - newest).total_seconds() > 24 * 3600)

            by_id = {}
            for row in rows:
                by_id.setdefault(row.get("analyst_id"), []).append(row)

            def _to_insight(row):
                pts = [p.strip() for p in (row.get("insight_summary") or "").split("\n") if p.strip()]
                return {
                    "title":     row.get("video_title") or "",
                    "link":      row.get("video_link") or "",
                    "published": row.get("published_date") or "",
                    "source":    "transcript",
                    "points":    pts,
                    "summary":   pts[0] if pts else (row.get("insight_summary") or ""),
                    "takeaway":  row.get("key_takeaway") or "",
                    "sentiment": row.get("sentiment") or "neutral",
                }

            analysts_out = [{
                "id": a["id"], "name": a["name"], "label": a["label"], "weight": a["weight"],
                "insights": [_to_insight(r) for r in by_id.get(a["id"], [])],
            } for a in ANALYSTS]

            out = {"analysts": analysts_out,
                   "fetched_at": newest.isoformat() if newest else None,
                   "stale": stale}
            if stale:
                out["message"] = STALE_MSG
            return _json_safe(out)

        # Light cache so repeated UI hits don't re-query Supabase on every request.
        return _cached_swr("yt-insights", produce, ttl=300, stale_ttl=86400)

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
                # (yfinance >=0.2.52 removed the show_errors kwarg)
                raw = yf.download(tickers, period="60d", auto_adjust=True, progress=False)
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
    def outlook_endpoint(profile: str = "", authorization: str = Header(None)):
        require_user(authorization)
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
    def why_now_endpoint(ticker: str, profile: str = "", authorization: str = Header(None)):
        """Fresh AI take on today's specific price action — no caching."""
        require_user(authorization)
        ticker = ticker.upper().strip()
        if not _valid_ticker(ticker): return {"error": "invalid ticker"}
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
    def portfolio_analysis_endpoint(payload: dict = Body(default={}), authorization: str = Header(None)):
        """AI analysis of the full portfolio as a book. Not cached — always fresh."""
        require_user(authorization)
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
    def sector_endpoint(name: str, authorization: str = Header(None)):
        # Drill-down: AI explanation of what's driving a sector + 30-90 day forecast.
        require_user(authorization)
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
        profile = str(payload.get("profile") or "")   # tunes alert thresholds/wording
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
            alerts    = list(layer4_alerts(active, analytics, macro, {}, profile=profile))
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
