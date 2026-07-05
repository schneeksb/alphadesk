"""
AlphaDesk — Market Brief agent
==============================
An agentic (tool-use loop) market analyst, not a one-shot prompt. Claude is
given AlphaDesk's existing data layer as tools, decides what to investigate,
follows the evidence, and finishes by calling `submit_brief` with a structured
Market Brief. Every tool call is logged (name, input, truncated result, ms) so
the investigation is reviewable after the fact.

Priorities baked into the system prompt (user's direction):
  1. Portfolio impact   2. Conviction watchlist   3. Radar watchlist   4. Broad market

Used by:
  - research.py  POST /brief/refresh   (on-demand from the app)
  - run_market_brief.py                (CLI + scheduled pre-market run)

Model: claude-sonnet-4-6 · loop capped at MAX_TURNS. ANTHROPIC_API_KEY from env.
"""

import os, json, time, datetime
import anthropic

MODEL          = "claude-sonnet-4-6"
MAX_TURNS      = 12
PREVIEW_CHARS  = 600      # per-tool preview kept in the saved log
RESULT_CAP     = 9000     # max chars of any tool result sent back to the model


# ── Serialization ─────────────────────────────────────────────────────────────
def _compact(obj, cap=RESULT_CAP):
    """Tool results → compact JSON string (DataFrames/objects already reduced
    to plain dicts by the data layer; _json_safe strips NaN/inf)."""
    import research
    s = json.dumps(research._json_safe(obj), separators=(",", ":"), default=str)
    return s[:cap] + "…(truncated)" if len(s) > cap else s


# ── Tool executors (wrap AlphaDesk's existing data layer — lazy imports) ──────
def _t_market_climate(_inp):
    from scanner import fetch_climate
    return fetch_climate()

def _t_sector_rotation(_inp):
    import research
    return research.sector_rotation_endpoint()

def _t_sector_performance(_inp):
    from scanner import fetch_sectors
    return {"sectors": fetch_sectors()}

def _t_economic_calendar(_inp):
    import research
    return research.calendar_endpoint()

def _t_options_flow(inp):
    import research
    tickers = ",".join([t.strip().upper() for t in (inp.get("tickers") or [])][:8])
    return research.map_data_endpoint(tickers=tickers)

def _t_ticker_snapshot(inp):
    import research
    t = (inp.get("ticker") or "").upper().strip()
    d = research.technicals(t)
    if d is None:
        return {"error": f"no market data for {t}"}
    hist = d.get("history") or []
    move_5d = round((hist[-1] / hist[-6] - 1) * 100, 2) if len(hist) >= 6 and hist[-6] else None
    w52h, w52l, spot = d.get("week52High"), d.get("week52Low"), d.get("spot")
    pos52 = round((spot - w52l) / (w52h - w52l) * 100, 1) if (spot and w52h and w52l and w52h != w52l) else None
    an = d.get("analyst") or {}
    ma = d.get("ma") or {}
    return {"ticker": t, "name": d.get("name"), "sector": d.get("sector"), "mktCap": d.get("mktCap"),
            "spot": spot, "chg_today_pct": d.get("chg"), "move_5d_pct": move_5d,
            "rsi14": d.get("rsi"), "iv_pct": d.get("iv"), "put_call_ratio": d.get("pcRatio"),
            "rel_volume": d.get("relVol"), "pct_of_52wk_range": pos52,
            "days_to_earnings": d.get("daysToEarn"),
            "ma_trend": ma.get("trend"), "ma_cross": ma.get("cross"),
            "pct_vs_50dma": ma.get("vs50"), "pct_vs_200dma": ma.get("vs200"),
            "tactical_setup": (d.get("tactical") or {}).get("key"),
            "analyst_target_mean": an.get("targetMean"), "analyst_rec": an.get("recKey")}

def _t_ticker_fundamentals(inp):
    import research
    t = (inp.get("ticker") or "").upper().strip()
    d = research.fundamentals(t)
    if not d or d.get("error"):
        return {"error": f"no fundamentals for {t}"}
    v = d.get("valuation") or {}
    def vx(k):
        m = v.get(k) or {}
        return {"value": m.get("value"),
                "vs_sector": (m.get("vs_sector") or {}).get("verdict"),
                "vs_own_5yr": (m.get("vs_own") or {}).get("verdict")}
    return {"ticker": t, "sector": d.get("sector"), "verdict": d.get("verdict"),
            "valuation": {k: vx(k) for k in ("forwardPE", "trailingPE", "peg", "ps", "evEbitda")},
            "ttm_revenue_growth": (d.get("ttm") or {}).get("revenueGrowth"),
            "ttm_earnings_growth": (d.get("ttm") or {}).get("earningsGrowth"),
            "health": d.get("health"), "share_dilution_pct": d.get("dilution")}

