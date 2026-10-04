/**
 * Evidence Emitter — collects evidence events from all device adapters,
 * hashes them, and assembles signed Evidence Bundles.
 *
 * This is the core integrity component of the Shop Kernel. It ensures
 * every evidence event is content-addressed and every bundle is
 * cryptographically signed.
 *
 * What code that replaces a method or global AFTER this module loads can and cannot do (astra
 * packs 273, 277; steward #6651, #6668). Every call this file makes goes through a binding
 * captured in the block below, a function or class declared in this file, or a JS private member
 * of the emitter; the one other call is finalizeBundle's, to the callbacks registered with
 * onBundle. evidence-emitter-order.test.ts checks that over this file's syntax with a closed
 * allowlist, which also refuses the forms that call without a call expression (for-of, spread,
 * instanceof, an await on a promise whose constructor is not pinned). So replacing
 * Map.prototype.get or set, Promise.prototype.then or constructor, crypto.subtle.digest,
 * node:crypto's exports, RegExp.prototype.test, Array.prototype.push or @pcc/spec's ids after
 * load changes nothing the emitter stores or hashes, nor the digest it hands its signer. Exactly
 * what that covers:
 *   - Hardened all the way down: the intrinsics below, @pcc/spec's canonicalize (built on spec's
 *     own load-time intrinsics), and node:crypto's one-shot hash, a native binding. The emitter
 *     hashes with it, synchronously, byte for byte as spec's hashEvent and hashBundle do. It uses
 *     neither spec's sha256 nor createHash: the first resolves through Promise.prototype.then
 *     inside Node's async digest, and the second reads its hash through an internal handle an
 *     accessor planted on Hash.prototype can replace.
 *   - Captured, but each looks up what it uses when it runs: spec's ids functions (Date.now,
 *     Math.random, Number.prototype.toString, String.prototype.substring: replacements of those
 *     run and can choose an id, which no hash covers, but are handed nothing of an event), spec's
 *     isFabricated and kernelPullCaptureIssue (they decide checkTierRequirements' answer for the
 *     events its caller passes, and touch no stored record), and Sentry.startSpan (it chains on the
 *     archive's promise, so getLastIpfsResult depends on it, and nothing else does).
 *   - Trusted collaborators: the signFn given to the constructor, the storage service given to
 *     setStorageService (its isReady and archiveBundle are bound then) and the onBundle callbacks.
 *     Each is handed only the bundle digest or the finalized bundle, which shares no object with
 *     what is stored; what each does with it, and what it looks up meanwhile, is its own code.
 *   - Promises: each promise the emitter awaits or returns gets its own `constructor`, the Promise
 *     captured below (pinned()), so an await takes it as it is and consults nothing on
 *     Promise.prototype. The links of a step's chain fulfil with undefined. A promise that fulfils
 *     with an object (an event or a bundle for a caller, or a collaborator's result) reads that
 *     object's `then`, as every promise does: an Object.prototype.then planted after load can
 *     change what a caller receives, never what is stored or hashed.
 *   - The boundary, as in @pcc/spec's util/primordials.ts: a realm whose intrinsics were replaced
 *     BEFORE this module loaded hands it the replaced ones. Load @pcc/kernel before untrusted code.
 */

import type {
  EvidenceEvent,
  EvidenceBundle,
  AssuranceTier,
  SHA256,
  Signature,
  TierEvidenceRequirements,
  Address,
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS, KERNEL_PULL_CAPTURE_TYPES, isFabricated, kernelPullCaptureIssue } from "@pcc/spec";
import { canonicalize, ids } from "@pcc/spec";
import { hash as nodeHash } from "node:crypto";
import { types } from "node:util";
import type { EvidenceStorageService, ArchiveResult } from "./evidence-storage.js";
import * as Sentry from "@sentry/node";

