/**
 * JobRunner binds evidence to a job by a REQUIRED handshake, quiesceEvidence() (#502 round 3b).
 *
 * Round 3 made the hook optional, with a quiet-period fallback (evidenceQuietMs, 1 s). That
 * fallback still assigns evidence by arrival time (astra pack 172: "the session tap assigns
 * evidence by arrival time, not by an authenticated execution epoch"):
 *   - R11: astra's recipe with a delay longer than the quiet period records A's completion under B;
 *   - R12: OctoPrint's real poll loop reports a completion up to one poll (2 s) after the runner saw
 *     100%, so the 1 s window closes first, and the completion lands in the next job.
 *
 * Every test here runs on the fake clock, with hashing moved onto microtasks (the mock below),
 * so the clock alone decides when a run moves on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle, EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

import type { MachineAdapter, MachineCommand, MachineCommandResult, SensorAdapter } from "../adapters/types.js";
import { OctoPrintAdapter } from "../adapters/octoprint-adapter.js";
import { fakeOctoPrintServer } from "./helpers/fake-octoprint-server.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import * as session from "../evidence-session.js";
import { JobRunner } from "../job-runner.js";
import type { JobResult } from "../job-runner.js";

// Plain functions, not vi.fn(), so vi.restoreAllMocks() cannot strip them.
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

// The real hashes run on crypto.subtle, whose callbacks come from real I/O. Hash on a
// microtask instead (still SHA-256 of the canonical form), so a fake-clock test never
// races real time.
vi.mock("@pcc/spec", async (importOriginal) => {
  const spec = await importOriginal<typeof import("@pcc/spec")>();
  const { createHash } = await import("node:crypto");
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(spec.canonicalize(value)).digest("hex")}`;
  return { ...spec, hashEvent: async (event: unknown) => digest(event), hashBundle: async (events: unknown) => digest(events) };
});

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-handshake-test";
const STEP = "step-1";

function evidence(type: Emitted["type"], deviceId: string, payload: Record<string, unknown> = {}): Emitted {
  return { type, timestamp: new Date().toISOString(), source: { deviceId, deviceType: "controller", kernelId: KERNEL_ID }, payload };
}

const gcode = (n: number): SHA256 => `sha256:${n.toString(16).padStart(64, "0")}` as SHA256;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Settle `promise` on the fake clock: drain the microtasks, then fire the timers one at a
 * time, in order, until it settles. Throws if it is still pending with no timer left to
 * fire (it waits on something the test has not released), or after 2,000 timers.
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
    if (fired >= 2_000) throw new Error("still pending after 2,000 timers");
    await vi.advanceTimersToNextTimerAsync();
  }
  return promise;
}

const typesOf = (emitter: EvidenceEmitter, jobId: string) => emitter.getEvents(jobId, STEP).map((e) => e.type);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // Round 3's quiet periods ran on an evidence clock; put it on the fake one where it
  // still exists (3290335c, where R11 and R12 were reproduced). Round 3b removes it.
  (session as { setEvidenceClock?: (clock?: () => number) => void }).setEvidenceClock?.(() => Date.now());
  // The test signer, the tier warning and dropped events all warn; keep the output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (session as { setEvidenceClock?: (clock?: () => number) => void }).setEvidenceClock?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R11: astra's recipe, with a delay longer than round 3's quiet period, on an adapter without a hook", () => {
  it("a late completion of job A is never recorded under job B: the adapter is refused, having no handshake", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const listeners: Array<(event: Emitted) => void> = [];
    const emit = (event: Emitted) => {
      for (const listener of [...listeners]) listener(event);
    };
    const releaseB = deferred();
    let starts = 0;
    const startedTwice = deferred();
    // A device whose completion arrives 5 s after it starts, and which has no quiesceEvidence().
    const machine = {
      id: "machine-r11",
      type: "fdm",
      source: { deviceId: "machine-r11", deviceType: "controller", kernelId: KERNEL_ID },
      async getStatus() {
        return "busy" as const;
      },
      async getProgress() {
        return 100;
      },
      async execute(command: MachineCommand): Promise<MachineCommandResult> {
        if (command.type === "load_gcode") {
          emit(evidence("gcode_hash_verified", "machine-r11", { gcodeHash: command.payload?.gcodeHash }));
          emit(evidence("power_profile_summary", "machine-r11", { gcodeHash: command.payload?.gcodeHash }));
        }
        if (command.type === "start") {
          starts += 1;
          if (starts === 1) setTimeout(() => emit(evidence("execution_completed", "machine-r11", { of: "job A" })), 5_000);
          if (starts === 2) {
            startedTwice.resolve();
            await releaseB.promise;
          }
        }
        return { success: true };
      },
      onEvidence(callback: (event: Emitted) => void) {
        listeners.push(callback);
      },
      async dispose() {},
    } as unknown as MachineAdapter;

    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-r11-A", stepId: STEP, gcodeHash: gcode(111), assuranceTier: 1 }));
    const runB = new JobRunner(machine, [], null, emitter).run({ jobId: "job-r11-B", stepId: STEP, gcodeHash: gcode(112), assuranceTier: 1 });
    await drive(Promise.race([startedTwice.promise, runB])); // job B is executing, or was refused
    await vi.advanceTimersByTimeAsync(5_000); // A's late completion has fired by now, if A ran
    releaseB.resolve();
    const b = await drive(runB);

    const payloadsOf = (jobId: string) => emitter.getEvents(jobId, STEP).map((e) => e.payload);
    expect.soft(payloadsOf("job-r11-B"), "payloads recorded under job B").not.toContainEqual(expect.objectContaining({ of: "job A" }));
    expect.soft(b.success && typesOf(emitter, "job-r11-B").includes("execution_completed"), "job B passed Tier 1 on a completion").toBe(false);
    const refusal = { success: false, error: "adapter machine-r11 has no quiesceEvidence(), so its evidence cannot be bound to a job", durationMs: 0 };
    expect.soft(a, "job A's result").toEqual(refusal);
    expect.soft(b, "job B's result").toEqual({ ...refusal });
  });
});

/**
 * The real OctoPrintAdapter, given the file name JobRunner does not send (its load_gcode
 * payload is only { gcodeHash }; OctoPrint selects a file by name). Its quiesceEvidence is
 * forwarded when it has one.
 */
