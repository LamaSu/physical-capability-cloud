/**
 * Adapter factory.
 *
 * Instantiates the correct adapter class based on a DeviceConfig.
 * When KernelConfig.mockMode is true, all devices fall back to mock adapters
 * regardless of their declared adapterType.
 */

import type { MachineAdapter, SensorAdapter, CameraAdapter } from "./adapters/types.js";
import type { KernelConfig, DeviceConfig } from "./kernel-config.js";

// Mock adapters
import { MockFDMAdapter } from "./adapters/mock-fdm.js";
import { MockPowerMonitorAdapter } from "./adapters/mock-power-monitor.js";
import { MockCameraAdapter } from "./adapters/mock-camera.js";

// Real adapters
import { OctoPrintAdapter } from "./adapters/octoprint-adapter.js";
import { ModbusSensorAdapter } from "./adapters/modbus-sensor-adapter.js";
import { OPCUAAdapter } from "./adapters/opcua-adapter.js";
import { SiLAAdapter } from "./adapters/sila/sila-adapter.js";
import { IppAdapter } from "./adapters/ipp-adapter.js";
import { OpentronsMachineAdapter } from "./opentrons/adapter.js";

// ---------------------------------------------------------------------------
// Machine adapters
// ---------------------------------------------------------------------------

/**
 * Create a MachineAdapter from a DeviceConfig.
 *
 * @param device - Device config with adapterType "octoprint" | "opcua" | "mock"
 * @param globalMockMode - If true, force mock mode regardless of adapterType
 */
