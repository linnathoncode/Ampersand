"""Private-boundary shared contract validation.

These Pydantic models mirror the TypeBox DTOs in
``packages/contracts/src/training/worker-input.ts`` and
``worker-result.ts``. They validate *trusted* job, snapshot, and tenant
metadata assembled by the API; they are not for validating external input.

Scalars are strict to match TypeBox semantics: strings must already be
strings, integers must already be integers (not booleans), and numbers may be
integer- or float-valued but never booleans, strings, or non-finite values.
Contract parity is maintained by ``tests/test_contracts.py`` using the same
payloads as the TypeScript contract tests.
"""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal, Mapping, Union

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    StrictStr,
    ValidationError,
)

from .errors import WorkerContractValidationError

_PG_IDENTIFIER_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
_SHA256_PATTERN = r"^[a-f0-9]{64}$"
_UUID_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _strict_int(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("must be an integer")
    return value


def _strict_number(value: Any) -> Any:
    if (
        isinstance(value, bool)
        or isinstance(value, str)
        or not isinstance(value, (int, float))
    ):
        raise ValueError("must be a number")
    return value


def _finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("must be a finite number")
    return value


NonEmptyString = Annotated[
    StrictStr, StringConstraints(min_length=1)
]
PgIdentifier = Annotated[
    StrictStr,
    StringConstraints(pattern=_PG_IDENTIFIER_PATTERN, max_length=63),
]
Sha256Hex = Annotated[StrictStr, StringConstraints(pattern=_SHA256_PATTERN)]
UuidStr = Annotated[StrictStr, StringConstraints(pattern=_UUID_PATTERN)]

IntegerT = Annotated[int, BeforeValidator(_strict_int)]
NonNegativeInteger = Annotated[
    int, BeforeValidator(_strict_int), Field(ge=0)
]
PositiveInteger = Annotated[
    int, BeforeValidator(_strict_int), Field(ge=1)
]

FiniteFloat = Annotated[
    float, BeforeValidator(_strict_number), AfterValidator(_finite)
]
NonNegativeFiniteFloat = Annotated[
    float, BeforeValidator(_strict_number), Field(ge=0), AfterValidator(_finite)
]
BoundedFiniteFloat = Annotated[
    float,
    BeforeValidator(_strict_number),
    Field(ge=0, le=1),
    AfterValidator(_finite),
]


def _forbid_extra() -> ConfigDict:
    return ConfigDict(extra="forbid")


class TrainingWorkerFeature(BaseModel):
    model_config = _forbid_extra()

    name: PgIdentifier
    dataType: Literal["number", "integer", "boolean", "category"]
    position: NonNegativeInteger


class TrainingWorkerTarget(BaseModel):
    model_config = _forbid_extra()

    name: PgIdentifier
    dataType: Literal["number", "integer"]


class TrainingWorkerSnapshot(BaseModel):
    model_config = _forbid_extra()

    id: UuidStr
    storageUri: NonEmptyString
    format: Literal["parquet"]
    contentSha256: Sha256Hex
    rowCount: PositiveInteger


class ResolvedTrainingConfig(BaseModel):
    model_config = _forbid_extra()

    trainerVersion: NonEmptyString
    algorithmPolicy: Literal["automatic-regression"]
    randomSeed: IntegerT
    splitStrategy: Literal["chronological"]
    testFraction: Annotated[
        float,
        BeforeValidator(_strict_number),
        Field(gt=0, lt=1),
        AfterValidator(_finite),
    ]
    maxRuntimeSeconds: PositiveInteger


class TrainingWorkerInput(BaseModel):
    model_config = _forbid_extra()

    tenantSchema: PgIdentifier
    jobId: UuidStr
    jobFingerprint: Sha256Hex
    datasetDefinitionId: UuidStr
    snapshot: TrainingWorkerSnapshot
    features: list[TrainingWorkerFeature] = Field(min_length=1)
    target: TrainingWorkerTarget
    timeColumn: Union[PgIdentifier, None]
    trainingConfig: ResolvedTrainingConfig
    artifactOutputDirectory: NonEmptyString
    heartbeatIntervalSeconds: PositiveInteger


class TrainingWorkerMetrics(BaseModel):
    model_config = _forbid_extra()

    mae: NonNegativeFiniteFloat
    rmse: NonNegativeFiniteFloat
    r2: FiniteFloat


class TrainingWorkerArtifact(BaseModel):
    model_config = _forbid_extra()

    storageUri: NonEmptyString
    format: Literal["onnx"]
    contentSha256: Sha256Hex
    sizeBytes: PositiveInteger


class TrainingWorkerModelFeature(BaseModel):
    model_config = _forbid_extra()

    name: PgIdentifier
    position: NonNegativeInteger
    dataType: Literal["number", "integer", "boolean", "category"]
    validMin: Union[FiniteFloat, None]
    validMax: Union[FiniteFloat, None]
    allowedValues: Union[list[Union[StrictStr, FiniteFloat]], None]
    missingRate: BoundedFiniteFloat


class TrainingWorkerSuccess(BaseModel):
    model_config = _forbid_extra()

    status: Literal["succeeded"]
    metrics: TrainingWorkerMetrics
    baselineMetrics: TrainingWorkerMetrics
    artifact: TrainingWorkerArtifact
    features: list[TrainingWorkerModelFeature] = Field(min_length=1)


class TrainingWorkerFailureError(BaseModel):
    model_config = _forbid_extra()

    code: NonEmptyString
    message: NonEmptyString


class TrainingWorkerFailure(BaseModel):
    model_config = _forbid_extra()

    status: Literal["failed"]
    error: TrainingWorkerFailureError


class TrainingWorkerResult(BaseModel):
    model_config = _forbid_extra()

    jobId: UuidStr
    jobFingerprint: Sha256Hex
    workerId: NonEmptyString
    result: Union[TrainingWorkerSuccess, TrainingWorkerFailure]


def validate_worker_input(payload: Mapping[str, Any]) -> TrainingWorkerInput:
    """Validate a trusted worker input payload against the private contract."""
    try:
        return TrainingWorkerInput.model_validate(payload)
    except ValidationError as exc:
        raise WorkerContractValidationError(
            _format_validation_errors(exc)
        ) from exc


def build_worker_input(
    *,
    tenant_schema: str,
    job_id: str,
    job_fingerprint: str,
    dataset_definition_id: str,
    snapshot: Mapping[str, Any],
    features: list[Mapping[str, Any]],
    target: Mapping[str, Any],
    time_column: str | None,
    training_config: Mapping[str, Any],
    artifact_output_directory: str,
    heartbeat_interval_seconds: int,
) -> TrainingWorkerInput:
    """Assemble a worker input from trusted server-resolved metadata."""
    payload: dict[str, Any] = {
        "tenantSchema": tenant_schema,
        "jobId": job_id,
        "jobFingerprint": job_fingerprint,
        "datasetDefinitionId": dataset_definition_id,
        "snapshot": snapshot,
        "features": features,
        "target": target,
        "timeColumn": time_column,
        "trainingConfig": training_config,
        "artifactOutputDirectory": artifact_output_directory,
        "heartbeatIntervalSeconds": heartbeat_interval_seconds,
    }
    return validate_worker_input(payload)


def validate_worker_result(payload: Mapping[str, Any]) -> TrainingWorkerResult:
    """Validate a worker result payload against the private contract.

    Validation currently covers the envelope only; persisting results is
    handled by the API-side completion flow.
    """
    try:
        return TrainingWorkerResult.model_validate(payload)
    except ValidationError as exc:
        raise WorkerContractValidationError(
            _format_validation_errors(exc)
        ) from exc


def to_json_dict(model: BaseModel) -> dict[str, Any]:
    """Convert a validated model to a plain JSON-compatible dictionary."""
    return model.model_dump(mode="json")


def _format_validation_errors(exc: ValidationError) -> str:
    issues = []
    for error in exc.errors():
        location = "/".join(str(part) for part in error["loc"])
        issues.append(f"{location}: {error['msg']}")
    return "worker payload failed contract validation: " + "; ".join(issues)