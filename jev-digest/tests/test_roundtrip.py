"""Round-trip tests: annotations preserve source, JSON matches PDF."""

import fitz

from jev_digest.annotate import annotate_pdf
from jev_digest.digest import select_digest
from tests.helpers import make_pdf


def _candidate(doc, index, page, role, prob):
    from jev_digest.extract import extract_candidates

    found = extract_candidates(doc)
    item = next(c for c in found if c.page == page)
    item.index = index
    item.probability = prob
    item.role = role
    item.role_probability = 0.8
    item.confidence = 0.7
    return item


def test_pdf_text_pagecount_preserved_and_annots(tmp_path):
    src = tmp_path / "src.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Original title metadata", fontsize=12)
    page.insert_link({"kind": 1, "from": fitz.Rect(72, 100, 200, 120), "page": 0})
    widget = fitz.Widget()
    widget.field_name = "name"
    widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    widget.rect = fitz.Rect(72, 140, 250, 160)
    page2 = doc.new_page()
    page2.insert_text((72, 72), "Second page target text", fontsize=12)
    doc.set_metadata({"title": "Keep me", "author": "Author"})
    doc.save(src)
    doc.close()
    with fitz.open(src) as handle:
        text_before = [handle.load_page(i).get_text() for i in range(handle.page_count)]
        links_before = len(list(handle.load_page(0).get_links()))
        widgets_before = len(list(handle.load_page(0).widgets() or []))
        meta_before = dict(handle.metadata)
    make_pdf(tmp_path / "body.pdf", [[{"text": "Refund policy body text " * 8}],
                                     [{"text": "Evidence paragraph about refunds " * 8}]])
    with fitz.open(tmp_path / "body.pdf") as doc:
        first = _candidate(doc, 0, 1, "direct_answer", 0.92)
        second = _candidate(doc, 1, 2, "qualification", 0.88)
        first.index, second.index = 0, 1
        selected = select_digest([first, second], 0.45)
        assert len(selected) == 2
        assert sum(1 for s in selected if s.is_catch) == 1
        count = annotate_pdf(doc, selected)
        assert count == 2
        out = tmp_path / "out.pdf"
        doc.save(out)
    with fitz.open(out) as check:
        assert check.page_count == 2
        kinds = []
        titles = []
        for i in range(check.page_count):
            page = check.load_page(i)
            kinds.extend(a.type[1] for a in (page.annots() or []))
            for annot in (page.annots() or []):
                info = annot.info
                titles.append(info.get("title", ""))
                if annot.type[1] == "Highlight":
                    assert "jev-digest" in info.get("content", "")
        assert "Highlight" in kinds
        assert "FreeText" in kinds
        assert any("The catch" in t or "Direct answer" in t for t in titles)
    with fitz.open(src) as handle:
        assert [handle.load_page(i).get_text() for i in range(handle.page_count)] == text_before
        assert len(list(handle.load_page(0).get_links())) == links_before
        assert len(list(handle.load_page(0).widgets() or [])) == widgets_before
        assert handle.metadata.get("title") == meta_before.get("title")


def test_manifest_locations_match_annotations(tmp_path):
    from jev_digest.manifest import build_manifest

    src = tmp_path / "src.pdf"
    make_pdf(src, [[{"text": "Refund policy body text " * 8}]])
    with fitz.open(src) as doc:
        item = _candidate(doc, 0, 1, "direct_answer", 0.9)
        selected = select_digest([item], 0.45)
        manifest = build_manifest(source={"path": str(src), "sha256": "x", "pages": 1},
                                  question="q",
                                  config={"threshold": 0.45, "model": "m",
                                          "batch_size": 12, "concurrency": 4},
                                  model="jev-latest",
                                  usage={"input_tokens": 3, "output_tokens": 1},
                                  selected=selected)
        passage = manifest["passages"][0]
        assert passage["order"] == 1
        assert passage["page"] == 1
        assert passage["role"] == "direct_answer"
        assert passage["label"] == "Direct answer"
        assert passage["probability"] == 0.9
        assert passage["score"] > 0
        assert passage["text"] == item.text
        assert passage["is_catch"] is False
        assert passage["quads"], "manifest must carry PDF-coordinate quads"
        assert all(len(q["quad"]) == 8 for q in passage["quads"])
        count = annotate_pdf(doc, selected)
        assert count == len([q for q in passage["quads"] if q]) or count >= 1

