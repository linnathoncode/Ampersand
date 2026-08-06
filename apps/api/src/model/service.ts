import type {
  ModelPublicationError,
  ModelRegistryResponse,
  PublishModelVersionResponse,
} from "@ampersand/contracts";

import type { PoolClient } from "pg";

import {
  findModelVersionStatus,
  listModelVersions,
  publishModelVersion,
} from "./repository";

export type PublishCandidateModelResult =
  | { ok: true; body: PublishModelVersionResponse }
  | {
      ok: false;
      status: 404 | 409;
      body: ModelPublicationError;
    };

export async function getModelRegistry(
  client: PoolClient,
  schemaName: string,
): Promise<ModelRegistryResponse> {
  const models = await listModelVersions(client, schemaName);
  return { models };
}

export async function publishCandidateModel(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
  publishedBy: string,
): Promise<PublishCandidateModelResult> {
  const publishedModel = await publishModelVersion(
    client,
    schemaName,
    modelVersionId,
    publishedBy,
  );

  if (publishedModel) {
    return {
      ok: true,
      body: publishedModel,
    };
  }

  const currentStatus = await findModelVersionStatus(
    client,
    schemaName,
    modelVersionId,
  );

  if (currentStatus === null) {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "MODEL_VERSION_NOT_FOUND",
          message: "Model version was not found",
          currentStatus: null,
        },
      },
    };
  }

  return {
    ok: false,
    status: 409,
    body: {
      error: {
        code: "INVALID_MODEL_TRANSITION",
        message:
          `Model version cannot transition from ` +
          `'${currentStatus}' to published`,
        currentStatus,
      },
    },
  };
}
