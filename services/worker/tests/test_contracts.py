import math

import pytest

from worker.contracts import (
    TrainingWorkerInput,
    TrainingWorkerResult,
    build_worker_input,
    to_json_dict,
    validate_worker_input,
    validate_worker_result,
)
from worker.errors import WorkerContractValidationError

JOB_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
SNAPSHOT_ID = "8a16f8f6-8a4f-4f44-9e5a-7f6a3d2e1b0a"
DATASET_DEFINITION_ID = "b3f1c7d9-0f3a-4a5c-8d2e-1f4a6c8e0b2d"

VALID_TRAINING_CONFIG = {
    "trainerVersion": "1.0.0",
    "algorithmPolicy": "automatic-regression",
    "randomSeed": 42,
    "splitStrategy": "chronological",
    "testFraction": 0.2,
    "maxRuntimeSeconds": 300,
}

VALID_SNAPSHOT = {
    "id": SNAPSHOT_ID,
    "storageUri": "snapshots/data.parquet",
    "format": "parquet",
    "contentSha256": "a" * 64,
    "rowCount": 100,
}

VALID_FEATURES = [
    {"name": "temperature", "dataType": "number", "position": 0},
    {"name": "occupancy", "dataType": "integer", "position": 1},
]

VALID_TARGET = {"name": "energy_usage", "dataType": "number"}


def input_payload(**overrides):
    payload = {
        "tenantSchema": "tenant_acme",
        "jobId": JOB_ID,
        "jobFingerprint": "b" * 64,
        "datasetDefinitionId": DATASET_DEFINITION_ID,
        "snapshot": VALID_SNAPSHOT,
        "features": VALID_FEATURES,
        "target": VALID_TARGET,
        "timeColumn": "recorded_at",
        "trainingConfig": VALID_TRAINING_CONFIG,
        "artifactOutputDirectory": "artifacts",
        "heartbeatIntervalSeconds": 10,
    }
    payload.update(overrides)
    return payload


def success_result_payload(**overrides):
    payload = {
        "jobId": JOB_ID,
        "jobFingerprint": "b" * 64,
        "workerId": "worker-test",
        "result": {
            "status": "succeeded",
            "metrics": {"mae": 1.0, "rmse": 1.2, "r2": 0.9},
            "baselineMetrics": {"mae": 2.0, "rmse": 2.2, "r2": 0.5},
            "artifact": {
                "storageUri": "artifacts/model.onnx",
                "format": "onnx",
                "contentSha256": "c" * 64,
                "sizeBytes": 1024,
            },
            "features": [
                {
                    "name": "temperature",
                    "position": 0,
                    "dataType": "number",
                    "validMin": -20,
                    "validMax": 50,
                    "allowedValues": None,
                    "missingRate": 0.01,
                }
            ],
        },
    }
    payload.update(overrides)
    return payload


def failure_result_payload(**overrides):
    payload = {
        "jobId": JOB_ID,
        "jobFingerprint": "b" * 64,
        "workerId": "worker-test",
        "result": {
            "status": "failed",
            "error": {"code": "TRAINING_FAILED", "message": "Training failed"},
        },
    }
    payload.update(overrides)
    return payload


