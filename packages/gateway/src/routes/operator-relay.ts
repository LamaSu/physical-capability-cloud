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
 * Poll, heartbeat and status require kernel-authority "operate": the recorded
 * operator identity, its proven wallet, or the gateway admin secret.
 * Evidence takes decide, per DECISIONS 2026-10-04 01:25 (N31c).
 * Anonymous callers get 401
 * before any job read; authority 403/404/503 refusals are sent unchanged.
 * Non-string IDs get 400 before lookup.
 * Evidence and status use the job row's kernel, never a body's kernelId.
 * Authenticated unknown jobs retain their 200 job_not_found receipt; jobs without a kernel
 * refuse non-admin callers with 403 job_has_no_kernel.
 * Operator identity proof for operate is completed by WP-A (DECISIONS items 136 and 138).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { executionPhaseOf, type Result } from "@pcc/spec";
import { and, asc, eq, schema } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";
import { JOB_STATUSES, normalizeJobStatus } from "../config/job-status.js";
import { extractNodeSignedBundle } from "../services/device-evidence-settlement.js";
import { commitRelayEvidence } from "../services/relay-evidence-commitment.js";
import { v4 as uuidv4 } from "uuid";
import { writeJobStatusGuarded, SETTLEMENT_OWNED_MESSAGE } from "../services/settlement-owned-status.js";
import { authorityOf, isAnonymous, refuseKernelAction, AUTHENTICATION_REQUIRED, type KernelAction } from "../auth/kernel-authority.js";
import { emergencyStopState } from "./device-relay.js";
import { projectFundingStatus, type FundingStatusDTO } from "../readmodels/funding-status.js";
import { fundingRecordStore } from "../services/funding-record-port.js";
import { escrowForJob } from "../services/scope-acceptance.js";
import { paidScopeActivationTerms } from "../services/paid-scope-activation-terms.js";
import { testnetBuyerAllowance, type TestnetBuyerAllowance } from "../services/funding-binding.js";

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Shared authority check for poll/heartbeat targets and the kernel read from a job row. */
export function refuseKernelRequest(req: FastifyRequest, kernelId: unknown, action: KernelAction = "operate"): { status: number; body: Record<string, string> } | null {
  const authority = authorityOf(req);
  if (isAnonymous(authority)) return { status: 401, body: AUTHENTICATION_REQUIRED };
  if (kernelId === null || kernelId === undefined) {
    return authority.admin ? null : {
      status: 403,
      body: { error: "forbidden", reason: "job_has_no_kernel", message: "This job has no kernel whose operator can authorize the action." },
    };
  }
  // Reject malformed repository values too, even for admins, before a kernel lookup.
  if (!isNonEmptyId(kernelId)) return { status: 400, body: { error: "kernelId must be a non-empty string" } };
  return refuseKernelAction(req, authority, kernelId, action);
}

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
// Job funding: synchronous readmodel, per listed job (never a chain query).
// ---------------------------------------------------------------------------

/** One listed job's buyer funding, to the extent the gateway could read it. */
type OperatorJobFunding =
  | { read: "ok"; scopes: FundingStatusDTO[] }
  | { read: "failed" };

/** Without a verification record there is no reason to read deployment terms or buyer config. */
const NO_RECORD_ALLOWANCE: TestnetBuyerAllowance = { testnetOnly: true, buyers: undefined };

