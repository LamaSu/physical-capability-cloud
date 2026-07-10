/**
 * Tests for adapter-factory.ts — createMachineAdapter, createSensorAdapter,
 * createCameraAdapter, createAdaptersFromConfig.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createMachineAdapter,
  createSensorAdapter,
  createCameraAdapter,
  createAdaptersFromConfig,
  registerMachineAdapter,
  registerSensorAdapter,
  registerCameraAdapter,
  unregisterMachineAdapter,
  unregisterSensorAdapter,
  unregisterCameraAdapter,
  listRegisteredMachineAdapters,
  listRegisteredSensorAdapters,
  listRegisteredCameraAdapters,
} from "../adapter-factory.js";
import type {
  MachineAdapterFactory,
  SensorAdapterFactory,
  CameraAdapterFactory,
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

  it("throws for 'generic-http' instead of silently aliasing to mock", () => {
    // generic-http used to hand back a MockFDMAdapter whose fabricated events
    // entered signed evidence bundles. It must now fail loud at creation.
    expect(() => createMachineAdapter(machineDevice("generic-http"))).toThrow(
      /generic-http.*not implemented/i,
    );
  });

  it("still allows generic-http under globalMockMode (explicit simulation)", () => {
    const adapter = createMachineAdapter(machineDevice("generic-http"), true);
    expect(adapter).toBeDefined();
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

  it("throws for 'generic-http' instead of silently aliasing to mock", () => {
    expect(() => createCameraAdapter(cameraDevice("generic-http"))).toThrow(
      /generic-http.*not implemented/i,
    );
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

// ---------------------------------------------------------------------------
// Plugin registry API
// ---------------------------------------------------------------------------

/**
 * Build a minimal MachineAdapter stub for registry tests. Avoids pulling in
 * a real adapter implementation — we only need to verify the registry calls
 * the factory we registered.
 */
function makeMachineStub(id: string): import("../adapters/types.js").MachineAdapter {
  return {
    id,
    type: "fdm" as const,
    source: { deviceId: id, deviceType: "printer", kernelId: "kernel_test" },
    getStatus: async () => "idle" as const,
    execute: async () => ({ success: true }),
    getProgress: async () => 0,
    onEvidence: () => {},
    dispose: async () => {},
  };
}

function makeSensorStub(id: string): import("../adapters/types.js").SensorAdapter {
  return {
    id,
    type: "power_monitor" as const,
    source: { deviceId: id, deviceType: "sensor", kernelId: "kernel_test" },
    startRecording: async () => {},
    stopRecording: async () => ({
      type: "sensor_data_summary" as const,
      timestamp: new Date().toISOString(),
      source: { deviceId: id, deviceType: "sensor", kernelId: "kernel_test" },
      payload: {},
    }),
    getCurrentReading: async () => ({}),
    onEvidence: () => {},
    dispose: async () => {},
  };
}

function makeCameraStub(id: string): import("../adapters/types.js").CameraAdapter {
  return {
    id,
    source: { deviceId: id, deviceType: "camera", kernelId: "kernel_test" },
    captureSnapshot: async () => ({ imageHash: "hash", storageRef: "ref" }),
    runInspection: async () => ({ passed: true, confidence: 1, findings: [], imageHash: "hash" }),
    onEvidence: () => {},
    dispose: async () => {},
  };
}

