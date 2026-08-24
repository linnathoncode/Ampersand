import {
  TrainingWorkerSuccessDto,
  type TrainingWorkerSuccess,
} from "@ampersand/contracts";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";

import {
  defaultSubmissionDependencies,
  submitSuccessResult,
  type ResultSubmissionOutcome,
  type SubmissionDependencies,
} from "./training-registration";

const TENANT_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The submission envelope is local to this endpoint on purpose: it wraps the
 * shared TrainingWorkerSuccessDto payload with only the transport fields the
 * worker already knows (its id and the job fingerprint), so the shared
 * worker-result contract stays untouched.
 */
const TrainingResultSubmissionDto = Type.Object(
  {
    workerId: Type.String({ minLength: 1 }),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    result: TrainingWorkerSuccessDto,
  },
  { additionalProperties: false },
);

type TrainingResultSubmission = Static<typeof TrainingResultSubmissionDto>;

export type InternalRouteDependencies = {
  storageRoot: string;
  internalToken: string | undefined;
  submission: SubmissionDependencies;
};

export function createInternalRoutes(
  overrides: Partial<InternalRouteDependencies> = {},
) {
  const dependencies: InternalRouteDependencies = {
    storageRoot: process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts",
    internalToken: process.env.NUCLEUS_INTERNAL_TOKEN,
    submission: defaultSubmissionDependencies,
    ...overrides,
  };

  return new Elysia({ prefix: "/internal" }).post(
    "/training-jobs/:jobId/result",
    async ({ params, request, set }) => {
      if (!isInternalTokenValid(request.headers.get("authorization"), dependencies.internalToken)) {
        set.status = 401;

        return {
          error: {
            code: "UNAUTHENTICATED",
            message:
              "A valid internal worker token is required for this endpoint",
            issues: [],
          },
        };
      }

      const schemaName = request.headers.get("x-tenant-schema") ?? "";

      if (!TENANT_SCHEMA_PATTERN.test(schemaName)) {
        set.status = 400;

        return {
          error: {
            code: "INVALID_TENANT_SCHEMA",
            message: "The x-tenant-schema header is missing or malformed",
            issues: [],
          },
        };
      }

      const jobId = params.jobId;

      if (!UUID_PATTERN.test(jobId)) {
        set.status = 400;

        return {
          error: {
            code: "INVALID_TRAINING_REQUEST",
            message: "The training job id is not a valid uuid",
            issues: [],
          },
        };
      }

      const body = await parseSubmissionBody(request);

      if (!body.ok) {
        set.status = 400;

        return body.body;
      }

      const outcome = await submitSuccessResult(
        {
          schemaName,
          jobId,
          jobFingerprint: body.body.fingerprint,
          workerId: body.body.workerId,
          result: body.body.result,
          storageRoot: dependencies.storageRoot,
        },
        dependencies.submission,
      );

      return respondWith(outcome, set);
    },
  );
}

function respondWith(
  outcome: ResultSubmissionOutcome,
  set: { status?: number | string },
) {
  switch (outcome.kind) {
    case "registered":
      set.status = 200;

      return {
        status: "registered",
        modelVersionId: outcome.candidate.modelVersionId,
        versionNumber: outcome.candidate.versionNumber,
        storageUri: outcome.candidate.storageUri,
      };
    case "rejected":
      set.status = outcome.httpStatus;

      return {
        error: {
          code: outcome.code,
          message: outcome.message,
          issues: [],
        },
      };
    case "unavailable":
      set.status = 503;

      return {
        error: {
          code: "REGISTRATION_UNAVAILABLE",
          message: outcome.message,
          issues: [],
        },
      };
  }
}

function isInternalTokenValid(
  authorizationHeader: string | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return false;
  }

  if (!authorizationHeader) {
    return false;
  }

  const separatorIndex = authorizationHeader.indexOf(" ");
  const scheme = authorizationHeader.slice(0, separatorIndex);
  const token = authorizationHeader.slice(separatorIndex + 1);

  if (scheme !== "Bearer" || token.length === 0) {
    return false;
  }

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

type ParsedSubmission =
  | { ok: true; body: TrainingResultSubmission }
  | {
      ok: false;
      body: {
        error: {
          code: string;
          message: string;
          issues: { path: string; message: string }[];
        };
      };
    };

async function parseSubmissionBody(
  request: Request,
): Promise<ParsedSubmission> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return {
      ok: false,
      body: invalidRequest("The request body could not be parsed as JSON"),
    };
  }

  const issues = [...Value.Errors(TrainingResultSubmissionDto, parsed)].map(
    (error) => ({
      path: error.path || "$",
      message: error.message,
    }),
  );

  if (issues.length > 0) {
    return {
      ok: false,
      body: invalidRequest("The training result submission is invalid", issues),
    };
  }

  return { ok: true, body: parsed as TrainingResultSubmission };
}

function invalidRequest(
  message: string,
  issues: { path: string; message: string }[] = [],
) {
  return {
    error: {
      code: "INVALID_TRAINING_REQUEST",
      message,
      issues,
    },
  };
}

export const internalRoutes = createInternalRoutes();
