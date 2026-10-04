import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MaintenanceEvent, OperatorCertification, OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getRepos, getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  checkKernelOwner,
  ownsKernel,
  requireActor,
  requireKernelOwner,
  requireOwnerOf,
} from "../auth/kernel-owner-guard.js";
import { presentsAdminSecret, requireAdminSecret } from "../auth/admin-secret-gate.js";
import {
  checkKernelAcceptsJobs,
  readOperatorPolicy,
  replyKernelNotAccepting,
} from "../services/kernel-emergency-stop.js";

/** 400 error code for a policy PUT/PATCH that tries to change emergencyStop.
 *  Stopping and resuming go ONLY through the dedicated routes below -- see
 *  their doc comments for why (the stop's side effects, like rejecting
 *  pending approvals, only run there). Shared between PUT and PATCH so the
 *  two can never drift to different codes for the same refusal. */
const EMERGENCY_STOP_IMMUTABLE_VIA_POLICY_WRITE = "emergency_stop_immutable_via_policy_write";
const INVALID_EMERGENCY_STOP = "invalid_emergency_stop";

/** A policy write may only name emergencyStop as a real boolean; a non-boolean is never stored (astra pack 150b). */
function namesNonBooleanEmergencyStop(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    Object.prototype.hasOwnProperty.call(body, "emergencyStop") &&
    typeof (body as Record<string, unknown>).emergencyStop !== "boolean"
  );
}

const { operatorPolicies, pendingApprovals } = schema;

const mockMachines = [
  { id: "reg-001", name: "Prusa MK4 Workshop", type: "fdm", status: "active", utilization: 72, jobsCompleted: 98, uptime: 99.2 },
  { id: "reg-002", name: "Epilog Fusion Pro", type: "laser-cut", status: "active", utilization: 58, jobsCompleted: 44, uptime: 97.8 },
];

const mockCerts: OperatorCertification[] = [
  { id: "cert-1", name: "OSHA 10-Hour General Industry", issuer: "OSHA", issuedAt: "2025-06-15T00:00:00Z", expiresAt: "2028-06-15T00:00:00Z", status: "valid" },
  { id: "cert-2", name: "3D Printing Safety Training", issuer: "PCC Network", issuedAt: "2025-09-01T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z", status: "valid" },
];

const mockMaintenance: MaintenanceEvent[] = [
  { id: "maint-1", machineId: "reg-001", type: "scheduled", description: "Replace nozzle and clean heatbreak", scheduledAt: "2026-03-10T09:00:00Z", status: "upcoming" },
  { id: "maint-2", machineId: "reg-001", type: "inspection", description: "Quarterly belt tension check", scheduledAt: "2026-03-20T14:00:00Z", status: "upcoming" },
  { id: "maint-3", machineId: "reg-001", type: "scheduled", description: "Firmware update v5.2.0", scheduledAt: "2026-03-01T10:00:00Z", completedAt: "2026-03-01T10:30:00Z", status: "completed" },
];

