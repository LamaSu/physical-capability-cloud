/**
 * openEvidenceSession: one permanent tap per adapter instance, one open session per
 * device, nothing delivered once a session is closed (#502 round 2, astra pack 168), and
 * a device handed to the next session only on its adapter's quiesceEvidence() (round 3b).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { SHA256 } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { openEvidenceSession } from "../evidence-session.js";
import type { EmittedEvidence } from "../evidence-session.js";
import { JobRunner } from "../job-runner.js";
import { lose1Capture } from "./lose1-capture-fixture.js";

vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

const KERNEL_ID = "kernel-session-test";

function evidence(type: EmittedEvidence["type"], deviceId: string, payload: Record<string, unknown> = {}): EmittedEvidence {
  return { type, timestamp: new Date().toISOString(), source: { deviceId, deviceType: "controller", kernelId: KERNEL_ID }, payload };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let devices = 0;

/**
 * An adapter on a device of its own, unless it is given one (a session locks the device).
 * Its quiesceEvidence() resolves at once (it emits only when the test says so); a test
 * makes it wait with quiesceEvidence.mockImplementation.
 */
function fakeAdapter(id: string, deviceId = `${id}-device-${++devices}`) {
  const listeners: Array<(event: EmittedEvidence) => void> = [];
  return {
    id,
    source: { deviceId, kernelId: KERNEL_ID },
    onEvidence: vi.fn((callback: (event: EmittedEvidence) => void) => {
      listeners.push(callback);
    }),
    quiesceEvidence: vi.fn(async (): Promise<void> => {}),
    emit(event: EmittedEvidence) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const owner = (jobId: string) => ({ jobId, stepId: "step-1" });

/** Open a session that must not be refused. */
function mustOpen(...args: Parameters<typeof openEvidenceSession>) {
  const opened = openEvidenceSession(...args);
  if (!opened.ok) throw new Error(`refused: ${JSON.stringify(opened.busy)}`);
  return opened.session;
}

/** Let settled hooks report back (their answers settle on microtasks). */
const answered = () => new Promise<void>((resolve) => setImmediate(resolve));

let warn: MockInstance;
let error: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("openEvidenceSession", () => {
  it("delivers every event from every adapter in the session, each once", () => {
    const a = fakeAdapter("adapter-a");
    const b = fakeAdapter("adapter-b");
    const deliver = vi.fn();
    mustOpen([a, b], owner("job-1"), deliver);

    a.emit(evidence("execution_started", "adapter-a"));
    b.emit(evidence("power_profile_sample", "adapter-b"));

    expect(deliver.mock.calls.map(([e]) => e.type)).toEqual(["execution_started", "power_profile_sample"]);
  });

  it("dedupes an adapter passed twice: one listener, one delivery per event, one hook call, one claim to release", async () => {
    const a = fakeAdapter("adapter-a");
    const deliver = vi.fn();
    const session = mustOpen([a, a], owner("job-1"), deliver);

    a.emit(evidence("execution_started", "adapter-a"));
    expect(a.onEvidence).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    session.close();
    // Its device is free once its one hook call has answered (round 3: once quiet for 1 s).
    await answered();
    expect(a.quiesceEvidence).toHaveBeenCalledTimes(1);
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok).toBe(true);
  });

  it("refuses, opening nothing, while any adapter is in another open session, naming that adapter and its job", () => {
    const a = fakeAdapter("adapter-a");
    const b = fakeAdapter("adapter-b");
    const c = fakeAdapter("adapter-c");
    mustOpen([a, b], owner("job-1"), vi.fn());

    expect(openEvidenceSession([c, b], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "adapter", adapterId: "adapter-b", jobId: "job-1" } });

    // Nothing was opened on c: another job can take it, and only that job sees its events.
    expect(c.onEvidence).not.toHaveBeenCalled();
    expect(c.quiesceEvidence, "hooks asked by a refused session").not.toHaveBeenCalled();
    const deliverC = vi.fn();
    mustOpen([c], owner("job-3"), deliverC);
    c.emit(evidence("execution_started", "adapter-c"));
    expect(deliverC).toHaveBeenCalledTimes(1);
  });

  it("close is idempotent, and a stale close never touches a later session on the same adapter", async () => {
    const a = fakeAdapter("adapter-a");
    const first = mustOpen([a], owner("job-1"), vi.fn());
    first.close();
    first.close();
    await answered();
    expect(a.quiesceEvidence, "hook calls by two closes of one session").toHaveBeenCalledTimes(1);

    const deliver = vi.fn();
    mustOpen([a], owner("job-2"), deliver);
    first.close();

    a.emit(evidence("execution_started", "adapter-a"));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(a.quiesceEvidence, "hook calls by the stale close").toHaveBeenCalledTimes(1);
    expect(openEvidenceSession([a], owner("job-3"), vi.fn())).toEqual({ ok: false, busy: { reason: "adapter", adapterId: "adapter-a", jobId: "job-2" } });
  });

  it("drops an event emitted after close, warning with the adapter id and the event type, never the payload", () => {
    const a = fakeAdapter("adapter-a");
    const deliver = vi.fn();
    mustOpen([a], owner("job-1"), deliver).close();

    a.emit(evidence("cv_inspection_result", "adapter-a", { secret: "payload-must-not-be-logged" }));

    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("adapter-a");
    expect(message).toContain("cv_inspection_result");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("payload-must-not-be-logged");
  });

  it("registers one listener per adapter however many sessions open on it", async () => {
    const a = fakeAdapter("adapter-a");
    for (let i = 0; i < 3; i++) {
      mustOpen([a], owner(`job-${i}`), vi.fn()).close();
      await answered();
    }
    expect(a.onEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("JobRunner over shared adapters", () => {
  it("registers exactly one onEvidence listener per adapter after 3 sequential runs, and asks each adapter to quiesce once per run", async () => {
    const machineListeners: Array<(e: EmittedEvidence) => void> = [];
    const sensorListeners: Array<(e: EmittedEvidence) => void> = [];
    const cameraListeners: Array<(e: EmittedEvidence) => void> = [];
    const emitTo = (listeners: Array<(e: EmittedEvidence) => void>, e: EmittedEvidence) => {
      for (const listener of [...listeners]) listener(e);
    };
    // Each emits only inside the call that causes it, so its hook has nothing to wait for.
    const machine: MachineAdapter = {
      id: "machine-3runs",
      type: "fdm",
      source: { deviceId: "machine-3runs", deviceType: "controller", kernelId: KERNEL_ID },
      getStatus: async () => "busy",
      getProgress: async () => 100,
      execute: async (command) => {
        if (command.type === "load_gcode") {
          emitTo(machineListeners, evidence("gcode_hash_verified", "machine-3runs"));
          emitTo(machineListeners, evidence("execution_completed", "machine-3runs"));
        }
        return { success: true };
      },
      onEvidence: vi.fn((cb) => void machineListeners.push(cb)),
      quiesceEvidence: vi.fn(async () => {}),
      dispose: async () => {},
    };
    const sensor: SensorAdapter = {
      id: "power-3runs",
      type: "power_monitor",
      source: { deviceId: "power-3runs", deviceType: "power_monitor", kernelId: KERNEL_ID },
      startRecording: async () => {},
      stopRecording: async () => {
        const summary = evidence("power_profile_summary", "power-3runs");
        emitTo(sensorListeners, summary);
        return summary;
      },
      getCurrentReading: async () => ({}),
      onEvidence: vi.fn((cb) => void sensorListeners.push(cb)),
      quiesceEvidence: vi.fn(async () => {}),
      dispose: async () => {},
    };
    const camera: CameraAdapter = {
      id: "camera-3runs",
      source: { deviceId: "camera-3runs", deviceType: "camera", kernelId: KERNEL_ID },
      captureSnapshot: async () => ({ imageHash: "sha256:none", storageRef: "none" }),
      runInspection: async (_referenceHash?: string, context?: { jobId?: string }) => {
        // A complete LO-SE-1 capture for the job it was asked for: since #489 only one counts.
        emitTo(cameraListeners, lose1Capture("cv_inspection_result", "camera-3runs", KERNEL_ID, String(context?.jobId)));
        return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
      },
      onEvidence: vi.fn((cb) => void cameraListeners.push(cb)),
      quiesceEvidence: vi.fn(async () => {}),
      dispose: async () => {},
    };
    const emitter = new EvidenceEmitter(KERNEL_ID);

    for (let i = 1; i <= 3; i++) {
      const result = await new JobRunner(machine, [sensor], camera, emitter).run({
        jobId: `job-3runs-${i}`,
        stepId: "step-1",
        gcodeHash: `sha256:${String(i).padStart(64, "0")}` as SHA256,
        assuranceTier: 2,
      });
      expect(result).toMatchObject({ success: true });
      expect(emitter.getEvents(`job-3runs-${i}`, "step-1")).toHaveLength(4);
    }

    expect(machine.onEvidence).toHaveBeenCalledTimes(1);
    expect(sensor.onEvidence).toHaveBeenCalledTimes(1);
    expect(camera.onEvidence).toHaveBeenCalledTimes(1);
    expect([machine.quiesceEvidence, sensor.quiesceEvidence, camera.quiesceEvidence].map((hook) => vi.mocked(hook).mock.calls.length)).toEqual([3, 3, 3]);
  });
});

describe("quiesce and the handoff guard: the adapter's word, never a clock (#502 round 3b)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** session.quiesce(), plus its result once it has one. */
  function quiescing(session: ReturnType<typeof mustOpen>, timeoutMs: number): { readonly result: boolean | undefined } {
    const tracked: { result: boolean | undefined } = { result: undefined };
    void session.quiesce(timeoutMs).then((result) => {
      tracked.result = result;
    });
    return tracked;
  }

  it("quiesce resolves true once every adapter's hook has resolved, however late, and still delivers what arrives meanwhile", async () => {
    const a = fakeAdapter("adapter-a");
    const b = fakeAdapter("adapter-b");
    const doneA = deferred();
    const doneB = deferred();
    a.quiesceEvidence.mockImplementation(() => doneA.promise);
    b.quiesceEvidence.mockImplementation(() => doneB.promise);
    const deliver = vi.fn();
    const session = mustOpen([a, b], owner("job-1"), deliver);

    const quiet = quiescing(session, 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    a.emit(evidence("execution_completed", "adapter-a")); // a's late completion, 5 s on
    doneA.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(quiet.result, "b has not answered").toBeUndefined();
    b.emit(evidence("power_profile_summary", "adapter-b"));
    doneB.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(quiet.result).toBe(true);
    expect(deliver.mock.calls.map(([e]) => e.type)).toEqual(["execution_completed", "power_profile_summary"]);
    expect([a.quiesceEvidence.mock.calls.length, b.quiesceEvidence.mock.calls.length]).toEqual([1, 1]);
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("quiesce resolves false at timeoutMs for a hook that never resolves, and leaves no timer", async () => {
    const a = fakeAdapter("adapter-a");
    a.quiesceEvidence.mockImplementation(() => new Promise<void>(() => {}));
    const session = mustOpen([a], owner("job-1"), vi.fn());

    const quiet = quiescing(session, 3_000);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(quiet.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.result).toBe(false);
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("a second quiesce waits on the same answers: each adapter is asked once per session", async () => {
    const a = fakeAdapter("adapter-a");
    const done = deferred();
    a.quiesceEvidence.mockImplementation(() => done.promise);
    const session = mustOpen([a, a], owner("job-1"), vi.fn());
    const first = quiescing(session, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.result).toBe(false);
    const second = quiescing(session, 1_000);
    done.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.result).toBe(true);
    expect(a.quiesceEvidence).toHaveBeenCalledTimes(1);
  });

  it("quiesce rejects with the error of a quiesceEvidence that rejects", async () => {
    const a = fakeAdapter("adapter-a");
    a.quiesceEvidence.mockImplementation(() => Promise.reject(new Error("camera offline")));
    const session = mustOpen([a], owner("job-1"), vi.fn());
    await expect(session.quiesce(10_000)).rejects.toThrow("camera offline");
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("after close, a device whose hook is pending refuses every adapter object on it (quiescing), with no time-based release, until the hook resolves", async () => {
    const a = fakeAdapter("adapter-a");
    const sameDevice = fakeAdapter("adapter-a2", a.source.deviceId);
    const done = deferred();
    a.quiesceEvidence.mockImplementation(() => done.promise);
    const session = mustOpen([a], owner("job-1"), vi.fn());
    const quiesced = session.quiesce(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await quiesced, "the run's quiesce timed out").toBe(false);
    session.close();
    a.emit(evidence("execution_completed", "adapter-a")); // dropped: no job is recording it
    expect(warn).toHaveBeenCalledWith("[evidence-session] dropped a execution_completed event from adapter adapter-a: no job is recording it");

    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "quiescing", adapterId: "adapter-a2", jobId: "job-1" } });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok, "an hour on, the hook still pending").toBe(false);
    expect(sameDevice.onEvidence, "listeners registered by a refused session").not.toHaveBeenCalled();
    expect(a.quiesceEvidence, "a pending hook is not asked again").toHaveBeenCalledTimes(1);
    done.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn()).ok, "once the hook resolved").toBe(true);
  });

  it("a device whose adapter already answered is free as soon as its session closes", async () => {
    const a = fakeAdapter("adapter-a");
    const session = mustOpen([a], owner("job-1"), vi.fn());
    expect(await session.quiesce(1_000)).toBe(true);
    session.close();
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok).toBe(true);
    expect(a.quiesceEvidence, "close does not ask again").toHaveBeenCalledTimes(1);
  });

  it("close() asks an adapter that was never asked, and its device is quiescing until it answers", async () => {
    const a = fakeAdapter("adapter-a");
    const done = deferred();
    a.quiesceEvidence.mockImplementation(() => done.promise);
    mustOpen([a], owner("job-1"), vi.fn()).close();
    expect(a.quiesceEvidence).toHaveBeenCalledTimes(1);
    expect(openEvidenceSession([a], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "quiescing", adapterId: "adapter-a", jobId: "job-1" } });
    done.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok).toBe(true);
  });

  it("a hook that rejected keeps the device quiescing; the next attempt to open asks it again, and the device is free once that call resolves", async () => {
    const a = fakeAdapter("adapter-a");
    a.quiesceEvidence.mockImplementationOnce(() => Promise.reject(new Error("printer unreachable")));
    const session = mustOpen([a], owner("job-1"), vi.fn());
    await expect(session.quiesce(1_000)).rejects.toThrow("printer unreachable");
    session.close();
    await vi.advanceTimersByTimeAsync(3_600_000);

    // Refused, and the refusal asks the hook again (which now resolves).
    expect(openEvidenceSession([a], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "quiescing", adapterId: "adapter-a", jobId: "job-1" } });
    expect(a.quiesceEvidence).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("locks the device, not the object: a second object on a held device is refused; the same deviceId under another kernelId is another device", () => {
    const a = fakeAdapter("adapter-a");
    const sameDevice = fakeAdapter("adapter-a2", a.source.deviceId);
    const otherKernel = Object.assign(fakeAdapter("adapter-a3", a.source.deviceId), { source: { deviceId: a.source.deviceId, kernelId: "another-kernel" } });
    mustOpen([a], owner("job-1"), vi.fn());

    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "adapter", adapterId: "adapter-a2", jobId: "job-1" } });
    expect(openEvidenceSession([otherKernel], owner("job-3"), vi.fn()).ok).toBe(true);
  });
});
