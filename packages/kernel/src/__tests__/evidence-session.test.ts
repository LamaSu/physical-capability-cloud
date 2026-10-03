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