// -- captured when this module loads (astra packs 273, 277; steward #6651, #6668) --
// The only bindings this file calls besides its own functions and the emitter's private members
// (see the module comment). Nothing below is looked up again when the emitter runs.
const FunctionPrototype = Function.prototype;
/** uncurryThis(fn)(self, ...args) calls the ORIGINAL fn with `this` = self, through the original `call`. */
const uncurryThis = FunctionPrototype.bind.bind(FunctionPrototype.call) as <T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
) => (self: T, ...args: A) => R;
const StructuredClone = globalThis.structuredClone;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectDefineProperty = Object.defineProperty;
const ObjectCreate = Object.create;
const ObjectPrototypeHasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty) as (o: object, key: PropertyKey) => boolean;
const ReflectOwnKeys = Reflect.ownKeys;
const ArrayIsArray = Array.isArray;
const NumberIsFinite = Number.isFinite;
const NumberIsInteger = Number.isInteger;
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectPrototype = Object.prototype;
const ArrayPrototype = Array.prototype;
const ErrorCtor = Error;
const PromiseCtor = Promise;
const MapCtor = Map;
const MapPrototypeGet = uncurryThis(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
const MapPrototypeSet = uncurryThis(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const MapPrototypeDelete = uncurryThis(Map.prototype.delete) as <K, V>(map: Map<K, V>, key: K) => boolean;
const MapPrototypeGetSize = uncurryThis(ObjectGetOwnPropertyDescriptor(Map.prototype, "size")!.get!) as (map: Map<unknown, unknown>) => number;
const WeakSetCtor = WeakSet;
const WeakSetPrototypeAdd = uncurryThis(WeakSet.prototype.add) as (set: WeakSet<object>, value: object) => WeakSet<object>;
const WeakSetPrototypeHas = uncurryThis(WeakSet.prototype.has) as (set: WeakSet<object>, value: object) => boolean;
const DateCtor = Date;
const DatePrototypeToISOString = uncurryThis(Date.prototype.toISOString) as (date: Date) => string;
const StringPrototypeSlice = uncurryThis(String.prototype.slice) as (s: string, start?: number, end?: number) => string;
const StringPrototypeCharAt = uncurryThis(String.prototype.charAt) as (s: string, i: number) => string;
/** The console object as it was at load. Its warn is bound when an emitter is built, like the other collaborators. */
const ConsoleAtLoad = console;
/** Makes a bound function: used only where a collaborator is taken in (the constructor, setStorageService). */
const FunctionPrototypeBind = uncurryThis(FunctionPrototype.bind) as <F extends (...args: never[]) => unknown>(fn: F, thisArg: unknown) => F;
/** node:util's proxy and promise checks: they run no trap and no getter. */
const IsProxy = types.isProxy;
const IsPromise = types.isPromise;
/** node:crypto's one-shot digest: a native binding, synchronous, with no wrapper object or promise in between. */
const OneShotHash = nodeHash;
/** @pcc/spec's canonical JSON, built only on intrinsics spec captured when it loaded (its util/primordials.ts). */
const Canonicalize = canonicalize;
/** @pcc/spec's id functions: `ids` is a plain object any importer can assign to, so they are taken now. */
const IdsEvidence = ids.evidence;
const IdsBundle = ids.bundle;
const IsFabricated = isFabricated;
const KernelPullCaptureIssue = kernelPullCaptureIssue;
const SentryStartSpan = Sentry.startSpan;
/** The camera event types and the default tier requirements, copied: spec exports both as mutable arrays. */
const CameraTypes: readonly string[] = StructuredClone(KERNEL_PULL_CAPTURE_TYPES);
const DefaultTierRequirements: TierEvidenceRequirements[] = StructuredClone(DEFAULT_TIER_REQUIREMENTS);
// -- end of the load-time captures --

/** Whether `descriptor` describes a data property: it OWNS `value` (one written on Object.prototype is not its own). */
function isDataDescriptor(descriptor: PropertyDescriptor): boolean {
  return ObjectGetOwnPropertyDescriptor(descriptor, "value") !== undefined;
}

/** An own data property's value, read without running a getter or a Proxy trap; otherwise undefined. */
function ownDataValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== "object" || IsProxy(target)) return undefined;
  const descriptor = ObjectGetOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && isDataDescriptor(descriptor) ? descriptor.value : undefined;
}

/** The device that emitted `event`, named for a `missing` entry without running a getter or a trap. */
function deviceLabel(event: unknown): string {
  const deviceId = ownDataValue(ownDataValue(event, "source"), "deviceId");
  return typeof deviceId === "string" ? deviceId : "an unknown device";
}

/** In-memory store for evidence events per job step */
interface StepEvidence {
  jobId: string;
  stepId: string;
  events: EvidenceEvent[];
  assuranceTier: AssuranceTier;
  /** The escrow unit (milestone) and its challenge nonce, when the job names one: the emitter's own copy. */
  unit: StepUnitContext | undefined;
  /**
   * Settles once every addEvent called so far on the step has stored its event or failed. Each
   * call stores only after it, so the step's events are in call order (N123). It always fulfils,
   * with undefined.
   */
  stored: Promise<void>;
  /** Adds that took a place on the step and have not yet stored their event or failed. */
  pending: number;
  /** Set when the step is cleaned up: an add still pending then fails instead of storing. */
  detached: boolean;
}

/** `0x` + 64 lowercase hex each (LO-EV-9 unit binding). */
export interface StepUnitContext {
  settlementUnitId: string;
  challengeNonce: string;
}

/** Deeper than this, a value is refused rather than walked (a cycle, or a structure no device emits). */
const MAX_EVIDENCE_DEPTH = 64;

/** The input check's own refusals, recorded so they are told apart without instanceof (which runs a Symbol.hasInstance). */
const InputErrors = new WeakSetCtor<object>();

/** Why an event's input is not plain JSON data. Module-private, so nothing outside can raise one. */
class EvidenceInputError extends ErrorCtor {
  constructor(message: string) {
    super(message);
    WeakSetPrototypeAdd(InputErrors, this);
  }
}

/** Whether `value` is one of the input check's refusals. */
function isEvidenceInputError(value: unknown): value is EvidenceInputError {
  return typeof value === "object" && value !== null && WeakSetPrototypeHas(InputErrors, value);
}

