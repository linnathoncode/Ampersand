"""Entrypoint for the private worker (``python -m worker``).

The worker connects directly to PostgreSQL and never starts an HTTP server.
It claims queued training jobs, executes them through the deterministic fake
trainer, and reaches a terminal state before polling for the next job.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any

from dotenv import load_dotenv

from .config import WorkerConfig
from .database import Database
from .errors import WorkerError
from .executor import create_executor
from .lifecycle import WorkerLifecycle
from .logging import setup_logging

_startup_logger = logging.getLogger("worker.startup")


def create_database(config: WorkerConfig) -> Database:
    return Database(
        config.database_url, application_name=config.worker_id
    )


def create_lifecycle(config: WorkerConfig, database: Database) -> WorkerLifecycle:
    executor = create_executor(config, database)
    return WorkerLifecycle(config, database, job_handler=executor.handle)


def main(
    argv: list[str] | None = None,
    *,
    config: WorkerConfig | None = None,
    database_factory: Callable[[WorkerConfig], Database] = create_database,
) -> int:
    """Run the worker process and return its exit code."""
    load_dotenv()

    if config is None:
        try:
            config = WorkerConfig.from_env()
        except WorkerError as exc:
            _startup_logger.error("%s: %s", exc.code, exc.message)
            return 1

    setup_logging(config.log_level)
    logger = logging.getLogger("worker")

    try:
        database = database_factory(config)
        lifecycle = create_lifecycle(config, database)
        return lifecycle.run()
    except WorkerError as exc:
        logger.error("%s: %s", exc.code, exc.message)
        return 1
    except Exception:
        logger.exception("unexpected startup failure")
        return 1


if __name__ == "__main__":
    sys.exit(main())