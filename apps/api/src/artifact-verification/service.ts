import type { PoolClient } from "pg";

import {
  findVerifiableModelArtifact,
  type StoredModelArtifact,
} from "./repository";
import {
  verifyArtifact,
  type ArtifactVerificationResult,
  type ReadArtifact,
} from "./verify-artifact";

export async function verifyStoredModelArtifact(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
  trustedWorkerIds: ReadonlySet<string>,
  readArtifact: ReadArtifact,
  findArtifact: (
    client: PoolClient,
    schemaName: string,
    modelVersionId: string,
  ) => Promise<StoredModelArtifact | null> = findVerifiableModelArtifact,
): Promise<ArtifactVerificationResult> {
  const artifact = await findArtifact(client, schemaName, modelVersionId);

  if (!artifact) {
    return {
      ok: false,
      reason: "ARTIFACT_NOT_FOUND",
      message: "No active artifact was found for the published model version",
    };
  }

  return verifyArtifact(
    {
      storageUri: artifact.storageUri,
      expectedSha256: artifact.contentSha256,
      expectedSizeBytes: artifact.sizeBytes,
      producerWorkerId: artifact.producerWorkerId,
    },
    trustedWorkerIds,
    readArtifact,
  );
}
