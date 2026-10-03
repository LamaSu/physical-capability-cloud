/**
 * Where a failed run failed (JobResult.failure, astra pack 190, MEDIUM (d); the breaker policy is the
 * gateway's, #5417): the caller charges the device the run names, never the machine for a sensor's or a
 * camera's fault. Each failure path names its origin; a busy refusal names none, for it is no failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256, Signature } from "@pcc/spec";


import type { CameraAdapter, MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import type { JobResult } from "../job-runner.js";

// Plain functions, not vi.fn(), so vi.restoreAllMocks() cannot strip them.
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
type DeviceType = EvidenceSource["deviceType"];

const KERNEL_ID = "kernel-scope-test";
const STEP = "step-1";
const GUARD_MS = 2_000;
const STILL_PENDING = `run() still pending after ${GUARD_MS} ms`;

function evidence(type: Emitted["type"], deviceId: string, deviceType: DeviceType, payload: Record<string, unknown> = {}): Emitted {
  return { type, timestamp: new Date().toISOString(), source: { deviceId, deviceType, kernelId: KERNEL_ID }, payload };
}

/** The Tier 1 events a machine emits while it loads a job's G-code, tagged with that job's hash. */
function tier1(machineId: string, gcodeHash: string): Emitted[] {
  return [
    evidence("gcode_hash_verified", machineId, "controller", { gcodeHash }),
    evidence("execution_completed", machineId, "controller", { gcodeHash }),
    evidence("power_profile_summary", `${machineId}-power`, "power_monitor", { gcodeHash }),
  ];
}

const gcode = (n: number): SHA256 => `sha256:${n.toString(16).padStart(64, "0")}` as SHA256;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface TestMachine extends MachineAdapter {
  /** Deliver an event to every listener, as the device would. */
  emit(event: Emitted): void;
  /** Every command type this machine was sent, in order. */
  readonly commands: string[];
  /** The command that fails, if any. */
  failing: "load_gcode" | "start" | null;
  /** Progress reported to waitForCompletion. */
  progress: () => number;
  /** Status reported to waitForCompletion while progress is under 100. */
  status: MachineStatus;
  /** Resolves once start has been called n times. */
  started(n: number): Promise<void>;
}