export async function operatorRoutes(app: FastifyInstance) {
  // List operator's machines
  app.get("/api/operator/machines", async () => {
    return { machines: mockMachines };
  });

  // Earnings data with period filter
  app.get("/api/operator/earnings", async (req) => {
    const query = req.query as Record<string, string>;
    const days = query.period === "7d" ? 7 : query.period === "90d" ? 90 : query.period === "1y" ? 365 : 30;

    const earnings = Array.from({ length: days }, (_, i) => {
      const daily = 15 + Math.random() * 40;
      return {
        date: new Date(Date.now() - (days - i) * 86400000).toISOString().split("T")[0],
        earnings: Math.round(daily * 100) / 100,
      };
    });

    let cumulative = 0;
    const withCumulative = earnings.map((e) => {
      cumulative += e.earnings;
      return { ...e, cumulative: Math.round(cumulative * 100) / 100 };
    });

    return { earnings: withCumulative, total: Math.round(cumulative * 100) / 100 };
  });

  // Certification list
  app.get("/api/operator/certifications", async () => {
    return { certifications: mockCerts };
  });

  // Maintenance events
  app.get("/api/operator/maintenance", async () => {
    return { events: mockMaintenance };
  });

  // ═════════════════════════════════════════════════════════════════
  // Operator Policy — guardrails for job execution
  // ═════════════════════════════════════════════════════════════════

  /**
   * GET /api/operator/policy/:kernelId — Get operator policy.
   *
   * OWNER-OR-ADMIN (WP-C, N31; adk #3972). The policy carries the approval mode,
   * spend/rate limits and `emergencyStop`, so a kernel's guardrail posture is not
   * public: any key could read any kernel's e-stop state and limits. Only the
   * kernel's owner (sameIdentity) or the admin may read it now. A kernel with no
   * recorded owner (missing, or the zero-address placeholder) is the admin's
   * alone (fail closed), matching the write path. No identity -> 401; a
   * non-owner -> 403 not_kernel_owner. The default-policy fallback for an
   * unknown kernel is unchanged, but only for an authorized caller.
   *
   * Three outcomes, and only two of them produce a policy. A stored row is
   * returned as stored. No row is DEFAULT_OPERATOR_POLICY, marked
   * `source: "default"`. A read that FAILS (the store cannot be opened, the
   * query throws, the stored row cannot be parsed) is not "no row": it answers
   * 503 `policy_unavailable` and never a policy, because the default carries
   * `emergencyStop: false` and a caller (a node, a runtime) would read the
   * failure as "no emergency stop".
   */
  app.get<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      // OWNER-OR-ADMIN, mirroring the PUT/PATCH writes below (same requireActor
      // + requireOwnerOf), plus an admin read for observability. An admin secret
      // presented (valid) reads any kernel; otherwise the actor must own the
      // kernel. requireOwnerOf fails closed on an unowned/placeholder kernel and
      // on an unknown one (404), via the hardened ownsKernel.
      if (presentsAdminSecret(req)) {
        if (!requireAdminSecret(req, reply)) return reply;
      } else {
        const actor = requireActor(req, reply);
        if (!actor) return reply;
        if (!(await requireOwnerOf(actor, reply, req.params.kernelId))) return reply;
      }
      const read = readOperatorPolicy(req.params.kernelId);
      if (read.kind === "unavailable") {
        req.log.error(
          { kernelId: req.params.kernelId },
          "operator policy read failed or unreadable; answering 503 policy_unavailable",
        );
        return reply.status(503).send({ error: "policy_unavailable" });
      }
      if (read.kind === "missing") {
        return { policy: DEFAULT_OPERATOR_POLICY, source: "default" };
      }
      return { policy: read.policy, updatedAt: read.updatedAt };
    },
  );

  /**
   * PUT /api/operator/policy/:kernelId — Update full policy
   *
   * OWNER-ONLY (WP-C, N31): the policy carries `emergencyStop`, so writing it
   * is the same authority as the e-stop routes below. The owner check runs
   * before any write (401 / 404 / 403 not_kernel_owner); a missing actor is a
   * 401 before the body is validated (steward rule 7).
   */
  app.put<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      const actor = requireActor(req, reply);
      if (!actor) return reply;
      const policy = req.body as OperatorPolicy;
      if (!policy || policy.version !== 1) {
        return reply.status(400).send({ error: "Invalid policy: version must be 1" });
      }
      if (namesNonBooleanEmergencyStop(policy)) {
        return reply.status(400).send({ error: INVALID_EMERGENCY_STOP, message: "emergencyStop must be a boolean." });
      }
      if (!(await requireOwnerOf(actor, reply, req.params.kernelId))) return reply;

      // refvertical #4850: emergencyStop may change ONLY through
      // POST /emergency-stop or /emergency-resume (see their doc comments),
      // never through a policy write. Checked against the CURRENT value,
      // whether or not the body includes the field: this is a full REPLACE,
      // so a body that simply omits emergencyStop would otherwise silently
      // CLEAR a real stop the instant it landed (the new row reads back with
      // no emergencyStop key at all -> falsy -> not stopped). An invalid
      // existing row answers 503 here rather than guessing at a comparison.
      const read = readOperatorPolicy(req.params.kernelId);
      if (read.kind === "unavailable") {
        return reply.status(503).send({ error: "policy_unavailable" });
      }
      const currentlyStopped = Boolean(
        read.kind === "ok" ? read.policy.emergencyStop : DEFAULT_OPERATOR_POLICY.emergencyStop,
      );
      const requestedStopped = Boolean((policy as unknown as Record<string, unknown>).emergencyStop);
      if (requestedStopped !== currentlyStopped) {
        return reply.status(400).send({
          error: EMERGENCY_STOP_IMMUTABLE_VIA_POLICY_WRITE,
          message:
            "emergencyStop can only be changed via POST /api/operator/emergency-stop or " +
            "/api/operator/emergency-resume, not PUT /api/operator/policy/:kernelId.",
        });
      }

      try {
        const { db } = getStore();
        const now = new Date().toISOString();

        db.insert(operatorPolicies)
          .values({
            kernelId: req.params.kernelId,
            policy: policy as any,
            updatedAt: now,
            updatedBy: "api",
          })
          .onConflictDoUpdate({
            target: operatorPolicies.kernelId,
            set: { policy: policy as any, updatedAt: now, updatedBy: "api" },
          })
          .run();

        return { policy, updated: true, updatedAt: now };
      } catch {
        return reply.status(500).send({ error: "Failed to save policy" });
      }
    },
  );

  /**
   * PATCH /api/operator/policy/:kernelId — Partial update
   *
   * OWNER-ONLY (WP-C, N31), same as PUT: a patch can set or clear
   * `emergencyStop`, so it must not be a side door around the e-stop check.
   */
  app.patch<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      const patch = req.body as Partial<OperatorPolicy>;
      if (namesNonBooleanEmergencyStop(patch)) {
        return reply.status(400).send({ error: INVALID_EMERGENCY_STOP, message: "emergencyStop must be a boolean." });
      }
      if (!(await requireKernelOwner(req, reply, req.params.kernelId))) return reply;

      try {
        const read = readOperatorPolicy(req.params.kernelId);
        if (read.kind === "unavailable") {
          // Same effect as the read itself throwing (the pre-existing
          // behavior for a stored value that cannot be parsed at all): caught
          // below as a generic failure. Never merge a patch over a policy we
          // could not verify, and never write a default over it.
          throw new Error("Operator policy could not be read");
        }
        const existing = (read.kind === "ok" ? read.policy : DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

        // refvertical #4850: emergencyStop may change ONLY through
        // POST /emergency-stop or /emergency-resume -- a PATCH that flips it
        // skips the stop's side effects (rejecting pending approvals), and a
        // PATCH-stop followed immediately by a PATCH-resume would leave
        // queued work completely undisturbed, as if the stop never ran.
        // Merge semantics mean an OMITTED field never changes the existing
        // value, so only a patch that explicitly NAMES the key is checked.
        if (Object.prototype.hasOwnProperty.call(patch ?? {}, "emergencyStop")) {
          const currentlyStopped = Boolean((existing as unknown as Record<string, unknown>).emergencyStop);
          const requestedStopped = Boolean((patch as unknown as Record<string, unknown>).emergencyStop);
          if (requestedStopped !== currentlyStopped) {
            return reply.status(400).send({
              error: EMERGENCY_STOP_IMMUTABLE_VIA_POLICY_WRITE,
              message:
                "emergencyStop can only be changed via POST /api/operator/emergency-stop or " +
                "/api/operator/emergency-resume, not PATCH /api/operator/policy/:kernelId.",
            });
          }
        }

        const merged = { ...existing, ...patch, version: 1 } as OperatorPolicy;
        const now = new Date().toISOString();
        const { db } = getStore();

        db.insert(operatorPolicies)
          .values({
            kernelId: req.params.kernelId,
            policy: merged as any,
            updatedAt: now,
            updatedBy: "api",
          })
          .onConflictDoUpdate({
            target: operatorPolicies.kernelId,
            set: { policy: merged as any, updatedAt: now, updatedBy: "api" },
          })
          .run();

        return { policy: merged, updated: true };
      } catch {
        return reply.status(500).send({ error: "Failed to update policy" });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // Emergency Stop / Resume
  // ═════════════════════════════════════════════════════════════════

  // OWNER-ONLY (WP-C; N31 from operator-ux #2348, steward #2450). Setting or
  // clearing a kernel's e-stop, and deciding its pending approvals, are the
  // kernel operator's calls. Each route requires a PRESENT actor who is the
  // kernel's recorded operator (requireKernelOwner / checkKernelOwner, over the
  // shared auth/kernel-operator.ts predicate): 401 without an actor, 404 for an
  // unknown kernel, 403 not_kernel_owner for anyone else. The check runs BEFORE
  // any write, so a refusal leaves the e-stop state and the approvals untouched.
  // (Before: kernelId came from the body with no identity or ownership check, so
  // any key could stop or resume any kernel.) Steward rule 7: the actor is
  // resolved first, so a request without one is 401 even before its body is
  // validated.

  /** POST /api/operator/emergency-stop — Activate emergency stop */
  app.post("/api/operator/emergency-stop", async (req, reply) => {
    const actor = requireActor(req, reply);
    if (!actor) return reply;
    const { kernelId, reason } = (req.body ?? {}) as { kernelId?: unknown; reason?: string };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    if (!(await requireOwnerOf(actor, reply, kernelId))) return reply;

    try {
      const read = readOperatorPolicy(kernelId);
      if (read.kind === "unavailable") {
        // astra pack 150 HIGH: a parseable-but-wrong-shaped row (an array, in
        // particular -- typeof [] === "object", and setting a named property
        // on an array "succeeds" in memory but vanishes on the next JSON
        // serialization) must never let this route answer 200 {stopped:true}
        // while persisting nothing. Fail the same way a read that throws
        // outright already does: 500, no write at all.
        throw new Error("Operator policy could not be read");
      }
      const policy = (read.kind === "ok" ? read.policy : { ...DEFAULT_OPERATOR_POLICY }) as unknown as OperatorPolicy;
      policy.emergencyStop = true;
      const now = new Date().toISOString();

      const { db } = getStore();
      db.insert(operatorPolicies)
        .values({ kernelId, policy: policy as any, updatedAt: now, updatedBy: "emergency-stop" })
        .onConflictDoUpdate({
          target: operatorPolicies.kernelId,
          set: { policy: policy as any, updatedAt: now, updatedBy: "emergency-stop" },
        })
        .run();

      // Cancel all pending approvals for this kernel. Only PENDING ones: an
      // approval already granted, and the kernel's queued jobs, are not touched
      // here. While the stop lasts they are held back at the queues a node polls
      // (GET /api/operator/approvals?status=approved and GET /api/operator/jobs),
      // and they are handed out again on resume.
      db.update(pendingApprovals)
        .set({
          status: "rejected",
          decidedAt: now,
          rejectionReason: `Emergency stop: ${reason ?? "operator activated"}`,
        })
        .where(and(
          eq(pendingApprovals.kernelId, kernelId),
          eq(pendingApprovals.status, "pending"),
        ))
        .run();

      return { stopped: true, kernelId, reason, timestamp: now };
    } catch {
      return reply.status(500).send({ error: "Failed to activate emergency stop" });
    }
  });

  /** POST /api/operator/emergency-resume — Deactivate emergency stop */
  app.post("/api/operator/emergency-resume", async (req, reply) => {
    const actor = requireActor(req, reply);
    if (!actor) return reply;
    const { kernelId } = (req.body ?? {}) as { kernelId?: unknown };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    if (!(await requireOwnerOf(actor, reply, kernelId))) return reply;

    try {
      const read = readOperatorPolicy(kernelId);
      if (read.kind === "missing") return reply.status(404).send({ error: "No policy found for kernel" });
      if (read.kind === "unavailable") {
        // Same reasoning as emergency-stop above: never guess at a row we
        // cannot trust. 500, no write.
        throw new Error("Operator policy could not be read");
      }

      const policy = read.policy as unknown as OperatorPolicy;
      policy.emergencyStop = false;
      const now = new Date().toISOString();

      const { db } = getStore();
      db.update(operatorPolicies)
        .set({ policy: policy as any, updatedAt: now, updatedBy: "emergency-resume" })
        .where(eq(operatorPolicies.kernelId, kernelId))
        .run();

      return { resumed: true, kernelId, timestamp: now };
    } catch {
      return reply.status(500).send({ error: "Failed to resume" });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // Pending Approvals
  // ═════════════════════════════════════════════════════════════════

  /**
   * POST /api/operator/approvals — Submit a job for the kernel operator's approval.
   *
   * WP-C R2 (review round 2, HIGH; probe P2). This route used to take
   * `autoApprove: true` from the body and store the job as ALREADY APPROVED
   * for any kernel, from any key, with `submittedBy` copied from the body. The
   * in-repo OT-2 daemon (scripts/ot2-agent.py) polls `status=approved` for its
   * kernel and runs those jobs on the robot, so this bypassed the owner-only
   * approve route (N31) and ignored the e-stop. Now:
   *   - a PRESENT actor is required (401), and an unknown kernel is 404;
   *   - body `autoApprove` is ignored. A job is created 'approved' only when
   *     the actor OWNS the kernel and the kernel's policy says
   *     `approvalMode: "auto"`. Everyone else creates 'pending', which only
   *     the owner can approve;
   *   - `submittedBy` is the authenticated actor, never a body field;
   *   - a kernel whose policy has `emergencyStop` set refuses new approvals
   *     (503, the same answer the job and negotiation routes give).
   * Any key may still SUBMIT a job for a kernel's approval; that is the
   * purpose of the queue.
   */
  app.post("/api/operator/approvals", async (req, reply) => {
    const actor = requireActor(req, reply);
    if (!actor) return reply;
    const { kernelId, capabilityType, parameters } = (req.body ?? {}) as {
      kernelId?: unknown; capabilityType?: string; parameters?: Record<string, unknown>;
    };
    if (typeof kernelId !== "string" || !kernelId) {
      return reply.status(400).send({ error: "kernelId required" });
    }
    // Owner check WITHOUT refusing non-owners: 404 / 502 refuse, 403 means
    // "may submit, but only as pending".
    const verdict = await checkKernelOwner(actor, kernelId);
    if (!verdict.ok && verdict.status !== 403) {
      return reply.status(verdict.status).send({ error: verdict.error, message: verdict.message, kernelId });
    }
    const isOwner = verdict.ok;
    try {
      const read = readOperatorPolicy(kernelId);
      if (read.kind === "unavailable") {
        // astra pack 150 HIGH: never decide this on a row we cannot trust
        // (an array included -- see kernel-emergency-stop.ts). Same effect
        // as the read throwing outright: caught below as a generic failure.
        throw new Error("Operator policy could not be read");
      }
      const policy = (read.kind === "ok" ? read.policy : DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;
      if (policy.emergencyStop) {
        return reply.status(503).send({ error: "Operator has activated emergency stop", kernelId });
      }
      const { db } = getStore();
      const approved = isOwner && policy.approvalMode === "auto";

      const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.insert(pendingApprovals).values({
        id,
        kernelId,
        jobId,
        submittedBy: actor,
        jobSummary: { capabilityType: capabilityType ?? "liquid-handler", parameters: parameters ?? {} },
        status: approved ? "approved" : "pending",
        createdAt: now,
        decidedAt: approved ? now : null,
        expiresAt: expires,
      }).run();

      const row = db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
      return { approval: row, created: true };
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to create approval", detail: e?.message ?? String(e) });
    }
  });

  /**
   * GET /api/operator/approvals — List approvals.
   *
   * OWNER-SCOPED (WP-C R2). A present actor is required (401). With
   * `?kernelId=` the actor must own that kernel (404 unknown, 403
   * not_kernel_owner). Without it, only approvals for kernels the actor owns
   * are listed, resolved with one batched kernel lookup. (Before: any key
   * could read every kernel's queue, including the job parameters.)
   *
   * EMERGENCY STOP. `?status=approved` is the queue the OT-2 daemon polls for
   * work to run, so a kernel in emergency stop hands out none of it. The stop
   * itself only rejects PENDING approvals (POST /emergency-stop below), so an
   * approval granted before the stop was still handed out. With `?kernelId=` the
   * answer is 200 `{ approvals: [], emergencyStop: true }` (a 200 for the reason
   * given at GET /api/operator/jobs), or 503 `policy_unavailable` when the
   * kernel's policy cannot be read. Without `?kernelId=` the rows of a kernel
   * that is stopped, or whose policy cannot be read, are left out. Any other
   * status filter, and the unfiltered history view, are unchanged.
   */
  app.get("/api/operator/approvals", async (req, reply) => {
    const actor = requireActor(req, reply);
    if (!actor) return reply;
    const { kernelId, status } = req.query as { kernelId?: string; status?: string };
    if (kernelId) {
      // String(): a repeated ?kernelId= arrives as an array and names no kernel (404).
      const verdict = await checkKernelOwner(actor, String(kernelId));
      if (!verdict.ok) {
        return reply.status(verdict.status).send({ error: verdict.error, message: verdict.message, kernelId });
      }
    }

    // Asking for the approved queue: ?status=approved, or a repeated ?status=
    // (an array, which is held back like any other work).
    const asksForApproved =
      status !== undefined && (typeof status !== "string" || status === "approved");
    if (kernelId && asksForApproved) {
      const accepts = checkKernelAcceptsJobs(String(kernelId));
      if (!accepts.ok) {
        if (accepts.status === 503) return replyKernelNotAccepting(reply, accepts);
        return { approvals: [], emergencyStop: true };
      }
    }

    try {
      const { db } = getStore();
      let rows;

      if (kernelId && status) {
        rows = db.select().from(pendingApprovals)
          .where(and(eq(pendingApprovals.kernelId, kernelId), eq(pendingApprovals.status, status)))
          .all();
      } else if (kernelId) {
        rows = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.kernelId, kernelId))
          .all();
      } else if (status) {
        rows = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.status, status))
          .all();
      } else {
        rows = db.select().from(pendingApprovals).all();
      }

      if (!kernelId) {
        const kernelIds = [...new Set(rows.map((r) => r.kernelId))];
        const owned = new Set(
          getRepos().kernels.findByIds(kernelIds)
            .filter((k) => ownsKernel(k.operatorAddress, actor))
            .map((k) => k.id),
        );
        rows = rows.filter((r) => owned.has(r.kernelId));
        if (asksForApproved) {
          // A kernel that is stopped, or whose policy cannot be read, hands out no work.
          const heldBack = new Set(
            [...new Set(rows.map((r) => r.kernelId))].filter((id) => !checkKernelAcceptsJobs(id).ok),
          );
          rows = rows.filter((r) => !heldBack.has(r.kernelId));
        }
      }

      return { approvals: rows };
    } catch {
      return { approvals: [] };
    }
  });

  /**
   * The approval's kernel must be owned by the request's actor (owner-only, see
   * the e-stop note above). Returns true when authorized; otherwise the refusal
   * (401 / 404 / 403 / 500) has been sent and nothing was written.
   */
  async function requireApprovalOwner(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    failure: string,
  ): Promise<boolean> {
    const actor = requireActor(req, reply);
    if (!actor) return false;
    let approval: { kernelId: string } | undefined;
    try {
      approval = getStore().db.select().from(pendingApprovals)
        .where(eq(pendingApprovals.id, req.params.id))
        .get();
    } catch {
      void reply.status(500).send({ error: failure });
      return false;
    }
    if (!approval) {
      void reply.status(404).send({ error: "Approval not found or already decided" });
      return false;
    }
    const verdict = await checkKernelOwner(actor, approval.kernelId);
    if (!verdict.ok) {
      void reply.status(verdict.status).send({
        error: verdict.error,
        message: verdict.message,
        kernelId: approval.kernelId,
      });
      return false;
    }
    return true;
  }

  /** POST /api/operator/approvals/:id/approve — Approve a pending job */
  app.post<{ Params: { id: string } }>(
    "/api/operator/approvals/:id/approve",
    async (req, reply) => {
      if (!(await requireApprovalOwner(req, reply, "Failed to approve"))) return reply;
      try {
        const { db } = getStore();
        const now = new Date().toISOString();

        db.update(pendingApprovals)
          .set({ status: "approved", decidedAt: now })
          .where(and(eq(pendingApprovals.id, req.params.id), eq(pendingApprovals.status, "pending")))
          .run();

        const row = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();

        if (!row || row.status !== "approved") {
          return reply.status(404).send({ error: "Approval not found or already decided" });
        }

        return { approval: row, approved: true };
      } catch {
        return reply.status(500).send({ error: "Failed to approve" });
      }
    },
  );

  /** POST /api/operator/approvals/:id/reject — Reject a pending job */
  app.post<{ Params: { id: string } }>(
    "/api/operator/approvals/:id/reject",
    async (req, reply) => {
      const { reason } = (req.body ?? {}) as { reason?: string };
      if (!(await requireApprovalOwner(req, reply, "Failed to reject"))) return reply;

      try {
        const { db } = getStore();
        const now = new Date().toISOString();

        db.update(pendingApprovals)
          .set({ status: "rejected", decidedAt: now, rejectionReason: reason ?? null })
          .where(and(eq(pendingApprovals.id, req.params.id), eq(pendingApprovals.status, "pending")))
          .run();

        const row = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();

        if (!row || row.status !== "rejected") {
          return reply.status(404).send({ error: "Approval not found or already decided" });
        }

        return { approval: row, rejected: true };
      } catch {
        return reply.status(500).send({ error: "Failed to reject" });
      }
    },
  );
}
