/**
 * Operator reads and actions that return only what the gateway returned.
 *
 * Every call resolves to a Result. A network failure, a non-2xx status or a
 * body without the field that confirms the effect is `{ ok: false }` with a
 * reason, never a plausible stand-in value. The operator pages used to invent
 * an evidence CID, an anti-spoof score, a verification match, an "issue filed"
 * receipt and a STOPPED machine whenever a request failed; this module is the
 * one place those requests are made now, so that cannot come back silently.
 *
 * The e-stop is the sharpest case: a machine is STOPPED only when the gateway
 * answered `{ stopped: true }` for that kernel. Anything else is NOT STOPPED,
 * and the page tells the operator to use the machine's physical stop.
 */

import type { AgentMeDTO, JobDTO } from "../types/dto.js";
import { getAuthHeaders } from "../stores/auth-store.js";

/**
 * The signed-in operator's machines from GET /api/agent/me, or null when that
 * section is missing, malformed or reported unavailable (never an empty list).
 */
export function kernelsOf(me: AgentMeDTO | undefined): AgentMeDTO["kernels"]["items"] | null {
  const k = me?.kernels;
  if (!k || k.unavailable || !Array.isArray(k.items)) return null;
  return k.items;
}

const API_ROOT: string = import.meta.env.VITE_PCC_URL ?? "";

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; reason: string };

type Fetch = typeof fetch;

type Reply =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status?: number; reason: string };

/** Plain-words reason for a failed reply, preferring the gateway's own message. */
function reasonFrom(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const msg = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : null;
    if (msg) return `${status}: ${msg.slice(0, 160)}`;
  }
  return `The gateway answered ${status}.`;
}

async function call(path: string, init: RequestInit | undefined, fetchImpl: Fetch): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...getAuthHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    return { ok: false, reason: "The gateway could not be reached." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return { ok: false, status: res.status, reason: reasonFrom(res.status, body) };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: res.status, reason: "The gateway's answer was not in the expected shape." };
  }
  return { ok: true, status: res.status, body: body as Record<string, unknown> };
}

function fail<T>(reply: Extract<Reply, { ok: false }>): Result<T> {
  return { ok: false, status: reply.status, reason: reply.reason };
}

function malformed<T>(what: string, status?: number): Result<T> {
  return { ok: false, status, reason: `The gateway's answer did not confirm ${what}.` };
}

// ── Emergency stop ──────────────────────────────────────────────────────────

export type StopOutcome =
  | { kernelId: string; state: "stopped"; at: string | null }
  | { kernelId: string; state: "not_stopped"; reason: string; status?: number };

/**
 * POST /api/operator/emergency-stop for one kernel. STOPPED only on
 * `{ stopped: true, kernelId }` for this kernel.
 */
export async function emergencyStop(kernelId: string, reason?: string, fetchImpl: Fetch = fetch): Promise<StopOutcome> {
  const reply = await call(
    "/api/operator/emergency-stop",
    { method: "POST", body: JSON.stringify({ kernelId, reason: reason ?? "operator pressed stop" }) },
    fetchImpl,
  );
  if (!reply.ok) return { kernelId, state: "not_stopped", reason: reply.reason, status: reply.status };
  if (reply.body.stopped !== true || reply.body.kernelId !== kernelId) {
    return { kernelId, state: "not_stopped", reason: "The gateway did not confirm the stop for this machine.", status: reply.status };
  }
  return { kernelId, state: "stopped", at: typeof reply.body.timestamp === "string" ? reply.body.timestamp : null };
}

export type ResumeOutcome =
  | { kernelId: string; state: "resumed" }
  | { kernelId: string; state: "not_resumed"; reason: string; status?: number };

/** POST /api/operator/emergency-resume. Resumed only on `{ resumed: true, kernelId }`. */
export async function emergencyResume(kernelId: string, fetchImpl: Fetch = fetch): Promise<ResumeOutcome> {
  const reply = await call("/api/operator/emergency-resume", { method: "POST", body: JSON.stringify({ kernelId }) }, fetchImpl);
  if (!reply.ok) return { kernelId, state: "not_resumed", reason: reply.reason, status: reply.status };
  if (reply.body.resumed !== true || reply.body.kernelId !== kernelId) {
    return { kernelId, state: "not_resumed", reason: "The gateway did not confirm the resume for this machine.", status: reply.status };
  }
  return { kernelId, state: "resumed" };
}

