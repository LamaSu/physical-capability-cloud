/**
 * astra pack 299 HIGH (PR #578 @6804552c): kernelPullCaptureIssue looked its intrinsics up when it
 * ran, and the kernel's tier gate asks it whether a camera event counts toward tier 2. With
 * RegExp.prototype.test replaced after load, a capture whose imageHash is "invalid" counted
 * (reproduced at 6804552c: /mnt/sparkbulk/tmp/sensors/round8/order/r299/repro-299-at-6804552c.txt).
 *
 * The function and every helper it calls now go only through bindings captured when the module
 * loads. Each row below replaces (or writes) one intrinsic AFTER load and requires every answer,
 * null or the reason, to be exactly the untouched one over valid and invalid events (so a
 * replacement that forces either answer is caught), with no call of what was replaced. The
 * fixtures and the untouched answers are built before any replacement, the answers are compared
 * only after it is restored, and the code that runs in between is an indexed loop: the test's own
 * code never runs a replaced intrinsic.
 */

import { describe, expect, it } from "vitest";

import { KERNEL_PULL_CAPTURE_TYPES, kernelPullCaptureIssue } from "../evidence/kernel-pull-capture.js";

// Captured at load: the harness installs and restores every row through these, never through what a row replaced.
const defineAtLoad = Reflect.defineProperty;
const descriptorAtLoad = Reflect.getOwnPropertyDescriptor;
const deleteAtLoad = Reflect.deleteProperty;
const ITERATOR: typeof Symbol.iterator = Symbol.iterator;

const JOB = "job-lose1-r2-001";
const AT = "2026-10-02T12:00:00.000Z";
const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;

type Payload = Record<PropertyKey, unknown>;
interface TestEvent {
  type: string;
  timestamp?: unknown;
  source?: unknown;
  payload?: unknown;
  id?: string;
  hash?: string;
}

function capturePayload(): Payload {
  return {
    jobId: JOB,
    acquiredAt: AT,
    imageHash: HASH,
    storageRef: `photo:${HASH}`,
    frameStored: false,
    rawSizeBytes: 15_000,
    captureMode: "kernel-pull",
    captureClass: "CC0",
    device: { path: "/dev/video0", identity: "SER-1" },
    declaredChallengeId: null,
    declaredChallengeAnchor: null,
    antiSpoofScore: 1,
  };
}

function inspectionPayload(): Payload {
  return {
    ...capturePayload(),
    passed: true,
    confidence: 100,
    findings: ["anti-spoof heuristic score 1.00 on a frame the kernel acquired"],
    referenceHash: null,
    model: "anti-spoof-heuristic",
  };
}

function cameraSource(): Record<string, unknown> {
  return { deviceId: "cam-1", deviceType: "camera", kernelId: "k-1", firmwareVersion: "PullCameraAdapter-1.0.0" };
}

function snapshot(payload: Payload = capturePayload()): TestEvent {
  return { id: "ev-1", type: "camera_snapshot", timestamp: AT, source: cameraSource(), payload, hash: "sha256:00" };
}

function inspection(payload: Payload = inspectionPayload()): TestEvent {
  return { ...snapshot(payload), type: "cv_inspection_result" };
}

/** A capture (or inspection) whose payload, and the event itself, `edit` changed. */
function edited(edit: (p: Payload, e: TestEvent) => void, kind: "snapshot" | "inspection" = "snapshot"): TestEvent {
  const payload = kind === "snapshot" ? capturePayload() : inspectionPayload();
  const e = kind === "snapshot" ? snapshot(payload) : inspection(payload);
  edit(payload, e);
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
  event: TestEvent;
  jobId: string;
}

const fixture = (name: string, event: TestEvent, jobId: string = JOB): Fixture => ({ name, event, jobId });

/**
 * Valid events (a replacement that forces a refusal shows here) and invalid ones (a replacement
 * that forces an acceptance, or another reason, shows here). Built once, before any replacement.
 */
