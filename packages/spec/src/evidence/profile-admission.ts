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
 *     The comparisons here only prove the record says the committed things;
 *     the leg must prove the record is TRUE of this event: that its sampleId
 *     commits the raw capture this event carries or references, that the
 *     capture is of the committed object (its nonce or document binding), and
 *     that the measurement relation holds. A leg that only checks some
 *     artifact hash, or finds a valid nonce anywhere in the set, would let a
 *     matching record ride on evidence about another object. Distinct sample
 *     ids meeting the physical sampling requirement is the leg's to establish
 *     too; here they only stop reissue.
 * A throw from a supplied leg counts as a failure.
 *
 * Callers and the set pin (evidence #3419 and #3543, oracle #3426):
 *   - The authoritative evaluation is the oracle's, inside /settle, on the
 *     evidence the on-chain-committed package names. Gateway /complete may run
 *     admission as a pre-check; its result is never authoritative.
 *   - v1 rule (evidence #3543): a settlement unit's evidence is ONE
 *     kernel-signed bundle that holds every outcome-bearing event, terminal and
 *     inspection alike, so a failure cannot sit in a bundle nobody presents.
 *     kernel-sdk (one bundle per job) and the kernel EvidenceEmitter (one per
 *     step, camera and sensors included) already emit that way. At /settle the
 *     pin degenerates to that one bundle:
 *     `computeBundleSetDigest(subject, [committedRoot])`, with `committedRoot`
 *     read from the committed package, never from the presentation.
 *   - The pin's source, now (a): the gateway reads EVERY stored bundle row for
 *     the job (and settlement unit) in one snapshot, and pins
 *     `computeBundleSetDigest` over all the rows that verify, never the first
 *     that verifies. The pin is immutable and recorded with the decision;
 *     recovery re-verifies it, so a bundle stored later cannot silently change
 *     a settled set. This trusts the gateway's store at pin time.
 *   - (b), a kernel-signed seal over a multi-bundle set, is NOT adopted for v1
 *     (evidence #3543); the one-bundle rule makes it unnecessary while a unit's
 *     evidence is one bundle.
 *   - Either way, the pin is never recomputed from `bundles` at evaluation
 *     time; that would make the check vacuous.
 *   - Still OPEN on the caller side, and required before this gates money
 *     (astra, pack 39 round 2):
 *       - finalize collection atomically with pinning: define job closure,
 *         sequencing, and what happens to evidence that arrives late;
 *       - authenticate and classify EVERY stored row: a row that fails
 *         validation must end in an explicit terminal state (reject or
 *         quarantine), never be silently left out of the pin;
 *       - persist the exact manifest and context with the decision: bundle
 *         roots, profile commitment, subject, unit and challenge, and the
 *         verifier and program identity, so recovery re-evaluates the same set;
 *       - under v1, present exactly the committed bundle at /settle, and hold
 *         producers to the one-bundle rule (evidence states it in LO-EV-9 and
 *         EvidenceBlockV2); a multi-bundle set would need the seal seam;
 *       - exercise the real seam: omitted failure, concurrent failure arrival,
 *         mutation across awaits, recovery after pinning, and gateway/oracle
 *         set disagreement.
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
 *   3. the set: a malformed pin rejects (it is no commitment at all). A set
 *      that is not the pinned one can never be admitted, but evaluation goes
 *      on, so a hard reject in what was presented still decides (a set
 *      mismatch under `onMissingData: "hold"` must not hide a contradiction
 *      the profile rejects on). Then the signature and binding legs, per
 *      bundle;
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
 *
 * NOTHING THAT RUNS AFTER LOAD CHANGES A DECISION, A DIGEST OR A RETURNED VALUE
 * (#363 round 9, steward #5186: the realm-mutation class of astra packs 162,
 * 164, 167, 170 and 171).
 *   - This module calls only intrinsics captured when util/primordials.ts
 *     loads, plain loops and operators: never a method looked up on a prototype
 *     or a global at the time of the call, never the iterator protocol, never
 *     `in`, never a RegExp. Formats are checked code unit by code unit
 *     (`isDecimalValue`, `isTaggedSha256`): RegExp.prototype.compile rewrites
 *     a RegExp in place, frozen or not (pack 167).
 *   - Its sets are null-prototype records built at load, the vocabulary's
 *     active primitives included (primitives.ts's defs are exported, mutable
 *     objects), and its exported data is frozen.
 *   - Everything it evaluates is its own plain-data copy, with no prototype at
 *     any depth, so a value written on Object.prototype is never read as the
 *     input's. The input boundary reads descriptors through their own
 *     properties: `"value" in descriptor` would also find one written on
 *     Object.prototype and pass an accessor off as data (pack 162).
 *   - The hash, for the bundle-set digest and the binding re-check, is
 *     node:crypto's SHA-256 with its methods captured at load, as in
 *     measurement-profile.ts, byte-identical to util/canonical.ts `sha256`.
 *   - The binding leg (`verifyEvidenceSubjectBinding`, the evidence lane's
 *     subject-binding.ts) is not built this way yet: it hashes through
 *     Array.prototype methods, JSON.parse, crypto.subtle and promise
 *     resolutions looked up at call time. Its answer is therefore re-verified
 *     here before anything it returns is evaluated: each event re-hashed, the
 *     bundle hash recomputed, and every subject commitment checked again, with
 *     the captured hash and own reads. The re-check can only refuse more.
 *   - Promises: `await` reads a promise's `constructor`, a resolution looks up
 *     `then`, and a native `then` builds the promise it returns with
 *     `constructor[Symbol.species]`. Every promise returned
 *     (`profileAdmitsBundle`, `computeBundleSetDigest`) is an `ownPromise`:
 *     its own `then`, `catch` and `finally` are the ones captured at load and
 *     its species is pinned, so every promise a caller derives from it is
 *     pinned too, at any depth (astra pack 187). The binding leg's promise is
 *     awaited through `awaitedHere`, so that `await` reads only its own
 *     `constructor` and looks nothing up on the answer. A leg's promise is
 *     followed through the `then` captured at load (`fulfillsWithTrue`). The
 *     result is a null-prototype object, so a `then` written on
 *     Object.prototype cannot take over its resolution.
 * The boundary, named honestly: the verification callbacks are the caller's
 * trusted code (a leg's answer must be true, false or a native promise; a
 * thenable is refused). A realm whose intrinsics were replaced BEFORE
 * @pcc/spec loaded is out of scope: no in-process check can tell. Anything
 * replaced after load can make admission refuse, or, for a promise that never
 * settles, never answer; it cannot change an acceptance or a value.
 */

import { createHash } from "node:crypto";

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
import { plainDataCopy, profileGoverns, type MeasurementProfileV1 } from "./measurement-profile.js";
// The trap-free proxy check: util/plain-data.ts binds Node's own from node:util when it loads.
import { isProxy } from "../util/plain-data.js";
import { EVIDENCE_PRIMITIVES } from "./primitives.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "./subject-binding.js";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES, type EvidenceEvent } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";
import { canonicalize } from "../util/canonical.js";
import {
  append,
  ArrayIsArray,
  ArrayPrototype,
  awaitedHere,
  charCodeAt,
  DateParse,
  deepFreeze,
  defineIndex,
  ErrorCtor,
  fulfillsWithTrue,
  hasOwn,
  includesValue,
  inSet,
  isHex256Digest,
  isTaggedSha256,
  joinStrings,
  JSONStringify,
  mapList,
  newList,
  NumberIsFinite,
  ObjectCreate,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectKeys,
  ownDataValue,
  ownPromise,
  PromiseCtor,
  ReflectOwnKeys,
  sortedStrings,
  StringCtor,
  stringSet,
  StructuredClone,
  uncurryThis,
} from "../util/primordials.js";

export const PROFILE_ADMISSION_CONTRACT = "pcc.evidence.profile-admission.v1";

/** `endCondition` token meaning "no end bound": capture may happen any time after the start. */
export const OPEN_CAPTURE_WINDOW_END = "open";

/** `measurement.unit` of a non-numeric observation, such as an image. */
export const NON_NUMERIC_UNIT = "none";

/** Domain separator: a bundle-set digest can never be taken for a bundle hash. */
export const BUNDLE_SET_DOMAIN = "PCC:evidence-bundle-set:v1";

/** The payload field that carries a qualifying observation's record. */
export const PROFILE_OBSERVATION_FIELD = "profileObservation";

function isDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

/**
 * An observation's `value`: a plain decimal string, exactly
 * `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`. An optional minus, an integer part with no
 * leading zero, and an optional fraction of at least one digit: no exponent,
 * no "+", no whitespace, ASCII digits only. False for anything that is not a
 * string. A predicate, not an exported RegExp, checked code unit by code
 * unit: RegExp.prototype.compile rewrites a RegExp's matcher in place after
 * load, frozen or not (astra pack 167; this replaces DECIMAL_VALUE_PATTERN).
 */
export function isDecimalValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const n = value.length;
  let i = 0;
  if (i < n && charCodeAt(value, i) === 0x2d) i++; // "-"
  if (i >= n) return false;
  const first = charCodeAt(value, i);
  if (first === 0x30) {
    i++; // a lone "0": no leading zero
  } else if (first >= 0x31 && first <= 0x39) {
    i++;
    while (i < n && isDigit(charCodeAt(value, i))) i++;
  } else {
    return false;
  }
  if (i === n) return true;
  if (charCodeAt(value, i) !== 0x2e) return false; // "."
  i++;
  if (i >= n) return false; // a fraction needs a digit
  for (; i < n; i++) if (!isDigit(charCodeAt(value, i))) return false;
  return true;
}

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
   * The measured value in `unit`, as a decimal string (`isDecimalValue`),
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
  | "input-unreadable"
  | "digest-wrong-family"
  | "profile-invalid"
  | "digest-mismatch"
  | "unverifiable-term"
  | "no-bundles"
  | "bundle-set-pin-invalid"
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
  /** The pinned set's digest (`computeBundleSetDigest`), from where it was pinned (see the caller contract). A malformed pin rejects. */
  pinnedBundleSetDigest: string;
  /** The registered-key signature leg. Its answer must be true, or a native promise of true; anything else fails. */
  verifyBundleSignature: (bundle: AdmissionBundle) => boolean | Promise<boolean>;
  /**
   * The primitive leg: is `observation` an authentic instance of `primitiveId`
   * for this job, and is its `profileObservation` record TRUE of it? It must
   * check this exact observation: its sampleId against the raw capture the
   * event carries or references, the capture against the committed object,
   * and the measurement relation (see the header). Both arguments are
   * deep-frozen copies of the verified snapshots: `events` is the job's whole
   * bound, de-duplicated event set, so a verifier that needs another event (a
   * capture nonce, say) reads the same hashed evidence admission evaluated
   * instead of fetching its own.
   */
  verifyPrimitiveInstance: (
    primitiveId: string,
    observation: EvidenceEvent,
    events: readonly EvidenceEvent[],
  ) => boolean | Promise<boolean>;
}

// -- built when this module loads --

/** The vocabularies as null-prototype records: membership consults no prototype and no Set method. */
const EVENT_TYPES = stringSet(EVIDENCE_EVENT_TYPES);
const DEVICE_TYPES = stringSet(EVIDENCE_DEVICE_TYPES);
const INSPECTION = stringSet(INSPECTION_EVENT_TYPES);

/**
 * The vocabulary's active primitive ids, read once, here. primitives.ts's defs
 * are exported, mutable objects, and its `getPrimitive` answers from a Map, so
 * a status written, or a Map method replaced, after load would change which
 * terms registration and admission can evaluate. A later def wins, as it does
 * in getPrimitive's Map.
 */
const ACTIVE_PRIMITIVES = ((): Readonly<Record<string, true>> => {
  const status = ObjectCreate(null) as Record<string, unknown>;
  for (let i = 0; i < EVIDENCE_PRIMITIVES.length; i++) {
    const def = EVIDENCE_PRIMITIVES[i]!;
    status[def.id] = def.status;
  }
  const ids = ObjectKeys(status);
  const active = newList<string>(0);
  for (let i = 0; i < ids.length; i++) if (status[ids[i]!] === "active") append(active, ids[i]!);
  return stringSet(active);
})();

/** The input fields admission reads, in the order it reads them. */
const INPUT_FIELDS = deepFreeze([
  "pinnedBundleSetDigest",
  "verifyBundleSignature",
  "verifyPrimitiveInstance",
  "subject",
  "bundles",
  "committedDigest",
  "profile",
] as const);
type InputField = (typeof INPUT_FIELDS)[number];

/** The input fields that are data, walked for code before anything is copied. */
const DATA_FIELDS = deepFreeze(["profile", "subject", "bundles"] as const);

const VERSION_PIN_FIELDS = deepFreeze(["permittedAdapterVersions", "permittedFirmwareVersions"] as const);

/** SHA-256 through node:crypto's Hash, with its methods captured when this module loads (as measurement-profile.ts does). */
const createHashAtLoad = createHash;
const HashPrototype = ObjectGetPrototypeOf(createHash("sha256")) as { update: (data: string) => unknown; digest: (encoding: "hex") => string };
const HashPrototypeUpdate = uncurryThis(HashPrototype.update);
const HashPrototypeDigest = uncurryThis(HashPrototype.digest);

/**
 * `sha256:` + hex(SHA-256(UTF-8 text)): byte-identical to util/canonical.ts
 * `sha256`, which calls crypto.subtle, Array.from, map and join at call time.
 */
function taggedSha256(text: string): SHA256 {
  const hash = createHashAtLoad("sha256");
  HashPrototypeUpdate(hash, text);
  return `sha256:${HashPrototypeDigest(hash, "hex")}` as SHA256;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !ArrayIsArray(v);
}

/** A thrown value's own `message`, for a diagnostic; never runs code supplied with it. */
function messageOf(err: unknown): string {
  const message = ownDataValue(err, "message");
  return typeof message === "string" ? message : "it threw";
}

/** A subject field for the set digest: its own data property; an accessor is refused, never run. */
function subjectField(subject: unknown, key: string): unknown {
  if (typeof subject !== "object" || subject === null) throw new ErrorCtor("computeBundleSetDigest: the subject is not an object");
  const descriptor = ObjectGetOwnPropertyDescriptor(subject, key);
  if (descriptor === undefined) return undefined;
  if (!hasOwn(descriptor, "value")) throw new ErrorCtor(`computeBundleSetDigest: subject.${key} is an accessor`);
  return descriptor.value;
}

/**
 * The set digest, computed now: the hashes de-duplicated and sorted in
 * code-unit order, the subject's own fields, the domain, hashed with the
 * captured SHA-256. Throws on an empty set or an entry that is not a `sha256:`
 * tagged digest; an index the array does not own (a hole, or one
 * Array.prototype serves) is not an entry.
 */
function bundleSetDigest(subject: unknown, bundleHashes: unknown): SHA256 {
  if (!ArrayIsArray(bundleHashes)) throw new ErrorCtor("computeBundleSetDigest: the bundle hashes are not an array");
  if (bundleHashes.length === 0) throw new ErrorCtor("computeBundleSetDigest: the set is empty");
  const distinct = ObjectCreate(null) as Record<string, true>;
  const hashes = newList<string>(0);
  for (let i = 0; i < bundleHashes.length; i++) {
    const hash = ownDataValue(bundleHashes, i);
    if (!isTaggedSha256(hash)) throw new ErrorCtor(`computeBundleSetDigest: entry ${i} is not a sha256: tagged digest`);
    if (!hasOwn(distinct, hash)) {
      distinct[hash] = true;
      append(hashes, hash);
    }
  }
  const preimage = ObjectCreate(null) as Record<string, unknown>;
  preimage.domain = BUNDLE_SET_DOMAIN;
  preimage.jobId = subjectField(subject, "jobId");
  preimage.kernelId = subjectField(subject, "kernelId");
  const settlementUnitId = subjectField(subject, "settlementUnitId");
  if (settlementUnitId !== undefined) preimage.settlementUnitId = settlementUnitId;
  preimage.bundleHashes = sortedStrings(hashes);
  return taggedSha256(canonicalize(preimage));
}

/**
 * The digest a job's pinned evidence set is committed to:
 *   sha256(canonicalize({ domain, jobId, kernelId, settlementUnitId?, bundleHashes }))
 * `sha256:`-tagged, over the bundle hashes de-duplicated and sorted in code-unit
 * order. `settlementUnitId` is included exactly when the subject names one, so a
 * unit-scoped pin cannot stand for another unit. The pinning party computes it
 * with this function over every row it pins (see the caller contract).
 * Rejects on an empty set or an entry that is not a `sha256:` tagged digest:
 * there is nothing meaningful to pin.
 *
 * It reads only the subject's own data properties and the array's own
 * indices, hashes with the SHA-256 captured at load, and returns an
 * `ownPromise` (util/primordials.ts): awaiting it, or following it with
 * `.then`, `.catch` or `.finally` at any depth, hands the caller this digest
 * or this rejection, whatever code running after load replaced on Promise.
 */
export function computeBundleSetDigest(
  subject: Pick<EvidenceSubject, "jobId" | "kernelId" | "settlementUnitId">,
  bundleHashes: readonly string[],
): Promise<SHA256> {
  return ownPromise(
    new PromiseCtor<SHA256>((resolve, reject) => {
      try {
        resolve(bundleSetDigest(subject, bundleHashes));
      } catch (err) {
        reject(err);
      }
    }),
  );
}

/** A result with no prototype: an async return is resolved with it, and a `then` on Object.prototype must not be consulted. */
function result(
  decision: ProfileAdmissionDecision,
  reasons: ProfileAdmissionReason[],
  reached: EvidenceLevel | null = null,
  qualifyingSamples = 0,
): ProfileAdmissionResult {
  const out = ObjectCreate(null) as ProfileAdmissionResult;
  out.decision = decision;
  out.admits = decision === "admit";
  out.reached = reached;
  out.qualifyingSamples = qualifyingSamples;
  out.reasons = reasons;
  return out;
}

function reason(code: ProfileAdmissionCode, detail: string): ProfileAdmissionReason {
  return { code, detail };
}

function only(code: ProfileAdmissionCode, detail: string): ProfileAdmissionReason[] {
  const reasons = newList<ProfileAdmissionReason>(0);
  append(reasons, reason(code, detail));
  return reasons;
}

const reject = (code: ProfileAdmissionCode, detail: string) => result("reject", only(code, detail));

/** True when `s` contains "*". */
function hasWildcard(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (charCodeAt(s, i) === 0x2a) return true;
  return false;
}

/**
 * Terms of a valid profile this version cannot evaluate. Registration refuses
 * a profile with any of them (profile-registration.ts), so admission and
 * registration share one definition. It reads the profile's own data
 * properties only, so a value on Object.prototype (a `tolerance`, say) is
 * never taken for a term, and an accessor is never run.
 */
export function unverifiableProfileTerms(profile: MeasurementProfileV1): string[] {
  const terms = newList<string>(0);
  const measurement = ownDataValue(profile, "measurement");
  if (ownDataValue(measurement, "tolerance") !== undefined) {
    append(terms, "measurement.tolerance: comparing the observed value with a tolerance is not evaluated yet");
  }
  if (ownDataValue(ownDataValue(measurement, "sampling"), "maxIntervalMs") !== undefined) {
    append(terms, "measurement.sampling.maxIntervalMs: a continuous-capture term; only one-shot capture is evaluated");
  }
  if (ownDataValue(ownDataValue(profile, "calibration"), "required")) {
    append(terms, "calibration.required: no evidence event carries a calibration record yet");
  }
  if ((ownDataValue(ownDataValue(profile, "witnesses"), "requiredRoles") as readonly unknown[]).length > 0) {
    append(terms, "witnesses.requiredRoles: independent witness attestation is not evaluated here");
  }
  const capture = ownDataValue(profile, "capture");
  const coverage = ownDataValue(capture, "coverage");
  const policy = ownDataValue(coverage, "policy");
  const minFraction = ownDataValue(coverage, "minFraction");
  if (policy !== "one-shot") {
    append(terms, `capture.coverage.policy ${JSONStringify(policy)}: only "one-shot" is evaluated`);
  } else if (minFraction !== 1) {
    append(terms, `capture.coverage.minFraction ${StringCtor(minFraction)}: a one-shot capture covers its window whole, so only 1 is evaluated`);
  }
  const device = ownDataValue(profile, "device");
  const kind = ownDataValue(device, "kind");
  if (!inSet(DEVICE_TYPES, kind)) {
    append(terms, `device.kind ${JSONStringify(kind)} is not an evidence device type, so no evidence source can match it`);
  }
  for (let f = 0; f < VERSION_PIN_FIELDS.length; f++) {
    const field = VERSION_PIN_FIELDS[f]!;
    const pins = ownDataValue(device, field) as readonly unknown[];
    for (let p = 0; p < pins.length; p++) {
      const pin = ownDataValue(pins, p);
      if (typeof pin === "string" && hasWildcard(pin)) {
        append(terms, `device.${field} ${JSONStringify(pin)}: version pins are exact strings, not patterns`);
      }
    }
  }
  const ids = ownDataValue(ownDataValue(profile, "interpretation"), "evidenceTypeIds") as readonly unknown[];
  for (let i = 0; i < ids.length; i++) {
    const id = ownDataValue(ids, i);
    if (!inSet(ACTIVE_PRIMITIVES, id)) {
      append(terms, `interpretation.evidenceTypeIds ${JSONStringify(id)} is not an active vocabulary primitive`);
    }
  }
  const start = ownDataValue(capture, "startCondition");
  if (!inSet(EVENT_TYPES, start)) {
    append(terms, `capture.startCondition ${JSONStringify(start)} is not an evidence event type`);
  }
  const end = ownDataValue(capture, "endCondition");
  if (end !== OPEN_CAPTURE_WINDOW_END && !inSet(EVENT_TYPES, end)) {
    append(terms, `capture.endCondition ${JSONStringify(end)} is neither an evidence event type nor "${OPEN_CAPTURE_WINDOW_END}"`);
  }
  return terms;
}

/**
 * Where reading `value` could run code supplied with it: a proxy (its traps),
 * an accessor property (its getter), or an array whose prototype is not
 * Array.prototype (a prototype supplied with the data serves every index the
 * array lacks; astra pack 154), anywhere inside. It reads property
 * descriptors and prototypes only, so no getter runs; null when the value is
 * plain data. A descriptor's `value` counts only as its OWN property: one
 * written on Object.prototype must not pass an accessor off as data (astra
 * pack 162). `ancestors` is the path from the root: a cycle stops the walk
 * here, and plainDataCopy refuses it later.
 */
function codeInData(value: unknown, path: string, ancestors: object[]): string | null {
  if (value === null || typeof value !== "object") return null;
  if (isProxy === null) return `${path}: this runtime has no trap-free proxy check`;
  if (isProxy(value)) return `${path}: a proxy`;
  if (ArrayIsArray(value) && ObjectGetPrototypeOf(value) !== ArrayPrototype) return `${path}: an array with a nonstandard prototype`;
  for (let i = 0; i < ancestors.length; i++) if (ancestors[i] === value) return null;
  append(ancestors, value);
  try {
    const keys = ReflectOwnKeys(value);
    for (let k = 0; k < keys.length; k++) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, keys[k]!);
      if (descriptor === undefined) continue;
      const at = `${path}.${StringCtor(keys[k])}`;
      if (!hasOwn(descriptor, "value")) return `${at}: an accessor (a getter or setter)`;
      const found = codeInData(descriptor.value, at, ancestors);
      if (found !== null) return found;
    }
    return null;
  } finally {
    ancestors.length = ancestors.length - 1;
  }
}

