import { Type } from "@sinclair/typebox";
import { Elysia } from "elysia";

import {
  GENERATE_TOOL_DEFINITION_CLAIM,
  getAuthContext,
  hasClaim,
} from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import {
  generateAndStoreModelToolDefinition,
  getDiscoverableTools,
} from "./service";

const GenerateToolDefinitionParamsDto = Type.Object(
  {
    modelVersionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const toolDefinitionRoutes = new Elysia()
  .post(
    "/model-versions/:modelVersionId/tool-definition",
    async ({ params, request, set }) => {
      const auth = getAuthContext(request.headers);

      if (!auth) {
        set.status = 401;

        return {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required",
          },
        };
      }

      if (!hasClaim(auth, GENERATE_TOOL_DEFINITION_CLAIM)) {
        set.status = 403;

        return {
          error: {
            code: "FORBIDDEN",
            message: "Tool generation permission is required",
          },
        };
      }

      const result = await withTenantTransaction(auth.schemaName, (client) =>
        generateAndStoreModelToolDefinition(
          client,
          auth.schemaName,
          params.modelVersionId,
          auth.userId,
        ),
      );

      if (!result.ok) {
        set.status = result.status;
      }

      return result.body;
    },
    {
      params: GenerateToolDefinitionParamsDto,
    },
  )
  .get("/tools", async ({ request, set }) => {
    const auth = getAuthContext(request.headers);

    if (!auth) {
      set.status = 401;

      return {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      };
    }

    return withTenantTransaction(auth.schemaName, (client) =>
      getDiscoverableTools(client, auth.schemaName),
    );
  });
