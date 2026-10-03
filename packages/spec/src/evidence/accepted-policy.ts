/**
 * acceptedPolicyDigest — the PUBLIC producer (evidence lane, implementer-uniform).
 *
 * The V-next escrow's CREATE2 policy salt (`VNextSettlementLib.computePolicySalt`,
 * `packages/contracts/src/libraries/VNextSettlementLib.sol`) takes `acceptedPolicyDigest`
 * as an OPAQUE bytes32 input; `packages/contracts/ts/vnext/compiler.ts` only ever carries
 * it through (`PolicyIdentityFields.acceptedPolicyDigest`, `JobPolicyFields.acceptedPolicyDigest`).
 * Nothing on master computes it. The private oracle recomputes it independently at settle
 * (oracle #4506); this module is the PUBLIC, pure counterpart composition's accept route
 * (#391) and escrow's encoder (#367) both need, so neither duplicates the encoding
 * (composition -> evidence, bus #4720; "no duplication, go ahead").
 *
 *   acceptedPolicyDigest = keccak256(abi.encode(
 *     bytes32 POLICY_DOMAIN, uint16 POLICY_VERSION,
 *     bytes32 termsHash, bytes32 subjectBlockHash, bytes32 bindingsRoot))
 *
 *   subjectBlockHash = keccak256(abi.encode(bytes32 SUBJECT_DOMAIN, <18 fields>))
 *     (field order + byte widths: bus #1174, #4569; golden mirror
 *     `packages/verifier/test-vectors/canonical-acceptedjobpolicy-v1-mirror.cjs` on #270)
 *   bindingsRoot = keccak256(abi.encode(tuple(bytes32,bytes32,uint8,uint8,bytes32)[]
 *     evidenceSubjectBindings)), canonical-sorted by (planUnitKey, requirementIdHash),
 *     one binding per requirementIdHash (sol #786 swap-attack fix; evidence #4569).
 *
 * Neither subjectBlockHash nor bindingsRoot takes a deal-derived input (confirmed,
 * bus #4569, re oracle #4506 item 2): no field here is defined from acceptedDealDigest,
 * the sealed deal bytes, or a units manifest. That is what lets a units manifest sit
 * inside the sealed v3 preimage without circularity (oracle N37).
 *
 * `termsHash` is an INPUT here, never derived: the oracle has not confirmed a public
 * derivation for it (composition #4720 item 2), so this module does not compute it.
 *
 * ── Layer 1 (this file, shipped): the pure encodings, byte-exact with the #270 mirror ──
 *   computeSubjectBlockHash  — the 18 already-committed subject fields -> subjectBlockHash.
 *   computeBindingsRoot      — the evidenceSubjectBindings array -> bindingsRoot.
 *   computeAcceptedPolicyDigest — {termsHash, subjectBlockHash, bindingsRoot} -> the digest.
 *   computePlanUnitKey       — the chain-independent per-unit key (evidence #876) that
 *     SubjectBinding.planUnitKey must equal; takes no deal input either, so it ships
 *     alongside the three digest functions. Composition and escrow RECOMPUTE it from the
 *     authenticated plan by ordinal; they never trust a binding's self-label (that is
 *     what defeats the rA<->rB swap attack sol found).
 * None of the four takes a deal object, a plan id or a composition section: the property
 * that no deal input reaches them is proven in accepted-policy.test.ts by feeding two
 * fixtures that differ ONLY outside these declared fields and checking the digests match.
 *
 * ── Layer 2 (NOT shipped here): acceptedPolicyDigestForJob(job, deployment, termsHash) ──
 * Composition's declared accept-time inputs (bus #4720) are the compiled plan's job
 * (operator, payer, units: milestoneIndex, stepId, g/f/n, fee, feeRecipient, reclaimAt,
 * compositionRoot, payouts — see `packages/spec/src/csd/accepted-plan-compiler.ts`
 * `CompiledJob`/`UnitConfigInput`) and the deployment config (chainId, factory, token,
 * policyNonce — see `VNextSettlementLib.computePolicySalt`,
 * `packages/contracts/ts/vnext/compiler.ts`).
 *
 * Of subjectBlockHash's 18 fields, only `planUnitKey` (inside each evidenceSubjectBinding,
 * via `computePlanUnitKey(unitOrdinal, milestoneIndex, stepId)`) is fully determined by
 * (job, deployment, termsHash). Every other field is populated by an operator's AUTHORITY
 * POLICY (which evidence requirements apply, the expert/executor sets, the recipient and
 * target-system identity, the committed program, ...) — a selection the compiled-plan
 * `job` object does not carry at all; it is a payments/settlement shape (operator, payer,
 * fees, payouts), not an evidence-requirements shape. Per field:
 *   - payer, operatorPrincipal, operatorSettlementAddress: subject-block `payer` /
 *     `operatorPrincipal` are "Principal" bytes32 refs (golden mirror comment,
 *     `canonical-acceptedjobpolicy-v1-mirror.cjs:47-49`), not addresses; no
 *     address -> Principal derivation is defined anywhere in @pcc/spec (checked:
 *     `identity/ephemeral.ts`, `csd/compose-root-types.ts` define a `Principal` shape
 *     but no address conversion). `job.payer`/`job.operator` are addresses.
 *   - authorizedTuplesRoot, expertSetRoot, executorSetRoot, expectedRecipient,
 *     targetSystemIdentity, committedProgramHash, recipeRef, sampleManifestRef,
 *     operatingEnvelopeHash, expectedRouteArea, expectedLocationHash, integrityGrade:
 *     authority-policy / evidence-requirement selections. No such data exists on
 *     `CompiledJob` or the deployment config.
 *   - childrenRoot: needs each child's (childJobId, childEscrow); childEscrow is the
 *     child clone's CREATE2 prediction, which itself needs that child's own
 *     acceptedPolicyDigest first (a sequencing dependency across the plan's jobs, not a
 *     per-job computation). Evidence -> composition (bus #4569): "Some values are
 *     job-bound, and their producer chooses them. That producer is the policy builder,
 *     which nobody has built yet: nothing on master builds a policy."
 *   - captureNonceAnchor, challengeAnchor: "fixed before seal from jobIdHash, plus a
 *     nonce chosen before seal" (bus #4569) — a fresh nonce input this module's declared
 *     inputs (job, deployment, termsHash) do not supply.
 *   - evidenceSubjectBindings' requirementIdHash/sourceKind/propositionKind/valueRef
 *     (beyond planUnitKey): each binding states which evidence requirement backs a unit
 *     and where its value comes from — again the authority-policy selection, absent from
 *     `CompiledJob`.
 * STOPPED per the task's own rule (build Layer 2 ONLY where every field is fully
 * determined): shipping a function that silently filled 17 of 18 subject fields and 4 of
 * 5 binding fields with placeholders would produce a WRONG, fabricated digest while
 * looking like a real one — worse than not shipping it. The owner of the missing mapping
 * is the not-yet-built "policy builder" (bus #4569's term): whoever turns an operator's
 * authority policy into a `SubjectBlockFields` + `SubjectBinding[]` per job. Until that
 * exists, composition's accept route and escrow's encoder can call `computePlanUnitKey`
 * today, and the three digest functions once they (or the policy builder) have assembled
 * the other 17 fields.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export type Bytes32Hex = `0x${string}`;
export type AddressHex = `0x${string}`;
/** A uint accepted in any of the three pinned spellings; see `uintWord`. */
export type UintInput = bigint | number | string;

