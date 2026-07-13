/**
 * The §8.3 transactional-receipt invariant, proven end-to-end.
 *
 * receipt ⟺ durably-committed acceptance, serialized per session. Five cases:
 *   (a) accepted → exactly one persisted receipt; rejected → none + no advance
 *   (b) single-writer serialization: seq===last+1, maxSignatures, chain, replay
 *   (c) construct-from-persisted: returned receipt fields === persisted row
 *   (d) sign → verify round-trip (and tamper / wrong-key rejection)
 *   (e) crash-ordering: a throwing insert → errored, nothing persisted, NO advance
 *
 * Each test uses a fresh in-memory store, a fresh (non-singleton)
 * SessionSequenceStore, and a fresh ephemeral Ed25519 signer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  type Store,
  type IGatewayReceiptRepository,
} from "@pcc/store";
import { SessionSequenceStore } from "../services/session-sequence-store.js";
import { GatewayReceiptSigner } from "../services/gateway-receipt-signer.js";
import {
  GatewayReceiptStore,
  type CheckpointReceiptInput,
} from "../services/gateway-receipt-store.js";
import { generateEd25519Keypair } from "../auth/ed25519.js";

function makeSigner(keyId = "gw-rcpt-test"): GatewayReceiptSigner {
  const kp = generateEd25519Keypair();
  return new GatewayReceiptSigner({
    keyId,
    privateKeyHex: kp.privateKeyHex,
    publicKeyHex: kp.publicKeyHex,
  });
}

function input(
  overrides: Partial<CheckpointReceiptInput> = {},
): CheckpointReceiptInput {
  return {
    jobId: "job-1",
    sessionId: "sess-1",
    seq: 1,
    checkpointHash: "h1",
    prevCheckpointHash: null,
    maxSignatures: 100,
    effectiveEvidenceTime: 1_800_000_000,
    ...overrides,
  };
}

describe("GatewayReceiptStore (§8.3 transactional invariant)", () => {
  let store: Store;
  let sequenceStore: SessionSequenceStore;
  let signer: GatewayReceiptSigner;
  let svc: GatewayReceiptStore;

  beforeEach(() => {
    store = createStore({ seed: false });
    sequenceStore = new SessionSequenceStore();
    signer = makeSigner();
    svc = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      sequenceStore,
      signer,
    });
  });
  afterEach(() => store.close());

  // (a) --------------------------------------------------------------------
  it("accepted checkpoint persists exactly one receipt; a rejected one persists none and does not advance", () => {
    const r1 = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(r1.status).toBe("accepted");
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(1);
    expect(sequenceStore.snapshot("sess-1")).toEqual({
      lastSeq: 1,
      lastHash: "h1",
      acceptedCount: 1,
    });

    // Reject: a seq gap (3, not 2). Must NOT persist and must NOT advance.
    const gap = svc.record(input({ seq: 3, checkpointHash: "h3", prevCheckpointHash: "h1" }));
    expect(gap.status).toBe("rejected");
    if (gap.status === "rejected") expect(gap.reason).toBe("seq_gap_or_replay");

    // Store + in-memory tip unchanged — still the single seq-1 receipt.
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(1);
    expect(sequenceStore.snapshot("sess-1")).toEqual({
      lastSeq: 1,
      lastHash: "h1",
      acceptedCount: 1,
    });
  });

  // (b) --------------------------------------------------------------------
  it("serializes the chain (seq===last+1), enforces maxSignatures + continuity, and rejects a replayed seq", () => {
    expect(
      svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null, maxSignatures: 2 })).status,
    ).toBe("accepted");
    expect(
      svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1", maxSignatures: 2 })).status,
    ).toBe("accepted");

    // Double-accept the same seq (2) → reject (seq === lastSeq, not last+1).
    const replay = svc.record(input({ seq: 2, checkpointHash: "h2x", prevCheckpointHash: "h1", maxSignatures: 2 }));
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") expect(replay.reason).toBe("seq_gap_or_replay");

    // seq 3 exceeds maxSignatures=2 → reject.
    const overMax = svc.record(input({ seq: 3, checkpointHash: "h3", prevCheckpointHash: "h2", maxSignatures: 2 }));
    expect(overMax.status).toBe("rejected");
    if (overMax.status === "rejected") expect(overMax.reason).toBe("max_signatures_exceeded");

    // Chain continuity: correct seq but wrong prevHash (fresh session) → reject.
    expect(
      svc.record(input({ sessionId: "s2", seq: 1, checkpointHash: "a1", prevCheckpointHash: null, maxSignatures: 5 })).status,
    ).toBe("accepted");
    const broken = svc.record(input({ sessionId: "s2", seq: 2, checkpointHash: "a2", prevCheckpointHash: "WRONG", maxSignatures: 5 }));
    expect(broken.status).toBe("rejected");
    if (broken.status === "rejected") expect(broken.reason).toBe("chain_broken");

    // sess-1 has exactly its two accepted receipts; DB tip is seq 2.
    expect(store.repos.gatewayReceipts.findBySession("sess-1").map((r) => r.seq)).toEqual([1, 2]);
    expect(store.repos.gatewayReceipts.lastAcceptedForSession("sess-1")).toEqual({
      lastSeq: 2,
      lastHash: "h2",
      lastReceiptId: "grcpt-sess-1-2",
    });
  });

  // (c) --------------------------------------------------------------------
  it("constructs the returned receipt FROM the persisted row (every field matches the stored columns)", () => {
    const r = svc.record(
      input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null, effectiveEvidenceTime: 1_700_000_123 }),
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;

    const row = store.repos.gatewayReceipts.findById(r.receipt.receiptId);
    expect(row).toBeDefined();
    if (!row) return;

    // Returned receipt fields === persisted row columns.
    expect(r.receipt.receiptId).toBe(row.receiptId);
    expect(r.receipt.gatewayKeyId).toBe(row.gatewayKeyId);
    expect(r.receipt.jobId).toBe(row.jobId);
    expect(r.receipt.sessionId).toBe(row.sessionId);
    expect(r.receipt.seq).toBe(row.seq);
    expect(r.receipt.checkpointHash).toBe(row.checkpointHash);
    expect(r.receipt.previousAcceptedHash).toBe(row.previousAcceptedHash);
    expect(r.receipt.sessionStateVersion).toBe(row.sessionStateVersion);
    expect(r.receipt.acceptedAt).toBe(row.acceptedAt);
    expect(r.receipt.signature).toBe(row.signature);
    // The returned receipt IS the persisted body (round-trip).
    expect(r.receipt).toEqual(row.body);

    // Spec §8.3 field semantics.
    expect(r.receipt.acceptedAt).toBe(1_700_000_123); // == effectiveEvidenceTime
    expect(r.receipt.previousAcceptedHash).toBeNull(); // genesis
    expect(r.receipt.sessionStateVersion).toBe(1); // new lastAcceptedSeq
    expect(r.row.receiptId).toBe("grcpt-sess-1-1");
  });

  // (d) --------------------------------------------------------------------
  it("signs the receipt so it verifies against the gateway key; tampering and wrong key do not verify", () => {
    const r = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;

    const { signature, ...content } = r.receipt;
    expect(signer.verify(content, signature)).toBe(true);

    // Tamper the acceptedAt (the freshness point) → signature must not verify.
    expect(signer.verify({ ...content, acceptedAt: content.acceptedAt + 1 }, signature)).toBe(false);
    // Tamper the checkpointHash → must not verify.
    expect(signer.verify({ ...content, checkpointHash: "forged" }, signature)).toBe(false);
    // A different key must not verify a signature it did not produce.
    expect(makeSigner().verify(content, signature)).toBe(false);

    // gatewayKeyId identifies THIS signer's key.
    expect(r.receipt.gatewayKeyId).toBe(signer.keyId);
  });

  // (e) --------------------------------------------------------------------
  it("on a persist failure: returns errored, persists nothing, and does NOT advance the in-memory chain", () => {
    // A repo whose insert throws; the failure under test is the persist. record()'s
    // step-0 rehydrate probe (§1) reads lastAcceptedForSession + findBySession BEFORE
    // the insert — for this never-committed session those faithfully return "no tip"
    // / empty chain, so step 0 is a no-op and the throwing insert stays the thing
    // being tested. Keep the REAL db for the txn.
    const throwingRepo = {
      insert: () => {
        throw new Error("simulated disk failure");
      },
      lastAcceptedForSession: () => undefined,
      findBySession: () => [],
    } as unknown as IGatewayReceiptRepository;

    const failingSvc = new GatewayReceiptStore({
      db: store.db,
      repo: throwingRepo,
      sequenceStore,
      signer,
    });

    const r = failingSvc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(r.status).toBe("errored");
    if (r.status === "errored") expect(r.error.message).toContain("simulated disk failure");

    // Nothing durably committed (rolled back) — the REAL repo sees no rows.
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toEqual([]);
    // The in-memory accepted chain did NOT advance.
    expect(sequenceStore.hasSession("sess-1")).toBe(false);
    expect(sequenceStore.snapshot("sess-1")).toBeUndefined();

    // The failed attempt did not poison the session: a real seq-1 accept still
    // starts cleanly from genesis (same store, same sequenceStore).
    const ok = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(ok.status).toBe("accepted");
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(1);
    expect(sequenceStore.snapshot("sess-1")).toEqual({ lastSeq: 1, lastHash: "h1", acceptedCount: 1 });
  });
});

/**
 * Rehydrate-on-first-touch (§1): after a gateway restart the in-memory acceptance
 * store is genesis, but the durable gateway_receipts rows hold the real accepted
 * tip. `record()` recovers that tip (inside its synchronous span) so post-restart
 * outcomes are correct. The restart is simulated faithfully: the durable rows are
 * committed through one `SessionSequenceStore`, then a FRESH (empty) one is placed
 * over the SAME @pcc/store db/repo — exactly what a process restart leaves behind.
 */