export function createMachineAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): MachineAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  switch (effectiveType) {
    case "octoprint": {
      return new OctoPrintAdapter(device.id, {
        url: (cfg.url as string | undefined) ?? "http://localhost:5000",
        apiKey: (cfg.apiKey as string | undefined) ?? "",
        kernelId,
        pollIntervalMs: cfg.pollIntervalMs as number | undefined,
        mockMode: (cfg.mockMode as boolean | undefined) ?? false,
      });
    }

    case "opcua": {
      return new OPCUAAdapter(device.id, {
        endpoint: (cfg.endpoint as string | undefined) ?? "opc.tcp://localhost:4840",
        kernelId,
        machineType: (cfg.machineType as "cnc-3axis" | "cnc-5axis" | "lathe" | "laser-cut" | undefined) ?? "cnc-3axis",
        nodeMap: (cfg.nodeMap as import("./adapters/opcua-adapter.js").OPCUANodeDef[] | undefined) ?? [],
        pollIntervalMs: cfg.pollIntervalMs as number | undefined,
        securityMode: cfg.securityMode as "none" | "sign" | "signAndEncrypt" | undefined,
        mockMode: (cfg.mockMode as boolean | undefined) ?? false,
      });
    }

    case "ipp": {
      return new IppAdapter(device.id, {
        uri: (cfg.uri as string | undefined) ?? "ipp://localhost:631/ipp/print",
        name: cfg.name as string | undefined,
        kernelId,
        pollIntervalMs: cfg.pollIntervalMs as number | undefined,
        mockMode: (cfg.mockMode as boolean | undefined) ?? true,
      });
    }

    case "opentrons": {
      return new OpentronsMachineAdapter(device.id, {
        url: (cfg.url as string | undefined) ?? "http://localhost:31950",
        apiVersion: (cfg.apiVersion as string | undefined) ?? "2.18",
        pollIntervalMs: cfg.pollIntervalMs as number | undefined,
        mockMode: (cfg.mockMode as boolean | undefined) ?? false,
        maxQueueDepth: cfg.maxQueueDepth as number | undefined,
      });
    }

    case "mock":
    case "generic-http":
    default: {
      return new MockFDMAdapter(
        device.id,
        kernelId,
        (cfg.jobDurationMs as number | undefined) ?? 5000,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sensor adapters
// ---------------------------------------------------------------------------

/**
 * Create a SensorAdapter from a DeviceConfig.
 *
 * @param device - Device config with adapterType "modbus" | "mock"
 * @param globalMockMode - If true, force mock mode
 */
export function createSensorAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): SensorAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  switch (effectiveType) {
    case "modbus": {
      return new ModbusSensorAdapter(device.id, {
        host: (cfg.host as string | undefined) ?? "localhost",
        port: cfg.port as number | undefined,
        unitId: cfg.unitId as number | undefined,
        kernelId,
        registerMap: (cfg.registerMap as import("./adapters/modbus-sensor-adapter.js").ModbusRegisterDef[] | undefined) ?? [],
        pollIntervalMs: cfg.pollIntervalMs as number | undefined,
        mockMode: (cfg.mockMode as boolean | undefined) ?? true,
      });
    }

    case "sila": {
      // SiLAAdapter implements a richer interface but satisfies SensorAdapter
      // via startRecording / stopRecording / getCurrentReading / onEvidence / dispose
      return createSiLASensorAdapter(device.id, cfg, kernelId);
    }

    case "mock":
    case "generic-http":
    default: {
      return new MockPowerMonitorAdapter(device.id, kernelId, {
        idleWatts: cfg.idleWatts as number | undefined,
        activeWatts: cfg.activeWatts as number | undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Camera adapters
// ---------------------------------------------------------------------------

/**
 * Create a CameraAdapter from a DeviceConfig.
 *
 * @param device - Device config with adapterType "mock" (only mock cameras exist today)
 * @param globalMockMode - If true, force mock mode
 */
export function createCameraAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): CameraAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  switch (effectiveType) {
    // When real camera adapters are added (e.g. RTSP, OpenCV) add cases here
    case "mock":
    case "generic-http":
    default: {
      return new MockCameraAdapter(
        device.id,
        kernelId,
        (cfg.passRate as number | undefined) ?? 0.95,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk factory
// ---------------------------------------------------------------------------

export interface AdapterSet {
  machines: MachineAdapter[];
  sensors: SensorAdapter[];
  cameras: CameraAdapter[];
}

/**
 * Instantiate all adapters declared in a KernelConfig.
 *
 * Devices are partitioned by their `type` field:
 *   - "machine" → MachineAdapter
 *   - "sensor"  → SensorAdapter
 *   - "camera"  → CameraAdapter
 *
 * If KernelConfig.mockMode is true, every adapter is forced into mock mode.
 */
export function createAdaptersFromConfig(kernelConfig: KernelConfig): AdapterSet {
  const globalMock = kernelConfig.mockMode ?? false;
  const machines: MachineAdapter[] = [];
  const sensors: SensorAdapter[] = [];
  const cameras: CameraAdapter[] = [];

  for (const device of kernelConfig.devices) {
    switch (device.type) {
      case "machine":
        machines.push(createMachineAdapter(device, globalMock));
        break;
      case "sensor":
        sensors.push(createSensorAdapter(device, globalMock));
        break;
      case "camera":
        cameras.push(createCameraAdapter(device, globalMock));
        break;
    }
  }

  return { machines, sensors, cameras };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a SiLAAdapter in the SensorAdapter interface.
 * SiLAAdapter doesn't directly implement SensorAdapter (it has a different
 * lifecycle: executeAssay rather than startRecording/stopRecording), so we
 * bridge the gap with a thin shim.
 */
function createSiLASensorAdapter(
  id: string,
  cfg: Record<string, unknown>,
  kernelId: string,
): SensorAdapter {
  const sila = new SiLAAdapter({
    deviceId: id,
    kernelId,
    silaServerUrl: cfg.url as string | undefined,
    mock: (cfg.mock as boolean | undefined) ?? true,
    deviceName: cfg.deviceName as string | undefined,
  });

  let currentJobId: string | null = null;

  return {
    id: sila.id,
    type: "power_monitor" as const, // generic sensor role
    source: sila.source,

    async startRecording(jobId: string): Promise<void> {
      currentJobId = jobId;
    },

    async stopRecording(): Promise<Omit<import("@pcc/spec").EvidenceEvent, "id" | "hash">> {
      return {
        type: "sensor_data_summary",
        timestamp: new Date().toISOString(),
        source: sila.source,
        payload: { jobId: currentJobId, adapter: "sila" },
      };
    },

    async getCurrentReading(): Promise<Record<string, unknown>> {
      const status = await sila.getStatus();
      return { status: status.status, adapter: "sila" };
    },

    onEvidence(
      callback: (event: Omit<import("@pcc/spec").EvidenceEvent, "id" | "hash">) => void,
    ): void {
      sila.onEvidence(callback);
    },

    async dispose(): Promise<void> {
      await sila.dispose();
    },
  };
}
