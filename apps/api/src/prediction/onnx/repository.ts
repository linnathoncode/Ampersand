import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

import { createModelFeaturesForSchema } from "../../drizzle/schema";
import type { OnnxFeature } from "./types";

export type StoredOnnxFeature = {
  name: string;
  position: number;
  dataType: string;
  isRequired: boolean;
  allowedValues: unknown;
};

export async function listOnnxFeatures(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<OnnxFeature[]> {
  const tenantSchema = pgSchema(schemaName);
  const modelFeatures = createModelFeaturesForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      name: modelFeatures.columnName,
      position: modelFeatures.position,
      dataType: modelFeatures.dataType,
      isRequired: modelFeatures.isRequired,
      allowedValues: modelFeatures.allowedValues,
    })
    .from(modelFeatures)
    .where(
      and(
        eq(modelFeatures.modelVersionId, modelVersionId),
        eq(modelFeatures.isActive, true),
      ),
    )
    .orderBy(asc(modelFeatures.position));

  return rows.map(toOnnxFeature);
}

export function toOnnxFeature(row: StoredOnnxFeature): OnnxFeature {
  const dataType = toOnnxFeatureDataType(row.dataType);

  return {
    name: row.name,
    position: row.position,
    dataType,
    isRequired: row.isRequired,
    allowedValues: toAllowedValues(dataType, row.allowedValues),
  };
}

function toOnnxFeatureDataType(
  value: string,
): OnnxFeature["dataType"] {
  if (
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "category"
  ) {
    return value;
  }

  throw new Error(`Unsupported ONNX feature type: ${value}`);
}

function toAllowedValues(
  dataType: OnnxFeature["dataType"],
  value: unknown,
): Array<string | number> | null {
  if (value === null) {
    if (dataType === "category") {
      throw new Error("Category feature must define allowed values");
    }

    return null;
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item) => typeof item === "string" || typeof item === "number",
    )
  ) {
    throw new Error("Invalid ONNX feature allowed values");
  }

  return value;
}
