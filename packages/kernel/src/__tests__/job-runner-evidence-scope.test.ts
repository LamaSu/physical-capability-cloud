/**
 * JobRunner evidence is job-scoped, closed and bounded (#502 round 2, astra pack 168).
 *
 * Round 1 recorded every event on one chain and drained it before the tier check and
 * the bundle. astra found the listeners behind that chain were bound to their run for
 * good, and the drain had no bound (DO-NOT-SHIP):
 *   - HIGH: a finished or overlapping run kept recording other jobs' events into its own
 *     step, so a Tier 2 run could pass on another job's camera event;
 *   - MEDIUM: an addEvent that never settles, or a device that emits as fast as events
 *     are hashed, kept run() waiting forever.
 * R1 to R6 reproduce those findings through the public JobRunner API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256, Signature } from "@pcc/spec";
import { verifyBundleHash } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { setEvidenceClock } from "../evidence-session.js";
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
/** A quiet period short enough to wait out in real time (the default is 1 s). */
const QUIET_MS = 20;
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
    async dispose() {},
  };
  return machine;
}

interface TestCamera extends CameraAdapter {
  emit(event: Emitted): void;
  /** Inspections that emit a cv_inspection_result; later ones emit nothing. */
  inspectionsThatEmit: number;
  inspectionsEmitted: number;
  /** Called after an inspection has emitted. */
  afterInspection: (() => void) | null;
}

