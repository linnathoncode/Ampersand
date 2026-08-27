"""HTTP submission of validated worker results to Nucleus.

After the executor validates a training result against the private
contract, this module hands it to Nucleus over the internal, token-
authenticated endpoint. Nucleus alone registers the candidate model and
finishes the job; the worker performs no registration SQL. Transport
failures and 5xx responses are retried with a short bounded backoff;
structured rejections from Nucleus are surfaced immediately so the job can
be failed with the server's stable error code.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping

from .config import WorkerConfig
from .contracts import TrainingWorkerInput
from .errors import (
    JobOwnershipError,
    JobStateConflictError,
    TrainingResultSubmissionError,
    WorkerError,
)

_RESULT_ENDPOINT_PATH = "/internal/training-jobs/{job_id}/result"

_MAX_BACKOFF_SECONDS = 2


@dataclass(frozen=True)
class SubmissionOutcome:
    """The accepted submission result reported by Nucleus."""

    status: str
    model_version_id: str | None = None
    version_number: int | None = None
    storage_uri: str | None = None


def build_result_submission(
    worker_id: str,
    worker_input: TrainingWorkerInput,
    success_payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Assemble the internal submission envelope for one success result."""
    return {
        "workerId": worker_id,
        "fingerprint": worker_input.jobFingerprint,
        "result": success_payload,
    }


def submit_training_result(
    config: WorkerConfig,
    *,
    job_id: str,
    schema_name: str,
    payload: Mapping[str, Any],
    sleep: Any = None,
) -> SubmissionOutcome:
    """Submit one result envelope to Nucleus with bounded retries.

    Ownership and state conflicts reported by Nucleus propagate as their
    structured worker errors so the executor leaves those jobs untouched.
    Other non-2xx responses raise immediately when Nucleus provided a
    stable code, and transport or server failures retry until the attempt
    budget is exhausted.
    """
    endpoint = (
        f"{config.nucleus_internal_url}"
        f"{_RESULT_ENDPOINT_PATH.format(job_id=job_id)}"
    )
    body = json.dumps(dict(payload)).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        # The API's tenant middleware deletes any client-supplied
        # x-tenant-schema header, resolves the caller through its registry
        # from this header (registered schema name, tenant id, or subdomain,
        # gated by trusted_sources), and stamps the resolved schema onto the
        # request before the endpoint handler reads it. Workers only ever
        # hold jobs for schemas listed active in that registry.
        "x-tenant-id": schema_name,
        "x-service-id": "ampersand-worker",
        "Authorization": f"Bearer {config.nucleus_result_token}",
    }
    sleep_between_attempts = sleep if sleep is not None else time.sleep

    last_error: TrainingResultSubmissionError | None = None

    for attempt in range(config.submission_max_attempts):
        request = urllib.request.Request(
            endpoint, data=body, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(
                request, timeout=config.submission_timeout_seconds
            ) as response:
                return _parse_success_response(response.read())

        except urllib.error.HTTPError as exc:
            rejection = _map_http_error(exc)
            if isinstance(rejection, (JobOwnershipError, JobStateConflictError)):
                raise rejection
            if isinstance(rejection, TrainingResultSubmissionError):
                if exc.code is not None and exc.code < 500:
                    raise rejection
                last_error = rejection
            else:
                last_error = TrainingResultSubmissionError(
                    "Nucleus rejected the training result submission"
                )

        except (urllib.error.URLError, TimeoutError, OSError):
            last_error = TrainingResultSubmissionError(
                "The training result could not be submitted to Nucleus"
            )

        if attempt + 1 < config.submission_max_attempts:
            sleep_between_attempts(min(2**attempt, _MAX_BACKOFF_SECONDS))

    raise last_error or TrainingResultSubmissionError(
        "The training result could not be submitted to Nucleus"
    )


def _parse_success_response(raw: bytes) -> SubmissionOutcome:
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TrainingResultSubmissionError(
            "Nucleus returned an unreadable submission response"
        ) from exc

    status = parsed.get("status") if isinstance(parsed, dict) else None

    if status == "registered":
        _validate_registered_response(parsed)
        return SubmissionOutcome(
            status="registered",
            model_version_id=parsed["modelVersionId"],
            version_number=parsed["versionNumber"],
            storage_uri=parsed["storageUri"],
        )
    if status == "failed-recorded":
        return SubmissionOutcome(status="failed-recorded")

    raise TrainingResultSubmissionError(
        "Nucleus returned an unexpected submission response"
    )


_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _validate_registered_response(parsed: dict[str, Any]) -> None:
    """Rejects malformed registered responses before values propagate.

    Mirrors the endpoint's response shape: a UUID model version id, a
    positive integer version number, and a non-empty immutable storage URI.
    """
    model_version_id = parsed.get("modelVersionId")
    version_number = parsed.get("versionNumber")
    storage_uri = parsed.get("storageUri")

    valid_id = (
        isinstance(model_version_id, str)
        and _UUID_PATTERN.fullmatch(model_version_id) is not None
    )
    valid_version = (
        isinstance(version_number, int)
        and not isinstance(version_number, bool)
        and version_number > 0
    )
    valid_uri = (
        isinstance(storage_uri, str)
        and len(storage_uri) > 0
        and storage_uri.startswith("models/")
    )

    if not (valid_id and valid_version and valid_uri):
        raise TrainingResultSubmissionError(
            "Nucleus returned a malformed success response"
        )


def _map_http_error(
    exc: urllib.error.HTTPError,
) -> WorkerError:
    code: str | None = None
    message: str | None = None

    try:
        parsed = json.loads(exc.read().decode("utf-8"))
        error_body = parsed.get("error", {}) if isinstance(parsed, dict) else {}
        code = error_body.get("code")
        message = error_body.get("message")
    except (UnicodeDecodeError, json.JSONDecodeError, OSError):
        message = None

    if code == "JOB_OWNERSHIP":
        return JobOwnershipError(
            message or "The submitted job is not owned by this worker"
        )
    if code == "JOB_STATE_CONFLICT":
        return JobStateConflictError(
            message or "The submitted job is not in the running state"
        )

    detail = message or "Nucleus rejected the training result submission"
    return TrainingResultSubmissionError(detail, server_error_code=code)
