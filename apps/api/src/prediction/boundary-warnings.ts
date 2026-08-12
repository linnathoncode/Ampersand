import type {
  PredictionInputValue,
  ToolInputSchema,
} from "@ampersand/contracts";

export function collectBoundaryWarnings(
  schema: ToolInputSchema,
  inputs: Record<string, PredictionInputValue>,
  warningRatio: number,
): string[] {
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value !== "number") continue;

    const property = schema.properties[name];

    if (
      !property ||
      property.minimum === undefined ||
      property.maximum === undefined
    ) {
      continue;
    }

    const range = property.maximum - property.minimum;

    if (range <= 0) continue;

    const warningDistance = range * warningRatio;

    if (value <= property.minimum + warningDistance) {
      warnings.push(
        `${name} is close to the minimum accepted value of ${property.minimum}`,
      );
    } else if (value >= property.maximum - warningDistance) {
      warnings.push(
        `${name} is close to the maximum accepted value of ${property.maximum}`,
      );
    }
  }

  return warnings;
}