export interface StopState {
  /** The recorded policy says this kernel is emergency-stopped. */
  stopped: boolean;
  /** False when the gateway answered with its default policy: nothing is recorded for this kernel. */
  recorded: boolean;
  updatedAt: string | null;
}

/** GET /api/operator/policy/:kernelId — the recorded emergency-stop flag. */
export async function readStopState(kernelId: string, fetchImpl: Fetch = fetch): Promise<Result<StopState>> {
  const reply = await call(`/api/operator/policy/${encodeURIComponent(kernelId)}`, undefined, fetchImpl);
  if (!reply.ok) return fail(reply);
  const policy = reply.body.policy;
  if (!policy || typeof policy !== "object") return malformed("this machine's stop state", reply.status);
  return {
    ok: true,
    data: {
      stopped: (policy as Record<string, unknown>).emergencyStop === true,
      recorded: reply.body.source !== "default",
      updatedAt: typeof reply.body.updatedAt === "string" ? reply.body.updatedAt : null,
    },
  };
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** One pending approval, as the gateway stores it (routes/operator.ts pendingApprovals). */
export interface PendingApproval {
  id: string;
  kernelId: string;
  jobId: string | null;
  requestedBy: string | null;
  capabilityType: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

function toPendingApproval(row: unknown): PendingApproval | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.kernelId !== "string") return null;
  const summary = r.jobSummary && typeof r.jobSummary === "object" ? (r.jobSummary as Record<string, unknown>) : null;
  return {
    id: r.id,
    kernelId: r.kernelId,
    jobId: typeof r.jobId === "string" ? r.jobId : null,
    requestedBy: typeof r.submittedBy === "string" ? r.submittedBy : null,
    capabilityType: summary && typeof summary.capabilityType === "string" ? summary.capabilityType : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
  };
}

/**
 * Pending approvals for the operator's own kernels, one read per kernel.
 * If any kernel's read fails the whole list is unavailable: a partial list
 * would read as "nothing else is waiting".
 */
export async function listPendingApprovals(kernelIds: string[], fetchImpl: Fetch = fetch): Promise<Result<PendingApproval[]>> {
  const mine = new Set(kernelIds);
  const out: PendingApproval[] = [];
  for (const kernelId of kernelIds) {
    const qs = new URLSearchParams({ kernelId, status: "pending" });
    const reply = await call(`/api/operator/approvals?${qs.toString()}`, undefined, fetchImpl);
    if (!reply.ok) return fail(reply);
    if (!Array.isArray(reply.body.approvals)) return malformed("the pending approvals", reply.status);
    for (const row of reply.body.approvals) {
      const a = toPendingApproval(row);
      if (a && mine.has(a.kernelId) && (row as Record<string, unknown>).status === "pending") out.push(a);
    }
  }
  return { ok: true, data: out };
}

