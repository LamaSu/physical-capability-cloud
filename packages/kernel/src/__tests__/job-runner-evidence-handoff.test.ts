/**
 * JobRunner evidence stays with its job across a session handoff, a step key and a
 * physical device (#502 round 3, astra pack 172).
 *
 * Round 2 gave every adapter one permanent tap and every job one session (pack 168).
 * astra found evidence still crosses jobs (DO-NOT-SHIP):
 *   - HIGH: the tap gives an event to whichever session is open when the event ARRIVES,
 *     so a late event of job A (OctoPrint's polled completion) is recorded under job B;
 *   - HIGH: registerStep overwrites an active (jobId, stepId), so two runs of one step on
 *     disjoint adapters read and finalize each other's events;
 *   - HIGH: the busy lock is keyed by the adapter OBJECT, so two wrappers of one physical
 *     device both run, and both record the device's events.
 * R7 to R9 reproduce those findings through the public JobRunner API.
 *
 * Every test here runs on the fake clock. Hashing is moved onto microtasks (the mock
 * below), so the clock alone decides when a run moves on: nothing waits on real I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter, MachineCommand, MachineCommandResult } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import type { JobResult } from "../job-runner.js";
import { lose1Capture } from "./lose1-capture-fixture.js";

// Plain functions, not vi.fn(), so vi.restoreAllMocks() cannot strip them.
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

/** A test can hold an event's hashing, as a slow hash would, by returning a promise here. */
const hashing = vi.hoisted(() => ({ gate: null as ((event: unknown) => Promise<void> | undefined) | null }));

