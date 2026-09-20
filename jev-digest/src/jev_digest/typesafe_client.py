"""TypeSafe Jev judging for Digest passages."""

from __future__ import annotations

import asyncio

from jev_digest.constants import MAX_RETRIES, REQUEST_TIMEOUT_S, ROLE_LABELS
from jev_digest.digest import chunk_id
from jev_digest.errors import RunError

ROLE_CRITERIA = {
    "direct_answer": "States or directly implies the answer.",
    "background": "Defines or establishes context required to understand the answer.",
    "reasoning": "Explains why or how the answer works.",
    "evidence": "Provides support, data, a concrete example, or an illustrative case.",
    "qualification": "Adds an important condition, exception, limitation, or caveat.",
    "counterpoint": "Presents a conflicting view, tension, or alternative conclusion.",
    "irrelevant": "Does not materially help the reader understand or answer the question.",
}


def build_questions(window_items: list) -> dict:
    questions: dict = {}
    for pos in range(len(window_items)):
        pid = chunk_id(pos)
        questions[f"{pid}_needed"] = {
            "type": "noul",
            "instructions": {
                "question": (
                    f"Does passage {pid} contain information a reader needs "
                    "to understand or accurately answer `question`?"
                ),
                "focus": (
                    f"Judge {pid} itself. Include direct answers, necessary "
                    "background, reasoning, evidence, important qualifications, "
                    "and genuine counterpoints. Mere topic overlap is not enough."
                ),
            },
            "criteria": {
                "true": (
                    f"Omitting {pid} could leave the reader with an incomplete, "
                    "misleading, or poorly supported understanding."
                ),
                "false": (
                    f"{pid} is irrelevant, redundant, or unnecessary "
                    "for understanding the answer."
                ),
            },
        }
        questions[f"{pid}_role"] = {
            "type": "choice",
            "instructions": (
                f"What is passage {pid}'s most useful role in helping a reader "
                "understand or answer `question`? Judge "
                f"{pid} itself."
            ),
            "criteria": dict(ROLE_CRITERIA),
        }
    return questions


def build_state(question: str, window_items: list) -> dict:
    lines = []
    for pos, item in enumerate(window_items):
        pid = chunk_id(pos)
        head = f" [under heading: {item.heading}]" if item.heading else ""
        lines.append(f"{pid}|{head} {item.text}")
    return {"question": question, "passages": "\n".join(lines)}


def make_windows(items: list, size: int) -> list:
    return [items[i:i + size] for i in range(0, len(items), size)]


def apply_answers(window_items: list, answers: dict) -> None:
    for pos, item in enumerate(window_items):
        pid = chunk_id(pos)
        needed = answers.get(f"{pid}_needed")
        role = answers.get(f"{pid}_role")
        item.probability = _as_float((needed or {}).get("noul"), default=0.0)
        choice = (role or {}).get("choice")
        item.role = choice if choice in ROLE_LABELS else "irrelevant"
        probs = (role or {}).get("probabilities") or {}
        try:
            item.role_probability = float(probs.get(item.role, 0.0) or 0.0)
        except (TypeError, ValueError):
            item.role_probability = 0.0
        item.confidence = _as_float((role or {}).get("confidence"), default=0.0)


def _as_float(value, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result


def create_client(api_key: str, model: str):
    from typesafe_sdk import AsyncTypeSafeClient, RetryPolicy

    return AsyncTypeSafeClient(
        api_key=api_key,
        model=model,
        retry=RetryPolicy(max_retries=MAX_RETRIES),
        timeout=REQUEST_TIMEOUT_S,
    )


async def judge_candidates(candidates: list, question: str, model: str,
                           batch_size: int, concurrency: int,
                           progress=None, client=None) -> dict:
    """Judge every window; any failure cancels the run atomically."""
    windows = make_windows(candidates, batch_size)
    total_in = 0
    total_out = 0
    used_model = model
    close_client = False
    if client is None:
        client = create_client("", model)
        close_client = True
    sem = asyncio.Semaphore(max(1, concurrency))
    failed: list = [None]

    async def run_one(window: list) -> None:
        async with sem:
            if failed[0] is not None:
                return
            state = build_state(question, window)
            questions = build_questions(window)
            try:
                response = await client.system_one(
                    state,
                    questions,
                    model=model,
                    retry=None,
                    timeout=REQUEST_TIMEOUT_S,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - mapped below
                failed[0] = exc
                raise
            answers: dict = {}
            for name, answer in (response.answers or {}).items():
                data = answer.model_dump() if hasattr(answer, "model_dump") else dict(answer)
                answers[name] = data
            missing = [k for k in questions if k not in answers]
            if missing:
                failed[0] = RunError(f"TypeSafe response missing answers: {missing[0]}")
                raise failed[0]
            apply_answers(window, answers)
            usage = response.usage
            nonlocal_total = getattr(usage, "input_tokens", 0) or 0
            nonlocal_out = getattr(usage, "output_tokens", 0) or 0
            return nonlocal_total, nonlocal_out, getattr(response, "model", model)

    async def runner():
        tasks = [asyncio.ensure_future(run_one(w)) for w in windows]
        try:
            results = await asyncio.gather(*tasks)
        except BaseException as exc:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if failed[0] is not None:
                raise failed[0] from None
            raise
        return results

    try:
        if progress is not None:
            progress(f"Judging {len(candidates)} passages in {len(windows)} passes")
        results = await runner()
        for entry in results:
            if entry:
                total_in += entry[0]
                total_out += entry[1]
                used_model = entry[2] or used_model
    finally:
        if close_client:
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001 - best effort close
                pass
    return {"input_tokens": total_in, "output_tokens": total_out, "model": used_model}


def typesafe_error_message(exc: Exception) -> str:
    status = getattr(exc, "status", None)
    request_id = getattr(exc, "request_id", None)
    text = str(exc) or exc.__class__.__name__
    if status is not None:
        text = f"{status}: {text}"
    if request_id:
        text = f"{text} (request {request_id})"
    return text


