"""PDF text candidates with source coordinates for Digest selection."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from jev_digest.constants import MAX_CHUNK_LEN, MIN_CHUNK_LEN

_WS_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    """Collapse whitespace the same way the browser extension does."""
    return _WS_RE.sub(" ", text).strip()


@dataclass
class Candidate:
    """One paragraph-like passage plus its PDF geometry."""

    index: int = 0
    text: str = ""
    page: int = 1  # one-based page number
    heading: str = ""
    quads: list = field(default_factory=list)  # list of (page_no0, quad) pairs
    probability: float | None = None
    role: str | None = None
    role_probability: float = 0.0
    confidence: float = 0.0


def header_footer_texts(blocks: list[dict]) -> set[str]:
    """Find repeated header/footer strings in the top/bottom page bands."""
    counts: dict[str, int] = {}
    page_ids: dict[str, set[int]] = {}
    for block in blocks:
        txt = block.get("text", "")
        if not txt or len(txt) > 120:
            continue
        counts[txt] = counts.get(txt, 0) + 1
        page_ids.setdefault(txt, set()).add(block["page"])
    return {
        txt
        for txt, count in counts.items()
        if count >= 3 and len(page_ids.get(txt, set())) >= 3
    }


def split_long_text(text: str, limit: int = MAX_CHUNK_LEN) -> list[str]:
    """Split over-long blocks at line, then word, boundaries."""
    pieces: list[str] = []
    for paragraph in text.splitlines() or [""]:
        paragraph = clean_text(paragraph)
        if not paragraph:
            continue
        while len(paragraph) > limit:
            cut = paragraph.rfind(" ", 0, limit)
            if cut <= limit // 2:
                cut = limit
            pieces.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        if paragraph:
            pieces.append(paragraph)
    if len(text) <= limit:
        single = clean_text(text)
        return [single] if single else []
    merged = [p for p in pieces if p]
    return merged if merged else [clean_text(text)[:limit]]
