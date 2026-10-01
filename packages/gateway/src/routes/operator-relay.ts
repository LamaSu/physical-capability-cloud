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
 *
 * AUTHORITY. Every route here is for the kernel's operator, never for "any key"
 * (apiGate admits any key and provisioning is public):
 *   - heartbeat (WP-C): the owner of the kernel in the body;
 *   - jobs, evidence, job-status (N85 b, LIVE): the owner of the kernel the
 *     query / the JOB names, or the admin secret. Same rule as GET
 *     /api/operator/policy/:kernelId (operator.ts). Order: a presented admin
 *     secret must be the right one (401/403/503), else a PRESENT actor (401
 *     before any body validation, steward rule 7); then the body (400), then the
 *     job lookup (404), then the owner of the JOB's kernel (403
 *     not_kernel_owner; a kernel with no recorded owner is the admin's alone).
 *     Nothing is written or listed on a refusal.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Result } from "@pcc/spec";
import { getRepos } from "../db.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";
import {
  INVALID_ACCEPTING_JOBS_CODE,
  INVALID_ACCEPTING_JOBS_MESSAGE,
  isValidAcceptingJobs,
} from "../facades/kernel.facade.js";
import { checkKernelAcceptsJobs, replyKernelNotAccepting } from "../services/kernel-emergency-stop.js";
import { requireActor, requireOwnerOf } from "../auth/kernel-owner-guard.js";
import { presentsAdminSecret, requireAdminSecret } from "../auth/admin-secret-gate.js";
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
  /** Optional boolean. `false`: a node that takes no jobs (see HeartbeatInput). Anything else but a boolean is a 400. */
  acceptingJobs?: boolean;
}

