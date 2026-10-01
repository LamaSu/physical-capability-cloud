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
 *                           `computeKernelSignedEventsRoot(bundle).root`, which recomputes
 *                           every event hash and the bundleHash instead of trusting the
 *                           carried ones, and returns the verified `events` it hashed.
 *                           ONE bundle: a settlement unit's evidence is one
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
 * safe integers or decimal strings (negative zero is refused: pass 0).
 *
 * The attestation set is validated before it is hashed (E7 F2): the job id and
 * every roleId are 1-128 printable ASCII characters with no whitespace; a set has
 * at least one role and roleIds are distinct; a role has at least one attestation;
 * minPositive and total are safe integers with 1 <= minPositive <= total; minScore
 * is a safe integer in [0, 100]; attestation hashes are distinct and no more than
 * `total`. Duplicates are refused, never silently de-duplicated. The #270 mirror
 * pins no empty set, so an empty set is refused.
 *
 * The bundle's events are snapshotted before they are hashed (E7b): each event goes through
 * `canonicalSnapshot` (#359), which reads own property descriptors only, so no getter and no
 * `toJSON` of the input ever runs, and which refuses what JSON cannot carry exactly: an accessor,
 * a non-enumerable or symbol-keyed property, NaN and Infinity, a bigint, a function, an
 * `undefined` array element or hole, a cycle, a class instance or other non-plain object. A
 * JSON.stringify/parse round trip accepted all of those and committed a projection (NaN became
 * null) instead of the submitted evidence. Every hash is recomputed over the snapshot and
 * `computeKernelSignedEventsRoot` returns the snapshot with the root: consumers evaluate the
 * returned `events`, never the object they passed in. An `undefined` OBJECT member is omitted,
 * exactly as `canonicalize` (and so `hashEvent` and `verifyEventHash`) omits it from every
 * hash in the repo and as JSON transport drops it: it is absent from the hashed text and from
 * the returned events alike, so what is evaluated is what was hashed. It is not refused:
 * refusing it would take a second read of the input, and would make this step stricter than
 * the `verifyEventHash` that accepts the same event.
 *
 * INPUT THAT CAN RUN CODE IS REFUSED BEFORE IT IS READ, AT EVERY PUBLIC ENTRY POINT (E7c). A Proxy
 * runs its traps on every reflection operation and an accessor runs its getter on every [[Get]].
 * Code that runs while a snapshot is being made or a digest is being computed can replace
 * `Object.freeze`, `Buffer.from`, `Array.prototype.sort` or any other global for one microtask, so
 * that the freezes become no-ops and the returned events stay mutable, or a digest differs from the
 * one the producer thinks it computed, or a later read answers differently: the events a consumer
 * evaluates could differ from the events that were committed. A prototype polluted with an accessor
 * can do the same to a field the caller never supplied. So every exported function that takes an
 * object or an array (`computeSettlementUnitId`, `computeUnitContextDigest`,
 * `computeAttestationRoleDigest`, `computeAttestationSetRoot`, `computeEvidenceBlockHash`,
 * `sessionKeyAuthSnapshot` and `computeSessionKeyAuthDigest`, and `computeKernelSignedEventsRoot` for
 * the events) first runs ONE guard over the whole input, `assertNoCodeRunningInput`, an iterative walk
 * that touches only what cannot run code, and refuses, before any value is read:
 *   - a Proxy at any depth (live or revoked), and an accessor anywhere, in a member that is read or
 *     not;
 *   - an object that is not plain: its prototype must be null or a prototype-less object that is no
 *     Proxy (the Object.prototype of any realm), so a class instance, a Date, a Map, a typed array, a
 *     Buffer, an Error and an object whose prototype is a Proxy are refused, before their members
 *     are enumerated.
 * Then each field is read exactly once from its OWN data descriptor, never with a [[Get]] (so no
 * getter runs and nothing is inherited: a field the object does not own is missing, whatever
 * Object.prototype says). For the bundle that means `events` and `bundleHash` (a getter on the bundle,
 * one inherited from a class, a missing property are refused), the events array (a hole or an accessor
 * element is refused) and, for each event, `canonicalSnapshot` over a graph proven free of Proxies and
 * accessors.
 * What is used after that is captured or pure: `Object.freeze`, `Array.isArray`, `Reflect.ownKeys`,
 * `Reflect.getOwnPropertyDescriptor`, `Reflect.getPrototypeOf`, `Number.isSafeInteger`,
 * `util.types.isProxy`, `Number`, `BigInt`, the `Uint8Array` constructor, the `node:crypto` Hash
 * `update` and `digest`, `Set` and `String.prototype.charCodeAt` and `slice` are references captured
 * when the module loads (as #359's canonical.ts does for the encoder), and hex, bytes, ABI words,
 * the field checks, the sorts and the array building are loops over char codes and bytes with no
 * Buffer, regular expression, `Uint8Array.from`, `Array.prototype` method or `Object.is`. So no
 * global or prototype method that was replaced after load changes a freeze, a check, a word or a
 * digest. What cannot be captured is what `@noble/hashes` (keccak) and `node:crypto` do inside the
 * two hash calls. A caller that replaces globals itself is outside the threat model: it already runs
 * arbitrary code in this process.
 *
 * The session authorization is snapshotted before it is hashed (E7 F3, F4): admitted first with the
 * same guard as every other entry point, then a frozen plain copy of exactly the declared fields,
 * read once from their own descriptors, with `publicKey` pinned to 64
 * and `parentSignature` to 128 lowercase hex characters with NO 0x prefix, the form the
 * golden uses and every in-repo producer emits. Other spellings of the same key are
 * refused rather than normalized, so one authorization has one digest and neither the
 * oracle mirror nor the goldens change. The scope arrays `allowedActions` and `contractIds`
 * are pinned by rejection to one canonical form, strictly ascending in UTF-16 code-unit
 * order (which also excludes a duplicate; an empty array is allowed). An unsorted or
 * duplicated array is refused, never sorted or de-duplicated, so the same permissions
 * cannot have two digests. Producers emit that form: `SessionKeyService.issueSessionKey`
 * builds `[...new Set(xs)].sort()` before it signs (gateway #4670), so a conforming
 * authorization is accepted unchanged.
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
import { NonCanonicalValueError, canonicalSnapshot, canonicalize, hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceBundle, EvidenceEvent, SessionKeyAuthorization } from "../types/evidence.js";

// What this module uses to inspect and freeze caller-supplied objects, and to encode and hash what
// it read from them, is captured here, when the module loads, and the code below calls only these
// references (#359's canonical.ts does the same for the encoder). A global or a prototype method
// replaced AFTER this point (Object.freeze, Reflect.ownKeys, util.types.isProxy, Buffer.from,
// Number, BigInt, Array.prototype.sort, RegExp.prototype.exec, Hash.prototype.update ...) cannot
// change what the freezes, the key enumeration, the array and Proxy tests, the field checks, the ABI
// words and the digests below do: in particular the snapshot's freeze cannot be made a no-op and no
// digest can be changed. The traversal of the two walks below (`assertNoCodeRunningInput` and
// `deepFreeze`) and the encoding below look nothing up at call time: `set.has(v)`, `arr.push(v)`,
// `text.charCodeAt(i)` and a regular expression's `test` would find a method on the object, so they
// use the bound captures, linked frames, char-code loops and `appendTo` instead. (Only the text of a
// refusal is built with ordinary calls; so is what `@noble/hashes` and `node:crypto` do inside the
// two hash calls, which this module cannot capture.)
const freeze = Object.freeze;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const getPrototypeOf = Reflect.getPrototypeOf;
const defineProperty = Reflect.defineProperty;
const isSafeInteger = Number.isSafeInteger;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const isProxy = utilTypes.isProxy;
const toBigInt = BigInt;
const toNumber = Number;
const Uint8ArrayConstructor = Uint8Array;
const createHashFunction = createHash;
const WeakSetConstructor = WeakSet;
const SetConstructor = Set;
const call = Function.prototype.call;
const weakSetAdd = call.bind(WeakSet.prototype.add) as unknown as (set: WeakSet<object>, value: object) => void;
const weakSetHas = call.bind(WeakSet.prototype.has) as unknown as (set: WeakSet<object>, value: unknown) => boolean;
const setAdd = call.bind(Set.prototype.add) as unknown as (set: Set<string>, value: string) => void;
const setHas = call.bind(Set.prototype.has) as unknown as (set: Set<string>, value: string) => boolean;
const charCodeAt = call.bind(String.prototype.charCodeAt) as unknown as (text: string, index: number) => number;
const stringSlice = call.bind(String.prototype.slice) as unknown as (text: string, from: number, to?: number) => string;
// node:crypto looks `update` and `digest` up on Hash.prototype at call time: take them from a sample hash.
const hashPrototype = getPrototypeOf(createHashFunction("sha256")) as object;
const hashUpdate = call.bind(getOwnPropertyDescriptor(hashPrototype, "update")!.value) as unknown as (hash: unknown, data: string) => unknown;
const hashDigest = call.bind(getOwnPropertyDescriptor(hashPrototype, "digest")!.value) as unknown as (hash: unknown, encoding: string) => string;

export type Bytes32Hex = `0x${string}`;

/** Raised for an input that is not in its pinned form. */
export class EvidenceBlockInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`EvidenceBlock input ${field}: ${reason}`);
    this.name = "EvidenceBlockInputError";
    this.field = field;
  }
}

