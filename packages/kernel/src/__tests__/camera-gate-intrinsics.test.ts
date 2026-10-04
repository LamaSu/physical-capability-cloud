/**
 * astra pack 299 HIGH (PR #578 @6804552c), at the emitter's tier gate. The EvidenceEmitter captures
 * @pcc/spec's kernelPullCaptureIssue at load and calls it in checkTierRequirements to decide
 * whether a camera event counts toward tier 2, the JobRunner's hard gate. The function looked its
 * intrinsics up when it ran, so with RegExp.prototype.test replaced after load, Tier 1 events plus
 * an LO-SE-1 camera_snapshot whose imageHash is "invalid" met tier 2 (reproduced at 6804552c:
 * /mnt/sparkbulk/tmp/sensors/round8/order/r299/repro-299-at-6804552c.txt). Capturing the outer
 * function was not enough: every helper it calls now goes only through bindings captured at load.
 *
 * Each row replaces (or writes) one intrinsic AFTER load and requires the tier-2 answer for every
 * camera event, valid and invalid (so a replacement that forces either answer is caught), to be
 * exactly the untouched one, with no call of what was replaced. The events, the emitter and the
 * untouched answers are built before any replacement, and the answers are compared only after it
 * is restored: the test's own code never runs a replaced intrinsic.
 */

import { describe, it, expect, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { KERNEL_PULL_CAPTURE_TYPES } from "@pcc/spec";

import { EvidenceEmitter } from "../evidence-emitter.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// Captured at load: the harness installs and restores every row through these, never through what a row replaced.
const defineAtLoad = Reflect.defineProperty;
const descriptorAtLoad = Reflect.getOwnPropertyDescriptor;
const deleteAtLoad = Reflect.deleteProperty;
const ITERATOR: typeof Symbol.iterator = Symbol.iterator;

type EmittedEvent = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-camera-gate-intrinsics";
const NOW_MS = 1_700_000_000_000;
const JOB = "job-provenance-001";
const OPTIONS = { jobId: JOB };

function source(deviceId: string, deviceType: EvidenceSource["deviceType"] = "controller"): EvidenceSource {
  return { deviceId, deviceType, kernelId: KERNEL_ID };
}

function event(type: string, payload: Record<string, unknown> = {}, deviceType: EvidenceSource["deviceType"] = "controller"): EmittedEvent {
  return { type: type as EvidenceEvent["type"], timestamp: new Date().toISOString(), source: source(`dev-${type}`, deviceType), payload };
}

const TIER1 = [
  event("gcode_hash_verified", { gcodeHash: "sha256:00" }),
  event("execution_completed", { durationMs: 1 }),
  event("power_profile_summary", { avgWatts: 90 }, "power_monitor"),
];

const IMAGE_HASH = `sha256:${"cd".repeat(32)}`;
type CameraType = "camera_snapshot" | "cv_inspection_result";

/** A complete LO-SE-1 capture for `jobId`, shaped as the PullCameraAdapter emits it. */
function lose1(type: CameraType = "camera_snapshot", jobId = JOB, timestampMs = NOW_MS): EmittedEvent {
  const timestamp = new Date(timestampMs).toISOString();
  const capture: Record<string, unknown> = {
    jobId,
    acquiredAt: timestamp,
    imageHash: IMAGE_HASH,
    storageRef: `photo:${IMAGE_HASH}`,
    frameStored: false,
    rawSizeBytes: 15_000,
    captureMode: "kernel-pull",
    captureClass: "CC0",
    device: { path: "/dev/video0", identity: "SER-1" },
    declaredChallengeId: null,
    declaredChallengeAnchor: null,
    antiSpoofScore: 1,
  };
  const payload =
    type === "camera_snapshot"
      ? capture
      : { ...capture, passed: true, confidence: 100, findings: ["ok"], referenceHash: null, model: "anti-spoof-heuristic" };
  return { type, timestamp, source: source("cam-lose1", "camera"), payload };
}

/** Events as the emitter stores them (id + hash added). */
function stored(list: EmittedEvent[]): EvidenceEvent[] {
  return list.map((e, i) => ({ ...e, id: `e${i}`, hash: `sha256:${i}` })) as unknown as EvidenceEvent[];
}

/** A capture whose payload, and the event itself, `edit` changed. */
function edited(edit: (p: Record<PropertyKey, unknown>, e: EmittedEvent) => void, type: CameraType = "camera_snapshot"): EmittedEvent {
  const e = lose1(type);
  edit(e.payload, e);
  return e;
}

/** Makes `target[key]` an enumerable accessor whose getter returns `value`. */
function accessor(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => value });
}

