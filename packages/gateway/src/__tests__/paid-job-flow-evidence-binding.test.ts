/**
 * LO-EV-9 at the real settlement seam: PUT /api/jobs/:jobId/complete with the
 * SEAM-2 gate forced open.
 *
 * The device rows are written the way the operator relay stores a signed bundle
 * (bundle row + its events). A genuine bundle for job A, stored again under
 * job B, must not anchor job B's settlement; the same bundle under job A must.
 * A bundle from kernel-nyc must not anchor a job kernel-sf accepted.
 *
 * External I/O is mocked exactly as in paid-job-flow.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { hashBundle, hashEvent, signingPreimage, type EvidenceEvent } from "@pcc/spec";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos } from "../db.js";

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

// Open the gate for this file only. Everything else in the module is real:
// the candidate selection, the subject binding and the Ed25519 verify.
vi.mock("../services/device-evidence-settlement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/device-evidence-settlement.js")>();
  return { ...actual, deviceEvidenceSettlementEnabled: () => true };
});

vi.setConfig({ testTimeout: 20000 });

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function createJob(app: FastifyInstance, kernelId: string, userAgentId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

function registerKey(kernelId: string, keyPair: nacl.SignKeyPair) {
  getRepos().kernels.update(kernelId, {
    signingKeyAlgorithm: "ed25519",
    signingKeyPublicKey: `0x${toHex(keyPair.publicKey)}`,
  });
}

/** A node-signed bundle whose events commit `jobId` and `kernelId`. */
async function signedBundle(jobId: string, kernelId: string, keyPair: nacl.SignKeyPair) {
  const source = { deviceId: `${kernelId}-ot2`, deviceType: "controller" as const, kernelId };
  const raw: Array<Omit<EvidenceEvent, "id" | "hash">> = [
    { type: "execution_started", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId, kernelId } },
    { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { jobId, kernelId } },
  ];
  const events: EvidenceEvent[] = await Promise.all(
    raw.map(async (e, i) => ({ ...e, id: `node-ev-${i}`, hash: await hashEvent(e) })),
  );
  const bundleHash = await hashBundle(events);
  const kernelSignature = {
    signer: `0x${toHex(keyPair.publicKey).slice(0, 40)}`,
    algorithm: "ed25519",
    value: toHex(nacl.sign.detached(signingPreimage(bundleHash), keyPair.secretKey)),
  };
  return { events, bundleHash, kernelSignature };
}

let rowSeq = 0;

/** Store a relayed device bundle under `jobId`, as the operator relay does:
 *  the bundle row plus its events, with bundle-scoped event ids. */
function storeRelayedBundle(
  jobId: string,
  kernelId: string,
  bundle: Awaited<ReturnType<typeof signedBundle>>,
) {
  const repos = getRepos();
  const bundleId = `ev-relayed-${++rowSeq}`;
  repos.evidence.insert({
    id: bundleId,
    jobId,
    stepId: "operator-relay",
    kernelId,
    assuranceTier: 0,
    bundleHash: bundle.bundleHash,
    kernelSignature: bundle.kernelSignature,
    createdAt: new Date().toISOString(),
  });
  repos.evidence.insertEvents(
    bundle.events.map((ev) => ({
      id: `${bundleId}:${ev.id}`,
      bundleId,
      type: ev.type,
      timestamp: ev.timestamp,
      source: ev.source,
      payload: ev.payload,
      hash: ev.hash,
    })),
  );
}

async function complete(app: FastifyInstance, jobId: string) {
  const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json() as { status: string; evidenceHash: string };
}

describe("LO-EV-9 — /complete binds device evidence to the accepted job and kernel", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("evidence from job A cannot settle job B; it still settles job A", async () => {
    const node = nacl.sign.keyPair();
    registerKey("kernel-nyc", node);
    const jobA = await createJob(app, "kernel-nyc", "user-agent-bind-a");
    const jobB = await createJob(app, "kernel-nyc", "user-agent-bind-b");

    const bundleA = await signedBundle(jobA, "kernel-nyc", node);
    storeRelayedBundle(jobA, "kernel-nyc", bundleA);
    storeRelayedBundle(jobB, "kernel-nyc", bundleA); // the replay

    const settledB = await complete(app, jobB);
    expect(settledB.status).toBe("settled");
    expect(settledB.evidenceHash).not.toBe(bundleA.bundleHash);

    const settledA = await complete(app, jobA);
    expect(settledA.evidenceHash).toBe(bundleA.bundleHash);
  });

  it("evidence for kernel-nyc cannot settle a job kernel-sf accepted", async () => {
    const nyc = nacl.sign.keyPair();
    const sf = nacl.sign.keyPair();
    registerKey("kernel-nyc", nyc);
    registerKey("kernel-sf", sf);
    const jobSf = await createJob(app, "kernel-sf", "user-agent-bind-sf");

    // Committed to this job, but by kernel-nyc and signed with its key.
    const fromNyc = await signedBundle(jobSf, "kernel-nyc", nyc);
    storeRelayedBundle(jobSf, "kernel-nyc", fromNyc);

    const settled = await complete(app, jobSf);
    expect(settled.evidenceHash).not.toBe(fromNyc.bundleHash);
  });

  it("a replayed row stored first does not hide the job's genuine bundle", async () => {
    const node = nacl.sign.keyPair();
    registerKey("kernel-nyc", node);
    const jobA = await createJob(app, "kernel-nyc", "user-agent-order-a");
    const jobB = await createJob(app, "kernel-nyc", "user-agent-order-b");

    const bundleA = await signedBundle(jobA, "kernel-nyc", node);
    const bundleB = await signedBundle(jobB, "kernel-nyc", node);
    storeRelayedBundle(jobB, "kernel-nyc", bundleA); // replay lands first
    storeRelayedBundle(jobB, "kernel-nyc", bundleB);

    const settled = await complete(app, jobB);
    expect(settled.evidenceHash).toBe(bundleB.bundleHash);
  });
});
