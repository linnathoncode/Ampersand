import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { Type } from "@sinclair/typebox";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  dynamicTool,
  jsonSchema,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { Elysia } from "elysia";

import {
  CREATE_DATASET_CLAIM,
  CREATE_TRAINING_JOB_CLAIM,
  getAuthContext,
  hasClaim,
  INVOKE_TOOL_CLAIM,
} from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";
import { withTenantTransaction } from "../database/tenant-transaction";
import { listSourceTables } from "../dataset/source-table-service";
import { loadUserLlmConfig, type UserLlmConfig } from "../llm-settings/service";
import { predictionRoutes } from "../prediction/routes";
import { getDiscoverableTools } from "../tool-definitions/service";
import { checkLlmAvailability } from "./llm-availability";
import { startModelTraining } from "./training-flow";

const ChatRequestDto = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    messages: Type.Array(Type.Any()),
  },
  { additionalProperties: true },
);

const CHAT_INSTRUCTIONS = `You are the Ampersand assistant. Available tools are supplied with each conversation.
Call list_source_tables when the user asks about datasets, tables, uploaded data, or data available for training. Call it immediately instead of describing it or asking which dataset they mean.
Call list_prediction_tools when the user asks which models or prediction tools are available. Do not call list_source_tables for that request.
After either list tool returns, the structured result already shows the available items. Do not repeat its rows, columns, features, or inputs in the conversational response unless the user asks for details, comparison, or a recommendation.
Training and prediction are different tasks. Use start_model_training only when the user explicitly asks to train, create, build, or fit a model. A request to predict, estimate, forecast, or use an existing model must never call start_model_training. For those requests, select the matching published prediction tool and collect only its actual input values.
For training, gather a model name, source table, feature columns, and one numeric target. Never ask for, invent, or send a time column. The training service uses its deterministic seeded split for conversational training. Never invent columns or infer correlation from column names. Call prepare_model_training when the user supplies a complete training request, then show its short summary and ask for confirmation. Call start_model_training only after the user confirms that prepared request.
Confirmation is required exactly once. When start_model_training returns a queued outcome, tell the user that the job is queued and stop. Do not ask them to confirm, proceed, or start training again.
Never send table names, column names, a target, or a feature list to a prediction tool. Prediction tools accept actual values for one observation and should only be called when the user asks for a prediction.
Report actual tool results and explain rejections without inventing results. Respond normally when no tool is relevant.`;

type ChatRouteDependencies = {
  loadLlmConfig(schemaName: string, userId: string): Promise<UserLlmConfig | null>;
};

const defaultChatRouteDependencies: ChatRouteDependencies = {
  loadLlmConfig: (schemaName, userId) =>
    withTenantTransaction(schemaName, (client) => loadUserLlmConfig(client, userId)),
};

export function createChatRoutes(
  overrides: Partial<ChatRouteDependencies> = {},
) {
  const dependencies = { ...defaultChatRouteDependencies, ...overrides };

  return new Elysia()
  .get("/chat/status", async ({ request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));

    if (!auth) {
      set.status = 401;
      return {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      };
    }

    const userLlm = await dependencies.loadLlmConfig(auth.schemaName, auth.userId);
    return userLlm
      ? { available: true as const, model: userLlm.model }
      : checkLlmAvailability();
  })
  .post(
    "/chat",
    async ({ body, request, set }) => {
      const auth =
        getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));

      if (!auth) {
        set.status = 401;
        return {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required",
          },
        };
      }

      if (!hasClaim(auth, INVOKE_TOOL_CLAIM)) {
        set.status = 403;
        return {
          error: {
            code: "FORBIDDEN",
            message: "Prediction tool invocation permission is required",
          },
        };
      }

      const userLlm = await dependencies.loadLlmConfig(auth.schemaName, auth.userId);
      const availability = userLlm ? { available: true as const, model: userLlm.model } : await checkLlmAvailability();
      if (!availability.available) {
        set.status = 503;
        return {
          error: {
            code: "LLM_UNAVAILABLE",
            message: availability.message,
          },
        };
      }

      const messages = deduplicateConversationMessages(
        body.messages as UIMessage[],
      );

      const definitions = await withTenantTransaction(
        auth.schemaName,
        (client) => getDiscoverableTools(client, auth.schemaName),
      );
      const tools = createConversationTools(
        definitions,
        body.id,
        auth,
        latestUserConfirmedTraining(messages),
        conversationHasQueuedTraining(messages),
      );
      const availableTools = Object.keys(tools).length > 0 ? tools : undefined;
      const model = createConversationModel(userLlm);
      const reasoningEffort = userLlm?.mode === "remote" &&
        userLlm.apiFormat === "openai-compatible"
        ? userLlm.reasoningEffort
        : null;
      const result = streamText({
        model,
        instructions: CHAT_INSTRUCTIONS,
        messages: await convertToModelMessages(messages),
        tools: availableTools,
        stopWhen: stepCountIs(5),
        providerOptions: reasoningEffort
          ? { openai: { reasoningEffort } }
          : undefined,
      });

      const stream = toUIMessageStream({ stream: result.stream }).pipeThrough(
        preventEmptyAssistantResponse(),
      );

      return createUIMessageStreamResponse({ stream });
    },
    { body: ChatRequestDto },
  );
}

