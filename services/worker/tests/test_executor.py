"""Focused tests for claimed-job execution, submission, and heartbeats."""

from __future__ import annotations

from dataclasses import replace

import pyarrow as pa
import pytest

from worker.config import WorkerConfig
from worker.database import (
    CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE,
    ClaimedJob,
    Database,
    DatasetColumn,
)
from worker.errors import (
    JobOwnershipError,
    WorkerError,
    JobStateConflictError,
    TrainingResultSubmissionError,
    WorkerContractValidationError,
)
from worker.executor import (
    SNAPSHOT_VERIFIED_PROGRESS_MESSAGE,
    JobExecutor,
)
from worker.submission import SubmissionOutcome

from support import make_context, make_snapshot_file, sha256_of


def config(tmp_path, heartbeat_interval_seconds=10):
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-test",
        poll_interval_seconds=30,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
        artifact_storage_path=str(tmp_path),
        log_level="INFO",
        nucleus_internal_url="http://nucleus-internal.test",
        nucleus_result_token="internal-secret",
        max_snapshot_bytes=1024 * 1024,
        max_snapshot_rows=100_000,
    )


def claimed_job():
    return ClaimedJob(
        id="11111111-1111-4111-8111-111111111111",
        fingerprint="a" * 64,
        dataset_snapshot_id="22222222-2222-4222-8222-222222222222",
        training_config={},
        max_runtime_seconds=600,
        schema_name="tenant_ampersand_dev",
    )


class StubDatabase(Database):
    def __init__(self, context):
        super().__init__("unused", "worker-test")
        self.context = context
        self.progress = []
        self.transitions = []
        self.fail_progress = None
        self.fail_load = None

    def load_job_execution_context(self, worker_id, schema_name, job_id):
        if self.fail_load is not None:
            raise self.fail_load
        return self.context

    def update_job_progress(self, **kwargs):
        if self.fail_progress is not None:
            raise self.fail_progress
        self.progress.append(kwargs)

    def transition_job(self, **kwargs):
        self.transitions.append(kwargs)


class FixedClock:
    def __init__(self, step=0):
        self.value = 100.0
        self.step = step

    def __call__(self):
        value = self.value
        self.value += self.step
        return value


def valid_context(snapshot):
    return make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256=sha256_of(snapshot),
        row_count=5,
    )


def registered_outcome():
    return SubmissionOutcome(
        status="registered",
        model_version_id="model-version-1",
        version_number=1,
        storage_uri="models/dd/v1/job.onnx",
    )


def install_submitter(monkeypatch, outcomes_and_errors):
    submissions = []

    def submit(config, *, job_id, schema_name, payload, **_kwargs):
        submissions.append(
            {
                "config": config,
                "job_id": job_id,
                "schema_name": schema_name,
                "payload": payload,
            }
        )
        outcome_or_error = outcomes_and_errors.pop(0)
        if isinstance(outcome_or_error, Exception):
            raise outcome_or_error
        return outcome_or_error

    monkeypatch.setattr("worker.executor.submit_training_result", submit)
    return submissions


def test_valid_job_submits_result_and_cleans_temporary_artifact(
    tmp_path, monkeypatch
):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    submissions = install_submitter(monkeypatch, [registered_outcome()])

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert len(submissions) == 1
    assert submissions[0]["job_id"] == claimed_job().id
    assert submissions[0]["schema_name"] == "tenant_ampersand_dev"
    assert submissions[0]["payload"]["workerId"] == "worker-test"
    assert (
        submissions[0]["payload"]["fingerprint"] == "a" * 64
    )
    assert submissions[0]["payload"]["result"]["status"] == "succeeded"

    assert database.transitions == []
    assert [item["progress_percent"] for item in database.progress] == [
        50,
        65,
        80,
    ]
    assert list(tmp_path.glob("*.onnx.tmp")) == []
    assert not (tmp_path / "models").exists()


def test_submission_failure_marks_job_failed_with_server_code(
    tmp_path, monkeypatch
):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    install_submitter(
        monkeypatch,
        [
            TrainingResultSubmissionError(
                "Nucleus rejected the training result submission",
                server_error_code="MODEL_FEATURE_METADATA_INVALID",
            )
        ],
    )

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions[-1]["next_status"] == "failed"
    assert (
        database.transitions[-1]["error_code"]
        == "MODEL_FEATURE_METADATA_INVALID"
    )
    assert list(tmp_path.glob("*.onnx.tmp")) == []


def test_transport_failure_marks_job_failed_with_generic_code(
    tmp_path, monkeypatch
):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    install_submitter(
        monkeypatch,
        [
            TrainingResultSubmissionError(
                "The training result could not be submitted to Nucleus"
            )
        ],
    )

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions[-1]["next_status"] == "failed"
    assert (
        database.transitions[-1]["error_code"]
        == "TRAINING_RESULT_SUBMISSION_FAILED"
    )


