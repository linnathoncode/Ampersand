"""Database-backed tests for worker claiming against real PostgreSQL.

These tests exercise the actual ``FOR UPDATE SKIP LOCKED`` claim SQL and the
ownership guards on a throwaway schema so the bootstrapped tenant is never
mutated. They are skipped when ``DATABASE_URL`` is missing or the database is
unreachable.
"""

from __future__ import annotations

import os
import secrets
import threading
from pathlib import Path

import psycopg
import pytest

from worker.config import WorkerConfig
from worker.database import CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE, Database
from worker.errors import (
    DatabaseConnectionError,
    InvalidJobTransitionError,
    InvalidTenantSchemaError,
    JobOwnershipError,
    JobStateConflictError,
    WorkerError,
)
from worker.lifecycle import (
    HANDLER_FAILED_ERROR_CODE,
    HANDLER_FAILED_ERROR_MESSAGE,
    WorkerLifecycle,
)

_TRAINING_JOBS_DDL = """
CREATE TABLE training_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint char(64) NOT NULL,
    dataset_snapshot_id uuid,
    training_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL,
    progress_percent integer NOT NULL DEFAULT 0,
    progress_message text,
    claimed_by varchar(255),
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    error_code varchar(100),
    error_message text,
    max_runtime_seconds integer NOT NULL DEFAULT 600,
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
"""


def _database_url() -> str | None:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_file = Path(__file__).resolve().parents[3] / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip()
    return None


@pytest.fixture(scope="module")
def db_url() -> str:
    url = _database_url()
    if not url:
        pytest.skip("DATABASE_URL is not set")
    try:
        connection = psycopg.connect(url, connect_timeout=2)
        connection.close()
    except Exception as exc:
        pytest.skip(f"PostgreSQL is not reachable: {exc}")
    return url


@pytest.fixture()
def admin(db_url):
    connection = psycopg.connect(db_url, autocommit=True)
    yield connection
    connection.close()


