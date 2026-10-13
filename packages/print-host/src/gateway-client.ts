import { inspect } from "node:util";
import type { EvidenceBundle } from "@pcc/spec";
import { isGatewayBaseUrl } from "./config.js";

export type GwCode =
  | "unauthenticated" | "not_kernel_operator" | "operator_proof_required"
  | "job_has_no_kernel" | "insufficient_scope" | "blocked_by_policy" | "forbidden"
  | "kernel_not_found" | "route_unavailable" | "rate_limited" | "bad_request"
  | "unavailable" | "server_error" | "network" | "timeout" | "malformed_response"
  | "job_not_found" | "settlement_owned_status" | "job_kernel_changed" | "invalid_status"
  | "payload_too_large" | "bad_bundle" | "stored_mismatch" | "not_stored"
  | "evidence_refused" | "indeterminate";

export type GwSubCode =
  | "job_not_found" | "storage_failed" | "kernel_mismatch" | "job_mismatch"
  | "malformed_envelope" | "ambiguous_envelope" | "events_malformed"
  | "event_hash_mismatch" | "bundle_hash_mismatch" | "bundle_hash_malformed"
  | "evidence_not_lo_ev" | "evidence_not_canonical" | "evidence_not_bound" | "other";

export type GwResult<T> = { ok: true; value: T } | {
  ok: false;
  code: GwCode;
  status: number | null;
  retryAfterS?: number;
  sub?: GwSubCode;
};

export type GatewayClientErrorCode =
  | "bad_config" | "bad_base_url" | "bad_api_key" | "bad_kernel_id"
  | "bad_timeout" | "bad_response_limit" | "bad_fetch" | "bad_reader";

/** Input values and underlying exceptions are never retained. */
export class GatewayClientError extends Error {
  readonly code: GatewayClientErrorCode;
  constructor(code: GatewayClientErrorCode) {
    super(code);
    this.name = "GatewayClientError";
    this.code = code;
  }
}

export type EStopDecision = { proceed: true } | {
  proceed: false;
  why: "reader_unavailable" | "stopped" | "unavailable" | "absent" | "malformed" | "poll_failed";
};

/** PR5 supplies the production reader; the default always prevents execution. */
export type EmergencyStopReader = (body: Readonly<Record<string, unknown>>) => EStopDecision;

export interface GatewayClientConfig {
  baseUrl: string;
  apiKey: string;
  kernelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  emergencyStopReader?: EmergencyStopReader;
}

/** Reuse the spec's LO-EV fields rather than defining another wire envelope. */
export type RelayEvidenceBundle = Pick<EvidenceBundle, "events" | "bundleHash">
  & Partial<Pick<EvidenceBundle, "kernelSignature" | "sessionKeyAuthorization">>;

export interface PollJobsValue {
  stop: EStopDecision;
  jobs: { jobId: string; status: string }[];
  foreignJobsDropped: number;
  truncated: boolean;
}

export type HeartbeatValue = { validUntil: string } | null;
export type InProgressValue = { updated: true };
export interface RelayEvidenceReceipt {
  jobId: string;
  contentHash: string;
  hashModel: "event_bundle_hash";
}

export interface GatewayClient {
  pollJobs(): Promise<GwResult<PollJobsValue>>;
  heartbeat(): Promise<GwResult<HeartbeatValue>>;
  reportInProgress(jobId: string): Promise<GwResult<InProgressValue>>;
  postRelayEvidence(jobId: string, bundle: RelayEvidenceBundle): Promise<GwResult<RelayEvidenceReceipt>>;
  toJSON(): { baseUrl: string; kernelId: string };
  toString(): string;
  [inspect.custom](): { baseUrl: string; kernelId: string };
}

type Failure = Extract<GwResult<never>, { ok: false }>;
type ObjectBody = Record<string, unknown>;
type Reply = { body: ObjectBody; status: 200 };
type CallKind = "poll" | "heartbeat" | "status" | "evidence";

function isFailure(reply: Reply | Failure): reply is Failure {
  return Object.hasOwn(reply, "ok");
}

function failure(code: GwCode, status: number | null, sub?: GwSubCode): Failure {
  return { ok: false, code, status, ...(sub === undefined ? {} : { sub }) };
}

function object(value: unknown): value is ObjectBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: ObjectBody, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function validId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

function defaultEmergencyStopReader(): EStopDecision {
  return { proceed: false, why: "reader_unavailable" };
}

function readStop(reader: EmergencyStopReader, body: ObjectBody): EStopDecision {
  try {
    const decision: unknown = reader(body);
    if (object(decision)) {
      if (own(decision, "proceed") === true) return { proceed: true };
      if (own(decision, "proceed") === false) {
        const why = own(decision, "why");
        const allowed = ["reader_unavailable", "stopped", "unavailable", "absent", "malformed", "poll_failed"] as const;
        for (const constant of allowed) if (why === constant) return { proceed: false, why: constant };
      }
    }
  } catch { return { proceed: false, why: "unavailable" }; }
  return { proceed: false, why: "malformed" };
}