function testCamera(id: string, inspectionsThatEmit = Number.POSITIVE_INFINITY): TestCamera {
  const listeners: Array<(event: Emitted) => void> = [];
  const camera: TestCamera = {
    id,
    source: { deviceId: id, deviceType: "camera", kernelId: KERNEL_ID },
    inspectionsThatEmit,
    inspectionsEmitted: 0,
    afterInspection: null,
    async captureSnapshot() {
      return { imageHash: "sha256:none", storageRef: "none" };
    },
    async runInspection() {
      if (camera.inspectionsEmitted < camera.inspectionsThatEmit) {
        camera.inspectionsEmitted += 1;
        camera.emit(evidence("cv_inspection_result", id, "camera", { passed: true, inspection: camera.inspectionsEmitted }));
      }
      camera.afterInspection?.();
      return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    async dispose() {},
  };
  return camera;
}

interface TestSensor extends SensorAdapter {
  emit(event: Emitted): void;
}

/** A power monitor that emits its summary when recording stops, as mock-power-monitor does. */
function testSensor(id: string): TestSensor {
  const listeners: Array<(event: Emitted) => void> = [];
  let recordingFor = "";
  const sensor: TestSensor = {
    id,
    type: "power_monitor",
    source: { deviceId: id, deviceType: "power_monitor", kernelId: KERNEL_ID },
    async startRecording(jobId) {
      recordingFor = jobId;
    },
    async stopRecording() {
      const summary = evidence("power_profile_summary", id, "power_monitor", { recordedFor: recordingFor });
      sensor.emit(summary);
      return summary;
    },
    async getCurrentReading() {
      return { watts: 90 };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    async dispose() {},
  };
  return sensor;
}

/** Poll until the condition holds (or give up after about a second, failing). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}

/** run() itself, or STILL_PENDING when it has not resolved within GUARD_MS. */
async function withinGuard<T>(run: Promise<T>): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(STILL_PENDING), GUARD_MS);
  });
  try {
    return await Promise.race([run, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait until every addEvent call made so far has settled and no new call has started. */
async function addEventsSettled(spy: { mock: { results: Array<{ value: unknown }> } }): Promise<void> {
  let seen = -1;
  while (seen !== spy.mock.results.length) {
    seen = spy.mock.results.length;
    await Promise.allSettled(spy.mock.results.map((r) => r.value));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const payloadsOf = (emitter: EvidenceEmitter, jobId: string) =>
  emitter.getEvents(jobId, STEP).map((e) => e.payload as Record<string, unknown>);

beforeEach(() => {
  // The test signer, the tier warning and dropped events all warn; keep the output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R1: a finished job records nothing from later jobs on the same adapters", () => {
  it.each([
    ["a new JobRunner per job, as server.ts makes one per /execute", false],
    ["one JobRunner for every job, as the gateway's KernelService keeps one per machine", true],
  ])("%s", async (_how, sameRunner) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const addEvent = vi.spyOn(emitter, "addEvent");
    // A device per case, and a short quiet period: since #502 round 3 a device stays
    // unavailable to the next job until it has been quiet that long.
    const machine = testMachine(`machine-r1-${sameRunner ? "one-runner" : "runner-per-job"}`);
    const options = { evidenceQuietMs: QUIET_MS };
    const runnerA = new JobRunner(machine, [], null, emitter, options);
    const a = await runnerA.run({ jobId: "job-r1-A", stepId: STEP, gcodeHash: gcode(1), assuranceTier: 1 });
    expect(a.success).toBe(true);
    await addEventsSettled(addEvent);
    const namingA = () => addEvent.mock.calls.filter(([jobId]) => jobId === "job-r1-A").length;
    const callsForA = namingA();
    const eventsOfA = emitter.getEvents("job-r1-A", STEP).length;

    // An event between the two jobs, then job B on the same machine. B is refused until the
    // machine has been quiet again: that event could still be job A's.
    machine.emit(evidence("execution_progress", machine.id, "controller", { between: "A and B" }));
    const runnerB = sameRunner ? runnerA : new JobRunner(machine, [], null, emitter, options);
    const tooSoon = await runnerB.run({ jobId: "job-r1-B", stepId: STEP, gcodeHash: gcode(2), assuranceTier: 1 });
    expect(tooSoon.busy).toEqual({ reason: "quiescing", adapterId: machine.id, jobId: "job-r1-A" });
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS + 5));
    const b = await runnerB.run({ jobId: "job-r1-B", stepId: STEP, gcodeHash: gcode(2), assuranceTier: 1 });
    expect(b.success).toBe(true);
    await addEventsSettled(addEvent);

    expect.soft(namingA(), "addEvent calls naming job A, after A returned").toBe(callsForA);
    expect.soft(emitter.getEvents("job-r1-A", STEP).length, "events recorded under job A, after job B ran").toBe(eventsOfA);
    expect.soft(payloadsOf(emitter, "job-r1-B"), "job B records its own events only").toEqual([
      { gcodeHash: gcode(2) },
      { gcodeHash: gcode(2) },
      { gcodeHash: gcode(2) },
    ]);
  });
});

describe("R2: overlapping Tier 2 jobs on one machine and one camera", () => {
  it("job B neither records job A's camera event nor passes its tier check with it", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const releaseA = deferred();
    const releaseB = deferred();
    const machine = testMachine("machine-r2", {
      holdStart: new Map([
        [1, releaseA.promise],
        [2, releaseB.promise],
      ]),
    });
    const camera = testCamera("camera-r2", 1); // only the first inspection, job A's, emits

    const runA = new JobRunner(machine, [], camera, emitter).run({ jobId: "job-r2-A", stepId: STEP, gcodeHash: gcode(1), assuranceTier: 2 });
    await machine.started(1); // job A is executing, its evidence window open
    const runB = new JobRunner(machine, [], camera, emitter).run({ jobId: "job-r2-B", stepId: STEP, gcodeHash: gcode(2), assuranceTier: 2 });
    releaseA.resolve();
    const a = await runA;
    releaseB.resolve();
    const b = await runB;

    expect(camera.inspectionsEmitted, "camera events emitted, all during job A's run").toBe(1);
    const typesOf = (jobId: string) => emitter.getEvents(jobId, STEP).map((e) => e.type);
    expect.soft(typesOf("job-r2-B"), "event types recorded under job B").not.toContain("cv_inspection_result");
    expect.soft(b, "job B's result").toMatchObject({ success: false });
    expect.soft(a, "job A's result").toMatchObject({ success: true });
    expect.soft(payloadsOf(emitter, "job-r2-A"), "payloads recorded under job A").not.toContainEqual({ gcodeHash: gcode(2) });
  });
});

/** An emitter whose addEvent never settles for one event type. */
class StuckEmitter extends EvidenceEmitter {
  /** How many calls are stuck. */
  stuckCalls = 0;

  constructor(private readonly stuckType: Emitted["type"]) {
    super(KERNEL_ID);
  }

  override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
    if (rawEvent.type !== this.stuckType) return super.addEvent(jobId, stepId, rawEvent);
    this.stuckCalls += 1;
    return new Promise<EvidenceEvent>(() => {});
  }
}