@pytest.fixture()
def tenant_schema(admin) -> str:
    schema_name = f"tmp_worker_test_{secrets.token_hex(4)}"
    with admin.transaction():
        with admin.cursor() as cursor:
            cursor.execute(f'CREATE SCHEMA "{schema_name}"')
            cursor.execute(f'SET LOCAL search_path TO "{schema_name}"')
            cursor.execute(_TRAINING_JOBS_DDL)
    yield schema_name
    with admin.cursor() as cursor:
        cursor.execute(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE')


@pytest.fixture()
def worker(db_url) -> Database:
    database = Database(db_url, application_name="worker-integration-test")
    database.connect()
    yield database
    database.close()


def insert_queued_job(admin, schema_name):
    fingerprint = secrets.token_hex(32)
    with admin.transaction():
        with admin.cursor() as cursor:
            cursor.execute(f'SET LOCAL search_path TO "{schema_name}"')
            cursor.execute(
                "INSERT INTO training_jobs "
                "(fingerprint, status, progress_percent, progress_message, queued_at) "
                "VALUES (%s, 'queued', 0, 'Waiting for a worker', now()) "
                "RETURNING id",
                (fingerprint,),
            )
            job_id = cursor.fetchone()[0]
    return job_id, fingerprint


def job_status(admin, schema_name, job_id):
    with admin.cursor() as cursor:
        cursor.execute(f'SET search_path TO "{schema_name}"')
        cursor.execute(
            "SELECT status, claimed_by, progress_percent FROM training_jobs "
            "WHERE id = %s",
            (job_id,),
        )
        return cursor.fetchone()


def make_worker_config(db_url: str, worker_id: str = "worker-a") -> WorkerConfig:
    return WorkerConfig(
        database_url=db_url,
        worker_id=worker_id,
        poll_interval_seconds=30,
        heartbeat_interval_seconds=10,
        artifact_storage_path="./artifacts",
        log_level="INFO",
    )


class TestHandlerFailurePersistence:
    def test_handler_failure_marks_job_failed(
        self, db_url, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        claimed = worker.claim_next_job("worker-a", tenant_schema)
        assert claimed is not None

        lifecycle = WorkerLifecycle(
            make_worker_config(db_url),
            worker,
            job_handler=lambda _job: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        lifecycle._handle_claimed_job(claimed)

        with admin.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{tenant_schema}"')
            cursor.execute(
                "SELECT status, claimed_by, progress_percent, error_code, "
                "error_message, finished_at IS NOT NULL "
                "FROM training_jobs WHERE id = %s",
                (job_id,),
            )
            row = cursor.fetchone()
        assert row == (
            "failed",
            "worker-a",
            0,
            HANDLER_FAILED_ERROR_CODE,
            HANDLER_FAILED_ERROR_MESSAGE,
            True,
        )

    def test_handler_worker_error_persists_code_and_message(
        self, db_url, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        claimed = worker.claim_next_job("worker-a", tenant_schema)
        assert claimed is not None

        lifecycle = WorkerLifecycle(
            make_worker_config(db_url),
            worker,
            job_handler=lambda _job: (_ for _ in ()).throw(
                WorkerError("training failed")
            ),
        )
        lifecycle._handle_claimed_job(claimed)

        with admin.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{tenant_schema}"')
            cursor.execute(
                "SELECT status, error_code, error_message FROM training_jobs "
                "WHERE id = %s",
                (job_id,),
            )
            row = cursor.fetchone()
        assert row == ("failed", "WORKER_ERROR", "training failed")

    def test_handler_failure_does_not_overwrite_terminal_job(
        self, db_url, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        claimed = worker.claim_next_job("worker-a", tenant_schema)
        assert claimed is not None
        worker.transition_job(
            worker_id="worker-a",
            schema_name=tenant_schema,
            job_id=job_id,
            current_status="running",
            next_status="succeeded",
            progress_percent=100,
            progress_message="done",
        )

        lifecycle = WorkerLifecycle(
            make_worker_config(db_url),
            worker,
            job_handler=lambda _job: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        lifecycle._handle_claimed_job(claimed)

        status, claimed_by, _ = job_status(admin, tenant_schema, job_id)
        assert status == "succeeded"
        assert claimed_by == "worker-a"


class TestClaim:
    def test_claim_sets_ownership_and_timestamps(
        self, worker, admin, tenant_schema
    ):
        job_id, fingerprint = insert_queued_job(admin, tenant_schema)

        claimed = worker.claim_next_job("worker-a", tenant_schema)

        assert claimed is not None
        assert claimed.id == job_id
        assert claimed.fingerprint == fingerprint
        assert claimed.schema_name == tenant_schema

        with admin.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{tenant_schema}"')
            cursor.execute(
                "SELECT status, claimed_by, progress_percent, progress_message, "
                "started_at IS NOT NULL, heartbeat_at IS NOT NULL, "
                "finished_at IS NULL "
                "FROM training_jobs WHERE id = %s",
                (job_id,),
            )
            row = cursor.fetchone()
        assert row == (
            "running",
            "worker-a",
            0,
            CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE,
            True,
            True,
            True,
        )

    def test_claim_empty_queue_returns_none(self, worker, tenant_schema):
        assert worker.claim_next_job("worker-a", tenant_schema) is None

    def test_concurrent_claim_gives_single_owner(
        self, db_url, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        results: dict[str, object] = {}

        def claim(worker_name):
            database = Database(db_url, application_name=worker_name)
            database.connect()
            try:
                results[worker_name] = database.claim_next_job(
                    worker_name, tenant_schema
                )
            finally:
                database.close()

        threads = [
            threading.Thread(target=claim, args=(f"worker-{i}",))
            for i in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        claimed = [name for name, value in results.items() if value is not None]
        assert len(claimed) == 1
        winner = claimed[0]

        status, claimed_by, _ = job_status(admin, tenant_schema, job_id)
        assert status == "running"
        assert claimed_by == winner

    def test_claim_rollback_leaves_job_queued(
        self, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        with admin.transaction():
            with admin.cursor() as cursor:
                cursor.execute(f'SET LOCAL search_path TO "{tenant_schema}"')
                cursor.execute(
                    "CREATE FUNCTION block_claim() RETURNS trigger AS $$ "
                    "BEGIN RAISE EXCEPTION 'forced claim failure'; END $$ "
                    "LANGUAGE plpgsql"
                )
                cursor.execute(
                    "CREATE TRIGGER block_claim BEFORE UPDATE ON training_jobs "
                    "FOR EACH ROW EXECUTE FUNCTION block_claim()"
                )

        with pytest.raises(DatabaseConnectionError):
            worker.claim_next_job("worker-a", tenant_schema)

        status, claimed_by, _ = job_status(admin, tenant_schema, job_id)
        assert status == "queued"
        assert claimed_by is None

    def test_unsafe_schema_name_is_rejected(self, worker):
        with pytest.raises(InvalidTenantSchemaError):
            worker.claim_next_job(
                "worker-a", "tenant_x; DROP TABLE training_jobs"
            )


class TestTenantIsolation:
    def test_claim_does_not_cross_tenant_boundaries(
        self, worker, admin, tenant_schema
    ):
        other_schema = f"tmp_worker_test_{secrets.token_hex(4)}"
        with admin.transaction():
            with admin.cursor() as cursor:
                cursor.execute(f'CREATE SCHEMA "{other_schema}"')
                cursor.execute(f'SET LOCAL search_path TO "{other_schema}"')
                cursor.execute(_TRAINING_JOBS_DDL)
        try:
            job_id, _ = insert_queued_job(admin, other_schema)

            assert worker.claim_next_job("worker-a", tenant_schema) is None

            claimed = worker.claim_next_job("worker-a", other_schema)
            assert claimed is not None
            assert claimed.id == job_id
        finally:
            with admin.cursor() as cursor:
                cursor.execute(
                    f'DROP SCHEMA IF EXISTS "{other_schema}" CASCADE'
                )

    def test_active_tenant_schemas_reads_registry(self, worker):
        schemas = worker.active_tenant_schemas()
        assert isinstance(schemas, list)
        assert all(
            schema.startswith("tenant_") for schema in schemas
        )


class TestTransitions:
    def test_terminal_state_is_immutable(
        self, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        worker.claim_next_job("worker-a", tenant_schema)
        worker.transition_job(
            worker_id="worker-a",
            schema_name=tenant_schema,
            job_id=job_id,
            current_status="running",
            next_status="succeeded",
            progress_percent=100,
            progress_message="done",
        )

        with pytest.raises(InvalidJobTransitionError):
            worker.transition_job(
                worker_id="worker-a",
                schema_name=tenant_schema,
                job_id=job_id,
                current_status="succeeded",
                next_status="running",
                progress_percent=50,
                progress_message="cannot revert",
            )

        status, _, _ = job_status(admin, tenant_schema, job_id)
        assert status == "succeeded"

    def test_wrong_worker_cannot_update_job(
        self, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        worker.claim_next_job("worker-a", tenant_schema)

        with pytest.raises(JobOwnershipError):
            worker.transition_job(
                worker_id="worker-b",
                schema_name=tenant_schema,
                job_id=job_id,
                current_status="running",
                next_status="failed",
                progress_percent=50,
                progress_message="intruder",
            )

        status, claimed_by, _ = job_status(admin, tenant_schema, job_id)
        assert status == "running"
        assert claimed_by == "worker-a"

    def test_state_conflict_is_detected(
        self, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        worker.claim_next_job("worker-a", tenant_schema)
        with admin.transaction():
            with admin.cursor() as cursor:
                cursor.execute(f'SET LOCAL search_path TO "{tenant_schema}"')
                cursor.execute(
                    "UPDATE training_jobs SET status = 'succeeded', "
                    "finished_at = now() WHERE id = %s",
                    (job_id,),
                )

        with pytest.raises(JobStateConflictError):
            worker.transition_job(
                worker_id="worker-a",
                schema_name=tenant_schema,
                job_id=job_id,
                current_status="running",
                next_status="failed",
                progress_percent=50,
                progress_message="too late",
            )

    def test_terminal_job_cannot_be_claimed_again(
        self, worker, admin, tenant_schema
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        worker.claim_next_job("worker-a", tenant_schema)
        worker.transition_job(
            worker_id="worker-a",
            schema_name=tenant_schema,
            job_id=job_id,
            current_status="running",
            next_status="succeeded",
            progress_percent=100,
            progress_message="done",
        )

        assert worker.claim_next_job("worker-b", tenant_schema) is None

    @pytest.mark.parametrize(
        ("current_status", "next_status"),
        [("running", "cancelled"), ("running", "dead")],
    )
    def test_nucleus_owned_transition_is_rejected(
        self, worker, admin, tenant_schema, current_status, next_status
    ):
        job_id, _ = insert_queued_job(admin, tenant_schema)
        worker.claim_next_job("worker-a", tenant_schema)

        with pytest.raises(InvalidJobTransitionError):
            worker.transition_job(
                worker_id="worker-a",
                schema_name=tenant_schema,
                job_id=job_id,
                current_status=current_status,
                next_status=next_status,
                progress_percent=0,
                progress_message="not allowed",
            )

        status, claimed_by, _ = job_status(admin, tenant_schema, job_id)
        assert status == "running"
        assert claimed_by == "worker-a"