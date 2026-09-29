/**
 * profileAdmitsBundle — does the evidence for a job satisfy its committed
 * MeasurementProfile? (LO-SE-2: the same profile digest must govern collection,
 * eligibility and verification, not only acceptance.)
 *
 * Every term of the profile is evaluated here, bound by the digest, checked at
 * registration, or fails closed. Nothing is merely descriptive. The table at
 * the end of this comment says which, field by field.
 *
 * Four legs are structural, not a caller's promise. Each is a required input
 * with no default, so no step can be skipped by forgetting it:
 *   - SET: the presented bundles must be exactly the job's pinned evidence set
 *     (`pinnedBundleSetDigest`, see `computeBundleSetDigest`). A caller that
 *     passes a subset (for example the first bundle that verifies) gets
 *     `bundle-set-mismatch`, never admit, so a stored failure cannot be left out;
 *   - SIGNATURE: every bundle's `bundleHash` verifies under the node's
 *     registered key (`verifyBundleSignature`: gateway
 *     `verifyDeviceSignedEvidence`, the oracle's registered-key check);
 *   - BINDING, run here (`verifyEvidenceSubjectBinding`, LO-EV-9): each digest
 *     opens to its events, and they commit the job and the kernel that
 *     accepted it;
 *   - PRIMITIVE: each qualifying observation is verified as an instance of the
 *     primitive it claims (`verifyPrimitiveInstance`, composed by the oracle
 *     from its verifier registry, where an unimplemented verifier fails closed).
 * A throw from a supplied leg counts as a failure.
 *
 * Callers and the set pin (evidence #3419, oracle #3426):
 *   - The authoritative evaluation is the oracle's, inside /settle, on the
 *     evidence the on-chain-committed package names. Gateway /complete may run
 *     admission as a pre-check; its result is never authoritative.
 *   - The pin's source, now (a): the gateway reads EVERY stored bundle row for
 *     the job (and settlement unit) in one snapshot, and pins
 *     `computeBundleSetDigest` over all the rows that verify, never the first
 *     that verifies. The pin is immutable and recorded with the decision;
 *     recovery re-verifies it, so a bundle stored later cannot silently change
 *     a settled set. This trusts the gateway's store at pin time.
 *   - Later (b): the kernel signs the set at job close, over a domain-separated
 *     message, and the committed evidence carries the seal. That is the only
 *     pin the oracle can enforce. It needs a set commitment in the evidence
 *     block (today it commits one bundle root): an evidence contract change,
 *     for the operator to approve.
 *   - Either way, the pin is never recomputed from `bundles` at evaluation
 *     time; that would make the check vacuous.
 *
 * Evaluate only what was hashed: every check reads the verified canonical
 * snapshots that binding returns (the JSON text `hashEvent` hashed, parsed
 * back), never the caller's objects, whose getters or non-enumerable fields
 * could answer differently from the hashed bytes. An event listed twice counts
 * once (hash identity is content identity after binding). Samples are
 * counted by their `sampleId`, a commitment to the raw capture, so reissuing
 * one observation with a new timestamp (a new event hash) adds nothing. A
 * sampleId stops reissue; it does not prove two samples are physically
 * distinct. That is the primitive verifier's question (a capture nonce, for
 * example), not this function's.
 *
 * A QUALIFYING OBSERVATION is an event that:
 *   - is at the profile's `acceptanceLevel` (evidence-level.ts, the one
 *     classification), from the profiled `device.deviceId`;
 *   - if it is an inspection, carries its own positive verdict,
 *     `payload.passed === true`. A negative verdict is a failure (below), and
 *     an inspection with no verdict proves nothing about the output;
 *   - comes from the profiled kind of device and adapter, and from pinned
 *     versions, each read from its own field: `source.deviceType` equals
 *     `device.kind`, `source.adapterType` equals `device.adapterType`,
 *     `source.adapterVersion` is in `permittedAdapterVersions`, and
 *     `source.firmwareVersion` is in `permittedFirmwareVersions`;
 *   - falls inside the capture window;
 *   - carries `payload.profileObservation` (`ProfileObservation`), which states
 *     what was observed and must match the profile: the committed profile
 *     digest (the capture was configured by this profile), a listed primitive
 *     id, the profile's object, method, quantity and unit, a decimal-string
 *     `value` exactly when the unit is not "none", and a `sampleId`;
 *   - passes the primitive leg for the primitive it names.
 *
 * Then, in order:
 *   1. the profile governs: digest(profile) equals the digest committed at
 *      acceptance (`profileGoverns`), in the 0x commitment family, and the
 *      profile has only v1 terms;
 *   2. terms this version cannot evaluate fail closed with `unverifiable-term`
 *      (`unverifiableProfileTerms`; registration refuses the same terms);
 *   3. the set, then the signature and binding legs, per bundle;
 *   4. simulation: the profile prohibits it, so ANY fabricated event
 *      (`isFabricated`) rejects;
 *   5. contradiction (evidence's `deriveContradictions`, which the oracle signs
 *      rejects on) under `onContradiction`; otherwise a failure
 *      (`execution_failed`, or an inspection with a negative verdict) under
 *      `interpretation.onDeviceFailure`;
 *   6. level: the strongest level the evidence reaches must meet
 *      `acceptanceLevel`, and at least `sampling.minSamples` distinct samples
 *      must qualify. Shortfalls follow `onMissingData`.
 * A hold never outranks a reject.
 *
 * Every profile term:
 *   profileVersion, profileId        bound by the digest
 *   outcome.capabilityType           checked at registration against the
 *                                    capability record (profile-registration.ts);
 *                                    the committed digest comes from that row
 *   outcome.statement                prose for the payer, not a term
 *   outcome.objectIdentity           compared: observation.object
 *   device.deviceId                  compared: source.deviceId
 *   device.kind                      compared: source.deviceType; a kind that is
 *                                    not an evidence device type fails closed
 *   device.adapterType               compared: source.adapterType
 *   device.permittedAdapterVersions  compared: source.adapterVersion
 *   device.permittedFirmwareVersions compared: source.firmwareVersion; a pin
 *                                    containing "*" fails closed (pins are exact)
 *   measurement.method/quantity/unit compared: observation.method/quantity/unit,
 *                                    and observation.value is present iff unit != "none"
 *   measurement.tolerance            fails closed
 *   measurement.sampling.minSamples  counted: distinct observation.sampleId
 *   measurement.sampling.maxIntervalMs  fails closed (continuous capture)
 *   capture.startCondition/endCondition evaluated: the capture window; a token
 *                                    that is not an event type (or "open") fails closed
 *   capture.coverage                 "one-shot" with minFraction 1 is evaluated
 *                                    (one qualifying capture covers it); anything
 *                                    else fails closed
 *   calibration.required             true fails closed; procedureId and
 *                                    validityWindowSeconds only apply when it is true
 *   interpretation.evidenceTypeIds   compared: observation.primitiveId, then the
 *                                    primitive leg; an id that is not an active
 *                                    vocabulary primitive fails closed
 *   interpretation.acceptanceLevel   evaluated: levels
 *   interpretation.onDeviceFailure, onMissingData, onContradiction  applied
 *   simulationProhibited             applied: any fabricated event rejects
 *   witnesses.requiredRoles          non-empty fails closed; independentOfClaimant
 *                                    only applies to required roles
 */

