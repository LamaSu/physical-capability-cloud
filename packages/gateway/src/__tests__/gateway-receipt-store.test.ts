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
    // A repo whose insert throws; the service only calls repo.insert (inside the
    // txn), so the other methods are unused. Keep the REAL db for the txn.
    const throwingRepo = {
      insert: () => {
        throw new Error("simulated disk failure");
      },
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