class NotPlain {
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
  }
}

interface Fixture {
  name: string;
  /** TIER1 plus the camera event, as the emitter stores them. */
  events: EvidenceEvent[];
}

const fixture = (name: string, camera: EmittedEvent): Fixture => ({ name, events: stored([...TIER1, camera]) });

/**
 * Valid camera events (a replacement that forces a refusal shows here) and invalid ones (one that
 * forces an acceptance, or another reason, shows here). Built once, before any replacement.
 */
const FIXTURES: readonly Fixture[] = [
  fixture("a valid camera_snapshot", lose1()),
  fixture("a valid cv_inspection_result", lose1("cv_inspection_result")),
  fixture(
    "a valid capture that declares a challenge",
    edited((p) => {
      p.declaredChallengeId = "challenge-1";
      p.declaredChallengeAnchor = "0xblock";
    }),
  ),
  fixture('imageHash "invalid" (astra pack 299)', edited((p) => (p.imageHash = "invalid"))),
  fixture("an uppercase-hex imageHash", edited((p) => (p.imageHash = IMAGE_HASH.toUpperCase().replace("SHA256", "sha256")))),
  fixture("an accessor captureClass whose getter says CC0", edited((p) => accessor(p, "captureClass", "CC0"))),
  fixture("an accessor source.deviceType whose getter says camera", edited((_p, e) => accessor(e.source, "deviceType", "camera"))),
  fixture("an accessor findings element", edited((p) => accessor(p.findings as object, 0, "ok"), "cv_inspection_result")),
  fixture("an extra key", edited((p) => (p.extra = 1))),
  fixture("a symbol key", edited((p) => (p[Symbol("hidden")] = 1))),
  fixture("a non-enumerable key", edited((p) => Object.defineProperty(p, "captureClass", { value: "CC0", enumerable: false }))),
  fixture("a missing key", edited((p) => delete p.antiSpoofScore)),
  fixture("a capture for another job", edited((p) => (p.jobId = "job-other"))),
  fixture("a capture for a job whose id is longer than 80 characters", edited((p) => (p.jobId = `job-${"x".repeat(100)}`))),
  fixture("a blank storageRef", edited((p) => (p.storageRef = "   "))),
  fixture("rawSizeBytes 1.5", edited((p) => (p.rawSizeBytes = 1.5))),
  fixture("antiSpoofScore NaN", edited((p) => (p.antiSpoofScore = Number.NaN))),
  fixture(
    "acquiredAt not canonical (the timestamp the same)",
    edited((p, e) => {
      p.acquiredAt = "2023-11-14 22:13:20";
      e.timestamp = "2023-11-14 22:13:20";
    }),
  ),
  fixture(
    "acquiredAt not a date (the timestamp the same)",
    edited((p, e) => {
      p.acquiredAt = "not a date";
      e.timestamp = "not a date";
    }),
  ),
  // eslint-disable-next-line no-sparse-arrays
  fixture("findings with a hole", edited((p) => (p.findings = [, "ok"]), "cv_inspection_result")),
  fixture("findings an array-like object", edited((p) => (p.findings = { 0: "ok", length: 1 }), "cv_inspection_result")),
  fixture("a device with a blank identity", edited((p) => (p.device = { path: "/dev/video0", identity: " " }))),
  fixture("a source that is not a camera", edited((_p, e) => (e.source = { ...e.source, deviceType: "controller" }))),
  fixture("a class-instance payload", edited((p, e) => (e.payload = new NotPlain(p) as unknown as Record<string, unknown>))),
];

type Answer = { met: boolean; missing: string[] } | { threw: unknown };

/** The answers in a form that compares by value; called only after every replacement is restored. */
function described(answers: readonly Answer[]): Array<{ fixture: string; answer: unknown }> {
  return answers.map((answer, i) => ({
    fixture: FIXTURES[i]!.name,
    answer: "threw" in answer ? `threw: ${String((answer.threw as Error)?.message)}` : answer,
  }));
}

/** The emitter the gate runs on, built before any replacement. */
const EMITTER = new EvidenceEmitter(KERNEL_ID);