import { isFabricated } from "./is-fabricated.js";
import {
  evidenceLevelOf,
  evidenceLevelOfBundle,
  executingDeviceIds,
  meetsEvidenceLevel,
  deriveContradictions,
  inspectionFailed,
  INSPECTION_EVENT_TYPES,
  type EvidenceLevel,
} from "./evidence-level.js";
import { profileGoverns, type MeasurementProfileV1 } from "./measurement-profile.js";
import { getPrimitive } from "./primitives.js";
import { isTaggedDigest } from "./signing-preimage.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "./subject-binding.js";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES, type EvidenceEvent } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";
import { canonicalize, sha256 } from "../util/canonical.js";

export const PROFILE_ADMISSION_CONTRACT = "pcc.evidence.profile-admission.v1";

/** `endCondition` token meaning "no end bound": capture may happen any time after the start. */
export const OPEN_CAPTURE_WINDOW_END = "open";

/** `measurement.unit` of a non-numeric observation, such as an image. */
export const NON_NUMERIC_UNIT = "none";

/** Domain separator: a bundle-set digest can never be taken for a bundle hash. */
export const BUNDLE_SET_DOMAIN = "PCC:evidence-bundle-set:v1";

/** The payload field that carries a qualifying observation's record. */
export const PROFILE_OBSERVATION_FIELD = "profileObservation";