// ── Proxy detection, ported from #361's technique (evidence-block.ts, unmerged on
// wt-evidence-block), not imported: that file is on a different, unmerged worktree. The
// host's `util.types.isProxy` is taken ONCE at module load from
// `process.getBuiltinModule("node:util")` (Node >= 20.16 / >= 22.3) rather than a static
// `import { types } from "node:util"`, because a browser bundle (the dashboard's Vite
// build) has no `node:util` and a static import of it fails that build (#361). Where the
// runtime cannot give it, the module still LOADS, and every exported function throws
// `AcceptedPolicyDigestInputError("runtime", ...)` before it reads its input: with no way
// to tell a Proxy, an unknown is never a "no". ──────────────────────────────────────────

/** What `takeHostIsProxy` looks for on `globalThis.process`, spelled out so no `@types/node` version matters. */
type BuiltinModuleHost = { getBuiltinModule?: (id: string) => { types?: { isProxy?: unknown } } | undefined };

function takeHostIsProxy(): ((value: unknown) => boolean) | undefined {
  try {
    const host = (globalThis as unknown as { process?: BuiltinModuleHost }).process;
    const candidate = host?.getBuiltinModule?.("node:util")?.types?.isProxy;
    return typeof candidate === "function" ? (candidate as (value: unknown) => boolean) : undefined;
  } catch {
    return undefined;
  }
}

