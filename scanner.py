"""
AlphaDesk — AI Morning Scanner (8 AM ET)
=========================================
Produces the morning brief that feeds the dashboard:
  1. Macro/micro climate  (VIX, 10Y, credit spreads, breadth, DXY, Fed path)
  2. Sector rotation       (winners vs losers, day + 1-month)
  3. What's hot / what's not (ranked movers + the WHY)
  4. Option plays           (strike + expiry + thesis + probabilities + pros/cons)

Run:   python scanner.py
Cron:  0 8 * * 1-5 cd /path/to/alphadesk && python scanner.py >> logs/scanner.log 2>&1

Requires: pip install yfinance pandas numpy scipy anthropic python-dotenv
"""

import os, json, datetime, time, re
import numpy as np
import yfinance as yf
from dotenv import load_dotenv
import anthropic
import urllib.request, urllib.parse, base64

load_dotenv()


def _lenient_json(raw):
    """Parse JSON from an LLM that may include ```fences```, // or /* */ comments,
    or trailing commas. Strips comments only outside string literals."""
    s = raw.strip().replace("```json", "").replace("```", "").strip()
    i, j = s.find("{"), s.rfind("}")
    if i != -1 and j != -1:
        s = s[i:j + 1]
    out, in_str, esc, k = [], False, False, 0
    while k < len(s):
        ch = s[k]
        if in_str:
            out.append(ch)
            if esc:            esc = False
            elif ch == "\\":   esc = True
            elif ch == '"':    in_str = False
            k += 1; continue
        if ch == '"':
            in_str = True; out.append(ch); k += 1; continue
        if ch == "/" and k + 1 < len(s) and s[k + 1] == "/":
            while k < len(s) and s[k] != "\n": k += 1
            continue
        if ch == "/" and k + 1 < len(s) and s[k + 1] == "*":
            k += 2
            while k + 1 < len(s) and not (s[k] == "*" and s[k + 1] == "/"): k += 1
            k += 2; continue
        out.append(ch); k += 1
    cleaned = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
    return json.loads(cleaned)

# ── CONFIG ────────────────────────────────────────────────────────────────────
WATCHLIST = [
    "NVDA","MSFT","META","AAPL","GOOGL","AMZN","TSLA","AMD","AVGO","CRM",
    "PLTR","SOFI","MSTR","COIN","RKLB","HOOD","SMCI","ARM","IONQ","NBIS",
]

# Sector ETFs → human label (for the rotation heatmap)
SECTOR_ETFS = {
    "SMH":"Semiconductors", "IGV":"Software",        "XLC":"Comm Services",
    "XLF":"Financials",     "XLI":"Industrials",     "XLV":"Healthcare",
    "XLP":"Consumer Staples","XLE":"Energy",         "XLU":"Utilities",
    "XLRE":"Real Estate",
}

SLACK_WEBHOOK = os.getenv("SLACK_WEBHOOK_URL", "")
TWILIO_SID    = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN  = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM   = os.getenv("TWILIO_FROM_NUMBER", "")
TWILIO_TO     = os.getenv("TWILIO_TO_NUMBER", "")


# ── LAYER: MACRO / MICRO CLIMATE ──────────────────────────────────────────────
def fetch_climate():
    """Deterministic macro + micro factors → 0-100 macro score."""
    print("[Climate] Fetching macro/micro factors...")
    def last(sym, period="5d"):
        try:
            c = yf.Ticker(sym).history(period=period)["Close"].dropna()
            return float(c.iloc[-1]) if not c.empty else None
        except Exception:
            return None
    def chg(sym, period="5d"):
        try:
            c = yf.Ticker(sym).history(period=period)["Close"].dropna()
            return float(c.iloc[-1]/c.iloc[-2]-1) if len(c)>1 else 0.0
        except Exception:
            return 0.0

    vix   = last("^VIX") or 18.0
    tnx   = last("^TNX")                    # ^TNX now quotes the 10Y yield directly (e.g. 4.5)
    y10   = round(tnx, 2) if tnx else 4.2
    dxy   = last("DX-Y.NYB") or 102.0
    hyg   = chg("HYG")                      # high-yield ETF — credit proxy
    lqd   = chg("LQD")                      # IG credit proxy
    # Breadth proxy: % of watchlist above their 20-day MA
    above = 0; total = 0
    for t in WATCHLIST:
        try:
            c = yf.Ticker(t).history(period="30d")["Close"].dropna()
            if len(c) >= 20:
                total += 1
                if c.iloc[-1] > c.rolling(20).mean().iloc[-1]:
                    above += 1
        except Exception:
            pass
    breadth = round(above/total, 2) if total else 0.5

    # Composite 0-100 (higher = calmer / more risk-on)
    score = 50
    score += (20 - vix) * 1.6           # calm VIX adds
    score += (breadth - 0.5) * 40       # broad participation adds
    score += hyg * 300                  # credit risk-on adds
    score -= max(0, (y10 - 4.5)) * 8    # high rates subtract
    score = int(max(0, min(100, score)))

    posture = ("Risk-On, Late-Cycle" if score>60 else
               "Neutral, Range-Bound" if score>40 else
               "Risk-Off, Defensive")

    climate = {
        "macro_score": score, "posture": posture,
        "gauges": [
            {"label":"VIX",            "symbol":"^VIX",     "value":f"{vix:.1f}",   "trend":"down" if vix<18 else "up",   "good":vix<20},
            {"label":"10Y Yield",      "symbol":"^TNX",     "value":f"{y10:.2f}%",  "trend":"down",                        "good":y10<4.5},
            {"label":"Credit (HYG)",   "symbol":"HYG",      "value":f"{hyg*100:+.2f}%","trend":"up" if hyg>0 else "down",  "good":hyg>=0},
            {"label":"Mkt Breadth",    "symbol":"SPY",      "value":f"{int(breadth*100)}%","trend":"up" if breadth>0.55 else "down","good":breadth>0.55},
            {"label":"Dollar (DXY)",   "symbol":"DX-Y.NYB", "value":f"{dxy:.1f}",   "trend":"down","good":dxy<104},
            {"label":"IG Credit (LQD)","symbol":"LQD",      "value":f"{lqd*100:+.2f}%","trend":"up" if lqd>0 else "down","good":lqd>=0},
        ],
        "raw": {"vix":vix, "y10":y10, "dxy":dxy, "hyg":hyg, "breadth":breadth},
    }
    print(f"  Macro score {score}/100 — {posture}")
    return climate