/** Approve or reject. Done only on `{ approved: true }` / `{ rejected: true }`. */
export async function decideApproval(
  id: string,
  action: "approve" | "reject",
  fetchImpl: Fetch = fetch,
): Promise<Result<{ id: string; status: "approved" | "rejected" }>> {
  const reply = await call(
    `/api/operator/approvals/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify({}) },
    fetchImpl,
  );
  if (!reply.ok) return fail(reply);
  const confirmed = action === "approve" ? reply.body.approved === true : reply.body.rejected === true;
  if (!confirmed) return malformed(`the ${action === "approve" ? "approval" : "rejection"}`, reply.status);
  return { ok: true, data: { id, status: action === "approve" ? "approved" : "rejected" } };
}

// ── Jobs on the operator's kernels ──────────────────────────────────────────

/** GET /api/jobs?kernelId= for each of the operator's kernels; `{ jobs }` is unwrapped. */
export async function listKernelJobs(kernelIds: string[], fetchImpl: Fetch = fetch): Promise<Result<JobDTO[]>> {
  const out: JobDTO[] = [];
  for (const kernelId of kernelIds) {
    const reply = await call(`/api/jobs?${new URLSearchParams({ kernelId }).toString()}`, undefined, fetchImpl);
    if (!reply.ok) return fail(reply);
    if (!Array.isArray(reply.body.jobs)) return malformed("the job list", reply.status);
    out.push(...(reply.body.jobs as JobDTO[]));
  }
  return { ok: true, data: out };
}

// ── Machine registration ────────────────────────────────────────────────────

/** GET /api/onboard/registrations/:id. The route answers `{ error: "not_found" }` with HTTP 200 when missing. */
export async function readRegistration(
  id: string,
  fetchImpl: Fetch = fetch,
): Promise<Result<{ found: false } | { found: true; registration: Record<string, unknown> }>> {
  const reply = await call(`/api/onboard/registrations/${encodeURIComponent(id)}`, undefined, fetchImpl);
  if (!reply.ok) {
    if (reply.status === 404) return { ok: true, data: { found: false } };
    return fail(reply);
  }
  if (reply.body.error === "not_found") return { ok: true, data: { found: false } };
  const reg = reply.body.registration;
  if (!reg || typeof reg !== "object") return malformed("this registration", reply.status);
  return { ok: true, data: { found: true, registration: reg as Record<string, unknown> } };
}

// ── Photo check (not job evidence) ──────────────────────────────────────────

export interface PhotoCheck {
  imageHash: string;
  /** What the gateway calls the photo. `photo:<hash>` means it kept a hash reference only. */
  cid: string;
  /** False when the gateway kept a hash reference only (no storage service wired). */
  stored: boolean;
  antiSpoofScore: number | null;
}

/** The base64 payload of a `data:` URL (what the photo routes expect). */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** POST /api/photo/upload `{ imageBase64 }`. */
export async function checkPhoto(imageBase64: string, fetchImpl: Fetch = fetch): Promise<Result<PhotoCheck>> {
  const reply = await call("/api/photo/upload", { method: "POST", body: JSON.stringify({ imageBase64 }) }, fetchImpl);
  if (!reply.ok) return fail(reply);
  const { imageHash, cid, antiSpoofScore } = reply.body;
  if (typeof imageHash !== "string" || typeof cid !== "string") return malformed("the photo was received", reply.status);
  return {
    ok: true,
    data: {
      imageHash,
      cid,
      stored: !cid.startsWith("photo:"),
      antiSpoofScore: typeof antiSpoofScore === "number" ? antiSpoofScore : null,
    },
  };
}

export interface PhotoComparison {
  verdict: string | null;
  matchScore: number | null;
  discrepancies: string[];
  reasoning: string | null;
  modelUsed: string | null;
}

/** POST /api/photo/compare `{ capturedImageBase64, referenceImageBase64 }` — an AI opinion, not verification. */
export async function comparePhotos(
  capturedImageBase64: string,
  referenceImageBase64: string,
  fetchImpl: Fetch = fetch,
): Promise<Result<PhotoComparison>> {
  const reply = await call(
    "/api/photo/compare",
    { method: "POST", body: JSON.stringify({ capturedImageBase64, referenceImageBase64 }) },
    fetchImpl,
  );
  if (!reply.ok) return fail(reply);
  const b = reply.body;
  if (typeof b.verdict !== "string" && typeof b.matchScore !== "number") return malformed("a comparison result", reply.status);
  return {
    ok: true,
    data: {
      verdict: typeof b.verdict === "string" ? b.verdict : null,
      matchScore: typeof b.matchScore === "number" ? b.matchScore : null,
      discrepancies: Array.isArray(b.discrepancies) ? b.discrepancies.filter((d): d is string => typeof d === "string") : [],
      reasoning: typeof b.reasoning === "string" ? b.reasoning : null,
      modelUsed: typeof b.modelUsed === "string" ? b.modelUsed : null,
    },
  };
}

// ── Support ─────────────────────────────────────────────────────────────────

/** POST /api/operator/support. Sent only when the gateway returns a thread id. */
export async function sendSupportReport(
  input: { kernelId: string; message: string; subject?: string },
  fetchImpl: Fetch = fetch,
): Promise<Result<{ threadId: string; isNewThread: boolean }>> {
  const reply = await call(
    "/api/operator/support",
    { method: "POST", body: JSON.stringify({ kernelId: input.kernelId, message: input.message, subject: input.subject }) },
    fetchImpl,
  );
  if (!reply.ok) return fail(reply);
  if (typeof reply.body.threadId !== "string") return malformed("your report was received", reply.status);
  return { ok: true, data: { threadId: reply.body.threadId, isNewThread: reply.body.isNewThread === true } };
}
