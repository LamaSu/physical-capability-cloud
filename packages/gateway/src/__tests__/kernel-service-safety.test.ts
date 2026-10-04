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
// `startSpanManual` is hoisted to a named const (N71 round 5 follow-up, kernel-
// service sinks) so tests further down this file can override its implementation
// per-test — mirrors tracing.test.ts's `mockStartSpanManual` — to get a handle on
// the lifecycleSpan.setStatus spy kernel-service.ts calls. Without this, every
// call gets its own throwaway `{end, setStatus}` object the test has no
// reference to.
const { mockStartSpanManual } = vi.hoisted(() => ({
  mockStartSpanManual: vi.fn().mockImplementation((_o: unknown, cb: (span: object) => void) => {
    cb({ end: vi.fn(), setStatus: vi.fn() });
  }),
}));

// Sentry: startSpanManual must invoke its callback so runner.run() executes.
vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    startSpan: vi.fn().mockImplementation(async (_o: unknown, cb: () => Promise<unknown>) => cb()),
    startSpanManual: mockStartSpanManual,
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
import { getSettlementService } from "../services/settlement-service.js";
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

// ── checkDeviceHealth's console.warn must never carry the dependency's message ──
//
// N71 round 5 (astra pack 83d, CRITICAL #1): round 3 scrubbed err.message with
// redactDiagnostic before logging it; round 4 fixed one scrubber bypass (an
// underscore shielding the match from a \b boundary). Astra's round 5 verdict
// found the NEXT one: a WHATWG-valid "scheme:userinfo@host" with no "//" at all
// (e.g. "http:u:pw@host") is a real, parseable URL whose credentials a fetch-alike
// would read — but redactUrlCredentials's "\b[a-z][a-z0-9+.-]*:\/\/\S+" matcher
// requires the literal "://", so it never matched, and redactDiagnostic returned it
// untouched. There is no fourth scrubber that closes this for good — the fix below
// stops trying to scrub a dependency's message at all: the sink gets a fixed code,
// never err.message in any form, scrubbed or not.

const THROW_TYPE = "test-throw-ks-n71r5";

/** Always throws from getStatus() with a caller-supplied message — for proving
 *  checkDeviceHealth's console.warn never discloses it (N71 round 5). The factory
 *  reads `failMessage` (a closure over the describe-scoped `let`) at CONSTRUCTION
 *  time, so each `it.each` case gets its own message despite one `registerMachineAdapter`
 *  call in `beforeAll`. */
class ThrowingStatusAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  constructor(id: string, kernelId: string, private readonly failMessage: string) {
    this.id = id;
    this.source = { deviceId: id, deviceType: "controller", kernelId };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> {
    throw new Error(this.failMessage);
  }
  async execute(): ReturnType<MachineAdapter["execute"]> {
    return { success: false, message: "n/a" };
  }
  async getProgress(): Promise<number> {
    return 0;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  async dispose(): Promise<void> {}
}

describe("KernelService.checkDeviceHealth — N71 round 5 (astra pack 83d, CRITICAL #1): console.warn never carries the dependency's message", () => {
  const SENTINEL = "N71-SENTINEL";
  let failMessage = "unset";

  beforeAll(() => {
    try { unregisterMachineAdapter(THROW_TYPE); } catch { /* not registered */ }
    registerMachineAdapter(THROW_TYPE, (device, _cfg, kernelId) => new ThrowingStatusAdapter(device.id, kernelId, failMessage));
  });

  afterAll(() => {
    try { unregisterMachineAdapter(THROW_TYPE); } catch { /* already gone */ }
  });

  it.each([
    [
      "an underscore shields the URL from a \\b boundary (round 3/4's own bypass)",
      `endpoint_http://u:${SENTINEL}@h.invalid`,
    ],
    [
      "a WHATWG-valid scheme:userinfo@host with no '//' at all (astra pack 83d CRITICAL #1)",
      `http:u:${SENTINEL}@h.invalid`,
    ],
  ] as Array<[string, string]>)("[neg] %s: the sentinel never reaches console.warn", async (_what, message) => {
    failMessage = message;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = new KernelService({
        kernelId: "kernel-ks-n71r5",
        mockMode: false,
        devices: [{ id: "dev-throw-n71r5", type: "machine", adapterType: THROW_TYPE, config: {} }],
      });
      const result = await svc.checkDeviceHealth("dev-throw-n71r5");
      expect(result).toEqual({ healthy: false, details: "adapter_error" });
      expect(warnSpy).toHaveBeenCalled();
      const allArgsText = warnSpy.mock.calls
        .map((call) => call.map((a) => String(a)).join(" "))
        .join("\n");
      expect(allArgsText).not.toContain(SENTINEL);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("control: a healthy device's console.warn is never called at all", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = new KernelService({
        kernelId: "kernel-ks-n71r5-ok",
        mockMode: false,
        devices: [{ id: "dev-ok-n71r5", type: "machine", adapterType: "mock", config: {} }],
      });
      const result = await svc.checkDeviceHealth("dev-ok-n71r5");
      expect(result.healthy).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// N71 round 5 follow-up: three sibling sinks in this file's class, all still
// carrying the dependency's raw text at HEAD ee1754ae. 83e-n71-report.md's own
// span-site-list flagged kernel-service.ts:388 for #538 and :364/:447 as
// "noted but out of scope"; :373 was mislabeled there as already-safe ("a
// facade Result's own error string"). It is NOT: `result` in the
// `.then((result) => ...)` callback below is JobRunner's OWN `JobResult`
// (job-runner.ts:38), whose `.error` is built from an adapter's
// `MachineCommandResult.message` (`Failed to load G-code:
// ${loadResult.message}` / `Failed to start: ${startResult.message}`) or from
// JobRunner's own caught `err instanceof Error ? err.message : String(err)` —
// it CAN carry raw dependency text, same as the other three sinks. Same
// property as F1/F3/F4: a fixed code, plus at most `knownErrorClassName(err)`
// (closed set, instanceof-checked) — never `err.message`, `String(err)`, or
// text derived from the error, on any sink.
// ---------------------------------------------------------------------------

const FOLLOWUP_SENTINEL = "N71-SENTINEL";
const REJECT_ONEVIDENCE_TYPE = "test-reject-onevidence-ks-n71r5-fu";
const FAIL_LOAD_SENTINEL_TYPE = "test-fail-load-sentinel-ks-n71r5-fu";
// Tests (b)/(c)/control need a job that actually SUCCEEDS end-to-end (through
// to a finalized evidence bundle), to drive KernelService into its real
// completedBundles -> settlement path. The built-in "mock" adapter type
// (MockFDMAdapter, registered globally by @pcc/kernel) emits its evidence
// events via real setInterval ticks over jobDurationMs, which gives
// job-runner.ts's fire-and-forget `evidenceEmitter.addEvent(...).catch(...)`
// (never awaited there) plenty of real event-loop turns to land before
// finalizeBundle() runs — unlike a hand-rolled adapter whose getProgress()
// returns 100 on the very first call, which outraces that same fire-and-forget
// add and left finalizeBundle() seeing zero events (confirmed empirically: an
// earlier version of this file's InstantSuccessAdapter did exactly that).
const MOCK_JOB_DURATION_MS = 50;

/**
 * Throws synchronously from onEvidence() — job-runner.ts:76 calls
 * `this.machine.onEvidence(handleEvidence)` BEFORE its own try/catch starts
 * (job-runner.ts:84), so the throw escapes `run()` as a REJECTED promise
 * instead of being converted into a resolved `{success:false}` the way every
 * throw INSIDE the try/catch is. This is the only way to make `runner.run()`
 * reject rather than resolve, which is what exercises kernel-service.ts:388's
 * `.catch((err: unknown) => ...)` branch specifically (as opposed to :373's
 * `.then((result) => ...)` branch for a resolved failure).
 */
class RejectingOnEvidenceAdapter implements MachineAdapter {
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
    return { success: true };
  }
  async getProgress(): Promise<number> {
    return 100;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {
    throw new Error(`password=${FOLLOWUP_SENTINEL}`);
  }
  async dispose(): Promise<void> {}
}

/**
 * execute() always resolves `{success:false, message: <sentinel>}` — JobRunner's
 * step 1 wraps this as `Failed to load G-code: ${loadResult.message}` into a
 * RESOLVED JobResult.error (runner.run() never rejects here), exercising
 * kernel-service.ts:373's `.then((result) => ...)` branch specifically.
 */
class FailLoadSentinelAdapter implements MachineAdapter {
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
    return { success: false, message: `password=${FOLLOWUP_SENTINEL}` };
  }
  async getProgress(): Promise<number> {
    return 0;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  async dispose(): Promise<void> {}
}

describe("KernelService.submitJob — N71 round 5 follow-up: job.lifecycle span + settlement console.warn never carry the dependency's message", () => {
  beforeAll(() => {
    try { unregisterMachineAdapter(REJECT_ONEVIDENCE_TYPE); } catch { /* not registered */ }
    try { unregisterMachineAdapter(FAIL_LOAD_SENTINEL_TYPE); } catch { /* not registered */ }
    registerMachineAdapter(REJECT_ONEVIDENCE_TYPE, (device, _cfg, kernelId) => new RejectingOnEvidenceAdapter(device.id, kernelId));
    registerMachineAdapter(FAIL_LOAD_SENTINEL_TYPE, (device, _cfg, kernelId) => new FailLoadSentinelAdapter(device.id, kernelId));
  });

  afterAll(() => {
    try { unregisterMachineAdapter(REJECT_ONEVIDENCE_TYPE); } catch { /* already gone */ }
    try { unregisterMachineAdapter(FAIL_LOAD_SENTINEL_TYPE); } catch { /* already gone */ }
  });

  it("[neg] (a) a REJECTED runner.run() never puts the dependency's message on the job.lifecycle span (kernel-service.ts:388)", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 100, cooldownMs: 60_000 } });
    const setStatusSpy = vi.fn();
    mockStartSpanManual.mockImplementationOnce((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: setStatusSpy });
    });

    const svc = new KernelService({
      kernelId: "kernel-ks-n71r5-fu-a",
      mockMode: false,
      devices: [{ id: "dev-reject-a", type: "machine", adapterType: REJECT_ONEVIDENCE_TYPE, config: {} }],
    });

    await svc.submitJob({ jobId: "ks-n71r5-fu-a", stepId: "s", assuranceTier: 0, deviceId: "dev-reject-a" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0);

    for (const call of setStatusSpy.mock.calls) {
      const status = call[0] as { code: number; message?: string };
      expect(status.message, "lifecycleSpan.setStatus message").not.toContain(FOLLOWUP_SENTINEL);
    }
    expect(setStatusSpy.mock.calls[0]?.[0]).toEqual({ code: 2, message: "job_run_failed:Error" });
  });

  it("[neg] (b) settlement-pipeline failure on the PRIMARY (Sentry) path never puts the dependency's message on console.warn (kernel-service.ts:364)", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 100, cooldownMs: 60_000 } });
    const settlementSvc = getSettlementService();
    const procSpy = vi
      .spyOn(settlementSvc, "processEvidence")
      .mockRejectedValueOnce(new Error(`password=${FOLLOWUP_SENTINEL}`));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const svc = new KernelService({
        kernelId: "kernel-ks-n71r5-fu-b",
        mockMode: false,
        devices: [{ id: "dev-instant-b", type: "machine", adapterType: "mock", config: { jobDurationMs: MOCK_JOB_DURATION_MS } }],
      });

