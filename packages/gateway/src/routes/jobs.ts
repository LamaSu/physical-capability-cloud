import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getJobFacade } from "../facades/index.js";

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
      const result = await facade.list(
        { kernelId: req.query.kernelId, status: req.query.status },
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
   * Returns 404 if not found, 500 on error.
   */
  app.patch<{ Params: { jobId: string }; Body: { status: string; progress?: number } }>(
    "/api/jobs/:jobId/status",
    async (req, reply) => {
      const result = await facade.updateStatus(
        req.params.jobId,
        req.body.status,
        req.body.progress,
      );
      if (result.success) return { job: result.data };
      return sendResult(reply, result);
    },
  );
}