// Captured at module load, as #361/#359 do, so a global replaced afterward (Reflect.*,
// Array.isArray, Number.isSafeInteger, util.types.isProxy, ...) cannot change what the
// guards below see.
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const getPrototypeOf = Reflect.getPrototypeOf;
const isSafeInteger = Number.isSafeInteger;
const toBigInt = BigInt;
const hostIsProxy = takeHostIsProxy();

const PROXY_DETECTION_UNAVAILABLE =
  "accepted-policy needs Node's util.types.isProxy (Node >= 20.16 / 22.3) to refuse code-running input; it is unavailable in this runtime";

export class AcceptedPolicyDigestInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`acceptedPolicyDigest input ${field}: ${reason}`);
    this.name = "AcceptedPolicyDigestInputError";
    this.field = field;
  }
}

/** Whether `value` is a Proxy, live or revoked. Throws (never answers "no") where the runtime cannot tell. */
function isProxy(value: unknown): boolean {
  if (hostIsProxy === undefined) {
    throw new AcceptedPolicyDigestInputError("runtime", PROXY_DETECTION_UNAVAILABLE);
  }
  return hostIsProxy(value);
}

/**
 * Whether a non-Proxy, non-array object is PLAIN: prototype null, or itself a
 * prototype-less, non-Proxy object (this realm's or another's `Object.prototype`). A class
 * instance, Date, Map, typed array, Buffer or Error is refused; so is an object whose
 * prototype is a Proxy (never asked for ITS prototype, which would run a trap).
 */
function hasPlainPrototype(node: object): boolean {
  const proto = getPrototypeOf(node);
  return proto === null || (!isProxy(proto) && getPrototypeOf(proto) === null);
}

/** Admits a plain, non-array object: refuses null/non-object, a Proxy, an array, or a non-plain prototype. */
function admitPlainObject(value: unknown, field: string): object {
  if (value === null || typeof value !== "object") {
    throw new AcceptedPolicyDigestInputError(field, "expected a plain object");
  }
  if (isProxy(value)) {
    throw new AcceptedPolicyDigestInputError(field, "is a Proxy: its traps run code, so it is refused before it is read");
  }
  if (isArray(value) || !hasPlainPrototype(value)) {
    throw new AcceptedPolicyDigestInputError(field, "expected a plain object (not an array, Proxy or class instance)");
  }
  return value;
}

/** Admits a plain, dense array (own keys are exactly the indices plus "length"): refuses null/non-object, a Proxy, or a non-array. */
function admitPlainArray(value: unknown, field: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    throw new AcceptedPolicyDigestInputError(field, "expected an array");
  }
  if (isProxy(value)) {
    throw new AcceptedPolicyDigestInputError(field, "is a Proxy: its traps run code, so it is refused before it is read");
  }
  if (!isArray(value)) {
    throw new AcceptedPolicyDigestInputError(field, "expected a plain array");
  }
  const length = ownDataValue(value, "length");
  if (typeof length !== "number" || !isSafeInteger(length) || length < 0 || ownKeys(value).length !== length + 1) {
    throw new AcceptedPolicyDigestInputError(field, "expected a dense array with no extra or missing elements");
  }
  return value as readonly unknown[];
}

/** What `ownDataValue` returns for a missing property and for an accessor. Module-private, so neither can equal a value read from input. */
const ABSENT = Symbol("accepted-policy: no such own property");
const ACCESSOR = Symbol("accepted-policy: accessor property");

