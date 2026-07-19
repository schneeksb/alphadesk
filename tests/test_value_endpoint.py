"""/value wiring: per-account profile resolution + auth gate.

The valuation layers (yfinance) and research cache are stubbed — no network.
"""
import pytest
from fastapi import HTTPException

import research as R
import run_daily


PAYLOAD = {
    "positions": [
        {"id": "1", "ticker": "AAA", "type": "SHARES", "qty": 1, "cost_basis": 100, "account": "roth"},
        {"id": "2", "ticker": "BBB", "type": "SHARES", "qty": 1, "cost_basis": 100, "account": None},
        {"id": "3", "ticker": "CCC", "type": "SHARES", "qty": 1, "cost_basis": 100, "account": "ghost"},
    ],
    "profile": "moderate|growth|swing|intermediate",
    "accounts": [{"id": "roth", "profile": "conservative|growth|daytrader|advanced"}],
}


@pytest.fixture
def stubbed_layers(monkeypatch):
    def fake_layer1(positions):
        return [{**p, "spot": 100.0, "current_val": 1000.0, "pnl": -200.0, "pnl_pct": -0.20,
                 "delta": 0.5, "theta": -1.0, "vega": 0, "iv": 0.3, "dte": None,
                 "prev_close": 99.0, "day_change": 1.0, "day_change_pct": 0.01,
                 "expired": False, "error": None} for p in positions]
    monkeypatch.setattr(run_daily, "layer1_data_valuation", fake_layer1)
    monkeypatch.setattr(run_daily, "get_macro_score",
                        lambda: {"vix": 18, "label": "neutral", "spy_change": 0.0,
                                 "spy_close": 500.0, "breadth": 0.5, "score": 0})
    monkeypatch.setattr(run_daily, "layer4_alerts", lambda *a, **k: [])
    monkeypatch.setattr(R, "_cached",
                        lambda key, fn: {"score": 5, "conviction": "Watch and Wait", "stage": "Stage 2",
                                         "reason": "", "trade_levels": {}})


def test_value_resolves_account_profiles(stubbed_layers):
    out = R.value_endpoint(PAYLOAD, authorization=None)   # auth open outside prod
    by = {p["ticker"]: p for p in out["positions"]}
    # roth override (conservative|daytrader): -20% breaches its -15% cut, day-stop 3%
    assert by["AAA"]["rec"] == "SELL" and by["AAA"]["prof_scope"] == "account"
    assert by["AAA"]["stop_rec"] == 97.0
    # no account → global moderate: -20% is held, swing 8% stop
    assert by["BBB"]["rec"] == "HOLD" and by["BBB"]["prof_scope"] == "global"
    assert by["BBB"]["stop_rec"] == 92.0
    # unknown account id → global fallback
    assert by["CCC"]["rec"] == "HOLD" and by["CCC"]["prof_scope"] == "global"
    assert out["macro"]["spy_close"] == 500.0


def test_value_empty_payload_is_safe(stubbed_layers):
    out = R.value_endpoint({}, authorization=None)
    assert out["positions"] == [] and out["expired"] == [] and out["errored"] == []


def test_value_requires_auth_when_enforced(monkeypatch):
    # Simulate prod (RENDER/REQUIRE_AUTH): unauthenticated /value must be rejected,
    # not silently do yfinance work. With no Supabase config it fails closed (503);
    # with config but no token it's a 401 — either way it raises.
    monkeypatch.setattr(R, "_AUTH_REQUIRED", True)
    with pytest.raises(HTTPException) as exc:
        R.value_endpoint(PAYLOAD, authorization=None)
    assert exc.value.status_code in (401, 503)
