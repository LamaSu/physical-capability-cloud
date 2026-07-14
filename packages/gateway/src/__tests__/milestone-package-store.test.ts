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
import { createStore, type Store } from "@pcc/store";
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
  ): string[] {
    const seq = new SessionSequenceStore();
    const receiptStore = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      checkpointBodies: store.repos.checkpointBodies,
      sequenceStore: seq,
      signer,
    });
    let prev: string | null = null;
    const hashes: string[] = [];
    const n = eventsPerCheckpoint.length;
    eventsPerCheckpoint.forEach((events, i) => {
      const seqNum = i + 1;
      const eventsRoot = canonicalSha256(events);
      const checkpointType = i === n - 1 ? terminalType : "workflow_step_completed";
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
      expect(r.package.receiptIds).toHaveLength(3);
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

  it("finalize past the evidence deadline -> rejected evidence_deadline_passed (session stays open)", () => {
    openSession(); // deadline = NOW + 86400
    seedChain([[{ a: 1 }]]);
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 86_401 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("evidence_deadline_passed");
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("open");
  });

  it("a revealed payload matching the receipted eventsRoot is accepted and rides in the package", () => {
    openSession();
    const events0 = [{ step: "start", ts: 1 }];
    seedChain([events0, [{ b: 2 }]]);
    const r = pkgStore().finalize({
      jobId: JOB,
      milestoneIndex: MI,
      now: NOW + 100,
      payloads: [{ seq: 1, events: events0 }],
    });
    expect(r.status).toBe("finalized");
    if (r.status === "finalized") {
      expect(r.package.payloads).toEqual([{ seq: 1, events: events0 }]);
    }
  });

  it("a revealed payload that does NOT hash to the receipted eventsRoot -> rejected payload_commitment_mismatch", () => {
    openSession();
    seedChain([[{ a: 1 }], [{ b: 2 }]]);
    const r = pkgStore().finalize({
      jobId: JOB,
      milestoneIndex: MI,
      now: NOW + 100,
      payloads: [{ seq: 1, events: [{ tampered: true }] }],
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("payload_commitment_mismatch");
    // Fail closed: no package, session unchanged.
    expect(store.repos.milestonePackages.findByJobMilestone(JOB, MI)).toBeUndefined();
    expect(store.repos.evidenceSessions.findByJobMilestone(JOB, MI)?.status).toBe("open");
  });

  it("finalize with zero accepted checkpoints -> rejected no_checkpoints", () => {
    openSession(); // session open, but no receipts recorded
    const r = pkgStore().finalize({ jobId: JOB, milestoneIndex: MI, now: NOW + 100 });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("no_checkpoints");
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
});
