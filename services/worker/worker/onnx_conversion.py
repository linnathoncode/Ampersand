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
immutable model artifact is handled by a separate registration step.
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
    if not worker_input.features:
        raise TrainingOnnxConversionError(
            "The fitted pipeline has no features to convert"
        )
    if feature_frame is None or getattr(feature_frame, "shape", None) is None:
        raise TrainingOnnxInputInvalidError(
            "Test feature frame is missing or has no shape"
        )
    if feature_frame.shape[0] == 0:
        raise TrainingOnnxInputInvalidError(
            "Test feature frame contains no rows"
        )
    initial_types = _initial_types(worker_input)
    if not initial_types:
        raise TrainingOnnxConversionError(
            "No ONNX initial types could be derived from the trusted features"
        )
    try:
        converted = convert_sklearn(pipeline, initial_types=initial_types)
        onnx_bytes = converted.SerializeToString()
    except Exception as exc:
        raise TrainingOnnxConversionError(
            "The fitted pipeline could not be converted into an ONNX payload"
        ) from exc

    if not onnx_bytes or len(onnx_bytes) == 0:
        raise TrainingOnnxConversionError(
            "The ONNX conversion produced an empty payload"
        )

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
        _validate_onnx_interface(session, worker_input)
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
    if artifact["sizeBytes"] < 1:
        path.unlink(missing_ok=True)
        raise TrainingOnnxConversionError(
            "The ONNX payload has an invalid size"
        )
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


def _validate_onnx_interface(
    session: ort.InferenceSession,
    worker_input: TrainingWorkerInput,
) -> None:
    """Validate ONNX input names, types, and shapes against trusted features.

    Checks that input order matches ``worker_input.features``, that categorical
    inputs are string tensors and numeric inputs are float/double/int64, and
    that each input exposes a 2-D shape ``[None, 1]`` (or equivalent dynamic
    first dimension). Also validates there is exactly one 2-D output ``[N,1]``.
    """
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
        _validate_input_shape(item)
    outputs = session.get_outputs()
    if len(outputs) != 1:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX model must return exactly one output"
        )
    _validate_output_shape(outputs[0])


def _validate_input_shape(item: Any) -> None:
    shape = getattr(item, "shape", None)
    if shape is None or len(shape) != 2:
        raise TrainingOnnxInputInvalidError(
            f"ONNX input '{item.name}' must have shape [None, 1]"
        )
    if shape[1] != 1:
        raise TrainingOnnxInputInvalidError(
            f"ONNX input '{item.name}' must have shape [None, 1]"
        )
    batch_dim = shape[0]
    # Batch dimension must be dynamic: None, -1, or symbolic string.
    # Fixed numeric batch sizes (e.g. 1, 8, 32) are rejected to prevent
    # single-row test data from masking multi-row inference failures.
    if isinstance(batch_dim, int):
        if batch_dim != -1:
            raise TrainingOnnxInputInvalidError(
                f"ONNX input '{item.name}' has a fixed batch dimension; expected dynamic [None, 1]"
            )
    elif batch_dim is None:
        pass
    elif isinstance(batch_dim, str):
        if not batch_dim:
            raise TrainingOnnxInputInvalidError(
                f"ONNX input '{item.name}' must have shape [None, 1]"
            )
    else:
        raise TrainingOnnxInputInvalidError(
            f"ONNX input '{item.name}' must have shape [None, 1]"
        )


def _validate_output_shape(item: Any) -> None:
    shape = getattr(item, "shape", None)
    if shape is None or len(shape) != 2:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX model output must have shape [N, 1]"
        )
    if shape[1] != 1:
        raise TrainingOnnxOutputInvalidError(
            "The ONNX model output must have shape [N, 1]"
        )


def _run_verified_session(
    session: ort.InferenceSession,
    worker_input: TrainingWorkerInput,
    feature_frame: Any,
) -> np.ndarray:
    """Run the ONNX payload on the test partition and validate its interface."""

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
