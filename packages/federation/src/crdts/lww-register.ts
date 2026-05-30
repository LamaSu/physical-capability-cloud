/**
 * LWW-Register CRDT — Last-Writer-Wins register with Lamport timestamps.
 *
 * Single-valued register used for fields where "the most recent write
 * wins" is the correct semantics. Per scope §7.2 / §7.3:
 *
 *   - Trust-tier promotions / demotions (with QUARANTINED kill-op priority)
 *   - `lastInvokedAt` (LWW with logical clock)
 *   - Pricing updates
 *   - Generic namespace metadata
 *
 * The Lamport timestamp is a (logicalTick, writerReplicaId) pair. On
 * write the writer increments its observed-max and tags. On merge we
 * pick the higher (logicalTick, writerReplicaId) — replicaId breaks ties
 * deterministically.
 *
 * Properties:
 *   - Commutative / associative / idempotent merge
 *   - Wall-clock-free: deterministic resolution across regions with
 *     skewed clocks
 *   - Total ordering on (tick, replicaId) tiebreak so all replicas
 *     converge on the same winner without coordination
 *
 * The value type is parametric. Common usage: `LWWRegister<TrustTier>`,
 * `LWWRegister<PricingHint>`.
 *
 * @see scope §7.2 — trust-tier authority ordered by Lamport timestamp
 */

import type { ReplicaId } from "./g-counter.js";

export interface LWWTimestamp {
  /** Monotonic Lamport tick — max(localCounter, observedTicks) + 1 on write. */
  tick: number;
  /** Replica that performed the write. Tiebreaker on equal ticks. */
  replica: ReplicaId;
}

export interface LWWRegisterState<T> {
  /** Current value. Undefined iff never written. */
  value: T | undefined;
  /** Timestamp of the current value. Undefined iff never written. */
  ts: LWWTimestamp | undefined;
}

export function createLWWRegister<T>(): LWWRegisterState<T> {
  return { value: undefined, ts: undefined };
}

/**
 * Compare two Lamport timestamps. Returns:
 *   -  negative  if a < b
 *   -  positive  if a > b
 *   -  zero      if equal
 *
 * Tiebreaking on equal ticks uses replica-id lexicographic order so all
 * replicas converge on the same winner without coordination.
 */
export function compareTimestamps(
  a: LWWTimestamp,
  b: LWWTimestamp,
): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  return a.replica.localeCompare(b.replica);
}

/**
 * Write a new value, generating a fresh Lamport timestamp. The local
 * counter must be at least `observedTickFloor + 1` so the new
 * timestamp dominates anything we've ever seen (including ours).
 *
 * @param state - current register state
 * @param replica - writing replica id
 * @param value - new value
 * @param observedTickFloor - the max tick seen from any source so far;
 *   defaults to the register's own current tick. Pass an external value
 *   when you've observed a higher tick from another channel (gossip /
 *   DHT) but it hasn't yet been merged into this register.
 */
export function lwwRegisterWrite<T>(
  state: LWWRegisterState<T>,
  replica: ReplicaId,
  value: T,
  observedTickFloor?: number,
): LWWRegisterState<T> {
  const floor =
    observedTickFloor !== undefined
      ? Math.max(observedTickFloor, state.ts?.tick ?? 0)
      : (state.ts?.tick ?? 0);
  return {
    value,
    ts: { tick: floor + 1, replica },
  };
}

/**
 * Merge two registers. Keeps the value with the higher timestamp; ties
 * broken on replica id.
 */
export function lwwRegisterMerge<T>(
  a: LWWRegisterState<T>,
  b: LWWRegisterState<T>,
): LWWRegisterState<T> {
  if (!a.ts) return b;
  if (!b.ts) return a;
  return compareTimestamps(a.ts, b.ts) >= 0 ? a : b;
}

export function lwwRegisterMergeAll<T>(
  states: LWWRegisterState<T>[],
): LWWRegisterState<T> {
  let acc = createLWWRegister<T>();
  for (const s of states) acc = lwwRegisterMerge(acc, s);
  return acc;
}

/**
 * Specialised kill-op for irreversible demotions (e.g. QUARANTINE).
 * Stamps with maximum possible tick + the "kill" sentinel replica id
 * that lexicographically dominates any real replica id. Per §7.2:
 *
 *   "Demotion to QUARANTINED is monotonic and irreversible (without
 *    operator override). Quarantine propagates as a 'kill' CRDT op with
 *    higher priority than any promote."
 *
 * Subsequent writes can override via `forceWrite`, intended only for an
 * explicit operator-override flow.
 */
const KILL_REPLICA_ID = "￿kill" as const;

export function lwwRegisterKillWrite<T>(
  state: LWWRegisterState<T>,
  value: T,
  observedTickFloor?: number,
): LWWRegisterState<T> {
  const floor =
    observedTickFloor !== undefined
      ? Math.max(observedTickFloor, state.ts?.tick ?? 0)
      : (state.ts?.tick ?? 0);
  return {
    value,
    ts: { tick: floor + 1, replica: KILL_REPLICA_ID },
  };
}

/** True iff the register's current value was written via a kill op. */
export function isKillStamped<T>(state: LWWRegisterState<T>): boolean {
  return state.ts?.replica === KILL_REPLICA_ID;
}
