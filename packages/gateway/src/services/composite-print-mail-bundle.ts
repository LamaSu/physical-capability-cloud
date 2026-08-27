/**
 * Composite EvidenceBundle producer — the PUBLIC side of `document.print-and-mail`.
 *
 * Given a completed PRINT leg (a `printer_job_verified` EvidenceEvent) and a
 * landed MAIL leg (a `courier_pickup_confirmed` EvidenceEvent) for the SAME
 * funded jobId, this assembles ONE `EvidenceBundle` that carries BOTH events
 * under ONE `bundleHash` — the kernel-signed events root — ready for the
 * existing kernel Ed25519 signer and the oracle's event-present verdict rule.
 *
 * This is built strictly to the posted evidence contract, not beside it:
 *   ~/.claude/shared/vnext-composite-evidence-print-and-mail-v2.md  (v2.1)
 *
 * What it IS (contract §1.2, oracle #1464 option (a)):
 *   - ONE EvidenceBundle whose events[] holds BOTH legs, each already hashed by
 *     @pcc/spec `hashEvent`, rolled into ONE `bundleHash = hashBundle(events)`
 *     covered by ONE `kernelSignature`. NOT a separately-signed mail leg (that
 *     would need a `verifyEvidenceBundle` extension — the contract says avoid it).
 *   - The kernel PULL model (carrier #1478 → direction (a)): the carrier events
 *     are NOT independently kernel-signed. The kernel pulls them (already
 *     `hashEvent`-conformant), folds them in verbatim next to the print leg, and
 *     re-attests them by including them under its own signed root. So this
 *     producer preserves the incoming events byte-for-byte (id + hash intact) —
 *     it never re-emits or mutates a pulled event.
 *
 * What it is NOT (out of scope — other lanes / operator decisions):
 *   - NO oracle verdict logic. The release/dispute decision — clauses (a)∧(b)∧
 *     (c)∧(d), the `simulated==true → dispute` rule (§4), commitment recompute
 *     and gateway-JWS verification (§1.3), the handoff-gap and doc↔envelope
 *     checks — is the oracle's (private, LamaSu/pcc-oracle). This module only
 *     assembles a well-formed composite and hands it to the signer.
 *   - NO identity / wallet / custody / settlement writes.
 *
 * Fail-closed: if EITHER leg is absent the bundle is neither assemblable nor
 * valid — that IS "no scan, no release". A mismatched jobId across the legs is
 * rejected (anti-swap, contract §0(b)). A photo — or any event that is not a
 * `courier_pickup_confirmed` — can NEVER stand in for the mail leg (§0, §2:
 * "a photo can never close it").
 *
 * Every moving part is reused, nothing invented:
 *   - `hashEvent` / `hashBundle` / `verifyEventHash` / `ids` from @pcc/spec.
 *   - The kernel Ed25519 signer is INJECTED as `signFn` — the exact shape
 *     `EvidenceEmitter` and `makeKernelEd25519Signer().signFn` produce
 *     (`(bundleHash: string) => Promise<Signature>`). This keeps the gateway
 *     producer decoupled from the (currently unmerged) print-kernel package.
 */