describe("registerMachineAdapter / unregisterMachineAdapter", () => {
  // Clean up any test registrations between tests so cross-pollution doesn't happen
  const TEST_TYPE = "test_machine_only";
  afterEach(() => {
    unregisterMachineAdapter(TEST_TYPE);
  });

  it("registers a new machine adapter and createMachineAdapter uses it", () => {
    let called = false;
    const factory: MachineAdapterFactory = (device) => {
      called = true;
      return makeMachineStub(device.id);
    };
    registerMachineAdapter(TEST_TYPE, factory);

    const adapter = createMachineAdapter({
      id: "stub_id_42",
      type: "machine",
      adapterType: TEST_TYPE,
      config: { kernelId: "kernel_test" },
    });

    expect(called).toBe(true);
    expect(adapter.id).toBe("stub_id_42");
  });

  it("throws when registering a duplicate adapter type", () => {
    registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id));

    expect(() =>
      registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id)),
    ).toThrow(/already registered/);
  });

  it("error message mentions the offending type and unregister hint", () => {
    registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id));

    expect(() =>
      registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id)),
    ).toThrow(/test_machine_only/);
    expect(() =>
      registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id)),
    ).toThrow(/unregisterMachineAdapter/);
  });

  it("unregisterMachineAdapter allows re-registration", () => {
    registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id));
    unregisterMachineAdapter(TEST_TYPE);

    // Re-register: should NOT throw
    expect(() =>
      registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id)),
    ).not.toThrow();
  });

  it("unregisterMachineAdapter is a no-op when type was never registered", () => {
    expect(() => unregisterMachineAdapter("never_registered_xyz")).not.toThrow();
  });

  it("unregistered adapterType fails loud (no silent mock fallback)", () => {
    // Note: this type was NEVER registered. A typo'd type must produce a
    // config error naming the type — not a mock adapter minting evidence.
    expect(() =>
      createMachineAdapter({
        id: "fallback_id",
        type: "machine",
        adapterType: "never_registered_xyz",
        config: { kernelId: "kernel_test" },
      }),
    ).toThrow(/never_registered_xyz/);
  });

  it("listRegisteredMachineAdapters includes built-ins", () => {
    const list = listRegisteredMachineAdapters();
    expect(list).toContain("mock");
    expect(list).toContain("octoprint");
    expect(list).toContain("opcua");
    expect(list).toContain("ipp");
    expect(list).toContain("opentrons");
    expect(list).toContain("hamilton");
    expect(list).toContain("generic-http");
  });

  it("listRegisteredMachineAdapters returns a sorted list", () => {
    const list = listRegisteredMachineAdapters();
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });

  it("listRegisteredMachineAdapters reflects new registrations", () => {
    const before = listRegisteredMachineAdapters();
    expect(before).not.toContain(TEST_TYPE);

    registerMachineAdapter(TEST_TYPE, (d) => makeMachineStub(d.id));

    const after = listRegisteredMachineAdapters();
    expect(after).toContain(TEST_TYPE);
    expect(after.length).toBe(before.length + 1);
  });

  it("factory receives device, cfg, and kernelId arguments", () => {
    let capturedDevice: DeviceConfig | undefined;
    let capturedCfg: Record<string, unknown> | undefined;
    let capturedKernelId: string | undefined;
    const factory: MachineAdapterFactory = (device, cfg, kernelId) => {
      capturedDevice = device;
      capturedCfg = cfg;
      capturedKernelId = kernelId;
      return makeMachineStub(device.id);
    };
    registerMachineAdapter(TEST_TYPE, factory);

    createMachineAdapter({
      id: "arg_check",
      type: "machine",
      adapterType: TEST_TYPE,
      config: { kernelId: "kernel_alpha", customField: 99 },
    });

    expect(capturedDevice?.id).toBe("arg_check");
    expect(capturedDevice?.adapterType).toBe(TEST_TYPE);
    expect(capturedCfg?.customField).toBe(99);
    expect(capturedKernelId).toBe("kernel_alpha");
  });

  it("kernelId falls back to 'kernel_dev_001' when not set in config", () => {
    let capturedKernelId: string | undefined;
    registerMachineAdapter(TEST_TYPE, (device, _cfg, kernelId) => {
      capturedKernelId = kernelId;
      return makeMachineStub(device.id);
    });

    createMachineAdapter({
      id: "no_kernel",
      type: "machine",
      adapterType: TEST_TYPE,
      config: {},
    });

    expect(capturedKernelId).toBe("kernel_dev_001");
  });
});

describe("registerSensorAdapter / unregisterSensorAdapter", () => {
  const TEST_TYPE = "test_sensor_only";
  afterEach(() => {
    unregisterSensorAdapter(TEST_TYPE);
  });

  it("registers a new sensor adapter and createSensorAdapter uses it", () => {
    let called = false;
    const factory: SensorAdapterFactory = (device) => {
      called = true;
      return makeSensorStub(device.id);
    };
    registerSensorAdapter(TEST_TYPE, factory);

    const adapter = createSensorAdapter({
      id: "sensor_99",
      type: "sensor",
      adapterType: TEST_TYPE,
      config: { kernelId: "kernel_test" },
    });

    expect(called).toBe(true);
    expect(adapter.id).toBe("sensor_99");
  });

  it("throws when registering a duplicate sensor type", () => {
    registerSensorAdapter(TEST_TYPE, (d) => makeSensorStub(d.id));
    expect(() =>
      registerSensorAdapter(TEST_TYPE, (d) => makeSensorStub(d.id)),
    ).toThrow(/already registered/);
  });

  it("unregisterSensorAdapter allows re-registration", () => {
    registerSensorAdapter(TEST_TYPE, (d) => makeSensorStub(d.id));
    unregisterSensorAdapter(TEST_TYPE);
    expect(() =>
      registerSensorAdapter(TEST_TYPE, (d) => makeSensorStub(d.id)),
    ).not.toThrow();
  });

  it("listRegisteredSensorAdapters includes built-ins", () => {
    const list = listRegisteredSensorAdapters();
    expect(list).toContain("mock");
    expect(list).toContain("modbus");
    expect(list).toContain("sila");
    expect(list).toContain("generic-http");
  });

  it("listRegisteredSensorAdapters returns a sorted list", () => {
    const list = listRegisteredSensorAdapters();
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });

  it("unknown sensor adapterType fails loud (no silent mock fallback)", () => {
    expect(() =>
      createSensorAdapter({
        id: "fallback_sensor",
        type: "sensor",
        adapterType: "unknown_sensor_type",
        config: { kernelId: "kernel_test" },
      }),
    ).toThrow(/unknown_sensor_type/);
  });
});

