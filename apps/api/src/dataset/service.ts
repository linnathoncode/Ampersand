import type {
  CreateDatasetDefinitionInput,
  DatasetColumnRole,
  DatasetColumnType,
  DatasetDefinitionError,
  DatasetDefinitionErrorCode,
  DatasetDefinitionResponse,
} from "@ampersand/contracts";
import type { PoolClient } from "pg";

import {
  inspectSourceTable,
  insertDatasetColumn,
  insertDatasetDefinition,
} from "./repository";
import type { SourceColumnInfo } from "./schema-inference";
import { tenantDataSchemaName } from "./tenant-data-schema";

export type CreateDatasetDefinitionResult =
  | { ok: true; body: DatasetDefinitionResponse }
  | { ok: false; status: 403 | 404 | 422; body: DatasetDefinitionError };

export type BuiltDatasetColumn = {
  name: string;
  description: string;
  unit: string | null;
  role: DatasetColumnRole;
  dataType: DatasetColumnType;
  isNullable: boolean;
  position: number;
};

export type BuildDatasetColumnsResult =
  | { ok: true; columns: BuiltDatasetColumn[] }
  | { ok: false; error: DatasetDefinitionError };

export async function createDatasetDefinition(
  pool: PoolClient,
  schemaName: string,
  userId: string,
  input: CreateDatasetDefinitionInput,
): Promise<CreateDatasetDefinitionResult> {
  const lookup = await inspectSourceTable(
    pool,
    tenantDataSchemaName(schemaName),
    input.sourceTable,
  );

  if (lookup.kind === "not-found") {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "SOURCE_TABLE_NOT_FOUND",
          message: `Source table '${input.sourceTable}' was not found`,
          issues: [
            {
              path: "sourceTable",
              message: `No table named '${input.sourceTable}' exists in this tenant`,
            },
          ],
        },
      },
    };
  }

  if (lookup.kind === "not-allowed") {
    return {
      ok: false,
      status: 403,
      body: {
        error: {
          code: "SOURCE_TABLE_NOT_ALLOWED",
          message: `Source table '${input.sourceTable}' cannot be used as a dataset source`,
          issues: [
            {
              path: "sourceTable",
              message: "Only base tables that are not platform-managed may be used",
            },
          ],
        },
      },
    };
  }

  const built = buildDatasetColumns(input, lookup.columns);
  if (!built.ok) {
    return { ok: false, status: 422, body: built.error };
  }

  const definition = await insertDatasetDefinition(pool, schemaName, {
    name: input.name,
    sourceTable: input.sourceTable,
    targetColumn: input.target.name,
    timeColumn: input.timeColumn?.name ?? null,
    createdBy: userId,
  });

  const columns = [];
  for (const column of built.columns) {
    columns.push(
      await insertDatasetColumn(pool, definition.id, {
        columnName: column.name,
        role: column.role,
        dataType: column.dataType,
        description: column.description,
        unit: column.unit,
        isNullable: column.isNullable,
        position: column.position,
      }),
    );
  }

  return {
    ok: true,
    body: {
      id: definition.id,
      name: input.name,
      sourceTable: input.sourceTable,
      targetColumn: input.target.name,
      timeColumn: input.timeColumn?.name ?? null,
      columns: columns.map((column) => ({
        id: column.id,
        name: column.columnName,
        role: column.role,
        dataType: column.dataType,
        description: column.description,
        unit: column.unit,
        isNullable: column.isNullable,
        position: column.position,
      })),
      createdAt: definition.createdAt.toISOString(),
    },
  };
}

const FEATURE_TYPES = new Set<DatasetColumnType>([
  "number",
  "integer",
  "boolean",
  "category",
]);
const TARGET_TYPES = new Set<DatasetColumnType>(["number", "integer"]);

