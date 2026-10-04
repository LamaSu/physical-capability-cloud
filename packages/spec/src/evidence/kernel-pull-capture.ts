/**
 * LO-SE-1 kernel-pull capture contract: the ONE predicate that decides whether
 * a camera event may count toward an assurance tier.
 *
 * Why: astra pack 155 HIGH 1 (#489 @b76a2545). The tier gate counted a camera
 * event by its type alone, so a registered camera plugin (or any adapter) could
 * emit a non-simulated camera_snapshot with an empty payload and satisfy Tier
 * 2's camera group.
 *
 * The contract is CLOSED. `kernelPullCaptureIssue(event, jobId)` returns null
 * only for a complete LO-SE-1 kernel-pull capture for `jobId`; otherwise it
 * returns the first reason the event is not one.
 *   - The event: its type is one of KERNEL_PULL_CAPTURE_TYPES; `jobId` is a
 *     non-blank string; its source is a camera; it is not fabricated
 *     (isFabricated).
 *   - The payload: a plain object (its prototype is Object.prototype or null)
 *     whose key set is EXACTLY the capture keys (camera_snapshot), or the
 *     capture keys plus the inspection keys (cv_inspection_result). There are
 *     no extra keys and none missing.
 *   - Every value is an own, enumerable data property, read through
 *     Object.getOwnPropertyDescriptor. An accessor is refused and its getter is
 *     never run: it could show this check one value and the event hash
 *     another. A non-enumerable or symbol key is refused too, because the
 *     canonical JSON the kernel signs hashes enumerable string keys only.
 *   - No object the check reads (the event, its source, the payload, the
 *     device, the findings) is a Proxy. A descriptor read on a Proxy runs its
 *     traps, and they can report a valid capture while the [[Get]] the event
 *     hash uses returns other values. node:util's isProxy runs no trap; it is
 *     found at module load without a static import, because @pcc/spec is also
 *     bundled for the browser. Where it is missing (a browser, Node before
 *     20.16 / 22.3) every capture is refused: fail closed.
 *   - Each value passes its check in fieldIssue below.
 *
 * What code that replaces a method or global AFTER this module loads can and
 * cannot do (astra pack 299 HIGH, PR #578). The kernel's tier gate captures
 * this function at load and asks it whether a camera event counts toward tier
 * 2, so its answer must not depend on anything changed afterwards: with
 * RegExp.prototype.test replaced, a malformed imageHash counted. This function
 * and every helper it calls now go only through bindings captured when the
 * module loads (spec's util/primordials.ts and the block below), plain loops
 * and operators: never a method looked up on a prototype or a global when it
 * runs.
 *   - No RegExp: the image hash is checked code unit by code unit.
 *   - No Map, Set or iterator protocol: an object's own data properties are
 *     copied onto a null-prototype record, its keys kept in the dense array
 *     Reflect.ownKeys returns, and every list is read by index, an element
 *     only where it is proven own.
 *   - No `in`: a descriptor describes data only when it OWNS `value`. One
 *     written on Object.prototype is not its own, so an accessor stays refused.
 *   - The governed types are a copy taken at load: the export is a mutable
 *     array any importer can write to.
 *   - isFabricated is handed the null-prototype copies of the source and the
 *     payload, so a `simulated` or `mock` written on Object.prototype is not
 *     read as the event's own.
 * kernel-pull-capture-intrinsics.test.ts (here) and camera-gate-intrinsics.test.ts
 * (@pcc/kernel) replace each such intrinsic after load and require the
 * untouched answers. The boundary, as in primordials.ts: a realm whose
 * intrinsics were replaced BEFORE this module loaded hands it the replaced
 * ones. Load @pcc/spec before untrusted code.
 *
 * The boundary, named honestly. In-process adapter code registered into the
 * kernel is part of the kernel's trusted base, so an adapter that deliberately
 * forges these fields is malicious kernel code, beyond any in-process check.
 * What the contract guarantees: a camera event counts only if it carries the
 * complete LO-SE-1 capture for the job. A legacy, careless, empty or push-fed
 * event never counts.
 *
 * The fields are the PullCameraAdapter's, and its header documents them
 * (packages/kernel/src/adapters/pull-camera-adapter.ts). Two are worth naming
 * here. `captureClass` is always "CC0": a kernel camera never has CC1's
 * operator-session signing, WebAuthn assertion and multi-sensor trace.
 * `declaredChallengeId` and `declaredChallengeAnchor` are unverified
 * declarations: the kernel authenticates neither the challenge's issuer nor
 * its anchor.
 */