# ── LAYER: SECTOR ROTATION ────────────────────────────────────────────────────
def fetch_sectors():
    """Day + 1-month performance per sector ETF → winners/losers heatmap."""
    print("[Sectors] Fetching rotation data...")
    out = []
    for etf, name in SECTOR_ETFS.items():
        try:
            c = yf.Ticker(etf).history(period="30d")["Close"].dropna()
            if len(c) < 21: continue
            day   = float(c.iloc[-1]/c.iloc[-2]-1)*100
            month = float(c.iloc[-1]/c.iloc[0]-1)*100
            status = ("hot" if month>8 else "warm" if month>2 else
                      "neutral" if month>-2 else "cool" if month>-5 else "cold")
            out.append({"name":name, "day":round(day,2), "month":round(month,1), "status":status})
        except Exception as e:
            print(f"  ⚠ {etf}: {e}")
        time.sleep(0.1)
    out.sort(key=lambda x: x["month"], reverse=True)
    if out:
        print(f"  Leader: {out[0]['name']} ({out[0]['month']:+.1f}%) | Laggard: {out[-1]['name']} ({out[-1]['month']:+.1f}%)")
    return out


# ── LAYER: MOVER SNAPSHOT (for the AI) ────────────────────────────────────────
def fetch_snapshot():
    print("[Snapshot] Scanning watchlist...")
    snap = {}
    for t in WATCHLIST:
        try:
            tk = yf.Ticker(t); h = tk.history(period="30d")
            c = h["Close"].dropna()
            if c.empty: continue
            spot = float(c.iloc[-1])
            d1 = (spot/float(c.iloc[-2])-1) if len(c)>1 else 0
            d5 = (spot/float(c.iloc[-6])-1) if len(c)>=6 else 0
            d20= (spot/float(c.iloc[-21])-1) if len(c)>=21 else 0
            # RSI14
            delta=c.diff(); up=delta.clip(lower=0).rolling(14).mean(); dn=(-delta.clip(upper=0)).rolling(14).mean()
            rsi=float(100-100/(1+up.iloc[-1]/dn.iloc[-1])) if dn.iloc[-1] else 50
            vr=float(h["Volume"].iloc[-1]/h["Volume"].mean()) if h["Volume"].mean() else 1
            iv=None
            try:
                exps=tk.options
                if exps:
                    ch=tk.option_chain(exps[0]).calls
                    iv=float(ch.iloc[(ch["strike"]-spot).abs().argsort()[:1]]["impliedVolatility"].values[0])
            except Exception: pass
            snap[t]={"spot":round(spot,2),"d1":round(d1,4),"d5":round(d5,4),"d20":round(d20,4),
                     "rsi":round(rsi,1),"vol_ratio":round(vr,2),"iv":round(iv,3) if iv else None}
            time.sleep(0.1)
        except Exception as e:
            print(f"  ⚠ {t}: {e}")
    return snap


