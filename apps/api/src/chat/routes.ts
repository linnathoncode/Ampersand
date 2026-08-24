import { createOpenAI } from "@ai-sdk/openai";
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
} from "ai";
import { Elysia } from "elysia";

import { getAuthContext, hasClaim, INVOKE_TOOL_CLAIM } from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";
import { withTenantTransaction } from "../database/tenant-transaction";
import { predictionRoutes } from "../prediction/routes";
import { getDiscoverableTools } from "../tool-definitions/service";

const ChatRequestDto = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    messages: Type.Array(Type.Any()),
  },
  { additionalProperties: true },
);

const CHAT_INSTRUCTIONS = `You are the Ampersand assistant. Respond normally to greetings, general questions, and casual conversation.
Prediction tools are optional capabilities. Do not mention a tool, request its inputs, or steer the conversation toward it unless the user explicitly asks for a prediction or clearly asks about something that a tool predicts.
When a prediction is requested, use the matching tool only after the required inputs are available. Ask only for missing required inputs.
After a tool call, report the prediction, uncertainty, model version, and warnings returned by the tool.
If a tool rejects the inputs, explain the rejection without inventing a prediction.`;

export const chatRoutes = new Elysia().post(
  "/chat",
  async ({ body, request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));

    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
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

    const apiKey = process.env.LLM_API_KEY;

    if (!apiKey) {
      set.status = 503;
      return {
        error: {
          code: "LLM_NOT_CONFIGURED",
          message: "The conversation model is not configured",
        },
      };
    }

    const definitions = await withTenantTransaction(auth.schemaName, (client) =>
      getDiscoverableTools(client, auth.schemaName),
    );
    const tools = createConversationTools(
      definitions,
      body.id,
      auth,
    );
    const provider = createOpenAI({
      apiKey,
      baseURL: process.env.LLM_BASE_URL || undefined,
    });
    const result = streamText({
      model: provider.chat(process.env.LLM_MODEL ?? "gpt-4.1-mini"),
      instructions: CHAT_INSTRUCTIONS,
      messages: await convertToModelMessages(body.messages as UIMessage[]),
      tools,
      stopWhen: stepCountIs(5),
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  },
  { body: ChatRequestDto },
);

function createConversationTools(
  definitions: Awaited<ReturnType<typeof getDiscoverableTools>>,
  conversationId: string | undefined,
  auth: NonNullable<Awaited<ReturnType<typeof resolveNucleusAuth>>>,
): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.toolName,
      dynamicTool({
        description: definition.description,
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
}
