import type { PredictionInputValue } from "@ampersand/contracts";

import type { OnnxFeature } from "./types";

export function buildOnnxFeatureValues(
  features: OnnxFeature[],
  inputs: Record<string, PredictionInputValue>,
): Float32Array {
  if (features.length === 0) {
    throw new Error("The model does not define any input features");
  }

  const orderedFeatures = [...features].sort(
    (left, right) => left.position - right.position,
  );

  orderedFeatures.forEach((feature, index) => {
    if (feature.position !== index) {
      throw new Error(
        "ONNX feature positions must be contiguous and start at zero",
      );
    }
  });

  return Float32Array.from(
    orderedFeatures.map((feature) =>
      toNumericFeatureValue(feature, inputs),
    ),
  );
}

function toNumericFeatureValue(
  feature: OnnxFeature,
  inputs: Record<string, PredictionInputValue>,
): number {
  if (!Object.hasOwn(inputs, feature.name)) {
    if (feature.isRequired) {
      throw new Error(`Required ONNX feature '${feature.name}' is missing`);
    }

    return Number.NaN;
  }

  const value = inputs[feature.name]!;

  switch (feature.dataType) {
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`ONNX feature '${feature.name}' must be numerical`);
      }

      return value;

    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`ONNX feature '${feature.name}' must be boolean`);
      }

      return value ? 1 : 0;

    case "category": {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(
          `ONNX feature '${feature.name}' must be categorical`,
        );
      }

      if (!feature.allowedValues) {
        throw new Error(
          `Category feature '${feature.name}' has no allowed values`,
        );
      }

      const categoryIndex = feature.allowedValues.indexOf(value);

      if (categoryIndex === -1) {
        throw new Error(
          `Category value for '${feature.name}' is not supported`,
        );
      }

      return categoryIndex;
    }
  }
}
