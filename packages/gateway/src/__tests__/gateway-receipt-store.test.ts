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
  schema,
  eq,
  type Store,
  type IGatewayReceiptRepository,
  type ICheckpointBodyRepository,
} from "@pcc/store";
import { SessionSequenceStore } from "../services/session-sequence-store.js";
import { GatewayReceiptSigner } from "../services/gateway-receipt-signer.js";
import {
  GatewayReceiptStore,
  makeEvidenceAcceptanceGuard,
  type CheckpointReceiptInput,
  type CheckpointAcceptanceGuard,
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
    // Body fields (S6-1: record() persists the checkpoint_bodies row atomically with the receipt).
    eventsRoot: "er1",
    checkpointType: "workflow_step_completed",
    deviceCreatedAt: 1_800_000_000,
    signature: "sig1",
    ...overrides,
  };
}

/**
 * A pass-through acceptance guard for the receipt-store unit tests that do not exercise the lifecycle
 * (round-7). record() calls the guard inside its txn; a pass-through returns `{ ok: true }` so the
 * receipt/body commit. The round-7 rollback tests below pass deliberately-rejecting/throwing guards, and
 * the guard-logic tests exercise makeEvidenceAcceptanceGuard directly.
 */
function passGuard(): CheckpointAcceptanceGuard {
  return { claimForCheckpoint: () => ({ ok: true as const }) };
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
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
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

    // Re-submit seq 2 with a DIFFERENT hash (h2x vs the committed h2). INTENDED H1
    // CHANGE (RULE 18): a row IS committed at (sess-1, 2) and the checkpoint differs,
    // so the DB-authoritative guard classifies this as conflict:equivocation — the
    // precise "you cannot fork history at a committed height" outcome. Pre-H1 this fell
    // through to checkSequence (seq===lastSeq, not last+1) and was seq_gap_or_replay.
    // Same H1 behavior the audit specifies ("different-hash-same-seq → equivocation
    // because a row DOES exist at that seq"); full matrix in the H1 describe block.
    const replay = svc.record(input({ seq: 2, checkpointHash: "h2x", prevCheckpointHash: "h1", maxSignatures: 2 }));
    expect(replay.status).toBe("conflict");
    if (replay.status === "conflict") expect(replay.reason).toBe("equivocation");

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
    // step-0 rehydrate probe (§1) reads lastAcceptedForSession + findAllBySession (S6-6:
    // UNCAPPED), and the H1 guard reads findById, BEFORE the insert — for this
    // never-committed session all three faithfully return "no tip" / empty chain / no
    // committed row, so steps 0+H1 are no-ops and the throwing insert stays the thing
    // being tested. Keep the REAL db for the txn.
    const throwingRepo = {
      insert: () => {
        throw new Error("simulated disk failure");
      },
      lastAcceptedForSession: () => undefined,
      findAllBySession: () => [],
      // H1 adds a findById probe before the insert; report "no committed row" so the
      // throwing insert remains the failure under test.
      findById: () => undefined,
    } as unknown as IGatewayReceiptRepository;

    const failingSvc = new GatewayReceiptStore({
      db: store.db,
      repo: throwingRepo,
      // Never reached: the receipt insert throws FIRST inside the txn (real body repo is fine here).
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
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

  /**
   * Commit a chained seq 1..N receipt run through a throwaway (pre-restart) store.
   * `maxSignatures` (default 100, additive — existing callers unchanged) must be >= N so
   * long chains (the S6-6 >MAX_LIMIT seed) are all accepted rather than max-signature capped.
   */
  function seedCommittedChain(sessionId: string, hashes: string[], maxSignatures = 100): void {
    const seedSeq = new SessionSequenceStore();
    const seeding = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore: seedSeq,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
      signer,
    });
    let prev: string | null = null;
    hashes.forEach((hash, i) => {
      const res = seeding.record(
        input({ sessionId, seq: i + 1, checkpointHash: hash, prevCheckpointHash: prev, maxSignatures }),
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
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
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

  it("a replayed seq-1 after restart is idempotent (exact-retry of the committed seq-1; H1)", () => {
    const sessionId = "sess-replay";
    seedCommittedChain(sessionId, ["h1", "h2", "h3"]);
    const { svc } = restartedStore();

    // INTENDED H1 CHANGE (RULE 18): this replays the EXACT checkpoint committed at seq 1
    // (hash "h1", jobId "job-1", prevHash null). Under H1 the DB-authoritative guard finds
    // the committed row at (sess-replay, 1) and returns `idempotent` (the response-lost-
    // after-commit case) — NOT `seq_gap_or_replay`. Pre-H1 it fell through to checkSequence
    // (rehydrate had set lastSeq=3) and was a seq_gap_or_replay reject. Both outcomes insert
    // NO row and mint NO 2nd receipt; H1 makes the safe-resubmit case explicit and returns
    // the already-committed receipt.
    const replay = svc.record(input({ sessionId, seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(replay.status).toBe("idempotent");
    if (replay.status === "idempotent") {
      expect(replay.row.receiptId).toBe(`grcpt-${sessionId}-1`);
      expect(replay.receipt.checkpointHash).toBe("h1");
    }

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

  // S6-6 — the rehydrate `seen` rebuild MUST read the UNCAPPED chain. Before the fix it used
  // the capped findBySession (default 100 / max 1000), so a restart on a long session rebuilt
  // an INCOMPLETE `seen` and a replayed old hash at a fresh seq slipped past the duplicate_hash
  // clause (a false "complete recovered state", §1). These prove the full set is rebuilt.
  it("S6-6: rebuilds the FULL `seen` from an UNCAPPED read — a >DEFAULT_LIMIT (100) old hash replayed at a fresh seq → duplicate_hash", () => {
    const sessionId = "sess-cap100";
    const N = 150; // > DEFAULT_LIMIT (100): the capped findBySession() would miss seq 101..150
    const hashes = Array.from({ length: N }, (_, i) => `hc${i + 1}`);
    seedCommittedChain(sessionId, hashes, 500);
    const { svc, sequenceStore } = restartedStore();
    expect(sequenceStore.hasSession(sessionId)).toBe(false);

    // (a) Replay hash from seq 120 (> 100, so absent from a default-100 capped `seen`) at a
    //     FRESH seq. Only the UNCAPPED rebuild contains it → duplicate_hash (a capped read
    //     would wrongly ACCEPT this evidence replay). hashes[119] === "hc120".
    const replay = svc.record(
      input({ sessionId, seq: N + 1, checkpointHash: hashes[119], prevCheckpointHash: hashes[N - 1], maxSignatures: 500 }),
    );
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") expect(replay.reason).toBe("duplicate_hash");

    // (b) A legit next seq still accepts (the rejected replay advanced nothing).
    const next = svc.record(
      input({ sessionId, seq: N + 1, checkpointHash: "hc-next", prevCheckpointHash: hashes[N - 1], maxSignatures: 500 }),
    );
    expect(next.status).toBe("accepted");
    expect(store.repos.gatewayReceipts.lastAcceptedForSession(sessionId)).toEqual({
      lastSeq: N + 1, lastHash: "hc-next", lastReceiptId: `grcpt-${sessionId}-${N + 1}`,
    });
  });

  it("S6-6: an UNCAPPED rebuild holds past MAX_LIMIT — a >1000-seq old hash replayed at a fresh seq → duplicate_hash (defeats a capped-1000 read)", () => {
    const sessionId = "sess-cap1000";
    const N = 1002; // > MAX_LIMIT (1000): even findBySession(sessionId, 1000) would miss seq 1001..1002
    const hashes = Array.from({ length: N }, (_, i) => `hh${i + 1}`);
    seedCommittedChain(sessionId, hashes, 2000);
    const { svc, sequenceStore } = restartedStore();
    expect(sequenceStore.hasSession(sessionId)).toBe(false);

    // (a) Replay an OLD hash from seq 1001 (> MAX_LIMIT, so absent from ANY capped `seen`)
    //     at a FRESH seq. Only findAllBySession (truly uncapped) rebuilds a `seen` that
    //     contains it → duplicate_hash. A capped-100 OR capped-1000 read would miss it and
    //     wrongly accept — this is the test a `findBySession(id, 1000)` pseudo-fix FAILS.
    //     hashes[1000] === "hh1001" (seq 1001); hashes[N-1] === "hh1002" (the tip).
    const replay = svc.record(
      input({ sessionId, seq: N + 1, checkpointHash: hashes[1000], prevCheckpointHash: hashes[N - 1], maxSignatures: 2000 }),
    );
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") expect(replay.reason).toBe("duplicate_hash");

    // (b) The legit next seq (lastSeq+1, fresh hash) still accepts.
    const next = svc.record(
      input({ sessionId, seq: N + 1, checkpointHash: "hh-next", prevCheckpointHash: hashes[N - 1], maxSignatures: 2000 }),
    );
    expect(next.status).toBe("accepted");
    expect(store.repos.gatewayReceipts.lastAcceptedForSession(sessionId)).toEqual({
      lastSeq: N + 1, lastHash: "hh-next", lastReceiptId: `grcpt-${sessionId}-${N + 1}`,
    });
  }, 30_000);
});

/**
 * H1 — checkpoint acceptance is DB-AUTHORITATIVE + IDEMPOTENT. The durable
 * gateway_receipts row at (sessionId, seq) is the source of truth; the in-memory
 * chain is only a cache over it. The discriminator is "does a committed row exist
 * AT THIS seq?": yes+match → idempotent (response-lost-after-commit, no 2nd row);
 * yes+differ → conflict:equivocation (no overwrite); no → fall through to
 * checkSequence (accept / seq_gap_or_replay / ...), unchanged.
 */
describe("GatewayReceiptStore — H1 DB-authoritative idempotency / equivocation", () => {
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
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
      signer,
    });
  });
  afterEach(() => store.close());

  it("exact resubmit of a committed checkpoint → idempotent (returns the committed receipt, NO 2nd row)", () => {
    const first = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(first.status).toBe("accepted");

    // Response-lost-after-commit: the IDENTICAL checkpoint is resubmitted.
    const retry = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(retry.status).toBe("idempotent");
    if (retry.status === "idempotent" && first.status === "accepted") {
      expect(retry.receipt).toEqual(first.receipt); // the committed receipt (round-trip)
      expect(retry.row.receiptId).toBe("grcpt-sess-1-1");
    }
    // NO second row; tip unchanged.
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(1);
    expect(sequenceStore.snapshot("sess-1")).toEqual({ lastSeq: 1, lastHash: "h1", acceptedCount: 1 });
  });

  it("exact resubmit of a MID-CHAIN committed seq → idempotent; findBySession count unchanged (no 2nd row)", () => {
    expect(svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null })).status).toBe("accepted");
    expect(svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1" })).status).toBe("accepted");
    expect(svc.record(input({ seq: 3, checkpointHash: "h3", prevCheckpointHash: "h2" })).status).toBe("accepted");
    const before = store.repos.gatewayReceipts.findBySession("sess-1").length;

    // Resubmit the exact seq-2 checkpoint (jobId/hash/prevHash all match the committed row).
    const retry = svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1" }));
    expect(retry.status).toBe("idempotent");
    if (retry.status === "idempotent") expect(retry.row.seq).toBe(2);

    // No duplicate row; tip still seq 3 (an old-seq idempotent replay never disturbs the chain).
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(before);
    expect(sequenceStore.snapshot("sess-1")).toEqual({ lastSeq: 3, lastHash: "h3", acceptedCount: 3 });
  });

  it("a DIFFERENT checkpoint at a committed (sessionId, seq) → conflict:equivocation (committed row untouched)", () => {
    expect(svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null })).status).toBe("accepted");
    expect(svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1" })).status).toBe("accepted");

    // Any of jobId / checkpointHash / prevCheckpointHash differing at a committed seq = equivocation.
    const forkHash = svc.record(input({ seq: 2, checkpointHash: "h2-FORK", prevCheckpointHash: "h1" }));
    expect(forkHash.status).toBe("conflict");
    if (forkHash.status === "conflict") expect(forkHash.reason).toBe("equivocation");

    const forkJob = svc.record(input({ seq: 2, jobId: "other-job", checkpointHash: "h2", prevCheckpointHash: "h1" }));
    expect(forkJob.status).toBe("conflict");

    const forkPrev = svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1-FORK" }));
    expect(forkPrev.status).toBe("conflict");

    // The committed seq-2 row is UNTOUCHED and no new row was inserted.
    const row2 = store.repos.gatewayReceipts.findById("grcpt-sess-1-2");
    expect(row2?.checkpointHash).toBe("h2");
    expect(row2?.jobId).toBe("job-1");
    expect(store.repos.gatewayReceipts.findBySession("sess-1").map((r) => r.seq)).toEqual([1, 2]);
    expect(sequenceStore.snapshot("sess-1")).toEqual({ lastSeq: 2, lastHash: "h2", acceptedCount: 2 });
  });

  it("a genuine seq GAP with NO committed row at that seq → rejected seq_gap_or_replay (not conflict)", () => {
    expect(svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null })).status).toBe("accepted");
    expect(svc.record(input({ seq: 2, checkpointHash: "h2", prevCheckpointHash: "h1" })).status).toBe("accepted");
    expect(svc.record(input({ seq: 3, checkpointHash: "h3", prevCheckpointHash: "h2" })).status).toBe("accepted");

    // seq 9 with tip 3: NO row at seq 9 → fall through → checkSequence → seq_gap_or_replay.
    const gap = svc.record(input({ seq: 9, checkpointHash: "h9", prevCheckpointHash: "h3" }));
    expect(gap.status).toBe("rejected");
    if (gap.status === "rejected") expect(gap.reason).toBe("seq_gap_or_replay");
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-9")).toBeUndefined();

    // seq 1 with a DIFFERENT hash than the committed seq-1: a row DOES exist at seq 1
    // → equivocation (contrast the gap above, which had no row).
    const sameSeqDiff = svc.record(input({ seq: 1, checkpointHash: "h1-DIFF", prevCheckpointHash: null }));
    expect(sameSeqDiff.status).toBe("conflict");
    if (sameSeqDiff.status === "conflict") expect(sameSeqDiff.reason).toBe("equivocation");

    // Chain unchanged throughout.
    expect(sequenceStore.snapshot("sess-1")).toEqual({ lastSeq: 3, lastHash: "h3", acceptedCount: 3 });
  });
});

