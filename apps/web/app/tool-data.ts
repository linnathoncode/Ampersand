export type ToolSchemaProperty = {
  name: string;
  type: "number" | "integer" | "string" | "boolean";
  description: string;
  required: boolean;
  constraint: string;
};

export type PredictionAuditEntry = {
  id: string;
  outcome: "prediction" | "rejected";
  createdAt: string;
  caller: string;
  latencyMs: number;
  inputs: Record<string, string | number | boolean>;
  prediction: number | null;
  uncertainty: number | null;
  warnings: string[];
  rejection: null | {
    code: string;
    message: string;
    fields: Array<{ name: string; message: string }>;
  };
};

export type PredictionTool = {
  slug: string;
  name: string;
  description: string;
  modelName: string;
  modelVersion: number;
  generatedAt: string;
  properties: ToolSchemaProperty[];
  outputType: string;
  calls: PredictionAuditEntry[];
};

export const predictionTools: PredictionTool[] = [
  {
    slug: "predict-energy-usage",
    name: "predict_energy_usage",
    description: "Predicts building energy consumption from temperature and occupancy.",
    modelName: "Energy usage predictor",
    modelVersion: 2,
    generatedAt: "2026-08-12T10:16:00.000Z",
    properties: [
      { name: "temperature", type: "number", description: "Outside temperature", required: true, constraint: "-10 to 45 °C" },
      { name: "occupancy", type: "integer", description: "Number of occupants", required: true, constraint: "0 to 500 people" },
    ],
    outputType: "number",
    calls: [
      {
        id: "call-1082",
        outcome: "prediction",
        createdAt: "2026-08-21T08:44:00.000Z",
        caller: "Furkan",
        latencyMs: 34,
        inputs: { temperature: 31.5, occupancy: 82 },
        prediction: 148.7,
        uncertainty: 4.2,
        warnings: ["temperature is close to the upper supported boundary"],
        rejection: null,
      },
      {
        id: "call-1081",
        outcome: "rejected",
        createdAt: "2026-08-21T08:37:00.000Z",
        caller: "Furkan",
        latencyMs: 7,
        inputs: { temperature: 61, occupancy: 82 },
        prediction: null,
        uncertainty: null,
        warnings: [],
        rejection: {
          code: "OUT_OF_RANGE",
          message: "One or more inputs are outside the model's supported range.",
          fields: [{ name: "temperature", message: "Must be between -10 and 45" }],
        },
      },
      {
        id: "call-1079",
        outcome: "prediction",
        createdAt: "2026-08-21T07:58:00.000Z",
        caller: "Nucleus",
        latencyMs: 29,
        inputs: { temperature: 22, occupancy: 43 },
        prediction: 92.4,
        uncertainty: 2.8,
        warnings: [],
        rejection: null,
      },
    ],
  },
  {
    slug: "forecast-weekly-demand",
    name: "forecast_weekly_demand",
    description: "Forecasts weekly product demand from recent sales and calendar inputs.",
    modelName: "Demand forecast",
    modelVersion: 1,
    generatedAt: "2026-08-18T13:22:00.000Z",
    properties: [
      { name: "recent_sales", type: "number", description: "Sales during the previous period", required: true, constraint: "0 or greater" },
      { name: "promotion_active", type: "boolean", description: "Whether a promotion is active", required: true, constraint: "true or false" },
    ],
    outputType: "number",
    calls: [],
  },
];

export function findPredictionTool(slug: string): PredictionTool | undefined {
  return predictionTools.find((tool) => tool.slug === slug);
}

export function formatToolDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
