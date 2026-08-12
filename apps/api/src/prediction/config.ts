const DEFAULT_BOUNDARY_WARNING_RATIO = 0.1;
const MAX_BOUNDARY_WARNING_RATIO = 0.5;

export function getBoundaryWarningRatio(
  configuredValue = process.env.BOUNDARY_WARNING_RATIO,
): number {
  if (configuredValue === undefined || configuredValue.trim() === "") {
    return DEFAULT_BOUNDARY_WARNING_RATIO;
  }

  const ratio = Number(configuredValue);

  if (
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > MAX_BOUNDARY_WARNING_RATIO
  ) {
    throw new Error(
      "BOUNDARY_WARNING_RATIO must be a number between 0 and 0.5",
    );
  }

  return ratio;
}
