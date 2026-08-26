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


class JobRuntimeExceededError(WorkerError):
    """A claimed job exceeded its server-controlled runtime limit."""

    code = "JOB_RUNTIME_EXCEEDED"


class SnapshotError(WorkerError):
    """Base class for snapshot artifact and dataset validation failures."""

    code = "SNAPSHOT_ERROR"


class SnapshotNotFoundError(SnapshotError):
    """The referenced snapshot artifact is missing or unreachable."""

    code = "SNAPSHOT_NOT_FOUND"


class SnapshotChecksumMismatchError(SnapshotError):
    """The snapshot artifact digest does not match the trusted checksum."""

    code = "SNAPSHOT_CHECKSUM_MISMATCH"


class SnapshotSizeExceededError(SnapshotError):
    """The snapshot artifact is larger than the configured limit."""

    code = "SNAPSHOT_SIZE_EXCEEDED"


class SnapshotArtifactInvalidError(SnapshotError):
    """The snapshot artifact is not a readable Parquet file."""

    code = "SNAPSHOT_ARTIFACT_INVALID"


class SnapshotRowCountExceededError(SnapshotError):
    """The snapshot contains more rows than the configured limit."""

    code = "SNAPSHOT_ROW_COUNT_EXCEEDED"


class SnapshotRowCountMismatchError(SnapshotError):
    """The snapshot row count differs from the trusted metadata."""

    code = "SNAPSHOT_ROW_COUNT_MISMATCH"


class SnapshotEmptyError(SnapshotError):
    """The snapshot contains no rows."""

    code = "SNAPSHOT_EMPTY_TABLE"


class SnapshotColumnMissingError(SnapshotError):
    """A trusted dataset column is absent from the snapshot."""

    code = "SNAPSHOT_COLUMN_MISSING"


class SnapshotColumnOrderInvalidError(SnapshotError):
    """The snapshot columns are not in the trusted order."""

    code = "SNAPSHOT_COLUMN_ORDER_INVALID"


class SnapshotColumnTypeInvalidError(SnapshotError):
    """A snapshot column type does not match the trusted dataset column."""

    code = "SNAPSHOT_COLUMN_TYPE_INVALID"


class SnapshotTargetInvalidError(SnapshotError):
    """The training target is missing or not numeric."""

    code = "SNAPSHOT_TARGET_INVALID"


class SnapshotTimeColumnInvalidError(SnapshotError):
    """The configured time column is missing or not a datetime column."""

    code = "SNAPSHOT_TIME_COLUMN_INVALID"


class SnapshotNullabilityInvalidError(SnapshotError):
    """A non-nullable column contains missing values."""

    code = "SNAPSHOT_NULLABILITY_INVALID"


class SnapshotNonFiniteValueError(SnapshotError):
    """A numeric snapshot value is NaN or infinite."""

    code = "SNAPSHOT_NON_FINITE_VALUE"


class SnapshotCategoryCardinalityExceededError(SnapshotError):
    """A category snapshot column exceeds the unique-value safety bound."""

    code = "SNAPSHOT_CATEGORY_CARDINALITY_EXCEEDED"


class SnapshotTimeValueMissingError(SnapshotError):
    """The configured time column contains missing timestamp values."""

    code = "SNAPSHOT_TIME_VALUE_MISSING"


class SnapshotTimeValueInvalidError(SnapshotError):
    """A time column value could not be used for chronological ordering."""

    code = "SNAPSHOT_TIME_VALUE_INVALID"


class TrainingSplitError(WorkerError):
    """Base class for dataset splitting and preprocessing failures."""

    code = "TRAINING_SPLIT_ERROR"


class TrainingSplitInvalidError(TrainingSplitError):
    """The dataset could not be partitioned into train and test sets."""

    code = "TRAINING_SPLIT_INVALID"


class TrainingSplitInsufficientRowsError(TrainingSplitError):
    """The dataset has too few rows to form both partitions."""

    code = "TRAINING_SPLIT_INSUFFICIENT_ROWS"


class TrainingSplitBoundaryInvalidError(TrainingSplitError):
    """A chronological split cannot separate test rows without leaking time."""

    code = "TRAINING_SPLIT_BOUNDARY_INVALID"


class TrainingError(WorkerError):
    """Base class for real regression training failures."""

    code = "TRAINING_ERROR"


class TrainingInsufficientRowsError(TrainingError):
    """The split does not provide enough rows to fit or evaluate a model."""

    code = "TRAINING_INSUFFICIENT_ROWS"


class TrainingTargetMissingError(TrainingError):
    """The trusted target column is absent from the training or test table."""

    code = "TRAINING_TARGET_MISSING"


class TrainingTargetNullError(TrainingError):
    """The numeric target contains missing values that cannot be imputed."""

    code = "TRAINING_TARGET_NULL"


class TrainingTargetNonFiniteError(TrainingError):
    """The numeric target contains a non-finite value."""

    code = "TRAINING_TARGET_NON_FINITE"


class TrainingTargetConstantError(TrainingError):
    """The target is constant and cannot support a meaningful regression."""

    code = "TRAINING_TARGET_CONSTANT"


class TrainingNoFeaturesError(TrainingError):
    """No usable feature columns remain after trusted feature resolution."""

    code = "TRAINING_NO_FEATURES"


class TrainingPreprocessingError(TrainingError):
    """Feature preprocessing or input conversion failed."""

    code = "TRAINING_PREPROCESSING"


class TrainingFitError(TrainingError):
    """The regression estimator could not be fitted to the training split."""

    code = "TRAINING_FIT_FAILED"


class TrainingMetricsInvalidError(TrainingError):
    """Produced evaluation metrics are non-finite or otherwise invalid."""

    code = "TRAINING_METRICS_INVALID"


class TrainingOnnxError(TrainingError):
    """Base class for ONNX conversion and runtime validation failures."""

    code = "TRAINING_ONNX_ERROR"


class TrainingOnnxConversionError(TrainingOnnxError):
    """The fitted pipeline could not be converted into an ONNX payload."""

    code = "TRAINING_ONNX_CONVERSION_FAILED"


class TrainingOnnxRuntimeInvalidError(TrainingOnnxError):
    """The produced ONNX payload does not load in the ONNX runtime."""

    code = "TRAINING_ONNX_RUNTIME_INVALID"


class TrainingOnnxInputInvalidError(TrainingOnnxError):
    """The ONNX payload does not expose the expected model inputs."""

    code = "TRAINING_ONNX_INPUT_INVALID"


class TrainingOnnxOutputInvalidError(TrainingOnnxError):
    """The ONNX payload does not produce the expected model output."""

    code = "TRAINING_ONNX_OUTPUT_INVALID"


class TrainingOnnxPredictionMismatchError(TrainingOnnxError):
    """ONNX predictions differ from the fitted Python pipeline beyond tolerance."""

    code = "TRAINING_ONNX_PREDICTION_MISMATCH"


class TrainingResultSubmissionError(WorkerError):
    """The validated result could not be handed to Nucleus.

    When Nucleus answered with a structured rejection, ``server_error_code``
    carries the stable code the job should be failed with; otherwise the
    generic submission code is used. Transport failures are retried by the
    submitter; once retries are exhausted this error is raised so the job
    stays recoverable work for the later recovery scope.
    """

    code = "TRAINING_RESULT_SUBMISSION_FAILED"

    def __init__(
        self, message: str, *, server_error_code: str | None = None
    ) -> None:
        super().__init__(message)
        self.server_error_code = server_error_code