describe("R3: an addEvent that never settles", () => {
  it("run() still resolves, as a failure, and finalizes nothing", async () => {
    // The stuck event is the last one and not a required one, so if the timeout
    // were treated as success the run would pass its tier check and finalize.
    const emitter = new StuckEmitter("camera_snapshot");
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const machine = testMachine("machine-r3");
    const camera = testCamera("camera-r3");
    camera.afterInspection = () => camera.emit(evidence("camera_snapshot", "camera-r3", "camera", { after: "inspection" }));

    const runner = new JobRunner(machine, [], camera, emitter, { evidenceSettleTimeoutMs: 200 });
    const outcome = await withinGuard(runner.run({ jobId: "job-r3", stepId: STEP, gcodeHash: gcode(3), assuranceTier: 2 }));

    expect(outcome).toEqual({ success: false, error: "evidence recording did not settle within 200 ms", durationMs: expect.any(Number) });
    expect(emitter.stuckCalls, "addEvent calls still stuck when the run returned").toBe(1);
    expect(bundles).toEqual([]);
  });
});

/** An emitter that makes the device emit another progress event whenever it is given one. */
class EchoEmitter extends EvidenceEmitter {
  echo: ((n: number) => void) | null = null;
  echoes = 0;
  readonly calls: Array<Promise<unknown>> = [];

  override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
    const added = super.addEvent(jobId, stepId, rawEvent);
    this.calls.push(added.catch(() => undefined));
    if (rawEvent.type === "execution_progress" && this.echo) {
      this.echoes += 1;
      this.echo(this.echoes);
    }
    return added;
  }
}

describe("R4: a device that emits again whenever an event is recorded", () => {
  // Since #502 round 3 a job's window stays open until its devices are quiet, and this
  // device never is: the run fails at the quiesce bound, at every tier, and finalizes
  // nothing. (In round 2 the window closed after step 7 and the run passed on its events.)
  it.each([
    ["the run ends as soon as the flood starts", false],
    ["the flood runs for the whole of a 500 ms execution", true],
  ])("run() resolves, as a failure, and nothing is recorded after it returns (%s)", async (_when, longRun) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setEvidenceClock(() => Date.now());
    // setImmediate is real: the flood runs as fast as real hashing, between clock steps.
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const emitter = new EchoEmitter(KERNEL_ID);
    let bundle: EvidenceBundle | undefined;
    emitter.onBundle((b) => {
      bundle = b;
    });
    const machine = testMachine(`machine-r4-${longRun ? "long" : "short"}`, {
      onLoad: (id, hash) => [...tier1(id, hash), evidence("execution_progress", id, "controller", { n: 0 })],
    });
    if (longRun) {
      // waitForCompletion polls every 500 ms; the first poll sees 50%, the second 100%.
      let polls = 0;
      machine.progress = () => (++polls >= 2 ? 100 : 50);
    }
    let emitted = 0;
    emitter.echo = (n) => {
      emitted += 1;
      machine.emit(evidence("execution_progress", machine.id, "controller", { n }));
    };
    try {
      let outcome: JobResult | undefined;
      const options = { evidenceSettleTimeoutMs: 1_000, evidenceQuiesceTimeoutMs: 2_000 };
      void new JobRunner(machine, [], null, emitter, options)
        .run({ jobId: "job-r4", stepId: STEP, gcodeHash: gcode(4), assuranceTier: 1 })
        .then((result) => {
          outcome = result;
        });
      // The fake clock moves 10 ms per event the device emits, so on that clock it is
      // never quiet for 1 s, however fast the real hashing that drives it runs.
      for (let turns = 0; outcome === undefined && turns < 100_000; turns++) {
        const before = emitted;
        await turn();
        if (emitted > before) await vi.advanceTimersByTimeAsync(10);
      }
      expect(outcome, "run()'s result").toEqual({ success: false, error: "evidence did not quiesce within 2000 ms", durationMs: expect.any(Number) });

      const callsAtReturn = emitter.calls.length;
      await Promise.allSettled(emitter.calls);
      for (let i = 0; i < 5; i++) await turn();
      expect(emitter.calls.length, "addEvent calls started after run() returned").toBe(callsAtReturn);
      expect(bundle).toBeUndefined();
      expect(emitter.getEvents("job-r4", STEP), "events recorded under the job, after it returned").toEqual([]);
    } finally {
      // Stop the device: at 5a3386b5 run() never returns while it emits.
      emitter.echo = null;
      setEvidenceClock();
      vi.useRealTimers();
    }
  });
});

