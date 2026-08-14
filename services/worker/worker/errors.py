"""Structured worker errors.

Every failure the worker can report carries a stable, machine-readable
``code`` and a human-readable ``message``. Startup and configuration errors
may expose the relevant configuration field name but must never include
secret values such as the full database URL.
"""

from __future__ import annotations


class WorkerError(Exception):
    """Base class for all structured worker errors."""

    code = "WORKER_ERROR"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class WorkerConfigError(WorkerError):
    """Base class for configuration loading and validation failures."""

    code = "CONFIG_ERROR"


class MissingEnvironmentVariableError(WorkerConfigError):
    """A required environment variable was not provided."""

    code = "MISSING_ENV_VAR"

    def __init__(self, variable: str) -> None:
        super().__init__(f"Environment variable '{variable}' is required")
        self.variable = variable


class InvalidEnvironmentValueError(WorkerConfigError):
    """An environment variable had a malformed value."""

    code = "INVALID_ENV_VALUE"

    def __init__(self, variable: str, detail: str) -> None:
        super().__init__(
            f"Environment variable '{variable}' is invalid: {detail}"
        )
        self.variable = variable


class WorkerContractValidationError(WorkerError):
    """A trusted worker payload failed private-boundary contract validation."""

    code = "CONTRACT_VALIDATION"


class DatabaseConnectionError(WorkerError):
    """The worker could not connect to or communicate with PostgreSQL."""

    code = "DATABASE_CONNECTION"


class WorkerStartupError(WorkerError):
    """The worker failed before entering its idle runtime loop."""

    code = "STARTUP"


class InvalidTenantSchemaError(WorkerError):
    """A PostgreSQL schema name is unsafe to use as a tenant search path."""

    code = "INVALID_TENANT_SCHEMA"


class InvalidJobTransitionError(WorkerError):
    """A job tried to move between states that are not allowed."""

    code = "INVALID_JOB_TRANSITION"


class JobOwnershipError(WorkerError):
    """A worker tried to update a job it does not own."""

    code = "JOB_OWNERSHIP"


class JobStateConflictError(WorkerError):
    """A job exists but is not in the expected state for the update."""

    code = "JOB_STATE_CONFLICT"