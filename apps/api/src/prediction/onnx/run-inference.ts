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
  const session = await ort.InferenceSession.create(input.artifactBytes);

  try {
    const modelInterface = validateModelInterface(session, input.features);
    const feeds = modelInterface === "combined"
      ? createCombinedFeatureFeed(input)
      : createNamedFeatureFeeds(input);
    const outputs = await session.run(feeds);
    const outputName = modelInterface === "combined"
      ? MODEL_OUTPUT_NAME
      : session.outputNames[0]!;
    const predictionOutput = outputs[outputName];

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

function validateModelInterface(
  session: ort.InferenceSession,
  features: RunOnnxInferenceInput["features"],
): "combined" | "named" {
  if (session.inputNames.length === 1 && session.inputNames[0] === MODEL_INPUT_NAME) {
    if (!session.outputNames.includes(MODEL_OUTPUT_NAME)) {
      throw new Error(
        `ONNX model must define an output named '${MODEL_OUTPUT_NAME}'`,
      );
    }
    return "combined";
  }

  const expectedInputNames = [...features]
    .sort((left, right) => left.position - right.position)
    .map((feature) => feature.name);

  if (
    session.inputNames.length !== expectedInputNames.length ||
    session.inputNames.some((name, index) => name !== expectedInputNames[index])
  ) {
    throw new Error(
      "ONNX model inputs do not match the registered feature order",
    );
  }

  if (session.outputNames.length !== 1) {
    throw new Error("ONNX model must define exactly one prediction output");
  }

  return "named";
}

function createCombinedFeatureFeed(
  input: RunOnnxInferenceInput,
): Record<string, ort.Tensor> {
  const values = buildOnnxFeatureValues(input.features, input.inputs);
  return {
    [MODEL_INPUT_NAME]: new ort.Tensor("float32", values, [1, values.length]),
  };
}

function createNamedFeatureFeeds(
  input: RunOnnxInferenceInput,
): Record<string, ort.Tensor> {
  return Object.fromEntries(
    [...input.features]
      .sort((left, right) => left.position - right.position)
      .map((feature) => {
        const value = input.inputs[feature.name];
        if (value === undefined) {
          throw new Error(`Required ONNX feature '${feature.name}' is missing`);
        }

        if (feature.dataType === "category") {
          if (typeof value !== "string") {
            throw new Error(`ONNX feature '${feature.name}' must be categorical`);
          }
          return [feature.name, new ort.Tensor("string", [value], [1, 1])];
        }

        const numericValue = feature.dataType === "boolean"
          ? value === true ? 1 : value === false ? 0 : Number.NaN
          : value;
        if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
          throw new Error(`ONNX feature '${feature.name}' must be numerical`);
        }
        return [
          feature.name,
          new ort.Tensor("float32", Float32Array.from([numericValue]), [1, 1]),
        ];
      }),
  );
}
