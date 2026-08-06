import { FormatRegistry } from "@sinclair/typebox";

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  ),
);
FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  ),
);

export const uuid = "123e4567-e89b-42d3-a456-426614174000";
export const secondUuid = "123e4567-e89b-42d3-a456-426614174001";
export const hash = "a".repeat(64);
export const timestamp = "2026-08-04T08:00:00Z";
