/**
 * Execution-scope service — the ONE place the gateway mints an execution scope
 * for a job it is about to dispatch in-process.
 *
 * Why this exists
 * ---------------
 * JobRunner classifies a job's actuation commands (load_gcode, start) as class
 * "scoped", and the SafetyGovernor's rule for that class is literally
 * `return !!cmd.scopeId` (packages/kernel/src/safety/governor.ts). KernelService
 * therefore denies any submitJob() that carries no scopeId, up front and
 * synchronously, and it deliberately does NOT mint a scope of its own — a
 * dispatch boundary that hands itself the credential it is supposed to be
 * checking is not a boundary at all.
 *
 * So the credential has to come from the *producer*: whoever creates the job
 * row on behalf of an authenticated principal is the one entitled to grant that
 * job an execution scope, and is the one whose identity the scope records. This
 * module is that grant, factored out of the paid-job path
 * (routes/paid-job-flow.ts) so all producers mint the same shape of row.
 *
 * What this module does NOT do
 * ----------------------------
 * It never accepts a caller-supplied scope id. A scope is minted here or the
 * submission fails; a request body cannot bring its own. That matters because
 * routes/device-relay.ts resolves an active scope by (kernelId, createdBy,
 * status) — so honouring an attacker-supplied id would let a caller borrow
 * someone else's grant.
 */

import { getStore } from "../db.js";
import { schema } from "@pcc/store";

const { executionScopes } = schema;

// ── Write-tool vocabulary ──────────────────────────────────────────────────
// Moved here verbatim from routes/paid-job-flow.ts so the two in-process job
// producers (facades/job.facade.ts, routes/setup.ts) can derive the same
// allowed-tool set without importing from a route module.

/** Default write tools for common device types */
const DEVICE_WRITE_TOOLS: Record<string, string[]> = {
  "liquid-handler": [
    "ot2_run_protocol",
    "ot2_aspirate",
    "ot2_dispense",
    "ot2_pick_up_tip",
    "ot2_drop_tip",
    "ot2_move_to",
    "ot2_mix",
    "ot2_blow_out",
    "ot2_touch_tip",
    "ot2_transfer",
  ],
  "fdm-printer": [
    "printer_start_job",
    "printer_pause",
    "printer_resume",
    "printer_cancel",
    "printer_set_temperature",
  ],
  "cnc-mill": [
    "cnc_start_program",
    "cnc_pause",
    "cnc_resume",
    "cnc_cancel",
    "cnc_set_speed",
  ],
};

/**
 * Get write tools for a device type, falling back to a generic set.
 *
 * The fallback is the minimal write vocabulary a job needs (start / pause /
 * resume / cancel), which is what an unmapped or unknown capability type gets.
 */
export function getWriteToolsForDeviceType(capabilityType: string | undefined): string[] {
  return (capabilityType ? DEVICE_WRITE_TOOLS[capabilityType] : undefined) ?? [
    "device_start_job",
    "device_pause",
    "device_resume",
    "device_cancel",
  ];
}

// ── Principal → agent DID ──────────────────────────────────────────────────

/**
 * Principal recorded on a scope minted for a request that carried no
 * authenticated identity. `execution_scopes.created_by` is NOT NULL and the
 * audit trail is the point of the row, so an unauthenticated producer records
 * *that* rather than inventing a plausible-looking operator id.
 */
export const UNAUTHENTICATED_PRINCIPAL = "unauthenticated";

/**
 * Normalise a principal into the DID form the SafetyGovernor expects.
 *
 * The governor buckets its per-minute command rate limit by `agentDid`
 * (governor.ts checkRateLimit/recordCommand). KernelService's fallback is the
 * constant "kernel-service", which lumps every caller into one bucket; passing
 * a per-principal DID gives each principal its own. Already-DID principals
 * pass through unchanged so we never emit `did:pcc:did:key:z...`.
 */
export function principalToAgentDid(principal: string): string {
  return principal.startsWith("did:") ? principal : `did:pcc:${principal}`;
}

// ── Minting ────────────────────────────────────────────────────────────────

export interface MintExecutionScopeInput {
  kernelId: string;
  /** Job this scope is bound to. */
  jobId: string;
  /** Authenticated principal on whose behalf the job was created. */
  createdBy: string;
  /** Capability/device type; maps to the allowed write-tool set. */
  capabilityType?: string;
  /** Explicit tool set, overriding the capabilityType lookup. */
  allowedTools?: string[];
  /** Command budget for the scope. Default 200 (the paid-job-path value). */
  maxCommands?: number;
  /** Troubleshooting retry budget. Default 5 (the paid-job-path value). */
  maxRetries?: number;
  /** Lifetime in ms. Default 1 hour (the paid-job-path value). */
  ttlMs?: number;
  /** Creation timestamp (ISO). Defaults to now. */
  createdAt?: string;
}

export interface MintedExecutionScope {
  scopeId: string;
  /** Pass to KernelService.submitJob alongside scopeId. */
  agentDid: string;
  allowedTools: string[];
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_COMMANDS = 200;
const DEFAULT_MAX_RETRIES = 5;

/**
 * Mint an execution scope for `jobId` and persist it.
 *
 * Throws if the row cannot be written. Callers MUST let that abort the
 * submission: a producer that swallows the failure and calls submitJob()
 * anyway is asking the boundary to dispatch an unscoped job, which it will
 * (correctly) refuse — and the caller would then be reporting the wrong cause.
 */
export function mintExecutionScope(input: MintExecutionScopeInput): MintedExecutionScope {
  const { db } = getStore();

  const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const allowedTools = input.allowedTools ?? getWriteToolsForDeviceType(input.capabilityType);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();

  db.insert(executionScopes).values({
    id: scopeId,
    kernelId: input.kernelId,
    jobId: input.jobId,
    createdBy: input.createdBy,
    status: "active",
    allowedTools,
    maxCommands: input.maxCommands ?? DEFAULT_MAX_COMMANDS,
    commandCount: 0,
    maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryCount: 0,
    createdAt,
    expiresAt,
  }).run();

  return {
    scopeId,
    agentDid: principalToAgentDid(input.createdBy),
    allowedTools,
    createdAt,
    expiresAt,
  };
}
