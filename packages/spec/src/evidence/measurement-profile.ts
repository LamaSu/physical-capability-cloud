/**
 * MeasurementProfileV1 — the committed capture profile (LO-SE-2).
 *
 * The memo's requirement in one sentence: capture parameters must be committed
 * BEFORE execution, so measurement terms cannot be chosen after results are in.
 * Nothing in the repo carries per-job capture parameters today — CSD
 * `evidence.tierN.primitives[].params` are static per-capability declarations,
 * and the committed `EvidenceRequirement` is `{evidenceTypeId, tier}` only. This
 * module is the missing artifact: a versioned profile, hashed to a digest the
 * accepted agreement commits, which configuration, collection, eligibility and
 * verification all quote.
 *
 * Field set follows the memo: physical outcome and object identity; device
 * identity and permitted versions; method, units, tolerances, sampling; capture
 * start/end and coverage; calibration and validity window; event vocabulary and
 * result interpretation; simulation prohibition; witness roles and independence;
 * missing-data and contradiction behavior.
 *
 * THE LOAD-BEARING FIELD is `interpretation.acceptanceLevel`. The memo requires
 * the three result levels to stay separate — command accepted, device reported
 * completion, relevant output inspected — because collapsing them is how a spool
 * receipt or a log-summary event comes to stand for a physical result. Stating
 * the accepted level makes "this evidence proves the page was inspected" a
 * checkable claim instead of a reading of an event name.
 *
 * Canonicalization is the PRODUCTION one (`util/canonical.ts`: sorted keys,
 * `String()` numbers). This module never hand-rolls an encoder — the 2026-08-25
 * cross-family finding was that mirror-form canonicalizers silently diverge from
 * production inside the digest preimage.
 *
 * The digest is in the COMMITMENT family — `0x` + 64 lowercase hex of
 * SHA-256, the same form as `computeVerificationProgramHash` — not the
 * `sha256:`-tagged evidence-event family. A profile is committed before
 * execution and is a peer of `committedProgramHash`: it reaches the chain by
 * being a policy subject folded into the accepted-policy digest, so it needs no
 * separate keccak twin (two forms of one fact can drift). A `sha256:`-tagged
 * value presented as a committed profile digest is rejected as the wrong family.
 */

import { createHash } from "node:crypto";

import { canonicalize } from "../util/canonical.js";
import { EVIDENCE_LEVELS, type EvidenceLevel } from "./evidence-level.js";

/** Domain separator — a profile digest can never collide with another digest. */
export const MEASUREMENT_PROFILE_DOMAIN = "PCC:measurement-profile:v1";

/** A committed measurement-profile digest: `0x` + 64 lowercase hex (SHA-256). */
export type MeasurementProfileDigest = `0x${string}`;

/** The only accepted committed-digest form. */
export const MEASUREMENT_PROFILE_DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;

/**
 * Which of the memo's three result levels this profile accepts as the proven
 * outcome. It IS the evidence contract's `EvidenceLevel` (evidence-level.ts) —
 * one classification, not a second map. Weakest to strongest:
 *   - `submitted`        the device took the work (a spool receipt). Proves a
 *                        request was made, never that work happened.
 *   - `device_reported`  the device that did the work reports it finished.
 *                        Proves the device said so.
 *   - `inspected_output` the output was observed or measured by a device other
 *                        than the one that produced it. The only level a
 *                        sensor-grounded claim may rest on.
 */
export type AcceptanceLevel = EvidenceLevel;

export const ACCEPTANCE_LEVELS: readonly AcceptanceLevel[] = EVIDENCE_LEVELS;

export interface ProfileOutcome {
  /** Provider-neutral capability identity, e.g. "document-printing". */
  capabilityType: string;
  /** The promised physical result, as a payer-readable sentence. */
  statement: string;
  /** What identifies the object the claim is about (e.g. a documentHash). */
  objectIdentity: { kind: string; value: string };
}

export interface ProfileDevice {
  deviceId: string;
  /** "machine" | "sensor" | "camera" — the kernel's device kinds. */
  kind: string;
  /** Adapter type that must serve this device; a mock can never satisfy it. */
  adapterType: string;
  /** Non-empty allowlists; an unlisted version invalidates the profile. */
  permittedAdapterVersions: string[];
  permittedFirmwareVersions: string[];
}

