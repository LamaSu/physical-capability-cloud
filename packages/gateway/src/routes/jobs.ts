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

  app.patch<{ Params: { jobId: string }; Body: { status: string; progress?: number } }>(
    "/api/jobs/:jobId/status",
    async (req, reply) => {
      try {
        const repos = getRepos();
        const updated = repos.jobs.updateStatus(
          req.params.jobId,
          req.body.status,
          req.body.progress,
        );
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