// The real hashes run on crypto.subtle, whose callbacks come from real I/O. Hash on a
// microtask instead (still SHA-256 of the canonical form), so a fake-clock test never
// races real time.
vi.mock("@pcc/spec", async (importOriginal) => {
  const spec = await importOriginal<typeof import("@pcc/spec")>();
  const { createHash } = await import("node:crypto");
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(spec.canonicalize(value)).digest("hex")}`;
  return {
    ...spec,
    hashEvent: async (event: unknown) => {
      await hashing.gate?.(event);
      return digest(event);
    },
    hashBundle: async (events: unknown) => digest(events),
  };
});

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
type DeviceType = EvidenceSource["deviceType"];

const KERNEL_ID = "kernel-handoff-test";
const STEP = "step-1";

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

/** One physical device's event stream: every adapter object that wraps it hears every event. */
interface DeviceStream {
  readonly listeners: Array<(event: Emitted) => void>;
  emit(event: Emitted): void;
}

function deviceStream(): DeviceStream {
  const listeners: Array<(event: Emitted) => void> = [];
  return {
    listeners,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

interface TestMachine extends MachineAdapter {
  /** Deliver an event to every listener on the device's stream, as the device would. */
  emit(event: Emitted): void;
  /** Every command type sent through this adapter object, in order. */
  readonly commands: string[];
  /** The command that fails, if any. */
  failing: "load_gcode" | "start" | null;
  /** Resolves once start has been called n times on this adapter object. */
  started(n: number): Promise<void>;
  /** How many times a run asked this adapter to quiesce. */
  quiesceCalls: number;
}

function testMachine(
  id: string,
  options: {
    /** The device the adapter claims. Default: its own, `id`. */
    source?: EvidenceSource;
    /** The device's event stream. Default: its own. */
    stream?: DeviceStream;
    /** Events emitted during load_gcode. Default: the Tier 1 set for the job's G-code. */
    onLoad?: (machineId: string, gcodeHash: string) => Emitted[];
    /** Hold the nth start (1-based) until its promise resolves. */
    holdStart?: Map<number, Promise<void>>;
    /** Called as the nth start is accepted. */
    onStart?: (machine: TestMachine, n: number) => void;
    /** Its quiesceEvidence() does this. Default: resolve at once (it emits inside its commands). */
    quiesceEvidence?: (machine: TestMachine) => Promise<void>;
  } = {},
): TestMachine {
  const stream = options.stream ?? deviceStream();
  const commands: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let starts = 0;
  const machine: TestMachine = {
    id,
    type: "fdm",
    source: options.source ?? { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands,
    failing: null,
    async getStatus() {
      return "busy";
    },
    async getProgress() {
      return 100;
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      commands.push(command.type);
      if (command.type === "load_gcode") {
        for (const e of (options.onLoad ?? tier1)(id, String(command.payload?.gcodeHash))) machine.emit(e);
      }
      if (command.type === "start") {
        starts += 1;
        options.onStart?.(machine, starts);
        for (const w of waiters) if (w.n <= starts) w.resolve();
        await options.holdStart?.get(starts);
      }
      if (machine.failing === command.type) return { success: false, message: `${command.type} refused` };
      return { success: true, message: "ok" };
    },
    onEvidence(callback) {
      stream.listeners.push(callback);
    },
    emit(event) {
      stream.emit(event);
    },
    started(n) {
      return new Promise((resolve) => {
        if (starts >= n) resolve();
        else waiters.push({ n, resolve });
      });
    },
    quiesceCalls: 0,
    quiesceEvidence() {
      machine.quiesceCalls += 1;
      return options.quiesceEvidence ? options.quiesceEvidence(machine) : Promise.resolve();
    },
    async dispose() {},
  };
  return machine;
}

/** A camera whose inspections emit a cv_inspection_result while `emits` is true. */
function testCamera(id: string, emits = true): CameraAdapter {
  const listeners: Array<(event: Emitted) => void> = [];
  return {
    id,
    source: { deviceId: id, deviceType: "camera", kernelId: KERNEL_ID },
    async captureSnapshot() {
      return { imageHash: "sha256:none", storageRef: "none" };
    },
    async runInspection(_referenceHash?: string, context?: { jobId?: string }) {
      // A complete LO-SE-1 capture for the job it was asked for: since #489 only one counts.
      if (emits) for (const listener of [...listeners]) listener(lose1Capture("cv_inspection_result", id, KERNEL_ID, String(context?.jobId)));
      return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    // It emits inside runInspection; nothing is left once that returns.
    async quiesceEvidence() {},
    async dispose() {},
  };
}

/**
 * Settle `promise` on the fake clock: drain the microtasks, then fire the timers one at a
 * time, in order, until it settles. Throws if it is still pending with no timer left to
 * fire (it waits on something the test has not released), or after 1,000 timers.
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  for (let fired = 0; !settled; fired++) {
    if (vi.getTimerCount() === 0) throw new Error("still pending, and no timer is left to fire");
    if (fired >= 1_000) throw new Error("still pending after 1,000 timers");
    await vi.advanceTimersToNextTimerAsync();
  }
  return promise;
}

const ZERO_SIGNER = "0x0000000000000000000000000000000000000000";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // The test signer, the tier warning and dropped events all warn; keep the output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  hashing.gate = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R7: an event that arrives late is recorded under its own job, never under the next", () => {
  // A's machine reports 100% before its own poll loop emits execution_completed, LATE_MS
  // later, after A's run has passed step 7, as OctoPrint's does (octoprint-adapter.ts:225-277).
  // Its quiesceEvidence() covers that completion, as OctoPrint's does since round 3b: it
  // resolves once the completion is emitted. Only A completes that way: B emits none.
  const LATE_MS = 300;

  it.each([
    ["job B starts as soon as job A returns", "returned"],
    ["job B starts while job A is still signing its bundle", "signing"],
  ] as const)("%s", async (_how, when) => {
    let runB: Promise<JobResult> | undefined;
    const startB = () => new JobRunner(machine, [], null, emitter).run({ jobId: "job-r7-B", stepId: STEP, gcodeHash: gcode(72), assuranceTier: 1 });
    const emitter = new EvidenceEmitter(KERNEL_ID, async (digest) => {
      if (when === "signing" && runB === undefined) runB = startB();
      return { signer: ZERO_SIGNER, algorithm: "secp256k1", value: `sig_${digest.slice(0, 16)}` };
    });
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const releaseB = deferred();
    let owed: Promise<void> = Promise.resolve();
    const machine = testMachine(`machine-r7-${when}`, {
      onLoad: (id, hash) => tier1(id, hash).filter((e) => e.type !== "execution_completed"),
      holdStart: new Map([[2, releaseB.promise]]),
      onStart: (m, n) => {
        if (n === 1) {
          owed = new Promise<void>((resolve) =>
            setTimeout(() => {
              m.emit(evidence("execution_completed", m.id, "controller", { gcodeHash: gcode(71), late: true }));
              resolve();
            }, LATE_MS),
          );
        }
      },
      quiesceEvidence: () => owed,
    });

    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-r7-A", stepId: STEP, gcodeHash: gcode(71), assuranceTier: 1 }));
    if (when === "returned") runB = startB();
    await drive(machine.started(2)); // job B is executing, its evidence window open
    await vi.advanceTimersByTimeAsync(LATE_MS); // A's late completion has fired by now, whichever run held the window
    releaseB.resolve();
    const b = await drive(runB!);

    const typesOf = (jobId: string) => emitter.getEvents(jobId, STEP).map((e) => e.type);
    const bundledTypesOf = (jobId: string) => bundles.filter((bundle) => bundle.jobId === jobId).flatMap((bundle) => bundle.events.map((e) => e.type));
    expect.soft(a, "job A's result").toMatchObject({ success: true });
    expect.soft(b, "job B's result").toMatchObject({ success: true });
    expect.soft(typesOf("job-r7-B"), "event types recorded under job B").not.toContain("execution_completed");
    expect.soft(bundledTypesOf("job-r7-B"), "event types in job B's bundle").not.toContain("execution_completed");
    expect.soft(typesOf("job-r7-A"), "event types recorded under job A").toContain("execution_completed");
    expect.soft(bundledTypesOf("job-r7-A"), "event types in job A's bundle").toContain("execution_completed");
  });
});

describe("R8: two runs of one (jobId, stepId) on disjoint adapters", () => {
  it("the second is refused, and the first neither observes nor finalizes the second's events", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const registerStep = vi.spyOn(emitter, "registerStep");
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const releaseA = deferred();
    const machineA = testMachine("machine-r8-A", { holdStart: new Map([[1, releaseA.promise]]) });
    const machineB = testMachine("machine-r8-B");
    // Only B's camera emits: B's run is the only one with the Tier 2 camera event.
    const cameraA = testCamera("camera-r8-A", false);
    const cameraB = testCamera("camera-r8-B");

    const runA = new JobRunner(machineA, [], cameraA, emitter).run({ jobId: "job-r8", stepId: STEP, gcodeHash: gcode(81), assuranceTier: 2 });
    await drive(machineA.started(1)); // job A is executing, its step registered
    const b = await drive(new JobRunner(machineB, [], cameraB, emitter).run({ jobId: "job-r8", stepId: STEP, gcodeHash: gcode(82), assuranceTier: 2 }));
    releaseA.resolve();
    const a = await drive(runA);

    expect.soft(b, "job B's result").toEqual({
      success: false,
      error: "step step-1 of job job-r8 is already running",
      busy: { reason: "step", jobId: "job-r8", stepId: STEP },
      durationMs: expect.any(Number),
    });
    expect.soft(machineB.commands, "commands sent to job B's machine").toEqual([]);
    expect.soft(registerStep, "steps registered").toHaveBeenCalledTimes(1);
    expect.soft(a, "job A's result: A's own camera recorded nothing").toMatchObject({ success: false });
    const bundleOfA = bundles.find((bundle) => bundle.id === a.bundleId);
    expect.soft(bundleOfA?.events.map((e) => e.source.deviceId) ?? [], "devices in job A's bundle").not.toContain("camera-r8-B");
  });
});

describe("R9: two adapter objects for one physical device", () => {
  it("the second run is refused while the first holds the device, and the device's completion is recorded once", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const stream = deviceStream();
    const device: EvidenceSource = { deviceId: "printer-r9", deviceType: "controller", kernelId: KERNEL_ID };
    const releaseA = deferred();
    const releaseB = deferred();
    // The device echoes the hash it loaded; both wrappers hear everything it says.
    const onLoad = (_id: string, hash: string) => [evidence("gcode_hash_verified", "printer-r9", "controller", { gcodeHash: hash })];
    const wrapper1 = testMachine("machine-r9-wrapper-1", { source: device, stream, onLoad, holdStart: new Map([[1, releaseA.promise]]) });
    const wrapper2 = testMachine("machine-r9-wrapper-2", { source: device, stream, onLoad, holdStart: new Map([[1, releaseB.promise]]) });

    const runA = new JobRunner(wrapper1, [], null, emitter).run({ jobId: "job-r9-A", stepId: STEP, gcodeHash: gcode(91), assuranceTier: 0 });
    await drive(wrapper1.started(1));
    const runB = new JobRunner(wrapper2, [], null, emitter).run({ jobId: "job-r9-B", stepId: STEP, gcodeHash: gcode(92), assuranceTier: 0 });
    await drive(Promise.race([wrapper2.started(1), runB])); // B is executing, or was refused
    stream.emit(evidence("execution_completed", "printer-r9", "controller", { print: "the device's only one" }));
    releaseA.resolve();
    releaseB.resolve();
    const a = await drive(runA);
    const b = await drive(runB);

    expect.soft(b, "job B's result").toEqual({
      success: false,
      error: "adapter machine-r9-wrapper-2 is in use by job job-r9-A",
      busy: { reason: "adapter", adapterId: "machine-r9-wrapper-2", jobId: "job-r9-A" },
      durationMs: expect.any(Number),
    });
    expect.soft(wrapper2.commands, "commands sent through the second wrapper").toEqual([]);
    const recordedCompletions = ["job-r9-A", "job-r9-B"].flatMap((jobId) =>
      emitter.getEvents(jobId, STEP).flatMap((e) => (e.type === "execution_completed" ? [jobId] : [])),
    );
    expect.soft(recordedCompletions, "jobs that recorded the device's one completion").toEqual(["job-r9-A"]);
    // Absences match by expect.objectContaining: the emitter commits the job's id into every
    // recorded payload (LO-EV-9, #341), so an exact object could never match one.
    expect.soft(emitter.getEvents("job-r9-A", STEP).map((e) => e.payload), "payloads recorded under job A").not.toContainEqual(expect.objectContaining({ gcodeHash: gcode(92) }));
    expect.soft(a, "job A's result").toMatchObject({ success: true });
  });
});

describe("R10: an addEvent still hashing when a failed run returns", () => {
  it("writes into a detached step: the failed job's events stay empty, before and after it completes", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const hashHeld = deferred();
    let held = 0;
    // addEvent looks its step up, then awaits the hash, then appends (evidence-emitter.ts:108-124).
    hashing.gate = (event) => {
      if ((event as Emitted).type !== "gcode_received") return undefined;
      held += 1;
      return hashHeld.promise;
    };
    const machine = testMachine("machine-r10", {
      onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)],
    });
    machine.failing = "start";

    const result = await drive(
      new JobRunner(machine, [], null, emitter, { evidenceSettleTimeoutMs: 100 }).run({ jobId: "job-r10", stepId: STEP, gcodeHash: gcode(101), assuranceTier: 1 }),
    );
    expect(result).toMatchObject({ success: false, error: "Failed to start: start refused" });
    expect(held, "addEvent calls still hashing when run() returned").toBe(1);
    expect.soft(emitter.getEvents("job-r10", STEP), "events recorded under the failed job when run() returned").toEqual([]);

    hashHeld.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(emitter.getEvents("job-r10", STEP), "events recorded under the failed job once that addEvent completed").toEqual([]);
  });
});

/** run() as a promise, plus its result once it has one: for tests that step the clock themselves. */
function track(run: Promise<JobResult>): { readonly outcome: JobResult | undefined } {
  const tracked: { outcome: JobResult | undefined } = { outcome: undefined };
  void run.then((result) => {
    tracked.outcome = result;
  });
  return tracked;
}

describe("Quiescence: a job's window stays open until its adapters are done", () => {
  it("waits for each adapter's quiesceEvidence (5 s here), records what it emits until then, and adds no wait after it", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    // The device reports its completion 5 s after it is asked to quiesce.
    const machine = testMachine("machine-hook", {
      onLoad: (id, hash) => tier1(id, hash).filter((e) => e.type !== "execution_completed"),
      quiesceEvidence: (m) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            m.emit(evidence("execution_completed", m.id, "controller", { via: "quiesceEvidence" }));
            resolve();
          }, 5_000);
        }),
    });
    const started = Date.now();

    const result = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-hook", stepId: STEP, gcodeHash: gcode(201), assuranceTier: 1 }));

    expect(result).toMatchObject({ success: true });
    expect(machine.quiesceCalls).toBe(1);
    expect(bundles.map((bundle) => bundle.events.map((e) => e.type))).toEqual([["gcode_hash_verified", "power_profile_summary", "execution_completed"]]);
    expect(Date.now() - started, "fake time the run took: the hook's, and nothing after it").toBe(5_000);
  });

  it.each([0, 1, 2] as const)("fails a Tier %s run, finalizing nothing, when quiesceEvidence never resolves: after evidenceQuiesceTimeoutMs, 15 s by default", async (tier) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const machine = testMachine(`machine-hook-stuck-${tier}`, { quiesceEvidence: () => new Promise<void>(() => {}) });
    const camera = testCamera(`camera-hook-stuck-${tier}`);

    const run = track(new JobRunner(machine, [], camera, emitter).run({ jobId: `job-hook-stuck-${tier}`, stepId: STEP, gcodeHash: gcode(202), assuranceTier: tier }));
    await vi.advanceTimersByTimeAsync(0);
    expect(machine.quiesceCalls, "the run is quiescing").toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(run.outcome, "resolved before 15 s").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(run.outcome).toEqual({ success: false, error: "evidence did not quiesce within 15000 ms", durationMs: 15_000 });
    expect(bundles).toEqual([]);
    expect(emitter.getEvents(`job-hook-stuck-${tier}`, STEP), "the failed step, detached").toEqual([]);
    expect(machine.quiesceCalls, "asked once: the finally does not ask again").toBe(1);
  });

  it("a hook still pending at the bound keeps the device quiescing, with no time-based release: B is refused, with no command and no registerStep, until it resolves; then B runs", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const registerStep = vi.spyOn(emitter, "registerStep");
    const answer = deferred();
    let calls = 0;
    const machine = testMachine("machine-hook-late", { quiesceEvidence: () => (++calls === 1 ? answer.promise : Promise.resolve()) });
    const a = await drive(new JobRunner(machine, [], null, emitter, { evidenceQuiesceTimeoutMs: 1_000 }).run({ jobId: "job-hook-late-A", stepId: STEP, gcodeHash: gcode(206), assuranceTier: 1 }));
    expect(a).toMatchObject({ success: false, error: "evidence did not quiesce within 1000 ms" });
    const commandsOfA = [...machine.commands];
    const jobB = { jobId: "job-hook-late-B", stepId: STEP, gcodeHash: gcode(207), assuranceTier: 1 as const };

    expect(await drive(new JobRunner(machine, [], null, emitter).run(jobB))).toEqual({
      success: false,
      error: "adapter machine-hook-late is still quiescing after job job-hook-late-A",
      busy: { reason: "quiescing", adapterId: "machine-hook-late", jobId: "job-hook-late-A" },
      durationMs: 0,
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect((await drive(new JobRunner(machine, [], null, emitter).run(jobB))).busy?.reason, "an hour on").toBe("quiescing");
    expect(machine.commands, "commands sent while the device was quiescing").toEqual(commandsOfA);
    expect(registerStep.mock.calls.map(([jobId]) => jobId), "steps registered").toEqual(["job-hook-late-A"]);

    answer.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await drive(new JobRunner(machine, [], null, emitter).run(jobB))).toMatchObject({ success: true });
  });

  it("fails the run with the error of a quiesceEvidence that rejects; the next attempt asks again, and runs once that resolves", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    let calls = 0;
    const machine = testMachine("machine-hook-rejects", { quiesceEvidence: async () => (++calls === 1 ? Promise.reject(new Error("printer offline")) : undefined) });

    const result = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-hook-rejects", stepId: STEP, gcodeHash: gcode(203), assuranceTier: 1 }));
    expect(result).toEqual({ success: false, error: "printer offline", durationMs: expect.any(Number) });
    expect(bundles).toEqual([]);

    const next = { jobId: "job-hook-rejects-next", stepId: STEP, gcodeHash: gcode(208), assuranceTier: 1 as const };
    expect((await drive(new JobRunner(machine, [], null, emitter).run(next))).busy?.reason, "the device is quiescing; the refusal asks again").toBe("quiescing");
    expect(calls).toBe(2);
    expect(await drive(new JobRunner(machine, [], null, emitter).run(next))).toMatchObject({ success: true });
  });

  type Missing = "machine" | "sensor" | "camera";
  it.each<[Missing, unknown]>([
    ["machine", undefined],
    ["sensor", undefined],
    ["camera", undefined],
    ["machine", "yes"],
  ])("refuses a %s object whose quiesceEvidence is %s, before any session, command or registerStep", async (which, hook) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const registerStep = vi.spyOn(emitter, "registerStep");
    const machine = testMachine(`machine-no-hook-${which}-${String(hook)}`);
    const sensor = {
      id: `sensor-no-hook-${which}-${String(hook)}`,
      type: "power_monitor" as const,
      source: { deviceId: `sensor-no-hook-${which}-${String(hook)}`, deviceType: "power_monitor" as const, kernelId: KERNEL_ID },
      startRecording: vi.fn(async () => {}),
      stopRecording: vi.fn(async () => evidence("power_profile_summary", "sensor", "power_monitor")),
      getCurrentReading: async () => ({}),
      onEvidence: vi.fn(),
      quiesceEvidence: async () => {},
      dispose: async () => {},
    };
    const camera = testCamera(`camera-no-hook-${which}-${String(hook)}`);
    const target = (which === "machine" ? machine : which === "sensor" ? sensor : camera) as unknown as Record<string, unknown>;
    if (hook === undefined) delete target.quiesceEvidence;
    else target.quiesceEvidence = hook;

    const result = await drive(new JobRunner(machine, [sensor as never], camera, emitter).run({ jobId: "job-no-hook", stepId: STEP, gcodeHash: gcode(209), assuranceTier: 2 }));

    expect(result).toEqual({ success: false, error: `adapter ${String(target.id)} has no quiesceEvidence(), so its evidence cannot be bound to a job`, durationMs: 0 });
    expect(machine.commands, "commands sent").toEqual([]);
    expect(sensor.startRecording).not.toHaveBeenCalled();
    expect(sensor.onEvidence, "listeners registered (a session opened)").not.toHaveBeenCalled();
    expect(registerStep).not.toHaveBeenCalled();
  });

  it("a device that keeps emitting does not hold up a run whose adapter has nothing outstanding: what it emits after the window closes is dropped, and the next job runs at once", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("machine-noisy");
    const noise = setInterval(() => machine.emit(evidence("execution_progress", machine.id, "controller", { tick: true })), 200);

    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-noisy", stepId: STEP, gcodeHash: gcode(205), assuranceTier: 1 }));
    expect(a, "round 3 failed this run at the quiesce bound: the device was never quiet").toMatchObject({ success: true, durationMs: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitter.getEvents("job-noisy", STEP).map((e) => e.payload), "payloads recorded under the job").not.toContainEqual(expect.objectContaining({ tick: true }));

    const next = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-noisy-next", stepId: STEP, gcodeHash: gcode(206), assuranceTier: 1 }));
    clearInterval(noise);
    expect(next).toMatchObject({ success: true });
  });

  it("a run that fails before step 8 returns only once its adapters have answered (bounded), and its devices are free when it returns", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("machine-fails-then-quiesces", {
      // The failed start leaves the device something to finish: it answers 500 ms later.
      quiesceEvidence: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    });
    machine.failing = "start";
    const started = Date.now();

    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-fails-then-quiesces", stepId: STEP, gcodeHash: gcode(210), assuranceTier: 1 }));
    expect(a).toMatchObject({ success: false, error: "Failed to start: start refused" });
    expect(Date.now() - started, "run() returned after the hook").toBe(500);
    expect(machine.quiesceCalls).toBe(1);

    machine.failing = null;
    expect(await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-fails-then-quiesces-next", stepId: STEP, gcodeHash: gcode(211), assuranceTier: 1 }))).toMatchObject({
      success: true,
    });
  });

  it("after a job that succeeded, an event its device emits later is dropped and does not hold the next job up", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = testMachine("machine-late-after-success");
    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-late-A", stepId: STEP, gcodeHash: gcode(212), assuranceTier: 1 }));
    expect(a.success).toBe(true);
    machine.emit(evidence("execution_completed", machine.id, "controller", { late: "after close" }));
    expect(console.warn).toHaveBeenCalledWith(`[evidence-session] dropped a execution_completed event from adapter ${machine.id}: no job is recording it`);

    const b = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-late-B", stepId: STEP, gcodeHash: gcode(213), assuranceTier: 1 }));
    expect(b, "round 3 refused B for a quiet period after that event").toMatchObject({ success: true });
    const payloads = ["job-late-A", "job-late-B"].flatMap((jobId) => emitter.getEvents(jobId, STEP).map((e) => e.payload));
    expect(payloads, "payloads recorded under either job").not.toContainEqual(expect.objectContaining({ late: "after close" }));
  });
});

describe("Step lease: an active (jobId, stepId) is refused, never overwritten", () => {
  it("a run of a running step is refused; once the first run returns, the step can run again, on a fresh record", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const releaseA = deferred();
    const machineA = testMachine("machine-lease-A", { holdStart: new Map([[1, releaseA.promise]]) });
    const machineB = testMachine("machine-lease-B");
    const job = { jobId: "job-lease", stepId: STEP, assuranceTier: 1 as const };

    const runA = new JobRunner(machineA, [], null, emitter).run({ ...job, gcodeHash: gcode(301) });
    await drive(machineA.started(1));
    const refused = await drive(new JobRunner(machineB, [], null, emitter).run({ ...job, gcodeHash: gcode(302) }));
    expect(refused).toEqual({ success: false, error: "step step-1 of job job-lease is already running", busy: { reason: "step", jobId: "job-lease", stepId: STEP }, durationMs: 0 });
    releaseA.resolve();
    expect(await drive(runA)).toMatchObject({ success: true });

    expect(await drive(new JobRunner(machineB, [], null, emitter).run({ ...job, gcodeHash: gcode(302) }))).toMatchObject({ success: true });
    expect(bundles.map((bundle) => bundle.events.map((e) => (e.payload as { gcodeHash?: string }).gcodeHash))).toEqual([
      [gcode(301), gcode(301), gcode(301)],
      [gcode(302), gcode(302), gcode(302)],
    ]);
  });

  it("is per emitter: the same (jobId, stepId) on another emitter runs alongside", async () => {
    const releaseA = deferred();
    const machineA = testMachine("machine-lease-emitter-A", { holdStart: new Map([[1, releaseA.promise]]) });
    const job = { jobId: "job-lease-emitters", stepId: STEP, gcodeHash: gcode(303), assuranceTier: 1 as const };
    const runA = new JobRunner(machineA, [], null, new EvidenceEmitter(KERNEL_ID)).run(job);
    await drive(machineA.started(1));

    const other = await drive(new JobRunner(testMachine("machine-lease-emitter-B"), [], null, new EvidenceEmitter(KERNEL_ID)).run(job));
    expect(other).toMatchObject({ success: true });
    releaseA.resolve();
    expect(await drive(runA)).toMatchObject({ success: true });
  });

  type Ending = { options: { evidenceQuiesceTimeoutMs?: number; evidenceSettleTimeoutMs?: number }; machine: Parameters<typeof testMachine>[1]; failing?: "load_gcode"; status?: "error" };
  it.each<[string, Ending]>([
    ["returns early (load fails)", { options: {}, machine: {}, failing: "load_gcode" }],
    ["throws (the machine reports an error)", { options: {}, machine: {}, status: "error" }],
    ["times out quiescing", { options: { evidenceQuiesceTimeoutMs: 100 }, machine: { quiesceEvidence: () => new Promise<void>(() => {}) } }],
    ["times out settling", { options: { evidenceSettleTimeoutMs: 100 }, machine: { onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)] } }],
  ])("is released when the run holding it %s", async (why, ending) => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    if (why === "times out settling") hashing.gate = (event) => ((event as Emitted).type === "gcode_received" ? new Promise<void>(() => {}) : undefined);
    const slug = why.replace(/\W+/g, "-");
    const machine = testMachine(`machine-lease-ends-${slug}`, ending.machine);
    machine.failing = ending.failing ?? null;
    if (ending.status) Object.assign(machine, { getStatus: async () => ending.status, getProgress: async () => 50 });
    const job = { jobId: "job-lease-ends", stepId: STEP, gcodeHash: gcode(304), assuranceTier: 1 as const };

    const first = await drive(new JobRunner(machine, [], null, emitter, ending.options).run(job));
    expect(first.success).toBe(false);
    expect(first.busy).toBeUndefined();

    hashing.gate = null;
    const again = await drive(new JobRunner(testMachine(`machine-lease-ends-${slug}-next`), [], null, emitter).run(job));
    expect(again).toMatchObject({ success: true });
  });

  it("is still held while a failed run settles, so that run's cleanup cannot wipe a new run of the step", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const hashHeld = deferred();
    hashing.gate = (event) => ((event as Emitted).type === "gcode_received" ? hashHeld.promise : undefined);
    const machineA = testMachine("machine-lease-settling-A", {
      onLoad: (id, hash) => [evidence("gcode_received", id, "controller", { gcodeHash: hash }), ...tier1(id, hash)],
    });
    machineA.failing = "start";
    const job = { jobId: "job-lease-settling", stepId: STEP, assuranceTier: 1 as const };

    const runA = track(new JobRunner(machineA, [], null, emitter, { evidenceSettleTimeoutMs: 1_000 }).run({ ...job, gcodeHash: gcode(305) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runA.outcome, "job A failed, and is settling").toBeUndefined();

    const machineB = testMachine("machine-lease-settling-B");
    const during = await drive(new JobRunner(machineB, [], null, emitter).run({ ...job, gcodeHash: gcode(306) }));
    expect(during.busy).toEqual({ reason: "step", jobId: "job-lease-settling", stepId: STEP });

    hashHeld.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA.outcome).toMatchObject({ success: false, error: "Failed to start: start refused" });
    expect(await drive(new JobRunner(machineB, [], null, emitter).run({ ...job, gcodeHash: gcode(306) }))).toMatchObject({ success: true });
    expect(emitter.getEvents("job-lease-settling", STEP).map((e) => (e.payload as { gcodeHash?: string }).gcodeHash)).toEqual([gcode(306), gcode(306), gcode(306)]);
    expect(bundles).toHaveLength(1);
  });
});

describe("Device lock: an adapter's device is its evidence source's (kernelId, deviceId)", () => {
  it("refuses a second adapter object on a device that is held, and on one that is quiescing, whatever kind of adapter claims it", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const device: EvidenceSource = { deviceId: "camera-shared-device", deviceType: "camera", kernelId: KERNEL_ID };
    const stream = deviceStream();
    const answer = deferred();
    /** A camera object on the shared device, hearing its stream; its hook answers when `answers` does. */
    const cameraOnDevice = (id: string, answers: Promise<void> = Promise.resolve()): CameraAdapter => ({
      ...testCamera(id),
      source: device,
      onEvidence: (callback) => void stream.listeners.push(callback),
      quiesceEvidence: () => answers,
    });
    const releaseA = deferred();
    const machineA = testMachine("machine-device-A", { holdStart: new Map([[1, releaseA.promise]]) });
    const machineB = testMachine("machine-device-B");
    const job = (n: number) => ({ jobId: `job-device-${n}`, stepId: STEP, gcodeHash: gcode(400 + n), assuranceTier: 1 as const });

    // Job A's camera does not confirm in time: A fails at the bound, and the device stays quiescing.
    const runA = new JobRunner(machineA, [], cameraOnDevice("camera-object-A", answer.promise), emitter, { evidenceQuiesceTimeoutMs: 1_000 }).run(job(1));
    await drive(machineA.started(1));
    const held = await drive(new JobRunner(machineB, [], cameraOnDevice("camera-object-B"), emitter).run(job(2)));
    expect(held.busy).toEqual({ reason: "adapter", adapterId: "camera-object-B", jobId: "job-device-1" });
    expect(machineB.commands, "commands sent to the refused job's machine").toEqual([]);

    releaseA.resolve();
    expect(await drive(runA)).toMatchObject({ success: false, error: "evidence did not quiesce within 1000 ms" });
    // A machine object that says it is the same device.
    const machineOnDevice = testMachine("machine-object", { source: device, stream });
    const quiescing = await drive(new JobRunner(machineOnDevice, [], null, emitter).run(job(3)));
    expect(quiescing.busy).toEqual({ reason: "quiescing", adapterId: "machine-object", jobId: "job-device-1" });
    expect(machineOnDevice.commands, "commands sent through the machine object").toEqual([]);

    answer.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await drive(new JobRunner(machineOnDevice, [], null, emitter).run(job(3)))).toMatchObject({ success: true });
  });

  it("lets adapters on different devices run at once, including one deviceId under two kernelIds", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const releases = [deferred(), deferred(), deferred()];
    const machines = [
      testMachine("machine-free-1", { source: { deviceId: "printer-1", deviceType: "controller", kernelId: KERNEL_ID }, holdStart: new Map([[1, releases[0]!.promise]]) }),
      testMachine("machine-free-2", { source: { deviceId: "printer-2", deviceType: "controller", kernelId: KERNEL_ID }, holdStart: new Map([[1, releases[1]!.promise]]) }),
      testMachine("machine-free-3", { source: { deviceId: "printer-1", deviceType: "controller", kernelId: "another-kernel" }, holdStart: new Map([[1, releases[2]!.promise]]) }),
    ];

    const runs = machines.map((machine, i) => new JobRunner(machine, [], null, emitter).run({ jobId: `job-free-${i}`, stepId: STEP, gcodeHash: gcode(410 + i), assuranceTier: 1 }));
    for (const machine of machines) await drive(machine.started(1)); // all three are executing at once
    for (const release of releases) release.resolve();
    for (const run of runs) expect(await drive(run)).toMatchObject({ success: true });
  });
});

describe("Closed before it settles: an event after quiescence is the next job's problem, never this bundle's", () => {
  it("an event that arrives once the run has quiesced, while its chain settles, is dropped: it is in neither the bundle nor the step", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const hashHeld = deferred();
    let held = 0;
    hashing.gate = (event) => {
      if ((event as Emitted).type !== "cv_inspection_result") return undefined;
      held += 1;
      return hashHeld.promise;
    };
    const machine = testMachine("machine-settling");
    const camera = testCamera("camera-settling");

    const run = track(new JobRunner(machine, [], camera, emitter).run({ jobId: "job-settling", stepId: STEP, gcodeHash: gcode(501), assuranceTier: 2 }));
    await vi.advanceTimersByTimeAsync(1_000); // every event came at once: the run has quiesced, and settles
    expect(held, "the inspection's addEvent, still hashing").toBe(1);
    expect(run.outcome).toBeUndefined();
    machine.emit(evidence("execution_progress", machine.id, "controller", { late: "while settling" }));
    hashHeld.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(run.outcome).toMatchObject({ success: true });
    expect(bundles.flatMap((bundle) => bundle.events.map((e) => e.payload)), "bundled payloads").not.toContainEqual(expect.objectContaining({ late: "while settling" }));
    expect(emitter.getEvents("job-settling", STEP).map((e) => e.payload), "payloads recorded under the job").not.toContainEqual(expect.objectContaining({ late: "while settling" }));
  });
});
