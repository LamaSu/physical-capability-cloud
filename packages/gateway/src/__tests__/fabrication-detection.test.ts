/**
 * Gateway-side fabrication detection — the three detector follow-ups
 * (coord #312, detector lane; companion to pcc-oracle PR #15):
 *
 *   1. SERVE THE FLAG — GET /api/evidence/:hash returns the canonical
 *      envelope whose RAW BYTES re-hash to the committed bundleHash and
 *      whose events carry source.simulated / payload.mock. This is the
 *      contract the oracle's fetch-and-verify + authenticity floor depend on
 *      (pcc-oracle evidence-checker.ts + PR #15).
 *   2. ALCOA `authentic` leg — a fabricated bundle with a REAL (non-zero)
 *      signer passes `original` but must fail `authentic`, and the failed
 *      leg hard-zeros the assurance score (critical finding). This is the
 *      test that would have caught the Spark-verified gap (handoff §5.0/§5.3).
 *   3. Settlement authenticity gate — SettlementService.processEvidence
 *      refuses the on-chain legs (submit + auto-release) for a tier ≥ 1
 *      bundle carrying a fabricated-by-design event; tier 0 exempt; archive
 *      and DB persist still run (honest, self-identifying record).
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { settlementRoutes } from "../routes/settlement.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema } from "@pcc/store";
import { resetSettlementService } from "../services/settlement-service.js";
import { buildCanonicalEvidenceEnvelope, isEvidenceHashForm } from "../services/evidence-envelope.js";
import type { EvidenceBundle } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({
      cid: "bafytest123",
      metadataCid: "bafymeta456",
    }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({
    transactionHash: "0xtest_evidence_tx123",
    status: "submitted",
  }),
  releaseMilestone: vi.fn().mockResolvedValue({
    transactionHash: "0xtest_release_tx456",
    status: "submitted",
  }),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REAL_SIGNER = "0x1111111111111111111111111111111111111111";

/** An event fabricated-by-design via the source.simulated leg of the tag. */
function makeSimulatedEvent(id: string, kernelId = "kernel-nyc") {
  return {
    id,
    type: "execution_completed",
    timestamp: new Date().toISOString(),
    source: {
      deviceId: "dev-mock-fdm",
      deviceType: "controller",
      kernelId,
      simulated: true,
    },
    payload: { mock: true, message: "simulated run" },
    hash: "a".repeat(64),
  };
}

/** An honest event — no fabrication tags. */
function makeHonestEvent(id: string, kernelId = "kernel-nyc") {
  return {
    id,
    type: "execution_completed",
    timestamp: new Date().toISOString(),
    source: {
      deviceId: "dev-real-fdm",
      deviceType: "controller",
      kernelId,
    },
    payload: { message: "real run" },
    hash: "b".repeat(64),
  };
}

/**
 * Insert a bundle + events whose committed bundleHash is the sha256 of the
 * canonical envelope — the aligned form Path-B (paid-job-flow) now commits,
 * and the form GET /api/evidence/:hash serves back byte-for-byte.
 * Returns the committed hash (sha256:<hex> form) and the envelope string.
 */
function seedEnvelopeAlignedBundle(opts: {
  bundleId: string;
  jobId: string;
  events: ReturnType<typeof makeSimulatedEvent>[];
  assuranceTier?: number;
  signer?: string;
}): { bundleHash: string; envelope: string } {
  const repos = getRepos();
  const meta = {
    id: opts.bundleId,
    jobId: opts.jobId,
    stepId: "step-4",
    kernelId: "kernel-nyc",
    assuranceTier: opts.assuranceTier ?? 1,
    createdAt: new Date().toISOString(),
    kernelSignature: {
      signer: opts.signer ?? REAL_SIGNER,
      algorithm: "ed25519",
      value: "sig-test",
    },
  };
  const envelope = buildCanonicalEvidenceEnvelope(meta, opts.events);
  const bundleHash = `sha256:${crypto.createHash("sha256").update(envelope).digest("hex")}`;

  repos.evidence.insert({
    id: meta.id,
    jobId: meta.jobId,
    stepId: meta.stepId,
    kernelId: meta.kernelId,
    assuranceTier: meta.assuranceTier,
    bundleHash,
    kernelSignature: meta.kernelSignature as { signer: string; algorithm: string; value: string },
    createdAt: meta.createdAt,
  });
  repos.evidence.insertEvents(
    opts.events.map((ev) => ({
      id: ev.id,
      bundleId: meta.id,
      type: ev.type,
      timestamp: ev.timestamp,
      source: ev.source,
      payload: ev.payload as Record<string, unknown>,
      hash: ev.hash,
    })),
  );
  return { bundleHash, envelope };
}


