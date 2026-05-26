/**
 * Tagged-Fraction CRDT — per-replica (numerator, denominator) counters
 * combined into a single weighted-average reading.
 *
 * The scope doc (§7.3) calls this a "Tagged-numerator-denominator CRDT"
 * for `successRate` (success_count / total_count) and `meanLatencyMs`
 * (latency_sum_ms / count). Storing the pair per replica preserves the
 * weights so cross-replica merges yield the correct overall ratio:
 *
 *     overall = SUM(numerators across replicas) / SUM(denominators)
 *
 * Implementation: two G-Counter-like structures per replica id, both
 * monotonic. Merge takes per-replica MAX on both, because both numerator
 * and denominator only grow.
 *
 * For `successRate`:   record(replica, success ? 1 : 0, 1)
 * For `meanLatencyMs`: record(replica, latencyMs, 1)
 *
 * Properties match the G-Counter (commutative / associative / idempotent
 * merge, monotonic value), with the added rule that `numerator <=
 * denominator` is preserved per replica because we only ever increment
 * one or both together.
 */

import type { ReplicaId } from "./g-counter.js";

export interface TaggedFractionSlot {
  numerator: number;
  denominator: number;
}

export interface TaggedFractionState {
  /** Per-replica (numerator, denominator) pair. Both grow-only. */
  slots: Record<ReplicaId, TaggedFractionSlot>;
}

export interface FractionValue {
  /** Sum of all replica numerators. */
  numerator: number;
  /** Sum of all replica denominators. */
  denominator: number;
  /**
   * numerator / denominator if denominator > 0, else null. Callers
   * should treat null as "no data yet" — typically falling back to a
   * default in the API response.
   */
  ratio: number | null;
}

export function createTaggedFraction(): TaggedFractionState {
  return { slots: {} };
}

/**
 * Record an observation on the local replica. `numerator` is added to
 * the numerator slot; `denominator` (default 1) is added to the
 * denominator slot.
 *
 * For `successRate` per call: `record(replica, success ? 1 : 0, 1)`
 * For `meanLatencyMs` per call: `record(replica, latencyMs, 1)`
 */
export function taggedFractionRecord(
  state: TaggedFractionState,
  replica: ReplicaId,
  numerator: number,
  denominator = 1,
): TaggedFractionState {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator < 0
  ) {
    throw new Error(
      `Tagged-Fraction observation must be non-negative finite numbers, got ${numerator}/${denominator}`,
    );
  }
  if (numerator === 0 && denominator === 0) return state;
  const current = state.slots[replica] ?? { numerator: 0, denominator: 0 };
  return {
    slots: {
      ...state.slots,
      [replica]: {
        numerator: current.numerator + numerator,
        denominator: current.denominator + denominator,
      },
    },
  };
}

/**
 * Merge two states by taking the per-replica MAX of both numerator and
 * denominator independently. Safe because both fields are monotonic.
 *
 * Edge: if replica A has (n=5, d=10) and replica A is also in B with
 * (n=3, d=12), merge yields (n=5, d=12). The "looks weird" case is rare
 * (it means the two views of replica A's slot disagree about which side
 * grew); in practice both sides grow together per `record()`.
 */
export function taggedFractionMerge(
  a: TaggedFractionState,
  b: TaggedFractionState,
): TaggedFractionState {
  const out: Record<ReplicaId, TaggedFractionSlot> = {};
  for (const [r, slot] of Object.entries(a.slots)) {
    out[r] = { ...slot };
  }
  for (const [r, slot] of Object.entries(b.slots)) {
    const existing = out[r];
    if (!existing) {
      out[r] = { ...slot };
    } else {
      out[r] = {
        numerator: Math.max(existing.numerator, slot.numerator),
        denominator: Math.max(existing.denominator, slot.denominator),
      };
    }
  }
  return { slots: out };
}

export function taggedFractionMergeAll(
  states: TaggedFractionState[],
): TaggedFractionState {
  let acc = createTaggedFraction();
  for (const s of states) acc = taggedFractionMerge(acc, s);
  return acc;
}

/**
 * Compute the externally-visible ratio: SUM numerators / SUM denominators
 * across replicas, plus the underlying sums for callers that need them.
 */
export function taggedFractionValue(
  state: TaggedFractionState,
): FractionValue {
  let n = 0;
  let d = 0;
  for (const slot of Object.values(state.slots)) {
    n += slot.numerator;
    d += slot.denominator;
  }
  return {
    numerator: n,
    denominator: d,
    ratio: d > 0 ? n / d : null,
  };
}

export function taggedFractionEquals(
  a: TaggedFractionState,
  b: TaggedFractionState,
): boolean {
  const aKeys = Object.keys(a.slots);
  const bKeys = Object.keys(b.slots);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const sa = a.slots[k];
    const sb = b.slots[k];
    if (!sa || !sb) return false;
    if (sa.numerator !== sb.numerator) return false;
    if (sa.denominator !== sb.denominator) return false;
  }
  return true;
}
