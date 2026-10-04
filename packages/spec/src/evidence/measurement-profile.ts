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
 *
 * Nothing changed after this module loads can change a verdict, a digest or
 * the frozen profile returned (astra pack 170). Validation, canonicalization
 * (the production `canonicalize`, itself built that way), the hash and
 * freezing call only intrinsics captured at load (`util/primordials.ts`) and
 * plain loops. The exported constants are frozen, and no format is checked
 * with a RegExp. A realm whose intrinsics were replaced before load is out of
 * scope: no in-process check can tell.
 */

import { createHash } from "node:crypto";

import { canonicalize } from "../util/canonical.js";
import { EVIDENCE_LEVELS, type EvidenceLevel } from "./evidence-level.js";
import { plainDataCopy } from "../util/plain-data.js";
import {
  append,
  ArrayIsArray,
  deepFreeze,
  hasOwn,
  includesValue,
  inSet,
  isHex256Digest,
  joinStrings,
  JSONStringify,
  mapList,
  newList,
  NumberIsFinite,
  NumberIsInteger,
  ObjectGetPrototypeOf,
  ObjectKeys,
  stringSet,
  trim,
  uncurryThis,
  listAt,
  ObjectCreate,
  ObjectDefineProperty,
} from "../util/primordials.js";

/** Domain separator — a profile digest can never collide with another digest. */
export const MEASUREMENT_PROFILE_DOMAIN = "PCC:measurement-profile:v1";

/** A committed measurement-profile digest: `0x` + 64 lowercase hex (SHA-256). */
export type MeasurementProfileDigest = `0x${string}`;

/**
 * Whether `value` is the only accepted committed-digest form: `0x` + 64
 * lowercase hex. A function, not an exported RegExp: RegExp.prototype.compile
 * rewrites a RegExp's matcher in place after load, frozen or not (astra pack 167).
 */
export function isMeasurementProfileDigest(value: unknown): value is MeasurementProfileDigest {
  return isHex256Digest(value);
}

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

/** The evidence contract's own list, frozen where it is defined: validation reads it, so nothing may add a level after load. */
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
  /**
   * The device's evidence source type (`EVIDENCE_DEVICE_TYPES`, e.g. "camera",
   * "controller"). Admission compares it with each observation's
   * `source.deviceType`, and fails closed on a kind no evidence source can carry.
   */
  kind: string;
  /** Adapter type that must serve this device (`source.adapterType`); a mock can never satisfy it. */
  adapterType: string;
  /**
   * Non-empty allowlists of exact strings, each checked against its own
   * evidence field: `source.adapterVersion` and `source.firmwareVersion`.
   */
  permittedAdapterVersions: string[];
  permittedFirmwareVersions: string[];
}

