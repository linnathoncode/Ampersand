import os
import signal
import threading
import time

import pytest

from worker.config import WorkerConfig
from worker.database import Database, ClaimedJob
from worker.errors import (
    DatabaseConnectionError,
    JobStateConflictError,
    WorkerError,
)
from worker.lifecycle import (
    HANDLER_FAILED_ERROR_CODE,
    HANDLER_FAILED_ERROR_MESSAGE,
    WorkerLifecycle,
)


class StubDatabase(Database):
    """A database stand-in that records operations without touching psycopg."""

    def __init__(
        self,
        *,
        fail_ping=False,
        schemas=None,
        claimed_job=True,
        on_claim=None,
        transition_error=None,
    ):
        super().__init__("unused-connection-string", "worker-test")
        self.operations = []
        self.fail_ping = fail_ping
        self.schemas = schemas if schemas is not None else ["tenant_a"]
        self.claimed_job = claimed_job
        self.on_claim = on_claim
        self.transition_error = transition_error
        self.claim_calls = []
        self.transition_calls = []

    def connect(self):
        self.operations.append("connect")

    def ping(self):
        self.operations.append("ping")
        if self.fail_ping:
            raise DatabaseConnectionError(
                "PostgreSQL connection check failed"
            )

    def close(self):
        self.operations.append("close")

    def active_tenant_schemas(self):
        self.operations.append("active_tenant_schemas")
        return self.schemas

    def claim_next_job(self, worker_id, schema_name):
        self.operations.append(("claim_next_job", schema_name))
        self.claim_calls.append((worker_id, schema_name))
        job = None
        if self.claimed_job:
            job = ClaimedJob(
                id=f"job-{schema_name}",
                fingerprint="0" * 64,
                dataset_snapshot_id=None,
                training_config={},
                max_runtime_seconds=60,
                schema_name=schema_name,
            )
        if self.on_claim is not None:
            self.on_claim(worker_id, schema_name, job)
        return job

    def transition_job(self, **kwargs):
        self.operations.append(
            ("transition_job", kwargs["job_id"], kwargs["next_status"])
        )
        self.transition_calls.append(kwargs)
        if self.transition_error is not None:
            raise self.transition_error


class FailingClaimDatabase(StubDatabase):
    def claim_next_job(self, worker_id, schema_name):
        self.operations.append(("claim_next_job", schema_name))
        self.claim_calls.append((worker_id, schema_name))
        if self.on_claim is not None:
            self.on_claim(worker_id, schema_name, None)
        raise WorkerError("claim attempt failed")


def make_config(poll_interval=30):
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-test",
        poll_interval_seconds=poll_interval,
        heartbeat_interval_seconds=10,
        artifact_storage_path="./artifacts",
        log_level="INFO",
        nucleus_internal_url="http://nucleus-internal.test",
        nucleus_result_token="internal-secret",
    )


class TestLifecycle:
    def test_run_stays_idle_and_closes_cleanly(self):
        database = StubDatabase()
        lifecycle = WorkerLifecycle(make_config(), database)
        lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert database.operations == ["connect", "ping", "close"]

    def test_run_does_not_touch_the_job_queue(self):
        database = StubDatabase()
        lifecycle = WorkerLifecycle(make_config(), database)
        lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert set(database.operations) == {"connect", "ping", "close"}

    def test_close_is_guaranteed_on_failed_connect(self):
        database = StubDatabase()

        class FailingConnect(StubDatabase):
            def connect(self):
                self.operations.append("connect")
                raise DatabaseConnectionError("Failed to connect to PostgreSQL")

        failing = FailingConnect()
        lifecycle = WorkerLifecycle(make_config(), failing)
        assert lifecycle.run() == 1
        assert failing.operations == ["connect", "close"]

    def test_ping_failure_returns_error_status_and_closes(self):
        database = StubDatabase(fail_ping=True)
        lifecycle = WorkerLifecycle(make_config(), database)
        assert lifecycle.run() == 1
        assert database.operations == ["connect", "ping", "close"]


