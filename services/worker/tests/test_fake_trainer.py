"""Focused tests for deterministic fake training."""

from __future__ import annotations

import pyarrow as pa

from worker.database import DatasetColumn
from worker.dataset_validation import TrustedColumn, validate_snapshot_dataset
from worker.fake_trainer import (
    FAKE_ARTIFACT_MARKER,
    FakeTrainer,
    validate_fake_result,
)
from worker.splitting import split_dataset

from support import (
    VALID_ROWS,
    build_worker_input,
    build_worker_input_with_features,
    load_table,
    make_context,
    make_snapshot_file,
    sha256_of,
)


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


def make_split(snapshot, worker_input):
    return split_dataset(
        load_table(snapshot),
        time_column=worker_input.timeColumn,
        test_fraction=worker_input.trainingConfig.testFraction,
        random_seed=worker_input.trainingConfig.randomSeed,
        feature_order=[feature.name for feature in worker_input.features],
        trainer_version=worker_input.trainingConfig.trainerVersion,
    )


class TestFakeTrainer:
    def test_output_is_deterministic_and_contract_valid(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        trainer = FakeTrainer(str(tmp_path))
        split = make_split(snapshot, worker_input)

        first = trainer.train(worker_input, dataset, split)
        second = trainer.train(worker_input, dataset, split)

        assert first.success_payload == second.success_payload
        assert first.artifact_path == second.artifact_path
        validate_fake_result("worker-test", worker_input, first.success_payload)
        assert first.artifact_path.read_bytes().startswith(FAKE_ARTIFACT_MARKER)

    def test_missing_output_directory_is_created(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        output_dir = tmp_path / "nested" / "artifacts"
        trainer = FakeTrainer(str(output_dir))
        split = make_split(snapshot, worker_input)

        output = trainer.train(worker_input, dataset, split)

        assert output_dir.is_dir()
        assert output.artifact_path.is_file()
        assert output.artifact_path.read_bytes().startswith(FAKE_ARTIFACT_MARKER)

    def test_success_payload_records_split_metadata(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        split = make_split(snapshot, worker_input)

        output = FakeTrainer(str(tmp_path)).train(worker_input, dataset, split)

        metadata = output.success_payload["splitMetadata"]
        assert metadata["strategy"] == "chronological"
        assert metadata["timeColumn"] == "recorded_at"
        assert metadata["randomSeed"] == worker_input.trainingConfig.randomSeed
        assert metadata["trainerVersion"] == "1.0.0"
        assert metadata["featureOrder"] == ["temperature", "occupancy"]
        assert metadata["trainRowCount"] + metadata["testRowCount"] == 5
        assert metadata["trainingBoundary"] is not None
        assert metadata["testStart"] is not None
        validate_fake_result("worker-test", worker_input, output.success_payload)

    def test_changed_seed_changes_deterministic_output(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = make_input(tmp_path, snapshot)
        split = make_split(snapshot, worker_input)
        trainer = FakeTrainer(str(tmp_path))

        base = trainer.train(worker_input, dataset, split)
        changed = worker_input.model_copy(
            update={
                "trainingConfig": worker_input.trainingConfig.model_copy(
                    update={"randomSeed": worker_input.trainingConfig.randomSeed + 1}
                )
            }
        )
        split_changed = split_dataset(
            load_table(snapshot),
            time_column=changed.timeColumn,
            test_fraction=changed.trainingConfig.testFraction,
            random_seed=changed.trainingConfig.randomSeed,
            feature_order=[feature.name for feature in changed.features],
            trainer_version=changed.trainingConfig.trainerVersion,
        )
        other = trainer.train(changed, dataset, split_changed)

        assert base.success_payload["metrics"] != other.success_payload["metrics"]
        assert (
            other.success_payload["splitMetadata"]["randomSeed"]
            == worker_input.trainingConfig.randomSeed + 1
        )

    def test_feature_order_stays_stable_for_reordered_positions(self, tmp_path):
        snapshot, dataset = make_dataset(tmp_path)
        worker_input = build_worker_input_with_features(
            make_context(
                snapshot_uri="snapshot.parquet",
                content_sha256=sha256_of(snapshot),
                row_count=len(VALID_ROWS),
            ),
            str(tmp_path),
            features=[
                {"name": "occupancy", "dataType": "integer", "position": 1},
                {"name": "temperature", "dataType": "number", "position": 0},
            ],
        )
        split = split_dataset(
            load_table(snapshot),
            time_column=worker_input.timeColumn,
            test_fraction=worker_input.trainingConfig.testFraction,
            random_seed=worker_input.trainingConfig.randomSeed,
            feature_order=[
                feature.name for feature in worker_input.features
            ],
            trainer_version=worker_input.trainingConfig.trainerVersion,
        )

        output = FakeTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert output.success_payload["splitMetadata"]["featureOrder"] == [
            "occupancy",
            "temperature",
        ]
        validate_fake_result("worker-test", worker_input, output.success_payload)

    def test_split_metadata_is_contract_valid_for_seeded_split(self, tmp_path):
        snapshot = make_snapshot_file(
            tmp_path,
            columns=[
                ("temperature", pa.float64()),
                ("energy_usage", pa.float64()),
            ],
            rows=[(21.5, 240.5), (22.0, 310.2), (19.0, 180.0)],
        )
        context = make_context(
            snapshot_uri="snapshot.parquet",
            content_sha256=sha256_of(snapshot),
            row_count=3,
            time_column=None,
            columns=(
                DatasetColumn("temperature", "feature", "number", False, 0),
                DatasetColumn("energy_usage", "target", "number", False, 1),
            ),
        )
        worker_input = build_worker_input_with_features(
            context,
            str(tmp_path),
            features=[
                {"name": "temperature", "dataType": "number", "position": 0},
            ],
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
            expected_row_count=3,
            max_rows=100_000,
        )
        split = split_dataset(
            load_table(snapshot),
            time_column=None,
            test_fraction=worker_input.trainingConfig.testFraction,
            random_seed=worker_input.trainingConfig.randomSeed,
            feature_order=[
                feature.name for feature in worker_input.features
            ],
            trainer_version=worker_input.trainingConfig.trainerVersion,
        )

        output = FakeTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert output.success_payload["splitMetadata"]["strategy"] == "seeded"
        assert output.success_payload["splitMetadata"]["timeColumn"] is None
        validate_fake_result("worker-test", worker_input, output.success_payload)
