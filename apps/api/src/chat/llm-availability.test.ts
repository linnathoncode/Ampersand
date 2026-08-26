import { afterEach, describe, expect, test } from "bun:test";

import { checkLlmAvailability } from "./llm-availability";

const originalEnvironment = {
  key: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
};

afterEach(() => {
  restoreEnvironment("LLM_API_KEY", originalEnvironment.key);
  restoreEnvironment("LLM_BASE_URL", originalEnvironment.baseUrl);
  restoreEnvironment("LLM_MODEL", originalEnvironment.model);
});

describe("LLM availability", () => {
  test("reports a stopped local Ollama service", async () => {
    process.env.LLM_API_KEY = "ollama";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "qwen3:1.7b";

    const availability = await checkLlmAvailability(async () => {
      throw new Error("connection refused");
    });

    expect(availability).toEqual({
      available: false,
      model: "qwen3:1.7b",
      message: "The local language model is unavailable. Start Ollama and try again.",
    });
  });

  test("reports when the configured model is not installed", async () => {
    process.env.LLM_API_KEY = "ollama";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "qwen3:1.7b";

    const availability = await checkLlmAvailability(async () =>
      new Response(JSON.stringify({ models: [{ name: "other:latest" }] })),
    );

    expect(availability).toMatchObject({
      available: false,
      message: "The configured model 'qwen3:1.7b' is not installed in Ollama.",
    });
  });

  test("accepts an installed local model", async () => {
    process.env.LLM_API_KEY = "ollama";
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "qwen3:1.7b";

    const availability = await checkLlmAvailability(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3:1.7b" }] })),
    );

    expect(availability).toEqual({ available: true, model: "qwen3:1.7b" });
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
