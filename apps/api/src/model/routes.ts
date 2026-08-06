import { PublishModelVersionParamsDto } from "@ampersand/contracts";

import { Elysia } from "elysia";

import { getAuthContext, hasClaim, PUBLISH_MODEL_CLAIM } from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import { publishCandidateModel, getModelRegistry } from "./service";

export const modelRoutes = new Elysia({ prefix: "/model-versions" })
  .get("/", async ({ request, set }) => {
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
      getModelRegistry(client, auth.schemaName),
    );
  })
  .post(
    "/:modelVersionId/publish",
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

      if (!hasClaim(auth, PUBLISH_MODEL_CLAIM)) {
        set.status = 403;

        return {
          error: {
            code: "FORBIDDEN",
            message: "Model publication permission is required",
          },
        };
      }

      const result = await withTenantTransaction(auth.schemaName, (client) =>
        publishCandidateModel(
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
    { params: PublishModelVersionParamsDto },
  );
