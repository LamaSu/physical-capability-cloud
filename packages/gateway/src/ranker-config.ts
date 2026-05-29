/**
 * Ranker mode configuration shared by the tool-search and aggregator-search
 * gateway routes.
 *
 * PCC_RANKER_MODE:
 *   - "legacy"  (default) — preserve current naive cosine / substring behavior.
 *   - "shadow"            — run BOTH legacy + hybrid in parallel; serve
 *                           legacy results but write the hybrid output to
 *                           the shadow telemetry log for A/B analysis.
 *   - "hybrid"            — serve hybrid results directly.
 *
 * Default is `legacy` so production stays bit-for-bit identical until an
 * operator opts in via env var. Shadow mode is the recommended rollout
 * step — collect 7 days of telemetry, hand-review the overlap@5, then
 * flip to `hybrid`.
 */

export type RankerMode = "legacy" | "shadow" | "hybrid";

const VALID_MODES = new Set<RankerMode>(["legacy", "shadow", "hybrid"]);

/** Parse PCC_RANKER_MODE from env, defaulting to `legacy`. */
export function readRankerMode(env: NodeJS.ProcessEnv = process.env): RankerMode {
  const raw = (env.PCC_RANKER_MODE ?? "").toLowerCase().trim();
  if (VALID_MODES.has(raw as RankerMode)) return raw as RankerMode;
  return "legacy";
}

/** Quick lookup: is the hybrid ranker running at all (shadow or hybrid mode)? */
export function isHybridActive(mode: RankerMode): boolean {
  return mode === "hybrid" || mode === "shadow";
}

/** Quick lookup: does the served response come from the hybrid ranker? */
export function isHybridServed(mode: RankerMode): boolean {
  return mode === "hybrid";
}
