import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────
// Sentry: startSpanManual must invoke its callback so runner.run() executes.
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

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNAVAILABLE_POLICY_CASES, applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";
import { Sentry } from "../sentry.js";
import { KernelService, initKernelService, resetKernelService } from "../services/kernel-service.js";
import {
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
  registerMachineAdapter,
  unregisterMachineAdapter,
} from "@pcc/kernel";
import type { MachineAdapter, KernelConfig } from "@pcc/kernel";

// ── Test adapters ─────────────────────────────────────────────────────────────
// Minimal MachineAdapter implementations. Parameters/ReturnType tricks keep the
// import surface to just the MachineAdapter type.

/** Fails the first machine command → JobRunner.run() returns {success:false} fast (no timers). */
class FailingLoadAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = { deviceId: id, deviceType: "controller", kernelId };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> {
    return "idle";
  }
  async execute(): ReturnType<MachineAdapter["execute"]> {
    return { success: false, message: "simulated device failure" };
  }
  async getProgress(): Promise<number> {
    return 0;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  // It emits nothing, so nothing is ever outstanding (the runner refuses an adapter without it).
  async quiesceEvidence(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Always reports offline via getStatus() — for the health-derivation test. */
class OfflineAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = { deviceId: id, deviceType: "controller", kernelId };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> {
    return "offline";
  }
  async execute(): ReturnType<MachineAdapter["execute"]> {
    return { success: true };
  }
  async getProgress(): Promise<number> {
    return 0;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  // It emits nothing, so nothing is ever outstanding (the runner refuses an adapter without it).
  async quiesceEvidence(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Released by the test: until then, the held job's device stays claimed by it. */
let releaseHeld: () => void = () => {};
let held: Promise<void> = Promise.resolve();

/**
 * Runs every job to completion at once (reporting it as evidence), but its quiesceEvidence()
 * answers only once the test releases it, so the first job holds the device and every later
 * job is refused busy.
 */
class HeldAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  readonly commands: string[] = [];
  private readonly listeners: Array<Parameters<MachineAdapter["onEvidence"]>[0]> = [];
  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = { deviceId: id, deviceType: "controller", kernelId };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> {
    return "busy";
  }
  async execute(command: Parameters<MachineAdapter["execute"]>[0]): ReturnType<MachineAdapter["execute"]> {
    this.commands.push(command.type);
    if (command.type === "start") {
      const event = { type: "execution_completed" as const, timestamp: new Date().toISOString(), source: this.source, payload: {} };
      for (const listener of this.listeners) listener(event);
    }
    return { success: true };
  }
  async getProgress(): Promise<number> {
    return 100;
  }
  onEvidence(cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {
    this.listeners.push(cb);
  }
  quiesceEvidence(): Promise<void> {
    return held;
  }
  async dispose(): Promise<void> {}
}

const FAIL_TYPE = "test-fail-load-ks-safety";
const OFFLINE_TYPE = "test-offline-ks-safety";
const HELD_TYPE = "test-held-ks-safety";
const DIFFERENT_ID_TYPE = "test-different-id-ks-safety";
const SLOW_TYPE = "test-slow-ks-safety";
let heldAdapter: HeldAdapter | undefined;

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!pred()) throw new Error("waitFor: condition not met within timeout");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(() => {
  // Register once; guard against a leftover registration from a prior run.
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* not registered */ }
  try { unregisterMachineAdapter(OFFLINE_TYPE); } catch { /* not registered */ }
  registerMachineAdapter(FAIL_TYPE, (device, _cfg, kernelId) => new FailingLoadAdapter(device.id, kernelId));
  registerMachineAdapter(OFFLINE_TYPE, (device, _cfg, kernelId) => new OfflineAdapter(device.id, kernelId));
  try { unregisterMachineAdapter(HELD_TYPE); } catch { /* not registered */ }
  registerMachineAdapter(HELD_TYPE, (device, _cfg, kernelId) => (heldAdapter = new HeldAdapter(device.id, kernelId)));
  registerMachineAdapter(DIFFERENT_ID_TYPE, (_device, _cfg, kernelId) => new OfflineAdapter("runtime-device-id", kernelId));
  registerMachineAdapter(SLOW_TYPE, (device, _cfg, kernelId) => {
    const adapter = new OfflineAdapter(device.id, kernelId);
    adapter.getStatus = () => new Promise(() => {});
    return adapter;
  });
});

afterAll(() => {
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(OFFLINE_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(HELD_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(DIFFERENT_ID_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(SLOW_TYPE); } catch { /* already gone */ }
});

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", undefined);
  vi.stubEnv("NODE_ENV", "test");
  for (const key of ["KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID"]) {
    vi.stubEnv(key, "");
    delete process.env[key];
  }
  initStore({ seed: false });
  resetSafetyGateway();
  vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
    cb({ end: vi.fn(), setStatus: vi.fn() });
  });
});

