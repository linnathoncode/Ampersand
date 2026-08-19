"""Real regression training against the reproducible dataset split.

This trainer replaces the deterministic fake trainer. It converts the
validated train and test partitions into a real scikit-learn regression
pipeline, computes a training-only naive baseline, and produces contract-valid
metrics, feature metadata, and split metadata from the same reproducible
split.

The trainer never registers, publishes, or exposes a model. The fitted
pipeline is converted into a genuine ONNX payload that is loaded and checked
against the Python predictions before it is returned. The payload is named as
a temporary, non-registerable output; the executor removes it immediately
after the worker boundary validates the result, so it can never be persisted
or registered as a model artifact.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .contracts import TrainingWorkerInput
from .dataset_validation import ValidatedDataset
from .errors import (
    TrainingFitError,
    TrainingInsufficientRowsError,
    TrainingMetricsInvalidError,
    TrainingNoFeaturesError,
    TrainingPreprocessingError,
    TrainingTargetConstantError,
    TrainingTargetMissingError,
    TrainingTargetNonFiniteError,
    TrainingTargetNullError,
)
from .onnx_conversion import convert_and_verify
from .result_validation import validate_success_payload
from .splitting import DatasetSplit

MISSING_CATEGORY_VALUE = "__ampersand_missing__"


@dataclass(frozen=True)
class RegressionTrainingOutput:
    """The validated success payload, temporary artifact, and fitted pipeline.

    ``model_predictions`` and ``baseline_predictions`` are the test-partition
    outputs used to compute the metrics.
    """

    success_payload: dict
    artifact_path: Path
    pipeline: Pipeline
    model_predictions: np.ndarray
    baseline_predictions: np.ndarray


class RegressionTrainer:
    """Fits a real regression pipeline and a naive baseline on one split."""

    def __init__(self, artifact_output_directory: str) -> None:
        self._artifact_output_directory = artifact_output_directory

    def train(
        self,
        worker_input: TrainingWorkerInput,
        dataset: ValidatedDataset,
        split: DatasetSplit,
        on_progress: Callable[[], None] | None = None,
    ) -> RegressionTrainingOutput:
        """Train the baseline and the regression model on the same split."""
        target_name = worker_input.target.name

        _validate_split_row_counts(split.train_table, split.test_table)
        _validate_target(target_name, split.train_table, split.test_table)

        X_train, y_train = _build_matrices(
            split.train_table, worker_input.features, target_name
        )
        X_test, y_test = _build_matrices(
            split.test_table, worker_input.features, target_name
        )

        pipeline = build_regression_pipeline(worker_input)
        try:
            pipeline.fit(X_train, y_train)
        except Exception as exc:
            raise TrainingFitError(
                "The regression estimator could not be fitted to the training split"
            ) from exc

        model_predictions = _predict(pipeline, X_test)

        baseline_value = float(np.mean(y_train))
        baseline_predictions = np.full(
            np.shape(y_test), baseline_value, dtype=np.float64
        )

        metrics = _evaluate(y_test, model_predictions)
        baseline_metrics = _evaluate(y_test, baseline_predictions)
        _validate_finite_metrics(metrics)
        _validate_finite_metrics(baseline_metrics)

        features = [
            _feature_metadata(dataset, feature) for feature in worker_input.features
        ]
        if on_progress is not None:
            on_progress()

        artifact_path, artifact = convert_and_verify(
            pipeline,
            worker_input,
            X_test,
            model_predictions,
            self._artifact_output_directory,
        )

        return RegressionTrainingOutput(
            success_payload={
                "status": "succeeded",
                "metrics": metrics,
                "baselineMetrics": baseline_metrics,
                "artifact": artifact,
                "features": features,
                "splitMetadata": split.metadata,
            },
            artifact_path=artifact_path,
            pipeline=pipeline,
            model_predictions=model_predictions,
            baseline_predictions=baseline_predictions,
        )


def build_regression_pipeline(worker_input: TrainingWorkerInput) -> Pipeline:
    """Build the deterministic regression pipeline for the trusted features.

    Numeric, integer, and boolean features are mean-imputed and standardized;
    boolean values are already coerced to binary numbers by the matrix
    builder. Categorical features are one-hot encoded with unknown categories
    ignored; missing categorical values are replaced with a deterministic
    placeholder by the matrix builder so the pipeline stays ONNX-convertible.
    The pipeline is fully deterministic for identical inputs.
    """
    numeric_columns: list[str] = []
    category_columns: list[str] = []
    for feature in worker_input.features:
        if feature.dataType == "category":
            category_columns.append(feature.name)
        else:
            numeric_columns.append(feature.name)

    transformers = []
    if numeric_columns:
        transformers.append(
            (
                "numeric",
                Pipeline(
                    [
                        ("impute", SimpleImputer(strategy="mean")),
                        ("scale", StandardScaler()),
                    ]
                ),
                numeric_columns,
            )
        )
    if category_columns:
        transformers.append(
            (
                "category",
                OneHotEncoder(handle_unknown="ignore"),
                category_columns,
            )
        )

    if not transformers:
        raise TrainingNoFeaturesError(
            "The dataset definition has no usable feature columns"
        )

    preprocess = ColumnTransformer(
        transformers,
        remainder="drop",
        verbose_feature_names_out=False,
    )
    return Pipeline([("preprocess", preprocess), ("model", LinearRegression())])


def _validate_split_row_counts(train_table, test_table) -> None:
    if train_table.num_rows < 2:
        raise TrainingInsufficientRowsError(
            "Training requires at least two rows to fit a regression model"
        )
    if test_table.num_rows < 1:
        raise TrainingInsufficientRowsError(
            "Evaluation requires at least one test row"
        )


def _validate_target(
    target_name: str, train_table, test_table
) -> None:
    if target_name not in train_table.column_names:
        raise TrainingTargetMissingError(
            "The training target column is missing from the train split"
        )
    if target_name not in test_table.column_names:
        raise TrainingTargetMissingError(
            "The training target column is missing from the test split"
        )
    train_target = _target_array(train_table, target_name)
    test_target = _target_array(test_table, target_name)
    if (
        np.isnan(train_target).any()
        or np.isnan(test_target).any()
    ):
        raise TrainingTargetNullError(
            "The training target contains missing values that cannot be imputed"
        )
    if (
        not np.isfinite(train_target).all()
        or not np.isfinite(test_target).all()
    ):
        raise TrainingTargetNonFiniteError(
            "The training target contains a non-finite value"
        )
    if np.unique(train_target).size < 2:
        raise TrainingTargetConstantError(
            "The training target is constant and cannot support a regression"
        )


def _target_array(table, target_name: str) -> np.ndarray:
    return np.asarray(
        table.column(target_name).to_numpy(), dtype=np.float64
    )


def _build_matrices(
    table,
    features: list,
    target_name: str,
) -> tuple:
    """Extract trusted-order feature and target matrices from one partition.

    Column order comes from the trusted worker input rather than the Parquet
    file, and the time column is excluded from model features. Boolean
    features are coerced to numeric binary values and categorical missing
    values are replaced with a deterministic placeholder string so the
    preprocessing pipeline and its ONNX conversion stay deterministic.
    """
    if not features:
        raise TrainingNoFeaturesError(
            "The dataset definition has no usable feature columns"
        )
    feature_names = [feature.name for feature in features]
    try:
        feature_frame = table.select(feature_names).to_pandas()
    except Exception as exc:
        raise TrainingPreprocessingError(
            "The split could not be converted into feature inputs"
        ) from exc
    for feature in features:
        if feature.dataType == "boolean":
            try:
                feature_frame[feature.name] = feature_frame[feature.name].astype(
                    float
                )
            except Exception as exc:
                raise TrainingPreprocessingError(
                    f"Boolean feature '{feature.name}' could not be converted"
                ) from exc
        elif feature.dataType == "category":
            try:
                feature_frame[feature.name] = (
                    feature_frame[feature.name]
                    .fillna(MISSING_CATEGORY_VALUE)
                    .astype(str)
                )
            except Exception as exc:
                raise TrainingPreprocessingError(
                    f"Category feature '{feature.name}' could not be converted"
                ) from exc
    target = _target_array(table, target_name)
    return feature_frame, target


def _predict(pipeline: Pipeline, feature_frame) -> np.ndarray:
    try:
        return np.asarray(pipeline.predict(feature_frame), dtype=np.float64)
    except Exception as exc:
        raise TrainingPreprocessingError(
            "The trained pipeline could not predict the test split"
        ) from exc


def _evaluate(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Compute MAE, RMSE, and R-squared for one set of predictions.

    The naive baseline and the fitted model are evaluated with the same helper
    so their results stay directly comparable.
    """
    residuals = y_true - y_pred
    mae = float(np.mean(np.abs(residuals)))
    rmse = float(np.sqrt(np.mean(np.square(residuals))))
    total_variance = float(np.sum(np.square(y_true - np.mean(y_true))))
    residual_variance = float(np.sum(np.square(residuals)))
    if total_variance == 0.0:
        r2 = 1.0 if residual_variance == 0.0 else 0.0
    else:
        r2 = 1.0 - residual_variance / total_variance
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
    }


def _validate_finite_metrics(metrics: dict) -> None:
    if not all(math.isfinite(value) for value in metrics.values()):
        raise TrainingMetricsInvalidError(
            "Training produced non-finite metrics"
        )


def _feature_metadata(dataset: ValidatedDataset, feature) -> dict:
    """Freeze one feature's bounds, categories, and missing rate."""
    stats = next(
        stat for stat in dataset.column_stats if stat.name == feature.name
    )
    row_count = dataset.row_count
    missing_rate = round(
        (stats.missing_count / row_count) if row_count else 0.0, 6
    )
    allowed_values = (
        list(stats.allowed_values) if stats.allowed_values is not None else None
    )
    return {
        "name": feature.name,
        "position": feature.position,
        "dataType": feature.dataType,
        "validMin": stats.valid_min,
        "validMax": stats.valid_max,
        "allowedValues": allowed_values,
        "missingRate": missing_rate,
    }


def validate_regression_result(
    worker_id: str, worker_input: TrainingWorkerInput, success_payload: dict
) -> None:
    """Validate the assembled worker result against the private contract."""
    validate_success_payload(worker_id, worker_input, success_payload)