export interface ProfileMeasurement {
  /** How the quantity is obtained, e.g. "optical-capture", "page-count". */
  method: string;
  /** What is measured, e.g. "printed-page-image". */
  quantity: string;
  /** Unit token; "none" for non-numeric observations such as an image. */
  unit: string;
  /** Numeric tolerance; omitted for non-numeric observations. */
  tolerance?: { comparator: "<" | "<=" | "=" | ">=" | ">"; target: number; band?: number };
  sampling: {
    /** Minimum observations required; at least 1. */
    minSamples: number;
    /** Max gap between samples for continuous capture; omit for one-shot. */
    maxIntervalMs?: number;
  };
}

export interface ProfileCapture {
  /**
   * The capture window, as evidence event types. An observation counts only
   * at or after the earliest `startCondition` event and at or before the
   * latest `endCondition` event; `endCondition: "open"` sets no end bound.
   * Admission (profile-admission.ts) fails closed on any other token.
   */
  startCondition: string;
  endCondition: string;
  coverage: {
    /** "one-shot" | "continuous" — what completeness means here. */
    policy: string;
    /** Fraction of the window that must be covered, within (0,1]. */
    minFraction: number;
  };
}

export interface ProfileCalibration {
  required: boolean;
  procedureId?: string;
  /** How long a calibration stays valid; stale calibration fails the profile. */
  validityWindowSeconds?: number;
}

export interface ProfileInterpretation {
  /** Evidence-vocabulary primitive ids this profile's evidence is read as. */
  evidenceTypeIds: string[];
  /** The result level this profile accepts. See AcceptanceLevel. */
  acceptanceLevel: AcceptanceLevel;
  /** What a device-reported failure means; never "retry silently". */
  onDeviceFailure: "reject" | "hold";
}

export interface ProfileWitnesses {
  /** Role ids required to attest; may be empty for single-device profiles. */
  requiredRoles: string[];
  /**
   * Whether required witnesses must be independent of the claimant. Several
   * signatures over one claimant's observation are not independent witnesses.
   */
  independentOfClaimant: boolean;
}

export interface MeasurementProfileV1 {
  profileVersion: 1;
  /** Stable id; the digest, not this string, is what binds. */
  profileId: string;
  outcome: ProfileOutcome;
  device: ProfileDevice;
  measurement: ProfileMeasurement;
  capture: ProfileCapture;
  calibration: ProfileCalibration;
  interpretation: ProfileInterpretation;
  /**
   * Simulation prohibition. MUST be `true` — a profile permitting simulated
   * capture is not a measurement profile, and this module refuses to digest one.
   */
  simulationProhibited: true;
  witnesses: ProfileWitnesses;
  onMissingData: "reject" | "hold";
  onContradiction: "reject" | "hold";
}

/** A validation failure. `path` is the offending field. */
export interface ProfileViolation {
  path: string;
  message: string;
}

const DECISION = new Set(["reject", "hold"]);
const COMPARATORS = ["<", "<=", "=", ">=", ">"];

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate a profile. Returns every violation found (empty array = valid).
 * Fails CLOSED: anything malformed, missing or self-contradictory is a
 * violation, and `computeMeasurementProfileDigest` refuses to digest it — an
 * unvalidatable profile must never acquire a digest that looks authoritative.
 */
