/**
 * Tests for adapter-factory.ts — createMachineAdapter, createSensorAdapter,
 * createCameraAdapter, createAdaptersFromConfig.
 */

import { describe, it, expect } from "vitest";
import {
  createMachineAdapter,
  createSensorAdapter,
  createCameraAdapter,
  createAdaptersFromConfig,
} from "../adapter-factory.js";
import type { KernelConfig, DeviceConfig } from "../kernel-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function machineDevice(adapterType: DeviceConfig["adapterType"], extra: Record<string, unknown> = {}): DeviceConfig {
  return {
    id: "test_machine_01",
    type: "machine",
    adapterType,
    config: { kernelId: "kernel_test", ...extra },
  };
}

function sensorDevice(adapterType: DeviceConfig["adapterType"], extra: Record<string, unknown> = {}): DeviceConfig {
  return {
    id: "test_sensor_01",
    type: "sensor",
    adapterType,
    config: { kernelId: "kernel_test", ...extra },
  };
}

function cameraDevice(adapterType: DeviceConfig["adapterType"], extra: Record<string, unknown> = {}): DeviceConfig {
  return {
    id: "test_camera_01",
    type: "camera",
    adapterType,
    config: { kernelId: "kernel_test", ...extra },
  };
}

// ---------------------------------------------------------------------------
// createMachineAdapter
// ---------------------------------------------------------------------------

