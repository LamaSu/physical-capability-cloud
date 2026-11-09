import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import { SEED_OPERATORS } from "./helpers/job-read-party.js";

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

vi.setConfig({ testTimeout: 20000 });

const ADMIN = randomUUID();
const BUYER = "0x5555555555555555555555555555555555555555";
const STRANGER = "0x6666666666666666666666666666666666666666";
const OTHER_BUYER = "0x7777777777777777777777777777777777777777";
const OPERATOR = SEED_OPERATORS["kernel-nyc"];
const asAdmin = { "x-admin-key": ADMIN };
const proven = (wallet: string, carrier = "key") => ({
  "x-test-principal": wallet,
  "x-test-proven-wallet": wallet,
  "x-test-carrier": carrier,
});

function ensurePricedLiquidHandler(kernelId: string): void {
  const capabilities = getRepos().capabilities;
  if (capabilities.findByKernel(kernelId).some((c: { type: string }) => c.type === "liquid-handler")) return;
  capabilities.insert({
    id: `cap-liquid-handler-${kernelId}`,
    kernelId,
    type: "liquid-handler",
    name: "liquid-handler test capability",
    description: "test",
    materials: [],
    tolerances: {},
    envelope: { x: 1, y: 1, z: 1, unit: "mm" as const },
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "10.00", minimum: "0.01" } as never,
    availability: {},
    location: { lat: 40.7, lng: -74 },
  } as never);
}

async function createJob(app: FastifyInstance, kernelId = "kernel-nyc", userAgentId = BUYER) {
  ensurePricedLiquidHandler(kernelId);
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    headers: asAdmin,
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

function jobRow(jobId: string) {
  return getStore().db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
}

describe("the job-complete and resume-settlement routes accept only the job's parties", () => {
  let app: FastifyInstance;
  let savedAdminKey: string | undefined;
  let savedDbPath: string | undefined;
  let savedMockSettlement: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    savedAdminKey = process.env.PCC_ADMIN_KEY;
    savedDbPath = process.env.PCC_DB_PATH;
    savedMockSettlement = process.env.MOCK_SETTLEMENT;
    process.env.PCC_ADMIN_KEY = ADMIN;
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    initStore({ seed: true });

    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const principal = req.headers["x-test-principal"];
      if (typeof principal === "string") req.operatorId = principal;
      const wallet = req.headers["x-test-proven-wallet"];
      if (typeof wallet === "string") {
        req.provenWallet = wallet.toLowerCase();
        req.provenWalletVia = "siwe-session";
        req.provenWalletCarrier = (req.headers["x-test-carrier"] ?? "key") as typeof req.provenWalletCarrier;
      }
    });
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(jobRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedAdminKey;
    if (savedDbPath === undefined) delete process.env.PCC_DB_PATH;
    else process.env.PCC_DB_PATH = savedDbPath;
    if (savedMockSettlement === undefined) delete process.env.MOCK_SETTLEMENT;
    else process.env.MOCK_SETTLEMENT = savedMockSettlement;
  });

  function complete(jobId: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, headers, payload: {} });
  }

  function resume(jobId: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement`, headers, payload: {} });
  }

  it("C1 a proven wallet that is no party to the job gets the not-found reply and changes nothing", async () => {
    const jobId = await createJob(app);
    const before = jobRow(jobId);
    const res = await complete(jobId, proven(STRANGER));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Job not found" });
    expect(jobRow(jobId)).toEqual(before);
  });

  it("C2 a credential with no proven wallet is refused as unverified", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId, { "x-test-principal": STRANGER });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("identity_unverified");
  });

  it("C3 a request with no identity is refused as unauthenticated", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
  });

  it("C4 the job's buyer completes it", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId, proven(BUYER));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");
  });

  it("C5 the job's kernel operator completes it", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId, proven(OPERATOR));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");
  });

  it("C6 the admin completes it", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId, asAdmin);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");
  });

  it("C7 the buyer's sign-in cookie alone is refused and changes nothing", async () => {
    const jobId = await createJob(app);
    const before = jobRow(jobId);
    const res = await complete(jobId, proven(BUYER, "cookie"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(EXPLICIT_CREDENTIAL_REQUIRED);
    expect(jobRow(jobId)).toEqual(before);
  });

  it("C8 an unknown job gets the not-found reply, for the admin too", async () => {
    const res = await complete("job-does-not-exist", asAdmin);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Job not found" });
  });

  it("C9 a claimed identity equal to the kernel's operator, with no proof, is refused", async () => {
    const jobId = await createJob(app);
    const res = await complete(jobId, { "x-test-principal": OPERATOR });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("identity_unverified");
  });

  it("C10 a party of another job gets the not-found reply", async () => {
    const jobId = await createJob(app);
    await createJob(app, "kernel-sf", OTHER_BUYER);
    const res = await complete(jobId, proven(OTHER_BUYER));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Job not found" });
  });

  it("O a refused completion leaves the job row exactly as it was", async () => {
    const jobId = await createJob(app);
    const before = jobRow(jobId);
    expect(before).toBeDefined();
    await complete(jobId, proven(STRANGER));
    expect(jobRow(jobId)).toEqual(before);
  });

  it("R1 resume: a proven wallet that is no party gets the not-found reply", async () => {
    const jobId = await createJob(app);
    const res = await resume(jobId, proven(STRANGER));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Job not found" });
  });

  it("R2 resume: the job's buyer reaches the handler", async () => {
    const jobId = await createJob(app);
    const res = await resume(jobId, proven(BUYER));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/resumable/);
  });

  it("R3 resume: the admin reaches the handler", async () => {
    const jobId = await createJob(app);
    const res = await resume(jobId, asAdmin);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/resumable/);
  });

  it("R4 resume: the buyer's sign-in cookie alone is refused", async () => {
    const jobId = await createJob(app);
    const res = await resume(jobId, proven(BUYER, "cookie"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(EXPLICIT_CREDENTIAL_REQUIRED);
  });
});