# ── AI: BRIEF (hot/not + plays with probabilities & pros/cons) ────────────────
def ai_brief(snapshot, sectors, climate):
    print("[AI] Generating morning brief...")
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    prompt = f"""You are an elite options strategist writing a morning brief for {datetime.date.today()}.

MACRO CLIMATE: score {climate['macro_score']}/100, posture "{climate['posture']}".
Raw: {json.dumps(climate['raw'])}

SECTOR ROTATION (1-month %, sorted): {json.dumps([(s['name'], s['month']) for s in sectors])}

WATCHLIST SNAPSHOT: {json.dumps(snapshot, indent=1)}

Produce a JSON object with EXACTLY this shape (no markdown, no preamble):
{{
  "climate_note": "2-3 sentences on overall posture and what it means for positioning",
  "hot": [   // 3 tickers with bullish momentum/setup
    {{"ticker":"","chg":"+X.X%","why":"2 sentences: catalyst + technical read","iv":"XX%","ivNote":"what the IV means for buying options"}}
  ],
  "not": [   // 3 tickers that are weak/avoid
    {{"ticker":"","chg":"-X.X%","why":"2 sentences why it's weak","iv":"XX%","ivNote":"IV read"}}
  ],
  "plays": [  // 3 option plays across short/medium/long horizon
    {{
      "ticker":"", "horizon":"Swing · 7-14d" | "LEAPS · 60-90d",
      "direction":"CALL"|"PUT", "spot":0.0, "strike":0, "expiry":"YYYY-MM-DD",
      "dte":0, "premium":0.0, "conviction":"HIGH"|"MEDIUM"|"LOW",
      "thesis":"3-4 sentences: why this strike, why this expiry, the Greeks logic, the edge",
      "prob":{{"bull":0,"base":0,"bear":0}},   // integers summing to 100
      "scenarios":{{
        "bull":"price target -> approx option value (% gain) + 1 phrase why",
        "base":"...", "bear":"..."
      }},
      "pros":["","",""], "cons":["","",""]
    }}
  ]
}}

Rules: pick real strikes near spot, expiries with DTE>45 for LEAPS and 7-21 for swings.
Probabilities must be realistic (bear case is real — options can expire worthless).
Be specific and honest about downside."""

    r = client.messages.create(model="claude-sonnet-4-6", max_tokens=8000,
        messages=[{"role":"user","content":prompt}])
    if r.stop_reason == "max_tokens":
        print("  ⚠ brief hit max_tokens — response may be truncated")
    return _lenient_json(r.content[0].text)


# ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
def send_slack(brief, climate, sectors):
    if not SLACK_WEBHOOK: return
    L=[f"*📊 AlphaDesk — {datetime.date.today()}*",
       f"Macro {climate['macro_score']}/100 · {climate['posture']}",
       f"_{brief.get('climate_note','')}_","",
       f"🔥 *HOT:* "+", ".join(p['ticker'] for p in brief['hot']),
       f"❄️ *NOT:* "+", ".join(p['ticker'] for p in brief['not']),
       f"📈 Top sector: {sectors[0]['name']} ({sectors[0]['month']:+.1f}%)","","*PLAYS:*"]
    for p in brief["plays"]:
        L.append(f"• *{p['ticker']}* ${p['strike']}{p['direction'][0]} exp {p['expiry']} ({p['conviction']}) — bull {p['prob']['bull']}% / bear {p['prob']['bear']}%")
    payload=json.dumps({"text":"\n".join(L)}).encode()
    req=urllib.request.Request(SLACK_WEBHOOK,data=payload,headers={"Content-Type":"application/json"})
    urllib.request.urlopen(req); print("[Slack] Sent.")

def send_sms(brief):
    if not all([TWILIO_SID,TWILIO_TOKEN,TWILIO_FROM,TWILIO_TO]):
        print("[SMS] Twilio not configured — skipping."); return
    body=f"AlphaDesk {datetime.date.today()}\nHOT: "+",".join(p['ticker'] for p in brief['hot'])+"\nPlays:\n"
    body+="\n".join(f"{p['ticker']} ${p['strike']}{p['direction'][0]} {p['expiry']}" for p in brief['plays'])
    url=f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json"
    data=urllib.parse.urlencode({"From":TWILIO_FROM,"To":TWILIO_TO,"Body":body}).encode()
    req=urllib.request.Request(url,data=data,headers={"Content-Type":"application/x-www-form-urlencoded"})
    req.add_header("Authorization","Basic "+base64.b64encode(f"{TWILIO_SID}:{TWILIO_TOKEN}".encode()).decode())
    urllib.request.urlopen(req); print("[SMS] Sent.")


# ── MAIN ──────────────────────────────────────────────────────────────────────
def run():
    print("="*60)
    print(f"AlphaDesk Morning Scanner  {datetime.datetime.now():%Y-%m-%d %H:%M}")
    print("="*60)
    climate  = fetch_climate()
    sectors  = fetch_sectors()
    snapshot = fetch_snapshot()
    brief    = ai_brief(snapshot, sectors, climate)

    report = {"generated_at":datetime.datetime.now().isoformat(),
              "climate":climate, "sectors":sectors, **brief, "snapshot":snapshot}
    out=f"scanner_{datetime.date.today()}.json"
    with open(out,"w") as f: json.dump(report,f,indent=2)
    print(f"[✓] Saved {out}")

    print("\n🔥 HOT:", ", ".join(p["ticker"] for p in brief["hot"]))
    print("❄️  NOT:", ", ".join(p["ticker"] for p in brief["not"]))
    print("\nPLAYS:")
    for p in brief["plays"]:
        print(f"  {p['ticker']} ${p['strike']}{p['direction'][0]} exp {p['expiry']} | {p['conviction']} | bull {p['prob']['bull']}% base {p['prob']['base']}% bear {p['prob']['bear']}%")

    send_slack(brief, climate, sectors)
    send_sms(brief)
    return report

if __name__ == "__main__":
    run()