afterEach(() => {
  resetKernelService();
  resetSafetyGateway();
  closeStore();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

import Fastify, { type FastifyInstance } from "fastify";
import { setupRoutes } from "../routes/setup.js";
import { getKernelService } from "../services/kernel-service.js";
import { JobRunner } from "@pcc/kernel";

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

const DISPATCH_KERNEL = "kernel-ks-n104";

function seedDispatchKernel() {
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id: DISPATCH_KERNEL, name: DISPATCH_KERNEL, operatorAddress: "operator-n104",
    location: { lat: 0, lng: 0 }, physicalAddress: "1 Bench Row", maxAssuranceTier: 2,
    publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
    registeredAt: now, lastHeartbeat: now, version: "1",
  } as never);
}

function stopDispatchKernel() {
  getStore().db.insert(schema.operatorPolicies).values({
    kernelId: DISPATCH_KERNEL,
    policy: { emergencyStop: true },
    updatedAt: new Date().toISOString(),
  }).run();
}

function dispatchService(config: Partial<KernelConfig> = {}) {
  return new KernelService({
    kernelId: DISPATCH_KERNEL,
    devices: [{ id: "dev-n104", type: "machine", adapterType: "mock", config: {} }],
    ...config,
  });
}

describe("N104 explicit local configuration", () => {
  it("does not load or refresh DB machines for a KERNEL_ID-only default config", () => {
    vi.stubEnv("KERNEL_ID", "kernel-from-id-only");
    const now = new Date().toISOString();
    getRepos().kernels.insert({
      id: "kernel-from-id-only", name: "id-only", operatorAddress: "operator-n104",
      location: { lat: 0, lng: 0 }, physicalAddress: "1 Bench Row", maxAssuranceTier: 2,
      publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1",
    } as never);
    getRepos().kernels.insertDevice({
      id: "dev-id-only-db", kernelId: "kernel-from-id-only", type: "machine", model: "BENCH",
      firmware: "1.0", status: "idle", contributesToCapabilities: [], lastUpdated: now,
      adapterType: OFFLINE_TYPE,
    } as never);
    const svc = new KernelService();
    expect(svc.hasExplicitConfig).toBe(false);
    expect(svc.hasRunner("dev-id-only-db")).toBe(false);
    expect(svc.refreshDeviceFromDb("dev-id-only-db"))
      .toEqual({ installed: false, reason: "no_configured_local_kernel" });
    expect(svc.hasRunner("dev-id-only-db")).toBe(false);
  });

  it.each([undefined, "kernel-from-id-only"])("does not authorize generated defaults with KERNEL_ID=%s (preflight never runs)", async (id) => {
    vi.stubEnv("KERNEL_ID", id ?? "");
    if (id === undefined) delete process.env.KERNEL_ID;
    const svc = new KernelService();
    expect(svc.hasExplicitConfig).toBe(false);
    const run = vi.spyOn(JobRunner.prototype, "run");
    const preflight = vi.spyOn(getSafetyGateway(), "validateOnly");
    await expect(svc.submitJob({ jobId: "default-blocked", kernelId: svc.kernelId, stepId: "s" }))
      .resolves.toEqual({ jobId: "default-blocked", deviceId: null, status: "queued", reason: "no_configured_local_kernel" });
    expect(preflight).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("N104 listDevices runtime inventory", () => {
  it("clears each health timer once the adapter answers", async () => {
    vi.useFakeTimers();
    const svc = dispatchService();
    await svc.listDevices();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("N104 setup test-job local dispatch", () => {
  let app: FastifyInstance;
  let savedQueueOnly: string | undefined;

  beforeEach(async () => {
    savedQueueOnly = process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    vi.stubEnv("NODE_ENV", "test");
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

  it("queues an unconfigured runtime's test job before KernelService", async () => {
    service.hasExplicitConfig = false;
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", reason: "no_configured_local_kernel", ran: false, passed: false });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("register-device under the built-in placeholder installs no runtime adapter (then a submit queues)", async () => {
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
    const run = vi.spyOn(JobRunner.prototype, "run");
    await expect(runtime.submitJob({ jobId: "p2-submit", kernelId: "kernel_dev_001", stepId: "s", deviceId: "device-placeholder" }))
      .resolves.toEqual({ jobId: "p2-submit", deviceId: null, status: "queued", reason: "no_configured_local_kernel" });
    expect(run).not.toHaveBeenCalled();
  });
});
