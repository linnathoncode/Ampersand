"""Shared helpers for worker execution tests.

These helpers build real Parquet snapshot fixtures, trusted execution
contexts, and validated worker inputs so the worker behavior can be exercised
without a running PostgreSQL instance.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from uuid import uuid4

import pyarrow as pa
import pyarrow.parquet as pq

from worker.contracts import (
    TrainingWorkerInput,
    build_worker_input as build_contract_worker_input,
)
from worker.database import DatasetColumn, JobExecutionContext
from worker.splitting import load_snapshot_table as load_table

FINGERPRINT = "a" * 64
JOB_ID = "11111111-1111-4111-8111-111111111111"
SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222"
DATASET_DEFINITION_ID = "33333333-3333-4333-8333-333333333333"
SCHEMA_NAME = "tenant_ampersand_dev"

FEATURE_NUMBER = ("temperature", pa.float64())
FEATURE_INTEGER = ("occupancy", pa.int64())
TARGET_NUMBER = ("energy_usage", pa.float64())
TIME_COLUMN = ("recorded_at", pa.timestamp("ms"))

VALID_COLUMNS = [
    FEATURE_NUMBER,
    FEATURE_INTEGER,
    TARGET_NUMBER,
    TIME_COLUMN,
]

VALID_ROWS = [
    (21.5, 3, 240.5, 1700000000000),
    (22.0, 5, 310.2, 1700000060000),
    (19.0, 2, 180.0, 1700000120000),
    (24.5, 7, 420.8, 1700000180000),
    (18.5, 1, 150.3, 1700000240000),
]

TRAINING_CONFIG = {
    "trainerVersion": "1.0.0",
    "algorithmPolicy": "automatic-regression",
    "randomSeed": 42,
    "splitStrategy": "chronological",
    "testFraction": 0.2,
    "maxRuntimeSeconds": 600,
}


def write_parquet(
    path: Path,
    columns: list[tuple[str, pa.DataType]],
    rows: list[tuple],
) -> None:
    arrays = []
    for index, (name, dtype) in enumerate(columns):
        values = [row[index] for row in rows] if rows else []
        arrays.append(pa.array(values, type=dtype))
    table = pa.Table.from_arrays(arrays, names=[column[0] for column in columns])
    pq.write_table(table, path)


def write_parquet_row_groups(
    path: Path,
    columns: list[tuple[str, pa.DataType]],
    rows: list[tuple],
    rows_per_group: int = 10_000,
) -> None:
    writer = pq.ParquetWriter(path, pa.schema(columns))
    try:
        for start in range(0, len(rows), rows_per_group):
            chunk = rows[start : start + rows_per_group]
            arrays = []
            for index, (_, dtype) in enumerate(columns):
                values = [row[index] for row in chunk]
                arrays.append(pa.array(values, type=dtype))
            table = pa.Table.from_arrays(
                arrays, names=[column[0] for column in columns]
            )
            writer.write_table(table)
    finally:
        writer.close()


def sha256_of(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def make_snapshot_file(
    tmp_path: Path,
    columns: list[tuple[str, pa.DataType]] | None = None,
    rows: list[tuple] | None = None,
    name: str = "snapshot.parquet",
) -> Path:
    columns = columns if columns is not None else VALID_COLUMNS
    rows = rows if rows is not None else VALID_ROWS
    path = tmp_path / name
    write_parquet(path, columns, rows)
    return path


def make_context(
    *,
    snapshot_uri: str,
    content_sha256: str,
    row_count: int,
    columns: tuple[DatasetColumn, ...] | None = None,
    job_fingerprint: str = FINGERPRINT,
    snapshot_format: str = "parquet",
    time_column: str | None = "recorded_at",
    training_config: dict | None = None,
) -> JobExecutionContext:
    if columns is None:
        columns = (
            DatasetColumn("temperature", "feature", "number", False, 0),
            DatasetColumn("occupancy", "feature", "integer", False, 1),
            DatasetColumn("energy_usage", "target", "number", False, 2),
            DatasetColumn("recorded_at", "time", "datetime", False, 3),
        )
    return JobExecutionContext(
        job_id=JOB_ID,
        job_fingerprint=job_fingerprint,
        training_config=training_config or TRAINING_CONFIG,
        max_runtime_seconds=600,
        snapshot_id=SNAPSHOT_ID,
        snapshot_uri=snapshot_uri,
        snapshot_format=snapshot_format,
        snapshot_content_sha256=content_sha256,
        snapshot_row_count=row_count,
        dataset_definition_id=DATASET_DEFINITION_ID,
        source_schema=SCHEMA_NAME,
        source_table="energy_readings",
        target_column="energy_usage",
        time_column=time_column,
        columns=columns,
        schema_name=SCHEMA_NAME,
    )


def build_worker_input(
    context: JobExecutionContext, artifact_output_directory: str
) -> TrainingWorkerInput:
    features = [
        {"name": "temperature", "dataType": "number", "position": 0},
        {"name": "occupancy", "dataType": "integer", "position": 1},
    ]
    return _contract_worker_input(
        context, features, artifact_output_directory
    )


def build_worker_input_with_features(
    context: JobExecutionContext,
    artifact_output_directory: str,
    features: list[dict],
) -> TrainingWorkerInput:
    return _contract_worker_input(
        context, features, artifact_output_directory
    )


def _contract_worker_input(
    context: JobExecutionContext,
    features: list[dict],
    artifact_output_directory: str,
) -> TrainingWorkerInput:
    return build_contract_worker_input(
        tenant_schema=context.schema_name,
        job_id=context.job_id,
        job_fingerprint=context.job_fingerprint,
        dataset_definition_id=context.dataset_definition_id,
        snapshot={
            "id": context.snapshot_id,
            "storageUri": context.snapshot_uri,
            "format": context.snapshot_format,
            "contentSha256": context.snapshot_content_sha256,
            "rowCount": context.snapshot_row_count,
        },
        features=features,
        target={"name": "energy_usage", "dataType": "number"},
        time_column=context.time_column,
        training_config=context.training_config,
        artifact_output_directory=artifact_output_directory,
        heartbeat_interval_seconds=10,
    )


def fresh_job_id() -> str:
    return str(uuid4())