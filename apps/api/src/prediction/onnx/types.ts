import type { PredictionInputValue } from "@ampersand/contracts";

export type OnnxFeature = {
  name: string;
  position: number;
  dataType: "number" | "integer" | "boolean" | "category";
  isRequired: boolean;
  allowedValues: Array<string | number> | null;
};

export type RunOnnxInferenceInput = {
  artifactBytes: Uint8Array;
  features: OnnxFeature[];
  inputs: Record<string, PredictionInputValue>;
};

export type OnnxInferenceResult = {
  prediction: number;
  uncertainty: number | null;
};
