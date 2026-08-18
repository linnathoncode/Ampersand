export const DEFAULT_DAILY_TENANT_INFERENCE_QUOTA = 1_000;

export function getDailyTenantInferenceQuota(): number {
  const configuredQuota = process.env.INFERENCE_TENANT_DAILY_QUOTA;

  if (configuredQuota === undefined) {
    return DEFAULT_DAILY_TENANT_INFERENCE_QUOTA;
  }

  const quota = Number(configuredQuota);

  if (!Number.isInteger(quota) || quota < 1) {
    throw new Error("INFERENCE_TENANT_DAILY_QUOTA must be a positive integer");
  }

  return quota;
}