import type { EvidenceEvent } from "../types/evidence.js";
import { isFabricated } from "./is-fabricated.js";
import {
  ArrayIsArray,
  ArrayPrototype,
  JSONStringify,
  NumberIsFinite,
  ObjectCreate,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectPrototype,
  StringCtor,
  hasOwn,
  trim,
  uncurryThis,
} from "../util/primordials.js";

/** The camera event types this contract governs. */
export const KERNEL_PULL_CAPTURE_TYPES = ["camera_snapshot", "cv_inspection_result"] as const;

// -- captured when this module loads (astra pack 299) --
// What this file calls besides spec's primordials and its own functions. Nothing below is looked
// up again when the check runs.
const ReflectOwnKeys = Reflect.ownKeys;
const NumberIsSafeInteger = Number.isSafeInteger;
const DateCtor = Date;
const DatePrototypeGetTime = uncurryThis(Date.prototype.getTime) as (date: Date) => number;
const DatePrototypeToISOString = uncurryThis(Date.prototype.toISOString) as (date: Date) => string;
const StringPrototypeSlice = uncurryThis(String.prototype.slice) as (s: string, start?: number, end?: number) => string;
const StringPrototypeCharCodeAt = uncurryThis(String.prototype.charCodeAt) as (s: string, index: number) => number;
/** The governed types, copied: KERNEL_PULL_CAPTURE_TYPES is an exported array any importer can write to. */
const CAPTURE_TYPES: readonly string[] = ObjectFreeze([...KERNEL_PULL_CAPTURE_TYPES]);

/**
 * node:util's trap-free Proxy test, or null where this runtime has none. Read
 * once at module load through process.getBuiltinModule, never a static import:
 * the dashboard bundles @pcc/spec for the browser, where node:util breaks the
 * build.
 */
const nodeIsProxy: ((value: unknown) => boolean) | null = (() => {
  const util = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.(
    "node:util",
  ) as { types?: { isProxy?: (value: unknown) => boolean } } | undefined;
  const isProxy = util?.types?.isProxy;
  return typeof isProxy === "function" ? isProxy : null;
})();
// -- end of the load-time captures --

/**
 * A plain object's own data properties: its keys in Reflect.ownKeys order (a
 * fresh, dense array), and each key's value on a null-prototype record.
 */
interface Fields {
  readonly keys: readonly (string | symbol)[];
  readonly values: Readonly<Record<string | symbol, unknown>>;
}

/** What a value check sees besides the value itself. */
interface CheckContext {
  jobId: string;
  timestamp: unknown;
  payload: Fields;
}

/** The event's own fields the check reads, in the order an accessor among them is reported. */
const EVENT_KEYS: readonly string[] = ObjectFreeze(["type", "timestamp", "source", "payload"]);

/** PhotoCaptureService writes `sha256:<hex>`. */
const IMAGE_HASH_PREFIX = "sha256:";

const DEVICE_KEYS: readonly string[] = ObjectFreeze(["path", "identity"]);

/** The capture keys, in the order a reason is reported: the key set a camera_snapshot's payload must have exactly. */
const CAPTURE_KEYS: readonly string[] = ObjectFreeze([
  "jobId", "acquiredAt", "imageHash", "storageRef", "frameStored", "rawSizeBytes", "captureMode", "captureClass", "device",
  "declaredChallengeId", "declaredChallengeAnchor", "antiSpoofScore",
]);
/** The inspection keys a cv_inspection_result carries on top of the capture keys, in the order a reason is reported. */
const INSPECTION_KEYS: readonly string[] = ObjectFreeze(["passed", "confidence", "findings", "referenceHash", "model"]);
/** A cv_inspection_result's keys: the capture's, then the inspection's. */
const ALL_KEYS: readonly string[] = ObjectFreeze([...CAPTURE_KEYS, ...INSPECTION_KEYS]);