const FIXTURES: readonly Fixture[] = [
  fixture("a valid camera_snapshot", snapshot()),
  fixture("a valid cv_inspection_result", inspection()),
  fixture(
    "a valid capture that declares a challenge",
    edited((p) => {
      p.declaredChallengeId = "challenge-1";
      p.declaredChallengeAnchor = "0xblock";
    }),
  ),
  fixture(
    "a valid inspection at its bounds, with no findings",
    edited((p) => {
      p.antiSpoofScore = 0;
      p.confidence = 0;
      p.findings = [];
      p.referenceHash = HASH;
      p.passed = false;
    }, "inspection"),
  ),
  fixture(
    "a valid capture on a null-prototype source and payload",
    edited((p, e) => {
      e.payload = Object.assign(Object.create(null) as Payload, p);
      e.source = Object.assign(Object.create(null) as object, cameraSource());
    }),
  ),
  fixture('imageHash "invalid" (astra pack 299)', edited((p) => (p.imageHash = "invalid"))),
  fixture("an uppercase-hex imageHash", edited((p) => (p.imageHash = HASH.toUpperCase().replace("SHA256", "sha256")))),
  fixture("an imageHash with a trailing newline", edited((p) => (p.imageHash = `${HASH}\n`))),
  fixture("an imageHash with another prefix", edited((p) => (p.imageHash = HASH.replace("sha256", "sha512")))),
  fixture("an accessor captureClass whose getter says CC0", edited((p) => accessor(p, "captureClass", "CC0"))),
  fixture("an accessor source.deviceType whose getter says camera", edited((_p, e) => accessor(e.source as object, "deviceType", "camera"))),
  fixture("an accessor payload.device.path", edited((p) => accessor(p.device as object, "path", "/dev/video0"))),
  fixture("an accessor findings element", edited((p) => accessor(p.findings as object, 0, "ok"), "inspection")),
  fixture("an accessor event.payload", edited((p, e) => accessor(e, "payload", p))),
  fixture("an extra key", edited((p) => (p.extra = 1))),
  fixture("a symbol key", edited((p) => (p[Symbol("hidden")] = 1))),
  fixture("a non-enumerable key", edited((p) => Object.defineProperty(p, "captureClass", { value: "CC0", enumerable: false }))),
  fixture("a missing key", edited((p) => delete p.antiSpoofScore)),
  fixture("a missing inspection key", edited((p) => delete p.model, "inspection")),
  fixture("a capture for another job", edited((p) => (p.jobId = "job-other"))),
  fixture("a capture for a job whose id is longer than 80 characters", edited((p) => (p.jobId = `job-${"x".repeat(100)}`))),
  fixture("a blank jobId to bind to", edited((p) => (p.jobId = "  ")), "  "),
  fixture("a blank storageRef", edited((p) => (p.storageRef = "   "))),
  fixture("frameStored not a boolean", edited((p) => (p.frameStored = "false"))),
  fixture("rawSizeBytes 1.5", edited((p) => (p.rawSizeBytes = 1.5))),
  fixture("rawSizeBytes 2 ** 53", edited((p) => (p.rawSizeBytes = 2 ** 53))),
  fixture("antiSpoofScore NaN", edited((p) => (p.antiSpoofScore = Number.NaN))),
  fixture("confidence Infinity", edited((p) => (p.confidence = Number.POSITIVE_INFINITY), "inspection")),
  fixture(
    "acquiredAt not canonical (the timestamp the same)",
    edited((p, e) => {
      p.acquiredAt = "2026-10-02T12:00:00Z";
      e.timestamp = "2026-10-02T12:00:00Z";
    }),
  ),
  fixture(
    "acquiredAt not a date (the timestamp the same)",
    edited((p, e) => {
      p.acquiredAt = "not a date";
      e.timestamp = "not a date";
    }),
  ),
  fixture("acquiredAt not the event's timestamp", edited((p) => (p.acquiredAt = "2026-10-02T12:00:01.000Z"))),
  fixture("acquiredAt as epoch milliseconds", edited((p) => (p.acquiredAt = Date.parse(AT)))),
  // eslint-disable-next-line no-sparse-arrays
  fixture("findings with a hole", edited((p) => (p.findings = [, "ok"]), "inspection")),
  fixture("findings an array-like object", edited((p) => (p.findings = { 0: "ok", length: 1 }), "inspection")),
  fixture("findings with a foreign prototype", edited((p) => (p.findings = Object.setPrototypeOf(["ok"], { map: () => ["forged"] }) as unknown), "inspection")),
  fixture("findings with an extra own key", edited((p) => (p.findings = Object.assign(["ok"], { extra: "x" })), "inspection")),
  fixture("findings with a non-string", edited((p) => (p.findings = ["ok", 1]), "inspection")),
  fixture("a device with an extra key", edited((p) => (p.device = { path: "/dev/video0", identity: "SER-1", serial: "SER-1" }))),
  fixture("a device missing identity", edited((p) => (p.device = { path: "/dev/video0" }))),
  fixture("a device with a blank identity", edited((p) => (p.device = { path: "/dev/video0", identity: "  " }))),
  fixture("an array device", edited((p) => (p.device = ["/dev/video0", "SER-1"]))),
  fixture("declaredChallengeAnchor without declaredChallengeId", edited((p) => (p.declaredChallengeAnchor = "0xblock"))),
  fixture("a source that is not a camera", edited((_p, e) => (e.source = { ...cameraSource(), deviceType: "controller" }))),
  fixture("a simulated source", edited((_p, e) => (e.source = { ...cameraSource(), simulated: true }))),
  fixture("payload.mock", edited((p) => (p.mock = true))),
  fixture("a class-instance payload", edited((p, e) => (e.payload = new NotPlain(p)))),
  fixture("a class-instance source", edited((_p, e) => (e.source = new NotPlain(cameraSource())))),
  fixture("an array payload", edited((_p, e) => (e.payload = []))),
  fixture("a type that is not a camera type", edited((_p, e) => (e.type = "execution_completed"))),
  fixture("a camera_snapshot carrying the inspection keys", snapshot(inspectionPayload())),
  fixture("a payload that is a Proxy", edited((p, e) => (e.payload = new Proxy(p, {})))),
  fixture("a bigint jobId in the payload", edited((p) => (p.jobId = 5n))),
  fixture("a null event", null as unknown as TestEvent),
];

