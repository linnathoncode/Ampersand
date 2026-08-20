"""Focused tests for real regression training against a reproducible split."""

from __future__ import annotations

import datetime as dt
import numpy as np
import pyarrow as pa
import pytest

from worker import regression_trainer as rt
from worker import onnx_conversion as oc
from worker.database import DatasetColumn
from worker.errors import (
    TrainingFitError,
    TrainingInsufficientRowsError,
    TrainingMetricsInvalidError,
    TrainingOnnxConversionError,
    TrainingOnnxPredictionMismatchError,
    TrainingOnnxRuntimeInvalidError,
    TrainingTargetConstantError,
    TrainingTargetMissingError,
    TrainingTargetNonFiniteError,
    TrainingTargetNullError,
)
from worker.onnx_conversion import ONNX_ARTIFACT_SUFFIX
from worker.regression_trainer import (
    RegressionTrainer,
    validate_regression_result,
)
from worker.splitting import DatasetSplit, split_dataset

from support import (
    build_worker_input_with_features,
    load_table,
    make_context,
    make_snapshot_file,
    sha256_of,
    validated_dataset,
)


def numeric_fixture_data(row_count=20):
    """Deterministic rows with a near-perfect linear target relationship."""
    temps = np.linspace(-5.0, 30.0, row_count)
    occupancy = np.arange(row_count) % 5 + 1
    targets = 2.5 * temps + 3.0 * occupancy + 100.0
    times = 1_700_000_000_000 + np.arange(row_count) * 60_000
    rows = [
        (float(temps[i]), float(occupancy[i]), float(targets[i]), int(times[i]))
        for i in range(row_count)
    ]
    return rows


def make_fixture(
    tmp_path,
    *,
    snapshot_columns,
    rows,
    features,
    time_column="recorded_at",
):
    """Build snapshot, trusted context, worker input, dataset, and split."""
    snapshot = make_snapshot_file(
        tmp_path, columns=snapshot_columns, rows=rows
    )
    role_by_name: dict[str, tuple[str, str]] = {}
    for position, (name, data_type) in enumerate(features):
        role_by_name[name] = ("feature", data_type)
    role_by_name["energy_usage"] = ("target", "number")
    if time_column is not None:
        role_by_name[time_column] = ("time", "datetime")

    context_columns = []
    for position, (name, _) in enumerate(snapshot_columns):
        role, data_type = role_by_name[name]
        is_nullable = any(row[position] is None for row in rows)
        context_columns.append(
            DatasetColumn(name, role, data_type, is_nullable, position)
        )

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
    worker_input = build_worker_input_with_features(
        context, str(tmp_path), feature_inputs
    )
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


def numeric_fixture(tmp_path, row_count=20, **kwargs):
    rows = numeric_fixture_data(row_count)
    columns = [
        ("temperature", pa.float64()),
        ("occupancy", pa.int64()),
        ("energy_usage", pa.float64()),
        ("recorded_at", pa.timestamp("ms")),
    ]
    features = [("temperature", "number"), ("occupancy", "integer")]
    return make_fixture(
        tmp_path, snapshot_columns=columns, rows=rows, features=features, **kwargs
    )


