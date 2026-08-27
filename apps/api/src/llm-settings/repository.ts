import type { PoolClient } from "pg";

export type StoredLlmSettings = {
  mode: "local" | "remote";
  apiFormat: "openai-compatible" | "anthropic" | null;
  model: string;
  baseUrl: string;
  encryptedApiKey: string | null;
  reasoningEffort: string | null;
};

export async function findStoredLlmSettings(
  client: PoolClient,
  userId: string,
): Promise<StoredLlmSettings | null> {
  const result = await client.query<{
    mode: "local" | "remote";
    api_format: "openai-compatible" | "anthropic" | null;
    model_name: string;
    base_url: string;
    encrypted_api_key: string | null;
    reasoning_effort: string | null;
  }>(`
    SELECT mode, api_format, model_name, base_url, encrypted_api_key, reasoning_effort
    FROM user_llm_settings
    WHERE user_id = $1 AND is_active = true
  `, [userId]);

  const row = result.rows[0];
  return row ? {
    mode: row.mode,
    apiFormat: row.api_format,
    model: row.model_name,
    baseUrl: row.base_url,
    encryptedApiKey: row.encrypted_api_key,
    reasoningEffort: row.reasoning_effort,
  } : null;
}

export async function upsertStoredLlmSettings(
  client: PoolClient,
  userId: string,
  settings: StoredLlmSettings,
): Promise<void> {
  await client.query(`
    INSERT INTO user_llm_settings (
      user_id, mode, api_format, model_name, base_url,
      encrypted_api_key, reasoning_effort, created_by, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $1)
    ON CONFLICT (user_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      api_format = EXCLUDED.api_format,
      model_name = EXCLUDED.model_name,
      base_url = EXCLUDED.base_url,
      encrypted_api_key = EXCLUDED.encrypted_api_key,
      reasoning_effort = EXCLUDED.reasoning_effort,
      is_active = true,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `, [
    userId,
    settings.mode,
    settings.apiFormat,
    settings.model,
    settings.baseUrl,
    settings.encryptedApiKey,
    settings.reasoningEffort,
  ]);
}

export async function deleteStoredLlmSettings(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query("DELETE FROM user_llm_settings WHERE user_id = $1", [userId]);
}
