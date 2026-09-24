/**
 * profileAdmitsBundle — does the evidence for a job satisfy its committed
 * MeasurementProfile? (LO-SE-2: the same profile digest must govern collection,
 * eligibility and verification, not only acceptance.)
 *
 * Admission is computed only over evidence that is authentic and bound, and
 * this function makes that structural rather than a caller's promise:
 *   - every bundle must pass the SIGNATURE leg, which the consumer supplies
 *     (`verifyBundleSignature`: the node's registered key over
 *     `signingPreimage(bundleHash)` — gateway `verifyDeviceSignedEvidence`, the
 *     oracle's registered-key check). There is no default: an unauthenticated
 *     bundle can never be admitted by forgetting a step;
 *   - every bundle must pass the BINDING leg, run here
 *     (`verifyEvidenceSubjectBinding`, LO-EV-9): its digest opens to its events,
 *     and they commit the job and the kernel that accepted it.
 * Neither leg is sufficient alone.
 *
 * Caller contract for `bundles`: EVERY bundle the accepting kernel stored for
 * the job, from the job's own store — never a presenter's selection, and never
 * third-party input. Omitting a bundle hides whatever it reports (a failure,
 * most importantly), and one unauthenticated or unbound bundle rejects the
 * whole set. At settlement this is the pinned set (LO-EV-9 R1).
 *
 * Events are counted once: after binding proves each event's `hash` equals
 * hashEvent(event), hash identity is content identity, so a bundle uploaded
 * twice, or an event listed twice, cannot inflate a sample count.
 *
 * Then, in order:
 *   1. the profile governs: digest(profile) equals the digest committed at
 *      acceptance (`profileGoverns`), in the 0x commitment family;
 *   2. terms this version cannot evaluate fail closed with `unverifiable-term`
 *      rather than being skipped: a numeric tolerance, required calibration,
 *      required witnesses, non-one-shot coverage, and capture-window tokens
 *      that are not evidence event types;
 *   3. simulation: the profile prohibits it, so ANY fabricated event
 *      (`isFabricated`) rejects — the canonical rule that one fabricated event
 *      makes the evidence non-authentic, which is stricter than "fabricated
 *      events don't count";
 *   4. device failure and contradiction, under the profile's committed
 *      `onDeviceFailure` / `onContradiction` policies. A failure is
 *      `execution_failed` OR an inspection reporting its own negative verdict
 *      (`payload.passed` present and not true): completion plus a failure is a
 *      contradiction, a failure alone is a device failure;
 *   5. level: the strongest level the evidence reaches (`evidenceLevelOfBundle`,
 *      evidence-level.ts — the one classification) must meet the profile's
 *      `acceptanceLevel`, and at least `sampling.minSamples` observations must
 *      come from the PROFILED device, at that level, not a failed inspection,
 *      from a permitted version, inside the capture window. Shortfalls follow
 *      `onMissingData`.
 *
 * Version pins: the evidence carries ONE version field, `source.firmwareVersion`
 * (adapters put their own version there; some robots put firmware there), so
 * an observation counts only if its version is in BOTH committed lists — the
 * only reading that enforces both pins. A profile whose two lists share no
 * string can never be satisfied and fails closed as unverifiable. Giving each
 * pin its own wire field (an additive `source.adapterVersion`) is a later,
 * hash-affecting change.
 *
 * A level says how strong evidence is, not whether the output was good; a
 * numeric tolerance is the pass/fail half and fails closed here until the
 * profile can name where the measured value lives. An inspection's own
 * `passed` verdict is honoured (step 4); an inspection with no `passed` field
 * claims no verdict and still counts.
 *
 * Two required profile terms are DESCRIPTIVE in v1, neither evaluated nor
 * failed closed: `interpretation.evidenceTypeIds` (primitive ids, which the
 * committed program evaluates, not this check) and `outcome.objectIdentity`
 * (nothing in the evidence names the object yet; it can later ride LO-EV-9's
 * `subject.outputHash` when the kinds line up). Both are required fields, so
 * failing closed on them would make every profile unverifiable.
 */

