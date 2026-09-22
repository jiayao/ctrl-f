# jev-digest CLI (PyMuPDF Digest)

The `jev-digest` command applies the Digest workflow to one text-based PDF. It uses PyMuPDF for layout-aware extraction and annotations, and TypeSafe Jev for relevance and semantic-role judgments. Each successful run writes an annotated PDF copy, a JSON manifest, and a concise reading path on stdout.

## Install

Requires Python 3.10+:

```sh
pip install .
jev-digest --help
```

PyMuPDF licensing requirements apply (its use was explicitly requested). Runtime dependencies are compatible PyMuPDF 1.x and `typesafe-sdk` 0.x releases; the CLI uses the SDK's `AsyncTypeSafeClient` with three retries and a 45-second request timeout, as documented in the [TypeSafe Python SDK](https://docs.typesafe.ai/sdk/python.md).

## Usage

```sh
export TYPESAFE_API_KEY=...
jev-digest INPUT.pdf --question "What does the report conclude?"
jev-digest INPUT.pdf --question TEXT --pdf-output OUT.pdf --json-output OUT.json \
  --threshold 0.45 --model jev-latest --batch-size 12 --concurrency 4 --force
```

- Default outputs are `<stem>.digest.pdf` and `<stem>.digest.json` beside the input.
- Defaults: threshold `0.45`, model `jev-latest`, batch size `12`, concurrency `4`.
- Credentials come only from `TYPESAFE_API_KEY`; there is no command-line key option (it could leak through shell history).
- Existing outputs are never overwritten unless `--force` is supplied.
- Exit code `2` means invalid arguments/configuration; exit code `1` means PDF, extraction, or API failures.
- Each stdout line is `number · role · probability · page · excerpt`, followed by a `Signal: N% of judged text (s/t words)` line: the share of judged passage words needed for the question (at or above the threshold, non-irrelevant role). Progress and diagnostics go to stderr. When nothing qualifies, the CLI reports that no clear reading path was found and writes no output files.

## Manifest

The versioned JSON manifest (version 2) records the source path/hash/page count, question, effective configuration, model and token usage, one entry per selected passage with order, one-based page, role, display label, probabilities, composite score, text, optional heading, catch status, and PDF-coordinate quads, plus a `signal` block with the judged/signal word counts and their ratio for the whole document.

## Tests

```sh
pip install ".[test]"
pytest -m "not live"
```

Live TypeSafe tests are optional and explicitly marked (`live`), so the normal suite is deterministic and incurs no API usage:

```sh
pytest -m live
```

Representative annotated PDFs were rendered with Poppler (`pdftoppm`) and visually inspected for clipped labels, obscured source text, incorrect highlight geometry, and unreadable colors.

## Layout

```
jev-digest/
  pyproject.toml
  README.md
  src/jev_digest/   # package source
  tests/            # pytest suite (run from this directory)
```

The scoring and selection rules are ported from the browser extension (`../extension/content.js`); code comments there point at the matching functions.
