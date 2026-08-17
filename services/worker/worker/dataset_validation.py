"""Validate a frozen Parquet snapshot against trusted training metadata.

The worker reads the verified snapshot only after its checksum matches. This
module confirms the Parquet structure matches the trusted dataset definition:
column presence and order, declared data types, the numeric target, the
optional datetime time column, nullability, row bounds, and finite numeric
values. Any mismatch produces a stable structured failure before a trainer is
invoked, so invalid data can never produce a prediction or model.

The snapshot is read in bounded batches and only bounded per-column statistics
are retained (row count, missing counts, numeric bounds, and bounded category
values). The full dataset is never materialized in memory, so memory use stays
bounded regardless of the snapshot size.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .errors import (
    SnapshotArtifactInvalidError,
    SnapshotCategoryCardinalityExceededError,
    SnapshotColumnMissingError,
    SnapshotColumnOrderInvalidError,
    SnapshotColumnTypeInvalidError,
    SnapshotEmptyError,
    SnapshotNonFiniteValueError,
    SnapshotNullabilityInvalidError,
    SnapshotRowCountExceededError,
    SnapshotRowCountMismatchError,
    SnapshotTargetInvalidError,
    SnapshotTimeColumnInvalidError,
    WorkerError,
)

_READ_BATCH_ROWS = 64_000

_CATEGORY_MAX_UNIQUE_VALUES = 10_000

_NUMERIC_TYPES = ("number", "integer")

_ARROW_TYPE_CHECKS: dict[str, Any] = {
    "number": pa.types.is_float64,
    "integer": pa.types.is_int64,
    "boolean": pa.types.is_boolean,
    "category": pa.types.is_string,
    "text": pa.types.is_string,
    "datetime": lambda t: pa.types.is_timestamp(t) or pa.types.is_date(t),
}


@dataclass(frozen=True)
class TrustedColumn:
    """One dataset column as recorded by the API for the worker boundary."""

    name: str
    role: str
    data_type: str
    is_nullable: bool
    position: int


@dataclass(frozen=True)
class ColumnStats:
    """Bounded per-column statistics gathered while validating a snapshot."""

    name: str
    missing_count: int
    valid_min: float | None
    valid_max: float | None
    allowed_values: tuple[str, ...] | None


@dataclass(frozen=True)
class ValidatedDataset:
    """A verified snapshot and its trusted column contract and statistics."""

    row_count: int
    columns: tuple[TrustedColumn, ...]
    column_stats: tuple[ColumnStats, ...]


def validate_snapshot_dataset(
    path: Path,
    columns: tuple[TrustedColumn, ...],
    expected_row_count: int,
    max_rows: int,
    on_batch: Callable[[], None] | None = None,
) -> ValidatedDataset:
    """Validate the Parquet snapshot at ``path`` against trusted metadata.

    The file is read in bounded batches so long reads can report progress via
    ``on_batch`` instead of blocking a caller (such as the executor heartbeat)
    for the whole file. Only bounded per-column statistics are retained; the
    full dataset is never materialized in memory.
    """
    try:
        parquet_file = pq.ParquetFile(path)
        schema = parquet_file.schema_arrow
    except Exception as exc:
        raise SnapshotArtifactInvalidError(
            "Snapshot artifact is not a readable Parquet file"
        ) from exc

    if not columns:
        raise SnapshotColumnMissingError(
            "The dataset definition has no selected columns"
        )

    ordered_columns = tuple(sorted(columns, key=lambda column: column.position))
    _validate_schema(schema, ordered_columns)

    accumulators = {
        column.name: _ColumnAccumulator(column) for column in ordered_columns
    }
    total_rows = 0
    try:
        for batch in parquet_file.iter_batches(batch_size=_READ_BATCH_ROWS):
            total_rows += batch.num_rows
            if total_rows > max_rows:
                raise SnapshotRowCountExceededError(
                    "Snapshot row count exceeds the configured limit"
                )
            _validate_batch_values(batch, ordered_columns, accumulators)
            if on_batch is not None:
                on_batch()
    except WorkerError:
        raise
    except Exception as exc:
        raise SnapshotArtifactInvalidError(
            "Snapshot artifact is not a readable Parquet file"
        ) from exc

    if total_rows == 0:
        raise SnapshotEmptyError("Snapshot contains no rows")
    if total_rows > max_rows:
        raise SnapshotRowCountExceededError(
            "Snapshot row count exceeds the configured limit"
        )
    if total_rows != expected_row_count:
        raise SnapshotRowCountMismatchError(
            "Snapshot row count does not match its trusted metadata"
        )

    return ValidatedDataset(
        row_count=total_rows,
        columns=ordered_columns,
        column_stats=tuple(
            accumulators[column.name].build() for column in ordered_columns
        ),
    )


class _ColumnAccumulator:
    """Aggregate bounded statistics for one trusted column across batches."""

    def __init__(self, column: TrustedColumn) -> None:
        self._column = column
        self.missing_count = 0
        self.valid_min: float | None = None
        self.valid_max: float | None = None
        self._category_values: set[str] = set()

    def consume(self, array: pa.Array) -> None:
        self.missing_count += array.null_count
        if self._column.data_type in _NUMERIC_TYPES:
            bounds = pc.min_max(array, skip_nulls=True)
            minimum = bounds["min"].as_py()
            maximum = bounds["max"].as_py()
            if minimum is not None:
                minimum = float(minimum)
                self.valid_min = (
                    minimum
                    if self.valid_min is None
                    else min(self.valid_min, minimum)
                )
            if maximum is not None:
                maximum = float(maximum)
                self.valid_max = (
                    maximum
                    if self.valid_max is None
                    else max(self.valid_max, maximum)
                )
        elif self._column.data_type == "category":
            for value in pc.unique(array).to_pylist():
                if value is None:
                    continue
                self._category_values.add(value)
                if len(self._category_values) > _CATEGORY_MAX_UNIQUE_VALUES:
                    raise SnapshotCategoryCardinalityExceededError(
                        f"Category column '{self._column.name}' exceeds the "
                        "unique-value safety bound"
                    )

    def build(self) -> ColumnStats:
        allowed_values = None
        if self._column.data_type == "category":
            allowed_values = tuple(sorted(self._category_values, key=str))
        return ColumnStats(
            name=self._column.name,
            missing_count=self.missing_count,
            valid_min=self.valid_min,
            valid_max=self.valid_max,
            allowed_values=allowed_values,
        )


def _validate_schema(
    schema: pa.Schema, columns: tuple[TrustedColumn, ...]
) -> None:
    _validate_column_presence_and_order(schema, columns)
    _validate_column_types(schema, columns)


def _validate_column_presence_and_order(
    schema: pa.Schema, columns: tuple[TrustedColumn, ...]
) -> None:
    expected_names = [column.name for column in columns]
    actual_names = schema.names

    if set(actual_names) != set(expected_names):
        missing = [
            name
            for name in expected_names
            if name not in actual_names
        ]
        if missing:
            for name in missing:
                column = next(c for c in columns if c.name == name)
                if column.role == "target":
                    raise SnapshotTargetInvalidError(
                        "The training target column is missing from the snapshot"
                    )
                if column.role == "time":
                    raise SnapshotTimeColumnInvalidError(
                        f"Time column '{name}' is missing from the snapshot"
                    )
            raise SnapshotColumnMissingError(
                f"Snapshot is missing trusted column(s): {', '.join(missing)}"
            )
        raise SnapshotColumnOrderInvalidError(
            "Snapshot contains columns not present in the trusted definition"
        )

    if actual_names != expected_names:
        raise SnapshotColumnOrderInvalidError(
            "Snapshot column order does not match the trusted definition"
        )


def _validate_column_types(
    schema: pa.Schema, columns: tuple[TrustedColumn, ...]
) -> None:
    for column in columns:
        field = schema.field(column.name)
        check = _ARROW_TYPE_CHECKS.get(column.data_type)
        if check is None or not check(field.type):
            if column.role == "target":
                raise SnapshotTargetInvalidError(
                    "The training target is not numeric"
                )
            if column.role == "time":
                raise SnapshotTimeColumnInvalidError(
                    f"Time column '{column.name}' is not a datetime column"
                )
            raise SnapshotColumnTypeInvalidError(
                f"Snapshot column '{column.name}' has an unexpected type"
            )

    features = [column for column in columns if column.role == "feature"]
    for feature in features:
        if feature.data_type not in ("number", "integer", "boolean", "category"):
            raise SnapshotColumnTypeInvalidError(
                f"Feature column '{feature.name}' uses an unsupported data type"
            )

    targets = [column for column in columns if column.role == "target"]
    if len(targets) != 1:
        raise SnapshotTargetInvalidError(
            "The snapshot does not identify exactly one numeric target"
        )
    if targets[0].data_type not in ("number", "integer"):
        raise SnapshotTargetInvalidError(
            "The training target is not numeric"
        )


def _validate_batch_values(
    batch: pa.RecordBatch,
    columns: tuple[TrustedColumn, ...],
    accumulators: dict[str, _ColumnAccumulator],
) -> None:
    for column in columns:
        array = batch.column(column.name)
        if not column.is_nullable and array.null_count > 0:
            raise SnapshotNullabilityInvalidError(
                f"Snapshot column '{column.name}' contains missing values"
            )
        if column.data_type == "number" and pa.types.is_float64(array.type):
            non_finite = pc.any(
                pc.or_(pc.is_nan(array), pc.is_inf(array)),
                skip_nulls=True,
            )
            if non_finite.as_py():
                raise SnapshotNonFiniteValueError(
                    f"Snapshot column '{column.name}' contains a non-finite value"
                )
        accumulators[column.name].consume(array)
