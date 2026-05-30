/**
 * JSON-RPC 2.0 protocol shapes shared between the TypeScript adapter and the
 * Python sidecar (`pcc_plr_sidecar`).
 *
 * Wire format: newline-delimited JSON, one message per line, exchanged over
 * the Python child process's stdin (TS → Py) and stdout (Py → TS). stderr is
 * tee'd for human review and never parsed structurally.
 */

/** JSON-RPC 2.0 error codes used by the sidecar (subset of -32xxx range) */
export const RPC_ERROR_CODES = {
  /** -32700: invalid JSON, parse error */
  PARSE_ERROR: -32700,
  /** -32600: well-formed JSON but not a valid request object */
  INVALID_REQUEST: -32600,
  /** -32601: method not found */
  METHOD_NOT_FOUND: -32601,
  /** -32602: invalid params */
  INVALID_PARAMS: -32602,
  /** -32603: internal server error (unhandled exception in handler) */
  INTERNAL_ERROR: -32603,
  /** -32001: retryable transient failure (USB hiccup, network blip) */
  RETRYABLE: -32001,
  /** -32002: non-retryable protocol error (out of tips, no plate, lid open) */
  NON_RETRYABLE: -32002,
  /** -32003: hardware unreachable (already disposed, no backend) */
  HARDWARE_UNREACHABLE: -32003,
  /** -32004: operation not supported by this backend (e.g., Hamilton STAR abort) */
  NOT_SUPPORTED: -32004,
  /** -32005: device busy (concurrent job rejected) */
  DEVICE_BUSY: -32005,
  /** -32099: sidecar restart in progress, retry once */
  SIDECAR_RESTART: -32099,
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 notification (no id, no response expected) */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response */
export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

/** JSON-RPC 2.0 error object */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/** JSON-RPC 2.0 error response */
export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── PLR-side RPC method names ────────────────────────────────────────────────
// Mirrors §3.4 of the PLR research doc. Comprehensive, organized by namespace.

/** RPC methods the TS adapter calls; sidecar implements all of these */
export const RPC_METHODS = {
  // Backend / device lifecycle (Phase 1)
  BACKEND_INIT: "backend.init",
  BACKEND_RUN: "backend.run",
  BACKEND_CALIBRATE: "backend.calibrate",
  BACKEND_STATUS: "backend.status",
  BACKEND_SHUTDOWN: "backend.shutdown",
  // Evidence side-channel (Phase 1)
  EVIDENCE_START_RECORDING: "evidence.startRecording",
  EVIDENCE_STOP_RECORDING: "evidence.stopRecording",
  EVIDENCE_SNAPSHOT: "evidence.snapshot",
  // Health (Phase 1)
  HEALTH_PING: "health.ping",
} as const;

/** Notification method names the sidecar pushes to the TS adapter */
export const RPC_NOTIFICATIONS = {
  /** PLR log lines + atomic-action events captured during a recording window */
  EVIDENCE: "evidence",
  /** Sidecar lifecycle: started, ready, shutting_down */
  LIFECYCLE: "lifecycle",
} as const;

// ── Param + result shapes (typed where they matter) ────────────────────────

/** Parameters for `backend.init` — instantiates the PLR Backend + Machine */
export interface BackendInitParams {
  /** Unique device id on this kernel */
  deviceId: string;
  /**
   * Which PLR backend to spin up. Phase 1 supports `ot2` and `chatterbox`;
   * Phase 2+ extends with `flex`, `star`, `vantage`, `evo`, `clariostar`,
   * `cytation5`, `vspin`, `hamilton-hhs`, `inheco-thermoshake`, `cytomat-*`,
   * `inheco-odtc`, `liconic-stx`, etc.
   */
  plrBackend:
    | "ot2"
    | "chatterbox"
    | "flex"
    | "star"
    | "vantage"
    | "evo"
    | (string & {});
  /** Per-backend adapter config (URL, credentials, deck file, etc.) */
  backendConfig: Record<string, unknown>;
}

/** Result returned by `backend.init` */
export interface BackendInitResult {
  ok: true;
  deviceId: string;
  plrBackend: string;
  /** Snapshot of the freshly-loaded deck layout (for evidence) */
  deckSnapshot?: Record<string, unknown>;
}

/** Parameters for `backend.run` — execute a PLR protocol */
export interface BackendRunParams {
  deviceId: string;
  /** PCC job id (used for evidence-recording scope) */
  jobId: string;
  /**
   * What kind of protocol payload we're sending. `plr-script` = inline
   * Python or URL pointing to PLR script. `opentrons-protocol` = Opentrons
   * Python protocol. `worklist-csv` = Hamilton/Tecan worklist. `inline-ops`
   * = a JSON array of atomic PLR ops (transfer, aspirate, dispense...).
   */
  protocolSource:
    | "plr-script"
    | "opentrons-protocol"
    | "worklist-csv"
    | "synthace-export"
    | "stock-protocol"
    | "inline-ops"
    | (string & {});
  /** URL or inline payload */
  protocolPayload?: string;
  /** Optional inline JSON payload (overrides protocolPayload when present) */
  protocolInline?: Record<string, unknown> | unknown[];
  /** Free-form protocol parameters (transferVolume_uL, plateFormat, etc.) */
  params?: Record<string, unknown>;
}

/** Result returned by `backend.run` */
export interface BackendRunResult {
  ok: boolean;
  /** PCC job id (echoed) */
  jobId: string;
  /** Total atomic ops executed */
  opCount: number;
  /** Wall-clock duration (ms) */
  durationMs: number;
  /** Any per-op summary the sidecar wants to surface */
  summary?: Record<string, unknown>;
}

/** Parameters for `backend.status` */
export interface BackendStatusParams {
  deviceId: string;
}

/** Result returned by `backend.status` */
export interface BackendStatusResult {
  /** "idle" / "busy" / "error" / "offline" — mapped to PCC MachineStatus */
  status: string;
  /** 0..1 normalized progress (TS adapter multiplies by 100) */
  progress?: number;
  /** Free-form diagnostic dump */
  diagnostics?: Record<string, unknown>;
}

/** Parameters for `backend.calibrate` */
export interface BackendCalibrateParams {
  deviceId: string;
  /** Operator-specific calibration kind (e.g., "deck", "tip-pickup", "plate-z") */
  kind: string;
  /** Calibration-specific params */
  params?: Record<string, unknown>;
}

/** Parameters for `backend.shutdown` */
export interface BackendShutdownParams {
  deviceId?: string;
}

/** Parameters for evidence.startRecording */
export interface EvidenceStartRecordingParams {
  deviceId: string;
  jobId: string;
}

/** Parameters for evidence.stopRecording */
export interface EvidenceStopRecordingParams {
  deviceId: string;
  jobId: string;
}

/** Shape of evidence notifications pushed from the sidecar */
export interface EvidenceNotificationParams {
  type: string;
  deviceId: string;
  jobId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
