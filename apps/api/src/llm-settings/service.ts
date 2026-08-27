import type { PoolClient } from "pg";

import { decryptApiKey, encryptApiKey } from "./crypto";
import {
  findStoredLlmSettings,
  upsertStoredLlmSettings,
  type StoredLlmSettings,
} from "./repository";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type UserLlmConfig =
  | { mode: "local"; model: string; baseUrl: string }
  | {
      mode: "remote";
      apiFormat: "openai-compatible" | "anthropic";
      apiKey: string;
      model: string;
      baseUrl: string;
      reasoningEffort: ReasoningEffort | null;
    };

export type SaveLlmSettingsInput =
  | { mode: "local"; model: string; baseUrl: string }
  | {
      mode: "remote";
      apiFormat: "openai-compatible" | "anthropic";
      apiKey?: string;
      model: string;
      baseUrl: string;
      reasoningEffort?: ReasoningEffort | null;
    };

export async function loadUserLlmConfig(
  client: PoolClient,
  userId: string,
): Promise<UserLlmConfig | null> {
  const stored = await findStoredLlmSettings(client, userId);
  if (!stored) return null;
  if (stored.mode === "local") {
    return { mode: "local", model: stored.model, baseUrl: stored.baseUrl };
  }
  if (!stored.encryptedApiKey || !stored.apiFormat) {
    throw new Error("Remote LLM settings are incomplete");
  }
  return {
    mode: "remote",
    apiFormat: stored.apiFormat,
    apiKey: decryptApiKey(stored.encryptedApiKey),
    model: stored.model,
    baseUrl: stored.baseUrl,
    reasoningEffort: parseReasoningEffort(stored.reasoningEffort),
  };
}

export async function saveUserLlmSettings(
  client: PoolClient,
  userId: string,
  input: SaveLlmSettingsInput,
): Promise<StoredLlmSettings> {
  assertHttpUrl(input.baseUrl);
  if (!input.model.trim()) throw new Error("Model name is required");

  const existing = await findStoredLlmSettings(client, userId);
  const stored: StoredLlmSettings = input.mode === "local"
    ? {
        mode: "local",
        apiFormat: null,
        model: input.model.trim(),
        baseUrl: input.baseUrl.trim(),
        encryptedApiKey: null,
        reasoningEffort: null,
      }
    : {
        mode: "remote",
        apiFormat: input.apiFormat,
        model: input.model.trim(),
        baseUrl: input.baseUrl.trim(),
        encryptedApiKey: input.apiKey?.trim()
          ? encryptApiKey(input.apiKey.trim())
          : existing?.encryptedApiKey ?? null,
        reasoningEffort: input.apiFormat === "openai-compatible"
          ? input.reasoningEffort ?? null
          : null,
      };

  if (stored.mode === "remote" && !stored.encryptedApiKey) {
    throw new Error("API key is required");
  }

  await upsertStoredLlmSettings(client, userId, stored);
  return stored;
}

function assertHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("Base URL must be an HTTP or HTTPS URL");
  }
}

function parseReasoningEffort(value: string | null): ReasoningEffort | null {
  if (
    value === "none" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh" || value === "max"
  ) return value;
  return null;
}
