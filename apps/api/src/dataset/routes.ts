import { CreateDatasetDefinitionDto } from "@ampersand/contracts";

import { Elysia } from "elysia";

import { CREATE_DATASET_CLAIM, getAuthContext, hasClaim } from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import { createDatasetDefinition } from "./service";

export const datasetRoutes = new Elysia({ prefix: "/dataset-definitions" })
  .post(
    "/",
    async ({ body, request, set }) => {
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

      if (!hasClaim(auth, CREATE_DATASET_CLAIM)) {
        set.status = 403;

        return {
          error: {
            code: "FORBIDDEN",
            message: "Dataset creation permission is required",
          },
        };
      }

      const result = await withTenantTransaction(auth.schemaName, (client) =>
        createDatasetDefinition(client, auth.schemaName, auth.userId, body),
      );

      if (!result.ok) {
        set.status = result.status;

        return result.body;
      }

      set.status = 201;

      return result.body;
    },
    { body: CreateDatasetDefinitionDto },
  );
