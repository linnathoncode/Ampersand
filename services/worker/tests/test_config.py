import re

import pytest

from worker.config import (
    DEFAULT_ARTIFACT_STORAGE_PATH,
    DEFAULT_CLAIM_TIMEOUT_SECONDS,
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_MAX_SNAPSHOT_BYTES,
    DEFAULT_MAX_SNAPSHOT_ROWS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    DEFAULT_SUBMISSION_MAX_ATTEMPTS,
    DEFAULT_SUBMISSION_TIMEOUT_SECONDS,
    WorkerConfig,
)
from worker.errors import (
    InvalidEnvironmentValueError,
    MissingEnvironmentVariableError,
)

SECRET_PASSWORD = "s3cr3t-connection-password"

DATABASE_URL = (
    f"postgresql://ampersand:{SECRET_PASSWORD}@localhost:5432/ampersand"
)


def base_env(**overrides):
    env = {
        "DATABASE_URL": DATABASE_URL,
        "WORKER_ID": "worker-test",
        "WORKER_POLL_INTERVAL_SECONDS": "5",
        "WORKER_HEARTBEAT_INTERVAL_SECONDS": "10",
        "ARTIFACT_STORAGE_PATH": "/tmp/ampersand-artifacts",
        "NUCLEUS_INTERNAL_URL": "http://nucleus-internal.test/",
        "NUCLEUS_INTERNAL_TOKEN": "internal-secret",
        "WORKER_LOG_LEVEL": "INFO",
    }
    env.update(overrides)
    return {k: v for k, v in env.items() if v is not None}


class TestConfigLoading:
    def test_valid_config_loads_all_values(self):
        config = WorkerConfig.from_env(base_env())
        assert config.database_url == DATABASE_URL
        assert config.worker_id == "worker-test"
        assert config.poll_interval_seconds == 5
        assert config.heartbeat_interval_seconds == 10
        assert config.claim_timeout_seconds == DEFAULT_CLAIM_TIMEOUT_SECONDS
        assert config.artifact_storage_path == "/tmp/ampersand-artifacts"
        assert config.nucleus_internal_url == "http://nucleus-internal.test"
        assert config.nucleus_result_token == "internal-secret"
        assert config.log_level == "INFO"

    def test_snapshot_limits_loaded(self):
        config = WorkerConfig.from_env(
            base_env(
                WORKER_MAX_SNAPSHOT_BYTES="1048576",
                WORKER_MAX_SNAPSHOT_ROWS="50000",
            )
        )
        assert config.max_snapshot_bytes == 1048576
        assert config.max_snapshot_rows == 50000

    def test_defaults_applied_for_optional_values(self):
        config = WorkerConfig.from_env(
            base_env(
                WORKER_POLL_INTERVAL_SECONDS=None,
                WORKER_HEARTBEAT_INTERVAL_SECONDS=None,
                WORKER_CLAIM_TIMEOUT_SECONDS=None,
                ARTIFACT_STORAGE_PATH=None,
                WORKER_LOG_LEVEL=None,
                WORKER_MAX_SNAPSHOT_BYTES=None,
                WORKER_MAX_SNAPSHOT_ROWS=None,
                WORKER_SUBMISSION_TIMEOUT_SECONDS=None,
                WORKER_SUBMISSION_MAX_ATTEMPTS=None,
            )
        )
        assert config.poll_interval_seconds == DEFAULT_POLL_INTERVAL_SECONDS
        assert (
            config.heartbeat_interval_seconds
            == DEFAULT_HEARTBEAT_INTERVAL_SECONDS
        )
        assert (
            config.claim_timeout_seconds == DEFAULT_CLAIM_TIMEOUT_SECONDS
        )
        assert config.artifact_storage_path == DEFAULT_ARTIFACT_STORAGE_PATH
        assert config.log_level == "INFO"
        assert config.max_snapshot_bytes == DEFAULT_MAX_SNAPSHOT_BYTES
        assert config.max_snapshot_rows == DEFAULT_MAX_SNAPSHOT_ROWS
        assert (
            config.submission_timeout_seconds
            == DEFAULT_SUBMISSION_TIMEOUT_SECONDS
        )
        assert (
            config.submission_max_attempts
            == DEFAULT_SUBMISSION_MAX_ATTEMPTS
        )

    def test_custom_claim_timeout_accepted(self):
        config = WorkerConfig.from_env(
            base_env(WORKER_CLAIM_TIMEOUT_SECONDS="45")
        )
        assert config.claim_timeout_seconds == 45

    def test_generated_worker_id_when_unset(self):
        config = WorkerConfig.from_env(base_env(WORKER_ID=None))
        assert re.fullmatch(r"worker-[A-Za-z0-9_.-]+-\d+", config.worker_id)

    def test_missing_internal_url_raises(self):
        with pytest.raises(MissingEnvironmentVariableError) as excinfo:
            WorkerConfig.from_env(base_env(NUCLEUS_INTERNAL_URL=None))
        assert excinfo.value.variable == "NUCLEUS_INTERNAL_URL"

    def test_missing_internal_token_raises(self):
        with pytest.raises(MissingEnvironmentVariableError) as excinfo:
            WorkerConfig.from_env(base_env(NUCLEUS_INTERNAL_TOKEN=None))
        assert excinfo.value.variable == "NUCLEUS_INTERNAL_TOKEN"

    def test_internal_token_never_appears_in_error_messages(self):
        token = "super-secret-internal-token"

        with pytest.raises(MissingEnvironmentVariableError) as excinfo:
            WorkerConfig.from_env(
                base_env(
                    NUCLEUS_INTERNAL_URL=None,
                    NUCLEUS_INTERNAL_TOKEN=token,
                )
            )
        assert token not in str(excinfo.value)

    def test_submission_settings_loaded(self):
        config = WorkerConfig.from_env(
            base_env(
                WORKER_SUBMISSION_TIMEOUT_SECONDS="20",
                WORKER_SUBMISSION_MAX_ATTEMPTS="5",
                NUCLEUS_INTERNAL_URL="http://nucleus-internal.test//",
            )
        )
        assert config.submission_timeout_seconds == 20
        assert config.submission_max_attempts == 5
        assert config.nucleus_internal_url == "http://nucleus-internal.test"

    @pytest.mark.parametrize(
        "raw", ["not-a-url", "localhost:4000", "ftp://evil.test", "//host"]
    )
    def test_internal_url_requires_http_scheme(self, raw):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(NUCLEUS_INTERNAL_URL=raw))
        assert excinfo.value.variable == "NUCLEUS_INTERNAL_URL"