/**
 * The value of `owner`'s own DATA property `key` (enumerable or not), or ABSENT / ACCESSOR.
 * Read entirely through descriptors obtained via the captured
 * `Reflect.getOwnPropertyDescriptor` — never a [[Get]], so no getter and no Proxy trap ever
 * runs, and the descriptor objects themselves (freshly minted by the engine for every call,
 * per `FromPropertyDescriptor`) cannot be a Proxy or carry an accessor, so reading their
 * `value`/`get`/`set` is safe. Enumerability is a SEPARATE concern, checked only where it
 * matters (`isOwnEnumerable`, used by `checkExactKeys` on caller-declared fields): a real
 * array's own `length` is permanently non-enumerable by spec (and permanently a data
 * property — `[[DefineOwnProperty]]` refuses to make an Array exotic object's `length` an
 * accessor), so a general-purpose reader must not treat non-enumerable as suspect on its
 * own. `owner` must already be proven not a Proxy (`admitPlainObject`/`admitPlainArray`).
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

/** Whether `owner` has an own property `key` whose descriptor owns `enumerable: true`. `owner` must not be a Proxy. */
function isOwnEnumerable(owner: object, key: PropertyKey): boolean {
  const descriptor = getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) return false;
  const enumerable = getOwnPropertyDescriptor(descriptor, "enumerable");
  return enumerable !== undefined && enumerable.value === true;
}

/**
 * Checks that `owner`'s own keys are EXACTLY `allowed` (sol-style pinning: "nothing
 * unknown"), each an ENUMERABLE own DATA property (never an accessor: a getter runs code,
 * so it is refused before it is read; never non-enumerable: a hidden field pretending not
 * to be there is refused, not silently skipped). `owner` must already be
 * `admitPlainObject`-checked.
 */
function checkExactKeys(owner: object, field: string, allowed: readonly string[]): void {
  const keys = ownKeys(owner);
  if (keys.length !== allowed.length) {
    throw new AcceptedPolicyDigestInputError(field, `expected exactly the keys [${allowed.join(", ")}]`);
  }
  for (const key of keys) {
    if (typeof key === "symbol" || !allowed.includes(key)) {
      throw new AcceptedPolicyDigestInputError(field, `unknown key ${String(key).slice(0, 64)}`);
    }
    if (ownDataValue(owner, key) === ACCESSOR || !isOwnEnumerable(owner, key)) {
      throw new AcceptedPolicyDigestInputError(`${field}.${key}`, "accessor or non-enumerable properties are not accepted; pass plain data");
    }
  }
}

/** One required own data field of an object `checkExactKeys` has already passed; re-checked here, read via `ownDataValue`, never a [[Get]]. */
function requiredField(owner: object, field: string, key: string): unknown {
  const value = ownDataValue(owner, key);
  if (value === ABSENT || value === ACCESSOR) {
    throw new AcceptedPolicyDigestInputError(`${field}.${key}`, "is required as a plain own data property");
  }
  return value;
}

// ── Pinned input forms: 0x + lowercase hex of exact width; canonical decimal integers; no -0. ──

const HEX_DIGITS = "0123456789abcdef";

function isLowerHexBody(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLowerAF = c >= 97 && c <= 102;
    if (!isDigit && !isLowerAF) return false;
  }
  return true;
}

function isPrefixedLowerHex(value: unknown, hexLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length === hexLength + 2 &&
    value.charCodeAt(0) === 48 && // '0'
    value.charCodeAt(1) === 120 && // 'x'
    isLowerHexBody(value, 2, hexLength + 2)
  );
}

