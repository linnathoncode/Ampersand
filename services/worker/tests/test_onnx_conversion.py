"""ONNX conversion and runtime validation tests.

Covers the worker ONNX pipeline cases:

- Successful conversion
- Unsupported pipeline
- Runtime loading (including corrupted payload)
- Input-shape validation
- Output-shape validation
- Prediction parity within defined tolerance

Also verifies temporary-file discipline and interface shape contracts
without mutating the shared worker-result contracts.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pyarrow as pa
import pytest

from worker import onnx_conversion as oc
from worker.errors import (
    TrainingOnnxConversionError,
    TrainingOnnxInputInvalidError,
    TrainingOnnxOutputInvalidError,
    TrainingOnnxPredictionMismatchError,
    TrainingOnnxRuntimeInvalidError,
)
from worker.onnx_conversion import (
    ONNX_ARTIFACT_SUFFIX,
    PREDICTION_TOLERANCE_ATOL,
    PREDICTION_TOLERANCE_RTOL,
)
from worker.regression_trainer import RegressionTrainer

from support import (
    build_worker_input_with_features,
    load_table,
    make_context,
    make_snapshot_file,
    sha256_of,
    validated_dataset,
)
from worker.splitting import split_dataset


def _numeric_fixture_data(row_count=20):
    temps = np.linspace(-5.0, 30.0, row_count)
    occupancy = np.arange(row_count) % 5 + 1
    targets = 2.5 * temps + 3.0 * occupancy + 100.0
    times = 1_700_000_000_000 + np.arange(row_count) * 60_000
    return [
        (float(temps[i]), float(occupancy[i]), float(targets[i]), int(times[i]))
        for i in range(row_count)
    ]


def _make_fixture(tmp_path, snapshot_columns, rows, features, time_column="recorded_at"):
    snapshot = make_snapshot_file(tmp_path, columns=snapshot_columns, rows=rows)
    role_by_name: dict[str, tuple[str, str]] = {}
    for position, (name, data_type) in enumerate(features):
        role_by_name[name] = ("feature", data_type)
    role_by_name["energy_usage"] = ("target", "number")
    if time_column is not None:
        role_by_name[time_column] = ("time", "datetime")
    from worker.database import DatasetColumn

    context_columns = []
    for position, (name, _) in enumerate(snapshot_columns):
        role, data_type = role_by_name[name]
        is_nullable = any(row[position] is None for row in rows)
        context_columns.append(DatasetColumn(name, role, data_type, is_nullable, position))
    context = make_context(
        snapshot_uri=snapshot.name,
        content_sha256=sha256_of(snapshot),
        row_count=len(rows),
        time_column=time_column,
        columns=tuple(context_columns),
    )
    feature_inputs = [
        {"name": name, "dataType": data_type, "position": position}
        for position, (name, data_type) in enumerate(features)
    ]
    worker_input = build_worker_input_with_features(context, str(tmp_path), feature_inputs)
    dataset = validated_dataset(snapshot, context)
    split = split_dataset(
        load_table(snapshot),
        time_column=worker_input.timeColumn,
        test_fraction=worker_input.trainingConfig.testFraction,
        random_seed=worker_input.trainingConfig.randomSeed,
        feature_order=[feature.name for feature in worker_input.features],
        trainer_version=worker_input.trainingConfig.trainerVersion,
    )
    return snapshot, context, worker_input, dataset, split


def _standard_fixture(tmp_path, row_count=20):
    rows = _numeric_fixture_data(row_count)
    columns = [
        ("temperature", pa.float64()),
        ("occupancy", pa.int64()),
        ("energy_usage", pa.float64()),
        ("recorded_at", pa.timestamp("ms")),
    ]
    features = [("temperature", "number"), ("occupancy", "integer")]
    return _make_fixture(tmp_path, snapshot_columns=columns, rows=rows, features=features)


class TestSuccessfulConversion:
    def test_converted_payload_passes_runtime_and_shape_checks(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        artifact = output.success_payload["artifact"]
        assert artifact["format"] == "onnx"
        assert artifact["storageUri"].endswith(ONNX_ARTIFACT_SUFFIX)
        assert len(artifact["contentSha256"]) == 64
        assert artifact["sizeBytes"] > 0
        assert artifact["contentSha256"] == sha256_of(output.artifact_path)
        # Runtime loading + interface shape validation
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        # Input names/shapes, output shape are validated inside oc._validate_onnx_interface
        oc._validate_onnx_interface(session, worker_input)
        for item in session.get_inputs():
            assert len(item.shape) == 2
            assert item.shape[1] == 1
        assert len(session.get_outputs()) == 1
        assert len(session.get_outputs()[0].shape) == 2
        assert session.get_outputs()[0].shape[1] == 1
        assert output.artifact_path.exists()
        assert output.artifact_path.stat().st_size > 0
        output.artifact_path.unlink(missing_ok=True)

    def test_artifact_hash_and_size_match_bytes(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        onnx_bytes = output.artifact_path.read_bytes()
        assert hashlib.sha256(onnx_bytes).hexdigest() == output.success_payload["artifact"]["contentSha256"]
        assert len(onnx_bytes) == output.success_payload["artifact"]["sizeBytes"]

    def test_interface_records_input_names_shapes_output_shape(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        input_names = [i.name for i in session.get_inputs()]
        output_names = [o.name for o in session.get_outputs()]
        assert input_names == [f.name for f in worker_input.features]
        assert len(output_names) == 1
        # input shapes [None,1], output [None,1]
        for inp in session.get_inputs():
            assert inp.shape[1] == 1
        assert session.get_outputs()[0].shape[1] == 1


class TestUnsupportedPipeline:
    def test_unsupported_estimator_raises_conversion_error_and_cleans_up(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)

        def bad_convert(*args, **kwargs):
            raise ValueError("unsupported pipeline step")

        monkeypatch.setattr(oc, "convert_sklearn", bad_convert)
        with pytest.raises(TrainingOnnxConversionError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob(f"*{ONNX_ARTIFACT_SUFFIX}")) == []

    def test_empty_onnx_bytes_raises_conversion_error(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)

        class EmptyModel:
            def SerializeToString(self):  # type: ignore[no-redef]
                return b""

        monkeypatch.setattr(oc, "convert_sklearn", lambda pipeline, initial_types: EmptyModel())
        with pytest.raises(TrainingOnnxConversionError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob(f"*{ONNX_ARTIFACT_SUFFIX}")) == []

    def test_text_feature_type_unsupported_converter_path(self, tmp_path):
        # Build a definition where a feature is 'text' — worker should reject via _WORKER_FEATURE_TYPES before conversion,
        # but onnx layer also hardens. We test onnx layer directly with a fake pipeline that skl2onnx cannot handle.
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        import worker.regression_trainer as rt

        class DummyPipeline:
            def fit(self, X, y):  # pragma: no cover
                return self

            def predict(self, X):  # pragma: no cover
                return np.zeros(len(X))

        # Monkeypatch to a pipeline that convert_sklearn will fail on due to unknown type
        import worker.onnx_conversion as oc2

        def failing_convert(pipeline, initial_types):
            raise RuntimeError("no converter for text")

        import unittest.mock as mock

        with mock.patch.object(oc2, "convert_sklearn", failing_convert):
            with pytest.raises(TrainingOnnxConversionError):
                oc2.convert_and_verify(
                    DummyPipeline(), worker_input, split.test_table.to_pandas(), np.zeros(split.test_table.num_rows), str(tmp_path)
                )


class TestRuntimeLoading:
    def test_corrupted_bytes_fail_runtime_validation_and_clean_up(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        # First get a valid artifact to ensure normal flow works, then corrupt
        original_bytes = None

        real_convert = oc.convert_sklearn

        def corrupting_convert(pipeline, initial_types):
            conv = real_convert(pipeline, initial_types=initial_types)
            return conv

        # Instead test low-level: pass invalid bytes directly via mocked InferenceSession
        class BrokenSession:
            def __init__(self, *args, **kwargs):
                raise ValueError("invalid onnx")

        monkeypatch.setattr(oc.ort, "InferenceSession", BrokenSession)
        with pytest.raises(TrainingOnnxRuntimeInvalidError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob(f"*{ONNX_ARTIFACT_SUFFIX}")) == []

    def test_truncated_file_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        onnx_bytes = output.artifact_path.read_bytes()
        truncated = onnx_bytes[:10]
        import onnxruntime as ort

        with pytest.raises(Exception):
            ort.InferenceSession(truncated, providers=["CPUExecutionProvider"])

    def test_valid_payload_loads_with_cpu_provider(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        assert session.get_providers() == ["CPUExecutionProvider"]


class TestInputShapeValidation:
    def test_input_name_mismatch_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        # Build a worker_input with swapped order
        from support import make_context, sha256_of, build_worker_input_with_features, make_snapshot_file

        # reuse same snapshot file but swap feature order
        swapped_features = [
            {"name": "occupancy", "dataType": "integer", "position": 0},
            {"name": "temperature", "dataType": "number", "position": 1},
        ]
        # need context for swapped order: use same snapshot
        snapshot_path = tmp_path / "snapshot.parquet"
        # We already have a snapshot file from fixture; rebuild with same name to get context
        # Simpler: reuse worker_input but monkeypatch features order
        swapped_input = build_worker_input_with_features(
            make_context(
                snapshot_uri=output.artifact_path.name,  # dummy uri matching not used for interface check
                content_sha256="a" * 64,
                row_count=20,
                columns=(
                    # minimal column set to build input; type checks only use features/target, not snapshot
                    __import__("worker.database", fromlist=["DatasetColumn"]).DatasetColumn("occupancy", "feature", "integer", False, 0),
                    __import__("worker.database", fromlist=["DatasetColumn"]).DatasetColumn("temperature", "feature", "number", False, 1),
                    __import__("worker.database", fromlist=["DatasetColumn"]).DatasetColumn("energy_usage", "target", "number", False, 2),
                    __import__("worker.database", fromlist=["DatasetColumn"]).DatasetColumn("recorded_at", "time", "datetime", False, 3),
                ),
            ),
            str(tmp_path),
            swapped_features,
        )
        with pytest.raises(TrainingOnnxInputInvalidError):
            oc._validate_onnx_interface(session, swapped_input)

    def test_input_wrong_type_rejected(self, tmp_path):
        # Build a worker_input where a category feature is declared numeric but ONNX has string
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        # Create a category fixture and validate mismatch by tampering
        rows = _numeric_fixture_data(20)
        regions = ["north" if i % 2 == 0 else "south" for i in range(20)]
        columns = [
            ("temperature", pa.float64()),
            ("region", pa.string()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows_cat = [(r[0], regions[i], r[2], r[3]) for i, r in enumerate(rows)]
        features = [("temperature", "number"), ("region", "category")]
        _, _, cat_input, cat_dataset, cat_split = _make_fixture(tmp_path, columns, rows_cat, features)
        cat_output = RegressionTrainer(str(tmp_path)).train(cat_input, cat_dataset, cat_split)
        import onnxruntime as ort

        session = ort.InferenceSession(cat_output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        # Now declare region as number — should fail type check
        wrong_features = [
            {"name": "temperature", "dataType": "number", "position": 0},
            {"name": "region", "dataType": "number", "position": 1},
        ]
        from support import make_context
        from worker.database import DatasetColumn

        wrong_input = build_worker_input_with_features(
            make_context(
                snapshot_uri="dummy.parquet",
                content_sha256="a" * 64,
                row_count=20,
                columns=(
                    DatasetColumn("temperature", "feature", "number", False, 0),
                    DatasetColumn("region", "feature", "category", False, 1),
                    DatasetColumn("energy_usage", "target", "number", False, 2),
                    DatasetColumn("recorded_at", "time", "datetime", False, 3),
                ),
            ),
            str(tmp_path),
            wrong_features,
        )
        # The session has tensor(string) for region, but wrong_input says number -> mismatch
        with pytest.raises(TrainingOnnxInputInvalidError):
            oc._validate_onnx_interface(session, wrong_input)

    def test_input_shape_second_dim_must_be_one(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        # Tamper with the first input's shape to be [None, 2]
        orig_shape = session.get_inputs()[0].shape
        # onnxruntime input shape is read-only tuple/list; we test _validate_input_shape directly with fake item
        class FakeItem:
            name = worker_input.features[0].name
            shape = [None, 2]

        with pytest.raises(TrainingOnnxInputInvalidError):
            oc._validate_input_shape(FakeItem())

    def test_empty_feature_frame_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        import pandas as pd

        empty = pd.DataFrame({f.name: [] for f in worker_input.features})
        from sklearn.pipeline import Pipeline

        dummy = Pipeline([("m", __import__("sklearn.linear_model", fromlist=["LinearRegression"]).LinearRegression())])
        # We don't actually fit; just test guard in convert_and_verify
        with pytest.raises(TrainingOnnxInputInvalidError):
            oc.convert_and_verify(dummy, worker_input, empty, np.array([]), str(tmp_path))

    def test_fixed_batch_shape_rejected(self):
        for fixed in [0, 1, 2, 8, 32]:
            class FakeItem:
                name = "temperature"
                shape = [fixed, 1]

            with pytest.raises(TrainingOnnxInputInvalidError):
                oc._validate_input_shape(FakeItem())

    @pytest.mark.parametrize("batch_dim", [None, -1, "batch", "N", "dim_0"])
    def test_dynamic_batch_shapes_accepted(self, batch_dim):
        class FakeItem:
            name = "temperature"
            shape = [batch_dim, 1]

        oc._validate_input_shape(FakeItem())

    def test_empty_batch_dim_string_rejected(self):
        class FakeItem:
            name = "temperature"
            shape = ["", 1]

        with pytest.raises(TrainingOnnxInputInvalidError):
            oc._validate_input_shape(FakeItem())


class TestOutputShapeValidation:
    def test_output_wrong_ndim_rejected(self, tmp_path):
        class FakeOut:
            shape = [None]  # 1-D

        with pytest.raises(TrainingOnnxOutputInvalidError):
            oc._validate_output_shape(FakeOut())

    def test_output_second_dim_not_one_rejected(self, tmp_path):
        class FakeOut:
            shape = [None, 2]

        with pytest.raises(TrainingOnnxOutputInvalidError):
            oc._validate_output_shape(FakeOut())

    def test_runtime_output_shape_mismatch_rejected(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        real_session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])

        class FakeSession:
            def get_inputs(self):
                return real_session.get_inputs()

            def get_outputs(self):
                return real_session.get_outputs()

            def run(self, *args, **kwargs):
                # Return 2 columns instead of 1
                return [np.zeros((split.test_table.num_rows, 2))]

        # Must pass interface validation then fail at runtime shape
        oc._validate_onnx_interface(FakeSession(), worker_input)
        with pytest.raises(TrainingOnnxOutputInvalidError):
            oc._run_verified_session(FakeSession(), worker_input, split.test_table.select([f.name for f in worker_input.features]).to_pandas())

    def test_output_row_count_mismatch_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        # Pass a feature frame with different row count than model output would be expected to match
        # We test via _run_verified_session where output.shape[0] != feature_frame.shape[0]
        # Monkeypatch session.run to return correctly shaped but wrong row count
        class FakeSession2:
            def get_inputs(self):
                return session.get_inputs()

            def get_outputs(self):
                return session.get_outputs()

            def run(self, *a, **k):
                return [np.zeros((999, 1))]

        import pandas as pd

        frame = split.test_table.select([f.name for f in worker_input.features]).to_pandas()
        with pytest.raises(TrainingOnnxOutputInvalidError):
            oc._run_verified_session(FakeSession2(), worker_input, frame)


class TestPredictionParity:
    def test_parity_within_tolerance_passes(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        # Directly test parity helper within tolerance
        a = np.array([1.0, 2.0, 3.0])
        b = a + 1e-5  # within 1e-4 rtol + 1e-3 atol
        oc._assert_prediction_parity(a, b)  # should not raise

    def test_parity_beyond_tolerance_fails(self, tmp_path):
        a = np.array([1.0, 2.0, 3.0])
        b = a + 0.1  # beyond atol 1e-3
        with pytest.raises(TrainingOnnxPredictionMismatchError):
            oc._assert_prediction_parity(a, b)

    def test_parity_shape_mismatch_fails(self, tmp_path):
        a = np.array([1.0, 2.0])
        b = np.array([1.0, 2.0, 3.0])
        with pytest.raises(TrainingOnnxPredictionMismatchError):
            oc._assert_prediction_parity(a, b)

    def test_full_onnx_vs_python_parity_end_to_end(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        import onnxruntime as ort

        session = ort.InferenceSession(output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"])
        import pandas as pd

        X_test = split.test_table.select([f.name for f in worker_input.features]).to_pandas()
        # Reproduce feed as in oc._run_verified_session
        feed = {}
        for feature in worker_input.features:
            feed[feature.name] = X_test[feature.name].to_numpy(dtype=np.float32).reshape(-1, 1)
        onnx_pred = session.run(None, feed)[0].reshape(-1)
        # Must be within tolerance to python predictions
        assert np.allclose(onnx_pred, output.model_predictions, rtol=PREDICTION_TOLERANCE_RTOL, atol=PREDICTION_TOLERANCE_ATOL)
        oc._assert_prediction_parity(onnx_pred, output.model_predictions)

    def test_temporary_file_cleaned_on_parity_failure(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        monkeypatch.setattr(oc, "_assert_prediction_parity", lambda a, b: (_ for _ in ()).throw(TrainingOnnxPredictionMismatchError("mismatch")))
        with pytest.raises(TrainingOnnxPredictionMismatchError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob(f"*{ONNX_ARTIFACT_SUFFIX}")) == []


class TestTemporaryFileDiscipline:
    def test_success_artifact_is_tmp_and_not_persisted_by_executor_semantics(self, tmp_path):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        output = RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        # Trainer returns tmp path; executor must unlink — simulate executor cleanup
        assert output.artifact_path.suffixes == [".onnx", ".tmp"] or output.artifact_path.name.endswith(ONNX_ARTIFACT_SUFFIX)
        assert output.artifact_path.exists()
        output.artifact_path.unlink(missing_ok=True)
        assert not output.artifact_path.exists()
        # No .onnx without .tmp should exist (immutable artifact registration is separate)
        assert list(tmp_path.glob("*.onnx")) == [] or all(p.name.endswith(ONNX_ARTIFACT_SUFFIX) for p in tmp_path.glob("*.onnx*"))

    def test_failure_leaves_no_tmp_file(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = _standard_fixture(tmp_path)
        monkeypatch.setattr(oc, "convert_sklearn", lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")))
        with pytest.raises(TrainingOnnxConversionError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob(f"*{ONNX_ARTIFACT_SUFFIX}")) == []
