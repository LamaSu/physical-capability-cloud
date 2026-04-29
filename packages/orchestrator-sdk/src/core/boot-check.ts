// Boot-time sanity check.
//
// T1.8 (2026-04-29): runs at process start to ensure no MOCK_* env var is
// set to "true" while NODE_ENV=production. The MOCK_* defaults were flipped
// in this same wave so they only activate on explicit opt-in — but operators
// can still leave a stale MOCK_PCC_DISCOVERY=true in a copy-pasted .env file
// and ship it to prod. This check is the second layer: hard-fail at boot
// rather than silently mint fakes for paying customers.
//
// Call from each long-lived entry point (gateway, voice agent, build agent)
// so production deploys self-cancel before serving traffic if a mock flag
// leaked through.

const MOCK_PREFIX = "MOCK_";

export interface BootCheckResult {
  /** Production environments only ever return when result.ok=true. */
  ok: boolean;
  /** Names of any MOCK_* env vars currently set to "true". */
  offendingMocks: string[];
}

/**
 * Read process.env, find every key starting with MOCK_ that's set to "true",
 * and return them. Pure (no side effects) so callers can inspect without
 * crashing. The crash policy lives in `assertProductionReady` below.
 */
export function findEnabledMocks(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => k.startsWith(MOCK_PREFIX) && v === "true")
    .map(([k]) => k)
    .sort();
}

/**
 * Throws when NODE_ENV=production and any MOCK_*=true env var is set. Use
 * this at the very top of production entry points:
 *
 *   import { assertProductionReady } from "@pcc/orchestrator-sdk";
 *   assertProductionReady();
 *
 * Returns a structured result for non-production environments so dev runs
 * can log a warning without crashing.
 */
export function assertProductionReady(env: NodeJS.ProcessEnv = process.env): BootCheckResult {
  const offendingMocks = findEnabledMocks(env);
  const ok = offendingMocks.length === 0;
  if (env.NODE_ENV === "production" && !ok) {
    throw new Error(
      `MOCK_* must not be true in production: ${offendingMocks.join(", ")}. ` +
        `Unset these env vars or change NODE_ENV before booting.`
    );
  }
  return { ok, offendingMocks };
}
