"""Worker configuration.

Loaded once at startup from environment variables. The worker never accepts
authorization, tenant permissions, or user identity as configuration; those
values are supplied later by the API as trusted job metadata.
"""

from __future__ import annotations

import os
import re
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse

from .errors import (
    InvalidEnvironmentValueError,
    MissingEnvironmentVariableError,
)

DEFAULT_POLL_INTERVAL_SECONDS = 5
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 10
DEFAULT_CLAIM_TIMEOUT_SECONDS = 120
DEFAULT_ARTIFACT_STORAGE_PATH = "./artifacts"
DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_SNAPSHOT_ROWS = 10_000_000
DEFAULT_SUBMISSION_TIMEOUT_SECONDS = 10
DEFAULT_SUBMISSION_MAX_ATTEMPTS = 3
DEFAULT_WORKER_LOG_MAX_CHARS = 8192
DEFAULT_LOG_LEVEL = "INFO"

_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

VALID_LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")

WORKER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
WORKER_ID_MAX_LENGTH = 255


@dataclass(frozen=True)
class WorkerConfig:
    database_url: str
    worker_id: str
    poll_interval_seconds: int
    heartbeat_interval_seconds: int
    artifact_storage_path: str
    log_level: str
    nucleus_internal_url: str
    nucleus_result_token: str
    claim_timeout_seconds: int = DEFAULT_CLAIM_TIMEOUT_SECONDS
    max_snapshot_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES
    max_snapshot_rows: int = DEFAULT_MAX_SNAPSHOT_ROWS
    submission_timeout_seconds: int = DEFAULT_SUBMISSION_TIMEOUT_SECONDS
    submission_max_attempts: int = DEFAULT_SUBMISSION_MAX_ATTEMPTS
    log_max_chars: int = DEFAULT_WORKER_LOG_MAX_CHARS

    @classmethod
    def from_env(
        cls, env: Mapping[str, str] | None = None
    ) -> "WorkerConfig":
        values = os.environ if env is None else env

        database_url = _require_non_empty(values, "DATABASE_URL")
        worker_id = _resolve_worker_id(values)
        poll_interval_seconds = _positive_int(
            values, "WORKER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS
        )
        heartbeat_interval_seconds = _positive_int(
            values,
            "WORKER_HEARTBEAT_INTERVAL_SECONDS",
            DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        )
        claim_timeout_seconds = _positive_int(
            values,
            "WORKER_CLAIM_TIMEOUT_SECONDS",
            DEFAULT_CLAIM_TIMEOUT_SECONDS,
        )
        artifact_storage_path = _artifact_storage_path(
            _require_non_empty(
                values,
                "ARTIFACT_STORAGE_PATH",
                default=DEFAULT_ARTIFACT_STORAGE_PATH,
            )
        )
        max_snapshot_bytes = _positive_int(
            values,
            "WORKER_MAX_SNAPSHOT_BYTES",
            DEFAULT_MAX_SNAPSHOT_BYTES,
        )
        max_snapshot_rows = _positive_int(
            values,
            "WORKER_MAX_SNAPSHOT_ROWS",
            DEFAULT_MAX_SNAPSHOT_ROWS,
        )
        submission_timeout_seconds = _positive_int(
            values,
            "WORKER_SUBMISSION_TIMEOUT_SECONDS",
            DEFAULT_SUBMISSION_TIMEOUT_SECONDS,
        )
        submission_max_attempts = _positive_int(
            values,
            "WORKER_SUBMISSION_MAX_ATTEMPTS",
            DEFAULT_SUBMISSION_MAX_ATTEMPTS,
        )
        log_max_chars = _positive_int(
            values, "WORKER_LOG_MAX_CHARS", DEFAULT_WORKER_LOG_MAX_CHARS
        )
        nucleus_internal_url = _nucleus_internal_url(values)
        nucleus_result_token = _require_non_empty(
            values, "NUCLEUS_INTERNAL_TOKEN"
        )
        log_level = _log_level(values)

        return cls(
            database_url=database_url,
            worker_id=worker_id,
            poll_interval_seconds=poll_interval_seconds,
            heartbeat_interval_seconds=heartbeat_interval_seconds,
            claim_timeout_seconds=claim_timeout_seconds,
            artifact_storage_path=artifact_storage_path,
            max_snapshot_bytes=max_snapshot_bytes,
            max_snapshot_rows=max_snapshot_rows,
            submission_timeout_seconds=submission_timeout_seconds,
            submission_max_attempts=submission_max_attempts,
            log_max_chars=log_max_chars,
            nucleus_internal_url=nucleus_internal_url,
            nucleus_result_token=nucleus_result_token,
            log_level=log_level,
        )


def _require_non_empty(
    env: Mapping[str, str],
    variable: str,
    *,
    default: str | None = None,
) -> str:
    raw = env.get(variable)
    if raw is None or raw == "":
        if default is not None:
            return default
        raise MissingEnvironmentVariableError(variable)
    return raw


def _nucleus_internal_url(env: Mapping[str, str]) -> str:
    raw = _require_non_empty(env, "NUCLEUS_INTERNAL_URL")
    parsed = urlparse(raw)

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise InvalidEnvironmentValueError(
            "NUCLEUS_INTERNAL_URL",
            "must be a valid http(s) URL",
        )

    return raw.rstrip("/")


def _artifact_storage_path(raw: str) -> str:
    path = Path(raw)
    if not path.is_absolute():
        path = _REPOSITORY_ROOT / path
    return str(path.resolve())


def _resolve_worker_id(env: Mapping[str, str]) -> str:
    raw = env.get("WORKER_ID")
    if raw is None or raw == "":
        return f"worker-{socket.gethostname()}-{os.getpid()}"

    if len(raw) > WORKER_ID_MAX_LENGTH:
        raise InvalidEnvironmentValueError(
            "WORKER_ID",
            f"must be at most {WORKER_ID_MAX_LENGTH} characters",
        )
    if WORKER_ID_PATTERN.fullmatch(raw) is None:
        raise InvalidEnvironmentValueError(
            "WORKER_ID",
            "must contain only letters, digits, underscores, or dashes",
        )
    return raw


def _positive_int(
    env: Mapping[str, str], variable: str, default: int
) -> int:
    raw = env.get(variable)
    if raw is None or raw == "":
        return default

    try:
        value = int(raw)
    except ValueError as exc:
        raise InvalidEnvironmentValueError(
            variable, "must be a whole number"
        ) from exc

    if value < 1:
        raise InvalidEnvironmentValueError(
            variable, "must be a positive integer"
        )
    return value


def _log_level(env: Mapping[str, str]) -> str:
    raw = env.get("WORKER_LOG_LEVEL", DEFAULT_LOG_LEVEL)
    level = raw.strip().upper()
    if level not in VALID_LOG_LEVELS:
        raise InvalidEnvironmentValueError(
            "WORKER_LOG_LEVEL",
            f"must be one of {', '.join(VALID_LOG_LEVELS)}",
        )
    return level
