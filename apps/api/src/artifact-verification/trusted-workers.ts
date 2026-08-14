export function parseTrustedWorkerIds(
  value: string | undefined,
): ReadonlySet<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((workerId) => workerId.trim())
      .filter((workerId) => workerId.length > 0),
  );
}