/**
 * R-14b — defensive input validation at the top of record(). A structurally
 * invalid input is a CONTRACT VIOLATION (→ errored), not a sequence reject: it
 * must never reach the rehydrate probe, the H1 lookup, checkSequence, the signer,
 * or the DB. Nothing is persisted and the in-memory chain is never created.
 */
describe("GatewayReceiptStore — R-14b defensive input validation", () => {
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
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
      signer,
    });
  });
  afterEach(() => store.close());

  const cases: Array<{ name: string; overrides: Partial<CheckpointReceiptInput> }> = [
    { name: "seq = 0 (below 1)", overrides: { seq: 0 } },
    { name: "seq negative", overrides: { seq: -1 } },
    { name: "seq non-integer", overrides: { seq: 1.5 } },
    { name: "seq NaN", overrides: { seq: Number.NaN } },
    { name: "maxSignatures negative", overrides: { maxSignatures: -1 } },
    { name: "maxSignatures non-integer", overrides: { maxSignatures: 2.5 } },
    { name: "effectiveEvidenceTime = 0", overrides: { effectiveEvidenceTime: 0 } },
    { name: "effectiveEvidenceTime negative", overrides: { effectiveEvidenceTime: -5 } },
    { name: "effectiveEvidenceTime Infinity", overrides: { effectiveEvidenceTime: Number.POSITIVE_INFINITY } },
    { name: "effectiveEvidenceTime NaN", overrides: { effectiveEvidenceTime: Number.NaN } },
    { name: "jobId empty", overrides: { jobId: "" } },
    { name: "jobId blank", overrides: { jobId: "   " } },
    { name: "sessionId empty", overrides: { sessionId: "" } },
    { name: "checkpointHash empty", overrides: { checkpointHash: "" } },
  ];

  for (const c of cases) {
    it(`${c.name} → errored, nothing persisted, chain not advanced`, () => {
      const r = svc.record(input(c.overrides));
      expect(r.status).toBe("errored");
      if (r.status === "errored") expect(r.error).toBeInstanceOf(Error);

      // The guard returns BEFORE any persist / in-memory advance.
      const sid = c.overrides.sessionId ?? "sess-1";
      expect(store.repos.gatewayReceipts.findBySession(sid)).toEqual([]);
      expect(sequenceStore.hasSession(sid)).toBe(false);
    });
  }

  it("a structurally-valid input still accepts (the guard does not block the happy path)", () => {
    const r = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(r.status).toBe("accepted");
  });
});

