"""Unit tests for the Nucleus result-submission client."""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest

from worker.config import WorkerConfig
from worker.errors import (
    JobOwnershipError,
    JobStateConflictError,
    TrainingResultSubmissionError,
)
from worker.submission import (
    SubmissionOutcome,
    build_result_submission,
    submit_training_result,
)

INTERNAL_URL = "http://nucleus-internal.test"
TOKEN = "internal-secret"


def config(max_attempts=3):
    return WorkerConfig(
        database_url="postgresql://unused@localhost:5432/unused",
        worker_id="worker-a",
        poll_interval_seconds=30,
        heartbeat_interval_seconds=10,
        artifact_storage_path="/tmp/ampersand-artifacts",
        log_level="INFO",
        nucleus_internal_url=INTERNAL_URL,
        nucleus_result_token=TOKEN,
        submission_max_attempts=max_attempts,
    )


def success_envelope():
    return {
        "workerId": "worker-a",
        "fingerprint": "a" * 64,
        "result": {
            "status": "succeeded",
            "metrics": {"mae": 1, "rmse": 1.2, "r2": 0.9},
            "baselineMetrics": {"mae": 5, "rmse": 5.5, "r2": 0},
            "artifact": {
                "storageUri": "job.onnx.tmp",
                "format": "onnx",
                "contentSha256": "b" * 64,
                "sizeBytes": 10,
            },
            "features": [
                {
                    "name": "temperature",
                    "position": 0,
                    "dataType": "number",
                    "validMin": None,
                    "validMax": None,
                    "allowedValues": None,
                    "missingRate": 0,
                }
            ],
            "splitMetadata": {
                "strategy": "chronological",
                "timeColumn": None,
                "trainRowCount": 1,
                "testRowCount": 1,
                "testFraction": 0.2,
                "roundingRule": "round",
                "trainingBoundary": None,
                "testStart": None,
                "randomSeed": 42,
                "featureOrder": ["temperature"],
                "trainerVersion": "1",
                "dependencyVersions": {"python": "3.11"},
            },
        },
    }


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def http_error(status: int, body: dict | None = None):
    raw = json.dumps(body or {}).encode("utf-8")
    error = urllib.error.HTTPError(
        url=f"{INTERNAL_URL}/result",
        code=status,
        msg="error",
        hdrs=None,
        fp=FakeResponse(raw),
    )
    return error