export function validateMeasurementProfile(profile: unknown): ProfileViolation[] {
  const v: ProfileViolation[] = [];
  const push = (path: string, message: string) => v.push({ path, message });

  if (typeof profile !== "object" || profile === null) {
    return [{ path: "", message: "profile must be an object" }];
  }
  const p = profile as Record<string, unknown>;

  if (p.profileVersion !== 1) push("profileVersion", "must be 1");
  if (!nonEmptyString(p.profileId)) push("profileId", "required, non-empty");

  // Simulation prohibition is not a default — it must be asserted.
  if (p.simulationProhibited !== true) {
    push(
      "simulationProhibited",
      "must be exactly true; a profile permitting simulated capture is not a measurement profile",
    );
  }

  const outcome = p.outcome as ProfileOutcome | undefined;
  if (!outcome || typeof outcome !== "object") push("outcome", "required");
  else {
    if (!nonEmptyString(outcome.capabilityType)) push("outcome.capabilityType", "required");
    if (!nonEmptyString(outcome.statement)) push("outcome.statement", "required");
    if (
      !outcome.objectIdentity ||
      !nonEmptyString(outcome.objectIdentity.kind) ||
      !nonEmptyString(outcome.objectIdentity.value)
    ) {
      push("outcome.objectIdentity", "required {kind,value}; the claim must name the object it is about");
    }
  }

  const device = p.device as ProfileDevice | undefined;
  if (!device || typeof device !== "object") push("device", "required");
  else {
    if (!nonEmptyString(device.deviceId)) push("device.deviceId", "required");
    if (!nonEmptyString(device.kind)) push("device.kind", "required");
    if (!nonEmptyString(device.adapterType)) push("device.adapterType", "required");
    if (device.adapterType === "mock") {
      push("device.adapterType", "a mock adapter can never satisfy a measurement profile");
    }
    if (!Array.isArray(device.permittedAdapterVersions) || device.permittedAdapterVersions.length === 0) {
      push("device.permittedAdapterVersions", "required, non-empty; an open version set is not a pinned device");
    }
    if (!Array.isArray(device.permittedFirmwareVersions) || device.permittedFirmwareVersions.length === 0) {
      push("device.permittedFirmwareVersions", "required, non-empty");
    }
  }

  const m = p.measurement as ProfileMeasurement | undefined;
  if (!m || typeof m !== "object") push("measurement", "required");
  else {
    if (!nonEmptyString(m.method)) push("measurement.method", "required");
    if (!nonEmptyString(m.quantity)) push("measurement.quantity", "required");
    if (!nonEmptyString(m.unit)) push("measurement.unit", "required; use \"none\" for non-numeric observations");
    if (!m.sampling || typeof m.sampling !== "object") push("measurement.sampling", "required");
    else {
      if (!Number.isInteger(m.sampling.minSamples) || m.sampling.minSamples < 1) {
        push("measurement.sampling.minSamples", "must be an integer >= 1; zero samples is vacuous");
      }
      if (
        m.sampling.maxIntervalMs !== undefined &&
        !(typeof m.sampling.maxIntervalMs === "number" && m.sampling.maxIntervalMs > 0)
      ) {
        push("measurement.sampling.maxIntervalMs", "must be a positive number when present");
      }
    }
    if (m.tolerance !== undefined) {
      const t = m.tolerance;
      if (!t || !COMPARATORS.includes(t.comparator)) push("measurement.tolerance.comparator", "invalid");
      if (typeof t?.target !== "number" || !Number.isFinite(t.target)) {
        push("measurement.tolerance.target", "must be a finite number");
      }
      if (t?.band !== undefined && !(typeof t.band === "number" && Number.isFinite(t.band) && t.band >= 0)) {
        push("measurement.tolerance.band", "must be a non-negative finite number when present");
      }
    }
  }

  const c = p.capture as ProfileCapture | undefined;
  if (!c || typeof c !== "object") push("capture", "required");
  else {
    if (!nonEmptyString(c.startCondition)) push("capture.startCondition", "required");
    if (!nonEmptyString(c.endCondition)) push("capture.endCondition", "required");
    if (!c.coverage || !nonEmptyString(c.coverage.policy)) push("capture.coverage.policy", "required");
    else if (!(typeof c.coverage.minFraction === "number" && c.coverage.minFraction > 0 && c.coverage.minFraction <= 1)) {
      push("capture.coverage.minFraction", "must be within (0,1]");
    }
  }

  const cal = p.calibration as ProfileCalibration | undefined;
  if (!cal || typeof cal !== "object") push("calibration", "required");
  else if (cal.required === true) {
    if (!nonEmptyString(cal.procedureId)) push("calibration.procedureId", "required when calibration.required");
    if (!(typeof cal.validityWindowSeconds === "number" && cal.validityWindowSeconds > 0)) {
      push(
        "calibration.validityWindowSeconds",
        "required positive window when calibration.required; without it stale calibration cannot be detected",
      );
    }
  }

  const i = p.interpretation as ProfileInterpretation | undefined;
  if (!i || typeof i !== "object") push("interpretation", "required");
  else {
    if (!Array.isArray(i.evidenceTypeIds) || i.evidenceTypeIds.length === 0) {
      push("interpretation.evidenceTypeIds", "required, non-empty");
    }
    if (!ACCEPTANCE_LEVELS.includes(i.acceptanceLevel)) {
      push("interpretation.acceptanceLevel", `must be one of ${ACCEPTANCE_LEVELS.join("|")}`);
    }
    if (!DECISION.has(i.onDeviceFailure)) push("interpretation.onDeviceFailure", 'must be "reject" or "hold"');
  }

  const w = p.witnesses as ProfileWitnesses | undefined;
  if (!w || typeof w !== "object") push("witnesses", "required");
  else {
    if (!Array.isArray(w.requiredRoles)) push("witnesses.requiredRoles", "required array (may be empty)");
    if (typeof w.independentOfClaimant !== "boolean") push("witnesses.independentOfClaimant", "required boolean");
    if (Array.isArray(w.requiredRoles) && w.requiredRoles.length > 0 && w.independentOfClaimant !== true) {
      push("witnesses.independentOfClaimant", "required roles without independence do not constitute witnesses");
    }
  }

  if (!DECISION.has(p.onMissingData as string)) push("onMissingData", 'must be "reject" or "hold"');
  if (!DECISION.has(p.onContradiction as string)) push("onContradiction", 'must be "reject" or "hold"');

  return v;
}