/**
 * S6-1 — receipt + checkpoint_bodies ATOMICITY (§8.1-#3 split-brain fix). record()
 * now inserts the gateway_receipts row AND the checkpoint_bodies sibling row in ONE
 * transaction (previously the route wrote the body separately, so a crash between the
 * committed receipt and the body left a receipt with no body). The H1 idempotent
 * branch additionally requires a matching body: a committed receipt without an agreeing
 * body is an INTEGRITY failure (errored), never a safe idempotent replay.
 */
describe("GatewayReceiptStore — S6-1 receipt/body atomicity (§8.1-#3)", () => {
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
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
      signer,
    });
  });
  afterEach(() => store.close());

  it("a body-insert throw AFTER the receipt insert rolls BOTH back: errored, no receipt, no body, no advance", () => {
    // REAL gateway_receipts repo (the receipt insert succeeds) + a checkpointBodies stub
    // whose insert throws — so the body insert throws INSIDE the txn, AFTER the receipt
    // insert. Atomicity must roll the receipt back too (the split-brain this fix closes).
    const throwingBodies = {
      insert: () => {
        throw new Error("simulated body-insert failure");
      },
      findBySessionSeq: () => undefined,
      findBySession: () => [],
    } as unknown as ICheckpointBodyRepository;
    const atomicSvc = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: throwingBodies,
      sequenceStore,
      acceptanceGuard: passGuard(), // round-7: pass-through acceptance guard (no lifecycle exercised)
      signer,
    });

    const r = atomicSvc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(r.status).toBe("errored");
    if (r.status === "errored") expect(r.error.message).toContain("simulated body-insert failure");

    // The receipt was ROLLED BACK with the body (atomic) — nothing durably committed.
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-1")).toBeUndefined();
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toEqual([]);
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeUndefined();
    // The in-memory accepted chain did NOT advance.
    expect(sequenceStore.hasSession("sess-1")).toBe(false);
  });

  // ── P1-2 + round-7 (re-audit): the acceptance precondition is enforced INSIDE the receipt txn ──
  function svcWith(guard: CheckpointAcceptanceGuard) {
    return new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore,
      acceptanceGuard: guard,
      signer,
    });
  }

  it("round-7: a new acceptance whose guard REJECTS the precondition → errored, receipt+body rolled back, no advance", () => {
    const r = svcWith({ claimForCheckpoint: () => undefined }).record(
      input({ seq: 1, checkpointHash: "ht", prevCheckpointHash: null, checkpointType: "execution_completed" }),
    );
    expect(r.status).toBe("errored");
    if (r.status === "errored") expect(r.error.message).toContain("acceptance precondition failed");
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-1")).toBeUndefined();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeUndefined();
    expect(sequenceStore.hasSession("sess-1")).toBe(false);
  });

  it("round-7: the guard rejects a NONTERMINAL acceptance too (session no longer open) → errored, rolled back", () => {
    const r = svcWith({ claimForCheckpoint: () => undefined }).record(
      input({ seq: 1, checkpointHash: "ht", prevCheckpointHash: null, checkpointType: "workflow_step_completed" }),
    );
    expect(r.status).toBe("errored");
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-1")).toBeUndefined();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeUndefined();
  });

  it("round-7: a guard that THROWS → errored, receipt+body rolled back", () => {
    const r = svcWith({
      claimForCheckpoint: () => {
        throw new Error("simulated guard failure");
      },
    }).record(input({ seq: 1, checkpointHash: "ht", prevCheckpointHash: null, checkpointType: "fault_report" }));
    expect(r.status).toBe("errored");
    if (r.status === "errored") expect(r.error.message).toContain("simulated guard failure");
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-1")).toBeUndefined();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeUndefined();
  });

  it("round-7: a guard that ACCEPTS → receipt + body commit", () => {
    const r = svcWith(passGuard()).record(
      input({ seq: 1, checkpointHash: "ht", prevCheckpointHash: null, checkpointType: "execution_completed" }),
    );
    expect(r.status).toBe("accepted");
    expect(store.repos.gatewayReceipts.findById("grcpt-sess-1-1")).toBeDefined();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeDefined();
  });

  // makeEvidenceAcceptanceGuard logic (fake session/job repos — no store setup needed).
  it("round-7 guard: session no longer open → undefined (post-terminal / post-finalize acceptance blocked)", () => {
    const guard = makeEvidenceAcceptanceGuard({
      sessions: { findById: () => ({ status: "terminal_success", jobId: "j" }), transitionIfOpen: () => undefined },
      jobs: { findById: () => ({ status: "executing" }) },
      uncollectableJobStatuses: new Set(),
    });
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: undefined })).toBeUndefined();
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: "terminal_success" })).toBeUndefined();
  });

  it("round-7 guard: a MISSING job → undefined (fail closed — never accept without a live job)", () => {
    const guard = makeEvidenceAcceptanceGuard({
      sessions: { findById: () => ({ status: "open", jobId: "j" }), transitionIfOpen: () => ({ status: "terminal_success" }) },
      jobs: { findById: () => undefined },
      uncollectableJobStatuses: new Set(),
    });
    // Both a nonterminal and a terminal acceptance must be refused, and the terminal CAS must NOT fire.
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: undefined })).toBeUndefined();
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: "terminal_success" })).toBeUndefined();
  });

  it("round-7 guard: a session that belongs to ANOTHER job → undefined (session.jobId must match)", () => {
    const guard = makeEvidenceAcceptanceGuard({
      sessions: { findById: () => ({ status: "open", jobId: "other-job" }), transitionIfOpen: () => ({ status: "terminal_success" }) },
      jobs: { findById: () => ({ status: "executing" }) },
      uncollectableJobStatuses: new Set(),
    });
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: undefined })).toBeUndefined();
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: "terminal_success" })).toBeUndefined();
  });

  it("round-7 guard: job no longer evidence-collectable (settlement_hold) → undefined", () => {
    const guard = makeEvidenceAcceptanceGuard({
      sessions: { findById: () => ({ status: "open", jobId: "j" }), transitionIfOpen: () => ({ status: "terminal_success" }) },
      jobs: { findById: () => ({ status: "settlement_hold" }) },
      uncollectableJobStatuses: new Set(["settlement_hold"]),
    });
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: undefined })).toBeUndefined();
  });

  it("round-7 guard: open matching session + collectable job → nonterminal ok; terminal CASes open→terminal; a 2nd terminal loses", () => {
    let sessionStatus = "open";
    const guard = makeEvidenceAcceptanceGuard({
      sessions: {
        findById: () => ({ status: sessionStatus, jobId: "j" }),
        transitionIfOpen: (_id, to) =>
          sessionStatus === "open" ? ((sessionStatus = to), { status: to }) : undefined,
      },
      jobs: { findById: () => ({ status: "executing" }) },
      uncollectableJobStatuses: new Set(["settlement_hold", "settled"]),
    });
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: undefined })).toEqual({ ok: true });
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: "terminal_success" })).toEqual({ ok: true });
    expect(sessionStatus).toBe("terminal_success"); // the CAS transitioned it
    expect(guard.claimForCheckpoint({ sessionId: "s", jobId: "j", terminalStatus: "terminal_fault" })).toBeUndefined(); // 2nd terminal → session no longer open
  });

  it("accept persists the receipt AND its checkpoint body atomically; exact replay → idempotent (no 2nd row)", () => {
    const first = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(first.status).toBe("accepted");
    // record() OWNS the body insert now — the sibling row is present after accept.
    const body = store.repos.checkpointBodies.findBySessionSeq("sess-1", 1);
    expect(body).toBeDefined();
    expect(body?.checkpointHash).toBe("h1");
    expect(body?.eventsRoot).toBe("er1");

    // Exact resubmit → idempotent (body + receipt both present and agree); no duplicate rows.
    const retry = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(retry.status).toBe("idempotent");
    expect(store.repos.gatewayReceipts.findBySession("sess-1")).toHaveLength(1);
    expect(store.repos.checkpointBodies.findBySession("sess-1")).toHaveLength(1);
  });

  it("a committed receipt whose body was REMOVED → errored (integrity), NOT idempotent", () => {
    expect(
      svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null })).status,
    ).toBe("accepted");
    // Force the split-brain state this fix prevents: delete the body under a committed receipt.
    store.db
      .delete(schema.checkpointBodies)
      .where(eq(schema.checkpointBodies.id, "ckpt-sess-1-1"))
      .run();
    expect(store.repos.checkpointBodies.findBySessionSeq("sess-1", 1)).toBeUndefined();

    const retry = svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null }));
    expect(retry.status).toBe("errored");
    if (retry.status === "errored") expect(retry.error.message).toContain("integrity");
  });

  it("a committed receipt whose body eventsRoot DIVERGES → errored (integrity), NOT idempotent", () => {
    expect(
      svc.record(input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null, eventsRoot: "er-original" }))
        .status,
    ).toBe("accepted");
    // Diverge the stored body's eventsRoot from what the receipt attests / the input claims.
    store.db
      .update(schema.checkpointBodies)
      .set({ eventsRoot: "er-DIVERGED" })
      .where(eq(schema.checkpointBodies.id, "ckpt-sess-1-1"))
      .run();

    const retry = svc.record(
      input({ seq: 1, checkpointHash: "h1", prevCheckpointHash: null, eventsRoot: "er-original" }),
    );
    expect(retry.status).toBe("errored");
    if (retry.status === "errored") expect(retry.error.message).toContain("integrity");
  });
});
