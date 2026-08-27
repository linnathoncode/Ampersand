import { afterEach, describe, expect, it } from "vitest";

import {
  chatRoutes,
  createChatRoutes,
  conversationHasQueuedTraining,
  createConversationTools,
  latestUserConfirmedTraining,
  toStartModelTrainingInput,
} from "./routes";

const originalApiKey = process.env.LLM_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.LLM_API_KEY;
  } else {
    process.env.LLM_API_KEY = originalApiKey;
  }
});

describe("chat routes", () => {
  it("exposes table discovery without prediction tools", () => {
    const tools = createConversationTools([], "conversation-1", {
      userId: "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
      schemaName: "tenant_ampersand_dev",
      authType: "access-token",
      claims: ["invoke.tool_definitions"],
    });

    expect(Object.keys(tools)).toEqual(["list_prediction_tools", "list_source_tables"]);
  });

  it("exposes training submission to users with both claims", () => {
    const tools = createConversationTools(
      [],
      "conversation-1",
      {
        userId: "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        schemaName: "tenant_ampersand_dev",
        authType: "access-token",
        claims: ["create.dataset_definitions", "queue.training_jobs"],
      },
    );

    expect(Object.keys(tools)).toContain("start_model_training");
  });

  it("recognizes an explicit confirmation immediately after a training summary", () => {
    expect(
      latestUserConfirmedTraining([confirmationRequiredMessage(), userMessage("yes")]),
    ).toBe(true);
    expect(
      latestUserConfirmedTraining([confirmationRequiredMessage(), userMessage("/train")]),
    ).toBe(true);
    expect(latestUserConfirmedTraining([userMessage("Start training.")])).toBe(false);
    expect(
      latestUserConfirmedTraining([confirmationRequiredMessage(), userMessage("What would this train?")]),
    ).toBe(false);
  });

  it("converts simple training tool inputs into the internal contract", () => {
    expect(
      toStartModelTrainingInput({
        name: "insurance",
        sourceTable: "insurance",
        features: ["age", "sex", "smoker"],
        target: "charges",
      }),
    ).toEqual({
      name: "insurance",
      sourceTable: "insurance",
      features: ["age", "sex", "smoker"].map((name) => ({
        name,
        description: `Training feature ${name}`,
      })),
      target: {
        name: "charges",
        description: "Prediction target charges",
      },
    });
  });

  it("does not expose training submission after a job is queued", () => {
    const messages = [queuedTrainingMessage()];
    expect(conversationHasQueuedTraining(messages)).toBe(true);

    const tools = createConversationTools(
      [],
      "conversation-1",
      {
        userId: "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        schemaName: "tenant_ampersand_dev",
        authType: "access-token",
        claims: ["create.dataset_definitions", "queue.training_jobs"],
      },
      true,
      true,
    );

    expect(Object.keys(tools)).not.toContain("start_model_training");
  });

  it("requires authentication", async () => {
    const response = await chatRoutes.handle(createRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  it("requires prediction tool invocation permission", async () => {
    const response = await createChatRoutes({ loadLlmConfig: async () => null }).handle(
      createRequest({
        "x-user-id": "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        "x-tenant-schema": "tenant_ampersand_dev",
        "x-auth-type": "access-token",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("reports a missing conversation model configuration", async () => {
    delete process.env.LLM_API_KEY;

    const response = await createChatRoutes({ loadLlmConfig: async () => null }).handle(
      createRequest({
        "x-user-id": "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        "x-tenant-schema": "tenant_ampersand_dev",
        "x-auth-type": "access-token",
        "x-user-claims": "invoke.tool_definitions",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "LLM_UNAVAILABLE",
        message: "The conversation model is not configured.",
      },
    });
  });
});

function userMessage(text: string) {
  return {
    id: "message-1",
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function queuedTrainingMessage() {
  return {
    id: "message-queued",
    role: "assistant" as const,
    parts: [
      {
        type: "dynamic-tool" as const,
        toolName: "start_model_training",
        toolCallId: "training-call-1",
        state: "output-available" as const,
        input: {},
        output: { outcome: "queued" as const },
      },
    ],
  };
}

function confirmationRequiredMessage() {
  return {
    id: "message-confirmation",
    role: "assistant" as const,
    parts: [
      {
        type: "dynamic-tool" as const,
        toolName: "start_model_training",
        toolCallId: "training-call-1",
        state: "output-available" as const,
        input: {},
        output: {
          outcome: "rejected" as const,
          code: "CONFIRMATION_REQUIRED" as const,
        },
      },
    ],
  };
}

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ id: "conversation-1", messages: [] }),
  });
}