/** A non-negative decimal integer with no leading zero (what /^(0|[1-9][0-9]*)$/ matches). */
function isCanonicalDecimal(value: string): boolean {
  const length = value.length;
  if (length === 0) return false;
  if (value.charCodeAt(0) === 48) return length === 1; // "0" only, never "0N"
  for (let i = 0; i < length; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/** 32 bytes from a validated `0x` + 64-lowercase-hex string. */
function hexToWord(hex: string, byteOffset: number, byteLength: number): Uint8Array {
  const word = new Uint8Array(32);
  for (let i = 0; i < byteLength; i++) {
    const hi = hexNibble(hex.charCodeAt(2 + 2 * i));
    const lo = hexNibble(hex.charCodeAt(2 + 2 * i + 1));
    word[byteOffset + i] = hi * 16 + lo;
  }
  return word;
}

/** A bytes32 field, pinned to `0x` + exactly 64 lowercase hex characters. */
function bytes32Word(field: string, value: unknown): Uint8Array {
  if (!isPrefixedLowerHex(value, 64)) {
    throw new AcceptedPolicyDigestInputError(field, "expected 0x + 64 lowercase hex characters");
  }
  return hexToWord(value, 0, 32);
}

/** An address field, pinned to `0x` + exactly 40 lowercase hex characters, right-aligned into a 32-byte word. */
function addressWord(field: string, value: unknown): Uint8Array {
  if (!isPrefixedLowerHex(value, 40)) {
    throw new AcceptedPolicyDigestInputError(field, "expected 0x + 40 lowercase hex characters (lowercase address)");
  }
  const word = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    const hi = hexNibble(value.charCodeAt(2 + 2 * i));
    const lo = hexNibble(value.charCodeAt(2 + 2 * i + 1));
    word[12 + i] = hi * 16 + lo;
  }
  return word;
}

/**
 * A `uintBits`-wide field as a 32-byte big-endian word. Accepts a bigint, a non-negative
 * safe-integer number, or a canonical decimal string (no leading zero); refuses negative
 * zero (`Number.isSafeInteger(-0)` is true and `BigInt(-0)` is `0n`, so `-0` would reach
 * the same word as `0` without this check — it is not the pinned spelling of zero).
 */
function uintWord(field: string, value: unknown, uintBits: number): Uint8Array {
  let n: bigint;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!isSafeInteger(value)) {
      throw new AcceptedPolicyDigestInputError(field, "expected a safe integer");
    }
    if (value === 0 && 1 / value < 0) {
      throw new AcceptedPolicyDigestInputError(field, "negative zero is not a pinned input form; pass 0");
    }
    n = toBigInt(value);
  } else if (typeof value === "string") {
    if (!isCanonicalDecimal(value)) {
      throw new AcceptedPolicyDigestInputError(field, "expected a canonical decimal integer string (no leading zero, no sign)");
    }
    n = toBigInt(value);
  } else {
    throw new AcceptedPolicyDigestInputError(field, "expected a non-negative integer (bigint, safe number, or decimal string)");
  }
  if (n < 0n || n >= 1n << toBigInt(uintBits)) {
    throw new AcceptedPolicyDigestInputError(field, `out of range for uint${uintBits}`);
  }
  const word = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    word[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return word;
}

function bytesToHex(bytes: Uint8Array): Bytes32Hex {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    out += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  }
  return out as Bytes32Hex;
}

function keccakWords(words: readonly Uint8Array[]): Bytes32Hex {
  const buf = new Uint8Array(words.length * 32);
  for (let w = 0; w < words.length; w++) {
    buf.set(words[w]!, w * 32);
  }
  return bytesToHex(keccak_256(buf));
}

function keccakUtf8(label: string): Bytes32Hex {
  return bytesToHex(keccak_256(new TextEncoder().encode(label)));
}

// ── Domain separators + version (evidence-owned; mirror `canonical-acceptedjobpolicy-v1-mirror.cjs`) ──

export const SUBJECT_DOMAIN: Bytes32Hex = keccakUtf8("PCC:vnext:accepted-policy-subjects:v1");
export const POLICY_DOMAIN: Bytes32Hex = keccakUtf8("PCC:vnext:accepted-job-policy:v1");
export const PLANUNIT_DOMAIN: Bytes32Hex = keccakUtf8("PCC:vnext:plan-unit-key:v1");
export const POLICY_VERSION = 1;

// ── Layer 1: the pure encodings ──────────────────────────────────────────────────────

