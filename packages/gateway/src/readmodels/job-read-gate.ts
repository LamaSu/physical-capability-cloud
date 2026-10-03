/**
 * The ONE gate for reads of a job's records (readmodels F3; gateway #2831 asked for one
 * shared helper, not copies). Every route that returns a job, its status, evidence, drift
 * alerts or money runs it first:
 *
 *   GET /api/jobs/:jobId              GET /api/jobs/:jobId/execution
 *   GET /api/jobs/:jobId/status       GET /api/jobs/:jobId/settlement
 *   GET /api/jobs/:jobId/evidence     GET /api/jobs/:jobId/drift-alerts
 *   GET /api/settlement/:jobId        GET /api/evidence/:jobId (the job-id form)
 *   GET /api/batches/by-job/:jobId    GET /api/telemetry/pipeline/:jobId
 *   GET /api/telemetry/logs?jobId=    GET /api/sensors/readings/:channel?jobId=
 *   GET /sse/stream/job/:jobId
 *   GET /api/compliance/evidence/:bundleId and its /tier-compliance, on the bundle's job
 *
 * (GET /api/print-and-mail/:jobId names a courier job, not a PCC job: it runs the same
 * identity precheck, then only an admin reads; see that route.)
 *
 * Identity first (precheckJobRead, #353's review r3): an admin (valid X-Admin-Key) proceeds;
 * no credential is 401 and a credential without a PROVEN wallet is 403 identity_unverified,
 * both BEFORE the job row is read, so neither says whether the job exists. A proven wallet
 * (SIWE: WP-A's req.provenWallet) then needs the job: it reads the job row, applies
 * TENANT_ENFORCE, and must be the job's kernel operator or its recorded buyer. Anyone else,
 * like a caller asking about a job that does not exist, gets the route's own 404. An API
 * key's operatorId or an email is never trusted as an identity here: self-service
 * provisioning lets anyone claim one.
 *
 * The authorization reads take only the caller's wallet (jobReaderOf; cross-family review r2
 * of #403, MEDIUM): the kernels it operates and the jobs whose single session names it. So a
 * refusal costs the same reads whether the job exists or not; only the requested row's own
 * lookup is keyed by the request.
 *
 * The routes that list or enumerate jobs use the same rule (F3 round 2): jobReadScopeOf
 * gives the set of jobs the caller may read (GET /api/jobs, /api/telemetry/jobs and /active,
 * /api/query's job intents).
 *
 * Records that belong to a KERNEL rather than one job (F3 round 3, review r2 of #403) take the
 * kernel's rule (gateKernelRead, kernelScopeOf): an admin or the kernel's operator. That is
 * the kernel, device and batch SSE streams, which carry job-bound sensor readings, and the
 * batch list and detail, whose slots name every sample's job and buyer. A job's buyer reads
 * its batches by job, where it sees only its own slots.
 *
 * Routes that mix records of many jobs and kernels (log lines, the live log stream, sensor
 * readings) keep a record only when the caller may read EVERY job and kernel it names, at any
 * depth (jobRecordFilterOf). A record that names neither is an admin's: its text can name any
 * job.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import {
  JOB_READ_REFUSAL,
  decideJobRead,
  jobReadCallerOf,
  jobReaderOf,
  jobsReadableBy,
  operatedKernelsOf,
  precheckJobRead,
  type JobRow,
} from "./job-execution.js";

export type JobReadGate =
  | { ok: true; job: JobRow; as: "admin" | "kernel_operator" | "buyer" }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" | "not_found" };

export function gateJobRead(req: FastifyRequest, jobId: string): JobReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };

  let store: ReturnType<typeof getStore>;
  let found: JobRow | undefined;
  try {
    store = getStore();
    found = store.repos.jobs.findById(jobId) as JobRow | undefined;
  } catch (error) {
    req.log.error({ jobId, err: error }, "job read gate: job row read failed");
    return { ok: false, kind: "unavailable" };
  }
  const tenant = tenantOpts(req as any);
  const job = found && inTenant(found, tenant) ? found : undefined;

  if (pre.as === "admin") return job ? { ok: true, job, as: "admin" } : { ok: false, kind: "not_found" };
  try {
    // The caller's reader is built for every request, whether or not the job exists or is in
    // the caller's tenant, from reads keyed by the wallet alone (review r2 of #403, MEDIUM).
    const reader = jobReaderOf(pre.wallet, store.repos, store.db);
    const decision = job ? decideJobRead(job, reader) : undefined;
    if (job && decision?.allow) return { ok: true, job, as: decision.as };
    return { ok: false, kind: "not_found" };
  } catch (error) {
    req.log.error({ jobId, err: error }, "job read gate: authorization read failed");
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * The gate for a record found by its own id (an evidence bundle) whose job decides who may
 * read it. Identity comes first, as in gateJobRead, before the record is looked up; then the
 * record's job is gated. A missing record, or one with no job, is not_found after the same
 * job and authorization reads a stranger's record costs.
 */
