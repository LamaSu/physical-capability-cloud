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
 *   - SIGNATURE, run here: every bundle's Ed25519 signature over its
 *     `bundleHash` (`signingPreimage`) verifies, through Web Crypto, under the
 *     key its declared signer names in ONE pinned registry snapshot
 *     (`registryKeys`, bound by `pinnedRegistryDigest`, see
 *     `computeRegistryDigest`). A signer id is 0x and the key's first 40 hex
 *     digits, as kernels declare it. The bundle's TRUST DOMAIN is the operator
 *     that key's row names (a session key's root's), or none. The key that
 *     verifies and its domain come from the same pinned row, and rows are
 *     unique by key and by signer id, so one key has one domain and no other
 *     registry can stand in (astra packs 271, 275). Levels judge independence
 *     between trust domains (evidence-level.ts, #345's one rule), so a key
 *     whose operator the registry does not name caps that bundle's inspections
 *     below inspected_output;
 *   - AUTHORIZATION, run here (astra pack 281, DECISIONS 00:26): a valid
 *     signature by a registered key authorizes nothing by itself. The key's
 *     row must hold a GRANT that names the subject: the executor of the
 *     subject's kernel, or a witness for that kernel or that job. The role
 *     must also fit the bundle: an executor signs any event of the subject, a
 *     witness inspections only. A session key counts only through a
 *     delegation rooted in a registered row and committed in the same pinned
 *     snapshot: it holds its root's grants for the jobs its scope names, for
 *     events timestamped inside its window, and its root's signature over the
 *     LO-EV-1 delegation must verify. Anything else is `unauthorized-signer`.
 *     A key that signs as the executor is the executor's own, never an
 *     independent inspector: its operator joins the deal's executors when
 *     levels are judged, and one whose operator the registry does not name
 *     leaves no inspection independent. So only a witness reaches
 *     inspected_output; when the profile requires it and no pinned row grants
 *     a witness for the subject, the shortfall is `no-witness-authorized`
 *     (steward #6694);
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
 *   - The registry is pinned the same way: when it pins the evidence set, the
 *     pinning party builds the rows from what the registry RECORDS and pins
 *     `computeRegistryDigest` over them. Admission is handed exactly those
 *     rows and that pin, never a later registry, so a key rotated, reassigned
 *     or re-granted after the pin cannot change a decision. The rows:
 *       - executor: the gateway registry binds ONE Ed25519 key to a kernel,
 *         `shop_kernels.signing_key_public_key` (set only once the kernel's
 *         signing proof verifies, served as `KernelDTO.signingKey`), owned by
 *         `shop_kernels.operator_address`. Its row is that key, that
 *         operator's principal, and the grant { executor, kernelId };
 *       - witness: NO registry record assigns an independent witness to a
 *         kernel or a job yet. Until one does (the deal's terms or a registry
 *         table), no witness row can be built, and no evidence reaches
 *         inspected_output;
 *       - session keys: a kernel-sdk bundle is signed by a per-job session key
 *         and carries its `sessionKeyAuthorization`. Its row is that key,
 *         `delegatedBy` its root's key, and that authorization as received.
 *         The gateway's `verifyDeviceSignedEvidence` already checks the
 *         wall-clock expiry at submission. Revocation and `maxSignatures`
 *         need state, so they are the pinning party's: a delegation it
 *         revoked or exhausted is left out of the rows. Admission checks the
 *         root's signature, the action, the job scope, and that every event
 *         the key signs falls inside the window.
 *   - Still OPEN on the caller side, and required before this gates money
 *     (astra, pack 39 round 2):
 *       - finalize collection atomically with pinning: define job closure,
 *         sequencing, and what happens to evidence that arrives late;
 *       - authenticate and classify EVERY stored row: a row that fails
 *         validation must end in an explicit terminal state (reject or
 *         quarantine), never be silently left out of the pin;
 *       - persist the exact manifest and context with the decision: bundle
 *         roots, profile commitment, subject, unit and challenge, the executor
 *         domains and the registry snapshot, and the verifier and program
 *         identity, so recovery re-evaluates the same set;
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
 *     classification), from the profiled `device.deviceId`. Levels are judged
 *     over the authenticated bundles, each with its signer's trust domain, and
 *     the deal's `executorTrustDomains`: an inspection is inspected_output only
 *     from a trust domain independent of every executor. An event present in
 *     several bundles counts at the HIGHEST level any of its occurrences gets,
 *     each levelled by its own bundle, exactly as #345 does (steward #6623,
 *     evidence #6559): with one domain per signer (the pinned snapshot), only a
 *     copy in a truly independent signer's bundle can lift it;
 *   - if it is an inspection, carries its own positive verdict: evidence's
 *     pinned verdict field (`inspectionVerdict` is pass: cv_inspection_result
 *     `passed: true`, instrument_result `pass: true`, batch_sample_result
 *     `status: "PASS"`). A negative or unreadable verdict is a failure (below),
 *     and an inspection with no verdict proves nothing about the output;
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
 *      must qualify. Shortfalls follow `onMissingData`. A shortfall from
 *      inspected_output with no witness granted for the subject is
 *      `no-witness-authorized`, otherwise `level-not-reached`.
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
  evidenceLevelOfBundles,
  evidenceLevelRank,
  evidenceLevelsOfEvents,
  meetsEvidenceLevel,
  deriveContradictions,
  inspectionFailed,
  inspectionVerdict,
  INSPECTION_EVENT_TYPES,
  type AuthenticatedBundle,
  type ContradictionKind,
  type EventLevel,
  type EvidenceLevel,
} from "./evidence-level.js";
import { parseOperatorPrincipalId } from "./principal-id.js";
import { plainDataCopy, profileGoverns, type MeasurementProfileV1 } from "./measurement-profile.js";
// The trap-free proxy check, loaded at runtime (no static node:util import, so browser bundles of @pcc/spec build).
import { isProxy } from "../util/plain-data.js";
import { getPrimitive } from "./primitives.js";
import {
  isTaggedDigest,
  parseEd25519PublicKeyHex,
  parseEd25519SignatureHex,
  sessionKeyDelegationPreimage,
  signingPreimage,
} from "./signing-preimage.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "./subject-binding.js";
import type { SessionAction, SessionKey } from "../identity/ephemeral.js";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES, type EvidenceEvent, type SessionKeyAuthorization } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";
import { canonicalize, sha256 } from "../util/canonical.js";