/** Read only this kernel's scopes for this listed job; a failure does not affect other jobs. */
function fundingForListedJob(jobId: string, kernelId: string, asOf: string): OperatorJobFunding {
  try {
    const db = getStore().db;
    // One scoped query per listed job; order ties by id to make the answer deterministic.
    const rows = db.select().from(schema.executionScopes).where(and(
      eq(schema.executionScopes.kernelId, kernelId),
      eq(schema.executionScopes.jobId, jobId),
    )).orderBy(asc(schema.executionScopes.createdAt), asc(schema.executionScopes.id)).all();
    const scopes = rows.map((scope) => {
      const record = fundingRecordStore()?.findByScope(db, scope.id) ?? null;
      if (record === null) {
        // fundingBindingOf checks no_record first. No escrow, deployment, or opt-in read.
        return projectFundingStatus(scope, null, null, null, asOf, NO_RECORD_ALLOWANCE);
      }
      const escrow = escrowForJob(jobId) ?? null;
      const terms = paidScopeActivationTerms({ id: scope.id, jobId: scope.jobId, kernelId: scope.kernelId });
      return projectFundingStatus(
        scope,
        record,
        escrow ? { contractAddress: escrow.contractAddress, payer: escrow.payer, status: escrow.status } : null,
        terms.expectedChainId,
        asOf,
        testnetBuyerAllowance(terms),
      );
    });
    return { read: "ok", scopes };
  } catch {
    // Never report an invented time or state, and never log a job, scope or error value.
    return { read: "failed" };
  }
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
   * Returns { jobs: Job[], emergencyStop: "clear" | "stopped" | "unavailable" }.
   * Each listed job gains funding: { read: "ok", scopes: FundingStatusDTO[] } or
   * { read: "failed" } ONLY for a decide-strength caller (admin or a proven wallet
   * matching this kernel's operator). Operate-only callers get the original job shape.
   * A host takes fundedAt and operator only when funding.read is "ok" and exactly
   * one scope is funded_verified with a non-null verification. It also checks that
   * operator matches its operator wallet and escrowAddress/chainId match its own
   * job-unit binding. Absent, failed or ambiguous funding means no fundedAt and
   * no GAP-7 evidence session; the host never puts a clock reading or an estimated block time in fundedAt's place.
   * Funding does not authorize execution: the claim route decides whether a job runs.
   */
  app.get<{
    Querystring: { kernelId?: string; status?: string };
  }>("/api/operator/jobs", async (req, reply) => {
    const { kernelId, status = "queued" } = req.query;

    if (!isNonEmptyId(kernelId)) {
      return reply.code(400).send({ error: "kernelId query param required" });
    }

    const refusal = refuseKernelRequest(req, kernelId);
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    const emergencyStop = emergencyStopState(kernelId);
    // The HOST must treat anything but "clear", including an absent field, as stop.

    const result = await jobFacade.list({ kernelId, status });
    if (!result.success) return { jobs: [], emergencyStop };
    const jobs = result.data.items ?? [];
    const listedJobs = emergencyStop === "clear" ? jobs : jobs.filter((job) => executionPhaseOf(job.status) !== "queued");
    // The poll itself permits operate, but its funding details require decide.
    // Do not read funding for claimed-only callers or for withheld queued jobs.
    if (refuseKernelAction(req, authorityOf(req), kernelId, "decide") !== null) {
      return { jobs: listedJobs, emergencyStop };
    }
    const asOf = new Date().toISOString(); // Once per successful poll, after the facade returns.
    return {
      jobs: listedJobs.map((job) => ({ ...job, funding: fundingForListedJob(job.id, kernelId, asOf) })),
      emergencyStop,
    };
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

    if (!isNonEmptyId(jobId)) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (kernelId !== undefined && !isNonEmptyId(kernelId)) {
      return reply.code(400).send({ error: "kernelId must be a non-empty string" });
    }
    if (!evidence) {
      return reply.code(400).send({ error: "evidence required" });
    }
    if (isAnonymous(authorityOf(req))) return reply.code(401).send(AUTHENTICATION_REQUIRED);

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

      // Evidence takes decide, per DECISIONS 2026-10-04 01:25 (N31c).
      const refusal = refuseKernelRequest(req, job.kernelId, "decide");
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      // The stored bundle belongs to the job's kernel. A body naming another kernel is
      // refused, never stored under it (N80: stored evidence tells the truth).
      if (kernelId !== undefined && job.kernelId && kernelId !== job.kernelId) {
        return reply.code(409).send({
          error: "kernel_mismatch",
          message: `evidence names kernel ${kernelId}, but job ${jobId} belongs to kernel ${job.kernelId}`,
        });
      }

      // Store evidence bundle
      const bundleId = `ev-${uuidv4()}`;
      const now = new Date().toISOString();

      // SEAM-2 (path 1): capture the node's REAL device (#236) Ed25519 signature and
      // real bundleHash when the pushed evidence carries a signed bundle — instead of
      // discarding the signature and writing a gateway placeholder. This only
      // PERSISTS the truth of what the device signed; it does NOT verify it or gate
      // settlement. The oracle #52 verifier (stubbed, fail-closed) still owns whether
      // this evidence may settle. Evidence without a device signature keeps the
      // placeholder SIGNATURE (a gateway placeholder, never device-signed).
      //
      // The stored bundleHash is never made up (N80, rehearsal R0 G3). It used to be
      // `sha256-<bundleId>` for any unsigned body, with no events stored, so it committed
      // to nothing that was received. commitRelayEvidence recomputes LO-EV event hashes, or
      // the hash of a device-signed document that names THIS job and its kernel (adk #4322),
      // and refuses everything else: a supplied hash its content does not reproduce, a
      // document signed for another job or kernel (409), a bare device digest that names no
      // job, an ambiguous envelope, malformed events, and a document the gateway could not
      // keep (cross-family review E4).
      //
      // assuranceTier stays 0 ON PURPOSE (fails closed): an UNVERIFIED bundle
      // "actually supports" only the tier-0 permissionless floor (eligibility.ts).
      // The node's self-declared tier is a claim, not proof — trusting it here would
      // let resume-settlement's `?? latestBundle.assuranceTier` fallback escalate the
      // release tier from unverified evidence. The tier is lifted only once the gated
      // #52 verifier confirms the evidence on deployed infra (SEAM-2 ready-but-gated).
      const captured = extractNodeSignedBundle(evidence);
      // The job context comes from the job row, never from the evidence.
      const committed = await commitRelayEvidence(evidence, captured, { jobId: job.id, kernelId: job.kernelId ?? null });
      if (!committed.ok) {
        const conflict = committed.refusal.error === "job_mismatch" || committed.refusal.error === "kernel_mismatch";
        return reply.code(conflict ? 409 : 422).send({ ...committed.refusal, stored: false, jobId });
      }
      const { bundleHash, hashModel, events } = committed.commitment;
      const kernelSignature = captured
        ? captured.kernelSignature
        : {
            signer: job.kernelId ?? "unknown",
            algorithm: "sha256",
            value: "operator-relay-auto",
          };

      try {
        // One transaction (cross-family review E4, finding 2): the bundle and its events
        // commit together or not at all, so a failed event insert never leaves a stored
        // bundle whose hash its missing events cannot reproduce.
        getStore().db.transaction(() => {
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
          if (events.length > 0) {
            repos.evidence.insertEvents(
              events.map((ev, i) => ({
                id: `${bundleId}:${i}`,
                bundleId,
                type: ev.type,
                timestamp: ev.timestamp,
                source: ev.source as { deviceId: string; deviceType: string; kernelId: string },
                payload: ev.payload,
                hash: ev.hash,
              })),
            );
          }
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
        // What was committed: the stored hash, how it was made, and how many LO-EV
        // events were stored with it (0 when the body carried none in that form).
        contentHash: bundleHash,
        hashModel,
        eventsStored: events.length,
        // True when the node's real device-signed (#236) bundle was captured
        // (real Ed25519 signature persisted); false when the placeholder was used.
        deviceSigned: !!captured,
        // Nothing here verifies a signature: capture persists it, and the gated #52
        // verifier owns verification.
        signatureVerified: false,
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

    if (!isNonEmptyId(kernelId)) {
      return reply.code(400).send({ error: "kernelId required" });
    }

    const refusal = refuseKernelRequest(req, kernelId);
    if (refusal) return reply.code(refusal.status).send(refusal.body);

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
    const { jobId, kernelId, status, metadata, timestamp } = req.body ?? {};

    if (!isNonEmptyId(jobId)) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (kernelId !== undefined && !isNonEmptyId(kernelId)) {
      return reply.code(400).send({ error: "kernelId must be a non-empty string" });
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
    if (isAnonymous(authorityOf(req))) return reply.code(401).send(AUTHENTICATION_REQUIRED);

    try {
      const job = getRepos().jobs.findById(jobId);
      if (!job) {
        // Job not found — return 200 so the node doesn't fail hard.
        return {
          updated: false,
          jobId,
          status: canonicalStatus,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }
      const refusal = refuseKernelRequest(req, job.kernelId);
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      // N85(a): a paid job's terminal status belongs to its settlement path.
      // N85: bind that UPDATE to the same kernel the operate check authorized.
      const outcome = writeJobStatusGuarded(jobId, canonicalStatus, undefined, job.kernelId ?? null);
      if (outcome.kind === "refused") {
        if (outcome.kernelChanged) {
          return reply.code(409).send({ error: "job_kernel_changed", message: "The job's kernel changed after authorization. Poll again before reporting status." });
        }
        return reply.code(409).send({
          error: "settlement_owned_status",
          currentStatus: outcome.currentStatus,
          message: SETTLEMENT_OWNED_MESSAGE,
        });
      }

      if (outcome.kind === "not_found") {
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
