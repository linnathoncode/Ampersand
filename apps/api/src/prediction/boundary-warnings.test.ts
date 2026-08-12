import type { ToolInputSchema } from "@ampersand/contracts";
import { describe, expect, test } from "bun:test";

import { collectBoundaryWarnings } from "./boundary-warnings";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    temperature: {
      type: "number",
      description: "Outside temperature",
      minimum: -20,
      maximum: 50,
    },
    occupancy: {
      type: "integer",
      description: "Number of occupants",
      minimum: 0,
      maximum: 100,
    },
    buildingType: {
      type: "string",
      description: "Building category",
      enum: ["office", "residential"],
    },
  },
  required: ["temperature", "occupancy", "buildingType"],
  additionalProperties: false,
};

describe("prediction boundary warnings", () => {
  test("returns no warning for values away from boundaries", () => {
    expect(
      collectBoundaryWarnings(
        schema,
        {
          temperature: 20,
          occupancy: 50,
          buildingType: "office",
        },
        0.1,
      ),
    ).toEqual([]);
  });

  test("warns when a value is close to its minimum", () => {
    expect(
      collectBoundaryWarnings(
        schema,
        { temperature: -18, occupancy: 50, buildingType: "office" },
        0.1,
      ),
    ).toEqual([
      "temperature is close to the minimum accepted value of -20",
    ]);
  });

  test("warns when a value is close to its maximum", () => {
    expect(
      collectBoundaryWarnings(
        schema,
        { temperature: 48, occupancy: 50, buildingType: "office" },
        0.1,
      ),
    ).toEqual([
      "temperature is close to the maximum accepted value of 50",
    ]);
  });

  test("returns warnings for multiple boundary values", () => {
    expect(
      collectBoundaryWarnings(
        schema,
        { temperature: -18, occupancy: 95, buildingType: "office" },
        0.1,
      ),
    ).toEqual([
      "temperature is close to the minimum accepted value of -20",
      "occupancy is close to the maximum accepted value of 100",
    ]);
  });

  test("uses the supplied warning ratio", () => {
    const inputs = {
      temperature: -18,
      occupancy: 50,
      buildingType: "office",
    };

    expect(collectBoundaryWarnings(schema, inputs, 0.01)).toEqual([]);
    expect(collectBoundaryWarnings(schema, inputs, 0.1)).toHaveLength(1);
  });
});
