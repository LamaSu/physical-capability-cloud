import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getJobFacade } from "../facades/index.js";
import { getRepos } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";

// Valid job status transitions (prevent arbitrary status injection)
const VALID_STATUSES = new Set([
  "pending", "queued", "in_progress", "paused",
  "completed", "failed", "cancelled",
]);

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
        // Backward-compatible envelope: { jobs } — same shape clients expect
        return { jobs: result.data.items };
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
   * Update job status (and optional progress).
   * Security: validates status against allowlist AND verifies caller ownership
   * (must be the kernel operator assigned to the job OR the job submitter).
   */
  app.patch<{ Params: { jobId: string }; Body: { status: string; progress?: number } }>(
    "/api/jobs/:jobId/status",
    async (req, reply) => {
      const { status, progress } = req.body;

      // Validate status against allowlist (prevents status injection attacks)
      if (!VALID_STATUSES.has(status)) {
        return reply.code(400).send({
          error: "invalid_status",
          message: `Status must be one of: ${[...VALID_STATUSES].join(", ")}`,
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
        status,
        progress,
      );
      if (result.success) return { job: result.data };
      return sendResult(reply, result);
    },
  );
}
