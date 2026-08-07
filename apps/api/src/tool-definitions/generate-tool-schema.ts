import type {
  ToolInputProperty,
  ToolInputSchema,
  ToolOutputSchema,
  GeneratedToolDefinition,
} from "@ampersand/contracts";

export type ModelFeatureMetadata = {
  columnName: string;
  dataType: "number" | "integer" | "boolean" | "category";
  description: string;
  unit: string | null;
  isRequired: boolean;
  validMin: number | null;
  validMax: number | null;
  allowedValues: Array<string | number> | null;
};

export const predictionToolOutputSchema: ToolOutputSchema = {
  type: "object",
  properties: {
    outcome: {
      enum: ["prediction", "rejected"],
    },
    prediction: {
      type: ["number", "null"],
    },
    uncertainty: {
      type: ["number", "null"],
    },
    modelVersion: { type: "integer" },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
    rejection: {
      type: ["object", "null"],
    },
  },
  required: [
    "outcome",
    "prediction",
    "uncertainty",
    "modelVersion",
    "warnings",
    "rejection",
  ],
  additionalProperties: false,
};

export type GenerateToolDefinitionInput = {
  modelVersionId: string;
  toolName: string;
  description: string;
  generatorVersion: string;
  features: ModelFeatureMetadata[];
};

export function generateToolInputProperty(
  feature: ModelFeatureMetadata,
): ToolInputProperty {
  const type = feature.dataType === "category" ? "string" : feature.dataType;

  const description = feature.unit
    ? `${feature.description} (${feature.unit})`
    : feature.description;

  return {
    type,
    description,
    ...(feature.validMin !== null && { minimum: feature.validMin }),
    ...(feature.validMax !== null && { maximum: feature.validMax }),
    ...(feature.allowedValues !== null && { enum: feature.allowedValues }),
  };
}

export function generateToolInputSchema(
  features: ModelFeatureMetadata[],
): ToolInputSchema {
  const properties = Object.fromEntries(
    features.map((feature) => [
      feature.columnName,
      generateToolInputProperty(feature),
    ]),
  );

  const required = features
    .filter((feature) => feature.isRequired)
    .map((feature) => feature.columnName);

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function generateToolDefinition(
  input: GenerateToolDefinitionInput,
): GeneratedToolDefinition {
  return {
    modelVersionId: input.modelVersionId,
    toolName: input.toolName,
    description: input.description,
    generatorVersion: input.generatorVersion,
    inputSchema: generateToolInputSchema(input.features),
    outputSchema: predictionToolOutputSchema,
  };
}
