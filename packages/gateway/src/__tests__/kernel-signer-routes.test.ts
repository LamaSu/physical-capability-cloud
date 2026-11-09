import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    startSpan: vi.fn().mockImplementation(async (_o: unknown, cb: () => Promise<unknown>) => cb()),
    startSpanManual: vi.fn().mockImplementation((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: vi.fn() });
    }),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
    init: vi.fn(),
    withScope: vi.fn().mockImplementation((cb: (s: object) => void) => cb({ setTag: vi.fn(), setExtra: vi.fn() })),
  },
}));

vi.mock("../sse/stream-hub.js", () => ({
  streamHub: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

// Storage + chain are only reached on the success path; mock them so importing
// kernel-service → settlement-service has no import-time side effects.
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_safety" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_safety_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xks_safety_evidence" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xks_safety_release" }),
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
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));


import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { JobRunner, resetSafetyGateway } from "@pcc/kernel";
import { setupRoutes } from "../routes/setup.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { getKernelService, KernelService, resetKernelService } from "../services/kernel-service.js";
import { pipelineTelemetry } from "../telemetry.js";

const { service } = vi.hoisted(() => ({
  service: {
    kernelId: "kernel-n104-setup",
    hasExplicitConfig: true,
    usesTestSigner: true,
    hasRunner: vi.fn().mockReturnValue(true),
    listDevices: vi.fn(),
    refreshDeviceFromDb: vi.fn(),
    submitJob: vi.fn(),
    getJobStatus: vi.fn().mockResolvedValue({ status: "completed", progress: 100 }),
    jobRanSimulated: vi.fn().mockReturnValue(false),
  },
}));
vi.mock("../services/kernel-service.js", async (importActual) => ({
  ...await importActual<typeof import("../services/kernel-service.js")>(),
  getKernelService: vi.fn(() => service),
}));

function environment(nodeEnv: string, flag?: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", flag ?? "");
  if (flag === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
}
const KERNEL_ID = "kernel-n104-setup";
const DEVICE_ID = "device-n104-setup";
const OWNER = "operator-n104-setup";

function queuedBody() {
  return { jobId: expect.stringMatching(/^test-job-/), deviceId: null, status: "queued",
    reason: "no_kernel_signer", ran: false, passed: false, duration: expect.any(Number) };
}

describe("N267 setup signer routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    const adminKey = randomUUID();
    vi.stubEnv("PCC_ADMIN_KEY", adminKey);
    environment("test");
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    resetSafetyGateway();
    initStore({ seed: false });
    const now = new Date().toISOString();
    const repos = getRepos();
    repos.kernels.insert({
      id: KERNEL_ID, name: KERNEL_ID, operatorAddress: OWNER,
      location: { lat: 0, lng: 0 }, physicalAddress: "1 Bench Row",
      maxAssuranceTier: 2, publicKey: "pk", reputation: 0,
      totalJobsCompleted: 0, status: "online", registeredAt: now,
      lastHeartbeat: now, version: "1",
    } as never);
    repos.kernels.insertDevice({
      id: DEVICE_ID, kernelId: KERNEL_ID, type: "machine", model: "Bench",
      firmware: "1", status: "idle", contributesToCapabilities: [],
      lastUpdated: now, adapterType: "opentrons",
    } as never);
    repos.capabilities.insert({
      id: "cap-n104-setup", kernelId: KERNEL_ID, type: "test-bench", name: "Bench",
      materials: [], assuranceTiers: [0],
      pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
      availability: {}, location: { lat: 0, lng: 0 },
    } as never);

    vi.clearAllMocks();
    service.kernelId = KERNEL_ID;
    service.hasExplicitConfig = true;
    service.usesTestSigner = true;
    service.hasRunner.mockReturnValue(true);
    service.getJobStatus.mockResolvedValue({ status: "completed", progress: 100 });
    service.jobRanSimulated.mockReturnValue(false);
    service.listDevices.mockResolvedValue([
      { id: DEVICE_ID, type: "machine", adapterType: "opentrons", healthStatus: "healthy" },
    ]);
    vi.mocked(getKernelService).mockReturnValue(service as unknown as KernelService);
    service.submitJob.mockImplementation(async ({ jobId }: { jobId: string }) => ({
      jobId, deviceId: DEVICE_ID, status: "accepted",
    }));
    app = Fastify({ logger: false });
    app.decorateRequest("userId", OWNER);
    app.addHook("onRequest", async (req) => {
      req.headers["x-admin-key"] = adminKey;
    });
    await app.register(setupRoutes);
    await app.ready();
  });


  afterEach(async () => {
    await app.close();
    resetKernelService();
    resetSafetyGateway();
    closeStore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const submit = () => app.inject({ method: "POST", url: "/api/setup/test-job",
    payload: { kernelId: KERNEL_ID, deviceId: DEVICE_ID } });

  it("K2: queues the real service test job in production", async () => {
    environment("production", "false");
    getStore().db.update(schema.kernelDevices).set({ adapterType: "mock" }).where(eq(schema.kernelDevices.id, DEVICE_ID)).run();
    const svc = new KernelService({ kernelId: KERNEL_ID,
      devices: [{ id: DEVICE_ID, type: "machine", adapterType: "mock", config: {} }] });
    vi.mocked(getKernelService).mockReturnValue(svc);
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(queuedBody());
    expect(run).not.toHaveBeenCalled();
    expect(getRepos().jobs.findById(response.json().jobId)?.status).toBe("queued");
  });

  it("K2b: queues before entering the runtime", async () => {
    environment("production", "false");
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(queuedBody());
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it("K4c: queue_only precedes signer", async () => {
    environment("production");
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", reason: "queue_only" });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("K3b: runs in test with the test signer", async () => {
    environment("test");
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", ran: true, passed: true });
  });

  it.each([true, false])("K5: detect with usesTestSigner=%s", async (usesTestSigner) => {
    environment("production", "false");
    service.usesTestSigner = usesTestSigner;
    const response = await app.inject({ method: "GET", url: "/api/setup/detect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobs: { queueOnly: false, localDispatch: !usesTestSigner } });
  });
});

describe("N267 submit signer routes", () => {
  let app: FastifyInstance;
  let kernel: { kernelId: string; hasExplicitConfig: boolean; usesTestSigner: boolean; submitJob: ReturnType<typeof vi.fn> };
  const KERNEL = "kernel-nyc";
  beforeEach(async () => {
    environment("test");
    vi.stubEnv("PCC_ADMIN_KEY", "n267-submit-admin");
    vi.stubEnv("PCC_A2A_AUTH_DISABLED", "true");
    vi.stubEnv("MOCK_SETTLEMENT", "true");
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });
    kernel = { kernelId: KERNEL, hasExplicitConfig: true, usesTestSigner: true,
      submitJob: vi.fn(async ({ jobId }: { jobId: string }) => ({ jobId, deviceId: "n267-machine", status: "accepted" })) };
    vi.mocked(getKernelService).mockReturnValue(kernel as unknown as KernelService);
    app = Fastify({ logger: false });
    await app.register(jobSubmitRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    resetKernelService();
    resetSafetyGateway();
    closeStore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("K8: queues with telemetry before entering the runtime", async () => {
    environment("production", "false");
    const emit = vi.spyOn(pipelineTelemetry, "emit");
    const response = await app.inject({ method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "k8" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", deviceId: null, reason: "no_kernel_signer" });
    expect(kernel.submitJob).not.toHaveBeenCalled();
    expect(getRepos().jobs.findById(body.jobId)?.status).toBe("queued");
    expect(emit).toHaveBeenCalledWith(body.jobId, "job_submit", "completed", {
      metadata: { kernelId: KERNEL, stepId: "k8", external: true, reason: "no_kernel_signer" },
    });
  });

  it("K8b: accepts when the signer state is false", async () => {
    environment("production", "false");
    kernel.usesTestSigner = false;
    const response = await app.inject({ method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "k8b" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("accepted");
    expect(kernel.submitJob).toHaveBeenCalledOnce();
  });

  it("K4d: client queueOnly precedes signer", async () => {
    environment("production", "false");
    const response = await app.inject({ method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "k4d", queueOnly: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().reason).toBe("queue_only");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });
});