/** A writable, enumerable, configurable data descriptor with no prototype, so no `get` or `set` written on Object.prototype is read as its own. */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = ObjectCreate(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/** Whether `o` has `key` as its OWN property, by the hasOwnProperty captured at load. */
function hasOwn(o: object, key: PropertyKey): boolean {
  return ObjectPrototypeHasOwnProperty(o, key);
}

/** The element of `list` at `index` if `list` owns it, else undefined: a hole never continues to Array.prototype (steward #6792). */
function listAt<T>(list: readonly T[], index: number): T | undefined {
  return hasOwn(list, index) ? list[index] : undefined;
}

/** `s`'s code unit at `i` as a string, "" past the end, by the charAt captured at load: no index reaches String.prototype. */
function charAt(s: string, i: number): string {
  return StringPrototypeCharAt(s, i);
}

/** Sets `record[key]` by defining it, never through [[Set]]: no setter written on a prototype runs (steward #6792). */
function defineField<T extends object, K extends keyof T>(record: T, key: K, value: T[K]): void {
  ObjectDefineProperty(record, key, dataDescriptor(value));
}

/** Puts `value` after `list`'s last element by defining it: no Array.prototype.push, no [[Set]] (astra pack 277). */
function append<T>(list: T[], value: T): void {
  ObjectDefineProperty(list, list.length, dataDescriptor(value));
}

/** The `constructor` pinned() gives a promise: the Promise captured at load, neither writable nor configurable. */
function pinnedConstructorDescriptor(): PropertyDescriptor {
  const descriptor = ObjectCreate(null) as PropertyDescriptor;
  descriptor.value = PromiseCtor;
  descriptor.writable = false;
  descriptor.enumerable = false;
  descriptor.configurable = false;
  return descriptor;
}

const PinnedConstructor = pinnedConstructorDescriptor();

/**
 * `value`, safe to await (steward #6668). A native promise gets its own `constructor`, the Promise
 * captured at load. An await first compares that with the intrinsic Promise, and when they match it
 * takes the promise as it is and calls no `then`, so a then, constructor or Symbol.species replaced
 * on Promise after load is never consulted. Anything else is returned as it is: a thenable a
 * collaborator returns runs its own then.
 */
function pinned<T>(value: T): T {
  if (IsPromise(value)) ObjectDefineProperty(value, "constructor", PinnedConstructor);
  return value;
}

/** An empty turn: the start of a step's chain. */
async function ready(): Promise<void> {}

/**
 * Stores `event` once the step's earlier adds have stored their events or failed (N123), unless the
 * step was cleaned up meanwhile (pack 259). It fulfils with undefined, or rejects with the reason it
 * did not store.
 */
async function storeInTurn(stepEv: StepEvidence, previous: Promise<void>, event: EvidenceEvent): Promise<void> {
  try {
    await pinned(previous);
    // Cleaned up while this add waited: nothing reads the record any more, so the event is not
    // stored and the call fails, rather than report storage nothing can see (pack 259).
    if (stepEv.detached) {
      throw new ErrorCtor(`step ${stepEv.stepId} of job ${stepEv.jobId} was cleaned up before this ${event.type} event was stored`);
    }
    // Stored by defining the element, never through Array.prototype.push: a push replaced after load
    // would be handed the stored event and could change it after it was hashed (astra pack 277).
    append(stepEv.events, event);
  } finally {
    defineField(stepEv, "pending", stepEv.pending - 1);
  }
}

/** Fulfils once `turn` has settled, and never rejects: the step's next add waits on it, whatever this add's outcome. */
async function settledTurn(turn: Promise<void>): Promise<void> {
  try {
    await pinned(turn);
  } catch {
    // The add reports its own failure to its caller.
  }
}

/** The step's record, if it is registered: two map levels, read through the Map methods captured at load. */
function stepRecord(steps: Map<string, Map<string, StepEvidence>>, jobId: string, stepId: string): StepEvidence | undefined {
  const byStep = MapPrototypeGet(steps, jobId);
  return byStep === undefined ? undefined : MapPrototypeGet(byStep, stepId);
}

/** `0x` and 64 lowercase hex digits, checked character by character: no RegExp, whose test and exec can be replaced. */
function isUnitField(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 66 || charAt(value, 0) !== "0" || charAt(value, 1) !== "x") return false;
  for (let i = 2; i < 66; i++) {
    const c = charAt(value, i);
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  return true;
}

/** `sha256:` and the hex SHA-256 of `text`'s UTF-8 bytes: what @pcc/spec's sha256 gives (it encodes with TextEncoder). */
function sha256Text(text: string): SHA256 {
  return `sha256:${OneShotHash("sha256", text, "hex")}` as SHA256;
}

/** @pcc/spec's hashEvent, byte for byte: the canonical JSON of the four fields an event's hash covers. */
function hashEventFields(input: EventInput): SHA256 {
  return sha256Text(Canonicalize({ type: input.type, timestamp: input.timestamp, source: input.source, payload: input.payload }));
}

/** `list`, sorted in place by UTF-16 code unit, which is how Array.prototype.sort orders strings without a comparator. */
function sortByCodeUnit(list: string[]): string[] {
  for (let i = 1; i < list.length; i++) {
    const s = listAt(list, i)!;
    let j = i - 1;
    while (j >= 0 && listAt(list, j)! > s) {
      ObjectDefineProperty(list, j + 1, dataDescriptor(listAt(list, j)));
      j--;
    }
    ObjectDefineProperty(list, j + 1, dataDescriptor(s));
  }
  return list;
}

/** @pcc/spec's hashBundle, byte for byte: the canonical JSON of the events' hashes, sorted. */
function hashBundleEvents(events: readonly EvidenceEvent[]): SHA256 {
  const hashes: string[] = [];
  for (let i = 0; i < events.length; i++) append(hashes, listAt(events, i)!.hash);
  return sha256Text(Canonicalize(sortByCodeUnit(hashes)));
}

/** Whether `list` holds `value`, compared as Array.prototype.includes and Set.prototype.has compare (SameValueZero), by index. */
function includesValue(list: readonly unknown[], value: unknown): boolean {
  for (let i = 0; i < list.length; i++) {
    const element = listAt(list, i);
    if (element === value || (element !== element && value !== value)) return true;
  }
  return false;
}

/** Whether any element `group` owns is in `values` (Array.prototype.some skips a hole). */
function someIncluded(group: readonly unknown[], values: readonly unknown[]): boolean {
  for (let i = 0; i < group.length; i++) {
    if (hasOwn(group, i) && includesValue(values, listAt(group, i))) return true;
  }
  return false;
}

/** `group` joined by `separator`, as Array.prototype.join joins it: null, undefined and a hole are written as nothing. */
function joinGroup(group: readonly unknown[], separator: string): string {
  let out = "";
  for (let i = 0; i < group.length; i++) {
    const element = listAt(group, i);
    if (i > 0) out += separator;
    if (element !== undefined && element !== null) out += `${element as string}`;
  }
  return out;
}

/** An own property of `target`, read from its descriptor: absent, or its value. An accessor is refused and never runs. */
function ownProperty(target: object, key: PropertyKey, at: string): { present: boolean; value: unknown } {
  const descriptor = ObjectGetOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!isDataDescriptor(descriptor)) throw new EvidenceInputError(`${at} is an accessor`);
  return { present: true, value: descriptor.value };
}

