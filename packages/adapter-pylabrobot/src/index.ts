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
 * The kernel registers this adapter via
 *   `packages/kernel/src/adapters/pylabrobot.ts`
 * which is a thin re-export to keep the kernel package's adapter index
 * file unchanged in shape.
 */

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
