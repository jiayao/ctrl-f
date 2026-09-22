"""Orchestrate one Digest run: extract, judge, select, annotate."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

import fitz

from jev_digest.annotate import annotate_pdf
from jev_digest.digest import select_digest, signal_stats
from jev_digest.errors import RunError
from jev_digest.extract import extract_candidates
from jev_digest.manifest import build_manifest
from jev_digest.typesafe_client import judge_candidates, typesafe_error_message


def _diag(message: str) -> None:
    print(f"jev-digest: {message}", file=sys.stderr)


def _source_info(path: Path, doc) -> dict:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return {"path": str(path), "sha256": digest.hexdigest(), "pages": int(doc.page_count)}


def _excerpt(text: str, limit: int = 120) -> str:
    flat = " ".join(text.split())
    if len(flat) > limit:
        return flat[:limit].rstrip() + "..."
    return flat


def _write_atomic(path: Path, writer) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    os.close(fd)
    try:
        writer(Path(tmp_name))
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def run_digest(args, client=None) -> int:
    """Execute the full workflow; return 0 or 1 and print the reading path."""
    input_path = Path(args.input)
    try:
        doc = fitz.open(input_path)
    except Exception as exc:  # noqa: BLE001 - mapped to RunError
        raise RunError(f"cannot open PDF: {exc}") from exc
    with doc:
        if getattr(doc, "needs_pass", False) or getattr(doc, "is_encrypted", False):
            raise RunError("encrypted PDF: password-protected PDFs are not supported")
        try:
            page_count = doc.page_count
        except Exception as exc:  # noqa: BLE001
            raise RunError(f"cannot read PDF: {exc}") from exc
        if page_count < 1:
            raise RunError("PDF has no pages")
        try:
            candidates = extract_candidates(doc)
        except Exception as exc:  # noqa: BLE001
            raise RunError(f"text extraction failed: {exc}") from exc
        if not candidates:
            raise RunError("no extractable text found; this PDF may lack a text layer")
        _diag(f"extracted {len(candidates)} passages from {page_count} pages")
        if client is None and not os.environ.get("TYPESAFE_API_KEY", "").strip():
            raise RunError("missing TYPESAFE_API_KEY")

        from jev_digest.typesafe_client import create_client

        owned = False
        if client is None:
            client = create_client(os.environ["TYPESAFE_API_KEY"].strip(), args.model)
            owned = True
        try:
            try:
                usage = asyncio.run(
                    judge_candidates(
                        candidates, args.question, args.model,
                        args.batch_size, args.concurrency,
                        progress=_diag, client=client,
                    )
                )
            except RunError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise RunError(f"TypeSafe request failed: {typesafe_error_message(exc)}") from exc
        finally:
            if owned:
                try:
                    asyncio.run(client.aclose())
                except Exception:  # noqa: BLE001 - best effort
                    pass
        signal = signal_stats(candidates, args.threshold)
        selected = select_digest(candidates, args.threshold)
        if not selected:
            print("No clear reading path found for this question.")
            return 0
        manifest = build_manifest(
            source=_source_info(input_path, doc),
            question=args.question,
            config={"threshold": args.threshold, "model": args.model,
                    "batch_size": args.batch_size, "concurrency": args.concurrency},
            model=usage.get("model", args.model),
            usage=usage,
            selected=selected,
            signal=signal,
        )

        def write_pdf(tmp: Path) -> None:
            with fitz.open(input_path) as out:
                annotate_pdf(out, selected)
                out.set_metadata({**out.metadata,
                                  "subject": f"jev-digest: {args.question[:120]}",
                                  "keywords": "jev-digest"})
                out.save(tmp, garbage=3, deflate=True)

        def write_json(tmp: Path) -> None:
            tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        try:
            _write_atomic(Path(args.pdf_output), write_pdf)
            _write_atomic(Path(args.json_output), write_json)
        except Exception as exc:  # noqa: BLE001
            for path in (Path(args.pdf_output), Path(args.json_output)):
                try:
                    if path.exists():
                        pass
                except OSError:
                    pass
            raise RunError(f"cannot write outputs: {exc}") from exc
        for item in selected:
            cand = item.candidate
            prob = cand.probability if cand.probability is not None else 0.0
        if signal["signal_ratio"] is not None:
            print(f"Signal: {signal['signal_ratio']:.0%} of judged text "
                  f"({signal['signal_words']}/{signal['judged_words']} words)")
        for item in selected:
            cand = item.candidate
            prob = cand.probability if cand.probability is not None else 0.0
            print(f"{item.order} · {item.label} · {prob:.2f} · {cand.page} · {_excerpt(cand.text)}")
        _diag(f"wrote {args.pdf_output} and {args.json_output}")
        return 0


