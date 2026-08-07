import { describe, expect, test } from "bun:test";

import { Value } from "@sinclair/typebox/value";
import {
  DatasetDefinitionErrorDto,
  DatasetDefinitionResponseDto,
  type DatasetDefinitionErrorCode,
} from "@ampersand/contracts";

import { buildDatasetColumns, type BuiltDatasetColumn } from "./service";
import type { SourceColumnInfo } from "./schema-inference";

const sourceColumns: SourceColumnInfo[] = [
  {
    name: "temperature",
    sqlType: "float8",
    isNullable: false,
    inferredType: "number",
  },
  {
    name: "occupancy",
    sqlType: "int4",
    isNullable: true,
    inferredType: "integer",
  },
  {
    name: "energy_usage",
    sqlType: "numeric",
    isNullable: false,
    inferredType: "number",
  },
  {
    name: "recorded_at",
    sqlType: "timestamptz",
    isNullable: false,
    inferredType: "datetime",
  },
  {
    name: "zone",
    sqlType: "varchar",
    isNullable: false,
    inferredType: "category",
  },
  {
    name: "flag",
    sqlType: "bool",
    isNullable: false,
    inferredType: "boolean",
  },
  {
    name: "notes",
    sqlType: "text",
    isNullable: true,
    inferredType: "category",
  },
];

const validInput = {
  name: "Energy predictor",
  sourceTable: "energy_readings",
  features: [
    { name: "temperature", description: "Outside temperature", unit: "celsius" },
    { name: "occupancy", description: "Number of occupants" },
  ],
  target: { name: "energy_usage", description: "Energy", unit: "kWh" },
  timeColumn: { name: "recorded_at", description: "Recorded time" },
};

function responseFor(input: unknown, columns: BuiltDatasetColumn[]): unknown {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    name: (input as { name: string }).name,
    sourceTable: (input as { sourceTable: string }).sourceTable,
    targetColumn: (input as { target: { name: string } }).target.name,
    timeColumn: (input as { timeColumn: { name: string } }).timeColumn.name,
    columns: columns.map((column) => ({
      id: "123e4567-e89b-42d3-a456-426614174001",
      ...column,
    })),
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}

function buildColumn(input: unknown) {
  const result = buildDatasetColumns(
    input as Parameters<typeof buildDatasetColumns>[0],
    sourceColumns,
  );
  return result;
}

function buildColumnList(input: unknown) {
  const result = buildColumn(input);
  if (!result.ok) throw new Error("expected successful column build");
  return result.columns;
}

describe("buildDatasetColumns happy path", () => {
  test("builds feature, target, and time columns with inferred types", () => {
    const columns = buildColumnList(validInput);

    expect(columns.map((column) => column.role)).toEqual([
      "feature",
      "feature",
      "target",
      "time",
    ]);
    expect(columns.map((column) => column.position)).toEqual([0, 1, 2, 3]);
    expect(columns.map((column) => column.dataType)).toEqual([
      "number",
      "integer",
      "number",
      "datetime",
    ]);
    expect(columns[0]).toMatchObject({
      name: "temperature",
      isNullable: false,
      unit: "celsius",
    });
    expect(columns[1]).toMatchObject({ name: "occupancy", isNullable: true });
    expect(columns[2]).toMatchObject({ name: "energy_usage", unit: "kWh" });
    expect(columns[3]).toMatchObject({ name: "recorded_at" });
  });

  test("supports optional time column", () => {
    const columns = buildColumnList({
      ...validInput,
      timeColumn: undefined,
    });

    expect(columns.map((column) => column.role)).toEqual([
      "feature",
      "feature",
      "target",
    ]);
    expect(columns[2]).toMatchObject({ role: "target", position: 2 });
  });
});

