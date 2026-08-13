"""Direct PostgreSQL access for the private worker.

The worker connects straight to PostgreSQL (the durable job queue) and must
never expose a public HTTP endpoint. This module only manages connectivity
and health checks; job claiming with ``FOR UPDATE SKIP LOCKED`` is added
incrementally. The connection string is never included in error messages.
"""

from __future__ import annotations

from .errors import DatabaseConnectionError, WorkerError

_CONNECT_TIMEOUT_SECONDS = 2


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
        connection = self._connection
        if connection is None:
            raise DatabaseConnectionError("Not connected to PostgreSQL")
        try:
            # psycopg does not autocommit by default, so an explicit
            # short-lived transaction guarantees the health check commits or
            # rolls back immediately instead of idling in an open transaction.
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
        except Exception as exc:
            raise DatabaseConnectionError(
                "PostgreSQL connection check failed"
            ) from exc

    def close(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass