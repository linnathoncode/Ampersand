"""Temporary artifact helpers for the private worker.

Since Nucleus owns candidate registration, the worker only ever creates a
temporary ONNX payload for its own training output and removes it after the
submission attempt. Promotion into immutable versioned storage and checksum
re-verification live on the Nucleus side.
"""

from __future__ import annotations

from pathlib import Path

from .errors import WorkerError


def delete_temp(temp_path: Path) -> None:
    """Delete a temporary payload, tolerating an already absent file."""
    try:
        temp_path.unlink(missing_ok=True)
    except OSError as exc:
        raise WorkerError(
            "The temporary ONNX payload could not be deleted"
        ) from exc
