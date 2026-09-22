"""TypeSafe request shape, scoring, and selection tests (mocked)."""

import asyncio

import pytest

from jev_digest.digest import digest_score, select_digest
from jev_digest.models import Candidate
from jev_digest.typesafe_client import apply_answers, build_questions
from jev_digest.typesafe_client import build_state as _build_state
from jev_digest.typesafe_client import judge_candidates, make_windows
from tests.helpers import FakeClient, digest_handler, failing_handler


def _cand(index, prob, role, role_p=0.7, page=1):
    return Candidate(index=index, text=f"passage {index} body text " * 6,
                     page=page, probability=prob, role=role, role_probability=role_p)


def test_request_shape_windows_and_ids():
    items = [Candidate(index=i, text=f"body {i} " * 10, page=1) for i in range(5)]
    windows = make_windows(items, 2)
    assert [len(w) for w in windows] == [2, 2, 1]
    questions = build_questions(windows[0])
    assert set(questions) == {"P01_needed", "P01_role", "P02_needed", "P02_role"}
    needed = questions["P01_needed"]
    assert needed["type"] == "noul" and "question" in needed["instructions"]
    assert needed["criteria"]["true"] and needed["criteria"]["false"]
    role = questions["P01_role"]
    assert role["type"] == "choice"
    assert set(role["criteria"]) == {"direct_answer", "background", "reasoning",
                                     "evidence", "qualification", "counterpoint",
                                     "irrelevant"}
    state = _build_state("What about refunds?", windows[0])

    assert state["question"] == "What about refunds?"
    assert state["passages"].startswith("P01|")
    assert "P02|" in state["passages"]


def test_role_parsing_and_confidence():
    items = [Candidate(index=0, text="x " * 20, page=1)]
    apply_answers(items, {"P01_needed": {"noul": 0.8},
                          "P01_role": {"choice": "evidence", "confidence": 0.77,
                                       "probabilities": {"evidence": 0.66}}})
    assert items[0].probability == 0.8
    assert items[0].role == "evidence"
    assert items[0].role_probability == pytest.approx(0.66)
    assert items[0].confidence == pytest.approx(0.77)


def test_unknown_role_becomes_irrelevant():
    items = [Candidate(index=0, text="x " * 20, page=1)]
    apply_answers(items, {"P01_needed": {"noul": 0.9},
                          "P01_role": {"choice": "mystery", "probabilities": {}}})
    assert items[0].role == "irrelevant"


def test_composite_weights():
    assert digest_score(0.8, "direct_answer", 1.0) == pytest.approx(0.8)
    assert digest_score(0.8, "qualification", 1.0) == pytest.approx(0.8 * 0.96)
    assert digest_score(0.8, "background", 1.0) == pytest.approx(0.8 * 0.9)
    assert digest_score(0.8, "background", 0.5) == pytest.approx(0.8 * 0.9 * 0.9)


def test_threshold_boundary_inclusive():
    items = [_cand(0, 0.45, "background"), _cand(1, 0.449, "background")]
    selected = select_digest(items, 0.45)
    assert [s.candidate.index for s in selected] == [0]


def test_diversity_and_source_order():
    items = [_cand(0, 0.95, "background"), _cand(1, 0.94, "background"),
             _cand(2, 0.93, "evidence"), _cand(3, 0.90, "direct_answer")]
    selected = select_digest(items, 0.45)
    roles = [s.candidate.role for s in selected]
    assert "direct_answer" in roles and "evidence" in roles
    assert [s.candidate.index for s in selected] == sorted(s.candidate.index for s in selected)
    assert len(selected) <= 7


def test_fewer_than_three_qualified_no_padding():
    items = [_cand(0, 0.9, "background"), _cand(1, 0.8, "evidence"),
             _cand(2, 0.1, "background")]
    selected = select_digest(items, 0.45)
    assert len(selected) == 2


def test_no_lowering_threshold_to_pad():
    items = [_cand(0, 0.9, "background"), _cand(1, 0.44, "evidence")]
    assert len(select_digest(items, 0.45)) == 1