/**
 * The emitter's own copy of `value`, which must be plain JSON data (astra packs 265, 273): canonical
 * JSON has no faithful form for anything else. It hashes a Date, a Map, a Set, a RegExp or an Error as
 * {}, a typed array as an object of its indices, a SharedArrayBuffer's bytes as they are at that moment,
 * an undefined array element as null, an array hole, NaN and Infinity as text no JSON parser reads, an
 * array without its named members, and an object without an undefined member, which JSON drops too.
 * #359's canonicalize refuses all of these; the oracle and VCR also refuse D5's integers outside the
 * safe range.
 *
 * It reads only through own property descriptors and node:util's trap-free proxy check, and calls only
 * what was captured at load, so while it copies no getter, setter or Proxy trap of the input runs, and
 * no method or global replaced after load. An accessor, a proxy, a symbol-keyed, non-enumerable or
 * `__proto__` member, and `undefined` anywhere are refused. Plain data is null, a boolean, a string, a
 * finite number that is not an integer outside the safe range (D5; -0 is copied as 0, as JSON carries
 * it), an ordinary array whose every index holds plain data and which has no other member, and an
 * object whose prototype is Object.prototype or null and whose members are plain data. The copy is
 * made of ordinary arrays and objects, built by defining properties, so no setter runs.
 */
function copyPlain(value: unknown, at: string, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!NumberIsFinite(value)) throw new EvidenceInputError(`${at} is ${value}`);
    if (NumberIsInteger(value) && !NumberIsSafeInteger(value)) {
      throw new EvidenceInputError(`${at} is the integer ${value}, outside the safe range (D5: send it as a decimal string)`);
    }
    return value === 0 ? 0 : value;
  }
  if (value === undefined) throw new EvidenceInputError(`${at} is undefined (JSON has no undefined: omit the member)`);
  if (typeof value !== "object") throw new EvidenceInputError(`${at} is a ${typeof value}`);
  if (IsProxy(value)) throw new EvidenceInputError(`${at} is a proxy`);
  if (depth >= MAX_EVIDENCE_DEPTH) throw new EvidenceInputError(`${at} nests deeper than ${MAX_EVIDENCE_DEPTH}`);
  const prototype: unknown = ObjectGetPrototypeOf(value);
  if (ArrayIsArray(value)) {
    if (prototype !== ArrayPrototype) throw new EvidenceInputError(`${at} is not a plain array`);
    const length = ownProperty(value, "length", `${at}.length`).value as number;
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const element = ownProperty(value, i, `${at}[${i}]`);
      if (!element.present) throw new EvidenceInputError(`${at}[${i}] is a hole`);
      ObjectDefineProperty(out, i, dataDescriptor(copyPlain(element.value, `${at}[${i}]`, depth + 1)));
    }
    // Its own keys are its indices and "length", and nothing else.
    if (ReflectOwnKeys(value).length !== length + 1) throw new EvidenceInputError(`${at} has a member besides its elements`);
    return out;
  }
  if (prototype !== ObjectPrototype && prototype !== null) throw new EvidenceInputError(`${at} is not a plain object`);
  const out: Record<string, unknown> = {};
  const keys = ReflectOwnKeys(value);
  for (let k = 0; k < keys.length; k++) {
    const key = listAt(keys, k)!;
    if (typeof key === "symbol") throw new EvidenceInputError(`${at} has a symbol-keyed member`);
    if (key === "__proto__") throw new EvidenceInputError(`${at} has a member named __proto__`);
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key)!;
    if (!isDataDescriptor(descriptor)) throw new EvidenceInputError(`${at}.${key} is an accessor`);
    if (descriptor.enumerable !== true) throw new EvidenceInputError(`${at}.${key} is not enumerable`);
    ObjectDefineProperty(out, key, dataDescriptor(copyPlain(descriptor.value, `${at}.${key}`, depth + 1)));
  }
  return out;
}