describe("R5: a run that fails early records nothing after it returns", () => {
  it.each(["load_gcode", "start"] as const)("an event emitted after a failed %s is not recorded", async (failing) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const addEvent = vi.spyOn(emitter, "addEvent");
    // A device per case: a refusal while the last case's device is quiescing would pass vacuously.
    const machine = testMachine(`machine-r5a-${failing}`, { onLoad: () => [] });
    machine.failing = failing;
    const result = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-r5a", stepId: STEP, gcodeHash: gcode(5), assuranceTier: 0 });
    expect(result.success).toBe(false);

    machine.emit(evidence("execution_completed", machine.id, "controller", { after: "return" }));
    await addEventsSettled(addEvent);

    expect.soft(addEvent.mock.calls.length, "addEvent calls after the failed run").toBe(0);
    expect.soft(emitter.getEvents("job-r5a", STEP).length, "events recorded under the failed job").toBe(0);
  });

  it.each(["load_gcode", "start"] as const)("events emitted during a failed %s are written before run() returns, or never", async (failing) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const original = emitter.addEvent.bind(emitter);
    let returned = false;
    const writtenAfterReturn: string[] = [];
    const addEvent = vi.spyOn(emitter, "addEvent").mockImplementation(async (jobId, stepId, rawEvent) => {
      const added = await original(jobId, stepId, rawEvent);
      if (returned) writtenAfterReturn.push(rawEvent.type);
      return added;
    });
    const machine = testMachine(`machine-r5b-${failing}`);
    machine.failing = failing;
    const result = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-r5b", stepId: STEP, gcodeHash: gcode(5), assuranceTier: 0 });
    returned = true;
    expect(result.success).toBe(false);
    await addEventsSettled(addEvent);

    expect(writtenAfterReturn, "events written into the failed job's step after run() returned").toEqual([]);
  });
});

/** An emitter that makes the device emit one more event when finalizeBundle starts. */
class LateEmitter extends EvidenceEmitter {
  late: (() => void) | null = null;
  readonly calls: Array<Promise<unknown>> = [];

  override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
    const added = super.addEvent(jobId, stepId, rawEvent);
    this.calls.push(added.catch(() => undefined));
    return added;
  }

  override async finalizeBundle(jobId: string, stepId: string): Promise<EvidenceBundle> {
    this.late?.();
    // Let a delivered event start recording, then finish, so it would be in the bundle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled(this.calls);
    return super.finalizeBundle(jobId, stepId);
  }
}

