"""Optional live TypeSafe test (skipped without TYPESAFE_API_KEY)."""

import os

import pytest

pytestmark = pytest.mark.live


def test_live_digest_smoke(tmp_path):
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        pytest.skip("TYPESAFE_API_KEY not set")
    from jev_digest.cli import main
    from tests.helpers import make_pdf

    src = tmp_path / "live.pdf"
    make_pdf(src, [[{"text": "Refunds are available within thirty days " * 8}]])
    code = main([str(src), "--question", "What is the refund window?"])
    assert code == 0