/**
 * The reason the payload's value for `key` fails its check, or null. One switch over the keys, with
 * each check written in place, so every call it makes is to a function named here: a check read
 * back from a table of functions would be a call target the default-deny check cannot see (astra
 * pack 303). An unknown key fails closed.
 */
function fieldIssue(key: string, v: unknown, context: CheckContext): string | null {
  switch (key) {
    case "jobId":
      return v === context.jobId ? null : `payload.jobId ${show(v)} is not this job's ${show(context.jobId)}`;
    case "acquiredAt":
      return !isCanonicalIso(v)
        ? `payload.acquiredAt ${show(v)} is not a canonical ISO-8601 instant`
        : v !== context.timestamp
          ? `payload.acquiredAt ${show(v)} is not the event's timestamp ${show(context.timestamp)}`
          : null;
    case "imageHash":
      return isImageHash(v) ? null : `payload.imageHash ${show(v)} is not sha256:<64 lowercase hex>`;
    case "storageRef":
      return nonBlank(v) ? null : `payload.storageRef ${show(v)} is not a non-blank string`;
    case "frameStored":
      return typeof v === "boolean" ? null : `payload.frameStored ${show(v)} is not a boolean`;
    case "rawSizeBytes":
      return NumberIsSafeInteger(v) && (v as number) > 0 ? null : `payload.rawSizeBytes ${show(v)} is not a positive safe integer`;
    case "captureMode":
      return v === "kernel-pull" ? null : `payload.captureMode ${show(v)} is not "kernel-pull"`;
    case "captureClass":
      return v === "CC0" ? null : `payload.captureClass ${show(v)} is not "CC0"`;
    case "device":
      return deviceIssue(v);
    case "declaredChallengeId":
      return v === null || nonBlank(v) ? null : `payload.declaredChallengeId ${show(v)} is not a non-blank string or null`;
    case "declaredChallengeAnchor":
      return !(v === null || nonBlank(v))
        ? `payload.declaredChallengeAnchor ${show(v)} is not a non-blank string or null`
        : (v === null) !== (fieldValue(context.payload, "declaredChallengeId") === null)
          ? "payload.declaredChallengeAnchor is not null exactly when declaredChallengeId is null"
          : null;
    case "antiSpoofScore":
      return inRange(v, 0, 1) ? null : `payload.antiSpoofScore ${show(v)} is not a finite number in [0, 1]`;
    case "passed":
      return typeof v === "boolean" ? null : `payload.passed ${show(v)} is not a boolean`;
    case "confidence":
      return inRange(v, 0, 100) ? null : `payload.confidence ${show(v)} is not a finite number in [0, 100]`;
    case "findings":
      return findingsIssue(v);
    case "referenceHash":
      return v === null || typeof v === "string" ? null : `payload.referenceHash ${show(v)} is not a string or null`;
    case "model":
      return v === "anti-spoof-heuristic" ? null : `payload.model ${show(v)} is not "anti-spoof-heuristic"`;
    default:
      return `payload.${key} has no check`;
  }
}

/**
 * Null when `event` is a complete LO-SE-1 kernel-pull capture for `jobId`;
 * otherwise the first reason it is not one. Never runs a getter on the event's
 * fields, its source or its payload, and never throws for a plain-data input.
 */
