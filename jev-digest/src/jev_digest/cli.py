"""Command-line interface for jev-digest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from jev_digest.constants import DEFAULT_MODEL
from jev_digest.errors import EXIT_FAILURE, EXIT_USAGE, RunError, UsageError
from jev_digest.pipeline import run_digest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jev-digest",
        description="Build a Jev-guided reading path through a text-based PDF.",
    )
    parser.add_argument("input", help="Input PDF file")
    parser.add_argument("--question", required=True, help="Question the reading path must answer")
    parser.add_argument("--pdf-output", default=None, help="Annotated PDF output path")
    parser.add_argument("--json-output", default=None, help="JSON manifest output path")
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--batch-size", type=int, default=12)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    return parser


def parse_args(argv=None):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code == 0:
            raise
        raise UsageError("invalid arguments") from exc
    return args



def validate_args(args) -> None:
    input_path = Path(args.input)
    if not input_path.is_file():
        raise UsageError(f"input not found: {args.input}")
    if input_path.suffix.lower() != ".pdf":
        raise UsageError("input must be a .pdf file")
    if not args.question or not args.question.strip():
        raise UsageError("--question must be non-empty")
    args.question = args.question.strip()
    if not (0.20 <= args.threshold <= 0.90):
        raise UsageError("--threshold must be within 0.20..0.90")
    if not args.model or not args.model.strip():
        raise UsageError("--model must be non-empty")
    args.model = args.model.strip()
    if not (4 <= args.batch_size <= 16):
        raise UsageError("--batch-size must be within 4..16")
    if not (1 <= args.concurrency <= 8):
        raise UsageError("--concurrency must be within 1..8")
    base = str(input_path.with_suffix(""))
    if args.pdf_output is None:
        args.pdf_output = base + ".digest.pdf"
    if args.json_output is None:
        args.json_output = base + ".digest.json"
    pdf_out = Path(args.pdf_output)
    json_out = Path(args.json_output)
    try:
        same = pdf_out.resolve() == input_path.resolve()
    except OSError:
        same = False
    if same:
        raise UsageError("--pdf-output must not overwrite the input PDF")
    try:
        same_json = json_out.resolve() == input_path.resolve()
    except OSError:
        same_json = False
    if same_json:
        raise UsageError("--json-output must not overwrite the input PDF")
    if pdf_out.resolve() == json_out.resolve():
        raise UsageError("--pdf-output and --json-output must differ")
    if not args.force:
        for path in (pdf_out, json_out):
            if path.exists():
                raise UsageError(f"output exists (use --force): {path}")


def main(argv=None) -> int:
    try:
        args = parse_args(argv)
        validate_args(args)
    except UsageError as exc:
        print(f"jev-digest: error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    try:
        return run_digest(args)
    except RunError as exc:
        print(f"jev-digest: error: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        print("jev-digest: error: interrupted", file=sys.stderr)
        return EXIT_FAILURE
    except Exception as exc:  # noqa: BLE001 - last-resort guard
        print(f"jev-digest: error: {exc}", file=sys.stderr)
        return EXIT_FAILURE


if __name__ == "__main__":
    raise SystemExit(main())
