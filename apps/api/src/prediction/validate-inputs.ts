import type {
  PredictionInputValue,
  PredictionRejection,
  ToolInputProperty,
  ToolInputSchema,
} from "@ampersand/contracts";

export type InputValidationResult =
  | {
      ok: true;
      inputs: Record<string, PredictionInputValue>;
    }
  | {
      ok: false;
      rejection: PredictionRejection;
    };

function reject(
  code: PredictionRejection["code"],
  message: string,
  fields: PredictionRejection["fields"],
): InputValidationResult {
  return {
    ok: false,
    rejection: {
      code,
      message,
      fields,
    },
  };
}

function matchesType(
  value: PredictionInputValue,
  property: ToolInputProperty,
): boolean {
  switch (property.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);

    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value)
      );

    case "boolean":
      return typeof value === "boolean";

    case "string":
      return typeof value === "string";
  }
}

export function validatePredictionInputs(
  schema: ToolInputSchema,
  inputs: Record<string, PredictionInputValue>,
): InputValidationResult {
  const unknownFields = Object.keys(inputs)
    .filter((name) => !(name in schema.properties))
    .map((name) => ({
      name,
      message: "This input is not accepted by the tool",
    }));

  if (unknownFields.length > 0) {
    return reject(
      "UNKNOWN_FEATURE",
      "The request contains unknown inputs",
      unknownFields,
    );
  }

  const missingFields = schema.required
    .filter((name) => !(name in inputs))
    .map((name) => ({
      name,
      message: "This input is required",
    }));

  if (missingFields.length > 0) {
    return reject(
      "MISSING_FEATURE",
      "One or more required inputs are missing",
      missingFields,
    );
  }

  const invalidTypes = Object.entries(inputs)
    .filter(
      ([name, value]) => !matchesType(value, schema.properties[name]!),
    )
    .map(([name]) => ({
      name,
      message: `Must be of type ${schema.properties[name]!.type}`,
    }));

  if (invalidTypes.length > 0) {
    return reject(
      "INVALID_TYPE",
      "One or more inputs have an invalid type",
      invalidTypes,
    );
  }

  const disallowedValues = Object.entries(inputs)
    .filter(([name, value]) => {
      const allowedValues = schema.properties[name]!.enum;

      return (
        allowedValues !== undefined &&
        typeof value !== "boolean" &&
        !allowedValues.includes(value)
      );
    })
    .map(([name]) => ({
      name,
      message: "Value is not included in the allowed values",
    }));

  if (disallowedValues.length > 0) {
    return reject(
      "VALUE_NOT_ALLOWED",
      "One or more inputs contain unsupported values",
      disallowedValues,
    );
  }

  const outOfRangeFields = Object.entries(inputs)
    .filter(([name, value]) => {
      if (typeof value !== "number") {
        return false;
      }

      const property = schema.properties[name]!;

      return (
        (property.minimum !== undefined && value < property.minimum) ||
        (property.maximum !== undefined && value > property.maximum)
      );
    })
    .map(([name]) => {
      const property = schema.properties[name]!;

      return {
        name,
        message: createRangeMessage(property),
      };
    });

  if (outOfRangeFields.length > 0) {
    return reject(
      "OUT_OF_RANGE",
      "One or more inputs are outside the supported range",
      outOfRangeFields,
    );
  }

  return {
    ok: true,
    inputs,
  };
}

function createRangeMessage(property: ToolInputProperty): string {
  if (property.minimum !== undefined && property.maximum !== undefined) {
    return `Must be between ${property.minimum} and ${property.maximum}`;
  }

  if (property.minimum !== undefined) {
    return `Must be at least ${property.minimum}`;
  }

  return `Must be at most ${property.maximum}`;
}
