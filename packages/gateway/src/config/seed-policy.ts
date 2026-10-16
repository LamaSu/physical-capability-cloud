import { logSafeId } from "../redaction.js";

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

/** Report invalid overrides once from the gateway's boot path. */
export function warnInvalidSeedDataOverride(
  value: string | undefined,
  nodeEnv: string | undefined,
): void {
  if (value === undefined || value === "true" || value === "false") return;
  console.warn(
    `Invalid PCC_SEED_DATA ${JSON.stringify(logSafeId(value))}; falling back to default ${shouldSeedDemoData(undefined, nodeEnv)}.`,
  );
}