/** Every subject field binding checks, with the form binding requires. */
function subjectProblem(subject: EvidenceSubject): string | null {
  const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!nonEmpty(subject.jobId) || !nonEmpty(subject.kernelId)) return "the subject names no job or kernel";
  if (subject.outputHash !== undefined && !nonEmpty(subject.outputHash)) return "the subject's outputHash is malformed";
  if (subject.settlementUnitId !== undefined && !isHex256Digest(subject.settlementUnitId)) return "the subject's settlementUnitId is malformed";
  if (subject.challengeNonce !== undefined && !isHex256Digest(subject.challengeNonce)) return "the subject's challengeNonce is malformed";
  return null;
}

/**
 * Why the binding leg's answer does not hold, recomputed here with the
 * captured hash and own reads; null when it does. `events` is admission's
 * plain-data copy of what binding returned: no prototype at any depth. Each
 * event must hash to its own `hash` (util/canonical.ts hashEvent's preimage),
 * the events must hash to `bundleHash` (hashBundle's: the sorted event
 * hashes), and every event must commit the subject, as LO-EV-9 requires: the
 * job and kernel on every event, the settlement unit and challenge on every
 * event when the subject names them, and the output on at least one event
 * (and on no event otherwise) when the subject names one.
 */
function bindingDisagreement(events: readonly unknown[], bundleHash: string, subject: EvidenceSubject): string | null {
  if (events.length === 0) return "no events";
  const hashes = newList<string>(events.length);
  let outputCommitted = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isRecord(e) || typeof e.type !== "string" || typeof e.timestamp !== "string" || !isRecord(e.source) || !isRecord(e.payload) || !isTaggedSha256(e.hash)) {
      return `event ${i} is not an event`;
    }
    if (taggedSha256(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload })) !== e.hash) {
      return `event ${i} does not hash to its hash`;
    }
    defineIndex(hashes, i, e.hash);
    const payload = e.payload;
    if (payload.jobId !== subject.jobId) return `event ${i} does not commit the job`;
    if (e.source.kernelId !== subject.kernelId || (payload.kernelId !== undefined && payload.kernelId !== subject.kernelId)) {
      return `event ${i} does not commit the kernel`;
    }
    if (subject.settlementUnitId !== undefined && payload.settlementUnitId !== subject.settlementUnitId) return `event ${i} does not commit the settlement unit`;
    if (subject.challengeNonce !== undefined && payload.challengeNonce !== subject.challengeNonce) return `event ${i} does not commit the challenge`;
    if (subject.outputHash !== undefined && payload.outputHash !== undefined) {
      if (payload.outputHash !== subject.outputHash) return `event ${i} commits another output`;
      outputCommitted = true;
    }
  }
  if (subject.outputHash !== undefined && !outputCommitted) return "no event commits the output";
  if (taggedSha256(canonicalize(sortedStrings(hashes))) !== bundleHash) return "the events do not hash to the bundle hash";
  return null;
}

