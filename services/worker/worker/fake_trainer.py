"""Deterministic fake training.

This trainer produces a contract-valid success result without fitting a real
model. It runs only after snapshot verification and dataset validation
succeed, is deterministic for identical inputs, and clearly marks every
artifact it writes as fake. It never registers, publishes, or exposes a model;
the produced artifact is temporary and is removed once the result has been
validated at the worker boundary.
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .contracts import TrainingWorkerInput, validate_worker_result
from .dataset_validation import ValidatedDataset
from .errors import WorkerContractValidationError

FAKE_ARTIFACT_MARKER = b"AMPERSAND_FAKE_TRAINING_ARTIFACT"


@dataclass(frozen=True)
class FakeTrainingOutput:
    """The validated success payload and the temporary artifact to clean up."""

    success_payload: dict
    artifact_path: Path


class FakeTrainer:
    """Produces deterministic, clearly marked fake training output."""

    def __init__(self, artifact_output_directory: str) -> None:
        self._artifact_output_directory = artifact_output_directory

    def train(
        self,
        worker_input: TrainingWorkerInput,
        dataset: ValidatedDataset,
        on_progress: Callable[[], None] | None = None,
    ) -> FakeTrainingOutput:
        seed = _training_seed(worker_input)
        rng = random.Random(seed)

        metrics = _deterministic_metrics(rng, seed)
        baseline = _deterministic_baseline_metrics(rng, seed)
        features = []
        for feature in worker_input.features:
            features.append(_feature_metadata(dataset, feature))
            if on_progress is not None:
                on_progress()
        artifact_path, artifact = self._write_fake_artifact(worker_input)

        return FakeTrainingOutput(
            success_payload={
                "status": "succeeded",
                "metrics": metrics,
                "baselineMetrics": baseline,
                "artifact": artifact,
                "features": features,
            },
            artifact_path=artifact_path,
        )

    def _write_fake_artifact(
        self, worker_input: TrainingWorkerInput
    ) -> tuple[Path, dict]:
        payload = (
            FAKE_ARTIFACT_MARKER
            + b"\0"
            + worker_input.jobFingerprint.encode()
            + b"\0"
            + worker_input.snapshot.contentSha256.encode()
        )
        filename = f"{worker_input.jobId}.fake.onnx"
        output_directory = Path(self._artifact_output_directory)
        output_directory.mkdir(parents=True, exist_ok=True)
        path = output_directory / filename
        path.write_bytes(payload)
        artifact = {
            "storageUri": filename,
            "format": "onnx",
            "contentSha256": hashlib.sha256(payload).hexdigest(),
            "sizeBytes": len(payload),
        }
        return path, artifact


def validate_fake_result(worker_id: str, worker_input: TrainingWorkerInput, success_payload: dict) -> None:
    """Validate the assembled worker result against the private contract."""
    result = {
        "jobId": worker_input.jobId,
        "jobFingerprint": worker_input.jobFingerprint,
        "workerId": worker_id,
        "result": success_payload,
    }
    validate_result_matches_input(result, worker_input)


def validate_result_matches_input(result: dict, worker_input: TrainingWorkerInput) -> None:
    """Validate a result envelope and tie it to the exact claimed job.

    The result must be contract-valid and must reference the claimed job and
    its exact fingerprint so a stale or unrelated worker result is rejected.
    """
    validated = validate_worker_result(result)
    if validated.jobId != worker_input.jobId:
        raise WorkerContractValidationError(
            "The worker result does not match the claimed job"
        )
    if validated.jobFingerprint != worker_input.jobFingerprint:
        raise WorkerContractValidationError(
            "The worker result fingerprint does not match the claimed job"
        )


def _training_seed(worker_input: TrainingWorkerInput) -> int:
    digest = hashlib.sha256()
    digest.update(worker_input.jobFingerprint.encode())
    digest.update(b"\0")
    digest.update(worker_input.snapshot.contentSha256.encode())
    return int.from_bytes(digest.digest()[:8], "big")


def _deterministic_metrics(rng: random.Random, seed: int) -> dict:
    mae = round(rng.uniform(1.0, 5.0), 4)
    rmse = round(mae + rng.uniform(0.1, 2.0), 4)
    r2 = round(rng.uniform(0.7, 0.95), 4)
    return {"mae": mae, "rmse": rmse, "r2": r2}


def _deterministic_baseline_metrics(rng: random.Random, seed: int) -> dict:
    mae = round(rng.uniform(4.0, 10.0), 4)
    rmse = round(mae + rng.uniform(0.5, 3.0), 4)
    r2 = round(rng.uniform(0.0, 0.3), 4)
    return {"mae": mae, "rmse": rmse, "r2": r2}


def _feature_metadata(
    dataset: ValidatedDataset,
    feature,
) -> dict:
    stats = next(
        stat for stat in dataset.column_stats if stat.name == feature.name
    )
    row_count = dataset.row_count
    missing_rate = round(
        (stats.missing_count / row_count) if row_count else 0.0, 6
    )
    allowed_values = (
        list(stats.allowed_values) if stats.allowed_values is not None else None
    )

    return {
        "name": feature.name,
        "position": feature.position,
        "dataType": feature.dataType,
        "validMin": stats.valid_min,
        "validMax": stats.valid_max,
        "allowedValues": allowed_values,
        "missingRate": missing_rate,
    }