import { isFabricated } from "./is-fabricated.js";
import {
  evidenceLevelOf,
  evidenceLevelOfBundle,
  executingDeviceIds,
  meetsEvidenceLevel,
  DEVICE_REPORTED_EVENT_TYPES,
  INSPECTION_EVENT_TYPES,
  type EvidenceLevel,
} from "./evidence-level.js";
import { profileGoverns, type MeasurementProfileV1 } from "./measurement-profile.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "./subject-binding.js";
import { EVIDENCE_EVENT_TYPES, type EvidenceEvent } from "../types/evidence.js";

export const PROFILE_ADMISSION_CONTRACT = "pcc.evidence.profile-admission.v1";

/** `endCondition` token meaning "no end bound": capture may happen any time after the start. */
export const OPEN_CAPTURE_WINDOW_END = "open";

export type ProfileAdmissionDecision = "admit" | "reject" | "hold";

export type ProfileAdmissionCode =
  | "digest-wrong-family"
  | "profile-invalid"
  | "digest-mismatch"
  | "unverifiable-term"
  | "no-bundles"
  | "unauthenticated-bundle"
  | "unbound-bundle"
  | "simulated-evidence"
  | "device-failure"
  | "contradictory-evidence"
  | "level-not-reached"
  | "missing-measurements";

export interface ProfileAdmissionReason {
  code: ProfileAdmissionCode;
  detail: string;
}

export interface ProfileAdmissionResult {
  decision: ProfileAdmissionDecision;
  admits: boolean;
  /** Strongest level the authenticated, bound evidence reaches (null if none or not evaluated). */
  reached: EvidenceLevel | null;
  /** Observations that count toward the profile: profiled device, required level, permitted version, in window. */
  qualifyingObservations: number;
  /** Empty exactly when admitted. */
  reasons: ProfileAdmissionReason[];
}

/** The part of an EvidenceBundle admission reads. */
export interface AdmissionBundle {
  bundleHash: string;
  events: readonly unknown[];
  kernelSignature: unknown;
}

export interface ProfileAdmissionInput {
  profile: MeasurementProfileV1;
  /** The profile digest committed in the accepted agreement. */
  committedDigest: string;
  /** The job and the kernel that accepted it — from the job record, never from the evidence. */
  subject: EvidenceSubject;
  /** EVERY bundle the accepting kernel stored for the job, from the job's own store (see the caller contract above). */
  bundles: readonly AdmissionBundle[];
  /** The registered-key signature leg. A throw counts as a failed signature. */
  verifyBundleSignature: (bundle: AdmissionBundle) => boolean | Promise<boolean>;
}

const EVENT_TYPES = new Set<string>(EVIDENCE_EVENT_TYPES);
const COMPLETION_TYPES = new Set<string>(DEVICE_REPORTED_EVENT_TYPES);
const INSPECTION_TYPES = new Set<string>(INSPECTION_EVENT_TYPES);

/** An inspection reporting its own negative verdict. No `passed` field claims no verdict. */
function inspectionFailed(event: EvidenceEvent): boolean {
  if (!INSPECTION_TYPES.has(event.type)) return false;
  const passed = (event.payload as Record<string, unknown> | undefined)?.passed;
  return passed !== undefined && passed !== true;
}

function result(
  decision: ProfileAdmissionDecision,
  reasons: ProfileAdmissionReason[],
  reached: EvidenceLevel | null = null,
  qualifyingObservations = 0,
): ProfileAdmissionResult {
  return { decision, admits: decision === "admit", reached, qualifyingObservations, reasons };
}

const reject = (code: ProfileAdmissionCode, detail: string) => result("reject", [{ code, detail }]);

/**
 * Terms of a valid profile this version cannot evaluate. Registration refuses
 * a profile with any of them (profile-registration.ts), so admission and
 * registration share one definition.
 */
