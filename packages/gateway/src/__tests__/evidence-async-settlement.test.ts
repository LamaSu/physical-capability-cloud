/**
 * §8.5 step 6 / §2.4 — package-anchored settlement. Proves the async evidence
 * split (begin → checkpoints → finalize) hands off to the EXISTING
 * `PUT /api/jobs/:jobId/complete` money path, which gains ONE additive branch:
 * when a finalized FinalMilestonePackage exists it anchors settlement on the
 * package's content hash (packageHash) and serves the canonical package bytes at
 * GET /api/evidence/:packageHash — otherwise the legacy synthesized-envelope path
 * is byte-identical.
 *
 * Four scenarios:
 *   1. legacy zero-diff — /complete with NO package settles exactly as before.
 *   2. full async happy path — begin → N checkpoints → finalize → /complete
 *      anchors on packageHash (no gateway placeholder signature in the served
 *      settlement evidence).
 *   3. long-job (the §8.1-#1 acceptance test / TTL-bug regression) — the
 *      execution window elapses AFTER the last checkpoint but BEFORE
 *      finalize+/complete; finalize still succeeds (deadline = window 3) and
 *      /complete still settles on the package.
 *   4. serve bytes — GET /api/evidence/:packageHash re-hashes to packageHash;
 *      an unknown hash fails closed → 404.
 *
 * Real Ed25519 throughout (crypto harness mirrors evidence-async.test.ts). All
 * external calls (IPFS, blockchain) mocked; MOCK_SETTLEMENT=true; no oracle key
 * (mock oracle verifies tier 0). No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { canonicalize } from "@pcc/spec";
import { SessionKeyService } from "@pcc/verifier";
import { schema } from "@pcc/store";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { evidenceAsyncRoutes } from "../routes/evidence-async.js";
import { settlementRoutes } from "../routes/settlement.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { sessionSequenceStore } from "../services/session-sequence-store.js";
import { sessionRevocationStore } from "../services/session-revocation-store.js";
import { resetSettlementService } from "../services/settlement-service.js";

// ── Mocks (mirror paid-job-flow.test.ts — no real IPFS/chain I/O) ──────────────

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// The /complete flow does best-effort archive + oracle I/O (all mock/fallback
// here); give the suite headroom so it does not flake on timing.
vi.setConfig({ testTimeout: 20000 });

// ── Crypto harness (mirrors evidence-async.test.ts) ────────────────────────────

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ACTIONS = ["execution_started", "workflow_step_completed", "execution_completed"];

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  delete process.env.PCC_ORACLE_KEY; // mock oracle (verifies tier 0, refuses tier >= 1)
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(evidenceAsyncRoutes);
  await app.register(settlementRoutes);
  await app.ready();
  return app;
}

/** Issue a job-scoped delegation from a principal (the kernel's registered signer). */
function issueDelegation(
  principal: nacl.SignKeyPair,
  jobId: string,
  opts?: { ttlSeconds?: number; allowedActions?: string[]; maxSignatures?: number },
) {
  const { sessionKey, sessionPrivateKey } = new SessionKeyService().issueSessionKey({
    principal: {
      agentId: "eip155:84532:0x0000000000000000000000000000000000000001",
      walletAddress: "0x0000000000000000000000000000000000000001",
      publicKey: principal.publicKey,
    } as never,
    principalPrivateKey: principal.secretKey,
    scope: {
      allowedActions: (opts?.allowedActions ?? ACTIONS) as never,
      contractIds: [jobId],
      maxSignatures: opts?.maxSignatures ?? 100,
    },
    ttlSeconds: opts?.ttlSeconds ?? 300,
  });
  return { sessionKey, sessionPrivateKey, authorization: toAuthorization(sessionKey) };
}