      await svc.submitJob({ jobId: "ks-n71r5-fu-b", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-b" });
      // Decisive check that this test exercised the PRIMARY path (startSpanManual
      // returned normally) and not the fallback — otherwise this test would
      // silently duplicate (c) instead of covering kernel-service.ts:364 distinctly.
      expect(mockStartSpanManual.mock.results.at(-1)?.type).toBe("return");
      await waitFor(
        () => warnSpy.mock.calls.some((call) => call.some((a) => String(a).includes("Settlement pipeline failed"))),
        5_000,
      );

      const allArgsText = warnSpy.mock.calls.map((call) => call.map((a) => String(a)).join(" ")).join("\n");
      expect(allArgsText).not.toContain(FOLLOWUP_SENTINEL);
      expect(procSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[kernel-service] Settlement pipeline failed:",
        "settlement_pipeline_failed",
        "Error",
      );
    } finally {
      procSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("[neg] (c) settlement-pipeline failure on the FALLBACK (non-Sentry) path never puts the dependency's message on console.warn (kernel-service.ts:447)", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 100, cooldownMs: 60_000 } });
    const settlementSvc = getSettlementService();
    const procSpy = vi
      .spyOn(settlementSvc, "processEvidence")
      .mockRejectedValueOnce(new Error(`password=${FOLLOWUP_SENTINEL}`));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Force kernel-service.ts's "Sentry not initialised" fallback branch.
    mockStartSpanManual.mockImplementationOnce(() => {
      throw new Error("sentry down (test fixture)");
    });

