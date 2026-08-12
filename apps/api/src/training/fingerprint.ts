import { createHash } from "node:crypto";

import type { ResolvedTrainingConfig } from "@ampersand/contracts";

export const FINGERPRINT_VERSION = 1;

export function buildTrainingFingerprint(input: {
  snapshotContentSha256: string;
  trainingConfig: ResolvedTrainingConfig;
}): string {
  const canonical = JSON.stringify({
    fingerprintVersion: FINGERPRINT_VERSION,
    snapshotSha256: input.snapshotContentSha256,
    trainingConfig: {
      trainerVersion: input.trainingConfig.trainerVersion,
      algorithmPolicy: input.trainingConfig.algorithmPolicy,
      randomSeed: input.trainingConfig.randomSeed,
      splitStrategy: input.trainingConfig.splitStrategy,
      testFraction: input.trainingConfig.testFraction,
      maxRuntimeSeconds: input.trainingConfig.maxRuntimeSeconds,
    },
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