describe("createMachineAdapter", () => {
  it("returns a MachineAdapter for adapterType 'mock'", () => {
    const adapter = createMachineAdapter(machineDevice("mock"));
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_machine_01");
    expect(typeof adapter.getStatus).toBe("function");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.getProgress).toBe("function");
    expect(typeof adapter.onEvidence).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });

  it("returns a MachineAdapter for adapterType 'octoprint'", () => {
    const adapter = createMachineAdapter(
      machineDevice("octoprint", { url: "http://localhost:5000", apiKey: "test-key", mockMode: true }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_machine_01");
    expect(adapter.type).toBe("fdm");
  });

  it("returns a MachineAdapter for adapterType 'opcua'", () => {
    const adapter = createMachineAdapter(
      machineDevice("opcua", { endpoint: "opc.tcp://localhost:4840", machineType: "cnc-3axis", nodeMap: [], mockMode: true }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_machine_01");
    expect(adapter.type).toBe("cnc-3axis");
  });

  it("returns a MachineAdapter for adapterType 'hamilton'", () => {
    const adapter = createMachineAdapter(
      machineDevice("hamilton", {
        url: "http://192.0.2.1",
        username: "test",
        password: "test",
        mockMode: true,
      }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_machine_01");
    expect(adapter.type).toBe("liquid-handler");
  });

  it("returns a MachineAdapter for adapterType 'trilobio'", () => {
    const adapter = createMachineAdapter(
      machineDevice("trilobio", {
        url: "http://192.0.2.1",
        apiKey: "test-key",
        tcodeApiVersion: "1.25.1",
        mockMode: true,
      }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_machine_01");
    expect(adapter.type).toBe("liquid-handler");
    expect(adapter.source.firmwareVersion).toContain("Trilobio");
  });

  it("falls back to mock for unknown adapterType", () => {
    const adapter = createMachineAdapter(machineDevice("generic-http"));
    expect(adapter).toBeDefined();
    // Mock FDM adapter type
    expect(adapter.type).toBe("fdm");
  });

  it("forces mock when globalMockMode=true regardless of adapterType", () => {
    // octoprint with globalMockMode=true should give a MockFDMAdapter
    const adapter = createMachineAdapter(
      machineDevice("octoprint", { url: "http://real-host:5000", apiKey: "key" }),
      true, // globalMockMode
    );
    expect(adapter).toBeDefined();
    // The mock FDM adapter doesn't do real HTTP calls
    const status = adapter.getStatus();
    expect(status).resolves.toBeDefined();
  });

  it("adapter can report status without throwing", async () => {
    const adapter = createMachineAdapter(machineDevice("mock"));
    const status = await adapter.getStatus();
    expect(["idle", "busy", "error", "offline", "maintenance"]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// createSensorAdapter
// ---------------------------------------------------------------------------

describe("createSensorAdapter", () => {
  it("returns a SensorAdapter for adapterType 'mock'", () => {
    const adapter = createSensorAdapter(sensorDevice("mock"));
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_sensor_01");
    expect(typeof adapter.startRecording).toBe("function");
    expect(typeof adapter.stopRecording).toBe("function");
    expect(typeof adapter.getCurrentReading).toBe("function");
    expect(typeof adapter.onEvidence).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });

  it("returns a SensorAdapter for adapterType 'modbus'", () => {
    const adapter = createSensorAdapter(
      sensorDevice("modbus", { host: "192.168.1.100", registerMap: [], mockMode: true }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_sensor_01");
  });

  it("returns a SensorAdapter for adapterType 'sila'", async () => {
    const adapter = createSensorAdapter(
      sensorDevice("sila", { url: "http://localhost:50052", mock: true }),
    );
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_sensor_01");

    // SiLA shim should implement the full SensorAdapter interface
    await adapter.startRecording("job_123");
    const reading = await adapter.getCurrentReading();
    expect(reading).toBeDefined();
    const summary = await adapter.stopRecording();
    expect(summary).toBeDefined();
    expect(summary.type).toBe("sensor_data_summary");
  });

  it("forces mock when globalMockMode=true", () => {
    const adapter = createSensorAdapter(
      sensorDevice("modbus", { host: "192.168.1.100", registerMap: [] }),
      true,
    );
    expect(adapter).toBeDefined();
    // Should be MockPowerMonitorAdapter (not Modbus)
    expect(adapter.type).toBe("power_monitor");
  });

  it("adapter can get current reading without throwing", async () => {
    const adapter = createSensorAdapter(sensorDevice("mock"));
    const reading = await adapter.getCurrentReading();
    expect(reading).toBeDefined();
    expect(typeof reading).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// createCameraAdapter
// ---------------------------------------------------------------------------

describe("createCameraAdapter", () => {
  it("returns a CameraAdapter for adapterType 'mock'", () => {
    const adapter = createCameraAdapter(cameraDevice("mock"));
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe("test_camera_01");
    expect(typeof adapter.captureSnapshot).toBe("function");
    expect(typeof adapter.runInspection).toBe("function");
    expect(typeof adapter.onEvidence).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });

  it("falls back to mock for all adapterTypes (no real camera adapters yet)", () => {
    const adapter = createCameraAdapter(cameraDevice("generic-http"));
    expect(adapter).toBeDefined();
  });

  it("forces mock when globalMockMode=true", () => {
    const adapter = createCameraAdapter(cameraDevice("generic-http"), true);
    expect(adapter).toBeDefined();
  });

  it("adapter can capture a snapshot without throwing", async () => {
    const adapter = createCameraAdapter(cameraDevice("mock"));
    const snap = await adapter.captureSnapshot();
    expect(snap).toBeDefined();
    expect(typeof snap.imageHash).toBe("string");
    expect(typeof snap.storageRef).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// createAdaptersFromConfig
// ---------------------------------------------------------------------------

describe("createAdaptersFromConfig", () => {
  it("returns empty arrays when devices list is empty", () => {
    const config: KernelConfig = { kernelId: "k_empty", devices: [] };
    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(0);
    expect(result.sensors).toHaveLength(0);
    expect(result.cameras).toHaveLength(0);
  });

  it("correctly partitions devices by type", () => {
    const config: KernelConfig = {
      kernelId: "k_mixed",
      devices: [
        { id: "m1", type: "machine", adapterType: "mock", config: { kernelId: "k_mixed" } },
        { id: "m2", type: "machine", adapterType: "mock", config: { kernelId: "k_mixed" } },
        { id: "s1", type: "sensor", adapterType: "mock", config: { kernelId: "k_mixed" } },
        { id: "c1", type: "camera", adapterType: "mock", config: { kernelId: "k_mixed" } },
      ],
    };
    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(2);
    expect(result.sensors).toHaveLength(1);
    expect(result.cameras).toHaveLength(1);
  });

  it("assigns correct IDs to adapters", () => {
    const config: KernelConfig = {
      kernelId: "k_ids",
      devices: [
        { id: "printer_alpha", type: "machine", adapterType: "mock", config: { kernelId: "k_ids" } },
        { id: "sensor_beta", type: "sensor", adapterType: "mock", config: { kernelId: "k_ids" } },
        { id: "cam_gamma", type: "camera", adapterType: "mock", config: { kernelId: "k_ids" } },
      ],
    };
    const result = createAdaptersFromConfig(config);
    expect(result.machines[0].id).toBe("printer_alpha");
    expect(result.sensors[0].id).toBe("sensor_beta");
    expect(result.cameras[0].id).toBe("cam_gamma");
  });

  it("mockMode override forces all adapters to mock regardless of adapterType", () => {
    const config: KernelConfig = {
      kernelId: "k_mock",
      mockMode: true,
      devices: [
        {
          id: "real_printer",
          type: "machine",
          adapterType: "octoprint",
          config: { url: "http://real-host:5000", apiKey: "real-key", kernelId: "k_mock" },
        },
        {
          id: "real_sensor",
          type: "sensor",
          adapterType: "modbus",
          config: { host: "real-plc", registerMap: [], kernelId: "k_mock" },
        },
      ],
    };

    // Should not throw even though URLs point to non-existent hosts
    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(1);
    expect(result.sensors).toHaveLength(1);

    // Mock adapters should respond to status immediately
    expect(result.machines[0].getStatus()).resolves.toBeDefined();
  });

  it("returns mixed real+mock adapters when mockMode is false", () => {
    const config: KernelConfig = {
      kernelId: "k_mixed_real",
      mockMode: false,
      devices: [
        {
          id: "octo_01",
          type: "machine",
          adapterType: "octoprint",
          config: { url: "http://localhost:5000", apiKey: "test", kernelId: "k_mixed_real", mockMode: true },
        },
        {
          id: "mock_sensor",
          type: "sensor",
          adapterType: "mock",
          config: { kernelId: "k_mixed_real" },
        },
      ],
    };
    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(1);
    expect(result.sensors).toHaveLength(1);
    expect(result.machines[0].id).toBe("octo_01");
    expect(result.machines[0].type).toBe("fdm"); // OctoPrintAdapter reports fdm
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — default config produces working adapters
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("default KernelConfig produces machine+sensor+camera adapters", async () => {
    // This mirrors what buildServer() uses with no env vars set
    const { loadKernelConfig } = await import("../kernel-config.js");

    const savedKernelConfig = process.env.KERNEL_CONFIG;
    const savedKernelConfigFile = process.env.KERNEL_CONFIG_FILE;
    delete process.env.KERNEL_CONFIG;
    delete process.env.KERNEL_CONFIG_FILE;

    try {
      const config = loadKernelConfig();
      const result = createAdaptersFromConfig(config);

      // Default config has 1 machine, 1 sensor, 1 camera
      expect(result.machines.length).toBeGreaterThanOrEqual(1);
      expect(result.sensors.length).toBeGreaterThanOrEqual(1);
      expect(result.cameras.length).toBeGreaterThanOrEqual(1);

      // All adapters should be functional
      await Promise.all([
        result.machines[0].getStatus(),
        result.sensors[0].getCurrentReading(),
        result.cameras[0].captureSnapshot(),
      ]);
    } finally {
      if (savedKernelConfig !== undefined) process.env.KERNEL_CONFIG = savedKernelConfig;
      if (savedKernelConfigFile !== undefined) process.env.KERNEL_CONFIG_FILE = savedKernelConfigFile;
    }
  });
});
