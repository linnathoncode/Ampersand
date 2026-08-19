"""Convert a fitted regression pipeline into a verified temporary ONNX payload.

The worker-result contract requires a genuine ONNX artifact, so this module
turns the fitted scikit-learn pipeline into ONNX bytes and validates them
before a success result is produced:

- the pipeline is converted with ``skl2onnx`` using initial types derived from
  the trusted worker features (numeric, integer, and boolean features as float
  inputs; categorical features as string inputs);
- the payload is loaded with the ONNX runtime to confirm it is structurally
  valid;
- the model interface is checked against the trusted feature order and types;
- ONNX predictions on the test partition are compared with the fitted Python
  pipeline within a defined tolerance.

The produced file is named as a temporary, non-registerable output and is
removed whenever any conversion or validation step fails. Persisting it as an
immutable model artifact is a later-day responsibility.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType, StringTensorType

from .contracts import TrainingWorkerInput
from .errors import (
    TrainingOnnxConversionError,
    TrainingOnnxError,
    TrainingOnnxInputInvalidError,
    TrainingOnnxOutputInvalidError,
    TrainingOnnxPredictionMismatchError,
    TrainingOnnxRuntimeInvalidError,
)

ONNX_ARTIFACT_SUFFIX = ".onnx.tmp"

PREDICTION_TOLERANCE_RTOL = 1e-4
PREDICTION_TOLERANCE_ATOL = 1e-3


def convert_and_verify(
    pipeline: Any,
    worker_input: TrainingWorkerInput,
    feature_frame: Any,
    expected_predictions: np.ndarray,
    output_directory: str,
) -> tuple[Path, dict]:
    """Convert and validate the fitted pipeline into a temporary ONNX payload.

    Returns ``(temporary_path, artifact_metadata)``.
    ``artifact_metadata`` matches the worker-result contract; the temporary
    path is removed immediately after the worker boundary validates the
    result. Any failure removes the temporary file before the structured error
    propagates.
    """
    initial_types = _initial_types(worker_input)
    try:
        converted = convert_sklearn(pipeline, initial_types=initial_types)
        onnx_bytes = converted.SerializeToString()
    except Exception as exc:
        raise TrainingOnnxConversionError(
            "The fitted pipeline could not be converted into an ONNX payload"
        ) from exc

    path = _unique_temporary_path(worker_input, output_directory)
    try:
        path.write_bytes(onnx_bytes)
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise TrainingOnnxConversionError(
            "The ONNX payload could not be written to temporary storage"
        ) from exc

    try:
        session = ort.InferenceSession(
            onnx_bytes, providers=["CPUExecutionProvider"]
        )
        onnx_predictions = _run_verified_session(
            session, worker_input, feature_frame
        )
        _assert_prediction_parity(onnx_predictions, expected_predictions)
    except TrainingOnnxError:
        path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise TrainingOnnxRuntimeInvalidError(
            "The ONNX payload could not be loaded by the runtime"
        ) from exc

    artifact = {
        "storageUri": path.name,
        "format": "onnx",
        "contentSha256": hashlib.sha256(onnx_bytes).hexdigest(),
        "sizeBytes": len(onnx_bytes),
    }
    return path, artifact


def _initial_types(worker_input: TrainingWorkerInput) -> list[tuple[str, Any]]:
    """Build skl2onnx initial types in the trusted feature order."""
    initial_types = []
    for feature in worker_input.features:
        if feature.dataType == "category":
            initial_types.append(
                (feature.name, StringTensorType([None, 1]))
            )
        else:
            initial_types.append(
                (feature.name, FloatTensorType([None, 1]))
            )
    return initial_types


def _run_verified_session(
    session: ort.InferenceSession,
    worker_input: TrainingWorkerInput,
    feature_frame: Any,
) -> np.ndarray:
    """Run the ONNX payload on the test partition and validate its interface."""
    expected_names = [feature.name for feature in worker_input.features]
    actual_names = [item.name for item in session.get_inputs()]
    if actual_names != expected_names:
        raise TrainingOnnxInputInvalidError(
            "The ONNX model inputs do not match the trusted feature order"
        )
    for feature, item in zip(worker_input.features, session.get_inputs()):
        if feature.dataType == "category" and item.type != "tensor(string)":
            raise TrainingOnnxInputInvalidError(
                f"ONNX input '{feature.name}' is not a string tensor"
            )
        if feature.dataType != "category" and item.type not in (
            "tensor(float)",
            "tensor(double)",
            "tensor(int64)",
        ):
            raise TrainingOnnxInputInvalidError(
                f"ONNX input '{feature.name}' is not numeric"
            )

    feed = {}
    for feature in worker_input.features:
        values = feature_frame[feature.name]
        if feature.dataType == "category":
            feed[feature.name] = (
                values.astype(str).to_numpy(dtype=object).reshape(-1, 1)
            )
        else:
            feed[feature.name] = (
                values.to_numpy(dtype=np.float32).reshape(-1, 1)
            )

    try:
        outputs = session.run(None, feed)
    except Exception as exc:
        raise TrainingOnnxRuntimeInvalidError(
            "The ONNX payload failed to produce predictions"
        ) from exc

    if len(outputs) != 1:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX model must return exactly one output"
        )
    output = np.asarray(outputs[0])
    if output.ndim != 2 or output.shape[1] != 1:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX model must return one prediction per row"
        )
    if output.shape[0] != feature_frame.shape[0]:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX prediction row count does not match the test partition"
        )
    return output.reshape(-1)


def _assert_prediction_parity(
    onnx_predictions: np.ndarray, python_predictions: np.ndarray
) -> None:
    python_predictions = np.asarray(python_predictions, dtype=np.float64)
    if onnx_predictions.shape != python_predictions.shape:
        raise TrainingOnnxPredictionMismatchError(
            "The ONNX prediction shape differs from the fitted Python pipeline"
        )
    if not np.allclose(
        onnx_predictions,
        python_predictions,
        rtol=PREDICTION_TOLERANCE_RTOL,
        atol=PREDICTION_TOLERANCE_ATOL,
    ):
        raise TrainingOnnxPredictionMismatchError(
            "The ONNX predictions differ from the fitted Python pipeline "
            "beyond the defined tolerance"
        )


def _unique_temporary_path(
    worker_input: TrainingWorkerInput, output_directory: str
) -> Path:
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    return directory / f"{worker_input.jobId}.{token}{ONNX_ARTIFACT_SUFFIX}"