/** An observation's `value`: a plain decimal, no exponent, no leading zeros, no "+". */
export const DECIMAL_VALUE_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * What a qualifying observation states about itself, in its hashed payload
 * (`payload.profileObservation`). The device and adapter are read from the
 * event's `source`, not from here.
 */
export interface ProfileObservation {
  /** The committed profile digest the capture was configured by. */
  profileDigest: string;
  /** The primitive this observation is an instance of; one of `interpretation.evidenceTypeIds`. */
  primitiveId: string;
  /** The object observed; equals `outcome.objectIdentity`. */
  object: { kind: string; value: string };
  method: string;
  quantity: string;
  unit: string;
  /**
   * The measured value in `unit`, as a decimal string (`DECIMAL_VALUE_PATTERN`),
   * present exactly when `unit` is not "none". A string, not a JSON number:
   * JS and Python print some floats differently (1e-7 vs 1e-07), which would
   * give one reading two event hashes.
   */
  value?: string;
  /**
   * The physical sample: the `sha256:` digest of the raw capture (the image
   * bytes, the raw sensor frame). Reissuing one capture keeps its id.
   */
  sampleId: string;
}

export type ProfileAdmissionDecision = "admit" | "reject" | "hold";

export type ProfileAdmissionCode =
  | "digest-wrong-family"
  | "profile-invalid"
  | "digest-mismatch"
  | "unverifiable-term"
  | "no-bundles"
  | "bundle-set-mismatch"
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
  /** Distinct physical samples that qualify (see "A QUALIFYING OBSERVATION"). */
  qualifyingSamples: number;
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
  /** Every bundle in the job's pinned evidence set. */
  bundles: readonly AdmissionBundle[];
  /** The pinned set's digest (`computeBundleSetDigest`), from where it was pinned (see the caller contract). */
  pinnedBundleSetDigest: string;
  /** The registered-key signature leg. */
  verifyBundleSignature: (bundle: AdmissionBundle) => boolean | Promise<boolean>;
  /**
   * The primitive leg: is `observation` an authentic instance of `primitiveId`
   * for this job? Both arguments are deep-frozen copies of the verified
   * snapshots: `events` is the job's whole bound, de-duplicated event set, so
   * a verifier that needs another event (a capture nonce, say) reads the same
   * hashed evidence admission evaluated instead of fetching its own.
   */
  verifyPrimitiveInstance: (
    primitiveId: string,
    observation: EvidenceEvent,
    events: readonly EvidenceEvent[],
  ) => boolean | Promise<boolean>;
}

const EVENT_TYPES = new Set<string>(EVIDENCE_EVENT_TYPES);
const DEVICE_TYPES = new Set<string>(EVIDENCE_DEVICE_TYPES);
const INSPECTION = new Set<string>(INSPECTION_EVENT_TYPES);

