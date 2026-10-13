/** Exact overrides take precedence over the environment's demo seed default. */
export function shouldSeedDemoData(
  value: string | undefined,
  nodeEnv: string | undefined,
  defaultSeed = nodeEnv !== "production",
): boolean {
  if (value === "false") return false;
  if (value === "true") return true;
  return defaultSeed;
}
