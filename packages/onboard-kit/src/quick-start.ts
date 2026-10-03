/**
 * Quick Start — minimal code to get a device on the PCC network.
 *
 * This function creates a complete working kernel + agent setup
 * from a simplified configuration.
 *
 * Two modes, chosen explicitly (PX-10: nothing is simulated silently):
 *
 *  - "live" (the default): jobs run on YOUR machine.  `machineApi` is
 *    required and is the adapter the kernel agent executes jobs with.  Nothing
 *    is simulated: there is no sensor or camera unless you give its API, and
 *    an adapter config asking for `mockMode` is refused.
 *  - "demo": everything is simulated (machine, power sensor, camera) so you can
 *    try the SDK without hardware.  The capability is tagged "demo", and a demo
 *    kernel never talks to a gateway: simulated evidence must not reach
 *    settlement.
 *
 * Evidence from jobs the kernel agent runs is signed with the agent's own
 * wallet key.  It can settle only once that key is registered as the kernel's
 * signing key; until then the oracle refuses it (fail closed).
 */

import { MessageBus } from "@pcc/a2a";
import { KernelAgent } from "@pcc/agent-kernel";
import { EvidenceEmitter, JobRunner } from "@pcc/kernel";
import type { MachineAdapter, SensorAdapter, CameraAdapter } from "@pcc/kernel";
import type { Capability, BuiltinCapabilityType, AssuranceTier } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { GenericHttpAdapter, type GenericHttpAdapterConfig } from "./templates/generic-http-adapter.js";
import { GenericSensorAdapter, type GenericSensorConfig } from "./templates/generic-sensor-adapter.js";
import { GenericCameraAdapter, type GenericCameraConfig } from "./templates/generic-camera-adapter.js";

export type QuickStartMode = "live" | "demo";

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
  /** "live" (default) runs jobs on your machine; "demo" simulates everything. */
  mode?: QuickStartMode;
  /** Your machine's HTTP API.  Required in live mode; ignored in demo mode. */
  machineApi?: GenericHttpAdapterConfig;
  /** Your sensor's HTTP API (optional; live mode has no sensor without it) */
  sensorApi?: GenericSensorConfig;
  /** Your camera's HTTP API (optional; live mode has no camera without it) */
  cameraApi?: GenericCameraConfig;
  /**
   * PCC gateway for batch settlement (live mode only).  There is no default:
   * without one the kernel settles nothing.  Refused in demo mode.
   */
  gatewayUrl?: string;
}

export interface QuickStartResult {
  /** The mode the kernel runs in: "demo" means every device is simulated. */
  mode: QuickStartMode;
  kernelAgent: KernelAgent;
  bus: MessageBus;
  capability: Capability;
  jobRunner: JobRunner;
  evidenceEmitter: EvidenceEmitter;
  stop: () => void;
}

/** A quickStart configuration that would run something other than what it says. */
export class QuickStartConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickStartConfigError";
  }
}

