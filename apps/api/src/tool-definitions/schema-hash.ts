import type { GeneratedToolDefinition } from "@ampersand/contracts";
import { createHash } from "node:crypto";

export function createToolDefinitionSha256(
  definition: GeneratedToolDefinition,
): string {
  const serializedDefinition = JSON.stringify(definition);

  return createHash("sha256").update(serializedDefinition).digest("hex");
}