const evidenceConflict = ["kernel_mismatch", "job_mismatch"] as const;
const evidenceInvalid = [
  "malformed_envelope", "ambiguous_envelope", "events_malformed", "event_hash_mismatch",
  "bundle_hash_mismatch", "bundle_hash_malformed", "evidence_not_lo_ev",
  "evidence_not_canonical", "evidence_not_bound",
] as const;

/** Only our allowlist constants can become error codes or subcodes. */
function classify(status: number, body: ObjectBody, headers: Headers, kind: CallKind): Failure {
  const error = own(body, "error");
  if (status === 401) return failure("unauthenticated", status);
  if (status === 403) {
    const reason = own(body, "reason");
    for (const constant of ["not_kernel_operator", "operator_proof_required", "job_has_no_kernel", "insufficient_scope"] as const) {
      if (reason === constant || error === constant) return failure(constant, status);
    }
    if (error === "AEGIS_BLOCKED" || error === "AEGIS_REVIEW_BLOCKED"
      || (error === "forbidden" && own(body, "message") === "Request blocked by security policy")) {
      return failure("blocked_by_policy", status);
    }
    return failure("forbidden", status);
  }
  if (status === 404) return failure(error === "kernel_not_found" ? "kernel_not_found" : "route_unavailable", status);
  if (status === 429) {
    const result = failure("rate_limited", status);
    const retry = headers.get("retry-after");
    if (retry !== null && /^[0-9]+$/.test(retry)) {
      const seconds = Number(retry);
      if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600) result.retryAfterS = seconds;
    }
    return result;
  }
  if (kind === "status") {
    if (status === 400 && error === "invalid_status") return failure("invalid_status", status);
    if (status === 409) {
      for (const constant of ["settlement_owned_status", "job_kernel_changed"] as const) {
        if (error === constant) return failure(constant, status);
      }
    }
  }
  if (kind === "evidence" && (status === 409 || status === 422)) {
    const allowed = status === 409 ? evidenceConflict : evidenceInvalid;
    for (const constant of allowed) if (error === constant) return failure("evidence_refused", status, constant);
    return failure("evidence_refused", status, "other");
  }
  if (status === 400) return failure("bad_request", status);
  if (kind === "evidence" && status >= 500 && status <= 599) {
    // Only these refusals establish that the non-idempotent post stored nothing.
    if (status === 500 && error === "evidence_store_failed") return failure("server_error", status);
    if (status === 503 && (error === "read_failed" || error === "scope_requirements_unavailable")) {
      return failure("unavailable", status);
    }
    return failure("indeterminate", status);
  }
  if (status === 503) return failure("unavailable", status);
  if (status >= 500 && status <= 599) return failure("server_error", status);
  return failure("route_unavailable", status);
}

const aborted = Symbol("gateway timeout");
const tooLarge = Symbol("gateway response limit");

/** Fetch implementations and streams need not implement abort themselves. */
function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