export function kernelPullCaptureIssue(
  event: { type: string; timestamp?: unknown; source?: unknown; payload?: unknown },
  jobId: string,
): string | null {
  if (event === null || typeof event !== "object") return `the event ${show(event)} is not an object`;
  const proxy = proxyIssue(event, "the event");
  if (proxy !== null) return proxy;
  const top = ObjectCreate(null) as Record<string, unknown>;
  for (let i = 0; i < EVENT_KEYS.length; i++) {
    const key = listAt(EVENT_KEYS, i)!;
    const descriptor = ObjectGetOwnPropertyDescriptor(event, key);
    if (descriptor !== undefined && !hasOwn(descriptor, "value")) return `event.${key} is an accessor, not an own data property`;
    top[key] = descriptor === undefined ? undefined : descriptor.value;
  }

  const type = top.type;
  if (!isOneOf(CAPTURE_TYPES, type)) return `event type ${show(type)} is not a kernel-pull capture type`;
  if (!nonBlank(jobId)) return "no job to bind the capture to (jobId is not a non-blank string)";

  const source = plainDataFields(top.source, "source");
  if (typeof source === "string") return source;
  const deviceType = fieldValue(source, "deviceType");
  if (deviceType !== "camera") return `source.deviceType ${show(deviceType)} is not "camera"`;

  const payload = plainDataFields(top.payload, "payload");
  if (typeof payload === "string") return payload;

  // After the structural checks, and on their copies: isFabricated reads own data properties only,
  // runs no getter, and finds no `simulated` or `mock` a prototype serves.
  if (isFabricated(fabricationView(source, payload))) return "the event is fabricated (source.simulated or payload.mock)";

  const snapshot = type === "camera_snapshot";
  const keys = keySetIssue(payload, snapshot ? CAPTURE_KEYS : ALL_KEYS, "payload");
  if (keys !== null) return keys;

  const checked = snapshot ? CAPTURE_KEYS : ALL_KEYS;
  const context: CheckContext = { jobId, timestamp: top.timestamp, payload };
  for (let i = 0; i < checked.length; i++) {
    const key = listAt(checked, i)!;
    const issue = fieldIssue(key, fieldValue(payload, key), context);
    if (issue !== null) return issue;
  }
  return null;
}

/**
 * The own properties of a plain object, read through their descriptors so no
 * getter ever runs; or the reason `value` is not a plain object of own,
 * enumerable data properties.
 */
function plainDataFields(value: unknown, what: string): Fields | string {
  if (value === null || typeof value !== "object") return `${what} ${show(value)} is not an object`;
  const proxy = proxyIssue(value, what);
  if (proxy !== null) return proxy;
  const prototype: unknown = ObjectGetPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) return `${what} is not a plain object`;
  const keys = ReflectOwnKeys(value);
  const values = ObjectCreate(null) as Record<string | symbol, unknown>;
  for (let i = 0; i < keys.length; i++) {
    const key = listAt(keys, i)!;
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !hasOwn(descriptor, "value")) {
      return `${what}.${StringCtor(key)} is an accessor, not an own data property`;
    }
    if (!descriptor.enumerable) return `${what}.${StringCtor(key)} is not enumerable, so the event hash does not cover it`;
    values[key] = descriptor.value;
  }
  return { keys, values };
}

/** The value `fields` holds for `key`, or undefined: read from its null-prototype record, never from a prototype. */
function fieldValue(fields: Fields, key: string): unknown {
  const values = fields.values;
  return hasOwn(values, key) ? values[key] : undefined;
}

/**
 * The event as isFabricated reads it: a null-prototype record holding the
 * null-prototype copies of the source's and the payload's own data properties.
 */
function fabricationView(source: Fields, payload: Fields): EvidenceEvent {
  const view = ObjectCreate(null) as Record<string, unknown>;
  view.source = source.values;
  view.payload = payload.values;
  return view as unknown as EvidenceEvent;
}

/** The reason `fields` does not have exactly the `expected` keys, or null. */
function keySetIssue(fields: Fields, expected: readonly string[], what: string): string | null {
  const keys = fields.keys;
  for (let i = 0; i < keys.length; i++) {
    const key = listAt(keys, i);
    if (typeof key !== "string" || !isOneOf(expected, key)) {
      return `${what} has an extra key ${typeof key === "string" ? JSONStringify(key) : StringCtor(key)}`;
    }
  }
  const values = fields.values;
  for (let i = 0; i < expected.length; i++) {
    const key = listAt(expected, i)!;
    if (!hasOwn(values, key)) return `${what} is missing ${key}`;
  }
  return null;
}

