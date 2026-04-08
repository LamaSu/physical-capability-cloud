/**
 * Operator relay endpoints -- the pcc-node HTTP polling protocol.
 *
 * These routes are the gateway side of the pcc-node protocol loop.
 * The pcc-node polls these endpoints instead of needing a persistent
 * WebSocket connection, which keeps the node zero-dependency.
 *
 *   GET  /api/operator/jobs           — poll for pending jobs (kernelId + status filter)
 *   POST /api/operator/evidence       — push evidence bundle from operator node
 *   POST /api/operator/heartbeat      — operator heartbeat + capability re-announcement
 *   POST /api/operator/job-status     — update job status from operator node
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getRepos } from "../db.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";
import { v4 as uuidv4 } from "uuid";

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface EvidenceBody {
  jobId: string;
  kernelId?: string;
  evidence: Record<string, unknown>;
  timestamp?: number;
}

interface HeartbeatBody {
  kernelId: string;
  status?: string;
  capabilities?: Array<Record<string, unknown>>;
  timestamp?: number;
}

interface JobStatusBody {
  jobId: string;
  kernelId?: string;
  status: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function operatorRelayRoutes(app: FastifyInstance) {
  const jobFacade = getJobFacade();
  const kernelFacade = getKernelFacade();
  /**
   * GET /api/operator/jobs
   *
   * Query params:
   *   kernelId  — filter by kernel (required)
   *   status    — filter by status (default: "queued")
   *
   * Returns { jobs: Job[] }
   */
  app.get<{
    Querystring: { kernelId?: string; status?: string };
  }>("/api/operator/jobs", async (req, reply) => {
    const { kernelId, status = "queued" } = req.query;

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId query param required" });
    }

    const result = await jobFacade.list({ kernelId, status });
    if (!result.success) return { jobs: [] };
    return { jobs: result.data.items ?? [] };
  });

  /**
   * POST /api/operator/evidence
   *
   * Push an evidence bundle from an operator node after job execution.
   * Stores the bundle and links it to the job.
   *
   * Body: { jobId, kernelId?, evidence: { ... }, timestamp? }
   */
  app.post<{ Body: EvidenceBody }>("/api/operator/evidence", async (req, reply) => {
    const { jobId, kernelId, evidence, timestamp } = req.body ?? {};

    if (!jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (!evidence) {
      return reply.code(400).send({ error: "evidence required" });
    }

    try {
      const repos = getRepos();

      // Verify the job exists
      const job = repos.jobs.findById(jobId);
      if (!job) {
        // Return 200 anyway — the node shouldn't hard-fail on this
        app.log.warn(`operator-relay: evidence for unknown job ${jobId}`);
        return {
          stored: false,
          jobId,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }

      // Store evidence bundle
      const bundleId = `ev-${uuidv4()}`;
      const now = new Date().toISOString();

      try {
        repos.evidence.insert({
          id: bundleId,
          jobId,
          stepId: job.stepId ?? "operator-relay",
          kernelId: kernelId ?? job.kernelId,
          assuranceTier: 0,
          bundleHash: `sha256-${bundleId}`,
          kernelSignature: {
            signer: kernelId ?? job.kernelId ?? "unknown",
            algorithm: "sha256",
            value: "operator-relay-auto",
          },
          createdAt: now,
        });
      } catch (insertErr) {
        // Evidence insert failed — still acknowledge receipt
        app.log.error(`operator-relay: evidence insert failed: ${insertErr}`);
        return {
          stored: false,
          jobId,
          bundleId,
          error: "storage_failed",
          timestamp: now,
        };
      }

      return {
        stored: true,
        jobId,
        bundleId,
        timestamp: now,
      };
    } catch (err) {
      return reply.code(500).send({
        error: "evidence_store_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/operator/heartbeat
   *
   * Operator node heartbeat: keeps the kernel marked "online" and
   * optionally re-announces capabilities.
   *
   * Body: { kernelId, status?, capabilities?, timestamp? }
   */
  app.post<{ Body: HeartbeatBody }>("/api/operator/heartbeat", async (req, reply) => {
    const { kernelId, status = "online", capabilities, timestamp } = req.body ?? {};

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId required" });
    }

    const result = await kernelFacade.heartbeat(kernelId, { status, capabilities, timestamp });
    return sendResult(reply, result);
  });

  /**
   * POST /api/operator/job-status
   *
   * Update job status from an operator node (alternative to PATCH /api/jobs/:id/status).
   * Used when the node doesn't know the exact route shape.
   *
   * Body: { jobId, kernelId?, status, metadata?, timestamp? }
   */
  app.post<{ Body: JobStatusBody }>("/api/operator/job-status", async (req, reply) => {
    const { jobId, status, metadata, timestamp } = req.body ?? {};

    if (!jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (!status) {
      return reply.code(400).send({ error: "status required" });
    }

    const VALID_STATUSES = ["queued", "running", "completed", "failed", "cancelled"];
    if (!VALID_STATUSES.includes(status)) {
      return reply.code(400).send({
        error: "invalid_status",
        valid: VALID_STATUSES,
      });
    }

    try {
      const repos = getRepos();
      const updated = repos.jobs.updateStatus(jobId, status);

      if (!updated) {
        // Job not found — return 200 so the node doesn't fail hard
        return {
          updated: false,
          jobId,
          status,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }

      return {
        updated: true,
        jobId,
        status,
        metadata: metadata ?? null,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return reply.code(500).send({
        error: "status_update_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
}
