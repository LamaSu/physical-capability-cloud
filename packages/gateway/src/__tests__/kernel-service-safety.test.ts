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
  async dispose(): Promise<void> {}
}

const FAIL_TYPE = "test-fail-load-ks-safety";
const OFFLINE_TYPE = "test-offline-ks-safety";

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
});

afterAll(() => {
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(OFFLINE_TYPE); } catch { /* already gone */ }
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
