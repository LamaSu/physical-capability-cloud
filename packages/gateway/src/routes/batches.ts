import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
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

import {
  gateJobRead,
  gateKernelRead,
  jobPartScopeOf,
  keepAsSent,
  kernelScopeOf,
  refuseJobRead,
  streamEventFilterOf,
} from "../readmodels/job-read-gate.js";
import { jobReadCallerOf, operatedKernelsOf, precheckJobRead } from "../readmodels/job-execution.js";
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
      const parts = jobPartScopeOf(req);
      if (!parts.ok) return refuseJobRead(reply, parts);
      const batches = batchTracker
        .getAllBatches({ kernelId: req.query.kernelId, status: req.query.status as any })
        .filter((batch) => scope.kernels === null || scope.kernels.has(batch.kernelId))
        .map((batch) => (parts.all ? batch : { ...batch, slots: batch.slots.filter((slot) => parts.keep(slot.jobId)) }));
      return { batches };
    },
  );

  // Batch detail with slots
  app.get<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req, reply) => {
    const gate = gateKernelRead(req, () => batchTracker.getBatch(req.params.batchId)?.kernelId);
    if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
    const batch = gate.ok ? batchTracker.getBatch(req.params.batchId) : undefined;
    if (!batch) return { error: "not_found" };
    // Each slot and event bound to a job is also that job's record (review r3 of #403, CRITICAL):
    // under TENANT_ENFORCE only the caller's tenant's jobs show.
    const parts = jobPartScopeOf(req);
    if (!parts.ok) return refuseJobRead(reply, parts);
    const events = streamEventFilterOf(req);
    if (!events.ok) return refuseJobRead(reply, events);
    return {
      batch: parts.all ? batch : { ...batch, slots: batch.slots.filter((slot) => parts.keep(slot.jobId)) },
      events: keepAsSent(batchTracker.getEvents(req.params.batchId), events.keep),
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
    const batches = batchTracker.getBatchesForJob(req.params.jobId).map((batch) => ({
      ...batch,
      // The whole batch, of the jobs the caller may read under TENANT_ENFORCE; a buyer, its own slots.
      slots: whole(batch)
        ? batch.slots.filter((slot) => parts.keep(slot.jobId))
        : batch.slots.filter((slot) => slot.jobId === req.params.jobId),
    }));
    return { batches };
  });

  // Add sample slot to assembling batch
  app.post<{ Params: { batchId: string }; Body: Omit<SampleSlot, "id" | "status"> }>(
    "/api/batches/:batchId/slots",
    async (req, reply) => {
      try {
        const slot = batchTracker.addSample(
          req.params.batchId,
          req.body as Omit<SampleSlot, "id" | "status">,
        );
        return { slot };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // Multi-User Shared Batches — multiple users share one run
  // ═════════════════════════════════════════════════════════════════

  /** POST /api/batches/shared — Create a shared batch run */
  app.post("/api/batches/shared", async (req, reply) => {
    const body = req.body as {
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
      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });
      if (batch.status !== "open" && batch.status !== "filling") {
        return reply.status(409).send({ error: `Batch is ${batch.status}, cannot claim slots` });
      }

      const body = req.body as {
        agentId: string;
        slotCount: number;
        sampleLabels?: string[];
        preferredIndices?: number[];
      };

      if (!body.agentId || !body.slotCount) {
        return reply.status(400).send({ error: "agentId and slotCount required" });
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
      if (body.preferredIndices && body.preferredIndices.length === body.slotCount) {
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
        agentId: body.agentId,
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
      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      const claimIdx = batch.claimedSlots.findIndex((c) => c.id === req.params.claimId);
      if (claimIdx === -1) return reply.status(404).send({ error: "Claim not found" });

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
