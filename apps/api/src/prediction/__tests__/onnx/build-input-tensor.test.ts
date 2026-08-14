import { describe, expect, test } from "bun:test";

import { buildOnnxFeatureValues } from "../../onnx/build-input-tensor";
import type { OnnxFeature } from "../../onnx/types";

const features: OnnxFeature[] = [
  {
    name: "occupied",
    position: 2,
    dataType: "boolean",
    isRequired: true,
    allowedValues: null,
  },
  {
    name: "temperature",
    position: 0,
    dataType: "number",
    isRequired: true,
    allowedValues: null,
  },
  {
    name: "building_type",
    position: 3,
    dataType: "category",
    isRequired: true,
    allowedValues: ["residential", "commercial"],
  },
  {
    name: "occupancy",
    position: 1,
    dataType: "integer",
    isRequired: true,
    allowedValues: null,
  },
];

describe("ONNX input tensor values", () => {
  test("orders and converts all supported feature types", () => {
    const values = buildOnnxFeatureValues(features, {
      building_type: "commercial",
      occupancy: 3,
      temperature: 22.5,
      occupied: true,
    });

    expect([...values]).toEqual([22.5, 3, 1, 1]);
  });

  test("represents an omitted optional feature as NaN", () => {
    const values = buildOnnxFeatureValues(
      [
        {
          name: "humidity",
          position: 0,
          dataType: "number",
          isRequired: false,
          allowedValues: null,
        },
      ],
      {},
    );

    expect(Number.isNaN(values[0])).toBe(true);
  });

  test("rejects missing required values", () => {
    expect(() =>
      buildOnnxFeatureValues(
        [
          {
            name: "temperature",
            position: 0,
            dataType: "number",
            isRequired: true,
            allowedValues: null,
          },
        ],
        {},
      ),
    ).toThrow("Required ONNX feature 'temperature' is missing");
  });

  test("rejects invalid feature positions", () => {
    expect(() =>
      buildOnnxFeatureValues(
        [
          {
            name: "temperature",
            position: 1,
            dataType: "number",
            isRequired: true,
            allowedValues: null,
          },
        ],
        { temperature: 22 },
      ),
    ).toThrow("ONNX feature positions must be contiguous and start at zero");
  });

  test("rejects an unsupported category value", () => {
    expect(() =>
      buildOnnxFeatureValues(
        [
          {
            name: "building_type",
            position: 0,
            dataType: "category",
            isRequired: true,
            allowedValues: ["residential", "commercial"],
          },
        ],
        { building_type: "industrial" },
      ),
    ).toThrow("Category value for 'building_type' is not supported");
  });
});
