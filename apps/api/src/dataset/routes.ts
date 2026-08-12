import {
  CreateDatasetDefinitionDto,
  CreateDatasetSnapshotParamsDto,
  type CreateDatasetDefinitionInput,
  type DatasetDefinitionError,
} from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
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
    async ({ request, set }) => {
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

      const body = await parseDatasetDefinitionBody(request);
      if (!body.ok) {
        set.status = 400;

        return body.body;
      }

      const result = await withTenantTransaction(auth.schemaName, (client) =>
        createDatasetDefinition(client, auth.schemaName, auth.userId, body.body),
      );

      if (!result.ok) {
        set.status = result.status;

        return result.body;
      }

      set.status = 201;

      return result.body;
    },
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

type ParsedDatasetDefinitionBody =
  | { ok: true; body: CreateDatasetDefinitionInput }
  | { ok: false; body: DatasetDefinitionError };

async function parseDatasetDefinitionBody(
  request: Request,
): Promise<ParsedDatasetDefinitionBody> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return {
      ok: false,
      body: invalidRequestError([
        {
          path: "$",
          message: "The request body could not be parsed as JSON",
        },
      ]),
    };
  }

  const issues = [...Value.Errors(CreateDatasetDefinitionDto, parsed)].map(
    (error) => ({
      path: error.path || "$",
      message: error.message,
    }),
  );

  if (issues.length > 0) {
    return { ok: false, body: invalidRequestError(issues) };
  }

  return { ok: true, body: parsed as CreateDatasetDefinitionInput };
}

function invalidRequestError(
  issues: { path: string; message: string }[],
): DatasetDefinitionError {
  return {
    error: {
      code: "INVALID_DATASET_DEFINITION_REQUEST",
      message: "The dataset definition request is invalid",
      issues,
    },
  };
}
