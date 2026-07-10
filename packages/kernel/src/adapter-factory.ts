/**
 * Adapter factory (plugin registry).
 *
 * Instantiates the correct adapter class based on a DeviceConfig. Adapters
 * are registered at module load time and can also be registered dynamically
 * by external packages (bridges, plugins).
 *
 * When KernelConfig.mockMode is true, all devices fall back to mock adapters
 * regardless of their declared adapterType.
 *
 * # Registry model
 *
 * There are three independent registries — one per adapter category
 * (machine / sensor / camera) — because each category has a distinct
 * interface and constructor signature.
 *
 * Each registry maps `adapterType` (string) -> factory function. The
 * factory function receives `(device, cfg, kernelId)` and returns an
 * adapter instance. This is more flexible than registering raw
 * constructors because every adapter pulls a different shape out of
 * `cfg` (URLs, API keys, register maps, etc.).
 *
 * # Backward compatibility
 *
 * All existing adapterType strings (`octoprint`, `opcua`, `ipp`,
 * `opentrons`, `hamilton`, `modbus`, `sila`, `mock`, `generic-http`) keep
 * working transparently — they are pre-registered in this file at module
 * load.
 *
 * # Adding a new adapter from another package
 *
 * ```ts
 * import { registerMachineAdapter } from "@pcc/kernel";
 * import { MyAdapter } from "./my-adapter.js";
 *
 * registerMachineAdapter("my-type", (device, cfg, kernelId) =>
 *   new MyAdapter(device.id, { ...cfg, kernelId }),
 * );
 * ```
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
import { HamiltonAdapter } from "./adapters/hamilton-adapter.js";

// ---------------------------------------------------------------------------
// Factory function types
// ---------------------------------------------------------------------------

/**
 * A factory function that builds a MachineAdapter from a DeviceConfig.
 *
 * @param device   - The full DeviceConfig (id, type, adapterType, config)
 * @param cfg      - Shortcut for `device.config` (the adapter-specific config blob)
 * @param kernelId - Resolved kernel ID (falls back to "kernel_dev_001")
 */
export type MachineAdapterFactory = (
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
) => MachineAdapter;

export type SensorAdapterFactory = (
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
) => SensorAdapter;

export type CameraAdapterFactory = (
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
) => CameraAdapter;

// ---------------------------------------------------------------------------
// Registries (one per category)
// ---------------------------------------------------------------------------

const machineRegistry = new Map<string, MachineAdapterFactory>();
const sensorRegistry = new Map<string, SensorAdapterFactory>();
const cameraRegistry = new Map<string, CameraAdapterFactory>();

/**
 * Error for an adapterType that has no registered factory.
 *
 * Historically this case silently fell back to the mock adapter, which lets a
 * typo'd device config mint fabricated-but-signed evidence bundles. Registration
 * of an unknown type is a configuration error and is reported as one.
 */
function unknownAdapterTypeError(
  category: "machine" | "sensor" | "camera",
  adapterType: string,
  deviceId: string,
  registered: string[],
): Error {
  return new Error(
    `[adapter-factory] Unknown ${category} adapterType "${adapterType}" for device "${deviceId}" — ` +
      `refusing to fall back to a mock adapter (a silent mock emits fabricated evidence for a device ` +
      `the operator believes is real). Registered ${category} adapter types: ${registered.join(", ")}. ` +
      `Use adapterType: "mock" (or KernelConfig.mockMode: true) for explicit, tagged simulation.`,
  );
}

// ---------------------------------------------------------------------------
// Public registration API
// ---------------------------------------------------------------------------

/**
 * Register a machine-adapter factory under `adapterType`.
 * Throws if `adapterType` is already registered — call
 * `unregisterMachineAdapter` first if you want to replace an existing
 * registration.
 */