/** Every fixture's tier-2 answer, in an indexed loop that writes only to elements `out` already owns. */
function answerAll(out: Answer[]): void {
  for (let i = 0; i < FIXTURES.length; i++) {
    const f = FIXTURES[i]!;
    try {
      out[i] = EMITTER.checkTierRequirements(f.events, 2, undefined, OPTIONS);
    } catch (err) {
      out[i] = { threw: err };
    }
  }
}

const CLEAN = (() => {
  const out: Answer[] = FIXTURES.map(() => ({ threw: "not run" }));
  answerAll(out);
  return described(out);
})();

/** Calls of whatever a row replaced; reset before each row. */
let calls = 0;

interface Row {
  name: string;
  /** Makes the change; returns what undoes it. */
  apply: () => () => void;
}

/** Replaces `target[key]` with `replacement` (which counts its calls), keeping the property's attributes. */
function replaced(name: string, target: object, key: PropertyKey, replacement: unknown): Row {
  return {
    name: `${name} replaced`,
    apply: () => {
      const original = descriptorAtLoad(target, key)!;
      defineAtLoad(target, key, { __proto__: null, value: replacement, writable: true, enumerable: original.enumerable, configurable: true } as PropertyDescriptor);
      return () => void defineAtLoad(target, key, original);
    },
  };
}