describe("registerCameraAdapter / unregisterCameraAdapter", () => {
  const TEST_TYPE = "test_camera_only";
  afterEach(() => {
    unregisterCameraAdapter(TEST_TYPE);
  });

  it("registers a new camera adapter and createCameraAdapter uses it", () => {
    let called = false;
    const factory: CameraAdapterFactory = (device) => {
      called = true;
      return makeCameraStub(device.id);
    };
    registerCameraAdapter(TEST_TYPE, factory);

    const adapter = createCameraAdapter({
      id: "cam_55",
      type: "camera",
      adapterType: TEST_TYPE,
      config: { kernelId: "kernel_test" },
    });

    expect(called).toBe(true);
    expect(adapter.id).toBe("cam_55");
  });

  it("throws when registering a duplicate camera type", () => {
    registerCameraAdapter(TEST_TYPE, (d) => makeCameraStub(d.id));
    expect(() =>
      registerCameraAdapter(TEST_TYPE, (d) => makeCameraStub(d.id)),
    ).toThrow(/already registered/);
  });

  it("unregisterCameraAdapter allows re-registration", () => {
    registerCameraAdapter(TEST_TYPE, (d) => makeCameraStub(d.id));
    unregisterCameraAdapter(TEST_TYPE);
    expect(() =>
      registerCameraAdapter(TEST_TYPE, (d) => makeCameraStub(d.id)),
    ).not.toThrow();
  });

  it("listRegisteredCameraAdapters includes built-ins", () => {
    const list = listRegisteredCameraAdapters();
    expect(list).toContain("mock");
    expect(list).toContain("generic-http");
  });

  it("listRegisteredCameraAdapters returns a sorted list", () => {
    const list = listRegisteredCameraAdapters();
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Smoke test: end-to-end via createAdaptersFromConfig with registered types
// ---------------------------------------------------------------------------

describe("plugin registry — end-to-end smoke", () => {
  const TEST_TYPE = "smoke_test_machine";
  afterEach(() => {
    unregisterMachineAdapter(TEST_TYPE);
  });

  it("createAdaptersFromConfig picks up newly registered machine types", () => {
    registerMachineAdapter(TEST_TYPE, (device) => makeMachineStub(device.id));

    const config: KernelConfig = {
      kernelId: "kernel_smoke",
      devices: [
        {
          id: "smoke_machine",
          type: "machine",
          adapterType: TEST_TYPE as DeviceConfig["adapterType"],
          config: { kernelId: "kernel_smoke" },
        },
      ],
    };

    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(1);
    expect(result.machines[0].id).toBe("smoke_machine");
  });

  it("mockMode override still wins over a custom-registered adapter", () => {
    let customCalled = false;
    registerMachineAdapter(TEST_TYPE, (device) => {
      customCalled = true;
      return makeMachineStub(device.id);
    });

    const config: KernelConfig = {
      kernelId: "kernel_smoke",
      mockMode: true, // forces mock regardless of declared adapterType
      devices: [
        {
          id: "smoke_machine",
          type: "machine",
          adapterType: TEST_TYPE as DeviceConfig["adapterType"],
          config: { kernelId: "kernel_smoke" },
        },
      ],
    };

    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(1);
    // Should be the mock FDM adapter, NOT the custom one
    expect(customCalled).toBe(false);
    expect(result.machines[0].type).toBe("fdm");
  });

  it("backward-compat: mock adapterType creates a working machine via registry", async () => {
    const config: KernelConfig = {
      kernelId: "kernel_compat",
      devices: [
        {
          id: "compat_machine",
          type: "machine",
          adapterType: "mock",
          config: { kernelId: "kernel_compat", jobDurationMs: 1000 },
        },
      ],
    };

    const result = createAdaptersFromConfig(config);
    expect(result.machines).toHaveLength(1);
    const status = await result.machines[0].getStatus();
    expect(["idle", "busy", "error", "offline", "maintenance"]).toContain(status);
  });
});