export const PROFILE_ADMISSION_CONTRACT = "pcc.evidence.profile-admission.v1";

/** `endCondition` token meaning "no end bound": capture may happen any time after the start. */
export const OPEN_CAPTURE_WINDOW_END = "open";

/** `measurement.unit` of a non-numeric observation, such as an image. */
export const NON_NUMERIC_UNIT = "none";

/** Domain separator: a bundle-set digest can never be taken for a bundle hash. */
export const BUNDLE_SET_DOMAIN = "PCC:evidence-bundle-set:v1";

/** Domain separator for a pinned registry snapshot's digest. */
export const REGISTRY_SNAPSHOT_DOMAIN = "PCC:evidence-registry-snapshot:v2";

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
  | "input-unreadable"
  | "digest-wrong-family"
  | "profile-invalid"
  | "digest-mismatch"
  | "unverifiable-term"
  | "no-bundles"
  | "bundle-set-pin-invalid"
  | "bundle-set-mismatch"
  | "registry-pin-invalid"
  | "registry-mismatch"
  | "unauthenticated-bundle"
  | "unauthorized-signer"
  | "unbound-bundle"
  | "simulated-evidence"
  | "device-failure"
  | "contradictory-evidence"
  | "level-not-reached"
  | "no-witness-authorized"
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

/** What a grant lets a key sign as (DECISIONS 00:26, astra pack 281). */
export type SignerRole = "executor" | "witness";

/**
 * One grant: the key may sign as `role` for kernel `kernelId` and, when `jobId`
 * is named, for that one job of it only.
 *   - `executor`: the kernel's own key, which signs the work the kernel does
 *     (any event of the subject).
 *   - `witness`: an independent inspector for that kernel or that job, which
 *     signs inspections only (`INSPECTION_EVENT_TYPES`).
 * Ids are non-empty strings, as subject binding requires of a subject.
 */
export interface SignerGrant {
  readonly role: SignerRole;
  readonly kernelId: string;
  readonly jobId?: string;
}

/**
 * A registered key: its raw 32-byte Ed25519 key as 0x and 64 LOWERCASE hex
 * digits (one spelling per key), the operator principal that owns it (or null
 * when the registry names none), and the subjects and role it may sign for.
 * Registry membership alone authorizes nothing: a bundle counts only for a
 * subject that one of its key's grants names.
 */
export interface RegisteredKeyRow {
  readonly publicKey: string;
  readonly trustDomain: string | null;
  readonly grants: readonly SignerGrant[];
}

/**
 * A session key, authorized only through its root's delegation:
 *   - `delegatedBy` is the publicKey of a registered row in the same snapshot;
 *   - `authorization` is that root's delegation of this key, exactly as the
 *     producer sent it (the LO-EV-1 wire form, a kernel-sdk bundle's
 *     `sessionKeyAuthorization`), so the pin commits it.
 * It carries its root's operator and grants, narrowed to the jobs its scope
 * names and to its validity window.
 */
export interface DelegatedKeyRow {
  readonly publicKey: string;
  readonly delegatedBy: string;
  readonly authorization: SessionKeyAuthorization;
}

/** One row of the pinned registry snapshot. */
export type RegistryKey = RegisteredKeyRow | DelegatedKeyRow;

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
  /**
   * The operator principals the job was ASSIGNED to (eip155:<chainId>:0x<40
   * lowercase hex>), from the accepted deal, as `subject` comes from the job
   * record: never from the evidence. Empty when the deal names none, and then no
   * inspection can show independence (at most device_reported). Otherwise the
   * operator of every key that signs as the subject's executor joins them when
   * levels are judged (see AUTHORIZATION in the header).
   */
  executorTrustDomains: readonly string[];
  /**
   * ONE pinned registry snapshot, as data, from the registry at the pin, never
   * from the evidence (astra packs 271, 275, 281):
   *   - a registered row names an Ed25519 key, the operator that owns it (or
   *     null) and its GRANTS: the role it may sign as, for kernel K and, when
   *     named, one job of it;
   *   - a session key's row names its root (a registered row of this snapshot)
   *     and holds the root's delegation of it, so the pin commits the chain.
   * Admission verifies every bundle's signature HERE, under the key its
   * declared signer names, then requires one of that key's grants to name the
   * subject in a role that fits the bundle. The bundle's trust domain is the
   * key's operator, or its root's. Registry membership alone authorizes
   * nothing. Refused: a key listed twice, two keys whose signer ids collide, a
   * malformed row or grant, and a delegation that does not verify under its
   * root.
   */
  registryKeys: readonly RegistryKey[];
  /** `computeRegistryDigest(registryKeys)`, from where the registry was pinned (see the caller contract). A malformed pin rejects; rows that do not digest to it are refused. */
  pinnedRegistryDigest: string;
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

