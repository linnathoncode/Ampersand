"""Direct PostgreSQL access for the private worker.

The worker connects straight to PostgreSQL (the durable job queue) and must
never expose a public HTTP endpoint. This module manages connectivity, health
and health checks, and job claiming with ``FOR UPDATE SKIP LOCKED``.
Candidate model registration lives on the Nucleus side; this module only
owns the worker's queue operations. Tenant data lives in per-tenant schemas,
so every job operation runs inside a transaction scoped to one validated
tenant schema. The connection string is never included in error messages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import (
    DatabaseConnectionError,
    InvalidJobTransitionError,
    InvalidTenantSchemaError,
    JobOwnershipError,
    JobStateConflictError,
    SnapshotNotFoundError,
    WorkerError,
)
from .job_state import (
    assert_worker_owned_transition,
    is_terminal_job_status,
)

_CONNECT_TIMEOUT_SECONDS = 2

_TENANT_SCHEMA_PATTERN = re.compile(r"^[a-z_][a-z0-9_]*$")

CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE = "Training job claimed; preparing data"

_TENANT_SCHEMAS_SQL = (
    "SELECT schema_name FROM main.tenants "
    "WHERE status = 'active' ORDER BY schema_name"
)

_CLAIM_JOB_SQL = """
    WITH candidate AS (
        SELECT id
        FROM training_jobs
        WHERE status = 'queued' AND is_active = true
        ORDER BY queued_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    UPDATE training_jobs AS tj
    SET status = 'running',
        claimed_by = %(worker_id)s,
        started_at = now(),
        heartbeat_at = now(),
        progress_percent = 0,
        progress_message = %(message)s,
        updated_at = now()
    FROM candidate
    WHERE tj.id = candidate.id
      AND tj.status = 'queued'
    RETURNING tj.id, tj.fingerprint, tj.dataset_snapshot_id,
              tj.training_config, tj.max_runtime_seconds
"""

_TRANSITION_JOB_SQL = """
    UPDATE training_jobs
    SET status = %(next_status)s,
        progress_percent = %(progress_percent)s,
        progress_message = %(progress_message)s,
        error_code = %(error_code)s,
        error_message = %(error_message)s,
        heartbeat_at = now(),
        finished_at = CASE
            WHEN %(is_terminal)s THEN now() ELSE finished_at END,
        updated_at = now()
    WHERE id = %(job_id)s
      AND claimed_by = %(worker_id)s
      AND status = %(current_status)s
"""

_LOOKUP_JOB_SQL = (
    "SELECT status, claimed_by FROM training_jobs WHERE id = %(job_id)s"
)

_LOAD_JOB_CONTEXT_SQL = """
    SELECT
        tj.id::text, tj.fingerprint, tj.training_config,
        tj.max_runtime_seconds,
        ds.id::text, ds.storage_uri, ds.storage_format,
        ds.content_sha256, ds.row_count,
        dd.id::text, dd.source_schema, dd.source_table, dd.target_column,
        dd.time_column,
        dc.column_name, dc.role, dc.data_type, dc.is_nullable, dc.position
    FROM training_jobs tj
    JOIN dataset_snapshots ds ON ds.id = tj.dataset_snapshot_id
    JOIN dataset_definitions dd ON dd.id = ds.dataset_definition_id
    LEFT JOIN dataset_columns dc ON dc.dataset_definition_id = dd.id
     AND dc.role IN ('feature', 'target', 'time')
    WHERE tj.id = %(job_id)s
      AND tj.claimed_by = %(worker_id)s
      AND tj.status = 'running'
    ORDER BY dc.position NULLS LAST
"""

_UPDATE_PROGRESS_SQL = """
    UPDATE training_jobs
    SET progress_percent = %(progress_percent)s,
        progress_message = %(progress_message)s,
        heartbeat_at = now(),
        updated_at = now()
    WHERE id = %(job_id)s
      AND claimed_by = %(worker_id)s
      AND status = 'running'
"""

@dataclass(frozen=True)
class DatasetColumn:
    """A trusted dataset column loaded for the worker boundary."""

    name: str
    role: str
    data_type: str
    is_nullable: bool
    position: int


@dataclass(frozen=True)
class JobExecutionContext:
    """Trusted job, snapshot, and dataset metadata for one claimed job."""

    job_id: str
    job_fingerprint: str
    training_config: object
    max_runtime_seconds: int
    snapshot_id: str
    snapshot_uri: str
    snapshot_format: str
    snapshot_content_sha256: str
    snapshot_row_count: int
    dataset_definition_id: str
    source_schema: str
    source_table: str
    target_column: str | None
    time_column: str | None
    columns: tuple[DatasetColumn, ...]
    schema_name: str


@dataclass(frozen=True)
class ClaimedJob:
    """A job row locked and moved to ``running`` by one worker."""

    id: str
    fingerprint: str
    dataset_snapshot_id: str | None
    training_config: object
    max_runtime_seconds: int
    schema_name: str



class Database:
    """Owns a single PostgreSQL connection used by the worker process."""

    def __init__(self, connection_string: str, application_name: str) -> None:
        self._connection_string = connection_string
        self._application_name = application_name
        self._connection = None

    def connect(self) -> None:
        try:
            import psycopg
        except ImportError as exc:
            raise WorkerError(
                "psycopg is not installed; run pip install -r services/worker/requirements.txt"
            ) from exc

        try:
            self._connection = psycopg.connect(
                self._connection_string,
                application_name=self._application_name,
                connect_timeout=_CONNECT_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to connect to PostgreSQL"
            ) from exc

    def ping(self) -> None:
        connection = self._require_connection()
        try:
            # psycopg does not autocommit by default, so an explicit
            # short-lived transaction guarantees the health check commits or
            # rolls back immediately instead of idling in an open transaction.
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
        except DatabaseConnectionError:
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "PostgreSQL connection check failed"
            ) from exc

    def active_tenant_schemas(self) -> list[str]:
        """Return the validated active tenant schema names from the registry."""
        connection = self._require_connection()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(_TENANT_SCHEMAS_SQL)
                    schemas = [row[0] for row in cursor.fetchall()]
        except DatabaseConnectionError:
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to list active tenant schemas"
            ) from exc

        for schema in schemas:
            _assert_tenant_schema_name(schema)
        return schemas

    def claim_next_job(self, worker_id: str, schema_name: str) -> ClaimedJob | None:
        """Atomically claim one queued job in a tenant schema.

        Returns ``None`` when the tenant queue is empty. Concurrent workers
        cannot claim the same row because the candidate rows are locked with
        ``FOR UPDATE SKIP LOCKED`` inside a single transaction.
        """
        _assert_tenant_schema_name(schema_name)
        connection = self._require_connection()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _scope_tenant(cursor, schema_name)
                    cursor.execute(
                        _CLAIM_JOB_SQL,
                        {
                            "worker_id": worker_id,
                            "message": CLAIMED_TRAINING_JOB_PROGRESS_MESSAGE,
                        },
                    )
                    row = cursor.fetchone()
                    if row is None:
                        return None
                    return ClaimedJob(
                        id=row[0],
                        fingerprint=row[1],
                        dataset_snapshot_id=row[2],
                        training_config=row[3],
                        max_runtime_seconds=row[4],
                        schema_name=schema_name,
                    )
        except DatabaseConnectionError:
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to claim a training job"
            ) from exc

    def transition_job(
        self,
        *,
        worker_id: str,
        schema_name: str,
        job_id: str,
        current_status: str,
        next_status: str,
        progress_percent: int,
        progress_message: str,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """Move a claimed job between allowed states.

        The transition must be valid in the lifecycle and owned by the worker,
        so Nucleus-owned moves such as ``running -> cancelled`` or
        ``running -> dead`` are rejected before any SQL runs. The update is
        then conditional on the job being owned by ``worker_id`` and currently
        in ``current_status``, so a stale or foreign worker can never mutate
        the job. Terminal states reject every transition before any SQL runs.
        """
        assert_worker_owned_transition(current_status, next_status)
        _assert_tenant_schema_name(schema_name)
        connection = self._require_connection()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _scope_tenant(cursor, schema_name)
                    cursor.execute(
                        _TRANSITION_JOB_SQL,
                        {
                            "worker_id": worker_id,
                            "job_id": job_id,
                            "current_status": current_status,
                            "next_status": next_status,
                            "is_terminal": is_terminal_job_status(next_status),
                            "progress_percent": progress_percent,
                            "progress_message": progress_message,
                            "error_code": error_code,
                            "error_message": error_message,
                        },
                    )
                    if cursor.rowcount == 0:
                        self._raise_conflict(cursor, job_id, current_status)
        except (
            DatabaseConnectionError,
            InvalidJobTransitionError,
            JobOwnershipError,
            JobStateConflictError,
        ):
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to update the training job"
            ) from exc

    def load_job_execution_context(
        self,
        worker_id: str,
        schema_name: str,
        job_id: str,
    ) -> JobExecutionContext:
        """Load the trusted execution context for a claimed running job.

        The snapshot and dataset metadata are resolved from the job's own
        ``dataset_snapshot_id`` inside the tenant schema, never from an
        external request. Ownership and state are re-validated so a stale or
        foreign worker cannot read context for a job it no longer owns.
        """
        _assert_tenant_schema_name(schema_name)
        connection = self._require_connection()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _scope_tenant(cursor, schema_name)
                    cursor.execute(
                        _LOAD_JOB_CONTEXT_SQL,
                        {"worker_id": worker_id, "job_id": job_id},
                    )
                    rows = cursor.fetchall()
                    if not rows:
                        self._raise_context_missing(
                            cursor, job_id, worker_id
                        )

                    first = rows[0]
                    columns: list[DatasetColumn] = []
                    for row in rows:
                        column_name = row[14]
                        if column_name is None:
                            continue
                        columns.append(
                            DatasetColumn(
                                name=column_name,
                                role=row[15],
                                data_type=row[16],
                                is_nullable=row[17],
                                position=row[18],
                            )
                        )
                    return JobExecutionContext(
                        job_id=first[0],
                        job_fingerprint=first[1],
                        training_config=first[2],
                        max_runtime_seconds=first[3],
                        snapshot_id=first[4],
                        snapshot_uri=first[5],
                        snapshot_format=first[6],
                        snapshot_content_sha256=first[7],
                        snapshot_row_count=first[8],
                        dataset_definition_id=first[9],
                        source_schema=first[10],
                        source_table=first[11],
                        target_column=first[12],
                        time_column=first[13],
                        columns=tuple(columns),
                        schema_name=schema_name,
                    )
        except (
            DatabaseConnectionError,
            InvalidTenantSchemaError,
            JobOwnershipError,
            JobStateConflictError,
            SnapshotNotFoundError,
        ):
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to load the training job context"
            ) from exc

    def update_job_progress(
        self,
        *,
        worker_id: str,
        schema_name: str,
        job_id: str,
        progress_percent: int,
        progress_message: str,
    ) -> None:
        """Persist an ownership-guarded progress update for a running job.

        The update is conditional on the job being owned by ``worker_id`` and
        still ``running``, so a cancelled or dead job cannot be overwritten by
        a stale worker.
        """
        _assert_tenant_schema_name(schema_name)
        connection = self._require_connection()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _scope_tenant(cursor, schema_name)
                    cursor.execute(
                        _UPDATE_PROGRESS_SQL,
                        {
                            "worker_id": worker_id,
                            "job_id": job_id,
                            "progress_percent": progress_percent,
                            "progress_message": progress_message,
                        },
                    )
                    if cursor.rowcount == 0:
                        self._raise_conflict(cursor, job_id, "running")
        except (
            DatabaseConnectionError,
            JobOwnershipError,
            JobStateConflictError,
        ):
            raise
        except Exception as exc:
            raise DatabaseConnectionError(
                "Failed to update the training job progress"
            ) from exc

    def _raise_context_missing(
        self, cursor, job_id: str, worker_id: str
    ) -> None:
        cursor.execute(_LOOKUP_JOB_SQL, {"job_id": job_id})
        row = cursor.fetchone()
        if row is None:
            raise JobOwnershipError(
                f"training job '{job_id}' was not found"
            )
        actual_status, claimed_by = row
        if actual_status != "running":
            raise JobStateConflictError(
                f"training job '{job_id}' is in status '{actual_status}', "
                "expected 'running'"
            )
        if claimed_by != worker_id:
            raise JobOwnershipError(
                f"training job '{job_id}' is claimed by '{claimed_by}', "
                "not by this worker"
            )
        raise SnapshotNotFoundError(
            "The snapshot or dataset for the training job is not available"
        )

    def _raise_conflict(
        self, cursor, job_id: str, current_status: str
    ) -> None:
        cursor.execute(_LOOKUP_JOB_SQL, {"job_id": job_id})
        row = cursor.fetchone()
        if row is None:
            raise JobOwnershipError(f"training job '{job_id}' was not found")
        actual_status, claimed_by = row
        if actual_status != current_status:
            raise JobStateConflictError(
                f"training job '{job_id}' is in status '{actual_status}', "
                f"expected '{current_status}'"
            )
        raise JobOwnershipError(
            f"training job '{job_id}' is claimed by '{claimed_by}', "
            "not by this worker"
        )

    def _require_connection(self):
        connection = self._connection
        if connection is None:
            raise DatabaseConnectionError("Not connected to PostgreSQL")
        return connection

    def close(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def _scope_tenant(cursor, schema_name: str) -> None:
    # The schema name is validated before this call, so inline quoting is safe
    # and the tenant queue is only reachable through its own search path.
    cursor.execute(f'SET LOCAL search_path TO "{schema_name}"')


def _assert_tenant_schema_name(schema_name: str) -> None:
    if _TENANT_SCHEMA_PATTERN.fullmatch(schema_name) is None:
        raise InvalidTenantSchemaError(
            f"unsafe PostgreSQL schema identifier: {schema_name}"
        )