export interface ProfileMeasurement {
  /** How the quantity is obtained, e.g. "optical-capture", "page-count". */
  method: string;
  /** What is measured, e.g. "printed-page-image". */
  quantity: string;
  /**
   * Unit token; "none" for non-numeric observations such as an image. Each
   * qualifying observation restates it and, unless it is "none", carries its
   * value as a decimal string (profile-admission.ts `ProfileObservation`).
   */
  unit: string;
  /** Numeric tolerance; omitted for non-numeric observations. */
  tolerance?: { comparator: "<" | "<=" | "=" | ">=" | ">"; target: number; band?: number };
  sampling: {
    /** Minimum observations required; at least 1. */
    minSamples: number;
    /** Max gap between samples for continuous capture; omit for one-shot (admission fails closed on it). */
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
    /** "one-shot" | "continuous" — what completeness means here. Admission evaluates only "one-shot". */
    policy: string;
    /** Fraction of the window that must be covered, within (0,1]. One-shot capture evaluates only 1. */
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

const DECISION = stringSet(["reject", "hold"]);
const COMPARATORS: readonly string[] = deepFreeze(["<", "<=", "=", ">=", ">"]);

/**
 * The v1 terms, per object. Any other key is a violation: an unknown term
 * would be committed by the digest but evaluated by nothing.
 */
const V1_FIELDS: readonly { path: string; segments: readonly string[]; allowed: readonly string[] }[] = deepFreeze([
  {
    path: "",
    segments: [],
    allowed: [
      "profileVersion", "profileId", "outcome", "device", "measurement", "capture",
      "calibration", "interpretation", "simulationProhibited", "witnesses", "onMissingData", "onContradiction",
    ],
  },
  { path: "outcome", segments: ["outcome"], allowed: ["capabilityType", "statement", "objectIdentity"] },
  { path: "outcome.objectIdentity", segments: ["outcome", "objectIdentity"], allowed: ["kind", "value"] },
  { path: "device", segments: ["device"], allowed: ["deviceId", "kind", "adapterType", "permittedAdapterVersions", "permittedFirmwareVersions"] },
  { path: "measurement", segments: ["measurement"], allowed: ["method", "quantity", "unit", "tolerance", "sampling"] },
  { path: "measurement.tolerance", segments: ["measurement", "tolerance"], allowed: ["comparator", "target", "band"] },
  { path: "measurement.sampling", segments: ["measurement", "sampling"], allowed: ["minSamples", "maxIntervalMs"] },
  { path: "capture", segments: ["capture"], allowed: ["startCondition", "endCondition", "coverage"] },
  { path: "capture.coverage", segments: ["capture", "coverage"], allowed: ["policy", "minFraction"] },
  { path: "calibration", segments: ["calibration"], allowed: ["required", "procedureId", "validityWindowSeconds"] },
  { path: "interpretation", segments: ["interpretation"], allowed: ["evidenceTypeIds", "acceptanceLevel", "onDeviceFailure"] },
  { path: "witnesses", segments: ["witnesses"], allowed: ["requiredRoles", "independentOfClaimant"] },
]);

/** The calibration terms that only `calibration.required: true` makes meaningful. */
const CALIBRATION_TERMS: readonly ("procedureId" | "validityWindowSeconds")[] = deepFreeze(["procedureId", "validityWindowSeconds"] as ("procedureId" | "validityWindowSeconds")[]);

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && trim(v).length > 0;
}

function positiveFinite(v: unknown): boolean {
  return typeof v === "number" && NumberIsFinite(v) && v > 0;
}

/**
 * Every slot holds a non-empty string. Index-based, so a sparse array's holes
 * fail (`.every` skips them), and an index is the array's OWN: one a prototype
 * serves is a hole.
 */
function denseStringList(v: unknown[]): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!hasOwn(v, i) || !nonEmptyString(listAt(v, i))) return false;
  }
  return true;
}

