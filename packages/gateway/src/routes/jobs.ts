import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";

export async function jobRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { kernelId?: string; status?: string } }>(
    "/api/jobs",
    async (req) => {
      try {
        const repos = getRepos();
        let jobs;
        if (req.query.kernelId && req.query.status) {
          jobs = repos.jobs.findByKernelAndStatus(req.query.kernelId, req.query.status);
        } else if (req.query.kernelId) {
          jobs = repos.jobs.findByKernel(req.query.kernelId);
        } else if (req.query.status) {
          jobs = repos.jobs.findByStatus(req.query.status);
        } else {
          jobs = repos.jobs.findAll();
        }
        return { jobs };
      } catch {
        return { jobs: [] };
      }
    },
  );

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (req) => {
    try {
      const repos = getRepos();
      const job = repos.jobs.findById(req.params.jobId);
      if (!job) return { error: "not_found" };

      // Also fetch evidence bundles for this job
      const evidence = repos.evidence.findByJob(req.params.jobId);
      return { job, evidence };
    } catch {
      return { error: "db_unavailable" };
    }
  });

  // Valid job status transitions (prevent arbitrary status injection)
  const VALID_STATUSES = new Set([
    "pending", "queued", "in_progress", "paused",
    "completed", "failed", "cancelled",
  ]);

  app.patch<{ Params: { jobId: string }; Body: { status: string; progress?: number } }>(
    "/api/jobs/:jobId/status",
    async (req, reply) => {
      try {
        const { status, progress } = req.body;

        // Validate status against allowlist (prevents status injection attacks)
        if (!VALID_STATUSES.has(status)) {
          return reply.code(400).send({
            error: "invalid_status",
            message: `Status must be one of: ${[...VALID_STATUSES].join(", ")}`,
          });
        }

        // Verify the caller is the kernel/operator assigned to this job
        const operatorId = (req as any).operatorId ?? (req as any).userId;
        const repos = getRepos();
        const job = repos.jobs.findById(req.params.jobId);
        if (!job) return reply.code(404).send({ error: "not_found" });

        // Only the assigned kernel operator or the job submitter can update status
        if (operatorId) {
          let isAuthorized = false;

          // Check if caller is the job submitter
          if ((job as any).submittedBy === operatorId) isAuthorized = true;

          // Check if caller is the kernel operator (when kernel exists)
          if (!isAuthorized && (job as any).kernelId) {
            const kernel = repos.kernels.findById((job as any).kernelId);
            if (kernel && (kernel as any).operatorId === operatorId) isAuthorized = true;
          }

          if (!isAuthorized) {
            return reply.code(403).send({ error: "forbidden", message: "You can only update status for your own jobs" });
          }
        }

        const updated = repos.jobs.updateStatus(req.params.jobId, status, progress);
        if (!updated) return reply.code(404).send({ error: "not_found" });
        return { job: updated };
      } catch (err: unknown) {
        return reply.code(500).send({
          error: "update_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  );
}
