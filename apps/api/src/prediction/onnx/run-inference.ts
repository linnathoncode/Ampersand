import * as ort from "onnxruntime-node";

import { buildOnnxFeatureValues } from "./build-input-tensor";
import type {
  OnnxInferenceResult,
  RunOnnxInferenceInput,
} from "./types";

const MODEL_INPUT_NAME = "features";
const MODEL_OUTPUT_NAME = "prediction";

export async function runOnnxInference(
  input: RunOnnxInferenceInput,
): Promise<OnnxInferenceResult> {
  const featureValues = buildOnnxFeatureValues(
    input.features,
    input.inputs,
  );

  const session = await ort.InferenceSession.create(input.artifactBytes);

  try {
    validateModelInterface(session);

    const featureTensor = new ort.Tensor(
      "float32",
      featureValues,
      [1, featureValues.length],
    );

    const outputs = await session.run({
      [MODEL_INPUT_NAME]: featureTensor,
    });

    const predictionOutput = outputs[MODEL_OUTPUT_NAME];

    if (!(predictionOutput instanceof ort.Tensor)) {
      throw new Error(
        `ONNX model did not return '${MODEL_OUTPUT_NAME}' as a tensor`,
      );
    }

    if (
      predictionOutput.type !== "float32" &&
      predictionOutput.type !== "float64"
    ) {
      throw new Error("ONNX prediction output must be float32 or float64");
    }

    if (predictionOutput.data.length !== 1) {
      throw new Error(
        "ONNX prediction output must contain exactly one value",
      );
    }

    const prediction = Number(predictionOutput.data[0]);

    if (!Number.isFinite(prediction)) {
      throw new Error("ONNX prediction output must be a finite number");
    }

    return {
      prediction,
      uncertainty: null,
    };
  } finally {
    await session.release();
  }
}

function validateModelInterface(session: ort.InferenceSession): void {
  if (
    session.inputNames.length !== 1 ||
    session.inputNames[0] !== MODEL_INPUT_NAME
  ) {
    throw new Error(
      `ONNX model must define one input named '${MODEL_INPUT_NAME}'`,
    );
  }

  if (!session.outputNames.includes(MODEL_OUTPUT_NAME)) {
    throw new Error(
      `ONNX model must define an output named '${MODEL_OUTPUT_NAME}'`,
    );
  }
}