function testMachine(
  id: string,
  options: {
    /** Events emitted during load_gcode. Default: the Tier 1 set for the job's G-code. */
    onLoad?: (machineId: string, gcodeHash: string) => Emitted[];
    /** Hold the nth start (1-based) until its promise resolves. */
    holdStart?: Map<number, Promise<void>>;
  } = {},
): TestMachine {
  const listeners: Array<(event: Emitted) => void> = [];
  const commands: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let starts = 0;
  const machine: TestMachine = {
    id,
    type: "fdm",
    source: { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands,
    failing: null,
    progress: () => 100,
    status: "busy",
    async getStatus() {
      return machine.status;
    },
    async getProgress() {
      return machine.progress();
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      commands.push(command.type);
      if (command.type === "load_gcode") {
        for (const e of (options.onLoad ?? tier1)(id, String(command.payload?.gcodeHash))) machine.emit(e);
      }
      if (command.type === "start") {
        starts += 1;
        for (const w of waiters) if (w.n <= starts) w.resolve();
        await options.holdStart?.get(starts);
      }
      if (machine.failing === command.type) return { success: false, message: `${command.type} refused` };
      return { success: true, message: "ok" };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    started(n) {
      return new Promise((resolve) => {
        if (starts >= n) resolve();
        else waiters.push({ n, resolve });
      });
    },
    // It emits inside the command that causes it; an event a test sends through emit()
    // later is one this hook did not cover (a device breaking its contract).
    async quiesceEvidence() {},
    async dispose() {},
  };
  return machine;
}


beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A sensor whose start or stop the test decides; it emits nothing. */
function sensorOf(id: string, opts: { start?: () => Promise<void>; stop?: () => Promise<Emitted> } = {}): SensorAdapter {
  return {
    id,
    type: "power_monitor",
    source: { deviceId: id, deviceType: "power_monitor", kernelId: KERNEL_ID },
    startRecording: opts.start ?? (async () => {}),
    stopRecording: opts.stop ?? (async () => evidence("power_profile_summary", id, "power_monitor")),
    getCurrentReading: async () => ({}),
    onEvidence: () => {},
    quiesceEvidence: async () => {},
    dispose: async () => {},
  } as unknown as SensorAdapter;
}

/** A camera whose snapshot or inspection the test decides; it emits nothing. */
function cameraOf(id: string, opts: { snapshot?: () => Promise<unknown>; inspect?: () => Promise<unknown> } = {}): CameraAdapter {
  return {
    id,
    source: { deviceId: id, deviceType: "camera", kernelId: KERNEL_ID },
    captureSnapshot: opts.snapshot ?? (async () => ({})),
    runInspection: opts.inspect ?? (async () => ({})),
    onEvidence: () => {},
    quiesceEvidence: async () => {},
    dispose: async () => {},
  } as unknown as CameraAdapter;
}

const job = (jobId: string, n: number, assuranceTier: 0 | 1 | 2 = 1) => ({ jobId, stepId: STEP, gcodeHash: gcode(n), assuranceTier });

describe("JobResult.failure: where a failed run failed (#5417)", () => {
  it("astra's recipe: a working machine and a sensor whose start throws charge the sensor, never the machine, on every run", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-recipe");
    const sensor = sensorOf("sensor-origin-recipe", { start: async () => Promise.reject(new Error("sensor offline")) });
    const first = await new JobRunner(machine, [sensor], null, emitter).run(job("job-origin-1", 61));
    const second = await new JobRunner(machine, [sensor], null, emitter).run(job("job-origin-2", 62));
    for (const result of [first, second]) {
      expect.soft(result.success, "the run").toBe(false);
      expect.soft(result.failure, "where it failed").toEqual({ origin: "sensor", adapterId: "sensor-origin-recipe" });
    }
  });

  it("a machine that refuses its G-code: origin machine", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-load");
    machine.failing = "load_gcode";
    const result = await new JobRunner(machine, [], null, emitter).run(job("job-origin-load", 63, 0));
    expect.soft(result.failure).toEqual({ origin: "machine", adapterId: "m-origin-load" });
  });

  it("a machine whose start rejects: origin machine", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-start-rejects");
    const execute = machine.execute.bind(machine);
    machine.execute = async (command) => (command.type === "start" ? Promise.reject(new Error("link lost")) : execute(command));
    const result = await new JobRunner(machine, [], null, emitter).run(job("job-origin-start", 64, 0));
    expect.soft(result.error).toBe("link lost");
    expect.soft(result.failure).toEqual({ origin: "machine", adapterId: "m-origin-start-rejects" });
  });

  it("a sensor whose stop throws: origin sensor", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-sensor-stop");
    const sensor = sensorOf("sensor-origin-stop", { stop: async () => Promise.reject(new Error("stop failed")) });
    const result = await new JobRunner(machine, [sensor], null, emitter).run(job("job-origin-sensor-stop", 65));
    expect.soft(result.failure).toEqual({ origin: "sensor", adapterId: "sensor-origin-stop" });
  });

  it.each([
    ["its snapshot", { snapshot: async () => Promise.reject(new Error("lens cap on")) }],
    ["its inspection", { inspect: async () => Promise.reject(new Error("model not loaded")) }],
  ] as const)("a camera whose %s throws: origin camera", async (_what, opts) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine(`m-origin-camera-${_what}`);
    const camera = cameraOf(`camera-origin-${_what}`, opts);
    const result = await new JobRunner(machine, [], camera, emitter).run(job(`job-origin-camera-${_what}`, 66, 2));
    expect.soft(result.failure).toEqual({ origin: "camera", adapterId: `camera-origin-${_what}` });
  });

  it("Tier 2 requirements not met: origin evidence", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-tier", { onLoad: () => [] }); // it reports nothing
    const result = await new JobRunner(machine, [], cameraOf("camera-origin-tier"), emitter).run(job("job-origin-tier", 67, 2));
    expect.soft(result.error ?? "").toMatch(/^Tier 2 requirements not met/);
    expect.soft(result.failure).toEqual({ origin: "evidence" });
  });

  it("an event that could not be recorded: origin evidence", async () => {
    class FailingEmitter extends EvidenceEmitter {
      override addEvent(): Promise<EvidenceEvent> {
        return Promise.reject(new Error("storage full"));
      }
    }
    const machine = testMachine("m-origin-unrecorded");
    const result = await new JobRunner(machine, [], null, new FailingEmitter(KERNEL_ID)).run(job("job-origin-unrecorded", 68, 0));
    expect.soft(result.error ?? "").toMatch(/could not be recorded/);
    expect.soft(result.failure).toEqual({ origin: "evidence" });
  });

  it("an adapter that throws while the session opens: origin configuration; a step that cannot be registered: origin evidence", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const broken = testMachine("m-origin-setup");
    broken.onEvidence = () => {
      throw new Error("cannot listen");
    };
    expect.soft((await new JobRunner(broken, [], null, emitter).run(job("job-origin-setup", 69, 0))).failure).toEqual({ origin: "configuration" });
    vi.spyOn(emitter, "registerStep").mockImplementationOnce(() => {
      throw new Error("registry full");
    });
    expect.soft((await new JobRunner(testMachine("m-origin-register"), [], null, emitter).run(job("job-origin-register", 70, 0))).failure).toEqual({ origin: "evidence" });
  });

  it("an adapter whose id cannot be read, and that has no hook: the run fails with origin configuration and no id, never a rejection", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("m-origin-no-id");
    delete (machine as unknown as Record<string, unknown>).quiesceEvidence;
    Object.defineProperty(machine, "id", {
      get: () => {
        throw Object.create(null);
      },
    });
    const result = await new JobRunner(machine, [], null, emitter).run(job("job-origin-no-id", 74, 0)).then((r) => r, () => null);
    expect.soft(result, "run() rejected").not.toBeNull();
    expect.soft(result?.error, "why").toBe("the run's adapters could not be checked: a reason with no text form");
    expect.soft(result?.failure, "where").toEqual({ origin: "configuration" });
  });

  it("a successful run, and a busy refusal, name no failure", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const ok = await new JobRunner(testMachine("m-origin-ok"), [], null, emitter).run(job("job-origin-ok", 71, 0));
    expect.soft(ok.success).toBe(true);
    expect.soft(ok.failure).toBeUndefined();
    const hold = deferred();
    const busyMachine = testMachine("m-origin-busy", { holdStart: new Map([[1, hold.promise]]) });
    const runA = new JobRunner(busyMachine, [], null, emitter).run(job("job-origin-busy-A", 72, 0));
    await busyMachine.started(1);
    const b = await new JobRunner(busyMachine, [], null, emitter).run(job("job-origin-busy-B", 73, 0));
    hold.resolve();
    await runA;
    expect.soft(b.busy?.reason).toBe("adapter");
    expect.soft(b.failure).toBeUndefined();
  });
});
