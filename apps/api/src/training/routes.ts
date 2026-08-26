import {
  CreateTrainingJobDto,
  type CreateTrainingJobInput,
  type TrainingJobRequestError,
} from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import { Elysia } from "elysia";

import {
  CREATE_TRAINING_JOB_CLAIM,
  getAuthContext,
  hasClaim,
} from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";
import { withTenantTransaction } from "../database/tenant-transaction";
import { loadTrainingJobProgress } from "./repository";
import { createTrainingJob, createTrainingJobRepository } from "./service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const trainingRoutes = new Elysia({ prefix: "/training-jobs" }).get(
  "/:trainingJobId",
  async ({ params, request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }
    if (!hasClaim(auth, CREATE_TRAINING_JOB_CLAIM)) {
      set.status = 403;
      return { error: { code: "FORBIDDEN", message: "Training job access permission is required" } };
    }
    if (!UUID_PATTERN.test(params.trainingJobId)) {
      set.status = 400;
      return { error: { code: "INVALID_TRAINING_JOB_ID", message: "Training job id is invalid" } };
    }

    const job = await withTenantTransaction(auth.schemaName, (client) =>
      loadTrainingJobProgress(client, params.trainingJobId),
    );
    if (!job) {
      set.status = 404;
      return { error: { code: "TRAINING_JOB_NOT_FOUND", message: "Training job was not found" } };
    }

    return job;
  },
).post(
  "/",
  async ({ request, set }) => {
    const auth = getAuthContext(request.headers);

    if (!auth) {
      set.status = 401;

      return {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
          issues: [],
        },
      };
    }

    if (!hasClaim(auth, CREATE_TRAINING_JOB_CLAIM)) {
      set.status = 403;

      return {
        error: {
          code: "FORBIDDEN",
          message: "Training job creation permission is required",
          issues: [],
        },
      };
    }

    const body = await parseTrainingJobBody(request);
    if (!body.ok) {
      set.status = 400;

      return body.body;
    }

    const result = await withTenantTransaction(auth.schemaName, (client) =>
      createTrainingJob(
        createTrainingJobRepository(client),
        auth.schemaName,
        auth.userId,
        body.body,
      ),
    );

    if (!result.ok) {
      set.status = result.status;

      return result.body;
    }

    set.status = 201;

    return result.body;
  },
);

type ParsedTrainingJobBody =
  | { ok: true; body: CreateTrainingJobInput }
  | { ok: false; body: TrainingJobRequestError };

async function parseTrainingJobBody(
  request: Request,
): Promise<ParsedTrainingJobBody> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return {
      ok: false,
      body: invalidRequestError([
        {
          path: "$",
          message: "The request body could not be parsed as JSON",
        },
      ]),
    };
  }

  const issues = [...Value.Errors(CreateTrainingJobDto, parsed)].map(
    (error) => ({
      path: error.path || "$",
      message: error.message,
    }),
  );

  if (issues.length > 0) {
    return { ok: false, body: invalidRequestError(issues) };
  }

  return { ok: true, body: parsed as CreateTrainingJobInput };
}

function invalidRequestError(
  issues: { path: string; message: string }[],
): TrainingJobRequestError {
  return {
    error: {
      code: "INVALID_TRAINING_REQUEST",
      message: "The training job request is invalid",
      issues,
    },
  };
}
