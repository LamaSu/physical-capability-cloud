import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BatchEvent, BatchManifest, SampleSlot } from "@pcc/spec";

// SharedBatch + BatchSlotClaim types inlined until spec rebuilds
interface SharedBatch {
  id: string; kernelId: string; capabilityType: string; totalSlots: number;
  claimedSlots: BatchSlotClaim[]; protocolType: string;
  status: "open" | "filling" | "full" | "running" | "completed" | "cancelled";
  minSlotsToRun: number; createdAt: string; closesAt: string;
  pricePerSlot: string; currency: string; evidenceBundleId?: string;
  /** The authenticated principal that created the batch (N49). */
  createdBy: string;
}
interface BatchSlotClaim {
  id: string; agentId: string; slotIndices: number[]; sampleLabels: string[];
  status: "claimed" | "paid" | "completed" | "refunded";
  amount: string; escrowAddress?: string; claimedAt: string;
}
import { batchTracker } from "../services.js";
import { requireAuth } from "../auth/require-auth.js";

// ── In-memory shared batch storage ────────────────────────────────
// Module-local and in memory: a restart loses every batch and claim, and two
// gateway instances would keep two ledgers. Batch pooling is not durable yet.
const sharedBatches = new Map<string, SharedBatch>();

// ── Input limits (N49 round 2, coord-watch #2939, gateway LOW-1) ──
/** The largest standard plate has 1536 wells. */
const MAX_TOTAL_SLOTS = 1536;
/** Ids, types, positions and sample labels. */
const MAX_TEXT = 200;
/** A non-negative decimal amount with at most 6 decimals (USDC precision). */
const AMOUNT_RE = /^\d{1,9}(\.\d{1,6})?$/;
const SAMPLE_TYPES = new Set(["unknown", "standard", "blank", "system_suitability", "sample", "spike", "duplicate"]);

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

// Board row N49: a claim belongs to the authenticated caller (req.userId, which
// apiGate sets from the API key's operatorId or the wallet session). A request
// body can never name a different claimant. Only the claimant sees the claim
// itself. Everyone else sees which slots are taken and their status: no
// claimant, sample labels, claim id (so a future claimId-keyed route cannot
// become an IDOR), amount, escrow or time.
function viewClaim(claim: BatchSlotClaim, viewer: string | null) {
  if (viewer !== null && claim.agentId === viewer) return { ...claim, own: true };
  return { slotIndices: claim.slotIndices, status: claim.status, agentId: null, sampleLabels: [], own: false };
}

function viewBatch(batch: SharedBatch, viewer: string | null) {
  return {
    ...batch,
    createdBy: viewer !== null && batch.createdBy === viewer ? batch.createdBy : null,
    claimedSlots: batch.claimedSlots.map((c) => viewClaim(c, viewer)),
  };
}

// The legacy batch manifests (batchTracker) hold every sample's owner, label,
// job and result reference. A viewer sees those only for their own samples.
function viewSlot(slot: SampleSlot, viewer: string | null) {
  if (viewer !== null && slot.userId === viewer) return { ...slot, own: true };
  return {
    id: slot.id,
    position: slot.position,
    sampleType: slot.sampleType,
    status: slot.status,
    acquisitionStart: slot.acquisitionStart,
    acquisitionEnd: slot.acquisitionEnd,
    own: false,
  };
}

function viewManifest(batch: BatchManifest, viewer: string | null) {
  return { ...batch, slots: batch.slots.map((s) => viewSlot(s, viewer)) };
}

/** Events about another viewer's sample keep their type and time, not their payload. */
function viewEvents(batch: BatchManifest, events: BatchEvent[], viewer: string | null) {
  const mine = new Set(batch.slots.filter((s) => viewer !== null && s.userId === viewer).map((s) => s.id));
  return events.map((e) => (e.slotId && !mine.has(e.slotId) ? { ...e, payload: {} } : e));
}

