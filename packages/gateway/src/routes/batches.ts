import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SampleSlot } from "@pcc/spec";

// SharedBatch + BatchSlotClaim types inlined until spec rebuilds
interface SharedBatch {
  id: string; kernelId: string; capabilityType: string; totalSlots: number;
  claimedSlots: BatchSlotClaim[]; protocolType: string;
  status: "open" | "filling" | "full" | "running" | "completed" | "cancelled";
  minSlotsToRun: number; createdAt: string; closesAt: string;
  pricePerSlot: string; currency: string; evidenceBundleId?: string;
}
interface BatchSlotClaim {
  id: string; agentId: string; slotIndices: number[]; sampleLabels: string[];
  status: "claimed" | "paid" | "completed" | "refunded";
  amount: string; escrowAddress?: string; claimedAt: string;
}
import { batchTracker } from "../services.js";
import { refuseKernelRequest } from "../auth/kernel-authority.js";

import {
  gateJobRead,
  gateKernelRead,
  jobPartScopeOf,
  keepAsSent,
  kernelScopeOf,
  refuseJobRead,
} from "../readmodels/job-read-gate.js";
import { jobReadCallerOf, operatedKernelsOf, precheckJobRead, JOB_READ_REFUSAL } from "../readmodels/job-execution.js";
import { batchEventVisible, batchViewFor } from "../readmodels/batch-read.js";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";

/**
 * The public face of a shared batch (cross-family review r3 of #403, CRITICAL): the opportunity to
 * join it (its kernel, capability, protocol, price, timing, status and how many slots are taken),
 * never its claims. A claim names its agent, sample labels, amount and escrow address.
 */
function sharedBatchFace(b: SharedBatch) {
  const { claimedSlots, evidenceBundleId: _evidence, ...opportunity } = b;
  return { ...opportunity, claimedSlotCount: claimedSlots.reduce((n, c) => n + c.slotIndices.length, 0) };
}

/**
 * Who may see a shared batch's claims: an admin without a tenant (claims carry no tenant, so a
 * tenant-scoped admin sees the public face), or the operator of the batch's kernel as a proven
 * wallet. Anyone else, including a caller with no credential, sees the public face. A failed read
 * of the caller's kernels also gives the public face.
 */
function sharedClaimsReaderOf(req: import("fastify").FastifyRequest): (kernelId: string) => boolean {
  const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
  if (!pre.proceed) return () => false;
  if (pre.as === "admin") {
    const allKernels = tenantOpts(req as any) === undefined;
    return () => allKernels;
  }
  let operated: ReadonlySet<string>;
  try {
    operated = operatedKernelsOf(pre.wallet, getStore().repos);
  } catch {
    return () => false;
  }
  return (kernelId) => operated.has(kernelId);
}

/** The caller, identity first (as gateJobRead): an admin, a proven wallet, or a refusal. */
const callerOf = (req: FastifyRequest) =>
  precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));

/** 401 without a credential, 403 without a proven wallet. */
const refuseIdentity = (reply: FastifyReply, reason: keyof typeof JOB_READ_REFUSAL) => {
  const refusal = JOB_READ_REFUSAL[reason];
  return reply.status(refusal.status).send(refusal.body);
};

const SAMPLE_TYPES: ReadonlySet<string> = new Set(["unknown", "standard", "blank", "system_suitability", "sample", "spike", "duplicate"]);

/**
 * A new slot's typed fields (SampleSlot without id and status), or undefined when one is missing
 * or not a string. Nothing else in the body reaches the batch: its status, timing and result are
 * the tracker's to set.
 */
function slotInputOf(body: unknown): Omit<SampleSlot, "id" | "status"> | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (!text(b.position) || !text(b.jobId) || !text(b.stepId) || !text(b.userId) || typeof b.sampleLabel !== "string") return undefined;
  if (b.sampleType !== undefined && !(typeof b.sampleType === "string" && SAMPLE_TYPES.has(b.sampleType))) return undefined;
  return {
    position: b.position,
    jobId: b.jobId,
    stepId: b.stepId,
    userId: b.userId as SampleSlot["userId"],
    sampleLabel: b.sampleLabel,
    ...(b.sampleType !== undefined ? { sampleType: b.sampleType as SampleSlot["sampleType"] } : {}),
  };
}

