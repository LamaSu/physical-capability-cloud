import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssuranceTier, EvidenceEvent, SHA256 } from "@pcc/spec";
import type { CameraAdapter, MachineAdapter, SensorAdapter } from "../adapters/types.js";
import type { EvidenceStorageService } from "../evidence-storage.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { openEvidenceSession } from "../evidence-session.js";
import { JobRunner } from "../job-runner.js";
import { knownErrorClassName, observationId } from "../observability.js";

const { startSpan } = vi.hoisted(() => ({
  startSpan: vi.fn((_options: unknown, callback: () => unknown) => callback()),
}));

// Capture the dependency import used by the kernel, independently of gateway telemetry.
vi.mock("@sentry/node", () => ({ startSpan }));

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
const raw = "operator supplied diagnostic / private value";
const jobId = `job / ${raw}`;
const stepId = `step / ${raw}`;
const kernelId = `kernel / ${raw}`;
const digest = (value: string) => `id:${createHash("sha256").update(value).digest("hex")}`;
const config = (tier: AssuranceTier = 2) => ({ jobId, stepId, assuranceTier: tier, gcodeHash: "sha256:test" as SHA256 });
const event: Emitted = {
  type: "execution_completed",
  timestamp: new Date().toISOString(),
  source: { deviceId: "observability-machine", kernelId, deviceType: "controller" },
  payload: {},
};