/** A registry key as the snapshot spells it: 0x and 64 lowercase hex digits, the raw 32-byte Ed25519 key. */
const REGISTRY_KEY = /^0x[0-9a-f]{64}$/;

/** The session action a delegation must allow for its key to sign evidence (identity/ephemeral.ts). */
const EVIDENCE_SUBMIT: SessionAction = "evidence_submit";

/** A checked row (see `RegistryKey`). */
interface RegistryRow {
  /** The key, and the signer id kernels declare for it: 0x and the key's first 40 hex digits. */
  publicKey: string;
  signer: string;
  /** The operator and the grants: a session key's are its root's. */
  trustDomain: string | null;
  grants: readonly SignerGrant[];
  /**
   * A session key's delegation: its root's key, the authorization as given,
   * the job ids its scope names, and its validity window in Unix seconds.
   * Null for a registered key.
   */
  delegation: { root: string; authorization: unknown; contractIds: readonly string[]; issuedAt: number; expiresAt: number } | null;
}

const ROW_FIELDS: readonly string[] = ["publicKey", "trustDomain", "grants"];
const DELEGATED_ROW_FIELDS: readonly string[] = ["publicKey", "delegatedBy", "authorization"];
const GRANT_FIELDS: readonly string[] = ["role", "kernelId", "jobId"];
const AUTHORIZATION_FIELDS: readonly string[] = [
  "sessionId",
  "parentAgentId",
  "publicKey",
  "issuedAt",
  "expiresAt",
  "scope",
  "parentSignature",
  "derivationPath",
];
const SCOPE_FIELDS: readonly string[] = ["allowedActions", "contractIds", "maxSignatures"];

/** Whether every own key of `value` is one of `allowed`. */
function onlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

/** A job or kernel id as subject binding requires one: a non-empty string. */
function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A grant's identity, for order and duplicates: its fields in a fixed order. */
const grantKey = (g: SignerGrant): string => JSON.stringify([g.role, g.kernelId, g.jobId ?? null]);

/**
 * A registered row's grants, checked and sorted, or null. They must be a
 * non-empty list; each grant is a role, a kernel and at most one job, and no
 * grant appears twice.
 */
function readGrants(value: unknown): SignerGrant[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const grants: SignerGrant[] = [];
  const seen = new Set<string>();
  for (const g of value) {
    if (!isRecord(g) || !onlyFields(g, GRANT_FIELDS)) return null;
    const { role, kernelId, jobId } = g;
    if ((role !== "executor" && role !== "witness") || !isName(kernelId) || !(jobId === undefined || isName(jobId))) return null;
    const grant: SignerGrant = jobId === undefined ? { role, kernelId } : { role, kernelId, jobId };
    if (seen.has(grantKey(grant))) return null;
    seen.add(grantKey(grant));
    grants.push(grant);
  }
  return grants.sort((a, b) => (grantKey(a) < grantKey(b) ? -1 : grantKey(a) > grantKey(b) ? 1 : 0));
}

/**
 * A session key's delegation, checked, or why it is not one. It must be:
 *   - the LO-EV-1 delegation of THIS row's key (`sessionKeyDelegationPreimage`
 *     refuses anything outside its input domain);
 *   - signed by the root's key;
 *   - allowing evidence_submit, for at least one named job (an empty scope
 *     means any job, which no subject-scoped grant allows);
 *   - with issuedAt <= expiresAt.
 */
