import { getDailyTenantInferenceQuota } from "./config";
import type { TenantQuotaReservation, TenantQuotaStore } from "./tenant-quota";

export type TenantQuotaExceededResponse = {
  error: {
    code: "TENANT_INFERENCE_QUOTA_EXCEEDED";
    message: string;
    limit: number;
    used: number;
    resetsAt: string;
  };
};

export type ReserveTenantInferenceResult =
  | {
      ok: true;
      reservation: Extract<TenantQuotaReservation, { allowed: true }>;
    }
  | {
      ok: false;
      status: 429;
      body: TenantQuotaExceededResponse;
    };

export async function reserveTenantInferenceQuota(
  store: TenantQuotaStore,
  schemaName: string,
  now: Date = new Date(),
): Promise<ReserveTenantInferenceResult> {
  const reservation = await store.reserve({
    schemaName,
    limit: getDailyTenantInferenceQuota(),
    now,
  });

  if (!reservation.allowed) {
    return {
      ok: false,
      status: 429,
      body: {
        error: {
          code: "TENANT_INFERENCE_QUOTA_EXCEEDED",
          message: "The tenant's daily inference quota has been reached",
          limit: reservation.limit,
          used: reservation.used,
          resetsAt: reservation.resetsAt.toISOString(),
        },
      },
    };
  }

  return {
    ok: true,
    reservation,
  };
}
