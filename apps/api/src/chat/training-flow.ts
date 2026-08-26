import type { CreateDatasetDefinitionInput } from "@ampersand/contracts";

import { resolveArtifactStoragePath } from "../artifacts/storage-path";
import type { AuthContext } from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import { createDatasetDefinition } from "../dataset/service";
import { createDatasetSnapshot } from "../dataset/snapshot-service";
import { createSnapshotStorage } from "../dataset/storage";
import { createTrainingJob, createTrainingJobRepository } from "../training/service";

const snapshotStoragePath = resolveArtifactStoragePath();

export type StartModelTrainingInput = CreateDatasetDefinitionInput;

export async function startModelTraining(
  auth: AuthContext,
  input: StartModelTrainingInput,
): Promise<unknown> {
  const storage = createSnapshotStorage(snapshotStoragePath);

  try {
    return await withTenantTransaction(
      auth.schemaName,
      async (client, transaction) => {
        const definition = await createDatasetDefinition(
          client,
          auth.schemaName,
          auth.userId,
          input,
        );
        if (!definition.ok) throw new TrainingFlowRejected(definition.body);

        const snapshot = await createDatasetSnapshot(
          client,
          auth.schemaName,
          definition.body.id,
          storage,
        );
        if (!snapshot.ok) throw new TrainingFlowRejected(snapshot.body);

        transaction.onRollback(() =>
          storage.deleteSnapshot(snapshot.body.storageUri),
        );

        const job = await createTrainingJob(
          createTrainingJobRepository(client),
          auth.schemaName,
          auth.userId,
          { datasetDefinitionId: definition.body.id },
        );
        if (!job.ok) throw new TrainingFlowRejected(job.body);

        return {
          outcome: "queued",
          dataset: {
            id: definition.body.id,
            name: definition.body.name,
            sourceTable: definition.body.sourceTable,
            targetColumn: definition.body.targetColumn,
          },
          snapshot: {
            id: snapshot.body.id,
            rowCount: snapshot.body.rowCount,
          },
          job: {
            id: job.body.id,
            status: job.body.status,
            progressPercent: job.body.progressPercent,
            progressMessage: job.body.progressMessage,
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof TrainingFlowRejected) {
      return { outcome: "rejected", ...error.payload };
    }
    throw error;
  }
}

class TrainingFlowRejected extends Error {
  constructor(readonly payload: object) {
    super("Training flow rejected");
  }
}