async function readDelegation(
  authorization: unknown,
  publicKey: string,
  rootKey: string,
): Promise<{ ok: true; contractIds: readonly string[]; issuedAt: number; expiresAt: number } | { ok: false; reason: string }> {
  const a = authorization;
  if (!isRecord(a) || !onlyFields(a, AUTHORIZATION_FIELDS) || !isRecord(a.scope) || !onlyFields(a.scope, SCOPE_FIELDS)) {
    return { ok: false, reason: "is not a session key authorization (the LO-EV-1 wire form)" };
  }
  const scope = a.scope;
  let preimage: Uint8Array;
  let parentSignature: Uint8Array;
  try {
    const sessionKey = parseEd25519PublicKeyHex(a.publicKey);
    const spelled = (a.publicKey as string).toLowerCase();
    if ((spelled.startsWith("0x") ? spelled : `0x${spelled}`) !== publicKey) return { ok: false, reason: "delegates another key than its row's" };
    parentSignature = parseEd25519SignatureHex(a.parentSignature);
    preimage = sessionKeyDelegationPreimage({
      sessionId: a.sessionId as string,
      parentAgentId: a.parentAgentId as SessionKey["parentAgentId"],
      publicKey: sessionKey,
      issuedAt: a.issuedAt as number,
      expiresAt: a.expiresAt as number,
      scope: {
        allowedActions: scope.allowedActions as SessionAction[],
        contractIds: scope.contractIds as string[],
        maxSignatures: scope.maxSignatures as number,
      },
      ...(a.derivationPath !== undefined ? { derivationPath: a.derivationPath as string } : {}),
    });
  } catch {
    return { ok: false, reason: "is not a well-formed session key authorization (LO-EV-1)" };
  }
  const allowedActions = scope.allowedActions as string[];
  const contractIds = scope.contractIds as string[];
  if (!allowedActions.includes(EVIDENCE_SUBMIT)) return { ok: false, reason: "does not allow evidence_submit" };
  if (contractIds.length === 0) return { ok: false, reason: "names no job: an empty scope means any job, which no subject-scoped grant allows" };
  if ((a.issuedAt as number) > (a.expiresAt as number)) return { ok: false, reason: "expires before it is issued" };
  if (!(await ed25519Verifies(rootKey, preimage, parentSignature))) return { ok: false, reason: `is not signed by its root key ${rootKey}` };
  return { ok: true, contractIds: Object.freeze([...contractIds]), issuedAt: a.issuedAt as number, expiresAt: a.expiresAt as number };
}

/**
 * The rows of a registry snapshot, checked and sorted by key, or why they are
 * not one (astra packs 271, 275, 281).
 *   - Each key has one spelling and one row, and no two keys share a signer id
 *     (0x + the first 40 hex digits), so a bundle's declared signer names at
 *     most one key.
 *   - A registered row names its operator and its grants.
 *   - A session key's row names its root, a registered row of this snapshot,
 *     and holds the root's delegation of it, which must verify under the
 *     root's key. The chain is one link: a session key never roots another.
 */
async function readRegistry(value: unknown): Promise<{ ok: true; rows: RegistryRow[] } | { ok: false; reason: string }> {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: "registryKeys (the pinned registry snapshot) must be a list of { publicKey, trustDomain, grants } and { publicKey, delegatedBy, authorization } rows",
    };
  }
  const rows: RegistryRow[] = [];
  const byKey = new Map<string, RegistryRow>();
  const signers = new Set<string>();
  for (let k = 0; k < value.length; k++) {
    const row: unknown = value[k];
    const publicKey = isRecord(row) ? row.publicKey : undefined;
    if (!isRecord(row) || typeof publicKey !== "string" || !REGISTRY_KEY.test(publicKey)) {
      return { ok: false, reason: `registryKeys[${k}] must be a row whose publicKey is 0x<64 lowercase hex>` };
    }
    let checked: RegistryRow;
    if (Object.prototype.hasOwnProperty.call(row, "delegatedBy")) {
      const root = row.delegatedBy;
      if (!onlyFields(row, DELEGATED_ROW_FIELDS) || typeof root !== "string" || !REGISTRY_KEY.test(root) || !isRecord(row.authorization)) {
        return { ok: false, reason: `registryKeys[${k}] must be { publicKey, delegatedBy: a registered key, authorization: its delegation }` };
      }
      const delegation = { root, authorization: row.authorization, contractIds: [], issuedAt: 0, expiresAt: 0 };
      checked = { publicKey, signer: publicKey.slice(0, 42), trustDomain: null, grants: [], delegation };
    } else {
      const trustDomain = row.trustDomain;
      const grants = readGrants(row.grants);
      if (
        !onlyFields(row, ROW_FIELDS) ||
        !(trustDomain === null || (typeof trustDomain === "string" && parseOperatorPrincipalId(trustDomain) !== null)) ||
        grants === null
      ) {
        return {
          ok: false,
          reason: `registryKeys[${k}] must be { publicKey, trustDomain: an operator principal id or null, grants: a non-empty list of { role: executor | witness, kernelId, jobId? }, none twice }`,
        };
      }
      checked = { publicKey, signer: publicKey.slice(0, 42), trustDomain, grants, delegation: null };
    }
    if (byKey.has(publicKey)) return { ok: false, reason: `registryKeys lists key ${publicKey} twice: a key has one row` };
    if (signers.has(checked.signer)) {
      return { ok: false, reason: `registryKeys lists two keys whose signer id is ${checked.signer}: a declared signer would not name one key` };
    }
    byKey.set(publicKey, checked);
    signers.add(checked.signer);
    rows.push(checked);
  }
  // A session key counts only through a delegation rooted in a registered row of this snapshot.
  for (const row of rows) {
    if (row.delegation === null) continue;
    const root = byKey.get(row.delegation.root);
    if (root === undefined || root.delegation !== null) {
      return { ok: false, reason: `session key ${row.publicKey} names ${row.delegation.root} as its root, which is not a registered row of this snapshot` };
    }
    const delegation = await readDelegation(row.delegation.authorization, row.publicKey, root.publicKey);
    if (!delegation.ok) return { ok: false, reason: `the delegation of session key ${row.publicKey} ${delegation.reason}` };
    row.trustDomain = root.trustDomain;
    row.grants = root.grants;
    row.delegation = { ...row.delegation, contractIds: delegation.contractIds, issuedAt: delegation.issuedAt, expiresAt: delegation.expiresAt };
  }
  rows.sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0));
  return { ok: true, rows };
}

