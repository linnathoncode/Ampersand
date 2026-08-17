"""Focused tests for deterministic fake training."""

from __future__ import annotations

from worker.dataset_validation import TrustedColumn, validate_snapshot_dataset
from worker.fake_trainer import (
    FAKE_ARTIFACT_MARKER,
    FakeTrainer,
    validate_fake_result,
)

from support import VALID_ROWS, build_worker_input, make_context, make_snapshot_file, sha256_of


def make_dataset(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    context = make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256=sha256_of(snapshot),
        row_count=len(VALID_ROWS),
    )
    dataset = validate_snapshot_dataset(
        snapshot,
        tuple(
            TrustedColumn(
                name=column.name,
                role=column.role,
                data_type=column.data_type,
                is_nullable=column.is_nullable,
                position=column.position,
            )
            for column in context.columns
        ),
        expected_row_count=len(VALID_ROWS),
        max_rows=100_000,
    )
    return snapshot, dataset


def make_input(tmp_path, snapshot):
    context = make_context(
        snapshot_uri="snapshot.parquet",
        content_sha256=sha256_of(snapshot),
        row_count=len(VALID_ROWS),
    )
    return build_worker_input(context, str(tmp_path))


class TestFakeTrainer:
    def test_output_is_deterministic_and_contract_valid(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        trainer = FakeTrainer(str(tmp_path))

        first = trainer.train(worker_input, dataset)
        second = trainer.train(worker_input, dataset)

        assert first.success_payload == second.success_payload
        assert first.artifact_path == second.artifact_path
        validate_fake_result("worker-test", worker_input, first.success_payload)
        assert first.artifact_path.read_bytes().startswith(FAKE_ARTIFACT_MARKER)

    def test_missing_output_directory_is_created(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        output_dir = tmp_path / "nested" / "artifacts"
        trainer = FakeTrainer(str(output_dir))

        output = trainer.train(worker_input, dataset)

        assert output_dir.is_dir()
        assert output.artifact_path.is_file()
        assert output.artifact_path.read_bytes().startswith(FAKE_ARTIFACT_MARKER)
