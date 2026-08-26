import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

const { createTrainingRoutes } = await import("./routes");
const serviceModule = await import("./service");

const cancelJobId = "55555555-5555-4555-8555-555555555555";
const cancelUrl = `http://localhost/training-jobs/${cancelJobId}/cancel`;

type CancelOutcome = Awaited<
  ReturnType<typeof serviceModule.cancelTrainingJobRequest>
>;

const observedJobIds: string[] = [];
let nextOutcome: CancelOutcome;

function cancelRequest(
  headers: Record<string, string> = {
    "x-user-id": "22222222-2222-4222-8222-222222222222",
    "x-tenant-schema": "ampersand_dev",
    "x-auth-type": "jwt",
    "x-user-claims": "cancel.training_jobs",
  },
): Request {
  return new Request(cancelUrl, { method: "POST", headers });
}

function makeRoutes() {
  return createTrainingRoutes({
    withTenantTransaction: (_schemaName, operation) =>
      operation({} as PoolClient, {
        onRollback: () => {},
      }),
    cancelTrainingJobRequest: (async (
      _repository: Parameters<
        typeof serviceModule.cancelTrainingJobRequest
      >[0],
      jobId: string,
    ) => {
      observedJobIds.push(jobId);

      return nextOutcome;
    }) as unknown as typeof serviceModule.cancelTrainingJobRequest,
  });
}

describe("training job cancellation route", () => {
  test("rejects an unauthenticated cancel", async () => {
    const response = await makeRoutes().handle(
      cancelRequest({ "content-type": "application/json" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
        issues: [],
      },
    });
  });

  test("rejects a user without the cancellation claim", async () => {
    const response = await makeRoutes().handle(
      cancelRequest({
        "x-user-id": "22222222-2222-4222-8222-222222222222",
        "x-tenant-schema": "ampersand_dev",
        "x-auth-type": "jwt",
        "x-user-claims": "invoke.tool_definitions",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Training job cancellation permission is required",
        issues: [],
      },
    });
  });

  test("rejects a malformed job id before touching the service", async () => {
    const response = await makeRoutes().handle(
      new Request("http://localhost/training-jobs/not-a-uuid/cancel", {
        method: "POST",
        headers: {
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-auth-type": "jwt",
          "x-user-claims": "cancel.training_jobs",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(observedJobIds).toEqual([]);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_TRAINING_JOB_ID",
        message: "The training job id is not a valid uuid",
        issues: [],
      },
    });
  });

  test("cancels a queued job and reports the previous status", async () => {
    nextOutcome = {
      ok: true,
      status: 200,
      body: { status: "cancelled", fromStatus: "queued" },
    };

    const response = await makeRoutes().handle(cancelRequest());

    expect(response.status).toBe(200);
    expect(observedJobIds.at(-1)).toBe(cancelJobId);
    expect(await response.json()).toEqual({
      status: "cancelled",
      fromStatus: "queued",
    });
  });

  test("cancels a running job through the same endpoint", async () => {
    nextOutcome = {
      ok: true,
      status: 200,
      body: { status: "cancelled", fromStatus: "running" },
    };

    const response = await makeRoutes().handle(cancelRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "cancelled",
      fromStatus: "running",
    });
  });

  test("reports unknown jobs as a structured 404", async () => {
    nextOutcome = {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "TRAINING_JOB_NOT_FOUND",
          message: `No cancellable training job with id '${cancelJobId}' exists`,
          issues: [],
        },
      },
    };

    const response = await makeRoutes().handle(cancelRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "TRAINING_JOB_NOT_FOUND",
        message: `No cancellable training job with id '${cancelJobId}' exists`,
        issues: [],
      },
    });
  });

  test("rejects terminal states with a 409 echoing the current status", async () => {
    nextOutcome = {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "JOB_TERMINAL_STATE",
          message: `Training job '${cancelJobId}' is already in terminal status 'succeeded'`,
          issues: [],
        },
      },
    };

    const response = await makeRoutes().handle(cancelRequest());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("JOB_TERMINAL_STATE");
  });

  test("a second cancel observes the first one as a terminal state", async () => {
    nextOutcome = {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "JOB_TERMINAL_STATE",
          message: `Training job '${cancelJobId}' is already in terminal status 'cancelled'`,
          issues: [],
        },
      },
    };

    const response = await makeRoutes().handle(cancelRequest());

    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("'cancelled'");
  });
});
