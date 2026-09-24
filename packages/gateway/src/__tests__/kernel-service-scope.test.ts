/**
 * KernelService → JobRunner execution-scope threading.
 *
 * Gateway-side follow-up to the JobRunner safety boundary (G-8c / R-11).
 *
 * JobRunner classifies load_gcode and start as class "scoped", and the
 * SafetyGovernor denies a scoped command that carries no execution scope
 * (isClassAllowed() is literally `return !!cmd.scopeId` for that class). Under
 * the default governor config that class check is the ONLY check that bites a
 * job command — there is no e-stop, the breaker starts empty, and the
 * velocity/temperature/force envelope checks never fire because load_gcode's
 * payload is {gcodeHash}. So the scope is the whole of the enforcement, and
 * these tests are about whether the gateway carries it.
 *
 * Two independent layers are asserted here, because the claim is defence in
 * depth and a test that only covers the outer layer would not notice the inner
 * one rotting:
 *
 *   Layer 1 — submitJob's synchronous pre-flight (gateway.validateOnly).
 *   Layer 2 — JobRunner's own dispatch boundary (gateway.validateAndRelay),
 *             reached out-of-band inside the fire-and-forget runner.run().
 *
 * External services (Sentry, SSE, storage, chain) are mocked so this runs
 * purely in-memory — same approach as kernel-service-safety.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────
// Sentry: startSpan/startSpanManual must invoke their callbacks so runner.run()
// actually executes rather than being swallowed.
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

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_scope" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_scope_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xks_scope_evidence" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xks_scope_release" }),
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
import { initStore, closeStore, getRepos } from "../db.js";
import { KernelService } from "../services/kernel-service.js";
import {
  JobRunner,
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
  registerMachineAdapter,
  unregisterMachineAdapter,
} from "@pcc/kernel";
import type { MachineAdapter, KernelConfig } from "@pcc/kernel";

// ── Test adapter ──────────────────────────────────────────────────────────────

/**
 * Records every command that reaches the "hardware". `executed` is the spy the
 * negative controls assert on — if the boundary works, it stays empty.
 */
const executed: Array<{ deviceId: string; type: string; payload: unknown }> = [];

class RecordingAdapter implements MachineAdapter {
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
  async execute(
    command: Parameters<MachineAdapter["execute"]>[0],
  ): ReturnType<MachineAdapter["execute"]> {
    executed.push({ deviceId: this.id, type: command.type, payload: command.payload });
    return { success: true };
  }
  /** 100 → waitForCompletion() returns on its first poll, so no timers. */
  async getProgress(): Promise<number> {
    return 100;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  async dispose(): Promise<void> {}
}

const REC_TYPE = "test-recording-ks-scope";
const DEVICE_ID = "dev-scope";
const KERNEL_ID = "kernel-ks-scope";
const SCOPE_ID = "scope-ks-scope-001";
const AGENT_DID = "did:pcc:agent:ks-scope-tester";

function makeConfig(): KernelConfig {
  return {
    kernelId: KERNEL_ID,
    mockMode: false,
    devices: [{ id: DEVICE_ID, type: "machine", adapterType: REC_TYPE, config: {} }],
  };
}

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
  try { unregisterMachineAdapter(REC_TYPE); } catch { /* not registered */ }
  registerMachineAdapter(REC_TYPE, (device, _cfg, kernelId) => new RecordingAdapter(device.id, kernelId));
});

afterAll(() => {
  try { unregisterMachineAdapter(REC_TYPE); } catch { /* already gone */ }
});

/**
 * The one spy that lives on a SHARED prototype and therefore has to be undone
 * by hand. Instance spies (on the SafetyGateway singleton) die with the
 * instance, since every test resets and re-inits the singleton.
 *
 * NB: afterEach deliberately uses clearAllMocks, not restoreAllMocks —
 * restoreAllMocks also strips the implementations off the hoisted vi.mock
 * factories above, which silently turns Sentry.startSpanManual into a no-op
 * that never invokes its callback, so runner.run() never fires and every test
 * after the first one "passes" without executing anything.
 */
let runSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  resetSafetyGateway();
  initSafetyGateway();
  executed.length = 0;
});

