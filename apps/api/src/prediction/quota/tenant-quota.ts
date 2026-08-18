export type TenantQuotaReservation =
  | {
      allowed: true;
      used: number;
      limit: number;
      remaining: number;
      resetsAt: Date;
    }
  | {
      allowed: false;
      used: number;
      limit: number;
      remaining: 0;
      resetsAt: Date;
    };

export type ReserveTenantQuotaInput = {
  schemaName: string;
  limit: number;
  now: Date;
};

export interface TenantQuotaStore {
  reserve(input: ReserveTenantQuotaInput): Promise<TenantQuotaReservation>;
  release(schemaName: string, now: Date): Promise<void>;
}

export function createTenantQuotaKey(schemaName: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);

  return `inference-quota:${schemaName}:${date}`;
}

export function getNextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}
