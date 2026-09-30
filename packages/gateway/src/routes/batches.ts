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
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

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
/** closesAt: an ISO 8601 UTC time, "2026-10-01T12:00:00Z" (seconds and milliseconds optional). */
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;
/** A shared batch may stay open for at most 30 days. */
const MAX_OPEN_MS = 30 * 24 * 60 * 60_000;
/** The in-memory store is bounded: per creator, and in total (N49 round 3). */
const MAX_OPEN_BATCHES_PER_CREATOR = 20;
const MAX_SHARED_BATCHES = 10_000;
/** N49 F5: how long a no-longer-claimable batch is retained before it may be pruned to free store space. */
const RETAINED_CLOSED_MS = 60 * 60_000;

/** N49 F6: an honest display amount = pricePerSlot (up to 6 decimals) * count,
 * computed in integer micro-units so 0.000001 * n is exact. Display only —
 * never accepted economics or settlement (D6). Returns a trimmed decimal string. */
function displayAmountMicros(pricePerSlot: string, count: number): string {
  const [intPart, frac = ""] = pricePerSlot.split(".");
  const micros = (BigInt(intPart) * 1_000_000n + BigInt((frac + "000000").slice(0, 6))) * BigInt(count);
  const whole = micros / 1_000_000n;
  const rem = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return rem ? `${whole}.${rem}` : `${whole}`;
}
/** Placeholder operator addresses that make a kernel nobody's. */
const UNOWNED_OPERATOR_ADDRESSES = new Set(["", "0x0000000000000000000000000000000000000000"]);

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && value.trim().length > 0;
}

/**
 * A price as a canonical decimal string ("1.5", "10", "0.25"), or null. A number
 * is accepted only when it has at most 6 decimals as given: 1.1234567 is refused,
 * never rounded to 1.123457. A string must already match AMOUNT_RE.
 */
function canonicalPrice(raw: unknown): string | null {
  let text: unknown = raw;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || raw >= 1e9) return null;
    const micros = Math.round(raw * 1e6);
    if (micros / 1e6 !== raw) return null;
    text = (micros / 1e6).toFixed(6);
  }
  if (typeof text !== "string" || !AMOUNT_RE.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const intPart = whole.replace(/^0+(?=\d)/, "");
  const fracPart = fraction.replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** A closesAt value as epoch ms, or null unless it is a real calendar time in ISO_UTC_RE form. */
function parseClosesAt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = ISO_UTC_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const sec = Number(m[6] ?? "0");
  const ms = Number((m[7] ?? "0").padEnd(3, "0"));
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(t);
  const same =
    back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d &&
    back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === sec;
  return same ? t : null;
}

function isOpenForClaims(batch: SharedBatch, now = Date.now()): boolean {
  return (batch.status === "open" || batch.status === "filling") && now < Date.parse(batch.closesAt);
}

/** True only when `principal` is the recorded operator of `kernelId` (N55 swaps in requireKernelOperator). */
function isKernelOperator(kernelId: string, principal: string | null): boolean {
  if (!principal) return false;
  const kernel = getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get();
  return !!kernel && !UNOWNED_OPERATOR_ADDRESSES.has(kernel.operatorAddress) && kernel.operatorAddress === principal;
}

function findJob(jobId: string) {
  return getStore().db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
}

// Board row N49: a claim belongs to the authenticated caller (req.userId, which
// apiGate sets from the API key's operatorId or the wallet session). A request
// body can never name a different claimant. Only the claimant sees the claim
// itself. Everyone else sees which slots are taken and their status: no
// claimant, sample labels, claim id (so a future claimId-keyed route cannot
// become an IDOR), amount, escrow or time. These fields are omitted, not made
// unknowable: the public price times the visible slot count gives a claim's
// display amount, and polling occupancy shows roughly when slots were taken.
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
// job, type, timing and result reference. A viewer sees those only for their own
// samples. Anyone else sees which positions are taken and their status: an
// explicit projection, so a field added to SampleSlot later stays private.
function viewSlot(slot: SampleSlot, viewer: string | null) {
  if (viewer !== null && slot.userId === viewer) return { ...slot, own: true };
  return { position: slot.position, status: slot.status, own: false };
}

