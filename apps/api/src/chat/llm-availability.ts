export type LlmAvailability =
  | { available: true; model: string }
  | { available: false; model: string | null; message: string };

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function checkLlmAvailability(
  fetcher: Fetcher = fetch,
): Promise<LlmAvailability> {
  const model = process.env.LLM_MODEL?.trim() || "gpt-4.1-mini";
  const baseUrl = process.env.LLM_BASE_URL?.trim();

  if (!process.env.LLM_API_KEY) {
    return {
      available: false,
      model,
      message: "The conversation model is not configured.",
    };
  }

  if (!baseUrl || !isLocalOllamaUrl(baseUrl)) {
    return { available: true, model };
  }

  try {
    const tagsUrl = new URL("/api/tags", baseUrl);
    const response = await fetcher(tagsUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error("Ollama returned an error");

    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const installed = body.models?.some(
      (entry) => entry.name === model || entry.model === model,
    );

    if (!installed) {
      return {
        available: false,
        model,
        message: `The configured model '${model}' is not installed in Ollama.`,
      };
    }

    return { available: true, model };
  } catch {
    return {
      available: false,
      model,
      message: "The local language model is unavailable. Start Ollama and try again.",
    };
  }
}

function isLocalOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.port === "11434" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
