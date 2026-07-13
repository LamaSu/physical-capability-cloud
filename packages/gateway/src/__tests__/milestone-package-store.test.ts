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
   * Seed an accepted checkpoint chain (seq 1..N) for SESSION_ID: record the
   * transactional receipt AND insert the matching checkpoint_bodies row (the route
   * writes the body after the receipt, §2.2 step 7). `eventsPerCheckpoint[i]` is the
   * events array committed by checkpoint i; body.eventsRoot = canonicalSha256(events).
   * Returns the accepted checkpoint hashes in seq order.
   */
  function seedChain(eventsPerCheckpoint: unknown[][]): string[] {
    const seq = new SessionSequenceStore();
    const receiptStore = new GatewayReceiptStore({
      db: store.db,
      repo: store.repos.gatewayReceipts,
      sequenceStore: seq,
      signer,
    });
    let prev: string | null = null;
    const hashes: string[] = [];
    eventsPerCheckpoint.forEach((events, i) => {
      const seqNum = i + 1;
      const eventsRoot = canonicalSha256(events);
      // checkpointHash: server-computed sha256 over the canonical checkpoint content.
      const checkpointHash = canonicalSha256({
        sessionId: SESSION_ID,
        seq: seqNum,
        eventsRoot,
        prevCheckpointHash: prev,
        checkpointType: "workflow_step_completed",
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
      });
      expect(res.status).toBe("accepted");
      store.repos.checkpointBodies.insert({
        id: `ckpt-${SESSION_ID}-${seqNum}`,
        sessionId: SESSION_ID,
        seq: seqNum,
        jobId: JOB,
        checkpointHash,
        prevCheckpointHash: prev,
        eventsRoot,
        checkpointType: "workflow_step_completed",
        deviceCreatedAt: NOW,
        signature: `sig-${seqNum}`,
        payload: null,
        createdAt: new Date((NOW + i) * 1000).toISOString(),
      });
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
});