function toAuthorization(sk: {
  sessionId: string;
  parentAgentId: string;
  publicKey: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  scope: { allowedActions: readonly string[]; contractIds: readonly string[]; maxSignatures: number };
  parentSignature: Uint8Array;
  derivationPath?: string;
}) {
  return {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: `0x${toHex(sk.publicKey)}`,
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions],
      contractIds: [...sk.scope.contractIds],
      maxSignatures: sk.scope.maxSignatures,
    },
    parentSignature: `0x${toHex(sk.parentSignature)}`,
    ...(sk.derivationPath ? { derivationPath: sk.derivationPath } : {}),
  };
}

/** Seed a kernel (registered ed25519 signer) + job + committed negotiation (tier + window). */
function seedJob(
  jobId: string,
  registeredPublicKey: Uint8Array,
  opts?: { status?: string; contractTerms?: Record<string, unknown> },
) {
  const { db } = getStore();
  const kernelId = `kernel-${jobId}`;
  const nowIso = new Date().toISOString();
  db.insert(schema.shopKernels)
    .values({
      id: kernelId,
      name: "Test Kernel",
      operatorAddress: "op@test",
      location: { lat: 0, lng: 0 },
      physicalAddress: "test",
      maxAssuranceTier: 3,
      publicKey: "legacy-random",
      signingKeyAlgorithm: "ed25519",
      signingKeyPublicKey: `0x${toHex(registeredPublicKey)}`,
      reputation: 0,
      totalJobsCompleted: 0,
      status: "online",
      registeredAt: nowIso,
      lastHeartbeat: nowIso,
      version: "1.0.0",
    })
    .run();
  db.insert(schema.jobs)
    .values({
      id: jobId,
      stepId: "step-1",
      cwmId: "cwm-1",
      capabilityId: "cap-1",
      kernelId,
      status: opts?.status ?? "executing",
      assignedDevices: [],
      progress: 0,
    })
    .run();
  db.insert(schema.negotiationSessions)
    .values({
      id: `neg-${jobId}`,
      status: "committed",
      userAgentId: "user-1",
      kernelId,
      capabilityType: "test",
      selections: {},
      operatorConstraints: {},
      contractTerms:
        opts?.contractTerms ?? {
          executionWindowSeconds: 3600,
          evidenceDeadlineSeconds: 86400,
          assuranceTier: 0,
        },
      jobId,
      transitions: [],
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    .run();
  return { kernelId };
}

/** Sign a checkpoint over the byte-identical canonical content the route recomputes. */
function signCheckpoint(params: {
  sessionId: string;
  seq: number;
  createdAt: number;
  prevCheckpointHash: string | null;
  events: unknown[];
  checkpointType: string;
  sessionPrivateKey: Uint8Array;
}) {
  const eventsRoot = `sha256:${createHash("sha256").update(canonicalize(params.events)).digest("hex")}`;
  const content = {
    sessionId: params.sessionId,
    seq: params.seq,
    createdAt: params.createdAt,
    prevCheckpointHash: params.prevCheckpointHash,
    eventsRoot,
    checkpointType: params.checkpointType,
  };
  const canonical = canonicalize(content);
  const signature = toHex(nacl.sign.detached(new TextEncoder().encode(canonical), params.sessionPrivateKey));
  const checkpointHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  return {
    eventsRoot,
    checkpointHash,
    body: {
      sessionId: params.sessionId,
      seq: params.seq,
      createdAt: params.createdAt,
      prevCheckpointHash: params.prevCheckpointHash,
      eventsRoot,
      checkpointType: params.checkpointType,
      signature,
    },
  };
}

let jobCounter = 0;
const freshJobId = () => `job-w3b-${++jobCounter}`;

describe("evidence async → settlement (§2.4 package-anchored /complete)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sessionSequenceStore.clear();
    sessionRevocationStore.clear();
    resetSettlementService();
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    closeStore();
    resetSettlementService();
  });

  /** begin + accept N checkpoints against a fresh tier-0 job; returns context. */
  async function beginAndAccept(
    count: number,
    opts?: { contractTerms?: Record<string, unknown> },
  ) {
    const jobId = freshJobId();
    const principal = nacl.sign.keyPair();
    seedJob(jobId, principal.publicKey, opts?.contractTerms ? { contractTerms: opts.contractTerms } : undefined);
    const del = issueDelegation(principal, jobId);
    const beginRes = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/evidence/begin`,
      payload: { sessionKeyAuthorization: del.authorization },
    });
    expect(beginRes.statusCode).toBe(201);
    const sessionId: string = beginRes.json().sessionId;
    const now = Math.floor(Date.now() / 1000);
    const hashes: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < count; i++) {
      // Last checkpoint is the terminal completion — finalize now requires it (§8.1-#1).
      const checkpointType = i === count - 1 ? "execution_completed" : ACTIONS[i % ACTIONS.length];
      const cp = signCheckpoint({
        sessionId,
        seq: i + 1,
        createdAt: now,
        prevCheckpointHash: prev,
        events: [{ i }],
        checkpointType,
        sessionPrivateKey: del.sessionPrivateKey,
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/checkpoints`,
        payload: cp.body,
      });
      expect(res.statusCode).toBe(201);
      prev = cp.checkpointHash;
      hashes.push(cp.checkpointHash);
    }
    return { jobId, sessionId, del, hashes };
  }

  /** finalize a session and return its packageHash. */
  async function finalize(jobId: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
    expect(res.statusCode).toBe(201);
    return res.json().packageHash as string;
  }

  // ── 1. legacy zero-diff ──────────────────────────────────────────────────────
  it("legacy zero-diff: /complete with NO finalized package settles exactly as before", async () => {
    const jobId = freshJobId();
    const principal = nacl.sign.keyPair();
    seedJob(jobId, principal.publicKey); // tier 0, status "executing", NO async flow

    // Precondition: no package exists → the legacy synthesized-envelope branch runs.
    expect(getRepos().milestonePackages.findByJobMilestone(jobId, 0)).toBeUndefined();

    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled"); // same outcome as the existing legacy /complete test
    expect(body.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The settlement anchored on the gateway envelope hash (no package), and the
    // stored evidence bundle carries exactly that hash — legacy behavior intact.
    const stored = getStore().repos.evidence.findByHash(body.evidenceHash);
    expect(stored?.bundleHash).toBe(body.evidenceHash);
    // No package was ever created for this job.
    expect(getRepos().milestonePackages.findByJobMilestone(jobId, 0)).toBeUndefined();
  });

  // ── 2. full async happy path ────────────────────────────────────────────────
  it("full async happy path: begin → checkpoints → finalize → /complete anchors on packageHash", async () => {
    const { jobId, hashes } = await beginAndAccept(3);
    const packageHash = await finalize(jobId);
    expect(packageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The job is finalized (async terminal), but NOT in /complete's claim-exclusion set.
    expect(getStore().repos.jobs.findById(jobId)?.status).toBe("evidence_finalized");

    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled");
    // Settlement ANCHORED ON the package's content hash — NOT a synthesized envelope.
    expect(body.evidenceHash).toBe(packageHash);
    expect(body.oracleVerified).toBe(true);

    // The stored settlement bundle uses packageHash as its anchor.
    const stored = getStore().repos.evidence.findByHash(packageHash);
    expect(stored?.bundleHash).toBe(packageHash);

    // The SERVED settlement evidence is the claim-free package (no gateway placeholder
    // signature in it), and its raw bytes re-hash to packageHash (the oracle contract).
    const serve = await app.inject({ method: "GET", url: `/api/evidence/${packageHash}` });
    expect(serve.statusCode).toBe(200);
    expect(`sha256:${createHash("sha256").update(serve.body).digest("hex")}`).toBe(packageHash);
    const servedPkg = JSON.parse(serve.body);
    expect(servedPkg.acceptedCheckpointHashes).toEqual(hashes);
    expect(servedPkg).not.toHaveProperty("kernelSignature");
    expect(servedPkg).not.toHaveProperty("assuranceTier");
    expect(serve.body).not.toContain("gateway-auto-sign");
    expect(serve.body).not.toContain("0x0000000000000000000000000000000000000000");
  });

  // ── P0-1 (round-6): sticky step-6 — opening a session disables the legacy fallback ─────
  it("sticky step-6: begin an async session then /complete WITHOUT finalizing → 409 evidence_not_finalized (no legacy bypass)", async () => {
    const { jobId } = await beginAndAccept(3); // opens a session, accepts the terminal checkpoint
    // No finalize → no package. The legacy synthesized-envelope fallback MUST be unreachable now:
    // a job that entered the async evidence flow cannot settle on the placeholder envelope (that
    // would bypass the terminal-completion requirement, the package receipt, and the accepted chain).
    expect(getRepos().milestonePackages.findByJobMilestone(jobId, 0)).toBeUndefined();
    expect(getRepos().evidenceSessions.findByJobMilestone(jobId, 0)).toBeDefined();

    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("evidence_not_finalized");
    // The guard runs BEFORE the completion claim, so the job is neither stranded in `completing`
    // nor settled via the bypass.
    expect(getStore().repos.jobs.findById(jobId)?.status).not.toBe("settled");
    expect(getStore().repos.jobs.findById(jobId)?.status).not.toBe("completing");

    // And it CAN still finalize + settle afterward — the guard blocks ONLY the bypass, not the
    // legitimate package path.
    await finalize(jobId);
    const ok = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("settled");
  });

  // ── P0 (round-6): idempotent finalize must be lifecycle-MONOTONIC (no settlement rerun) ─────
  it("P0: an idempotent finalize on a SETTLED job does NOT roll status back to evidence_finalized", async () => {
    const { jobId } = await beginAndAccept(2);
    await finalize(jobId);
    const settle = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(settle.statusCode).toBe(200);
    expect(settle.json().status).toBe("settled");
    expect(getStore().repos.jobs.findById(jobId)?.status).toBe("settled");

    // Repeat finalize (permissionless + idempotent — the package already exists) reaches the store
    // and returns idempotent. The status reconcile MUST be monotonic: `settled` stays `settled`.
    const refin = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
    expect(refin.statusCode).toBe(200);
    expect(refin.json().idempotent).toBe(true);
    expect(getStore().repos.jobs.findById(jobId)?.status).toBe("settled"); // NOT rewound

    // Therefore a second /complete cannot re-claim + re-run settlement.
    const resettle = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(resettle.statusCode).toBe(409);
  });

  // ── 3. long-job (§8.1-#1 acceptance test / TTL-bug regression) ───────────────
  it("long-job: execution window elapses after last checkpoint, before finalize+/complete — still settles on the package", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    // window 2 (execution) = 600s; window 3 (evidence deadline) = 100000s. The
    // 300s delegation fits inside window 2, so begin + checkpoints pass at ~t0.
    const { jobId, hashes } = await beginAndAccept(2, {
      contractTerms: { executionWindowSeconds: 600, evidenceDeadlineSeconds: 100_000, assuranceTier: 0 },
    });

    // Advance the gateway clock PAST the execution window (t0+600) but BEFORE the
    // evidence deadline (t0+100000) — the exact scenario the old TTL clamp rejected.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((t0 + 50_000) * 1000);

    // finalize STILL succeeds — its deadline is window 3, not the elapsed window 2.
    const finRes = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
    expect(finRes.statusCode).toBe(201);
    const packageHash: string = finRes.json().packageHash;

    // /complete STILL settles — on the package.
    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    vi.useRealTimers();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled");
    expect(body.evidenceHash).toBe(packageHash);
    expect(finRes.json().package.acceptedCheckpointHashes).toEqual(hashes);
  });

  // ── 4. serve bytes ──────────────────────────────────────────────────────────
  it("serve bytes: GET /api/evidence/:packageHash re-hashes to packageHash; unknown → 404", async () => {
    const { jobId } = await beginAndAccept(2);
    const packageHash = await finalize(jobId);

    const serve = await app.inject({ method: "GET", url: `/api/evidence/${packageHash}` });
    expect(serve.statusCode).toBe(200);
    // Raw response bytes re-hash to the committed packageHash (oracle fetch-and-verify).
    expect(`sha256:${createHash("sha256").update(serve.body).digest("hex")}`).toBe(packageHash);
    // Also resolvable via the 0x-prefixed on-chain hash form.
    const hex = packageHash.slice("sha256:".length);
    const serve0x = await app.inject({ method: "GET", url: `/api/evidence/0x${hex}` });
    expect(serve0x.statusCode).toBe(200);
    expect(serve0x.body).toBe(serve.body);

    // Unknown hash → fail closed (no package, no bundle, no job) → 404.
    const unknown = await app.inject({ method: "GET", url: `/api/evidence/sha256:${"a".repeat(64)}` });
    expect(unknown.statusCode).toBe(404);
  });

  // ── B4 (round-5 M1): direct settlement_hold guard tests ──────────────────────
  // A job in the terminal `settlement_hold` state (paid-job-flow parks it there when settlement fails
  // with the escrow funded but no resolution) is excluded from the /complete atomic claim and is
  // evidence-uncollectable. The guard existed but had no direct test. Seed the state directly — inducing
  // the fail-then-hold path needs a specific mocked-settlement failure, orthogonal to the guard.
  it("B4: a settlement_hold job → /complete → 409 (the atomic claim excludes settlement_hold)", async () => {
    const jobId = freshJobId();
    const principal = nacl.sign.keyPair();
    seedJob(jobId, principal.publicKey);
    getStore().repos.jobs.update(jobId, { status: "settlement_hold" });
    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(409);
    // The held job is NOT re-claimed → status unchanged (never flipped to 'completing').
    expect(getStore().repos.jobs.findById(jobId)?.status).toBe("settlement_hold");
  });

  it("B4: concurrent /complete on a settlement_hold job → BOTH 409 (the hold guard is race-safe)", async () => {
    const jobId = freshJobId();
    const principal = nacl.sign.keyPair();
    seedJob(jobId, principal.publicKey);
    getStore().repos.jobs.update(jobId, { status: "settlement_hold" });
    const [a, b] = await Promise.all([
      app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} }),
      app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} }),
    ]);
    // The atomic claim excludes settlement_hold, so neither call can win it — both 409, no double-run.
    expect(a.statusCode).toBe(409);
    expect(b.statusCode).toBe(409);
    expect(getStore().repos.jobs.findById(jobId)?.status).toBe("settlement_hold");
  });

  it("B4: an open-session job that goes to settlement_hold → a new checkpoint AND finalize are rejected", async () => {
    const jobId = freshJobId();
    const principal = nacl.sign.keyPair();
    seedJob(jobId, principal.publicKey);
    const del = issueDelegation(principal, jobId);
    const beginRes = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/evidence/begin`,
      payload: { sessionKeyAuthorization: del.authorization },
    });
    expect(beginRes.statusCode).toBe(201);
    const sessionId: string = beginRes.json().sessionId;
    // Accept ONE non-terminal checkpoint so the session stays OPEN (execution_started never terminalizes).
    const now = Math.floor(Date.now() / 1000);
    const c1 = signCheckpoint({ sessionId, seq: 1, createdAt: now, prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
    expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c1.body })).statusCode).toBe(201);

    // The job goes to settlement_hold out-of-band while its session is still open.
    getStore().repos.jobs.update(jobId, { status: "settlement_hold" });

    // A NEW checkpoint is rejected by the item-1 job-lifecycle gate (settlement_hold is uncollectable).
    const c2 = signCheckpoint({ sessionId, seq: 2, createdAt: now, prevCheckpointHash: c1.checkpointHash, events: [{ b: 2 }], checkpointType: "execution_completed", sessionPrivateKey: del.sessionPrivateKey });
    const cpRes = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c2.body });
    expect(cpRes.statusCode).toBe(409);
    expect(cpRes.json().error).toBe("job_not_evidence_collectable");

    // And a NEW finalize is rejected by the same lifecycle gate (no package exists yet).
    const finRes = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
    expect(finRes.statusCode).toBe(409);
    expect(finRes.json().error).toBe("job_not_evidence_collectable");
  });
});
