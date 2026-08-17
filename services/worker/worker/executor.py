"""Coordinator that executes one claimed training job to a terminal state.

The executor runs only after the lifecycle has claimed a job with
``FOR UPDATE SKIP LOCKED``. It loads trusted job, snapshot, and dataset
metadata from the tenant schema, verifies the snapshot checksum, validates the
Parquet data against the trusted definition, runs the deterministic fake
trainer, validates the result against the private contract, and reaches a
terminal state. All lifecycle writes remain ownership-guarded; a job that was
cancelled or moved by Nucleus in the meantime is never overwritten.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

from .config import WorkerConfig
from .contracts import TrainingWorkerInput, build_worker_input
from .database import (
    CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE,
    ClaimedJob,
    Database,
    JobExecutionContext,
)
from .dataset_validation import (
    TrustedColumn,
    validate_snapshot_dataset,
)
from .errors import (
    JobOwnershipError,
    JobRuntimeExceededError,
    JobStateConflictError,
    SnapshotColumnMissingError,
    SnapshotColumnOrderInvalidError,
    SnapshotColumnTypeInvalidError,
    SnapshotTargetInvalidError,
    WorkerError,
)
from .fake_trainer import FakeTrainer, validate_fake_result
from .snapshots import resolve_snapshot_path, verify_snapshot_file

_WORKER_FEATURE_TYPES = ("number", "integer", "boolean", "category")
_WORKER_TARGET_TYPES = ("number", "integer")

SNAPSHOT_VERIFIED_PROGRESS_PERCENT = 50
SNAPSHOT_VERIFIED_PROGRESS_MESSAGE = "Snapshot verified; validating dataset schema"
TRAINING_PROGRESS_PERCENT = 80
TRAINING_PROGRESS_MESSAGE = "Running deterministic fake training; no model registered"
SUCCESS_PROGRESS_PERCENT = 100
SUCCESS_PROGRESS_MESSAGE = "Fake training completed; no model registered"
FAILED_PROGRESS_MESSAGE = "Training job failed"

_MAX_ERROR_MESSAGE_LENGTH = 500


def build_worker_input_from_context(
    context: JobExecutionContext, config: WorkerConfig
) -> TrainingWorkerInput:
    """Build the immutable worker input from trusted server metadata.

    Feature types must be supported by the worker, the target must be numeric,
    and feature positions must be contiguous and correctly ordered. Any
    violation raises a stable structured error before a snapshot is read.
    """
    features: list[dict] = []
    for column in context.columns:
        if column.role != "feature":
            continue
        if column.data_type not in _WORKER_FEATURE_TYPES:
            raise SnapshotColumnTypeInvalidError(
                f"Feature column '{column.name}' uses an unsupported data type"
            )
        features.append(
            {
                "name": column.name,
                "dataType": column.data_type,
                "position": column.position,
            }
        )

    if not features:
        raise SnapshotColumnMissingError(
            "The dataset definition has no feature columns"
        )

    features.sort(key=lambda feature: feature["position"])
    positions = [feature["position"] for feature in features]
    if positions != list(range(len(positions))):
        raise SnapshotColumnOrderInvalidError(
            "Feature positions are not contiguous and ordered"
        )

    targets = [
        column
        for column in context.columns
        if column.role == "target"
    ]
    if len(targets) != 1:
        raise SnapshotTargetInvalidError(
            "The dataset definition does not identify exactly one target"
        )
    target = targets[0]
    if target.data_type not in _WORKER_TARGET_TYPES:
        raise SnapshotTargetInvalidError(
            "The training target is not numeric"
        )

    time_column = context.time_column
    return build_worker_input(
        tenant_schema=context.schema_name,
        job_id=context.job_id,
        job_fingerprint=context.job_fingerprint,
        dataset_definition_id=context.dataset_definition_id,
        snapshot={
            "id": context.snapshot_id,
            "storageUri": context.snapshot_uri,
            "format": context.snapshot_format,
            "contentSha256": context.snapshot_content_sha256,
            "rowCount": context.snapshot_row_count,
        },
        features=features,
        target={"name": target.name, "dataType": target.data_type},
        time_column=time_column,
        training_config=context.training_config,
        artifact_output_directory=config.artifact_storage_path,
        heartbeat_interval_seconds=config.heartbeat_interval_seconds,
    )


class JobExecutor:
    """Owns the safe execution of one claimed job to a terminal state."""

    def __init__(
        self,
        config: WorkerConfig,
        database: Database,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._config = config
        self._database = database
        self._fake_trainer = FakeTrainer(config.artifact_storage_path)
        self._logger = logging.getLogger("worker.executor")
        self._progress_percent = 0
        self._progress_message = CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE
        self._last_heartbeat_at = 0.0
        self._runtime_deadline = 0.0
        self._now = clock or time.monotonic
        self._heartbeat_due_after = max(
            1, config.heartbeat_interval_seconds // 2
        )

    def handle(self, job: ClaimedJob) -> None:
        """Execute the claimed job, reaching succeeded or failed exactly once."""
        self._progress_percent = 0
        self._progress_message = CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE
        self._last_heartbeat_at = self._now()
        self._runtime_deadline = self._last_heartbeat_at + job.max_runtime_seconds
        heartbeat = self._make_heartbeat(job)
        try:
            self._check_runtime()
            context = self._database.load_job_execution_context(
                self._config.worker_id, job.schema_name, job.id
            )
            worker_input = build_worker_input_from_context(
                context, self._config
            )
            self._check_runtime()

            snapshot_path = resolve_snapshot_path(
                self._config.artifact_storage_path, context.snapshot_uri
            )
            verify_snapshot_file(
                snapshot_path,
                context.snapshot_content_sha256,
                self._config.max_snapshot_bytes,
                on_chunk=heartbeat,
            )
            self._update_progress(
                job,
                SNAPSHOT_VERIFIED_PROGRESS_PERCENT,
                SNAPSHOT_VERIFIED_PROGRESS_MESSAGE,
            )
            self._check_runtime()

            trusted_columns = tuple(
                TrustedColumn(
                    name=column.name,
                    role=column.role,
                    data_type=column.data_type,
                    is_nullable=column.is_nullable,
                    position=column.position,
                )
                for column in context.columns
            )
            dataset = validate_snapshot_dataset(
                snapshot_path,
                trusted_columns,
                expected_row_count=worker_input.snapshot.rowCount,
                max_rows=self._config.max_snapshot_rows,
                on_batch=heartbeat,
            )
            self._check_runtime()

            output = self._fake_trainer.train(
                worker_input, dataset, on_progress=heartbeat
            )
            try:
                self._check_runtime()
                validate_fake_result(
                    self._config.worker_id, worker_input, output.success_payload
                )
                self._update_progress(
                    job,
                    TRAINING_PROGRESS_PERCENT,
                    TRAINING_PROGRESS_MESSAGE,
                )
            finally:
                output.artifact_path.unlink(missing_ok=True)

            self._database.transition_job(
                worker_id=self._config.worker_id,
                schema_name=job.schema_name,
                job_id=job.id,
                current_status="running",
                next_status="succeeded",
                progress_percent=SUCCESS_PROGRESS_PERCENT,
                progress_message=SUCCESS_PROGRESS_MESSAGE,
                error_code=None,
                error_message=None,
            )
        except (JobOwnershipError, JobStateConflictError):
            raise
        except WorkerError as exc:
            self._mark_failed(job, exc.code, exc.message)
        self._logger.info(
            "worker %s finished training job %s", self._config.worker_id, job.id
        )

    def _make_heartbeat(self, job: ClaimedJob) -> Callable[[], None]:
        """Return a throttled heartbeat that keeps the claimed job alive."""

        def _heartbeat() -> None:
            self._check_runtime()
            self._maybe_heartbeat(job)

        return _heartbeat

    def _check_runtime(self) -> None:
        if self._now() - self._runtime_deadline >= 0:
            raise JobRuntimeExceededError(
                "Training job exceeded its maximum runtime"
            )

    def _maybe_heartbeat(self, job: ClaimedJob) -> None:
        """Refresh ``heartbeat_at`` when the interval threshold is due.

        This re-persists the current progress phase (unchanged percent and
        message) so long checksum reads, batch validation, and statistics stay
        within the claimed worker's heartbeat window without spamming the
        database on every chunk or batch.
        """
        now = self._now()
        if now - self._last_heartbeat_at < self._heartbeat_due_after:
            return
        self._last_heartbeat_at = now
        self._database.update_job_progress(
            worker_id=self._config.worker_id,
            schema_name=job.schema_name,
            job_id=job.id,
            progress_percent=self._progress_percent,
            progress_message=self._progress_message,
        )

    def _update_progress(self, job: ClaimedJob, percent: int, message: str) -> None:
        self._database.update_job_progress(
            worker_id=self._config.worker_id,
            schema_name=job.schema_name,
            job_id=job.id,
            progress_percent=percent,
            progress_message=message,
        )
        self._progress_percent = percent
        self._progress_message = message
        self._last_heartbeat_at = self._now()

    def _mark_failed(self, job: ClaimedJob, code: str, message: str) -> None:
        bounded_message = message[: _MAX_ERROR_MESSAGE_LENGTH]
        self._database.transition_job(
            worker_id=self._config.worker_id,
            schema_name=job.schema_name,
            job_id=job.id,
            current_status="running",
            next_status="failed",
            progress_percent=self._progress_percent,
            progress_message=FAILED_PROGRESS_MESSAGE,
            error_code=code,
            error_message=bounded_message,
        )
        self._logger.warning(
            "training job %s failed with %s", job.id, code
        )


def create_executor(config: WorkerConfig, database: Database) -> JobExecutor:
    """Create the default executor used by the worker entrypoint."""
    return JobExecutor(config, database)
