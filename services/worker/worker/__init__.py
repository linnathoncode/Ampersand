"""Ampersand private ML worker.

This package is private training code only. It must never expose a public
HTTP endpoint and it must never make authorization decisions. All authority
is granted by the API through trusted job, snapshot, and tenant metadata.
"""

from .errors import (
    DatabaseConnectionError,
    InvalidEnvironmentValueError,
    MissingEnvironmentVariableError,
    WorkerConfigError,
    WorkerContractValidationError,
    WorkerError,
    WorkerStartupError,
)

__all__ = [
    "DatabaseConnectionError",
    "InvalidEnvironmentValueError",
    "MissingEnvironmentVariableError",
    "WorkerConfigError",
    "WorkerContractValidationError",
    "WorkerError",
    "WorkerStartupError",
]

__version__ = "0.1.0"