def test_submission_state_conflict_propagates_unmarked(tmp_path, monkeypatch):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    install_submitter(
        monkeypatch,
        [JobStateConflictError("the job is no longer running")],
    )

    with pytest.raises(JobStateConflictError):
        JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions == []
    assert list(tmp_path.glob("*.onnx.tmp")) == []


def test_no_time_column_job_succeeds(tmp_path, monkeypatch):
    snapshot = make_snapshot_file(
        tmp_path,
        columns=[
            ("temperature", pa.float64()),
            ("energy_usage", pa.float64()),
        ],
        rows=[(21.5, 240.5), (22.0, 310.2), (19.0, 180.0)],
    )
    context = make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256=sha256_of(snapshot),
        row_count=3,
        time_column=None,
        columns=(
            DatasetColumn("temperature", "feature", "number", False, 0),
            DatasetColumn("energy_usage", "target", "number", False, 1),
        ),
    )
    database = StubDatabase(context)
    install_submitter(monkeypatch, [registered_outcome()])

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions == []
    assert [item["progress_percent"] for item in database.progress] == [
        50,
        65,
        80,
    ]


def test_validation_failure_unlinks_temp_and_does_not_submit(
    tmp_path, monkeypatch
):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    submissions = install_submitter(monkeypatch, [])

    def reject_payload(worker_id, worker_input, success_payload):
        raise WorkerContractValidationError(
            "worker payload failed contract validation: rejected"
        )

    monkeypatch.setattr(
        "worker.executor.validate_regression_result", reject_payload
    )

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert submissions == []
    assert list(tmp_path.glob("*.onnx.tmp")) == []
    assert not (tmp_path / "models").exists()


def test_missing_timestamps_mark_job_failed(tmp_path):
    snapshot = make_snapshot_file(
        tmp_path,
        columns=[
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ],
        rows=[
            (21.5, 3, 240.5, None),
            (22.0, 5, 310.2, 1700000060000),
        ],
    )
    context = make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256=sha256_of(snapshot),
        row_count=2,
        columns=(
            DatasetColumn("temperature", "feature", "number", False, 0),
            DatasetColumn("occupancy", "feature", "integer", False, 1),
            DatasetColumn("energy_usage", "target", "number", False, 2),
            DatasetColumn("recorded_at", "time", "datetime", True, 3),
        ),
    )
    database = StubDatabase(context)

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions[-1]["next_status"] == "failed"
    assert (
        database.transitions[-1]["error_code"]
        == "SNAPSHOT_TIME_VALUE_MISSING"
    )
    assert list(tmp_path.glob("*.onnx.tmp")) == []


def test_checksum_failure_marks_job_failed(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    context = make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256="b" * 64,
        row_count=5,
    )
    database = StubDatabase(context)

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions[-1]["next_status"] == "failed"
    assert database.transitions[-1]["error_code"] == "SNAPSHOT_CHECKSUM_MISMATCH"


def test_runtime_limit_marks_job_failed(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    job = replace(claimed_job(), max_runtime_seconds=1)

    JobExecutor(
        config(tmp_path), database, clock=FixedClock(step=2)
    ).handle(job)

    assert database.transitions[-1]["next_status"] == "failed"
    assert database.transitions[-1]["error_code"] == "JOB_RUNTIME_EXCEEDED"


def test_due_heartbeats_preserve_current_phase(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    executor = JobExecutor(
        config(tmp_path), database, clock=FixedClock(step=6)
    )

    executor.handle(claimed_job())

    assert len(database.progress) > 2
    assert any(
        item["progress_percent"] == 0
        and item["progress_message"] == CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE
        for item in database.progress
    )
    assert any(
        item["progress_percent"] == 50
        and item["progress_message"] == SNAPSHOT_VERIFIED_PROGRESS_MESSAGE
        for item in database.progress
    )


def test_heartbeat_ownership_conflict_propagates(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))
    database.fail_progress = JobOwnershipError("job ownership changed")

    with pytest.raises(JobOwnershipError):
        JobExecutor(
            config(tmp_path), database, clock=FixedClock(step=6)
        ).handle(claimed_job())


def test_trainer_crash_after_temp_write_leaves_no_artifact(
    tmp_path, monkeypatch
):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))

    class CrashAfterWriteTrainer:
        def __init__(self, storage):
            self._storage = storage

        def train(self, worker_input, dataset, split, on_progress=None):
            (self._storage / f"{worker_input.jobId}.token.onnx.tmp").write_bytes(
                b"partial model bytes"
            )
            raise WorkerError("trainer crashed after writing the artifact")

    executor = JobExecutor(config(tmp_path), database)
    executor._trainer = CrashAfterWriteTrainer(tmp_path)
    executor.handle(claimed_job())

    assert list(tmp_path.glob("*.onnx.tmp")) == []
    assert database.transitions[-1]["next_status"] == "failed"
    assert (
        database.transitions[-1]["error_code"] == "WORKER_ERROR"
    )
