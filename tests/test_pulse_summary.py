"""Market Pulse panel summary: /yt-insights attaches a trust-weighted AI summary."""
import json
import urllib.request

import pytest

import research as R


PULSE_ROWS = [
    {"analyst_id": "nicholas_crown", "weight": 1, "video_title": "Liquidity read",
     "video_link": "https://youtube.com/watch?v=a", "published_date": "2026-07-18",
     "insight_summary": "Liquidity rolling over\nTrim beta", "key_takeaway": "Trim beta into strength.",
     "sentiment": "cautious", "fetched_at": "2099-01-01T00:00:00+00:00"},
    {"analyst_id": "jerry_romine", "weight": 3, "video_title": "NVDA",
     "video_link": "https://youtube.com/watch?v=b", "published_date": "2026-07-18",
     "insight_summary": "NVDA earnings strong", "key_takeaway": "Buying NVDA on the dip.",
     "sentiment": "bullish", "fetched_at": "2099-01-01T00:00:00+00:00"},
]


@pytest.fixture(autouse=True)
def _clear_cache():
    # _cached_swr / _cached memoize in R._CACHE; clear so each test recomputes
    # (both tests share a fetched_at, hence the same pulse-summary cache key).
    R._CACHE.clear()
    yield
    R._CACHE.clear()


def _patch(monkeypatch, ai_text):
    """Stub Supabase read (market_pulse rows) + the Anthropic summary call."""
    class _Resp:
        status = 200
        def __init__(self, payload): self._p = json.dumps(payload).encode()
        def read(self): return self._p
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(R.os, "getenv", lambda k, d=None: {
        "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_ANON_KEY": "anon",
        "ANTHROPIC_API_KEY": "sk-test"}.get(k, d if d is not None else ""))
    # The endpoint does a local `import urllib.request`, so patch the real module.
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=10: _Resp(PULSE_ROWS))

    class _Msg:
        content = [type("B", (), {"text": ai_text})()]

    class _Client:
        def __init__(self, **kw):
            self.messages = type("M", (), {"create": lambda _s, **kw: _Msg()})()

    monkeypatch.setattr(R.anthropic, "Anthropic", _Client)


def test_summary_attached_to_yt_insights(monkeypatch):
    _patch(monkeypatch, json.dumps({
        "mood": "cautious",
        "bottom_line": "Trusted macro voices are turning defensive while stock-pickers stay long.",
        "themes": ["AI leadership (NVDA)", "Liquidity rolling over"],
        "divergence": "Crown cautious vs Romine bullish on beta.",
        "standout": "Crown: trim beta into strength."}))
    out = R.yt_insights_endpoint()
    assert "summary" in out, out
    s = out["summary"]
    assert s["mood"] == "cautious"
    assert "themes" in s and len(s["themes"]) == 2
    assert s["standout"].startswith("Crown")


def test_summary_absent_when_ai_fails(monkeypatch):
    _patch(monkeypatch, "not json at all")   # _lenient_json returns non-dict → no summary
    out = R.yt_insights_endpoint()
    assert out.get("analysts")                # panel still returns
    assert "summary" not in out               # but no summary key when it can't be built