/**
 * The digest a job's pinned evidence set is committed to:
 *   sha256(canonicalize({ domain, jobId, kernelId, settlementUnitId?, bundleHashes }))
 * `sha256:`-tagged, over the bundle hashes de-duplicated and sorted in code-unit
 * order. `settlementUnitId` is included exactly when the subject names one, so a
 * unit-scoped pin cannot stand for another unit. The pinning party computes it
 * with this function over every row it pins (see the caller contract).
 * Throws on an empty set or an entry that is not a `sha256:` tagged digest:
 * there is nothing meaningful to pin.
 */
export async function computeBundleSetDigest(
  subject: Pick<EvidenceSubject, "jobId" | "kernelId" | "settlementUnitId">,
  bundleHashes: readonly string[],
): Promise<SHA256> {
  if (bundleHashes.length === 0) throw new Error("computeBundleSetDigest: the set is empty");
  const bad = bundleHashes.findIndex((h) => !isTaggedDigest(h));
  if (bad !== -1) throw new Error(`computeBundleSetDigest: entry ${bad} is not a sha256: tagged digest`);
  return sha256(
    canonicalize({
      domain: BUNDLE_SET_DOMAIN,
      jobId: subject.jobId,
      kernelId: subject.kernelId,
      ...(subject.settlementUnitId !== undefined ? { settlementUnitId: subject.settlementUnitId } : {}),
      bundleHashes: [...new Set(bundleHashes)].sort(),
    }),
  );
}

function result(
  decision: ProfileAdmissionDecision,
  reasons: ProfileAdmissionReason[],
  reached: EvidenceLevel | null = null,
  qualifyingSamples = 0,
): ProfileAdmissionResult {
  return { decision, admits: decision === "admit", reached, qualifyingSamples, reasons };
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
    terms.push("measurement.tolerance: comparing the observed value with a tolerance is not evaluated yet");
  }
  if (profile.measurement.sampling.maxIntervalMs !== undefined) {
    terms.push("measurement.sampling.maxIntervalMs: a continuous-capture term; only one-shot capture is evaluated");
  }
  if (profile.calibration.required) {
    terms.push("calibration.required: no evidence event carries a calibration record yet");
  }
  if (profile.witnesses.requiredRoles.length > 0) {
    terms.push("witnesses.requiredRoles: independent witness attestation is not evaluated here");
  }
  const coverage = profile.capture.coverage;
  if (coverage.policy !== "one-shot") {
    terms.push(`capture.coverage.policy ${JSON.stringify(coverage.policy)}: only "one-shot" is evaluated`);
  } else if (coverage.minFraction !== 1) {
    terms.push(
      `capture.coverage.minFraction ${coverage.minFraction}: a one-shot capture covers its window whole, so only 1 is evaluated`,
    );
  }
  if (!DEVICE_TYPES.has(profile.device.kind)) {
    terms.push(`device.kind ${JSON.stringify(profile.device.kind)} is not an evidence device type, so no evidence source can match it`);
  }
  for (const field of ["permittedAdapterVersions", "permittedFirmwareVersions"] as const) {
    for (const pin of profile.device[field]) {
      if (pin.includes("*")) {
        terms.push(`device.${field} ${JSON.stringify(pin)}: version pins are exact strings, not patterns`);
      }
    }
  }
  for (const id of profile.interpretation.evidenceTypeIds) {
    if (getPrimitive(id)?.status !== "active") {
      terms.push(`interpretation.evidenceTypeIds ${JSON.stringify(id)} is not an active vocabulary primitive`);
    }
  }
  if (!EVENT_TYPES.has(profile.capture.startCondition)) {
    terms.push(`capture.startCondition ${JSON.stringify(profile.capture.startCondition)} is not an evidence event type`);
  }
  const end = profile.capture.endCondition;
  if (end !== OPEN_CAPTURE_WINDOW_END && !EVENT_TYPES.has(end)) {
    terms.push(`capture.endCondition ${JSON.stringify(end)} is neither an evidence event type nor "${OPEN_CAPTURE_WINDOW_END}"`);
  }
  return terms;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * The observation record, if it matches the profile; otherwise why not (the
 * first profile term it fails, in a fixed order).
 */
