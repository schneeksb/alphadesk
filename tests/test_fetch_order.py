"""Round-robin fetch order: every analyst gets a caption request before any gets
seconds — so the low-trust tail (FX Evolution, Figuring Out Money) clears YouTube's
IP block, which trips partway through a run."""
import fetch_transcripts as F


def _plan(name, n):
    return {"a": {"name": name}, "cands": [f"{name}-{i}" for i in range(n)],
            "target": 3, "found": 0}


def test_breadth_first_first_pass_covers_every_analyst():
    # 9 analysts, some with more videos than others.
    plans = [_plan(n, k) for n, k in [
        ("crown", 4), ("felix", 2), ("jerry", 3), ("finedu", 2), ("ticker", 2),
        ("stealth", 1), ("jeremy", 2), ("fx", 3), ("figuring", 2)]]
    order = list(F._round_robin(plans))
    # The first 9 yields (round 0) must be exactly one per analyst, in list order —
    # so with the block tripping ~a dozen fetches in, all 9 still get a first attempt.
    first_pass = [p["a"]["name"] for p, _ in order[:9]]
    assert first_pass == ["crown", "felix", "jerry", "finedu", "ticker",
                          "stealth", "jeremy", "fx", "figuring"]
    # The tail analysts appear in round 0, not buried after the leaders' seconds.
    assert ("fx" in first_pass) and ("figuring" in first_pass)


def test_round_index_advances_per_analyst():
    plans = [_plan("a", 3), _plan("b", 1)]
    order = [(p["a"]["name"], v) for p, v in F._round_robin(plans)]
    # a has 3 candidates, b has 1: round0 a0,b0 · round1 a1 · round2 a2
    assert order == [("a", "a-0"), ("b", "b-0"), ("a", "a-1"), ("a", "a-2")]


def test_no_candidates_yields_nothing():
    assert list(F._round_robin([])) == []
    assert list(F._round_robin([{"a": {"name": "x"}, "cands": [], "target": 3, "found": 0}])) == []
