/**
 * EvidenceCollector tests — verify event shape conversion + start/stop/fail
 * semantics + camera + sensor hook integration.
 */

import { describe, expect, it, vi } from "vitest";
import { EvidenceCollector, type CameraHook, type SensorHook } from "../evidence.js";
import type { EvidenceSource } from "@pcc/spec";

const SOURCE: EvidenceSource = {
  deviceId: "dev-ot2-test",
  deviceType: "instrument",
  kernelId: "kernel-test",
  firmwareVersion: "PyLabRobotAdapter-test/ot2",
};

describe("EvidenceCollector", () => {
  it("emits execution_started on startRecording", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("execution_started");
    expect((events[0] as { payload: { jobId: string } }).payload.jobId).toBe("job-1");
  });

  it("emits execution_completed with op count + duration on stopRecording", async () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");
    collector.ingestSidecarNotification({
      type: "aspirate",
      deviceId: "dev-ot2-test",
      jobId: "job-1",
      timestamp: "2026-05-25T00:00:01Z",
      payload: { volume_uL: 100 },
    });
    collector.ingestSidecarNotification({
      type: "dispense",
      deviceId: "dev-ot2-test",
      jobId: "job-1",
      timestamp: "2026-05-25T00:00:02Z",
      payload: { volume_uL: 100 },
    });
    const buffered = collector.stopRecording("job-1");

    expect(events.length).toBeGreaterThanOrEqual(4); // start + 2 ops + complete
    const completed = events.find(
      (e) => (e as { type: string }).type === "execution_completed",
    ) as { payload: Record<string, unknown> } | undefined;
    expect(completed).toBeDefined();
    expect(completed!.payload.jobId).toBe("job-1");
    expect(completed!.payload.opCount).toBe(2);
    expect(buffered.length).toBe(events.length);
  });

  it("maps unknown sidecar event types to instrument_result", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");
    collector.ingestSidecarNotification({
      type: "some-vendor-specific-event",
      deviceId: "dev-ot2-test",
      jobId: "job-1",
      timestamp: "2026-05-25T00:00:01Z",
      payload: { foo: "bar" },
    });

    const ev = events[1] as { type: string; payload: Record<string, unknown> };
    expect(ev.type).toBe("instrument_result");
    expect(ev.payload.sidecarType).toBe("some-vendor-specific-event");
    expect(ev.payload.foo).toBe("bar");
  });

  it("maps known PLR action types to instrument_result", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");
    for (const action of ["aspirate", "dispense", "pickUpTips", "dropTips", "mix"]) {
      collector.ingestSidecarNotification({
        type: action,
        deviceId: "dev-ot2-test",
        jobId: "job-1",
        timestamp: "2026-05-25T00:00:01Z",
        payload: {},
      });
    }
    const actionEvents = events.slice(1, 6) as Array<{ type: string }>;
    expect(actionEvents.every((e) => e.type === "instrument_result")).toBe(true);
  });

  it("maps log → process_log_summary", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");
    collector.ingestSidecarNotification({
      type: "log",
      deviceId: "d",
      jobId: "job-1",
      timestamp: "t",
      payload: { line: "PLR INFO: setup complete" },
    });
    expect((events[1] as { type: string }).type).toBe("process_log_summary");
  });

  it("failRecording emits execution_failed with reason + opCount", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    collector.startRecording("job-1");
    collector.ingestSidecarNotification({
      type: "aspirate",
      deviceId: "d",
      jobId: "job-1",
      timestamp: "t",
      payload: {},
    });
    collector.failRecording("job-1", "USB disconnect", { code: -32001 });

    const failed = events.find((e) => (e as { type: string }).type === "execution_failed") as {
      payload: Record<string, unknown>;
    };
    expect(failed).toBeDefined();
    expect(failed.payload.reason).toBe("USB disconnect");
    expect(failed.payload.opCount).toBe(1);
    expect(failed.payload.code).toBe(-32001);
  });

  it("snapshot() captures via the camera hook + emits camera_snapshot", async () => {
    const camera: CameraHook = {
      captureSnapshot: vi.fn().mockResolvedValue({
        imageHash: "sha256:cafef00d",
        storageRef: "ipfs://bafy123",
      }),
    };
    const collector = new EvidenceCollector({ source: SOURCE, camera });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    await collector.snapshot("pre-aspirate");
    expect(camera.captureSnapshot).toHaveBeenCalledOnce();
    expect((events[0] as { type: string }).type).toBe("camera_snapshot");
    expect((events[0] as { payload: Record<string, unknown> }).payload.imageHash).toBe("sha256:cafef00d");
  });

  it("sampleSensors() reads every configured sensor + emits temperature_log per", async () => {
    const sensor1: SensorHook = {
      getCurrentReading: vi.fn().mockResolvedValue({ value: 36.5, unit: "C" }),
      channel: "chamber-temp",
    };
    const sensor2: SensorHook = {
      getCurrentReading: vi.fn().mockResolvedValue({ rpm: 1200 }),
      channel: "shaker-rpm",
    };
    const collector = new EvidenceCollector({
      source: SOURCE,
      sensors: [sensor1, sensor2],
    });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    await collector.sampleSensors("step-1");
    expect(events.length).toBe(2);
    expect((events[0] as { type: string }).type).toBe("temperature_log");
    expect((events[0] as { payload: { channel: string } }).payload.channel).toBe("chamber-temp");
  });

  it("listener errors do not break ingestion", () => {
    const collector = new EvidenceCollector({ source: SOURCE });
    collector.onEvidence(() => {
      throw new Error("boom");
    });
    expect(() => collector.startRecording("job-1")).not.toThrow();
  });

  it("camera hook failure becomes a process_log_summary warning", async () => {
    const camera: CameraHook = {
      captureSnapshot: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
    };
    const collector = new EvidenceCollector({ source: SOURCE, camera });
    const events: Array<unknown> = [];
    collector.onEvidence((e) => events.push(e));
    await collector.snapshot("step");
    expect((events[0] as { type: string }).type).toBe("process_log_summary");
    expect((events[0] as { payload: { warning: string } }).payload.warning).toBe("camera snapshot failed");
  });
});
