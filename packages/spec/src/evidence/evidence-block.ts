/**
 * EvidenceBlockV1 v2 — the evidence commitment a FinalMilestonePackageV2
 * carries as `evidence.evidenceBlockHash`. Ported from the evidence lane's
 * golden mirror (`packages/verifier/test-vectors/evidence-block-v2-mirror.cjs`
 * on #270) so a producer exists in public PCC; the mirror's pinned goldens are
 * reproduced byte-exact in the tests.
 *
 *   evidenceBlockHash = keccak256(abi.encode(
 *     bytes32 keccak256("PCC:vnext:evidence-block:v2"), uint16 2,
 *     bytes32 unitContextDigest, bytes32 kernelSignedEventsRoot,
 *     bytes32 sessionKeyAuthDigest, bytes32 attestationSetRoot,
 *     bytes32 workProductRoot, bytes32 programHash))
 *
 * The six roots:
 *   unitContextDigest       keccak256(abi.encode(keccak256("PCC:vnext:unit-context:v1"),
 *                           uint256 chainId, address escrow, bytes32 settlementUnitId,
 *                           bytes32 jobIdHash, uint256 milestoneIndex, bytes32 stepId,
 *                           bytes32 challengeNonce)): binds the block to one settlement
 *                           unit and one challenge, so evidence for unit A cannot be
 *                           replayed onto unit B
 *   kernelSignedEventsRoot  the bundle's `hashBundle` digest, as 0x + hex, derived by
 *                           `computeKernelSignedEventsRoot(bundle)`, which recomputes every
 *                           event hash and the bundleHash instead of trusting the carried
 *                           ones. ONE bundle: a settlement unit's evidence is one
 *                           kernel-signed bundle holding every outcome-bearing event
 *                           (terminal events and inspections), so nothing can be left out
 *                           by choosing which bundle to commit (LO-EV-9 header; bus #3543)
 *   sessionKeyAuthDigest    0x + sha256(canonicalize(SessionKeyAuthorization))
 *   attestationSetRoot      0x + sha256(canonicalize(sorted role digests)); each role
 *                           digest binds roleId, the quorum config, the job and the
 *                           role's sorted attestation hashes, so attestations cannot be
 *                           relabelled to another role or a weaker quorum
 *   workProductRoot         `computeWorkProductHash` (WorkProduct.productHash)
 *   programHash             the committed program hash (`computeVerificationProgramHash`)
 *
 * `settlementUnitId` is the escrow's frozen derivation, keccak256(abi.encode(
 * keccak256("PCC:vnext:settlement-unit:v1"), uint256 chainId, address escrow,
 * bytes32 jobIdHash, uint256 milestoneIndex, bytes32 stepId)); a unit context
 * whose milestoneIndex or stepId does not reproduce it is incoherent.
 *
 * Input forms are pinned so the digests cannot depend on spelling: every hex
 * value is 0x + lowercase hex of its exact width (an EIP-55 checksummed address
 * must be lowercased by the caller), and integers are non-negative bigints,
 * safe integers or decimal strings.
 *
 * The attestation set is validated before it is hashed (E7 F2): the job id and
 * every roleId are 1-128 printable ASCII characters with no whitespace; a set has
 * at least one role and roleIds are distinct; a role has at least one attestation;
 * minPositive and total are safe integers with 1 <= minPositive <= total; minScore
 * is a safe integer in [0, 100]; attestation hashes are distinct and no more than
 * `total`. Duplicates are refused, never silently de-duplicated. The #270 mirror
 * pins no empty set, so an empty set is refused.
 *
 * The session authorization is snapshotted before it is hashed (E7 F3, F4): a frozen
 * plain copy of exactly the declared fields, read once, with `publicKey` pinned to 64
 * and `parentSignature` to 128 lowercase hex characters with NO 0x prefix, the form the
 * golden uses and every in-repo producer emits. Other spellings of the same key are
 * refused rather than normalized, so one authorization has one digest and neither the
 * oracle mirror nor the goldens change. The scope arrays are committed in the order
 * given: the same permissions in another order, or with a duplicate, have another digest.
 * They are not pinned here because `SessionKeyService.issueSessionKey` passes the
 * caller's order and duplicates through verbatim (the parent signature covers a sorted
 * copy), so a producer exists that would not comply; that needs a producer-side decision.
 *
 * The block is evaluator-ready, not a money authority by itself: the oracle
 * reconstructs the unit context independently and pins programHash to the
 * funded policy's committed program.
 *
 * BOUNDARY: what this module does NOT do (E7 verdict on #361, F1). A root derived
 * here proves the CONTENT of one bundle is self-consistent. It does not prove the
 * bundle is authentic, final or the only one, and none of the following is
 * enforced by a pure function. Each has an owner:
 *   1. The kernel signature over bundleHash and the session-key delegation are
 *      verified by the consumer with the LO-EV-1 verifier (#338).
 *      `computeKernelSignedEventsRoot` checks the events and the bundleHash only.
 *   2. "ONE finalized bundle per settlement unit" needs a stateful finalization
 *      record at the evidence-finalization boundary (gateway/VCR). Without it a
 *      producer can cherry-pick one favorable signed bundle and omit a later
 *      execution_failed or inspection event.
 *   3. The oracle independently repeats these checks and rejects parallel,
 *      partial, superseded or unfinalized bundles.
 * `computeEvidenceBlockHash(roots)` is the low-level, mirror-exact function: it
 * hashes whatever bytes32 roots it is handed. Those roots must come only from the
 * verified derivations in this module (or the oracle's own).
 */

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize, hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceBundle, EvidenceEvent, SessionKeyAuthorization } from "../types/evidence.js";

