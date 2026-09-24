import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MaintenanceEvent, OperatorCertification, OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";
import type { FastifyReply, FastifyRequest } from "fastify";
import { checkKernelOwner, requireActor, requireKernelOwner } from "../auth/kernel-owner-guard.js";

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

  /** GET /api/operator/policy/:kernelId — Get operator policy */
  app.get<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req) => {
      try {
        const { db } = getStore();
        const row = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, req.params.kernelId))
          .get();

        if (!row) {
          return { policy: DEFAULT_OPERATOR_POLICY, source: "default" };
        }
        return { policy: row.policy, updatedAt: row.updatedAt };
      } catch {
        return { policy: DEFAULT_OPERATOR_POLICY, source: "default" };
      }
    },
  );

  /**
   * PUT /api/operator/policy/:kernelId — Update full policy
   *
   * OWNER-ONLY (WP-C, N31): the policy carries `emergencyStop`, so writing it
   * is the same authority as the e-stop routes below. requireKernelOwner runs
   * before any write (401 / 404 / 403 not_kernel_owner).
   */
  app.put<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      const policy = req.body as OperatorPolicy;
      if (!policy || policy.version !== 1) {
        return reply.status(400).send({ error: "Invalid policy: version must be 1" });
      }
      if (!(await requireKernelOwner(req, reply, req.params.kernelId))) return reply;

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
      if (!(await requireKernelOwner(req, reply, req.params.kernelId))) return reply;

      try {
        const { db } = getStore();
        const row = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, req.params.kernelId))
          .get();

        const existing = (row?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;
        const merged = { ...existing, ...patch, version: 1 } as OperatorPolicy;
        const now = new Date().toISOString();

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
  // any key could stop or resume any kernel.)

  /** POST /api/operator/emergency-stop — Activate emergency stop */
  app.post("/api/operator/emergency-stop", async (req, reply) => {
    const { kernelId, reason } = (req.body ?? {}) as { kernelId?: unknown; reason?: string };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    if (!(await requireKernelOwner(req, reply, kernelId))) return reply;

    try {
      const { db } = getStore();
      const row = db.select().from(operatorPolicies)
        .where(eq(operatorPolicies.kernelId, kernelId))
        .get();

      const policy = (row?.policy ?? { ...DEFAULT_OPERATOR_POLICY }) as unknown as OperatorPolicy;
      policy.emergencyStop = true;
      const now = new Date().toISOString();

      db.insert(operatorPolicies)
        .values({ kernelId, policy: policy as any, updatedAt: now, updatedBy: "emergency-stop" })
        .onConflictDoUpdate({
          target: operatorPolicies.kernelId,
          set: { policy: policy as any, updatedAt: now, updatedBy: "emergency-stop" },
        })
        .run();

      // Cancel all pending approvals for this kernel
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
    const { kernelId } = (req.body ?? {}) as { kernelId?: unknown };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    if (!(await requireKernelOwner(req, reply, kernelId))) return reply;

    try {
      const { db } = getStore();
      const row = db.select().from(operatorPolicies)
        .where(eq(operatorPolicies.kernelId, kernelId))
        .get();

      if (!row) return reply.status(404).send({ error: "No policy found for kernel" });

      const policy = row.policy as unknown as OperatorPolicy;
      policy.emergencyStop = false;
      const now = new Date().toISOString();

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

  /** POST /api/operator/approvals — Submit a job for approval */
  app.post("/api/operator/approvals", async (req, reply) => {
    const { kernelId, agentId, capabilityType, parameters, autoApprove } = (req.body ?? {}) as {
      kernelId?: string; agentId?: string; capabilityType?: string;
      parameters?: Record<string, unknown>; autoApprove?: boolean;
    };
    if (!kernelId || !agentId) {
      return reply.status(400).send({ error: "kernelId and agentId required" });
    }
    try {
      const { db } = getStore();
      const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.insert(pendingApprovals).values({
        id,
        kernelId,
        jobId,
        submittedBy: agentId,
        jobSummary: { capabilityType: capabilityType ?? "liquid-handler", parameters: parameters ?? {} },
        status: autoApprove ? "approved" : "pending",
        createdAt: now,
        decidedAt: autoApprove ? now : null,
        expiresAt: expires,
      }).run();

      const row = db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
      return { approval: row, created: true };
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to create approval", detail: e?.message ?? String(e) });
    }
  });

  /** GET /api/operator/approvals — List pending approvals */
  app.get("/api/operator/approvals", async (req) => {
    const { kernelId, status } = req.query as { kernelId?: string; status?: string };

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