import {
  hashBundle,
  verifyEventHash,
  ids,
  type EvidenceEvent,
  type EvidenceBundle,
  type EvidenceEventType,
  type Signature,
  type AssuranceTier,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Contract vocabulary (both strings already live in EVIDENCE_EVENT_TYPES —
// evidence.ts:34,48 — no new event type is introduced; oracle #1464 Q1).
// ---------------------------------------------------------------------------

/** The PRINT leg's required event type — kernel's own confirmation it printed
 *  the job's document (contract §1.1; REQUIRED at every tier). */
export const COMPOSITE_PRINT_EVENT_TYPE: EvidenceEventType = "printer_job_verified";

/** The MAIL leg's required closing event type — acceptance into the mail stream
 *  (contract §0(b), §1.1). A photo can never close the mail leg (§0, §2). */
export const COMPOSITE_MAIL_EVENT_TYPE: EvidenceEventType = "courier_pickup_confirmed";

/** The print-and-mail tier-0 floor (contract §3): the default G-code tier ladder
 *  does NOT apply, so a composite defaults to tier 0 (print + committed pickup). */
export const DEFAULT_COMPOSITE_TIER: AssuranceTier = 0;

// ---------------------------------------------------------------------------
// Rejection taxonomy — every fail-closed reason has a stable code so callers
// (and tests) can assert the exact cause rather than a string match.
// ---------------------------------------------------------------------------

export type CompositeRejectionCode =
  | "missing_print_leg" // no printer_job_verified supplied — no print, no bundle
  | "missing_mail_leg" // no courier_pickup_confirmed supplied — no scan, no release
  | "wrong_print_event_type" // print slot held a non-printer_job_verified event
  | "wrong_mail_event_type" // mail slot held a non-courier_pickup_confirmed event (e.g. a photo)
  | "print_jobid_missing" // printer_job_verified.payload.jobId absent/blank
  | "mail_jobid_missing" // courier_pickup_confirmed.payload.jobId absent/blank
  | "jobid_swap" // print.payload.jobId !== mail.payload.jobId (anti-swap)
  | "print_jobid_mismatch" // legs do not bind to the funded jobId
  | "extra_event_jobid_mismatch" // a tier≥1 corroborating event binds a different jobId
  | "print_event_hash_invalid" // supplied print event's hash does not cover its content
  | "mail_event_hash_invalid" // supplied mail event's hash does not cover its content
  | "extra_event_hash_invalid" // a supplied corroborating event's hash is inconsistent
  | "bundle_hash_mismatch"; // an assembled bundle's bundleHash != hashBundle(events)

/** Thrown by {@link assembleCompositePrintMailBundle} / {@link signCompositePrintMailBundle}
 *  when the two legs cannot be assembled into a valid composite (fail-closed). */
export class CompositeBundleError extends Error {
  constructor(
    public readonly code: CompositeRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "CompositeBundleError";
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface AssembleCompositeInput {
  /**
   * The funded PCC jobId. BOTH legs must bind to it (contract §0(b):
   * `scan.jobId == fundedJobId`). This is the anti-swap anchor — the kernel
   * knows which job it is closing, so we require it explicitly rather than
   * trusting whichever id happens to be inside an event.
   */
  jobId: string;
  /** The kernel assembling + signing the bundle (becomes `bundle.kernelId`). */
  kernelId: string;
  /**
   * The PRINT leg: a `printer_job_verified` EvidenceEvent already hashed by
   * @pcc/spec. `null`/`undefined` ⇒ fail-closed `missing_print_leg`.
   */
  printEvent: EvidenceEvent | null | undefined;
  /**
   * The MAIL leg: a `courier_pickup_confirmed` EvidenceEvent already hashed by
   * @pcc/spec. `null`/`undefined` ⇒ fail-closed `missing_mail_leg` — this IS
   * "no scan, no release".
   */
  mailEvent: EvidenceEvent | null | undefined;
  /**
   * Optional corroborating events for tiers ≥1 (contract §3): e.g.
   * `printer_log_captured` (T1), `photo_captured` + `photo_anti_spoof_check`
   * (T2), `courier_delivery_confirmed` + `tee_attestation` (T3). They are folded
   * into the SAME one root next to the two required legs. They can never replace
   * a required leg. Any that carry a `payload.jobId` must bind the funded jobId.
   */
  extraEvents?: EvidenceEvent[];
  /** Evidence step id (defaults to `jobId`). */
  stepId?: string;
  /** Assurance tier for the bundle (defaults to {@link DEFAULT_COMPOSITE_TIER}). */
  assuranceTier?: AssuranceTier;
  /** Bundle id override (defaults to `ids.bundle()`). Injectable for tests. */
  bundleId?: string;
  /** `createdAt` override (defaults to `new Date().toISOString()`). Injectable for tests. */
  createdAt?: string;
}

/**
 * An assembled-but-unsigned composite bundle: the events are fixed and the
 * `bundleHash` (the kernel-signed events root) is computed. "Ready to sign" —
 * it is exactly an {@link EvidenceBundle} minus its `kernelSignature`, so the
 * existing kernel signer only has to cover `bundleHash`.
 */
export type UnsignedCompositeBundle = Omit<EvidenceBundle, "kernelSignature">;

/** Outcome of {@link verifyCompositePrintMailBundle}. */
export type CompositeVerification =
  | { ok: true }
  | { ok: false; code: CompositeRejectionCode; message: string };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Read a non-blank string `payload.jobId` from an event, else null. */
function readJobId(event: EvidenceEvent): string | null {
  const raw = (event.payload as Record<string, unknown> | undefined)?.jobId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

type ValidatedLegs = {
  printEvent: EvidenceEvent;
  mailEvent: EvidenceEvent;
  extraEvents: EvidenceEvent[];
};

type ValidationOutcome =
  | { ok: true; legs: ValidatedLegs }
  | { ok: false; code: CompositeRejectionCode; message: string };

const fail = (code: CompositeRejectionCode, message: string): ValidationOutcome => ({
  ok: false,
  code,
  message,
});

/**
 * The single source of truth for "is this a valid print-and-mail composite?".
 * Both the throwing assembler and the non-throwing verifier route through here,
 * so "not assemblable" and "not valid" can never diverge. Order matters — the
 * checks are fail-closed and reported most-specific-first.
 */
async function validateComposite(
  fundedJobId: string,
  printEvent: EvidenceEvent | null | undefined,
  mailEvent: EvidenceEvent | null | undefined,
  extraEvents: EvidenceEvent[],
): Promise<ValidationOutcome> {
  // (1) Both legs must be present. Absence of EITHER is fail-closed.
  if (!printEvent) return fail("missing_print_leg", "composite requires a printer_job_verified print leg");
  if (!mailEvent)
    return fail("missing_mail_leg", "composite requires a courier_pickup_confirmed mail leg (no scan, no release)");

  // (2) Each leg must be the RIGHT event type. This is where a photo_captured —
  // or any non-courier_pickup_confirmed — is rejected as a mail closer (§0, §2).
  if (printEvent.type !== COMPOSITE_PRINT_EVENT_TYPE) {
    return fail(
      "wrong_print_event_type",
      `print leg must be ${COMPOSITE_PRINT_EVENT_TYPE}, got ${printEvent.type}`,
    );
  }
  if (mailEvent.type !== COMPOSITE_MAIL_EVENT_TYPE) {
    return fail(
      "wrong_mail_event_type",
      `mail leg must be ${COMPOSITE_MAIL_EVENT_TYPE}, got ${mailEvent.type} — a photo (or any other event) can never close the mail leg`,
    );
  }

  // (3) Both legs must name a jobId in their authenticated payload.
  const printJobId = readJobId(printEvent);
  const mailJobId = readJobId(mailEvent);
  if (!printJobId) return fail("print_jobid_missing", "printer_job_verified.payload.jobId is missing");
  if (!mailJobId) return fail("mail_jobid_missing", "courier_pickup_confirmed.payload.jobId is missing");

  // (4) Anti-swap: the two legs must name the SAME job. This is the negative
  // control the contract calls out (§0(b)) — a scan for a different job's
  // tracking code must never be folded onto this job's print leg.
  if (printJobId !== mailJobId) {
    return fail(
      "jobid_swap",
      `anti-swap: print leg jobId (${printJobId}) !== mail leg jobId (${mailJobId})`,
    );
  }

  // (5) …and that shared job must be the funded one the kernel is closing.
  if (printJobId !== fundedJobId) {
    return fail(
      "print_jobid_mismatch",
      `legs bind jobId ${printJobId} but the funded jobId is ${fundedJobId}`,
    );
  }

  // (6) Integrity of the pulled events: each self-declared hash must actually
  // cover its (type,timestamp,source,payload). The PULL model trusts only
  // hashEvent-conformant events; a tampered/hand-crafted event is rejected so
  // the signed root can never commit to content that its hash does not.
  if (!(await verifyEventHash(printEvent))) {
    return fail("print_event_hash_invalid", "print leg hash does not match its content");
  }
  if (!(await verifyEventHash(mailEvent))) {
    return fail("mail_event_hash_invalid", "mail leg hash does not match its content");
  }

  // (7) Corroborating tier≥1 events: hash-verified, and if they name a jobId it
  // must be the funded one (a stray event for another job cannot ride along).
  for (const extra of extraEvents) {
    if (!(await verifyEventHash(extra))) {
      return fail("extra_event_hash_invalid", `corroborating ${extra.type} event hash does not match its content`);
    }
    const extraJobId = readJobId(extra);
    if (extraJobId !== null && extraJobId !== fundedJobId) {
      return fail(
        "extra_event_jobid_mismatch",
        `corroborating ${extra.type} event binds jobId ${extraJobId}, not the funded ${fundedJobId}`,
      );
    }
  }

  return { ok: true, legs: { printEvent, mailEvent, extraEvents } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure. Validate the two legs (+ any corroborating events) and assemble the
 * ONE-root, unsigned composite bundle. Throws {@link CompositeBundleError}
 * (fail-closed) if either leg is absent, the legs do not bind the same funded
 * jobId, or a leg is the wrong event type.
 *
 * The returned bundle's `bundleHash` is `hashBundle(events)` — the exact root
 * the kernel signer covers. `events` are preserved verbatim (id + hash intact),
 * ordered [print, mail, ...extras]; `bundleHash` is order-independent because
 * `hashBundle` sorts the event hashes.
 */
export async function assembleCompositePrintMailBundle(
  input: AssembleCompositeInput,
): Promise<UnsignedCompositeBundle> {
  const extraEvents = input.extraEvents ?? [];
  const outcome = await validateComposite(input.jobId, input.printEvent, input.mailEvent, extraEvents);
  if (!outcome.ok) {
    throw new CompositeBundleError(outcome.code, outcome.message);
  }

  const { printEvent, mailEvent } = outcome.legs;
  const events: EvidenceEvent[] = [printEvent, mailEvent, ...extraEvents];
  const bundleHash = await hashBundle(events);

  return {
    id: input.bundleId ?? ids.bundle(),
    jobId: input.jobId,
    stepId: input.stepId ?? input.jobId,
    kernelId: input.kernelId,
    assuranceTier: input.assuranceTier ?? DEFAULT_COMPOSITE_TIER,
    events,
    bundleHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Assemble (via {@link assembleCompositePrintMailBundle}) then cover the whole
 * bundle with ONE `kernelSignature` using the injected kernel signer — the
 * exact `signFn` shape `EvidenceEmitter` / `makeKernelEd25519Signer().signFn`
 * produce. The signer is called exactly once, over `bundleHash`.
 *
 * The result is a standard {@link EvidenceBundle} the existing verifier and
 * oracle already consume (`EvidenceBundle → O5Verdict.evidenceBundleHash →
 * releaseFromEvidence()`, contract §1.4) — the composite changes only WHAT is
 * in `events[]`, never the chain.
 */
export async function signCompositePrintMailBundle(
  input: AssembleCompositeInput,
  signFn: (bundleHash: string) => Promise<Signature>,
): Promise<EvidenceBundle> {
  const unsigned = await assembleCompositePrintMailBundle(input);
  const kernelSignature = await signFn(unsigned.bundleHash);
  return { ...unsigned, kernelSignature };
}

/**
 * Non-throwing structural check of an already-assembled composite bundle: it
 * must hold exactly the two required legs (right types, same funded jobId,
 * hashes intact) and its `bundleHash` must equal `hashBundle(events)`. Use this
 * for the "a bundle missing the carrier event must NOT be valid" gate.
 *
 * This is NOT the oracle verdict — it never returns release/dispute. It only
 * confirms the bundle is a well-formed print-and-mail composite; the oracle
 * still applies clauses (a)∧(b)∧(c)∧(d) and the simulated-evidence rule.
 */
export async function verifyCompositePrintMailBundle(
  bundle: Pick<EvidenceBundle, "jobId" | "events" | "bundleHash">,
): Promise<CompositeVerification> {
  const events = bundle.events ?? [];
  const printEvent = events.find((e) => e.type === COMPOSITE_PRINT_EVENT_TYPE);
  const mailEvent = events.find((e) => e.type === COMPOSITE_MAIL_EVENT_TYPE);
  const extraEvents = events.filter((e) => e !== printEvent && e !== mailEvent);

  const outcome = await validateComposite(bundle.jobId, printEvent, mailEvent, extraEvents);
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  // The signed root must actually cover these events.
  const recomputed = await hashBundle(events);
  if (recomputed !== bundle.bundleHash) {
    return {
      ok: false,
      code: "bundle_hash_mismatch",
      message: `bundleHash ${bundle.bundleHash} != hashBundle(events) ${recomputed}`,
    };
  }

  return { ok: true };
}