class TestBaseline:
    def test_baseline_predicts_training_target_mean(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        train_target = np.asarray(
            split.train_table.column("energy_usage").to_numpy(), dtype=np.float64
        )
        expected = float(np.mean(train_target))
        assert np.allclose(output.baseline_predictions, expected)
        assert output.baseline_predictions.shape == output.model_predictions.shape
        assert output.baseline_predictions.shape[0] == split.test_table.num_rows

    def test_model_beats_naive_baseline_on_the_same_split(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        metrics = output.success_payload["metrics"]
        baseline = output.success_payload["baselineMetrics"]
        assert metrics["mae"] < baseline["mae"]
        assert metrics["r2"] > baseline["r2"]
        assert metrics["r2"] > 0.9
        assert baseline["mae"] > 0
        validate_regression_result("worker-test", worker_input, output.success_payload)


class TestUncertainty:
    def test_uncertainty_is_the_held_out_model_rmse(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        metrics = output.success_payload["metrics"]
        assert output.uncertainty == metrics["rmse"]
        assert output.uncertainty >= 0

    def test_uncertainty_matches_hand_calculated_test_rmse(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        y_test = np.asarray(
            split.test_table.column("energy_usage").to_numpy(), dtype=np.float64
        )
        residuals = y_test - output.model_predictions
        expected = float(np.sqrt(np.mean(np.square(residuals))))
        assert output.uncertainty == pytest.approx(round(expected, 4), abs=1e-9)

    def test_uncertainty_is_finite_and_non_negative(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert np.isfinite(output.uncertainty)
        assert output.uncertainty >= 0

    def test_repeated_training_yields_identical_uncertainty(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)
        trainer = RegressionTrainer(str(tmp_path))

        first = trainer.train(worker_input, dataset, split)
        second = trainer.train(worker_input, dataset, split)

        assert first.uncertainty == second.uncertainty

    def test_non_finite_uncertainty_estimate_is_rejected(self):
        with pytest.raises(TrainingMetricsInvalidError):
            rt._uncertainty_estimate({"rmse": float("nan")})

    def test_infinite_uncertainty_estimate_is_rejected(self):
        with pytest.raises(TrainingMetricsInvalidError):
            rt._uncertainty_estimate({"rmse": float("inf")})

    def test_negative_uncertainty_estimate_is_rejected(self):
        with pytest.raises(TrainingMetricsInvalidError):
            rt._uncertainty_estimate({"rmse": -1.0})

    def test_missing_rmse_uncertainty_estimate_is_rejected(self):
        with pytest.raises(TrainingMetricsInvalidError):
            rt._uncertainty_estimate({})

    def test_invalid_rmse_type_uncertainty_estimate_is_rejected(self):
        with pytest.raises(TrainingMetricsInvalidError):
            rt._uncertainty_estimate({"rmse": "1.0"})

    def test_uncertainty_is_not_a_worker_contract_field(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert "uncertainty" not in output.success_payload
        validate_regression_result("worker-test", worker_input, output.success_payload)


class TestMetricsExactness:
    def test_evaluate_matches_hand_computed_values(self):
        assert rt._evaluate(
            np.array([1.0, 2.0, 3.0, 4.0]), np.array([2.0, 2.0, 2.0, 2.0])
        ) == {"mae": 1.0, "rmse": 1.2247, "r2": -0.2}

    def test_evaluate_two_point_case(self):
        assert rt._evaluate(
            np.array([0.0, 1.0]), np.array([0.0, 0.0])
        ) == {"mae": 0.5, "rmse": 0.7071, "r2": -1.0}

    def test_evaluate_constant_target_perfect_prediction(self):
        assert rt._evaluate(
            np.array([5.0, 5.0, 5.0]), np.array([5.0, 5.0, 5.0])
        ) == {"mae": 0.0, "rmse": 0.0, "r2": 1.0}

    def test_evaluate_constant_target_imperfect_prediction(self):
        assert rt._evaluate(
            np.array([5.0, 5.0, 5.0]), np.array([6.0, 5.0, 4.0])
        ) == {"mae": 0.6667, "rmse": 0.8165, "r2": 0.0}

    def test_perfect_linear_fit_produces_zero_error_metrics(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        metrics = output.success_payload["metrics"]
        assert metrics["mae"] == pytest.approx(0.0, abs=1e-9)
        assert metrics["rmse"] == pytest.approx(0.0, abs=1e-9)
        assert metrics["r2"] == pytest.approx(1.0, abs=1e-9)

    def test_baseline_metrics_match_hand_computed_rmse(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        train_target = np.asarray(
            split.train_table.column("energy_usage").to_numpy(), dtype=np.float64
        )
        test_target = np.asarray(
            split.test_table.column("energy_usage").to_numpy(), dtype=np.float64
        )
        baseline_value = float(np.mean(train_target))
        expected_rmse = float(
            np.sqrt(np.mean(np.square(test_target - baseline_value)))
        )
        baseline = output.success_payload["baselineMetrics"]
        assert baseline["rmse"] == pytest.approx(round(expected_rmse, 4), abs=1e-9)
        assert all(round(value, 4) == value for value in baseline.values())

    def test_all_metrics_are_rounded_to_four_decimals(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        for group in ("metrics", "baselineMetrics"):
            assert all(
                round(value, 4) == value
                for value in output.success_payload[group].values()
            )


class TestFeatureTypes:
    def test_boolean_feature_trains(self, tmp_path):
        rows = numeric_fixture_data(20)
        columns = [
            ("temperature", pa.float64()),
            ("is_weekend", pa.bool_()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (temp, (int(i) % 2 == 0), target, time)
            for i, (temp, _, target, time) in enumerate(rows)
        ]
        features = [("temperature", "number"), ("is_weekend", "boolean")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        validate_regression_result("worker-test", worker_input, output.success_payload)
        assert np.isfinite(output.model_predictions).all()

    def test_categorical_feature_trains_and_records_allowed_values(self, tmp_path):
        rows = numeric_fixture_data(20)
        regions = ["north" if i % 2 == 0 else "south" for i in range(20)]
        columns = [
            ("temperature", pa.float64()),
            ("region", pa.string()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (temp, regions[i], target, time)
            for i, (temp, _, target, time) in enumerate(rows)
        ]
        features = [("temperature", "number"), ("region", "category")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        validate_regression_result("worker-test", worker_input, output.success_payload)
        assert np.isfinite(output.model_predictions).all()
        region_meta = next(
            feature
            for feature in output.success_payload["features"]
            if feature["name"] == "region"
        )
        assert set(region_meta["allowedValues"]) == {"north", "south"}

    def test_category_value_seen_only_in_test_is_ignored(self, tmp_path):
        rows = numeric_fixture_data(20)
        regions = ["north"] * 15 + ["south"] * 5
        columns = [
            ("temperature", pa.float64()),
            ("region", pa.string()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (temp, regions[i], target, time)
            for i, (temp, _, target, time) in enumerate(rows)
        ]
        features = [("temperature", "number"), ("region", "category")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert np.isfinite(output.model_predictions).all()
        validate_regression_result("worker-test", worker_input, output.success_payload)

    def test_mixed_feature_types_train(self, tmp_path):
        rows = numeric_fixture_data(20)
        regions = ["east" if i % 3 == 0 else "west" for i in range(20)]
        columns = [
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("is_weekend", pa.bool_()),
            ("region", pa.string()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (temp, int(occ), int(i) % 2 == 0, regions[i], target, time)
            for i, (temp, occ, target, time) in enumerate(rows)
        ]
        features = [
            ("temperature", "number"),
            ("occupancy", "integer"),
            ("is_weekend", "boolean"),
            ("region", "category"),
        ]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert np.isfinite(output.model_predictions).all()
        validate_regression_result("worker-test", worker_input, output.success_payload)

    def test_nullable_numeric_feature_is_imputed(self, tmp_path):
        rows = numeric_fixture_data(20)
        temps = list(rows)
        temps[3] = (None, temps[3][1], temps[3][2], temps[3][3])
        temps[11] = (None, temps[11][1], temps[11][2], temps[11][3])
        columns = [
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        features = [("temperature", "number"), ("occupancy", "integer")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=temps, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert np.isfinite(output.model_predictions).all()
        temperature_meta = next(
            feature
            for feature in output.success_payload["features"]
            if feature["name"] == "temperature"
        )
        assert temperature_meta["missingRate"] == pytest.approx(2 / 20, abs=1e-6)
        validate_regression_result("worker-test", worker_input, output.success_payload)


class TestFeatureStatistics:
    def test_numeric_feature_bounds_are_exact(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        features = {
            feature["name"]: feature
            for feature in output.success_payload["features"]
        }
        assert features["temperature"]["validMin"] == -5.0
        assert features["temperature"]["validMax"] == 30.0
        assert features["occupancy"]["validMin"] == 1.0
        assert features["occupancy"]["validMax"] == 5.0

    def test_missing_rate_covers_the_full_snapshot(self, tmp_path):
        rows = numeric_fixture_data(20)
        rows[19] = (None, rows[19][1], rows[19][2], rows[19][3])
        columns = [
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        features = [("temperature", "number"), ("occupancy", "integer")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        expected_time = dt.datetime.fromtimestamp(
            (1_700_000_000_000 + 19 * 60_000) / 1000.0, tz=dt.timezone.utc
        ).replace(tzinfo=None)
        assert split.test_table.num_rows == 4
        assert expected_time in split.test_table.column("recorded_at").to_pylist()

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        temperature_meta = next(
            feature
            for feature in output.success_payload["features"]
            if feature["name"] == "temperature"
        )
        assert temperature_meta["missingRate"] == pytest.approx(1 / 20, abs=1e-6)
        validate_regression_result("worker-test", worker_input, output.success_payload)

    def test_category_allowed_values_are_sorted_over_the_full_snapshot(self, tmp_path):
        rows = numeric_fixture_data(20)
        regions = ["north"] * 16 + ["south"] * 4
        columns = [
            ("temperature", pa.float64()),
            ("region", pa.string()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (temp, regions[i], target, time)
            for i, (temp, _, target, time) in enumerate(rows)
        ]
        features = [("temperature", "number"), ("region", "category")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        assert split.test_table.num_rows == 4
        test_regions = set(split.test_table.column("region").to_pylist())
        assert test_regions == {"south"}

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        region_meta = next(
            feature
            for feature in output.success_payload["features"]
            if feature["name"] == "region"
        )
        assert region_meta["allowedValues"] == ["north", "south"]
        validate_regression_result("worker-test", worker_input, output.success_payload)

    def test_emitted_features_exclude_target_and_time_columns(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        features = output.success_payload["features"]
        names = [feature["name"] for feature in features]
        assert names == ["temperature", "occupancy"]
        assert "energy_usage" not in names
        assert "recorded_at" not in names
        assert [feature["dataType"] for feature in features] == [
            "number",
            "integer",
        ]
        assert [feature["position"] for feature in features] == [0, 1]


class TestDeterminism:
    def test_repeated_training_is_identical(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)
        trainer = RegressionTrainer(str(tmp_path))

        first = trainer.train(worker_input, dataset, split)
        second = trainer.train(worker_input, dataset, split)

        for key in ("metrics", "baselineMetrics", "features", "splitMetadata"):
            assert first.success_payload[key] == second.success_payload[key]
        assert first.uncertainty == second.uncertainty
        assert np.allclose(first.model_predictions, second.model_predictions)
        assert np.allclose(
            first.baseline_predictions, second.baseline_predictions
        )

    def test_feature_order_is_preserved_in_split_metadata(self, tmp_path):
        rows = numeric_fixture_data(20)
        columns = [
            ("occupancy", pa.int64()),
            ("temperature", pa.float64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        rows = [
            (int(occ), temp, target, time)
            for (temp, occ, target, time) in rows
        ]
        features = [("occupancy", "integer"), ("temperature", "number")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert output.success_payload["splitMetadata"]["featureOrder"] == [
            "occupancy",
            "temperature",
        ]
        validate_regression_result("worker-test", worker_input, output.success_payload)


class TestRejections:
    def test_insufficient_train_rows_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path, row_count=2)

        with pytest.raises(TrainingInsufficientRowsError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)

    def test_empty_test_partition_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)
        empty_test = pa.table(
            {
                "temperature": pa.array([], type=pa.float64()),
                "occupancy": pa.array([], type=pa.int64()),
                "energy_usage": pa.array([], type=pa.float64()),
            }
        )
        manual_split = DatasetSplit(
            train_table=split.train_table,
            test_table=empty_test,
            metadata={},
        )

        with pytest.raises(TrainingInsufficientRowsError):
            RegressionTrainer(str(tmp_path)).train(
                worker_input, dataset, manual_split
            )

    def test_missing_target_column_rejected(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)
        test_without_target = split.test_table.drop(["energy_usage"])
        manual_split = DatasetSplit(
            train_table=split.train_table,
            test_table=test_without_target,
            metadata={},
        )

        with pytest.raises(TrainingTargetMissingError):
            RegressionTrainer(str(tmp_path)).train(
                worker_input, dataset, manual_split
            )

    def test_null_target_rejected(self, tmp_path):
        rows = numeric_fixture_data(20)
        rows[4] = (rows[4][0], rows[4][1], None, rows[4][3])
        columns = [
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        features = [("temperature", "number"), ("occupancy", "integer")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        with pytest.raises(TrainingTargetNullError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)

    def test_non_finite_target_rejected(self, tmp_path):
        _, _, worker_input, dataset, _ = numeric_fixture(tmp_path)
        train_table = pa.table(
            {
                "temperature": pa.array([1.0, 2.0, 3.0]),
                "energy_usage": pa.array([1.0, 2.0, float("inf")]),
            }
        )
        test_table = pa.table(
            {
                "temperature": pa.array([4.0, 5.0]),
                "energy_usage": pa.array([4.0, 5.0]),
            }
        )
        manual_split = DatasetSplit(train_table=train_table, test_table=test_table, metadata={})

        with pytest.raises(TrainingTargetNonFiniteError):
            RegressionTrainer(str(tmp_path)).train(
                worker_input, dataset, manual_split
            )

    def test_constant_target_rejected(self, tmp_path):
        rows = numeric_fixture_data(20)
        rows = [
            (temp, occ, 100.0, time)
            for (temp, occ, _, time) in rows
        ]
        columns = [
            ("temperature", pa.float64()),
            ("occupancy", pa.int64()),
            ("energy_usage", pa.float64()),
            ("recorded_at", pa.timestamp("ms")),
        ]
        features = [("temperature", "number"), ("occupancy", "integer")]

        _, _, worker_input, dataset, split = make_fixture(
            tmp_path, snapshot_columns=columns, rows=rows, features=features
        )

        with pytest.raises(TrainingTargetConstantError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)


class TestFailureHandling:
    def test_estimator_fit_failure_raises_structured_error(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        class BoomPipeline:
            def fit(self, X, y):
                raise ValueError("boom")

        monkeypatch.setattr(
            rt, "build_regression_pipeline", lambda worker_input: BoomPipeline()
        )

        with pytest.raises(TrainingFitError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)

    def test_non_finite_metrics_raise_structured_error(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        def bad_evaluate(y_true, y_pred):
            return {"mae": float("nan"), "rmse": 1.0, "r2": 0.0}

        monkeypatch.setattr(rt, "_evaluate", bad_evaluate)

        with pytest.raises(TrainingMetricsInvalidError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)

    def test_non_finite_baseline_metrics_raise_structured_error(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        calls = {"count": 0}

        def alternating_evaluate(y_true, y_pred):
            calls["count"] += 1
            if calls["count"] == 1:
                return {"mae": 1.0, "rmse": 1.0, "r2": 0.5}
            return {"mae": float("nan"), "rmse": 1.0, "r2": 0.5}

        monkeypatch.setattr(rt, "_evaluate", alternating_evaluate)

        with pytest.raises(TrainingMetricsInvalidError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)


class TestArtifact:
    def test_artifact_is_a_genuine_onnx_payload(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        artifact = output.success_payload["artifact"]
        assert output.artifact_path.name.endswith(ONNX_ARTIFACT_SUFFIX)
        assert artifact["format"] == "onnx"
        assert artifact["storageUri"] == output.artifact_path.name
        assert artifact["contentSha256"] == sha256_of(output.artifact_path)
        assert artifact["sizeBytes"] == output.artifact_path.stat().st_size
        import onnxruntime as ort

        session = ort.InferenceSession(
            output.artifact_path.read_bytes(), providers=["CPUExecutionProvider"]
        )
        assert [item.name for item in session.get_inputs()] == [
            feature.name for feature in worker_input.features
        ]
        validate_regression_result("worker-test", worker_input, output.success_payload)

    def test_fitted_pipeline_is_retained_for_later_conversion(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        assert output.pipeline is not None
        X_test = split.test_table.select(
            [feature.name for feature in worker_input.features]
        ).to_pandas()
        assert np.allclose(
            output.pipeline.predict(X_test), output.model_predictions
        )

    def test_no_joblib_artifact_is_written(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)

        assert list(tmp_path.glob("*.joblib")) == []
        assert list(tmp_path.glob("*.pkl")) == []
        assert list(tmp_path.glob("*.training.tmp")) == []


class TestOnnxFailures:
    def test_conversion_failure_is_structured_and_cleans_up(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        def bad_convert(*args, **kwargs):
            raise ValueError("unsupported pipeline")

        monkeypatch.setattr(oc, "convert_sklearn", bad_convert)

        with pytest.raises(TrainingOnnxConversionError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob("*.onnx.tmp")) == []

    def test_runtime_load_failure_is_structured_and_cleans_up(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        class BrokenSession:
            def __init__(self, *args, **kwargs):
                raise ValueError("cannot load model")

        monkeypatch.setattr(oc.ort, "InferenceSession", BrokenSession)

        with pytest.raises(TrainingOnnxRuntimeInvalidError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob("*.onnx.tmp")) == []

    def test_prediction_mismatch_is_structured_and_cleans_up(self, tmp_path, monkeypatch):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        def bad_parity(*args, **kwargs):
            raise TrainingOnnxPredictionMismatchError(
                "predictions differ beyond tolerance"
            )

        monkeypatch.setattr(oc, "_assert_prediction_parity", bad_parity)

        with pytest.raises(TrainingOnnxPredictionMismatchError):
            RegressionTrainer(str(tmp_path)).train(worker_input, dataset, split)
        assert list(tmp_path.glob("*.onnx.tmp")) == []


class TestPayloadMetadata:
    def test_success_payload_records_split_and_feature_metadata(self, tmp_path):
        _, _, worker_input, dataset, split = numeric_fixture(tmp_path)

        output = RegressionTrainer(str(tmp_path)).train(
            worker_input, dataset, split
        )

        metadata = output.success_payload["splitMetadata"]
        assert metadata["strategy"] == "chronological"
        assert metadata["timeColumn"] == "recorded_at"
        assert metadata["trainRowCount"] + metadata["testRowCount"] == 20
        assert metadata["featureOrder"] == ["temperature", "occupancy"]
        assert set(metadata["dependencyVersions"]) >= {
            "scikit-learn",
            "pandas",
            "numpy",
        }
        features = output.success_payload["features"]
        assert [feature["name"] for feature in features] == [
            "temperature",
            "occupancy",
        ]
        assert features[0]["dataType"] == "number"
        assert features[0]["validMin"] is not None
        assert features[0]["validMax"] is not None
        assert features[0]["allowedValues"] is None
        validate_regression_result("worker-test", worker_input, output.success_payload)
