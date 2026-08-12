import { describe, expect, test } from "bun:test";

import type { ResolvedTrainingConfig } from "@ampersand/contracts";

import { buildTrainingFingerprint } from "./fingerprint";

const trainingConfig: ResolvedTrainingConfig = {
  trainerVersion: "1.0.0",
  algorithmPolicy: "automatic-regression",
  randomSeed: 42,
  splitStrategy: "chronological",
  testFraction: 0.2,
  maxRuntimeSeconds: 600,
};

const snapshotSha256 = "a".repeat(64);

describe("buildTrainingFingerprint", () => {
  test("is deterministic for identical inputs", () => {
    const first = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig,
    });
    const second = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig,
    });

    expect(first).toBe(second);
  });

  test("returns 64 lowercase hexadecimal characters", () => {
    const fingerprint = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig,
    });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("changes when the snapshot checksum changes", () => {
    const baseline = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig,
    });
    const changed = buildTrainingFingerprint({
      snapshotContentSha256: "b".repeat(64),
      trainingConfig,
    });

    expect(changed).not.toBe(baseline);
  });

  test.each([
    ["trainerVersion", "1.1.0"],
    ["randomSeed", 7],
    ["splitStrategy", "random" as ResolvedTrainingConfig["splitStrategy"]],
    ["testFraction", 0.3],
    ["maxRuntimeSeconds", 900],
  ] as const)("changes when %s changes", (key, value) => {
    const baseline = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig,
    });
    const changed = buildTrainingFingerprint({
      snapshotContentSha256: snapshotSha256,
      trainingConfig: { ...trainingConfig, [key]: value },
    });

    expect(changed).not.toBe(baseline);
  });

  test("is independent of property order in the configuration", () => {
    const reordered: ResolvedTrainingConfig = {
      maxRuntimeSeconds: trainingConfig.maxRuntimeSeconds,
      testFraction: trainingConfig.testFraction,
      splitStrategy: trainingConfig.splitStrategy,
      randomSeed: trainingConfig.randomSeed,
      algorithmPolicy: trainingConfig.algorithmPolicy,
      trainerVersion: trainingConfig.trainerVersion,
    };

    expect(
      buildTrainingFingerprint({
        snapshotContentSha256: snapshotSha256,
        trainingConfig,
      }),
    ).toBe(
      buildTrainingFingerprint({
        snapshotContentSha256: snapshotSha256,
        trainingConfig: reordered,
      }),
    );
  });
});
