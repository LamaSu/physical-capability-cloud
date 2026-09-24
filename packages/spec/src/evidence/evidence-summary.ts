/**
 * EvidenceSummaryV1 — the evidence read model for product surfaces (product
 * pack §7 item 4: an EvidenceSummary / ProvenanceDTO for ordinary users, with
 * raw inspect refs).
 *
 * The rule it exists to enforce: a UI must never read "verified" from
 * "evidence exists", or "done" from "the device accepted it". Every field is an
 * explicit enum derived here, once, from the evidence semantics:
 *
 *   authentication   verified        a device-signed bundle whose signature
 *                                    verified against the kernel's registered
 *                                    key and whose digest opens to events that
 *                                    commit this job and kernel (LO-EV-1,
 *                                    LO-EV-9). The caller runs those checks and
 *                                    passes the result per bundle.
 *                    unverified      device-signed, but not verified: not
 *                                    checked, or a check failed (`reasons`)
 *                    gateway_record  only the gateway's own record of the job
 *                    none            no evidence stored
 *   verifiedStrength the evidence level (submitted / device_reported /
 *                    inspected_output) shown by VERIFIED evidence only
 *   outcome          completed / failed / accepted / none, read from verified
 *                    events when there are any, otherwise from what was
 *                    claimed; `outcomeBasis` says which
 *   simulated        any fabricated event anywhere in the job's evidence
 *
 * `plainLanguage` is the one sentence an ordinary user sees; `inspect` carries
 * the raw references (bundle ids and hashes) for anyone who wants to check.
 */

import type { EvidenceEvent } from "../types/evidence.js";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
  evidenceLevelOfBundle,
  type EvidenceLevel,
} from "./evidence-level.js";
import { isFabricated } from "./is-fabricated.js";

export const EVIDENCE_SUMMARY_SCHEMA = "pcc.evidence-summary.v1";

export type EvidenceAuthentication = "verified" | "unverified" | "gateway_record" | "none";

export type EvidenceOutcome = "completed" | "failed" | "accepted" | "none";

/** One stored bundle for the job, with the caller's authentication result. */
export interface EvidenceSummaryBundleInput {
  bundleId: string;
  bundleHash: string;
  /** Source timestamp: when the gateway stored the bundle. */
  createdAt: string;
  /** "device" when the stored signature is a real device signature
   *  (gateway `isDeviceSignedSignature`); "gateway" for the gateway's own
   *  record or an unsigned relay. */
  signedBy: "device" | "gateway";
  /** For a device-signed bundle: the signature + subject-binding result.
   *  Absent means not checked, which never counts as verified. */
  verification?: { ok: true } | { ok: false; reason: string };
  events: readonly EvidenceEvent[];
}

export interface EvidenceInspectRef {
  bundleId: string;
  bundleHash: string;
  signedBy: "device" | "gateway";
  /** true / false for a checked device bundle, null when there is nothing to check or it was not checked. */
  verified: boolean | null;
  eventCount: number;
  createdAt: string;
}

export interface EvidenceSummaryV1 {
  schema: typeof EVIDENCE_SUMMARY_SCHEMA;
  jobId: string;
  authentication: EvidenceAuthentication;
  verifiedStrength: EvidenceLevel | "none";
  outcome: EvidenceOutcome;
  outcomeBasis: "verified" | "claimed" | "none";
  simulated: boolean;
  plainLanguage: string;
  /** Why device evidence is not verified, deduplicated ("not-checked" when unchecked). */
  reasons: string[];
  /** Latest bundle createdAt, or null when there is no evidence. */
  lastRecordedAt: string | null;
  inspect: EvidenceInspectRef[];
}

const COMPLETED_TYPES = new Set<string>(DEVICE_REPORTED_EVENT_TYPES);
const ACCEPTED_TYPES = new Set<string>(SUBMITTED_EVENT_TYPES);

