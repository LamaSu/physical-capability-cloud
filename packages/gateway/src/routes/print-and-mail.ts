/**
 * Print-and-mail HANDOFF routes — the gig worker's leg of document.print-and-mail.
 *
 * The gig worker IS a courier.dispatch driver. They:
 *   1. claim the handoff job through the EXISTING courier-jobs claim route
 *      (POST /api/courier-jobs/:id/claim) — no new identity/auth/wallet/custody
 *      code here; the driver authenticates exactly as courier drivers do today,
 *      by presenting the driverAgent that matches the claim;
 *   2. affix the pre-printed carrier label, photograph the printed first page +
 *      label together in ONE frame before sealing, seal, and drop at the post
 *      office;
 *   3. submit that as handoff evidence here.
 *
 * This surface deliberately does NOT re-implement claim/heartbeat — it READS the
 * claim state the courier-jobs store already holds. See
 * services/print-and-mail-handoff.ts for the evidence construction + the
 * mail-leg grader, and services/print-and-mail-handoff-store.ts for the
 * carrier-leg integration seam.
 *
 *   GET  /api/print-and-mail/healthz            — liveness (PUBLIC)
 *   POST /api/print-and-mail/:jobId/handoff     — driver submits handoff evidence
 *   GET  /api/print-and-mail/:jobId             — job evidence + mail-leg status
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { EvidenceEvent } from "@pcc/spec";
import { getCourierJobsStore } from "../services/courier-jobs-store.js";
import {
  buildHandoffEvidence,
  evaluateMailLeg,
  type HandoffPhotoDeviceType,
  type HandoffPhotoEventType,
} from "../services/print-and-mail-handoff.js";
import {
  getPrintAndMailHandoffStore,
  getCarrierBridge,
  type HandoffRecord,
} from "../services/print-and-mail-handoff-store.js";

interface HandoffBody {
  driverAgent?: string;
  kernelId?: string;
  commitmentHash?: string;
  trackingCode?: string;
  printJobId?: string;
  photo?: {
    imageHash?: string;
    capturedAt?: string;
    mimeType?: string;
    uri?: string | null;
  };
  dropOff?: { name?: string; address?: string; lat?: number; lng?: number } | null;
  photoEventType?: HandoffPhotoEventType;
  photoDeviceType?: HandoffPhotoDeviceType;
  /** Mock/simulated fixture ONLY. Sets source.simulated so isFabricated() flags it. */
  simulated?: boolean;
  occurredAt?: string;
}

