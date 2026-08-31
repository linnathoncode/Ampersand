import type { ResolvedTrainingConfig } from "@ampersand/contracts";

import { Value } from "@sinclair/typebox/value";
import { ResolvedTrainingConfigDto } from "@ampersand/contracts";
import { resolvePositiveInt } from "../utils/env";

export const DEFAULT_MAX_ACTIVE_TRAINING_JOBS = 5;

export const DEFAULT_HEARTBEAT_EXPIRY_SECONDS = 180;

export const DEFAULT_TRAINING_RUNTIME_SECONDS = 600;

export const DEFAULT_ARTIFACT_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export const QUEUED_TRAINING_JOB_PROGRESS_MESSAGE = "Waiting for a worker";

export function resolveTrainingConfig(): ResolvedTrainingConfig {
  const config: ResolvedTrainingConfig = {
    trainerVersion: "1.0.0",
    algorithmPolicy: "automatic-regression",
    randomSeed: 42,
    splitStrategy: "chronological",
    testFraction: 0.2,
    maxRuntimeSeconds: resolveTrainingRuntimeSeconds(),
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

export function resolveTrainingRuntimeSeconds(): number {
  return resolvePositiveInt(
    process.env.TRAINING_MAX_RUNTIME_SECONDS,
    DEFAULT_TRAINING_RUNTIME_SECONDS,
  );
}

/**
 * Authoritative upper bound on the encoded model artifact size. Larger payloads
 * are rejected before promotion. Returns the configured limit or its default;
 * invalid values fall back to the default rather than disabling the check.
 */
export function resolveArtifactSizeLimit(): number {
  return resolvePositiveInt(
    process.env.ARTIFACT_MAX_SIZE_BYTES,
    DEFAULT_ARTIFACT_SIZE_LIMIT_BYTES,
  );
}
