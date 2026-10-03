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
import { setEvidenceClock } from "../evidence-session.js";
import { JobRunner } from "../job-runner.js";
import type { JobResult } from "../job-runner.js";

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
    async runInspection() {
      if (emits) for (const listener of [...listeners]) listener(evidence("cv_inspection_result", id, "camera", { passed: true }));
      return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
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
  // The evidence clock reads the fake Date, so quiet periods run on the fake clock.
  // (Optional call: c87eff47, where R7-R9 were reproduced, has no evidence clock.)
  setEvidenceClock?.(() => Date.now());
  // The test signer, the tier warning and dropped events all warn; keep the output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  hashing.gate = null;
  setEvidenceClock?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R7: an event that arrives late is recorded under its own job, never under the next", () => {
  // A's machine reports 100% before its own poll loop emits execution_completed, LATE_MS
  // later, after A's run has passed step 7, as OctoPrint's does (octoprint-adapter.ts:225-277).
  // Only A completes that way: job B emits no completion of its own.
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
    // A device per case: a device stays unavailable while it is quiet for less than the quiet period.
    const machine = testMachine(`machine-r7-${when}`, {
      onLoad: (id, hash) => tier1(id, hash).filter((e) => e.type !== "execution_completed"),
      holdStart: new Map([[2, releaseB.promise]]),
      onStart: (m, n) => {
        if (n === 1) setTimeout(() => m.emit(evidence("execution_completed", m.id, "controller", { gcodeHash: gcode(71), late: true })), LATE_MS);
      },
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
    expect.soft(emitter.getEvents("job-r9-A", STEP).map((e) => e.payload), "payloads recorded under job A").not.toContainEqual({ gcodeHash: gcode(92) });
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
