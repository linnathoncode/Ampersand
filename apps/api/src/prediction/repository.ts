import type {
  PredictionInputValue,
  PredictionRejection,
} from "@ampersand/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

import { createInferenceCallsForSchema } from "../drizzle/schema";

export type StoreRejectedInferenceCallInput = {
  toolDefinitionId: string;
  modelVersionId: string;
  createdBy: string;
  conversationId: string | null;
  inputs: Record<string, PredictionInputValue>;
  rejection: PredictionRejection;
  latencyMs: number;
};

export async function storeRejectedInferenceCall(
  client: PoolClient,
  schemaName: string,
  input: StoreRejectedInferenceCallInput,
): Promise<string> {
  const tenantSchema = pgSchema(schemaName);
  const inferenceCalls = createInferenceCallsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .insert(inferenceCalls)
    .values({
      toolDefinitionId: input.toolDefinitionId,
      modelVersionId: input.modelVersionId,
      createdBy: input.createdBy,
      conversationId: input.conversationId,
      inputPayload: input.inputs,
      outcome: "rejected",
      prediction: null,
      uncertainty: null,
      warnings: [],
      rejectionCode: input.rejection.code,
      rejectionMessage: input.rejection.message,
      latencyMs: input.latencyMs,
    })
    .returning({
      id: inferenceCalls.id,
    });

  const storedCall = rows[0];

  if (!storedCall) {
    throw new Error("Rejected inference call could not be stored");
  }

  return storedCall.id;
}
