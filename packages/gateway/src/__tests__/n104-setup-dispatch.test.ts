import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { setupRoutes } from "../routes/setup.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { getKernelService, KernelService } from "../services/kernel-service.js";
import { UNAVAILABLE_POLICY_CASES, applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";

const { service } = vi.hoisted(() => ({
  service: {
    kernelId: "kernel-n104-setup",
    hasExplicitConfig: true,
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

const KERNEL_ID = "kernel-n104-setup";
const DEVICE_ID = "device-n104-setup";
const OWNER = "operator-n104-setup";

describe("N104 setup test-job local dispatch", () => {
  let app: FastifyInstance;
  let savedQueueOnly: string | undefined;

  beforeEach(async () => {
    savedQueueOnly = process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    vi.stubEnv("NODE_ENV", "test");
    const adminKey = randomUUID();
    vi.stubEnv("PCC_ADMIN_KEY", adminKey);
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
    service.hasExplicitConfig = true;
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
    closeStore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (savedQueueOnly === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    else process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = savedQueueOnly;
  });

  const submit = (queueOnly?: unknown) => app.inject({
    method: "POST", url: "/api/setup/test-job",
    payload: { kernelId: KERNEL_ID, deviceId: DEVICE_ID, queueOnly },
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
    expect(body).toMatchObject({ status: "queued", deviceId: null, reason: "queue_only", ran: false, passed: false });
    expect(getRepos().jobs.findById(body.jobId)?.status).toBe("queued");
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it("does not let client payload disable operator queue-only mode", async () => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    const response = await app.inject({
      method: "POST", url: "/api/setup/test-job",
      payload: { kernelId: KERNEL_ID, deviceId: DEVICE_ID, PCC_JOB_SUBMIT_QUEUE_ONLY: false, queueOnly: false },
    });
    expect(response.json()).toMatchObject({ status: "queued", ran: false });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("lets a client request queue-only without polling", async () => {
    const response = await submit(true);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", reason: "queue_only", ran: false, passed: false, deviceId: null });
    expect(getRepos().jobs.findById(body.jobId)?.status).toBe("queued");
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it.each([false, "true", "false", 1, 0, null, {}, []].map((queueOnly) => ({ queueOnly })))(
    "ignores queueOnly $queueOnly unless it is strict boolean true", async ({ queueOnly }) => {
      const response = await submit(queueOnly);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "completed", ran: true, passed: true });
      expect(service.submitJob).toHaveBeenCalledOnce();
    },
  );

  it("queues an e-stopped local kernel without entering KernelService", async () => {
    getStore().db.insert(schema.operatorPolicies).values({
      kernelId: KERNEL_ID, policy: { emergencyStop: true } as never,
      updatedAt: new Date().toISOString(),
    }).run();
    const response = await submit();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", reason: "emergency_stop", ran: false, passed: false });
    expect(getRepos().jobs.findById(body.jobId)).toBeUndefined();
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it.each(UNAVAILABLE_POLICY_CASES)("leaves no test job when policy is $label", async (policyCase) => {
    applyUnavailablePolicy(KERNEL_ID, policyCase);
    const response = await submit();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", deviceId: null, reason: "policy_unavailable", ran: false, passed: false });
    expect(getRepos().jobs.findById(body.jobId)).toBeUndefined();
    expect(service.submitJob).not.toHaveBeenCalled();
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("checks a stop before inserting even with queueOnly %j", async (queueOnly) => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    getStore().db.insert(schema.operatorPolicies).values({
      kernelId: KERNEL_ID, policy: { emergencyStop: true } as never,
      updatedAt: new Date().toISOString(),
    }).run();
    const response = await submit(queueOnly);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "queued", reason: "emergency_stop", ran: false, passed: false });
    expect(getRepos().jobs.findById(body.jobId)).toBeUndefined();
    expect(service.submitJob).not.toHaveBeenCalled();
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
      jobId, deviceId: null, status: "queued", reason: "emergency_stop",
    }));
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", reason: "emergency_stop", ran: false, passed: false });
    expect(service.getJobStatus).not.toHaveBeenCalled();
  });

  it("reports effective local dispatch and queue-only on detect", async () => {
    const response = await app.inject({ method: "GET", url: "/api/setup/detect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobs: { queueOnly: false, localDispatch: true } });
  });

  it.each([
    { environment: "production", flag: undefined, queueOnly: true },
    { environment: "production", flag: "false", queueOnly: false },
    { environment: "production", flag: "FALSE", queueOnly: true },
    { environment: "development", flag: undefined, queueOnly: false },
    { environment: "development", flag: "true", queueOnly: true },
  ])("detect reports $environment with switch $flag", async ({ environment, flag, queueOnly }) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", flag ?? "");
    if (flag === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    const response = await app.inject({ method: "GET", url: "/api/setup/detect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobs: { queueOnly, localDispatch: !queueOnly } });
  });

  it.each(["unconfigured", "stopped", "no machine", "no runner", "placeholder"])(
    "detect reports no possible local dispatch for %s", async (state) => {
      if (state === "unconfigured") service.hasExplicitConfig = false;
      if (state === "placeholder") service.kernelId = "kernel_dev_001";
      if (state === "no machine") service.listDevices.mockResolvedValue([
        { id: "sensor-only", type: "sensor", adapterType: "mock", healthStatus: "healthy" },
      ]);
      if (state === "no runner") service.hasRunner.mockReturnValue(false);
      if (state === "stopped") getStore().db.insert(schema.operatorPolicies).values({
        kernelId: KERNEL_ID, policy: { emergencyStop: true } as never, updatedAt: new Date().toISOString(),
      }).run();
      const response = await app.inject({ method: "GET", url: "/api/setup/detect" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ jobs: { queueOnly: false, localDispatch: false } });
    },
  );

  it.each(UNAVAILABLE_POLICY_CASES)("detect disables local dispatch for $label", async (policyCase) => {
    applyUnavailablePolicy(KERNEL_ID, policyCase);
    const response = await app.inject({ method: "GET", url: "/api/setup/detect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobs: { queueOnly: false, localDispatch: false } });
  });

  it("register-device under the built-in placeholder installs no runtime adapter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    const runtime = new KernelService();
    vi.mocked(getKernelService).mockReturnValue(runtime);
    const refresh = vi.spyOn(runtime, "refreshDeviceFromDb");
    getRepos().kernels.insert({ ...getRepos().kernels.findById(KERNEL_ID)!, id: "kernel_dev_001" } as never);
    const response = await app.inject({
      method: "POST", url: "/api/setup/register-device",
      payload: {
        kernelId: "kernel_dev_001", deviceId: "device-placeholder", type: "machine", adapterType: "octoprint",
        adapterConfig: { url: "http://127.0.0.1:9", apiKey: "test-not-a-key" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ registered: true });
    expect(refresh).toHaveBeenCalledWith("device-placeholder");
    expect(refresh.mock.results[0]?.value).toEqual({ installed: false, reason: "no_configured_local_kernel" });
    expect(runtime.hasRunner("device-placeholder")).toBe(false);
    expect((await runtime.listDevices()).map((device) => device.id)).not.toContain("device-placeholder");
  });
});