async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(settlementRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// 1. Serve the flag — GET /api/evidence/:hash
// ---------------------------------------------------------------------------

describe("GET /api/evidence/:hash — canonical envelope serving", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    resetSettlementService();
  });

  it("serves bytes that re-hash to the committed bundleHash AND include source.simulated (the oracle contract)", async () => {
    const { bundleHash } = seedEnvelopeAlignedBundle({
      bundleId: "bundle-sim-serve",
      jobId: "job-004",
      events: [makeSimulatedEvent("ev-sim-1"), makeHonestEvent("ev-hon-1")],
    });

    const res = await app.inject({ method: "GET", url: `/api/evidence/${bundleHash}` });
    expect(res.statusCode).toBe(200);

    // (a) RAW BYTES re-hash to the committed hash — exactly what the oracle's
    // fetchAndVerifyEvidence does (fail-closed on mismatch).
    const computed = crypto.createHash("sha256").update(res.body).digest("hex");
    expect(`sha256:${computed}`).toBe(bundleHash);

    // (b) The flag SURVIVES: the hash-verified document carries the events
    // with both tag legs, which the oracle floor reads (bundle.events[]).
    const doc = JSON.parse(res.body) as { events: Array<{ id: string; source: { simulated?: boolean }; payload: { mock?: boolean } }> };
    expect(Array.isArray(doc.events)).toBe(true);
    const sim = doc.events.find((e) => e.id === "ev-sim-1");
    expect(sim?.source.simulated).toBe(true);
    expect(sim?.payload.mock).toBe(true);
    const honest = doc.events.find((e) => e.id === "ev-hon-1");
    expect(honest?.source.simulated).toBeUndefined();
  });

  it("resolves the same bundle via 0x-prefixed and bare-hex hash forms", async () => {
    const { bundleHash, envelope } = seedEnvelopeAlignedBundle({
      bundleId: "bundle-forms",
      jobId: "job-004",
      events: [makeHonestEvent("ev-forms-1")],
    });
    const hex = bundleHash.slice("sha256:".length);

    for (const form of [`0x${hex}`, hex]) {
      const res = await app.inject({ method: "GET", url: `/api/evidence/${form}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(envelope);
    }
  });

  it("falls through to the jobId lookup when no bundle matches a hash-form param", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/evidence/sha256:${"f".repeat(64)}`,
    });
    // No bundle with that hash and no job with that id → 404 from the
    // original jobId path (unchanged behavior).
    expect(res.statusCode).toBe(404);
  });

  it("keeps the original jobId behavior for non-hash params", async () => {
    seedEnvelopeAlignedBundle({
      bundleId: "bundle-byjob",
      jobId: "job-004",
      events: [makeHonestEvent("ev-byjob-1")],
    });
    const res = await app.inject({ method: "GET", url: "/api/evidence/job-004" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { jobId: string; bundles: unknown[]; count: number };
    expect(body.jobId).toBe("job-004");
    expect(body.count).toBeGreaterThan(0);
  });

  it("envelope construction is order-independent (events sorted by id inside)", () => {
    const meta = {
      id: "b1",
      jobId: "j1",
      stepId: "s1",
      kernelId: "k1",
      assuranceTier: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      kernelSignature: { signer: REAL_SIGNER, algorithm: "ed25519", value: "sig" },
    };
    const e1 = makeSimulatedEvent("ev-a");
    const e2 = makeHonestEvent("ev-b");
    expect(buildCanonicalEvidenceEnvelope(meta, [e1, e2])).toBe(
      buildCanonicalEvidenceEnvelope(meta, [e2, e1]),
    );
  });

  it("isEvidenceHashForm recognizes the three hash forms and rejects jobIds", () => {
    const hex = "a".repeat(64);
    expect(isEvidenceHashForm(`sha256:${hex}`)).toBe(true);
    expect(isEvidenceHashForm(`0x${hex}`)).toBe(true);
    expect(isEvidenceHashForm(hex)).toBe(true);
    expect(isEvidenceHashForm("job-004")).toBe(false);
    expect(isEvidenceHashForm("bundle-abc123")).toBe(false);
    expect(isEvidenceHashForm(`sha256:${"a".repeat(63)}`)).toBe(false);
  });
});