function registryDigestOf(rows: readonly RegistryRow[]): Promise<SHA256> {
  return sha256(
    canonicalize({
      domain: REGISTRY_SNAPSHOT_DOMAIN,
      keys: rows.map((r) =>
        r.delegation === null
          ? { publicKey: r.publicKey, trustDomain: r.trustDomain, grants: r.grants }
          : { publicKey: r.publicKey, delegatedBy: r.delegation.root, authorization: r.delegation.authorization },
      ),
    }),
  );
}

/**
 * The digest a pinned registry snapshot is committed to:
 *   sha256(canonicalize({ domain, keys }))
 * `sha256:`-tagged, over the rows sorted by key, each registered row's grants
 * sorted, and each delegation as given. The pinning party computes it over the
 * rows it builds when it pins the evidence set (see the caller contract).
 * Rejects on rows admission would refuse, a delegation that does not verify
 * included: there is nothing meaningful to pin.
 */
export async function computeRegistryDigest(registryKeys: readonly RegistryKey[]): Promise<SHA256> {
  const copy = plainDataCopy(registryKeys);
  if (!copy.ok) throw new Error(`computeRegistryDigest: the registry is not plain JSON data (${copy.reason})`);
  const registry = await readRegistry(copy.value);
  if (!registry.ok) throw new Error(`computeRegistryDigest: ${registry.reason}`);
  return registryDigestOf(registry.rows);
}

/** Whether `grant` names `subject`: its kernel is the subject's, and its job, if it names one, is the subject's. */
function grantNames(grant: SignerGrant, subject: EvidenceSubject): boolean {
  return grant.kernelId === subject.kernelId && (grant.jobId === undefined || grant.jobId === subject.jobId);
}

/** Whether `row`'s key is the executor for `subject`: one of its grants names it in the executor role. */
function isExecutorFor(row: RegistryRow, subject: EvidenceSubject): boolean {
  return row.grants.some((g) => g.role === "executor" && grantNames(g, subject));
}

/**
 * Whether any pinned row lets a key witness `subject`: a witness grant that
 * names it. A session key holds only its root's grants, so it adds no witness
 * its root, a registered row here, does not already grant.
 */
function witnessAuthorized(rows: readonly RegistryRow[], subject: EvidenceSubject): boolean {
  return rows.some((row) => row.grants.some((g) => g.role === "witness" && grantNames(g, subject)));
}

/**
 * Why `row`'s key may not sign `events` for `subject`, or null when it may
 * (astra pack 281, DECISIONS 00:26).
 *   - A grant names the subject when its kernel is the subject's and its job,
 *     if it names one, is the subject's.
 *   - An executor grant lets the key sign any event of the subject. A witness
 *     grant lets it sign inspections only.
 *   - A session key holds its root's grants only for the jobs its delegation's
 *     scope names, and only for events whose own timestamps fall inside the
 *     delegation's window, in whole seconds, as the session verifier counts
 *     them.
 * Subject binding has already shown that every event names the subject's job
 * and kernel, so a grant matched against the subject covers every event.
 */
function authorizationDenied(row: RegistryRow, subject: EvidenceSubject, events: readonly EvidenceEvent[]): string | null {
  if (row.delegation !== null) {
    if (!row.delegation.contractIds.includes(subject.jobId)) {
      return `session key ${row.signer} is delegated for job(s) ${row.delegation.contractIds.join(", ")}, not job ${subject.jobId}`;
    }
    for (const e of events) {
      const second = Math.floor(Date.parse(e.timestamp) / 1000);
      if (!(second >= row.delegation.issuedAt && second <= row.delegation.expiresAt)) {
        return `session key ${row.signer} signed an event timestamped ${e.timestamp}, outside its delegation's window`;
      }
    }
  }
  if (isExecutorFor(row, subject)) return null;
  if (!row.grants.some((g) => g.role === "witness" && grantNames(g, subject))) {
    return `key ${row.signer} holds no grant for kernel ${subject.kernelId}, job ${subject.jobId}: registry membership alone authorizes nothing`;
  }
  const other = events.find((e) => !INSPECTION.has(e.type));
  return other === undefined ? null : `key ${row.signer} is a witness for this subject, which signs inspections only, not ${other.type}`;
}

/** Whether `signature` is the Ed25519 signature of `message` under the raw `publicKey` (0x + 64 hex), through Web Crypto. */
async function ed25519Verifies(publicKey: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    // Fresh copies: Web Crypto takes ArrayBuffer-backed bytes.
    const key = await crypto.subtle.importKey("raw", new Uint8Array(parseEd25519PublicKeyHex(publicKey)), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new Uint8Array(message));
  } catch {
    return false;
  }
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

/** Membership by own index reads, never through Array.prototype methods. */
function ownIncludes(list: readonly unknown[], x: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === x) return true;
  return false;
}

/**
 * Where reading `value` could run code supplied with it: a proxy (its traps),
 * an accessor property (its getter), or an array whose prototype is not
 * Array.prototype (a prototype supplied with the data serves every index the
 * array lacks; astra pack 154), anywhere inside. It reads property
 * descriptors and prototypes only, so no getter runs; null when the value is
 * plain data. A cycle stops the walk here, and plainDataCopy refuses it later.
 */