/** The emitter's copy of exactly the four fields an event's hash covers. */
interface EventInput {
  type: string;
  timestamp: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * The four fields the hash covers, copied through own descriptors (copyPlain); the event's other
 * fields are never read. type and timestamp must be strings and source a plain object; an absent or
 * null payload is an empty one, as before.
 */
function copyEventInput(rawEvent: unknown): EventInput {
  if (rawEvent === null || typeof rawEvent !== "object" || IsProxy(rawEvent)) throw new EvidenceInputError("event is not a plain object");
  const type = ownProperty(rawEvent, "type", "event.type").value;
  const timestamp = ownProperty(rawEvent, "timestamp", "event.timestamp").value;
  const source = ownProperty(rawEvent, "source", "event.source").value;
  const payload = ownProperty(rawEvent, "payload", "event.payload").value;
  if (typeof type !== "string") throw new EvidenceInputError("event.type is not a string");
  if (typeof timestamp !== "string") throw new EvidenceInputError("event.timestamp is not a string");
  const sourceCopy = copyPlain(source, "event.source", 1);
  if (sourceCopy === null || typeof sourceCopy !== "object" || ArrayIsArray(sourceCopy)) {
    throw new EvidenceInputError("event.source is not an object");
  }
  const payloadCopy = payload === undefined || payload === null ? {} : copyPlain(payload, "event.payload", 1);
  if (payloadCopy === null || typeof payloadCopy !== "object" || ArrayIsArray(payloadCopy)) {
    throw new EvidenceInputError("event.payload is not an object");
  }
  return { type, timestamp, source: sourceCopy as Record<string, unknown>, payload: payloadCopy as Record<string, unknown> };
}

/** A payload member's own value (undefined when absent), read from the emitter's own copy. */
function ownMember(payload: Record<string, unknown>, field: string): unknown {
  const descriptor = ObjectGetOwnPropertyDescriptor(payload, field);
  return descriptor === undefined ? undefined : descriptor.value;
}

export class EvidenceEmitter {
  // Its state, its signer and its collaborators are JS private fields: code holding the emitter can
  // add properties to it, but cannot replace or read any of these (steward #6668).
  readonly #kernelId: string;
  /**
   * Steps by job, then by step id. Two map levels, never a joined `job:step` string, so ids such
   * as ("a:b", "c") and ("a", "b:c") never share a record (astra pack 259).
   */
  readonly #steps: Map<string, Map<string, StepEvidence>> = new MapCtor();
  /** The callbacks registered with onBundle. */
  readonly #listeners: Array<(bundle: EvidenceBundle) => void> = [];
  /**
   * Signing function — async to support HSM/TEE/wallet signers in production.
   * Receives the tagged bundle digest; an Ed25519 signer must sign
   * `signingPreimage(data)` from @pcc/spec (LO-EV-1), never the raw digest bytes.
   */
  readonly #signFn: (data: string) => Promise<Signature>;
  /** True when a real signing function was provided; false when using the test-only default */
  readonly #hasRealSignFn: boolean;
  /** console.warn as it was when the emitter was built, bound to console: the test-only signer's warning. */
  readonly #warn: (...data: unknown[]) => void;
  /** Optional IPFS storage service — when set, bundles are archived after finalization */
  #storage: EvidenceStorageService | null = null;
  /** The storage service's isReady and archiveBundle, bound to it when it was attached. */
  #storageIsReady: (() => boolean) | null = null;
  #storageArchive: ((bundle: EvidenceBundle) => Promise<ArchiveResult>) | null = null;
  /** Result from the most recent IPFS archive operation */
  #lastIpfsResult: ArchiveResult | undefined = undefined;

