"""Focused tests for snapshot verification and dataset validation."""

from __future__ import annotations

import pyarrow as pa
import pytest

from worker.dataset_validation import TrustedColumn, validate_snapshot_dataset
from worker.errors import (
    SnapshotCategoryCardinalityExceededError,
    SnapshotChecksumMismatchError,
    SnapshotColumnMissingError,
    SnapshotNotFoundError,
    SnapshotRowCountExceededError,
    SnapshotTargetInvalidError,
)
from worker.snapshots import resolve_snapshot_path, verify_snapshot_file

from support import make_snapshot_file, write_parquet_row_groups


VALID_COLUMNS = (
    TrustedColumn("temperature", "feature", "number", False, 0),
    TrustedColumn("occupancy", "feature", "integer", False, 1),
    TrustedColumn("energy_usage", "target", "number", False, 2),
    TrustedColumn("recorded_at", "time", "datetime", False, 3),
)


def validate(path, columns=VALID_COLUMNS, expected_rows=5, max_rows=100_000):
    return validate_snapshot_dataset(
        path,
        columns,
        expected_row_count=expected_rows,
        max_rows=max_rows,
    )


def test_snapshot_path_traversal_is_rejected(tmp_path):
    with pytest.raises(SnapshotNotFoundError):
        resolve_snapshot_path(str(tmp_path), "../secret.parquet")


def test_checksum_mismatch_is_rejected(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    with pytest.raises(SnapshotChecksumMismatchError):
        verify_snapshot_file(snapshot, "b" * 64, max_bytes=1024 * 1024)


def test_valid_snapshot_passes(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    assert validate(snapshot).row_count == 5


def test_missing_column_is_rejected(tmp_path):
    snapshot = make_snapshot_file(
        tmp_path,
        columns=[
            ("temperature", pa.float64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ],
        rows=[
            (21.5, 240.5, 1700000000000),
            (22.0, 310.2, 1700000060000),
            (19.0, 180.0, 1700000120000),
            (24.5, 420.8, 1700000180000),
            (18.5, 150.3, 1700000240000),
        ],
    )
    with pytest.raises(SnapshotColumnMissingError):
        validate(snapshot)


def test_invalid_target_is_rejected(tmp_path):
    columns = (
        VALID_COLUMNS[0],
        VALID_COLUMNS[1],
        TrustedColumn("energy_usage", "target", "boolean", False, 2),
        VALID_COLUMNS[3],
    )
    snapshot = make_snapshot_file(
        tmp_path,
        columns=[
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.bool_()),
            ("recorded_at", pa.timestamp("ms")),
        ],
        rows=[
            (21.5, 3, True, 1700000000000),
            (22.0, 5, False, 1700000060000),
            (19.0, 2, True, 1700000120000),
            (24.5, 7, False, 1700000180000),
            (18.5, 1, True, 1700000240000),
        ],
    )
    with pytest.raises(SnapshotTargetInvalidError):
        validate(snapshot, columns=columns)


def test_row_limit_is_enforced_before_callback_continues(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    calls = []
    with pytest.raises(SnapshotRowCountExceededError):
        validate_snapshot_dataset(
            snapshot,
            VALID_COLUMNS,
            expected_row_count=5,
            max_rows=2,
            on_batch=lambda: calls.append(1),
        )
    assert calls == []


def test_streaming_stats_are_returned_without_a_full_table(tmp_path):
    snapshot = make_snapshot_file(tmp_path)
    result = validate(snapshot)
    assert not hasattr(result, "table")
    assert result.row_count == 5
    assert [stat.name for stat in result.column_stats] == [
        "temperature",
        "occupancy",
        "energy_usage",
        "recorded_at",
    ]


def test_numeric_and_null_stats_aggregated_across_batches(tmp_path):
    columns = [
        ("temperature", pa.float64()),
        ("occupancy", pa.int64()),
        ("energy_usage", pa.float64()),
    ]
    rows = [(float(i % 100), i % 7, float(i % 5)) for i in range(130_000)]
    path = tmp_path / "big.parquet"
    write_parquet_row_groups(path, columns, rows, rows_per_group=10_000)
    trusted = (
        TrustedColumn("temperature", "feature", "number", False, 0),
        TrustedColumn("occupancy", "feature", "integer", False, 1),
        TrustedColumn("energy_usage", "target", "number", False, 2),
    )

    result = validate_snapshot_dataset(
        path,
        trusted,
        expected_row_count=130_000,
        max_rows=1_000_000,
    )

    assert result.row_count == 130_000
    stats = {stat.name: stat for stat in result.column_stats}
    assert stats["temperature"].missing_count == 0
    assert stats["temperature"].valid_min == 0.0
    assert stats["temperature"].valid_max == 99.0
    assert stats["temperature"].allowed_values is None
    assert stats["occupancy"].valid_min == 0.0
    assert stats["occupancy"].valid_max == 6.0


def test_category_cardinality_limit_is_enforced(tmp_path):
    columns = [("code", pa.string()), ("energy_usage", pa.float64())]
    rows = [(f"c{i % 20_000}", 1.0) for i in range(100_000)]
    path = tmp_path / "high_cardinality.parquet"
    write_parquet_row_groups(path, columns, rows, rows_per_group=10_000)
    trusted = (
        TrustedColumn("code", "feature", "category", False, 0),
        TrustedColumn("energy_usage", "target", "number", False, 1),
    )

    with pytest.raises(SnapshotCategoryCardinalityExceededError):
        validate_snapshot_dataset(
            path,
            trusted,
            expected_row_count=100_000,
            max_rows=1_000_000,
        )
