import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";

const { operatorPolicies, pendingApprovals } = schema;

/**
 * An operator read the gateway has no real source for yet. It answers 501 with a
 * reason and pointers to the reads that ARE real, instead of inventing data.
 *
 * These four routes used to return hard-coded machines, certifications and
 * maintenance rows, and a freshly randomized daily earnings series on every call. The public
 * agent package advertises them as an operator's earnings, so an agent acting for an
 * operator read invented income. A missing fact is not a plausible number.
 */
function notAvailable(what: string, why: string, see: string[]) {
  return { error: "not_available", message: `${what} ${why} Nothing is returned rather than an estimate.`, see };
}

export async function operatorRoutes(app: FastifyInstance) {
  // Machines: the operator's real kernels, devices and in-flight jobs are at
  // /api/agent/me. There is no per-operator machine registry with utilization or
  // uptime to serve here.
  app.get("/api/operator/machines", async (_req, reply) => {
    return reply.code(501).send(
      notAvailable(
        "Operator machines with utilization and uptime are not recorded.",
        "Your kernels, devices and in-flight jobs are real and available at /api/agent/me.",
        ["/api/agent/me", "/api/kernels/:kernelId", "/api/kernels/:kernelId/devices"],
      ),
    );
  });

  // Earnings: escrow records carry no per-operator payout history or release time,
  // so a daily series cannot be reported. Per-job payout state is at
  // /api/jobs/:jobId/execution (settlement axis, from the escrow record).
  app.get("/api/operator/earnings", async (_req, reply) => {
    return reply.code(501).send(
      notAvailable(
        "Operator earnings history is not recorded yet.",
        "Per-job payment state is available at /api/jobs/:jobId/execution.",
        ["/api/jobs", "/api/jobs/:jobId/execution"],
      ),
    );
  });

  // Certifications: there is no certification store.
  app.get("/api/operator/certifications", async (_req, reply) => {
    return reply.code(501).send(
      notAvailable("Operator certifications are not recorded.", "There is no certification store yet.", []),
    );
  });

  // Maintenance: nothing writes maintenance events yet, so an empty list would read
  // as "no maintenance scheduled" (absence is not evidence).
  app.get("/api/operator/maintenance", async (_req, reply) => {
    return reply.code(501).send(
      notAvailable("Operator maintenance windows are not recorded.", "Nothing records maintenance events yet.", []),
    );
  });

  // ═════════════════════════════════════════════════════════════════
  // Operator Policy — guardrails for job execution
  // ═════════════════════════════════════════════════════════════════

  /** GET /api/operator/policy/:kernelId — Get operator policy */
  app.get<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      let row;
      try {
        const { db } = getStore();
        row = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, req.params.kernelId))
          .get();
      } catch (err) {
        // A failed read is not "no policy set": answering the default here would show
        // an operator's real guardrails as the defaults.
        req.log.warn({ kernelId: req.params.kernelId, err }, "operator policy read failed");
        return reply.code(503).send({ error: "read_failed", message: "The operator policy could not be read. Try again shortly." });
      }
      if (!row) {
        return { policy: DEFAULT_OPERATOR_POLICY, source: "default" };
      }
      return { policy: row.policy, updatedAt: row.updatedAt };
    },
  );

  /** PUT /api/operator/policy/:kernelId — Update full policy */
  app.put<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      const policy = req.body as OperatorPolicy;
      if (!policy || policy.version !== 1) {
        return reply.status(400).send({ error: "Invalid policy: version must be 1" });
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

  /** PATCH /api/operator/policy/:kernelId — Partial update */
  app.patch<{ Params: { kernelId: string } }>(
    "/api/operator/policy/:kernelId",
    async (req, reply) => {
      const patch = req.body as Partial<OperatorPolicy>;

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

  /** POST /api/operator/emergency-stop — Activate emergency stop */
  app.post("/api/operator/emergency-stop", async (req, reply) => {
    const { kernelId, reason } = req.body as { kernelId: string; reason?: string };
    if (!kernelId) return reply.status(400).send({ error: "kernelId required" });

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
    const { kernelId } = req.body as { kernelId: string };
    if (!kernelId) return reply.status(400).send({ error: "kernelId required" });

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

  /** POST /api/operator/approvals/:id/approve — Approve a pending job */
  app.post<{ Params: { id: string } }>(
    "/api/operator/approvals/:id/approve",
    async (req, reply) => {
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