export function gateJobRecordRead(req: FastifyRequest, jobIdOfRecord: () => string | null | undefined): JobReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  let jobId: string | null | undefined;
  try {
    jobId = jobIdOfRecord();
  } catch (error) {
    req.log.error({ err: error }, "job read gate: record read failed");
    return { ok: false, kind: "unavailable" };
  }
  const gate = gateJobRead(req, jobId ?? "");
  if (!jobId && gate.ok) return { ok: false, kind: "not_found" };
  return gate;
}

/** TENANT_ENFORCE's rule, as the gate has applied it since #353: a tenant-less job matches only a tenant-less caller. */
const inTenant = (job: Pick<JobRow, "tenantId">, tenant: { tenantId: string | null } | undefined) =>
  !tenant || (job.tenantId ?? null) === tenant.tenantId;

/**
 * The gate for a record that belongs to a kernel (a kernel, a device or a batch): an admin or
 * the kernel's operator, as a proven wallet. Identity first, as in gateJobRead. A proven
 * wallet's operated kernels are read from its wallet alone, before `kernelIdOf` resolves the
 * record to its kernel (a device's or a batch's); anyone who does not operate that kernel gets
 * the not_found a missing kernel, device or batch gets. An admin reads any record that exists:
 * `kernelRow` says the record is the kernel itself, named only by its id, so its row must exist.
 */
export type KernelReadGate =
  | { ok: true; kernelId: string; as: "admin" | "kernel_operator" }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" | "not_found" };

export function gateKernelRead(
  req: FastifyRequest,
  kernelIdOf: () => string | null | undefined,
  opts: { kernelRow?: boolean } = {},
): KernelReadGate {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  let kernelId: string | undefined;
  let operated: ReadonlySet<string> | null = null;
  try {
    const store = getStore();
    if (pre.as !== "admin") operated = operatedKernelsOf(pre.wallet, store.repos);
    kernelId = kernelIdOf() ?? undefined;
    if (pre.as === "admin" && opts.kernelRow && kernelId !== undefined && store.repos.kernels.findById(kernelId) == null) {
      kernelId = undefined;
    }
  } catch (error) {
    req.log.error({ err: error }, "kernel read gate: record read failed");
    return { ok: false, kind: "unavailable" };
  }
  if (kernelId === undefined) return { ok: false, kind: "not_found" };
  if (pre.as === "admin") return { ok: true, kernelId, as: "admin" };
  // Operated kernels are registered kernels, so this also refuses a kernel that does not exist.
  return operated!.has(kernelId) ? { ok: true, kernelId, as: "kernel_operator" } : { ok: false, kind: "not_found" };
}