interface JobStatusBody {
  jobId: string;
  kernelId?: string;
  status: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Statuses that are not work for a node to start. GET /api/operator/jobs lists
 * these even for a kernel in emergency stop; every other status (queued,
 * pending, paused, and any a later version adds) is held back.
 */
const STATUSES_NOT_TO_START: ReadonlySet<string> = new Set([
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Who is asking (N85 b)
// ---------------------------------------------------------------------------

/** The admin (a valid admin secret), or an authenticated actor whose ownership is still to be checked. */
type RelayCaller = { admin: true } | { admin: false; actor: string };

/**
 * The first step of every owner-or-admin relay route: exactly the pattern of GET
 * /api/operator/policy/:kernelId (operator.ts), over the same helpers, with no
 * rule of its own.
 *   - A request that PRESENTS the admin secret must present the RIGHT one
 *     (requireAdminSecret: 401 blank, 403 wrong, 503 unconfigured). A bad secret
 *     is refused, never downgraded to the key's owner authority.
 *   - Otherwise a PRESENT actor is required (requireActor: 401), before any body
 *     validation or lookup (steward rule 7), so nothing is ever looked up for a
 *     caller who is nobody.
 * Returns null after sending the refusal. A non-admin caller's ownership is then
 * checked by the handler with requireOwnerOf, against the kernel the JOB (or the
 * query) names: a body `kernelId` is a claim, never an identity.
 */
function requireRelayCaller(req: FastifyRequest, reply: FastifyReply): RelayCaller | null {
  if (presentsAdminSecret(req)) {
    return requireAdminSecret(req, reply) ? { admin: true } : null;
  }
  const actor = requireActor(req, reply);
  return actor ? { admin: false, actor } : null;
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
   * OWNER-OR-ADMIN (N85 b, LIVE): the job queue of a kernel belongs to its
   * operator. Before, any key listed any kernel's queue (the job ids the two
   * writes below act on). Now the caller must present the admin secret or own
   * the kernel named by `kernelId` (401 no identity, 404 unknown kernel, 403
   * not_kernel_owner; a kernel with no recorded owner is the admin's alone).
   * `kernelId` stays required for everyone, the admin included: there is no
   * list-everything form (400), and it must be a single string (a repeated
   * ?kernelId= is a 400).
   *
   * Query params:
   *   kernelId  — filter by kernel (required)
   *   status    — filter by status (default: "queued")
   *
   * Returns { jobs: Job[] }
   *
   * EMERGENCY STOP. This is the queue a node polls for work, so a kernel in
   * emergency stop hands out none: the answer is 200 `{ jobs: [], emergencyStop:
   * true }` for every status except those that are not work to start
   * (in_progress, completed, failed, cancelled). Queued, pending and paused jobs
   * stay in the table and are handed out again once the kernel is resumed. (The
   * stop itself only rejects pending APPROVALS, never queued jobs.) It is a 200
   * and not an error on purpose: the pcc-node client treats a non-200 as "no
   * jobs", but on a 404 it falls back to the public GET /api/jobs list, so the
   * answer must never be a 404 and must not read as a fault; to a client that
   * knows nothing of the flag an empty queue is exactly right, and a new one can
   * say why. A policy that cannot be read is a 503 `policy_unavailable`, never a
   * queue. The check follows the owner check, so only the kernel's operator or
   * the admin learns the stop state here.
   */
  app.get<{
    Querystring: { kernelId?: string; status?: string };
  }>("/api/operator/jobs", async (req, reply) => {
    const caller = requireRelayCaller(req, reply);
    if (!caller) return reply;
    const { kernelId, status = "queued" } = req.query;

    if (typeof kernelId !== "string" || !kernelId) {
      return reply.code(400).send({ error: "kernelId query param required" });
    }
    if (!caller.admin && !(await requireOwnerOf(caller.actor, reply, kernelId))) return reply;

    // A repeated ?status= arrives as an array: that is not one of the statuses
    // below, so it is held back like any other work.
    if (!(typeof status === "string" && STATUSES_NOT_TO_START.has(status))) {
      const accepts = checkKernelAcceptsJobs(kernelId);
      if (!accepts.ok) {
        if (accepts.status === 503) return replyKernelNotAccepting(reply, accepts);
        return { jobs: [], emergencyStop: true };
      }
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
   * OWNER-OR-ADMIN (N85 b, LIVE): only the owner of the JOB's kernel (or the
   * admin secret) may file evidence on a job. Before, any key stored a bundle
   * for any job. The job is looked up first (404 job_not_found, no longer a
   * graceful 200), then its kernel's owner is checked (403 not_kernel_owner);
   * nothing is stored on a refusal. The bundle is stored under the JOB's
   * kernel, never under the body's `kernelId`, which is only validated as a
   * string: evidence filed under a kernel the job is not on would surface in
   * that kernel's compliance report.
   *
   * Body: { jobId, kernelId?, evidence: { ... }, timestamp? }
   */
  app.post<{ Body: EvidenceBody }>("/api/operator/evidence", async (req, reply) => {
    const caller = requireRelayCaller(req, reply);
    if (!caller) return reply;
    const { jobId, kernelId, evidence, timestamp } = req.body ?? {};

    if (typeof jobId !== "string" || !jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (kernelId !== undefined && kernelId !== null && typeof kernelId !== "string") {
      return reply.code(400).send({ error: "kernelId must be a string" });
    }
    if (!evidence) {
      return reply.code(400).send({ error: "evidence required" });
    }

    try {
      const repos = getRepos();

      // Verify the job exists
      const job = repos.jobs.findById(jobId);
      if (!job) {
        app.log.warn(`operator-relay: evidence for unknown job ${jobId}`);
        return reply.code(404).send({
          error: "job_not_found",
          message: `Job '${jobId}' does not exist`,
          jobId,
        });
      }
      // The caller must be the admin or the owner of the JOB's kernel.
      if (!caller.admin && !(await requireOwnerOf(caller.actor, reply, job.kernelId))) return reply;

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
            signer: job.kernelId,
            algorithm: "sha256",
            value: "operator-relay-auto",
          };

      try {
        repos.evidence.insert({
          id: bundleId,
          jobId,
          stepId: job.stepId ?? "operator-relay",
          kernelId: job.kernelId,
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
   * Owner-only (WP-C): same rule as POST /api/kernels/:kernelId/heartbeat
   * (requireKernelOwner, over the shared auth/kernel-operator.ts predicate).
   * The kernel must exist (404) and the authenticated actor (apiGate
   * `operatorId ?? userId`) must be its recorded owner (403
   * `not_kernel_owner`); nothing is written on a refusal. A pcc-node daemon
   * must therefore heartbeat with the key that registered its kernel.
   * Announced capability tiers are clamped to the kernel's authorized ceiling.
   *
   * `acceptingJobs` (optional boolean): `false` marks a node that takes no jobs
   * (the heartbeat-only pcc-node daemon). The heartbeat still records the
   * kernel's liveness, but refreshes no capability's validUntil, applies no
   * announced list and withdraws nothing, so the kernel's listings age out
   * instead of being kept alive by its heartbeats. `true` or absent is the
   * ordinary heartbeat. Any other type is a 400 `invalid_accepting_jobs`.
   *
   * Body: { kernelId, status?, capabilities?, timestamp?, acceptingJobs? }
   */
  app.post<{ Body: HeartbeatBody }>("/api/operator/heartbeat", async (req, reply) => {
    // Steward rule 7: a PRESENT actor first (401), before body validation or
    // any lookup.
    const actor = requireActor(req, reply);
    if (!actor) return reply;
    const { kernelId, status = "online", capabilities, timestamp, acceptingJobs } = req.body ?? {};

    if (typeof kernelId !== "string" || !kernelId) {
      return reply.code(400).send({ error: "kernelId required" });
    }
    // The body is validated before the kernel is looked up (401, 400, then 404 /
    // 403), like kernelId above. The facade checks it again for other callers.
    if (!isValidAcceptingJobs(acceptingJobs)) {
      return reply.code(400).send({
        error: INVALID_ACCEPTING_JOBS_CODE,
        message: INVALID_ACCEPTING_JOBS_MESSAGE,
      });
    }

    if (!(await requireOwnerOf(actor, reply, kernelId))) return reply;
    const result = await kernelFacade.heartbeat(
      kernelId,
      { status, capabilities, timestamp, acceptingJobs },
      actor,
    );
    return sendResult(reply, result);
  });

  /**
   * POST /api/operator/job-status
   *
   * Update job status from an operator node (alternative to PATCH /api/jobs/:id/status).
   * Used when the node doesn't know the exact route shape.
   *
   * OWNER-OR-ADMIN (N85 b, LIVE): only the owner of the JOB's kernel (or the
   * admin secret) may set a job's status. Before, any key set any job's status:
   * once a paid job is 'completed', /complete answers 409 and the settlement
   * facade reads 'completed' as settled, so any key could strand any paid job's
   * settlement. The job is looked up first (404 job_not_found, no longer a
   * graceful 200), then its kernel's owner is checked (403 not_kernel_owner);
   * nothing is written on a refusal. The body's `kernelId` is only validated as
   * a string: the job's own kernel decides who may act.
   *
   * Body: { jobId, kernelId?, status, metadata?, timestamp? }
   */
  app.post<{ Body: JobStatusBody }>("/api/operator/job-status", async (req, reply) => {
    const caller = requireRelayCaller(req, reply);
    if (!caller) return reply;
    const { jobId, kernelId, status, metadata, timestamp } = req.body ?? {};

    if (typeof jobId !== "string" || !jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (kernelId !== undefined && kernelId !== null && typeof kernelId !== "string") {
      return reply.code(400).send({ error: "kernelId must be a string" });
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

      // Verify the job exists, then that the caller is the admin or the owner of
      // the JOB's kernel, BEFORE anything is written.
      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.code(404).send({
          error: "job_not_found",
          message: `Job '${jobId}' does not exist`,
          jobId,
        });
      }
      if (!caller.admin && !(await requireOwnerOf(caller.actor, reply, job.kernelId))) return reply;

      const updated = repos.jobs.updateStatus(jobId, canonicalStatus);

      if (!updated) {
        // The job vanished between the lookup and the write.
        return reply.code(404).send({
          error: "job_not_found",
          message: `Job '${jobId}' does not exist`,
          jobId,
        });
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