export const chatRoutes = createChatRoutes();

export function deduplicateConversationMessages(
  messages: UIMessage[],
): UIMessage[] {
  const seenMessageIds = new Set<string>();

  return messages.filter((message) => {
    if (seenMessageIds.has(message.id)) return false;

    seenMessageIds.add(message.id);
    return true;
  });
}

export function createConversationTools(
  definitions: Awaited<ReturnType<typeof getDiscoverableTools>>,
  conversationId: string | undefined,
  auth: NonNullable<Awaited<ReturnType<typeof resolveNucleusAuth>>>,
  trainingConfirmed = false,
  trainingAlreadyQueued = false,
): ToolSet {
  const trainingExecutions = new Map<string, Promise<unknown>>();
  const predictionTools = Object.fromEntries(
    definitions.map((definition) => [
          definition.toolName,
          dynamicTool({
            description: `Prediction only. Use this published model tool when the user asks to predict or estimate using it. Do not use it to train a model. ${definition.description}`,
            inputSchema: jsonSchema(definition.inputSchema),
            execute: async (inputs) => {
              const internalHeaders = new Headers();
              internalHeaders.set("content-type", "application/json");
              internalHeaders.set("x-user-id", auth.userId);
              internalHeaders.set("x-tenant-schema", auth.schemaName);
              internalHeaders.set("x-auth-type", auth.authType);
              internalHeaders.set("x-user-claims", auth.claims.join(","));

              const response = await predictionRoutes.handle(
                new Request("http://ampersand.internal/predictions", {
                  method: "POST",
                  headers: internalHeaders,
                  body: JSON.stringify({
                    toolName: definition.toolName,
                    conversationId,
                    inputs,
                  }),
                }),
              );

              return response.json();
            },
          }),
    ]),
  );

  const tools: ToolSet = {
    ...predictionTools,
    list_prediction_tools: dynamicTool({
      description:
        "List the published prediction tools available in the current tenant. Use this for questions about available models or prediction tools, not for training tables.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () =>
        definitions.map((definition) => ({
          toolName: definition.toolName,
          modelVersionId: definition.modelVersionId,
          description: definition.description,
          inputs: Object.entries(definition.inputSchema.properties).map(
            ([name, property]) => ({
              name,
              type: property.type,
              values: property.enum ?? [],
            }),
          ),
        })),
    }),
    list_source_tables: dynamicTool({
      description:
        "List source tables available in the current tenant for model training, including row counts, columns, and detected data types.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({
        tables: await withTenantTransaction(auth.schemaName, (client) =>
          listSourceTables(client, auth.schemaName),
        ),
      }),
    }),
  };

  if (
    !trainingAlreadyQueued &&
    hasClaim(auth, CREATE_DATASET_CLAIM) &&
    hasClaim(auth, CREATE_TRAINING_JOB_CLAIM)
  ) {
    const trainingInputSchema = jsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["name", "sourceTable", "features", "target"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        sourceTable: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        features: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
            pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          },
        },
        target: {
          type: "string",
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        },
      },
    });

    if (!trainingConfirmed) {
      tools.prepare_model_training = dynamicTool({
        description:
          "Prepare a training summary without creating a dataset, snapshot, or job. Use this only after the user has supplied a complete training request.",
        inputSchema: trainingInputSchema,
        execute: async (input) => ({
          outcome: "ready",
          training: input as TrainingToolInput,
        }),
      });
    } else {
      tools.start_model_training = dynamicTool({
        description:
          "Create a dataset definition, freeze its current data, and queue the training job that the user has explicitly confirmed.",
        inputSchema: trainingInputSchema,
        execute: async (input) => {

          const trainingInput = input as TrainingToolInput;
          const executionKey = JSON.stringify(trainingInput);
          let execution = trainingExecutions.get(executionKey);

          if (!execution) {
            execution = startModelTraining(
              auth,
              toStartModelTrainingInput(trainingInput),
            );
            trainingExecutions.set(executionKey, execution);
          }

          return execution;
        },
      });
    }
  }

  return tools;
}