export type Bytes32Hex = `0x${string}`;

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Raised for an input that is not in its pinned form. */
export class EvidenceBlockInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`EvidenceBlock input ${field}: ${reason}`);
    this.name = "EvidenceBlockInputError";
    this.field = field;
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function keccakUtf8(s: string): Bytes32Hex {
  return `0x${toHex(keccak_256(new TextEncoder().encode(s)))}`;
}

export const EVIDENCE_BLOCK_DOMAIN_V2: Bytes32Hex = keccakUtf8("PCC:vnext:evidence-block:v2");
export const EVIDENCE_BLOCK_VERSION = 2;
export const UNIT_CONTEXT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:unit-context:v1");
export const SETTLEMENT_UNIT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:settlement-unit:v1");

// ── Static ABI words (every field here is a 32-byte head word) ──────────────

function bytes32Word(field: string, value: unknown): Uint8Array {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 64 lowercase hex");
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function addressWord(field: string, value: unknown): Uint8Array {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 40 lowercase hex");
  }
  const word = new Uint8Array(32);
  word.set(Buffer.from(value.slice(2), "hex"), 12);
  return word;
}

function uintWord(field: string, value: unknown, bits: number): Uint8Array {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) {
    // Number.isSafeInteger(-0) is true and BigInt(-0) is 0n, so -0 would reach the same word
    // as 0. It is not the pinned spelling of zero: refuse it.
    if (Object.is(value, -0)) {
      throw new EvidenceBlockInputError(field, "negative zero is not a pinned input form; pass 0");
    }
    n = BigInt(value);
  } else if (typeof value === "string" && DECIMAL.test(value)) n = BigInt(value);
  else throw new EvidenceBlockInputError(field, "expected a non-negative integer");
  if (n < 0n || n >= 1n << BigInt(bits)) {
    throw new EvidenceBlockInputError(field, `out of range for uint${bits}`);
  }
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--) {
    word[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return word;
}

function keccakWords(words: Uint8Array[]): Bytes32Hex {
  const buf = new Uint8Array(words.length * 32);
  words.forEach((w, i) => buf.set(w, i * 32));
  return `0x${toHex(keccak_256(buf))}`;
}

function sha256Canonical(value: unknown): Bytes32Hex {
  return `0x${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

// ── Unit identity ────────────────────────────────────────────────────────────

export interface SettlementUnitRef {
  chainId: bigint | number | string;
  escrow: string;
  jobIdHash: string;
  milestoneIndex: bigint | number | string;
  stepId: string;
}

/** The escrow's frozen settlement-unit id derivation. */
export function computeSettlementUnitId(unit: SettlementUnitRef): Bytes32Hex {
  return keccakWords([
    bytes32Word("SETTLEMENT_UNIT_DOMAIN_V1", SETTLEMENT_UNIT_DOMAIN_V1),
    uintWord("chainId", unit.chainId, 256),
    addressWord("escrow", unit.escrow),
    bytes32Word("jobIdHash", unit.jobIdHash),
    uintWord("milestoneIndex", unit.milestoneIndex, 256),
    bytes32Word("stepId", unit.stepId),
  ]);
}

export interface UnitContext extends SettlementUnitRef {
  settlementUnitId: string;
  challengeNonce: string;
}

/**
 * The unit + challenge context bound inside the block. Refuses a context whose
 * settlementUnitId does not derive from its own chainId, escrow, jobIdHash,
 * milestoneIndex and stepId. Every field is read exactly once and the derivation
 * check and the hash both use those copies, so a getter that answers differently
 * on a second read cannot make the committed context differ from the checked one.
 */
export function computeUnitContextDigest(ctx: UnitContext): Bytes32Hex {
  if (ctx === null || typeof ctx !== "object") {
    throw new EvidenceBlockInputError("unitContext", "expected a unit context object");
  }
  const chainId = ctx.chainId;
  const escrow = ctx.escrow;
  const settlementUnitId = ctx.settlementUnitId;
  const jobIdHash = ctx.jobIdHash;
  const milestoneIndex = ctx.milestoneIndex;
  const stepId = ctx.stepId;
  const challengeNonce = ctx.challengeNonce;
  if (computeSettlementUnitId({ chainId, escrow, jobIdHash, milestoneIndex, stepId }) !== settlementUnitId) {
    throw new EvidenceBlockInputError(
      "settlementUnitId",
      "does not derive from the context's chainId, escrow, jobIdHash, milestoneIndex and stepId",
    );
  }
  return keccakWords([
    bytes32Word("UNIT_CONTEXT_DOMAIN_V1", UNIT_CONTEXT_DOMAIN_V1),
    uintWord("chainId", chainId, 256),
    addressWord("escrow", escrow),
    bytes32Word("settlementUnitId", settlementUnitId),
    bytes32Word("jobIdHash", jobIdHash),
    uintWord("milestoneIndex", milestoneIndex, 256),
    bytes32Word("stepId", stepId),
    bytes32Word("challengeNonce", challengeNonce),
  ]);
}

// ── The sha256 roots ─────────────────────────────────────────────────────────

/** A tagged evidence digest (`sha256:<hex>`, e.g. a bundleHash) as a bytes32 root. */
export function taggedDigestToBytes32(digest: string): Bytes32Hex {
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new EvidenceBlockInputError("kernelSignedEventsRoot", "expected sha256: + 64 lowercase hex");
  }
  return `0x${digest.slice("sha256:".length)}`;
}

/** One event as plain data: a JSON round trip reads every property exactly once. */
function snapshotEvent(field: string, event: unknown): EvidenceEvent {
  let text: string | undefined;
  try {
    text = JSON.stringify(event);
  } catch {
    throw new EvidenceBlockInputError(field, "is not JSON-serializable plain data");
  }
  const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EvidenceBlockInputError(field, "expected an event object");
  }
  return parsed as EvidenceEvent;
}

/**
 * The kernelSignedEventsRoot of ONE evidence bundle, derived from what its events
 * actually say rather than from the hashes it carries. `hashBundle` trusts each
 * `event.hash`, so on its own two bundles with different payloads and the same
 * carried hashes share a root.
 *
 * The events are snapshotted once (a JSON round trip of each event: one read, then
 * plain data). Every event hash is recomputed with `hashEvent` and must equal the
 * carried `event.hash`; `hashBundle` is recomputed over that snapshot and must equal
 * `bundle.bundleHash`; an empty event list is refused. Throws `EvidenceBlockInputError`
 * on any failure. Returns the bundleHash as a bytes32 root.
 *
 * Only the root is returned: a consumer that evaluates events afterwards must evaluate
 * plain data it holds, not a live object it passed here. This does not verify the kernel
 * signature, the session-key delegation, or that this is the one finalized bundle for the
 * settlement unit; see BOUNDARY in the module header.
 */
export async function computeKernelSignedEventsRoot(
  bundle: Pick<EvidenceBundle, "events" | "bundleHash">,
): Promise<Bytes32Hex> {
  if (bundle === null || typeof bundle !== "object") {
    throw new EvidenceBlockInputError("bundle", "expected an evidence bundle object");
  }
  // Each bundle property is read exactly once; only the local copies are used after this.
  const rawEvents: unknown = bundle.events;
  const carriedBundleHash: unknown = bundle.bundleHash;
  if (!Array.isArray(rawEvents)) {
    throw new EvidenceBlockInputError("events", "expected an array of evidence events");
  }
  const count = rawEvents.length;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError("events", "expected at least one event (an empty bundle commits to nothing)");
  }
  const events: EvidenceEvent[] = [];
  for (let i = 0; i < count; i++) events.push(snapshotEvent(`events[${i}]`, rawEvents[i]));
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if ((await hashEvent(event)) !== event.hash) {
      throw new EvidenceBlockInputError(
        `events[${i}].hash`,
        "does not match the hash recomputed from the event's type, timestamp, source and payload",
      );
    }
  }
  const bundleHash = await hashBundle(events);
  if (bundleHash !== carriedBundleHash) {
    throw new EvidenceBlockInputError("bundleHash", "does not match the hash recomputed from the bundle's event hashes");
  }
  return taggedDigestToBytes32(bundleHash);
}

// ── The session authorization ────────────────────────────────────────────────

/** Exactly the fields `SessionKeyAuthorization` declares in types/evidence.ts. */
const SESSION_KEY_AUTH_FIELDS = [
  "sessionId",
  "parentAgentId",
  "publicKey",
  "issuedAt",
  "expiresAt",
  "scope",
  "parentSignature",
  "derivationPath",
] as const satisfies readonly (keyof SessionKeyAuthorization)[];
const SESSION_SCOPE_FIELDS = ["allowedActions", "contractIds", "maxSignatures"] as const satisfies readonly (keyof SessionKeyAuthorization["scope"])[];

// Compile-time guard: a field added to SessionKeyAuthorization must be listed above (and
// given a rule below) before this module compiles. At runtime an unlisted field is refused.
type AssertNever<T extends never> = T;
type SessionFieldsMissingFromSnapshot = AssertNever<
  | Exclude<keyof SessionKeyAuthorization, (typeof SESSION_KEY_AUTH_FIELDS)[number]>
  | Exclude<keyof SessionKeyAuthorization["scope"], (typeof SESSION_SCOPE_FIELDS)[number]>
>;

/** A deep-frozen plain copy of a SessionKeyAuthorization. */
export type FrozenSessionKeyAuthorization = Readonly<Omit<SessionKeyAuthorization, "scope">> & {
  readonly scope: Readonly<{
    allowedActions: readonly string[];
    contractIds: readonly string[];
    maxSignatures: number;
  }>;
};

export interface SessionKeyAuthSnapshot {
  /**
   * The frozen plain copy of exactly the fields SessionKeyAuthorization declares. Consumers
   * evaluate THIS value, never the object they passed in: it is the value that was hashed.
   */
  readonly value: FrozenSessionKeyAuthorization;
  /** 0x + sha256(canonicalize(value)), computed over `value` itself. */
  readonly digest: Bytes32Hex;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  // The Object.prototype of any realm has a null prototype itself; class instances, Map and Date do not.
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * The own properties of a plain object, each read once through its descriptor so an accessor
 * is never invoked. Refuses a Proxy, a non-plain object, a symbol or unlisted key, an accessor
 * and a non-enumerable property.
 */
function readPlainFields(path: string, input: unknown, allowed: readonly string[]): Map<string, unknown> {
  if (!isPlainObject(input)) {
    throw new EvidenceBlockInputError(path, "expected a plain object (not null, an array, a Proxy or a class instance)");
  }
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol" || !allowed.includes(key)) {
      throw new EvidenceBlockInputError(path, `unknown own key ${JSON.stringify(String(key).slice(0, 64))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new EvidenceBlockInputError(`${path}.${key}`, "accessor properties are not accepted; pass plain data");
    }
    if (descriptor.enumerable !== true) {
      throw new EvidenceBlockInputError(`${path}.${key}`, "expected an enumerable data property");
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function requiredField(path: string, fields: Map<string, unknown>, key: string): unknown {
  if (!fields.has(key)) {
    throw new EvidenceBlockInputError(`${path}.${key}`, "is required");
  }
  return fields.get(key);
}

function requireNonEmptyString(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceBlockInputError(field, "expected a non-empty string");
  }
  return value;
}

/**
 * The pinned spelling of the session public key (a raw 32-byte Ed25519 key) and of the
 * parent signature (64 bytes): bare lowercase hex, no 0x prefix. This is the form the
 * golden uses and the only form the in-repo producers emit (kernel-sdk job-handler.ts
 * `toHex`, gateway identity-session.ts `toHex`). The type permits an optional 0x prefix
 * and the gateway intake accepts uppercase, but those spellings of one key would give one
 * authorization several digests, so they are refused here, never normalized.
 */
const SESSION_PUBLIC_KEY = /^[0-9a-f]{64}$/;
const SESSION_PARENT_SIGNATURE = /^[0-9a-f]{128}$/;

function requirePinnedHex(field: string, value: unknown, pattern: RegExp, expected: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new EvidenceBlockInputError(field, expected);
  }
  return value;
}

/** A frozen copy of a dense, plain array of strings; elements are read through descriptors. */
function readStringArray(path: string, input: unknown): readonly string[] {
  if (!Array.isArray(input) || utilTypes.isProxy(input)) {
    throw new EvidenceBlockInputError(path, "expected a plain array of strings");
  }
  const length = input.length;
  if (Reflect.ownKeys(input).length !== length + 1) {
    throw new EvidenceBlockInputError(path, "expected a dense array with no extra properties");
  }
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, i);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected an enumerable data element");
    }
    if (typeof descriptor.value !== "string") {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected a string");
    }
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}