/** The most slots a shared batch may offer (a 1536-well plate). */
const MAX_SHARED_SLOTS = 1536;

// ── In-memory shared batch storage ────────────────────────────────
const sharedBatches = new Map<string, SharedBatch>();

export async function batchRoutes(app: FastifyInstance) {
  // A batch's slots name every sample's job, buyer and result (F3 round 3, cross-family review
  // r2 of #403, CRITICAL), so a whole batch is the kernel's record: its operator's and an
  // admin's (kernelScopeOf / gateKernelRead). No credential is 401, an unproven one 403. A
  // stranger's list leaves the batch out, and its detail is a missing batch's answer.
  app.get<{ Querystring: { kernelId?: string; status?: string } }>(
    "/api/batches",
    async (req, reply) => {
      const scope = kernelScopeOf(req);
      if (!scope.ok) return refuseJobRead(reply, scope);
      // Each batch as this caller may see it: a typed projection of the live batch (readmodels/batch-read.ts).
      const parts = jobPartScopeOf(req);
      if (!parts.ok) return refuseJobRead(reply, parts);
      const batches = batchTracker
        .getAllBatches({ kernelId: req.query.kernelId, status: req.query.status as any })
        .filter((batch) => scope.kernels === null || scope.kernels.has(batch.kernelId))
        .map((batch) => batchViewFor(batch, parts)?.batch)
        .filter((batch) => batch !== undefined);
      return { batches };
    },
  );

  // Batch detail with slots
  app.get<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req, reply) => {
    const gate = gateKernelRead(req, () => batchTracker.getBatch(req.params.batchId)?.kernelId);
    if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
    const batch = gate.ok ? batchTracker.getBatch(req.params.batchId) : undefined;
    if (!batch) return { error: "not_found" };
    // The batch and its events as this caller may see them (readmodels/batch-read.ts; reviews r3 to
    // r5 of #403): slots whose live job it may not read, the runConfig of a batch it does not see
    // whole, and every event owned by a job it may not read (a withheld slot's sample events, and
    // the batch-level events of a batch it does not see whole) are left out.
    const parts = jobPartScopeOf(req);
    if (!parts.ok) return refuseJobRead(reply, parts);
    const view = batchViewFor(batch, parts);
    if (!view) return { error: "not_found" };
    return {
      batch: view.batch,
      events: keepAsSent(batchTracker.getEvents(req.params.batchId), (event) => batchEventVisible(event, req.params.batchId, parts)),
    };
  });

  // Batches containing a specific job's samples. They are that job's records, so the job
  // read gate runs first (F3 round 2); a job the caller may not read has no batches. A shared
  // batch also holds other jobs' slots: the job's buyer sees only this job's slots; the
  // operator of the batch's kernel, and an admin, see the whole batch (F3 round 3).
  app.get<{ Params: { jobId: string } }>("/api/batches/by-job/:jobId", async (req, reply) => {
    const gate = gateJobRead(req, req.params.jobId);
    if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
    if (!gate.ok) return { batches: [] };
    const parts = jobPartScopeOf(req);
    if (!parts.ok) return refuseJobRead(reply, parts);
    const whole = (batch: { kernelId: string }) =>
      gate.as === "admin" || (gate.as === "kernel_operator" && batch.kernelId === gate.job.kernelId);
    // The operator of the batch's kernel and an admin: the batch as they may see it; a buyer: only
    // the slots whose live job is this job (and so, in a shared batch, no runConfig).
    const batches = batchTracker
      .getBatchesForJob(req.params.jobId)
      .map((batch) => batchViewFor(batch, parts, whole(batch) ? undefined : (slot) => slot.jobId === req.params.jobId)?.batch)
      .filter((batch) => batch !== undefined);
    return { batches };
  });

  // Add a sample slot to an assembling batch. A slot puts a job's sample into a kernel's batch
  // (found while fixing review r5 of #403, the class of its HIGH): identity first (401, 403); then
  // only an admin or the operator of the batch's kernel (gateKernelRead), and anyone else gets the
  // answer a missing batch gets; then the job must be one of that kernel's that the caller may read
  // (gateJobRead), and any other gets the answer a missing job gets.
  app.post<{ Params: { batchId: string } }>(
    "/api/batches/:batchId/slots",
    async (req, reply) => {
      const pre = callerOf(req);
      if (!pre.proceed) return refuseIdentity(reply, pre.reason);
      const missingBatch = () => reply.code(400).send({ error: `Batch ${req.params.batchId} not found` });
      const gate = gateKernelRead(req, () => batchTracker.getBatch(req.params.batchId)?.kernelId);
      if (!gate.ok) return gate.kind === "not_found" ? missingBatch() : refuseJobRead(reply, gate);
      const input = slotInputOf(req.body);
      if (!input) {
        return reply.code(400).send({ error: "position, jobId, stepId, userId and sampleLabel must be strings, and sampleType a sample type" });
      }
      const job = gateJobRead(req, input.jobId);
      if (!job.ok && job.kind !== "not_found") return refuseJobRead(reply, job);
      if (!job.ok || job.job.kernelId !== gate.kernelId) {
        return reply.code(400).send({ error: `Job ${input.jobId} not found on this batch's kernel` });
      }
      try {
        const slot = batchTracker.addSample(req.params.batchId, input);
        return { slot };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // Multi-User Shared Batches — multiple users share one run
  // ═════════════════════════════════════════════════════════════════

  /**
   * POST /api/batches/shared — Open a shared batch run. It offers a kernel's capacity for sale, so it
   * is the kernel operator's or an admin's (found while fixing review r5 of #403, the class of its
   * HIGH): 401 without a credential, 403 without a proven wallet or for a wallet that does not
   * operate the kernel.
   */
  app.post("/api/batches/shared", async (req, reply) => {
    const pre = callerOf(req);
    if (!pre.proceed) return refuseIdentity(reply, pre.reason);
    const body = (req.body ?? {}) as {
      kernelId: string;
      capabilityType: string;
      totalSlots: number;
      protocolType: string;
      minSlotsToRun?: number;
      closesAt?: string;
      pricePerSlot: string;
      currency?: string;
    };

    if (!body.kernelId || !body.capabilityType || !body.totalSlots || !body.pricePerSlot) {
      return reply.status(400).send({ error: "kernelId, capabilityType, totalSlots, and pricePerSlot required" });
    }
    if (typeof body.kernelId !== "string" || !Number.isSafeInteger(body.totalSlots) || body.totalSlots < 1 || body.totalSlots > MAX_SHARED_SLOTS) {
      return reply.status(400).send({ error: `kernelId must be a string and totalSlots a whole number from 1 to ${MAX_SHARED_SLOTS}` });
    }
    const kernels = kernelScopeOf(req);
    if (!kernels.ok) return refuseJobRead(reply, kernels);
    if (kernels.kernels !== null && !kernels.kernels.has(body.kernelId)) {
      return reply.status(403).send({ error: "forbidden", message: "Only the kernel's operator or an admin may open a shared batch on it." });
    }

    // N31c (the body/query inventory; the steward's #6540): a shared batch offers slots on the kernel it names, at a price, so it needs that kernel's
    // operator's DECISION (DECISIONS 01:25: acting as the operator, or spending a paid resource):
    // the admin or the PROVEN operator wallet, never a claimed key.
    const refusal = refuseKernelRequest(req, String(body.kernelId), "decide");
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    const batch: SharedBatch = {
      id: `sbatch-${crypto.randomUUID().slice(0, 12)}`,
      kernelId: body.kernelId,
      capabilityType: body.capabilityType,
      totalSlots: body.totalSlots,
      claimedSlots: [],
      protocolType: body.protocolType,
      status: "open",
      minSlotsToRun: body.minSlotsToRun ?? 1,
      createdAt: new Date().toISOString(),
      closesAt: body.closesAt ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      pricePerSlot: body.pricePerSlot,
      currency: (body.currency ?? "USDC") as any,
    };

    sharedBatches.set(batch.id, batch);
    return { batch };
  });

  /**
   * GET /api/batches/shared/open — List open batches available to join. Anyone sees the
   * opportunity (sharedBatchFace); the claims are the kernel operator's and an admin's.
   */
  app.get("/api/batches/shared/open", async (req) => {
    const { kernelId, capabilityType } = req.query as { kernelId?: string; capabilityType?: string };
    let batches = [...sharedBatches.values()].filter(
      (b) => b.status === "open" || b.status === "filling",
    );
    if (kernelId) batches = batches.filter((b) => b.kernelId === kernelId);
    if (capabilityType) batches = batches.filter((b) => b.capabilityType === capabilityType);
    const claimsReader = sharedClaimsReaderOf(req);
    return { batches: batches.map((b) => (claimsReader(b.kernelId) ? b : sharedBatchFace(b))) };
  });

  /** GET /api/batches/shared/:batchId — Get batch details including all claims */
  app.get<{ Params: { batchId: string } }>("/api/batches/shared/:batchId", async (req, reply) => {
    const batch = sharedBatches.get(req.params.batchId);
    if (!batch) return reply.status(404).send({ error: "Batch not found" });

    const claimedCount = batch.claimedSlots.reduce((sum: number, c: BatchSlotClaim) => sum + c.slotIndices.length, 0);
    return {
      batch: sharedClaimsReaderOf(req)(batch.kernelId) ? batch : sharedBatchFace(batch),
      summary: {
        totalSlots: batch.totalSlots,
        claimedSlots: claimedCount,
        availableSlots: batch.totalSlots - claimedCount,
        claimants: batch.claimedSlots.length,
        fillPercent: Math.round((claimedCount / batch.totalSlots) * 100),
      },
    };
  });

  /** POST /api/batches/shared/:batchId/claim — Claim slots in a batch */
  app.post<{ Params: { batchId: string } }>(
    "/api/batches/shared/:batchId/claim",
    async (req, reply) => {
      // A claim books slots, and their price, for its claimant (review r5 of #403, HIGH): identity
      // first (401, 403). A proven wallet claims for itself only: agentId defaults to it, and naming
      // another claimant is 403. An admin names the claimant.
      const pre = callerOf(req);
      if (!pre.proceed) return refuseIdentity(reply, pre.reason);
      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });
      if (batch.status !== "open" && batch.status !== "filling") {
        return reply.status(409).send({ error: `Batch is ${batch.status}, cannot claim slots` });
      }

      const body = (req.body ?? {}) as {
        agentId?: unknown;
        slotCount: number;
        sampleLabels?: string[];
        preferredIndices?: number[];
      };

      let agentId: string;
      if (pre.as === "proven") {
        if (body.agentId !== undefined && !(typeof body.agentId === "string" && body.agentId.trim().toLowerCase() === pre.wallet)) {
          return reply.status(403).send({ error: "forbidden", message: "A claim is made for the signed-in wallet only." });
        }
        agentId = pre.wallet;
      } else {
        if (typeof body.agentId !== "string" || body.agentId.trim() === "") {
          return reply.status(400).send({ error: "agentId and slotCount required" });
        }
        agentId = body.agentId;
      }
      if (!Number.isSafeInteger(body.slotCount) || body.slotCount < 1) {
        return reply.status(400).send({ error: "slotCount must be a whole number of at least 1" });
      }
      if (body.sampleLabels !== undefined && !(Array.isArray(body.sampleLabels) && body.sampleLabels.every((label) => typeof label === "string"))) {
        return reply.status(400).send({ error: "sampleLabels must be strings" });
      }

      // Calculate which indices are already claimed
      const claimedIndices = new Set(batch.claimedSlots.flatMap((c) => c.slotIndices));
      const claimedCount = claimedIndices.size;
      const available = batch.totalSlots - claimedCount;

      if (body.slotCount > available) {
        return reply.status(409).send({
          error: `Only ${available} slots available, requested ${body.slotCount}`,
        });
      }

      // Assign indices — prefer requested, otherwise auto-assign contiguous
      let indices: number[];
      if (Array.isArray(body.preferredIndices) && body.preferredIndices.length === body.slotCount) {
        const wanted = body.preferredIndices;
        if (!wanted.every((i) => Number.isSafeInteger(i) && i >= 0 && i < batch.totalSlots) || new Set(wanted).size !== wanted.length) {
          return reply.status(400).send({ error: `preferredIndices must be distinct slot numbers from 0 to ${batch.totalSlots - 1}` });
        }
        const conflict = body.preferredIndices.find((i) => claimedIndices.has(i));
        if (conflict !== undefined) {
          return reply.status(409).send({ error: `Slot ${conflict} is already claimed` });
        }
        indices = body.preferredIndices;
      } else {
        indices = [];
        for (let i = 0; i < batch.totalSlots && indices.length < body.slotCount; i++) {
          if (!claimedIndices.has(i)) indices.push(i);
        }
      }

      const perSlotPrice = parseFloat(batch.pricePerSlot);
      const claim: BatchSlotClaim = {
        id: `claim-${crypto.randomUUID().slice(0, 12)}`,
        agentId,
        slotIndices: indices,
        sampleLabels: body.sampleLabels ?? indices.map((i) => `sample-${i}`),
        status: "claimed",
        amount: (perSlotPrice * body.slotCount).toFixed(2),
        claimedAt: new Date().toISOString(),
      };

      batch.claimedSlots.push(claim);

      // Update batch status
      const totalClaimed = claimedCount + body.slotCount;
      if (totalClaimed >= batch.totalSlots) {
        batch.status = "full";
      } else if (batch.status === "open") {
        batch.status = "filling";
      }

      return { claim, batchStatus: batch.status, slotsRemaining: batch.totalSlots - totalClaimed };
    },
  );

  /** DELETE /api/batches/shared/:batchId/claim/:claimId — Release claimed slots */
  app.delete<{ Params: { batchId: string; claimId: string } }>(
    "/api/batches/shared/:batchId/claim/:claimId",
    async (req, reply) => {
      // Releasing a claim reads and removes it (review r4 of #403, HIGH): identity first (401 without
      // a credential, 403 without a proven wallet), then only the batch's kernel operator, an admin
      // without a tenant, or the claimant the claim names (a proven wallet equal to its agentId) may
      // release it. Anyone else gets the answer a missing claim gets.
      const pre = precheckJobRead(jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }));
      if (!pre.proceed) {
        const refusal = JOB_READ_REFUSAL[pre.reason];
        return reply.status(refusal.status).send(refusal.body);
      }
      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      const claimIdx = batch.claimedSlots.findIndex((c) => c.id === req.params.claimId);
      const claimant = claimIdx === -1 ? undefined : batch.claimedSlots[claimIdx]!.agentId;
      const mayRelease =
        sharedClaimsReaderOf(req)(batch.kernelId) ||
        (pre.as === "proven" && typeof claimant === "string" && claimant.trim().toLowerCase() === pre.wallet);
      if (claimIdx === -1 || !mayRelease) return reply.status(404).send({ error: "Claim not found" });

      if (batch.status === "running" || batch.status === "completed") {
        return reply.status(409).send({ error: `Cannot release slots from a ${batch.status} batch` });
      }

      const removed = batch.claimedSlots.splice(claimIdx, 1)[0];

      // Revert status if needed
      if (batch.status === "full") batch.status = "filling";
      if (batch.claimedSlots.length === 0) batch.status = "open";

      return { released: true, claim: removed, batchStatus: batch.status };
    },
  );

  /** GET /api/batches/shared/:batchId/availability — Check available slots */
  app.get<{ Params: { batchId: string } }>(
    "/api/batches/shared/:batchId/availability",
    async (req, reply) => {
      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      const claimedIndices = new Set(batch.claimedSlots.flatMap((c) => c.slotIndices));
      const availableIndices = [];
      for (let i = 0; i < batch.totalSlots; i++) {
        if (!claimedIndices.has(i)) availableIndices.push(i);
      }

      return {
        total: batch.totalSlots,
        claimed: claimedIndices.size,
        available: availableIndices.length,
        availableIndices,
        // Who claimed which slots is the kernel operator's and an admin's to see.
        ...(sharedClaimsReaderOf(req)(batch.kernelId)
          ? {
              claimedBy: batch.claimedSlots.map((c) => ({
                agentId: c.agentId,
                slotCount: c.slotIndices.length,
                indices: c.slotIndices,
              })),
            }
          : {}),
        pricePerSlot: batch.pricePerSlot,
        currency: batch.currency,
      };
    },
  );
}