/** Writes a data property `key` on `target` (a prototype), as a pollution bug would. */
function written(name: string, target: object, key: PropertyKey, value: unknown): Row {
  return {
    name: `${name} written`,
    apply: () => {
      const original = descriptorAtLoad(target, key);
      defineAtLoad(target, key, { __proto__: null, value, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
      return () => void (original === undefined ? deleteAtLoad(target, key) : defineAtLoad(target, key, original));
    },
  };
}

/** An iterator that is done at once: a replaced iterator makes a for...of see nothing. */
function emptyIterator(): Iterator<unknown> & Iterable<unknown> {
  const it = {
    next: () => ({ done: true as const, value: undefined }),
    [ITERATOR]: () => it,
  };
  return it;
}

const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;
const MapIteratorPrototype = Object.getPrototypeOf(new Map()[Symbol.iterator]()) as object;

/** A Date stand-in whose instances report a fixed time and a forged ISO string. */
function FakeDate(): { getTime: () => number; toISOString: () => string } {
  calls++;
  return { getTime: () => 0, toISOString: () => "forged" };
}

const ROWS: Row[] = [
  // astra's recipe first.
  replaced("RegExp.prototype.test", RegExp.prototype, "test", () => (calls++, true)),
  // RegExp.prototype.test calls the RegExp's exec: a match-like result makes every test true.
  replaced("RegExp.prototype.exec", RegExp.prototype, "exec", () => (calls++, ["forged"])),
  replaced("Map.prototype.get", Map.prototype, "get", () => (calls++, undefined)),
  replaced("Map.prototype.set", Map.prototype, "set", function (this: unknown) {
    calls++;
    return this;
  }),
  replaced("Map.prototype.has", Map.prototype, "has", () => (calls++, true)),
  replaced("Map.prototype.keys", Map.prototype, "keys", () => (calls++, emptyIterator())),
  replaced("Map.prototype[Symbol.iterator]", Map.prototype, Symbol.iterator, () => (calls++, emptyIterator())),
  replaced("%MapIteratorPrototype%.next", MapIteratorPrototype, "next", () => (calls++, { done: true, value: undefined })),
  replaced("Array.prototype.includes", Array.prototype, "includes", () => (calls++, true)),
  replaced("Array.prototype.map", Array.prototype, "map", () => (calls++, [])),
  replaced("Array.prototype.indexOf", Array.prototype, "indexOf", () => (calls++, 0)),
  replaced("Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, () => (calls++, emptyIterator())),
  replaced("%ArrayIteratorPrototype%.next", ArrayIteratorPrototype, "next", () => (calls++, { done: true, value: undefined })),
  replaced("Object.getOwnPropertyDescriptor", Object, "getOwnPropertyDescriptor", () => (calls++, undefined)),
  replaced("Object.getPrototypeOf", Object, "getPrototypeOf", () => (calls++, null)),
  replaced("Reflect.ownKeys", Reflect, "ownKeys", () => (calls++, [])),
  replaced("String.prototype.trim", String.prototype, "trim", () => (calls++, "")),
  replaced("String.prototype.slice", String.prototype, "slice", () => (calls++, "forged")),
  replaced("Number.isFinite", Number, "isFinite", () => (calls++, false)),
  replaced("Number.isSafeInteger", Number, "isSafeInteger", () => (calls++, false)),
  replaced("Date.prototype.getTime", Date.prototype, "getTime", () => (calls++, NaN)),
  replaced("Date.prototype.toISOString", Date.prototype, "toISOString", () => (calls++, "forged")),
  replaced("the global Date", globalThis, "Date", FakeDate),
  replaced("JSON.stringify", JSON, "stringify", () => (calls++, '"forged"')),
  replaced("the global String", globalThis, "String", () => (calls++, "forged")),
  replaced("Array.isArray", Array, "isArray", () => (calls++, false)),
  // Beyond astra's list: what the hardened code is built on, or could be.
  replaced("Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty", () => (calls++, true)),
  replaced("String.prototype.charCodeAt", String.prototype, "charCodeAt", () => (calls++, 0x30)),
  replaced("Function.prototype.call", Function.prototype, "call", () => (calls++, undefined)),
  replaced("Object.create", Object, "create", () => (calls++, {})),
  replaced("Object.defineProperty", Object, "defineProperty", (o: unknown) => (calls++, o)),
  // Data written on a prototype: no call to count; the answers must not move. (Not `simulated` or
  // `mock` on Object.prototype: the emitter's own isFabricated call reads the caller's events, a
  // separate path from kernelPullCaptureIssue, which spec's intrinsics test covers for both.)
  written("Object.prototype.value", Object.prototype, "value", "CC0"),
  written("Array.prototype[0]", Array.prototype, 0, "forged"),
  {
    // The export is a mutable array; the check uses its own copy, taken at load.
    name: "the exported KERNEL_PULL_CAPTURE_TYPES written",
    apply: () => {
      const types = KERNEL_PULL_CAPTURE_TYPES as unknown as string[];
      const first = types[0]!;
      const second = types[1]!;
      types[0] = "execution_completed";
      types[1] = "forged";
      return () => {
        types[0] = first;
        types[1] = second;
      };
    },
  },
];

/** The answers with `row` applied, and the calls of what it replaced; restored before returning. */
function hostileRun(row: Row): { answers: Array<{ fixture: string; answer: unknown }>; calls: number } {
  const out: Answer[] = FIXTURES.map(() => ({ threw: "not run" }));
  calls = 0;
  const restore = row.apply();
  try {
    answerAll(out);
  } finally {
    restore();
  }
  return { answers: described(out), calls };
}

const GROUP_MISSING = "Missing one of: cv_inspection_result | camera_snapshot";

describe("astra pack 299 HIGH: nothing replaced after load changes the tier-2 answer for a camera event", () => {
  it("astra's reproduction: with RegExp.prototype.test replaced after load, an imageHash of \"invalid\" still fails tier 2, with the same answer", () => {
    const camera = lose1();
    camera.payload.imageHash = "invalid";
    const events = stored([...TIER1, camera]);
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const clean = emitter.checkTierRequirements(events, 2, undefined, OPTIONS);
    const test = RegExp.prototype.test;
    let hostile: unknown;
    try {
      RegExp.prototype.test = () => true;
      hostile = emitter.checkTierRequirements(events, 2, undefined, OPTIONS);
    } finally {
      RegExp.prototype.test = test;
    }
    expect(clean).toEqual({
      met: false,
      missing: [
        GROUP_MISSING,
        'camera_snapshot from cam-lose1: not an LO-SE-1 capture for this job (payload.imageHash "invalid" is not sha256:<64 lowercase hex>)',
        "Need at least 4 events, have 3",
      ],
    });
    expect(hostile).toEqual(clean);
  });

  it("the fixtures cover both answers: valid captures meet tier 2 and every invalid one fails it, naming its reason", () => {
    for (const c of CLEAN) {
      const answer = c.answer as { met: boolean; missing: string[] };
      if (c.fixture.startsWith("a valid ")) {
        expect(answer, c.fixture).toEqual({ met: true, missing: [] });
      } else {
        expect(answer.met, c.fixture).toBe(false);
        expect(answer.missing, c.fixture).toContain(GROUP_MISSING);
        expect(answer.missing.some((m) => m.includes(": not an LO-SE-1 capture for this job (")), c.fixture).toBe(true);
      }
    }
  });

  it.each(ROWS)("$name: every tier-2 answer is the untouched one, and nothing replaced is called", (row) => {
    const hostile = hostileRun(row);
    expect(hostile.answers).toEqual(CLEAN);
    expect(hostile.calls, "calls of what was replaced").toBe(0);
  });
});
