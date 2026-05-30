/**
 * Built-in weight presets for the HybridRanker phase-2 scorer.
 *
 * See ai/scoping/vespa-hybrid-ranking-2026-05-23.md §4.4. Callers select
 * a preset via `RankerQuery.profile`; per-call overrides flow through
 * `RankerQuery.weights` (merged on top of the preset defaults).
 *
 * Adding a new preset:
 *   1. Add the preset name to RankerProfile in types.ts.
 *   2. Add the weights here.
 *   3. (Optional) document the use case in §4.4 of the scope doc.
 */

import type { RankerProfile, RankWeights } from "./types.js";

/**
 * `agent-default` — recommended starting profile.
 *
 * Rationale: trust + receipts dominate ("a VERIFIED_PARTNER with 10K
 * successful DCC3 invocations should beat a never-invoked AUTO_INDEXED
 * tool of equal raw relevance"). Relevance is the tiebreaker, not the
 * dominator.
 */
export const PRESET_AGENT_DEFAULT: RankWeights = {
  relevance: 1.0,
  trust: 2.0,
  provenance: 2.5,
  reputation: 1.0,
  freshness: 0.8,
  price: 0.5,
  geo: 1.5,
};

/**
 * `compliance-strict` — regulated callers (medical / pharma / aerospace).
 *
 * Trust + provenance weighted higher, external reputation de-emphasized
 * (Glama / Smithery scorecards aren't PCC-attested and shouldn't drive
 * compliance decisions). Freshness matters more because audit reviews
 * stale tools harshly.
 *
 * Recommended companion: also set `filter.requestedDccClass ≥ DCC3`.
 */
export const PRESET_COMPLIANCE_STRICT: RankWeights = {
  relevance: 1.0,
  trust: 4.0,
  provenance: 3.0,
  reputation: 0.5,
  freshness: 1.5,
  price: 0.2,
  geo: 1.0,
};

/**
 * `discovery-explore` — casual browse ("show me what's out there").
 *
 * Relevance dominates so semantically-close tools surface even if
 * trust/provenance is weak. Geo + price off by default (most "what's
 * out there" queries don't supply hints).
 */
export const PRESET_DISCOVERY_EXPLORE: RankWeights = {
  relevance: 2.0,
  trust: 1.0,
  provenance: 1.0,
  reputation: 1.5,
  freshness: 0.5,
  price: 0.0,
  geo: 0.0,
};

const PRESETS: Record<RankerProfile, RankWeights> = {
  "agent-default": PRESET_AGENT_DEFAULT,
  "compliance-strict": PRESET_COMPLIANCE_STRICT,
  "discovery-explore": PRESET_DISCOVERY_EXPLORE,
};

/**
 * Resolve the effective weights for one query: load the preset, then
 * shallow-merge the per-call overrides on top. Returns a fresh object
 * — callers may mutate without affecting the preset.
 */
export function resolveWeights(
  profile: RankerProfile = "agent-default",
  overrides: Partial<RankWeights> = {},
): RankWeights {
  const base = PRESETS[profile] ?? PRESET_AGENT_DEFAULT;
  return { ...base, ...overrides };
}

/** Inspect the registered preset names (for /api/tools/status etc.). */
export function presetNames(): RankerProfile[] {
  return Object.keys(PRESETS) as RankerProfile[];
}
