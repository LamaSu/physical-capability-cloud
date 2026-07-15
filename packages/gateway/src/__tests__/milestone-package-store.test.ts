/**
 * Milestone package store (§2.3 / §8.4-B) — finalize the claim-free
 * FinalMilestonePackage under the step-5 transactional invariant, against a REAL
 * @pcc/store: seed an accepted chain via GatewayReceiptStore.record() + matching
 * checkpoint_bodies, open a session, then exercise §8.4-B clause-by-clause.
 *
 * Covered: happy finalize (evidenceRoot === merkleRoot(hashes), packageHash stable,
 * session flips to finalized, receipt verifies); idempotent re-finalize (same
 * package, original receipt time, no overwrite); deadline passed; matching + non-
 * matching payload revelation; zero checkpoints; session not found; claim-free body.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createStore, schema, eq, type Store } from "@pcc/store";
import { canonicalize } from "@pcc/spec";
import { merkleRoot } from "@pcc/verifier";
import { GatewayReceiptStore } from "../services/gateway-receipt-store.js";
import { GatewayReceiptSigner } from "../services/gateway-receipt-signer.js";
import { SessionSequenceStore } from "../services/session-sequence-store.js";
import { generateEd25519Keypair } from "../auth/ed25519.js";
import { EvidenceSessionStore } from "../services/evidence-session-store.js";
import { MilestonePackageStore } from "../services/milestone-package-store.js";

const NOW = 1_800_000_000; // Unix seconds
const JOB = "job-1";
const MI = 0;
const SESSION_ID = "evs-job-1-0"; // = evidenceSessionId(JOB, MI)

/** The cross-wave canonical-sha256 idiom (mirrors the store under test). */
function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function makeSigner(): GatewayReceiptSigner {
  const kp = generateEd25519Keypair();
  return new GatewayReceiptSigner({
    keyId: "gw-rcpt-test",
    privateKeyHex: kp.privateKeyHex,
    publicKeyHex: kp.publicKeyHex,
  });
}