function checkConfig(config: QuickStartConfig, mode: QuickStartMode): void {
  if (mode !== "live" && mode !== "demo") {
    throw new QuickStartConfigError(`mode must be "live" or "demo", not ${JSON.stringify(mode)}`);
  }
  if (mode === "demo") {
    if (config.gatewayUrl !== undefined) {
      throw new QuickStartConfigError(
        "a demo kernel never talks to a gateway: its devices are simulated, and simulated evidence must not reach settlement",
      );
    }
    return;
  }
  if (!config.machineApi) {
    throw new QuickStartConfigError(
      'live mode needs machineApi: the HTTP API of the machine that will run jobs. For a simulated kernel, pass mode: "demo".',
    );
  }
  const apis: Array<[string, { mockMode?: boolean } | undefined]> = [
    ["machineApi", config.machineApi],
    ["sensorApi", config.sensorApi],
    ["cameraApi", config.cameraApi],
  ];
  for (const [label, api] of apis) {
    if (api?.mockMode) {
      throw new QuickStartConfigError(
        `${label}.mockMode simulates the device, which live mode never does. For a simulated kernel, pass mode: "demo".`,
      );
    }
  }
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
 *   machineApi: { baseUrl: "http://192.168.1.50", kernelId: "kernel_my_shop", ... },
 * });
 * // Jobs the kernel agent accepts now run on the machine at machineApi.
 * ```
 *
 * Throws QuickStartConfigError when the configuration would run something
 * other than what it says (see the module docstring).
 */
export async function quickStart(config: QuickStartConfig): Promise<QuickStartResult> {
  const mode: QuickStartMode = config.mode ?? "live";
  checkConfig(config, mode);
  const {
    kernelId,
    name,
    location,
    capability: capConfig,
    machineApi,
    sensorApi,
    cameraApi,
    gatewayUrl,
  } = config;
  const demo = mode === "demo";

  // 1. Create adapters.  Live mode uses only what was configured; demo mode
  //    simulates every device, and nothing else does.
  const machine = new GenericHttpAdapter(
    `dev_machine_${kernelId}`,
    demo
      ? {
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
          mockMode: true,
        }
      : (machineApi as GenericHttpAdapterConfig),
  );

  const sensor = sensorApi && !demo
    ? new GenericSensorAdapter(`dev_sensor_${kernelId}`, sensorApi)
    : demo
      ? new GenericSensorAdapter(`dev_sensor_${kernelId}`, {
          readingUrl: "http://localhost:9998/reading",
          kernelId,
          channel: "power",
          unit: "W",
          sensorType: "power_monitor",
          valueField: "watts",
          mockMode: true,
          mockRange: { min: 50, max: 500 },
        })
      : null;

  const camera = cameraApi && !demo
    ? new GenericCameraAdapter(`dev_camera_${kernelId}`, cameraApi)
    : demo
      ? new GenericCameraAdapter(`dev_camera_${kernelId}`, {
          captureUrl: "http://localhost:9997/capture",
          kernelId,
          imageHashField: "hash",
          storageRefField: "url",
          mockMode: true,
        })
      : null;

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
    ...(demo ? { tags: ["demo"] } : {}),
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
  } as unknown as MachineAdapter;

  const sensorAdapters: SensorAdapter[] = sensor
    ? [
        {
          id: sensor.id,
          type: sensor.type,
          source: sensor.source,
          startRecording: (jobId: string) => sensor.startRecording(jobId),
          stopRecording: () => sensor.stopRecording(),
          getCurrentReading: () => sensor.getCurrentReading(),
          onEvidence: (cb: any) => sensor.onEvidence(cb),
          dispose: () => sensor.dispose(),
        } as unknown as SensorAdapter,
      ]
    : [];

  const cameraAdapter: CameraAdapter | null = camera
    ? ({
        id: camera.id,
        source: camera.source,
        captureSnapshot: () => camera.captureSnapshot(),
        runInspection: (ref?: string) => camera.runInspection(ref),
        onEvidence: (cb: any) => camera.onEvidence(cb),
        dispose: () => camera.dispose(),
      } as unknown as CameraAdapter)
    : null;

  const jobRunner = new JobRunner(machineAdapter, sensorAdapters, cameraAdapter, evidenceEmitter);

  // 4. Create agent.  It runs jobs on THESE adapters: without them it would
  //    fall back to its own simulators, whatever machineApi said.
  const bus = new MessageBus();
  const kernelAgent = new KernelAgent(bus, {
    kernelId,
    name,
    location,
    capabilities: [capability],
    adapters: { machine: machineAdapter, sensors: sensorAdapters, camera: cameraAdapter },
    ...(!demo && gatewayUrl ? { gatewayUrl } : {}),
  });

  kernelAgent.start();

  const stop = () => {
    kernelAgent.stop();
    machine.dispose();
    sensor?.dispose();
    camera?.dispose();
  };

  return { mode, kernelAgent, bus, capability, jobRunner, evidenceEmitter, stop };
}
