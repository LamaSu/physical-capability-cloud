/**
 * Shadow-mode telemetry writer.
 *
 * When PCC_RANKER_MODE=shadow, the gateway runs BOTH the legacy ranker
 * and the new HybridRanker on every query, serves legacy results to the
 * caller, and fires an async append to the shadow log for A/B analysis.
 *
 * Log path resolution (in order):
 *   1. process.env.PCC_RANKER_SHADOW_LOG  — explicit override
 *   2. ~/.claude/audit/ranker-shadow.jsonl — default
 *   3. ./ranker-shadow.jsonl              — if HOME unavailable
 *
 * Format: one JSON object per line, schema = ShadowTelemetryEvent.
 *
 * Writes are best-effort and fire-and-forget — failure to write the log
 * MUST NOT block or mutate the served response. Errors are routed
 * through an optional `onError` hook (defaults to console.warn).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { ShadowTelemetryEvent } from "./types.js";

/** Compute the effective shadow log path from env. Exported for tests. */
export function resolveShadowLogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PCC_RANKER_SHADOW_LOG) {
    return resolvePath(env.PCC_RANKER_SHADOW_LOG);
  }
  const home = env.HOME || homedir() || ".";
  return join(home, ".claude", "audit", "ranker-shadow.jsonl");
}

/**
 * Build a ShadowTelemetryEvent from two rankings. Both inputs are
 * already-truncated to top-5 (or fewer if the result set is smaller).
 */
export function buildShadowEvent(input: {
  query: string;
  legacyTop5: Array<{ id: string; score: number }>;
  hybridTop5: Array<{ id: string; score: number }>;
  now?: Date;
}): ShadowTelemetryEvent {
  const now = input.now ?? new Date();
  const legacyIds = new Set(input.legacyTop5.map((h) => h.id));
  const hybridIds = new Set(input.hybridTop5.map((h) => h.id));
  let overlap = 0;
  for (const id of hybridIds) if (legacyIds.has(id)) overlap++;
  const allIds = new Set<string>([...legacyIds, ...hybridIds]);
  const legacyRankById = new Map<string, number>();
  input.legacyTop5.forEach((h, i) => legacyRankById.set(h.id, i + 1));
  const hybridRankById = new Map<string, number>();
  input.hybridTop5.forEach((h, i) => hybridRankById.set(h.id, i + 1));
  const rankDelta = Array.from(allIds).map((id) => ({
    id,
    legacyRank: legacyRankById.get(id) ?? null,
    hybridRank: hybridRankById.get(id) ?? null,
  }));
  return {
    ts: now.toISOString(),
    query: input.query,
    legacyTop5: input.legacyTop5,
    hybridTop5: input.hybridTop5,
    overlap,
    rankDelta,
  };
}

export interface WriteOptions {
  /** Override the resolved log path. */
  path?: string;
  /** Hook invoked on write error. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

/**
 * Append one shadow event as JSONL. Best-effort: never throws.
 *
 * The parent directory is created on first write (mkdir -p). Subsequent
 * appends skip the mkdir.
 */
export async function appendShadowEvent(
  event: ShadowTelemetryEvent,
  options: WriteOptions = {},
): Promise<void> {
  const path = options.path ?? resolveShadowLogPath();
  const onError = options.onError ?? ((e) => console.warn("[ranker-shadow]", e));
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    onError(err);
  }
}