/**
 * Snapshot a session-key authorization: validate it and copy it into a deep-frozen plain
 * value, reading every property exactly once. An unknown own key, an accessor property, a
 * non-plain object or a Proxy is refused, so validation and the digest cannot observe
 * different values. `digest` is computed over the frozen copy. Consumers must evaluate
 * `value`, never the original object: it is the exact value that was hashed.
 */
export function sessionKeyAuthSnapshot(auth: SessionKeyAuthorization): SessionKeyAuthSnapshot {
  const path = "sessionKeyAuthorization";
  const top = readPlainFields(path, auth, SESSION_KEY_AUTH_FIELDS);
  const sessionId = requireNonEmptyString(`${path}.sessionId`, requiredField(path, top, "sessionId"));
  const parentAgentId = requireNonEmptyString(`${path}.parentAgentId`, requiredField(path, top, "parentAgentId"));
  const publicKey = requirePinnedHex(
    `${path}.publicKey`,
    requiredField(path, top, "publicKey"),
    SESSION_PUBLIC_KEY,
    "expected 64 lowercase hex characters with no 0x prefix (the raw 32-byte Ed25519 key)",
  );
  const issuedAt = boundedInt(`${path}.issuedAt`, requiredField(path, top, "issuedAt"), 0, Number.MAX_SAFE_INTEGER);
  const expiresAt = boundedInt(`${path}.expiresAt`, requiredField(path, top, "expiresAt"), 0, Number.MAX_SAFE_INTEGER);
  const parentSignature = requirePinnedHex(
    `${path}.parentSignature`,
    requiredField(path, top, "parentSignature"),
    SESSION_PARENT_SIGNATURE,
    "expected 128 lowercase hex characters with no 0x prefix (the 64-byte parent signature)",
  );
  // An optional field that is absent or undefined is the same value: canonicalize omits undefined.
  const derivationRaw = top.get("derivationPath");
  const derivationPath =
    derivationRaw === undefined ? undefined : requireNonEmptyString(`${path}.derivationPath`, derivationRaw);

  const scopePath = `${path}.scope`;
  const scopeFields = readPlainFields(scopePath, requiredField(path, top, "scope"), SESSION_SCOPE_FIELDS);
  const allowedActions = readStringArray(`${scopePath}.allowedActions`, requiredField(scopePath, scopeFields, "allowedActions"));
  const contractIds = readStringArray(`${scopePath}.contractIds`, requiredField(scopePath, scopeFields, "contractIds"));
  const maxSignatures = boundedInt(
    `${scopePath}.maxSignatures`,
    requiredField(scopePath, scopeFields, "maxSignatures"),
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const value: FrozenSessionKeyAuthorization = Object.freeze({
    sessionId,
    parentAgentId,
    publicKey,
    issuedAt,
    expiresAt,
    scope: Object.freeze({ allowedActions, contractIds, maxSignatures }),
    parentSignature,
    ...(derivationPath === undefined ? {} : { derivationPath }),
  });
  return Object.freeze({ value, digest: sha256Canonical(value) });
}

/** The sessionKeyAuthDigest: 0x + sha256(canonicalize(frozen snapshot of the authorization)). */
export function computeSessionKeyAuthDigest(auth: SessionKeyAuthorization): Bytes32Hex {
  return sessionKeyAuthSnapshot(auth).digest;
}

export interface AttestationQuorumRole {
  roleId: string;
  minPositive: number;
  total: number;
  minScore: number;
  /** Hashes of the role's attestations (0x + 64 lowercase hex). */
  attestationHashes: string[];
}

/** 1-128 printable ASCII characters, no whitespace: the pinned form of a roleId and of the attestation job id. */
const TOKEN = /^[\x21-\x7E]{1,128}$/;

function requireToken(field: string, value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new EvidenceBlockInputError(field, "expected 1-128 printable ASCII characters with no whitespace");
  }
  return value;
}