describe("GatewayReceiptStore — rehydrate-on-first-touch (§1)", () => {
  let store: Store;
  let signer: GatewayReceiptSigner;

  beforeEach(() => {
    store = createStore({ seed: false });
    signer = makeSigner();
  });
  afterEach(() => store.close());

  /** Commit a chained seq 1..N receipt run through a throwaway (pre-restart) store. */
  function seedCommittedChain(sessionId: string, hashes: string[]): void {
    const seedSeq = new SessionSequenceStore();
    const seeding = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      sequenceStore: seedSeq,
      signer,
    });
    let prev: string | null = null;
    hashes.forEach((hash, i) => {
      const res = seeding.record(
        input({ sessionId, seq: i + 1, checkpointHash: hash, prevCheckpointHash: prev }),
      );
      expect(res.status).toBe("accepted");
      prev = hash;
    });
  }

  /** A "restarted gateway": a fresh (empty) sequenceStore over the SAME durable db/repo. */
  function restartedStore(): { svc: GatewayReceiptStore; sequenceStore: SessionSequenceStore } {
    const sequenceStore = new SessionSequenceStore();
    const svc = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      sequenceStore,
      signer,
    });
    return { svc, sequenceStore };
  }

  it("restart-sim: a fresh sequenceStore over durable rows accepts the next seq (tip recovered)", () => {
    const sessionId = "sess-restart";
    seedCommittedChain(sessionId, ["h1", "h2", "h3"]); // seq 1..3 committed
    const { svc, sequenceStore } = restartedStore();

    // Memory is genesis after "restart".
    expect(sequenceStore.hasSession(sessionId)).toBe(false);

    // seq 4, prevHash = the committed tip (h3) → accepted ONLY if the tip was recovered.
    const r = svc.record(input({ sessionId, seq: 4, checkpointHash: "h4", prevCheckpointHash: "h3" }));
    expect(r.status).toBe("accepted");

    // Durable tip advanced to seq 4; in-memory recovered (seen={h1..h3}) then advanced.
    expect(store.repos.gatewayReceipts.lastAcceptedForSession(sessionId)).toEqual({
      lastSeq: 4,
      lastHash: "h4",
      lastReceiptId: `grcpt-${sessionId}-4`,
    });
    expect(sequenceStore.snapshot(sessionId)).toEqual({ lastSeq: 4, lastHash: "h4", acceptedCount: 4 });
  });

  it("a replayed seq-1 after restart rejects cleanly (seq_gap_or_replay, NOT errored — no PK collision)", () => {
    const sessionId = "sess-replay";
    seedCommittedChain(sessionId, ["h1", "h2", "h3"]);
    const { svc } = restartedStore();

    // Rehydrate sets lastSeq=3, so seq 1 fails the seq clause BEFORE any insert.
    const replay = svc.record(input({ sessionId, seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") expect(replay.reason).toBe("seq_gap_or_replay");

    // No insert attempted → durable rows unchanged (still the original 3).
    expect(store.repos.gatewayReceipts.findBySession(sessionId).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("rebuilds `seen` from the committed chain: a duplicate old hash at a fresh seq → duplicate_hash", () => {
    const sessionId = "sess-seen";
    seedCommittedChain(sessionId, ["h1", "h2", "h3"]);
    const { svc } = restartedStore();

    // seq 4 (valid), prevHash = tip h3 (valid chain), but hash = h1 (already accepted).
    // seq/max/chain clauses all pass; only the REBUILT `seen` set catches the replay.
    const dup = svc.record(input({ sessionId, seq: 4, checkpointHash: "h1", prevCheckpointHash: "h3" }));
    expect(dup.status).toBe("rejected");
    if (dup.status === "rejected") expect(dup.reason).toBe("duplicate_hash");

    expect(store.repos.gatewayReceipts.findBySession(sessionId).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("rehydrate refuses to overwrite live memory (first-touch-wins)", () => {
    const sessionId = "sess-live";
    const sequenceStore = new SessionSequenceStore();
    // Live memory ahead of any rehydrate: accept seq 1 directly.
    expect(
      sequenceStore.accept(sessionId, { seq: 1, prevHash: null, hash: "live1", maxSignatures: 100 }).accepted,
    ).toBe(true);
    const before = sequenceStore.snapshot(sessionId);

    // Attempt to install a different (durable-looking) state → refused, state unchanged.
    const installed = sequenceStore.rehydrate(sessionId, {
      lastSeq: 9,
      lastHash: "durable9",
      seen: new Set(["x", "y"]),
    });
    expect(installed).toBe(false);
    expect(sequenceStore.snapshot(sessionId)).toEqual(before);
  });

  it("a genuinely-new session (no durable rows) stays genesis: first record at seq 1 accepts", () => {
    const sessionId = "sess-new";
    const { svc, sequenceStore } = restartedStore(); // nothing seeded → no durable rows

    // No durable rows → rehydrate is a no-op (never stores a genesis; rule 1) → clean genesis.
    const r = svc.record(input({ sessionId, seq: 1, checkpointHash: "n1", prevCheckpointHash: null }));
    expect(r.status).toBe("accepted");
    expect(sequenceStore.snapshot(sessionId)).toEqual({ lastSeq: 1, lastHash: "n1", acceptedCount: 1 });
    expect(store.repos.gatewayReceipts.findBySession(sessionId).map((row) => row.seq)).toEqual([1]);
  });
});
