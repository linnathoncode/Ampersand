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
from typing import Mapping

from .errors import (
    InvalidEnvironmentValueError,
    MissingEnvironmentVariableError,
)

DEFAULT_POLL_INTERVAL_SECONDS = 5
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 10
DEFAULT_ARTIFACT_STORAGE_PATH = "./artifacts"
DEFAULT_LOG_LEVEL = "INFO"

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
        artifact_storage_path = _require_non_empty(
            values,
            "ARTIFACT_STORAGE_PATH",
            default=DEFAULT_ARTIFACT_STORAGE_PATH,
        )
        log_level = _log_level(values)

        return cls(
            database_url=database_url,
            worker_id=worker_id,
            poll_interval_seconds=poll_interval_seconds,
            heartbeat_interval_seconds=heartbeat_interval_seconds,
            artifact_storage_path=artifact_storage_path,
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