/** A safe integer in [min, max]. Negative zero is refused: it is not the pinned spelling of 0. */
function boundedInt(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw new EvidenceBlockInputError(field, `expected a safe integer in [${min}, ${max}]`);
  }
  return value;
}

/** A role as validated, frozen plain data. */
interface AttestationRoleSnapshot {
  readonly roleId: string;
  readonly minPositive: number;
  readonly total: number;
  readonly minScore: number;
  readonly attestationHashes: readonly string[];
}

/**
 * Validate one role and copy it into frozen plain data. Every field and every array
 * element is read exactly once, and only the copy is validated and hashed, so a getter
 * or Proxy that changes its answer cannot make the validated value differ from the
 * committed one.
 */
function snapshotAttestationRole(path: string, input: unknown): AttestationRoleSnapshot {
  if (input === null || typeof input !== "object") {
    throw new EvidenceBlockInputError(path, "expected a role object");
  }
  const raw = input as Record<string, unknown>;
  const roleIdRaw = raw.roleId;
  const minPositiveRaw = raw.minPositive;
  const totalRaw = raw.total;
  const minScoreRaw = raw.minScore;
  const hashesRaw = raw.attestationHashes;

  const roleId = requireToken(`${path}.roleId`, roleIdRaw);
  const total = boundedInt(`${path}.total`, totalRaw, 1, Number.MAX_SAFE_INTEGER);
  const minPositive = boundedInt(`${path}.minPositive`, minPositiveRaw, 1, Number.MAX_SAFE_INTEGER);
  if (minPositive > total) {
    throw new EvidenceBlockInputError(`${path}.minPositive`, "must not exceed total");
  }
  const minScore = boundedInt(`${path}.minScore`, minScoreRaw, 0, 100);

  if (!Array.isArray(hashesRaw)) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "expected an array of attestation hashes");
  }
  const count = hashesRaw.length;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "expected at least one attestation hash");
  }
  if (count > total) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "more attestation hashes than total");
  }
  const attestationHashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hash = hashesRaw[i];
    bytes32Word(`${path}.attestationHashes[${i}]`, hash);
    attestationHashes.push(hash as string);
  }
  if (new Set(attestationHashes).size !== attestationHashes.length) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "attestation hashes must be distinct");
  }
  return Object.freeze({ roleId, minPositive, total, minScore, attestationHashes: Object.freeze(attestationHashes) });
}

