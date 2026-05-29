/**
 * G-Counter — Grow-only counter CRDT.
 *
 * Maps replica-id → non-negative integer count. Increment only adds to
 * the local replica's slot; merge takes the per-replica MAX (since each
 * replica's count is monotonic, MAX is correct).
 *
 * Used for `IndexedTool.invocationCount` per scope doc §7.3:
 *   "G-Counter (grow-only counter) per (region, mesh) → SUM on read.
 *    New invocations only ADD to the local counter; no decrement."
 *
 * The replica-id is intended to be `region` or `(region, mesh)` —
 * stable across restarts. New invocations increment the local replica
 * only; merging two G-Counters from different replicas gives the union
 * of per-replica counts, summed for the externally-visible value.
 *
 * Properties:
 *   - Commutative: merge(a, b) === merge(b, a)
 *   - Associative: merge(merge(a, b), c) === merge(a, merge(b, c))
 *   - Idempotent: merge(a, a) === a
 *   - Increment-only: value() never decreases under merge() or increment()
 *
 * Auditable in-house impl (~60 LOC) rather than a dependency on Yjs /
 * Automerge — see scope §14 Q1 for the recommendation.
 */

export type ReplicaId = string;

/**
 * Serialisable G-Counter state. Round-trips through JSON cleanly, so it
 * can ride in CRDT delta messages without custom codecs.
 */
export interface GCounterState {
  /** Per-replica slot. All values must be non-negative integers. */
  slots: Record<ReplicaId, number>;
}

/**
 * Build a fresh G-Counter with no slots populated.
 */
export function createGCounter(): GCounterState {
  return { slots: {} };
}

/**
 * Get the externally-visible value (sum across all replica slots).
 */
export function gCounterValue(state: GCounterState): number {
  let sum = 0;
  for (const v of Object.values(state.slots)) sum += v;
  return sum;
}

/**
 * Increment the local replica's slot. Returns a new state object — the
 * input is not mutated, so callers can pass shared state safely.
 *
 * @param state - current G-Counter state
 * @param replica - this node's replica id (e.g. "us-east-1-mesh-a")
 * @param delta - non-negative integer to add (default 1)
 */
export function gCounterIncrement(
  state: GCounterState,
  replica: ReplicaId,
  delta = 1,
): GCounterState {
  if (!Number.isInteger(delta) || delta < 0) {
    throw new Error(
      `G-Counter increment delta must be a non-negative integer, got ${delta}`,
    );
  }
  if (delta === 0) return state;
  const current = state.slots[replica] ?? 0;
  return {
    slots: { ...state.slots, [replica]: current + delta },
  };
}

/**
 * Merge two G-Counters by taking the per-replica MAX. Commutative,
 * associative, idempotent.
 */
export function gCounterMerge(
  a: GCounterState,
  b: GCounterState,
): GCounterState {
  const out: Record<ReplicaId, number> = { ...a.slots };
  for (const [replica, count] of Object.entries(b.slots)) {
    const existing = out[replica] ?? 0;
    if (count > existing) out[replica] = count;
  }
  return { slots: out };
}

/**
 * Merge an arbitrary number of G-Counters in one pass. Convenience over
 * `reduce(gCounterMerge, createGCounter())`.
 */
export function gCounterMergeAll(states: GCounterState[]): GCounterState {
  let acc = createGCounter();
  for (const s of states) acc = gCounterMerge(acc, s);
  return acc;
}

/**
 * Equality check for tests. Two G-Counters are equal iff they have the
 * same per-replica slot values.
 */
export function gCounterEquals(
  a: GCounterState,
  b: GCounterState,
): boolean {
  const aKeys = Object.keys(a.slots);
  const bKeys = Object.keys(b.slots);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a.slots[k] !== b.slots[k]) return false;
  }
  return true;
}
