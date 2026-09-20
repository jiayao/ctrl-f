"""Typed errors with the CLI exit code each class maps to."""

EXIT_USAGE = 2
EXIT_FAILURE = 1


class UsageError(Exception):
    """Invalid arguments or configuration. Reported with exit code 2."""


class RunError(Exception):
    """PDF, extraction, or API failure. Reported with exit code 1."""