/** The 18 already-committed fields `computeSubjectBlockHash` hashes, in ABI order (bus #1174, #4569). */
export interface SubjectBlockFields {
  payer: Bytes32Hex;
  operatorPrincipal: Bytes32Hex;
  operatorSettlementAddress: AddressHex;
  authorizedTuplesRoot: Bytes32Hex;
  expertSetRoot: Bytes32Hex;
  executorSetRoot: Bytes32Hex;
  expectedRecipient: Bytes32Hex;
  targetSystemIdentity: Bytes32Hex;
  committedProgramHash: Bytes32Hex;
  recipeRef: Bytes32Hex;
  sampleManifestRef: Bytes32Hex;
  childrenRoot: Bytes32Hex;
  operatingEnvelopeHash: Bytes32Hex;
  expectedRouteArea: Bytes32Hex;
  expectedLocationHash: Bytes32Hex;
  captureNonceAnchor: Bytes32Hex;
  challengeAnchor: Bytes32Hex;
  integrityGrade: UintInput;
}

const SUBJECT_BLOCK_KEYS = [
  "payer",
  "operatorPrincipal",
  "operatorSettlementAddress",
  "authorizedTuplesRoot",
  "expertSetRoot",
  "executorSetRoot",
  "expectedRecipient",
  "targetSystemIdentity",
  "committedProgramHash",
  "recipeRef",
  "sampleManifestRef",
  "childrenRoot",
  "operatingEnvelopeHash",
  "expectedRouteArea",
  "expectedLocationHash",
  "captureNonceAnchor",
  "challengeAnchor",
  "integrityGrade",
] as const satisfies readonly (keyof SubjectBlockFields)[];

// Compile-time guard: a field added to SubjectBlockFields must be added above (and given
// an encoding rule in computeSubjectBlockHash) before this module compiles.
type AssertNever<T extends never> = T;
type SubjectFieldsMissingFromKeyList = AssertNever<Exclude<keyof SubjectBlockFields, (typeof SUBJECT_BLOCK_KEYS)[number]>>;

/**
 * subjectBlockHash = keccak256(abi.encode(SUBJECT_DOMAIN, <18 fields>)), byte-exact with
 * the #270 mirror. Takes the 18 fields directly (already-committed roots and scalars, not
 * the raw sets/arrays that feed them — those belong to whoever assembles the subject
 * block, see the module header's Layer 2 boundary). No field here is deal-derived.
 *
 * `subject` is admitted first (no Proxy, no accessor, exactly these 18 keys, nothing
 * unknown) before any field is read, then every field is read once from its own data
 * descriptor and encoded in its pinned form.
 */
export function computeSubjectBlockHash(subject: SubjectBlockFields): Bytes32Hex {
  const admitted = admitPlainObject(subject, "subject");
  checkExactKeys(admitted, "subject", SUBJECT_BLOCK_KEYS);
  const f = (key: (typeof SUBJECT_BLOCK_KEYS)[number]) => requiredField(admitted, "subject", key);
  return keccakWords([
    bytes32Word("SUBJECT_DOMAIN", SUBJECT_DOMAIN),
    bytes32Word("subject.payer", f("payer")),
    bytes32Word("subject.operatorPrincipal", f("operatorPrincipal")),
    addressWord("subject.operatorSettlementAddress", f("operatorSettlementAddress")),
    bytes32Word("subject.authorizedTuplesRoot", f("authorizedTuplesRoot")),
    bytes32Word("subject.expertSetRoot", f("expertSetRoot")),
    bytes32Word("subject.executorSetRoot", f("executorSetRoot")),
    bytes32Word("subject.expectedRecipient", f("expectedRecipient")),
    bytes32Word("subject.targetSystemIdentity", f("targetSystemIdentity")),
    bytes32Word("subject.committedProgramHash", f("committedProgramHash")),
    bytes32Word("subject.recipeRef", f("recipeRef")),
    bytes32Word("subject.sampleManifestRef", f("sampleManifestRef")),
    bytes32Word("subject.childrenRoot", f("childrenRoot")),
    bytes32Word("subject.operatingEnvelopeHash", f("operatingEnvelopeHash")),
    bytes32Word("subject.expectedRouteArea", f("expectedRouteArea")),
    bytes32Word("subject.expectedLocationHash", f("expectedLocationHash")),
    bytes32Word("subject.captureNonceAnchor", f("captureNonceAnchor")),
    bytes32Word("subject.challengeAnchor", f("challengeAnchor")),
    uintWord("subject.integrityGrade", f("integrityGrade"), 8),
  ]);
}