export function registerMachineAdapter(
  adapterType: string,
  factory: MachineAdapterFactory,
): void {
  if (machineRegistry.has(adapterType)) {
    throw new Error(
      `Machine adapter "${adapterType}" is already registered. ` +
        `Call unregisterMachineAdapter("${adapterType}") first if you want to replace it.`,
    );
  }
  machineRegistry.set(adapterType, factory);
}

export function registerSensorAdapter(
  adapterType: string,
  factory: SensorAdapterFactory,
): void {
  if (sensorRegistry.has(adapterType)) {
    throw new Error(
      `Sensor adapter "${adapterType}" is already registered. ` +
        `Call unregisterSensorAdapter("${adapterType}") first if you want to replace it.`,
    );
  }
  sensorRegistry.set(adapterType, factory);
}

export function registerCameraAdapter(
  adapterType: string,
  factory: CameraAdapterFactory,
): void {
  if (cameraRegistry.has(adapterType)) {
    throw new Error(
      `Camera adapter "${adapterType}" is already registered. ` +
        `Call unregisterCameraAdapter("${adapterType}") first if you want to replace it.`,
    );
  }
  cameraRegistry.set(adapterType, factory);
}

/** Remove a machine-adapter factory. No-op if not registered. */
export function unregisterMachineAdapter(adapterType: string): void {
  machineRegistry.delete(adapterType);
}

export function unregisterSensorAdapter(adapterType: string): void {
  sensorRegistry.delete(adapterType);
}

export function unregisterCameraAdapter(adapterType: string): void {
  cameraRegistry.delete(adapterType);
}

/** Return the sorted list of registered machine-adapter types. */
export function listRegisteredMachineAdapters(): string[] {
  return [...machineRegistry.keys()].sort();
}

export function listRegisteredSensorAdapters(): string[] {
  return [...sensorRegistry.keys()].sort();
}

export function listRegisteredCameraAdapters(): string[] {
  return [...cameraRegistry.keys()].sort();
}

// ---------------------------------------------------------------------------
// Machine adapters
// ---------------------------------------------------------------------------

/**
 * Create a MachineAdapter from a DeviceConfig.
 *
 * @param device         - Device config with a registered adapterType
 * @param globalMockMode - If true, force mock mode regardless of adapterType
 */
export function createMachineAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): MachineAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  const factory = machineRegistry.get(effectiveType);
  if (factory) {
    return factory(device, cfg, kernelId);
  }

  // FAIL LOUD: an unknown (typo'd / unregistered) adapterType must never
  // silently become a mock adapter. The mock emits fabricated evidence that
  // enters SIGNED evidence bundles while the operator believes a real device
  // is wired. Explicit simulation stays available via adapterType: "mock" or
  // KernelConfig.mockMode: true.
  throw unknownAdapterTypeError("machine", effectiveType, device.id, listRegisteredMachineAdapters());
}

// ---------------------------------------------------------------------------
// Sensor adapters
// ---------------------------------------------------------------------------

/**
 * Create a SensorAdapter from a DeviceConfig.
 *
 * @param device         - Device config with a registered adapterType
 * @param globalMockMode - If true, force mock mode
 */
export function createSensorAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): SensorAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  const factory = sensorRegistry.get(effectiveType);
  if (factory) {
    return factory(device, cfg, kernelId);
  }

  // FAIL LOUD — see createMachineAdapter for rationale.
  throw unknownAdapterTypeError("sensor", effectiveType, device.id, listRegisteredSensorAdapters());
}

// ---------------------------------------------------------------------------
// Camera adapters
// ---------------------------------------------------------------------------

/**
 * Create a CameraAdapter from a DeviceConfig.
 *
 * @param device         - Device config with a registered adapterType
 * @param globalMockMode - If true, force mock mode
 */
