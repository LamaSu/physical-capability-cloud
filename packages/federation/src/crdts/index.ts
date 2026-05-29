/**
 * CRDT primitives for the federation runtime.
 *
 * Pure-TS, dependency-free implementations of:
 *   - G-Counter (grow-only, used for invocationCount)
 *   - Tagged-Fraction (weighted ratios, used for successRate + meanLatencyMs)
 *   - LWW-Register (last-writer-wins with Lamport timestamps, used for
 *     trust-tier promotions, pricing, namespace metadata)
 *
 * Per scope §14 Q1: built rather than bought (Yjs / Automerge) because
 * the shapes we need are well-understood and a tightly-typed in-house
 * impl is ~600 LOC vs the dep weight and shape-mismatch cost of
 * generic CRDT libraries.
 */

// G-Counter
export {
  createGCounter,
  gCounterIncrement,
  gCounterMerge,
  gCounterMergeAll,
  gCounterValue,
  gCounterEquals,
  type GCounterState,
  type ReplicaId,
} from "./g-counter.js";

// Tagged-Fraction
export {
  createTaggedFraction,
  taggedFractionRecord,
  taggedFractionMerge,
  taggedFractionMergeAll,
  taggedFractionValue,
  taggedFractionEquals,
  type TaggedFractionState,
  type TaggedFractionSlot,
  type FractionValue,
} from "./tagged-fraction.js";

// LWW-Register
export {
  createLWWRegister,
  lwwRegisterWrite,
  lwwRegisterMerge,
  lwwRegisterMergeAll,
  lwwRegisterKillWrite,
  compareTimestamps,
  isKillStamped,
  type LWWRegisterState,
  type LWWTimestamp,
} from "./lww-register.js";
