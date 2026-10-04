import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";

const { operatorPolicies, pendingApprovals, shopKernels } = schema;

/**
 * Board N31 (bus #6272; the steward's ruling #6278). These routes used to change any kernel's
 * stop, policy and approvals for any authenticated caller. Who may act on a kernel now:
 *
 *   - "decide": approve, reject, emergency-resume, PUT or PATCH of the policy (PATCH
 *     {emergencyStop:false} is a resume by another name), and an approval submitted with
 *     autoApprove (a pre-made approval decision). It needs the gateway admin secret, or a wallet
 *     the caller PROVED that is the kernel's operator. WP-A (#326) sets req.provenWallet for a
 *     SIWE session or a key minted from one; nothing sets it before that merges, so until then
 *     only the admin decides. A claimed identity never decides: anyone can provision a key that
 *     names any wallet or email.
 *   - "stop or submit": emergency-stop, and an approval submitted as PENDING. Also the kernel's
 *     own principal: the identity its operatorAddress records, which POST /api/kernels takes from
 *     the registering caller. An operator must never lose their own e-stop, and a pending
 *     approval still needs a decision. The residual, a key provisioned under the operator's
 *     identity stopping the kernel or queueing requests, is queue item 136.
 *
 * The reads (GET policy, GET approvals) are unchanged here.
 */
type KernelAction = "decide" | "stop_or_submit";

interface KernelAuthority {
  /** The request carried a valid X-Admin-Key. */
  admin: boolean;
  /** The wallet the caller proved control of (WP-A); null when none. */
  provenWallet: string | null;
  /** The caller's claimed identity: its API key's operator id, or its session's address. */
  claimed: string | null;
}

/**
 * True only when X-Admin-Key equals PCC_ADMIN_KEY, compared in constant time (both SHA-256'd to
 * fixed-length digests). An unset or blank PCC_ADMIN_KEY, or a missing, empty or repeated header,
 * grants nothing in any environment. (Same rule as routes/kernels.ts; WP-A #326 adds the shared
 * helper, auth/admin-key.ts.)
 */