// ── Pure encoding: hex, bytes and ABI words (round 2) ───────────────────────
// Everything between a validated primitive and a digest is a loop over char codes and bytes and
// BigInt operators: no Buffer, no regular expression, no Uint8Array.from or .set, no Array.prototype
// method, so nothing here depends on a global or a prototype method that could be replaced. Text is
// judged by `isPrefixedLowerHex`, `isBareLowerHex`, `isDecimal` and `isToken`, which read characters
// with the captured `charCodeAt`; they accept exactly what the regular expressions they replace did.

const HEX_DIGITS = "0123456789abcdef";

/** The value of one lowercase hex digit by its char code, or -1. */
function hexDigitValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/** Whether text[from .. to) is nothing but lowercase hex digits. */
function isLowerHex(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (hexDigitValue(charCodeAt(text, i)) < 0) return false;
  return true;
}

/** `0x` followed by exactly `hexLength` lowercase hex digits (what /^0x[0-9a-f]{n}$/ matched). */
function isPrefixedLowerHex(value: unknown, hexLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length === hexLength + 2 &&
    charCodeAt(value, 0) === 48 &&
    charCodeAt(value, 1) === 120 &&
    isLowerHex(value, 2, hexLength + 2)
  );
}

/** Exactly `hexLength` lowercase hex digits and nothing else (what /^[0-9a-f]{n}$/ matched). */
function isBareLowerHex(value: unknown, hexLength: number): value is string {
  return typeof value === "string" && value.length === hexLength && isLowerHex(value, 0, hexLength);
}