function createConversationModel(config: UserLlmConfig | null) {
  if (!config) {
    return createOpenAI({
      apiKey: process.env.LLM_API_KEY!,
      baseURL: process.env.LLM_BASE_URL || undefined,
    }).chat(process.env.LLM_MODEL ?? "gpt-4.1-mini");
  }

  if (config.mode === "remote" && config.apiFormat === "anthropic") {
    return createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    }).chat(config.model);
  }

  if (config.mode === "remote") {
    return createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    }).responses(config.model);
  }

  return createOpenAI({
    apiKey: "local",
    baseURL: config.baseUrl,
  }).chat(config.model);
}

type StartModelTrainingInput = Parameters<typeof startModelTraining>[1];

type TrainingToolInput = {
  name: string;
  sourceTable: string;
  features: string[];
  target: string;
  timeColumn?: string;
};

export function toStartModelTrainingInput(
  input: TrainingToolInput,
): StartModelTrainingInput {
  return {
    name: input.name,
    sourceTable: input.sourceTable,
    features: input.features.map((name) => ({
      name,
      description: `Training feature ${name}`,
    })),
    target: {
      name: input.target,
      description: `Prediction target ${input.target}`,
    },
    ...(input.timeColumn
      ? {
          timeColumn: {
            name: input.timeColumn,
            description: `Training time column ${input.timeColumn}`,
          },
        }
      : {}),
  };
}

export function latestUserConfirmedTraining(messages: UIMessage[]): boolean {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  const latestUserMessage = messages[latestUserIndex];
  if (!latestUserMessage) return false;

  const text = latestUserMessage.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join(" ")
    .trim()
    .toLowerCase();

  const isExplicitConfirmation =
    /^(yes|confirm(ed)?|start( training)?|train it|proceed|go ahead|\/train)[.! ]*$/.test(
      text,
    );
  if (!isExplicitConfirmation) return false;

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (
      message?.role === "assistant" &&
      message.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolName === "prepare_model_training" &&
          part.state === "output-available" &&
          isTrainingPreparationResult(part.output),
      )
    ) {
      return true;
    }
  }

  return false;
}

function isTrainingPreparationResult(
  value: unknown,
): value is { outcome: "ready" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    value.outcome === "ready"
  );
}

export function conversationHasQueuedTraining(messages: UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        part.toolName === "start_model_training" &&
        part.state === "output-available" &&
        isQueuedTrainingResult(part.output),
    ),
  );
}

function isQueuedTrainingResult(
  value: unknown,
): value is { outcome: "queued" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    value.outcome === "queued"
  );
}

function preventEmptyAssistantResponse(): TransformStream<
  UIMessageChunk,
  UIMessageChunk
> {
  let hasVisibleContent = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (
        (chunk.type === "text-delta" && chunk.delta.trim().length > 0) ||
        chunk.type === "tool-input-available" ||
        chunk.type === "tool-input-error"
      ) {
        hasVisibleContent = true;
      }

      if (chunk.type === "finish" && !hasVisibleContent) {
        const id = crypto.randomUUID();
        controller.enqueue({ type: "text-start", id });
        controller.enqueue({
          type: "text-delta",
          id,
          delta: "I could not complete that response. Please try again.",
        });
        controller.enqueue({ type: "text-end", id });
      }

      controller.enqueue(chunk);
    },
  });
}
