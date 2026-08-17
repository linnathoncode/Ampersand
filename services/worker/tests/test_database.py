import pytest

from worker.database import Database
from worker.errors import (
    DatabaseConnectionError,
    InvalidJobTransitionError,
    InvalidTenantSchemaError,
    JobOwnershipError,
    JobStateConflictError,
    SnapshotNotFoundError,
)

CONNECTION_STRING = "postgresql://ampersand:s3cret@localhost:5432/ampersand"

SAFE_SCHEMA = "tenant_ampersand_dev"


class FakeConnection:
    """Minimal psycopg-like connection that records operations.

    ``responses`` maps an SQL substring to either a list of rows, a
    ``{"rows": [...], "rowcount": n}`` dict, or an exception to raise when
    that statement executes.
    """

    def __init__(self, execute_error=None, responses=None):
        self.events = []
        self.in_transaction = False
        self.execute_error = execute_error
        self.responses = responses or {}
        self.closed = False

    def transaction(self):
        return _FakeTransaction(self)

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        self.closed = True


class _FakeTransaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("transaction_begin")
        self.connection.in_transaction = True
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.connection.events.append("transaction_commit")
        else:
            self.connection.events.append("transaction_rollback")
        self.connection.in_transaction = False
        return False


class _FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self._queue = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.connection.events.append(("execute", sql))
        if self.connection.execute_error is not None:
            raise self.connection.execute_error
        for fragment, response in self.connection.responses.items():
            if fragment in sql:
                if isinstance(response, Exception):
                    raise response
                if isinstance(response, list):
                    self._queue = list(response)
                    self.rowcount = len(response)
                else:
                    self._queue = list(response.get("rows", []))
                    self.rowcount = response.get(
                        "rowcount", len(self._queue)
                    )
                return
        self._queue = []
        self.rowcount = 0

    def fetchone(self):
        if self._queue:
            return self._queue.pop(0)
        return None

    def fetchall(self):
        rows = self._queue
        self._queue = []
        return rows


def make_database(connection=None):
    database = Database(CONNECTION_STRING, application_name="worker-test")
    database._connection = connection
    return database


def executed_sql(connection):
    return [
        sql
        for event in connection.events
        if isinstance(event, tuple) and event[0] == "execute"
        for sql in [event[1]]
    ]


class TestConnect:
    def test_unreachable_database_raises_structured_error(self):
        database = Database(
            "postgresql://u:p@127.0.0.1:1/unused", application_name="worker-test"
        )
        with pytest.raises(DatabaseConnectionError):
            database.connect()

    def test_connection_string_is_never_leaked(self):
        database = Database(
            "postgresql://u:p@127.0.0.1:1/unused", application_name="worker-test"
        )
        with pytest.raises(DatabaseConnectionError) as excinfo:
            database.connect()
        assert "u:p@127.0.0.1:1" not in str(excinfo.value)


