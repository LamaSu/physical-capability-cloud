/**
 * Tests for the single-writer checkpoint-acceptance store (§8.5-3).
 *
 * Proves the store threads a chain via accept(), enforces every §8.4-A step 5
 * clause (incl. maxSignatures), keeps per-session state isolated, and — the
 * single-writer point — advances state on accept so a re-submission of the same
 * seq is rejected because the state already moved on.
 */

import { describe, it, expect } from "vitest";
import type { SequenceEntry } from "@pcc/verifier";
import {
  SessionSequenceStore,
  sessionSequenceStore,
} from "../services/session-sequence-store.js";

const MAX = 100;
const S = "session-A";

/** Build an entry with sane defaults. */
function entry(seq: number, prevHash: string | null, hash: string, maxSignatures = MAX): SequenceEntry {
  return { seq, prevHash, hash, maxSignatures };
}

describe("SessionSequenceStore — §8.5-3", () => {
  it("accepts a valid chain seq 1 -> 2 -> 3 via accept() (prevHash threaded internally)", () => {
    const store = new SessionSequenceStore();
    expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    expect(store.accept(S, entry(2, "h1", "h2"))).toEqual({ accepted: true });
    expect(store.accept(S, entry(3, "h2", "h3"))).toEqual({ accepted: true });
    expect(store.snapshot(S)).toEqual({ lastSeq: 3, lastHash: "h3", acceptedCount: 3 });
  });

  it("is single-writer: after accept(seq=1), a second accept(seq=1) is rejected (state advanced)", () => {
    const store = new SessionSequenceStore();
    expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    // State moved to lastSeq=1, so seq=1 is now a replay (needs seq=2 next).
    expect(store.accept(S, entry(1, null, "h1-again"))).toEqual({
      accepted: false,
      reason: "seq_gap_or_replay",
    });
    // Tip is unchanged by the rejected write.
    expect(store.snapshot(S)).toEqual({ lastSeq: 1, lastHash: "h1", acceptedCount: 1 });
  });

  it("rejects a gap (seq=1 then seq=3) as seq_gap_or_replay", () => {
    const store = new SessionSequenceStore();
    expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    expect(store.accept(S, entry(3, "h1", "h3"))).toEqual({
      accepted: false,
      reason: "seq_gap_or_replay",
    });
  });

  it("enforces maxSignatures: seq > maxSignatures is rejected as max_signatures_exceeded", () => {
    const store = new SessionSequenceStore();
    // maxSignatures=2: seq 1 and 2 accepted, seq 3 exceeds the ceiling.
    expect(store.accept(S, entry(1, null, "h1", 2))).toEqual({ accepted: true });
    expect(store.accept(S, entry(2, "h1", "h2", 2))).toEqual({ accepted: true });
    expect(store.accept(S, entry(3, "h2", "h3", 2))).toEqual({
      accepted: false,
      reason: "max_signatures_exceeded",
    });
  });

  it("rejects a broken chain (wrong prevHash) as chain_broken", () => {
    const store = new SessionSequenceStore();
    expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    expect(store.accept(S, entry(2, "WRONG", "h2"))).toEqual({
      accepted: false,
      reason: "chain_broken",
    });
  });

  it("rejects a replayed (already-accepted) hash as duplicate_hash", () => {
    const store = new SessionSequenceStore();
    expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    // seq/prevHash valid for the next slot, but the hash repeats an accepted one.
    expect(store.accept(S, entry(2, "h1", "h1"))).toEqual({
      accepted: false,
      reason: "duplicate_hash",
    });
  });

  describe("genesis via the store", () => {
    it("rejects seq=2 as the first submission and does NOT create session state", () => {
      const store = new SessionSequenceStore();
      expect(store.accept(S, entry(2, null, "h2"))).toEqual({
        accepted: false,
        reason: "seq_gap_or_replay",
      });
      expect(store.hasSession(S)).toBe(false);
      // A rejected first submission must not poison the session: seq=1 still works.
      expect(store.accept(S, entry(1, null, "h1"))).toEqual({ accepted: true });
    });

    it("rejects a first submission with a non-null prevHash as chain_broken", () => {
      const store = new SessionSequenceStore();
      expect(store.accept(S, entry(1, "not-null", "h1"))).toEqual({
        accepted: false,
        reason: "chain_broken",
      });
      expect(store.hasSession(S)).toBe(false);
    });
  });

  it("keeps per-session state isolated (two sessions each start at genesis)", () => {
    const store = new SessionSequenceStore();
    expect(store.accept("A", entry(1, null, "a1"))).toEqual({ accepted: true });
    expect(store.accept("B", entry(1, null, "b1"))).toEqual({ accepted: true });
    // Same hash under different sessions is fine — `seen` is per-session.
    expect(store.accept("A", entry(2, "a1", "shared"))).toEqual({ accepted: true });
    expect(store.accept("B", entry(2, "b1", "shared"))).toEqual({ accepted: true });
    expect(store.snapshot("A")).toEqual({ lastSeq: 2, lastHash: "shared", acceptedCount: 2 });
    expect(store.snapshot("B")).toEqual({ lastSeq: 2, lastHash: "shared", acceptedCount: 2 });
  });

  it("reset() and clear() drop accepted state", () => {
    const store = new SessionSequenceStore();
    store.accept("A", entry(1, null, "a1"));
    store.accept("B", entry(1, null, "b1"));
    store.reset("A");
    expect(store.hasSession("A")).toBe(false);
    expect(store.hasSession("B")).toBe(true);
    store.clear();
    expect(store.hasSession("B")).toBe(false);
    expect(store.snapshot("B")).toBeUndefined();
  });

  it("exports a shared module singleton", () => {
    expect(sessionSequenceStore).toBeInstanceOf(SessionSequenceStore);
  });
});