def _t_analyst_pulse(_inp):
    import research
    return research.yt_insights_endpoint()

_EXECUTORS = {
    "get_market_climate":     _t_market_climate,
    "get_sector_rotation":    _t_sector_rotation,
    "get_sector_performance": _t_sector_performance,
    "get_economic_calendar":  _t_economic_calendar,
    "get_options_flow":       _t_options_flow,
    "get_ticker_snapshot":    _t_ticker_snapshot,
    "get_ticker_fundamentals":_t_ticker_fundamentals,
    "get_analyst_pulse":      _t_analyst_pulse,
}


# ── Tool schemas (rich descriptions steer the investigation) ──────────────────
_BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One line, <=15 words. The single most decision-relevant takeaway of the morning."},
        "market_regime": {
            "type": "object",
            "properties": {
                "label":      {"type": "string", "enum": ["risk-on", "risk-off", "neutral", "mixed"]},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "summary":    {"type": "string", "description": "2-3 sentences on the regime and what's driving it, citing specific readings."},
            },
            "required": ["label", "confidence", "summary"],
        },
        "portfolio_read": {
            "type": "object",
            "description": "TOP PRIORITY section. How today's conditions map onto the user's actual holdings.",
            "properties": {
                "takeaway": {"type": "string", "description": "3-5 sentences, decision-first: what the portfolio owner should know this morning."},
                "exposures": {
                    "type": "array",
                    "items": {"type": "object", "properties": {
                        "theme":    {"type": "string", "description": "e.g. 'Technology concentration', 'Short-dated call options'"},
                        "detail":   {"type": "string"},
                        "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                    }, "required": ["theme", "detail", "severity"]},
                },
            },
            "required": ["takeaway", "exposures"],
        },
        "key_observations": {
            "type": "array",
            "description": "3-6 market observations, each backed by specific evidence from tool results.",
            "items": {"type": "object", "properties": {
                "title":   {"type": "string"},
                "so_what": {"type": "string", "description": "Why this matters to THIS user."},
                "evidence": {"type": "array", "items": {"type": "object", "properties": {
                    "source": {"type": "string", "description": "The tool the fact came from, e.g. get_sector_rotation"},
                    "fact":   {"type": "string", "description": "The specific number/reading, not a paraphrase."},
                }, "required": ["source", "fact"]}},
            }, "required": ["title", "so_what", "evidence"]},
        },
        "watchlist_flags": {
            "type": "array",
            "items": {"type": "object", "properties": {
                "ticker":  {"type": "string"},
                "flag":    {"type": "string", "description": "Short label, e.g. 'Earnings in 3d', 'Oversold + sector improving'"},
                "urgency": {"type": "string", "enum": ["high", "medium", "low"]},
                "reason":  {"type": "string"},
            }, "required": ["ticker", "flag", "urgency", "reason"]},
        },
        "suggested_actions": {
            "type": "array",
            "description": "2-5 concrete, directional actions with honest confidence. Research input, not financial advice.",
            "items": {"type": "object", "properties": {
                "action":     {"type": "string"},
                "rationale":  {"type": "string"},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            }, "required": ["action", "rationale", "confidence"]},
        },
        "what_i_did_not_check": {
            "type": "array", "items": {"type": "string"},
            "description": "Honest gaps: tools not called, data that came back empty/stale, angles skipped for time.",
        },
    },
    "required": ["headline", "market_regime", "portfolio_read", "key_observations",
                 "watchlist_flags", "suggested_actions", "what_i_did_not_check"],
}

