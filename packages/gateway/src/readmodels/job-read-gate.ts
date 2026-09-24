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
 * It reads the job row, applies TENANT_ENFORCE, and authorizes the caller with
 * authorizeJobRead: an admin (valid X-Admin-Key), the job's kernel operator, or its
 * recorded buyer. Anonymous callers get 401. Anyone else, like a caller asking about a job
 * that does not exist, gets the route's own 404, so the answer reveals nothing about the
 * job's existence.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { authorizeJobRead, type JobExecutionRepos, type JobRow } from "./job-execution.js";

export type JobReadGate =
  | { ok: true; job: JobRow; as: "admin" | "kernel_operator" | "buyer" }
  | { ok: false; kind: "unavailable" | "unauthenticated" | "not_found" };

export function gateJobRead(req: FastifyRequest, jobId: string): JobReadGate {
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

  const principal = ((req as any).operatorId ?? (req as any).userId ?? null) as string | null;
  const adminHeader = req.headers["x-admin-key"];
  try {
    const decision = authorizeJobRead(
      job,
      { principal, adminKey: typeof adminHeader === "string" ? adminHeader : null },
      store.repos as unknown as JobExecutionRepos,
      store.db,
    );
    if (decision.allow) return { ok: true, job, as: decision.as };
    return { ok: false, kind: decision.reason === "unauthenticated" ? "unauthenticated" : "not_found" };
  } catch (error) {
    req.log.error({ jobId, err: error }, "job read gate: authorization read failed");
    return { ok: false, kind: "unavailable" };
  }
}

/**
 * Sends the refusal for a gate that did not pass. `notFound` is the route's own body for a
 * job that does not exist, so "not yours" and "no such job" are indistinguishable.
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
  if (gate.kind === "unauthenticated") {
    return reply.code(401).send({ error: "unauthenticated", message: "Sign in or send an API key to read a job." });
  }
  return reply.code(404).send(notFound);
}
