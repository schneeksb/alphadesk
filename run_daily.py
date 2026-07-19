"""
AlphaDesk — 4-Layer Daily Portfolio Monitor (9:45 AM ET)
=========================================================
Run after market open: python run_daily.py

Requirements:
    pip install yfinance pandas numpy scipy requests anthropic python-dotenv
"""

import os, json, datetime, numpy as np, yfinance as yf
import pandas as pd
from scipy.stats import norm
from dotenv import load_dotenv
import anthropic, urllib.request

load_dotenv()

PORTFOLIO = [
    {"ticker": "NVDA", "type": "CALL",   "strike": 900,  "expiry": "2026-01-16", "qty": 2,   "cost_basis": 4200},
    {"ticker": "MSFT", "type": "CALL",   "strike": 380,  "expiry": "2026-03-20", "qty": 3,   "cost_basis": 3100},
    {"ticker": "META", "type": "CALL",   "strike": 520,  "expiry": "2025-12-19", "qty": 2,   "cost_basis": 2800},
    {"ticker": "PLTR", "type": "SHARES",                                          "qty": 150, "cost_basis": 3200},
    {"ticker": "SOFI", "type": "SHARES",                                          "qty": 400, "cost_basis": 2100},
    {"ticker": "AMD",  "type": "CALL",   "strike": 160,  "expiry": "2026-01-16", "qty": 4,   "cost_basis": 3600},
]

ALERT_SETTINGS = {
    "stop_loss_pct":   -0.25,
    "take_profit_pct":  0.50,
    "dte_warning":      45,
    "theta_daily_max":  75,
    "vix_high":         25,
    "iv_high":          0.60,
}

SLACK_WEBHOOK = os.getenv("SLACK_WEBHOOK_URL", "")


def black_scholes_greeks(S, K, T, r, sigma, option_type="call"):
    """Returns raw (unrounded) price so callers can compute cv precisely before rounding."""
    if T <= 0 or not (np.isfinite(sigma) and sigma > 0):
        return {"price": 0.0, "delta": 0.0, "theta": 0.0, "vega": 0.0, "gamma": 0.0}
    d1 = (np.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*np.sqrt(T))
    d2 = d1 - sigma*np.sqrt(T)
    if option_type == "call":
        price = S*norm.cdf(d1) - K*np.exp(-r*T)*norm.cdf(d2)
        delta = norm.cdf(d1)
    else:
        price = K*np.exp(-r*T)*norm.cdf(-d2) - S*norm.cdf(-d1)
        delta = norm.cdf(d1) - 1
    gamma = norm.pdf(d1) / (S*sigma*np.sqrt(T))
    theta = (-(S*norm.pdf(d1)*sigma)/(2*np.sqrt(T)) - r*K*np.exp(-r*T)*norm.cdf(d2 if option_type=="call" else -d2)) / 365
    vega  = S*norm.pdf(d1)*np.sqrt(T) / 100
    # price is NOT rounded here — caller multiplies by qty*100 before rounding
    return {"price": float(price), "delta": round(delta,3), "theta": round(theta,2), "vega": round(vega,2), "gamma": round(gamma,4)}


def get_option_mark_price(ticker_obj, strike, expiry_str, option_type="call"):
    """
    Fetch the live mark price and IV directly from the options chain.
    Mark price = (bid+ask)/2 when both > 0, else lastPrice.
    IV is sanitised — 0, NaN, and inf all fall back to 0.35.
    Returns (mark_price_per_share_or_None, iv).
    """
    try:
        chain = ticker_obj.option_chain(expiry_str)
        opts  = chain.calls if option_type == "call" else chain.puts
        row   = opts[opts["strike"] == strike]
        if row.empty:
            return None, 0.35
        r = row.iloc[0]

        def _fval(v):
            """Safe float that treats NaN/inf/None as 0 — NaN is truthy so `x or 0` doesn't work."""
            try:
                f = float(v)
                return f if np.isfinite(f) else 0.0
            except (TypeError, ValueError):
                return 0.0

        bid  = _fval(r.get("bid"))
        ask  = _fval(r.get("ask"))
        last = _fval(r.get("lastPrice"))
        mark = (bid + ask) / 2 if (bid > 0 and ask > 0) else (last if last > 0 else None)

        iv_raw = _fval(r.get("impliedVolatility"))
        iv = iv_raw if iv_raw > 0 else 0.35  # fallback when chain IV is missing/zero/NaN

        return mark, iv
    except Exception:
        return None, 0.35


