import type {
  CreateTrainingJobInput,
  ResolvedTrainingConfig,
  TrainingJobRequestError,
  TrainingJobRequestErrorCode,
  TrainingJobResponse,
} from "@ampersand/contracts";
import type { PoolClient } from "pg";

import type { LoadedDatasetColumn } from "../dataset/repository";
import { buildTrainingFingerprint } from "./fingerprint";
import {
  resolveHeartbeatExpirySeconds,
  resolveMaxActiveTrainingJobs,
  resolveTrainingConfig,
  QUEUED_TRAINING_JOB_PROGRESS_MESSAGE,
} from "./config";
import {
  cancelTrainingJob,
  countActiveTrainingJobs,
  insertTrainingJob,
  loadLatestValidSnapshot,
  lockTrainingSubmissionQuota,
  recoverAbandonedTrainingJobs,
  type CancelTrainingJobOutcome,
  type InsertedTrainingJob,
  type InsertTrainingJobInput,
  type LoadedTrainingSnapshot,
} from "./repository";
import {
  loadDatasetColumns,
  loadDatasetDefinition,
} from "../dataset/repository";

export type TrainingJobRepository = {
  loadDatasetDefinition(
    definitionId: string,
  ): Promise<Awaited<ReturnType<typeof loadDatasetDefinition>>>;
  loadDatasetColumns(
    definitionId: string,
  ): Promise<Awaited<ReturnType<typeof loadDatasetColumns>>>;
  loadLatestValidSnapshot(
    definitionId: string,
  ): Promise<LoadedTrainingSnapshot | null>;
  lockTrainingSubmissionQuota(schemaName: string): Promise<void>;
  countActiveTrainingJobs(): Promise<number>;
  recoverAbandonedTrainingJobs(expirySeconds: number): Promise<number>;
  insertTrainingJob(input: InsertTrainingJobInput): Promise<InsertedTrainingJob>;
  cancelTrainingJob(jobId: string): Promise<CancelTrainingJobOutcome>;
};

export function createTrainingJobRepository(
  client: PoolClient,
): TrainingJobRepository {
  return {
    loadDatasetDefinition: (definitionId) =>
      loadDatasetDefinition(client, definitionId),
    loadDatasetColumns: (definitionId) =>
      loadDatasetColumns(client, definitionId),
    loadLatestValidSnapshot: (definitionId) =>
      loadLatestValidSnapshot(client, definitionId),
    lockTrainingSubmissionQuota: (schemaName) =>
      lockTrainingSubmissionQuota(client, schemaName),
    countActiveTrainingJobs: () => countActiveTrainingJobs(client),
    recoverAbandonedTrainingJobs: (expirySeconds) =>
      recoverAbandonedTrainingJobs(client, expirySeconds),
    insertTrainingJob: (input) => insertTrainingJob(client, input),
    cancelTrainingJob: (jobId) => cancelTrainingJob(client, jobId),
  };
}

export type CreateTrainingJobResult =
  | { ok: true; status: 201; body: TrainingJobResponse }
  | {
      ok: false;
      status: 404 | 409 | 422 | 429;
      body: TrainingJobRequestError;
    };

