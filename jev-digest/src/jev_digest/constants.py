"""Shared Digest constants ported from the browser extension (content.js)."""

__version__ = "0.1.0"

MANIFEST_VERSION = 1

MIN_CHUNK_LEN = 40
MAX_CHUNK_LEN = 960
MIN_DIGEST_ITEMS = 3
MAX_DIGEST_ITEMS = 7

ROLE_LABELS = {
    "direct_answer": "Direct answer",
    "background": "Background",
    "reasoning": "Explanation",
    "evidence": "Evidence",
    "qualification": "Important exception",
    "counterpoint": "Counterpoint",
    "irrelevant": "Not needed",
}

ROLE_ORDER = [
    "direct_answer",
    "background",
    "reasoning",
    "evidence",
    "qualification",
    "counterpoint",
]

# (fill, text) colors as 0..1 RGB triples for highlight annotations.
ROLE_COLORS = {
    "direct_answer": ((0.72, 0.97, 0.94), (0.04, 0.35, 0.33)),
    "background": ((0.86, 0.88, 1.0), (0.16, 0.18, 0.55)),
    "reasoning": ((0.86, 0.88, 1.0), (0.16, 0.18, 0.55)),
    "evidence": ((0.80, 0.96, 0.82), (0.06, 0.38, 0.16)),
    "qualification": ((1.0, 0.91, 0.72), (0.48, 0.28, 0.02)),
    "counterpoint": ((1.0, 0.91, 0.72), (0.48, 0.28, 0.02)),
}

# Stronger amber treatment reserved for "The catch".
CATCH_FILL = (1.0, 0.80, 0.38)

QUESTION_ID_WIDTH = 2
REQUEST_TIMEOUT_S = 45.0
MAX_RETRIES = 3
DEFAULT_MODEL = "jev-latest"

CATCH_ROLES = ("qualification", "counterpoint")