/** One `evidenceSubjectBindings` entry: which requirement backs a plan unit, and where its value comes from. */
export interface SubjectBinding {
  /** Chain-independent (evidence #876): `computePlanUnitKey(unitOrdinal, milestoneIndex, stepId)`. */
  planUnitKey: Bytes32Hex;
  requirementIdHash: Bytes32Hex;
  sourceKind: UintInput;
  propositionKind: UintInput;
  valueRef: Bytes32Hex;
}

const SUBJECT_BINDING_KEYS = [
  "planUnitKey",
  "requirementIdHash",
  "sourceKind",
  "propositionKind",
  "valueRef",
] as const satisfies readonly (keyof SubjectBinding)[];
type BindingFieldsMissingFromKeyList = AssertNever<Exclude<keyof SubjectBinding, (typeof SUBJECT_BINDING_KEYS)[number]>>;

interface PinnedBinding {
  planUnitKeyHex: string;
  requirementIdHashHex: string;
  words: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
}

/**
 * bindingsRoot = keccak256(abi.encode(tuple(bytes32,bytes32,uint8,uint8,bytes32)[]
 * evidenceSubjectBindings)), byte-exact with the #270 mirror. Canonical-sorted by
 * (planUnitKey, requirementIdHash) so the caller's array order never changes the root (sol
 * #786 f1); a duplicate requirementIdHash is refused (globally unique, sol #786 NO-GO #6 /
 * evidence #4569) rather than silently de-duplicated, so one binding set has one root.
 *
 * `bindings` is admitted first as a dense, non-Proxy array; each element is then admitted
 * as a plain object with exactly these 5 keys before any of its fields is read.
 */
export function computeBindingsRoot(bindings: readonly SubjectBinding[]): Bytes32Hex {
  const admittedArray = admitPlainArray(bindings, "bindings");
  const pinned: PinnedBinding[] = [];
  for (let i = 0; i < admittedArray.length; i++) {
    const field = `bindings[${i}]`;
    const admitted = admitPlainObject(admittedArray[i], field);
    checkExactKeys(admitted, field, SUBJECT_BINDING_KEYS);
    const f = (key: (typeof SUBJECT_BINDING_KEYS)[number]) => requiredField(admitted, field, key);
    const planUnitKeyValue = f("planUnitKey");
    const requirementIdHashValue = f("requirementIdHash");
    const planUnitKeyW = bytes32Word(`${field}.planUnitKey`, planUnitKeyValue);
    const requirementIdHashW = bytes32Word(`${field}.requirementIdHash`, requirementIdHashValue);
    pinned.push({
      planUnitKeyHex: planUnitKeyValue as string,
      requirementIdHashHex: requirementIdHashValue as string,
      words: [
        planUnitKeyW,
        requirementIdHashW,
        uintWord(`${field}.sourceKind`, f("sourceKind"), 8),
        uintWord(`${field}.propositionKind`, f("propositionKind"), 8),
        bytes32Word(`${field}.valueRef`, f("valueRef")),
      ],
    });
  }
  const seenRequirementIds = new Set<string>();
  for (let i = 0; i < pinned.length; i++) {
    const id = pinned[i]!.requirementIdHashHex;
    if (seenRequirementIds.has(id)) {
      throw new AcceptedPolicyDigestInputError(`bindings[${i}].requirementIdHash`, `duplicate requirementIdHash ${id} (must be globally unique)`);
    }
    seenRequirementIds.add(id);
  }
  // Pinned forms are same-length lowercase hex strings, so plain `<`/`>` gives the same
  // order as comparing the underlying bytes (canonical-sort, mirror lines 115-123).
  const sorted = [...pinned].sort((a, b) => {
    if (a.planUnitKeyHex < b.planUnitKeyHex) return -1;
    if (a.planUnitKeyHex > b.planUnitKeyHex) return 1;
    if (a.requirementIdHashHex < b.requirementIdHashHex) return -1;
    if (a.requirementIdHashHex > b.requirementIdHashHex) return 1;
    return 0;
  });
  const words: Uint8Array[] = [encodeUint(32n), encodeUint(toBigInt(sorted.length))];
  for (const entry of sorted) words.push(...entry.words);
  return bytesToHex(keccak_256(concatWords(words)));
}