/** Validate and snapshot a whole role set: at least one role, distinct roleIds. */
function snapshotAttestationRoles(input: unknown): readonly AttestationRoleSnapshot[] {
  if (!Array.isArray(input)) {
    throw new EvidenceBlockInputError("roles", "expected an array of roles");
  }
  const count = input.length;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError("roles", "expected at least one role (the mirror defines no empty attestation set)");
  }
  const roles: AttestationRoleSnapshot[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const role = snapshotAttestationRole(`roles[${i}]`, input[i]);
    if (seen.has(role.roleId)) {
      throw new EvidenceBlockInputError(`roles[${i}].roleId`, `duplicate roleId ${JSON.stringify(role.roleId)}`);
    }
    seen.add(role.roleId);
    roles.push(role);
  }
  return Object.freeze(roles);
}

function roleDigestOf(job: string, role: AttestationRoleSnapshot): Bytes32Hex {
  return sha256Canonical({
    roleId: role.roleId,
    minPositive: role.minPositive,
    total: role.total,
    minScore: role.minScore,
    job,
    hashes: [...role.attestationHashes].sort(),
  });
}

/**
 * One role's digest: binds roleId, its quorum config, the job and its sorted attestations.
 * The role is validated and snapshotted first; only the snapshot is hashed.
 */