function readObservation(
  event: EvidenceEvent,
  profile: MeasurementProfileV1,
  committedDigest: string,
): { ok: true; observation: ProfileObservation } | { ok: false; why: string } {
  const record = isRecord(event.payload) ? event.payload[PROFILE_OBSERVATION_FIELD] : undefined;
  if (!isRecord(record)) return { ok: false, why: "without a profileObservation record" };
  if (record.profileDigest !== committedDigest) return { ok: false, why: "not matching the committed profile digest" };
  if (typeof record.primitiveId !== "string" || !profile.interpretation.evidenceTypeIds.includes(record.primitiveId)) {
    return { ok: false, why: "not matching interpretation.evidenceTypeIds" };
  }
  const object = record.object;
  const expected = profile.outcome.objectIdentity;
  if (!isRecord(object) || object.kind !== expected.kind || object.value !== expected.value) {
    return { ok: false, why: "not matching outcome.objectIdentity" };
  }
  if (record.method !== profile.measurement.method) return { ok: false, why: "not matching measurement.method" };
  if (record.quantity !== profile.measurement.quantity) return { ok: false, why: "not matching measurement.quantity" };
  if (record.unit !== profile.measurement.unit) return { ok: false, why: "not matching measurement.unit" };
  const numeric = profile.measurement.unit !== NON_NUMERIC_UNIT;
  const decimal = typeof record.value === "string" && DECIMAL_VALUE_PATTERN.test(record.value);
  if (numeric ? !decimal : "value" in record) {
    return { ok: false, why: numeric ? "without a decimal-string value" : "with a value on a non-numeric (unit none) observation" };
  }
  if (!isTaggedDigest(record.sampleId)) return { ok: false, why: "without a sha256: sampleId" };
  return { ok: true, observation: record as unknown as ProfileObservation };
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

async function legPasses(leg: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return (await leg()) === true;
  } catch {
    return false;
  }
}

/**
 * Admit, reject or hold the evidence for one job against its committed
 * measurement profile. Never throws.
 */
