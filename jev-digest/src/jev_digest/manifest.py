"""Versioned JSON manifest for a Digest run."""

from __future__ import annotations

from jev_digest.constants import MANIFEST_VERSION


def _quad_to_list(quad) -> list:
    try:
        return [float(quad.ul.x), float(quad.ul.y), float(quad.ur.x),
                float(quad.ur.y), float(quad.ll.x), float(quad.ll.y),
                float(quad.lr.x), float(quad.lr.y)]
    except AttributeError:
        return [float(v) for v in list(quad)[:8]]


def build_manifest(*, source: dict, question: str, config: dict,
                   model: str, usage: dict, selected: list,
                   signal: dict | None = None) -> dict:
    passages = []
    for item in selected:
        candidate = item.candidate
        quads = []
        for page_no0, quad in candidate.quads:
            try:
                rect = quad.rect
                bbox = [float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)]
            except AttributeError:
                bbox = []
            quads.append({"page": page_no0 + 1, "quad": _quad_to_list(quad), "rect": bbox})
        prob = candidate.probability if candidate.probability is not None else 0.0
        passages.append({
            "order": item.order,
            "page": candidate.page,
            "role": candidate.role,
            "label": item.label,
            "probability": float(prob),
            "role_probability": float(candidate.role_probability or 0.0),
            "confidence": float(candidate.confidence or 0.0),
            "score": float(item.score),
            "text": candidate.text,
            "heading": candidate.heading or None,
            "is_catch": bool(item.is_catch),
            "quads": quads,
        })
    return {
        "manifest_version": MANIFEST_VERSION,
        "source": dict(source),
        "question": question,
        "config": dict(config),
        "model": model,
        "usage": {"input_tokens": int(usage.get("input_tokens", 0) or 0),
                  "output_tokens": int(usage.get("output_tokens", 0) or 0)},
        "passages": passages,
        "signal": dict(signal) if signal is not None else None,
    }
