import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getJobFacade } from "../facades/index.js";
import { getRepos, getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { JOB_STATUSES, normalizeJobStatus } from "../config/job-status.js";
import {
  authorizeJobRead,
  buildJobExecutionDTO,
  loadJobExecutionSources,
  type JobExecutionRepos,
  type JobRow,
} from "../readmodels/job-execution.js";

// ── Result→HTTP helper ────────────────────────────────────────────────────────

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function jobRoutes(app: FastifyInstance) {
  const facade = getJobFacade();

  /**
   * List jobs with optional kernel/status filtering and DTO enrichment.
   * Supports: ?kernelId=, ?status=, or both.
   */
  app.get<{ Querystring: { kernelId?: string; status?: string; offset?: number; limit?: number } }>(
    "/api/jobs",
    async (req, reply) => {
      const asOf = new Date().toISOString();
      // Wave 4.1.x — pass through tenant filter when TENANT_ENFORCE=true.
      // Default OFF preserves cross-tenant listing (today's behavior).
      const tOpts = tenantOpts(req as any);
      const result = await facade.list(
        {
          kernelId: req.query.kernelId,
          status: req.query.status,
          ...(tOpts?.tenantId ? { tenantId: tOpts.tenantId } : {}),
        },
        {},
        { offset: req.query.offset, limit: req.query.limit },
      );
      if (result.success) {
        // Backward-compatible envelope: { jobs }, plus collection-v1 `items` (the closed
        // render IR's list shape), the page (`total` is ALL matching jobs, not the page
        // length) and `asOf` = when the gateway read the rows.
        const { items, total, offset, limit, hasMore } = result.data;
        return { jobs: items, items, total, offset, limit, hasMore, asOf };
      }
      return sendResult(reply, result);
    },
  );

  /**
   * Get a single job by ID with evidence bundles and timeline.
   * Returns 404 when not found (previously returned 200 with { error: "not_found" }).
   */
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (req, reply) => {
    const result = await facade.getById(req.params.jobId);
    if (result.success) {
      const { evidenceBundles, ...job } = result.data;
      // Preserve backward-compat shape: { job, evidence }
      return { job, evidence: evidenceBundles };
    }
    return sendResult(reply, result);
  });

  /**
   * Product read model for one job (PX-6): JobExecutionDTO from @pcc/spec.
   * Four independent axes (execution, evidence, verification, settlement), each
   * naming its source; nothing is inferred across axes, and a source that cannot be
   * read is reported `unavailable`, never defaulted.
   *
   * Object-authorized before any axis is read (authorizeJobRead): an admin, the job's
   * kernel operator, or its recorded buyer. Anonymous callers get 401; anyone else gets
   * 404 (no existence oracle), whatever TENANT_ENFORCE says. Under TENANT_ENFORCE a job
   * of another tenant is also a 404.
   */
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/execution", async (req, reply) => {
    const asOf = new Date().toISOString();
    const notFound = () =>
      reply.code(404).send({ error: "not_found", message: `job '${req.params.jobId}' not found` });
    let store;
    let job: JobRow | undefined;
    try {
      store = getStore();
      job = store.repos.jobs.findById(req.params.jobId) as JobRow | undefined;
    } catch (error) {
      req.log.error({ jobId: req.params.jobId, err: error }, "job execution read model: job row read failed");
      return reply.code(503).send({
        error: "read_model_unavailable",
        message: "The job record could not be read. Try again shortly.",
      });
    }
    if (!job) return notFound();

    const tenant = tenantOpts(req as any);
    if (tenant && (job.tenantId ?? null) !== tenant.tenantId) return notFound();

    const principal = ((req as any).operatorId ?? (req as any).userId ?? null) as string | null;
    const adminHeader = req.headers["x-admin-key"];
    let decision;
    try {
      decision = authorizeJobRead(
        job,
        { principal, adminKey: typeof adminHeader === "string" ? adminHeader : null },
        store.repos as unknown as JobExecutionRepos,
        store.db,
      );
    } catch (error) {
      req.log.error({ jobId: req.params.jobId, err: error }, "job execution read model: authorization read failed");
      return reply.code(503).send({
        error: "read_model_unavailable",
        message: "The job record could not be read. Try again shortly.",
      });
    }
    if (!decision.allow) {
      if (decision.reason === "unauthenticated") {
        return reply.code(401).send({ error: "unauthenticated", message: "Sign in or send an API key to read a job." });
      }
      return notFound();
    }

    const sources = loadJobExecutionSources(job, store.repos as unknown as JobExecutionRepos, store.db, {
      tenant,
      onReadError: (source, error) =>
        req.log.warn({ jobId: req.params.jobId, source, err: error }, "job execution read model: source read failed"),
    });
    reply.header("cache-control", "no-store");
    return buildJobExecutionDTO(sources, asOf);
  });

  /**
   * Update job status (and optional progress).
   * Security: validates status against allowlist AND verifies caller ownership
   * (must be the kernel operator assigned to the job OR the job submitter).
   */
  app.patch<{ Params: { jobId: string }; Body: { status: string; progress?: number } }>(
    "/api/jobs/:jobId/status",
    async (req, reply) => {
      const { status, progress } = req.body;

      // Validate against the canonical allowlist (prevents status injection),
      // tolerating documented input aliases (e.g. "running" → "in_progress").
      const canonicalStatus = normalizeJobStatus(status);
      if (!canonicalStatus) {
        return reply.code(400).send({
          error: "invalid_status",
          message: `Status must be one of: ${JOB_STATUSES.join(", ")}`,
        });
      }

      // Verify the caller is the kernel operator or the job submitter
      const operatorId = (req as any).operatorId ?? (req as any).userId;
      if (operatorId) {
        const repos = getRepos();
        const job = repos.jobs.findById(req.params.jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });

        let isAuthorized = false;
        if ((job as any).submittedBy === operatorId) isAuthorized = true;
        if (!isAuthorized && (job as any).kernelId) {
          const kernel = repos.kernels.findById((job as any).kernelId);
          if (kernel && (kernel as any).operatorId === operatorId) isAuthorized = true;
        }
        if (!isAuthorized) {
          return reply.code(403).send({ error: "forbidden", message: "You can only update status for your own jobs" });
        }
      }

      const result = await facade.updateStatus(
        req.params.jobId,
        canonicalStatus,
        progress,
      );
      if (result.success) return { job: result.data };
      return sendResult(reply, result);
    },
  );
}
