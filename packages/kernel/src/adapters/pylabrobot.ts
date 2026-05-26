/**
 * PyLabRobot adapter — thin re-export of the @pcc/adapter-pylabrobot package.
 *
 * Keeps the kernel's adapter import surface uniform (every adapter lives
 * under `packages/kernel/src/adapters/`). The heavy lifting (sidecar
 * spawn, JSON-RPC framing, evidence collection) lives in the dedicated
 * `@pcc/adapter-pylabrobot` package so it can be tested + versioned
 * independently of the kernel.
 *
 * See `ai/research/pylabrobot-pcc-integration-2026-05-25.md` for the
 * full architecture (§3 in particular).
 */

export {
  PyLabRobotAdapter,
  type PyLabRobotConfig,
  type PlrBackend,
  SidecarClient,
  SidecarError,
  type SidecarClientConfig,
  EvidenceCollector,
  type CameraHook,
  type SensorHook,
  RPC_ERROR_CODES,
  RPC_METHODS,
} from "@pcc/adapter-pylabrobot";
