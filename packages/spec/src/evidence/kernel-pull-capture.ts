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
 *   - Each value passes its check in CAPTURE_CHECKS or INSPECTION_CHECKS below.
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

/** The camera event types this contract governs. */
export const KERNEL_PULL_CAPTURE_TYPES = ["camera_snapshot", "cv_inspection_result"] as const;

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

/** What a value check sees besides the value itself. */
interface CheckContext {
  jobId: string;
  timestamp: unknown;
  payload: ReadonlyMap<PropertyKey, unknown>;
}

type Check = (value: unknown, context: CheckContext) => string | null;

/** PhotoCaptureService writes `sha256:<hex>`. */
const IMAGE_HASH = /^sha256:[0-9a-f]{64}$/;

const DEVICE_KEYS: readonly string[] = ["path", "identity"];

/** The capture keys, each with its check, in the order a reason is reported. */
const CAPTURE_CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ["jobId", (v, { jobId }) => (v === jobId ? null : `payload.jobId ${show(v)} is not this job's ${show(jobId)}`)],
  [
    "acquiredAt",
    (v, { timestamp }) =>
      !isCanonicalIso(v)
        ? `payload.acquiredAt ${show(v)} is not a canonical ISO-8601 instant`
        : v !== timestamp
          ? `payload.acquiredAt ${show(v)} is not the event's timestamp ${show(timestamp)}`
          : null,
  ],
  [
    "imageHash",
    (v) => (typeof v === "string" && IMAGE_HASH.test(v) ? null : `payload.imageHash ${show(v)} is not sha256:<64 lowercase hex>`),
  ],
  ["storageRef", (v) => (nonBlank(v) ? null : `payload.storageRef ${show(v)} is not a non-blank string`)],
  ["frameStored", (v) => (typeof v === "boolean" ? null : `payload.frameStored ${show(v)} is not a boolean`)],
  [
    "rawSizeBytes",
    (v) => (Number.isSafeInteger(v) && (v as number) > 0 ? null : `payload.rawSizeBytes ${show(v)} is not a positive safe integer`),
  ],
  ["captureMode", (v) => (v === "kernel-pull" ? null : `payload.captureMode ${show(v)} is not "kernel-pull"`)],
  ["captureClass", (v) => (v === "CC0" ? null : `payload.captureClass ${show(v)} is not "CC0"`)],
  ["device", deviceIssue],
  [
    "declaredChallengeId",
    (v) => (v === null || nonBlank(v) ? null : `payload.declaredChallengeId ${show(v)} is not a non-blank string or null`),
  ],
  [
    "declaredChallengeAnchor",
    (v, { payload }) =>
      !(v === null || nonBlank(v))
        ? `payload.declaredChallengeAnchor ${show(v)} is not a non-blank string or null`
        : (v === null) !== (payload.get("declaredChallengeId") === null)
          ? "payload.declaredChallengeAnchor is not null exactly when declaredChallengeId is null"
          : null,
  ],
  ["antiSpoofScore", (v) => (inRange(v, 0, 1) ? null : `payload.antiSpoofScore ${show(v)} is not a finite number in [0, 1]`)],
];

/** The inspection keys a cv_inspection_result carries on top of the capture keys. */
const INSPECTION_CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ["passed", (v) => (typeof v === "boolean" ? null : `payload.passed ${show(v)} is not a boolean`)],
  ["confidence", (v) => (inRange(v, 0, 100) ? null : `payload.confidence ${show(v)} is not a finite number in [0, 100]`)],
  ["findings", findingsIssue],
  ["referenceHash", (v) => (v === null || typeof v === "string" ? null : `payload.referenceHash ${show(v)} is not a string or null`)],
  ["model", (v) => (v === "anti-spoof-heuristic" ? null : `payload.model ${show(v)} is not "anti-spoof-heuristic"`)],
];

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
  const top = new Map<string, unknown>();
  for (const key of ["type", "timestamp", "source", "payload"]) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (descriptor !== undefined && !("value" in descriptor)) return `event.${key} is an accessor, not an own data property`;
    top.set(key, descriptor?.value);
  }

  const type = top.get("type");
  if (!(KERNEL_PULL_CAPTURE_TYPES as readonly unknown[]).includes(type)) {
    return `event type ${show(type)} is not a kernel-pull capture type`;
  }
  if (!nonBlank(jobId)) return "no job to bind the capture to (jobId is not a non-blank string)";

  const source = plainDataFields(top.get("source"), "source");
  if (typeof source === "string") return source;
  if (source.get("deviceType") !== "camera") return `source.deviceType ${show(source.get("deviceType"))} is not "camera"`;

  const payload = plainDataFields(top.get("payload"), "payload");
  if (typeof payload === "string") return payload;

  // After the structural checks, so isFabricated reads own data properties and runs no getter.
  if (isFabricated(event as unknown as EvidenceEvent)) return "the event is fabricated (source.simulated or payload.mock)";

  const checks = type === "camera_snapshot" ? CAPTURE_CHECKS : [...CAPTURE_CHECKS, ...INSPECTION_CHECKS];
  const keys = keySetIssue(
    payload,
    checks.map(([key]) => key),
    "payload",
  );
  if (keys !== null) return keys;

  const context: CheckContext = { jobId, timestamp: top.get("timestamp"), payload };
  for (const [key, check] of checks) {
    const issue = check(payload.get(key), context);
    if (issue !== null) return issue;
  }
  return null;
}