/** The kernels whose records this caller may read: null for an admin (all of them). */
export type KernelReadScope =
  | { ok: true; kernels: ReadonlySet<string> | null }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function kernelScopeOf(req: FastifyRequest): KernelReadScope {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  if (pre.as === "admin") return { ok: true, kernels: null };
  try {
    return { ok: true, kernels: operatedKernelsOf(pre.wallet, getStore().repos) };
  } catch (error) {
    req.log.error({ err: error }, "kernel read scope: kernel read failed");
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * The jobs this caller may read, for the routes that list jobs or read records keyed by a
 * job id. The refusals are gateJobRead's, in the same order. An admin reads every job, within
 * its tenant under TENANT_ENFORCE; a proven wallet reads the jobs whose kernel it operates or
 * whose single negotiation session names it as buyer (jobsReadableBy). `jobIds` is null when
 * every job id is readable, including ids with no job row (an admin without a tenant).
 */
export type JobReadScope =
  | { ok: true; as: "admin" | "proven"; jobIds: ReadonlySet<string> | null }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function jobReadScopeOf(req: FastifyRequest): JobReadScope {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return { ok: false, kind: pre.reason };
  const tenant = tenantOpts(req as any);
  if (pre.as === "admin" && !tenant) return { ok: true, as: "admin", jobIds: null };
  try {
    const store = getStore();
    const jobs = (store.repos.jobs.findAll() as JobRow[]).filter((job) => inTenant(job, tenant));
    if (pre.as === "admin") return { ok: true, as: "admin", jobIds: new Set(jobs.map((job) => job.id)) };
    return { ok: true, as: "proven", jobIds: jobsReadableBy(jobs, pre.wallet, store.repos, store.db) };
  } catch (error) {
    req.log.error({ err: error }, "job read scope: job or authorization read failed");
    return { ok: false, kind: "unavailable" };
  }
}

/** May a caller with this scope read the records of the job with this id? */
export function scopeAllows(scope: Extract<JobReadScope, { ok: true }>, jobId: unknown): boolean {
  return scope.jobIds === null || (typeof jobId === "string" && scope.jobIds.has(jobId));
}

/** Keys that bind a record to jobs or kernels, in any of the shapes producers use. */
const JOB_KEY = /^job_?id$/i;
const JOB_LIST_KEY = /^job_?ids$/i;
const KERNEL_KEY = /^kernel_?id$/i;
const KERNEL_LIST_KEY = /^kernel_?ids$/i;
const MAX_DEPTH = 8;

export interface RecordBindings {
  jobs: string[];
  kernels: string[];
  /** A binding key held something other than a nonempty string: the record cannot be placed. */
  malformed: boolean;
}

/**
 * Every job and kernel a record names, at any depth (up to MAX_DEPTH), in objects and arrays.
 * A binding key whose value is not a nonempty string, or a record nested deeper than
 * MAX_DEPTH, is malformed: the filter then keeps the record only for an unscoped admin.
 */
export function recordBindingsOf(record: unknown): RecordBindings {
  const out: RecordBindings = { jobs: [], kernels: [], malformed: false };
  const seen = new WeakSet<object>();
  const one = (value: unknown, into: string[]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value.trim() !== "") into.push(value);
    else out.malformed = true;
  };
  const many = (value: unknown, into: string[]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v) => one(v, into));
    else out.malformed = true;
  };
  const walk = (value: unknown, depth: number) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    if (depth > MAX_DEPTH) {
      out.malformed = true;
      return;
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (JOB_KEY.test(key)) one(child, out.jobs);
      else if (JOB_LIST_KEY.test(key)) many(child, out.jobs);
      else if (KERNEL_KEY.test(key)) one(child, out.kernels);
      else if (KERNEL_LIST_KEY.test(key)) many(child, out.kernels);
      else walk(child, depth + 1);
    }
  };
  walk(record, 0);
  return out;
}

/**
 * For a route that returns records of many jobs and kernels (log lines, sensor readings, live
 * telemetry): keeps a record only when the caller may read every job it names, and, when it
 * names no job, every kernel it names (the kernel's operator). A record that names neither is
 * kept only for an admin: free text such as a log message can name any job. A malformed
 * binding is kept only for an unscoped admin. Refused like the other gates: 401 without a
 * credential, 403 without a proven wallet, 503 when the records the rule needs cannot be read.
 */
export type JobRecordFilter =
  | { ok: true; keep: (record: unknown) => boolean }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "identity_unverified" };

export function jobRecordFilterOf(req: FastifyRequest): JobRecordFilter {
  const scope = jobReadScopeOf(req);
  if (!scope.ok) return scope;
  if (scope.as === "admin" && scope.jobIds === null) return { ok: true, keep: () => true };
  let operated: ReadonlySet<string> | null = null;
  if (scope.as === "proven") {
    const kernels = kernelScopeOf(req);
    if (!kernels.ok) return kernels;
    operated = kernels.kernels;
  }
  const admin = scope.as === "admin";
  return {
    ok: true,
    keep: (record) => {
      const bound = recordBindingsOf(record);
      if (bound.malformed) return false;
      if (bound.jobs.length > 0) return bound.jobs.every((jobId) => scopeAllows(scope, jobId));
      if (admin) return true;
      if (bound.kernels.length > 0) return operated !== null && bound.kernels.every((kernelId) => operated!.has(kernelId));
      return false;
    },
  };
}

/**
 * Sends the refusal for a gate or a scope that did not pass. `notFound` is the route's own
 * body for a job that does not exist, so "not yours" and "no such job" are indistinguishable
 * (a scope is never refused as not_found). The 401 and 403 bodies are the same for every
 * job id.
 */
export function refuseJobRead(
  reply: FastifyReply,
  gate:
    | Extract<JobReadGate, { ok: false }>
    | Extract<JobReadScope, { ok: false }>
    | Extract<JobRecordFilter, { ok: false }>
    | Extract<KernelReadGate, { ok: false }>
    | Extract<KernelReadScope, { ok: false }>,
  notFound: Record<string, unknown> = {},
) {
  if (gate.kind === "unavailable") {
    return reply.code(503).send({
      error: "read_model_unavailable",
      message: "The job record could not be read. Try again shortly.",
    });
  }
  if (gate.kind === "unauthenticated" || gate.kind === "identity_unverified") {
    const refusal = JOB_READ_REFUSAL[gate.kind];
    return reply.code(refusal.status).send(refusal.body);
  }
  return reply.code(404).send(notFound);
}
