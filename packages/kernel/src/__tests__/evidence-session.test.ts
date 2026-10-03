/**
 * openEvidenceSession: one permanent tap per adapter instance, one open session per
 * adapter, and nothing delivered once a session is closed (#502 round 2, astra pack 168).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { SHA256 } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter, SensorAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { DEFAULT_EVIDENCE_QUIET_MS, openEvidenceSession, setEvidenceClock } from "../evidence-session.js";
import type { EmittedEvidence } from "../evidence-session.js";
import { JobRunner } from "../job-runner.js";

vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  addBreadcrumb: () => {},
  captureException: () => {},
}));

const KERNEL_ID = "kernel-session-test";

function evidence(type: EmittedEvidence["type"], deviceId: string, payload: Record<string, unknown> = {}): EmittedEvidence {
  return { type, timestamp: new Date().toISOString(), source: { deviceId, deviceType: "controller", kernelId: KERNEL_ID }, payload };
}

let devices = 0;

/** An adapter on a device of its own, unless it is given one (a session locks the device). */
function fakeAdapter(id: string, deviceId = `${id}-device-${++devices}`) {
  const listeners: Array<(event: EmittedEvidence) => void> = [];
  return {
    id,
    source: { deviceId, kernelId: KERNEL_ID },
    onEvidence: vi.fn((callback: (event: EmittedEvidence) => void) => {
      listeners.push(callback);
    }),
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

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setEvidenceClock();
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

  it("dedupes an adapter passed twice: one listener, one delivery per event, one claim to release", () => {
    let now = 0;
    setEvidenceClock(() => now);
    const a = fakeAdapter("adapter-a");
    const deliver = vi.fn();
    const session = mustOpen([a, a], owner("job-1"), deliver);

    a.emit(evidence("execution_started", "adapter-a"));
    expect(a.onEvidence).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    session.close();
    // Once its device has been quiet for the quiet period (#502 round 3).
    now += DEFAULT_EVIDENCE_QUIET_MS;
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
    const deliverC = vi.fn();
    mustOpen([c], owner("job-3"), deliverC);
    c.emit(evidence("execution_started", "adapter-c"));
    expect(deliverC).toHaveBeenCalledTimes(1);
  });

  it("close is idempotent, and a stale close never touches a later session on the same adapter", () => {
    const a = fakeAdapter("adapter-a");
    const first = mustOpen([a], owner("job-1"), vi.fn());
    first.close();
    first.close();

    const deliver = vi.fn();
    mustOpen([a], owner("job-2"), deliver);
    first.close();

    a.emit(evidence("execution_started", "adapter-a"));
    expect(deliver).toHaveBeenCalledTimes(1);
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

  it("registers one listener per adapter however many sessions open on it", () => {
    const a = fakeAdapter("adapter-a");
    for (let i = 0; i < 3; i++) mustOpen([a], owner(`job-${i}`), vi.fn()).close();
    expect(a.onEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("JobRunner over shared adapters", () => {
  it("registers exactly one onEvidence listener per adapter after 3 sequential runs", async () => {
    const machineListeners: Array<(e: EmittedEvidence) => void> = [];
    const sensorListeners: Array<(e: EmittedEvidence) => void> = [];
    const cameraListeners: Array<(e: EmittedEvidence) => void> = [];
    const emitTo = (listeners: Array<(e: EmittedEvidence) => void>, e: EmittedEvidence) => {
      for (const listener of [...listeners]) listener(e);
    };
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
      dispose: async () => {},
    };
    const camera: CameraAdapter = {
      id: "camera-3runs",
      source: { deviceId: "camera-3runs", deviceType: "camera", kernelId: KERNEL_ID },
      captureSnapshot: async () => ({ imageHash: "sha256:none", storageRef: "none" }),
      runInspection: async () => {
        emitTo(cameraListeners, evidence("cv_inspection_result", "camera-3runs"));
        return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
      },
      onEvidence: vi.fn((cb) => void cameraListeners.push(cb)),
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
  });
});

describe("quiesce, the handoff guard and the device lock (#502 round 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // The injected evidence clock reads the fake Date, so quiet periods run on the fake clock.
    setEvidenceClock(() => Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** session.quiesce(), plus its result once it has one. */
  function quiescing(session: ReturnType<typeof mustOpen>, quietMs: number, timeoutMs: number): { readonly result: boolean | undefined } {
    const tracked: { result: boolean | undefined } = { result: undefined };
    void session.quiesce(quietMs, timeoutMs).then((result) => {
      tracked.result = result;
    });
    return tracked;
  }

  it("quiesce resolves true once every device has been quiet for quietMs, and still delivers what arrives meanwhile", async () => {
    const a = fakeAdapter("adapter-a");
    const b = fakeAdapter("adapter-b");
    const deliver = vi.fn();
    const session = mustOpen([a, b], owner("job-1"), deliver);
    a.emit(evidence("execution_started", "adapter-a")); // t = 0

    const quiet = quiescing(session, 1_000, 10_000);
    await vi.advanceTimersByTimeAsync(600);
    b.emit(evidence("execution_progress", "adapter-b")); // t = 600: b's device is quiet from t = 1600
    await vi.advanceTimersByTimeAsync(999);
    expect(quiet.result, "at t = 1599").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(quiet.result, "at t = 1600").toBe(true);
    expect(deliver.mock.calls.map(([e]) => e.type)).toEqual(["execution_started", "execution_progress"]);
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("quiesce waits until every device is quiet at the same moment", async () => {
    const a = fakeAdapter("adapter-a");
    const b = fakeAdapter("adapter-b");
    const session = mustOpen([a, b], owner("job-1"), vi.fn());
    a.emit(evidence("execution_started", "adapter-a")); // t = 0: a quiet from 1000
    b.emit(evidence("execution_started", "adapter-b")); // t = 0

    const quiet = quiescing(session, 1_000, 10_000);
    await vi.advanceTimersByTimeAsync(900);
    b.emit(evidence("execution_progress", "adapter-b")); // t = 900: b quiet from 1900
    await vi.advanceTimersByTimeAsync(600);
    a.emit(evidence("execution_progress", "adapter-a")); // t = 1500, after a was quiet: a quiet from 2500
    await vi.advanceTimersByTimeAsync(999);
    expect(quiet.result, "at t = 2499").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.result, "at t = 2500").toBe(true);
  });

  it("quiesce resolves false at timeoutMs for a device that never goes quiet, and leaves no timer", async () => {
    const a = fakeAdapter("adapter-a");
    const session = mustOpen([a], owner("job-1"), vi.fn());
    a.emit(evidence("execution_started", "adapter-a")); // t = 0 (a device that never emitted is quiet at once)
    const noise = setInterval(() => a.emit(evidence("execution_progress", "adapter-a")), 100);

    const quiet = quiescing(session, 1_000, 3_000);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(quiet.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.result).toBe(false);
    clearInterval(noise);
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("quiesce awaits quiesceEvidence instead of a quiet period, for an adapter that has one", async () => {
    let finish!: () => void;
    const a = Object.assign(fakeAdapter("adapter-a"), {
      quiesceEvidence: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const session = mustOpen([a], owner("job-1"), vi.fn());

    const quiet = quiescing(session, 1_000, 10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(quiet.result, "before quiesceEvidence resolves").toBeUndefined();
    a.emit(evidence("execution_completed", "adapter-a"));
    finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(quiet.result, "as soon as it resolves, with no quiet period after its last event").toBe(true);
    expect(a.quiesceEvidence).toHaveBeenCalledTimes(1);
  });

  it("quiesce rejects with the error of a quiesceEvidence that rejects", async () => {
    const a = Object.assign(fakeAdapter("adapter-a"), { quiesceEvidence: () => Promise.reject(new Error("camera offline")) });
    const session = mustOpen([a], owner("job-1"), vi.fn());
    await expect(session.quiesce(1_000, 10_000)).rejects.toThrow("camera offline");
    expect(vi.getTimerCount(), "timers left pending").toBe(0);
  });

  it("after close, an event is dropped and restarts its device's quiet clock: another adapter object on that device is refused, quiescing, until quiet", async () => {
    const a = fakeAdapter("adapter-a");
    const sameDevice = fakeAdapter("adapter-a2", a.source.deviceId);
    const session = mustOpen([a], owner("job-1"), vi.fn(), { quietMs: 300 });
    a.emit(evidence("execution_started", "adapter-a")); // t = 0, delivered
    await vi.advanceTimersByTimeAsync(5_000);
    session.close(); // its device has been quiet for 5 s
    a.emit(evidence("execution_completed", "adapter-a")); // t = 5000, dropped
    expect(warn).toHaveBeenCalledWith("[evidence-session] dropped a execution_completed event from adapter adapter-a: no job is recording it");

    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn())).toEqual({ ok: false, busy: { reason: "quiescing", adapterId: "adapter-a2", jobId: "job-1" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn()).ok, "299 ms after the dropped event").toBe(false);
    expect(sameDevice.onEvidence, "listeners registered by a refused session").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(openEvidenceSession([sameDevice], owner("job-2"), vi.fn()).ok, "300 ms after it: the closed session's quiet period").toBe(true);
  });

  it("a device already quiet for the quiet period is free as soon as its session closes", () => {
    const a = fakeAdapter("adapter-a");
    const session = mustOpen([a], owner("job-1"), vi.fn(), { quietMs: 300 });
    a.emit(evidence("execution_started", "adapter-a"));
    vi.setSystemTime(Date.now() + 300);
    session.close();
    expect(openEvidenceSession([a], owner("job-2"), vi.fn()).ok).toBe(true);
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

describe("an adapter passed twice (#502 round 3)", () => {
  it("is asked to quiesce once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const a = Object.assign(fakeAdapter("adapter-a"), { quiesceEvidence: vi.fn(async () => {}) });
      const session = mustOpen([a, a], owner("job-1"), vi.fn());
      expect(await session.quiesce(1_000, 10_000)).toBe(true);
      expect(a.quiesceEvidence).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