describe("R6: an event emitted while the bundle is finalized", () => {
  it("as finalizeBundle starts: it is neither in the bundle nor added to the step", async () => {
    const emitter = new LateEmitter(KERNEL_ID);
    let bundle: EvidenceBundle | undefined;
    emitter.onBundle((b) => {
      bundle = b;
    });
    const machine = testMachine("machine-r6a");
    emitter.late = () => machine.emit(evidence("execution_progress", "machine-r6a", "controller", { late: "finalize" }));

    const result = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-r6a", stepId: STEP, gcodeHash: gcode(6), assuranceTier: 1 });
    expect(result.success).toBe(true);
    await Promise.allSettled(emitter.calls);

    expect.soft(bundle!.events.map((e) => e.payload), "bundled payloads").not.toContainEqual({ late: "finalize" });
    expect.soft(payloadsOf(emitter, "job-r6a"), "payloads recorded under the job").not.toContainEqual({ late: "finalize" });
  });

  it("while the bundle is signed: the bundle still matches its hash, and the step its bundle", async () => {
    let machine!: TestMachine;
    const calls: Array<Promise<unknown>> = [];
    const emitter = new EvidenceEmitter(KERNEL_ID, async (digest) => {
      machine.emit(evidence("execution_progress", "machine-r6b", "controller", { late: "signing" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled(calls);
      const signature: Signature = { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: `sig_${digest.slice(0, 16)}` };
      return signature;
    });
    const original = emitter.addEvent.bind(emitter);
    vi.spyOn(emitter, "addEvent").mockImplementation((jobId, stepId, rawEvent) => {
      const added = original(jobId, stepId, rawEvent);
      calls.push(added.catch(() => undefined));
      return added;
    });
    let bundle: EvidenceBundle | undefined;
    emitter.onBundle((b) => {
      bundle = b;
    });
    machine = testMachine("machine-r6b");

    const result = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-r6b", stepId: STEP, gcodeHash: gcode(6), assuranceTier: 1 });
    expect(result.success).toBe(true);
    await Promise.allSettled(calls);

    expect.soft(await verifyBundleHash(bundle!), "the bundle's events match its bundleHash").toBe(true);
    expect.soft(bundle!.events.map((e) => e.payload), "bundled payloads").not.toContainEqual({ late: "signing" });
    expect.soft(payloadsOf(emitter, "job-r6b"), "payloads recorded under the job").not.toContainEqual({ late: "signing" });
  });
});

describe("Busy: an adapter serves one job at a time", () => {
  it("a second run on a held machine is refused before any command; the first run is unaffected; the next run succeeds", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const registerStep = vi.spyOn(emitter, "registerStep");
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const release = deferred();
    const machine = testMachine("machine-busy", { holdStart: new Map([[1, release.promise]]) });
    const camera = testCamera("camera-busy");

    const runA = new JobRunner(machine, [], camera, emitter).run({ jobId: "job-busy-A", stepId: STEP, gcodeHash: gcode(7), assuranceTier: 2 });
    await machine.started(1);
    const commandsBeforeB = [...machine.commands];
    const b = await new JobRunner(machine, [], camera, emitter).run({ jobId: "job-busy-B", stepId: STEP, gcodeHash: gcode(8), assuranceTier: 2 });

    expect(b).toEqual({ success: false, error: "adapter machine-busy is in use by job job-busy-A", busy: { reason: "adapter", adapterId: "machine-busy", jobId: "job-busy-A" }, durationMs: expect.any(Number) });
    expect(machine.commands, "commands sent once job B was refused").toEqual(commandsBeforeB);
    expect(registerStep.mock.calls.map(([jobId]) => jobId), "steps registered").toEqual(["job-busy-A"]);

    release.resolve();
    expect(await runA).toMatchObject({ success: true });
    expect(bundles.map((bundle) => bundle.events.map((e) => e.type))).toEqual([
      ["gcode_hash_verified", "execution_completed", "power_profile_summary", "cv_inspection_result"],
    ]);

    const c = await new JobRunner(machine, [], camera, emitter).run({ jobId: "job-busy-C", stepId: STEP, gcodeHash: gcode(9), assuranceTier: 2 });
    expect(c).toMatchObject({ success: true });
  });

  it.each(["camera", "sensor"] as const)("a run on another machine that shares only the %s with a running job is refused, naming it", async (shared) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const release = deferred();
    const machineA = testMachine(`machine-share-A-${shared}`, {
      onLoad: (id, hash) => tier1(id, hash).filter((e) => e.type !== "power_profile_summary"),
      holdStart: new Map([[1, release.promise]]),
    });
    const machineB = testMachine(`machine-share-B-${shared}`);
    const sensor = testSensor(`power-shared-${shared}`);
    const camera = testCamera(`camera-shared-${shared}`);
    const sensorsOf = (own: boolean) => (shared === "sensor" || own ? [sensor] : [testSensor(`power-B-${shared}`)]);
    const cameraOf = (own: boolean) => (shared === "camera" || own ? camera : testCamera(`camera-B-${shared}`));

    const runA = new JobRunner(machineA, sensorsOf(true), cameraOf(true), emitter).run({ jobId: "job-share-A", stepId: STEP, gcodeHash: gcode(11), assuranceTier: 2 });
    await machineA.started(1);
    const b = await new JobRunner(machineB, sensorsOf(false), cameraOf(false), emitter).run({ jobId: "job-share-B", stepId: STEP, gcodeHash: gcode(12), assuranceTier: 2 });

    const sharedId = shared === "camera" ? camera.id : sensor.id;
    expect(b).toEqual({ success: false, error: `adapter ${sharedId} is in use by job job-share-A`, busy: { reason: "adapter", adapterId: sharedId, jobId: "job-share-A" }, durationMs: expect.any(Number) });
    expect(machineB.commands, "commands sent to job B's own machine").toEqual([]);

    release.resolve();
    expect(await runA).toMatchObject({ success: true });
    // The sensor's summary, emitted at step 6, is job A's own.
    expect(bundles[0]!.events.map((e) => e.payload)).toContainEqual({ recordedFor: "job-share-A" });
  });

  it("a duplicate of a running job, under the same ids, is refused before it can wipe that job's evidence", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const release = deferred();
    const machine = testMachine("machine-dup", { holdStart: new Map([[1, release.promise]]) });
    const camera = testCamera("camera-dup");
    const job = { jobId: "job-dup", stepId: STEP, gcodeHash: gcode(13), assuranceTier: 2 as const };

    const runA = new JobRunner(machine, [], camera, emitter).run(job);
    await machine.started(1);
    await until(() => emitter.getEvents("job-dup", STEP).length === 3); // job A's load events are recorded
    const b = await new JobRunner(machine, [], camera, emitter).run(job);
    // Its (jobId, stepId) is checked first: the duplicate is refused as a running step (#502 round 3).
    expect(b).toEqual({ success: false, error: "step step-1 of job job-dup is already running", busy: { reason: "step", jobId: "job-dup", stepId: STEP }, durationMs: expect.any(Number) });

    release.resolve();
    expect(await runA).toMatchObject({ success: true });
    expect(bundles.map((bundle) => bundle.events.map((e) => e.type))).toEqual([
      ["gcode_hash_verified", "execution_completed", "power_profile_summary", "cv_inspection_result"],
    ]);
  });

  type BreakIt = (machine: TestMachine, camera: TestCamera, emitter: EvidenceEmitter) => void;
  it.each<[string, BreakIt]>([
    ["load_gcode fails", (m) => void (m.failing = "load_gcode")],
    ["start fails", (m) => void (m.failing = "start")],
    ["the machine reports an error", (m) => void ((m.progress = () => 50), (m.status = "error"))],
    ["the Tier 2 check fails", (_m, c) => void (c.inspectionsThatEmit = 0)],
    ["evidence recording does not settle", (_m, c) => void (c.afterInspection = () => c.emit(evidence("camera_snapshot", c.id, "camera")))],
    ["finalizeBundle throws", (_m, _c, e) => void vi.spyOn(e, "finalizeBundle").mockRejectedValueOnce(new Error("signer offline"))],
  ])("after a run that ends because %s, the adapters are free for the next job once they have been quiet", async (why, breakIt) => {
    const emitter = new StuckEmitter("camera_snapshot");
    // Devices per case, and a short quiet period: since #502 round 3 a device stays
    // unavailable to the next job until it has been quiet that long.
    const slug = why.replace(/\W+/g, "-");
    const machine = testMachine(`machine-free-${slug}`);
    const camera = testCamera(`camera-free-${slug}`);
    breakIt(machine, camera, emitter);
    const options = { evidenceSettleTimeoutMs: 100, evidenceQuietMs: QUIET_MS };

    const first = await new JobRunner(machine, [], camera, emitter, options).run({ jobId: "job-free-1", stepId: STEP, gcodeHash: gcode(14), assuranceTier: 2 });
    expect(first.success).toBe(false);

    Object.assign(machine, { failing: null, progress: () => 100, status: "busy" });
    Object.assign(camera, { inspectionsThatEmit: Number.POSITIVE_INFINITY, afterInspection: null });
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS + 5));
    const second = await new JobRunner(machine, [], camera, emitter, options).run({ jobId: "job-free-2", stepId: STEP, gcodeHash: gcode(15), assuranceTier: 2 });
    expect(second).toMatchObject({ success: true });
  });
});