export function validateDatasetTrainability(
  columns: LoadedDatasetColumn[],
): string[] {
  const issues: string[] = [];

  if (columns.length === 0) {
    return ["The dataset definition has no selected columns"];
  }

  const features = columns.filter((column) => column.role === "feature");
  if (features.length === 0) {
    issues.push("At least one feature column is required");
  }

  const targets = columns.filter((column) => column.role === "target");
  if (targets.length === 0) {
    issues.push("Exactly one target column is required");
  } else if (targets.length > 1) {
    issues.push("Only one target column is allowed");
  } else if (
    targets[0]!.dataType !== "number" &&
    targets[0]!.dataType !== "integer"
  ) {
    issues.push("The target column must have a numeric type");
  }

  return issues;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

export async function createTrainingJob(
  repository: TrainingJobRepository,
  schemaName: string,
  userId: string,
  input: CreateTrainingJobInput,
): Promise<CreateTrainingJobResult> {
  const definition = await repository.loadDatasetDefinition(
    input.datasetDefinitionId,
  );
  if (!definition || definition.sourceSchema !== schemaName) {
    return trainingRequestError(
      404,
      "DATASET_DEFINITION_NOT_FOUND",
      `No dataset definition with id '${input.datasetDefinitionId}' exists`,
      [
        {
          path: "datasetDefinitionId",
          message: `No dataset definition with id '${input.datasetDefinitionId}' exists in this tenant`,
        },
      ],
    );
  }

  const columns = await repository.loadDatasetColumns(
    input.datasetDefinitionId,
  );
  const trainabilityIssues = validateDatasetTrainability(columns);
  if (trainabilityIssues.length > 0) {
    return trainingRequestError(
      422,
      "DATASET_NOT_TRAINABLE",
      "The dataset definition cannot be used for training",
      trainabilityIssues.map((message) => ({
        path: "datasetDefinitionId",
        message,
      })),
    );
  }

  const snapshot = await repository.loadLatestValidSnapshot(
    input.datasetDefinitionId,
  );
  if (!snapshot) {
    return trainingRequestError(
      404,
      "SNAPSHOT_NOT_FOUND",
      `No snapshot exists for dataset definition '${input.datasetDefinitionId}'`,
      [
        {
          path: "datasetDefinitionId",
          message: "Create a snapshot before requesting training",
        },
      ],
    );
  }

  const trainingConfig = resolveTrainingConfig();
  const fingerprint = buildTrainingFingerprint({
    snapshotContentSha256: snapshot.contentSha256,
    trainingConfig,
  });

  // Abandoned running jobs otherwise inflate the active count and
  // permanently burn a tenant quota slot, so expired claims are reaped
  // before the quota check observes them.
  const recovered = await repository.recoverAbandonedTrainingJobs(
    resolveHeartbeatExpirySeconds(),
  );

  if (recovered > 0) {
    console.log(
      `Recovered ${recovered} heartbeat-expired training job(s) for tenant '${schemaName}'`,
    );
  }

  await repository.lockTrainingSubmissionQuota(schemaName);

  const activeJobs = await repository.countActiveTrainingJobs();
  if (activeJobs >= resolveMaxActiveTrainingJobs()) {
    return trainingRequestError(
      429,
      "TRAINING_QUOTA_EXCEEDED",
      "The training job limit for this tenant has been reached",
      [],
    );
  }

  try {
    const inserted = await repository.insertTrainingJob({
      datasetSnapshotId: snapshot.id,
      fingerprint,
      trainingConfig,
      maxRuntimeSeconds: trainingConfig.maxRuntimeSeconds,
      createdBy: userId,
    });

    return {
      ok: true,
      status: 201,
      body: toTrainingJobResponse(inserted, snapshot, fingerprint, trainingConfig),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return trainingRequestError(
        409,
        "DUPLICATE_TRAINING_REQUEST",
        "An equivalent training job already exists",
        [],
      );
    }
    throw error;
  }
}

export type TrainingCancellationError = {
  error: {
    code: TrainingJobRequestErrorCode;
    message: string;
    issues: { path: string; message: string }[];
  };
};

export type CancelTrainingJobServiceResult =
  | {
      ok: true;
      status: 200;
      body: { status: "cancelled"; fromStatus: "queued" | "running" };
    }
  | { ok: false; status: 404 | 409; body: TrainingCancellationError };

/**
 * Cancels one queued or running training job. Terminal states are
 * immutable, so a job that already reached succeeded, failed, cancelled,
 * or dead stays untouched and the outcome reports the current status.
 */
export async function cancelTrainingJobRequest(
  repository: TrainingJobRepository,
  jobId: string,
): Promise<CancelTrainingJobServiceResult> {
  const outcome = await repository.cancelTrainingJob(jobId);

  if (outcome.ok) {
    return {
      ok: true,
      status: 200,
      body: { status: "cancelled", fromStatus: outcome.fromStatus },
    };
  }

  if (outcome.reason === "not-found") {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "TRAINING_JOB_NOT_FOUND",
          message: `No cancellable training job with id '${jobId}' exists`,
          issues: [],
        },
      },
    };
  }

  return {
    ok: false,
    status: 409,
    body: {
      error: {
        code: "JOB_TERMINAL_STATE",
        message: `Training job '${jobId}' is already in terminal status '${outcome.currentStatus}'`,
        issues: [],
      },
    },
  };
}

function toTrainingJobResponse(
  inserted: InsertedTrainingJob,
  snapshot: LoadedTrainingSnapshot,
  fingerprint: string,
  trainingConfig: ResolvedTrainingConfig,
): TrainingJobResponse {
  return {
    id: inserted.id,
    datasetSnapshotId: snapshot.id,
    fingerprint,
    status: "queued",
    trainingConfig,
    progressPercent: 0,
    progressMessage: QUEUED_TRAINING_JOB_PROGRESS_MESSAGE,
    queuedAt: inserted.queuedAt.toISOString(),
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    error: null,
  };
}

function trainingRequestError(
  status: 404 | 409 | 422 | 429,
  code:
    | "DATASET_DEFINITION_NOT_FOUND"
    | "DATASET_NOT_TRAINABLE"
    | "SNAPSHOT_NOT_FOUND"
    | "TRAINING_QUOTA_EXCEEDED"
    | "DUPLICATE_TRAINING_REQUEST",
  message: string,
  issues: { path: string; message: string }[],
): { ok: false; status: 404 | 409 | 422 | 429; body: TrainingJobRequestError } {
  return {
    ok: false,
    status,
    body: {
      error: {
        code,
        message,
        issues,
      },
    },
  };
}
