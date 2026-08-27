/**
 * Print-and-mail HANDOFF leg — the human-attested "print-and-seal" evidence
 * a gig worker produces, and the grader that decides what it is (and is NOT)
 * allowed to close.
 *
 * WHERE THIS FITS
 * ---------------
 * document.print-and-mail has two physical-provenance legs that dovetail on a
 * shared jobId + carrier commitment hash:
 *
 *   1. CARRIER leg (sibling branch feat/carrier-integration, PR #297):
 *        POST /api/carrier/shipments buys a real postage label BEFORE any
 *        human touches the envelope and returns a pre-execution commitment
 *        (jobId + destinationHash + trackingCode + labelHash + committedAt,
 *        hashed). Later, the carrier's OWN tracking webhook emits a
 *        `courier_pickup_confirmed` EvidenceEvent from deviceType `courier_api`.
 *        THAT is what closes the mail leg — an un-fakeable third-party scan.
 *
 *   2. HANDOFF leg (this module): a courier.dispatch driver — the gig worker —
 *        claims the job through the EXISTING courier-jobs claim route, affixes
 *        the pre-printed label, photographs the envelope, seals it, and drops
 *        it at the post office. The driver's evidence is what THIS module builds
 *        and grades.
 *
 * WHY THE PHOTO EXISTS — sol's finding A on PR #297
 * -------------------------------------------------
 * A carrier scan proves a labeled envelope entered the mail stream. It CANNOT
 * prove that:
 *   - the envelope held the RIGHT document,
 *   - the envelope was not empty, or
 *   - the label was not peeled off and moved to a different envelope.
 * Those are DOCUMENT-TO-ENVELOPE binding facts, and the carrier never sees them.
 * The handoff photo is the only place that binding can be captured: ONE frame,
 * taken BEFORE sealing, showing together
 *   (a) the printed first page with its kernel-signed print job id visible, and
 *   (b) the affixed carrier label with its tracking code visible.
 * Both ids are recorded in the event payload and bound to the pre-committed
 * carrier commitment hash (the whole payload is covered by @pcc/spec's
 * canonical `hashEvent`, so co-locating them in the signed payload IS the bind —
 * we deliberately do NOT invent a second hash).
 *
 * THIS EVIDENCE IS DELIBERATELY WEAKER THAN THE CARRIER SCAN.
 * It is print-and-seal evidence ATTESTED BY A HUMAN: the gig worker asserts the
 * frame shows both ids and that the document went into the sealed envelope.
 * There is no computer-vision verification of the frame here (that is out of
 * scope for this leg and would be dishonest to imply). So it is graded
 * accordingly — see `evaluateMailLeg` below:
 *   - the human print-and-seal attestation supplies document→envelope binding
 *     but MUST NEVER, on its own, close the mail leg;
 *   - the mail leg closes ONLY on an authentic (non-fabricated)
 *     `courier_pickup_confirmed` from deviceType `courier_api`.
 * The two layers are complementary, not substitutable: the carrier scan proves
 * "a labeled envelope entered the mail stream," the handoff photo proves "this
 * document was sealed under this label" — you need both for end-to-end
 * provenance, and neither can stand in for the other.
 *
 * VOCABULARY IS FIXED. Every event type and device type used here already
 * exists in packages/spec/src/types/evidence.ts (EVIDENCE_EVENT_TYPES /
 * EVIDENCE_DEVICE_TYPES). This module adds NO new evidence vocabulary.
 */

