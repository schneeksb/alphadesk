"""/portfolio-analysis analyst knowledge-base timeline (archive + live pulse merge).

Anthropic client, sector rotation, archive and live pulse are all stubbed — no network.
"""
import json

import pytest

import research as R


ARCHIVE = [
    {"analyst_id": "nicholas_crown", "analyst_name": "Nicholas Crown", "label": "Macro & Market Cycles",
     "weight": 1, "video_title": "Liquidity turning", "published_date": "2026-07-17", "sentiment": "cautious",
     "key_takeaway": "Liquidity impulse is rolling over — trim beta.",
     "insight_summary": "Fed RRP drained\nTGA rebuild ahead"},
    {"analyst_id": "nicholas_crown", "analyst_name": "Nicholas Crown", "label": "Macro & Market Cycles",
     "weight": 1, "video_title": "Still risk-on", "published_date": "2026-07-08", "sentiment": "bullish",
     "key_takeaway": "Stay long while liquidity expands.", "insight_summary": "Breadth strong"},
    {"analyst_id": "figuring_out_money", "analyst_name": "Figuring Out Money", "label": "Near Term",
     "weight": 9, "video_title": "old short-term", "published_date": "2026-07-01", "sentiment": "bearish",
     "key_takeaway": "Old near-term chop call.", "insight_summary": ""},
]

LIVE = {"stale": False, "analysts": [
    # Duplicate of the newest archived Crown video — must not double up.
    {"id": "nicholas_crown", "name": "Nicholas Crown", "label": "Macro & Market Cycles", "weight": 1,
     "insights": [{"title": "Liquidity turning", "published": "2026-07-17", "sentiment": "cautious",
                   "takeaway": "Liquidity impulse is rolling over — trim beta.", "points": []}]},
    # Fresher low-weight take — replaces the archived one (depth 1 for weight > 3).
    {"id": "figuring_out_money", "name": "Figuring Out Money", "label": "Near Term", "weight": 9,
     "insights": [{"title": "fresh chop", "published": "2026-07-18", "sentiment": "neutral",
                   "takeaway": "Range-bound into OPEX.", "points": []}]},
]}


@pytest.fixture
def prompt(monkeypatch):
    captured = {}

    class _Msg:
        content = [type("B", (), {"text": json.dumps({"health_score": "Balanced"})})()]

    class _Messages:
        def create(self, **kw):
            captured.update(kw)
            return _Msg()

    class _Client:
        def __init__(self, **kw): self.messages = _Messages()

    monkeypatch.setattr(R.anthropic, "Anthropic", _Client)
    monkeypatch.setattr(R, "sector_rotation_endpoint", lambda: {"sectors": []})
    monkeypatch.setattr(R, "_pulse_archive", lambda: ARCHIVE)
    monkeypatch.setattr(R, "yt_insights_endpoint", lambda: LIVE)

    out = R.portfolio_analysis_endpoint({
        "positions": [{"ticker": "NVDA", "type": "SHARES", "qty": 1, "current_val": 100, "pnl": 0, "pnl_pct": 0}],
        "analytics": {"total_value": 100}, "profile": "", "accounts": [], "macro": {},
    }, authorization=None)
    assert "error" not in out, out
    return captured["messages"][0]["content"]


def test_top_analyst_gets_dated_timeline_with_detail(prompt):
    newest = prompt.index("2026-07-17 cautious — Liquidity impulse is rolling over")
    older = prompt.index("2026-07-08 bullish — Stay long while liquidity expands.")
    assert newest < older                                  # newest first
    assert "• Fed RRP drained" in prompt                   # latest video's points, weight 1 only
    assert "read each analyst's TREND" in prompt


def test_archive_and_live_pulse_dedupe(prompt):
    assert prompt.count("Liquidity impulse is rolling over") == 1


def test_low_weight_analyst_latest_take_only(prompt):
    assert "Range-bound into OPEX." in prompt              # fresh live entry wins
    assert "Old near-term chop call." not in prompt        # archived older one dropped (depth 1)