/** A non-negative decimal integer with no leading zero (what /^(0|[1-9][0-9]*)$/ matched). */
function isDecimal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = value.length;
  if (length === 0) return false;
  if (charCodeAt(value, 0) === 48) return length === 1;
  for (let i = 0; i < length; i++) {
    const code = charCodeAt(value, i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** 1-128 printable ASCII characters, no whitespace (what /^[\x21-\x7E]{1,128}$/ matched). */
function isToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = value.length;
  if (length < 1 || length > 128) return false;
  for (let i = 0; i < length; i++) {
    const code = charCodeAt(value, i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** The bytes that `byteCount` hex pairs of `text`, from index `from`, spell, written into `into` at `at`. `text` must already be validated hex. */
function hexIntoBytes(text: string, from: number, byteCount: number, into: Uint8Array, at: number): void {
  for (let i = 0; i < byteCount; i++) {
    into[at + i] = hexDigitValue(charCodeAt(text, from + 2 * i)) * 16 + hexDigitValue(charCodeAt(text, from + 2 * i + 1));
  }
}

/** The lowercase hex of bytes[0 .. length). */
function bytesToHex(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i]!;
    out += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  }
  return out;
}

function keccakUtf8(s: string): Bytes32Hex {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(s)), 32)}`;
}

export const EVIDENCE_BLOCK_DOMAIN_V2: Bytes32Hex = keccakUtf8("PCC:vnext:evidence-block:v2");
export const EVIDENCE_BLOCK_VERSION = 2;
export const UNIT_CONTEXT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:unit-context:v1");
export const SETTLEMENT_UNIT_DOMAIN_V1: Bytes32Hex = keccakUtf8("PCC:vnext:settlement-unit:v1");

// ── Static ABI words (every field here is a 32-byte head word) ──────────────

function bytes32Word(field: string, value: unknown): Uint8Array {
  if (!isPrefixedLowerHex(value, 64)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 64 lowercase hex");
  }
  const word = new Uint8ArrayConstructor(32);
  hexIntoBytes(value, 2, 32, word, 0);
  return word;
}

function addressWord(field: string, value: unknown): Uint8Array {
  if (!isPrefixedLowerHex(value, 40)) {
    throw new EvidenceBlockInputError(field, "expected 0x + 40 lowercase hex");
  }
  const word = new Uint8ArrayConstructor(32);
  hexIntoBytes(value, 2, 20, word, 12);
  return word;
}

function uintWord(field: string, value: unknown, bits: number): Uint8Array {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && isSafeInteger(value)) {
    // Number.isSafeInteger(-0) is true and BigInt(-0) is 0n, so -0 would reach the same word
    // as 0. It is not the pinned spelling of zero: refuse it. (1 / -0 is -Infinity: the test that
    // Object.is(value, -0) was, without looking Object.is up.)
    if (value === 0 && 1 / value < 0) {
      throw new EvidenceBlockInputError(field, "negative zero is not a pinned input form; pass 0");
    }
    n = toBigInt(value);
  } else if (isDecimal(value)) n = toBigInt(value);
  else throw new EvidenceBlockInputError(field, "expected a non-negative integer");
  if (n < 0n || n >= 1n << toBigInt(bits)) {
    throw new EvidenceBlockInputError(field, `out of range for uint${bits}`);
  }
  const word = new Uint8ArrayConstructor(32);
  for (let i = 31; i >= 0 && n > 0n; i--) {
    word[i] = toNumber(n & 0xffn);
    n >>= 8n;
  }
  return word;
}

function keccakWords(words: Uint8Array[]): Bytes32Hex {
  const count = words.length;
  const buf = new Uint8ArrayConstructor(count * 32);
  for (let w = 0; w < count; w++) {
    const word = words[w]!;
    for (let j = 0; j < 32; j++) buf[w * 32 + j] = word[j]!;
  }
  return `0x${bytesToHex(keccak_256(buf), 32)}`;
}

function sha256Canonical(value: unknown): Bytes32Hex {
  const hash = createHashFunction("sha256");
  hashUpdate(hash, canonicalize(value));
  return `0x${hashDigest(hash, "hex")}`;
}

// ── Unit identity ────────────────────────────────────────────────────────────

export interface SettlementUnitRef {
  chainId: bigint | number | string;
  escrow: string;
  jobIdHash: string;
  milestoneIndex: bigint | number | string;
  stepId: string;
}

/** The escrow's settlement-unit id over five already-read values, each validated as it is encoded. */
function settlementUnitIdOf(chainId: unknown, escrow: unknown, jobIdHash: unknown, milestoneIndex: unknown, stepId: unknown): Bytes32Hex {
  return keccakWords([
    bytes32Word("SETTLEMENT_UNIT_DOMAIN_V1", SETTLEMENT_UNIT_DOMAIN_V1),
    uintWord("chainId", chainId, 256),
    addressWord("escrow", escrow),
    bytes32Word("jobIdHash", jobIdHash),
    uintWord("milestoneIndex", milestoneIndex, 256),
    bytes32Word("stepId", stepId),
  ]);
}

/**
 * The escrow's frozen settlement-unit id derivation. The unit is admitted first (no Proxy at any
 * depth, no accessor anywhere, a plain prototype: `assertNoCodeRunningInput`), then each field is
 * read from its own data descriptor, never with a [[Get]], so no code of the caller runs while the
 * id is derived and nothing is inherited from a prototype.
 */
export function computeSettlementUnitId(unit: SettlementUnitRef): Bytes32Hex {
  if (unit === null || typeof unit !== "object") {
    throw new EvidenceBlockInputError("unit", "expected a settlement unit object");
  }
  admit(unit, "unit");
  return settlementUnitIdOf(
    fieldOf(unit, "chainId"),
    fieldOf(unit, "escrow"),
    fieldOf(unit, "jobIdHash"),
    fieldOf(unit, "milestoneIndex"),
    fieldOf(unit, "stepId"),
  );
}

export interface UnitContext extends SettlementUnitRef {
  settlementUnitId: string;
  challengeNonce: string;
}

/**
 * The unit + challenge context bound inside the block. Refuses a context whose
 * settlementUnitId does not derive from its own chainId, escrow, jobIdHash,
 * milestoneIndex and stepId. The context is admitted first, as for `computeSettlementUnitId`:
 * a getter, a Proxy or a non-plain prototype is refused unread. Then every field is read exactly
 * once from its own data descriptor and the derivation check and the hash both use those copies.
 */
export function computeUnitContextDigest(ctx: UnitContext): Bytes32Hex {
  if (ctx === null || typeof ctx !== "object") {
    throw new EvidenceBlockInputError("unitContext", "expected a unit context object");
  }
  admit(ctx, "unitContext");
  const chainId = fieldOf(ctx, "chainId");
  const escrow = fieldOf(ctx, "escrow");
  const settlementUnitId = fieldOf(ctx, "settlementUnitId");
  const jobIdHash = fieldOf(ctx, "jobIdHash");
  const milestoneIndex = fieldOf(ctx, "milestoneIndex");
  const stepId = fieldOf(ctx, "stepId");
  const challengeNonce = fieldOf(ctx, "challengeNonce");
  if (settlementUnitIdOf(chainId, escrow, jobIdHash, milestoneIndex, stepId) !== settlementUnitId) {
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
  if (typeof digest !== "string" || digest.length !== 71 || stringSlice(digest, 0, 7) !== "sha256:" || !isLowerHex(digest, 7, 71)) {
    throw new EvidenceBlockInputError("kernelSignedEventsRoot", "expected sha256: + 64 lowercase hex");
  }
  return `0x${stringSlice(digest, 7)}`;
}

/**
 * Text taken from a refusal can carry an attacker's key names: replace control characters and
 * bound the length, so an error field or message cannot inject log lines or grow without limit.
 */
function printable(text: string, max: number): string {
  // Cut first, then scrub: a very long hostile key must not make the scrub itself expensive.
  const clean = text.slice(0, max).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?");
  return text.length > max ? `${clean}...` : clean;
}

/** What `ownDataValue` returns for a missing property and for an accessor. Module-private, so neither can equal a value read from input. */
const ABSENT = Symbol("evidence-block: no such own property");
const ACCESSOR = Symbol("evidence-block: accessor property");

/**
 * The value of `owner`'s OWN data property `key`, or ABSENT (no own property of that name: an
 * inherited one does not count) or ACCESSOR. It is read from the property's own descriptor through
 * the captured reflection, never with a [[Get]], so a getter is never invoked. A descriptor
 * describes a data property only when it OWNS `value` and no `get` or `set` (as #359's `dataValueOf`
 * judges it, never with `in`, which would also find a value inherited from a polluted
 * Object.prototype).
 *
 * `owner` must not be a Proxy: a Proxy answers a descriptor request with its own code. Callers test
 * `isProxy` first.
 */
function ownDataValue(owner: object, key: PropertyKey): unknown {
  const descriptor = getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) return ABSENT;
  const value = getOwnPropertyDescriptor(descriptor, "value");
  if (
    value === undefined ||
    getOwnPropertyDescriptor(descriptor, "get") !== undefined ||
    getOwnPropertyDescriptor(descriptor, "set") !== undefined
  ) {
    return ACCESSOR;
  }
  return value.value;
}

/** One entry of a linked stack: no array, so nothing is looked up on Array.prototype while walking. */
interface FreezeFrame {
  readonly node: unknown;
  readonly below: FreezeFrame | null;
}

/**
 * Freeze `root` and every object and array reachable from it, with the captured `Object.freeze`
 * (a replaced global cannot make this a no-op). The tree is a fresh JSON parse, so it is acyclic and
 * holds only own data properties, each fetched from its own descriptor; the walk is iterative, so
 * depth cannot overflow the stack.
 */
function deepFreeze<T>(root: T): T {
  let top: FreezeFrame | null = { node: root, below: null };
  while (top !== null) {
    const node: unknown = top.node;
    top = top.below;
    if (node === null || typeof node !== "object") continue;
    freeze(node);
    const keys = ownKeys(node);
    for (let i = 0; i < keys.length; i++) {
      const member = ownDataValue(node, keys[i]);
      if (member !== ABSENT && member !== ACCESSOR) top = { node: member, below: top };
    }
  }
  return root;
}

/** One node of the walk: the value, the node it hangs from and the key it hangs under, and the frame below it on the stack. */
interface WalkFrame {
  readonly value: unknown;
  readonly parent: WalkFrame | null;
  readonly key: PropertyKey | null;
  readonly below: WalkFrame | null;
}

/** The field of a node in a refusal: `rootField` plus the keys on the way down, e.g. `events[0].payload.list[2]`. */
function walkField(rootField: string, frame: WalkFrame): string {
  const segments: string[] = [];
  for (let at: WalkFrame | null = frame; at !== null && at.parent !== null; at = at.parent) {
    const key = String(at.key); // a symbol key reads as Symbol(description)
    segments.push(isArray(at.parent.value) || typeof at.key === "symbol" ? `[${key}]` : `.${key}`);
  }
  let field = rootField;
  for (let i = segments.length - 1; i >= 0; i--) field += segments[i];
  return field;
}

/**
 * Whether an object that is no Proxy and no array is PLAIN: its prototype is null, or is itself a
 * prototype-less object that is no Proxy (the Object.prototype of this realm or of another one).
 * A class instance, Date, Map, typed array, Buffer or Error has a prototype that has a prototype,
 * so it is not plain; neither is an object whose prototype is a Proxy, which is never asked for ITS
 * prototype (that would run its `getPrototypeOf` trap). `node` must not be a Proxy.
 */
function hasPlainPrototype(node: object): boolean {
  const proto = getPrototypeOf(node);
  return proto === null || (!isProxy(proto) && getPrototypeOf(proto) === null);
}

/**
 * Refuse, before anything of it is read, every part of `root` that can run code: a Proxy at any
 * depth (its traps run on the first reflection call), an accessor anywhere (its getter runs on a
 * [[Get]]) and an object that is not plain (see `hasPlainPrototype`). Code that runs during a
 * snapshot or a digest can replace `Object.freeze`, `Buffer.from` or `Array.prototype.sort` for one
 * microtask and so leave the returned events mutable or change a digest (E7c), so it must never run
 * at all.
 *
 * The walk is iterative (depth cannot overflow the stack), uses only the captured functions, and
 * touches an object only after proving it is no Proxy: the own keys and descriptors of a non-Proxy
 * run no code. A node is enumerated only when it is an array or a plain object: any other object (a
 * Buffer, a typed array, a class instance, an Error) is refused here, before its members are
 * touched, which is O(1) where enumerating a large typed array is not and never reads an Error's
 * `stack`. An array is not asked for its prototype at all. Everything else JSON cannot carry (NaN, a
 * bigint, an undefined element, a cycle, a foreign-realm object ...) is left to the caller's own
 * checks, for events `canonicalSnapshot`, which runs next on a graph this walk has proven free of
 * Proxies and accessors. `seen` skips a node that was already walked, so a cycle ends the walk and
 * a shared node is walked once.
 */
function assertNoCodeRunningInput(root: unknown, rootField: string, seen: WeakSet<object>): void {
  let top: WalkFrame | null = { value: root, parent: null, key: null, below: null };
  while (top !== null) {
    const frame: WalkFrame = top;
    top = frame.below;
    const node = frame.value;
    if (node === null || (typeof node !== "object" && typeof node !== "function")) continue;
    if (isProxy(node)) {
      throw new EvidenceBlockInputError(
        printable(walkField(rootField, frame), 200),
        "is a Proxy: its traps run code, so it is refused before it is read",
      );
    }
    if (typeof node === "function" || weakSetHas(seen, node)) continue; // a function is no data: the caller's own checks refuse it
    weakSetAdd(seen, node);
    if (!isArray(node) && !hasPlainPrototype(node)) {
      throw new EvidenceBlockInputError(
        printable(walkField(rootField, frame), 200),
        "is not plain data (a non-plain object: its prototype is not Object.prototype or null)",
      );
    }
    const keys = ownKeys(node);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const member = ownDataValue(node, key);
      if (member === ACCESSOR || member === ABSENT) {
        throw new EvidenceBlockInputError(
          printable(walkField(rootField, { value: undefined, parent: frame, key, below: null }), 200),
          member === ACCESSOR
            ? "is an accessor property: its getter runs code, so it is refused before it is read"
            : "is a property that vanished while it was read",
        );
      }
      if (member !== null && (typeof member === "object" || typeof member === "function")) {
        top = { value: member, parent: frame, key, below: top };
      }
    }
  }
}

/**
 * The guard that every public entry point taking an object or an array runs FIRST on it (E7c, round
 * 2): nothing is read before the whole input is known to run no code. After it, fields are read
 * with `fieldOf` or `ownDataValue` only.
 */
function admit(root: unknown, rootField: string): void {
  assertNoCodeRunningInput(root, rootField, new WeakSetConstructor<object>());
}

/**
 * One own data field of an object that `admit` has passed: its value, or undefined when the object
 * has no such OWN property (the field's validator then refuses it by name; a property inherited from
 * a prototype, which a polluted Object.prototype could supply, never counts). Never a [[Get]]. An
 * accessor cannot be here after `admit`; if one were, it is refused, not read.
 */
function fieldOf(owner: object, key: string): unknown {
  const value = ownDataValue(owner, key);
  if (value === ACCESSOR) {
    throw new EvidenceBlockInputError(key, "is an accessor property: its getter runs code, so it is refused before it is read");
  }
  return value === ABSENT ? undefined : value;
}

/** Whether `owner` has an own property `key` whose descriptor owns `enumerable: true` (as #359's isEnumerable judges it). */
function isOwnEnumerable(owner: object, key: PropertyKey): boolean {
  const descriptor = getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) return false;
  const enumerable = getOwnPropertyDescriptor(descriptor, "enumerable");
  return enumerable !== undefined && enumerable.value === true;
}

/**
 * `list.push(value)` without looking `push` up on Array.prototype: the value becomes an own data
 * property at index `list.length`, DEFINED, never assigned, so no setter or read-only index on a
 * prototype is consulted. Only for arrays this module has just made.
 */
function appendTo<T>(list: T[], value: T): void {
  defineProperty(list, list.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
}

/**
 * A copy of `list` sorted ascending by UTF-16 code unit (the order `<` gives, which is the default
 * sort's). Heapsort in place over indices that already exist, as #359's canonicalize sorts keys: no
 * Array.prototype method is looked up, and it is O(n log n) however the input is ordered.
 */
function sortedCopy(list: readonly string[]): string[] {
  const copy: string[] = [];
  const count = list.length;
  for (let i = 0; i < count; i++) appendTo(copy, list[i]!);
  for (let root = (count - (count % 2)) / 2 - 1; root >= 0; root--) siftDown(copy, root, count);
  for (let end = count - 1; end > 0; end--) {
    const largest = copy[0]!;
    copy[0] = copy[end]!;
    copy[end] = largest;
    siftDown(copy, 0, end);
  }
  return copy;
}

function siftDown(list: string[], start: number, end: number): void {
  let root = start;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= end) return;
    if (child + 1 < end && list[child]! < list[child + 1]!) child++;
    if (!(list[root]! < list[child]!)) return;
    const moved = list[root]!;
    list[root] = list[child]!;
    list[child] = moved;
    root = child;
  }
}

/**
 * One event as deep-frozen plain data (E7b). The raw value is taken through `canonicalSnapshot`
 * (#359): canonicalize it from its own property descriptors, then parse the canonical text once.
 * No getter and no `toJSON` of the input runs, and what cannot be written as JSON exactly (an
 * accessor, NaN, a bigint, a class instance, a hole, ...) is refused rather than normalised, as the
 * JSON.stringify/parse round trip this replaces normalised NaN to null. The event is the snapshot's
 * own value, so nothing but the snapshot is ever hashed, returned or evaluated. A refusal names the
 * event and the member that caused it.
 *
 * The caller has already run `assertNoCodeRunningInput` over `event` (E7c): it holds no Proxy and no
 * accessor, so `canonicalSnapshot` runs none of the input's code here and nothing can replace a
 * global between the read and the freeze.
 */
function snapshotEvent(field: string, event: unknown): EvidenceEvent {
  let value: unknown;
  try {
    value = canonicalSnapshot(event).value;
  } catch (err) {
    if (err instanceof NonCanonicalValueError) {
      // `path` is rooted at "$" (the event itself); re-root it at the event's place in the bundle.
      const member = err.path.startsWith("$") ? err.path.slice(1) : `.${err.path}`;
      throw new EvidenceBlockInputError(
        printable(`${field}${member}`, 200),
        `is not plain JSON evidence data (${printable(err.message, 300)})`,
      );
    }
    throw new EvidenceBlockInputError(field, "could not be read as plain JSON evidence data");
  }
  if (value === null || typeof value !== "object" || isArray(value)) {
    throw new EvidenceBlockInputError(field, "expected an event object");
  }
  return deepFreeze(value as EvidenceEvent);
}

/** What `computeKernelSignedEventsRoot` returns: the root and the exact events it was derived from. */
export interface KernelSignedEventsSnapshot {
  /** The bundleHash as a bytes32 root. */
  readonly root: Bytes32Hex;
  /**
   * The events whose hashes were recomputed and checked, in the order given: deep-frozen plain
   * JSON, the snapshot that was hashed. Consumers evaluate THIS value, never the object they passed
   * in. Every plain object in it has no prototype (see `canonicalSnapshot`), so do not call
   * Object.prototype methods on one (obj.hasOwnProperty(k), String(obj)): use Object.keys, `in` or
   * Object.hasOwn.
   */
  readonly events: readonly EvidenceEvent[];
}

/**
 * The kernelSignedEventsRoot of ONE evidence bundle, derived from what its events
 * actually say rather than from the hashes it carries. `hashBundle` trusts each
 * `event.hash`, so on its own two bundles with different payloads and the same
 * carried hashes share a root.
 *
 * Input that can run code is refused before it is read (E7c; see the module header): a bundle that
 * is a Proxy, a bundle whose `events` or `bundleHash` is not an own DATA property (a getter on the
 * bundle runs code), an events array that is a Proxy, an element that is a hole or an accessor, and
 * a Proxy or an accessor anywhere inside an event. Each property is read from its own descriptor,
 * never with a [[Get]], so no code of the caller runs during this call and the snapshot cannot be
 * undone by a global that the input replaces. A caller that mutates globals itself is outside the
 * threat model; the captured intrinsics still make the snapshot freeze immune to later global
 * mutation.
 *
 * Each event is then snapshotted once with `canonicalSnapshot` (see `snapshotEvent`) over data
 * proven free of Proxies and accessors, so no getter, trap or `toJSON` runs. Anything JSON cannot
 * carry exactly is refused rather than normalised. Every event hash is recomputed with `hashEvent`
 * over that snapshot and must equal the carried `event.hash`; `hashBundle` is recomputed over the
 * snapshot and must equal `bundle.bundleHash`; an empty event list is refused. Throws
 * `EvidenceBlockInputError` on any failure, naming the event and the member that caused it.
 *
 * Returns `{ root, events }`. `events` is exactly the data whose hashes were recomputed and
 * checked: a consumer evaluates `events`, never the object it passed in, which a caller can mutate
 * after this returns. The result and every event in it are deep-frozen. This does not verify the
 * kernel signature, the session-key delegation, or that this is the one finalized bundle for the
 * settlement unit; see BOUNDARY in the module header.
 */
export async function computeKernelSignedEventsRoot(
  bundle: Pick<EvidenceBundle, "events" | "bundleHash">,
): Promise<KernelSignedEventsSnapshot> {
  if (bundle === null || typeof bundle !== "object") {
    throw new EvidenceBlockInputError("bundle", "expected an evidence bundle object");
  }
  // Admission (E7c). Everything up to the first `await` runs without any code of the caller: the
  // Proxy test comes before any other operation on a value (Array.isArray throws on a revoked
  // Proxy), and each property is read exactly once, from its own descriptor.
  if (isProxy(bundle)) {
    throw new EvidenceBlockInputError("bundle", "is a Proxy: its traps run code, so it is refused before it is read");
  }
  const rawEvents = readBundleProperty(bundle, "events");
  const carriedBundleHash = readBundleProperty(bundle, "bundleHash");
  if (isProxy(rawEvents)) {
    throw new EvidenceBlockInputError("events", "is a Proxy: its traps run code, so it is refused before it is read");
  }
  if (!isArray(rawEvents)) {
    throw new EvidenceBlockInputError("events", "expected an array of evidence events");
  }
  const count = ownDataValue(rawEvents, "length");
  if (typeof count !== "number" || !isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError("events", "expected at least one event (an empty bundle commits to nothing)");
  }
  const seen = new WeakSetConstructor<object>();
  const events: EvidenceEvent[] = [];
  for (let i = 0; i < count; i++) {
    const field = `events[${i}]`;
    const element = ownDataValue(rawEvents, i);
    if (element === ABSENT || element === ACCESSOR) {
      throw new EvidenceBlockInputError(
        field,
        element === ABSENT
          ? "is a hole in the events array: an element must be an own data property"
          : "is an accessor element of the events array: its getter runs code, so it is refused before it is read",
      );
    }
    assertNoCodeRunningInput(element, field, seen);
    appendTo(events, snapshotEvent(field, element));
  }
  // The array is frozen before any other code is handed it (hashBundle receives it below).
  freeze(events);
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
  return freeze({ root: taggedDigestToBytes32(bundleHash), events });
}

/**
 * A property of the bundle, read from its OWN descriptor (E7c): a data property or a refusal, never
 * a [[Get]]. A getter on the bundle runs caller code, and so does a getter the bundle inherits from
 * its class, so neither is invoked; a missing property, or one that is only inherited, is refused
 * too. `bundle` must not be a Proxy.
 */
function readBundleProperty(bundle: object, field: "events" | "bundleHash"): unknown {
  const value = ownDataValue(bundle, field);
  if (value === ACCESSOR) {
    throw new EvidenceBlockInputError(
      field,
      "is an accessor property of the bundle: a getter on the bundle runs code, so it is refused before it is read (pass the bundle as plain data)",
    );
  }
  if (value === ABSENT) {
    throw new EvidenceBlockInputError(field, "is required as an own data property of the bundle (a missing or inherited one is refused)");
  }
  return value;
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
const SESSION_SCOPE_FIELDS = [
  "allowedActions",
  "contractIds",
  "maxSignatures",
] as const satisfies readonly (keyof SessionKeyAuthorization["scope"])[];

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
  // The Proxy test comes first: Array.isArray throws on a revoked Proxy, and a Proxy answers with its own code.
  return value !== null && typeof value === "object" && !isProxy(value) && !isArray(value) && hasPlainPrototype(value);
}

/** Whether `key` is one of `allowed` (a loop, so no Array.prototype method is looked up). */
function isListedKey(allowed: readonly string[], key: string): boolean {
  for (let i = 0; i < allowed.length; i++) if (allowed[i] === key) return true;
  return false;
}

/**
 * The pre-pass over an object that `admit` has already passed: it must be a plain object whose own
 * keys are all listed, string-keyed, enumerable DATA properties, each judged from its own
 * descriptor so an accessor is never invoked (after `admit` none can be here; one is still refused,
 * never read). Returns the object; its fields are then read with `requiredField` and `fieldOf`.
 */
function checkListedFields(path: string, input: unknown, allowed: readonly string[]): object {
  if (!isPlainObject(input)) {
    throw new EvidenceBlockInputError(path, "expected a plain object (not null, an array, a Proxy or a class instance)");
  }
  const keys = ownKeys(input);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (typeof key === "symbol" || !isListedKey(allowed, key)) {
      throw new EvidenceBlockInputError(path, `unknown own key ${JSON.stringify(String(key).slice(0, 64))}`);
    }
    const value = ownDataValue(input, key);
    if (value === ACCESSOR || value === ABSENT) {
      throw new EvidenceBlockInputError(`${path}.${key}`, "accessor properties are not accepted; pass plain data");
    }
    if (!isOwnEnumerable(input, key)) {
      throw new EvidenceBlockInputError(`${path}.${key}`, "expected an enumerable data property");
    }
  }
  return input;
}

/** A required own data field of an object `checkListedFields` has passed. */
function requiredField(path: string, owner: object, key: string): unknown {
  const value = ownDataValue(owner, key);
  if (value === ABSENT) {
    throw new EvidenceBlockInputError(`${path}.${key}`, "is required");
  }
  if (value === ACCESSOR) {
    throw new EvidenceBlockInputError(`${path}.${key}`, "accessor properties are not accepted; pass plain data");
  }
  return value;
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
const SESSION_PUBLIC_KEY_HEX_LENGTH = 64;
const SESSION_PARENT_SIGNATURE_HEX_LENGTH = 128;

function requirePinnedHex(field: string, value: unknown, hexLength: number, expected: string): string {
  if (!isBareLowerHex(value, hexLength)) {
    throw new EvidenceBlockInputError(field, expected);
  }
  return value;
}

/**
 * A frozen copy of a dense, plain array of strings in the one canonical order: strictly ascending
 * by UTF-16 code unit (plain JS `<`, which is what the default Array.prototype.sort produces), so
 * a duplicate is out of order too. An empty array is allowed. Each element is read once, from its
 * own descriptor, and the order is judged on that copy, so what is checked is what is committed.
 * An array that is not in canonical order is refused at the first element that breaks it, never
 * sorted or de-duplicated: one authorization has one digest.
 */
function readCanonicalStringSet(path: string, input: unknown): readonly string[] {
  if (isProxy(input) || !isArray(input)) {
    throw new EvidenceBlockInputError(path, "expected a plain array of strings");
  }
  const length = ownDataValue(input, "length");
  if (typeof length !== "number" || ownKeys(input).length !== length + 1) {
    throw new EvidenceBlockInputError(path, "expected a dense array with no extra properties");
  }
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const element = ownDataValue(input, i);
    if (element === ABSENT || element === ACCESSOR || !isOwnEnumerable(input, i)) {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected an enumerable data element");
    }
    if (typeof element !== "string") {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected a string");
    }
    appendTo(out, element);
  }
  for (let i = 1; i < out.length; i++) {
    if (!(out[i - 1] < out[i])) {
      const canonical = "expected strictly ascending UTF-16 code-unit order, the canonical form [...new Set(xs)].sort()";
      throw new EvidenceBlockInputError(
        `${path}[${i}]`,
        out[i - 1] === out[i] ? `duplicate of the previous element: ${canonical}` : `out of order: ${canonical}`,
      );
    }
  }
  return freeze(out);
}

/**
 * Snapshot a session-key authorization: validate it and copy it into a deep-frozen plain
 * value, reading every property exactly once. The authorization is admitted first (E7c, round 2:
 * `assertNoCodeRunningInput`, the same guard as every other entry point), so a Proxy at any depth,
 * an accessor anywhere and a non-plain object are refused before anything is read. An unknown own
 * key is refused too, so validation and the digest cannot observe different values. The scope
 * arrays must already be in canonical order (strictly ascending, see the module header): an array
 * that is not is refused, never reordered. `digest` is computed over the frozen copy. Consumers must
 * evaluate `value`, never the original object: it is the exact value that was hashed.
 */
export function sessionKeyAuthSnapshot(auth: SessionKeyAuthorization): SessionKeyAuthSnapshot {
  const path = "sessionKeyAuthorization";
  admit(auth, path);
  const top = checkListedFields(path, auth, SESSION_KEY_AUTH_FIELDS);
  const sessionId = requireNonEmptyString(`${path}.sessionId`, requiredField(path, top, "sessionId"));
  const parentAgentId = requireNonEmptyString(`${path}.parentAgentId`, requiredField(path, top, "parentAgentId"));
  const publicKey = requirePinnedHex(
    `${path}.publicKey`,
    requiredField(path, top, "publicKey"),
    SESSION_PUBLIC_KEY_HEX_LENGTH,
    "expected 64 lowercase hex characters with no 0x prefix (the raw 32-byte Ed25519 key)",
  );
  const issuedAt = boundedInt(`${path}.issuedAt`, requiredField(path, top, "issuedAt"), 0, MAX_SAFE_INTEGER);
  const expiresAt = boundedInt(`${path}.expiresAt`, requiredField(path, top, "expiresAt"), 0, MAX_SAFE_INTEGER);
  const parentSignature = requirePinnedHex(
    `${path}.parentSignature`,
    requiredField(path, top, "parentSignature"),
    SESSION_PARENT_SIGNATURE_HEX_LENGTH,
    "expected 128 lowercase hex characters with no 0x prefix (the 64-byte parent signature)",
  );
  // An optional field that is absent or undefined is the same value: canonicalize omits undefined.
  const derivationRaw = fieldOf(top, "derivationPath");
  const derivationPath =
    derivationRaw === undefined ? undefined : requireNonEmptyString(`${path}.derivationPath`, derivationRaw);

  const scopePath = `${path}.scope`;
  const scope = checkListedFields(scopePath, requiredField(path, top, "scope"), SESSION_SCOPE_FIELDS);
  const allowedActions = readCanonicalStringSet(`${scopePath}.allowedActions`, requiredField(scopePath, scope, "allowedActions"));
  const contractIds = readCanonicalStringSet(`${scopePath}.contractIds`, requiredField(scopePath, scope, "contractIds"));
  const maxSignatures = boundedInt(`${scopePath}.maxSignatures`, requiredField(scopePath, scope, "maxSignatures"), 0, MAX_SAFE_INTEGER);

  const value: FrozenSessionKeyAuthorization = freeze({
    sessionId,
    parentAgentId,
    publicKey,
    issuedAt,
    expiresAt,
    scope: freeze({ allowedActions, contractIds, maxSignatures }),
    parentSignature,
    ...(derivationPath === undefined ? {} : { derivationPath }),
  });
  return freeze({ value, digest: sha256Canonical(value) });
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

/** 1-128 printable ASCII characters, no whitespace (`isToken`): the pinned form of a roleId and of the attestation job id. */
function requireToken(field: string, value: unknown): string {
  if (!isToken(value)) {
    throw new EvidenceBlockInputError(field, "expected 1-128 printable ASCII characters with no whitespace");
  }
  return value;
}

/** A safe integer in [min, max]. Negative zero is refused: it is not the pinned spelling of 0. */
function boundedInt(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !isSafeInteger(value) || (value === 0 && 1 / value < 0) || value < min || value > max) {
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
 * Validate one role and copy it into frozen plain data. The role has already been admitted by
 * the entry point (`admit`: no Proxy, no accessor, a plain prototype, at any depth), so every field
 * and every array element is read exactly once from its own data descriptor, never with a [[Get]],
 * and nothing is inherited from a prototype: only the copy is validated and hashed.
 */
function snapshotAttestationRole(path: string, input: unknown): AttestationRoleSnapshot {
  if (input === null || typeof input !== "object") {
    throw new EvidenceBlockInputError(path, "expected a role object");
  }
  const roleIdRaw = fieldOf(input, "roleId");
  const minPositiveRaw = fieldOf(input, "minPositive");
  const totalRaw = fieldOf(input, "total");
  const minScoreRaw = fieldOf(input, "minScore");
  const hashesRaw = fieldOf(input, "attestationHashes");

  const roleId = requireToken(`${path}.roleId`, roleIdRaw);
  const total = boundedInt(`${path}.total`, totalRaw, 1, MAX_SAFE_INTEGER);
  const minPositive = boundedInt(`${path}.minPositive`, minPositiveRaw, 1, MAX_SAFE_INTEGER);
  if (minPositive > total) {
    throw new EvidenceBlockInputError(`${path}.minPositive`, "must not exceed total");
  }
  const minScore = boundedInt(`${path}.minScore`, minScoreRaw, 0, 100);

  if (isProxy(hashesRaw) || !isArray(hashesRaw)) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "expected an array of attestation hashes");
  }
  const count = ownDataValue(hashesRaw, "length");
  if (typeof count !== "number" || !isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "expected at least one attestation hash");
  }
  if (count > total) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "more attestation hashes than total");
  }
  const attestationHashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hash = ownDataValue(hashesRaw, i);
    if (!isPrefixedLowerHex(hash, 64)) {
      // A hole, an accessor (none can be here after `admit`) and a malformed hash are all this refusal.
      throw new EvidenceBlockInputError(`${path}.attestationHashes[${i}]`, "expected 0x + 64 lowercase hex");
    }
    appendTo(attestationHashes, hash);
  }
  const distinct = new SetConstructor<string>();
  for (let i = 0; i < count; i++) {
    const hash = attestationHashes[i]!;
    if (setHas(distinct, hash)) {
      throw new EvidenceBlockInputError(`${path}.attestationHashes`, "attestation hashes must be distinct");
    }
    setAdd(distinct, hash);
  }
  return freeze({ roleId, minPositive, total, minScore, attestationHashes: freeze(attestationHashes) });
}

/** Validate and snapshot a whole role set, already admitted by the entry point: at least one role, distinct roleIds. */
function snapshotAttestationRoles(input: unknown): readonly AttestationRoleSnapshot[] {
  if (isProxy(input) || !isArray(input)) {
    throw new EvidenceBlockInputError("roles", "expected an array of roles");
  }
  const count = ownDataValue(input, "length");
  if (typeof count !== "number" || !isSafeInteger(count) || count < 1) {
    throw new EvidenceBlockInputError("roles", "expected at least one role (the mirror defines no empty attestation set)");
  }
  const roles: AttestationRoleSnapshot[] = [];
  const seen = new SetConstructor<string>();
  for (let i = 0; i < count; i++) {
    const element = ownDataValue(input, i);
    // A hole (and an accessor, which `admit` has already refused) is no role.
    const role = snapshotAttestationRole(`roles[${i}]`, element === ABSENT || element === ACCESSOR ? undefined : element);
    if (setHas(seen, role.roleId)) {
      throw new EvidenceBlockInputError(`roles[${i}].roleId`, `duplicate roleId ${JSON.stringify(role.roleId)}`);
    }
    setAdd(seen, role.roleId);
    appendTo(roles, role);
  }
  return freeze(roles);
}

function roleDigestOf(job: string, role: AttestationRoleSnapshot): Bytes32Hex {
  return sha256Canonical({
    roleId: role.roleId,
    minPositive: role.minPositive,
    total: role.total,
    minScore: role.minScore,
    job,
    hashes: sortedCopy(role.attestationHashes),
  });
}

/**
 * One role's digest: binds roleId, its quorum config, the job and its sorted attestations.
 * The role is admitted first (`assertNoCodeRunningInput`: no Proxy at any depth, no accessor
 * anywhere, a plain prototype), then validated and snapshotted from its own data descriptors; only
 * the snapshot is hashed.
 */
export function computeAttestationRoleDigest(job: string, role: AttestationQuorumRole): Bytes32Hex {
  const checkedJob = requireToken("job", job);
  admit(role, "role");
  return roleDigestOf(checkedJob, snapshotAttestationRole("role", role));
}

/**
 * The attestation set root: sha256 of the sorted role digests. The whole set is admitted first (as
 * for `computeAttestationRoleDigest`), then validated and snapshotted before anything is hashed:
 * duplicate roleIds, duplicate attestation hashes, an empty set, an empty role and an invalid
 * quorum are refused, never silently de-duplicated.
 */
export function computeAttestationSetRoot(job: string, roles: readonly AttestationQuorumRole[]): Bytes32Hex {
  const checkedJob = requireToken("job", job);
  admit(roles, "roles");
  const snapshot = snapshotAttestationRoles(roles);
  const digests: string[] = [];
  for (let i = 0; i < snapshot.length; i++) appendTo(digests, roleDigestOf(checkedJob, snapshot[i]!));
  return sha256Canonical(sortedCopy(digests));
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
 * own. See BOUNDARY in the module header. The object is admitted first (a getter, a Proxy or a
 * non-plain prototype is refused unread) and each root is read from its own data descriptor, so no
 * code of the caller runs while the block hash is computed.
 */
export function computeEvidenceBlockHash(roots: EvidenceBlockRoots): Bytes32Hex {
  if (roots === null || typeof roots !== "object") {
    throw new EvidenceBlockInputError("roots", "expected an object holding the six roots");
  }
  admit(roots, "roots");
  return keccakWords([
    bytes32Word("EVIDENCE_BLOCK_DOMAIN_V2", EVIDENCE_BLOCK_DOMAIN_V2),
    uintWord("version", EVIDENCE_BLOCK_VERSION, 16),
    bytes32Word("unitContextDigest", fieldOf(roots, "unitContextDigest")),
    bytes32Word("kernelSignedEventsRoot", fieldOf(roots, "kernelSignedEventsRoot")),
    bytes32Word("sessionKeyAuthDigest", fieldOf(roots, "sessionKeyAuthDigest")),
    bytes32Word("attestationSetRoot", fieldOf(roots, "attestationSetRoot")),
    bytes32Word("workProductRoot", fieldOf(roots, "workProductRoot")),
    bytes32Word("programHash", fieldOf(roots, "programHash")),
  ]);
}
