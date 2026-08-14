"""Worker lifecycle: startup, poll-and-claim loop, and graceful shutdown.

Current scope: validate configuration, connect to PostgreSQL, confirm
connectivity, poll active tenant queues, and stay alive until a shutdown
signal. Claiming is only enabled when a job handler is configured, because a
claimed job must always be moved to a terminal state; without one the worker
stays idle so no job is left stuck in ``running``. Tenant queues are polled
in round-robin order so no single tenant can starve the others.

A handler may perform its own terminal transition. If a handler raises before
transitioning the job, the lifecycle attempts an ownership-guarded
``running -> failed`` transition so the job never silently stays ``running``.
Raw exception text is never persisted; a stable error code and a bounded,
generic message are stored instead. Persisted failure details are logged
separately for diagnosis. If PostgreSQL cannot record the failure, the worker
exits nonzero and the job remains recoverable work for the later recovery
scope. Heartbeats and recovery are added incrementally. The worker never
mutates the job queue outside ``FOR UPDATE SKIP LOCKED`` claiming or owned
transitions.
"""

from __future__ import annotations

import logging
import signal
import threading
from collections.abc import Callable

from .config import WorkerConfig
from .database import ClaimedJob, Database
from .errors import (
    DatabaseConnectionError,
    JobOwnershipError,
    JobStateConflictError,
    WorkerError,
)

HANDLER_FAILED_ERROR_CODE = "WORKER_HANDLER_FAILED"
HANDLER_FAILED_ERROR_MESSAGE = (
    "The worker failed while processing the training job"
)
_MAX_ERROR_MESSAGE_LENGTH = 500


class WorkerLifecycle:
    def __init__(
        self,
        config: WorkerConfig,
        database: Database,
        job_handler: Callable[[ClaimedJob], None] | None = None,
    ) -> None:
        self._config = config
        self._database = database
        self._job_handler = job_handler
        self._tenant_cursor = 0
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
                "worker polling; poll interval %ss, claim timeout %ss",
                self._config.poll_interval_seconds,
                self._config.claim_timeout_seconds,
            )
            while not self._shutdown.is_set():
                self._claim_one_job()
                if self._shutdown.wait(
                    timeout=self._config.poll_interval_seconds
                ):
                    break

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

    def _claim_one_job(self) -> None:
        """Claim one queued job fairly across the active tenant queues.

        Only claims when a job handler is configured; without one the worker
        stays idle. The claimed job is handed to the handler, which is
        responsible for reaching a terminal state. The next poll starts after
        the tenant that was just claimed so busy tenants rotate instead of
        starving the rest.
        """
        if self._job_handler is None:
            return

        try:
            schemas = self._database.active_tenant_schemas()
        except WorkerError as exc:
            self._logger.warning(
                "claim attempt failed: %s: %s", exc.code, exc.message
            )
            return

        if not schemas:
            self._tenant_cursor = 0
            return

        count = len(schemas)
        start = self._tenant_cursor % count
        for offset in range(count):
            index = (start + offset) % count
            schema_name = schemas[index]
            try:
                job = self._database.claim_next_job(
                    self._config.worker_id, schema_name
                )
            except WorkerError as exc:
                self._logger.warning(
                    "claim on %s failed: %s: %s",
                    schema_name,
                    exc.code,
                    exc.message,
                )
                self._tenant_cursor = (index + 1) % count
                return
            if job is not None:
                self._tenant_cursor = (index + 1) % count
                self._logger.info(
                    "worker %s claimed training job %s in tenant schema %s",
                    self._config.worker_id,
                    job.id,
                    schema_name,
                )
                self._handle_claimed_job(job)
                return

        self._tenant_cursor = 0

    def _handle_claimed_job(self, job: ClaimedJob) -> None:
        """Invoke the handler and recover from unexpected handler failures.

        A handler may reach a terminal state itself. When it raises, the
        lifecycle attempts an ownership-guarded ``running -> failed``
        transition so the claimed job never silently stays ``running``.
        """
        try:
            self._job_handler(job)
        except WorkerError as exc:
            self._logger.warning(
                "handler failed for training job %s: %s: %s",
                job.id,
                exc.code,
                exc.message,
            )
            self._mark_handler_failure(job, code=exc.code, message=exc.message)
        except Exception:
            self._logger.exception(
                "unexpected handler failure for training job %s", job.id
            )
            self._mark_handler_failure(
                job,
                code=HANDLER_FAILED_ERROR_CODE,
                message=HANDLER_FAILED_ERROR_MESSAGE,
            )

    def _mark_handler_failure(
        self, job: ClaimedJob, *, code: str, message: str
    ) -> None:
        """Persist ``running -> failed`` for a job whose handler raised.

        Raw exception text is never stored; the message is bounded and the
        error code is stable. A job that was already moved to another state
        by a concurrent path is left untouched. A database failure during the
        fallback is surfaced so the worker exits nonzero instead of pretending
        the job was handled.
        """
        bounded_message = message[: _MAX_ERROR_MESSAGE_LENGTH]
        try:
            self._database.transition_job(
                worker_id=self._config.worker_id,
                schema_name=job.schema_name,
                job_id=job.id,
                current_status="running",
                next_status="failed",
                progress_percent=0,
                progress_message="Training job failed",
                error_code=code,
                error_message=bounded_message,
            )
        except (JobOwnershipError, JobStateConflictError) as exc:
            self._logger.warning(
                "handler failed for training job %s but the job was already "
                "changed: %s: %s",
                job.id,
                exc.code,
                exc.message,
            )
            return
        self._logger.warning(
            "training job %s marked failed after handler error %s",
            job.id,
            code,
        )

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