def patch_urlopen(monkeypatch, responses):
    """Queue responses for sequential urlopen calls."""
    calls = []

    def open_fake(request, timeout=None):
        calls.append({"request": request, "timeout": timeout})
        action = responses.pop(0)
        if isinstance(action, Exception):
            raise action
        return FakeResponse(json.dumps(action).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", open_fake)
    return calls


def sleeps(monkeypatch):
    recorded = []
    monkeypatch.setattr("time.sleep", lambda s: recorded.append(s))
    return recorded


def submit(config_instance=config(), **kwargs):
    return submit_training_result(
        config_instance,
        job_id="11111111-1111-4111-8111-111111111111",
        schema_name="tenant_ampersand_dev",
        payload=success_envelope(),
        **kwargs,
    )


class TestSuccess:
    def test_registered_response_is_parsed(self, monkeypatch):
        calls = patch_urlopen(
            monkeypatch,
            [
                {
                    "status": "registered",
                    "modelVersionId": "11111111-1111-4111-8111-111111111111",
                    "versionNumber": 4,
                    "storageUri": "models/dd/v4/job.onnx",
                }
            ],
        )

        outcome = submit()

        assert outcome == SubmissionOutcome(
            status="registered",
            model_version_id="11111111-1111-4111-8111-111111111111",
            version_number=4,
            storage_uri="models/dd/v4/job.onnx",
        )
        request = calls[0]["request"]
        assert (
            request.full_url
            == f"{INTERNAL_URL}/internal/training-jobs/11111111-1111-4111-8111-111111111111/result"
        )
        assert request.get_header("Content-type") == "application/json"
        assert request.get_header("Authorization") == f"Bearer {TOKEN}"
        assert request.get_header("X-tenant-id") == "tenant_ampersand_dev"

    def test_failed_recorded_response_is_accepted(self, monkeypatch):
        patch_urlopen(monkeypatch, [{"status": "failed-recorded"}])

        outcome = submit()

        assert outcome.status == "failed-recorded"


class TestStructuredRejections:
    def test_ownership_conflict_propagates_without_retry(self, monkeypatch):
        calls = patch_urlopen(
            monkeypatch,
            [http_error(409, {"error": {"code": "JOB_OWNERSHIP"}})],
        )
        recorded = sleeps(monkeypatch)

        with pytest.raises(JobOwnershipError):
            submit()

        assert len(calls) == 1
        assert recorded == []

    def test_state_conflict_propagates_without_retry(self, monkeypatch):
        patch_urlopen(
            monkeypatch,
            [http_error(409, {"error": {"code": "JOB_STATE_CONFLICT"}})],
        )
        recorded = sleeps(monkeypatch)

        with pytest.raises(JobStateConflictError):
            submit()

        assert recorded == []

    def test_structured_4xx_fails_fast_with_server_code(self, monkeypatch):
        patch_urlopen(
            monkeypatch,
            [
                http_error(
                    422,
                    {
                        "error": {
                            "code": "MODEL_FEATURE_METADATA_INVALID",
                            "message": "Feature mismatch",
                        }
                    },
                )
            ],
        )
        recorded = sleeps(monkeypatch)

        with pytest.raises(TrainingResultSubmissionError) as excinfo:
            submit()

        assert excinfo.value.server_error_code == "MODEL_FEATURE_METADATA_INVALID"
        assert recorded == []


class TestRetries:
    def test_server_errors_are_retried_until_success(self, monkeypatch):
        calls = patch_urlopen(
            monkeypatch,
            [
                http_error(503),
                http_error(500),
                {
                    "status": "registered",
                    "modelVersionId": "11111111-1111-4111-8111-111111111111",
                    "versionNumber": 2,
                    "storageUri": "models/dd/v2/job.onnx",
                },
            ],
        )
        recorded = sleeps(monkeypatch)

        outcome = submit()

        assert outcome.version_number == 2
        assert len(calls) == 3
        assert recorded == [1, 2]

    def test_transport_failures_are_retried_then_raised(self, monkeypatch):
        calls = patch_urlopen(
            monkeypatch,
            [
                urllib.error.URLError("connection refused"),
                urllib.error.URLError("connection refused"),
                urllib.error.URLError("connection refused"),
            ],
        )
        recorded = sleeps(monkeypatch)

        with pytest.raises(TrainingResultSubmissionError) as excinfo:
            submit(config(max_attempts=3))

        assert excinfo.value.server_error_code is None
        assert len(calls) == 3
        assert recorded == [1, 2]

    def test_unreadable_success_body_raises_structured_error(
        self, monkeypatch
    ):
        def open_fake(request, timeout=None):
            return FakeResponse(b"not-json")

        monkeypatch.setattr(urllib.request, "urlopen", open_fake)
        sleeps(monkeypatch)

        with pytest.raises(TrainingResultSubmissionError):
            submit(config(max_attempts=1))

    @pytest.mark.parametrize(
        "override",
        [
            {"modelVersionId": "not-a-uuid"},
            {"versionNumber": 0},
            {"versionNumber": True},
            {"versionNumber": "2"},
            {"storageUri": "uploads/model.onnx"},
            {"storageUri": ""},
        ],
    )
    def test_malformed_registered_field_raises_structured_error(
        self, monkeypatch, override
    ):
        body = {
            "status": "registered",
            "modelVersionId": "11111111-1111-4111-8111-111111111111",
            "versionNumber": 4,
            "storageUri": "models/dd/v4/job.onnx",
        }
        body.update(override)

        def open_fake(request, timeout=None):
            return FakeResponse(json.dumps(body).encode("utf-8"))

        monkeypatch.setattr(urllib.request, "urlopen", open_fake)
        sleeps(monkeypatch)

        with pytest.raises(TrainingResultSubmissionError) as excinfo:
            submit(config(max_attempts=1))

        assert "malformed success response" in str(excinfo.value)


def test_submission_envelope_binds_result_to_claimed_job():
    class WorkerInput:
        jobFingerprint = "f" * 64

    envelope = build_result_submission(
        "worker-a", WorkerInput(), {"status": "succeeded"}
    )

    assert envelope == {
        "workerId": "worker-a",
        "fingerprint": "f" * 64,
        "result": {"status": "succeeded"},
    }