import { randomUUID } from "node:crypto";
import { hashEvent, isFabricated, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";

// ── The two poles of the grade, named once ──────────────────────────────────

/** The event + device type that — and ONLY that — closes the mail leg. */
export const MAIL_LEG_CLOSING_EVENT_TYPE = "courier_pickup_confirmed" as const;
export const MAIL_LEG_CLOSING_DEVICE_TYPE = "courier_api" as const;

/** The human drop-off assertion. deviceType MUST be `human`. */
export const HANDOFF_CUSTODY_EVENT_TYPE = "custody_handoff_confirmed" as const;
export const HANDOFF_CUSTODY_DEVICE_TYPE = "human" as const;

/** The envelope photo. Either spelling is accepted (both are in the fixed vocab). */
export const HANDOFF_PHOTO_EVENT_TYPES = ["photo_captured", "camera_snapshot"] as const;
export const HANDOFF_PHOTO_DEVICE_TYPES = ["photo-camera", "camera"] as const;

export type HandoffPhotoEventType = (typeof HANDOFF_PHOTO_EVENT_TYPES)[number];
export type HandoffPhotoDeviceType = (typeof HANDOFF_PHOTO_DEVICE_TYPES)[number];

// ── Handoff evidence construction ───────────────────────────────────────────

export interface HandoffPhotoFrame {
  /** SHA-256 (or other content hash) of the captured frame. The binary is NOT stored in the event — only its content address. */
  imageHash: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  mimeType?: string;
  /** Optional pointer to the archived image (IPFS/S3/...). null when not archived. */
  uri?: string | null;
}

export interface HandoffEvidenceInput {
  jobId: string;
  kernelId: string;
  /** The courier.dispatch driver who claimed the job through the EXISTING claim route. Authenticated exactly as courier drivers are today — by matching the claim. */
  driverAgent: string;
  /** The carrier commitment hash from POST /api/carrier/shipments — binds this photo to the pre-committed label. */
  commitmentHash: string;
  /** The committed label's tracking code — must be VISIBLE on the label in the frame. */
  trackingCode: string;
  /** The kernel-signed print job id — must be VISIBLE on the printed first page in the SAME frame. */
  printJobId: string;
  /** The single frame that shows the printed first page AND the label together, before sealing. */
  photo: HandoffPhotoFrame;
  dropOff?: { name?: string; address?: string; lat?: number; lng?: number } | null;
  /** Which photo event spelling to emit. Default `photo_captured`. */
  photoEventType?: HandoffPhotoEventType;
  /** Which camera device type to attribute the photo to. Default `photo-camera`. */
  photoDeviceType?: HandoffPhotoDeviceType;
  /**
   * True ONLY for mock/simulated fixtures. Sets `source.simulated` so
   * `isFabricated()` flags every event here as non-authentic. NEVER set true
   * for a real gig-worker submission.
   */
  simulated?: boolean;
  /** Override the event timestamp (default: photo.capturedAt). */
  occurredAt?: string;
}

export interface HandoffEvidence {
  /** The human drop-off assertion. */
  custodyEvent: EvidenceEvent;
  /** The envelope photo binding document→envelope→label. */
  photoEvent: EvidenceEvent;
}

/**
 * Builds the TWO EvidenceEvents a print-and-seal handoff produces, both bound
 * to the carrier commitment hash and both recording the (printJobId,
 * trackingCode) pair that ties the document to the envelope to the label.
 *
 * NOTE the honesty of the field names: `attestedShowsPrintedFirstPage` /
 * `attestedShowsCarrierLabel` are the HUMAN's assertion about the frame, not a
 * verified fact — there is no CV check here. `bindingStrength` is stamped
 * `human_attested_print_and_seal` so no downstream reader can mistake this for
 * the stronger carrier scan.
 */
export async function buildHandoffEvidence(input: HandoffEvidenceInput): Promise<HandoffEvidence> {
  const timestamp = input.occurredAt ?? input.photo.capturedAt;
  const photoEventType: HandoffPhotoEventType = input.photoEventType ?? "photo_captured";
  const photoDeviceType: HandoffPhotoDeviceType = input.photoDeviceType ?? "photo-camera";
  const simulated = input.simulated === true;

  // The (document id, label id, carrier commitment) triple — the binding sol's
  // finding A says the photo must supply and the scan cannot. Co-located in the
  // signed payload; the event hash IS the binding artifact.
  const documentEnvelopeBinding = {
    printJobId: input.printJobId,
    trackingCode: input.trackingCode,
    commitmentHash: input.commitmentHash,
    imageHash: input.photo.imageHash,
    bindingStrength: "human_attested_print_and_seal" as const,
  };

  const humanSource: EvidenceSource = {
    deviceId: `human:${input.driverAgent}`,
    deviceType: HANDOFF_CUSTODY_DEVICE_TYPE,
    kernelId: input.kernelId,
    simulated,
  };
  const custodyWithoutHash = {
    type: HANDOFF_CUSTODY_EVENT_TYPE,
    timestamp,
    source: humanSource,
    payload: {
      jobId: input.jobId,
      driverAgent: input.driverAgent,
      // the drop-off assertion
      assertion: "sealed_and_dropped",
      method: "print_and_seal_human_attested",
      dropOff: input.dropOff ?? null,
      documentEnvelopeBinding,
      // convenience mirrors so consumers need not reach into the nested object
      commitmentHash: input.commitmentHash,
      trackingCode: input.trackingCode,
      printJobId: input.printJobId,
      photoImageHash: input.photo.imageHash,
      attestationOnly: true,
    },
  } as const;
  const custodyEvent: EvidenceEvent = {
    id: randomUUID(),
    ...custodyWithoutHash,
    hash: await hashEvent(custodyWithoutHash),
  };

  const photoSource: EvidenceSource = {
    deviceId: `${photoDeviceType}:${input.driverAgent}`,
    deviceType: photoDeviceType,
    kernelId: input.kernelId,
    simulated,
  };
  const photoWithoutHash = {
    type: photoEventType,
    timestamp,
    source: photoSource,
    payload: {
      jobId: input.jobId,
      commitmentHash: input.commitmentHash,
      trackingCode: input.trackingCode,
      printJobId: input.printJobId,
      frame: {
        imageHash: input.photo.imageHash,
        capturedAt: input.photo.capturedAt,
        mimeType: input.photo.mimeType ?? "image/jpeg",
        uri: input.photo.uri ?? null,
      },
      // The gig worker's ASSERTIONS about the single frame — not CV-verified here.
      attestedShowsPrintedFirstPage: true,
      attestedShowsCarrierLabel: true,
      attestedSingleFrameBothVisible: true,
      attestedSealedAfterCapture: true,
      attestedBy: input.driverAgent,
      documentEnvelopeBinding,
      // Loud, machine-readable "do not over-trust me": this is weaker than the
      // carrier scan and can never close the mail leg on its own.
      attestationOnly: true,
      canCloseMailLeg: false,
    },
  } as const;
  const photoEvent: EvidenceEvent = {
    id: randomUUID(),
    ...photoWithoutHash,
    hash: await hashEvent(photoWithoutHash),
  };

  return { custodyEvent, photoEvent };
}

// ── Mail-leg grading (the crux) ─────────────────────────────────────────────

export type MailLegGrade =
  | "carrier_pickup_scan" // strongest: an authentic third-party carrier scan closed it
  | "human_print_and_seal_attestation" // weaker: document→envelope binding attested, leg still OPEN
  | "none"; // nothing gradable yet

export interface DocumentBinding {
  present: boolean;
  printJobId: string | null;
  trackingCode: string | null;
  commitmentHash: string | null;
}

export interface MailLegEvaluation {
  /** TRUE iff an authentic `courier_pickup_confirmed` from `courier_api` (bound to the commitment, when one is supplied) is present. Handoff evidence never sets this. */
  closed: boolean;
  grade: MailLegGrade;
  /** The event that closed the leg, if any. */
  closingEvent: EvidenceEvent | null;
  /** True iff a human `custody_handoff_confirmed` + an envelope photo are present AND carry the document→envelope binding. */
  handoffAttested: boolean;
  /** The (printJobId, trackingCode, commitmentHash) the handoff photo bound — the fact the carrier scan cannot supply. */
  documentBinding: DocumentBinding;
  /**
   * True iff a `courier_pickup_confirmed`/`courier_api` event exists but is
   * fabricated (source.simulated / payload.mock). Surfaced, but it does NOT
   * close a real leg — consistent with the kernel's tier gate, which also
   * refuses fabricated events (checkTierRequirements → isFabricated).
   */
  simulatedClosingEventPresent: boolean;
  reason: string;
}

function readStr(payload: Record<string, unknown> | undefined, key: string): string | null {
  const v = payload?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The mail-leg grader. Pure function over a set of EvidenceEvents (typically
 * the carrier leg's events for this jobId ∪ this leg's handoff events).
 *
 * Closure rule, stated as plainly as the code:
 *   closed  ⇔  ∃ e : e.type === "courier_pickup_confirmed"
 *                    ∧ e.source.deviceType === "courier_api"
 *                    ∧ ¬isFabricated(e)
 *                    ∧ (expectedCommitmentHash ? e.payload.commitmentHash === expectedCommitmentHash : true)
 *
 * A `photo_captured` (or `camera_snapshot`) can never satisfy this — wrong
 * type. A human `custody_handoff_confirmed` can never satisfy this — wrong type
 * AND wrong deviceType. That structural impossibility is the whole security
 * property, and it is what the NEGATIVE CONTROL test pins down.
 *
 * We deliberately do NOT reuse the kernel's `checkTierRequirements`: that gate
 * keys on event TYPE only, whereas the mail-leg property is SOURCE-typed (the
 * closing signal must come from `courier_api`, never from a human). A
 * type-only check would let a human-emitted `courier_pickup_confirmed` through.
 */
export function evaluateMailLeg(
  events: readonly EvidenceEvent[],
  opts: { expectedCommitmentHash?: string | null } = {},
): MailLegEvaluation {
  const expected = opts.expectedCommitmentHash ?? null;

  // 1) Closing signal — authentic carrier scan only.
  let closingEvent: EvidenceEvent | null = null;
  let simulatedClosingEventPresent = false;
  for (const e of events) {
    const isCarrierPickup =
      e.type === MAIL_LEG_CLOSING_EVENT_TYPE && e.source?.deviceType === MAIL_LEG_CLOSING_DEVICE_TYPE;
    if (!isCarrierPickup) continue;
    if (isFabricated(e)) {
      simulatedClosingEventPresent = true;
      continue; // a simulated scan cannot authentically close a real leg
    }
    if (expected && readStr(e.payload as Record<string, unknown>, "commitmentHash") !== expected) {
      // A real scan, but for a different commitment than the one we expect —
      // does not close THIS job's leg.
      continue;
    }
    closingEvent = e;
    break;
  }

  // 2) Handoff attestation layer — the weaker, human, document→envelope binding.
  const custody = events.find(
    (e) =>
      e.type === HANDOFF_CUSTODY_EVENT_TYPE && e.source?.deviceType === HANDOFF_CUSTODY_DEVICE_TYPE,
  );
  const photo = events.find(
    (e) =>
      (HANDOFF_PHOTO_EVENT_TYPES as readonly string[]).includes(e.type) &&
      (HANDOFF_PHOTO_DEVICE_TYPES as readonly string[]).includes(e.source?.deviceType ?? ""),
  );

  // Read the binding off the photo first (that is the frame that must show
  // both ids), falling back to the custody assertion.
  const bindingSource = (photo ?? custody)?.payload as Record<string, unknown> | undefined;
  const printJobId = readStr(bindingSource, "printJobId");
  const trackingCode = readStr(bindingSource, "trackingCode");
  const commitmentHash = readStr(bindingSource, "commitmentHash");
  const bindingPresent = !!(printJobId && trackingCode && commitmentHash);

  const documentBinding: DocumentBinding = {
    present: bindingPresent,
    printJobId,
    trackingCode,
    commitmentHash,
  };

  // Attestation requires BOTH the human custody assertion AND the envelope
  // photo, AND the document→envelope binding. A lone photo is NOT an
  // attestation (and, per the closure rule above, is not a closure either).
  const handoffAttested = !!custody && !!photo && bindingPresent;

  const closed = closingEvent !== null;
  const grade: MailLegGrade = closed
    ? "carrier_pickup_scan"
    : handoffAttested
      ? "human_print_and_seal_attestation"
      : "none";

  let reason: string;
  if (closed) {
    reason =
      "Mail leg CLOSED by an authentic carrier pickup scan (courier_pickup_confirmed from courier_api).";
  } else if (simulatedClosingEventPresent) {
    reason =
      "A courier_pickup_confirmed from courier_api is present but SIMULATED (source.simulated/payload.mock); a fabricated scan cannot close a real mail leg. Awaiting a real carrier scan.";
  } else if (handoffAttested) {
    reason =
      "Handoff recorded: human-attested print-and-seal evidence supplies document→envelope binding but is WEAKER than a carrier scan and does not close the mail leg. Awaiting courier_pickup_confirmed from courier_api.";
  } else {
    reason =
      "Mail leg OPEN. No authentic carrier pickup scan, and no complete print-and-seal handoff attestation yet.";
  }

  return {
    closed,
    grade,
    closingEvent,
    handoffAttested,
    documentBinding,
    simulatedClosingEventPresent,
    reason,
  };
}
