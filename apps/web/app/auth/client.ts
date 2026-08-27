export const nucleusUrl =
  process.env.NEXT_PUBLIC_NUCLEUS_URL ?? "http://localhost:4000";

export const serviceId = "ampersand-web";
export const tenantStorageKey = "ampersand:tenant";
const authenticatedUserStorageKey = "ampersand:authenticated-user";
const legacyLlmSettingsStoragePrefix = "ampersand:llm-settings";
export const authenticatedUserChangedEvent =
  "ampersand:authenticated-user-changed";
const chatCachePrefixes = [
  "ampersand:chat:",
  "ampersand:chat-timestamps:",
] as const;

export function getSelectedTenant(): string | null {
  return window.localStorage.getItem(tenantStorageKey);
}

export function saveSelectedTenant(tenant: string): void {
  window.localStorage.setItem(tenantStorageKey, tenant);
}

export function createTenantHeaders(tenant: string): Record<string, string> {
  return {
    "x-service-id": serviceId,
    "x-tenant-id": tenant,
  };
}

export function normalizeTenant(value: string): string {
  return value.trim().toLowerCase();
}

export function synchronizeAuthenticatedUser(userId: string): void {
  const previousUserId = window.sessionStorage.getItem(
    authenticatedUserStorageKey,
  );

  if (previousUserId && previousUserId !== userId) {
    clearChatSessionCache();
  }

  window.sessionStorage.setItem(authenticatedUserStorageKey, userId);
  window.dispatchEvent(
    new CustomEvent(authenticatedUserChangedEvent, { detail: userId }),
  );
}

export function getAuthenticatedUserId(): string | null {
  return window.sessionStorage.getItem(authenticatedUserStorageKey);
}

export type LlmSettings =
  | {
      mode: "local";
      model: string;
      baseUrl: string;
    }
  | {
      mode: "remote";
      apiFormat: "openai-compatible" | "anthropic";
      model: string;
      baseUrl: string;
      apiKey: string;
      reasoningEffort: ReasoningEffort | "";
    };

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function clearAuthenticatedSession(): void {
  clearChatSessionCache();
  window.sessionStorage.removeItem(authenticatedUserStorageKey);
}

export function clearLegacyLlmSettings(): void {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(legacyLlmSettingsStoragePrefix)) {
      window.localStorage.removeItem(key);
    }
  }
}

export async function fetchWithAuthRedirect(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status === 401) {
    clearAuthenticatedSession();
    window.location.assign("/login");
  }

  return response;
}

function clearChatSessionCache(): void {
  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);

    if (key && chatCachePrefixes.some((prefix) => key.startsWith(prefix))) {
      window.sessionStorage.removeItem(key);
    }
  }
}