class TestConfigErrors:
    def test_missing_database_url_raises(self):
        with pytest.raises(MissingEnvironmentVariableError) as excinfo:
            WorkerConfig.from_env(base_env(DATABASE_URL=None))
        assert excinfo.value.variable == "DATABASE_URL"

    def test_database_url_secret_is_never_leaked(self):
        with pytest.raises(MissingEnvironmentVariableError) as excinfo:
            WorkerConfig.from_env(base_env(DATABASE_URL=None))
        assert SECRET_PASSWORD not in str(excinfo.value)

    def test_invalid_worker_id_rejected(self):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(WORKER_ID="bad id!"))
        assert excinfo.value.variable == "WORKER_ID"

    def test_invalid_poll_interval_rejected(self):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(
                base_env(WORKER_POLL_INTERVAL_SECONDS="abc")
            )
        assert excinfo.value.variable == "WORKER_POLL_INTERVAL_SECONDS"

    @pytest.mark.parametrize("raw", ["abc", "0", "-5"])
    def test_invalid_claim_timeout_rejected(self, raw):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(
                base_env(WORKER_CLAIM_TIMEOUT_SECONDS=raw)
            )
        assert excinfo.value.variable == "WORKER_CLAIM_TIMEOUT_SECONDS"

    @pytest.mark.parametrize("variable", ["WORKER_MAX_SNAPSHOT_BYTES", "WORKER_MAX_SNAPSHOT_ROWS"])
    def test_invalid_snapshot_limits_rejected(self, variable):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(**{variable: "0"}))
        assert excinfo.value.variable == variable

    def test_invalid_log_level_rejected(self):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(WORKER_LOG_LEVEL="verbose"))
        assert excinfo.value.variable == "WORKER_LOG_LEVEL"


class TestWorkerLogConfig:
    def test_worker_log_max_chars_default(self):
        config = WorkerConfig.from_env(base_env())
        assert config.log_max_chars == 8192

    def test_worker_log_max_chars_loaded(self):
        config = WorkerConfig.from_env(
            base_env(WORKER_LOG_MAX_CHARS="4096")
        )
        assert config.log_max_chars == 4096

    @pytest.mark.parametrize("raw", ["0", "-1", "abc"])
    def test_invalid_worker_log_max_chars_rejected(self, raw):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(WORKER_LOG_MAX_CHARS=raw))
        assert excinfo.value.variable == "WORKER_LOG_MAX_CHARS"