function octoPrintGivenFileNames(octo: OctoPrintAdapter): MachineAdapter {
  let loads = 0;
  const hook = (octo as Partial<MachineAdapter>).quiesceEvidence;
  return {
    id: octo.id,
    type: octo.type,
    source: octo.source,
    getStatus: () => octo.getStatus(),
    getProgress: () => octo.getProgress(),
    execute: (command: MachineCommand) =>
      octo.execute(command.type === "load_gcode" ? { ...command, payload: { ...command.payload, filename: `job-${++loads}.gcode` } } : command),
    onEvidence: (callback) => octo.onEvidence(callback),
    dispose: () => octo.dispose(),
    ...(typeof hook === "function" ? { quiesceEvidence: () => hook.call(octo) } : {}),
  } as MachineAdapter;
}

describe("R12: OctoPrint's polled completion, the case astra cited (octoprint-adapter.ts:225-277)", () => {
  it("job A's completion, reported by A's poll loop after the runner saw 100%, is recorded under A, never under the next job", async () => {
    const server = fakeOctoPrintServer();
    vi.stubGlobal("fetch", server.fetch);
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const bundles: EvidenceBundle[] = [];
    emitter.onBundle((bundle) => bundles.push(bundle));
    const octo = new OctoPrintAdapter("octoprint-r12", { url: "http://octoprint.test", apiKey: "test-key", kernelId: KERNEL_ID, pollIntervalMs: 2_000 });
    const machine = octoPrintGivenFileNames(octo);

    const a = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-r12-A", stepId: STEP, gcodeHash: gcode(121), assuranceTier: 0 }));
    // Job B is queued as soon as A returns; its file selection is held, so its window is open.
    const releaseSelect = server.hold("POST /api/files/local/job-2.gcode");
    const runB = new JobRunner(machine, [], null, emitter).run({ jobId: "job-r12-B", stepId: STEP, gcodeHash: gcode(122), assuranceTier: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000); // one more of A's polls, if A's loop is still running
    releaseSelect();
    const b = await drive(runB);
    await vi.advanceTimersByTimeAsync(10_000);
    void octo.dispose();

    const completionsOf = (jobId: string) =>
      emitter.getEvents(jobId, STEP).flatMap((e) => (e.type === "execution_completed" ? [(e.payload as { jobName?: string }).jobName] : []));
    expect.soft(a, "job A's result").toMatchObject({ success: true });
    expect.soft(b, "job B's result").toMatchObject({ success: true });
    expect.soft(completionsOf("job-r12-B"), "completions recorded under job B (by the file they printed)").not.toContain("job-1.gcode");
    expect.soft(completionsOf("job-r12-A"), "completions recorded under job A").toEqual(["job-1.gcode"]);
    const bundled = (jobId: string) => bundles.filter((bundle) => bundle.jobId === jobId).flatMap((bundle) => bundle.events.map((e) => e.payload));
    expect.soft(bundled("job-r12-B"), "job B's bundle").not.toContainEqual(expect.objectContaining({ jobName: "job-1.gcode" }));
  });
});

/** A machine whose events come at load, and whose quiesceEvidence() is `hook`. */
function handshakeMachine(id: string, options: { hook: () => Promise<void>; onStart?: (emit: (event: Emitted) => void, n: number) => void; failStart?: boolean }) {
  const listeners: Array<(event: Emitted) => void> = [];
  const emit = (event: Emitted) => {
    for (const listener of [...listeners]) listener(event);
  };
  let starts = 0;
  const commands: string[] = [];
  const machine: MachineAdapter & { commands: string[] } = {
    id,
    type: "fdm",
    source: { deviceId: id, deviceType: "controller", kernelId: KERNEL_ID },
    commands,
    async getStatus() {
      return "busy";
    },
    async getProgress() {
      return 100;
    },
    async execute(command: MachineCommand): Promise<MachineCommandResult> {
      commands.push(command.type);
      if (command.type === "load_gcode") {
        emit(evidence("gcode_hash_verified", id, { gcodeHash: command.payload?.gcodeHash }));
        emit(evidence("power_profile_summary", id, { gcodeHash: command.payload?.gcodeHash }));
      }
      if (command.type === "start") {
        starts += 1;
        options.onStart?.(emit, starts);
        if (options.failStart) return { success: false, message: "start refused" };
      }
      return { success: true };
    },
    onEvidence(callback) {
      listeners.push(callback);
    },
    quiesceEvidence: () => options.hook(),
    async dispose() {},
  };
  return machine;
}

describe("astra's recipe on an adapter whose hook answers only after its completion (5 s on the fake clock)", () => {
  it("A's completion is A's; B is refused while A waits for it; B gets nothing of A's", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    let owed: Promise<void> = Promise.resolve();
    const machine = handshakeMachine("machine-recipe", {
      onStart: (emit, n) => {
        if (n !== 1) return;
        owed = new Promise<void>((resolve) =>
          setTimeout(() => {
            emit(evidence("execution_completed", "machine-recipe", { of: "job A" }));
            resolve();
          }, 5_000),
        );
      },
      hook: () => owed,
    });

    const runA = new JobRunner(machine, [], null, emitter).run({ jobId: "job-recipe-A", stepId: STEP, gcodeHash: gcode(131), assuranceTier: 1 });
    await vi.advanceTimersByTimeAsync(4_999); // A has passed step 7 and waits for its adapter
    const during = await new JobRunner(machine, [], null, emitter).run({ jobId: "job-recipe-B", stepId: STEP, gcodeHash: gcode(132), assuranceTier: 1 });
    expect(during.busy, "B, while A waits for its completion").toEqual({ reason: "adapter", adapterId: "machine-recipe", jobId: "job-recipe-A" });
    const a = await drive(runA);
    const b = await drive(new JobRunner(machine, [], null, emitter).run({ jobId: "job-recipe-B", stepId: STEP, gcodeHash: gcode(132), assuranceTier: 1 }));

    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: true });
    expect(emitter.getEvents("job-recipe-A", STEP).map((e) => e.payload), "payloads recorded under job A").toContainEqual(expect.objectContaining({ of: "job A" }));
    expect(emitter.getEvents("job-recipe-B", STEP).map((e) => e.payload), "payloads recorded under job B").not.toContainEqual(expect.objectContaining({ of: "job A" }));
    expect(typesOf(emitter, "job-recipe-B"), "job B has no completion of its own").not.toContain("execution_completed");
  });
});