/** Test-only: reset the in-memory shared-batch store. */
export function _clearSharedBatchesForTests(): void {
  sharedBatches.clear();
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
      return { batches: batches.map((b) => viewManifest(b, req.userId ?? null)) };
    },
  );

  // Batch detail with slots
  app.get<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req, reply) => {
    const batch = batchTracker.getBatch(req.params.batchId);
    if (!batch) return reply.status(404).send({ error: "not_found" });
    const viewer = req.userId ?? null;
    return { batch: viewManifest(batch, viewer), events: viewEvents(batch, batchTracker.getEvents(req.params.batchId), viewer) };
  });

  // Batches containing a specific job's samples
  app.get<{ Params: { jobId: string } }>("/api/batches/by-job/:jobId", async (req) => {
    const batches = batchTracker.getBatchesForJob(req.params.jobId);
    return { batches: batches.map((b) => viewManifest(b, req.userId ?? null)) };
  });

  // Add sample slot to assembling batch. The sample belongs to the caller: a
  // body userId may only name the caller (N49, same rule as a shared claim).
  app.post<{ Params: { batchId: string } }>(
    "/api/batches/:batchId/slots",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const owner = req.userId;
      if (!owner) return reply.status(401).send({ error: "Authentication required" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.userId !== undefined && body.userId !== owner) {
        return reply.status(403).send({
          error: "agent_mismatch",
          message: "userId must be omitted or equal the authenticated caller",
        });
      }
      if (!isText(body.position) || !isText(body.jobId) || !isText(body.stepId) || !isText(body.sampleLabel)) {
        return reply.status(400).send({
          error: `position, jobId, stepId and sampleLabel must be non-empty strings of at most ${MAX_TEXT} characters`,
        });
      }
      if (body.sampleType !== undefined && !SAMPLE_TYPES.has(body.sampleType as string)) {
        return reply.status(400).send({ error: "sampleType is not a known sample type" });
      }
      try {
        const slot = batchTracker.addSample(req.params.batchId, {
          position: body.position,
          jobId: body.jobId,
          stepId: body.stepId,
          sampleLabel: body.sampleLabel,
          sampleType: body.sampleType as SampleSlot["sampleType"],
          userId: owner,
        });
        return { slot: viewSlot(slot, owner) };
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
   * Authenticated, and the creator is recorded. Binding the batch to the
   * kernel's operator is board row N55 (it needs requireKernelOperator from
   * #335 / WP-C).
   */
  app.post("/api/batches/shared", { preHandler: [requireAuth] }, async (req, reply) => {
    const creator = req.userId;
    if (!creator) return reply.status(401).send({ error: "Authentication required" });
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!isText(body.kernelId) || !isText(body.capabilityType)) {
      return reply.status(400).send({ error: `kernelId and capabilityType must be non-empty strings of at most ${MAX_TEXT} characters` });
    }
    if (body.protocolType !== undefined && !isText(body.protocolType)) {
      return reply.status(400).send({ error: `protocolType must be a non-empty string of at most ${MAX_TEXT} characters` });
    }
    const totalSlots = body.totalSlots;
    if (!Number.isInteger(totalSlots) || (totalSlots as number) < 1 || (totalSlots as number) > MAX_TOTAL_SLOTS) {
      return reply.status(400).send({ error: `totalSlots must be an integer from 1 to ${MAX_TOTAL_SLOTS}` });
    }
    const minSlotsToRun = body.minSlotsToRun ?? 1;
    if (!Number.isInteger(minSlotsToRun) || (minSlotsToRun as number) < 1 || (minSlotsToRun as number) > (totalSlots as number)) {
      return reply.status(400).send({ error: "minSlotsToRun must be an integer from 1 to totalSlots" });
    }
    // The dashboard sends a number; other clients send a decimal string.
    const rawPrice = body.pricePerSlot;
    const pricePerSlot =
      typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice < 1e9
        ? rawPrice.toFixed(6).replace(/\.?0+$/, "")
        : rawPrice;
    if (typeof pricePerSlot !== "string" || !AMOUNT_RE.test(pricePerSlot)) {
      return reply.status(400).send({ error: "pricePerSlot must be a non-negative amount with at most 6 decimals" });
    }
    const currency = body.currency ?? "USDC";
    if (typeof currency !== "string" || !/^[A-Z]{3,5}$/.test(currency)) {
      return reply.status(400).send({ error: "currency must be 3 to 5 capital letters" });
    }
    let closesAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    if (body.closesAt !== undefined) {
      const t = typeof body.closesAt === "string" ? Date.parse(body.closesAt) : Number.NaN;
      if (!Number.isFinite(t)) return reply.status(400).send({ error: "closesAt must be an ISO date" });
      closesAt = new Date(t).toISOString();
    }

    const batch: SharedBatch = {
      id: `sbatch-${crypto.randomUUID().slice(0, 12)}`,
      kernelId: body.kernelId,
      capabilityType: body.capabilityType,
      totalSlots: totalSlots as number,
      claimedSlots: [],
      protocolType: (body.protocolType as string | undefined) ?? "",
      status: "open",
      minSlotsToRun: minSlotsToRun as number,
      createdAt: new Date().toISOString(),
      closesAt,
      pricePerSlot,
      currency,
      createdBy: creator,
    };

    sharedBatches.set(batch.id, batch);
    return { batch: viewBatch(batch, creator) };
  });

  /** GET /api/batches/shared/open — List open batches available to join */
  app.get("/api/batches/shared/open", async (req) => {
    const { kernelId, capabilityType } = req.query as { kernelId?: string; capabilityType?: string };
    let batches = [...sharedBatches.values()].filter(
      (b) => b.status === "open" || b.status === "filling",
    );
    if (kernelId) batches = batches.filter((b) => b.kernelId === kernelId);
    if (capabilityType) batches = batches.filter((b) => b.capabilityType === capabilityType);
    return { batches: batches.map((b) => viewBatch(b, req.userId ?? null)) };
  });

  /** GET /api/batches/shared/:batchId — Get batch details including all claims */
  app.get<{ Params: { batchId: string } }>("/api/batches/shared/:batchId", async (req, reply) => {
    const batch = sharedBatches.get(req.params.batchId);
    if (!batch) return reply.status(404).send({ error: "Batch not found" });

    const claimedCount = batch.claimedSlots.reduce((sum: number, c: BatchSlotClaim) => sum + c.slotIndices.length, 0);
    return {
      batch: viewBatch(batch, req.userId ?? null),
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
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const claimant = req.userId;
      if (!claimant) return reply.status(401).send({ error: "Authentication required" });

      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });
      if (batch.status !== "open" && batch.status !== "filling") {
        return reply.status(409).send({ error: `Batch is ${batch.status}, cannot claim slots` });
      }

      const body = (req.body ?? {}) as {
        agentId?: unknown;
        slotCount?: unknown;
        sampleLabels?: unknown;
        preferredIndices?: unknown;
      };

      // The claimant is always the authenticated caller. A body agentId is accepted
      // only when it names that same caller, so older clients keep working while
      // a claim can never be attributed to someone else.
      if (body.agentId !== undefined && body.agentId !== claimant) {
        return reply.status(403).send({
          error: "agent_mismatch",
          message: "agentId must be omitted or equal the authenticated caller",
        });
      }
      if (!Number.isInteger(body.slotCount) || (body.slotCount as number) < 1) {
        return reply.status(400).send({ error: "slotCount must be a positive integer" });
      }
      const slotCount = body.slotCount as number;

      // Supplied labels: at most one per slot, each a bounded string (gateway LOW-1).
      let labels: string[] | undefined;
      if (body.sampleLabels !== undefined) {
        const raw = body.sampleLabels;
        if (!Array.isArray(raw) || raw.length > slotCount || !raw.every((l) => typeof l === "string" && l.length <= MAX_TEXT)) {
          return reply.status(400).send({
            error: `sampleLabels must be an array of at most ${slotCount} strings of at most ${MAX_TEXT} characters`,
          });
        }
        labels = raw as string[];
      }

      // Calculate which indices are already claimed
      const claimedIndices = new Set(batch.claimedSlots.flatMap((c) => c.slotIndices));
      const claimedCount = claimedIndices.size;
      const available = batch.totalSlots - claimedCount;

      if (slotCount > available) {
        return reply.status(409).send({
          error: `Only ${available} slots available, requested ${slotCount}`,
        });
      }

      // Assign indices: the requested ones, or else the lowest free ones. Supplied
      // preferredIndices must be valid; a malformed value is refused, never
      // silently replaced by an automatic assignment.
      let indices: number[];
      if (body.preferredIndices !== undefined) {
        const preferred = body.preferredIndices;
        const valid =
          Array.isArray(preferred) &&
          preferred.length === slotCount &&
          new Set(preferred).size === slotCount &&
          preferred.every((i) => Number.isInteger(i) && i >= 0 && i < batch.totalSlots);
        if (!valid) {
          return reply.status(400).send({
            error: `preferredIndices must be ${slotCount} distinct integers in [0, ${batch.totalSlots})`,
          });
        }
        const conflict = (preferred as number[]).find((i) => claimedIndices.has(i));
        if (conflict !== undefined) {
          return reply.status(409).send({ error: `Slot ${conflict} is already claimed` });
        }
        indices = preferred as number[];
      } else {
        indices = [];
        for (let i = 0; i < batch.totalSlots && indices.length < slotCount; i++) {
          if (!claimedIndices.has(i)) indices.push(i);
        }
      }

      // Display amount, computed in floating point from the validated decimal
      // price. Exact base units belong with the money path (D6), not this store.
      const perSlotPrice = parseFloat(batch.pricePerSlot);
      const claim: BatchSlotClaim = {
        id: `claim-${crypto.randomUUID().slice(0, 12)}`,
        agentId: claimant,
        slotIndices: indices,
        sampleLabels: indices.map((slot, n) => labels?.[n] ?? `sample-${slot}`),
        status: "claimed",
        amount: (perSlotPrice * slotCount).toFixed(2),
        claimedAt: new Date().toISOString(),
      };

      batch.claimedSlots.push(claim);

      // Update batch status
      const totalClaimed = claimedCount + slotCount;
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
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const caller = req.userId;
      if (!caller) return reply.status(401).send({ error: "Authentication required" });

      const batch = sharedBatches.get(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      const claimIdx = batch.claimedSlots.findIndex((c) => c.id === req.params.claimId);
      if (claimIdx === -1) return reply.status(404).send({ error: "Claim not found" });
      if (batch.claimedSlots[claimIdx].agentId !== caller) {
        return reply.status(403).send({ error: "not_claimant", message: "Only the claimant can release a claim" });
      }

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
          agentId: c.agentId === (req.userId ?? null) ? c.agentId : null,
          own: c.agentId === (req.userId ?? null),
          slotCount: c.slotIndices.length,
          indices: c.slotIndices,
        })),
        pricePerSlot: batch.pricePerSlot,
        currency: batch.currency,
      };
    },
  );
}
