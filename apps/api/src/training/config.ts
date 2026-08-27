import type { ResolvedTrainingConfig } from "@ampersand/contracts";

import { Value } from "@sinclair/typebox/value";
import { ResolvedTrainingConfigDto } from "@ampersand/contracts";

export const DEFAULT_MAX_ACTIVE_TRAINING_JOBS = 5;

export const DEFAULT_HEARTBEAT_EXPIRY_SECONDS = 180;

export const QUEUED_TRAINING_JOB_PROGRESS_MESSAGE = "Waiting for a worker";

export function resolveTrainingConfig(): ResolvedTrainingConfig {
  const config: ResolvedTrainingConfig = {
    trainerVersion: "1.0.0",
    algorithmPolicy: "automatic-regression",
    randomSeed: 42,
    splitStrategy: "chronological",
    testFraction: 0.2,
    maxRuntimeSeconds: 600,
  };

  if (!Value.Check(ResolvedTrainingConfigDto, config)) {
    throw new Error("Resolved training configuration failed contract validation");
  }

  return config;
}

export function resolveMaxActiveTrainingJobs(): number {
  const raw = process.env.TRAINING_MAX_ACTIVE_JOBS;

  if (raw === undefined) {
    return DEFAULT_MAX_ACTIVE_TRAINING_JOBS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_ACTIVE_TRAINING_JOBS;
  }

  return value;
}

export function resolveHeartbeatExpirySeconds(): number {
  const raw = process.env.TRAINING_HEARTBEAT_EXPIRY_SECONDS;

  if (raw === undefined) {
    return DEFAULT_HEARTBEAT_EXPIRY_SECONDS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_HEARTBEAT_EXPIRY_SECONDS;
  }

  return value;
}
