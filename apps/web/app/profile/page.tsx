"use client";

import { useEffect, useState } from "react";

import {
  createTenantHeaders,
  fetchWithAuthRedirect,
  getSelectedTenant,
  nucleusUrl,
  type LlmSettings,
  type ReasoningEffort,
} from "../auth/client";
import { AppShell } from "../components/app-shell";

const localDefaults: LlmSettings = {
  mode: "local",
  model: "",
  baseUrl: "",
};

const remoteDefaults: LlmSettings = {
  mode: "remote",
  apiFormat: "openai-compatible",
  model: "",
  baseUrl: "",
  apiKey: "",
  reasoningEffort: "",
};

export default function ProfilePage() {
  const [settings, setSettings] = useState<LlmSettings>(localDefaults);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tenant = getSelectedTenant();
    if (!tenant) {
      window.location.assign("/login");
      return;
    }

    void fetchWithAuthRedirect(`${nucleusUrl}/profile/llm-settings/`, {
      credentials: "include",
      headers: createTenantHeaders(tenant),
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("LLM settings could not be loaded");
        const result = (await response.json()) as { settings: ProfileLlmSettings | null };
        if (!result.settings) return;

        if (result.settings.mode === "local") {
          setSettings({
            mode: "local",
            model: result.settings.model,
            baseUrl: result.settings.baseUrl,
          });
          return;
        }

        setHasStoredApiKey(result.settings.apiKey !== null);
        setSettings({
          mode: "remote",
          apiFormat: result.settings.apiFormat,
          model: result.settings.model,
          baseUrl: result.settings.baseUrl,
          apiKey: "",
          reasoningEffort: result.settings.reasoningEffort ?? "",
        });
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "LLM settings could not be loaded"),
      )
      .finally(() => setLoading(false));
  }, []);

  function selectMode(mode: LlmSettings["mode"]): void {
    setSettings(mode === "local" ? localDefaults : remoteDefaults);
    setHasStoredApiKey(false);
    setSaved(false);
    setError(null);
  }

  async function save(): Promise<void> {
    const tenant = getSelectedTenant();
    if (!tenant) return;

    setSaved(false);
    setError(null);
    const body = settings.mode === "local"
      ? {
          mode: "local" as const,
          model: settings.model.trim(),
          baseUrl: settings.baseUrl.trim(),
        }
      : {
          mode: "remote" as const,
          apiFormat: settings.apiFormat,
          model: settings.model.trim(),
          baseUrl: settings.baseUrl.trim(),
          reasoningEffort: settings.reasoningEffort || null,
          ...(settings.apiKey.trim() ? { apiKey: settings.apiKey.trim() } : {}),
        };

    const response = await fetchWithAuthRedirect(`${nucleusUrl}/profile/llm-settings/`, {
      method: "PUT",
      credentials: "include",
      headers: {
        ...createTenantHeaders(tenant),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as {
      settings?: ProfileLlmSettings;
      error?: { message?: string };
    };
    if (!response.ok || !result.settings) {
      setError(result.error?.message ?? "LLM settings could not be saved");
      return;
    }

    setHasStoredApiKey(result.settings.mode === "remote" && result.settings.apiKey !== null);
    setSettings((current) => current.mode === "remote"
      ? { ...current, apiKey: "" }
      : current);
    setSaved(true);
  }

  async function reset(): Promise<void> {
    const tenant = getSelectedTenant();
    if (!tenant) return;

    const response = await fetchWithAuthRedirect(`${nucleusUrl}/profile/llm-settings/`, {
      method: "DELETE",
      credentials: "include",
      headers: createTenantHeaders(tenant),
    });
    if (!response.ok) {
      setError("LLM settings could not be reset");
      return;
    }

    setSettings(localDefaults);
    setHasStoredApiKey(false);
    setSaved(false);
    setError(null);
  }

  return (
    <AppShell activeTab="selection" activeSection="profile" breadcrumb="Profile">
      <section className="profile-settings">
        <h1>LLM settings</h1>

        <div className="llm-mode-selector" role="radiogroup" aria-label="Model source">
          <button
            aria-checked={settings.mode === "local"}
            className={settings.mode === "local" ? "active" : ""}
            onClick={() => selectMode("local")}
            role="radio"
            type="button"
          >
            <span>Local</span>
            <small>Ollama or another local server</small>
          </button>
          <button
            aria-checked={settings.mode === "remote"}
            className={settings.mode === "remote" ? "active" : ""}
            onClick={() => selectMode("remote")}
            role="radio"
            type="button"
          >
            <span>Remote</span>
            <small>Hosted model through an API</small>
          </button>
        </div>

        <div className="llm-settings-form">
          {settings.mode === "remote" && (
            <label>
              API format
              <select
                value={settings.apiFormat}
                onChange={(event) => {
                  const apiFormat = event.target.value as "openai-compatible" | "anthropic";
                  setSettings((current) => current.mode === "remote"
                    ? { ...current, apiFormat, baseUrl: "" }
                    : current);
                  setSaved(false);
                }}
              >
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
          )}

          {settings.mode === "remote" && settings.apiFormat === "openai-compatible" && (
            <label>
              Reasoning effort
              <select
                value={settings.reasoningEffort}
                onChange={(event) => {
                  const reasoningEffort = event.target.value as ReasoningEffort | "";
                  setSettings((current) => current.mode === "remote"
                    ? { ...current, reasoningEffort }
                    : current);
                  setSaved(false);
                }}
              >
                <option value="">Default</option>
                <option value="none">None</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="max">Max</option>
              </select>
            </label>
          )}

          <label>
            Model name
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              name="llm-model"
              spellCheck={false}
              value={settings.model}
              onChange={(event) => {
                setSettings((current) => ({ ...current, model: event.target.value }));
                setSaved(false);
              }}
            />
          </label>

          <label>
            {settings.mode === "local" ? "Server URL" : "Base URL"}
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              name="llm-base-url"
              spellCheck={false}
              type="url"
              value={settings.baseUrl}
              onChange={(event) => {
                setSettings((current) => ({ ...current, baseUrl: event.target.value }));
                setSaved(false);
              }}
            />
          </label>

          {settings.mode === "remote" && (
            <label>
              API key
              <input
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                name="llm-api-key"
                placeholder={hasStoredApiKey ? "••••••••" : ""}
                type="password"
                value={settings.apiKey}
                onChange={(event) => {
                  setSettings((current) => current.mode === "remote"
                    ? { ...current, apiKey: event.target.value }
                    : current);
                  setSaved(false);
                }}
              />
            </label>
          )}
        </div>

        <div className="profile-actions">
          <button disabled={loading || !canSave(settings, hasStoredApiKey)} onClick={() => void save()} type="button">Save changes</button>
          <button disabled={loading} onClick={() => void reset()} type="button">Use environment settings</button>
          {saved && <span>Saved</span>}
          {error && <span role="alert">{error}</span>}
        </div>
      </section>
    </AppShell>
  );
}

type ProfileLlmSettings =
  | { mode: "local"; apiFormat: null; model: string; baseUrl: string; reasoningEffort: null; apiKey: null }
  | {
      mode: "remote";
      apiFormat: "openai-compatible" | "anthropic";
      model: string;
      baseUrl: string;
      reasoningEffort: ReasoningEffort | null;
      apiKey: string | null;
    };

function canSave(settings: LlmSettings, hasStoredApiKey: boolean): boolean {
  if (!settings.model.trim() || !settings.baseUrl.trim()) return false;
  return settings.mode === "local" || hasStoredApiKey || settings.apiKey.trim().length >= 10;
}
