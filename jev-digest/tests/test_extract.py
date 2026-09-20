"""Extraction and coordinate unit tests."""

import fitz

from jev_digest.extract import extract_candidates, iter_page_blocks
from tests.helpers import LONG_TEXT, make_pdf


def _open(pdf_path):
    return fitz.open(pdf_path)


def test_multi_page_reading_order(tmp_path):
    pdf = tmp_path / "order.pdf"
    make_pdf(pdf, [[{"text": "First page body " * 8}], [{"text": "Second page body " * 8}]])
    with _open(pdf) as doc:
        found = extract_candidates(doc)
    assert [c.page for c in found] == [1, 2]
    assert found[0].index == 0 and found[1].index == 1


def test_two_column_sort(tmp_path):
    pdf = tmp_path / "cols.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(36, 72, 280, 700), "Left column body text " * 12,
                        fontsize=12, fontname="helv")
    page.insert_textbox(fitz.Rect(320, 72, 580, 700), "Right column body text " * 12,
                        fontsize=12, fontname="helv")
    doc.save(pdf)
    doc.close()
    with _open(pdf) as handle:
        blocks = iter_page_blocks(handle.load_page(0), 1)
    left = next(b for b in blocks if b["text"].startswith("Left"))
    right = next(b for b in blocks if b["text"].startswith("Right"))
    assert left["x0"] < right["x0"]



def test_rotated_quad_recovery(tmp_path):
    pdf = tmp_path / "rot.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((200, 500), "Rotated digest body text " * 8, fontsize=12, rotate=90)
    doc.save(pdf)
    doc.close()
    with _open(pdf) as handle:
        found = extract_candidates(handle)
    assert found, "rotated text should still extract"
    assert found[0].quads, "rotated lines need quads for highlight annotations"
    quad = found[0].quads[0][1]
    assert quad.rect.width > 0 and quad.rect.height > 0


def test_long_block_splits(tmp_path):
    pdf = tmp_path / "long.pdf"
    make_pdf(pdf, [[{"text": LONG_TEXT}]])
    with _open(pdf) as doc:
        found = extract_candidates(doc)
    assert len(found) >= 2
    assert all(len(c.text) <= 960 for c in found)
    assert all(len(c.text) >= 40 for c in found)


def test_short_blocks_discarded(tmp_path):
    pdf = tmp_path / "short.pdf"
    make_pdf(pdf, [[{"text": "Tiny."}], [{"text": "Long enough body text " * 6}]])
    with _open(pdf) as doc:
        found = extract_candidates(doc)
    assert len(found) == 1
    assert found[0].page == 2


def test_heading_association(tmp_path):
    pdf = tmp_path / "head.pdf"
    make_pdf(pdf, [[{"text": "Refunds", "fontsize": 20, "bold": True},
                    {"text": "Refund policy body text " * 8, "fontsize": 11}]])
    with _open(pdf) as doc:
        found = extract_candidates(doc)
    assert len(found) == 1
    assert found[0].heading == "Refunds"


def test_plain_short_block_not_heading(tmp_path):
    pdf = tmp_path / "nohead.pdf"
    make_pdf(pdf, [[{"text": "note", "fontsize": 11, "box": (72, 72, 560, 100)},
                    {"text": "Refund policy body text " * 8, "fontsize": 11,
                     "box": (72, 120, 560, 400)}]])
    with _open(pdf) as doc:
        found = extract_candidates(doc)
    assert len(found) == 1
    assert found[0].heading == ""





def test_repeated_header_footer_excluded(tmp_path):
    pdf = tmp_path / "hf.pdf"
    pages = []
    for i in range(3):
        pages.append([{"text": "ACME Digest Header", "fontsize": 9},
                      {"text": f"Page {i} body text about refunds " * 8},
                      {"text": "ACME Digest Footer", "fontsize": 9}])
    make_pdf(tmp_path / "hf.pdf", pages)
    with _open(tmp_path / "hf.pdf") as doc:
        found = extract_candidates(doc)
    joined = " ".join(c.text for c in found)
    assert "ACME Digest Header" not in joined
    assert "ACME Digest Footer" not in joined
    assert len(found) == 3