export function unverifiableProfileTerms(profile: MeasurementProfileV1): string[] {
  const terms: string[] = [];
  if (profile.measurement.tolerance !== undefined) {
    terms.push("measurement.tolerance: the profile does not name where the measured value lives");
  }
  if (profile.calibration.required) {
    terms.push("calibration.required: no evidence event carries a calibration record yet");
  }
  if (profile.witnesses.requiredRoles.length > 0) {
    terms.push("witnesses.requiredRoles: independent witness attestation is not evaluated here");
  }
  if (profile.capture.coverage.policy !== "one-shot") {
    terms.push(`capture.coverage.policy "${profile.capture.coverage.policy}": only "one-shot" is evaluated`);
  }
  const firmwarePins = new Set(profile.device.permittedFirmwareVersions);
  if (!profile.device.permittedAdapterVersions.some((v) => firmwarePins.has(v))) {
    terms.push(
      "device version pins: permittedAdapterVersions and permittedFirmwareVersions share no string, and the evidence carries one version field, so no observation can satisfy both",
    );
  }
  if (!EVENT_TYPES.has(profile.capture.startCondition)) {
    terms.push(`capture.startCondition "${profile.capture.startCondition}" is not an evidence event type`);
  }
  const end = profile.capture.endCondition;
  if (end !== OPEN_CAPTURE_WINDOW_END && !EVENT_TYPES.has(end)) {
    terms.push(`capture.endCondition "${end}" is neither an evidence event type nor "${OPEN_CAPTURE_WINDOW_END}"`);
  }
  return terms;
}

function time(event: EvidenceEvent): number {
  return Date.parse(event.timestamp);
}

/** [opens, closes] from the committed window events; null bound = event absent. */
function captureWindow(
  profile: MeasurementProfileV1,
  events: readonly EvidenceEvent[],
): { opens: number | null; closes: number | null } {
  const at = (type: string, pick: (a: number, b: number) => number) => {
    let t: number | null = null;
    for (const e of events) {
      if (e.type !== type) continue;
      const ms = time(e);
      if (Number.isFinite(ms)) t = t === null ? ms : pick(t, ms);
    }
    return t;
  };
  const opens = at(profile.capture.startCondition, Math.min);
  const end = profile.capture.endCondition;
  const closes = end === OPEN_CAPTURE_WINDOW_END ? Number.POSITIVE_INFINITY : at(end, Math.max);
  return { opens, closes };
}

function policyDecision(policy: "reject" | "hold"): ProfileAdmissionDecision {
  return policy === "hold" ? "hold" : "reject";
}

/**
 * Admit, reject or hold the evidence for one job against its committed
 * measurement profile. Never throws.
 */
