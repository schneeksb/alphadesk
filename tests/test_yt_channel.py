"""Custom YouTube tab: /yt-resolve and /yt-channel-analysis (schema + auth)."""
import pytest
from fastapi import HTTPException

import research as R


ANALYSIS = {
    "channel": "Test Channel", "recent_take": "Cautiously bullish on AI names.",
    "content_overview": "Weekly macro + single-stock breakdowns.", "stance": "bullish",
    "credibility": "Medium",
    "claims_check": [{"claim": "NVDA will hit $200", "assessment": "Above current; speculative.", "verdict": "unverifiable"}],
    "consensus": "Aligns with the panel's risk-on lean.", "contradictions": ["More bullish than the macro read"],
    "red_flags": ["Clickbait titles"], "green_flags": ["Shows charts"], "bottom_line": "Use for ideas, verify calls.",
}


def _stub_ai(monkeypatch):
    block = type("B", (), {"type": "tool_use", "input": ANALYSIS})()
    msg = type("R", (), {"content": [block], "stop_reason": "tool_use"})

    class _Client:
        def __init__(self, **kw):
            self.messages = type("M", (), {"create": lambda _s, **kw: msg()})()
    monkeypatch.setattr(R.anthropic, "Anthropic", _Client)


def test_channel_analysis_returns_schema(monkeypatch):
    _stub_ai(monkeypatch)
    # Stub the data layers so no network: fake recent videos, no transcripts, empty context.
    monkeypatch.setattr(R, "_yt_rss_videos", lambda cid, limit=6: [
        {"vid": "x", "title": "Market crash incoming?!", "published": "2026-09-10",
         "link": "https://youtube.com/watch?v=x", "description": "why I'm buying"}])
    monkeypatch.setattr(R, "_yt_custom_transcripts", lambda cid, limit=4: [])
    monkeypatch.setattr(R, "yt_insights_endpoint", lambda: {"summary": {"mood": "risk-on", "bottom_line": "Stay long."}, "analysts": []})
    monkeypatch.setattr(R, "sector_rotation_endpoint", lambda: {"sectors": []})
    R._CACHE.clear()

    out = R.yt_channel_analysis_endpoint({"channel_id": "UC123", "name": "Test Channel"}, authorization=None)
    assert "error" not in out, out
    assert out["analysis"]["stance"] == "bullish"
    assert out["analysis"]["claims_check"][0]["verdict"] == "unverifiable"
    assert out["videos"][0]["title"].startswith("Market crash")
    assert out["has_transcripts"] is False


def test_channel_analysis_requires_channel_id(monkeypatch):
    _stub_ai(monkeypatch)
    out = R.yt_channel_analysis_endpoint({}, authorization=None)
    assert out.get("error")


def test_yt_endpoints_require_auth_when_enforced(monkeypatch):
    monkeypatch.setattr(R, "_AUTH_REQUIRED", True)
    with pytest.raises(HTTPException):
        R.yt_channel_analysis_endpoint({"channel_id": "UC123"}, authorization=None)
    with pytest.raises(HTTPException):
        R.yt_resolve_endpoint({"q": "@someone"}, authorization=None)
