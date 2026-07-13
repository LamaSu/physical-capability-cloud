/**
 * Shared in-memory per-session checkpoint-acceptance store (§8.5-3).
 *
 * Holds the accepted-chain state `{lastSeq, lastHash, seen}` for each ephemeral
 * session and is the single point that ACCEPTS or REJECTS an incoming checkpoint
 * against §8.4-A step 5. It delegates the predicate to the verifier's pure
 * `checkSequence` and owns the one thing a pure function cannot: advancing state.
 *
 * WHY A STORE (single-writer): §8.3's TRANSACTIONAL INVARIANT requires acceptance
 * to be "serialized per session (single owner / strongly-consistent store)". A
 * checkpoint's validity depends on the LAST accepted checkpoint, so two concurrent
 * acceptances of `seq === lastSeq + 1` must never both succeed. `accept()` is a
 * SYNCHRONOUS critical section — it reads state, calls `checkSequence`, and (only
 * on accept) advances state with NO `await` anywhere between the read and the
 * write. In a single Node process the event loop cannot interleave another
 * `accept()` inside that synchronous span, so "last writer" is unambiguous and the
 * strict `seq === lastSeq + 1` rule is what serializes the chain. This is the
 * single-writer guarantee, expressed as "no await in the critical section".
 *
 * This ALSO enforces `maxSignatures`, which the current
 * `verifySessionSignedEvent` never checks: `checkSequence` rejects any
 * `seq > entry.maxSignatures`.
 *
 * ADDITIVE + NON-BREAKING: not wired into `paid-job-flow.ts` /
 * `device-evidence-settlement.ts` — the checkpoint-submission endpoint that will
 * call `accept()` inside the §8.3 verify→persist→receipt transaction is step 6.
 * This step delivers the mechanism, unit-proven.
 *
 * KNOWN LIMITATION (Gate-5; spec §8.6): in-memory and single-process. A gateway
 * restart clears accepted state, and a second instance would not share it — so the
 * single-writer guarantee holds only WITHIN one process. Durable / multi-instance
 * acceptance (a DB-backed, strongly-consistent store, or coupling acceptance to
 * the durable transactional receipt of §8.3) is the owner-gated later concern and
 * is intentionally NOT added here. Mirrors `session-revocation-store.ts` (step 2).
 */

import {
  checkSequence,
  genesisSequenceState,
  type SequenceEntry,
  type SequencePriorState,
  type SequenceRejectReason,
} from "@pcc/verifier";

/** Result of {@link SessionSequenceStore.accept}. `reason` is present iff rejected. */
export interface SequenceAcceptResult {
  accepted: boolean;
  reason?: SequenceRejectReason;
}

/** A read-only snapshot of a session's accepted-chain tip (observability / later paths). */
export interface AcceptedSequenceSnapshot {
  lastSeq: number;
  lastHash: string | null;
  acceptedCount: number;
}

/** Internal mutable per-session state. `seen` is a mutable Set the store advances. */
interface AcceptedSessionState {
  lastSeq: number;
  lastHash: string | null;
  seen: Set<string>;
}

export class SessionSequenceStore {
  private readonly stateBySession = new Map<string, AcceptedSessionState>();

  /**
   * Accept or reject a checkpoint for a session against §8.4-A step 5.
   *
   * SINGLE-WRITER CRITICAL SECTION: read → check → advance, entirely synchronous
   * (no `await`). On accept, state advances (`lastSeq`/`lastHash`/`seen`) and the
   * result is `{accepted: true}`. On reject, state is UNCHANGED and never created —
   * an out-of-order or invalid submission cannot poison a session (a subsequent
   * correct `seq === 1` still starts cleanly from genesis).
   */
  accept(sessionId: string, entry: SequenceEntry): SequenceAcceptResult {
    // Read: existing state, or a fresh genesis (NOT yet stored) for a new session.
    const state = this.stateBySession.get(sessionId) ?? genesisSequenceState();

    // Check: the pure predicate. `state` (mutable Set) is assignable to the
    // ReadonlySet the predicate reads.
    const result = checkSequence(entry, state);
    if (!result.accepted) {
      return { accepted: false, reason: result.reason };
    }

    // Advance atomically (still synchronous). `state` is either the stored object
    // or the fresh genesis; either way it is ours to mutate, and we (re)store it.
    state.lastSeq = entry.seq;
    state.lastHash = entry.hash;
    state.seen.add(entry.hash);
    this.stateBySession.set(sessionId, state);
    return { accepted: true };
  }

  /** True iff at least one checkpoint has been accepted for this session. */
  hasSession(sessionId: string): boolean {
    return this.stateBySession.has(sessionId);
  }

  /**
   * Peek a session's prior accepted-chain state (incl. `seen`) WITHOUT creating
   * or mutating it — the READ half of the transactional-receipt critical section
   * in `gateway-receipt-store.ts`. That path must call the pure `checkSequence`
   * ITSELF (before persisting) and then advance via {@link accept} ONLY after
   * the DB commit; it needs `seen`, which {@link snapshot} deliberately does not
   * expose. Returns a FRESH genesis view for an unknown session and never stores
   * it. Typed as the read-only {@link SequencePriorState} so callers cannot
   * mutate the store's internal state through it.
   */
  priorState(sessionId: string): SequencePriorState {
    return this.stateBySession.get(sessionId) ?? genesisSequenceState();
  }

  /**
   * The accepted-chain tip for a session, or `undefined` if nothing accepted yet.
   * A read shape the settlement / final-package paths (step 6) will consume.
   */
  snapshot(sessionId: string): AcceptedSequenceSnapshot | undefined {
    const state = this.stateBySession.get(sessionId);
    if (!state) return undefined;
    return {
      lastSeq: state.lastSeq,
      lastHash: state.lastHash,
      acceptedCount: state.seen.size,
    };
  }

  /** Drop a single session's accepted state (test/util). */
  reset(sessionId: string): void {
    this.stateBySession.delete(sessionId);
  }

  /** Clear all accepted state (test/util). */
  clear(): void {
    this.stateBySession.clear();
  }
}

/**
 * The process-wide shared acceptance store. The checkpoint-submission path (step 6)
 * will call `accept()` on this single instance inside its §8.3 transaction.
 */
export const sessionSequenceStore = new SessionSequenceStore();
