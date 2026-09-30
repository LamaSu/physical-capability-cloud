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
 * TENANT_ENFORCE, and must be the job's kernel operator or its recorded buyer
 * (authorizeJobRead). Anyone else, like a caller asking about a job that does not exist,
 * gets the route's own 404. An API key's operatorId or an email is never trusted as an
 * identity here: self-service provisioning lets anyone claim one.
 *
 * The routes that list or enumerate jobs use the same rule (F3 round 2, cross-family review
 * r1 of #403): jobReadScopeOf gives the set of jobs the caller may read (GET /api/jobs,
 * /api/telemetry/jobs and /active, /api/query's job intents), and the routes that mix
 * records of many jobs (log lines, the live log stream, sensor readings) leave out the
 * records of any other job, as if they did not exist (jobRecordFilterOf).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import {
  JOB_READ_REFUSAL,
  authorizeJobRead,
  jobReadCallerOf,
  jobsReadableBy,
  precheckJobRead,
  type JobExecutionRepos,
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
    // A missing job, a job in another tenant and a stranger's job all make the same kernel and
    // negotiation-session reads, so the time a refusal takes does not say which it was (review
    // r1 of #403, MEDIUM). For a missing job the reads are made and their answer discarded.
    const decision = authorizeJobRead(found ?? phantomJob(jobId), pre.wallet, store.repos as unknown as JobExecutionRepos, store.db);
    if (job && decision.allow) return { ok: true, job, as: decision.as };
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

/** A job row with no kernel, for the authorization reads made when the job does not exist. */
const phantomJob = (jobId: string): JobRow => ({
  id: jobId,
  stepId: "",
  cwmId: "",
  capabilityId: "",
  kernelId: "",
  status: "",
  startedAt: null,
  completedAt: null,
  progress: null,
});

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

/**
 * For a route that returns records of many jobs mixed with records of no job (log lines,
 * sensor readings): keeps a record that names no job, and a record that names a job only
 * when the caller may read that job (jobReadScopeOf). A caller with no credential or no
 * proven wallet keeps only the records that name no job. Refused only when the job or
 * authorization records could not be read.
 */
export type JobRecordFilter =
  | { ok: true; keep: (record: unknown) => boolean }
  | { ok: false; kind: "unavailable" };

export function jobRecordFilterOf(req: FastifyRequest): JobRecordFilter {
  const scope = jobReadScopeOf(req);
  if (!scope.ok && scope.kind === "unavailable") return { ok: false, kind: "unavailable" };
  return {
    ok: true,
    keep: (record) => {
      const jobId = (record as { jobId?: unknown } | null | undefined)?.jobId;
      if (jobId === undefined || jobId === null) return true;
      return scope.ok && scopeAllows(scope, jobId);
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
  gate: Extract<JobReadGate, { ok: false }> | Extract<JobReadScope, { ok: false }> | Extract<JobRecordFilter, { ok: false }>,
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
