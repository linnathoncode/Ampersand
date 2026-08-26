"""Unit tests for the worker's temporary artifact helper."""

from __future__ import annotations

from pathlib import Path

from worker.artifacts import delete_temp


def test_delete_temp_removes_an_existing_payload(tmp_path: Path):
    path = tmp_path / "job.onnx.tmp"
    path.write_bytes(b"payload")

    delete_temp(path)

    assert not path.exists()


def test_delete_temp_tolerates_a_missing_payload(tmp_path: Path):
    delete_temp(tmp_path / "missing.onnx.tmp")
