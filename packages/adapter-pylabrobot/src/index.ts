/**
 * @pcc/adapter-pylabrobot — PyLabRobot adapter for the PCC kernel.
 *
 * Public surface:
 *   - `PyLabRobotAdapter` — implements `MachineAdapter`; spawns + talks to
 *     the Python sidecar.
 *   - `SidecarClient` + `InMemoryTransport` — JSON-RPC stdio client for the
 *     long-running sidecar, plus a test transport.
 *   - `EvidenceCollector` — per-job evidence buffer with camera + sensor
 *     hooks.
 *   - Protocol constants + types for the JSON-RPC contract.
 *
 * Side effect: registers itself with the kernel's plugin registry at
 * module-load time. Importing `@pcc/adapter-pylabrobot` makes
 * `adapterType: 'pylabrobot'` resolvable via `createMachineAdapter`.
 *
 * Operators register a PLR-backed device via KERNEL_CONFIG with:
 *
 *   {
 *     "deviceId": "dev-ot2-001",
 *     "type": "machine",
 *     "adapterType": "pylabrobot",
 *     "config": {
 *       "plrBackend": "ot2",
 *       "backendConfig": {
 *         "ot2Url": "http://192.168.1.50:31950",
 *         "ot2ApiKey": "..."
 *       },
 *       "pythonPath": "auto"
 *     },
 *     "capabilities": ["liquid-handling-plr"]
 *   }
 */

import { registerMachineAdapter } from "@pcc/kernel";
import { PyLabRobotAdapter } from "./adapter.js";

// Auto-register at module load. Mirrors the SiLA / Hamilton / Opentrons
// pattern of having one entry-point per adapter that the host application
// imports for its side effect.
registerMachineAdapter("pylabrobot", (device, cfg, kernelId) => {
  const plrBackend = (cfg.plrBackend as string | undefined) ?? "chatterbox";
  const backendConfig =
    (cfg.backendConfig as Record<string, unknown> | undefined) ?? cfg;
  return new PyLabRobotAdapter({
    deviceId: device.id,
    kernelId,
    plrBackend: plrBackend as import("./adapter.js").PlrBackend,
    backendConfig,
    machineType: cfg.machineType as string | undefined,
    mockMode: (cfg.mockMode as boolean | undefined) ?? false,
    rpcTimeoutMs: cfg.rpcTimeoutMs as number | undefined,
    runTimeoutMs: cfg.runTimeoutMs as number | undefined,
    restartAfterJobs: cfg.restartAfterJobs as number | undefined,
    sidecarConfig: {
      pythonPath:
        (cfg.pythonPath as string | undefined) ??
        process.env.PCC_PLR_PYTHON_PATH ??
        "python",
    },
  });
});

export { PyLabRobotAdapter } from "./adapter.js";
export type { PyLabRobotConfig, PlrBackend } from "./adapter.js";

export {
  SidecarClient,
  SidecarError,
  InMemoryTransport,
} from "./sidecar-client.js";
export type {
  SidecarClientConfig,
  SidecarTransport,
} from "./sidecar-client.js";

export { EvidenceCollector } from "./evidence.js";
export type { CameraHook, SensorHook, EvidenceCollectorConfig } from "./evidence.js";

export {
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
} from "./protocol.js";
export type {
  RpcErrorCode,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcErrorObject,
  BackendInitParams,
  BackendInitResult,
  BackendRunParams,
  BackendRunResult,
  BackendStatusParams,
  BackendStatusResult,
  BackendCalibrateParams,
  BackendShutdownParams,
  EvidenceStartRecordingParams,
  EvidenceStopRecordingParams,
  EvidenceNotificationParams,
} from "./protocol.js";

export type {
  MachineAdapter,
  MachineCommand,
  MachineCommandResult,
  MachineStatus,
  AdapterEvidenceEvent,
  EvidenceCallback,
} from "./types.js";