async function boundedBody(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await withinDeadline(reader.read(), signal);
      if (signal.aborted) throw aborted;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { cancel(); throw tooLarge; }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createGatewayClient(cfg: GatewayClientConfig): Readonly<GatewayClient> {
  let input: GatewayClientConfig;
  try {
    if (!object(cfg)) throw undefined;
    input = {
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, kernelId: cfg.kernelId,
      fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs,
      maxResponseBytes: cfg.maxResponseBytes, emergencyStopReader: cfg.emergencyStopReader,
    };
  } catch { throw new GatewayClientError("bad_config"); }
  const { baseUrl, apiKey, kernelId } = input;
  if (typeof baseUrl !== "string" || !isGatewayBaseUrl(baseUrl)) throw new GatewayClientError("bad_base_url");
  if (typeof apiKey !== "string" || !/^pcc_(live|test)_[A-Za-z0-9_-]{16,256}$/.test(apiKey)) throw new GatewayClientError("bad_api_key");
  if (!validId(kernelId)) throw new GatewayClientError("bad_kernel_id");
  const timeoutMs = input.timeoutMs === undefined ? 15_000 : input.timeoutMs;
  const maxResponseBytes = input.maxResponseBytes === undefined ? 1024 * 1024 : input.maxResponseBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new GatewayClientError("bad_timeout");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new GatewayClientError("bad_response_limit");
  const fetchImpl = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl;
  const emergencyStopReader = input.emergencyStopReader === undefined ? defaultEmergencyStopReader : input.emergencyStopReader;
  if (typeof fetchImpl !== "function") throw new GatewayClientError("bad_fetch");
  if (typeof emergencyStopReader !== "function") throw new GatewayClientError("bad_reader");
  const endpoint = (name: string) => `${baseUrl.replace(/\/+$/, "")}/api/operator/${encodeURIComponent(name)}`;

  async function request(kind: CallKind, url: string, body?: string): Promise<Reply | Failure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    try {
      const response = await withinDeadline(fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      }), controller.signal);
      status = response.status;
      const text = await boundedBody(response, controller.signal, maxResponseBytes);
      if (controller.signal.aborted) throw aborted;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const isJson = contentType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType ?? "");
      // Success bodies are parsed only for JSON 200s. Non-200 JSON is decoded
      // solely to classify the route's allowlisted error discriminators.
      let parsed: unknown;
      if (isJson) {
        try { parsed = JSON.parse(text); } catch { /* never retain parse exceptions */ }
      }
      if (status !== 200) return classify(status, object(parsed) ? parsed : {}, response.headers, kind);
      if (!isJson || !object(parsed)) return failure(kind === "evidence" ? "indeterminate" : "malformed_response", status);
      return { status: 200, body: parsed };
    } catch (error) {
      if (kind === "evidence") return failure("indeterminate", status);
      if (error === tooLarge) return failure("malformed_response", status);
      const timedOut = controller.signal.aborted || error === aborted;
      return failure(timedOut ? "timeout" : status === null ? "network" : "malformed_response", status);
    } finally {
      clearTimeout(timer);
    }
  }

  const publicIdentity = () => ({ baseUrl, kernelId });
  return Object.freeze({
    async pollJobs(): Promise<GwResult<PollJobsValue>> {
      const reply = await request("poll", `${endpoint("jobs")}?kernelId=${encodeURIComponent(kernelId)}&status=${encodeURIComponent("queued")}`);
      if (isFailure(reply)) return reply;
      const incoming = own(reply.body, "jobs");
      if (!Array.isArray(incoming)) return failure("malformed_response", 200);
      const jobs: PollJobsValue["jobs"] = [];
      let foreignJobsDropped = 0;
      for (const job of incoming) {
        if (!object(job)) return failure("malformed_response", 200);
        const id = own(job, "id");
        const jobKernel = own(job, "kernelId");
        const status = own(job, "status");
        if (!validId(id) || typeof jobKernel !== "string" || typeof status !== "string") return failure("malformed_response", 200);
        if (jobKernel !== kernelId) { foreignJobsDropped++; continue; }
        jobs.push({ jobId: id, status });
      }
      return { ok: true, value: { stop: readStop(emergencyStopReader, reply.body), jobs, foreignJobsDropped, truncated: incoming.length >= 50 } };
    },
    async heartbeat(): Promise<GwResult<HeartbeatValue>> {
      const reply = await request("heartbeat", endpoint("heartbeat"), JSON.stringify({ kernelId, status: "online" }));
      if (isFailure(reply)) return reply;
      if (own(reply.body, "acknowledged") !== true) return failure("malformed_response", 200);
      const validUntil = own(reply.body, "validUntil");
      return { ok: true, value: typeof validUntil === "string" ? { validUntil } : null };
    },
    async reportInProgress(jobId: string): Promise<GwResult<InProgressValue>> {
      if (!validId(jobId)) return failure("bad_request", null);
      const reply = await request("status", endpoint("job-status"), JSON.stringify({ jobId, status: "in_progress" }));
      if (isFailure(reply)) return reply;
      if (own(reply.body, "updated") === true) return { ok: true, value: { updated: true } };
      if (own(reply.body, "updated") === false && own(reply.body, "warning") === "job_not_found") return failure("job_not_found", 200);
      return failure("malformed_response", 200);
    },
    async postRelayEvidence(jobId: string, bundle: RelayEvidenceBundle): Promise<GwResult<RelayEvidenceReceipt>> {
      if (!validId(jobId)) return failure("bad_request", null);
      let body: string;
      let bundleHash: string;
      try {
        if (!object(bundle)) return failure("bad_bundle", null);
        const hash = own(bundle, "bundleHash");
        if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) return failure("bad_bundle", null);
        bundleHash = hash;
        body = JSON.stringify({ jobId, kernelId, evidence: bundle });
      } catch { return failure("bad_bundle", null); }
      if (Buffer.byteLength(body, "utf8") > 1_000_000) return failure("payload_too_large", null);
      const reply = await request("evidence", endpoint("evidence"), body);
      if (isFailure(reply)) return reply;
      if (own(reply.body, "stored") === false) {
        if (own(reply.body, "warning") === "job_not_found") return failure("not_stored", 200, "job_not_found");
        if (own(reply.body, "error") === "storage_failed") return failure("not_stored", 200, "storage_failed");
        return failure("not_stored", 200, "other");
      }
      if (own(reply.body, "stored") !== true) return failure("indeterminate", 200);
      const contentHash = bundleHash;
      if (own(reply.body, "jobId") !== jobId || own(reply.body, "hashModel") !== "event_bundle_hash"
        || own(reply.body, "contentHash") !== contentHash) return failure("stored_mismatch", 200);
      return { ok: true, value: { jobId, contentHash, hashModel: "event_bundle_hash" } };
    },
    toJSON: publicIdentity,
    toString: () => JSON.stringify(publicIdentity()),
    [inspect.custom]: publicIdentity,
  });
}