function codeInData(value: unknown, path: string, seen: Set<object>): string | null {
  if (value === null || typeof value !== "object") return null;
  if (isProxy === null) return `${path}: this runtime has no trap-free proxy check`;
  if (isProxy(value)) return `${path}: a proxy`;
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) return `${path}: an array with a nonstandard prototype`;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) return `${path}.${String(key)}: an accessor (a getter or setter)`;
    const found = codeInData(descriptor.value, `${path}.${String(key)}`, seen);
    if (found !== null) return found;
  }
  return null;
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
  if (typeof record.primitiveId !== "string" || !ownIncludes(profile.interpretation.evidenceTypeIds, record.primitiveId)) {
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

/** The higher of two levels; null (no level) is the lowest. */
function higherLevel(a: EvidenceLevel | null, b: EvidenceLevel | null): EvidenceLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return evidenceLevelRank(a) >= evidenceLevelRank(b) ? a : b;
}

/**
 * Admit, reject or hold the evidence for one job against its committed
 * measurement profile. Never throws.
 *
 * Every input is copied once, as frozen plain data, before the first `await`:
 * the profile (through `profileGoverns`, which returns the snapshot it
 * validated and digested), the subject, the pin and the bundles. Everything
 * after reads only the copies, so nothing the caller changes, or a getter
 * answers, after that point can reach the decision.
 */