    try {
      const svc = new KernelService({
        kernelId: "kernel-ks-n71r5-fu-c",
        mockMode: false,
        devices: [{ id: "dev-instant-c", type: "machine", adapterType: "mock", config: { jobDurationMs: MOCK_JOB_DURATION_MS } }],
      });

      await svc.submitJob({ jobId: "ks-n71r5-fu-c", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-c" });
      // Decisive check that this test actually exercised the FALLBACK path
      // (startSpanManual threw, as forced above) and not the primary one —
      // otherwise this test would silently duplicate (b) instead of covering
      // kernel-service.ts:447 distinctly.
      expect(mockStartSpanManual.mock.results.at(-1)?.type).toBe("throw");
      await waitFor(
        () => warnSpy.mock.calls.some((call) => call.some((a) => String(a).includes("Settlement pipeline failed"))),
        5_000,
      );

      const allArgsText = warnSpy.mock.calls.map((call) => call.map((a) => String(a)).join(" ")).join("\n");
      expect(allArgsText).not.toContain(FOLLOWUP_SENTINEL);
      expect(procSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[kernel-service] Settlement pipeline failed:",
        "settlement_pipeline_failed",
        "Error",
      );
    } finally {
      procSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("[neg] (d) a RESOLVED job failure (result.success===false) never puts JobRunner's own error text on the job.lifecycle span (kernel-service.ts:373)", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 100, cooldownMs: 60_000 } });
    const setStatusSpy = vi.fn();
    mockStartSpanManual.mockImplementationOnce((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: setStatusSpy });
    });

    const svc = new KernelService({
      kernelId: "kernel-ks-n71r5-fu-d",
      mockMode: false,
      devices: [{ id: "dev-failload-d", type: "machine", adapterType: FAIL_LOAD_SENTINEL_TYPE, config: {} }],
    });

    await svc.submitJob({ jobId: "ks-n71r5-fu-d", stepId: "s", assuranceTier: 0, deviceId: "dev-failload-d" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0);

    for (const call of setStatusSpy.mock.calls) {
      const status = call[0] as { code: number; message?: string };
      expect(status.message, "lifecycleSpan.setStatus message").not.toContain(FOLLOWUP_SENTINEL);
    }
    expect(setStatusSpy.mock.calls[0]?.[0]).toEqual({ code: 2, message: "job_run_failed" });
  });

  it("control: a normal successful job still gets {code:1, message:'ok'} on the job.lifecycle span", async () => {
    initSafetyGateway({ circuitBreaker: { failureThreshold: 100, cooldownMs: 60_000 } });
    const setStatusSpy = vi.fn();
    mockStartSpanManual.mockImplementationOnce((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: setStatusSpy });
    });

    const svc = new KernelService({
      kernelId: "kernel-ks-n71r5-fu-ctrl",
      mockMode: false,
      devices: [{ id: "dev-instant-ctrl", type: "machine", adapterType: "mock", config: { jobDurationMs: MOCK_JOB_DURATION_MS } }],
    });

    await svc.submitJob({ jobId: "ks-n71r5-fu-ctrl", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-ctrl" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0, 5_000);

    expect(setStatusSpy).toHaveBeenCalledWith({ code: 1, message: "ok" });
  });
});