function outcomeOf(events: readonly EvidenceEvent[]): EvidenceOutcome {
  const real = events.filter((e) => !isFabricated(e));
  if (real.some((e) => e.type === "execution_failed")) return "failed";
  if (real.some((e) => COMPLETED_TYPES.has(e.type))) return "completed";
  if (real.some((e) => ACCEPTED_TYPES.has(e.type))) return "accepted";
  return "none";
}

function isVerified(b: EvidenceSummaryBundleInput): boolean {
  return b.signedBy === "device" && b.verification?.ok === true;
}

function plainLanguageOf(s: Omit<EvidenceSummaryV1, "plainLanguage" | "schema" | "jobId" | "inspect" | "reasons" | "lastRecordedAt">, anyRealEvent: boolean): string {
  if (s.authentication === "none") return "No evidence has been recorded for this job yet.";
  if (s.simulated && !anyRealEvent) return "This job's evidence came from a simulator, not real hardware.";

  let sentence: string;
  if (s.authentication === "verified") {
    if (s.outcome === "failed") sentence = "The machine's signed record shows the job failed.";
    else if (s.verifiedStrength === "inspected_output") sentence = "An independent device inspected the output.";
    else if (s.verifiedStrength === "device_reported") sentence = "The machine's signed record shows the job finished.";
    else if (s.verifiedStrength === "submitted") sentence = "The machine accepted the job and has not reported finishing.";
    else sentence = "Signed evidence was received but shows no progress yet.";
  } else if (s.authentication === "unverified") {
    if (s.outcome === "failed") sentence = "The provider reports the job failed.";
    else if (s.outcome === "completed") sentence = "The provider reports the job finished. This has not been verified.";
    else if (s.outcome === "accepted") sentence = "The provider's device accepted the job. It has not reported finishing.";
    else sentence = "The provider sent evidence that has not been verified.";
  } else {
    sentence = "PCC recorded this job's activity. The provider has not sent signed device evidence.";
  }
  return s.simulated ? `${sentence} Some evidence came from a simulator and was not counted.` : sentence;
}

/** Summarize every stored evidence bundle for one job. Pure; never throws on well-typed input. */
export function summarizeEvidence(
  jobId: string,
  bundles: readonly EvidenceSummaryBundleInput[],
): EvidenceSummaryV1 {
  const verified = bundles.filter(isVerified);
  const device = bundles.filter((b) => b.signedBy === "device");

  const authentication: EvidenceAuthentication =
    verified.length > 0
      ? "verified"
      : device.length > 0
        ? "unverified"
        : bundles.length > 0
          ? "gateway_record"
          : "none";

  const verifiedEvents = verified.flatMap((b) => b.events);
  const allEvents = bundles.flatMap((b) => b.events);
  const verifiedStrength = evidenceLevelOfBundle(verifiedEvents) ?? "none";
  const outcomeBasis = verified.length > 0 ? "verified" : allEvents.length > 0 ? "claimed" : "none";
  const outcome = outcomeOf(outcomeBasis === "verified" ? verifiedEvents : allEvents);
  const simulated = allEvents.some((e) => isFabricated(e));

  const reasons = [
    ...new Set(
      device
        .filter((b) => !isVerified(b))
        .map((b) => (b.verification && !b.verification.ok ? b.verification.reason : "not-checked")),
    ),
  ];
  const recordedAt = bundles.map((b) => b.createdAt).sort();
  const lastRecordedAt = recordedAt.length === 0 ? null : recordedAt[recordedAt.length - 1]!;

  const core = { authentication, verifiedStrength, outcome, outcomeBasis, simulated } as const;
  return {
    schema: EVIDENCE_SUMMARY_SCHEMA,
    jobId,
    ...core,
    plainLanguage: plainLanguageOf(core, allEvents.some((e) => !isFabricated(e))),
    reasons: authentication === "verified" ? [] : reasons,
    lastRecordedAt,
    inspect: bundles.map((b) => ({
      bundleId: b.bundleId,
      bundleHash: b.bundleHash,
      signedBy: b.signedBy,
      verified: b.signedBy === "device" && b.verification !== undefined ? b.verification.ok : null,
      eventCount: b.events.length,
      createdAt: b.createdAt,
    })),
  };
}