/** A non-empty, dense array whose every entry is a non-empty string. */
function nonEmptyStringList(v: unknown): boolean {
  return ArrayIsArray(v) && v.length > 0 && denseStringList(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !ArrayIsArray(v);
}

/**
 * Validate a profile. Returns every violation found (empty array = valid).
 * Fails CLOSED: anything malformed, missing or self-contradictory is a
 * violation, and `computeMeasurementProfileDigest` refuses to digest it — an
 * unvalidatable profile must never acquire a digest that looks authoritative.
 */
export function validateMeasurementProfile(profile: unknown): ProfileViolation[] {
  const v = newList<ProfileViolation>(0);
  const push = (path: string, message: string) => append(v, { path, message });

  if (typeof profile !== "object" || profile === null) {
    return [{ path: "", message: "profile must be an object" }];
  }
  const p = profile as Record<string, unknown>;

  for (let f = 0; f < V1_FIELDS.length; f++) {
    const { path, segments, allowed } = listAt(V1_FIELDS, f)!;
    let at: unknown = p;
    for (let s = 0; s < segments.length; s++) {
      const segment = listAt(segments, s)!;
      at = isObject(at) && hasOwn(at, segment) ? at[segment] : undefined;
    }
    if (!isObject(at)) continue;
    const keys = ObjectKeys(at);
    for (let k = 0; k < keys.length; k++) {
      const key = listAt(keys, k)!;
      if (!includesValue(allowed, key)) {
        push(path ? `${path}.${key}` : key, "unknown field: a v1 profile has only the v1 terms, and an unknown term would be committed but never evaluated");
      }
    }
  }

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
    if (!nonEmptyStringList(device.permittedAdapterVersions)) {
      push("device.permittedAdapterVersions", "required, non-empty list of non-empty strings; an open version set is not a pinned device");
    }
    if (!nonEmptyStringList(device.permittedFirmwareVersions)) {
      push("device.permittedFirmwareVersions", "required, non-empty list of non-empty strings");
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
      if (!NumberIsInteger(m.sampling.minSamples) || m.sampling.minSamples < 1) {
        push("measurement.sampling.minSamples", "must be an integer >= 1; zero samples is vacuous");
      }
      if (m.sampling.maxIntervalMs !== undefined && !positiveFinite(m.sampling.maxIntervalMs)) {
        push("measurement.sampling.maxIntervalMs", "must be a positive finite number when present");
      }
    }
    if (m.tolerance !== undefined) {
      const t = m.tolerance;
      if (!t || !includesValue(COMPARATORS, t.comparator)) push("measurement.tolerance.comparator", "invalid");
      if (typeof t?.target !== "number" || !NumberIsFinite(t.target)) {
        push("measurement.tolerance.target", "must be a finite number");
      }
      if (t?.band !== undefined && !(typeof t.band === "number" && NumberIsFinite(t.band) && t.band >= 0)) {
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
  else if (typeof cal.required !== "boolean") push("calibration.required", "required boolean");
  else if (cal.required) {
    if (!nonEmptyString(cal.procedureId)) push("calibration.procedureId", "required when calibration.required");
    if (!positiveFinite(cal.validityWindowSeconds)) {
      push(
        "calibration.validityWindowSeconds",
        "required positive window when calibration.required; without it stale calibration cannot be detected",
      );
    }
  } else {
    // Inert terms: with calibration not required, nothing evaluates them, so a
    // digest must not commit them (they would read as a requirement).
    for (let k = 0; k < CALIBRATION_TERMS.length; k++) {
      const field = listAt(CALIBRATION_TERMS, k)!;
      if (hasOwn(cal, field) && cal[field] !== undefined) {
        push(`calibration.${field}`, "only allowed when calibration.required is true; with calibration not required it would be committed but never evaluated");
      }
    }
  }

  const i = p.interpretation as ProfileInterpretation | undefined;
  if (!i || typeof i !== "object") push("interpretation", "required");
  else {
    if (!nonEmptyStringList(i.evidenceTypeIds)) {
      push("interpretation.evidenceTypeIds", "required, non-empty list of primitive ids");
    }
    if (!includesValue(ACCEPTANCE_LEVELS, i.acceptanceLevel)) {
      push("interpretation.acceptanceLevel", `must be one of ${joinStrings(ACCEPTANCE_LEVELS, "|")}`);
    }
    if (!inSet(DECISION, i.onDeviceFailure)) push("interpretation.onDeviceFailure", 'must be "reject" or "hold"');
  }

  const w = p.witnesses as ProfileWitnesses | undefined;
  if (!w || typeof w !== "object") push("witnesses", "required");
  else {
    if (!ArrayIsArray(w.requiredRoles) || !denseStringList(w.requiredRoles)) {
      push("witnesses.requiredRoles", "required array of role ids (may be empty)");
    }
    if (typeof w.independentOfClaimant !== "boolean") push("witnesses.independentOfClaimant", "required boolean");
    if (ArrayIsArray(w.requiredRoles) && w.requiredRoles.length > 0 && w.independentOfClaimant !== true) {
      push("witnesses.independentOfClaimant", "required roles without independence do not constitute witnesses");
    }
  }

  if (!inSet(DECISION, p.onMissingData)) push("onMissingData", 'must be "reject" or "hold"');
  if (!inSet(DECISION, p.onContradiction)) push("onContradiction", 'must be "reject" or "hold"');

  return v;
}

/** Thrown when a digest is requested for a profile that does not validate. */
export class InvalidMeasurementProfileError extends Error {
  constructor(public readonly violations: ProfileViolation[]) {
    super(
      `measurement profile invalid (${violations.length}): ` +
        joinStrings(mapList(violations, (x) => `${x.path || "<root>"}: ${x.message}`), "; "),
    );
    // Defined, not assigned: an accessor planted on Error.prototype after load is never run (astra pack 291).
    const descriptor = ObjectCreate(null) as PropertyDescriptor;
    descriptor.value = "InvalidMeasurementProfileError";
    descriptor.writable = true;
    descriptor.enumerable = true;
    descriptor.configurable = true;
    ObjectDefineProperty(this, "name", descriptor);
  }
}

/** SHA-256 through node:crypto's Hash, with its methods captured when this module loads. */
const createHashAtLoad = createHash;
const HashPrototype = ObjectGetPrototypeOf(createHash("sha256")) as { update: (data: string) => unknown; digest: (encoding: "hex") => string };
const HashPrototypeUpdate = uncurryThis(HashPrototype.update);
const HashPrototypeDigest = uncurryThis(HashPrototype.digest);

function digestProfile(profile: MeasurementProfileV1): MeasurementProfileDigest {
  const hash = createHashAtLoad("sha256");
  HashPrototypeUpdate(hash, canonicalize({ domain: MEASUREMENT_PROFILE_DOMAIN, profile }));
  return `0x${HashPrototypeDigest(hash, "hex")}`;
}

/** Re-exported: the one-pass copy every check here runs on (util/plain-data.ts). */
export { plainDataCopy };

/** A diagnostic for any value that cannot throw (JSON.stringify can, on a bigint or a cycle). */
function describeValue(v: unknown): string {
  return typeof v === "string" ? JSONStringify(v) : `a value of type ${typeof v}`;
}

/**
 * The committed digest of a measurement profile:
 *   "0x" + hex(sha256(canonicalize({ domain, profile })))
 * using the PRODUCTION canonicalizer, so the digest a producer computes and the
 * digest a verifier recomputes share one preimage. It is computed over a plain-
 * data copy (`plainDataCopy`), validated first; an invalid profile is refused.
 */
export function computeMeasurementProfileDigest(
  profile: MeasurementProfileV1,
): MeasurementProfileDigest {
  const copy = plainDataCopy(profile);
  if (!copy.ok) {
    throw new InvalidMeasurementProfileError([{ path: "", message: `not plain JSON data (${copy.reason})` }]);
  }
  const violations = validateMeasurementProfile(copy.value);
  if (violations.length > 0) throw new InvalidMeasurementProfileError(violations);
  return digestProfile(copy.value as MeasurementProfileV1);
}

/** Why a presented profile does not govern; null when it does. */
export type ProfileGovernanceCode = "digest-wrong-family" | "profile-invalid" | "digest-mismatch";

/** The outcome of checking a presented profile against a committed digest. */
export interface ProfileGovernanceResult {
  governs: boolean;
  code: ProfileGovernanceCode | null;
  /** Digest recomputed from the presented profile. */
  presentedDigest: MeasurementProfileDigest | null;
  /**
   * The profile that governs: a deep-frozen, plain-data copy of the presented
   * profile, validated and digested exactly as returned. Null unless it
   * governs. Evaluate only this, never the caller's object, whose fields could
   * change, or answer differently, after this check.
   */
  profile: MeasurementProfileV1 | null;
  reasons: string[];
}

/**
 * Does `presentedProfile` govern work committed under `committedDigest`?
 *
 * This is the mutation gate the memo asks for: change a sampling rate or a
 * tolerance after acceptance and the recomputed digest differs, so the old
 * acceptance cannot authorize the changed profile. The check runs on one
 * plain-data copy, and that copy is what it returns. Never throws: a
 * malformed committed digest, a profile JSON cannot carry, an invalid profile,
 * or a mismatch returns `governs:false` with a code and reasons.
 */
export function profileGoverns(
  committedDigest: string,
  presentedProfile: MeasurementProfileV1,
): ProfileGovernanceResult {
  const refuse = (
    code: ProfileGovernanceCode,
    reasons: string[],
    presentedDigest: MeasurementProfileDigest | null = null,
  ): ProfileGovernanceResult => ({ governs: false, code, presentedDigest, profile: null, reasons });

  if (!isMeasurementProfileDigest(committedDigest)) {
    return refuse("digest-wrong-family", [
      `committed digest ${describeValue(committedDigest)} is not a measurement-profile commitment: expected 0x + 64 lowercase hex; a sha256:-tagged value is the evidence-event family`,
    ]);
  }
  const copy = plainDataCopy(presentedProfile);
  if (!copy.ok) return refuse("profile-invalid", [`<root>: not plain JSON data (${copy.reason})`]);
  let profile: MeasurementProfileV1;
  let presentedDigest: MeasurementProfileDigest;
  try {
    const violations = validateMeasurementProfile(copy.value);
    if (violations.length > 0) {
      return refuse("profile-invalid", mapList(violations, (x) => `${x.path || "<root>"}: ${x.message}`));
    }
    profile = deepFreeze(copy.value) as MeasurementProfileV1;
    presentedDigest = digestProfile(profile);
  } catch {
    // The copy is plain data, so this is a defect, not an input; still never throw.
    return refuse("profile-invalid", ["<root>: the profile could not be validated"]);
  }
  if (presentedDigest !== committedDigest) {
    return refuse(
      "digest-mismatch",
      [
        `profile digest mismatch: committed ${committedDigest}, presented ${presentedDigest} — the accepted agreement did not authorize this profile`,
      ],
      presentedDigest,
    );
  }
  return { governs: true, code: null, presentedDigest, profile, reasons: [] };
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
