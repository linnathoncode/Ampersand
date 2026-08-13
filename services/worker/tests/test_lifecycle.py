import os
import signal
import threading
import time

import pytest

from worker.config import WorkerConfig
from worker.database import Database
from worker.errors import DatabaseConnectionError
from worker.lifecycle import WorkerLifecycle


class StubDatabase(Database):
    """A database stand-in that records operations without touching psycopg."""

    def __init__(self, *, fail_ping=False):
        super().__init__("unused-connection-string", "worker-test")
        self.operations = []
        self.fail_ping = fail_ping

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


def make_config(poll_interval=30):
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-test",
        poll_interval_seconds=poll_interval,
        heartbeat_interval_seconds=10,
        artifact_storage_path="./artifacts",
        log_level="INFO",
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


class TestSignalHandling:
    @pytest.mark.skipif(
        threading.current_thread() is not threading.main_thread(),
        reason="signal handlers only run in the main thread",
    )
    def test_sigterm_requests_graceful_shutdown(self):
        database = StubDatabase()
        lifecycle = WorkerLifecycle(make_config(poll_interval=1), database)

        def _send_signal():
            time.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)

        sender = threading.Thread(target=_send_signal)
        sender.start()
        try:
            assert lifecycle.run() == 0
        finally:
            sender.join(timeout=5)
        assert database.operations == ["connect", "ping", "close"]

    def test_signal_handlers_are_restored_after_run(self):
        previous_term = signal.getsignal(signal.SIGTERM)
        database = StubDatabase()
        lifecycle = WorkerLifecycle(make_config(), database)
        lifecycle.request_shutdown()
        lifecycle.run()
        assert signal.getsignal(signal.SIGTERM) == previous_term