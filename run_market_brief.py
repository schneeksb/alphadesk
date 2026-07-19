"""
AlphaDesk — Market Brief runner (CLI + scheduled)
=================================================
Pulls the user's live state (positions, watchlist, profile) from Supabase,
values the portfolio, runs the Market Brief agent, prints the tool-call log,
and saves the brief + log to the `market_brief` table.

Run it:      python run_market_brief.py [--no-save] [--user <uuid>]
Scheduled:   Render Cron Job (see render.yaml) pre-market on weekdays.

Env (.env locally / Render dashboard for the cron service):
    ANTHROPIC_API_KEY          — agent model calls
    SUPABASE_URL               — project URL
    SUPABASE_SERVICE_ROLE_KEY  — server-side ONLY (cron/local). Reads the user's
                                 portfolios row and writes market_brief, bypassing
                                 RLS. Never in the frontend, never in the public
                                 web service.
"""

import os, sys, json, argparse, urllib.request
from dotenv import load_dotenv

# UTF-8 console (Windows cp1252 would choke on arrows/emoji in titles)
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

load_dotenv()

SB_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SB_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()


def _sb(method, path, body=None, prefer="return=minimal"):
    url = f"{SB_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}",
        "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def load_user_state(user_id=None):
    q = "portfolios?select=user_id,data,updated_at&order=updated_at.desc&limit=1"
    if user_id:
        q = f"portfolios?select=user_id,data,updated_at&user_id=eq.{user_id}&limit=1"
    rows = _sb("GET", q) or []
    if not rows:
        raise SystemExit("No portfolios row found in Supabase — sign into the app once first.")
    row = rows[0]
    d = row.get("data") or {}
    prof = d.get("profile") or {}
    def _seg(v, default):
        # goals/styles are arrays when saved by the multi-select profiler
        if isinstance(v, list):
            return ",".join(str(x) for x in v) or default
        return str(v) if v else default
    profile_str = (f"{_seg(prof.get('riskTolerance'),'moderate')}|{_seg(prof.get('goal'),'growth')}"
                   f"|{_seg(prof.get('style'),'longterm')}|{_seg(prof.get('level'),'intermediate')}") if prof else ""
    accounts = d.get("accounts") or []
    return {"user_id": row["user_id"], "positions": d.get("positions") or [],
            "watchlist": d.get("watchlist") or [], "radar": d.get("radar") or [],
            "profile": profile_str,
            # Snapshot inputs: combined cash/margin (global + per-account) and the
            # cumulative realized P&L from the Closed ledger.
            "cash":   float(d.get("cash") or 0)   + sum(float(a.get("cash") or 0)   for a in accounts),
            "margin": float(d.get("margin") or 0) + sum(float(a.get("margin") or 0) for a in accounts),
            "realized_pnl": sum(float(c.get("realized_pnl") or 0)
                                for c in (d.get("closedPositions") or []))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-save", action="store_true", help="print only, skip Supabase write")
    ap.add_argument("--user", default=None, help="specific user_id (default: most recently active)")
    args = ap.parse_args()

    missing = [n for n, v in [("SUPABASE_URL", SB_URL), ("SUPABASE_SERVICE_ROLE_KEY", SB_KEY),
                              ("ANTHROPIC_API_KEY", os.getenv("ANTHROPIC_API_KEY"))] if not v]
    if missing:
        raise SystemExit(f"Missing env vars: {', '.join(missing)}")

    state = load_user_state(args.user)
    print(f"User {state['user_id'][:8]}… · {len(state['positions'])} position(s) · "
          f"{len(state['watchlist'])} watchlist name(s)")

    # Value the portfolio with the existing layer (live yfinance)
    valued, analytics = [], {}
    if state["positions"]:
        from run_daily import layer1_data_valuation, layer2_portfolio_analytics
        valued = layer1_data_valuation(state["positions"])
        ok = [p for p in valued if not p.get("error") and not p.get("expired")]
        if ok:
            analytics = layer2_portfolio_analytics(ok)

    from market_brief_agent import run_market_brief
    print("\nRunning Market Brief agent …\n" + "-" * 60)
    out = run_market_brief(positions=valued, analytics=analytics,
                           conviction=state["watchlist"], radar=state["radar"],
                           profile=state["profile"])

    # Tool-call log
    print(f"{'#':>2}  {'tool':<26} {'ms':>6}  input")
    for e in out["tool_log"]:
        print(f"{e['turn']:>2}  {e['tool']:<26} {e.get('ms',0):>6}  {json.dumps(e.get('input') or {})[:70]}")
    print("-" * 60)

    b = out.get("brief")
    if not b:
        raise SystemExit("Agent finished without submitting a brief — not saved.")
    reg = b.get("market_regime") or {}
    print(f"\nHEADLINE: {b.get('headline')}")
    print(f"REGIME:   {reg.get('label')} ({reg.get('confidence')})")
    print(f"OBSERVATIONS: {len(b.get('key_observations') or [])} · FLAGS: {len(b.get('watchlist_flags') or [])} "
          f"· ACTIONS: {len(b.get('suggested_actions') or [])} · turns used: {out['turns']}")

    if args.no_save:
        print("\n--no-save: skipping Supabase write. Full artifact below.")
        print("===BRIEF_JSON_START===")
        print(json.dumps(out, default=str))
        print("===BRIEF_JSON_END===")
        return

    _sb("POST", "market_brief", {
        "user_id": state["user_id"], "source": "scheduled" if os.getenv("RENDER") else "manual-cli",
        "brief": b, "tool_log": out["tool_log"],
        "model": out["model"], "turns": out["turns"],
    })
    print("\nSaved to market_brief ✓")

    # Daily portfolio snapshot (best-effort): fills weekday mornings the app isn't
    # opened, so the Performance panel has a continuous history. Same upsert key
    # as the frontend — (user_id, snap_date) — so double-writes are harmless.
    if analytics:
        try:
            import datetime as _dt
            from run_daily import get_macro_score
            _sb("POST", "portfolio_snapshots", {
                "user_id": state["user_id"],
                "snap_date": _dt.date.today().isoformat(),
                "total_value": round(analytics.get("total_value") or 0),
                "total_cost":  round(analytics.get("total_cost") or 0),
                "total_pnl":   round(analytics.get("total_pnl") or 0),
                "realized_pnl": round(state.get("realized_pnl") or 0),
                "cash":   round(state.get("cash") or 0),
                "margin": round(state.get("margin") or 0),
                "net_value": round((analytics.get("total_value") or 0) - (state.get("margin") or 0)),
                "spy_close": (get_macro_score() or {}).get("spy_close"),
                "positions_count": len([p for p in valued if not p.get("error") and not p.get("expired")]),
            }, prefer="return=minimal,resolution=merge-duplicates")
            print("Snapshot upserted ✓")
        except Exception as e:
            print(f"Snapshot skipped: {e}")


if __name__ == "__main__":
    main()