export async function profileAdmitsBundle(input: ProfileAdmissionInput): Promise<ProfileAdmissionResult> {
  const { profile, committedDigest, subject, bundles, pinnedBundleSetDigest, verifyBundleSignature, verifyPrimitiveInstance } =
    input;

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

  // SET leg: the presented bundles are exactly the pinned set.
  const hashes: string[] = [];
  for (let i = 0; i < bundles.length; i++) {
    const hash = (bundles[i] as Partial<AdmissionBundle> | null | undefined)?.bundleHash;
    if (!isTaggedDigest(hash)) return reject("unbound-bundle", `bundle ${i}: bundleHash is not a sha256: tagged digest`);
    hashes.push(hash);
  }
  let presentedSet: string;
  try {
    presentedSet = await computeBundleSetDigest(subject, hashes);
  } catch (err) {
    presentedSet = `(not computable: ${err instanceof Error ? err.message : String(err)})`;
  }
  if (!isTaggedDigest(pinnedBundleSetDigest) || presentedSet !== pinnedBundleSetDigest) {
    return result(policyDecision(profile.onMissingData), [
      {
        code: "bundle-set-mismatch",
        detail: `the ${new Set(hashes).size} presented bundle(s) digest to ${presentedSet}, not the pinned set ${isTaggedDigest(pinnedBundleSetDigest) ? pinnedBundleSetDigest : "(a malformed pin)"}: a bundle is missing or was not pinned`,
      },
    ]);
  }

  const events: EvidenceEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    if (!(await legPasses(() => verifyBundleSignature(bundle)))) {
      return reject("unauthenticated-bundle", `bundle ${i}: signature leg failed`);
    }
    const binding = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject,
    });
    if (!binding.ok) {
      const at = binding.eventIndex === undefined ? "" : ` at event ${binding.eventIndex}`;
      return reject("unbound-bundle", `bundle ${i}: ${binding.reason}${at}`);
    }
    // Evaluate only what was hashed: the verified canonical snapshots, never
    // the caller's objects (a getter or non-enumerable field could differ).
    for (const e of binding.events) {
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
  // Contradiction is evidence's one public rule, the same one the oracle signs
  // rejects on (evidence-level.ts deriveContradictions); a failure with no
  // completion is a device failure, judged here under onDeviceFailure.
  const contradictions = deriveContradictions(events);
  const executionFailed = events.some((e) => e.type === "execution_failed");
  const failedInspections = events.filter(inspectionFailed).length;
  const failure = [
    ...(executionFailed ? ["execution_failed"] : []),
    ...(failedInspections > 0 ? [`${failedInspections} failed inspection(s)`] : []),
  ].join(" and ");
  if (contradictions.length > 0) {
    findings.push({
      decision: policyDecision(profile.onContradiction),
      reason: { code: "contradictory-evidence", detail: `contradictions: ${contradictions.join(", ")}` },
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
  const { device } = profile;
  const adapterPins = new Set(device.permittedAdapterVersions);
  const firmwarePins = new Set(device.permittedFirmwareVersions);
  const window = captureWindow(profile, events);

  let atLevel = 0;
  let otherDevices = 0;
  const excluded = new Map<string, number>();
  const exclude = (why: string) => excluded.set(why, (excluded.get(why) ?? 0) + 1);
  const samples = new Set<string>();
  // What the primitive leg sees: frozen copies, so nothing it does can reach
  // the snapshots evaluated here (a leg that tries to mutate them throws, and
  // a throw is a failure).
  const legEvents = deepFreeze(structuredClone(events));
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!;
    if (!meetsEvidenceLevel(evidenceLevelOf(e, executing), required)) continue;
    if (e.source.deviceId !== device.deviceId) {
      otherDevices++;
      continue;
    }
    atLevel++;
    if (inspectionFailed(e)) {
      exclude("failed inspection(s)");
      continue;
    }
    if (INSPECTION.has(e.type) && (e.payload as Record<string, unknown> | undefined)?.passed !== true) {
      exclude("without a positive verdict");
      continue;
    }
    if (e.source.deviceType !== device.kind || e.source.adapterType !== device.adapterType) {
      exclude("from another device kind or adapter");
      continue;
    }
    const { adapterVersion, firmwareVersion } = e.source;
    if (
      typeof adapterVersion !== "string" ||
      typeof firmwareVersion !== "string" ||
      !adapterPins.has(adapterVersion) ||
      !firmwarePins.has(firmwareVersion)
    ) {
      exclude("unpermitted version");
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
      exclude("outside the capture window");
      continue;
    }
    const read = readObservation(e, profile, committedDigest);
    if (!read.ok) {
      exclude(read.why);
      continue;
    }
    if (!(await legPasses(() => verifyPrimitiveInstance(read.observation.primitiveId, legEvents[k]!, legEvents)))) {
      exclude(`not verified as ${read.observation.primitiveId}`);
      continue;
    }
    if (samples.has(read.observation.sampleId)) {
      exclude("repeating a counted sample");
      continue;
    }
    samples.add(read.observation.sampleId);
  }
  const qualifying = samples.size;

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
    const exclusions = [...excluded].map(([why, n]) => `${n} ${why}`).join(", ") || "none";
    findings.push({
      decision: policyDecision(profile.onMissingData),
      reason: {
        code: "missing-measurements",
        detail:
          `${qualifying} qualifying sample(s) from ${device.deviceId}, the profile requires ${profile.measurement.sampling.minSamples}` +
          ` (at ${required}: ${atLevel} from the profiled device, ${otherDevices} from other devices;` +
          ` excluded: ${exclusions}${windowNote})`,
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