export async function profileAdmitsBundle(input: ProfileAdmissionInput): Promise<ProfileAdmissionResult> {
  const { profile, committedDigest, subject, bundles, verifyBundleSignature } = input;

  const governance = profileGoverns(committedDigest, profile);
  if (!governance.governs) {
    return reject(governance.code ?? "profile-invalid", governance.reasons.join("; "));
  }

  const terms = unverifiableProfileTerms(profile);
  if (terms.length > 0) return reject("unverifiable-term", terms.join("; "));

  if (!Array.isArray(bundles) || bundles.length === 0) {
    return result(policyDecision(profile.onMissingData), [
      { code: "no-bundles", detail: "no evidence bundle was presented for the job" },
    ]);
  }

  const events: EvidenceEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    let signed = false;
    try {
      signed = (await verifyBundleSignature(bundle)) === true;
    } catch {
      signed = false;
    }
    if (!signed) return reject("unauthenticated-bundle", `bundle ${i}: signature leg failed`);

    const binding = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject,
    });
    if (!binding.ok) {
      const at = binding.eventIndex === undefined ? "" : ` at event ${binding.eventIndex}`;
      return reject("unbound-bundle", `bundle ${i}: ${binding.reason}${at}`);
    }
    for (const e of bundle.events as EvidenceEvent[]) {
      if (seen.has(e.hash)) continue;
      seen.add(e.hash);
      events.push(e);
    }
  }

  const fabricated = events.filter(isFabricated).length;
  if (fabricated > 0) {
    return reject(
      "simulated-evidence",
      `${fabricated} fabricated event(s); the profile prohibits simulation, so the evidence is not authentic`,
    );
  }

  const findings: { decision: ProfileAdmissionDecision; reason: ProfileAdmissionReason }[] = [];
  const completed = events.some((e) => COMPLETION_TYPES.has(e.type));
  const executionFailed = events.some((e) => e.type === "execution_failed");
  const failedInspections = events.filter(inspectionFailed).length;
  const failure = [
    ...(executionFailed ? ["execution_failed"] : []),
    ...(failedInspections > 0 ? [`${failedInspections} failed inspection(s)`] : []),
  ].join(" and ");
  if (completed && failure) {
    findings.push({
      decision: policyDecision(profile.onContradiction),
      reason: { code: "contradictory-evidence", detail: `the evidence reports completion and ${failure}` },
    });
  } else if (failure) {
    findings.push({
      decision: policyDecision(profile.interpretation.onDeviceFailure),
      reason: { code: "device-failure", detail: `the evidence reports ${failure}` },
    });
  }

  const required = profile.interpretation.acceptanceLevel;
  const reached = evidenceLevelOfBundle(events);
  const executing = executingDeviceIds(events);
  const adapterPins = new Set(profile.device.permittedAdapterVersions);
  const firmwarePins = new Set(profile.device.permittedFirmwareVersions);
  const window = captureWindow(profile, events);

  let atLevel = 0;
  let otherDevices = 0;
  let unpermittedVersion = 0;
  let outsideWindow = 0;
  let qualifying = 0;
  for (const e of events) {
    if (!meetsEvidenceLevel(evidenceLevelOf(e, executing), required)) continue;
    if (e.source.deviceId !== profile.device.deviceId) {
      otherDevices++;
      continue;
    }
    atLevel++;
    if (inspectionFailed(e)) continue;
    const version = e.source.firmwareVersion;
    if (typeof version !== "string" || !adapterPins.has(version) || !firmwarePins.has(version)) {
      unpermittedVersion++;
      continue;
    }
    const ms = time(e);
    if (
      window.opens === null ||
      window.closes === null ||
      !Number.isFinite(ms) ||
      ms < window.opens ||
      ms > window.closes
    ) {
      outsideWindow++;
      continue;
    }
    qualifying++;
  }

  if (!meetsEvidenceLevel(reached, required)) {
    findings.push({
      decision: policyDecision(profile.onMissingData),
      reason: {
        code: "level-not-reached",
        detail: `the evidence reaches ${reached ?? "no level"}; the profile requires ${required}`,
      },
    });
  } else if (qualifying < profile.measurement.sampling.minSamples) {
    const windowNote =
      window.opens === null
        ? `; the window never opened (no ${profile.capture.startCondition} event)`
        : window.closes === null
          ? `; the window never closed (no ${profile.capture.endCondition} event)`
          : "";
    findings.push({
      decision: policyDecision(profile.onMissingData),
      reason: {
        code: "missing-measurements",
        detail:
          `${qualifying} qualifying observation(s) from ${profile.device.deviceId}, the profile requires ${profile.measurement.sampling.minSamples}` +
          ` (at ${required}: ${atLevel} from the profiled device, ${otherDevices} from other devices;` +
          ` excluded: ${failedInspections} failed inspection(s), ${unpermittedVersion} unpermitted version, ${outsideWindow} outside the capture window${windowNote})`,
      },
    });
  }

  if (findings.length === 0) return result("admit", [], reached, qualifying);
  const decision = findings.some((f) => f.decision === "reject") ? "reject" : "hold";
  return result(
    decision,
    findings.map((f) => f.reason),
    reached,
    qualifying,
  );
}
