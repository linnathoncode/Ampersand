"""Result envelope validation shared across training steps.

The worker result must be contract-valid and must reference the exact claimed
job and fingerprint so a stale or unrelated worker result is rejected before
it can reach a terminal success state.
"""

from __future__ import annotations

from typing import Any, Mapping

from .contracts import validate_worker_result
from .errors import WorkerContractValidationError


def validate_result_matches_input(result: Mapping[str, Any], worker_input) -> None:
    """Validate a result envelope and tie it to the exact claimed job."""
    validated = validate_worker_result(dict(result))
    if validated.jobId != worker_input.jobId:
        raise WorkerContractValidationError(
            "The worker result does not match the claimed job"
        )
    if validated.jobFingerprint != worker_input.jobFingerprint:
        raise WorkerContractValidationError(
            "The worker result fingerprint does not match the claimed job"
        )


def validate_success_payload(
    worker_id: str, worker_input, success_payload: dict[str, Any]
) -> None:
    """Assemble the worker result envelope and validate it at the boundary."""
    result = {
        "jobId": worker_input.jobId,
        "jobFingerprint": worker_input.jobFingerprint,
        "workerId": worker_id,
        "result": success_payload,
    }
    validate_result_matches_input(result, worker_input)
