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
 * INPUT THAT CAN RUN CODE IS REFUSED BEFORE IT IS READ (E7c). A Proxy runs its traps on every
 * reflection operation and an accessor runs its getter on every [[Get]]. Code that runs while the
 * snapshot is being made can replace `Object.freeze` (or `Reflect.*`) for one microtask, so that the
 * freezes become no-ops and the returned events stay mutable, or can answer a later read
 * differently: the events a consumer evaluates could then differ from the events that were
 * committed. So `computeKernelSignedEventsRoot` refuses, before it reads a value from it:
 *   - a bundle that is a Proxy, and a bundle whose `events` or `bundleHash` is not an OWN DATA
 *     property (a getter on the bundle, a getter inherited from a class, a missing property). Each
 *     is read from its own descriptor, never with a [[Get]];
 *   - an events array that is a Proxy, and an element that is a hole or an accessor;
 *   - a Proxy anywhere inside an event, and an accessor anywhere inside an event
 *     (`assertNoCodeRunningInput`: an iterative walk that touches only what cannot run code), and
 *     an object that `canonicalize` would refuse as non-plain, whose members are never enumerated.
 * What is left is `canonicalSnapshot` over a graph proven free of Proxies and accessors, so no code
 * of the input runs during the call. What this module uses to inspect and freeze caller-supplied
 * objects is a reference captured when it loads (`Object.freeze`, `Array.isArray`,
 * `Reflect.ownKeys`, `Reflect.getOwnPropertyDescriptor`, `Reflect.getPrototypeOf`,
 * `Number.isSafeInteger`, `util.types.isProxy`), as #359's canonical.ts does for the encoder, so a
 * global replaced after load cannot turn the freeze of the snapshot into a no-op. A caller that
 * replaces globals itself is outside the threat model: it already runs arbitrary code in this
 * process.
 *
 * The session authorization is snapshotted before it is hashed (E7 F3, F4): a frozen
 * plain copy of exactly the declared fields, read once, with `publicKey` pinned to 64
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

