"""Focused tests for claimed-job execution and heartbeats."""

from __future__ import annotations

from dataclasses import replace

import pytest

from worker.config import WorkerConfig
from worker.database import (
    CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE,
    ClaimedJob,
    Database,
)
from worker.errors import JobOwnershipError
from worker.executor import (
    SNAPSHOT_VERIFIED_PROGRESS_MESSAGE,
    JobExecutor,
)

from support import make_context, make_snapshot_file, sha256_of


def config(tmp_path, heartbeat_interval_seconds=10):
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-test",
        poll_interval_seconds=30,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
        artifact_storage_path=str(tmp_path),
        log_level="INFO",
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


def test_valid_job_succeeds_and_cleans_fake_artifact(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    database = StubDatabase(valid_context(snapshot))

    JobExecutor(config(tmp_path), database).handle(claimed_job())

    assert database.transitions[-1]["next_status"] == "succeeded"
    assert [item["progress_percent"] for item in database.progress] == [50, 80]
    assert list(tmp_path.glob("*.fake.onnx")) == []


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
