"""Shared pytest helpers: PDF builders and a fake TypeSafe client."""

from __future__ import annotations

import fitz


def _wrap(text: str, width: int = 88) -> list:
    words = str(text).split()
    lines: list = []
    current: list = []
    length = 0
    for word in words:
        extra = len(word) + (1 if current else 0)
        if current and length + extra > width:
            lines.append(" ".join(current))
            current = [word]
            length = len(word)
        else:
            current.append(word)
            length += extra
    if current:
        lines.append(" ".join(current))
    return lines or [""]


def make_pdf(path, pages) -> None:
    """Create a PDF at path; pages is a list of block-lists or line-lists."""
    doc = fitz.open()
    for page_spec in pages:
        page = doc.new_page()
        if page_spec and isinstance(page_spec[0], dict):
            y = 72.0
            for block in page_spec:
                fontsize = float(block.get("fontsize", 12))
                bold = block.get("bold", False)
                font = "hebo" if bold else "helv"
                box = block.get("box")
                raw_text = str(block.get("text", ""))
                if box is not None:
                    rect = fitz.Rect(*box)
                    page.insert_textbox(rect, raw_text, fontsize=fontsize, fontname=font)
                    y = rect.y1 + fontsize
                    continue
                for paragraph in raw_text.splitlines() or [""]:
                    for line in _wrap(paragraph):
                        page.insert_text((72, y), line, fontsize=fontsize, fontname=font)
                        y += fontsize * 1.5
                y += fontsize * 0.8
        else:
            y = 72.0
            for line in page_spec:
                for wrapped in _wrap(line):
                    page.insert_text((72, y), str(wrapped), fontsize=12)
                    y += 18.0
    doc.save(path)
    doc.close()



LONG_TEXT = ("Lorem ipsum dolor sit amet. " * 60).strip()


SAMPLE_QUESTION = "What does the document say about refunds?"


class FakeUsage:
    def __init__(self, in_tokens=10, out_tokens=5):
        self.input_tokens = in_tokens
        self.output_tokens = out_tokens


class FakeResponse:
    def __init__(self, answers, model="jev-latest"):
        self.answers = answers
        self.model = model
        self.usage = FakeUsage()


class FakeAnswer:
    def __init__(self, payload):
        self._payload = dict(payload)

    def model_dump(self):
        return dict(self._payload)


class FakeClient:
    """Minimal async stand-in for AsyncTypeSafeClient."""

    def __init__(self, handler, model="jev-latest"):
        self._handler = handler
        self._model = model
        self.calls = []
        self.active = 0
        self.max_active = 0
        self.closed = False

    async def system_one(self, state, questions, **kwargs):
        import asyncio
        import inspect

        self.calls.append({"state": state, "questions": questions, "kwargs": kwargs})
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0)
            result = self._handler(state, questions, kwargs)
            if inspect.isawaitable(result):
                result = await result
            return result
        finally:
            self.active -= 1

    async def aclose(self):
        self.closed = True


def answer_for(probability, role="background", role_prob=0.7):
    probs = {"direct_answer": 0.0, "background": 0.0, "reasoning": 0.0,
             "evidence": 0.0, "qualification": 0.0, "counterpoint": 0.0,
             "irrelevant": 0.0}
    probs[role] = role_prob
    if role != "irrelevant":
        probs["irrelevant"] = round(max(0.0, 1.0 - role_prob), 4)
    else:
        probs["irrelevant"] = 1.0
    return ({"type": "noul", "noul": probability},
            {"type": "choice", "choice": role, "confidence": role_prob,
             "probabilities": probs})


def digest_handler(plan):
    """Build a handler from {(window, pos): (p, role, role_p)} or {pos: ...}."""

    def handle(state, questions, kwargs):
        import re

        answers = {}
        lines = str(state.get("passages", "")).splitlines()
        for line in lines:
            match = re.match(r"(P\d+)\|", line)
            if not match:
                continue
            pid = match.group(1)
            pos = int(pid[1:]) - 1
            key = (len(lines), pos) if (len(lines), pos) in plan else pos
            prob, role, role_p = plan.get(key, (0.05, "irrelevant", 0.0))
            needed, choice = answer_for(prob, role, role_p)
            answers[f"{pid}_needed"] = FakeAnswer(needed)
            answers[f"{pid}_role"] = FakeAnswer(choice)
        return FakeResponse(answers)

    return handle


def failing_handler(exc):
    def handle(state, questions, kwargs):
        raise exc

    return handle