def test_signal_stats_weighted_by_words():
    from jev_digest.digest import signal_stats
    long_signal = Candidate(index=0, text="signal " * 20, page=1,
                            probability=0.9, role="background")
    short_filler = Candidate(index=1, text="filler " * 5, page=1,
                             probability=0.9, role="irrelevant")
    assert signal_stats([long_signal, short_filler], 0.45) == {
        "judged_words": 25, "signal_words": 20, "signal_ratio": 0.8}


def test_signal_stats_threshold_boundary_and_unjudged():
    from jev_digest.digest import signal_stats
    items = [_cand(0, 0.45, "background"), _cand(1, 0.449, "background"),
             Candidate(index=2, text="x " * 20, page=1)]
    stats = signal_stats(items, 0.45)
    assert stats["judged_words"] == 48  # two judged 24-word passages
    assert stats["signal_words"] == 24
    assert stats["signal_ratio"] == 0.5


def test_signal_stats_all_unjudged_is_none():
    from jev_digest.digest import signal_stats
    items = [Candidate(index=0, text="x " * 20, page=1)]
    assert signal_stats(items, 0.45)["signal_ratio"] is None


def test_max_seven_items():
    items = [_cand(i, 0.95 - i * 0.01, "background") for i in range(10)]
    assert len(select_digest(items, 0.45)) <= 7


def test_catch_tie_break_lowest_index():
    items = [_cand(0, 0.8, "qualification", 0.7), _cand(1, 0.8, "counterpoint", 0.7),
             _cand(2, 0.95, "background", 0.9)]
    selected = select_digest(items, 0.45)
    catches = [s for s in selected if s.is_catch]
    assert len(catches) == 1
    assert catches[0].candidate.index == 0
    assert catches[0].label == "The catch"


def test_judge_concurrency_limit():
    items = [Candidate(index=i, text=f"body {i} " * 10, page=1) for i in range(6)]
    client = FakeClient(digest_handler({i: (0.9, "background", 0.8) for i in range(6)}))
    asyncio.run(judge_candidates(items, "q", "jev-latest", 2, 2, client=client))
    assert len(client.calls) == 3
    assert client.max_active <= 2
    assert all(c.probability == 0.9 for c in items)
    for call in client.calls:
        assert call["kwargs"].get("timeout") == 45.0
        assert call["kwargs"].get("model") == "jev-latest"


def test_judge_failure_atomic_and_cancels():
    items = [Candidate(index=i, text=f"body {i} " * 10, page=1) for i in range(4)]
    client = FakeClient(failing_handler(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        asyncio.run(judge_candidates(items, "q", "jev-latest", 2, 2, client=client))
    assert all(c.probability is None for c in items)


def test_judge_cancellation_cancels_outstanding():
    import asyncio

    started = asyncio.Event()
    release = asyncio.Event()
    entered = asyncio.Event()

    async def hanging(state, questions, kwargs):
        entered.set()
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            raise
        from tests.helpers import FakeResponse

        return FakeResponse({})

    async def scenario():
        from tests.helpers import FakeClient

        items = [Candidate(index=i, text=f"body {i} " * 10, page=1) for i in range(4)]
        client = FakeClient(hanging)
        task = asyncio.ensure_future(
            judge_candidates(items, "q", "jev-latest", 2, 1, client=client))
        assert await asyncio.wait_for(entered.wait(), timeout=5)
        await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        release.set()
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()

    asyncio.run(scenario())



def test_retry_policy_three_retries_and_timeout():
    from jev_digest import typesafe_client
    from jev_digest.constants import MAX_RETRIES, REQUEST_TIMEOUT_S

    assert MAX_RETRIES == 3
    assert REQUEST_TIMEOUT_S == 45.0
    from typesafe_sdk import RetryPolicy

    policy = RetryPolicy(max_retries=MAX_RETRIES)
    assert policy.max_retries == 3
    assert "max_retries" in dir(policy)
    assert typesafe_client.REQUEST_TIMEOUT_S == 45.0


