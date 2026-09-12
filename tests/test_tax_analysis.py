"""/tax-analysis: schema-validated CPA plan via forced tool use, and auth gating."""
import json

import pytest
from fastapi import HTTPException

import research as R


PROFILE = {"filing_status": "mfj", "state": "CA", "tax_year": 2026,
           "w2_wages": 220000, "se_income": 40000, "business_entity": "scorp"}
INVEST = {"tax_year": 2026, "realized_short_term": 5000, "realized_long_term": -2000,
          "harvest_candidates": [{"ticker": "ARKK", "loss": -3200, "term": "short"}],
          "margin_interest_annual": 1500}

PLAN = {
    "tax_year": 2026, "summary": "High MFJ income with S-corp room.",
    "est_total_tax": "$48,000–$54,000", "est_effective_rate": "19%", "est_marginal_bracket": "32%",
    "strategies": [{"title": "Max the solo-401k", "category": "retirement", "detail": "…",
                    "est_savings": "$7,000", "effort": "low", "priority": 1}],
    "tax_loss_harvesting": [{"ticker": "ARKK", "term": "short", "loss": "-$3,200",
                             "est_benefit": "~$1,024", "wash_sale_risk": "Don't rebuy for 30 days", "note": "…"}],
    "retirement_moves": ["Backdoor Roth"], "business_qbi": ["Review reasonable comp"],
    "estimated_tax": ["Pay Q3 by Sept 15"], "deductions": ["Bunch charity"],
    "watch_outs": ["Provide dividend income"], "disclaimer": "Not tax advice.",
}


def _patch(monkeypatch):
    block = type("B", (), {"type": "tool_use", "input": PLAN})()
    msg = type("R", (), {"content": [block], "stop_reason": "tool_use"})
    captured = {}

    class _Messages:
        def create(self, **kw): captured.update(kw); return msg()

    class _Client:
        def __init__(self, **kw): self.messages = _Messages()

    monkeypatch.setattr(R.anthropic, "Anthropic", _Client)
    return captured


def test_tax_analysis_returns_schema_plan(monkeypatch):
    captured = _patch(monkeypatch)
    out = R.tax_analysis_endpoint({"profile": PROFILE, "investments": INVEST}, authorization=None)
    assert "error" not in out, out
    assert out["est_total_tax"] == "$48,000–$54,000"
    assert out["tax_loss_harvesting"][0]["ticker"] == "ARKK"
    assert "generated_at" in out
    # The profile + investment activity are actually put in front of the model.
    prompt = captured["messages"][0]["content"]
    assert "mfj" in prompt and "ARKK" in prompt and "scorp" in prompt


def test_tax_analysis_requires_auth_when_enforced(monkeypatch):
    monkeypatch.setattr(R, "_AUTH_REQUIRED", True)
    with pytest.raises(HTTPException) as exc:
        R.tax_analysis_endpoint({"profile": PROFILE, "investments": INVEST}, authorization=None)
    assert exc.value.status_code in (401, 503)


def test_tax_analysis_empty_payload_is_safe(monkeypatch):
    _patch(monkeypatch)
    out = R.tax_analysis_endpoint({}, authorization=None)
    assert "error" not in out and "generated_at" in out