/**
 * The own properties of a plain object, read through their descriptors so no
 * getter ever runs; or the reason `value` is not a plain object of own,
 * enumerable data properties.
 */
function plainDataFields(value: unknown, what: string): Map<PropertyKey, unknown> | string {
  if (value === null || typeof value !== "object") return `${what} ${show(value)} is not an object`;
  const proxy = proxyIssue(value, what);
  if (proxy !== null) return proxy;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${what} is not a plain object`;
  const fields = new Map<PropertyKey, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return `${what}.${String(key)} is an accessor, not an own data property`;
    }
    if (!descriptor.enumerable) return `${what}.${String(key)} is not enumerable, so the event hash does not cover it`;
    fields.set(key, descriptor.value);
  }
  return fields;
}

/** The reason `fields` does not have exactly the `expected` keys, or null. */
function keySetIssue(fields: ReadonlyMap<PropertyKey, unknown>, expected: readonly string[], what: string): string | null {
  for (const key of fields.keys()) {
    if (typeof key !== "string" || !expected.includes(key)) {
      return `${what} has an extra key ${typeof key === "string" ? JSON.stringify(key) : String(key)}`;
    }
  }
  for (const key of expected) {
    if (!fields.has(key)) return `${what} is missing ${key}`;
  }
  return null;
}

/** `device` is a plain object with exactly {path, identity}, both non-blank strings. */
function deviceIssue(value: unknown): string | null {
  const device = plainDataFields(value, "payload.device");
  if (typeof device === "string") return device;
  const keys = keySetIssue(device, DEVICE_KEYS, "payload.device");
  if (keys !== null) return keys;
  for (const key of DEVICE_KEYS) {
    if (!nonBlank(device.get(key))) return `payload.device.${key} ${show(device.get(key))} is not a non-blank string`;
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
  if (!Array.isArray(value)) return "payload.findings is not an array";
  if (Object.getPrototypeOf(value) !== Array.prototype) return "payload.findings is not a plain array";
  const length = value.length;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor === undefined) return `payload.findings has a hole at index ${i}`;
    if (!("value" in descriptor)) return `payload.findings[${i}] is an accessor, not an own data property`;
    if (typeof descriptor.value !== "string") return `payload.findings[${i}] ${show(descriptor.value)} is not a string`;
  }
  if (Reflect.ownKeys(value).length !== length + 1) return "payload.findings has an own key besides its indices and length";
  return null;
}

/** The reason `value` may not be read (it is a Proxy, or no trap-free check exists here), or null. */
function proxyIssue(value: object, what: string): string | null {
  if (nodeIsProxy === null) {
    return "this runtime has no trap-free Proxy check (node:util types.isProxy via process.getBuiltinModule), so no capture can be verified";
  }
  return nodeIsProxy(value) ? `${what} is a Proxy, whose traps could show this check values the event hash never sees` : null;
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function inRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/** True for a string that is its own `new Date(x).toISOString()`; an invalid date never is. */
function isCanonicalIso(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}

/** A value, described for a reason without ever throwing or touching an object (it may be a revoked Proxy). */
function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}...` : v);
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  return typeof v === "object" ? "(an object)" : `(a ${typeof v})`;
}
