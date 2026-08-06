import type { TrainingJobStatus } from "./job";

export const TRAINING_JOB_TRANSITIONS = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "dead"],
  succeeded: [],
  failed: [],
  cancelled: [],
  dead: [],
} as const satisfies Readonly<
  Record<TrainingJobStatus, readonly TrainingJobStatus[]>
>;

export const TERMINAL_TRAINING_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "dead",
] as const satisfies readonly TrainingJobStatus[];

export type TerminalTrainingJobStatus =
  (typeof TERMINAL_TRAINING_JOB_STATUSES)[number];

export const TRAINING_JOB_TRANSITION_OWNERS = {
  "queued->running": "worker",
  "queued->cancelled": "nucleus",
  "running->succeeded": "worker",
  "running->failed": "worker",
  "running->cancelled": "nucleus",
  "running->dead": "nucleus",
} as const;

export type TrainingJobTransition =
  keyof typeof TRAINING_JOB_TRANSITION_OWNERS;

export type TrainingJobTransitionOwner =
  (typeof TRAINING_JOB_TRANSITION_OWNERS)[TrainingJobTransition];

export const TRAINING_JOB_HEARTBEAT_INTERVAL_SECONDS = 10;
export const TRAINING_JOB_DEAD_THRESHOLD_SECONDS = 30;
