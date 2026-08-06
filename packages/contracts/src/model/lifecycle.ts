import type { ModelVersionStatus } from "./version";

export const MODEL_VERSION_TRANSITIONS = {
  candidate: ["published"],
  published: ["retired"],
  retired: [],
} as const satisfies Readonly<
  Record<ModelVersionStatus, readonly ModelVersionStatus[]>
>;

export function isModelVersionTransitionAllowed(
  from: ModelVersionStatus,
  to: ModelVersionStatus,
): boolean {
  const allowedNextStatuses: readonly ModelVersionStatus[] =
    MODEL_VERSION_TRANSITIONS[from];
  return allowedNextStatuses.includes(to);
}
