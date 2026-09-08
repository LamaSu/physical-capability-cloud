/**
 * JobRunner safety-boundary tests (R-11).
 *
 * The memo item these cover: "physical safety is not implied by economic
 * authorization". A job can be fully funded and still must not actuate
 * hardware if the safety policy prohibits the command. JobRunner is the last
 * place that can be enforced — it holds the MachineAdapter reference — so
 * these tests assert against machine.execute() call counts, not against
 * SafetyGateway internals (those are covered in safety/__tests__/gateway.test.ts).
 *
 * The negative control is a MISSING EXECUTION SCOPE. That is the prohibition
 * the SafetyGovernor really enforces under its default config: load_gcode and
 * start are class "scoped" (governor.ts Class 3 — "protocol upload, run"), and
 * isClassAllowed() returns !!cmd.scopeId for that class. E-stop and an open
 * circuit breaker are tested as two further real prohibitions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner, toPhysicalCommand } from "../job-runner.js";
import { SafetyGateway, resetSafetyGateway } from "../safety/gateway.js";
import type { PhysicalCommand } from "../safety/governor.js";
import type {
  MachineAdapter,
  MachineCommand,
  SensorAdapter,
  CameraAdapter,
} from "../adapters/types.js";
import type { EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

// Mock Sentry so spans are pass-through and no network calls are made.
vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-safety-test";
const DEVICE_ID = "dev-safety-001";
const GCODE_HASH =
  "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256;
const SCOPE_ID = "scope-authorized-1";

function makeSource(): EvidenceSource {
  return { deviceId: DEVICE_ID, deviceType: "controller", kernelId: KERNEL_ID };
}

function makeEvent(type: string): Omit<EvidenceEvent, "id" | "hash"> {
  return {
    type: type as EvidenceEvent["type"],
    timestamp: new Date().toISOString(),
    source: makeSource(),
    payload: {},
  };
}

/** Machine adapter that succeeds every command and records what it received. */
function makeMockMachine(): MachineAdapter & { received: MachineCommand[] } {
  const listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  const received: MachineCommand[] = [];

  const machine = {
    id: DEVICE_ID,
    type: "fdm" as const,
    source: makeSource(),
    received,
    getStatus: vi.fn().mockResolvedValue("idle"),
    getProgress: vi.fn().mockResolvedValue(100),
    execute: vi.fn().mockImplementation(async (cmd: MachineCommand) => {
      received.push(cmd);
      if (cmd.type === "load_gcode") {
        for (const ev of [makeEvent("gcode_hash_verified"), makeEvent("execution_completed")]) {
          for (const cb of listeners) cb(ev);
        }
        // Let the emitter's async hashing settle before finalizeBundle.
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true };
    }),
    onEvidence: vi.fn().mockImplementation((cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) => {
      listeners.push(cb);
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  return machine as unknown as MachineAdapter & { received: MachineCommand[] };
}

function makeMockSensor(): SensorAdapter {
  return {
    id: "sensor-safety-001",
    type: "power_monitor" as const,
    source: makeSource(),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn().mockResolvedValue(makeEvent("power_profile_summary")),
    getCurrentReading: vi.fn().mockResolvedValue({ watts: 42 }),
    onEvidence: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as SensorAdapter;
}

function makeMockCamera(): CameraAdapter {
  return {
    id: "camera-safety-001",
    source: makeSource(),
    captureSnapshot: vi.fn().mockResolvedValue({ imageHash: "sha256:img", storageRef: "ref" }),
    runInspection: vi
      .fn()
      .mockResolvedValue({ passed: true, confidence: 0.99, findings: [], imageHash: "sha256:img" }),
    onEvidence: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as CameraAdapter;
}

let emitter: EvidenceEmitter;

beforeEach(() => {
  emitter = new EvidenceEmitter(KERNEL_ID);
  resetSafetyGateway();
  vi.clearAllMocks();
});

afterEach(() => {
  resetSafetyGateway();
});

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

describe("toPhysicalCommand — MachineCommand → PhysicalCommand mapping", () => {
  const ctx = { jobId: "job-1", stepId: "step-1", agentDid: "did:key:agent", scopeId: SCOPE_ID };

  it("classifies actuation commands as 'scoped' and status as 'read'", () => {
    expect(toPhysicalCommand({ type: "load_gcode" }, DEVICE_ID, ctx).class).toBe("scoped");
    expect(toPhysicalCommand({ type: "start" }, DEVICE_ID, ctx).class).toBe("scoped");
    expect(toPhysicalCommand({ type: "pause" }, DEVICE_ID, ctx).class).toBe("safe");
    expect(toPhysicalCommand({ type: "resume" }, DEVICE_ID, ctx).class).toBe("safe");
    expect(toPhysicalCommand({ type: "stop" }, DEVICE_ID, ctx).class).toBe("safe");
    expect(toPhysicalCommand({ type: "status" }, DEVICE_ID, ctx).class).toBe("read");
  });

  it("carries deviceId, agentDid, scopeId and an auditable commandId", () => {
    const physical = toPhysicalCommand({ type: "start" }, DEVICE_ID, ctx);
    expect(physical.deviceId).toBe(DEVICE_ID);
    expect(physical.agentDid).toBe("did:key:agent");
    expect(physical.scopeId).toBe(SCOPE_ID);
    expect(physical.commandId).toBe("job-1:step-1:start");
  });

  it("passes params through by reference (no validate-then-mutate gap)", () => {
    const payload = { gcodeHash: GCODE_HASH };
    const physical = toPhysicalCommand({ type: "load_gcode", payload }, DEVICE_ID, ctx);
    expect(physical.params).toBe(payload);
  });

  it("does NOT downgrade the class when the scope is missing", () => {
    const unscoped = { jobId: "job-1", stepId: "step-1", agentDid: "did:key:agent" };
    expect(toPhysicalCommand({ type: "load_gcode" }, DEVICE_ID, unscoped).class).toBe("scoped");
    expect(toPhysicalCommand({ type: "start" }, DEVICE_ID, unscoped).class).toBe("scoped");
  });
});

// ---------------------------------------------------------------------------
// (a) POSITIVE — an admitted job actuates, through the gateway
// ---------------------------------------------------------------------------

describe("JobRunner — admitted job (positive control)", () => {
  it("dispatches exactly load_gcode then start, and both are gateway-admitted", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const relaySpy = vi.spyOn(gateway, "validateAndRelay");
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const result = await runner.run({
      jobId: "job-admitted-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });

    expect(result.success).toBe(true);

    // Exactly two actuation commands, in order.
    expect(machine.execute).toHaveBeenCalledTimes(2);
    expect(machine.received.map((c) => c.type)).toEqual(["load_gcode", "start"]);

    // Every one of them went through the gateway.
    expect(relaySpy).toHaveBeenCalledTimes(2);
    const admitted = relaySpy.mock.calls.map((c) => c[0] as PhysicalCommand);
    expect(admitted.map((c) => c.type)).toEqual(["load_gcode", "start"]);
    expect(admitted.every((c) => c.class === "scoped")).toBe(true);
    expect(admitted.every((c) => c.scopeId === SCOPE_ID)).toBe(true);
    expect(admitted.map((c) => c.commandId)).toEqual([
      "job-admitted-1:step-1:load_gcode",
      "job-admitted-1:step-1:start",
    ]);
  });

  it("validates the IDENTICAL object the adapter receives", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const relaySpy = vi.spyOn(gateway, "validateAndRelay");
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    await runner.run({
      jobId: "job-identity-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });

    const validatedLoad = relaySpy.mock.calls[0][0] as PhysicalCommand;
    const executedLoad = machine.received[0];

    // Reference identity: the params the governor inspected ARE the payload
    // object the adapter received. Nothing was swapped in between.
    expect(validatedLoad.params).toBe(executedLoad.payload);
    expect(validatedLoad.type).toBe(executedLoad.type);
    expect((executedLoad.payload as { gcodeHash: string }).gcodeHash).toBe(GCODE_HASH);
  });

  it("defaults agentDid to a stable per-device DID when the caller supplies none", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const relaySpy = vi.spyOn(gateway, "validateAndRelay");
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    await runner.run({
      jobId: "job-did-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });

    expect((relaySpy.mock.calls[0][0] as PhysicalCommand).agentDid).toBe(
      `did:pcc:device:${DEVICE_ID}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) NEGATIVE CONTROL — a prohibited command causes ZERO actuation
// ---------------------------------------------------------------------------

describe("JobRunner — prohibited command (negative control)", () => {
  it("NEGATIVE CONTROL: a job with no execution scope calls machine.execute ZERO times", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const result = await runner.run({
      jobId: "job-unscoped-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      // no scopeId — load_gcode/start are class "scoped", so this is prohibited
    });

    // THE ASSERTION THAT PROVES ZERO ACTUATION:
    expect(machine.execute).toHaveBeenCalledTimes(0);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^safety: /);
    expect(result.error).toContain("scope");
  });

  it("NEGATIVE CONTROL: an engaged e-stop causes ZERO actuation", async () => {
    const gateway = new SafetyGateway({ initialHardwareState: { isEStopEngaged: true } });
    const machine = makeMockMachine();
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const result = await runner.run({
      jobId: "job-estop-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID, // economically authorized AND scoped — still denied
    });

    expect(machine.execute).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    // governor.ts:139 returns the family reason on the interlock path; the
    // specific check detail ("E-stop is engaged") stays in verdict.checks,
    // which JobResult does not carry.
    expect(result.error).toBe("safety: Hardware interlock active");
  });

  it("NEGATIVE CONTROL: an open circuit breaker causes ZERO actuation", async () => {
    const gateway = new SafetyGateway({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
    });
    gateway.recordDeviceFailure(DEVICE_ID); // trip it
    const machine = makeMockMachine();
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const result = await runner.run({
      jobId: "job-breaker-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });

    expect(machine.execute).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Circuit breaker OPEN");
  });

  it("fails closed when the SafetyGateway singleton was never initialized", async () => {
    resetSafetyGateway();
    const machine = makeMockMachine();
    // No gateway injected → falls back to the singleton, which is absent.
    const runner = new JobRunner(machine, [], null, emitter);

    const result = await runner.run({
      jobId: "job-nogateway-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });

    expect(machine.execute).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("safety: safety gateway unavailable");
  });
});

// ---------------------------------------------------------------------------
// (c) The load_gcode denial short-circuits the whole pipeline
// ---------------------------------------------------------------------------

describe("JobRunner — denial short-circuits every downstream phase", () => {
  it("starts no sensors, takes no snapshot, and never issues start", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const sensor = makeMockSensor();
    const camera = makeMockCamera();
    const runner = new JobRunner(machine, [sensor], camera, emitter, gateway);

    // Tier 2 so that, if admitted, sensors AND the before-snapshot would run.
    const result = await runner.run({
      jobId: "job-shortcircuit-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 2,
      // no scopeId → load_gcode denied at phase 1
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^safety: /);

    // Nothing downstream of the denied load_gcode ran.
    expect(machine.execute).toHaveBeenCalledTimes(0);
    expect(sensor.startRecording).not.toHaveBeenCalled();
    expect(sensor.stopRecording).not.toHaveBeenCalled();
    expect(camera.captureSnapshot).not.toHaveBeenCalled();
    expect(camera.runInspection).not.toHaveBeenCalled();
  });

  it("reports the tier-2 failure path is not reached — the safety reason wins", async () => {
    const gateway = new SafetyGateway();
    const machine = makeMockMachine();
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const result = await runner.run({
      jobId: "job-shortcircuit-2",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 2,
    });

    // A denied job fails with the safety reason, NOT with a tier-evidence
    // complaint — proving the pipeline stopped at phase 1.
    expect(result.error).toMatch(/^safety: /);
    expect(result.error).not.toContain("requirements not met");
  });
});

// ---------------------------------------------------------------------------
// Adapter failures still reach the breaker (the gateway's own contract)
// ---------------------------------------------------------------------------

describe("JobRunner — real device failures are recorded on the breaker", () => {
  it("a self-reported {success:false} load trips the breaker after the threshold", async () => {
    const gateway = new SafetyGateway({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
    });
    const machine = makeMockMachine();
    (machine.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      message: "Load failed",
    });
    const runner = new JobRunner(machine, [], null, emitter, gateway);

    const first = await runner.run({
      jobId: "job-devfail-1",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });
    expect(first.success).toBe(false);
    expect(first.error).toContain("Failed to load G-code");
    expect(machine.execute).toHaveBeenCalledTimes(1);

    // Breaker is now open — the next job is denied before touching hardware.
    const second = await runner.run({
      jobId: "job-devfail-2",
      stepId: "step-1",
      gcodeHash: GCODE_HASH,
      assuranceTier: 0,
      scopeId: SCOPE_ID,
    });
    expect(second.error).toContain("Circuit breaker OPEN");
    expect(machine.execute).toHaveBeenCalledTimes(1); // still 1 — no new actuation
  });
});