// N49 F2 (CRITICAL): an explicit allowlist, never a spread. The legacy list and
// detail routes are public, and `runConfig` is a free-form Record that can hold
// proprietary protocol parameters or customer metadata; spreading the manifest
// leaked it to everyone. Private execution configuration (runConfig, methodId)
// is exposed only through a separately authorized operator view, never here.
function viewManifest(batch: BatchManifest, viewer: string | null) {
  return {
    id: batch.id,
    kernelId: batch.kernelId,
    deviceId: batch.deviceId,
    capabilityId: batch.capabilityId,
    status: batch.status,
    sealedAt: batch.sealedAt,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    slots: batch.slots.map((s) => viewSlot(s, viewer)),
  };
}

/** The payload fields a batch-level event may show anyone: aggregate counts only. */
const BATCH_EVENT_FIELDS: Partial<Record<BatchEvent["type"], readonly string[]>> = {
  batch_sealed: ["slotCount"],
  batch_completed: ["completed", "failed"],
};

/**
 * A viewer sees events about their own samples in full. Events about anyone
 * else's sample are left out entirely (no time, no slot link). Batch-level
 * events keep their type and time and only the allowlisted aggregate fields.
 */
function viewEvents(batch: BatchManifest, events: BatchEvent[], viewer: string | null) {
  const mine = new Set(batch.slots.filter((s) => viewer !== null && s.userId === viewer).map((s) => s.id));
  const visible: Array<Partial<BatchEvent>> = [];
  for (const e of events) {
    if (e.slotId) {
      if (mine.has(e.slotId)) visible.push(e);
      continue;
    }
    const payload: Record<string, unknown> = {};
    for (const field of BATCH_EVENT_FIELDS[e.type] ?? []) {
      if (field in e.payload) payload[field] = e.payload[field];
    }
    visible.push({ id: e.id, batchId: e.batchId, timestamp: e.timestamp, type: e.type, payload });
  }
  return visible;
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

  // Batches containing a specific job's samples. Not a membership oracle: the
  // operator of the job's kernel sees that kernel's batches holding the job, and
  // anyone else only the batches holding a sample of theirs from that job. An
  // unauthorised caller gets the same empty list as a job with no batches.
  app.get<{ Params: { jobId: string } }>(
    "/api/batches/by-job/:jobId",
    { preHandler: [requireAuth] },
    async (req) => {
      const viewer = req.userId ?? null;
      const { jobId } = req.params;
      const job = findJob(jobId);
      const all = batchTracker.getBatchesForJob(jobId);
      const visible =
        job && isKernelOperator(job.kernelId, viewer)
          ? all.filter((b) => b.kernelId === job.kernelId)
          : all.filter((b) => b.slots.some((s) => s.jobId === jobId && viewer !== null && s.userId === viewer));
      return { batches: visible.map((b) => viewManifest(b, viewer)) };
    },
  );

  // Add a sample slot to an assembling batch (N49 round 3). Jobs record no
  // buyer, so the relationship that can be checked is the kernel's: only the
  // operator of the batch's kernel adds samples, only for a job (and its step)
  // on that same kernel. The sample is recorded as the caller's: a body userId
  // may only name the caller.
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
      const batch = batchTracker.getBatch(req.params.batchId);
      if (!batch) return reply.status(404).send({ error: "not_found" });
      if (!isKernelOperator(batch.kernelId, owner)) {
        return reply.status(403).send({
          error: "not_kernel_operator",
          message: "Only the operator of this batch's kernel adds samples to it",
        });
      }
      const job = findJob(body.jobId);
      if (!job || job.kernelId !== batch.kernelId || job.stepId !== body.stepId) {
        return reply.status(400).send({ error: "jobId and stepId must name a job step on this batch's kernel" });
      }
      if (batch.status !== "assembling") {
        return reply.status(409).send({ error: "batch_not_assembling", status: batch.status });
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
      } catch {
        // The tracker's own message is not forwarded: only this fixed error is.
        return reply.code(400).send({ error: "sample_not_added" });
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
    // An explicit null is refused, not defaulted: only an absent field takes the default.
    const minSlotsToRun = body.minSlotsToRun === undefined ? 1 : body.minSlotsToRun;
    if (!Number.isInteger(minSlotsToRun) || (minSlotsToRun as number) < 1 || (minSlotsToRun as number) > (totalSlots as number)) {
      return reply.status(400).send({ error: "minSlotsToRun must be an integer from 1 to totalSlots" });
    }
    // The dashboard sends a number; other clients send a decimal string. A value
    // that would need rounding is refused, and the stored price is canonical.
    const pricePerSlot = canonicalPrice(body.pricePerSlot);
    if (pricePerSlot === null) {
      return reply.status(400).send({ error: "pricePerSlot must be a non-negative amount with at most 6 decimals" });
    }
    const currency = body.currency === undefined ? "USDC" : body.currency;
    if (typeof currency !== "string" || !/^[A-Z]{3,5}$/.test(currency)) {
      return reply.status(400).send({ error: "currency must be 3 to 5 capital letters" });
    }
    const now = Date.now();
    let closesAt = new Date(now + 24 * 60 * 60_000).toISOString();
    if (body.closesAt !== undefined) {
      const t = parseClosesAt(body.closesAt);
      if (t === null) {
        return reply.status(400).send({ error: "closesAt must be an ISO 8601 UTC time such as 2026-10-01T12:00:00Z" });
      }
      if (t <= now || t > now + MAX_OPEN_MS) {
        return reply.status(400).send({ error: "closesAt must be in the future and at most 30 days away" });
      }
      closesAt = new Date(t).toISOString();
    }
    const creatorsOpen = [...sharedBatches.values()].filter((b) => b.createdBy === creator && isOpenForClaims(b, now));
    if (creatorsOpen.length >= MAX_OPEN_BATCHES_PER_CREATOR) {
      return reply.status(409).send({ error: "too_many_open_batches", limit: MAX_OPEN_BATCHES_PER_CREATOR });
    }
    // N49 F5: the store is bounded, so prune batches that can no longer be
    // claimed and are past a short retention window before counting against the
    // cap. Without this, short-lived batches accumulate and creation is
    // permanently unavailable (batch_store_full) until a process restart.
    if (sharedBatches.size >= MAX_SHARED_BATCHES) {
      const cutoff = now - RETAINED_CLOSED_MS;
      for (const [id, b] of sharedBatches) {
        if (!isOpenForClaims(b, now) && Date.parse(b.closesAt) < cutoff) sharedBatches.delete(id);
      }
    }
    if (sharedBatches.size >= MAX_SHARED_BATCHES) {
      return reply.status(503).send({ error: "batch_store_full" });
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
    const now = Date.now();
    let batches = [...sharedBatches.values()].filter((b) => isOpenForClaims(b, now));
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
      if (!isOpenForClaims(batch)) {
        return reply.status(409).send({ error: "batch_closed", closesAt: batch.closesAt });
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
        // N49 F4: every supplied label must be real text (isText), not merely a
        // string of bounded length — a whitespace-only label is rejected.
        if (!Array.isArray(raw) || raw.length > slotCount || !raw.every((l) => isText(l))) {
          return reply.status(400).send({
            error: `sampleLabels must be an array of at most ${slotCount} non-empty strings of at most ${MAX_TEXT} characters`,
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

      // N49 F6: an honest, full-precision DISPLAY amount (pricePerSlot has up to
      // 6 decimals). It is display only — the accepted price and settlement come
      // from the money path (D6), never from this in-memory store. `displayAmount`
      // is named so no caller mistakes it for settlement.
      const claim: BatchSlotClaim = {
        id: `claim-${crypto.randomUUID().slice(0, 12)}`,
        agentId: claimant,
        slotIndices: indices,
        sampleLabels: indices.map((slot, n) => labels?.[n] ?? `sample-${slot}`),
        status: "claimed",
        // Display only (see displayAmountMicros): full-precision, never settlement.
        amount: displayAmountMicros(batch.pricePerSlot, slotCount),
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

      // Someone else's claim answers exactly like a missing one: no existence oracle.
      const claimIdx = batch.claimedSlots.findIndex((c) => c.id === req.params.claimId);
      if (claimIdx === -1 || batch.claimedSlots[claimIdx].agentId !== caller) {
        return reply.status(404).send({ error: "Claim not found" });
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
