"""Focused tests for chronological and deterministic dataset splitting."""

from __future__ import annotations

from datetime import date

import pytest

import pyarrow as pa

from worker.errors import (
    SnapshotTimeColumnInvalidError,
    SnapshotTimeValueMissingError,
    TrainingSplitBoundaryInvalidError,
    TrainingSplitInsufficientRowsError,
)
from worker.splitting import (
    ROUNDING_RULE,
    dependency_versions,
    load_snapshot_table,
    split_dataset,
)

from support import write_parquet

TIME_COLUMNS = [
    ("temperature", pa.float64()),
    ("occupancy", pa.int64()),
    ("energy_usage", pa.float64()),
    ("recorded_at", pa.timestamp("ms")),
]

TIME_ROWS = [
    (21.5, 3, 240.5, 1700000120000),
    (22.0, 5, 310.2, 1700000000000),
    (19.0, 2, 180.0, 1700000240000),
    (24.5, 7, 420.8, 1700000180000),
    (18.5, 1, 150.3, 1700000060000),
]

NO_TIME_COLUMNS = [
    ("temperature", pa.float64()),
    ("occupancy", pa.int64()),
    ("energy_usage", pa.float64()),
]

NO_TIME_ROWS = [
    (21.5, 3, 240.5),
    (22.0, 5, 310.2),
    (19.0, 2, 180.0),
    (24.5, 7, 420.8),
    (18.5, 1, 150.3),
]

DATE32_COLUMNS = [
    ("temperature", pa.float64()),
    ("occupancy", pa.int64()),
    ("energy_usage", pa.float64()),
    ("recorded_at", pa.date32()),
]

DATE64_COLUMNS = [
    ("temperature", pa.float64()),
    ("occupancy", pa.int64()),
    ("energy_usage", pa.float64()),
    ("recorded_at", pa.date64()),
]

DATE_ROWS = [
    (21.5, 3, 240.5, date(2026, 8, 3)),
    (22.0, 5, 310.2, date(2026, 8, 1)),
    (19.0, 2, 180.0, date(2026, 8, 4)),
    (24.5, 7, 420.8, date(2026, 8, 2)),
]


def write_snapshot(tmp_path, columns, rows):
    path = tmp_path / "split.parquet"
    write_parquet(path, columns, rows)
    return path


def split_table(
    tmp_path,
    columns,
    rows,
    *,
    time_column=None,
    test_fraction=0.2,
    random_seed=42,
    feature_order=("temperature", "occupancy"),
    trainer_version="1.0.0",
):
    snapshot = write_snapshot(tmp_path, columns, rows)
    table = load_snapshot_table(snapshot)
    return split_dataset(
        table,
        time_column=time_column,
        test_fraction=test_fraction,
        random_seed=random_seed,
        feature_order=list(feature_order),
        trainer_version=trainer_version,
    )


