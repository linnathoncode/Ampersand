"""Worker lifecycle: startup, idle polling, and graceful shutdown.

Current scope: validate configuration, connect to PostgreSQL, confirm
connectivity, stay idle until a shutdown signal, then close cleanly. The
worker does not claim jobs, mutate the job queue, or start any HTTP server.
"""

from __future__ import annotations

import logging
import signal
import threading

from .config import WorkerConfig
from .database import Database
from .errors import WorkerError


class WorkerLifecycle:
    def __init__(self, config: WorkerConfig, database: Database) -> None:
        self._config = config
        self._database = database
        self._shutdown = threading.Event()
        self._logger = logging.getLogger("worker.lifecycle")

    def request_shutdown(self) -> None:
        """Request a graceful shutdown; idempotent and signal-safe."""
        self._shutdown.set()

    def run(self) -> int:
        previous_handlers: dict[int, object] = {}
        try:
            previous_handlers = self._install_signal_handlers()

            self._logger.info(
                "worker %s starting", self._config.worker_id
            )
            self._database.connect()
            self._database.ping()
            self._logger.info("connected to PostgreSQL")

            self._logger.info(
                "worker idle; polling interval %ss",
                self._config.poll_interval_seconds,
            )
            while not self._shutdown.wait(
                timeout=self._config.poll_interval_seconds
            ):
                pass

            self._logger.info("shutdown requested; exiting cleanly")
            return 0
        except WorkerError as exc:
            self._logger.error("%s: %s", exc.code, exc.message)
            return 1
        except Exception:
            self._logger.exception("unexpected worker failure")
            return 1
        finally:
            self._restore_signal_handlers(previous_handlers)
            self._database.close()

    def _install_signal_handlers(self) -> dict[int, object]:
        previous: dict[int, object] = {}
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                previous[sig] = signal.signal(
                    sig, self._make_shutdown_handler()
                )
            except ValueError:
                self._logger.debug(
                    "cannot install handler for signal %s (not main thread)",
                    sig,
                )
        return previous

    def _make_shutdown_handler(self):
        def _handle(_signum, _frame) -> None:
            self.request_shutdown()

        return _handle

    @staticmethod
    def _restore_signal_handlers(previous: dict[int, object]) -> None:
        for sig, handler in previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, TypeError):
                pass