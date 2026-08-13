"""Logging setup for the private worker."""

from __future__ import annotations

import logging
import sys

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def setup_logging(level: str) -> None:
    """Configure the root logger once with a stable, parseable format."""
    logging.basicConfig(
        level=level,
        stream=sys.stdout,
        format=_LOG_FORMAT,
        force=True,
    )