describe("buildDatasetColumns error codes", () => {
  function expectErrorCode(input: unknown, code: DatasetDefinitionErrorCode) {
    const result = buildColumn(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(code);
      expect(Value.Check(DatasetDefinitionErrorDto, result.error)).toBe(true);
    }
  }

  test("DUPLICATE_FEATURE", () => {
    expectErrorCode(
      {
        ...validInput,
        features: [
          { name: "temperature", description: "A" },
          { name: "temperature", description: "B" },
        ],
      },
      "DUPLICATE_FEATURE",
    );
  });

  test("DUPLICATE_FEATURE is case-insensitive", () => {
    expectErrorCode(
      {
        ...validInput,
        features: [
          { name: "Temperature", description: "A" },
          { name: "temperature", description: "B" },
        ],
      },
      "DUPLICATE_FEATURE",
    );
  });

  test("COLUMN_NOT_FOUND for a feature, target, and time column", () => {
    expectErrorCode(
      {
        ...validInput,
        features: [{ name: "missing_feature", description: "A" }],
      },
      "COLUMN_NOT_FOUND",
    );
    expectErrorCode(
      { ...validInput, target: { name: "missing_target", description: "T" } },
      "COLUMN_NOT_FOUND",
    );
    expectErrorCode(
      {
        ...validInput,
        timeColumn: { name: "missing_time", description: "T" },
      },
      "COLUMN_NOT_FOUND",
    );
  });

  test("TARGET_IS_FEATURE", () => {
    expectErrorCode(
      {
        ...validInput,
        features: [
          { name: "temperature", description: "A" },
          { name: "energy_usage", description: "Target as feature" },
        ],
      },
      "TARGET_IS_FEATURE",
    );
  });

  test("TIME_COLUMN_CONFLICT when the time column is a feature or the target", () => {
    expectErrorCode(
      {
        ...validInput,
        features: [
          { name: "temperature", description: "A" },
          { name: "recorded_at", description: "Time as feature" },
        ],
      },
      "TIME_COLUMN_CONFLICT",
    );
    expectErrorCode(
      {
        ...validInput,
        target: { name: "recorded_at", description: "Time as target" },
      },
      "TIME_COLUMN_CONFLICT",
    );
  });

  test("UNSUPPORTED_COLUMN_TYPE for a non-numeric target and a datetime feature", () => {
    expectErrorCode(
      {
        ...validInput,
        target: { name: "zone", description: "Categorical target" },
      },
      "UNSUPPORTED_COLUMN_TYPE",
    );
    expectErrorCode(
      {
        ...validInput,
        timeColumn: undefined,
        features: [
          { name: "recorded_at", description: "Datetime feature" },
          { name: "occupancy", description: "Occupants" },
        ],
      },
      "UNSUPPORTED_COLUMN_TYPE",
    );
  });

  test("INVALID_TIME_COLUMN_TYPE when the time column is not date-like", () => {
    expectErrorCode(
      {
        ...validInput,
        timeColumn: { name: "zone", description: "Category as time" },
      },
      "INVALID_TIME_COLUMN_TYPE",
    );
  });

  test("categorical and boolean features are allowed", () => {
    const columns = buildColumnList({
      name: "Categorical predictor",
      sourceTable: "energy_readings",
      features: [
        { name: "zone", description: "Zone" },
        { name: "flag", description: "Flag" },
        { name: "notes", description: "Notes" },
      ],
      target: { name: "energy_usage", description: "Energy" },
    });

    expect(columns.filter((column) => column.role === "feature")).toHaveLength(3);
    expect(
      columns
        .filter((column) => column.role === "feature")
        .map((column) => column.dataType),
    ).toEqual(["category", "boolean", "category"]);
  });
});

describe("buildDatasetColumns response contract", () => {
  test("maps to a valid DatasetDefinitionResponseDto", () => {
    const columns = buildColumnList(validInput);
    const response = responseFor(validInput, columns);

    expect(Value.Check(DatasetDefinitionResponseDto, response)).toBe(true);
  });
});