describe("a failed run stops the sensors it started, so their hooks can answer", () => {
  it("a recording left running by a failed start is stopped; the run returns once the sensor has answered, and the sensor is free for the next job", async () => {
    const { MockPowerMonitorAdapter } = await import("../adapters/mock-power-monitor.js");
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const power = new MockPowerMonitorAdapter("power-left-recording", KERNEL_ID);
    const emittedByPower: string[] = [];
    power.onEvidence((event) => emittedByPower.push(event.type));
    const failing = handshakeMachine("machine-fails-start", { hook: async () => {}, failStart: true });

    const a = await drive(new JobRunner(failing, [power], null, emitter).run({ jobId: "job-left-A", stepId: STEP, gcodeHash: gcode(141), assuranceTier: 1 }));
    expect(a).toEqual({ success: false, error: "Failed to start: start refused", durationMs: 0 });
    expect(emittedByPower, "the sensor's summary, from the stop the failed run made").toEqual(["power_profile_summary"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emittedByPower, "samples after the failed run returned").toEqual(["power_profile_summary"]);

    const machine = handshakeMachine("machine-after-left", { hook: async () => {} });
    expect(await drive(new JobRunner(machine, [power], null, emitter).run({ jobId: "job-left-B", stepId: STEP, gcodeHash: gcode(142), assuranceTier: 1 }))).toMatchObject({ success: true });
  });
});

/**
 * A sensor whose stop can fail. Its stopRecording() is `stop`, given the call's number (1, 2,
 * ...), which may reject or throw synchronously. Its quiesceEvidence() answers only once a stop
 * has succeeded, as an honest hook with a recording still running must.
 */
function stoppableSensor(id: string, stop: (call: number) => Promise<Emitted>): SensorAdapter & { readonly stops: number } {
  let stopped = { promise: Promise.resolve(), resolve: () => {} };
  let calls = 0;
  return {
    id,
    type: "power_monitor",
    source: { deviceId: id, deviceType: "power_monitor", kernelId: KERNEL_ID },
    get stops() {
      return calls;
    },
    async startRecording() {
      stopped = deferred();
    },
    stopRecording() {
      calls += 1;
      return stop(calls).then((summary) => {
        stopped.resolve();
        return summary;
      });
    },
    async getCurrentReading() {
      return {};
    },
    onEvidence() {},
    quiesceEvidence: () => stopped.promise,
    async dispose() {},
  };
}

describe("astra pack 184 MEDIUM: a sensor stop that fails is never forgotten, and cannot abort the cleanup", () => {
  it("astra's recipe: a stop that rejects in step 6 is made again on the failure path, so the hook answers and the next job runs", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const sensor = stoppableSensor("sensor-stop-retry", async (call) => {
      if (call === 1) throw new Error("stop failed once");
      return evidence("power_profile_summary", "sensor-stop-retry");
    });
    const machine = handshakeMachine("machine-stop-retry", { hook: async () => {} });

    const a = await drive(new JobRunner(machine, [sensor], null, emitter).run({ jobId: "job-stop-A", stepId: STEP, gcodeHash: gcode(151), assuranceTier: 1 }));
    expect.soft(a, "job A's result").toEqual({ success: false, error: "stop failed once", durationMs: 0 });
    expect.soft(sensor.stops, "stopRecording() calls: step 6's, then the failure path's").toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    const next = handshakeMachine("machine-stop-retry-next", { hook: async () => {} });
    const b = await drive(new JobRunner(next, [sensor], null, emitter).run({ jobId: "job-stop-B", stepId: STEP, gcodeHash: gcode(152), assuranceTier: 1 }));
    expect.soft(b.busy, "the next job on the sensor, a minute later").toBeUndefined();
    expect.soft(b, "the next job's result").toMatchObject({ success: true });
  });

  it("a stop that throws synchronously on the failure path is contained: the run returns its own failure, closes, and frees the machine", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const sensor = stoppableSensor("sensor-stop-throws", () => {
      throw new Error("stop threw synchronously");
    });
    const machine = handshakeMachine("machine-stop-throws", { hook: async () => {}, failStart: true });

    const a = await drive(new JobRunner(machine, [sensor], null, emitter).run({ jobId: "job-throw-A", stepId: STEP, gcodeHash: gcode(161), assuranceTier: 1 })).catch(
      (err: unknown) => ({ rejectedWith: err instanceof Error ? err.message : String(err) }),
    );
    expect.soft(a, "job A's result").toEqual({ success: false, error: "Failed to start: start refused", durationMs: 0 });
    expect.soft(sensor.stops, "stopRecording() calls").toBe(1);

    const free = handshakeMachine("machine-stop-throws", { hook: async () => {} });
    const b = await drive(new JobRunner(free, [], null, emitter).run({ jobId: "job-throw-B", stepId: STEP, gcodeHash: gcode(162), assuranceTier: 0 }));
    expect.soft(b.busy, "the next job on the machine").toBeUndefined();
    expect.soft(b, "the next job's result").toMatchObject({ success: true });
    // The sensor never stopped, so its honest hook never answers: its device stays held (fail closed).
    const held = await new JobRunner(free, [sensor], null, emitter).run({ jobId: "job-throw-C", stepId: STEP, gcodeHash: gcode(163), assuranceTier: 1 });
    expect.soft(held.busy, "a job on the sensor that never stopped").toEqual({ reason: "quiescing", adapterId: "sensor-stop-throws", jobId: "job-throw-A" });
  });
});