  constructor(
    kernelId: string,
    signFn?: (data: string) => Promise<Signature>,
  ) {
    this.#kernelId = kernelId;
    this.#hasRealSignFn = !!signFn;
    this.#warn = FunctionPrototypeBind(ConsoleAtLoad.warn, ConsoleAtLoad);
    // TEST-ONLY default — replace with a real wallet signFn in production
    this.#signFn = signFn ?? (async (data: string) => {
      this.#warn(
        "[evidence-emitter] WARNING: Using test-only signing key (zero address). " +
          "Evidence bundles are NOT cryptographically verified. " +
          "Set a real signing key in production.",
      );
      return {
        signer: "0x0000000000000000000000000000000000000000" as Address,
        algorithm: "secp256k1" as const,
        value: `test_sig_${StringPrototypeSlice(data, 0, 16)}`,
      };
    });
  }

  /** Returns true when using the test-only zero-address signing key. */
  isTestSigner(): boolean {
    return !this.#hasRealSignFn;
  }

  /**
   * Attach an IPFS storage service for automatic archiving. Its isReady and archiveBundle are bound
   * now, so replacing them on the service later changes nothing here.
   */
  setStorageService(service: EvidenceStorageService): void {
    this.#storageIsReady = FunctionPrototypeBind(service.isReady, service);
    this.#storageArchive = FunctionPrototypeBind(service.archiveBundle, service);
    this.#storage = service;
  }

  /** Get the attached storage service (if any) */
  getStorageService(): EvidenceStorageService | null {
    return this.#storage;
  }

  /** Get the IPFS archive result from the most recent finalizeBundle call */
  getLastIpfsResult(): ArchiveResult | undefined {
    return this.#lastIpfsResult;
  }

  /**
   * Register a job step to collect evidence for. `unit` names the escrow
   * settlement unit and its challenge nonce when the job has one; every event
   * of the step then commits both (LO-EV-9).
   */
  registerStep(jobId: string, stepId: string, assuranceTier: AssuranceTier, unit?: StepUnitContext): void {
    // Each of the unit's two fields is read once, checked and kept: the record never holds the caller's object.
    let unitCopy: StepUnitContext | undefined;
    if (unit) {
      const settlementUnitId: unknown = unit.settlementUnitId;
      const challengeNonce: unknown = unit.challengeNonce;
      if (!(isUnitField(settlementUnitId) && isUnitField(challengeNonce))) {
        throw new ErrorCtor("registerStep: settlementUnitId and challengeNonce must be 0x + 64 lowercase hex");
      }
      unitCopy = { settlementUnitId, challengeNonce };
    }
    // A step whose adds are still pending is never replaced: they would store into a record
    // nothing reads, and report success (astra pack 259). Once they have settled, a later run of
    // the step registers a fresh record.
    if ((stepRecord(this.#steps, jobId, stepId)?.pending ?? 0) > 0) {
      throw new ErrorCtor(`registerStep: step ${stepId} of job ${jobId} still has events being stored`);
    }
    let steps = MapPrototypeGet(this.#steps, jobId);
    if (steps === undefined) {
      steps = new MapCtor<string, StepEvidence>();
      MapPrototypeSet(this.#steps, jobId, steps);
    }
    MapPrototypeSet(steps, stepId, {
      jobId,
      stepId,
      events: [],
      assuranceTier,
      unit: unitCopy,
      stored: pinned(ready()),
      pending: 0,
      detached: false,
    });
  }

  /**
   * Add an evidence event for a job step. The step's events are stored in the order this is
   * called (N123). The promise settles once this event is stored, or rejects with the reason it
   * was not.
   */
  addEvent(
    jobId: string,
    stepId: string,
    rawEvent: Omit<EvidenceEvent, "id" | "hash">,
  ): Promise<EvidenceEvent> {
    return pinned(this.#addEvent(jobId, stepId, rawEvent));
  }

  async #addEvent(jobId: string, stepId: string, rawEvent: unknown): Promise<EvidenceEvent> {
    const stepEv = stepRecord(this.#steps, jobId, stepId);
    if (!stepEv) {
      throw new ErrorCtor(`No step registered for ${jobId}:${stepId}`);
    }

    // The emitter's own copy of exactly the fields the hash covers, taken FIRST and read through own
    // descriptors only (copyEventInput): no getter, setter or Proxy trap of the adapter's runs while
    // it is taken (astra pack 273). The event is hashed and stored from the copy, and stored by
    // defining its element (astra pack 277), so nothing the adapter changes afterwards reaches what
    // is stored (steward #6450), and nothing the hash does not cover is stored. Input that is not
    // plain JSON data fails the call here, before it takes a place. From here on the call runs only
    // the emitter's own code, spec's canonicalize and the id function captured from spec (see the
    // module comment for what each of those looks up).
    let input: EventInput;
    try {
      input = copyEventInput(rawEvent);
    } catch (err) {
      if (isEvidenceInputError(err)) {
        // The refusal's own message, set by its constructor: no property of Error.prototype is read.
        throw new ErrorCtor(`${ownDataValue(err, "message") as string}: evidence must be plain JSON data, which its hash commits to faithfully`);
      }
      throw err;
    }
    const payload = input.payload;

    // Every event names its job, and its unit when the step has one, inside the
    // hashed payload: LO-EV-9 and the oracle bind each event, not the bundle.
    // An adapter may pre-fill a field, but never with another job or unit, and
    // never with a unit the step was not given: the unit fields are reserved
    // for the binding. Read and written on the copy, own members only.
    const unit = stepEv.unit;
    if (!unit) {
      if (ownMember(payload, "settlementUnitId") !== undefined) {
        throw new ErrorCtor("event payload.settlementUnitId is reserved for the step's unit, and this step has none");
      }
      if (ownMember(payload, "challengeNonce") !== undefined) {
        throw new ErrorCtor("event payload.challengeNonce is reserved for the step's unit, and this step has none");
      }
    }
    const commit: Array<{ field: string; value: string }> = unit
      ? [{ field: "jobId", value: jobId }, { field: "settlementUnitId", value: unit.settlementUnitId }, { field: "challengeNonce", value: unit.challengeNonce }]
      : [{ field: "jobId", value: jobId }];
    for (let c = 0; c < commit.length; c++) {
      const field = listAt(commit, c)!.field;
      const value = listAt(commit, c)!.value;
      const existing = ownMember(payload, field);
      if (existing !== undefined && existing !== value) {
        const shown = typeof existing === "string" ? existing : `a ${typeof existing}`;
        throw new ErrorCtor(`event payload.${field} ${shown} does not match the step's ${value}`);
      }
      ObjectDefineProperty(payload, field, dataDescriptor(value));
    }

    // Hashed now, at the call, by the digest captured at load, synchronously: no digest can finish
    // late and reorder events (N123), and none replaced after load is consulted (steward #6668). The
    // event then takes its place and is stored on the step's chain, after the step's earlier events
    // are stored or have failed. An event refused above never takes a place; nor does one whose
    // hash throws.
    const event = {
      type: input.type,
      timestamp: input.timestamp,
      source: input.source,
      payload,
      id: IdsEvidence(),
      hash: hashEventFields(input),
    } as unknown as EvidenceEvent;
    defineField(stepEv, "pending", stepEv.pending + 1);
    const turn = pinned(storeInTurn(stepEv, stepEv.stored, event));
    defineField(stepEv, "stored", pinned(settledTurn(turn)));
    await pinned(turn);
    // The caller gets a copy: a stored event is never shared, so nothing changes it.
    return StructuredClone(event);
  }

  /** Finalize and sign an evidence bundle for a job step */
  finalizeBundle(jobId: string, stepId: string): Promise<EvidenceBundle> {
    return pinned(this.#finalizeBundle(jobId, stepId));
  }

  async #finalizeBundle(jobId: string, stepId: string): Promise<EvidenceBundle> {
    const stepEv = stepRecord(this.#steps, jobId, stepId);
    if (!stepEv) {
      throw new ErrorCtor(`No step registered for ${jobId}:${stepId}`);
    }

    // Sealed at this call (astra pack 259): wait for every add called before it, refuse a step
    // cleaned up meanwhile, then hash and return ONE snapshot of its events. The bundle's hash
    // therefore covers exactly its events; an add called later is stored after the bundle and
    // never enters it.
    await pinned(stepEv.stored);
    if (stepEv.detached) {
      throw new ErrorCtor(`step ${stepId} of job ${jobId} was cleaned up while its bundle was being finalized`);
    }
    // A deep copy, so the bundle shares no object with the stored record, and a change made to
    // either while the bundle is hashed and signed never reaches the other (astra pack 261).
    const events: EvidenceEvent[] = StructuredClone(stepEv.events);
    if (events.length === 0) {
      throw new ErrorCtor(`No evidence events for ${jobId}:${stepId}`);
    }

    const bundleHashValue = hashBundleEvents(events);
    const signature = await pinned(this.#signFn(bundleHashValue));

    const bundle: EvidenceBundle = {
      id: IdsBundle(),
      jobId: stepEv.jobId,
      stepId: stepEv.stepId,
      kernelId: this.#kernelId,
      assuranceTier: stepEv.assuranceTier,
      events,
      bundleHash: bundleHashValue,
      kernelSignature: signature,
      createdAt: DatePrototypeToISOString(new DateCtor()),
    };

    // Mark bundles signed with the test key so consumers can distinguish them (defined, so no setter runs)
    if (!this.#hasRealSignFn) {
      ObjectDefineProperty(bundle, "_testSigned", dataDescriptor(true));
    }

    // Archive to IPFS if storage service is available (best-effort)
    if (this.#storageIsReady !== null && this.#storageIsReady()) {
      try {
        const ipfsResult = await pinned(
          SentryStartSpan(
            {
              name: "evidence.ipfs_archive",
              op: "storage",
              attributes: {
                "bundle.id": bundle.id,
                "job.id": bundle.jobId,
                "kernel.id": this.#kernelId,
              },
            },
            () => pinned(this.#storageArchive!(bundle)),
          ),
        );
        this.#lastIpfsResult = ipfsResult;
      } catch {
        // IPFS archival is best-effort — do not block bundle finalization
        this.#lastIpfsResult = undefined;
      }
    }

    // Notify listeners: each callback registered with onBundle, a trusted collaborator.
    const listeners = this.#listeners;
    for (let i = 0; i < listeners.length; i++) {
      const listener = listAt(listeners, i)!;
      listener(bundle);
    }

    return bundle;
  }

  /**
   * Check whether evidence meets the requirements for a tier.
   *
   * An event counts, both toward its required-type group and toward the
   * minimum-event floor, only when it is authentic:
   *   - A fabricated (mock/simulated) event never counts, so a bundle of
   *     all-fabricated events meets no tier (coord #312/#316).
   *   - A camera event (camera_snapshot, cv_inspection_result) counts only
   *     when it is a closed LO-SE-1 kernel-pull capture for `options.jobId`:
   *     kernelPullCaptureIssue(event, jobId) in @pcc/spec returns null (astra
   *     pack 155 HIGH 1). Its type alone never counts, and neither does a
   *     legacy, careless, empty or push-fed payload. With no `options.jobId`,
   *     no camera event counts: fail closed.
   *   - Each camera event that does not count adds a `missing` entry naming
   *     why. A bundle carrying one therefore does not meet the tier, even
   *     when another capture does count.
   * Other event types count by their type, as before.
   */
  checkTierRequirements(
    events: EvidenceEvent[],
    tier: AssuranceTier,
    requirements: TierEvidenceRequirements[] = DefaultTierRequirements,
    options: { jobId?: string } = {},
  ): { met: boolean; missing: string[] } {
    let tierReq: TierEvidenceRequirements | undefined;
    for (let r = 0; r < requirements.length; r++) {
      const candidate = listAt(requirements, r)!;
      if (candidate.tier === tier) {
        tierReq = candidate;
        break;
      }
    }
    if (!tierReq) {
      return { met: false, missing: [`No requirements defined for tier ${tier}`] };
    }

    // Each event's type is read once, and the same value is used to classify it
    // and to count it. A camera event gets the reason it does not count (null
    // when it does). These arrays are built by defining their elements and read
    // by index: no [[Set]] and no Array.prototype method, so no setter or method
    // put on Array.prototype runs (astra packs 158, 277). A hole in `events` is
    // skipped, as map skipped it.
    const jobId = options?.jobId ?? "";
    const assessed: Array<{ event: EvidenceEvent; type: string; cameraIssue: string | null }> = [];
    for (let i = 0; i < events.length; i++) {
      if (!hasOwn(events, i)) continue;
      const event = listAt(events, i)!;
      const type = event.type;
      const cameraIssue = includesValue(CameraTypes, type) ? KernelPullCaptureIssue(event, jobId) : null;
      append(assessed, { event, type, cameraIssue });
    }
    const countedTypes: string[] = [];
    for (let i = 0; i < assessed.length; i++) {
      const entry = listAt(assessed, i)!;
      if (entry.cameraIssue === null && !IsFabricated(entry.event)) append(countedTypes, entry.type);
    }

    const missing: string[] = [];
    // At least one event type from each group must be present.
    const groups = tierReq.requiredEventTypes;
    for (let g = 0; g < groups.length; g++) {
      if (!hasOwn(groups, g)) continue;
      const group = listAt(groups, g)!;
      if (!someIncluded(group, countedTypes)) append(missing, `Missing one of: ${joinGroup(group, " | ")}`);
    }
    for (let i = 0; i < assessed.length; i++) {
      const entry = listAt(assessed, i)!;
      if (entry.cameraIssue !== null) {
        append(missing, `${entry.type} from ${deviceLabel(entry.event)}: not an LO-SE-1 capture for this job (${entry.cameraIssue})`);
      }
    }
    if (countedTypes.length < tierReq.minimumEvents) {
      append(missing, `Need at least ${tierReq.minimumEvents} events, have ${countedTypes.length}`);
    }

    return { met: missing.length === 0, missing };
  }

  /** A copy of the events stored for a job step, in call order. */
  getEvents(jobId: string, stepId: string): EvidenceEvent[] {
    // A copy, as from addEvent: changing it (or pushing into it) changes nothing stored.
    return StructuredClone(stepRecord(this.#steps, jobId, stepId)?.events ?? []);
  }

  /** Subscribe to finalized bundles */
  onBundle(callback: (bundle: EvidenceBundle) => void): void {
    append(this.#listeners, callback);
  }

  /** Clean up evidence for a completed job step. An add still pending on it then fails instead of storing. */
  cleanup(jobId: string, stepId: string): void {
    const steps = MapPrototypeGet(this.#steps, jobId);
    const stepEv = steps === undefined ? undefined : MapPrototypeGet(steps, stepId);
    if (steps === undefined || stepEv === undefined) return;
    defineField(stepEv, "detached", true);
    MapPrototypeDelete(steps, stepId);
    if (MapPrototypeGetSize(steps) === 0) MapPrototypeDelete(this.#steps, jobId);
  }
}
