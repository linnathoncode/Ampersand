import { Type, type Static } from "@sinclair/typebox";

import {
  DatasetColumnRoleDto,
  DatasetColumnTypeDto,
  PostgreSqlIdentifierSchema,
} from "./definition";

export const SnapshotColumnSummaryDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    role: DatasetColumnRoleDto,
    dataType: DatasetColumnTypeDto,
    position: Type.Integer({ minimum: 0 }),
    isNullable: Type.Boolean(),
  },
  {
    additionalProperties: false,
  },
);

export type SnapshotColumnSummary = Static<typeof SnapshotColumnSummaryDto>;

export const SchemaSummaryDto = Type.Object(
  {
    sourceTable: PostgreSqlIdentifierSchema,
    columns: Type.Array(SnapshotColumnSummaryDto),
  },
  {
    additionalProperties: false,
  },
);

export type SchemaSummary = Static<typeof SchemaSummaryDto>;

export const DatasetSnapshotRecordDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    datasetDefinitionId: Type.String({ format: "uuid" }),
    storageUri: Type.String({ minLength: 1 }),
    format: Type.Literal("parquet"),
    contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    rowCount: Type.Integer({ minimum: 1 }),
    schemaSummary: SchemaSummaryDto,
    frozenAt: Type.String({ format: "date-time" }),
  },
  {
    additionalProperties: false,
  },
);

export type DatasetSnapshotRecord = Static<typeof DatasetSnapshotRecordDto>;

export const CreateDatasetSnapshotParamsDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
  },
  {
    additionalProperties: false,
  },
);

export type CreateDatasetSnapshotParams = Static<
  typeof CreateDatasetSnapshotParamsDto
>;

export const DatasetSnapshotErrorCodeDto = Type.Union([
  Type.Literal("DATASET_DEFINITION_NOT_FOUND"),
  Type.Literal("DATASET_SOURCE_TABLE_MISSING"),
  Type.Literal("DATASET_SOURCE_TABLE_NOT_ALLOWED"),
  Type.Literal("DATASET_COLUMN_MISSING"),
  Type.Literal("DATASET_COLUMN_INVALID_IDENTIFIER"),
  Type.Literal("DATASET_COLUMN_TIMEZONE_REQUIRED"),
  Type.Literal("DATASET_COLUMN_PRECISION_LOSS"),
  Type.Literal("DATASET_DEFINITION_HAS_NO_COLUMNS"),
  Type.Literal("SNAPSHOT_EMPTY_TABLE"),
  Type.Literal("SNAPSHOT_STORAGE_FAILED"),
  Type.Literal("SNAPSHOT_CONTENT_COLLISION"),
]);

export type DatasetSnapshotErrorCode = Static<
  typeof DatasetSnapshotErrorCodeDto
>;

export const DatasetSnapshotErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: DatasetSnapshotErrorCodeDto,
        message: Type.String(),
        issues: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              message: Type.String(),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
      },
      {
        additionalProperties: false,
      },
    ),
  },
  {
    additionalProperties: false,
  },
);

export type DatasetSnapshotError = Static<typeof DatasetSnapshotErrorDto>;