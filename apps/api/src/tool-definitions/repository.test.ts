import { describe, expect, test } from "bun:test";
import { toModelFeatureMetadata } from "./repository";

describe("stored model feature conversion", () => {
  test("converts stored database values into generator metadata", () => {
    const feature = toModelFeatureMetadata({
      columnName: "temperature",
      position: 0,
      dataType: "number",
      description: "Outside temperature",
      unit: "celsius",
      isRequired: true,
      validMin: "-20",
      validMax: "50.5",
      allowedValues: null,
    });

    expect(feature).toEqual({
      columnName: "temperature",
      dataType: "number",
      description: "Outside temperature",
      unit: "celsius",
      isRequired: true,
      validMin: -20,
      validMax: 50.5,
      allowedValues: null,
    });
  });

  test("rejects an unsupported model feature type", () => {
    expect(() =>
      toModelFeatureMetadata({
        columnName: "temperature",
        position: 0,
        dataType: "unsupported",
        description: "Outside temperature",
        unit: "celsius",
        isRequired: true,
        validMin: "-20",
        validMax: "50",
        allowedValues: null,
      }),
    ).toThrow("Unsupported model feature type: unsupported");
  });

  test("rejects an empty allowed-values list", () => {
    expect(() =>
      toModelFeatureMetadata({
        columnName: "building_type",
        position: 0,
        dataType: "category",
        description: "Type of building",
        unit: null,
        isRequired: true,
        validMin: null,
        validMax: null,
        allowedValues: [],
      }),
    ).toThrow("Invalid model feature allowed values");
  });
});