# ── Price-fetch cache ─────────────────────────────────────────────────────────
# Yahoo aggressively rate-limits datacenter IPs (Render), and the frontend re-values
# the whole portfolio on every position edit / refresh. Without caching, each call
# re-fetches every ticker's 5-day close and quickly trips 429 "Too Many Requests",
# dropping positions into the errored list. Cache the close series per ticker for a
# short TTL so repeated valuations reuse prices, and serve the last good series if a
# fetch is rate-limited rather than failing the position.
import time as _time_rd
_PRICE_CACHE = {}          # ticker -> (timestamp, [close floats, oldest→newest])
_PRICE_TTL   = 90          # seconds — a portfolio view doesn't need sub-minute prices

def _is_rate_limited(err) -> bool:
    s = str(err).lower()
    return "too many requests" in s or "429" in s or "rate limit" in s

def _closes_5d(ticker):
    """5-day close series (oldest→newest) with a short TTL cache and stale-on-error."""
    now = _time_rd.time()
    hit = _PRICE_CACHE.get(ticker)
    if hit and now - hit[0] < _PRICE_TTL:
        return hit[1]
    try:
        c = yf.Ticker(ticker).history(period="5d")["Close"].dropna()
        vals = [float(x) for x in c.tolist()]
        if vals:
            _PRICE_CACHE[ticker] = (now, vals)
        return vals
    except Exception:
        if hit:                       # rate-limited/transient: reuse the last good prices
            return hit[1]
        raise