class TestPing:
    def test_ping_runs_select_1_inside_a_transaction(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.ping()

        assert connection.events == [
            "transaction_begin",
            ("execute", "SELECT 1"),
            "transaction_commit",
        ]

    def test_ping_leaves_no_open_transaction(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.ping()

        assert connection.in_transaction is False

    def test_ping_failure_exits_transaction_and_raises(self):
        connection = FakeConnection(execute_error=RuntimeError("boom"))
        database = make_database(connection)

        with pytest.raises(DatabaseConnectionError):
            database.ping()

        assert connection.events[0] == "transaction_begin"
        assert connection.events[-1] == "transaction_rollback"
        assert connection.in_transaction is False

    def test_ping_without_connection_raises(self):
        database = make_database(None)
        with pytest.raises(DatabaseConnectionError):
            database.ping()


class TestClose:
    def test_close_is_idempotent(self):
        connection = FakeConnection()
        database = make_database(connection)

        database.close()
        database.close()

        assert connection.closed is True

    def test_close_without_connection_is_safe(self):
        database = make_database(None)
        database.close()


class TestActiveTenantSchemas:
    def test_lists_validated_registry_schemas(self):
        connection = FakeConnection(
            responses={
                "main.tenants": {
                    "rows": [("tenant_ampersand_dev",), ("tenant_b",)]
                }
            }
        )
        database = make_database(connection)

        assert database.active_tenant_schemas() == [
            "tenant_ampersand_dev",
            "tenant_b",
        ]
        assert connection.events[-1] == "transaction_commit"

    def test_rejects_unsafe_schema_from_registry(self):
        connection = FakeConnection(
            responses={"main.tenants": {"rows": [("tenant_a; drop",)]}}
        )
        database = make_database(connection)

        with pytest.raises(InvalidTenantSchemaError):
            database.active_tenant_schemas()

    def test_requires_connection(self):
        database = make_database(None)
        with pytest.raises(DatabaseConnectionError):
            database.active_tenant_schemas()


class TestClaimNextJob:
    def test_claim_returns_job_with_ownership_fields(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {
                    "rows": [
                        (
                            "job-1",
                            "a" * 64,
                            "snap-1",
                            {"algorithmPolicy": "automatic-regression"},
                            60,
                        )
                    ],
                    "rowcount": 1,
                }
            }
        )
        database = make_database(connection)

        job = database.claim_next_job("worker-a", SAFE_SCHEMA)

        assert job is not None
        assert job.id == "job-1"
        assert job.fingerprint == "a" * 64
        assert job.dataset_snapshot_id == "snap-1"
        assert job.max_runtime_seconds == 60
        assert job.schema_name == SAFE_SCHEMA

        sql = executed_sql(connection)
        assert any("FOR UPDATE SKIP LOCKED" in statement for statement in sql)
        assert any(
            f'SET LOCAL search_path TO "{SAFE_SCHEMA}"' in statement
            for statement in sql
        )
        assert connection.events[-1] == "transaction_commit"
        assert connection.in_transaction is False

    def test_claim_empty_queue_returns_none(self):
        connection = FakeConnection(
            responses={"UPDATE training_jobs": {"rows": [], "rowcount": 0}}
        )
        database = make_database(connection)

        assert database.claim_next_job("worker-a", SAFE_SCHEMA) is None

    def test_claim_failure_rolls_back_and_raises(self):
        connection = FakeConnection(
            responses={"UPDATE training_jobs": RuntimeError("boom")}
        )
        database = make_database(connection)

        with pytest.raises(DatabaseConnectionError):
            database.claim_next_job("worker-a", SAFE_SCHEMA)

        assert connection.events[-1] == "transaction_rollback"
        assert connection.in_transaction is False

    def test_claim_rejects_unsafe_schema_without_querying(self):
        connection = FakeConnection()
        database = make_database(connection)

        with pytest.raises(InvalidTenantSchemaError):
            database.claim_next_job("worker-a", "bad; DROP TABLE")

        assert connection.events == []

    def test_claim_without_connection_raises(self):
        database = make_database(None)
        with pytest.raises(DatabaseConnectionError):
            database.claim_next_job("worker-a", SAFE_SCHEMA)


class TestTransitionJob:
    def _transition(self, database, **overrides):
        params = {
            "worker_id": "worker-a",
            "schema_name": SAFE_SCHEMA,
            "job_id": "job-1",
            "current_status": "running",
            "next_status": "succeeded",
            "progress_percent": 100,
            "progress_message": "done",
        }
        params.update(overrides)
        database.transition_job(**params)

    def test_successful_transition_commits(self):
        connection = FakeConnection(
            responses={"UPDATE training_jobs": {"rowcount": 1}}
        )
        database = make_database(connection)

        self._transition(database)

        sql = executed_sql(connection)
        assert any("UPDATE training_jobs" in statement for statement in sql)
        assert connection.events[-1] == "transaction_commit"
        assert connection.in_transaction is False

    def test_transition_from_terminal_state_is_rejected_before_sql(self):
        connection = FakeConnection()
        database = make_database(connection)

        with pytest.raises(InvalidJobTransitionError):
            self._transition(
                database,
                current_status="succeeded",
                next_status="running",
            )

        assert connection.events == []

    @pytest.mark.parametrize(
        ("current_status", "next_status"),
        [
            ("queued", "cancelled"),
            ("running", "cancelled"),
            ("running", "dead"),
        ],
    )
    def test_nucleus_owned_transitions_are_rejected_before_sql(
        self, current_status, next_status
    ):
        connection = FakeConnection()
        database = make_database(connection)

        with pytest.raises(InvalidJobTransitionError):
            self._transition(
                database,
                current_status=current_status,
                next_status=next_status,
            )

        assert connection.events == []

    def test_worker_failure_transition_is_allowed(self):
        connection = FakeConnection(
            responses={"UPDATE training_jobs": {"rowcount": 1}}
        )
        database = make_database(connection)

        self._transition(
            database,
            current_status="running",
            next_status="failed",
            progress_percent=0,
            progress_message="Training job failed",
            error_code="WORKER_HANDLER_FAILED",
            error_message="The worker failed while processing the training job",
        )

        assert connection.events[-1] == "transaction_commit"
        assert connection.in_transaction is False

    def test_wrong_worker_raises_ownership_error(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {"rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("running", "worker-b")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(JobOwnershipError):
            self._transition(database, worker_id="worker-a")

    def test_state_conflict_raises_conflict_error(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {"rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("succeeded", "worker-a")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(JobStateConflictError):
            self._transition(
                database, current_status="running", next_status="failed"
            )

    def test_missing_job_raises_ownership_error(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {"rowcount": 0},
                "SELECT status, claimed_by": {"rows": [], "rowcount": 0},
            }
        )
        database = make_database(connection)

        with pytest.raises(JobOwnershipError):
            self._transition(database)

    def test_transition_rejects_unsafe_schema(self):
        connection = FakeConnection()
        database = make_database(connection)

        with pytest.raises(InvalidTenantSchemaError):
            self._transition(database, schema_name="bad; DROP TABLE")

        assert connection.events == []


def context_row(*, column_name, role, data_type, is_nullable, position):
    return (
        "job-1",
        "a" * 64,
        {"algorithmPolicy": "automatic-regression"},
        60,
        "snap-1",
        "snapshot.parquet",
        "parquet",
        "b" * 64,
        5,
        "def-1",
        SAFE_SCHEMA,
        "energy_readings",
        "energy_usage",
        "recorded_at",
        column_name,
        role,
        data_type,
        is_nullable,
        position,
    )


CONTEXT_COLUMN_ROWS = [
    context_row(column_name="temperature", role="feature", data_type="number", is_nullable=False, position=0),
    context_row(column_name="occupancy", role="feature", data_type="integer", is_nullable=False, position=1),
    context_row(column_name="energy_usage", role="target", data_type="number", is_nullable=False, position=2),
    context_row(column_name="recorded_at", role="time", data_type="datetime", is_nullable=False, position=3),
]


class TestLoadJobExecutionContext:
    def test_loads_snapshot_and_dataset_metadata(self):
        connection = FakeConnection(
            responses={"JOIN dataset_snapshots": {"rows": CONTEXT_COLUMN_ROWS}}
        )
        database = make_database(connection)

        context = database.load_job_execution_context(
            "worker-a", SAFE_SCHEMA, "job-1"
        )

        assert context.job_id == "job-1"
        assert context.job_fingerprint == "a" * 64
        assert context.snapshot_uri == "snapshot.parquet"
        assert context.snapshot_content_sha256 == "b" * 64
        assert context.snapshot_row_count == 5
        assert context.dataset_definition_id == "def-1"
        assert context.time_column == "recorded_at"
        assert [column.name for column in context.columns] == [
            "temperature",
            "occupancy",
            "energy_usage",
            "recorded_at",
        ]
        assert connection.events[-1] == "transaction_commit"
        assert connection.in_transaction is False

    def test_uses_tenant_search_path(self):
        connection = FakeConnection(
            responses={"JOIN dataset_snapshots": {"rows": CONTEXT_COLUMN_ROWS}}
        )
        database = make_database(connection)

        database.load_job_execution_context("worker-a", SAFE_SCHEMA, "job-1")

        sql = executed_sql(connection)
        assert any(
            f'SET LOCAL search_path TO "{SAFE_SCHEMA}"' in statement
            for statement in sql
        )

    def test_missing_context_with_wrong_owner_raises(self):
        connection = FakeConnection(
            responses={
                "JOIN dataset_snapshots": {"rows": [], "rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("running", "worker-b")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(JobOwnershipError):
            database.load_job_execution_context(
                "worker-a", SAFE_SCHEMA, "job-1"
            )

    def test_missing_snapshot_raises_structured_error(self):
        connection = FakeConnection(
            responses={
                "JOIN dataset_snapshots": {"rows": [], "rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("running", "worker-a")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(SnapshotNotFoundError):
            database.load_job_execution_context(
                "worker-a", SAFE_SCHEMA, "job-1"
            )

class TestUpdateJobProgress:
    def test_progress_update_commits(self):
        connection = FakeConnection(
            responses={"UPDATE training_jobs": {"rowcount": 1}}
        )
        database = make_database(connection)

        database.update_job_progress(
            worker_id="worker-a",
            schema_name=SAFE_SCHEMA,
            job_id="job-1",
            progress_percent=50,
            progress_message="validating",
        )

        sql = executed_sql(connection)
        assert any("UPDATE training_jobs" in statement for statement in sql)
        assert connection.events[-1] == "transaction_commit"
        assert connection.in_transaction is False

    def test_wrong_worker_raises_ownership_error(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {"rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("running", "worker-b")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(JobOwnershipError):
            database.update_job_progress(
                worker_id="worker-a",
                schema_name=SAFE_SCHEMA,
                job_id="job-1",
                progress_percent=50,
                progress_message="validating",
            )

    def test_terminal_job_conflict_raises(self):
        connection = FakeConnection(
            responses={
                "UPDATE training_jobs": {"rowcount": 0},
                "SELECT status, claimed_by": {
                    "rows": [("cancelled", "worker-a")],
                    "rowcount": 1,
                },
            }
        )
        database = make_database(connection)

        with pytest.raises(JobStateConflictError):
            database.update_job_progress(
                worker_id="worker-a",
                schema_name=SAFE_SCHEMA,
                job_id="job-1",
                progress_percent=50,
                progress_message="validating",
            )