/** An emitter whose first gcode_received takes 300 ms to record. */
class SlowEmitter extends EvidenceEmitter {
  readonly asked: string[] = [];
  slow: Promise<unknown> = Promise.resolve();

  override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
    this.asked.push(rawEvent.type);
    if (rawEvent.type !== "gcode_received") return super.addEvent(jobId, stepId, rawEvent);
    const added = new Promise((resolve) => setTimeout(resolve, 300)).then(() => super.addEvent(jobId, stepId, rawEvent));
    this.slow = added.catch(() => undefined);
    return added;
  }
}

describe("Sealed: a failed run never writes an event still queued", () => {
  it("an event queued behind a slow addEvent is not written after the run failed and returned (and R10: nothing lands in its step)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // setImmediate is real: hashing finishes, and every microtask runs, between checks.
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    try {
      const emitter = new SlowEmitter(KERNEL_ID);
      const bundles: EvidenceBundle[] = [];
      emitter.onBundle((bundle) => bundles.push(bundle));
      const machine = testMachine("machine-sealed", {
        onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)],
      });
      machine.failing = "start";

      // The bounded wait (100 ms) ends before the slow addEvent (300 ms) does.
      const run = new JobRunner(machine, [], null, emitter, { evidenceSettleTimeoutMs: 100 }).run({
        jobId: "job-sealed",
        stepId: STEP,
        gcodeHash: gcode(16),
        assuranceTier: 1,
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await run;
      expect(result.success).toBe(false);
      // R10 (astra pack 172): the slow addEvent is still running when run() returns...
      expect.soft(emitter.getEvents("job-sealed", STEP), "events recorded under the failed job when run() returned").toEqual([]);

      await vi.advanceTimersByTimeAsync(200);
      await emitter.slow;
      await turn();

      // The slow one was already running and cannot be recalled; the queued ones never start.
      expect(emitter.asked).toEqual(["gcode_received"]);
      // ...and once it completes, the failed job's step still records nothing.
      expect.soft(emitter.getEvents("job-sealed", STEP), "events recorded under the failed job once the slow addEvent completed").toEqual([]);
      expect(bundles).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the settle timer", () => {
  // Since #502 round 3 a run first quiesces, on the evidence clock: these tests put that
  // clock on the fake one (Date), and move it on.
  it.each([
    ["a run that succeeds", null],
    ["a run whose load fails", "load_gcode"],
  ] as const)("is cleared, with the quiescence timers, when %s returns", async (_how, failing) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setEvidenceClock(() => Date.now());
    // setImmediate is real: hashing finishes, and every microtask runs, between clock steps.
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    try {
      const machine = testMachine(`machine-timer-${failing ?? "ok"}`);
      machine.failing = failing;
      let outcome: JobResult | undefined;
      void new JobRunner(machine, [], null, new EvidenceEmitter(KERNEL_ID))
        .run({ jobId: "job-timer", stepId: STEP, gcodeHash: gcode(17), assuranceTier: 1 })
        .then((result) => {
          outcome = result;
        });
      for (let steps = 0; outcome === undefined && steps < 100; steps++) {
        await turn();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(outcome?.success).toBe(failing === null);
      expect(vi.getTimerCount(), "timers left pending").toBe(0);
    } finally {
      setEvidenceClock();
      vi.useRealTimers();
    }
  });

  it("defaults to 30 s, and a run that times out waits for it once, not twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setEvidenceClock(() => Date.now());
    // setImmediate is real: hashing finishes, and every microtask runs, between checks.
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    try {
      const camera = testCamera("camera-default");
      camera.afterInspection = () => camera.emit(evidence("camera_snapshot", camera.id, "camera"));
      const emitter = new StuckEmitter("camera_snapshot");
      let outcome: JobResult | undefined;
      void new JobRunner(testMachine("machine-default"), [], camera, emitter)
        .run({ jobId: "job-default", stepId: STEP, gcodeHash: gcode(18), assuranceTier: 2 })
        .then((result) => {
          outcome = result;
        });
      // Advance only once the stuck addEvent is in flight; earlier, the queued events
      // would just be sealed.
      while (emitter.stuckCalls === 0) await turn();
      // The snapshot was the last event: one default quiet period (1 s) later the run
      // closes its window and sets the settle's timer, by then its only timer.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount(), "timers pending once the run has quiesced").toBe(1);

      await vi.advanceTimersByTimeAsync(29_999);
      await turn();
      expect(outcome, "resolved before 30 s").toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await turn();
      expect(outcome).toEqual({ success: false, error: "evidence recording did not settle within 30000 ms", durationMs: expect.any(Number) });
    } finally {
      setEvidenceClock();
      vi.useRealTimers();
    }
  });
});

describe("an addEvent that fails", () => {
  it.each(["rejects", "throws"] as const)("is logged and skipped when it %s, and the events after it are still recorded", async (how) => {
    class FailingEmitter extends EvidenceEmitter {
      override addEvent(jobId: string, stepId: string, rawEvent: Emitted): Promise<EvidenceEvent> {
        if (rawEvent.type === "gcode_received") {
          if (how === "throws") throw new Error("storage full");
          return Promise.reject(new Error("storage full"));
        }
        return super.addEvent(jobId, stepId, rawEvent);
      }
    }
    const emitter = new FailingEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const machine = testMachine("machine-failing-add", {
      onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)],
    });

    const result = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-failing-add", stepId: STEP, gcodeHash: gcode(19), assuranceTier: 1 });

    expect(result).toMatchObject({ success: true });
    expect(bundles.map((bundle) => bundle.events.map((e) => e.type))).toEqual([["gcode_hash_verified", "execution_completed", "power_profile_summary"]]);
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: "storage full" }));
  });
});
