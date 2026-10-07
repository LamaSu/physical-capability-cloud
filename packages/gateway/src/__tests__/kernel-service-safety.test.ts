/**
 * KernelService ↔ SafetyGateway wiring tests.
 *
 * Proves the S3 fix (arch review): the circuit breaker now receives REAL device
 * failures, and listDevices() reports REAL health.
 *
 *   1. A device whose execution keeps failing trips the breaker after threshold,
 *      and the NEXT job to that device is rejected (circuit_open) — previously
 *      impossible, because the pre-flight recorded a phantom success on every job.
 *   2. listDevices() reflects real adapter status + breaker state, not a
 *      hardcoded "healthy".
 *
 * External services (Sentry, SSE, storage, chain) are mocked so the test runs
 * purely in-memory — same approach as tracing.test.ts.
 */

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
import { initStore, closeStore } from "../db.js";
import { Sentry } from "../sentry.js";
import { KernelService } from "../services/kernel-service.js";
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
});

afterAll(() => {
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(OFFLINE_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(HELD_TYPE); } catch { /* already gone */ }
});

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  resetSafetyGateway();
});

afterEach(() => {
  resetSafetyGateway();
  closeStore();
  vi.clearAllMocks();
});

// ── Real execution failures reach the breaker ─────────────────────────────────

describe("KernelService.submitJob — real device failures trip the breaker", () => {
  it("trips after threshold and rejects the next job with circuit_open", async () => {
    // failureThreshold: 2 → two failing jobs trip it (proves accumulation, and
    // that no phantom success resets the count between jobs).
    initSafetyGateway({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    const gw = getSafetyGateway();

    const config: KernelConfig = {
      kernelId: "kernel-ks-safety-fail",
      mockMode: false,
      devices: [{ id: "dev-fail", type: "machine", adapterType: FAIL_TYPE, config: {} }],
    };
    const svc = new KernelService(config);

    // Job 1 — fails.
    await svc.submitJob({ jobId: "ks-fail-1", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" });
    await waitFor(() => (gw.getStatus().circuits.get("dev-fail")?.failures ?? 0) >= 1);
    expect(gw.getStatus().circuits.get("dev-fail")?.state).toBe("closed"); // 1 of 2

    // Job 2 — fails → trips.
    await svc.submitJob({ jobId: "ks-fail-2", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" });
    await waitFor(() => gw.getStatus().circuits.get("dev-fail")?.state === "open");
    expect(gw.getStatus().circuits.get("dev-fail")?.state).toBe("open");

    // Job 3 — blocked by the tripped breaker (admission rejects before accepting).
    await expect(
      svc.submitJob({ jobId: "ks-fail-3", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" }),
    ).rejects.toThrow(/circuit_open|denied/i);
  });
});

describe("KernelService.submitJob — a busy refusal is not a device failure (#5205)", () => {
  it.each([
    ["with the Sentry lifecycle span", false],
    ["on the fallback path, when Sentry cannot start a span", true],
  ])("jobs refused because another job holds the device never open its breaker, and the next job is still admitted (%s)", async (_path, withoutSentry) => {
    const startSpanManual = vi.mocked(Sentry.startSpanManual);
    if (withoutSentry) {
      startSpanManual.mockImplementation(() => {
        throw new Error("Sentry not initialised");
      });
    }
    try {
      await busyRefusalsAreNotFailures(withoutSentry ? "kernel-ks-safety-busy-fallback" : "kernel-ks-safety-busy");
      expect(startSpanManual, "submissions that tried Sentry's span").toHaveBeenCalledTimes(4);
    } finally {
      startSpanManual.mockImplementation((_o: unknown, cb: (span: object) => void) => {
        cb({ end: vi.fn(), setStatus: vi.fn() });
      });
    }
  });
});

/** Job 1 holds the device; jobs 2 to 4 are refused busy, and none of it reaches the breaker. */
async function busyRefusalsAreNotFailures(kernelId: string): Promise<void> {
  initSafetyGateway({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
  const gw = getSafetyGateway();
  held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const svc = new KernelService({
    kernelId,
    mockMode: false,
    devices: [{ id: "dev-held", type: "machine", adapterType: HELD_TYPE, config: {} }],
  });
  const done = async (jobId: string) => (await svc.getJobStatus(jobId)).status !== "executing";
  const waitDone = async (jobId: string) => {
    const start = Date.now();
    while (!(await done(jobId))) {
      if (Date.now() - start > 2_000) throw new Error(`job ${jobId} is still executing`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // Job 1 runs, and holds the device until its adapter answers.
  await svc.submitJob({ jobId: "ks-busy-1", stepId: "s", assuranceTier: 0, deviceId: "dev-held" });
  // Jobs 2 and 3 are refused busy: twice the breaker's threshold, were refusals failures.
  for (const jobId of ["ks-busy-2", "ks-busy-3"]) {
    await svc.submitJob({ jobId, stepId: "s", assuranceTier: 0, deviceId: "dev-held" });
    await waitDone(jobId);
  }
  expect(heldAdapter?.commands, "commands the device received: job 1's only").toEqual(["load_gcode", "start"]);
  expect(await done("ks-busy-1"), "job 1, still holding the device").toBe(false);
  expect.soft(gw.getStatus().circuits.get("dev-held")?.failures ?? 0, "device failures recorded").toBe(0);
  expect.soft(gw.getStatus().circuits.get("dev-held")?.state ?? "closed", "the breaker").toBe("closed");
  await expect.soft(
    svc.submitJob({ jobId: "ks-busy-4", stepId: "s", assuranceTier: 0, deviceId: "dev-held" }),
    "job 4's admission",
  ).resolves.toMatchObject({ status: "accepted" });
  await waitDone("ks-busy-4").catch(() => {});

  releaseHeld();
  await waitDone("ks-busy-1");
  expect(gw.getStatus().circuits.get("dev-held")?.failures ?? 0, "device failures, after job 1 completed").toBe(0);
}

// ── listDevices reports real health ───────────────────────────────────────────

describe("KernelService.listDevices — real health, not hardcoded", () => {
  it("derives health from adapter status and circuit-breaker state", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    const gw = getSafetyGateway();

    const config: KernelConfig = {
      kernelId: "kernel-ks-safety-health",
      mockMode: false,
      devices: [
        { id: "dev-ok", type: "machine", adapterType: "mock", config: {} },
        { id: "dev-degrade", type: "machine", adapterType: "mock", config: {} },
        { id: "dev-off", type: "machine", adapterType: OFFLINE_TYPE, config: {} },
      ],
    };
    const svc = new KernelService(config);

    // Baseline: mock adapters report "idle" → healthy; the offline adapter →
    // offline (proves health is adapter-driven, not a hardcoded "healthy").
    const before = await svc.listDevices();
    const byId = (list: Awaited<ReturnType<KernelService["listDevices"]>>) =>
      Object.fromEntries(list.map((d) => [d.id, d.healthStatus]));
    expect(byId(before)).toMatchObject({
      "dev-ok": "healthy",
      "dev-degrade": "healthy",
      "dev-off": "offline",
    });

    // Trip dev-degrade's breaker with a real failure (threshold 1 → open).
    gw.recordDeviceFailure("dev-degrade");
    expect(gw.getStatus().circuits.get("dev-degrade")?.state).toBe("open");

    const after = await svc.listDevices();
    expect(byId(after)).toMatchObject({
      "dev-ok": "healthy",        // untouched
      "dev-degrade": "degraded",  // adapter idle + breaker open → degraded
      "dev-off": "offline",       // adapter offline
    });
  });
});