export function buildDatasetColumns(
  input: CreateDatasetDefinitionInput,
  sourceColumns: SourceColumnInfo[],
): BuildDatasetColumnsResult {
  const byName = new Map(sourceColumns.map((column) => [column.name, column]));
  const sourceNames = new Set(sourceColumns.map((column) => column.name));

  const duplicate = findDuplicate(input.features.map((feature) => feature.name));
  if (duplicate) {
    return duplicateFeatureError(duplicate);
  }

  const features = input.features;
  for (const [index, feature] of features.entries()) {
    if (!sourceNames.has(feature.name)) {
      return columnNotFoundError(`features.${index}`, feature.name);
    }
  }
  if (!sourceNames.has(input.target.name)) {
    return columnNotFoundError("target", input.target.name);
  }
  if (input.timeColumn && !sourceNames.has(input.timeColumn.name)) {
    return columnNotFoundError("timeColumn", input.timeColumn.name);
  }

  const featureSet = new Set(features.map((feature) => feature.name));
  if (featureSet.has(input.target.name)) {
    return {
      ok: false,
      error: {
        error: {
          code: "TARGET_IS_FEATURE",
          message: "The target column is also listed as a feature",
          issues: [
            {
              path: "target",
              message: `Target '${input.target.name}' cannot also be a feature`,
            },
          ],
        },
      },
    };
  }

  if (
    input.timeColumn &&
    (input.timeColumn.name === input.target.name ||
      featureSet.has(input.timeColumn.name))
  ) {
    return {
      ok: false,
      error: {
        error: {
          code: "TIME_COLUMN_CONFLICT",
          message: "The time column conflicts with a feature or the target",
          issues: [
            {
              path: "timeColumn",
              message: `Time column '${input.timeColumn.name}' cannot also be the target or a feature`,
            },
          ],
        },
      },
    };
  }

  for (const [index, feature] of features.entries()) {
    const info = byName.get(feature.name);
    const type = info?.inferredType;
    if (!type || !FEATURE_TYPES.has(type)) {
      return unsupportedTypeError(
        `features.${index}`,
        feature.name,
        info?.sqlType ?? "unknown",
      );
    }
  }

  const targetInfo = byName.get(input.target.name);
  const targetType = targetInfo?.inferredType;
  if (!targetType || !TARGET_TYPES.has(targetType)) {
    return unsupportedTypeError(
      "target",
      input.target.name,
      targetInfo?.sqlType ?? "unknown",
    );
  }

  if (input.timeColumn) {
    const timeInfo = byName.get(input.timeColumn.name);
    if (timeInfo?.inferredType !== "datetime") {
      return {
        ok: false,
        error: {
          error: {
            code: "INVALID_TIME_COLUMN_TYPE",
            message: "The time column must be a date or timestamp type",
            issues: [
              {
                path: "timeColumn",
                message: `Time column '${input.timeColumn.name}' has type '${timeInfo?.sqlType ?? "unknown"}'`,
              },
            ],
          },
        },
      };
    }
  }

  const built: BuiltDatasetColumn[] = [];
  let position = 0;

  for (const feature of features) {
    built.push({
      name: feature.name,
      description: feature.description,
      unit: feature.unit ?? null,
      role: "feature",
      dataType: byName.get(feature.name)!.inferredType!,
      isNullable: byName.get(feature.name)!.isNullable,
      position,
    });
    position += 1;
  }

  built.push({
    name: input.target.name,
    description: input.target.description,
    unit: input.target.unit ?? null,
    role: "target",
    dataType: byName.get(input.target.name)!.inferredType!,
    isNullable: byName.get(input.target.name)!.isNullable,
    position,
  });
  position += 1;

  if (input.timeColumn) {
    const timeSource = byName.get(input.timeColumn.name)!;
    built.push({
      name: input.timeColumn.name,
      description: input.timeColumn.description,
      unit: input.timeColumn.unit ?? null,
      role: "time",
      dataType: timeSource.inferredType!,
      isNullable: timeSource.isNullable,
      position,
    });
  }

  return { ok: true, columns: built };
}

function findDuplicate(names: string[]): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) return name;
    seen.add(normalizedName);
  }
  return null;
}

function duplicateFeatureError(duplicate: string): BuildDatasetColumnsResult {
  return {
    ok: false,
    error: {
      error: {
        code: "DUPLICATE_FEATURE",
        message: `Feature column '${duplicate}' is declared more than once`,
        issues: [
          { path: "features", message: `Duplicate feature column: ${duplicate}` },
        ],
      },
    },
  };
}

function columnNotFoundError(
  path: string,
  name: string,
): BuildDatasetColumnsResult {
  return {
    ok: false,
    error: {
      error: {
        code: "COLUMN_NOT_FOUND",
        message: `Column '${name}' was not found in the source table`,
        issues: [{ path, message: `No column named '${name}' in the source table` }],
      },
    },
  };
}

function unsupportedTypeError(
  path: string,
  name: string,
  sqlType: string,
): BuildDatasetColumnsResult {
  return {
    ok: false,
    error: {
      error: {
        code: "UNSUPPORTED_COLUMN_TYPE",
        message: `Column '${name}' has unsupported type '${sqlType}'`,
        issues: [{ path, message: `Unsupported column type: ${sqlType}` }],
      },
    },
  };
}