describe("MilestonePackageStore.finalize (§2.3 / §8.4-B)", () => {
  let store: Store;
  let signer: GatewayReceiptSigner;

  const window = {
    notBefore: NOW,
    expiresAt: NOW + 3600,
    evidenceSubmissionDeadline: NOW + 86_400,
  };
  const delegation = {
    sessionId: "sk-1",
    scope: { contractIds: [JOB], maxSignatures: 100 },
  };

  beforeEach(() => {
    store = createStore({ seed: false });
    signer = makeSigner();
  });
  afterEach(() => store.close());

  function openSession(): void {
    const svc = new EvidenceSessionStore({ repo: store.repos.evidenceSessions });
    const r = svc.open({
      jobId: JOB,
      milestoneIndex: MI,
      sessionKeyAuthorization: delegation,
      window,
      now: NOW,
    });
    expect(r.status).toBe("opened");
  }

  /**
   * Seed an accepted checkpoint chain (seq 1..N) for SESSION_ID. record() now inserts
   * the matching checkpoint_bodies row ATOMICALLY with the receipt (S6-1) — the SETUP
   * no longer writes the body separately. The LAST checkpoint's type is `terminalType`
   * (default "execution_completed") so the chain satisfies finalize's terminal-completion
   * requirement (S6-2); earlier checkpoints are "workflow_step_completed".
   * `eventsPerCheckpoint[i]` is the events array committed by checkpoint i;
   * body.eventsRoot = canonicalSha256(events). Returns the accepted hashes in seq order.
   */
  function seedChain(
    eventsPerCheckpoint: unknown[][],
    terminalType = "execution_completed",
    typesOverride?: string[],
  ): string[] {
    const seq = new SessionSequenceStore();
    const receiptStore = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore: seq,
      // Pass-through guard (round-7): the seeder builds the durable fixture; the terminal SESSION state
      // is set directly (seedChain sets it from the last type; the >1000 R-14c seed sets it below).
      acceptanceGuard: { claimForCheckpoint: () => ({ ok: true as const }) },
      signer,
    });
    let prev: string | null = null;
    const hashes: string[] = [];
    const n = eventsPerCheckpoint.length;
    eventsPerCheckpoint.forEach((events, i) => {
      const seqNum = i + 1;
      const eventsRoot = canonicalSha256(events);
      const checkpointType = typesOverride
        ? typesOverride[i]
        : i === n - 1
          ? terminalType
          : "workflow_step_completed";
      // checkpointHash: server-computed sha256 over the canonical checkpoint content —
      // the SAME 6 keys finalize recomputes over (S6-2 terminal-hash integrity check).
      const checkpointHash = canonicalSha256({
        sessionId: SESSION_ID,
        seq: seqNum,
        eventsRoot,
        prevCheckpointHash: prev,
        checkpointType,
        createdAt: NOW,
      });
      const res = receiptStore.record({
        jobId: JOB,
        sessionId: SESSION_ID,
        seq: seqNum,
        checkpointHash,
        prevCheckpointHash: prev,
        maxSignatures: 100,
        effectiveEvidenceTime: NOW + i, // first=NOW, last=NOW+(N-1)
        eventsRoot,
        checkpointType,
        deviceCreatedAt: NOW,
        signature: `sig-${seqNum}`,
      });
      expect(res.status).toBe("accepted");
      // record() owns the checkpoint_bodies insert now (S6-1) — no manual insert here.
      prev = checkpointHash;
      hashes.push(checkpointHash);
    });
    // Reflect the terminal SESSION state the live route would produce (the round-7 acceptance guard CASes
    // open→terminal on the LAST accepted checkpoint): a completion → terminal_success, a fault →
    // terminal_fault, a nonterminal last → stays open. Set directly since the pass-through guard did not.
    const lastType = typesOverride ? typesOverride[n - 1] : terminalType;
    if (lastType === "execution_completed") store.repos.evidenceSessions.setStatus(SESSION_ID, "terminal_success");
    else if (lastType === "fault_report") store.repos.evidenceSessions.setStatus(SESSION_ID, "terminal_fault");
    return hashes;
  }

  function pkgStore(): MilestonePackageStore {
    return new MilestonePackageStore({
      db: store.db,
      evidenceSessions: store.repos.evidenceSessions,
      gatewayReceipts: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      milestonePackages: store.repos.milestonePackages,
      signer,
    });
  }

  it("happy finalize: evidenceRoot === merkleRoot(hashes), packageHash stable, session flips to finalized", () => {
    openSession();
    const hashes = seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });

    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      expect(r.package.acceptedCheckpointHashes).toEqual(hashes);
      expect(r.evidenceRoot).toBe(merkleRoot(hashes));
      expect(r.package.evidenceRoot).toBe(merkleRoot(hashes));
      // packageHash is the canonical-sha256 of the returned package (content-addressed).
      expect(r.packageHash).toBe(canonicalSha256(r.package));
      expect(r.package.packageId).toBe(`fmp-${JOB}-${MI}`);
      expect(r.package.gatewayReceiptIds).toHaveLength(3);
      // provenance = first/last accepted receipt times.
      expect(r.package.evidenceTimeProvenance.kind).toBe("gateway-receipt-points");
      expect(r.package.evidenceTimeProvenance.firstAcceptedAt).toBe(NOW + 0);
      expect(r.package.evidenceTimeProvenance.lastAcceptedAt).toBe(NOW + 2);
      // PackageReceipt shape + signature verifies against the gateway key.
      expect(r.packageReceipt.receiptId).toBe(`fmprcpt-${JOB}-${MI}`);
      expect(r.packageReceipt.acceptedCount).toBe(3);
      expect(r.packageReceipt.packageHash).toBe(r.packageHash);
      expect(r.packageReceipt.acceptedAt).toBe(NOW + 100);
      const { signature, ...content } = r.packageReceipt;
      expect(signer.verify(content, signature)).toBe(true);
    }
    // Session flipped to finalized (atomic with the package insert).
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe(
      "finalized",
    );
    // Exactly one package row (UNIQUE(job,mi)).
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)?.packageId).toBe(
      `fmp-${JOB}-${MI}`,
    );
  });

  it("idempotent re-finalize: same package, original receipt time, no overwrite", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]]);
    const svc = pkgStore();
    const first = svc.finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(first.status).toBe("finalized");
    const second = svc.finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 200 });
    expect(second.status).toBe("idempotent");
    if (first.status === "finalized" && second.status === "idempotent") {
      expect(second.packageHash).toBe(first.packageHash);
      expect(second.package).toEqual(first.package);
      expect(second.packageReceipt).toEqual(first.packageReceipt);
      // The stored row was NOT overwritten: acceptedAt is the FIRST finalize time.
      expect(second.packageReceipt.acceptedAt).toBe(NOW + 100);
    }
  });

  it("finalize past the evidence deadline -> rejected evidence_deadline_passed (session already terminal_success)", () => {
    openSession(); // deadline = NOW + 86400
    seedChain([[{ a: 1 }]]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 86_401 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("evidence_deadline_passed");
    // Round-6 A3: the terminal checkpoint transitioned the session during seeding (the live path), so
    // it is terminal_success here; the deadline rejection does not un-transition it.
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("terminal_success");
  });

  // ── Round-5 payloads-out: the package binds ONLY commitments, NEVER payloads ─────────
  // Revealed payloads live OUTSIDE the immutable package (content-addressed by checkpoint hash,
  // fetched independently). This kills the S6-5 finalize-before-reveal griefing race: the package
  // never carries payloads, so a permissionless finalizer cannot curate/exclude them, and the
  // package is identical whether payloads were revealed before finalize or never at all.

  it("round-5 payloads-out: the finalized package carries NO payloads and binds the terminal + delegation session", () => {
    openSession();
    const events0 = [{ step: "start", ts: 1 }];
    const hashes = seedChain([events0, [{ done: true }]]);
    store.repos.checkpointBodies.setPayload(SESSION_ID, 1, events0); // revealed durably
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      // NO payloads in the package (even though one was revealed) — payloads-out.
      expect((r.package as Record<string, unknown>).payloads).toBeUndefined();
      // Instead the package binds the terminal checkpoint hash + the delegation session id.
      expect(r.package.terminalCheckpointHash).toBe(hashes[hashes.length - 1]);
      expect(r.package).toHaveProperty("delegationSessionId");
    }
  });

  it("round-5 griefing fix: finalizing with NOTHING revealed still yields a complete package (nothing to exclude)", () => {
    // A permissionless keeper finalizes BEFORE the device reveals any payload. Payloads-out ⇒ the
    // package binds the full accepted chain regardless, so the keeper excludes nothing; a later
    // reveal is retrievable independently and never needs to amend the already-frozen package.
    openSession();
    const hashes = seedChain([[{ measured: 42 }], [{ b: 2 }]]); // nothing revealed
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      expect((r.package as Record<string, unknown>).payloads).toBeUndefined();
      expect(r.package.acceptedCheckpointHashes).toEqual(hashes); // whole chain bound
      expect(r.package.evidenceRoot).toBe(merkleRoot(hashes));
    }
  });

  // ── S6-2b: a terminal checkpoint must be the LAST accepted checkpoint ────────────────
  it("S6-2b: fault_report THEN execution_completed does NOT finalize as success → rejected post_terminal_checkpoint", () => {
    openSession();
    // A fault ends the run; a later execution_completed is invalid. The finalizer trusts only the
    // LAST type, so without the S6-2b scan this would settle as success — the exact audit case.
    seedChain([[{ fault: true }], [{ done: true }]], "execution_completed", [
      "fault_report",
      "execution_completed",
    ]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("post_terminal_checkpoint");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("S6-2b: a completion checkpoint that is NOT last → rejected post_terminal_checkpoint", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]], "execution_completed", [
      "execution_completed",
      "execution_completed",
    ]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("post_terminal_checkpoint");
  });

  // ── Round-6 P1-3: WHOLE-CHAIN body↔receipt integrity (every body, not just the last) ─
  it("round-6 whole-chain: a tampered NON-terminal body → errored, no package (the terminal body is intact)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]); // 3 checkpoints; last is the terminal completion
    // Corrupt the FIRST (non-terminal) body's checkpointHash directly (bypassing record()). It no
    // longer recomputes to its own hash NOR matches its receipt — the whole-chain check must catch it
    // even though the TERMINAL body is untouched (the old last-only check would have missed this).
    store.db
      .update(schema.checkpointBodies)
      .set({ checkpointHash: `sha256:${"de".repeat(32)}` })
      .where(eq(schema.checkpointBodies.id, `ckpt-${SESSION_ID}-1`))
      .run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
    // Round-6 A3: seeding drove the terminal checkpoint, so the session is terminal_success; the
    // whole-chain integrity failure (errored) is detected AFTER the terminal-state gate passes.
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("terminal_success");
  });

  // ── Round-6 A2: complete whole-chain body↔receipt field binding ──────────────────────
  it("round-6 A2: a non-terminal body whose OWN jobId is wrong → errored (bodies are fetched by sessionId, not jobId)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    // Corrupt the first (non-terminal) body's jobId only. It still belongs to SESSION_ID (so
    // findAllBySession still returns it), still recomputes to its own checkpointHash (jobId is NOT
    // one of the 6 canonical checkpoint keys), and its receipt is untouched — so ONLY the new
    // body.jobId binding catches the mismatch (the receipt.jobId check does not cover the body).
    store.db
      .update(schema.checkpointBodies)
      .set({ jobId: "job-someone-else" })
      .where(eq(schema.checkpointBodies.id, `ckpt-${SESSION_ID}-1`))
      .run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("round-6 A2: a receipt that CLAIMS a wrong previousAcceptedHash (internally consistent) → errored", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    // Make receipt seq-2 internally CONSISTENT (column == body, so the per-row assertRowIntegrity
    // passes) but chain-WRONG: its previousAcceptedHash no longer equals receipt seq-1's checkpointHash.
    // The body chain stays continuous (bodies untouched), so ONLY the new receipt.previousAcceptedHash
    // binding (and the body-prev==receipt-prev binding) catches it — exactly the round-6 finding that a
    // receipt can claim a different prior hash while the body chain looks internally continuous.
    const wrongPrev = `sha256:${"ab".repeat(32)}`;
    const row = store.repos.gatewayReceipts.findById(`grcpt-${SESSION_ID}-2`)!;
    const body = { ...(row.body as Record<string, unknown>), previousAcceptedHash: wrongPrev };
    store.db
      .update(schema.gatewayReceipts)
      .set({ previousAcceptedHash: wrongPrev, body })
      .where(eq(schema.gatewayReceipts.receiptId, `grcpt-${SESSION_ID}-2`))
      .run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("round-6 A2: a MIDDLE checkpoint body deleted (receipt still present) → errored (fail closed)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    store.db.delete(schema.checkpointBodies).where(eq(schema.checkpointBodies.id, `ckpt-${SESSION_ID}-2`)).run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored"); // body/receipt count mismatch
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("round-6 A2: a MIDDLE gateway receipt deleted (body still present) → errored (accepted chain incomplete)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    store.db.delete(schema.gatewayReceipts).where(eq(schema.gatewayReceipts.receiptId, `grcpt-${SESSION_ID}-2`)).run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored"); // receiptRows.length !== tip.lastSeq → incomplete chain
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("round-6 A2: a body RE-HOMED to another session (wrong sessionId) → errored (cannot re-attribute a body)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]]);
    // Move body 2 to a different session — findAllBySession(SESSION_ID) no longer returns it, so the
    // body/receipt counts diverge and finalize fails closed (a body can't be silently re-attributed).
    store.db.update(schema.checkpointBodies).set({ sessionId: "evs-other-session-0" }).where(eq(schema.checkpointBodies.id, `ckpt-${SESSION_ID}-2`)).run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("round-6 A3: finalize on an OPEN session (never terminalized) -> rejected terminal_state_missing", () => {
    openSession(); // session open, no terminal checkpoint accepted (here: no receipts at all)
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    // A3 makes the terminal-state gate authoritative: an open session fails BEFORE the chain scan, so
    // the old `no_checkpoints` reason is now unreachable for an open session (it never reached
    // terminal_success, so no success package can be minted). no_checkpoints stays as defense-in-depth
    // for a terminal session whose durable receipts were lost.
    if (r.status === "rejected") expect(r.reason).toBe("terminal_state_missing");
  });

  it("finalize for a (job, milestone) with no session -> rejected session_not_found", () => {
    const r = pkgStore().finalize({ jobId: "does-not-exist", milestoneIndex: 0, now: NOW });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("session_not_found");
  });

  it("the persisted package is claim-free (no assuranceTier / oracleVerified / success / outcome)", () => {
    openSession();
    seedChain([[{ a: 1 }]]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("finalized");
    const row = store.repos.milestonePackages.findByJobMilestone(JOB, MI);
    expect(row).toBeDefined();
    const body = row!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("assuranceTier");
    expect(body).not.toHaveProperty("oracleVerified");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("outcome");
    // Positive shape: the aggregation fields ARE present.
    expect(body).toHaveProperty("acceptedCheckpointHashes");
    expect(body).toHaveProperty("evidenceRoot");
    expect(body).toHaveProperty("evidenceTimeProvenance");
  });

  it("R-14c: evidenceRoot is computed over the FULL chain (>1000), not a capped/truncated one", () => {
    openSession();

    // Seed 1001 accepted checkpoints (> the repo's 1000 MAX_LIMIT) directly via
    // record() with a high maxSignatures. No checkpoint_bodies needed (no payload
    // revelation in this test), keeping the loop tight.
    const N = 1001;
    const seq = new SessionSequenceStore();
    const receiptStore = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore: seq,
      // Pass-through guard (round-7): the seeder builds the durable fixture; the terminal SESSION state
      // is set directly (seedChain sets it from the last type; the >1000 R-14c seed sets it below).
      acceptanceGuard: { claimForCheckpoint: () => ({ ok: true as const }) },
      signer,
    });
    const hashes: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < N; i++) {
      const seqNum = i + 1;
      const eventsRoot = canonicalSha256(`events-${seqNum}`);
      // Last checkpoint is terminal so finalize (S6-2) proceeds; hash over the same 6
      // canonical keys finalize recomputes. A valid leaf ("sha256:"+64hex) for merkleRoot.
      const checkpointType = i === N - 1 ? "execution_completed" : "workflow_step_completed";
      const checkpointHash = canonicalSha256({
        sessionId: SESSION_ID,
        seq: seqNum,
        eventsRoot,
        prevCheckpointHash: prev,
        checkpointType,
        createdAt: NOW,
      });
      const res = receiptStore.record({
        jobId: JOB,
        sessionId: SESSION_ID,
        seq: seqNum,
        checkpointHash,
        prevCheckpointHash: prev,
        maxSignatures: N + 10,
        effectiveEvidenceTime: NOW + i,
        eventsRoot,
        checkpointType,
        deviceCreatedAt: NOW,
        signature: `sig-${seqNum}`,
      });
      expect(res.status).toBe("accepted");
      prev = checkpointHash;
      hashes.push(checkpointHash);
    }
    expect(hashes).toHaveLength(N);
    // The >1000 chain ends in execution_completed; reflect the terminal session state the live guard
    // would CAS (the pass-through seed guard did not) so finalize passes the round-6 A3 terminal-state gate.
    store.repos.evidenceSessions.setStatus(SESSION_ID, "terminal_success");

    // The OLD capped path (findBySession up to MAX_LIMIT=1000) truncates; the R-14c
    // uncapped path returns all N. (Pre-R-14c finalize even ERRORED on such a chain —
    // its completeness guard tripped when the 1000-cap fetch < tip seq 1001.)
    expect(store.repos.gatewayReceipts.findBySession(SESSION_ID, 1000)).toHaveLength(1000);
    expect(store.repos.gatewayReceipts.findAllBySession(SESSION_ID)).toHaveLength(N);

    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      // The money-path root is the merkleRoot over ALL N hashes in seq order — proving
      // the cap no longer truncates it. A truncated root would differ.
      expect(r.package.acceptedCheckpointHashes).toHaveLength(N);
      expect(r.evidenceRoot).toBe(merkleRoot(hashes));
      // And it is NOT the (wrong) root over just the first 1000 (the old capped fetch).
      expect(r.evidenceRoot).not.toBe(merkleRoot(hashes.slice(0, 1000)));
    }
  });

  // ── S6-2: finalize requires a TERMINAL completion checkpoint (frozen §8.1-#1) ──────
  // Completion is a CLAIM signed + receipted under live authority; the LAST accepted
  // checkpoint must be a terminal-completion type. seedChain's `terminalType` param sets
  // the last checkpoint's type (a legitimate fixture control — finalize's contract now
  // depends on it). A non-terminal / fault last checkpoint must NOT finalize a success.

  it("round-6 A3: a single non-terminal (execution_started) checkpoint → rejected terminal_state_missing", () => {
    openSession();
    seedChain([[{ a: 1 }]], "execution_started"); // the only (last) checkpoint is non-terminal
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    // Round-6 A3: a non-terminal-ending chain never transitions the session, so finalize now fails at
    // the terminal-state gate (terminal_state_missing) BEFORE the terminal-completion scan would have
    // returned terminal_checkpoint_missing. Same security property (a non-terminal chain is NOT a
    // success package), enforced earlier and at the session level.
    if (r.status === "rejected") expect(r.reason).toBe("terminal_state_missing");
    // Fail closed: no package minted, session stays open (never terminalized).
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("open");
  });

  it("round-6 A3: a chain whose LAST checkpoint is non-terminal (workflow_step_completed) → rejected terminal_state_missing", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]], "workflow_step_completed"); // last is non-terminal
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    // A3: the session never transitioned (no terminal checkpoint), so the terminal-state gate fires
    // first — terminal_state_missing rather than the (now defense-in-depth) terminal_checkpoint_missing.
    if (r.status === "rejected") expect(r.reason).toBe("terminal_state_missing");
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
  });

  it("S6-2: a chain ending in execution_completed → finalized", () => {
    openSession();
    const hashes = seedChain([[{ a: 1 }], [{ b: 2 }]], "execution_completed");
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      expect(r.package.acceptedCheckpointHashes).toEqual(hashes);
      expect(r.evidenceRoot).toBe(merkleRoot(hashes));
    }
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("finalized");
  });

  it("S6-2: a chain whose LAST checkpoint is a terminal fault_report → rejected terminal_fault (NOT finalized)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]], "fault_report"); // completed-but-failed
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("terminal_fault");
    // A terminal fault is a DISTINCT outcome from a never-completed chain; not a success finalize.
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
    // Round-6 A3: the fault_report transitioned the session to terminal_fault (the live route path),
    // and finalize returns terminal_fault straight from that state.
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("terminal_fault");
  });

  it("S6-2: terminal checkpoint body missing despite a receipt → errored (integrity, fail closed)", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]], "execution_completed");
    // Force the split state: delete the LAST (terminal) checkpoint's body while its receipt remains.
    // The round-6 whole-chain check fails closed on the resulting body/receipt COUNT mismatch — a more
    // general catch than the old last-only "body missing" (it also catches a missing MIDDLE body).
    store.db
      .delete(schema.checkpointBodies)
      .where(eq(schema.checkpointBodies.id, `ckpt-${SESSION_ID}-2`))
      .run();
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("errored");
    if (r.status === "errored") expect(r.error.message).toContain("body/receipt count mismatch");
    // Fail closed: no package minted. Round-6 A3: seeding drove the terminal checkpoint, so the
    // session is terminal_success; the body/receipt count mismatch (errored) is caught after the gate.
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("terminal_success");
  });
});
