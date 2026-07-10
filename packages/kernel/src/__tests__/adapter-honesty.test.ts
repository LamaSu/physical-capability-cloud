/**
 * Adapter honesty tests — no adapter feeds fabricated data into evidence
 * bundles without an unmistakable machine-readable marker, and no adapter
 * pretends a never-contacted device is healthy.
 *
 * Contract under test (see adapter-fabrication-blast-radius.md):
 *   1. Unknown / generic-http adapterType fails loud (no silent mock fallback).
 *   2. Mock/simulated emitters tag EVERY event: payload.mock === true and
 *      source.simulated === true.
 *   3. sila refuses real mode entirely (no SiLA 2 transport exists) — no
 *      fabricated assay/QC/compliance evidence, no canned capability claims.
 *   4. opcua/modbus read path reports "offline" (never a fabricated "idle")
 *      and fails loud on reads it cannot perform.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

import {
  createMachineAdapter,
  createSensorAdapter,
  createCameraAdapter,
} from "../adapter-factory.js";
import type { DeviceConfig } from "../kernel-config.js";
import { MockFDMAdapter } from "../adapters/mock-fdm.js";
import { MockPowerMonitorAdapter } from "../adapters/mock-power-monitor.js";
import { MockCameraAdapter } from "../adapters/mock-camera.js";
import { OPCUAAdapter } from "../adapters/opcua-adapter.js";
import { ModbusSensorAdapter } from "../adapters/modbus-sensor-adapter.js";
import { SiLAAdapter } from "../adapters/sila/sila-adapter.js";
import { OpentronsMachineAdapter } from "../opentrons/adapter.js";

type EmittedEvent = Omit<EvidenceEvent, "id" | "hash">;

function device(
  type: "machine" | "sensor" | "camera",
  adapterType: string,
  extra: Record<string, unknown> = {},
): DeviceConfig {
  return {
    id: `honesty_${type}_01`,
    type,
    adapterType: adapterType as DeviceConfig["adapterType"],
    config: { kernelId: "kernel_honesty_test", ...extra },
  };
}

function collect(adapter: {
  onEvidence(cb: (e: EmittedEvent) => void): void;
}): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  adapter.onEvidence((e) => events.push(e));
  return events;
}

function expectAllTagged(events: EmittedEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e.payload.mock, `payload.mock missing on ${e.type}`).toBe(true);
    expect(e.source.simulated, `source.simulated missing on ${e.type}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 1. Factory fail-loud (no silent mock fallback)
// ---------------------------------------------------------------------------

describe("adapter-factory fail-loud contract", () => {
  it("unknown machine adapterType throws naming the type and the registered list", () => {
    expect(() => createMachineAdapter(device("machine", "trilobio-typo"))).toThrow(
      /trilobio-typo.*Registered machine adapter types/s,
    );
  });

  it("unknown sensor adapterType throws", () => {
    expect(() => createSensorAdapter(device("sensor", "octoprnt"))).toThrow(/octoprnt/);
  });

  it("unknown camera adapterType throws", () => {
    expect(() => createCameraAdapter(device("camera", "webcam9000"))).toThrow(/webcam9000/);
  });

  it("generic-http throws for all three categories", () => {
    expect(() => createMachineAdapter(device("machine", "generic-http"))).toThrow(
      /generic-http.*not implemented/i,
    );
    expect(() => createSensorAdapter(device("sensor", "generic-http"))).toThrow(
      /generic-http.*not implemented/i,
    );
    expect(() => createCameraAdapter(device("camera", "generic-http"))).toThrow(
      /generic-http.*not implemented/i,
    );
  });

  it("explicit adapterType 'mock' still works (legitimate declared simulation)", () => {
    expect(createMachineAdapter(device("machine", "mock"))).toBeDefined();
    expect(createSensorAdapter(device("sensor", "mock"))).toBeDefined();
    expect(createCameraAdapter(device("camera", "mock"))).toBeDefined();
  });

  it("globalMockMode=true forces mock even for unknown/generic-http types", () => {
    expect(createMachineAdapter(device("machine", "generic-http"), true)).toBeDefined();
    expect(createSensorAdapter(device("sensor", "some-typo"), true)).toBeDefined();
    expect(createCameraAdapter(device("camera", "generic-http"), true)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Mock emitters tag every event
// ---------------------------------------------------------------------------

describe("mock adapters tag every emitted event (payload.mock + source.simulated)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("MockFDMAdapter tags gcode_received / gcode_hash_verified / execution_*", async () => {
    vi.useFakeTimers();
    const fdm = new MockFDMAdapter("fdm_h1", "kernel_h", 1000);
    const events = collect(fdm);

    await fdm.execute({ type: "load_gcode", payload: { gcodeHash: "abc123" } });
    await fdm.execute({ type: "start" });
    await vi.advanceTimersByTimeAsync(1100); // run to completion

    const types = events.map((e) => e.type);
    expect(types).toContain("gcode_received");
    expect(types).toContain("gcode_hash_verified");
    expect(types).toContain("execution_started");
    expect(types).toContain("execution_completed");
    expectAllTagged(events);

    await fdm.dispose();
  });

  it("MockPowerMonitorAdapter tags samples and summary (returned value too)", async () => {
    vi.useFakeTimers();
    const pm = new MockPowerMonitorAdapter("pm_h1", "kernel_h");
    const events = collect(pm);

    await pm.startRecording("job_h1");
    await vi.advanceTimersByTimeAsync(2100); // one power_profile_sample
    const summary = await pm.stopRecording();

    expect(events.map((e) => e.type)).toContain("power_profile_sample");
    expect(events.map((e) => e.type)).toContain("power_profile_summary");
    expectAllTagged(events);
    // The RETURNED summary (not just the emitted copy) is tagged as well.
    expect(summary.payload.mock).toBe(true);
    expect(summary.source.simulated).toBe(true);

    await pm.dispose();
  });

  it("MockCameraAdapter tags camera_snapshot and cv_inspection_result", async () => {
    const cam = new MockCameraAdapter("cam_h1", "kernel_h", 1.0);
    const events = collect(cam);

    await cam.captureSnapshot();
    await cam.runInspection();

    const types = events.map((e) => e.type);
    expect(types).toContain("camera_snapshot");
    expect(types).toContain("cv_inspection_result");
    expectAllTagged(events);

    await cam.dispose();
  });

  it("Opentrons mock mode tags run_started / run_progress / run_completed", async () => {
    vi.useFakeTimers();
    const ot = new OpentronsMachineAdapter("otkernel-h1", {
      url: "http://localhost:31950",
      mockMode: true,
    });
    const events = collect(ot);

    await ot.execute({ type: "load_gcode", payload: { protocolSource: "{}" } });
    await ot.execute({ type: "start" });
    await vi.advanceTimersByTimeAsync(10_500); // progress ticks to completion

    const types = events.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_progress");
    expect(types).toContain("run_completed");
    for (const e of events) {
      expect(e.payload.mock, `payload.mock missing on ${e.type}`).toBe(true);
      expect(e.source.simulated, `source.simulated missing on ${e.type}`).toBe(true);
    }

    await ot.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. sila — refuses real mode, tags mock mode
// ---------------------------------------------------------------------------

describe("SiLAAdapter real mode refuses to fabricate", () => {
  const assay = {
    assayName: "honesty-elisa",
    protocolId: "proto-h1",
    plateFormat: 96 as const,
    sampleCount: 4,
    replicates: 2,
    qcCriteria: { maxCV: 10, minR2: 0.9, minZPrime: 0.4 },
  };

  function realSila(): SiLAAdapter {
    return new SiLAAdapter({
      deviceId: "sila_h_real",
      kernelId: "kernel_h",
      mock: false,
    });
  }

  it("executeAssay rejects and emits NO events", async () => {
    const sila = realSila();
    const events = collect(sila);
    await expect(sila.executeAssay(assay)).rejects.toThrow(/not implemented.*refusing to fabricate/i);
    expect(events).toHaveLength(0);
  });

  it("executeFailingAssay rejects and emits NO events", async () => {
    const sila = realSila();
    const events = collect(sila);
    await expect(sila.executeFailingAssay(assay)).rejects.toThrow(/not implemented/i);
    expect(events).toHaveLength(0);
  });

  it("collectCalibrationEvidence rejects and emits NO events", async () => {
    const sila = realSila();
    const events = collect(sila);
    await expect(sila.collectCalibrationEvidence()).rejects.toThrow(/not implemented/i);
    expect(events).toHaveLength(0);
  });

  it("getStatus and getCapabilities reject (no canned descriptors / compliance claims)", async () => {
    const sila = realSila();
    await expect(sila.getStatus()).rejects.toThrow(/not implemented/i);
    await expect(sila.getCapabilities()).rejects.toThrow(/not implemented/i);
  });
});

describe("SiLAAdapter mock mode is unmistakably tagged", () => {
  const assay = {
    assayName: "honesty-elisa-mock",
    protocolId: "proto-h2",
    plateFormat: 96 as const,
    sampleCount: 2,
    replicates: 1,
    qcCriteria: { maxCV: 100, minR2: 0, minZPrime: -2 },
  };

  it("executeAssay emits only tagged events (incl. per-well instrument_result)", async () => {
    const sila = new SiLAAdapter({ deviceId: "sila_h_mock", kernelId: "kernel_h", mock: true });
    const events = collect(sila);
    const result = await sila.executeAssay(assay);
    expect(result.runId).toBeDefined();
    expect(events.map((e) => e.type)).toContain("instrument_result");
    expectAllTagged(events);
    await sila.dispose();
  });

  it("collectCalibrationEvidence returns and emits tagged calibration_record events", async () => {
    const sila = new SiLAAdapter({ deviceId: "sila_h_mock2", kernelId: "kernel_h", mock: true });
    const emitted = collect(sila);
    const returned = await sila.collectCalibrationEvidence();
    for (const e of returned) {
      expect(e.payload.mock).toBe(true);
      expect(e.source.simulated).toBe(true);
    }
    expectAllTagged(emitted);
    await sila.dispose();
  });

  it("getCapabilities entries carry simulated:true (no bare compliance claims)", async () => {
    const sila = new SiLAAdapter({ deviceId: "sila_h_mock3", kernelId: "kernel_h", mock: true });
    const caps = await sila.getCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(cap.simulated).toBe(true);
    }
    await sila.dispose();
  });
});

describe("sila factory shim honors mockMode and refuses real mode", () => {
  it("mockMode:false (previously silently ignored) selects real mode -> startRecording rejects", async () => {
    const shim = createSensorAdapter(device("sensor", "sila", { mockMode: false }));
    await expect(shim.startRecording("job_h")).rejects.toThrow(/no SiLA 2 transport/i);
    await expect(shim.stopRecording()).rejects.toThrow(/no SiLA 2 transport/i);
  });

  it("mock:false behaves identically", async () => {
    const shim = createSensorAdapter(device("sensor", "sila", { mock: false }));
    await expect(shim.startRecording("job_h")).rejects.toThrow(/no SiLA 2 transport/i);
  });

  it("mock mode works and tags its summary", async () => {
    const shim = createSensorAdapter(device("sensor", "sila", { mock: true }));
    await shim.startRecording("job_h");
    const summary = await shim.stopRecording();
    expect(summary.type).toBe("sensor_data_summary");
    expect(summary.payload.mock).toBe(true);
    await shim.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. opcua / modbus read-path honesty
// ---------------------------------------------------------------------------

describe("OPCUAAdapter read path (real mode) stops fabricating", () => {
  function realOpcua(): OPCUAAdapter {
    return new OPCUAAdapter("opcua_h1", {
      endpoint: "opc.tcp://192.0.2.10:4840",
      kernelId: "kernel_h",
      machineType: "cnc-3axis",
      nodeMap: [],
      mockMode: false,
    });
  }

  it("getStatus reports 'offline' for a never-contacted machine (never 'idle')", async () => {
    const adapter = realOpcua();
    await expect(adapter.getStatus()).resolves.toBe("offline");
    await adapter.dispose();
  });

  it("getProgress rejects instead of returning a fabricated 0", async () => {
    const adapter = realOpcua();
    await expect(adapter.getProgress()).rejects.toThrow(/not implemented/i);
    await adapter.dispose();
  });

  it("execute(status) returns success:false instead of fabricated zero telemetry", async () => {
    const adapter = realOpcua();
    const result = await adapter.execute({ type: "status" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
    expect(result.data).toBeUndefined();
    await adapter.dispose();
  });

  it("mock mode still reports idle and tags its source", async () => {
    const adapter = new OPCUAAdapter("opcua_h2", {
      endpoint: "opc.tcp://localhost:4840",
      kernelId: "kernel_h",
      machineType: "cnc-3axis",
      nodeMap: [],
      mockMode: true,
    });
    await expect(adapter.getStatus()).resolves.toBe("idle");
    expect(adapter.source.simulated).toBe(true);
    await adapter.dispose();
  });
});

describe("ModbusSensorAdapter (real mode) stops fabricating", () => {
  function realModbus(): ModbusSensorAdapter {
    return new ModbusSensorAdapter("modbus_h1", {
      host: "192.0.2.20",
      kernelId: "kernel_h",
      registerMap: [
        {
          channel: "power",
          label: "Power",
          address: 100,
          registerType: "holding",
          dataType: "float32",
          unit: "W",
        },
      ],
      mockMode: false,
    });
  }

  it("getStatus reports 'offline' (no socket was ever opened)", async () => {
    const adapter = realModbus();
    await expect(adapter.getStatus()).resolves.toBe("offline");
    await adapter.dispose();
  });

  it("stopRecording rejects instead of returning a fabricated empty summary", async () => {
    const adapter = realModbus();
    await expect(adapter.stopRecording()).rejects.toThrow(/refusing to emit a fabricated/i);
    await adapter.dispose();
  });

  it("mock mode summary is tagged and source carries simulated", async () => {
    const adapter = new ModbusSensorAdapter("modbus_h2", {
      host: "localhost",
      kernelId: "kernel_h",
      registerMap: [
        {
          channel: "power",
          label: "Power",
          address: 100,
          registerType: "holding",
          dataType: "float32",
          unit: "W",
        },
      ],
      mockMode: true,
    });
    await adapter.startRecording("job_h");
    const summary = await adapter.stopRecording();
    expect(summary.type).toBe("sensor_data_summary");
    expect(summary.payload.mock).toBe(true);
    expect(adapter.source.simulated).toBe(true);
    await adapter.dispose();
  });
});