afterEach(() => {
  runSpy?.mockRestore();
  runSpy = null;
  resetSafetyGateway();
  closeStore();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The threading itself
// ─────────────────────────────────────────────────────────────────────────────

describe("KernelService.submitJob — threads the execution scope into JobRunner", () => {
  it("passes scopeId and agentDid into runner.run()'s config", async () => {
    // Spy WITHOUT a mock implementation: run() still executes for real, we just
    // get to read the config it was handed.
    const spy = vi.spyOn(JobRunner.prototype, "run");
    runSpy = spy;
    const svc = new KernelService(makeConfig());

    await svc.submitJob({
      jobId: "ks-scope-thread-1",
      stepId: "s",
      assuranceTier: 0,
      deviceId: DEVICE_ID,
      scopeId: SCOPE_ID,
      agentDid: AGENT_DID,
    });

    await waitFor(() => spy.mock.calls.length > 0);

    const config = spy.mock.calls[0][0] as { scopeId?: string; agentDid?: string };
    // THE ASSERTION THIS WHOLE LANE EXISTS FOR: the credential reaches the
    // dispatch boundary. Before this change the config was
    // {jobId, stepId, gcodeHash, assuranceTier, onPhase} and these were absent.
    expect(config.scopeId).toBe(SCOPE_ID);
    expect(config.agentDid).toBe(AGENT_DID);
  });

  it("a scoped job actually actuates, and both commands carry the scope to the governor", async () => {
    const gw = getSafetyGateway();
    const relaySpy = vi.spyOn(gw, "validateAndRelay");

    const svc = new KernelService(makeConfig());
    await svc.submitJob({
      jobId: "ks-scope-run-1",
      stepId: "s",
      assuranceTier: 0,
      deviceId: DEVICE_ID,
      scopeId: SCOPE_ID,
      agentDid: AGENT_DID,
    });

    // Positive control: with a scope, the job runs end to end.
    await waitFor(() => executed.length >= 2);
    expect(executed.map((e) => e.type)).toEqual(["load_gcode", "start"]);

    // Every command the governor saw was class "scoped" AND carried the scope
    // the caller supplied — not a downgraded class, not a synthesised scope.
    const relayed = relaySpy.mock.calls.map((c) => c[0]);
    expect(relayed.map((c) => c.type)).toEqual(["load_gcode", "start"]);
    for (const cmd of relayed) {
      expect(cmd.class).toBe("scoped");
      expect(cmd.scopeId).toBe(SCOPE_ID);
      expect(cmd.agentDid).toBe(AGENT_DID);
      expect(cmd.deviceId).toBe(DEVICE_ID);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NEGATIVE CONTROL — layer 1: the synchronous pre-flight
// ─────────────────────────────────────────────────────────────────────────────

describe("KernelService.submitJob — NEGATIVE CONTROL: no execution scope", () => {
  it("denies an unscoped submission and calls machine.execute ZERO times", async () => {
    const svc = new KernelService(makeConfig());

    await expect(
      svc.submitJob({
        jobId: "ks-scope-unscoped-1",
        stepId: "s",
        assuranceTier: 0,
        deviceId: DEVICE_ID,
        // no scopeId — load_gcode/start are class "scoped", so this is prohibited
      }),
    ).rejects.toThrow(/Class 'scoped' requires active scope/);

    // THE ASSERTION THAT PROVES ZERO ACTUATION:
    expect(executed).toHaveLength(0);

    // And nothing was recorded as accepted/running either.
    expect(await svc.getJobStatus("ks-scope-unscoped-1")).toMatchObject({ status: "unknown" });
  });

  it("does not blame the device: an unscoped denial leaves the breaker untouched", async () => {
    const gw = getSafetyGateway();
    const svc = new KernelService(makeConfig());

    await expect(
      svc.submitJob({ jobId: "ks-scope-unscoped-2", stepId: "s", assuranceTier: 0, deviceId: DEVICE_ID }),
    ).rejects.toThrow(/Class 'scoped' requires active scope/);

    // A missing credential is the CALLER's fault, not the device's. Counting it
    // as a device failure would let an unauthorised caller trip a healthy
    // device's breaker and deny service to everyone else.
    expect(gw.getStatus().circuits.get(DEVICE_ID)?.failures ?? 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NEGATIVE CONTROL — layer 2: the dispatch boundary holds on its own
// ─────────────────────────────────────────────────────────────────────────────

describe("KernelService.submitJob — NEGATIVE CONTROL: dispatch boundary is independent", () => {
  it("with the pre-flight bypassed, the runner still denies: ZERO execute, job recorded failed", async () => {
    const gw = getSafetyGateway();

    // Simulate the OUTER layer failing open, to prove the INNER one holds by
    // itself. Only the pre-flight command is waved through — commandIds are
    // `preflight:<jobId>` (kernel-service) vs `<jobId>:<stepId>:<type>`
    // (job-runner), so the runner's own validateOnly calls, made from inside
    // validateAndRelay, still hit the REAL governor with the REAL config.
    const realValidateOnly = gw.validateOnly.bind(gw);
    vi.spyOn(gw, "validateOnly").mockImplementation(async (cmd) => {
      if (typeof cmd?.commandId === "string" && cmd.commandId.startsWith("preflight:")) {
        return { allowed: true, executed: false } as Awaited<ReturnType<typeof realValidateOnly>>;
      }
      return realValidateOnly(cmd);
    });

    const jobId = "ks-scope-bypass-1";
    getRepos().jobs.insert({
      id: jobId,
      stepId: "s",
      cwmId: `cwm-${jobId}`,
      capabilityId: "cap-ks-scope",
      kernelId: KERNEL_ID,
      status: "queued",
      assignedDevices: [],
      startedAt: new Date().toISOString(),
      progress: 0,
      assuranceTier: 0,
    } as never);

    const svc = new KernelService(makeConfig());

    // The pre-flight lets it through, so the job IS accepted...
    const accepted = await svc.submitJob({
      jobId,
      stepId: "s",
      assuranceTier: 0,
      deviceId: DEVICE_ID,
      // still no scopeId
    });
    expect(accepted.status).toBe("accepted");

    // ...and then the dispatch boundary refuses it out of band.
    await waitFor(() => getRepos().jobs.findById(jobId)?.status === "failed");

    // THE ASSERTION THAT PROVES ZERO ACTUATION, with admission bypassed:
    expect(executed).toHaveLength(0);
    expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The pre-flight class is no longer downgraded
// ─────────────────────────────────────────────────────────────────────────────

describe("KernelService.submitJob — pre-flight class is fixed, not downgraded", () => {
  it("validates an UNSCOPED submission as class 'scoped', never as 'safe'", async () => {
    const gw = getSafetyGateway();
    const validateSpy = vi.spyOn(gw, "validateOnly");
    const svc = new KernelService(makeConfig());

    await expect(
      svc.submitJob({ jobId: "ks-scope-class-1", stepId: "s", assuranceTier: 0, deviceId: DEVICE_ID }),
    ).rejects.toThrow(/denied/i);

    const preflight = validateSpy.mock.calls
      .map((c) => c[0])
      .find((c) => c.commandId === "preflight:ks-scope-class-1");
    expect(preflight).toBeDefined();

    // This is the regression this test exists to pin. The old line was
    // `params.scopeId ? "scoped" : "safe"`, so an unscoped job was described to
    // the governor as "safe" — the one class the default config always admits —
    // and admission could therefore never fail. "safe" here is the bug.
    expect(preflight!.class).toBe("scoped");
    expect(preflight!.scopeId).toBeUndefined();
  });

  it("uses the same class for a SCOPED submission — the class does not track the credential", async () => {
    const gw = getSafetyGateway();
    const validateSpy = vi.spyOn(gw, "validateOnly");
    const svc = new KernelService(makeConfig());

    await svc.submitJob({
      jobId: "ks-scope-class-2",
      stepId: "s",
      assuranceTier: 0,
      deviceId: DEVICE_ID,
      scopeId: SCOPE_ID,
    });

    const preflight = validateSpy.mock.calls
      .map((c) => c[0])
      .find((c) => c.commandId === "preflight:ks-scope-class-2");
    expect(preflight!.class).toBe("scoped");
    expect(preflight!.scopeId).toBe(SCOPE_ID);
  });
});
