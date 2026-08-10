import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { secondUuid, timestamp, uuid } from "../test-support";
import {
  CreateDatasetDefinitionDto,
  DatasetDefinitionErrorDto,
  DatasetDefinitionResponseDto,
  DatasetSnapshotErrorDto,
} from "./index";

describe("dataset contracts", () => {
  it("accepts valid requests, responses, and structured errors", () => {
    expect(
      Value.Check(CreateDatasetDefinitionDto, {
        name: "Energy predictor",
        sourceTable: "energy_readings",
        features: [{ name: "temperature", description: "Temperature" }],
        target: { name: "energy_usage", description: "Energy", unit: "kWh" },
        timeColumn: { name: "recorded_at", description: "Recorded time" },
      }),
    ).toBe(true);
    expect(
      Value.Check(DatasetDefinitionResponseDto, {
        id: uuid,
        name: "Energy predictor",
        sourceTable: "energy_readings",
        targetColumn: "energy_usage",
        timeColumn: "recorded_at",
        columns: [
          {
            id: secondUuid,
            name: "temperature",
            role: "feature",
            dataType: "number",
            description: "Temperature",
            unit: null,
            isNullable: false,
            position: 0,
          },
        ],
        createdAt: timestamp,
      }),
    ).toBe(true);
    expect(
      Value.Check(DatasetDefinitionErrorDto, {
        error: {
          code: "COLUMN_NOT_FOUND",
          message: "Column was not found",
          issues: [{ path: "features.0", message: "Unknown column" }],
        },
      }),
    ).toBe(true);
  });

  it("rejects invalid identifiers", () => {
    expect(
      Value.Check(CreateDatasetDefinitionDto, {
        name: "Energy predictor",
        sourceTable: "public.energy_readings",
        features: [{ name: "temperature", description: "Temperature" }],
        target: { name: "energy_usage", description: "Energy" },
      }),
    ).toBe(false);
  });

  it("accepts every snapshot error code", () => {
    for (const code of [
      "DATASET_DEFINITION_NOT_FOUND",
      "DATASET_SOURCE_TABLE_MISSING",
      "DATASET_SOURCE_TABLE_NOT_ALLOWED",
      "DATASET_COLUMN_MISSING",
      "DATASET_COLUMN_INVALID_IDENTIFIER",
      "DATASET_COLUMN_TIMEZONE_REQUIRED",
      "DATASET_COLUMN_PRECISION_LOSS",
      "DATASET_DEFINITION_HAS_NO_COLUMNS",
      "SNAPSHOT_EMPTY_TABLE",
      "SNAPSHOT_STORAGE_FAILED",
      "SNAPSHOT_CONTENT_COLLISION",
    ]) {
      expect(
        Value.Check(DatasetSnapshotErrorDto, {
          error: {
            code,
            message: "Something went wrong",
            issues: [{ path: "sourceTable", message: "Nope" }],
          },
        }),
      ).toBe(true);
    }
  });
});
