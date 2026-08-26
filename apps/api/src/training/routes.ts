import {
  CreateTrainingJobDto,
  type CreateTrainingJobInput,
  type TrainingJobRequestError,
} from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import { Elysia } from "elysia";

import {
  CANCEL_TRAINING_JOB_CLAIM,
  CREATE_TRAINING_JOB_CLAIM,
  getAuthContext,
  hasClaim,
} from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import {
  cancelTrainingJobRequest,
  createTrainingJob,
  createTrainingJobRepository,
} from "./service";

const TRAINING_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestError(
  code: string,
  message: string,
): { error: { code: string; message: string; issues: never[] } } {
  return { error: { code, message, issues: [] } };
}

export type TrainingRouteDependencies = {
  withTenantTransaction: typeof withTenantTransaction;
  cancelTrainingJobRequest: typeof cancelTrainingJobRequest;
};

export function createTrainingRoutes(
  overrides: Partial<TrainingRouteDependencies> = {},
) {
  const dependencies: TrainingRouteDependencies = {
    withTenantTransaction,
    cancelTrainingJobRequest,
    ...overrides,
  };

  return new Elysia({ prefix: "/training-jobs" })
    .post(
      "/",
      async ({ request, set }) => {
        const auth = getAuthContext(request.headers);

        if (!auth) {
          set.status = 401;

          return requestError(
            "UNAUTHENTICATED",
            "Authentication is required",
          );
        }

        if (!hasClaim(auth, CREATE_TRAINING_JOB_CLAIM)) {
          set.status = 403;

          return requestError(
            "FORBIDDEN",
            "Training job creation permission is required",
          );
        }

        const body = await parseTrainingJobBody(request);
        if (!body.ok) {
          set.status = 400;

          return body.body;
        }

        const result = await dependencies.withTenantTransaction(
          auth.schemaName,
          (client) =>
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
    )
    .post(
      "/:jobId/cancel",
      async ({ request, params, set }) => {
        const auth = getAuthContext(request.headers);

        if (!auth) {
          set.status = 401;

          return requestError(
            "UNAUTHENTICATED",
            "Authentication is required",
          );
        }

        if (!hasClaim(auth, CANCEL_TRAINING_JOB_CLAIM)) {
          set.status = 403;

          return requestError(
            "FORBIDDEN",
            "Training job cancellation permission is required",
          );
        }

        if (!TRAINING_JOB_ID_PATTERN.test(params.jobId)) {
          set.status = 400;

          return requestError(
            "INVALID_TRAINING_JOB_ID",
            "The training job id is not a valid uuid",
          );
        }

        const result = await dependencies.withTenantTransaction(
          auth.schemaName,
          (client) =>
            dependencies.cancelTrainingJobRequest(
              createTrainingJobRepository(client),
              params.jobId,
            ),
        );

        if (!result.ok) {
          set.status = result.status;

          return result.body;
        }

        set.status = 200;

        return result.body;
      },
    );
}

export const trainingRoutes = createTrainingRoutes();

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