function handoffDTO(record: HandoffRecord) {
  return {
    jobId: record.jobId,
    kernelId: record.kernelId,
    driverAgent: record.driverAgent,
    commitmentHash: record.commitmentHash,
    trackingCode: record.trackingCode,
    printJobId: record.printJobId,
    commitmentVerified: record.commitmentVerified,
    events: record.events,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Reads the courier-jobs claim state without duplicating it. Returns the projected job or an error verdict. */
function loadClaimedJob(
  jobId: string,
  driverAgent: string,
):
  | { ok: true; claimedBy: string; status: string }
  | { ok: false; code: number; error: string; message: string; details?: unknown } {
  let job;
  try {
    job = getCourierJobsStore().get(jobId);
  } catch {
    // Underlying job-offers store not initialised — treat as not found rather than 500.
    return { ok: false, code: 404, error: "job_not_found", message: `No courier job ${jobId}` };
  }
  if (!job) {
    return {
      ok: false,
      code: 404,
      error: "job_not_found",
      message: `No courier job ${jobId}. Post it and claim it via /api/courier-jobs first.`,
    };
  }
  const claimedBy = job.claimedBy ?? null;
  if (!claimedBy) {
    return {
      ok: false,
      code: 409,
      error: "job_not_claimed",
      message: `Job ${jobId} is not claimed. Claim it first via POST /api/courier-jobs/${jobId}/claim.`,
    };
  }
  if (claimedBy !== driverAgent) {
    return {
      ok: false,
      code: 403,
      error: "not_claimant",
      message: "Only the driver who claimed this job may submit its handoff evidence.",
    };
  }
  return { ok: true, claimedBy, status: job.status };
}

export async function printAndMailRoutes(app: FastifyInstance) {
  // ── GET /api/print-and-mail/healthz ─────────────────────────────────────
  app.get("/api/print-and-mail/healthz", async () => {
    const store = getPrintAndMailHandoffStore();
    return {
      ok: true,
      service: "print-and-mail handoff leg",
      handoffs: store.size(),
      carrierBridgeWired: getCarrierBridge() !== null,
      ts: new Date().toISOString(),
    };
  });

  // ── POST /api/print-and-mail/:jobId/handoff ─────────────────────────────
  app.post<{ Params: { jobId: string }; Body: HandoffBody }>(
    "/api/print-and-mail/:jobId/handoff",
    async (req: FastifyRequest<{ Params: { jobId: string }; Body: HandoffBody }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      const b = req.body ?? {};

      // 1) Required-field validation.
      const errors: string[] = [];
      if (!b.driverAgent) errors.push("driverAgent is required");
      if (!b.kernelId) errors.push("kernelId is required");
      if (!b.commitmentHash) errors.push("commitmentHash is required (from POST /api/carrier/shipments)");
      if (!b.trackingCode) errors.push("trackingCode is required (visible on the affixed label)");
      if (!b.printJobId) errors.push("printJobId is required (kernel-signed id, visible on the printed first page)");
      if (!b.photo?.imageHash) errors.push("photo.imageHash is required (content hash of the single capture frame)");
      if (!b.photo?.capturedAt) errors.push("photo.capturedAt is required (ISO-8601)");
      if (errors.length) {
        return reply.code(400).send({ error: "missing_fields", details: errors });
      }

      // 2) Reuse the EXISTING claim state — the driver authenticates by matching
      //    the claim, exactly as courier drivers do today. No new auth code.
      const claim = loadClaimedJob(jobId, b.driverAgent!);
      if (!claim.ok) {
        return reply.code(claim.code).send({ error: claim.error, message: claim.message });
      }

      // 3) Immutable evidence: one handoff per job. Never silently overwrite.
      const store = getPrintAndMailHandoffStore();
      const existing = store.getByJobId(jobId);
      if (existing) {
        return reply.code(409).send({
          error: "handoff_already_recorded",
          message: `Handoff evidence for job ${jobId} already exists and is immutable.`,
          handoff: handoffDTO(existing),
        });
      }

      // 4) Bind to the pre-committed carrier label. If the carrier leg is wired
      //    (post-merge), VERIFY the referenced commitment against the value
      //    committed before the envelope reached the human; otherwise record it
      //    as caller-attested (commitmentVerified:false — never faked).
      const bridge = getCarrierBridge();
      const committed = bridge?.getCommitment(jobId) ?? null;
      let commitmentVerified = false;
      if (committed) {
        const hashMatch = committed.hash === b.commitmentHash;
        const trackMatch = committed.trackingCode === b.trackingCode;
        if (!hashMatch || !trackMatch) {
          return reply.code(409).send({
            error: "commitment_mismatch",
            message:
              "Referenced commitment does not match the pre-committed carrier label for this job. " +
              "The photo cannot be bound to a label that was not committed before handoff.",
            details: { hashMatch, trackMatch },
          });
        }
        commitmentVerified = true;
      }

      // 5) Build the two handoff EvidenceEvents (custody_handoff_confirmed/human
      //    + envelope photo), both bound to the commitment hash + both carrying
      //    the (printJobId, trackingCode) pair.
      const { custodyEvent, photoEvent } = await buildHandoffEvidence({
        jobId,
        kernelId: b.kernelId!,
        driverAgent: b.driverAgent!,
        commitmentHash: b.commitmentHash!,
        trackingCode: b.trackingCode!,
        printJobId: b.printJobId!,
        photo: {
          imageHash: b.photo!.imageHash!,
          capturedAt: b.photo!.capturedAt!,
          mimeType: b.photo!.mimeType,
          uri: b.photo!.uri ?? null,
        },
        dropOff: b.dropOff ?? null,
        photoEventType: b.photoEventType,
        photoDeviceType: b.photoDeviceType,
        simulated: b.simulated === true,
        occurredAt: b.occurredAt,
      });

      const record = store.create({
        jobId,
        kernelId: b.kernelId!,
        driverAgent: b.driverAgent!,
        commitmentHash: b.commitmentHash!,
        trackingCode: b.trackingCode!,
        printJobId: b.printJobId!,
        commitmentVerified,
        events: [custodyEvent, photoEvent],
      });

      // 6) Grade the mail leg over handoff ∪ carrier events. On this branch the
      //    carrier events are empty, so the leg stays OPEN — the handoff photo
      //    can NEVER close it; only an authentic courier_pickup_confirmed can.
      const carrierEvents: readonly EvidenceEvent[] = bridge?.getEvents(jobId) ?? [];
      const mailLeg = evaluateMailLeg([...record.events, ...carrierEvents], {
        expectedCommitmentHash: b.commitmentHash!,
      });

      return reply.code(201).send({
        ok: true,
        handoff: handoffDTO(record),
        mailLeg,
        note: commitmentVerified
          ? "Commitment verified against the pre-committed carrier label."
          : "Carrier leg not wired on this branch; commitment recorded as caller-attested (commitmentVerified=false).",
      });
    },
  );

  // ── GET /api/print-and-mail/:jobId ──────────────────────────────────────
  app.get<{ Params: { jobId: string } }>(
    "/api/print-and-mail/:jobId",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      const record = getPrintAndMailHandoffStore().getByJobId(jobId);
      const bridge = getCarrierBridge();
      const carrierEvents: readonly EvidenceEvent[] = bridge?.getEvents(jobId) ?? [];

      if (!record && carrierEvents.length === 0) {
        return reply.code(404).send({ error: "not_found", message: `No print-and-mail evidence for job ${jobId}` });
      }

      const handoffEvents = record?.events ?? [];
      const commitmentHash = record?.commitmentHash ?? null;
      const mailLeg = evaluateMailLeg([...handoffEvents, ...carrierEvents], {
        expectedCommitmentHash: commitmentHash,
      });

      return {
        jobId,
        handoff: record ? handoffDTO(record) : null,
        carrierEventCount: carrierEvents.length,
        mailLeg,
      };
    },
  );
}