TOOLS = [
    {"name": "get_market_climate",
     "description": ("Macro climate gauges: VIX, 10Y yield, HYG credit spread proxy, market breadth, "
                     "dollar (DXY), IG credit, plus a composite macro score (0-100) and posture. "
                     "START HERE — establishes the regime everything else is read against."),
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_sector_rotation",
     "description": ("Relative-strength rotation quadrants vs SPY over 20 days: each sector ETF is tagged "
                     "Leading / Weakening / Improving / Lagging with RS and RS-momentum numbers. "
                     "This is the core evidence for any sector-rotation claim — use it before asserting "
                     "money is moving into or out of a sector."),
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_sector_performance",
     "description": "Simple sector performance heatmap (recent week/month % moves per sector). Complements rotation quadrants with raw returns.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_economic_calendar",
     "description": ("Upcoming macro events within 90 days (FOMC, CPI, NFP, OPEX) with days_away. "
                     "Check for event risk in the next 1-2 weeks — it changes what 'act now' means."),
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_options_flow",
     "description": ("Options positioning for up to 8 specific tickers: put/call volume ratio, relative volume, "
                     "unusual-activity flag, and a bullish/bearish/neutral bias. Slow (~3s per ticker) — "
                     "reserve for the handful of names where positioning actually matters (portfolio holdings, "
                     "flagged watchlist names)."),
     "input_schema": {"type": "object", "properties": {
         "tickers": {"type": "array", "items": {"type": "string"}, "description": "Up to 8 tickers."}},
         "required": ["tickers"]}},
    {"name": "get_ticker_snapshot",
     "description": ("Compact technical snapshot for ONE ticker: price, today + 5-day % move, RSI(14), IV, "
                     "put/call, relative volume, position in 52-week range, days to earnings, analyst mean "
                     "target. Cheap and fast — use freely on portfolio and watchlist names."),
     "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]}},
    {"name": "get_ticker_fundamentals",
     "description": ("Valuation + quality read for ONE ticker: forward/trailing P/E, PEG, P/S, EV/EBITDA each "
                     "tagged cheap/fair/expensive vs sector AND vs the stock's own 5-year history, revenue/earnings "
                     "growth, margins, FCF, dilution, and a plain-English valuation verdict. Use when deciding "
                     "whether a flagged name is worth acting on, not just reacting to."),
     "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]}},
    {"name": "get_analyst_pulse",
     "description": ("The user's trusted YouTube analyst panel (trust-weighted, macro-first ordering): recent "
                     "insights, sentiment, and key takeaways per analyst. Qualitative sentiment layer — may be "
                     "empty/stale if the pipeline hasn't run; if so, say so in what_i_did_not_check."),
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "submit_brief",
     "description": ("Submit the final Market Brief and end the investigation. Call this once you have enough "
                     "evidence — do not pad turns. Every observation must trace to a tool result."),
     "input_schema": _BRIEF_SCHEMA},
]


# ── System prompt ──────────────────────────────────────────────────────────────
def _system(profile: str) -> str:
    try:
        import research
        prof = research._profile_ctx(profile) if profile else ""
    except Exception:
        prof = ""
    return f"""You are AlphaDesk's Market Analyst agent, producing the pre-market Market Brief the user \
reads first every morning. You investigate with tools, follow the evidence, and finish by calling submit_brief.

PRIORITIES, strictly in this order:
1. PORTFOLIO — how do current conditions hit what the user actually owns (positions are in your context)?
2. CONVICTION watchlist names — changes from what a holder would expect.
3. RADAR watchlist names — anything that makes one newly interesting.
4. Broad market — regime, rotation, event risk.

{prof}
INVESTIGATION DISCIPLINE:
- Establish the macro regime first (get_market_climate), then rotation (get_sector_rotation), then event \
risk (get_economic_calendar). Read everything else against that frame.
- Drill into specific tickers ONLY where the macro/sector picture or the user's exposure justifies it. \
Batch independent tool calls in a single turn — you have a hard cap of {MAX_TURNS} turns, be efficient.
- Every observation, flag, and action must cite specific numbers from tool results. Never invent a figure. \
If a tool returns empty or stale data, record that in what_i_did_not_check instead of guessing.
- Be direct and directional. This is the user's personal research input — they explicitly do not want \
hedged both-sides mush. Confidence ratings carry the uncertainty, not weasel wording.
- Honesty over completeness: a shorter brief with real evidence beats a padded one.

Today is {datetime.date.today().isoformat()} ({datetime.date.today().strftime('%A')}). Finish with submit_brief."""


# ── Context block (portfolio + watchlists injected, not fetched) ───────────────
def _context(positions, analytics, conviction, radar, profile):
    lines = []
    if positions:
        lines.append("PORTFOLIO (live valuation):")
        for p in positions[:25]:
            if p.get("error"):
                continue
            desc = f"  {p.get('ticker')} {p.get('type')} x{p.get('qty')}"
            if p.get("strike"): desc += f" ${p['strike']} exp {p.get('expiry')} (DTE {p.get('dte')})"
            desc += f" · value ${p.get('current_val')} · P&L ${p.get('pnl')} ({round((p.get('pnl_pct') or 0)*100,1)}%)"
            if p.get("day_change") is not None: desc += f" · today ${p.get('day_change')}"
            lines.append(desc)
        a = analytics or {}
        if a:
            lines.append(f"  TOTALS: value ${a.get('total_value')} · P&L ${a.get('total_pnl')} "
                         f"· today ${a.get('daily_change')} · net delta {a.get('net_delta')} "
                         f"· daily theta ${a.get('daily_theta')} · sector allocation {a.get('sector_alloc')}")
    else:
        lines.append("PORTFOLIO: (none provided)")
    lines.append(f"CONVICTION WATCHLIST: {', '.join(conviction) if conviction else '(empty)'}")
    lines.append(f"RADAR WATCHLIST: {', '.join(radar) if radar else '(empty)'}")
    lines.append("\nProduce this morning's Market Brief.")
    return "\n".join(lines)


# ── The loop ───────────────────────────────────────────────────────────────────
def run_market_brief(positions=None, analytics=None, conviction=None, radar=None, profile=""):
    """Run the agent. Returns {brief, tool_log, turns, generated_at, model} —
    brief is None only if the loop somehow ends without submit_brief."""
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    messages = [{"role": "user", "content": _context(positions or [], analytics, conviction or [], radar or [], profile)}]
    system = _system(profile)
    tool_log, brief = [], None
    turns_used = 0

    # Prompt caching: the tools schema + system prompt (~3k tokens) are identical
    # every turn, and each turn replays the whole growing conversation. Marking
    # the last tool and the newest message as cache breakpoints means turn N
    # reads everything from turn N-1 at 10% of the input price instead of full.
    cached_tools = [dict(t) for t in TOOLS]
    cached_tools[-1]["cache_control"] = {"type": "ephemeral"}
    cached_system = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
    def _mark_newest(msgs):
        # move the rolling breakpoint to the final content block of the last message
        for m in msgs:
            c = m.get("content")
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict): b.pop("cache_control", None)
        last = msgs[-1]
        if isinstance(last.get("content"), str):
            last["content"] = [{"type": "text", "text": last["content"]}]
        if isinstance(last.get("content"), list) and last["content"] and isinstance(last["content"][-1], dict):
            last["content"][-1]["cache_control"] = {"type": "ephemeral"}

    for turn in range(MAX_TURNS):
        turns_used = turn + 1
        force_submit = (turn == MAX_TURNS - 1)   # last turn: no more investigating
        _mark_newest(messages)
        resp = client.messages.create(
            model=MODEL, max_tokens=4096, system=cached_system, tools=cached_tools,
            tool_choice=({"type": "tool", "name": "submit_brief"} if force_submit else {"type": "auto"}),
            messages=messages,
        )
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            # Model produced prose without finishing — nudge it to conclude.
            messages.append({"role": "assistant", "content": resp.content})
            messages.append({"role": "user", "content": "Continue with tools, or call submit_brief to finish."})
            continue

        results = []
        for tu in tool_uses:
            if tu.name == "submit_brief":
                # The API doesn't hard-enforce `required` — validate and bounce
                # an incomplete brief back for one repair round.
                missing = [k for k in _BRIEF_SCHEMA["required"] if k not in (tu.input or {})]
                if missing and not force_submit:
                    tool_log.append({"turn": turns_used, "tool": "submit_brief",
                                     "input": {"(rejected)": f"missing {missing}"},
                                     "result_preview": "rejected — incomplete", "ms": 0})
                    results.append({"type": "tool_result", "tool_use_id": tu.id,
                                    "content": f"REJECTED: brief is missing required fields {missing}. "
                                               f"Call submit_brief again with ALL required fields populated "
                                               f"(use an empty array only if a section truly has no items)."})
                    continue
                brief = tu.input
                tool_log.append({"turn": turns_used, "tool": "submit_brief",
                                 "input": {"(final brief)": f"{len(json.dumps(tu.input))} chars"},
                                 "result_preview": "brief accepted", "ms": 0})
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": "Brief received."})
                continue
            t0 = time.time()
            try:
                out = _EXECUTORS[tu.name](tu.input or {})
            except Exception as e:
                out = {"error": f"{type(e).__name__}: {e}"}
            s = _compact(out)
            tool_log.append({"turn": turns_used, "tool": tu.name, "input": tu.input,
                             "result_preview": s[:PREVIEW_CHARS], "result_chars": len(s),
                             "ms": int((time.time() - t0) * 1000)})
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": s})

        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content": results})
        if brief is not None:
            break

    return {"brief": brief, "tool_log": tool_log, "turns": turns_used,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "model": MODEL}