/** `device` is a plain object with exactly {path, identity}, both non-blank strings. */
function deviceIssue(value: unknown): string | null {
  const device = plainDataFields(value, "payload.device");
  if (typeof device === "string") return device;
  const keys = keySetIssue(device, DEVICE_KEYS, "payload.device");
  if (keys !== null) return keys;
  for (let i = 0; i < DEVICE_KEYS.length; i++) {
    const key = listAt(DEVICE_KEYS, i)!;
    const field = fieldValue(device, key);
    if (!nonBlank(field)) return `payload.device.${key} ${show(field)} is not a non-blank string`;
  }
  return null;
}

/**
 * `findings` is a dense, plain array of strings. The event hash reads it
 * through the array's own `map`, so its prototype must be Array.prototype and
 * its own keys exactly its indices and `length`; each element is an own data
 * property holding a string.
 */
function findingsIssue(value: unknown): string | null {
  if (value === null || typeof value !== "object") return `payload.findings ${show(value)} is not an array`;
  const proxy = proxyIssue(value, "payload.findings");
  if (proxy !== null) return proxy;
  if (!ArrayIsArray(value)) return "payload.findings is not an array";
  if (ObjectGetPrototypeOf(value) !== ArrayPrototype) return "payload.findings is not a plain array";
  const length = value.length;
  for (let i = 0; i < length; i++) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, i);
    if (descriptor === undefined) return `payload.findings has a hole at index ${i}`;
    if (!hasOwn(descriptor, "value")) return `payload.findings[${i}] is an accessor, not an own data property`;
    if (typeof descriptor.value !== "string") return `payload.findings[${i}] ${show(descriptor.value)} is not a string`;
  }
  if (ReflectOwnKeys(value).length !== length + 1) return "payload.findings has an own key besides its indices and length";
  return null;
}

/** The reason `value` may not be read (it is a Proxy, or no trap-free check exists here), or null. */
function proxyIssue(value: object, what: string): string | null {
  if (nodeIsProxy === null) {
    return "this runtime has no trap-free Proxy check (node:util types.isProxy via process.getBuiltinModule), so no capture can be verified";
  }
  return nodeIsProxy(value) ? `${what} is a Proxy, whose traps could show this check values the event hash never sees` : null;
}

/** `list[i]` when `list` owns index `i`; otherwise undefined, never an element a prototype serves. */
function listAt<T>(list: readonly T[], i: number): T | undefined {
  return hasOwn(list, i) ? list[i] : undefined;
}

/** Whether `value` is one of `list`'s own elements (===). */
function isOneOf(list: readonly string[], value: unknown): boolean {
  for (let i = 0; i < list.length; i++) {
    if (hasOwn(list, i) && list[i] === value) return true;
  }
  return false;
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && trim(v).length > 0;
}

function inRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && NumberIsFinite(v) && v >= min && v <= max;
}

/**
 * `sha256:` followed by exactly 64 lowercase hex digits, checked code unit by
 * code unit. There is no RegExp: its test and exec are looked up when it runs
 * (astra pack 299), and RegExp.prototype.compile replaces a RegExp object's
 * matcher in place (primordials' isHex256Digest).
 */
function isImageHash(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== IMAGE_HASH_PREFIX.length + 64) return false;
  for (let i = 0; i < IMAGE_HASH_PREFIX.length; i++) {
    if (StringPrototypeCharCodeAt(v, i) !== StringPrototypeCharCodeAt(IMAGE_HASH_PREFIX, i)) return false;
  }
  for (let i = IMAGE_HASH_PREFIX.length; i < v.length; i++) {
    const unit = StringPrototypeCharCodeAt(v, i);
    if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
  }
  return true;
}

/** True for a string that is its own `new Date(x).toISOString()`; an invalid date never is. */
function isCanonicalIso(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const ms = DatePrototypeGetTime(new DateCtor(v));
  return NumberIsFinite(ms) && DatePrototypeToISOString(new DateCtor(ms)) === v;
}

/** A value, described for a reason without ever throwing or touching an object (it may be a revoked Proxy). */
function show(v: unknown): string {
  if (typeof v === "string") return JSONStringify(v.length > 80 ? `${StringPrototypeSlice(v, 0, 80)}...` : v);
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return StringCtor(v);
  return typeof v === "object" ? "(an object)" : `(a ${typeof v})`;
}
