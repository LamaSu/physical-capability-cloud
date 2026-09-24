/**
 * Tests for the pure sequence-acceptance predicate (§8.4-A step 5, §8.5-3).
 *
 * Proves `checkSequence` implements the four conjuncts exactly, with the reason
 * codes short-circuiting in spec order, and that `genesisSequenceState()` pins the
 * first accepted checkpoint to `seq === 1 ∧ prevHash === null`.
 *
 * `checkSequence` is pure (advances nothing), so a tiny local `advance` helper
 * threads a chain for the multi-checkpoint case — mirroring what the gateway store
 * does, but kept in test code so the module under test stays stateless.
 */

import { describe, it, expect } from "vitest";
import {
  checkSequence,
  genesisSequenceState,
  type SequenceEntry,
  type SequencePriorState,
} from "../sequence-acceptance.js";

/** Test-only: apply one accepted entry to a prior state, returning the next state. */
function advance(prior: SequencePriorState, entry: SequenceEntry): SequencePriorState {
  const seen = new Set(prior.seen);
  seen.add(entry.hash);
  return { lastSeq: entry.seq, lastHash: entry.hash, seen };
}

const MAX = 100;

describe("checkSequence — §8.4-A step 5", () => {
  describe("genesis", () => {
    it("accepts the first checkpoint (seq===1, prevHash===null)", () => {
      const genesis = genesisSequenceState();
      const entry: SequenceEntry = { seq: 1, prevHash: null, hash: "h1", maxSignatures: MAX };
      expect(checkSequence(entry, genesis)).toEqual({ accepted: true });
    });

    it("genesisSequenceState() is {lastSeq:0, lastHash:null, seen:∅} and fresh each call", () => {
      const a = genesisSequenceState();
      const b = genesisSequenceState();
      expect(a).toEqual({ lastSeq: 0, lastHash: null, seen: new Set() });
      expect(a.seen).not.toBe(b.seen); // distinct Set instances — no shared mutable state
    });

    it("rejects seq===0 as the first checkpoint (seq_gap_or_replay)", () => {
      const entry: SequenceEntry = { seq: 0, prevHash: null, hash: "h0", maxSignatures: MAX };
      expect(checkSequence(entry, genesisSequenceState())).toEqual({
        accepted: false,
        reason: "seq_gap_or_replay",
      });
    });

    it("rejects seq===2 as the first checkpoint (seq_gap_or_replay)", () => {
      const entry: SequenceEntry = { seq: 2, prevHash: null, hash: "h2", maxSignatures: MAX };
      expect(checkSequence(entry, genesisSequenceState())).toEqual({
        accepted: false,
        reason: "seq_gap_or_replay",
      });
    });

    it("rejects a first checkpoint with a non-null prevHash (chain_broken)", () => {
      const entry: SequenceEntry = { seq: 1, prevHash: "x", hash: "h1", maxSignatures: MAX };
      expect(checkSequence(entry, genesisSequenceState())).toEqual({
        accepted: false,
        reason: "chain_broken",
      });
    });
  });

  describe("valid chain", () => {
    it("accepts a threaded chain seq 1 -> 2 -> 3 (prevHash threaded)", () => {
      let state: SequencePriorState = genesisSequenceState();

      const c1: SequenceEntry = { seq: 1, prevHash: null, hash: "h1", maxSignatures: MAX };
      expect(checkSequence(c1, state)).toEqual({ accepted: true });
      state = advance(state, c1);

      const c2: SequenceEntry = { seq: 2, prevHash: "h1", hash: "h2", maxSignatures: MAX };
      expect(checkSequence(c2, state)).toEqual({ accepted: true });
      state = advance(state, c2);

      const c3: SequenceEntry = { seq: 3, prevHash: "h2", hash: "h3", maxSignatures: MAX };
      expect(checkSequence(c3, state)).toEqual({ accepted: true });
      state = advance(state, c3);

      expect(state.lastSeq).toBe(3);
      expect(state.lastHash).toBe("h3");
    });
  });

  describe("rejections", () => {
    // prior = one checkpoint accepted at seq 2.
    const prior: SequencePriorState = {
      lastSeq: 2,
      lastHash: "h2",
      seen: new Set(["h1", "h2"]),
    };

    it("rejects replay (seq === last) as seq_gap_or_replay", () => {
      const entry: SequenceEntry = { seq: 2, prevHash: "h2", hash: "h2b", maxSignatures: MAX };
      expect(checkSequence(entry, prior)).toEqual({
        accepted: false,
        reason: "seq_gap_or_replay",
      });
    });

    it("rejects a gap (seq === last + 2) as seq_gap_or_replay", () => {
      const entry: SequenceEntry = { seq: 4, prevHash: "h2", hash: "h4", maxSignatures: MAX };
      expect(checkSequence(entry, prior)).toEqual({
        accepted: false,
        reason: "seq_gap_or_replay",
      });
    });

    it("rejects prevHash !== lastHash as chain_broken", () => {
      const entry: SequenceEntry = { seq: 3, prevHash: "WRONG", hash: "h3", maxSignatures: MAX };
      expect(checkSequence(entry, prior)).toEqual({
        accepted: false,
        reason: "chain_broken",
      });
    });

    it("rejects a replayed (already-seen) hash at a fresh seq as duplicate_hash", () => {
      // seq/maxSig/prevHash all valid; only the hash is a replay of an accepted one.
      const entry: SequenceEntry = { seq: 3, prevHash: "h2", hash: "h1", maxSignatures: MAX };
      expect(checkSequence(entry, prior)).toEqual({
        accepted: false,
        reason: "duplicate_hash",
      });
    });
  });

  describe("maxSignatures enforcement (the §8.5-3 primitive)", () => {
    it("accepts seq exactly equal to maxSignatures (the ceiling is inclusive)", () => {
      const prior: SequencePriorState = { lastSeq: 2, lastHash: "h2", seen: new Set(["h1", "h2"]) };
      const entry: SequenceEntry = { seq: 3, prevHash: "h2", hash: "h3", maxSignatures: 3 };
      expect(checkSequence(entry, prior)).toEqual({ accepted: true });
    });

    it("rejects seq > maxSignatures as max_signatures_exceeded", () => {
      // seq is strictly next (3+1), so the seq clause passes; the ceiling is what bites.
      const prior: SequencePriorState = {
        lastSeq: 3,
        lastHash: "h3",
        seen: new Set(["h1", "h2", "h3"]),
      };
      const entry: SequenceEntry = { seq: 4, prevHash: "h3", hash: "h4", maxSignatures: 3 };
      expect(checkSequence(entry, prior)).toEqual({
        accepted: false,
        reason: "max_signatures_exceeded",
      });
    });
  });
});
