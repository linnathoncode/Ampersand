"""Chronological and deterministic dataset splitting.

This module turns a validated snapshot into reproducible training and test
partitions. When a time column is configured, rows are sorted chronologically
and the split keeps every test timestamp strictly after the training
boundary. Equal timestamps are never separated across the boundary, because a
duplicate timestamp on both sides would let training see future rows.

When no time column is configured, a deterministic seeded shuffle produces
the split instead; there is no chronological order to preserve.

All input is already validated (schema, types, row count, and bounds), so
this module only orders, partitions, and records reproducible split metadata.
The loaded table stays within the snapshot row-count limit enforced during
validation.
"""

from __future__ import annotations

import platform
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version as _package_version
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .errors import (
    SnapshotArtifactInvalidError,
    SnapshotTimeColumnInvalidError,
    SnapshotTimeValueInvalidError,
    SnapshotTimeValueMissingError,
    TrainingSplitBoundaryInvalidError,
    TrainingSplitInsufficientRowsError,
    TrainingSplitInvalidError,
)

ROUNDING_RULE = (
    "round(rowCount * testFraction), clamped so both partitions keep at "
    "least one row"
)


@dataclass(frozen=True)
class DatasetSplit:
    """The partitioned dataset and its reproducible split metadata."""

    train_table: pa.Table
    test_table: pa.Table
    metadata: dict[str, Any]


def load_snapshot_table(
    path: Path,
    on_batch: Callable[[], None] | None = None,
) -> pa.Table:
    """Load the validated snapshot into a bounded in-memory table."""
    try:
        table = pq.read_table(path)
    except Exception as exc:
        raise SnapshotArtifactInvalidError(
            "Snapshot artifact is not a readable Parquet file"
        ) from exc
    if on_batch is not None:
        on_batch()
    return table


def split_dataset(
    table: pa.Table,
    *,
    time_column: str | None,
    test_fraction: float,
    random_seed: int,
    feature_order: list[str],
    trainer_version: str,
    on_batch: Callable[[], None] | None = None,
) -> DatasetSplit:
    """Partition a validated table and build its split metadata.

    ``feature_order`` must already be in trusted position order. The result is
    deterministic for identical inputs, fraction, and seed.
    """
    row_count = table.num_rows
    if row_count < 2:
        raise TrainingSplitInsufficientRowsError(
            "Training requires at least two rows to form train and test partitions"
        )

    test_row_count = _resolve_test_row_count(row_count, test_fraction)

    if time_column is not None:
        strategy = "chronological"
        train_indices, test_indices, boundary_times = _chronological_split(
            table, time_column, test_row_count
        )
        training_boundary, test_start = boundary_times
    else:
        strategy = "seeded"
        train_indices, test_indices = _seeded_split(
            row_count, test_row_count, random_seed
        )
        training_boundary = None
        test_start = None

    train_table = _select_rows(table, train_indices)
    test_table = _select_rows(table, test_indices)
    if on_batch is not None:
        on_batch()

    metadata = {
        "strategy": strategy,
        "timeColumn": time_column,
        "trainRowCount": len(train_indices),
        "testRowCount": len(test_indices),
        "testFraction": test_fraction,
        "roundingRule": ROUNDING_RULE,
        "trainingBoundary": training_boundary,
        "testStart": test_start,
        "randomSeed": random_seed,
        "featureOrder": list(feature_order),
        "trainerVersion": trainer_version,
        "dependencyVersions": dependency_versions(),
    }
    return DatasetSplit(
        train_table=train_table,
        test_table=test_table,
        metadata=metadata,
    )


def dependency_versions() -> dict[str, str]:
    """Record the runtime versions relevant to preprocessing.

    Unknown or missing optional packages are recorded as "unknown" rather
    than failing the job; the metadata stays deterministic for a fixed
    worker environment.
    """
    versions: dict[str, str] = {"python": platform.python_version()}
    for package in (
        "pyarrow",
        "pydantic",
        "scikit-learn",
        "pandas",
        "numpy",
        "joblib",
    ):
        versions[package] = _resolve_package_version(package)
    return versions


def _resolve_package_version(package: str) -> str:
    try:
        return _package_version(package)
    except (PackageNotFoundError, ValueError):
        try:
            module = import_module(package)
            return str(getattr(module, "__version__", "unknown"))
        except Exception:
            return "unknown"


def _resolve_test_row_count(row_count: int, test_fraction: float) -> int:
    requested = round(row_count * test_fraction)
    return max(1, min(requested, row_count - 1))


def _chronological_split(
    table: pa.Table,
    time_column: str,
    test_row_count: int,
) -> tuple[list[int], list[int], tuple[str, str]]:
    if time_column not in table.column_names:
        raise SnapshotTimeColumnInvalidError(
            f"Time column '{time_column}' is missing from the snapshot"
        )
    array = table.column(time_column).combine_chunks()
    if not (
        pa.types.is_timestamp(array.type) or pa.types.is_date(array.type)
    ):
        raise SnapshotTimeColumnInvalidError(
            f"Time column '{time_column}' is not a datetime column"
        )
    if array.null_count > 0:
        raise SnapshotTimeValueMissingError(
            f"Time column '{time_column}' contains missing timestamps"
        )

    sort_order = pc.sort_indices(array)
    sorted_times = array.take(sort_order)

    first_test_index = len(sort_order) - test_row_count
    last_train_index = first_test_index - 1

    if _equal_time(sorted_times, last_train_index, first_test_index):
        first_test_index += 1
        while (
            first_test_index < len(sorted_times)
            and _equal_time(sorted_times, first_test_index - 1, first_test_index)
        ):
            first_test_index += 1
        if first_test_index >= len(sorted_times):
            raise TrainingSplitBoundaryInvalidError(
                "The time column cannot produce a valid chronological split "
                "without leaking identical timestamps across the boundary"
            )

    train_indices = sort_order[:first_test_index]
    test_indices = sort_order[first_test_index:]
    try:
        training_boundary = _to_iso_timestamp(sorted_times[first_test_index - 1])
        test_start = _to_iso_timestamp(sorted_times[first_test_index])
    except (TypeError, ValueError) as exc:
        raise SnapshotTimeValueInvalidError(
            f"Time column '{time_column}' contains an unusable timestamp value"
        ) from exc
    return (
        [int(index) for index in train_indices.to_pylist()],
        [int(index) for index in test_indices.to_pylist()],
        (training_boundary, test_start),
    )


def _seeded_split(
    row_count: int, test_row_count: int, random_seed: int
) -> tuple[list[int], list[int]]:
    indices = list(range(row_count))
    rng = random.Random(random_seed)
    rng.shuffle(indices)
    boundary = row_count - test_row_count
    return indices[:boundary], indices[boundary:]


def _select_rows(table: pa.Table, indices: list[int]) -> pa.Table:
    if not indices:
        raise TrainingSplitInvalidError("A split partition is empty")
    return table.take(pa.array(indices))


def _equal_time(array: pa.Array, left: int, right: int) -> bool:
    return bool(pc.equal(array[left], array[right]).as_py())


def _to_iso_timestamp(value: Any) -> str:
    parsed = value.as_py()
    if isinstance(parsed, datetime):
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    if isinstance(parsed, date):
        return datetime(
            parsed.year, parsed.month, parsed.day, tzinfo=timezone.utc
        ).isoformat()
    raise TypeError("time value is not a datetime or date")
