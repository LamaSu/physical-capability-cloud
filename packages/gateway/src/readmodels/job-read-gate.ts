/**
 * The ONE gate for reads of a job's records (readmodels F3; gateway #2831 asked for one
 * shared helper, not copies). Every route that returns a job, its status, evidence, drift
 * alerts or money runs it first:
 *
 *   GET /api/jobs/:jobId              GET /api/jobs/:jobId/execution
 *   GET /api/jobs/:jobId/status       GET /api/jobs/:jobId/settlement
 *   GET /api/jobs/:jobId/evidence     GET /api/jobs/:jobId/drift-alerts
 *   GET /api/settlement/:jobId        GET /api/evidence/:jobId (the job-id form)
 *
 * Identity first (precheckJobRead, #353's review r3): an admin (valid X-Admin-Key) proceeds;
 * no credential is 401 and a credential without a PROVEN wallet is 403 identity_unverified,
 * both BEFORE the job row is read, so neither says whether the job exists. A proven wallet
 * (SIWE: WP-A's req.provenWallet) then needs the job: it reads the job row, applies
 * TENANT_ENFORCE, and must be the job's kernel operator or its recorded buyer
 * (authorizeJobRead). Anyone else, like a caller asking about a job that does not exist,
 * gets the route's own 404. An API key's operatorId or an email is never trusted as an
 * identity here: self-service provisioning lets anyone claim one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import {
  JOB_READ_REFUSAL,
  authorizeJobRead,
  jobReadCallerOf,
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
  let job: JobRow | undefined;
  try {
    store = getStore();
    job = store.repos.jobs.findById(jobId) as JobRow | undefined;
  } catch (error) {
    req.log.error({ jobId, err: error }, "job read gate: job row read failed");
    return { ok: false, kind: "unavailable" };
  }
  if (!job) return { ok: false, kind: "not_found" };

  const tenant = tenantOpts(req as any);
  if (tenant && (job.tenantId ?? null) !== tenant.tenantId) return { ok: false, kind: "not_found" };

  if (pre.as === "admin") return { ok: true, job, as: "admin" };
  try {
    const decision = authorizeJobRead(job, pre.wallet, store.repos as unknown as JobExecutionRepos, store.db);
    if (decision.allow) return { ok: true, job, as: decision.as };
    return { ok: false, kind: "not_found" };
  } catch (error) {
    req.log.error({ jobId, err: error }, "job read gate: authorization read failed");
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * Sends the refusal for a gate that did not pass. `notFound` is the route's own body for a
 * job that does not exist, so "not yours" and "no such job" are indistinguishable. The 401
 * and 403 bodies are the same for every job id.
 */
export function refuseJobRead(
  reply: FastifyReply,
  gate: Extract<JobReadGate, { ok: false }>,
  notFound: Record<string, unknown>,
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
