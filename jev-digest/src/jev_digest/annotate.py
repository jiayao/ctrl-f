"""Role-colored highlight annotations on a copied PDF."""

from __future__ import annotations

import fitz

from jev_digest.constants import CATCH_FILL, ROLE_COLORS

_LABEL_FONT_SIZE = 8.0
_LABEL_PADDING = 2.0


def _colors(role: str, is_catch: bool):
    fill, text = ROLE_COLORS.get(role, ((1.0, 1.0, 0.6), (0.3, 0.3, 0.0)))
    if is_catch:
        fill = CATCH_FILL
    return fill, text


def _metadata(selected) -> str:
    item = selected.candidate
    role = item.role or "irrelevant"
    parts = [f"jev-digest role={role}", f"order={selected.order}",
             f"p={item.probability:.3f}" if item.probability is not None else "p=?"]
    parts.append(f"role_p={item.role_probability:.3f}")
    if selected.is_catch:
        parts.append("catch=yes")
    return "; ".join(parts)


def annotate_pdf(doc, selected: list) -> int:
    """Add highlight plus label annotations; return highlight count."""
    count = 0
    by_page: dict = {}
    for item in selected:
        for page_no0, quad in item.candidate.quads:
            by_page.setdefault(page_no0, []).append((item, quad))
    for page_no0, entries in by_page.items():
        page = doc.load_page(page_no0)
        groups: dict = {}
        for item, quad in entries:
            groups.setdefault(item.order, (item, []))[1].append(quad)
        for order in sorted(groups):
            item, quads = groups[order]
            quads = [q for q in quads if q is not None]
            if not quads:
                continue
            fill, _text = _colors(item.candidate.role or "", item.is_catch)
            annot = page.add_highlight_annot(quads)
            annot.set_colors(stroke=fill)
            try:
                annot.set_opacity(0.45)
            except Exception:  # noqa: BLE001 - opacity optional
                pass
            annot.set_info(title=f"{order} {item.label}", content=_metadata(item))
            annot.update()
            count += 1
            _add_label(page, item, quads, order)
    return count


def _add_label(page, selected, quads, order: int) -> None:
    fill, text = _colors(selected.candidate.role or "", selected.is_catch)
    label = f"{order} {selected.label}"
    rect = quads[0].rect
    width = max(28.0, 6.0 * len(label) + 8.0)
    height = _LABEL_FONT_SIZE + 2 * _LABEL_PADDING + 2.0
    page_rect = page.rect
    x0 = min(max(rect.x0, page_rect.x0 + 2), max(page_rect.x0 + 2, page_rect.x1 - width - 2))
    above = rect.y0 - height - 2.0
    below = rect.y1 + 2.0
    if above >= page_rect.y0 + 2:
        y0 = above
    elif below + height <= page_rect.y1 - 2:
        y0 = below
    else:
        y0 = max(page_rect.y0 + 2, min(rect.y0, page_rect.y1 - height - 2))
    target = fitz.Rect(x0, y0, x0 + width, y0 + height)
    annot = page.add_freetext_annot(target, label, fontsize=_LABEL_FONT_SIZE,
                                    text_color=text, fill_color=fill)

    try:
        annot.set_opacity(0.95)
    except Exception:  # noqa: BLE001 - opacity optional
        pass
    try:
        annot.update()
    except Exception:  # noqa: BLE001 - keep highlight even if label fails
        pass
