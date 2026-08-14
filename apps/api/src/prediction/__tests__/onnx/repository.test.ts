import { describe, expect, test } from "bun:test";

import { toOnnxFeature } from "../../onnx/repository";

describe("stored ONNX feature conversion", () => {
  test("converts valid category metadata", () => {
    expect(
      toOnnxFeature({
        name: "building_type",
        position: 1,
        dataType: "category",
        isRequired: true,
        allowedValues: ["residential", "commercial"],
      }),
    ).toEqual({
      name: "building_type",
      position: 1,
      dataType: "category",
      isRequired: true,
      allowedValues: ["residential", "commercial"],
    });
  });

  test("rejects an unsupported feature type", () => {
    expect(() =>
      toOnnxFeature({
        name: "temperature",
        position: 0,
        dataType: "date",
        isRequired: true,
        allowedValues: null,
      }),
    ).toThrow("Unsupported ONNX feature type: date");
  });

  test("requires allowed values for categories", () => {
    expect(() =>
      toOnnxFeature({
        name: "building_type",
        position: 0,
        dataType: "category",
        isRequired: true,
        allowedValues: null,
      }),
    ).toThrow("Category feature must define allowed values");
  });

  test("rejects malformed allowed values", () => {
    expect(() =>
      toOnnxFeature({
        name: "building_type",
        position: 0,
        dataType: "category",
        isRequired: true,
        allowedValues: ["residential", true],
      }),
    ).toThrow("Invalid ONNX feature allowed values");
  });
});