// What this module uses to inspect and freeze caller-supplied objects is captured here, when the
// module loads, and the code below calls only these references (#359's canonical.ts does the same
// for the encoder). A global replaced AFTER this point (Object.freeze, Reflect.ownKeys,
// util.types.isProxy ...) cannot change what the freezes, the key enumeration, the array and Proxy
// tests below do: in particular the snapshot's freeze cannot be made a no-op. The traversal of the
// two walks below (`assertNoCodeRunningInput` and `deepFreeze`) looks nothing up at call time:
// `set.has(v)` and `arr.push(v)` would find a method on the object, so they use the bound captures
// and linked frames instead. (Only the text of a refusal is built with ordinary calls.)
const freeze = Object.freeze;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const getPrototypeOf = Reflect.getPrototypeOf;
const isSafeInteger = Number.isSafeInteger;
const isProxy = utilTypes.isProxy;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const WeakSetConstructor = WeakSet;
const call = Function.prototype.call;
const weakSetAdd = call.bind(WeakSet.prototype.add) as unknown as (set: WeakSet<object>, value: object) => void;
const weakSetHas = call.bind(WeakSet.prototype.has) as unknown as (set: WeakSet<object>, value: unknown) => boolean;

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
  else if (typeof value === "number" && isSafeInteger(value)) {
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
 * Refuse, before anything of it is read, every part of `root` that can run code: a Proxy at any
 * depth (its traps run on the first reflection call) and an accessor anywhere (its getter runs on a
 * [[Get]]). Code that runs during the snapshot can replace `Object.freeze` for one microtask and so
 * leave the returned events mutable (E7c), so it must never run at all.
 *
 * The walk is iterative (depth cannot overflow the stack), uses only the captured functions, and
 * touches an object only after proving it is no Proxy: the own keys and descriptors of a non-Proxy
 * run no code. A node is enumerated only when `canonicalize` would descend into it too, a plain
 * object or an ordinary array: any other object (a Buffer, a typed array, a class instance, an Error)
 * is refused here, before its members are touched, which is exactly what `canonicalize` does with it
 * and is O(1) where enumerating a large typed array is not. Everything else JSON cannot carry (NaN, a
 * bigint, an undefined element, a cycle ...) is left to `canonicalSnapshot`, which runs next on a
 * graph this walk has proven free of Proxies and accessors. `seen` skips a node that was already
 * walked, so a cycle ends the walk and a shared node is walked once.
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
    if (typeof node === "function" || weakSetHas(seen, node)) continue; // a function is no JSON data: canonicalSnapshot refuses it
    weakSetAdd(seen, node);
    const proto = getPrototypeOf(node);
    if (isArray(node) ? proto !== ARRAY_PROTOTYPE : proto !== OBJECT_PROTOTYPE && proto !== null) {
      throw new EvidenceBlockInputError(
        printable(walkField(rootField, frame), 200),
        isArray(node)
          ? "is not plain JSON evidence data (an array with a substituted prototype or an Array subclass)"
          : "is not plain JSON evidence data (a non-plain object: its prototype is not Object.prototype or null)",
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
    events.push(snapshotEvent(field, element));
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
  if (value === null || typeof value !== "object" || isProxy(value) || isArray(value)) {
    return false;
  }
  // The Object.prototype of any realm has a null prototype itself; class instances, Map and Date do not.
  // A prototype that is a Proxy is refused unasked: asking it for ITS prototype would run its trap.
  const proto = getPrototypeOf(value);
  return proto === null || (!isProxy(proto) && getPrototypeOf(proto) === null);
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
  for (const key of ownKeys(input)) {
    if (typeof key === "symbol" || !allowed.includes(key)) {
      throw new EvidenceBlockInputError(path, `unknown own key ${JSON.stringify(String(key).slice(0, 64))}`);
    }
    const descriptor = getOwnPropertyDescriptor(input, key);
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

/**
 * A frozen copy of a dense, plain array of strings in the one canonical order: strictly ascending
 * by UTF-16 code unit (plain JS `<`, which is what the default Array.prototype.sort produces), so
 * a duplicate is out of order too. An empty array is allowed. Each element is read once, through
 * its descriptor, and the order is judged on that copy, so what is checked is what is committed.
 * An array that is not in canonical order is refused at the first element that breaks it, never
 * sorted or de-duplicated: one authorization has one digest.
 */
function readCanonicalStringSet(path: string, input: unknown): readonly string[] {
  if (isProxy(input) || !isArray(input)) {
    throw new EvidenceBlockInputError(path, "expected a plain array of strings");
  }
  const length = input.length;
  if (ownKeys(input).length !== length + 1) {
    throw new EvidenceBlockInputError(path, "expected a dense array with no extra properties");
  }
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = getOwnPropertyDescriptor(input, i);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected an enumerable data element");
    }
    if (typeof descriptor.value !== "string") {
      throw new EvidenceBlockInputError(`${path}[${i}]`, "expected a string");
    }
    out.push(descriptor.value);
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
 * value, reading every property exactly once. An unknown own key, an accessor property, a
 * non-plain object or a Proxy is refused, so validation and the digest cannot observe
 * different values. The scope arrays must already be in canonical order (strictly ascending,
 * see the module header): an array that is not is refused, never reordered. `digest` is
 * computed over the frozen copy. Consumers must evaluate `value`, never the original object:
 * it is the exact value that was hashed.
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
  const allowedActions = readCanonicalStringSet(`${scopePath}.allowedActions`, requiredField(scopePath, scopeFields, "allowedActions"));
  const contractIds = readCanonicalStringSet(`${scopePath}.contractIds`, requiredField(scopePath, scopeFields, "contractIds"));
  const maxSignatures = boundedInt(
    `${scopePath}.maxSignatures`,
    requiredField(scopePath, scopeFields, "maxSignatures"),
    0,
    Number.MAX_SAFE_INTEGER,
  );

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
  if (typeof value !== "number" || !isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
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

  if (!isArray(hashesRaw)) {
    throw new EvidenceBlockInputError(`${path}.attestationHashes`, "expected an array of attestation hashes");
  }
  const count = hashesRaw.length;
  if (!isSafeInteger(count) || count < 1) {
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
  return freeze({ roleId, minPositive, total, minScore, attestationHashes: freeze(attestationHashes) });
}

/** Validate and snapshot a whole role set: at least one role, distinct roleIds. */
function snapshotAttestationRoles(input: unknown): readonly AttestationRoleSnapshot[] {
  if (!isArray(input)) {
    throw new EvidenceBlockInputError("roles", "expected an array of roles");
  }
  const count = input.length;
  if (!isSafeInteger(count) || count < 1) {
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
  return freeze(roles);
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