let sequence = 0;
function fixture() {
  const suffix = ++sequence;
  const machine: MachineAdapter = {
    id: "observability-machine",
    type: "fdm",
    source: { ...event.source, deviceId: `observability-machine-${suffix}` },
    getStatus: vi.fn(async () => "idle" as const),
    getProgress: vi.fn(async () => 100),
    execute: vi.fn(async () => ({ success: true })),
    onEvidence: vi.fn(),
    quiesceEvidence: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const sensor: SensorAdapter = {
    id: `sensor / ${raw}`,
    type: "power_monitor",
    source: { ...event.source, deviceId: `observability-sensor-${suffix}` },
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => event),
    getCurrentReading: vi.fn(async () => ({})),
    onEvidence: vi.fn(),
    quiesceEvidence: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const camera: CameraAdapter = {
    id: "observability-camera",
    source: { ...event.source, deviceId: `observability-camera-${suffix}` },
    captureSnapshot: vi.fn(async () => ({ imageHash: "sha256:test", storageRef: "test" })),
    runInspection: vi.fn(async () => ({ passed: true, confidence: 100, findings: [], imageHash: "sha256:test" })),
    onEvidence: vi.fn(),
    quiesceEvidence: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const emitter = {
    registerStep: vi.fn(),
    addEvent: vi.fn(async () => {}),
    getEvents: vi.fn(() => []),
    checkTierRequirements: vi.fn(() => ({ met: true, missing: [] as string[] })),
    finalizeBundle: vi.fn(async () => ({ id: "bundle-observability", bundleHash: "sha256:test", events: [] })),
    cleanup: vi.fn(),
  };
  const runner = () => new JobRunner(machine, [sensor], camera, emitter as unknown as EvidenceEmitter);
  return { machine, sensor, camera, emitter, runner };
}

beforeEach(() => {
  startSpan.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("JobRunner downstream observability", () => {
  it("hashes every span identifier while execution and evidence retain their identifiers", async () => {
    const { machine, sensor, camera, emitter, runner } = fixture();
    expect((await runner().run(config())).success).toBe(true);
    expect(startSpan.mock.calls.map(([options]) => (options as { name: string }).name)).toEqual([
      "job.run", "job.load_gcode", "job.start_sensors", "job.before_snapshot",
      "job.start_execution", "job.wait_for_completion", "job.stop_sensors",
      "job.cv_inspection", "job.finalize_bundle",
    ]);
    for (const [options] of startSpan.mock.calls) {
      expect(options).toMatchObject({ attributes: { "job.id": digest(jobId) } });
      expect(JSON.stringify(options)).not.toContain(raw);
    }
    expect(startSpan.mock.calls[0][0]).toMatchObject({ attributes: { "job.step_id": digest(stepId), "job.assurance_tier": 2 } });
    expect(startSpan.mock.calls[2][0]).toMatchObject({ attributes: { "sensor.count": 1 } });
    expect(machine.execute).toHaveBeenCalledWith({ type: "load_gcode", payload: { gcodeHash: config().gcodeHash, jobId } });
    expect(machine.execute).toHaveBeenCalledWith({ type: "start", payload: { jobId } });
    expect(sensor.startRecording).toHaveBeenCalledWith(jobId);
    expect(camera.captureSnapshot).toHaveBeenCalledWith({ jobId });
    expect(camera.runInspection).toHaveBeenCalledWith(undefined, { jobId });
    expect(emitter.registerStep).toHaveBeenCalledWith(jobId, stepId, 2);
    expect(emitter.finalizeBundle).toHaveBeenCalledWith(jobId, stepId);
  });

  it("formats runtime-invalid tiers at the span boundary", async () => {
    const { runner } = fixture();
    await runner().run(config(raw as unknown as AssuranceTier));
    expect(startSpan.mock.calls[0][0]).toMatchObject({ attributes: { "job.assurance_tier": -1 } });
    expect(JSON.stringify(startSpan.mock.calls)).not.toContain(raw);
  });

  it("logs an evidence write failure as a fixed code and closed error category", async () => {
    const { machine, emitter, runner } = fixture();
    let emit!: (value: Emitted) => void;
    vi.mocked(machine.onEvidence).mockImplementation((callback) => { emit = callback; });
    vi.mocked(machine.execute).mockImplementation(async () => { emit(event); return { success: true }; });
    emitter.addEvent.mockRejectedValueOnce(new SyntaxError(raw));
    const result = await runner().run(config());
    expect(result.success).toBe(false);
    expect(emitter.addEvent).toHaveBeenCalledWith(jobId, stepId, event);
    expect(console.error).toHaveBeenCalledWith("job_evidence_record_failed", "SyntaxError");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(raw);
  });

  it.each(["throw", "reject"])("sanitizes a cleanup sensor failure (%s)", async (mode) => {
    const { machine, sensor, runner } = fixture();
    vi.mocked(machine.execute).mockImplementation(async (command) => ({ success: command.type !== "start" }));
    vi.mocked(sensor.stopRecording).mockImplementation(() => {
      if (mode === "throw") throw new TypeError(raw);
      return Promise.reject(new TypeError(raw));
    });
    expect((await runner().run(config())).success).toBe(false);
    expect(sensor.stopRecording).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("job_sensor_stop_failed", "TypeError", digest(sensor.id));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(raw);
  });

  it("sanitizes a cleanup evidence handshake failure", async () => {
    const { machine, runner } = fixture();
    vi.mocked(machine.execute).mockResolvedValue({ success: false });
    vi.mocked(machine.quiesceEvidence).mockRejectedValue(new RangeError(raw));
    expect((await runner().run(config())).success).toBe(false);
    expect(machine.quiesceEvidence).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("job_evidence_quiesce_failed", "RangeError", digest(jobId));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(raw);
  });

  it("logs tier warnings with bounded numeric fields without dependency descriptions", async () => {
    const { emitter, runner } = fixture();
    emitter.checkTierRequirements.mockReturnValue({ met: false, missing: [raw] });
    expect((await runner().run(config(1))).success).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("job_tier_requirements_partial", 1, 1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(raw);
  });
});

describe("JobRunner executing dependencies", () => {
  it("hashes archive span identifiers while the archived bundle retains its identifiers", async () => {
    const emitter = new EvidenceEmitter(kernelId);
    const archiveBundle = vi.fn(async () => ({ cid: "archive", metadataCid: "metadata" }));
    emitter.setStorageService({ isReady: () => true, archiveBundle } as unknown as EvidenceStorageService);
    emitter.registerStep(jobId, stepId, 0);
    await emitter.addEvent(jobId, stepId, event);
    const bundle = await emitter.finalizeBundle(jobId, stepId);
    expect(archiveBundle).toHaveBeenCalledWith(bundle);
    expect(bundle).toMatchObject({ jobId, stepId, kernelId });
    expect(startSpan).toHaveBeenCalledWith({
      name: "evidence.ipfs_archive", op: "storage",
      attributes: { "bundle.id": digest(bundle.id), "job.id": digest(jobId), "kernel.id": digest(kernelId) },
    }, expect.any(Function));
    expect(JSON.stringify(startSpan.mock.calls)).not.toContain(raw);
  });

  it("sanitizes dropped-event and unanswered-handshake logs", async () => {
    const { machine } = fixture();
    let emit!: (value: Emitted) => void;
    vi.mocked(machine.onEvidence).mockImplementation((callback) => { emit = callback; });
    vi.mocked(machine.quiesceEvidence).mockRejectedValue(new URIError(raw));
    const opened = openEvidenceSession([machine], { jobId, stepId }, vi.fn());
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("session must open");
    opened.session.close();
    emit({ ...event, type: raw as Emitted["type"] });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("evidence_quiesce_failed", "URIError", digest(machine.id)));
    expect(console.warn).toHaveBeenCalledWith("evidence_event_without_job", digest(machine.id), digest(raw));
    expect(JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls])).not.toContain(raw);
  });

  it("observation helpers expose only digests and fixed error categories", () => {
    expect(observationId("ordinary-job-id")).toBe(digest("ordinary-job-id"));
    expect(observationId({ toString() { throw new Error(raw); } })).toBe("[invalid id]");
    expect(knownErrorClassName(Object.assign(new Error(raw), { name: raw }))).toBe("Error");
    expect(knownErrorClassName({ name: raw, message: raw })).toBe("Error");
  });
});
