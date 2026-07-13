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
import { JOB_STATUSES, normalizeJobStatus } from "../config/job-status.js";
import { extractNodeSignedBundle } from "../services/device-evidence-settlement.js";
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

      // SEAM-2 (path 1): capture the node's REAL device (#236) Ed25519 signature and
      // real bundleHash when the pushed evidence carries a signed bundle — instead of
      // discarding the signature and writing a gateway placeholder. This only
      // PERSISTS the truth of what the device signed; it does NOT verify it or gate
      // settlement. The oracle #52 verifier (stubbed, fail-closed) still owns whether
      // this evidence may settle. Old nodes / non-bundle evidence fall back to the
      // placeholder, unchanged.
      //
      // assuranceTier stays 0 ON PURPOSE (fails closed): an UNVERIFIED bundle
      // "actually supports" only the tier-0 permissionless floor (eligibility.ts).
      // The node's self-declared tier is a claim, not proof — trusting it here would
      // let resume-settlement's `?? latestBundle.assuranceTier` fallback escalate the
      // release tier from unverified evidence. The tier is lifted only once the gated
      // #52 verifier confirms the evidence on deployed infra (SEAM-2 ready-but-gated).
      const captured = extractNodeSignedBundle(evidence);
      const bundleHash = captured?.bundleHash ?? `sha256-${bundleId}`;
      const kernelSignature = captured
        ? captured.kernelSignature
        : {
            signer: kernelId ?? job.kernelId ?? "unknown",
            algorithm: "sha256",
            value: "operator-relay-auto",
          };

      try {
        repos.evidence.insert({
          id: bundleId,
          jobId,
          stepId: job.stepId ?? "operator-relay",
          kernelId: kernelId ?? job.kernelId,
          assuranceTier: 0,
          bundleHash,
          kernelSignature,
          sessionKeyAuthorization: captured?.sessionKeyAuthorization ?? null,
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
        // True when the node's real device-signed (#236) bundle was captured
        // (real Ed25519 signature persisted); false when the placeholder was used.
        deviceSigned: !!captured,
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

    // Same canonical vocabulary as PATCH /api/jobs/:id/status — tolerate the
    // documented `running` alias, normalise to `in_progress` before storing.
    const canonicalStatus = normalizeJobStatus(status);
    if (!canonicalStatus) {
      return reply.code(400).send({
        error: "invalid_status",
        valid: [...JOB_STATUSES],
      });
    }

    try {
      const repos = getRepos();
      const updated = repos.jobs.updateStatus(jobId, canonicalStatus);

      if (!updated) {
        // Job not found — return 200 so the node doesn't fail hard
        return {
          updated: false,
          jobId,
          status: canonicalStatus,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }

      return {
        updated: true,
        jobId,
        status: canonicalStatus,
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
