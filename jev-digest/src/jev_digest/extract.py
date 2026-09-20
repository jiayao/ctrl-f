"""Layout-aware PDF text extraction on PyMuPDF rawdict data."""

from __future__ import annotations

import fitz

from jev_digest.constants import MAX_CHUNK_LEN, MIN_CHUNK_LEN
from jev_digest.models import Candidate, clean_text, header_footer_texts
from jev_digest.models import split_long_text as _split_long_text

_BOLD_TOKENS = ("bold", "black", "heavy", "demi", "semibold")


def _is_bold(font: str, flags: int) -> bool:
    if flags & 16:
        return True
    lowered = (font or "").lower()
    return any(t in lowered for t in _BOLD_TOKENS)


def _line_text(line: dict) -> str:
    parts = []
    for span in line.get("spans", []):
        chars = span.get("chars")
        if chars:
            parts.append("".join(c.get("c", "") for c in chars))
        else:
            parts.append(span.get("text", ""))
    return clean_text("".join(parts))


def _rect_to_quad(rect, line: dict):
    direction = line.get("dir")
    if direction:
        try:
            ox, oy = float(direction[0][0]), float(direction[0][1])
            if abs(ox) + abs(oy) > 1e-9:
                length = (ox * ox + oy * oy) ** 0.5
                ux, uy = ox / length, oy / length
                nx, ny = -uy, ux
                w = abs(rect.width * ux) + abs(rect.height * uy)
                h = abs(rect.width * nx) + abs(rect.height * ny)
                w = max(w, 1.0)
                h = max(h, 1.0)
                x0, y0 = rect.x0, rect.y0
                return fitz.Quad(
                    fitz.Point(x0, y0),
                    fitz.Point(x0 + ux * w, y0 + uy * w),
                    fitz.Point(x0 + nx * h, y0 + ny * h),
                    fitz.Point(x0 + ux * w + nx * h, y0 + uy * w + ny * h),
                )
        except (IndexError, TypeError, ArithmeticError):
            pass
    return fitz.Quad(rect.top_left, rect.top_right, rect.bottom_left, rect.bottom_right)


def _line_quad(line: dict):
    points: list = []
    for span in line.get("spans", []):
        for char in span.get("chars", []) or []:
            bbox = char.get("bbox")
            if bbox:
                points.append((bbox[0], bbox[1]))
                points.append((bbox[2], bbox[3]))
        bbox = span.get("bbox")
        if bbox and not span.get("chars"):
            points.append((bbox[0], bbox[1]))
            points.append((bbox[2], bbox[3]))
    if len(points) < 2:
        bbox = line.get("bbox")
        if not bbox:
            return None
        rect = fitz.Rect(bbox)
        return fitz.Quad(rect.top_left, rect.top_right, rect.bottom_left, rect.bottom_right)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    rect = fitz.Rect(min(xs), min(ys), max(xs), max(ys))
    if rect.is_empty or rect.is_infinite:
        return None
    return _rect_to_quad(rect, line)


def _line_style(line: dict) -> tuple:
    sizes = []
    bold = False
    for span in line.get("spans", []):
        try:
            sizes.append(float(span.get("size", 0) or 0))
        except (TypeError, ValueError):
            continue
        try:
            flags = int(span.get("flags", 0) or 0)
        except (TypeError, ValueError):
            flags = 0
        if _is_bold(span.get("font", ""), flags):
            bold = True
    return (max(sizes) if sizes else 0.0), bold


def iter_page_blocks(page, page_number: int) -> list:
    raw = page.get_text("rawdict")
    page_rect = page.rect
    blocks: list = []
    for number, block in enumerate(raw.get("blocks", [])):
        if block.get("type", 0) != 0:
            continue
        lines = []
        for line in block.get("lines", []):
            text = _line_text(line)
            if not text:
                continue
            size, bold = _line_style(line)
            lines.append({"text": text, "quad": _line_quad(line),
                          "size": size, "bold": bold})
        if not lines:
            continue
        text = clean_text(" ".join(line["text"] for line in lines))
        if not text:
            continue
        try:
            rect = fitz.Rect(block.get("bbox", (0, 0, 0, 0)))
        except ValueError:
            continue
        center = (rect.x0 + rect.x1) / 2.0
        band_h = page_rect.height * 0.08 if page_rect.height else 0
        if rect.y0 <= page_rect.y0 + band_h:
            band = "top"
        elif rect.y1 >= page_rect.y1 - band_h:
            band = "bottom"
        else:
            band = ""
        blocks.append({"page": page_number, "number": number, "x0": rect.x0,
                       "y0": rect.y0, "center_x": center, "text": text,
                       "lines": lines, "band": band})
    blocks.sort(key=lambda b: (b["page"], round(b["y0"] / 4.0), b["center_x"], b["x0"]))
    return blocks


def _heading_for(block: dict, previous) -> str:
    if previous is None or previous["page"] != block["page"]:
        return ""
    prev_text = previous["text"]
    if not prev_text or len(prev_text) > 200 or len(prev_text.split()) > 12:
        return ""
    prev_lines = previous.get("lines", [])
    cur_lines = block.get("lines", [])
    if not prev_lines or not cur_lines:
        return ""
    prev_size = max(line["size"] for line in prev_lines)
    cur_size = max(line["size"] for line in cur_lines) or 1.0
    prev_bold = any(line["bold"] for line in prev_lines)
    cur_bold = any(line["bold"] for line in cur_lines)
    larger = prev_size >= cur_size * 1.08 and prev_size > 0
    if larger or (prev_bold and not cur_bold):
        return prev_text
    return ""


def _make_candidate(block: dict, text: str, heading: str):
    quads = []
    for line in block.get("lines", []):
        if line.get("quad") is not None:
            quads.append((block["page"] - 1, line["quad"]))
    text = clean_text(text)
    if len(text) > MAX_CHUNK_LEN:
        for piece in _split_long_text(text):
            if len(piece) >= MIN_CHUNK_LEN:
                text = piece
                break
    return Candidate(text=text, page=block["page"], heading=heading, quads=quads)


def extract_candidates(doc) -> list:
    blocks: list = []
    for page_number in range(1, doc.page_count + 1):
        blocks.extend(iter_page_blocks(doc.load_page(page_number - 1), page_number))
    repeated = header_footer_texts(blocks)
    candidates: list = []
    previous = None
    for block in blocks:
        is_repeat = block["text"] in repeated and block["band"] in ("top", "bottom")
        heading = _heading_for(block, previous)
        if is_repeat:
            previous = block
            continue
        if len(block["text"]) < MIN_CHUNK_LEN:
            previous = block
            continue
        pieces = _split_long_text(block["text"])
        if len(pieces) <= 1:
            candidates.append(_make_candidate(block, block["text"], heading))
        else:
            first = True
            for piece in pieces:
                if len(piece) >= MIN_CHUNK_LEN:
                    item = _make_candidate(block, piece, heading if first else "")
                    candidates.append(item)
                    first = False
        previous = block
    for index, candidate in enumerate(candidates):
        candidate.index = index
    return candidates



