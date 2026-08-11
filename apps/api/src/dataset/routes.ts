import {
  CreateDatasetDefinitionDto,
  CreateDatasetSnapshotParamsDto,
} from "@ampersand/contracts";

import { Elysia } from "elysia";

import { CREATE_DATASET_CLAIM, getAuthContext, hasClaim } from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import { createDatasetDefinition } from "./service";
import { createDatasetSnapshot } from "./snapshot-service";
import { createSnapshotStorage } from "./storage";

const snapshotStoragePath = process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts";

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
  )
  .post(
    "/:id/snapshot",
    async ({ request, params, set }) => {
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

      const storage = createSnapshotStorage(snapshotStoragePath);
      const result = await withTenantTransaction(auth.schemaName, async (client, transaction) => {
        const snapshotResult = await createDatasetSnapshot(
          client,
          auth.schemaName,
          params.id,
          storage,
        );
        if (snapshotResult.ok) {
          transaction.onRollback(() => storage.deleteSnapshot(snapshotResult.body.storageUri));
        }
        return snapshotResult;
      });

      if (!result.ok) {
        set.status = result.status;

        return result.body;
      }

      set.status = 201;

      return result.body;
    },
    { params: CreateDatasetSnapshotParamsDto },
  );
