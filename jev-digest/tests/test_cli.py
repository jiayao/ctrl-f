from tests.helpers import FakeClient, SAMPLE_QUESTION, digest_handler, make_pdf
from tests.helpers import FakeAnswer, answer_for


def _pdf(tmp_path, name="in.pdf", pages=None):
    path = tmp_path / name
    if pages is None:
        pages = [[{"text": "Refund policy body text " * 8}],
                 [{"text": "Evidence paragraph about refunds " * 8}]]
    make_pdf(path, pages)
    return path


def _fake_judge(plan_client):
    async def fake(candidates, question, model, batch, conc, progress=None, client=None):
        from jev_digest.typesafe_client import apply_answers, chunk_id, make_windows

        plan = getattr(plan_client, "_plan", {})
        windows = make_windows(candidates, batch)
        for window in windows:
            answers = {}
            for pos, item in enumerate(window):
                prob, role, role_p = plan.get(item.index, (0.05, "irrelevant", 0.0))
                needed, choice = answer_for(prob, role, role_p)
                answers[f"{chunk_id(pos)}_needed"] = FakeAnswer(needed)
                answers[f"{chunk_id(pos)}_role"] = FakeAnswer(choice)
            apply_answers(window, {k: v.model_dump() for k, v in answers.items()})
        return {"input_tokens": 5, "output_tokens": 2, "model": model}

    return fake



def _client_for(plan):
    client = FakeClient(digest_handler(plan))
    client._plan = dict(plan)
    return client


def test_missing_credentials_exit_1(tmp_path, monkeypatch, capsys):
    import os

    from jev_digest.cli import main

    path = _pdf(tmp_path)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 1
    assert "TYPESAFE_API_KEY" in capsys.readouterr().err
    assert not os.path.exists(tmp_path / "in.digest.pdf")
    assert not os.path.exists(tmp_path / "in.digest.json")


def test_invalid_args_exit_2(tmp_path):
    from jev_digest.cli import main

    path = _pdf(tmp_path)
    assert main([str(path), "--question", SAMPLE_QUESTION, "--threshold", "0.95"]) == 2
    assert main([str(path), "--question", SAMPLE_QUESTION, "--batch-size", "99"]) == 2
    assert main([str(path), "--question", SAMPLE_QUESTION, "--concurrency", "0"]) == 2
    assert main([str(tmp_path / "nope.pdf"), "--question", SAMPLE_QUESTION]) == 2


def test_invalid_pdf_exit_1(tmp_path, capsys):
    from jev_digest.cli import main

    bad = tmp_path / "bad.pdf"
    bad.write_text("not a pdf", encoding="utf-8")
    assert main([str(bad), "--question", SAMPLE_QUESTION]) == 1


def test_textless_pdf_exit_1(tmp_path):
    import fitz

    from jev_digest.cli import main

    path = tmp_path / "blank.pdf"
    doc = fitz.open()
    doc.new_page()
    doc.save(path)
    doc.close()
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 1


def test_encrypted_pdf_exit_1(tmp_path):
    import fitz

    from jev_digest.cli import main

    path = tmp_path / "enc.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Refund policy body text " * 8, fontsize=12)
    doc.save(path, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret")
    doc.close()
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 1



def test_output_collision_and_force(tmp_path, monkeypatch):
    import jev_digest.pipeline as pipeline
    from jev_digest.cli import main

    path = _pdf(tmp_path)
    (tmp_path / "in.digest.pdf").write_text("x", encoding="utf-8")
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 2
    client = _client_for({0: (0.9, "direct_answer", 0.9), 1: (0.9, "evidence", 0.9)})
    monkeypatch.setattr(pipeline, "judge_candidates", _fake_judge(client))
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    assert main([str(path), "--question", SAMPLE_QUESTION, "--force"]) == 0
    assert (tmp_path / "in.digest.pdf").stat().st_size > 10


def test_api_error_no_partial_output(tmp_path, monkeypatch):
    import jev_digest.pipeline as pipeline
    from jev_digest.cli import main

    path = _pdf(tmp_path)
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")

    async def boom(candidates, question, model, batch, conc, progress=None, client=None):
        raise RuntimeError("service down")

    monkeypatch.setattr(pipeline, "judge_candidates", boom)
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 1
    assert not (tmp_path / "in.digest.pdf").exists()
    assert not (tmp_path / "in.digest.json").exists()


def test_success_default_and_custom_paths(tmp_path, monkeypatch, capsys):
    import json

    import jev_digest.pipeline as pipeline
    from jev_digest.cli import main

    path = _pdf(tmp_path)
    plan = {0: (0.92, "direct_answer", 0.9), 1: (0.88, "evidence", 0.85)}
    monkeypatch.setattr(pipeline, "judge_candidates", _fake_judge(_client_for(plan)))
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 0
    out = capsys.readouterr().out
    assert "Direct answer" in out and "Evidence" in out
    assert (tmp_path / "in.digest.pdf").exists()
    data = json.loads((tmp_path / "in.digest.json").read_text(encoding="utf-8"))
    assert data["manifest_version"] == 1
    assert data["question"] == SAMPLE_QUESTION
    assert len(data["passages"]) == 2
    custom_pdf = tmp_path / "custom.pdf"
    custom_json = tmp_path / "custom.json"
    monkeypatch.setattr(pipeline, "judge_candidates", _fake_judge(_client_for(plan)))
    args = [str(path), "--question", SAMPLE_QUESTION, "--pdf-output", str(custom_pdf),
            "--json-output", str(custom_json), "--force"]
    assert main(args) == 0
    assert custom_pdf.exists() and custom_json.exists()


def test_no_qualifying_no_artifacts(tmp_path, monkeypatch, capsys):
    import jev_digest.pipeline as pipeline
    from jev_digest.cli import main

    path = _pdf(tmp_path)
    plan = {0: (0.05, "irrelevant", 0.0), 1: (0.06, "irrelevant", 0.0)}
    monkeypatch.setattr(pipeline, "judge_candidates", _fake_judge(_client_for(plan)))
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    assert main([str(path), "--question", SAMPLE_QUESTION]) == 0
    assert "No clear reading path" in capsys.readouterr().out
    assert not (tmp_path / "in.digest.pdf").exists()
    assert not (tmp_path / "in.digest.json").exists()