export function createCameraAdapter(
  device: DeviceConfig,
  globalMockMode = false,
): CameraAdapter {
  const effectiveType = globalMockMode ? "mock" : device.adapterType;
  const cfg = device.config;
  const kernelId = (cfg.kernelId as string | undefined) ?? "kernel_dev_001";

  const factory = cameraRegistry.get(effectiveType);
  if (factory) {
    return factory(device, cfg, kernelId);
  }

  // FAIL LOUD — see createMachineAdapter for rationale.
  throw unknownAdapterTypeError("camera", effectiveType, device.id, listRegisteredCameraAdapters());
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
// Built-in factories (module-level functions, reused by registry + fallbacks)
// ---------------------------------------------------------------------------

function buildMockMachine(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): MachineAdapter {
  return new MockFDMAdapter(
    device.id,
    kernelId,
    (cfg.jobDurationMs as number | undefined) ?? 5000,
  );
}

function buildMockSensor(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): SensorAdapter {
  return new MockPowerMonitorAdapter(device.id, kernelId, {
    idleWatts: cfg.idleWatts as number | undefined,
    activeWatts: cfg.activeWatts as number | undefined,
  });
}

function buildMockCamera(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): CameraAdapter {
  return new MockCameraAdapter(
    device.id,
    kernelId,
    (cfg.passRate as number | undefined) ?? 0.95,
  );
}

function buildOctoPrint(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): MachineAdapter {
  return new OctoPrintAdapter(device.id, {
    url: (cfg.url as string | undefined) ?? "http://localhost:5000",
    apiKey: (cfg.apiKey as string | undefined) ?? "",
    kernelId,
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? false,
  });
}

function buildOPCUA(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): MachineAdapter {
  return new OPCUAAdapter(device.id, {
    endpoint: (cfg.endpoint as string | undefined) ?? "opc.tcp://localhost:4840",
    kernelId,
    machineType:
      (cfg.machineType as "cnc-3axis" | "cnc-5axis" | "lathe" | "laser-cut" | undefined) ??
      "cnc-3axis",
    nodeMap:
      (cfg.nodeMap as import("./adapters/opcua-adapter.js").OPCUANodeDef[] | undefined) ?? [],
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    securityMode: cfg.securityMode as "none" | "sign" | "signAndEncrypt" | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? false,
  });
}

function buildIpp(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): MachineAdapter {
  return new IppAdapter(device.id, {
    uri: (cfg.uri as string | undefined) ?? "ipp://localhost:631/ipp/print",
    name: cfg.name as string | undefined,
    kernelId,
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? true,
  });
}

function buildOpentrons(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  _kernelId: string,
): MachineAdapter {
  return new OpentronsMachineAdapter(device.id, {
    url: (cfg.url as string | undefined) ?? "http://localhost:31950",
    apiVersion: (cfg.apiVersion as string | undefined) ?? "2.18",
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? false,
    maxQueueDepth: cfg.maxQueueDepth as number | undefined,
  });
}

function buildHamilton(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): MachineAdapter {
  return new HamiltonAdapter(device.id, {
    url: (cfg.url as string | undefined) ?? "http://localhost",
    username: (cfg.username as string | undefined) ?? "",
    password: (cfg.password as string | undefined) ?? "",
    kernelId,
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? false,
    refreshLeadSeconds: cfg.refreshLeadSeconds as number | undefined,
    mockRunDurationMs: cfg.mockRunDurationMs as number | undefined,
  });
}

function buildModbus(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): SensorAdapter {
  return new ModbusSensorAdapter(device.id, {
    host: (cfg.host as string | undefined) ?? "localhost",
    port: cfg.port as number | undefined,
    unitId: cfg.unitId as number | undefined,
    kernelId,
    registerMap:
      (cfg.registerMap as
        | import("./adapters/modbus-sensor-adapter.js").ModbusRegisterDef[]
        | undefined) ?? [],
    pollIntervalMs: cfg.pollIntervalMs as number | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? true,
  });
}

function buildSiLA(
  device: DeviceConfig,
  cfg: Record<string, unknown>,
  kernelId: string,
): SensorAdapter {
  return createSiLASensorAdapter(device.id, cfg, kernelId);
}

// ---------------------------------------------------------------------------
// Built-in registrations (auto-register at module load for backward-compat)
// ---------------------------------------------------------------------------

/**
 * `generic-http` was historically a silent alias for the mock adapters —
 * a device honestly registered under this documented adapterType received a
 * simulator whose fabricated events entered signed evidence bundles. No real
 * generic-http transport exists in this build, so creating one now fails
 * loudly at registration/boot time. The type stays registered (discoverable
 * via listRegistered*Adapters, replaceable by a real implementation through
 * the unregister/register API), but it can no longer mint mock evidence unnoticed.
 */
function buildGenericHttpRefusal<T>(category: "machine" | "sensor" | "camera") {
  return (device: DeviceConfig): T => {
    throw new Error(
      `[adapter-factory] adapterType "generic-http" (device "${device.id}") is not implemented — ` +
        `it previously aliased silently to the mock ${category} adapter, which emits fabricated evidence. ` +
        `Use adapterType: "mock" (or KernelConfig.mockMode: true) for explicit simulation, or register a ` +
        `real implementation via unregister/register for "generic-http".`,
    );
  };
}

// Machine adapters
registerMachineAdapter("mock", buildMockMachine);
registerMachineAdapter("generic-http", buildGenericHttpRefusal<MachineAdapter>("machine"));
registerMachineAdapter("octoprint", buildOctoPrint);
registerMachineAdapter("opcua", buildOPCUA);
registerMachineAdapter("ipp", buildIpp);
registerMachineAdapter("opentrons", buildOpentrons);
registerMachineAdapter("hamilton", buildHamilton);

// Sensor adapters
registerSensorAdapter("mock", buildMockSensor);
registerSensorAdapter("generic-http", buildGenericHttpRefusal<SensorAdapter>("sensor"));
registerSensorAdapter("modbus", buildModbus);
registerSensorAdapter("sila", buildSiLA);

// Camera adapters
registerCameraAdapter("mock", buildMockCamera);
registerCameraAdapter("generic-http", buildGenericHttpRefusal<CameraAdapter>("camera"));

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
  // Honor BOTH `mock` and `mockMode` keys. Every other adapter uses
  // `mockMode`; sila historically only read `mock`, so an operator setting
  // `mockMode: false` (believing it engages real transport) silently stayed
  // in mock. Either key set to false now selects real mode — which fails
  // loudly, because no real SiLA 2 transport exists in this build.
  const mockFlag =
    (cfg.mock as boolean | undefined) ?? (cfg.mockMode as boolean | undefined) ?? true;

  const sila = new SiLAAdapter({
    deviceId: id,
    kernelId,
    silaServerUrl: cfg.url as string | undefined,
    mock: mockFlag,
    deviceName: cfg.deviceName as string | undefined,
  });

  let currentJobId: string | null = null;

  const assertMockOnly = (operation: string): void => {
    if (!mockFlag) {
      throw new Error(
        `[sila-adapter] ${operation} not implemented for real SiLA 2 servers — no SiLA 2 transport ` +
          `exists in this build; refusing to fabricate sensor lifecycle/evidence for device "${id}". ` +
          `Set mock: true for explicit, tagged simulation.`,
      );
    }
  };

  return {
    id: sila.id,
    type: "power_monitor" as const, // generic sensor role
    source: sila.source,

    async startRecording(jobId: string): Promise<void> {
      // Real mode must not pretend a recording started (a Tier-1+ job would
      // believe evidence collection is running when nothing is connected).
      assertMockOnly("startRecording");
      currentJobId = jobId;
    },

    async stopRecording(): Promise<Omit<import("@pcc/spec").EvidenceEvent, "id" | "hash">> {
      assertMockOnly("stopRecording");
      return {
        type: "sensor_data_summary",
        timestamp: new Date().toISOString(),
        source: sila.source,
        payload: { jobId: currentJobId, adapter: "sila", mock: true },
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
