"""Snapshot artifact resolution and verification.

The worker reads frozen Parquet snapshots from the shared artifact storage
root. The storage URI and expected digest come only from trusted job metadata
assembled by the API; the worker never selects a file on its own. Resolution
rejects any URI that escapes the configured storage root, and verification
bounds the file size before reading and compares the incremental SHA-256 digest
against the trusted checksum.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path

from .errors import (
    SnapshotChecksumMismatchError,
    SnapshotNotFoundError,
    SnapshotSizeExceededError,
)

_READ_CHUNK_BYTES = 1024 * 1024


def resolve_snapshot_path(storage_root: str, storage_uri: str) -> Path:
    """Resolve a snapshot URI inside the configured storage root.

    Absolute URIs and paths that escape the root through ``..`` segments are
    rejected because a snapshot location must never be chosen by the worker or
    influenced by untrusted input.
    """
    root = Path(storage_root).resolve()
    candidate = (root / storage_uri).resolve()
    if not candidate.is_relative_to(root):
        raise SnapshotNotFoundError(
            "The snapshot storage URI points outside the artifact storage root"
        )
    return candidate


def verify_snapshot_file(
    path: Path,
    expected_sha256: str,
    max_bytes: int,
    on_chunk: Callable[[], None] | None = None,
) -> int:
    """Verify a snapshot file exists, is bounded, and matches its checksum.

    Returns the verified file size in bytes. The digest is computed
    incrementally so the file is never loaded into memory as a whole. When
    ``on_chunk`` is provided it is invoked after every read chunk so callers
    can keep long checksum computations alive with progress or heartbeat
    updates.
    """
    if not path.is_file():
        raise SnapshotNotFoundError(
            f"Snapshot artifact '{path.name}' is not present"
        )
    size = path.stat().st_size
    if size > max_bytes:
        raise SnapshotSizeExceededError(
            "Snapshot artifact exceeds the configured size limit"
        )

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(_READ_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            if on_chunk is not None:
                on_chunk()

    actual = digest.hexdigest()
    if actual != expected_sha256:
        raise SnapshotChecksumMismatchError(
            "Snapshot artifact checksum does not match its trusted digest"
        )
    return size