import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
export const VALID_HASH = "a".repeat(64);

export function registerFormats(): void {
  FormatRegistry.Set("uuid", (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
  FormatRegistry.Set("date-time", (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ),
  );
}

export function assertContract(
  schema: TSchema,
  value: unknown,
  label: string,
): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)]
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${errors}`);
}

export const datasetRequest = {
  name: "Mock energy predictor",
  sourceTable: "energy_readings",
  features: [
    { name: "temperature", description: "Outside temperature", unit: "celsius" },
    { name: "occupancy", description: "Number of occupants", unit: "people" },
  ],
  target: {
    name: "energy_usage",
    description: "Building energy consumption",
    unit: "kWh",
  },
  timeColumn: { name: "recorded_at", description: "Measurement time" },
} as const;

export const trainingConfig = {
  trainerVersion: "mock-1.0.0",
  algorithmPolicy: "automatic-regression" as const,
  randomSeed: 42,
  splitStrategy: "chronological" as const,
  testFraction: 0.2,
  maxRuntimeSeconds: 60,
};
