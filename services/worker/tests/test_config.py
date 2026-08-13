import re

import pytest

from worker.config import (
    DEFAULT_ARTIFACT_STORAGE_PATH,
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
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
        assert config.artifact_storage_path == "/tmp/ampersand-artifacts"
        assert config.log_level == "INFO"

    def test_defaults_applied_for_optional_values(self):
        config = WorkerConfig.from_env(
            base_env(
                WORKER_POLL_INTERVAL_SECONDS=None,
                WORKER_HEARTBEAT_INTERVAL_SECONDS=None,
                ARTIFACT_STORAGE_PATH=None,
                WORKER_LOG_LEVEL=None,
            )
        )
        assert config.poll_interval_seconds == DEFAULT_POLL_INTERVAL_SECONDS
        assert (
            config.heartbeat_interval_seconds
            == DEFAULT_HEARTBEAT_INTERVAL_SECONDS
        )
        assert config.artifact_storage_path == DEFAULT_ARTIFACT_STORAGE_PATH
        assert config.log_level == "INFO"

    def test_generated_worker_id_when_unset(self):
        config = WorkerConfig.from_env(base_env(WORKER_ID=None))
        assert re.fullmatch(r"worker-[A-Za-z0-9_.-]+-\d+", config.worker_id)


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

    def test_invalid_log_level_rejected(self):
        with pytest.raises(InvalidEnvironmentValueError) as excinfo:
            WorkerConfig.from_env(base_env(WORKER_LOG_LEVEL="verbose"))
        assert excinfo.value.variable == "WORKER_LOG_LEVEL"