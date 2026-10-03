import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
import { getKernelFacade } from "../facades/index.js";

// ── In-memory shared batch storage ────────────────────────────────
const sharedBatches = new Map<string, SharedBatch>();

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The authenticated caller (an API key's operator, else a session's user), as
 * apiGate set it, trimmed. Null when there is none or it is blank, so a blank
 * identity never matches anything.
 */
function callerIdentity(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: unknown; userId?: unknown };
  const raw = r.operatorId ?? r.userId;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id ? id : null;
}

export async function batchRoutes(app: FastifyInstance) {
  // List batch manifests — from in-memory BatchTracker (live lifecycle state)
  app.get<{ Querystring: { kernelId?: string; status?: string } }>(
    "/api/batches",
    async (req) => {
      const batches = batchTracker.getAllBatches({
        kernelId: req.query.kernelId,
        status: req.query.status as any,
      });
      return { batches };
    },
  );

  // Batch detail with slots
  app.get<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req) => {
    const batch = batchTracker.getBatch(req.params.batchId);
    if (!batch) return { error: "not_found" };
    return { batch, events: batchTracker.getEvents(req.params.batchId) };
  });

  // Batches containing a specific job's samples
  app.get<{ Params: { jobId: string } }>("/api/batches/by-job/:jobId", async (req) => {
    const batches = batchTracker.getBatchesForJob(req.params.jobId);
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

  /**
   * POST /api/batches/shared — Create a shared batch run.
   *
   * N55: a shared batch is the kernel operator's priced offer, so only the
   * operator of the kernel it names may create one (the kernel-operator check of
   * routes/lob.ts and routes/carrier.ts). No identity: 401. Unknown kernel: 404.
   * A kernel with no operator, or the zero address, has nobody to act for it:
   * 403 kernel_unowned. Anyone else: 403 not_kernel_operator.
   */
  app.post("/api/batches/shared", async (req, reply) => {
    const caller = callerIdentity(req);
    if (!caller) return reply.status(401).send({ error: "unauthenticated" });

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

    const kernelRes = await getKernelFacade().getById(body.kernelId);
    if (!kernelRes.success) {
      const notFound = kernelRes.error.httpStatus === 404;
      return reply.status(notFound ? 404 : 502).send({ error: notFound ? "kernel_not_found" : "kernel_lookup_failed" });
    }
    const recorded = (kernelRes.data as { operatorAddress?: unknown }).operatorAddress;
    const owner = typeof recorded === "string" ? recorded.trim() : "";
    if (!owner || owner.toLowerCase() === ZERO_ADDRESS) {
      return reply.status(403).send({ error: "kernel_unowned" }); // nobody to act for it: fail closed
    }
    if (owner.toLowerCase() !== caller.toLowerCase()) {
      return reply.status(403).send({ error: "not_kernel_operator" });
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

  /** GET /api/batches/shared/open — List open batches available to join */
  app.get("/api/batches/shared/open", async (req) => {
    const { kernelId, capabilityType } = req.query as { kernelId?: string; capabilityType?: string };
    let batches = [...sharedBatches.values()].filter(
      (b) => b.status === "open" || b.status === "filling",
    );
    if (kernelId) batches = batches.filter((b) => b.kernelId === kernelId);
    if (capabilityType) batches = batches.filter((b) => b.capabilityType === capabilityType);
    return { batches };
  });

  /** GET /api/batches/shared/:batchId — Get batch details including all claims */
  app.get<{ Params: { batchId: string } }>("/api/batches/shared/:batchId", async (req, reply) => {
    const batch = sharedBatches.get(req.params.batchId);
    if (!batch) return reply.status(404).send({ error: "Batch not found" });

    const claimedCount = batch.claimedSlots.reduce((sum: number, c: BatchSlotClaim) => sum + c.slotIndices.length, 0);
    return {
      batch,
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
        claimedBy: batch.claimedSlots.map((c) => ({
          agentId: c.agentId,
          slotCount: c.slotIndices.length,
          indices: c.slotIndices,
        })),
        pricePerSlot: batch.pricePerSlot,
        currency: batch.currency,
      };
    },
  );
}