/** Each fixture's answer: null, the reason, or what it threw. */
type Answer = string | null | { threw: unknown };

/** The answers in a form that compares by value; called only after every replacement is restored. */
function described(answers: readonly Answer[]): Array<{ fixture: string; answer: unknown }> {
  return answers.map((answer, i) => ({
    fixture: FIXTURES[i]!.name,
    answer: answer !== null && typeof answer === "object" ? `threw: ${String((answer.threw as Error)?.message)}` : answer,
  }));
}

/** Every fixture's answer, in an indexed loop that writes only to elements `out` already owns. */
function answerAll(out: Answer[]): void {
  for (let i = 0; i < FIXTURES.length; i++) {
    const f = FIXTURES[i]!;
    try {
      out[i] = kernelPullCaptureIssue(f.event, f.jobId);
    } catch (err) {
      out[i] = { threw: err };
    }
  }
}

const CLEAN = (() => {
  const out: Answer[] = FIXTURES.map(() => "not run");
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
  // Data written on a prototype: no call to count; the answers must not move.
  written("Object.prototype.value", Object.prototype, "value", "CC0"),
  written("Object.prototype.simulated", Object.prototype, "simulated", true),
  written("Object.prototype.mock", Object.prototype, "mock", true),
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
  const out: Answer[] = FIXTURES.map(() => "not run");
  calls = 0;
  const restore = row.apply();
  try {
    answerAll(out);
  } finally {
    restore();
  }
  return { answers: described(out), calls };
}

describe("astra pack 299 HIGH: nothing replaced after load changes kernelPullCaptureIssue's answer", () => {
  it("the fixtures cover both answers: valid captures are accepted and each invalid one is refused", () => {
    const accepted = CLEAN.filter((c) => c.answer === null).map((c) => c.fixture);
    expect(accepted).toEqual([
      "a valid camera_snapshot",
      "a valid cv_inspection_result",
      "a valid capture that declares a challenge",
      "a valid inspection at its bounds, with no findings",
      "a valid capture on a null-prototype source and payload",
    ]);
    for (const c of CLEAN) expect(typeof c.answer === "string" || c.answer === null, c.fixture).toBe(true);
  });

  it("astra's reproduction: with RegExp.prototype.test replaced after load (() => true), an imageHash of \"invalid\" is still refused", () => {
    const event = edited((p) => (p.imageHash = "invalid"));
    const clean = kernelPullCaptureIssue(event, JOB);
    const test = RegExp.prototype.test;
    let hostile: unknown;
    try {
      RegExp.prototype.test = () => true;
      hostile = kernelPullCaptureIssue(event, JOB);
    } finally {
      RegExp.prototype.test = test;
    }
    expect(clean).toBe('payload.imageHash "invalid" is not sha256:<64 lowercase hex>');
    expect(hostile).toBe(clean);
  });

  it("with Object.prototype.value written, an accessor is still refused as one, and its getter never runs", () => {
    const payload = capturePayload();
    let ran = false;
    Object.defineProperty(payload, "captureClass", {
      enumerable: true,
      configurable: true,
      get() {
        ran = true;
        return "CC0";
      },
    });
    const event = snapshot(payload);
    let answer: unknown;
    try {
      // An accessor's descriptor has no own `value`; read through `in`, an inherited one would make it look like data.
      Object.defineProperty(Object.prototype, "value", { value: "CC0", writable: true, enumerable: false, configurable: true });
      answer = kernelPullCaptureIssue(event, JOB);
    } finally {
      delete (Object.prototype as { value?: unknown }).value;
    }
    expect(answer).toBe("payload.captureClass is an accessor, not an own data property");
    expect(ran).toBe(false);
  });

  it.each(ROWS)("$name: every answer is the untouched one, and nothing replaced is called", (row) => {
    const hostile = hostileRun(row);
    expect(hostile.answers).toEqual(CLEAN);
    expect(hostile.calls, "calls of what was replaced").toBe(0);
  });
});
