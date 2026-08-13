import os
import signal
import sys
import threading
import time

import pytest

import worker
from worker.__main__ import main
from worker.config import WorkerConfig
from worker.database import Database


class StubDatabase(Database):
    def __init__(self):
        super().__init__("unused-connection-string", "worker-test")
        self.closed = False

    def connect(self):
        pass

    def ping(self):
        pass

    def close(self):
        self.closed = True


def make_config():
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-test",
        poll_interval_seconds=30,
        heartbeat_interval_seconds=10,
        artifact_storage_path="./artifacts",
        log_level="INFO",
    )


class TestEntrypoint:
    @pytest.mark.skipif(
        threading.current_thread() is not threading.main_thread(),
        reason="signal handlers only run in the main thread",
    )
    def test_main_runs_idle_and_exits_zero(self):
        database = StubDatabase()

        def _send_signal():
            time.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)

        sender = threading.Thread(target=_send_signal)
        sender.start()
        try:
            code = main(
                config=make_config(),
                database_factory=lambda _config: database,
            )
        finally:
            sender.join(timeout=5)
        assert code == 0
        assert database.closed is True

    def test_main_returns_nonzero_for_invalid_config(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setattr(
            worker.__main__, "load_dotenv", lambda *args, **kwargs: None
        )
        monkeypatch.setenv("WORKER_POLL_INTERVAL_SECONDS", "5")
        assert main() == 1

    def test_no_http_server_is_started(self):
        for name in ("http.server", "uvicorn", "flask", "aiohttp", "starlette"):
            assert name not in sys.modules, f"{name} must not be imported"