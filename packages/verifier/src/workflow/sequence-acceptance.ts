/**
 * Sequence-bound checkpoint acceptance — the pure logic of §8.4-A step 5
 * (frozen protocol v3, §8.5-3 "Sequence-bound signing").
 *
 * This is the mechanism that finally ENFORCES `maxSignatures`. The current
 * `SessionKeyService.verifySessionSignedEvent` (ephemeral-identity.ts) does five
 * checks — session sig, parent sig, expiry, scope, revocation — but has NO
 * sequence concept and never consults `maxSignatures` (it is serialized into the
 * SessionKey scope and then ignored). §8.4-A step 5 requires a checkpoint to
 * "follow the unique accepted chain":
 *
 *     seq === lastAcceptedSeq + 1
 *   ∧ seq <= maxSignatures
 *   ∧ prevCheckpointHash === lastAcceptedHash
 *   ∧ hash never previously accepted
 *
 * This module implements exactly that predicate as a PURE function: it reads a
 * prior accepted-chain state and an incoming entry and returns accept/reject with
 * a reason code. It advances NOTHING — statefulness (the per-session single-writer
 * store) lives in the gateway (`services/session-sequence-store.ts`), keeping this
 * logic trivially testable and reusable by any consumer that already holds state.
 *
 * ADDITIVE + NON-BREAKING: nothing here touches `SessionSignedEvent` / `SessionKey`
 * shapes or `verifySessionSignedEvent` behavior. Wiring into the live settlement /
 * checkpoint-submission path is step 6, not here.
 */

/** One checkpoint's sequence-relevant fields (a projection of the §8.3 Checkpoint). */
export interface SequenceEntry {
  /** Strictly serial per session; the first accepted checkpoint is `seq === 1`. */
  seq: number;
  /**
   * Hash of the previous checkpoint in this session's chain, or `null` for the
   * genesis (first) checkpoint. Must equal the last accepted hash.
   */
  prevHash: string | null;
  /** This checkpoint's own hash. Must never have been accepted before. */
  hash: string;
  /**
   * The session's `SessionScope.maxSignatures` ceiling. `seq` may never exceed it
   * — this is the compromise-blast-radius bound the spec calls out (edge #2).
   */
  maxSignatures: number;
}

/**
 * The prior accepted-chain state for a session. `seen` is the set of every hash
 * accepted so far. Read-only here — advancement is the store's job.
 */
export interface SequencePriorState {
  /** Highest accepted seq; `0` at genesis (nothing accepted yet). */
  lastSeq: number;
  /** Last accepted checkpoint hash; `null` at genesis. */
  lastHash: string | null;
  /** Every hash accepted so far (duplicate-rejection set). */
  seen: ReadonlySet<string>;
}

/** The reason a checkpoint was rejected. Stable string codes, one per predicate clause. */
export type SequenceRejectReason =
  | "seq_gap_or_replay"
  | "max_signatures_exceeded"
  | "chain_broken"
  | "duplicate_hash";

/** Result of {@link checkSequence}. `reason` is present iff `accepted === false`. */
export interface SequenceCheckResult {
  accepted: boolean;
  reason?: SequenceRejectReason;
}

/**
 * The explicit genesis state for a session with nothing accepted yet:
 * `{ lastSeq: 0, lastHash: null, seen: ∅ }`.
 *
 * Consequence (documented on purpose): the FIRST checkpoint that can be accepted
 * therefore has `seq === 1` (because `1 === 0 + 1`) and `prevHash === null`
 * (because it must equal `lastHash`, which is `null` at genesis). A first
 * submission with `seq === 0`/`seq === 2` fails the seq clause; a first submission
 * with a non-null `prevHash` fails the chain clause.
 *
 * Returns a FRESH object (with a fresh, mutable `Set`) on every call so callers
 * that advance it never share or mutate a common instance.
 */
export function genesisSequenceState(): {
  lastSeq: number;
  lastHash: string | null;
  seen: Set<string>;
} {
  return { lastSeq: 0, lastHash: null, seen: new Set<string>() };
}

/**
 * Pure acceptance predicate for one checkpoint against a session's prior state.
 * Implements §8.4-A step 5 exactly, short-circuiting in the spec's conjunction
 * order so the returned `reason` is deterministic:
 *
 *   1. `seq === lastSeq + 1`      else `seq_gap_or_replay`   (rejects replay AND gaps)
 *   2. `seq <= maxSignatures`     else `max_signatures_exceeded`
 *   3. `prevHash === lastHash`    else `chain_broken`
 *   4. `!seen.has(hash)`          else `duplicate_hash`
 *
 * Advances no state; the caller owns advancement on `accepted === true`.
 */
export function checkSequence(
  entry: SequenceEntry,
  priorState: SequencePriorState,
): SequenceCheckResult {
  // 1. Strict serial ordering. `seq !== lastSeq + 1` catches both a replay
  //    (seq === lastSeq) and any gap (seq > lastSeq + 1, or seq < lastSeq + 1).
  if (entry.seq !== priorState.lastSeq + 1) {
    return { accepted: false, reason: "seq_gap_or_replay" };
  }

  // 2. maxSignatures ceiling — THIS is the enforcement §8.4-A step 5 calls out.
  //    Since seq is strictly serial (clause 1), `seq > maxSignatures` means the
  //    session has already signed its maximum allowed number of checkpoints.
  if (entry.seq > entry.maxSignatures) {
    return { accepted: false, reason: "max_signatures_exceeded" };
  }

  // 3. Chain continuity. At genesis lastHash === null, so the first checkpoint
  //    must carry prevHash === null; thereafter it must equal the last hash.
  if (entry.prevHash !== priorState.lastHash) {
    return { accepted: false, reason: "chain_broken" };
  }

  // 4. No hash may be accepted twice (replay of a previously-accepted payload,
  //    even if it were somehow presented at a fresh seq).
  if (priorState.seen.has(entry.hash)) {
    return { accepted: false, reason: "duplicate_hash" };
  }

  return { accepted: true };
}
