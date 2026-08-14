import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

import { runOnnxInference } from "../../onnx/run-inference";

describe("ONNX model inference", () => {
  test("loads verified bytes and returns a scalar regression prediction", async () => {
    const artifactBytes = await readFile(
      new URL("../fixtures/linear-regression.onnx", import.meta.url),
    );

    const result = await runOnnxInference({
      artifactBytes,
      features: [
        {
          name: "temperature",
          position: 0,
          dataType: "number",
          isRequired: true,
          allowedValues: null,
        },
        {
          name: "occupancy",
          position: 1,
          dataType: "integer",
          isRequired: true,
          allowedValues: null,
        },
      ],
      inputs: {
        temperature: 4,
        occupancy: 6,
      },
    });

    expect(result).toEqual({
      prediction: 31,
      uncertainty: null,
    });
  });
});