export async function profileAdmitsBundle(input: ProfileAdmissionInput): Promise<ProfileAdmissionResult> {
  // No code supplied with the input runs during admission. The input object,
  // and everything in its profile, subject and bundles, must be plain data: a
  // proxy or an accessor anywhere is refused, found through property
  // descriptors alone, before anything is read. (A getter that ran during the
  // copy could change shared built-ins, such as Array.prototype.includes,
  // while admission waits; astra pack 127.) The verification callbacks are the
  // caller's trusted code. A process whose built-ins were changed before the
  // call is beyond what any in-process check can defend.
  if (typeof input !== "object" || input === null || isProxy === null || isProxy(input)) {
    return reject("input-unreadable", "the admission input must be a plain object, not a proxy");
  }
  const fields = ["pinnedBundleSetDigest", "verifyPrimitiveInstance", "subject", "bundles", "committedDigest", "profile", "executorTrustDomains", "registryKeys", "pinnedRegistryDigest"] as const;
  const read = Object.create(null) as Record<(typeof fields)[number], unknown>;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !("value" in descriptor)) {
      return reject("input-unreadable", `input.${key} is an accessor; the admission input must be plain data`);
    }
    read[key] = descriptor?.value;
  }
  for (const key of ["profile", "subject", "bundles", "executorTrustDomains", "registryKeys"] as const) {
    const code = codeInData(read[key], `input.${key}`, new Set());
    if (code !== null) return reject("input-unreadable", `${code}: no code supplied with the data may run during admission`);
  }

  // Every read happens once, inside one guard, so a throw resolves to a reject, never to a rejected promise.
  let entry: {
    pinnedBundleSetDigest: unknown;
    pinnedRegistryDigest: unknown;
    verifyPrimitiveInstance: ProfileAdmissionInput["verifyPrimitiveInstance"];
    subjectCopy: ReturnType<typeof plainDataCopy>;
    bundlesCopy: ReturnType<typeof plainDataCopy>;
    executorsCopy: ReturnType<typeof plainDataCopy>;
    registryCopy: ReturnType<typeof plainDataCopy>;
    committedDigest: string;
    presentedProfile: MeasurementProfileV1;
  };
  try {
    entry = {
      pinnedBundleSetDigest: read.pinnedBundleSetDigest,
      pinnedRegistryDigest: read.pinnedRegistryDigest,
      verifyPrimitiveInstance: read.verifyPrimitiveInstance as ProfileAdmissionInput["verifyPrimitiveInstance"],
      subjectCopy: plainDataCopy(read.subject),
      bundlesCopy: plainDataCopy(read.bundles),
      executorsCopy: plainDataCopy(read.executorTrustDomains),
      registryCopy: plainDataCopy(read.registryKeys),
      committedDigest: read.committedDigest as string,
      presentedProfile: read.profile as MeasurementProfileV1,
    };
  } catch {
    return reject("input-unreadable", "reading the admission input threw, so nothing was evaluated");
  }
  const { pinnedBundleSetDigest, pinnedRegistryDigest, verifyPrimitiveInstance, subjectCopy, bundlesCopy, executorsCopy, registryCopy } = entry;

  const governance = profileGoverns(entry.committedDigest, entry.presentedProfile);
  if (!governance.governs || governance.profile === null || governance.presentedDigest === null) {
    return reject(governance.code ?? "profile-invalid", governance.reasons.join("; "));
  }
  const profile = governance.profile;
  const committedDigest = governance.presentedDigest;

  if (!subjectCopy.ok || !isRecord(subjectCopy.value)) {
    return reject("unbound-bundle", "the subject (the job record's job and kernel) is not plain JSON data");
  }
  const subject = deepFreeze(subjectCopy.value) as unknown as EvidenceSubject;

  // The deal's executors: a list of operator principal ids, possibly empty, never absent.
  const executors: unknown = executorsCopy.ok ? executorsCopy.value : undefined;
  if (!Array.isArray(executors) || !executors.every((d) => typeof d === "string" && parseOperatorPrincipalId(d) !== null)) {
    return reject(
      "input-unreadable",
      "executorTrustDomains (the deal's assigned operators) must be a list of operator principal ids, eip155:<chainId>:0x<40 lowercase hex>",
    );
  }
  const executorTrustDomains = deepFreeze([...executors]) as readonly string[];

  // The pinned registry snapshot (astra packs 271, 275): each key's one trust domain, unique by key and by signer id.
  const registry = await readRegistry(registryCopy.ok ? registryCopy.value : undefined);
  if (!registry.ok) return reject("input-unreadable", registry.reason);
  const rowOfSigner = new Map<string, RegistryRow>();
  for (const row of registry.rows) rowOfSigner.set(row.signer, row);

  const terms = unverifiableProfileTerms(profile);
  if (terms.length > 0) return reject("unverifiable-term", terms.join("; "));

  if (!bundlesCopy.ok) return reject("unbound-bundle", "the bundles are not plain JSON data");
  const presented: unknown = deepFreeze(bundlesCopy.value);
  if (!Array.isArray(presented) || presented.length === 0) {
    return result(policyDecision(profile.onMissingData), [
      { code: "no-bundles", detail: "no evidence bundle was presented for the job" },
    ]);
  }

  // The registry's pin binds the keys and their domains to the registry as it was pinned: a malformed pin, or rows
  // that are not the pinned ones (a key rotated or reassigned since), are refused before any signature is checked.
  if (!isTaggedDigest(pinnedRegistryDigest)) {
    return reject("registry-pin-invalid", "the pinned registry digest is not a sha256: tagged digest, so no registry is committed to");
  }
  const presentedRegistry = await registryDigestOf(registry.rows);
  if (presentedRegistry !== pinnedRegistryDigest) {
    return reject(
      "registry-mismatch",
      `the registry rows digest to ${presentedRegistry}, not the pinned ${pinnedRegistryDigest}: they are not the registry the evidence was pinned with`,
    );
  }

  // The pin is authority: a malformed one is refused outright, never read as
  // missing data.
  if (!isTaggedDigest(pinnedBundleSetDigest)) {
    return reject(
      "bundle-set-pin-invalid",
      "the pinned bundle-set digest is not a sha256: tagged digest, so there is no valid commitment to evaluate against",
    );
  }

  // SET leg: the presented bundles are exactly the pinned set.
  const bundles: AdmissionBundle[] = [];
  for (let i = 0; i < presented.length; i++) {
    const b: unknown = presented[i];
    if (!isRecord(b) || !isTaggedDigest(b.bundleHash) || !Array.isArray(b.events)) {
      return reject("unbound-bundle", `bundle ${i}: not a bundle with a sha256: tagged bundleHash and an events array`);
    }
    bundles.push(b as unknown as AdmissionBundle);
  }
  const hashes = bundles.map((b) => b.bundleHash);
  const findings: { decision: ProfileAdmissionDecision; reason: ProfileAdmissionReason }[] = [];
  let presentedSet: string;
  try {
    presentedSet = await computeBundleSetDigest(subject, hashes);
  } catch (err) {
    presentedSet = `(not computable: ${err instanceof Error ? err.message : String(err)})`;
  }
  if (presentedSet !== pinnedBundleSetDigest) {
    // Never admit, but keep evaluating: a set that is not the pinned one must
    // not hide a hard reject in what WAS presented (reject outranks hold).
    findings.push({
      decision: policyDecision(profile.onMissingData),
      reason: {
        code: "bundle-set-mismatch",
        detail: `the ${new Set(hashes).size} presented bundle(s) digest to ${presentedSet}, not the pinned set ${pinnedBundleSetDigest}: a bundle is missing or was not pinned`,
      },
    });
  }
  const rejectNow = (code: ProfileAdmissionCode, detail: string): ProfileAdmissionResult =>
    result("reject", [...findings.map((f) => f.reason), { code, detail }]);

  const events: EvidenceEvent[] = [];
  const seen = new Set<string>();
  // Each bundle as evidence-level reads it: its bound events and its signer's trust domain.
  const authenticated: AuthenticatedBundle[] = [];
  // The operators of the keys that signed as the subject's executor, and whether one of them names none.
  const executorDomains = new Set<string>();
  let executorDomainUnknown = false;
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    // SIGNATURE, run here (astra packs 271, 275): the declared signer names one key of the pinned registry, the
    // bundle hash's Ed25519 signature must verify under THAT key, and the bundle's trust domain is that key's row.
    const signature: unknown = bundle.kernelSignature;
    const declared: unknown = isRecord(signature) ? signature.signer : undefined;
    const row = typeof declared === "string" ? rowOfSigner.get(declared) : undefined;
    if (!isRecord(signature) || signature.algorithm !== "ed25519" || row === undefined) {
      return rejectNow("unauthenticated-bundle", `bundle ${i}: its signature is not an ed25519 signature by a key of the pinned registry (registryKeys)`);
    }
    let signed = false;
    try {
      signed = await ed25519Verifies(row.publicKey, signingPreimage(bundle.bundleHash), parseEd25519SignatureHex(signature.value));
    } catch {
      signed = false;
    }
    if (!signed) {
      return rejectNow("unauthenticated-bundle", `bundle ${i}: its signature does not verify under the registered key of ${row.signer}`);
    }
    const trustDomain = row.trustDomain;
    const binding = await verifyEvidenceSubjectBinding({
      bundleHash: bundle.bundleHash,
      events: bundle.events,
      subject,
    });
    if (!binding.ok) {
      const at = binding.eventIndex === undefined ? "" : ` at event ${binding.eventIndex}`;
      return rejectNow("unbound-bundle", `bundle ${i}: ${binding.reason}${at}`);
    }
    // AUTHORIZATION (astra pack 281, DECISIONS 00:26): a valid signature by a registered key authorizes nothing by
    // itself. The key must hold a grant naming this subject, in a role that fits what the bundle holds.
    const denied = authorizationDenied(row, subject, binding.events);
    if (denied !== null) return rejectNow("unauthorized-signer", `bundle ${i}: ${denied}`);
    if (isExecutorFor(row, subject)) {
      if (trustDomain === null) executorDomainUnknown = true;
      else executorDomains.add(trustDomain);
    }
    authenticated.push(trustDomain === null ? { events: binding.events } : { events: binding.events, trustDomain });
    // Evaluate only what was hashed: the verified canonical snapshots.
    for (const e of binding.events) {
      if (seen.has(e.hash)) continue;
      seen.add(e.hash);
      events.push(e);
    }
  }

  const fabricated = events.filter(isFabricated).length;
  if (fabricated > 0) {
    return rejectNow(
      "simulated-evidence",
      `${fabricated} fabricated event(s); the profile prohibits simulation, so the evidence is not authentic`,
    );
  }

  // Contradiction is evidence's one public rule, the same one the oracle signs
  // rejects on (evidence-level.ts deriveContradictions); a failure with no
  // completion is a device failure, judged here under onDeviceFailure.
  let contradictions: ContradictionKind[];
  let eventLevels: readonly EventLevel[];
  let reached: EvidenceLevel | null;
  // A key that signed as the executor is the executor's own, never an independent inspector (steward #6694): its
  // operator joins the deal's executors when levels are judged, so only a witness can reach inspected_output. An
  // executor key whose operator the registry does not name leaves no inspection independent. When the deal names no
  // executor, none is added: #345 then shows no independence, as before.
  const levelExecutors =
    executorTrustDomains.length === 0 || executorDomainUnknown ? [] : [...new Set([...executorTrustDomains, ...executorDomains])];
  try {
    contradictions = deriveContradictions(authenticated);
    eventLevels = evidenceLevelsOfEvents(authenticated, { executorTrustDomains: levelExecutors });
    // The strongest level the bundles prove: #345's own function, the maximum over every occurrence.
    reached = evidenceLevelOfBundles(authenticated, { executorTrustDomains: levelExecutors });
  } catch (err) {
    return rejectNow("input-unreadable", `the evidence levels could not classify the bundles: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // The level an event counts at: the MAX over its occurrences, each levelled by its own bundle, as #345 takes
  // it (steward #6623, evidence #6559). A test holds this and `reached` equal to evidence-level.ts on duplicates.
  const levelByHash = new Map<string, EvidenceLevel | null>();
  for (const { bundleIndex, eventIndex, level } of eventLevels) {
    const hash = authenticated[bundleIndex]!.events[eventIndex]!.hash;
    levelByHash.set(hash, levelByHash.has(hash) ? higherLevel(levelByHash.get(hash)!, level) : level);
  }
  const levelOf = (e: EvidenceEvent): EvidenceLevel | null => levelByHash.get(e.hash) ?? null;
  const { device } = profile;
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
    if (!meetsEvidenceLevel(levelOf(e), required)) continue;
    if (e.source.deviceId !== device.deviceId) {
      otherDevices++;
      continue;
    }
    atLevel++;
    if (inspectionFailed(e)) {
      exclude("failed inspection(s)");
      continue;
    }
    if (INSPECTION.has(e.type) && inspectionVerdict(e) !== "pass") {
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
      !ownIncludes(device.permittedAdapterVersions, adapterVersion) ||
      !ownIncludes(device.permittedFirmwareVersions, firmwareVersion)
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

  if (!meetsEvidenceLevel(reached, required) && required === "inspected_output" && !witnessAuthorized(registry.rows, subject)) {
    // Only a witness's inspection reaches inspected_output, and the pinned rows grant no witness for this subject.
    // No registry record assigns witnesses yet (N132), so say so rather than report a generic shortfall.
    findings.push({
      decision: policyDecision(profile.onMissingData),
      reason: {
        code: "no-witness-authorized",
        detail:
          `the profile requires inspected_output, which only an independent witness's inspection reaches, and no pinned row grants a witness ` +
          `for kernel ${subject.kernelId}, job ${subject.jobId} (no registry record assigns witnesses yet); the evidence reaches ${reached ?? "no level"}`,
      },
    });
  } else if (!meetsEvidenceLevel(reached, required)) {
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