/**
 * The observation record, if it matches the profile; otherwise why not (the
 * first profile term it fails, in a fixed order). `event` is admission's
 * copy: no prototype at any depth, so every read here is the event's own.
 */
function readObservation(
  event: EvidenceEvent,
  profile: MeasurementProfileV1,
  committedDigest: string,
): { ok: true; observation: ProfileObservation } | { ok: false; why: string } {
  const record = isRecord(event.payload) ? event.payload[PROFILE_OBSERVATION_FIELD] : undefined;
  if (!isRecord(record)) return { ok: false, why: "without a profileObservation record" };
  if (record.profileDigest !== committedDigest) return { ok: false, why: "not matching the committed profile digest" };
  if (typeof record.primitiveId !== "string" || !includesValue(profile.interpretation.evidenceTypeIds, record.primitiveId)) {
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
  if (numeric ? !isDecimalValue(record.value) : hasOwn(record, "value")) {
    return { ok: false, why: numeric ? "without a decimal-string value" : "with a value on a non-numeric (unit none) observation" };
  }
  if (!isTaggedSha256(record.sampleId)) return { ok: false, why: "without a sha256: sampleId" };
  return { ok: true, observation: record as unknown as ProfileObservation };
}

function time(event: EvidenceEvent): number {
  return DateParse(event.timestamp);
}

/** [opens, closes] from the committed window events; null bound = event absent. */
function captureWindow(
  profile: MeasurementProfileV1,
  events: readonly EvidenceEvent[],
): { opens: number | null; closes: number | null } {
  const bound = (type: string, earliest: boolean): number | null => {
    let t: number | null = null;
    for (let k = 0; k < events.length; k++) {
      const e = events[k]!;
      if (e.type !== type) continue;
      const ms = time(e);
      if (NumberIsFinite(ms) && (t === null || (earliest ? ms < t : ms > t))) t = ms;
    }
    return t;
  };
  const opens = bound(profile.capture.startCondition, true);
  const end = profile.capture.endCondition;
  const closes = end === OPEN_CAPTURE_WINDOW_END ? Infinity : bound(end, false);
  return { opens, closes };
}

function policyDecision(policy: "reject" | "hold"): ProfileAdmissionDecision {
  return policy === "hold" ? "hold" : "reject";
}

/** A trusted leg's answer, ready to await (see `fulfillsWithTrue`). A leg that throws fails. */
function legAnswer(leg: () => unknown): boolean | Promise<boolean> {
  try {
    return fulfillsWithTrue(leg());
  } catch {
    return false;
  }
}

interface Finding {
  decision: ProfileAdmissionDecision;
  reason: ProfileAdmissionReason;
}

/**
 * Admit, reject or hold the evidence for one job against its committed
 * measurement profile. Never throws.
 *
 * Every input is copied once, as frozen plain data, before the first `await`:
 * the profile (through `profileGoverns`, which returns the snapshot it
 * validated and digested), the subject, the pin and the bundles. Everything
 * after reads only the copies, so nothing the caller changes, or a getter
 * answers, after that point can reach the decision. The promise returned is an
 * `ownPromise` (util/primordials.ts): it, and every promise a caller derives
 * from it with `.then`, `.catch` or `.finally`, delivers this decision,
 * whatever code running after load replaced on Promise (see the header).
 */
export function profileAdmitsBundle(input: ProfileAdmissionInput): Promise<ProfileAdmissionResult> {
  return ownPromise(admit(input));
}

async function admit(input: unknown): Promise<ProfileAdmissionResult> {
  // No code supplied with the input runs during admission. The input object,
  // and everything in its profile, subject and bundles, must be plain data: a
  // proxy or an accessor anywhere is refused, found through property
  // descriptors alone, before anything is read. (A getter that ran during the
  // copy could change shared built-ins, such as Array.prototype.includes,
  // while admission waits; astra pack 127.) The verification callbacks are the
  // caller's trusted code. A process whose built-ins were changed before
  // @pcc/spec loaded is beyond what any in-process check can defend.
  if (typeof input !== "object" || input === null || isProxy === null || isProxy(input)) {
    return reject("input-unreadable", "the admission input must be a plain object, not a proxy");
  }
  const read = ObjectCreate(null) as Record<InputField, unknown>;
  for (let k = 0; k < INPUT_FIELDS.length; k++) {
    const key = INPUT_FIELDS[k]!;
    const descriptor = ObjectGetOwnPropertyDescriptor(input, key);
    // The descriptor's OWN value: one written on Object.prototype must not pass an accessor off as data.
    if (descriptor !== undefined && !hasOwn(descriptor, "value")) {
      return reject("input-unreadable", `input.${key} is an accessor; the admission input must be plain data`);
    }
    read[key] = descriptor === undefined ? undefined : descriptor.value;
  }
  for (let k = 0; k < DATA_FIELDS.length; k++) {
    const key = DATA_FIELDS[k]!;
    const code = codeInData(read[key], `input.${key}`, newList<object>(0));
    if (code !== null) return reject("input-unreadable", `${code}: no code supplied with the data may run during admission`);
  }

  const pinnedBundleSetDigest = read.pinnedBundleSetDigest;
  const verifyBundleSignature = read.verifyBundleSignature as ProfileAdmissionInput["verifyBundleSignature"];
  const verifyPrimitiveInstance = read.verifyPrimitiveInstance as ProfileAdmissionInput["verifyPrimitiveInstance"];
  // Each read happens once, inside one guard, so a throw resolves to a reject, never to a rejected promise.
  let subjectCopy: ReturnType<typeof plainDataCopy>;
  let bundlesCopy: ReturnType<typeof plainDataCopy>;
  try {
    subjectCopy = plainDataCopy(read.subject);
    bundlesCopy = plainDataCopy(read.bundles);
  } catch {
    return reject("input-unreadable", "reading the admission input threw, so nothing was evaluated");
  }

  const governance = profileGoverns(read.committedDigest as string, read.profile as MeasurementProfileV1);
  if (!governance.governs || governance.profile === null || governance.presentedDigest === null) {
    return reject(governance.code ?? "profile-invalid", joinStrings(governance.reasons, "; "));
  }
  const profile = governance.profile;
  const committedDigest = governance.presentedDigest;

  if (!subjectCopy.ok || !isRecord(subjectCopy.value)) {
    return reject("unbound-bundle", "the subject (the job record's job and kernel) is not plain JSON data");
  }
  const subject = deepFreeze(subjectCopy.value) as unknown as EvidenceSubject;

  const terms = unverifiableProfileTerms(profile);
  if (terms.length > 0) return reject("unverifiable-term", joinStrings(terms, "; "));

  if (!bundlesCopy.ok) return reject("unbound-bundle", "the bundles are not plain JSON data");
  const presented: unknown = deepFreeze(bundlesCopy.value);
  if (!ArrayIsArray(presented) || presented.length === 0) {
    return result(policyDecision(profile.onMissingData), only("no-bundles", "no evidence bundle was presented for the job"));
  }

  // The pin is authority: a malformed one is refused outright, never read as
  // missing data.
  if (!isTaggedSha256(pinnedBundleSetDigest)) {
    return reject(
      "bundle-set-pin-invalid",
      "the pinned bundle-set digest is not a sha256: tagged digest, so there is no valid commitment to evaluate against",
    );
  }

  // SET leg: the presented bundles are exactly the pinned set.
  const bundles = newList<AdmissionBundle>(0);
  for (let i = 0; i < presented.length; i++) {
    const b: unknown = presented[i];
    if (!isRecord(b) || !isTaggedSha256(b.bundleHash) || !ArrayIsArray(b.events)) {
      return reject("unbound-bundle", `bundle ${i}: not a bundle with a sha256: tagged bundleHash and an events array`);
    }
    append(bundles, b as unknown as AdmissionBundle);
  }
  const hashes = mapList(bundles, (b) => b.bundleHash);
  const findings = newList<Finding>(0);
  let presentedSet: string;
  try {
    presentedSet = bundleSetDigest(subject, hashes);
  } catch (err) {
    presentedSet = `(not computable: ${messageOf(err)})`;
  }
  if (presentedSet !== pinnedBundleSetDigest) {
    // Never admit, but keep evaluating: a set that is not the pinned one must
    // not hide a hard reject in what WAS presented (reject outranks hold).
    const distinct = ObjectCreate(null) as Record<string, true>;
    let presentedCount = 0;
    for (let i = 0; i < hashes.length; i++) {
      if (!hasOwn(distinct, hashes[i]!)) {
        distinct[hashes[i]!] = true;
        presentedCount++;
      }
    }
    append(findings, {
      decision: policyDecision(profile.onMissingData),
      reason: reason(
        "bundle-set-mismatch",
        `the ${presentedCount} presented bundle(s) digest to ${presentedSet}, not the pinned set ${pinnedBundleSetDigest}: a bundle is missing or was not pinned`,
      ),
    });
  }
  const rejectNow = (code: ProfileAdmissionCode, detail: string): ProfileAdmissionResult => {
    const reasons = mapList(findings, (f) => f.reason);
    append(reasons, reason(code, detail));
    return result("reject", reasons);
  };

  const events = newList<EvidenceEvent>(0);
  const seen = ObjectCreate(null) as Record<string, true>;
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    let signed: boolean;
    try {
      signed = (await legAnswer(() => verifyBundleSignature(bundle))) === true;
    } catch {
      signed = false;
    }
    if (!signed) return rejectNow("unauthenticated-bundle", `bundle ${i}: signature leg failed`);

    let answer: unknown;
    try {
      answer = await awaitedHere(verifyEvidenceSubjectBinding({ bundleHash: bundle.bundleHash, events: bundle.events, subject }));
    } catch {
      answer = undefined;
    }
    // The answer as plain data, read through its own properties: no prototype, no accessor.
    const copied = plainDataCopy(answer);
    const binding = copied.ok && isRecord(copied.value) ? copied.value : null;
    if (binding === null) return rejectNow("unbound-bundle", `bundle ${i}: the binding leg's answer is not plain data`);
    if (binding.ok !== true) {
      const why = typeof binding.reason === "string" ? binding.reason : "the binding leg failed";
      const at = typeof binding.eventIndex === "number" ? ` at event ${binding.eventIndex}` : "";
      return rejectNow("unbound-bundle", `bundle ${i}: ${why}${at}`);
    }
    // Evaluate only what was hashed: the verified canonical snapshots, re-verified here first.
    const opened = binding.events;
    const disagreement = ArrayIsArray(opened)
      ? subjectProblem(subject) ?? bindingDisagreement(opened, bundle.bundleHash, subject)
      : "the binding leg returned no events";
    if (disagreement !== null) {
      return rejectNow("unbound-bundle", `bundle ${i}: the binding leg's answer does not re-verify with intrinsics captured at load: ${disagreement}`);
    }
    const verified = opened as readonly EvidenceEvent[];
    for (let k = 0; k < verified.length; k++) {
      const e = verified[k]!;
      if (hasOwn(seen, e.hash)) continue;
      seen[e.hash] = true;
      append(events, e);
    }
  }
  deepFreeze(events);

  let fabricatedCount = 0;
  for (let k = 0; k < events.length; k++) if (isFabricated(events[k]!)) fabricatedCount++;
  if (fabricatedCount > 0) {
    return rejectNow(
      "simulated-evidence",
      `${fabricatedCount} fabricated event(s); the profile prohibits simulation, so the evidence is not authentic`,
    );
  }

  // Contradiction is evidence's one public rule, the same one the oracle signs
  // rejects on (evidence-level.ts deriveContradictions); a failure with no
  // completion is a device failure, judged here under onDeviceFailure.
  const contradictions = deriveContradictions(events);
  let executionFailed = false;
  let failedInspections = 0;
  for (let k = 0; k < events.length; k++) {
    if (events[k]!.type === "execution_failed") executionFailed = true;
    if (inspectionFailed(events[k]!)) failedInspections++;
  }
  let failure = executionFailed ? "execution_failed" : "";
  if (failedInspections > 0) failure = `${failure === "" ? "" : `${failure} and `}${failedInspections} failed inspection(s)`;
  if (contradictions.length > 0) {
    append(findings, {
      decision: policyDecision(profile.onContradiction),
      reason: reason("contradictory-evidence", `contradictions: ${joinStrings(contradictions, ", ")}`),
    });
  } else if (failure !== "") {
    append(findings, {
      decision: policyDecision(profile.interpretation.onDeviceFailure),
      reason: reason("device-failure", `the evidence reports ${failure}`),
    });
  }

  const required = profile.interpretation.acceptanceLevel;
  const reached = evidenceLevelOfBundle(events);
  const executing = executingDeviceIds(events);
  const device = profile.device;
  const window = captureWindow(profile, events);

  let atLevel = 0;
  let otherDevices = 0;
  // Exclusion reasons and counts, in the order first seen.
  const excludedWhy = newList<string>(0);
  const excludedCount = newList<number>(0);
  const exclude = (why: string) => {
    for (let x = 0; x < excludedWhy.length; x++) {
      if (excludedWhy[x] === why) {
        defineIndex(excludedCount, x, excludedCount[x]! + 1);
        return;
      }
    }
    append(excludedWhy, why);
    append(excludedCount, 1);
  };
  const samples = ObjectCreate(null) as Record<string, true>;
  let qualifying = 0;
  // What the primitive leg sees: frozen copies, so nothing it does can reach
  // the snapshots evaluated here (a leg that tries to mutate them throws, and
  // a throw is a failure). The structured clone captured at load makes them
  // ordinary objects, as the leg has always received.
  const legEvents = deepFreeze((StructuredClone as <T>(value: T) => T)(events));
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
    if (inSet(INSPECTION, e.type) && (e.payload as Record<string, unknown>).passed !== true) {
      exclude("without a positive verdict");
      continue;
    }
    if (e.source.deviceType !== device.kind || e.source.adapterType !== device.adapterType) {
      exclude("from another device kind or adapter");
      continue;
    }
    const adapterVersion = e.source.adapterVersion;
    const firmwareVersion = e.source.firmwareVersion;
    if (
      typeof adapterVersion !== "string" ||
      typeof firmwareVersion !== "string" ||
      !includesValue(device.permittedAdapterVersions, adapterVersion) ||
      !includesValue(device.permittedFirmwareVersions, firmwareVersion)
    ) {
      exclude("unpermitted version");
      continue;
    }
    const ms = time(e);
    if (window.opens === null || window.closes === null || !NumberIsFinite(ms) || ms < window.opens || ms > window.closes) {
      exclude("outside the capture window");
      continue;
    }
    const observed = readObservation(e, profile, committedDigest);
    if (!observed.ok) {
      exclude(observed.why);
      continue;
    }
    const observation = observed.observation;
    let verified: boolean;
    try {
      verified = (await legAnswer(() => verifyPrimitiveInstance(observation.primitiveId, legEvents[k]!, legEvents))) === true;
    } catch {
      verified = false;
    }
    if (!verified) {
      exclude(`not verified as ${observation.primitiveId}`);
      continue;
    }
    if (hasOwn(samples, observation.sampleId)) {
      exclude("repeating a counted sample");
      continue;
    }
    samples[observation.sampleId] = true;
    qualifying++;
  }

  if (!meetsEvidenceLevel(reached, required)) {
    append(findings, {
      decision: policyDecision(profile.onMissingData),
      reason: reason("level-not-reached", `the evidence reaches ${reached ?? "no level"}; the profile requires ${required}`),
    });
  } else if (qualifying < profile.measurement.sampling.minSamples) {
    const windowNote =
      window.opens === null
        ? `; the window never opened (no ${profile.capture.startCondition} event)`
        : window.closes === null
          ? `; the window never closed (no ${profile.capture.endCondition} event)`
          : "";
    let exclusions = "";
    for (let x = 0; x < excludedWhy.length; x++) {
      exclusions = `${exclusions}${x === 0 ? "" : ", "}${excludedCount[x]} ${excludedWhy[x]}`;
    }
    if (exclusions === "") exclusions = "none";
    append(findings, {
      decision: policyDecision(profile.onMissingData),
      reason: reason(
        "missing-measurements",
        `${qualifying} qualifying sample(s) from ${device.deviceId}, the profile requires ${profile.measurement.sampling.minSamples}` +
          ` (at ${required}: ${atLevel} from the profiled device, ${otherDevices} from other devices;` +
          ` excluded: ${exclusions}${windowNote})`,
      ),
    });
  }

  if (findings.length === 0) return result("admit", newList<ProfileAdmissionReason>(0), reached, qualifying);
  let decision: ProfileAdmissionDecision = "hold";
  for (let x = 0; x < findings.length; x++) if (findings[x]!.decision === "reject") decision = "reject";
  return result(
    decision,
    mapList(findings, (f) => f.reason),
    reached,
    qualifying,
  );
}
