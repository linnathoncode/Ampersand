import { Type } from "@sinclair/typebox";
import { Elysia } from "elysia";

import { getAuthContext } from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";
import { withTenantTransaction } from "../database/tenant-transaction";
import { deleteStoredLlmSettings, findStoredLlmSettings } from "./repository";
import { saveUserLlmSettings } from "./service";

const ReasoningEffortDto = Type.Union([
  Type.Literal("none"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const SaveLlmSettingsDto = Type.Union([
  Type.Object({
    mode: Type.Literal("local"),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    baseUrl: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("remote"),
    apiFormat: Type.Union([
      Type.Literal("openai-compatible"),
      Type.Literal("anthropic"),
    ]),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    baseUrl: Type.String({ minLength: 1, maxLength: 500 }),
    apiKey: Type.Optional(Type.String({ minLength: 10, maxLength: 500 })),
    reasoningEffort: Type.Optional(Type.Union([ReasoningEffortDto, Type.Null()])),
  }, { additionalProperties: false }),
]);

export const llmSettingsRoutes = new Elysia({ prefix: "/profile/llm-settings" })
  .get("/", async ({ request, set }) => {
    const auth = getAuthContext(request.headers) ?? await resolveNucleusAuth(request);
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }

    const stored = await withTenantTransaction(auth.schemaName, (client) =>
      findStoredLlmSettings(client, auth.userId));

    return { settings: stored ? toProfileResponse(stored) : null };
  })
  .put("/", async ({ body, request, set }) => {
    const auth = getAuthContext(request.headers) ?? await resolveNucleusAuth(request);
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }

    try {
      const stored = await withTenantTransaction(auth.schemaName, (client) =>
        saveUserLlmSettings(client, auth.userId, body));
      return { settings: toProfileResponse(stored) };
    } catch (error) {
      set.status = 400;
      return {
        error: {
          code: "INVALID_LLM_SETTINGS",
          message: error instanceof Error ? error.message : "The LLM settings are invalid",
        },
      };
    }
  }, { body: SaveLlmSettingsDto })
  .delete("/", async ({ request, set }) => {
    const auth = getAuthContext(request.headers) ?? await resolveNucleusAuth(request);
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }

    await withTenantTransaction(auth.schemaName, (client) =>
      deleteStoredLlmSettings(client, auth.userId));
    return { deleted: true };
  });

function toProfileResponse(settings: Awaited<ReturnType<typeof findStoredLlmSettings>>) {
  if (!settings) return null;
  return {
    mode: settings.mode,
    apiFormat: settings.apiFormat,
    model: settings.model,
    baseUrl: settings.baseUrl,
    reasoningEffort: settings.reasoningEffort,
    apiKey: settings.encryptedApiKey ? "••••••••" : null,
  };
}
