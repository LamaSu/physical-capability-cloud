/**
 * Quick Start — minimal code to get a device on the PCC network.
 *
 * This function creates a complete working kernel + agent setup
 * from a simplified configuration. Use this for rapid prototyping.
 */

import { MessageBus } from "@pcc/a2a";
import { KernelAgent } from "@pcc/agent-kernel";
import { EvidenceEmitter, JobRunner } from "@pcc/kernel";
import type { Capability, BuiltinCapabilityType, AssuranceTier } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { GenericHttpAdapter, type GenericHttpAdapterConfig } from "./templates/generic-http-adapter.js";
import { GenericSensorAdapter, type GenericSensorConfig } from "./templates/generic-sensor-adapter.js";
import { GenericCameraAdapter, type GenericCameraConfig } from "./templates/generic-camera-adapter.js";

export interface QuickStartConfig {
  /** Unique kernel ID */
  kernelId: string;
  /** Human-readable name */
  name: string;
  /** Physical location */
  location: { lat: number; lng: number };
  /** What your machine does */
  capability: {
    type: BuiltinCapabilityType;
    name: string;
    materials: string[];
    assuranceTiers: AssuranceTier[];
    pricing: {
      baseCost: string;
      perMinute: string;
      minimum: string;
    };
  };
  /** Your machine's HTTP API (optional — uses mock mode if not provided) */
  machineApi?: GenericHttpAdapterConfig;
  /** Your sensor's HTTP API (optional) */
  sensorApi?: GenericSensorConfig;
  /** Your camera's HTTP API (optional) */
  cameraApi?: GenericCameraConfig;
  /** PCC Gateway URL */
  gatewayUrl?: string;
}

export interface QuickStartResult {
  kernelAgent: KernelAgent;
  bus: MessageBus;
  capability: Capability;
  jobRunner: JobRunner;
  evidenceEmitter: EvidenceEmitter;
  stop: () => void;
}

/**
 * One-call setup: creates adapters, kernel, agent, connects to network.
 *
 * ```typescript
 * const { kernelAgent, stop } = await quickStart({
 *   kernelId: "kernel_my_shop",
 *   name: "My Workshop",
 *   location: { lat: 37.77, lng: -122.41 },
 *   capability: {
 *     type: "fdm",
 *     name: "Prusa MK4",
 *     materials: ["pla", "petg", "abs"],
 *     assuranceTiers: [0, 1],
 *     pricing: { baseCost: "5.00", perMinute: "0.10", minimum: "10.00" },
 *   },
 * });
 * // Your machine is now discoverable on the PCC network
 * ```
 */
export async function quickStart(config: QuickStartConfig): Promise<QuickStartResult> {
  const {
    kernelId,
    name,
    location,
    capability: capConfig,
    machineApi,
    sensorApi,
    cameraApi,
    gatewayUrl = "http://localhost:3200",
  } = config;

  // 1. Create adapters
  const machine = new GenericHttpAdapter(`dev_machine_${kernelId}`, machineApi ?? {
    baseUrl: "http://localhost:9999",
    kernelId,
    machineType: capConfig.type,
    endpoints: {
      status: { method: "GET", path: "/status" },
      progress: { method: "GET", path: "/progress" },
      loadProgram: { method: "POST", path: "/load" },
      start: { method: "POST", path: "/start" },
      stop: { method: "POST", path: "/stop" },
    },
    statusMapping: {
      statusField: "state",
      map: { ready: "idle", running: "busy", error: "error" },
      default: "idle",
    },
    progressMapping: { progressField: "percent" },
    mockMode: !machineApi,
  });

  const sensor = sensorApi
    ? new GenericSensorAdapter(`dev_sensor_${kernelId}`, sensorApi)
    : new GenericSensorAdapter(`dev_sensor_${kernelId}`, {
        readingUrl: "http://localhost:9998/reading",
        kernelId,
        channel: "power",
        unit: "W",
        sensorType: "power_monitor",
        valueField: "watts",
        mockMode: true,
        mockRange: { min: 50, max: 500 },
      });

  const camera = cameraApi
    ? new GenericCameraAdapter(`dev_camera_${kernelId}`, cameraApi)
    : new GenericCameraAdapter(`dev_camera_${kernelId}`, {
        captureUrl: "http://localhost:9997/capture",
        kernelId,
        imageHashField: "hash",
        storageRefField: "url",
        mockMode: true,
      });

  // 2. Build capability object
  const capability: Capability = {
    id: ids.capability(),
    kernelId,
    type: capConfig.type,
    name: capConfig.name,
    materials: capConfig.materials,
    assuranceTiers: capConfig.assuranceTiers,
    pricing: {
      currency: "USDC",
      baseCost: capConfig.pricing.baseCost,
      perMinute: capConfig.pricing.perMinute,
      perGram: "0.00",
      minimum: capConfig.pricing.minimum,
    },
    location,
    queueDepth: 0,
    availability: {
      timezone: "UTC",
      windows: {
        0: [{ start: "00:00", end: "23:59" }],
        1: [{ start: "00:00", end: "23:59" }],
        2: [{ start: "00:00", end: "23:59" }],
        3: [{ start: "00:00", end: "23:59" }],
        4: [{ start: "00:00", end: "23:59" }],
        5: [{ start: "00:00", end: "23:59" }],
        6: [{ start: "00:00", end: "23:59" }],
      },
    },
  };

  // 3. Create evidence pipeline
  const evidenceEmitter = new EvidenceEmitter(kernelId);

  // Bridge adapters to kernel adapter interface
  const machineAdapter = {
    id: machine.id,
    type: machine.type,
    source: machine.source,
    getStatus: () => machine.getStatus(),
    getProgress: () => machine.getProgress(),
    execute: (cmd: any) => machine.execute(cmd),
    onEvidence: (cb: any) => machine.onEvidence(cb),
    dispose: () => machine.dispose(),
  };

  const sensorAdapter = {
    id: sensor.id,
    type: sensor.type,
    source: sensor.source,
    startRecording: (jobId: string) => sensor.startRecording(jobId),
    stopRecording: () => sensor.stopRecording(),
    getCurrentReading: () => sensor.getCurrentReading(),
    onEvidence: (cb: any) => sensor.onEvidence(cb),
    dispose: () => sensor.dispose(),
  };

  const cameraAdapter = {
    id: camera.id,
    source: camera.source,
    captureSnapshot: () => camera.captureSnapshot(),
    runInspection: (ref?: string) => camera.runInspection(ref),
    onEvidence: (cb: any) => camera.onEvidence(cb),
    dispose: () => camera.dispose(),
  };

  const jobRunner = new JobRunner(
    machineAdapter as any,
    [sensorAdapter as any],
    cameraAdapter as any,
    evidenceEmitter,
  );

  // 4. Create agent
  const bus = new MessageBus();
  const kernelAgent = new KernelAgent(bus, {
    kernelId,
    name,
    location,
    capabilities: [capability],
    mockPrintDuration: 3000,
    gatewayUrl,
  });

  kernelAgent.start();

  const stop = () => {
    kernelAgent.stop();
    machine.dispose();
    sensor.dispose();
    camera.dispose();
  };

  return { kernelAgent, bus, capability, jobRunner, evidenceEmitter, stop };
}