/** A bare 32-byte big-endian word for a trusted (already-range-checked) non-negative bigint. */
function encodeUint(n: bigint): Uint8Array {
  const word = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    word[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return word;
}

function concatWords(words: readonly Uint8Array[]): Uint8Array {
  const buf = new Uint8Array(words.length * 32);
  for (let i = 0; i < words.length; i++) buf.set(words[i]!, i * 32);
  return buf;
}

/** The three already-computed roots `computeAcceptedPolicyDigest` combines. */
export interface AcceptedPolicyDigestInputs {
  /** An INPUT, never derived here: the oracle has not confirmed a public termsHash derivation (bus #4720 item 2). */
  termsHash: Bytes32Hex;
  subjectBlockHash: Bytes32Hex;
  bindingsRoot: Bytes32Hex;
}

const ACCEPTED_POLICY_DIGEST_KEYS = [
  "termsHash",
  "subjectBlockHash",
  "bindingsRoot",
] as const satisfies readonly (keyof AcceptedPolicyDigestInputs)[];
type DigestInputFieldsMissingFromKeyList = AssertNever<Exclude<keyof AcceptedPolicyDigestInputs, (typeof ACCEPTED_POLICY_DIGEST_KEYS)[number]>>;

/**
 * acceptedPolicyDigest = keccak256(abi.encode(POLICY_DOMAIN, uint16 POLICY_VERSION,
 * termsHash, subjectBlockHash, bindingsRoot)), byte-exact with the #270 mirror. No deal
 * input reaches this: it takes exactly the three already-computed roots, nothing else.
 */
export function computeAcceptedPolicyDigest(inputs: AcceptedPolicyDigestInputs): Bytes32Hex {
  const admitted = admitPlainObject(inputs, "inputs");
  checkExactKeys(admitted, "inputs", ACCEPTED_POLICY_DIGEST_KEYS);
  const f = (key: (typeof ACCEPTED_POLICY_DIGEST_KEYS)[number]) => requiredField(admitted, "inputs", key);
  return keccakWords([
    bytes32Word("POLICY_DOMAIN", POLICY_DOMAIN),
    uintWord("POLICY_VERSION", POLICY_VERSION, 16),
    bytes32Word("inputs.termsHash", f("termsHash")),
    bytes32Word("inputs.subjectBlockHash", f("subjectBlockHash")),
    bytes32Word("inputs.bindingsRoot", f("bindingsRoot")),
  ]);
}

/**
 * planUnitKey = keccak256(abi.encode(PLANUNIT_DOMAIN, uint32 unitOrdinal,
 * uint256 milestoneIndex, bytes32 stepId)) — chain-independent (evidence #876): no
 * chainId/escrow/address input, so it carries no fixed-point cycle back through
 * acceptedPolicyDigest -> bindingsRoot -> escrow's CREATE2 salt. `unitOrdinal` is the
 * position in the committed `UnitConfig[]` (composition #892 -> escrow #893), NOT
 * `milestoneIndex`: composition and escrow recompute this from the AUTHENTICATED plan by
 * ordinal, never from a binding's self-label, which is what defeats sol's unit-swap
 * attack (rA->unitB, rB->unitA).
 */
export function computePlanUnitKey(unitOrdinal: UintInput, milestoneIndex: UintInput, stepId: Bytes32Hex): Bytes32Hex {
  return keccakWords([
    bytes32Word("PLANUNIT_DOMAIN", PLANUNIT_DOMAIN),
    uintWord("unitOrdinal", unitOrdinal, 32),
    uintWord("milestoneIndex", milestoneIndex, 256),
    bytes32Word("stepId", stepId),
  ]);
}