/** Thrown when a digest is requested for a profile that does not validate. */
export class InvalidMeasurementProfileError extends Error {
  constructor(public readonly violations: ProfileViolation[]) {
    super(
      `measurement profile invalid (${violations.length}): ` +
        violations.map((x) => `${x.path || "<root>"}: ${x.message}`).join("; "),
    );
    this.name = "InvalidMeasurementProfileError";
  }
}

function digestProfile(profile: MeasurementProfileV1): MeasurementProfileDigest {
  const hex = createHash("sha256")
    .update(canonicalize({ domain: MEASUREMENT_PROFILE_DOMAIN, profile }))
    .digest("hex");
  return `0x${hex}`;
}

/**
 * The committed digest of a measurement profile:
 *   "0x" + hex(sha256(canonicalize({ domain, profile })))
 * using the PRODUCTION canonicalizer, so the digest a producer computes and the
 * digest a verifier recomputes share one preimage. Refuses invalid profiles.
 */
export function computeMeasurementProfileDigest(
  profile: MeasurementProfileV1,
): MeasurementProfileDigest {
  const violations = validateMeasurementProfile(profile);
  if (violations.length > 0) throw new InvalidMeasurementProfileError(violations);
  return digestProfile(profile);
}

/** Why a presented profile does not govern; null when it does. */
export type ProfileGovernanceCode = "digest-wrong-family" | "profile-invalid" | "digest-mismatch";

/** The outcome of checking a presented profile against a committed digest. */
export interface ProfileGovernanceResult {
  governs: boolean;
  code: ProfileGovernanceCode | null;
  /** Digest recomputed from the presented profile. */
  presentedDigest: MeasurementProfileDigest | null;
  reasons: string[];
}

/**
 * Does `presentedProfile` govern work committed under `committedDigest`?
 *
 * This is the mutation gate the memo asks for: change a sampling rate or a
 * tolerance after acceptance and the recomputed digest differs, so the old
 * acceptance cannot authorize the changed profile. Never throws — a malformed
 * committed digest, an invalid profile, or a mismatch returns `governs:false`
 * with reasons.
 */
export function profileGoverns(
  committedDigest: string,
  presentedProfile: MeasurementProfileV1,
): ProfileGovernanceResult {
  if (typeof committedDigest !== "string" || !MEASUREMENT_PROFILE_DIGEST_PATTERN.test(committedDigest)) {
    return {
      governs: false,
      code: "digest-wrong-family",
      presentedDigest: null,
      reasons: [
        `committed digest ${JSON.stringify(committedDigest)} is not a measurement-profile commitment: expected 0x + 64 lowercase hex; a sha256:-tagged value is the evidence-event family`,
      ],
    };
  }
  const violations = validateMeasurementProfile(presentedProfile);
  if (violations.length > 0) {
    return {
      governs: false,
      code: "profile-invalid",
      presentedDigest: null,
      reasons: violations.map((x) => `${x.path || "<root>"}: ${x.message}`),
    };
  }
  const presentedDigest = digestProfile(presentedProfile);
  if (presentedDigest !== committedDigest) {
    return {
      governs: false,
      code: "digest-mismatch",
      presentedDigest,
      reasons: [
        `profile digest mismatch: committed ${committedDigest}, presented ${presentedDigest} — the accepted agreement did not authorize this profile`,
      ],
    };
  }
  return { governs: true, code: null, presentedDigest, reasons: [] };
}

/**
 * Does the profile's accepted result level support a sensor-grounded claim?
 * `submitted` and `device_reported` do not: the first is a receipt, the second
 * is the device's own word. A consumer advertising inspected-output assurance
 * checks this rather than reading an event name.
 */
export function acceptsInspectedOutput(profile: MeasurementProfileV1): boolean {
  return profile.interpretation.acceptanceLevel === "inspected_output";
}