class TestWorkerInput:
    def test_build_worker_input_succeeds(self):
        model = build_worker_input(
            tenant_schema="tenant_acme",
            job_id=JOB_ID,
            job_fingerprint="b" * 64,
            dataset_definition_id=DATASET_DEFINITION_ID,
            snapshot=VALID_SNAPSHOT,
            features=VALID_FEATURES,
            target=VALID_TARGET,
            time_column="recorded_at",
            training_config=VALID_TRAINING_CONFIG,
            artifact_output_directory="artifacts",
            heartbeat_interval_seconds=10,
        )
        assert isinstance(model, TrainingWorkerInput)
        assert to_json_dict(model)["jobId"] == JOB_ID

    def test_validate_worker_input_succeeds(self):
        assert isinstance(
            validate_worker_input(input_payload()), TrainingWorkerInput
        )

    def test_null_time_column_is_accepted(self):
        assert (
            validate_worker_input(input_payload(timeColumn=None)).timeColumn
            is None
        )

    @pytest.mark.parametrize(
        "override",
        [
            {"jobId": "not-a-uuid"},
            {"jobFingerprint": "x".upper() * 64},
            {"snapshot": {**VALID_SNAPSHOT, "rowCount": 0}},
            {"snapshot": {**VALID_SNAPSHOT, "id": "not-a-uuid"}},
            {"features": []},
            {"features": [{"name": "1bad", "dataType": "text", "position": 0}]},
            {"heartbeatIntervalSeconds": 0},
            {"timeColumn": "bad column"},
            {"trainingConfig": {**VALID_TRAINING_CONFIG, "testFraction": 1}},
            {"unexpectedField": "x"},
        ],
    )
    def test_invalid_worker_input_rejected(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_input(input_payload(**override))


class TestWorkerResult:
    def test_valid_success_accepted(self):
        result = validate_worker_result(success_result_payload())
        assert isinstance(result, TrainingWorkerResult)
        assert result.result.status == "succeeded"

    def test_valid_failure_accepted(self):
        result = validate_worker_result(failure_result_payload())
        assert result.result.status == "failed"

    def test_serializes_to_json_compatible_dict(self):
        dumped = to_json_dict(validate_worker_result(success_result_payload()))
        assert dumped["result"]["status"] == "succeeded"

    @pytest.mark.parametrize(
        "override",
        [
            {"result": {**success_result_payload()["result"], "extra": 1}},
            {
                "result": {
                    **success_result_payload()["result"],
                    "features": [],
                }
            },
            {
                "result": {
                    **success_result_payload()["result"],
                    "metrics": {"mae": -1, "rmse": 1.2, "r2": 0.9},
                }
            },
            {
                "result": {
                    **success_result_payload()["result"],
                    "metrics": {"mae": 1.0, "rmse": 1.2, "r2": math.nan},
                }
            },
            {
                "result": {
                    **success_result_payload()["result"],
                    "artifact": {
                        **success_result_payload()["result"]["artifact"],
                        "format": "pt",
                        "sizeBytes": 0,
                    },
                }
            },
            {
                "result": {
                    **success_result_payload()["result"],
                    "features": [
                        {
                            **success_result_payload()["result"]["features"][0],
                            "missingRate": 2,
                        }
                    ],
                }
            },
        ],
    )
    def test_invalid_success_result_rejected(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(success_result_payload(**override))

    def test_success_with_error_field_rejected(self):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(
                success_result_payload(
                    result={
                        **success_result_payload()["result"],
                        "error": {"code": "X", "message": "x"},
                    }
                )
            )

    @pytest.mark.parametrize(
        "override",
        [
            {"result": {"status": "failed", "error": {"code": "", "message": "x"}}},
            {"result": {"status": "failed"}},
            {"result": {"status": "succeeded"}},
            {"result": {"status": "dead"}},
        ],
    )
    def test_invalid_failure_result_rejected(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(failure_result_payload(**override))


# Coercible values that default Pydantic behavior accepts but the TypeBox
# boundary contract rejects; these guard the review fixes.
STRICT_INPUT_CASES = [
    {"heartbeatIntervalSeconds": "10"},
    {"heartbeatIntervalSeconds": True},
    {"trainingConfig": {**VALID_TRAINING_CONFIG, "testFraction": "0.2"}},
    {"tenantSchema": 123},
    {"artifactOutputDirectory": 123},
]

MISSING_REQUIRED_INPUT_CASES = [
    {"snapshot": {k: v for k, v in VALID_SNAPSHOT.items() if k != "format"}},
    {
        "trainingConfig": {
            k: v
            for k, v in VALID_TRAINING_CONFIG.items()
            if k != "algorithmPolicy"
        }
    },
]

STRICT_RESULT_CASES = [
    {
        "result": {
            **success_result_payload()["result"],
            "metrics": {"mae": "1", "rmse": 1.2, "r2": 0.9},
        }
    },
    {
        "result": {
            **success_result_payload()["result"],
            "artifact": {
                **success_result_payload()["result"]["artifact"],
                "sizeBytes": "1024",
            },
        }
    },
    {"workerId": 123},
    {
        "result": {
            **success_result_payload()["result"],
            "features": [
                {
                    **success_result_payload()["result"]["features"][0],
                    "allowedValues": [True],
                }
            ],
        }
    },
]

MISSING_REQUIRED_RESULT_CASES = [
    {
        "result": {
            k: v
            for k, v in success_result_payload()["result"].items()
            if k != "status"
        }
    },
    {
        "result": {
            k: v
            for k, v in failure_result_payload()["result"].items()
            if k != "status"
        }
    },
]


class TestStrictScalars:
    @pytest.mark.parametrize("override", STRICT_INPUT_CASES)
    def test_input_rejects_coercible_values(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_input(input_payload(**override))

    @pytest.mark.parametrize("override", MISSING_REQUIRED_INPUT_CASES)
    def test_input_requires_typebox_fields(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_input(input_payload(**override))

    @pytest.mark.parametrize("override", STRICT_RESULT_CASES)
    def test_result_rejects_coercible_values(self, override):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(success_result_payload(**override))

    @pytest.mark.parametrize(
        "payload",
        MISSING_REQUIRED_RESULT_CASES,
        ids=["success-without-status", "failure-without-status"],
    )
    def test_result_requires_typebox_fields(self, payload):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(payload)


class TestStrictNumberParity:
    def test_integer_json_numbers_still_accepted_for_float_fields(self):
        payload = success_result_payload()
        payload["result"]["metrics"] = {"mae": 1, "rmse": 2, "r2": 0}
        validate_worker_result(payload)

    def test_boolean_is_never_an_integer_or_number(self):
        with pytest.raises(WorkerContractValidationError):
            validate_worker_input(
                input_payload(heartbeatIntervalSeconds=True)
            )
        with pytest.raises(WorkerContractValidationError):
            validate_worker_result(
                success_result_payload(
                    result={
                        **success_result_payload()["result"],
                        "metrics": {"mae": 1.0, "rmse": 1.0, "r2": True},
                    }
                )
            )