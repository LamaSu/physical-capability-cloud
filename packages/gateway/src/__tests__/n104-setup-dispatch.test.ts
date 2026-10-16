import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { setupRoutes } from "../routes/setup.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const { service } = vi.hoisted(() => ({
  service: {
    kernelId: "kernel-n104-setup",
    hasRunner: vi.fn().mockReturnValue(true),
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

const KERNEL_ID = "kernel-n104-setup";
const DEVICE_ID = "device-n104-setup";
const OWNER = "operator-n104-setup";

describe("N104 setup test-job local dispatch", () => {
  let app: FastifyInstance;
  let savedQueueOnly: string | undefined;

  beforeEach(async () => {
    savedQueueOnly = process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    process.env.PCC_DB_PATH = ":memory:";
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
    service.submitJob.mockImplementation(async ({ jobId }: { jobId: string }) => ({
      jobId, deviceId: DEVICE_ID, status: "accepted",
    }));
    app = Fastify({ logger: false });
    app.decorateRequest("userId", OWNER);
    await app.register(setupRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (savedQueueOnly === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    else process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = savedQueueOnly;
  });

  const submit = () => app.inject({
    method: "POST", url: "/api/setup/test-job",
    payload: { kernelId: KERNEL_ID, deviceId: DEVICE_ID },
  });

  it("dispatches a positively matched local kernel", async () => {
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", ran: true, passed: true });
    expect(service.submitJob).toHaveBeenCalledWith(expect.objectContaining({ kernelId: KERNEL_ID }));
  });

  it("queues a matching test job in operator queue-only mode without polling", async () => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    const response = await submit();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", deviceId: null, ran: false, passed: false });
    expect(getRepos().jobs.findById(body.jobId)?.status).toBe("queued");
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it("does not let client payload disable operator queue-only mode", async () => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    const response = await app.inject({
      method: "POST", url: "/api/setup/test-job",
      payload: { kernelId: KERNEL_ID, deviceId: DEVICE_ID, PCC_JOB_SUBMIT_QUEUE_ONLY: false },
    });
    expect(response.json()).toMatchObject({ status: "queued", ran: false });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("queues an e-stopped local kernel without entering KernelService", async () => {
    getStore().db.insert(schema.operatorPolicies).values({
      kernelId: KERNEL_ID, policy: { emergencyStop: true } as never,
      updatedAt: new Date().toISOString(),
    }).run();
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", ran: false, passed: false });
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it.each(["", "other-kernel"])("refuses a runtime whose kernel identity is %j", async (localKernelId) => {
    service.kernelId = localKernelId;
    const response = await submit();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "gateway_does_not_run_this_kernel", ran: false });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("does not poll when the runtime's repeated guard queues the job", async () => {
    service.submitJob.mockImplementation(async ({ jobId }: { jobId: string }) => ({
      jobId, deviceId: null, status: "queued",
    }));
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", ran: false, passed: false });
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });
});
