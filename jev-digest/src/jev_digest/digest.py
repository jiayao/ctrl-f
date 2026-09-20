"""Digest scoring and selection ported from content.js."""

from __future__ import annotations

from dataclasses import dataclass

from jev_digest.constants import (
    CATCH_ROLES,
    MAX_DIGEST_ITEMS,
    MIN_DIGEST_ITEMS,
    ROLE_LABELS,
    ROLE_ORDER,
)


@dataclass
class Selected:
    candidate: object
    order: int = 0
    score: float = 0.0
    is_catch: bool = False

    @property
    def label(self) -> str:
        if self.is_catch:
            return "The catch"
        return ROLE_LABELS.get(self.candidate.role or "", "Read")


def chunk_id(index: int) -> str:
    return f"P{index + 1:02d}"


def digest_score(probability: float, role: str | None, role_probability: float) -> float:
    if role == "direct_answer":
        weight = 1.0
    elif role in ("qualification", "counterpoint"):
        weight = 0.96
    else:
        weight = 0.9
    return (probability or 0.0) * weight * (0.8 + 0.2 * (role_probability or 0.0))


def select_digest(candidates: list, threshold: float) -> list:
    """Mirror content.js collectDigest: diversity pass then score pass."""
    scored = []
    for item in candidates:
        if item.probability is None:
            continue
        if item.probability < threshold:
            continue
        if (item.role or "irrelevant") == "irrelevant":
            continue
        score = digest_score(item.probability, item.role, item.role_probability)
        scored.append({"item": item, "score": score})
    scored.sort(key=lambda e: (-e["score"], e["item"].index))
    selected: list = []
    picked: set = set()

    def add(entry):
        if entry is None:
            return
        if entry["item"].index in picked:
            return
        if len(selected) >= MAX_DIGEST_ITEMS:
            return
        picked.add(entry["item"].index)
        selected.append(entry)

    for role in ROLE_ORDER:
        found = next((e for e in scored if (e["item"].role or "") == role), None)
        add(found)
    floor = max(0.62, threshold)
    for entry in scored:
        if len(selected) >= MIN_DIGEST_ITEMS and entry["item"].probability < floor:
            break
        add(entry)
    selected.sort(key=lambda e: e["item"].index)
    out: list = []
    for order, entry in enumerate(selected, start=1):
        out.append(Selected(candidate=entry["item"], order=order, score=entry["score"]))
    mark_catch(out)
    return out


def mark_catch(selected: list) -> None:
    contenders = [s for s in selected if (s.candidate.role or "") in CATCH_ROLES]
    if not contenders:
        return
    contenders.sort(key=lambda s: (-s.score, s.candidate.index))
    contenders[0].is_catch = True