function hasAdminSecret(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  if (typeof expected !== "string" || expected.trim().length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorityOf(req: FastifyRequest): KernelAuthority {
  const r = req as unknown as { provenWallet?: unknown; operatorId?: unknown; userId?: unknown };
  const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  return {
    admin: hasAdminSecret(req.headers["x-admin-key"]),
    provenWallet: text(r.provenWallet),
    claimed: text(r.operatorId) ?? text(r.userId),
  };
}

const isAnonymous = (a: KernelAuthority) => !a.admin && a.provenWallet === null && a.claimed === null;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
/** operatorAddress values that record no owner: the empty string and the legacy zero placeholder. */
const UNOWNED = new Set(["", "0x0000000000000000000000000000000000000000"]);

function ownerOf(operatorAddress: unknown): string | null {
  if (typeof operatorAddress !== "string") return null;
  const owner = operatorAddress.trim().toLowerCase();
  return UNOWNED.has(owner) ? null : owner;
}

/** The admin secret, or a proven wallet equal to the kernel's operator (both compared as addresses). */
function mayDecide(a: KernelAuthority, operatorAddress: unknown): boolean {
  if (a.admin) return true;
  const owner = ownerOf(operatorAddress);
  if (owner === null || !WALLET_RE.test(owner) || a.provenWallet === null || !WALLET_RE.test(a.provenWallet)) return false;
  return a.provenWallet.toLowerCase() === owner;
}

/** Anyone who may decide, or the caller whose claimed identity is the kernel's recorded operator. */
function mayStopOrSubmit(a: KernelAuthority, operatorAddress: unknown): boolean {
  if (mayDecide(a, operatorAddress)) return true;
  const owner = ownerOf(operatorAddress);
  return owner !== null && a.claimed !== null && a.claimed.toLowerCase() === owner;
}

const AUTHENTICATION_REQUIRED = {
  error: "authentication_required",
  message: "This operator action needs an API key or a signed-in wallet.",
};

const REFUSALS: Record<KernelAction, Record<string, string>> = {
  decide: {
    error: "forbidden",
    reason: "operator_proof_required",
    message:
      "This needs the gateway admin secret, or proof that you control the kernel's operator wallet (wallet sign-in proof, WP-A). An API key's claimed identity is not proof.",
  },
  stop_or_submit: {
    error: "forbidden",
    reason: "not_kernel_operator",
    message: "Only this kernel's operator or the gateway admin may do this.",
  },
};

interface Refusal {
  status: 403 | 404 | 503;
  body: Record<string, string>;
}

/**
 * Null when this caller may take `action` on the kernel; otherwise the refusal to send. The admin
 * may act on any id, registered or not, as before. For anyone else an unregistered kernel is 404
 * (kernel ids are public through GET /api/kernels), and a failed kernel read is 503, never a pass.
 */
function refuseKernelAction(req: FastifyRequest, a: KernelAuthority, kernelId: string, action: KernelAction): Refusal | null {
  if (a.admin) return null;
  let kernel: { operatorAddress: string } | undefined;
  try {
    const { db } = getStore();
    kernel = db.select({ operatorAddress: shopKernels.operatorAddress }).from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
  } catch (err) {
    req.log.warn({ kernelId, err }, "kernel read for an operator action failed");
    return { status: 503, body: { error: "read_failed", message: "The kernel could not be read to check who operates it. Try again shortly." } };
  }
  if (!kernel) return { status: 404, body: { error: "kernel_not_found", message: "No kernel with this id is registered." } };
  const allowed = action === "decide" ? mayDecide(a, kernel.operatorAddress) : mayStopOrSubmit(a, kernel.operatorAddress);
  return allowed ? null : { status: 403, body: REFUSALS[action] };
}

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

/**
 * The 409 body for an approve/reject that changed nothing because the approval had already
 * left "pending". It carries the record's current status and never says this request
 * decided it (no `approved: true` / `rejected: true`).
 */
function alreadyDecided(status: string) {
  return { error: "already_decided", status, message: `This approval is already ${status}; this request changed nothing.` };
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

  // Certifications: registration carries the registrant's own certification claims
  // (packages/db/src/schema/onboarding.ts machineRegistrations.operator.certifications),
  // but nothing verifies them. There is no authoritative, verified certification read.
  app.get("/api/operator/certifications", async (_req, reply) => {
    return reply.code(501).send(
      notAvailable(
        "There is no verified operator-certification read.",
        "Certifications given at registration are the registrant's own claims, stored with the registration and not verified.",
        [],
      ),
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
      const authority = authorityOf(req);
      if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
      const policy = req.body as OperatorPolicy;
      if (!policy || policy.version !== 1) {
        return reply.status(400).send({ error: "Invalid policy: version must be 1" });
      }
      // N31: replacing the policy can clear the stop and every guardrail, so it is a decision.
      const refusal = refuseKernelAction(req, authority, req.params.kernelId, "decide");
      if (refusal) return reply.code(refusal.status).send(refusal.body);

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
      const authority = authorityOf(req);
      if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
      // N31: PATCH {emergencyStop:false} is a resume by another name, so a patch is a decision.
      const refusal = refuseKernelAction(req, authority, req.params.kernelId, "decide");
      if (refusal) return reply.code(refusal.status).send(refusal.body);
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
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    const { kernelId, reason } = (req.body ?? {}) as { kernelId?: unknown; reason?: string };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    // N31: the kernel's own operator may always stop it, even by a claimed identity (fail-safe).
    const refusal = refuseKernelAction(req, authority, kernelId, "stop_or_submit");
    if (refusal) return reply.code(refusal.status).send(refusal.body);

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
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    const { kernelId } = (req.body ?? {}) as { kernelId?: unknown };
    if (typeof kernelId !== "string" || !kernelId) return reply.status(400).send({ error: "kernelId required" });
    // N31: undoing a stop is a decision; a claimed identity may stop but never resume.
    const refusal = refuseKernelAction(req, authority, kernelId, "decide");
    if (refusal) return reply.code(refusal.status).send(refusal.body);

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
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    const { kernelId, agentId, capabilityType, parameters, autoApprove } = (req.body ?? {}) as {
      kernelId?: string; agentId?: string; capabilityType?: string;
      parameters?: Record<string, unknown>; autoApprove?: unknown;
    };
    if (typeof kernelId !== "string" || !kernelId || typeof agentId !== "string" || !agentId) {
      return reply.status(400).send({ error: "kernelId and agentId required" });
    }
    // N31: autoApprove stores an APPROVED record the executor may run, so only a real boolean
    // counts; a truthy string used to approve.
    if (autoApprove !== undefined && typeof autoApprove !== "boolean") {
      return reply.status(400).send({ error: "invalid_body", message: "autoApprove must be a boolean." });
    }
    const preApproved = autoApprove === true;
    // The body above is only cast, not validated: a wrong-shaped value would otherwise be
    // persisted unchanged even though the public type requires a string/plain-object.
    // An explicit null is not a capability type either (cross-family review r1 of #513, M3): only an
    // absent field means "unspecified".
    if (capabilityType !== undefined && (typeof capabilityType !== "string" || !capabilityType)) {
      return reply.status(400).send({ error: "invalid_body", message: "capabilityType must be a non-empty string." });
    }
    if (parameters !== undefined && (parameters === null || typeof parameters !== "object" || Array.isArray(parameters))) {
      return reply.status(400).send({ error: "invalid_body", message: "parameters must be a plain object." });
    }
    // N31: a pre-approved submission is an approval decision; a pending one is a request the
    // kernel's own principal may queue.
    const refusal = refuseKernelAction(req, authority, kernelId, preApproved ? "decide" : "stop_or_submit");
    if (refusal) return reply.code(refusal.status).send(refusal.body);
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
        // capabilityType is unknown unless the caller says so. The spec declares it optional
        // (PendingApproval.jobSummary.capabilityType?: string), so an absent value is left out;
        // it used to be stored as "liquid-handler", a type nobody asserted.
        jobSummary: {
          ...(capabilityType !== undefined && capabilityType !== null ? { capabilityType } : {}),
          parameters: parameters ?? {},
        },
        status: preApproved ? "approved" : "pending",
        createdAt: now,
        decidedAt: preApproved ? now : null,
        expiresAt: expires,
      }).run();

      const row = db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
      return { approval: row, created: true };
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to create approval", detail: e?.message ?? String(e) });
    }
  });

  /** GET /api/operator/approvals — List pending approvals */
  app.get("/api/operator/approvals", async (req, reply) => {
    const query = req.query as { kernelId?: unknown; status?: unknown };
    // A repeated parameter arrives as a list: a client error (400), not a failed read (503).
    for (const [name, value] of [["kernelId", query.kernelId], ["status", query.status]] as const) {
      if (value !== undefined && typeof value !== "string") {
        return reply.code(400).send({ error: "invalid_query", message: `${name} must be given once, as a single value.` });
      }
      // An empty or whitespace-only filter is a client error, not an absent filter:
      // treating it as "no filter" would silently broaden the query past what the caller
      // asked for.
      if (typeof value === "string" && value.trim() === "") {
        return reply.code(400).send({ error: "invalid_query", message: `${name} must not be empty.` });
      }
    }
    const kernelId = query.kernelId as string | undefined;
    const status = query.status as string | undefined;

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
    } catch (err) {
      // A failed read is not "no approvals": an empty list here would hide recorded
      // approvals during an outage. Same refusal as the operator policy read above.
      req.log.warn({ kernelId, status, err }, "operator approvals read failed");
      return reply.code(503).send({ error: "read_failed", message: "The approvals could not be read. Try again shortly." });
    }
  });

  /** POST /api/operator/approvals/:id/approve — Approve a pending job */
  app.post<{ Params: { id: string } }>(
    "/api/operator/approvals/:id/approve",
    async (req, reply) => {
      const authority = authorityOf(req);
      if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
      try {
        const { db } = getStore();
        // N31: the approval's kernel decides who may approve it.
        const target = db.select({ kernelId: pendingApprovals.kernelId }).from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();
        if (!target) return reply.status(404).send({ error: "Approval not found" });
        const refusal = refuseKernelAction(req, authority, target.kernelId, "decide");
        if (refusal) return reply.code(refusal.status).send(refusal.body);
        const now = new Date().toISOString();

        // The update only matches a "pending" row, so its changed-row count is what says
        // whether THIS request made the decision. Accepting any row that reads back as
        // "approved" reported an earlier decision as this request's.
        const { changes } = db.update(pendingApprovals)
          .set({ status: "approved", decidedAt: now })
          .where(and(eq(pendingApprovals.id, req.params.id), eq(pendingApprovals.status, "pending")))
          .run();

        const row = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();

        if (!row) {
          return reply.status(404).send({ error: "Approval not found" });
        }
        if (changes === 0) {
          return reply.status(409).send(alreadyDecided(row.status));
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
      const authority = authorityOf(req);
      if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
      const { reason } = (req.body ?? {}) as { reason?: string };

      try {
        const { db } = getStore();
        // N31: same rule as approve; rejecting is a decision too.
        const target = db.select({ kernelId: pendingApprovals.kernelId }).from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();
        if (!target) return reply.status(404).send({ error: "Approval not found" });
        const refusal = refuseKernelAction(req, authority, target.kernelId, "decide");
        if (refusal) return reply.code(refusal.status).send(refusal.body);
        const now = new Date().toISOString();

        // Same rule as approve: only a changed row means THIS request rejected it.
        const { changes } = db.update(pendingApprovals)
          .set({ status: "rejected", decidedAt: now, rejectionReason: reason ?? null })
          .where(and(eq(pendingApprovals.id, req.params.id), eq(pendingApprovals.status, "pending")))
          .run();

        const row = db.select().from(pendingApprovals)
          .where(eq(pendingApprovals.id, req.params.id))
          .get();

        if (!row) {
          return reply.status(404).send({ error: "Approval not found" });
        }
        if (changes === 0) {
          return reply.status(409).send(alreadyDecided(row.status));
        }

        return { approval: row, rejected: true };
      } catch {
        return reply.status(500).send({ error: "Failed to reject" });
      }
    },
  );
}
