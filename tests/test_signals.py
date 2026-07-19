"""Deterministic Signal/Stop logic: _recommend, _stop_recommendation, _profile_knobs.

No network, no API keys — pure functions only.
"""
import itertools

import research as R

# Profiles used throughout ("risk|goals|styles|level")
CONS_LT  = "conservative|growth|longterm|advanced"
CONS_DAY = "conservative|growth|daytrader|advanced"
DEGEN    = "degen|speculation|options|advanced"
AGG      = "aggressive|growth|swing|intermediate"


# ── Legacy equivalence: no profile (and moderate|swing) must reproduce the
#    original hardcoded behavior exactly. This reference implementation IS the
#    pre-profile logic — do not "fix" it; it documents frozen behavior. ──────
def _legacy_recommend(score, pnl_pct, dte, conviction=None):
    if pnl_pct is not None and pnl_pct <= -0.25: return "SELL"
    if conviction == "Risky Setup": return "SELL"
    if dte is not None and dte < 21 and conviction != "Strong Setup" and (score is None or score < 6): return "SELL"
    if conviction == "Strong Setup": return "HOLD" if (pnl_pct or 0) >= 0.6 else "BUY"
    if score is None: return "HOLD"
    if score >= 7: return "HOLD" if (pnl_pct or 0) >= 0.6 else "BUY"
    if score <= 3.5: return "SELL"
    if pnl_pct is not None and pnl_pct >= 0.5: return "SELL"
    return "HOLD"


def test_recommend_defaults_match_legacy():
    cases = itertools.product(
        [None, 2, 5, 8],
        [None, -0.6, -0.4, -0.26, -0.2, -0.05, 0.1, 0.45, 0.55, 0.7, 1.0],
        [None, 3, 5, 15, 25, 60],
        [None, "Strong Setup", "Risky Setup", "Watch and Wait"])
    for c in cases:
        assert R._recommend(*c) == _legacy_recommend(*c), f"drift at {c}"
        assert R._recommend(*c, profile="moderate|growth|swing|intermediate") == _legacy_recommend(*c), f"moderate|swing drift at {c}"


def test_stop_defaults_match_legacy_bands():
    assert R._stop_recommendation("SHARES", 100) == 92.0      # 8% below spot
    assert R._stop_recommendation("CALL", 100) == 84.8        # options band ~15.2% (was 15%)
    assert R._stop_recommendation("CRYPTO", 100) == 84.8
    assert R._stop_recommendation("SHARES", None) is None
    assert R._stop_recommendation("SHARES", 0) is None


# ── Profile calibration ─────────────────────────────────────────────────────
def test_loss_cut_scales_with_risk():
    args = (5, -0.20, None, "Watch and Wait")
    assert R._recommend(*args, profile=CONS_DAY) == "SELL"    # cuts at -15%
    assert R._recommend(*args) == "HOLD"                      # moderate holds to -25%
    assert R._recommend(5, -0.45, None, "Watch and Wait", profile=DEGEN) == "HOLD"
    assert R._recommend(5, -0.55, None, "Watch and Wait", profile=DEGEN) == "SELL"


def test_longterm_conviction_survives_drawdown():
    # Long-term + Strong Setup: price alone is not a thesis change…
    assert R._recommend(5, -0.20, None, "Strong Setup", profile=CONS_LT) == "BUY"
    # …but an AI Risky Setup verdict still overrides the patience.
    assert R._recommend(5, -0.20, None, "Risky Setup", profile=CONS_LT) == "SELL"


def test_profit_taking_scales_with_risk():
    assert R._recommend(5, 0.35, None, None, profile=CONS_LT) == "TRIM"   # long-term scales out
    assert R._recommend(5, 0.35, None, None, profile=CONS_DAY) == "SELL"  # short-horizon exits
    assert R._recommend(5, 0.35, None, None, profile=DEGEN) == "HOLD"     # degen rides
    assert R._recommend(5, 1.30, None, None, profile=DEGEN) == "SELL"     # even degen takes +130%
    assert R._recommend(5, 0.55, None, None, profile=AGG) == "HOLD"       # aggressive rides past +50%


def test_dte_exit_scales_with_risk():
    weak = (5, 0.0)
    assert R._recommend(*weak, 18, None) == "SELL"                        # moderate bails <21 DTE
    assert R._recommend(*weak, 18, None, profile=DEGEN) == "HOLD"         # degen holds to <7
    assert R._recommend(*weak, 5, None, profile=DEGEN) == "SELL"
    assert R._recommend(*weak, 25, None, profile=CONS_LT) == "SELL"       # conservative bails <30


def test_stop_widths_by_style_and_risk():
    assert R._stop_recommendation("SHARES", 100, CONS_DAY) == 97.0    # day 4% × cons 0.75
    assert R._stop_recommendation("SHARES", 100, CONS_LT) == 88.75    # long-term 15% × 0.75
    assert R._stop_recommendation("SHARES", 100, DEGEN) == 87.2       # swing-base 8% × 1.6
    assert R._stop_recommendation("CALL", 100, DEGEN) == 75.68        # options 15.2% × 1.6
    # Widest combination hits the 50% safety cap path but stays sane
    wide = R._stop_recommendation("CALL", 100, "degen|speculation|longterm|advanced")
    assert 50.0 <= wide < 60.0


def test_profile_knobs_shapes():
    k = R._profile_knobs("")                                  # empty → moderate/swing legacy values
    assert (k["loss_cut"], k["gain_trim"], k["gain_hold"], k["dte_exit"]) == (-0.25, 0.50, 0.60, 21)
    assert k["stop_base"] == 0.08 and k["stop_mult"] == 1.0
    k = R._profile_knobs("degen|speculation|options,daytrader|advanced")
    assert k["risk"] == "degen" and "daytrader" in k["styles"] and k["stop_base"] == 0.04
    k = R._profile_knobs("not-a-risk|x|y|z")                  # junk degrades to moderate thresholds
    assert k["loss_cut"] == -0.25


def test_profile_line_render():
    assert R._profile_line("") == ""
    line = R._profile_line("conservative|growth,income|longterm|advanced")
    assert "Risk: conservative" in line and "growth, income" in line and "longterm" in line
    assert "Risk: moderate" in R._profile_line("|||")         # empty segments → defaults