export function computeAttestationRoleDigest(job: string, role: AttestationQuorumRole): Bytes32Hex {
  return roleDigestOf(requireToken("job", job), snapshotAttestationRole("role", role));
}

/**
 * The attestation set root: sha256 of the sorted role digests. The whole set is validated
 * and snapshotted before anything is hashed: duplicate roleIds, duplicate attestation
 * hashes, an empty set, an empty role and an invalid quorum are refused, never silently
 * de-duplicated.
 */
export function computeAttestationSetRoot(job: string, roles: readonly AttestationQuorumRole[]): Bytes32Hex {
  const checkedJob = requireToken("job", job);
  const snapshot = snapshotAttestationRoles(roles);
  return sha256Canonical(snapshot.map((r) => roleDigestOf(checkedJob, r)).sort());
}

// ── The block ────────────────────────────────────────────────────────────────

export interface EvidenceBlockRoots {
  unitContextDigest: string;
  kernelSignedEventsRoot: string;
  sessionKeyAuthDigest: string;
  attestationSetRoot: string;
  workProductRoot: string;
  programHash: string;
}

/**
 * The block hash over six roots. This is the low-level, mirror-exact function: it
 * checks each root's form (0x + 64 lowercase hex) and nothing else, so it cannot tell a
 * verified root from an arbitrary one. The roots must come only from the verified
 * derivations in this module (`computeUnitContextDigest`, `computeKernelSignedEventsRoot`,
 * `computeSessionKeyAuthDigest`, `computeAttestationSetRoot`, ...) or from the oracle's
 * own. See BOUNDARY in the module header.
 */
export function computeEvidenceBlockHash(roots: EvidenceBlockRoots): Bytes32Hex {
  return keccakWords([
    bytes32Word("EVIDENCE_BLOCK_DOMAIN_V2", EVIDENCE_BLOCK_DOMAIN_V2),
    uintWord("version", EVIDENCE_BLOCK_VERSION, 16),
    bytes32Word("unitContextDigest", roots.unitContextDigest),
    bytes32Word("kernelSignedEventsRoot", roots.kernelSignedEventsRoot),
    bytes32Word("sessionKeyAuthDigest", roots.sessionKeyAuthDigest),
    bytes32Word("attestationSetRoot", roots.attestationSetRoot),
    bytes32Word("workProductRoot", roots.workProductRoot),
    bytes32Word("programHash", roots.programHash),
  ]);
}