class TestClaimingLoop:
    def test_run_claims_a_queued_job_and_hands_it_to_the_handler(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(make_config(), database)
        received = []

        def handler(job):
            received.append(job)
            lifecycle.request_shutdown()

        lifecycle = WorkerLifecycle(make_config(), database, job_handler=handler)

        assert lifecycle.run() == 0

        assert database.claim_calls == [("worker-test", "tenant_a")]
        assert len(received) == 1
        assert received[0].schema_name == "tenant_a"
        assert "active_tenant_schemas" in database.operations
        assert ("claim_next_job", "tenant_a") in database.operations
        assert database.operations[-1] == "close"

    def test_run_without_handler_never_claims(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(make_config(poll_interval=0.1), database)

        def _stop():
            time.sleep(0.3)
            lifecycle.request_shutdown()

        thread = threading.Thread(target=_stop)
        thread.daemon = True
        thread.start()
        try:
            assert lifecycle.run() == 0
        finally:
            thread.join(timeout=5)

        assert database.claim_calls == []
        assert database.operations[-1] == "close"

    def test_run_keeps_polling_when_all_queues_are_empty(self):
        database = StubDatabase(
            schemas=["tenant_a", "tenant_b"],
            claimed_job=False,
        )
        lifecycle = WorkerLifecycle(
            make_config(), database, job_handler=lambda _job: None
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0

        assert database.claim_calls == [
            ("worker-test", "tenant_a"),
            ("worker-test", "tenant_b"),
        ]
        assert database.operations[-1] == "close"

    def test_claims_alternate_across_busy_tenants(self):
        database = StubDatabase(
            schemas=["tenant_a", "tenant_b"],
            claimed_job=True,
        )
        lifecycle = WorkerLifecycle(make_config(poll_interval=0.1), database)
        claimed_tenants = []

        def handler(job):
            claimed_tenants.append(job.schema_name)
            if len(claimed_tenants) == 3:
                lifecycle.request_shutdown()

        lifecycle = WorkerLifecycle(
            make_config(poll_interval=0.1), database, job_handler=handler
        )

        assert lifecycle.run() == 0
        assert claimed_tenants == ["tenant_a", "tenant_b", "tenant_a"]

    def test_claim_failure_is_logged_and_loop_continues(self):
        database = FailingClaimDatabase()
        lifecycle = WorkerLifecycle(
            make_config(), database, job_handler=lambda _job: None
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0

        assert database.claim_calls == [("worker-test", "tenant_a")]
        assert database.operations[-1] == "close"

    def test_no_claim_happens_when_shutdown_is_requested_before_start(self):
        database = StubDatabase(claimed_job=True)
        lifecycle = WorkerLifecycle(make_config(), database)
        lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert database.claim_calls == []
        assert database.operations == ["connect", "ping", "close"]

    def test_handler_success_does_not_create_a_failure_transition(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(
            make_config(), database, job_handler=lambda _job: None
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert database.transition_calls == []

    def test_handler_worker_error_marks_the_job_failed(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(
            make_config(),
            database,
            job_handler=lambda _job: (_ for _ in ()).throw(
                WorkerError("training failed")
            ),
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert len(database.transition_calls) == 1
        transition = database.transition_calls[0]
        assert transition["worker_id"] == "worker-test"
        assert transition["job_id"] == "job-tenant_a"
        assert transition["schema_name"] == "tenant_a"
        assert transition["current_status"] == "running"
        assert transition["next_status"] == "failed"
        assert transition["error_code"] == "WORKER_ERROR"
        assert transition["error_message"] == "training failed"

    def test_handler_generic_exception_marks_the_job_failed(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(
            make_config(),
            database,
            job_handler=lambda _job: (_ for _ in ()).throw(
                RuntimeError("boom: secret token leaked")
            ),
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert len(database.transition_calls) == 1
        transition = database.transition_calls[0]
        assert transition["error_code"] == HANDLER_FAILED_ERROR_CODE
        assert transition["error_message"] == HANDLER_FAILED_ERROR_MESSAGE
        assert "boom" not in transition["error_message"]

    def test_handler_error_message_is_bounded(self):
        database = StubDatabase(schemas=["tenant_a"], claimed_job=True)
        lifecycle = WorkerLifecycle(
            make_config(),
            database,
            job_handler=lambda _job: (_ for _ in ()).throw(
                WorkerError("x" * 5000)
            ),
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        transition = database.transition_calls[0]
        assert len(transition["error_message"]) <= 500

    def test_failure_transition_conflict_does_not_stop_the_loop(self):
        database = StubDatabase(
            schemas=["tenant_a"],
            claimed_job=True,
            transition_error=JobStateConflictError(
                "training job 'job-tenant_a' is in status 'succeeded'"
            ),
        )
        lifecycle = WorkerLifecycle(
            make_config(),
            database,
            job_handler=lambda _job: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        database.on_claim = lambda _w, _s, _j: lifecycle.request_shutdown()

        assert lifecycle.run() == 0
        assert len(database.transition_calls) == 1
        assert database.operations[-1] == "close"

    def test_failure_transition_database_error_stops_the_worker(self):
        database = StubDatabase(
            schemas=["tenant_a"],
            claimed_job=True,
            transition_error=DatabaseConnectionError("database is down"),
        )
        lifecycle = WorkerLifecycle(
            make_config(),
            database,
            job_handler=lambda _job: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        assert lifecycle.run() == 1
        assert len(database.transition_calls) == 1
        assert database.operations[-1] == "close"

    def test_round_robin_continues_after_a_handler_failure(self):
        database = StubDatabase(
            schemas=["tenant_a", "tenant_b"],
            claimed_job=True,
        )
        lifecycle = WorkerLifecycle(make_config(poll_interval=0.1), database)
        claimed_tenants = []

        def handler(job):
            claimed_tenants.append(job.schema_name)
            if len(claimed_tenants) == 3:
                lifecycle.request_shutdown()
            if job.schema_name == "tenant_a":
                raise RuntimeError("boom")

        lifecycle = WorkerLifecycle(
            make_config(poll_interval=0.1), database, job_handler=handler
        )

        assert lifecycle.run() == 0
        assert claimed_tenants == ["tenant_a", "tenant_b", "tenant_a"]
        assert [c["next_status"] for c in database.transition_calls] == [
            "failed",
            "failed",
        ]


class TestSignalHandling:
    @pytest.mark.skipif(
        threading.current_thread() is not threading.main_thread(),
        reason="signal handlers only run in the main thread",
    )
    def test_sigterm_requests_graceful_shutdown(self):
        database = StubDatabase(schemas=[], claimed_job=False)
        lifecycle = WorkerLifecycle(
            make_config(poll_interval=1),
            database,
            job_handler=lambda _job: None,
        )

        def _send_signal():
            time.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)

        sender = threading.Thread(target=_send_signal)
        sender.start()
        try:
            assert lifecycle.run() == 0
        finally:
            sender.join(timeout=5)
        assert database.operations[0:3] == [
            "connect",
            "ping",
            "active_tenant_schemas",
        ]
        assert database.operations[-1] == "close"

    def test_signal_handlers_are_restored_after_run(self):
        previous_term = signal.getsignal(signal.SIGTERM)
        database = StubDatabase()
        lifecycle = WorkerLifecycle(make_config(), database)
        lifecycle.request_shutdown()
        lifecycle.run()
        assert signal.getsignal(signal.SIGTERM) == previous_term