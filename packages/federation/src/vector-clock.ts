/**
 * VectorClock — Lamport vector clock for cross-region merges.
 *
 * Per scope §11.1. A vector clock is `region-id → tick` ticks plus the
 * compare/merge operations from classical CRDT theory.
 *
 * Phase 1 uses vector clocks for:
 *   - IndexedTool merge ordering (tracking which region last edited a
 *     given field)
 *   - Namespace ACL change ordering
 *
 * Phase 2 will also use them for cross-region search result freshness
 * indicators.
 */

import type { RegionId } from "./region/types.js";

export interface VectorClock {
  /** region-id → logical clock tick */
  ticks: Record<RegionId, number>;
}

export function createVectorClock(): VectorClock {
  return { ticks: {} };
}

/**
 * Tick the local region's slot, returning a new clock. If
 * `observedFloor` is supplied, the new tick dominates that value too.
 */
export function vectorClockTick(
  clock: VectorClock,
  region: RegionId,
  observedFloor?: number,
): VectorClock {
  const current = clock.ticks[region] ?? 0;
  const floor =
    observedFloor !== undefined ? Math.max(observedFloor, current) : current;
  return {
    ticks: { ...clock.ticks, [region]: floor + 1 },
  };
}

/**
 * Merge two clocks by taking the per-region MAX.
 */
export function vectorClockMerge(
  a: VectorClock,
  b: VectorClock,
): VectorClock {
  const out: Record<RegionId, number> = { ...a.ticks };
  for (const [region, tick] of Object.entries(b.ticks)) {
    const existing = out[region] ?? 0;
    if (tick > existing) out[region] = tick;
  }
  return { ticks: out };
}

/**
 * Comparison verdict between two vector clocks.
 *
 * - "equal": same ticks
 * - "before": a dominates b in no slot and lags in at least one
 * - "after": a dominates b in at least one slot and lags in none
 * - "concurrent": neither dominates — a real conflict that LWW
 *   tiebreaker resolves on top of the VC
 */
export type VectorClockOrder = "equal" | "before" | "after" | "concurrent";

export function compareVectorClocks(
  a: VectorClock,
  b: VectorClock,
): VectorClockOrder {
  const allRegions = new Set([
    ...Object.keys(a.ticks),
    ...Object.keys(b.ticks),
  ]);
  let aGreater = false;
  let bGreater = false;
  for (const r of allRegions) {
    const av = a.ticks[r] ?? 0;
    const bv = b.ticks[r] ?? 0;
    if (av > bv) aGreater = true;
    if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return "concurrent";
  if (aGreater) return "after";
  if (bGreater) return "before";
  return "equal";
}

/**
 * True iff `a` happens-before `b` (or equals it). Useful when deciding
 * whether to apply a CRDT delta or skip it as already-applied.
 */
export function vectorClockHappensBeforeOrEquals(
  a: VectorClock,
  b: VectorClock,
): boolean {
  const order = compareVectorClocks(a, b);
  return order === "before" || order === "equal";
}
