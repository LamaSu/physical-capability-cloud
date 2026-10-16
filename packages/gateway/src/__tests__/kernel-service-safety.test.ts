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
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNAVAILABLE_POLICY_CASES, applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";
import { Sentry } from "../sentry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { KernelService, initKernelService, resetKernelService } from "../services/kernel-service.js";
import {
  JobRunner,
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
// Detect exposes adapter types from its fixed vocabulary. Modbus has only a
// built-in sensor factory, so its independent machine factory is free for this
// offline test double without replacing any built-in machine registration.
const OFFLINE_TYPE = "modbus";
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
    await svc.submitJob({ kernelId: config.kernelId, jobId: "ks-fail-1", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" });
    await waitFor(() => (gw.getStatus().circuits.get("dev-fail")?.failures ?? 0) >= 1);
    expect(gw.getStatus().circuits.get("dev-fail")?.state).toBe("closed"); // 1 of 2

    // Job 2 — fails → trips.
    await svc.submitJob({ kernelId: config.kernelId, jobId: "ks-fail-2", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" });
    await waitFor(() => gw.getStatus().circuits.get("dev-fail")?.state === "open");
    expect(gw.getStatus().circuits.get("dev-fail")?.state).toBe("open");

    // Job 3 — blocked by the tripped breaker (admission rejects before accepting).
    await expect(
      svc.submitJob({ kernelId: config.kernelId, jobId: "ks-fail-3", stepId: "s", assuranceTier: 0, deviceId: "dev-fail" }),
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
  await svc.submitJob({ kernelId, jobId: "ks-busy-1", stepId: "s", assuranceTier: 0, deviceId: "dev-held" });
  // Jobs 2 and 3 are refused busy: twice the breaker's threshold, were refusals failures.
  for (const jobId of ["ks-busy-2", "ks-busy-3"]) {
    await svc.submitJob({ kernelId, jobId, stepId: "s", assuranceTier: 0, deviceId: "dev-held" });
    await waitDone(jobId);
  }
  expect(heldAdapter?.commands, "commands the device received: job 1's only").toEqual(["load_gcode", "start"]);
  expect(await done("ks-busy-1"), "job 1, still holding the device").toBe(false);
  expect.soft(gw.getStatus().circuits.get("dev-held")?.failures ?? 0, "device failures recorded").toBe(0);
  expect.soft(gw.getStatus().circuits.get("dev-held")?.state ?? "closed", "the breaker").toBe("closed");
  await expect.soft(
    svc.submitJob({ kernelId, jobId: "ks-busy-4", stepId: "s", assuranceTier: 0, deviceId: "dev-held" }),
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

/** Evidence registration fails before the runner's execution catch. */
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
  async quiesceEvidence(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/**
 * A failed load resolves with dependency text, reaching the service's resolved
 * failure branch through JobRunner's own execution path.
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
  async quiesceEvidence(): Promise<void> {}
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

    const registration = vi.spyOn(RejectingOnEvidenceAdapter.prototype, "onEvidence");
    const run = vi.spyOn(JobRunner.prototype, "run");
    await svc.submitJob({ kernelId: svc.kernelId, jobId: "ks-n71r5-fu-a", stepId: "s", assuranceTier: 0, deviceId: "dev-reject-a" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(registration).toHaveBeenCalledTimes(1);

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

      await svc.submitJob({ kernelId: svc.kernelId, jobId: "ks-n71r5-fu-b", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-b" });
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

      await svc.submitJob({ kernelId: svc.kernelId, jobId: "ks-n71r5-fu-c", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-c" });
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

    const execute = vi.spyOn(FailLoadSentinelAdapter.prototype, "execute");
    const svc = new KernelService({
      kernelId: "kernel-ks-n71r5-fu-d",
      mockMode: false,
      devices: [{ id: "dev-failload-d", type: "machine", adapterType: FAIL_LOAD_SENTINEL_TYPE, config: {} }],
    });

    await svc.submitJob({ kernelId: svc.kernelId, jobId: "ks-n71r5-fu-d", stepId: "s", assuranceTier: 0, deviceId: "dev-failload-d" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "load_gcode" }));

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

    await svc.submitJob({ kernelId: svc.kernelId, jobId: "ks-n71r5-fu-ctrl", stepId: "s", assuranceTier: 0, deviceId: "dev-instant-ctrl" });
    await waitFor(() => setStatusSpy.mock.calls.length > 0, 5_000);

    expect(setStatusSpy).toHaveBeenCalledWith({ code: 1, message: "ok" });
  });
});

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

describe.each(["Sentry span", "Sentry fallback"])("N104 local dispatch final defense — %s", (path) => {
  beforeEach(() => {
    seedDispatchKernel();
    vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
      if (path === "Sentry fallback") throw new Error("Sentry unavailable");
      cb({ end: vi.fn(), setStatus: vi.fn() });
    });
  });

  afterEach(() => {
    vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: vi.fn() });
    });
  });

  it.each([
    ["no local kernel id", undefined, DISPATCH_KERNEL, false, false, "not_local"],
    ["empty local kernel id", "", DISPATCH_KERNEL, false, false, "not_local"],
    ["different kernel id", DISPATCH_KERNEL, "remote-kernel", false, false, "not_local"],
    ["queue-only mode", DISPATCH_KERNEL, DISPATCH_KERNEL, true, false, "queue_only"],
    ["emergency stop", DISPATCH_KERNEL, DISPATCH_KERNEL, false, true, "emergency_stop"],
  ] as const)("queues before admission for %s", async (_label, localId, jobKernelId, queueOnly, stopped, reason) => {
    // Explicit undefined is intentional: KernelService may be initialized with
    // an incomplete runtime config, which must never authorize actuation.
    const svc = dispatchService({ kernelId: localId as string });
    if (queueOnly) vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", "true");
    if (stopped) stopDispatchKernel();
    const run = vi.spyOn(JobRunner.prototype, "run");
    const preflight = vi.spyOn(getSafetyGateway(), "validateOnly");
    await expect(svc.submitJob({ jobId: "n104-blocked", kernelId: jobKernelId, stepId: "s" }))
      .resolves.toEqual({ jobId: "n104-blocked", deviceId: null, status: "queued", reason });
    expect(preflight).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(UNAVAILABLE_POLICY_CASES)("queues before admission for $label", async (policyCase) => {
    const svc = dispatchService();
    applyUnavailablePolicy(DISPATCH_KERNEL, policyCase);
    const run = vi.spyOn(JobRunner.prototype, "run");
    const preflight = vi.spyOn(getSafetyGateway(), "validateOnly");
    await expect(svc.submitJob({ jobId: "n104-unavailable", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toEqual({ jobId: "n104-unavailable", deviceId: null, status: "queued", reason: "policy_unavailable" });
    expect(preflight).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", "TRUE", "1"])("dispatches a positive match with queue-only=%s", async (flag) => {
    vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", flag);
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    await expect(svc.submitJob({ jobId: "n104-matched", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toMatchObject({ deviceId: "dev-n104", status: "accepted" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rechecks the emergency stop after an awaited safety preflight", async () => {
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run");
    vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
      await Promise.resolve();
      stopDispatchKernel();
      return { allowed: true, executed: false };
    });
    await expect(svc.submitJob({ jobId: "n104-preflight-stop", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toMatchObject({ status: "queued" });
    expect(run).not.toHaveBeenCalled();
    expect(Sentry.startSpanManual).not.toHaveBeenCalled();
  });

  it.each(["emergency stop", "queue-only mode"])("rechecks %s immediately before runner.run", async (blocker) => {
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run");
    vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
      if (blocker === "emergency stop") stopDispatchKernel();
      else vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", "true");
      if (path === "Sentry fallback") throw new Error("Sentry unavailable");
      cb({ end: vi.fn(), setStatus: vi.fn() });
    });
    await expect(svc.submitJob({ jobId: "n104-runner-stop", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toEqual({
        jobId: "n104-runner-stop", deviceId: null, status: "queued",
        reason: blocker === "emergency stop" ? "emergency_stop" : "queue_only",
      });
    expect(run).not.toHaveBeenCalled();
    expect(await svc.getJobStatus("n104-runner-stop")).toMatchObject({ status: "unknown" });
  });

  it("resets a persisted job to queued when dispatch is blocked in the span callback", async () => {
    const svc = dispatchService();
    getRepos().capabilities.insert({
      id: "cap-n104-persisted", kernelId: DISPATCH_KERNEL, type: "fdm", name: "N104",
      materials: [], assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
      availability: {}, location: { lat: 0, lng: 0 },
    });
    getRepos().jobs.insert({
      id: "n104-persisted", stepId: "s", cwmId: "cwm-n104", capabilityId: "cap-n104-persisted",
      kernelId: DISPATCH_KERNEL, status: "queued", assignedDevices: [], progress: 0,
    });
    const run = vi.spyOn(JobRunner.prototype, "run");
    vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
      expect(getRepos().jobs.findById("n104-persisted")?.status).toBe("executing");
      stopDispatchKernel();
      if (path === "Sentry fallback") throw new Error("Sentry unavailable");
      cb({ end: vi.fn(), setStatus: vi.fn() });
    });
    await expect(svc.submitJob({ jobId: "n104-persisted", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toEqual({ jobId: "n104-persisted", deviceId: null, status: "queued", reason: "emergency_stop" });
    expect(run).not.toHaveBeenCalled();
    expect(getRepos().jobs.findById("n104-persisted")?.status).toBe("queued");
    expect(await svc.getJobStatus("n104-persisted")).toMatchObject({ status: "queued", progress: 0 });
  });
});

describe("N104 explicit local configuration", () => {
  it.each([undefined, "kernel-from-id-only"])("does not authorize generated defaults with KERNEL_ID=%s", async (id) => {
    vi.stubEnv("KERNEL_ID", id ?? "");
    if (id === undefined) delete process.env.KERNEL_ID;
    const svc = new KernelService();
    expect(svc.hasExplicitConfig).toBe(false);
    const run = vi.spyOn(JobRunner.prototype, "run");
    await expect(svc.submitJob({ jobId: "default-blocked", kernelId: svc.kernelId, stepId: "s" }))
      .resolves.toEqual({ jobId: "default-blocked", deviceId: null, status: "queued", reason: "no_configured_local_kernel" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["constructor", "KERNEL_CONFIG", "KERNEL_CONFIG_FILE"])("records explicit configuration from %s", (source) => {
    const config = { kernelId: DISPATCH_KERNEL, devices: [] };
    const dir = mkdtempSync(join(tmpdir(), "n104-kernel-config-"));
    try {
      if (source === "KERNEL_CONFIG") vi.stubEnv("KERNEL_CONFIG", JSON.stringify(config));
      if (source === "KERNEL_CONFIG_FILE") {
        const filename = join(dir, "kernel.json");
        writeFileSync(filename, JSON.stringify(config));
        vi.stubEnv("KERNEL_CONFIG_FILE", filename);
      }
      const svc = new KernelService(source === "constructor" ? config : undefined);
      expect(svc.hasExplicitConfig).toBe(true);
      expect(svc.kernelId).toBe(DISPATCH_KERNEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never treats the placeholder as a local identity even with an explicit config", async () => {
    const svc = dispatchService({ kernelId: "kernel_dev_001" });
    expect(svc.hasExplicitConfig).toBe(true);
    const run = vi.spyOn(JobRunner.prototype, "run");
    await expect(svc.submitJob({ jobId: "placeholder-blocked", kernelId: "kernel_dev_001", stepId: "s" }))
      .resolves.toEqual({ jobId: "placeholder-blocked", deviceId: null, status: "queued", reason: "no_configured_local_kernel" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not load or refresh DB machines under the placeholder (explicit=%s)", (explicit) => {
    const now = new Date().toISOString();
    getRepos().kernels.insert({
      id: "kernel_dev_001", name: "placeholder", operatorAddress: "operator-n104",
      location: { lat: 0, lng: 0 }, physicalAddress: "1 Bench Row", maxAssuranceTier: 2,
      publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1",
    } as never);
    getRepos().kernels.insertDevice({
      id: "dev-default-db", kernelId: "kernel_dev_001", type: "machine", model: "BENCH",
      firmware: "1.0", status: "idle", contributesToCapabilities: [], lastUpdated: now,
      adapterType: OFFLINE_TYPE,
    } as never);
    const svc = new KernelService(explicit ? { kernelId: "kernel_dev_001", devices: [] } : undefined);
    expect(svc.hasRunner("dev-default-db")).toBe(false);
    expect(svc.refreshDeviceFromDb("dev-default-db"))
      .toEqual({ installed: false, reason: "no_configured_local_kernel" });
    expect(svc.hasRunner("dev-default-db")).toBe(false);
  });
});

it("does not dispatch a second runner if Sentry throws after invoking the callback", async () => {
  const svc = dispatchService();
  const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
  vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
    cb({ end: vi.fn(), setStatus: vi.fn() });
    throw new Error("Sentry failed after dispatch");
  });
  await expect(svc.submitJob({ jobId: "n104-once", kernelId: DISPATCH_KERNEL, stepId: "s" }))
    .resolves.toEqual({ jobId: "n104-once", deviceId: "dev-n104", status: "accepted" });
  expect(run).toHaveBeenCalledTimes(1);
});

describe("N104 listDevices runtime inventory", () => {
  it("bounds a stalled direct health check and returns only the fixed adapter error", async () => {
    vi.useFakeTimers();
    const svc = dispatchService({
      devices: [{ id: "dev-n104-slow", type: "machine", adapterType: SLOW_TYPE, config: {} }],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let completed = false;
    const health = svc.checkDeviceHealth("dev-n104-slow").then((result) => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await health).toEqual({ healthy: false, details: "adapter_error" });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a runtime factory whose adapter id differs from its config id", async () => {
    const svc = dispatchService({
      devices: [{ id: "configured-device-id", type: "machine", adapterType: DIFFERENT_ID_TYPE, config: {} }],
    });
    expect(svc.hasRunner("runtime-device-id")).toBe(true);
    expect(await svc.listDevices()).toContainEqual({
      id: "runtime-device-id", type: "machine", adapterType: "unknown", healthStatus: "offline",
    });
  });

  it("bounds a slow DB device's health check and reports unknown while other devices stay healthy", async () => {
    vi.useFakeTimers();
    seedDispatchKernel();
    getRepos().kernels.insertDevice({
      id: "dev-n104-slow", kernelId: DISPATCH_KERNEL, type: "machine", model: "BENCH",
      firmware: "1.0", status: "idle", contributesToCapabilities: [], lastUpdated: new Date().toISOString(),
      adapterType: SLOW_TYPE,
    } as never);
    const svc = dispatchService();
    expect(svc.hasRunner("dev-n104-slow")).toBe(true);
    let completed = false;
    const inventory = svc.listDevices().then((devices) => { completed = true; return devices; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await inventory).toEqual(expect.arrayContaining([
      { id: "dev-n104", type: "machine", adapterType: "mock", healthStatus: "healthy" },
      { id: "dev-n104-slow", type: "machine", adapterType: SLOW_TYPE, healthStatus: "unknown" },
    ]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes DB-registered runners absent from config and keeps live adapter metadata", async () => {
    seedDispatchKernel();
    const now = new Date().toISOString();
    getRepos().kernels.insertDevice({
      id: "dev-n104-db", kernelId: DISPATCH_KERNEL, type: "machine", model: "BENCH",
      firmware: "1.0", status: "idle", contributesToCapabilities: [], lastUpdated: now,
      adapterType: OFFLINE_TYPE,
    } as never);
    const svc = initKernelService({
      kernelId: DISPATCH_KERNEL,
      devices: [{ id: "dev-n104", type: "machine", adapterType: "mock", config: {} }],
    });
    expect(svc.hasRunner("dev-n104-db")).toBe(true);
    expect(await svc.listDevices()).toEqual(expect.arrayContaining([
      { id: "dev-n104", type: "machine", adapterType: "mock", healthStatus: "healthy" },
      { id: "dev-n104-db", type: "machine", adapterType: OFFLINE_TYPE, healthStatus: "offline" },
    ]));
    const { default: Fastify } = await import("fastify");
    const { setupRoutes } = await import("../routes/setup.js");
    const app = Fastify({ logger: false });
    try {
      await app.register(setupRoutes);
      const detected = await app.inject({ method: "GET", url: "/api/setup/detect" });
      expect(detected.statusCode).toBe(200);
      expect(detected.json().kernelService).toMatchObject({
        ready: true,
        devices: expect.arrayContaining([
          { id: "dev-n104-db", type: "machine", adapterType: OFFLINE_TYPE, healthy: false },
        ]),
      });
    } finally {
      await app.close();
    }
    // A refreshed DB registration can replace a configured runner; report
    // the installed adapter rather than stale config metadata.
    getRepos().kernels.insertDevice({
      id: "dev-n104", kernelId: DISPATCH_KERNEL, type: "machine", model: "BENCH",
      firmware: "1.0", status: "idle", contributesToCapabilities: [], lastUpdated: now,
      adapterType: OFFLINE_TYPE,
    } as never);
    expect(svc.refreshDeviceFromDb("dev-n104")).toEqual({ installed: true });
    expect(await svc.listDevices()).toContainEqual({
      id: "dev-n104", type: "machine", adapterType: OFFLINE_TYPE, healthStatus: "offline",
    });
  });
});