def layer1_data_valuation(portfolio=None):
    """Value a list of positions concurrently (yfinance calls run in parallel threads).

    Options P&L logic:
      - cost_basis is stored as TOTAL dollars paid (premium × contracts × 100)
      - current_val = live mark price (from chain) × contracts × 100
        fallback: Black-Scholes price (raw, unrounded) × contracts × 100
      - pnl = current_val - cost_basis
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    if portfolio is None:
        portfolio = PORTFOLIO
    print(f"\n[L1] Valuing {len(portfolio)} position(s) in parallel...")
    r_rate = 0.053; today = datetime.date.today()

    def _err(pos, msg):
        return {**pos, "spot": None, "current_val": 0, "pnl": 0, "pnl_pct": 0,
                "delta": 0, "theta": 0, "vega": 0, "iv": None, "dte": None,
                "prev_close": None, "day_change": 0, "day_change_pct": 0,
                "expired": False, "error": msg}

    def _value_one(pos):
        try:
            vals = _closes_5d(pos["ticker"])
            if not vals:
                return _err(pos, "No market data")
            spot = float(vals[-1])
            prev = float(vals[-2]) if len(vals) > 1 else spot   # prior close → today's $ move
            cb   = float(pos.get("cost_basis") or 0)

            if pos["type"] in ("SHARES", "CRYPTO"):
                # Crypto (e.g. BTC-USD) values exactly like shares: spot × units.
                cv  = spot * pos["qty"]
                pnl = cv - cb
                day_chg  = (spot - prev) * pos["qty"]          # today's $ change for the position
                prior_val = cv - day_chg
                tag = "CRY" if pos["type"] == "CRYPTO" else "SHR"
                print(f"  [{tag}] {pos['ticker']} spot=${spot:.2f} cv=${cv:.2f} pnl=${pnl:+.2f}")
                return {**pos, "spot": round(spot,2), "current_val": round(cv,2),
                        "pnl": round(pnl,2), "pnl_pct": round(pnl/cb,4) if cb else 0,
                        "prev_close": round(prev,2), "day_change": round(day_chg,2),
                        "day_change_pct": round(day_chg/prior_val,4) if prior_val else 0,
                        "delta": 1.0, "theta": 0, "vega": 0, "iv": None, "dte": None,
                        "expired": False}
            else:
                tk      = yf.Ticker(pos["ticker"])   # options need the chain (constructing is free)
                expiry  = datetime.date.fromisoformat(pos["expiry"])
                raw_dte = (expiry - today).days
                dte     = max(raw_dte, 0)
                T       = dte / 365.0
                qty     = pos["qty"]
                mark_price, iv = get_option_mark_price(tk, pos["strike"], pos["expiry"], pos["type"].lower())
                greeks = black_scholes_greeks(spot, pos["strike"], T, r_rate, iv, pos["type"].lower())
                if mark_price is not None and mark_price > 0:
                    cv = mark_price * qty * 100
                    src = f"chain ${mark_price:.3f}"
                else:
                    cv = greeks["price"] * qty * 100
                    src = f"BS ${greeks['price']:.4f}"
                pnl = cv - cb
                # Option daily $ change ≈ delta × underlying's $ move × contracts × 100
                day_chg  = (greeks.get("delta") or 0) * (spot - prev) * qty * 100
                prior_val = cv - day_chg
                pnl_pct_str = f"{pnl/cb*100:+.1f}%" if cb else "N/A"
                print(f"  [OPT] {pos['ticker']} ${pos.get('strike')} {pos['type']} "
                      f"DTE={dte} IV={iv:.0%} {src} cv=${cv:.2f} pnl={pnl_pct_str}")
                return {**pos, "spot": round(spot,2), "current_val": round(cv,2),
                        "pnl": round(pnl,2), "pnl_pct": round(pnl/cb,4) if cb else 0,
                        "prev_close": round(prev,2), "day_change": round(day_chg,2),
                        "day_change_pct": round(day_chg/prior_val,4) if prior_val else 0,
                        "dte": dte, "iv": round(iv,3), "expired": raw_dte < 0, **greeks}
        except Exception as e:
            msg = "Yahoo rate-limited — prices refresh shortly" if _is_rate_limited(e) else str(e)
            return _err(pos, msg)

    # Run concurrently but with a modest cap: caching means most calls hit memory,
    # and a smaller burst on a cold cache is far less likely to trip Yahoo's 429.
    results = [None] * len(portfolio)
    with ThreadPoolExecutor(max_workers=min(len(portfolio), 4)) as ex:
        futs = {ex.submit(_value_one, pos): i for i, pos in enumerate(portfolio)}
        for fut in as_completed(futs):
            results[futs[fut]] = fut.result()
    return results


# Precious-metals tickers — ETFs + futures. Bucketed as one sector in analytics.
_METAL_TICKERS = {
    "GLD","IAU","SGOL","GLDM","BAR","OUNZ","AAAU","SLV","SIVR","PSLV","PPLT","PALL",
    "GLTR","DBP","GDX","GDXJ","SIL","SILJ","RING","NUGT",
    "GC=F","MGC=F","SI=F","SIL=F","PL=F","PA=F","HG=F",
}


def layer2_portfolio_analytics(positions):
    print("\n[L2] Portfolio analytics...")
    # Fast-path cache: well-known tickers skip an API call.
    # Any ticker not in this map gets a live yfinance sector lookup (if portfolio is small).
    sector_map = {"NVDA":"Technology","MSFT":"Technology","META":"Communication",
                  "PLTR":"Technology","SOFI":"Financials","AMD":"Technology"}
    total_val   = sum(p["current_val"] for p in positions)
    total_cost  = sum(p["cost_basis"]  for p in positions)
    total_pnl   = total_val - total_cost
    # Shares and crypto carry a 1x multiplier; options are ×100 per contract.
    _mult = lambda p: 1 if p["type"] in ("SHARES", "CRYPTO") else 100
    total_theta = sum((p.get("theta") or 0)*p["qty"]*_mult(p) for p in positions)
    total_delta = sum((p.get("delta") or 0)*p["qty"]*_mult(p) for p in positions)
    total_day_chg = sum((p.get("day_change") or 0) for p in positions)   # today's $ change across book
    prior_total   = total_val - total_day_chg
    sector_alloc = {}
    # Only do live lookups for small portfolios to avoid excessive API calls.
    do_live_lookup = len(positions) < 20
    for p in positions:
        ticker = p["ticker"]
        if p.get("type") == "CRYPTO" or ticker.endswith("-USD"):
            s = "Crypto"                       # crypto has no equity sector — bucket it together
        elif ticker.upper() in _METAL_TICKERS:
            s = "Precious Metals"              # gold/silver/platinum/palladium ETFs & futures
        else:
            if ticker not in sector_map and do_live_lookup:
                try:
                    fetched = yf.Ticker(ticker).info.get("sector", "Other") or "Other"
                    sector_map[ticker] = fetched  # cache so duplicate tickers don't re-fetch
                except Exception:
                    sector_map[ticker] = "Other"
            s = sector_map.get(ticker, "Other")
        sector_alloc[s] = sector_alloc.get(s, 0) + p["current_val"]
    return {"total_value": round(total_val,2), "total_cost": round(total_cost,2),
            "total_pnl": round(total_pnl,2),
            "total_pnl_pct": round(total_pnl/total_cost,4) if total_cost else 0,
            "daily_theta": round(total_theta,2), "net_delta": round(total_delta,2),
            "daily_change": round(total_day_chg,2),
            "daily_change_pct": round(total_day_chg/prior_total,4) if prior_total else 0,
            "sector_alloc": {k: round(v,2) for k,v in sector_alloc.items()}}


def get_macro_score():
    try:
        vix   = yf.Ticker("^VIX").history(period="5d")["Close"].dropna()
        spy   = yf.Ticker("SPY").history(period="5d")["Close"].dropna()
        vix_v = float(vix.iloc[-1])
        spy_c = float(spy.iloc[-1]/spy.iloc[-2] - 1)
        breadth = max(0, min(1, 0.5 + spy_c*10))
        score   = 1 if vix_v < 20 and breadth > 0.5 else (-1 if vix_v > 30 else 0)
        return {"vix": round(vix_v,2), "breadth": round(breadth,2),
                "score": score, "label": {1:"bullish",0:"neutral",-1:"bearish"}[score],
                "spy_change": round(spy_c,4), "spy_close": round(float(spy.iloc[-1]),2)}
    except Exception:
        return {"vix":18.0,"breadth":0.55,"score":0,"label":"neutral","spy_change":0.0,"spy_close":None}


def get_ai_sentiment(tickers):
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    results = {}
    for ticker in tickers:
        try:
            r = client.messages.create(model="claude-sonnet-4-6", max_tokens=200,
                messages=[{"role":"user","content":
                    f"Analyst for {ticker} as of {datetime.date.today()}. "
                    f'Respond JSON only: {{"score":<0-1>,"summary":"<1-2 sentences>"}}'}])
            results[ticker] = json.loads(r.content[0].text.strip())
        except Exception:
            results[ticker] = {"score":0.5,"summary":"Unavailable."}
    return results


def _parse_profile(profile: str):
    """'risk|goal1,goal2|style1,style2|level' → parts. Goals/styles are comma
    lists (the profiler is multi-select); every field optional with sane defaults."""
    parts = (profile or "").split("|")
    seg = lambda i: (parts[i] if len(parts) > i else "").strip()
    return {
        "risk":   seg(0) or "moderate",
        "goals":  {g.strip() for g in seg(1).split(",") if g.strip()} or {"growth"},
        "styles": {s.strip() for s in seg(2).split(",") if s.strip()} or {"swing"},
        "level":  seg(3) or "intermediate",
    }


def layer4_alerts(positions, analytics, macro, sentiment, profile=""):
    """Rule alerts tuned to the trader profile: thresholds scale with risk
    tolerance, rules filter by style, and wording matches the horizon. A
    long-term investor shouldn't be told to 'take profits' at +50% — a swing
    trader should. Defaults (no profile) reproduce the original behavior."""
    alerts = []; s = ALERT_SETTINGS
    prof = _parse_profile(profile)
    styles = prof["styles"]
    is_long   = "longterm" in styles
    is_trader = bool(styles & {"swing", "daytrader", "options"})
    long_only = is_long and not is_trader

    # Pain threshold scales with risk appetite; pure long-term widens further
    # (drawdowns are noise until they're thesis-breaking).
    stop_pct = {"conservative": -0.15, "moderate": -0.25,
                "aggressive": -0.35, "degen": -0.45}.get(prof["risk"], s["stop_loss_pct"])
    if long_only:
        stop_pct = max(stop_pct * 1.4, -0.50)
    down_msg = ("drawdown check — is the thesis intact?" if long_only else
                "stop-loss / thesis check" if is_long else "stop-loss")

    # Profit alerts: traders get exit prompts, long-term gets a thesis check much later.
    if long_only:
        tp_pct, tp_msg = 1.00, "thesis check — trim, or let it compound?"
    elif is_long:
        tp_pct, tp_msg = 0.60, "trim or let it compound?"
    else:
        tp_pct, tp_msg = s["take_profit_pct"], "take profits"

    for p in positions:
        t = p["ticker"]; pct = p["pnl_pct"]
        if pct <= stop_pct:
            alerts.append({"ticker":t,"type":"STOP_LOSS","severity":"red","message":f"{t} down {pct*100:.1f}% — {down_msg}"})
        if pct >= tp_pct:
            alerts.append({"ticker":t,"type":"TAKE_PROFIT","severity":"green","message":f"{t} up {pct*100:.1f}% — {tp_msg}"})
        # Expiry/IV are objective properties of options actually held — always relevant.
        dte = p.get("dte")
        if dte and 0 < dte < s["dte_warning"]:
            alerts.append({"ticker":t,"type":"DTE_WARNING","severity":"yellow","message":f"{t} {dte} DTE — consider roll"})
        iv = p.get("iv")
        if iv and iv > s["iv_high"]:
            alerts.append({"ticker":t,"type":"HIGH_IV","severity":"yellow","message":f"{t} IV {iv*100:.0f}% — elevated"})

    # Theta nagging is for options-focused traders; others only hear about real bleed.
    theta_max = s["theta_daily_max"] if "options" in styles else s["theta_daily_max"] * 2
    if abs(analytics["daily_theta"]) > theta_max:
        alerts.append({"ticker":"PORTFOLIO","type":"THETA_BLEED","severity":"yellow",
                       "message":f"Daily theta ${analytics['daily_theta']:.2f}"})

    # VIX framing depends on horizon: threat to a trader, sale to a long-term buyer.
    if macro["vix"] > s["vix_high"]:
        vix_msg = (f"VIX {macro['vix']} — volatility discount: quality names going on sale" if long_only else
                   f"VIX {macro['vix']} — tighten risk on swings; discount window for long-term adds" if is_long else
                   f"VIX {macro['vix']} — hedge")
        alerts.append({"ticker":"MACRO","type":"HIGH_VIX",
                       "severity": "yellow" if long_only else "red", "message": vix_msg})
    return alerts


def send_slack_alert(report):
    if not SLACK_WEBHOOK: return
    alerts = report["alerts"]
    if not alerts: return
    a = report["analytics"]
    lines = [f"*AlphaDesk 9:45 AM — {datetime.date.today()}*",
             f"${a['total_value']:,.0f} | P&L ${a['total_pnl']:+,.0f} | Theta ${a['daily_theta']:.0f}/day",
             "", "*Alerts:*"]
    for al in alerts:
        icon = {"red":"🔴","yellow":"🟡","green":"🟢"}.get(al["severity"],"⚪")
        lines.append(f"{icon} {al['message']}")
    payload = json.dumps({"text":"\n".join(lines)}).encode()
    req = urllib.request.Request(SLACK_WEBHOOK, data=payload, headers={"Content-Type":"application/json"})
    urllib.request.urlopen(req)
    print("[Slack] Alert sent.")


def run():
    print("="*60)
    print(f"AlphaDesk Daily Monitor  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("="*60)
    positions  = layer1_data_valuation()
    analytics  = layer2_portfolio_analytics(positions)
    macro      = get_macro_score()
    sentiment  = get_ai_sentiment([p["ticker"] for p in positions])
    alerts     = layer4_alerts(positions, analytics, macro, sentiment)
    report     = {"generated_at": datetime.datetime.now().isoformat(),
                  "macro": macro, "analytics": analytics,
                  "positions": positions, "sentiment": sentiment, "alerts": alerts}
    out = f"report_{datetime.date.today()}.json"
    with open(out,"w") as f: json.dump(report,f,indent=2)
    print(f"\n[✓] Report: {out}")
    for al in alerts:
        icon = {"red":"🔴","yellow":"🟡","green":"🟢"}.get(al["severity"],"⚪")
        print(f"  {icon} {al['message']}")
    send_slack_alert(report)
    return report

if __name__ == "__main__":
    run()
