import { Type, type Static } from "@sinclair/typebox";

export const CleanupCandidatesDto = Type.Object(
  {
    staleTempFiles: Type.Integer({ minimum: 0 }),
    abandonedSnapshots: Type.Integer({ minimum: 0 }),
    unreferencedCandidates: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CleanupCandidates = Static<typeof CleanupCandidatesDto>;

export const CleanupDeletedDto = Type.Object(
  {
    staleTempFiles: Type.Integer({ minimum: 0 }),
    abandonedSnapshots: Type.Integer({ minimum: 0 }),
    unreferencedCandidates: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CleanupDeleted = Static<typeof CleanupDeletedDto>;

export const CleanupErrorDto = Type.Object(
  {
    class: Type.Union([
      Type.Literal("stale_temp_file"),
      Type.Literal("abandoned_snapshot"),
      Type.Literal("unreferenced_candidate"),
    ]),
    id: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    message: Type.String(),
  },
  { additionalProperties: false },
);
export type CleanupError = Static<typeof CleanupErrorDto>;

export const CleanupResultDto = Type.Object(
  {
    dryRun: Type.Boolean(),
    scanned: Type.Integer({ minimum: 0 }),
    candidates: CleanupCandidatesDto,
    deleted: CleanupDeletedDto,
    bytesReclaimed: Type.Integer({ minimum: 0 }),
    protectedCount: Type.Integer({ minimum: 0 }),
    errors: Type.Array(CleanupErrorDto),
    durationMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CleanupResult = Static<typeof CleanupResultDto>;