class TestChronologicalSplit:
    def test_sorts_rows_chronologically_without_leakage(self, tmp_path):
        split = split_table(tmp_path, TIME_COLUMNS, TIME_ROWS, time_column="recorded_at")

        train_times = split.train_table.column("recorded_at").to_pylist()
        test_times = split.test_table.column("recorded_at").to_pylist()

        assert train_times == sorted(train_times)
        assert test_times == sorted(test_times)
        assert all(test_time > train_times[-1] for test_time in test_times)
        assert split.metadata["trainRowCount"] + split.metadata["testRowCount"] == 5
        assert split.metadata["trainingBoundary"] < split.metadata["testStart"]

    def test_split_boundary_and_fraction_rounding(self, tmp_path):
        split = split_table(
            tmp_path,
            TIME_COLUMNS,
            TIME_ROWS,
            time_column="recorded_at",
            test_fraction=0.2,
        )

        assert split.metadata["testRowCount"] == 1
        assert split.metadata["trainRowCount"] == 4
        assert split.metadata["roundingRule"] == ROUNDING_RULE
        assert split.metadata["testFraction"] == 0.2

    def test_half_fraction_rounds_up(self, tmp_path):
        rows = TIME_ROWS[:3]
        split = split_table(
            tmp_path,
            TIME_COLUMNS,
            rows,
            time_column="recorded_at",
            test_fraction=0.5,
        )

        assert split.metadata["testRowCount"] == 2
        assert split.metadata["trainRowCount"] == 1

    def test_fraction_clamped_to_keep_train_rows(self, tmp_path):
        rows = TIME_ROWS[:2]
        split = split_table(
            tmp_path,
            TIME_COLUMNS,
            rows,
            time_column="recorded_at",
            test_fraction=0.9,
        )

        assert split.metadata["testRowCount"] == 1
        assert split.metadata["trainRowCount"] == 1

    def test_duplicate_timestamps_never_cross_boundary(self, tmp_path):
        rows = [
            (21.5, 3, 240.5, 1700000000000),
            (22.0, 5, 310.2, 1700000060000),
            (19.0, 2, 180.0, 1700000060000),
            (24.5, 7, 420.8, 1700000060000),
            (18.5, 1, 150.3, 1700000120000),
        ]
        split = split_table(
            tmp_path,
            TIME_COLUMNS,
            rows,
            time_column="recorded_at",
            test_fraction=0.4,
        )

        train_times = set(split.train_table.column("recorded_at").to_pylist())
        test_times = set(split.test_table.column("recorded_at").to_pylist())

        assert not (train_times & test_times)
        assert split.metadata["testRowCount"] == 1
        assert split.metadata["trainingBoundary"] < split.metadata["testStart"]

    def test_all_rows_with_same_timestamp_fail(self, tmp_path):
        rows = [
            (21.5, 3, 240.5, 1700000000000),
            (22.0, 5, 310.2, 1700000000000),
            (19.0, 2, 180.0, 1700000000000),
        ]

        with pytest.raises(TrainingSplitBoundaryInvalidError):
            split_table(
                tmp_path, TIME_COLUMNS, rows, time_column="recorded_at"
            )

    def test_missing_timestamps_rejected(self, tmp_path):
        rows = [
            (21.5, 3, 240.5, None),
            (22.0, 5, 310.2, 1700000060000),
        ]

        with pytest.raises(SnapshotTimeValueMissingError):
            split_table(
                tmp_path, TIME_COLUMNS, rows, time_column="recorded_at"
            )

    def test_configured_time_column_missing_from_table(self, tmp_path):
        rows = [(21.5, 240.5), (22.0, 310.2)]
        columns = [
            ("temperature", pa.float64()),
            ("energy_usage", pa.float64()),
        ]

        with pytest.raises(SnapshotTimeColumnInvalidError):
            split_table(
                tmp_path, columns, rows, time_column="recorded_at"
            )

    def test_single_row_cannot_form_two_partitions(self, tmp_path):
        rows = [(21.5, 3, 240.5, 1700000000000)]

        with pytest.raises(TrainingSplitInsufficientRowsError):
            split_table(
                tmp_path, TIME_COLUMNS, rows, time_column="recorded_at"
            )

    @pytest.mark.parametrize(
        "columns",
        [DATE32_COLUMNS, DATE64_COLUMNS],
        ids=["date32", "date64"],
    )
    def test_date_columns_split_chronologically(self, tmp_path, columns):
        split = split_table(
            tmp_path, columns, DATE_ROWS, time_column="recorded_at"
        )

        train_times = split.train_table.column("recorded_at").to_pylist()
        test_times = split.test_table.column("recorded_at").to_pylist()

        assert train_times == sorted(train_times)
        assert all(test_time > train_times[-1] for test_time in test_times)
        assert split.metadata["trainRowCount"] + split.metadata["testRowCount"] == 4
        assert split.metadata["trainingBoundary"] < split.metadata["testStart"]
        assert split.metadata["trainingBoundary"].endswith("T00:00:00+00:00")
        assert split.metadata["testStart"].endswith("T00:00:00+00:00")


class TestSeededSplit:
    def test_no_time_column_uses_deterministic_seed(self, tmp_path):
        first = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            random_seed=7,
        )
        second = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            random_seed=7,
        )

        assert first.train_table.to_pylist() == second.train_table.to_pylist()
        assert first.metadata == second.metadata
        assert first.metadata["strategy"] == "seeded"
        assert first.metadata["timeColumn"] is None
        assert first.metadata["trainingBoundary"] is None
        assert first.metadata["testStart"] is None

    def test_changed_seed_changes_row_order(self, tmp_path):
        first = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            random_seed=7,
        )
        changed = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            random_seed=8,
        )

        assert (
            first.train_table.column("temperature").to_pylist()
            != changed.train_table.column("temperature").to_pylist()
        )
        assert changed.metadata["randomSeed"] == 8

    def test_partitions_cover_every_row(self, tmp_path):
        split = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            random_seed=7,
        )

        train = split.train_table.to_pylist()
        test = split.test_table.to_pylist()
        assert len(train) + len(test) == 5
        assert sorted(train + test, key=lambda row: row["temperature"]) == sorted(
            [
                {
                    "temperature": temperature,
                    "occupancy": occupancy,
                    "energy_usage": energy_usage,
                }
                for temperature, occupancy, energy_usage in NO_TIME_ROWS
            ],
            key=lambda row: row["temperature"],
        )


class TestSplitMetadata:
    def test_feature_order_recorded_stably(self, tmp_path):
        split = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            feature_order=["occupancy", "temperature"],
        )

        assert split.metadata["featureOrder"] == [
            "occupancy",
            "temperature",
        ]

    def test_metadata_records_versions(self, tmp_path):
        split = split_table(
            tmp_path,
            NO_TIME_COLUMNS,
            NO_TIME_ROWS,
            time_column=None,
            trainer_version="1.0.0",
        )

        versions = split.metadata["dependencyVersions"]
        assert split.metadata["trainerVersion"] == "1.0.0"
        assert versions["python"]
        assert versions["pyarrow"]
        assert versions["pydantic"]

    def test_dependency_versions_are_non_empty(self):
        versions = dependency_versions()

        assert set(versions) >= {"python", "pyarrow", "pydantic"}
        assert all(bool(value) for value in versions.values())