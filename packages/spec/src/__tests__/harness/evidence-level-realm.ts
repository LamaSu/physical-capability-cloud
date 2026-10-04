/**
 * One realm for the evidence-level realm-mutation harness (../evidence-level-intrinsics.test.ts).
 *
 * Why a child process: vitest runs its own runner in the realm of the test it
 * runs, so a test that replaces an intrinsic breaks vitest itself (see
 * admission-realm.ts). Each scenario runs here, in a process that holds only
 * @pcc/spec, this file and Node. That is also the threat: post-load code in a
 * process that loaded @pcc/spec first.
 *
 *   1. load: the static imports below;
 *   2. build every item, and run them clean;
 *   3. apply the scenario's change, run the items again, undo the change;
 *   4. print one JSON line: { scenario, clean, patched }.
 *
 * Usage: tsx evidence-level-realm.ts <scenario id> | --list
 * The code that runs while a change is in place (`results`, `copy` and the
 * items) uses index loops, literals and operators only.
 */
import { pathToFileURL } from "node:url";

import {
  DEVICE_REPORTED_EVENT_TYPES,
  deriveContradictions,
  EVIDENCE_LEVELS,
  evidenceLevelOfBundles,
  evidenceLevelRank,
  evidenceLevelsOfEvents,
  EXECUTION_EVENT_TYPES,
  INSPECTION_EVENT_TYPES,
  inspectionFailed,
  inspectionVerdict,
  meetsEvidenceLevel,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
  NON_EXECUTOR_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
  type AuthenticatedBundle,
  type EvidenceLevel,
} from "../../evidence/evidence-level.js";
import type { EvidenceEvent } from "../../types/evidence.js";

// -- what this file itself calls while a change is in place, captured at load --
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectDeleteProperty = Reflect.deleteProperty;
const ObjectCreate = Object.create;
const ObjectKeys = Object.keys;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;

/** A property descriptor with a null prototype: once Object.prototype.value or .get is written, a literal would inherit it. */
function nullDescriptor(fields: Record<string, unknown>): PropertyDescriptor {
  const d = ObjectCreate(null) as Record<string, unknown>;
  const keys = ObjectKeys(fields);
  for (let i = 0; i < keys.length; i++) d[keys[i]!] = fields[keys[i]!];
  return d as PropertyDescriptor;
}

// -- builders, run before any change --
const EXEC = `eip155:1:0x${"11".repeat(20)}`;
const INSP = `eip155:1:0x${"22".repeat(20)}`;
const OTHER = `eip155:8453:0x${"33".repeat(20)}`;
const PRINTER = "dev-printer";
const CAMERA = "dev-camera";
const T = "2026-10-03T12:00:00.000Z";

function ev(type: string, deviceId: string | undefined, payload: Record<string, unknown> = {}, extraSource: Record<string, unknown> = {}): EvidenceEvent {
  const source: Record<string, unknown> = { deviceType: "machine", kernelId: "kernel-realm", ...extraSource };
  if (deviceId !== undefined) source.deviceId = deviceId;
  return { type, timestamp: T, source, payload } as unknown as EvidenceEvent;
}
const bundle = (events: EvidenceEvent[], trustDomain?: string): AuthenticatedBundle =>
  (trustDomain === undefined ? { events } : { events, trustDomain }) as AuthenticatedBundle;

const printed = () => [ev("execution_started", PRINTER), ev("execution_completed", PRINTER)];
const camera = (payload: Record<string, unknown>) => [ev("cv_inspection_result", CAMERA, payload)];
const accessorPinned = (): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  Object.defineProperty(payload, "passed", { get: () => true, enumerable: true });
  return payload;
};
const ctx = { executorTrustDomains: [EXEC] };

const B = {
  independent: [bundle(printed(), EXEC), bundle(camera({ passed: true }), INSP)],
  selfInspect: [bundle(printed(), EXEC), bundle(camera({ passed: true }), EXEC)],
  unknownExecutor: [bundle(printed()), bundle(camera({ passed: true }), INSP)],
  fabricatedPrinter: [bundle([ev("execution_completed", PRINTER, {}, { simulated: true })], EXEC), bundle(camera({ passed: true }), INSP)],
  mockCamera: [bundle(printed(), EXEC), bundle(camera({ passed: true, mock: true }), INSP)],
  failedInspection: [bundle(printed(), EXEC), bundle(camera({ passed: false }), INSP)],
  noVerdict: [bundle(printed(), EXEC), bundle(camera({}), INSP)],
  foldedSpelling: [bundle(printed(), EXEC), bundle(camera({ Passed: true }), INSP)],
  twoVerdicts: [bundle(printed(), EXEC), bundle(camera({ passed: true, status: "PASS" }), INSP)],
  accessor: [bundle(printed(), EXEC), bundle(camera(accessorPinned()), INSP)],
  gatewayStamp: [bundle([ev("execution_completed", " Gateway ")], EXEC)],
  noDevice: [bundle([ev("execution_completed", undefined)], EXEC)],
  completionFailure: [bundle([...printed(), ev("execution_failed", PRINTER)], EXEC)],
  failureAlone: [bundle([ev("execution_started", PRINTER), ev("execution_failed", PRINTER)], EXEC)],
  batchPass: [bundle(printed(), EXEC), bundle([ev("batch_sample_result", CAMERA, { status: "PASS" })], OTHER)],
  instrumentFail: [bundle(printed(), EXEC), bundle([ev("instrument_result", CAMERA, { pass: false })], OTHER)],
  submittedOnly: [bundle([ev("gcode_received", PRINTER), ev("execution_progress", PRINTER)], EXEC)],
  empty: [] as AuthenticatedBundle[],
};

const principal = (chainId: string, hex = "ab".repeat(20)) => `eip155:${chainId}:0x${hex}`;
const DOMAIN_CANDIDATES: Array<[string, string]> = [
  ["valid chain 1", principal("1")],
  ["valid chain 9007199254740991", principal("9007199254740991")],
  ["unsafe chain 9007199254740992", principal("9007199254740992")],
  ["17-digit chain", principal("10000000000000000")],
  ["leading zero", principal("01")],
  ["chain 0", principal("0")],
  ["uppercase hex", principal("1", "AB".repeat(20))],
  ["39 hex", principal("1", "ab".repeat(19) + "a")],
  ["trailing newline", `${principal("1")}\n`],
  ["EIP155 prefix", `EIP155:1:0x${"ab".repeat(20)}`],
  ["fullwidth digit", principal("１")],
];

const meetsPairs: Array<[EvidenceLevel | null, EvidenceLevel]> = [
  ["submitted", "inspected_output"], ["device_reported", "inspected_output"], ["inspected_output", "inspected_output"],
  ["submitted", "device_reported"], ["inspected_output", "submitted"], [null, "submitted"],
];

type Item = [label: string, run: () => unknown];
const ITEMS: Item[] = [];
const keys = ObjectKeys(B) as Array<keyof typeof B>;
for (let i = 0; i < keys.length; i++) {
  const name = keys[i]!;
  ITEMS[ITEMS.length] = [`levelOfBundles ${name}, assigned`, () => evidenceLevelOfBundles(B[name], ctx)];
  ITEMS[ITEMS.length] = [`levelOfBundles ${name}, no context`, () => evidenceLevelOfBundles(B[name])];
  ITEMS[ITEMS.length] = [`levelsOfEvents ${name}, assigned`, () => evidenceLevelsOfEvents(B[name], ctx)];
  ITEMS[ITEMS.length] = [`contradictions ${name}`, () => deriveContradictions(B[name])];
}
const inspections: Array<[string, EvidenceEvent]> = [
  ["cv passed", camera({ passed: true })[0]!],
  ["cv failed", camera({ passed: false })[0]!],
  ["cv none", camera({})[0]!],
  ["cv Passed", camera({ Passed: true })[0]!],
  ["cv passed + status", camera({ passed: true, status: "PASS" })[0]!],
  ["cv accessor", camera(accessorPinned())[0]!],
  ["cv passed 'yes'", camera({ passed: "yes" })[0]!],
  ["batch PASS", ev("batch_sample_result", CAMERA, { status: "PASS" })],
  ["batch pass", ev("batch_sample_result", CAMERA, { status: "pass" })],
  ["instrument false", ev("instrument_result", CAMERA, { pass: false })],
  ["photo comparison verdict", ev("photo_comparison_result", CAMERA, { result: "ok" })],
  ["not an inspection", ev("execution_completed", PRINTER, { passed: false })],
];
for (let i = 0; i < inspections.length; i++) {
  const [label, event] = inspections[i]!;
  ITEMS[ITEMS.length] = [`verdict ${label}`, () => inspectionVerdict(event)];
  ITEMS[ITEMS.length] = [`failed ${label}`, () => inspectionFailed(event)];
}
for (let i = 0; i < meetsPairs.length; i++) {
  const [reached, required] = meetsPairs[i]!;
  ITEMS[ITEMS.length] = [`meets ${String(reached)} for ${required}`, () => meetsEvidenceLevel(reached, required)];
}
for (let i = 0; i < EVIDENCE_LEVELS.length; i++) {
  const level = EVIDENCE_LEVELS[i]!;
  ITEMS[ITEMS.length] = [`rank ${level}`, () => evidenceLevelRank(level)];
}
ITEMS[ITEMS.length] = ["rank vibes", () => evidenceLevelRank("vibes" as EvidenceLevel)];
for (let i = 0; i < DOMAIN_CANDIDATES.length; i++) {
  const [label, domain] = DOMAIN_CANDIDATES[i]!;
  const declared = [bundle(printed(), domain)];
  const assigned = { executorTrustDomains: [domain] };
  ITEMS[ITEMS.length] = [`trustDomain ${label}`, () => evidenceLevelOfBundles(declared, ctx)];
  ITEMS[ITEMS.length] = [`executorTrustDomains ${label}`, () => evidenceLevelOfBundles(B.independent, assigned)];
}
const NOT_BUNDLES = {} as unknown as AuthenticatedBundle[];
const NOT_EVENTS = [{ events: {} } as unknown as AuthenticatedBundle];
ITEMS[ITEMS.length] = ["bundles not an array", () => evidenceLevelOfBundles(NOT_BUNDLES)];
ITEMS[ITEMS.length] = ["events not an array", () => evidenceLevelOfBundles(NOT_EVENTS)];
ITEMS[ITEMS.length] = ["context not an object", () => evidenceLevelOfBundles(B.independent, 7 as never)];

// Inputs that leave a field to inheritance: each answer must not change when Object.prototype
// (or Array.prototype) supplies it.
const EMPTY_CONTEXT = {};
const SPARSE_ASSIGNED = { executorTrustDomains: new Array<string>(1) };
const NO_TYPE = [bundle([{ timestamp: T, source: { deviceId: PRINTER, deviceType: "machine" }, payload: {} } as unknown as EvidenceEvent], EXEC)];
const NO_SOURCE = [bundle([{ type: "execution_completed", timestamp: T, payload: {} } as unknown as EvidenceEvent], EXEC)];
const NO_PAYLOAD = [bundle(printed(), EXEC), bundle([{ type: "cv_inspection_result", timestamp: T, source: { deviceId: CAMERA, deviceType: "camera" } } as unknown as EvidenceEvent], INSP)];
const NO_EVENTS = [{ trustDomain: EXEC } as unknown as AuthenticatedBundle];
ITEMS[ITEMS.length] = ["an empty context", () => evidenceLevelOfBundles(B.independent, EMPTY_CONTEXT)];
ITEMS[ITEMS.length] = ["a hole in executorTrustDomains", () => evidenceLevelOfBundles(B.independent, SPARSE_ASSIGNED)];
ITEMS[ITEMS.length] = ["an event with no type", () => evidenceLevelOfBundles(NO_TYPE, ctx)];
ITEMS[ITEMS.length] = ["an event with no source", () => evidenceLevelOfBundles(NO_SOURCE, ctx)];
ITEMS[ITEMS.length] = ["an inspection with no payload", () => evidenceLevelOfBundles(NO_PAYLOAD, ctx)];
ITEMS[ITEMS.length] = ["an inspection with no payload: verdict", () => inspectionVerdict(NO_PAYLOAD[1]!.events[0]!)];
ITEMS[ITEMS.length] = ["a bundle with no events", () => evidenceLevelOfBundles(NO_EVENTS, ctx)];
const SPARSE_BUNDLES = new Array<AuthenticatedBundle>(1);
const SPARSE_EVENTS = [{ events: new Array<EvidenceEvent>(1), trustDomain: EXEC } as unknown as AuthenticatedBundle];
ITEMS[ITEMS.length] = ["a hole in bundles", () => evidenceLevelOfBundles(SPARSE_BUNDLES, ctx)];
ITEMS[ITEMS.length] = ["a hole in a bundle's events", () => evidenceLevelOfBundles(SPARSE_EVENTS, ctx)];
ITEMS[ITEMS.length] = ["a hole in bundles: contradictions", () => deriveContradictions(SPARSE_BUNDLES)];

// -- running items while a change is in place: index loops, literals and operators only --
type Row = [label: string, value: unknown];

/** A plain copy of an answer: frozen records become plain records, lists plain lists. */
function copy(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown> & { length?: unknown };
  if (typeof v.length === "number") {
    const out: unknown[] = [];
    for (let i = 0; i < (v.length as number); i++) out[i] = copy((value as unknown[])[i]);
    return out;
  }
  return { bundleIndex: v.bundleIndex, eventIndex: v.eventIndex, level: v.level };
}

function results(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < ITEMS.length; i++) {
    let value: unknown;
    try {
      value = copy(ITEMS[i]![1]());
    } catch (err) {
      value = `threw ${(err as { name?: unknown }).name === "EvidenceLevelInputError" ? "EvidenceLevelInputError" : "other"}`;
    }
    rows[i] = [ITEMS[i]![0], value];
  }
  return rows;
}

// -- the changes --
type Apply = () => () => void;

function replace(target: object, key: PropertyKey, make: (original: any) => unknown): Apply {
  return () => {
    const original = ReflectGetOwnPropertyDescriptor(target, key)!;
    const changed = nullDescriptor({ configurable: original.configurable, enumerable: original.enumerable, writable: original.writable, value: make(original.value) });
    ReflectDefineProperty(target, key, changed);
    return () => void ReflectDefineProperty(target, key, original);
  };
}

function replaceGetter(target: object, key: PropertyKey, make: (original: any) => () => unknown): Apply {
  return () => {
    const original = ReflectGetOwnPropertyDescriptor(target, key)!;
    ReflectDefineProperty(target, key, nullDescriptor({ configurable: original.configurable, enumerable: original.enumerable, get: make(original.get), set: original.set }));
    return () => void ReflectDefineProperty(target, key, original);
  };
}

/** Write `values` onto Object.prototype (non-enumerable), as post-load code could. */
function pollute(values: () => Record<string, unknown>): Apply {
  return () => {
    const v = values();
    const names = ObjectKeys(v);
    for (let i = 0; i < names.length; i++) {
      ReflectDefineProperty(Object.prototype, names[i]!, nullDescriptor({ value: v[names[i]!], writable: true, configurable: true, enumerable: false }));
    }
    return () => {
      for (let i = 0; i < names.length; i++) ReflectDeleteProperty(Object.prototype, names[i]!);
    };
  };
}

/** Exported data evidence-level reads, written as post-load code could; a frozen list refuses. */
function mutate(change: () => () => void): Apply {
  return () => {
    try {
      return change();
    } catch {
      return () => undefined;
    }
  };
}
const pushOnto = (list: readonly unknown[], value: unknown) => () => {
  (list as unknown[]).push(value);
  return () => void (list as unknown[]).pop();
};

const SCENARIOS: Array<[id: string, apply: Apply]> = [
  ["Array.prototype.map", replace(Array.prototype, "map", () => () => [])],
  ["Array.prototype.filter", replace(Array.prototype, "filter", () => () => [])],
  ["Array.prototype.some", replace(Array.prototype, "some", () => () => true)],
  ["Array.prototype.every", replace(Array.prototype, "every", () => () => false)],
  ["Array.prototype.includes", replace(Array.prototype, "includes", () => () => true)],
  ["Array.prototype.indexOf", replace(Array.prototype, "indexOf", () => () => 2)],
  ["Array.prototype.push", replace(Array.prototype, "push", () => () => 0)],
  ["Array.prototype.slice", replace(Array.prototype, "slice", () => () => [])],
  ["Array.prototype.concat", replace(Array.prototype, "concat", () => () => [])],
  ["Array.prototype[Symbol.iterator]", replace(Array.prototype, Symbol.iterator, () => function* () {})],
  ["%ArrayIteratorPrototype%.next", replace(ArrayIteratorPrototype, "next", () => () => ({ done: true, value: undefined }))],
  ["Array.isArray", replace(Array, "isArray", () => () => false)],
  ["Array.prototype[0] = a principal", () => {
    ReflectDefineProperty(Array.prototype, "0", nullDescriptor({ value: EXEC, writable: true, configurable: true, enumerable: false }));
    return () => void ReflectDeleteProperty(Array.prototype, "0");
  }],
  ["Array.prototype[0] = a completed bundle and event", () => {
    // One object that reads as a bundle (events, trustDomain) and as an event (type, source, payload).
    const forged = { events: [ev("execution_completed", PRINTER), ev("execution_failed", PRINTER)], trustDomain: EXEC, type: "execution_completed", timestamp: T, source: { deviceId: PRINTER, deviceType: "machine" }, payload: {} };
    ReflectDefineProperty(Array.prototype, "0", nullDescriptor({ value: forged, writable: true, configurable: true, enumerable: false }));
    return () => void ReflectDeleteProperty(Array.prototype, "0");
  }],
  ["Object.freeze", replace(Object, "freeze", () => (v: unknown) => v)],
  ["Object.keys", replace(Object, "keys", () => () => [])],
  ["Object.create", replace(Object, "create", () => () => ({}))],
  ["Object.getOwnPropertyNames", replace(Object, "getOwnPropertyNames", () => () => [])],
  ["Object.getOwnPropertyDescriptor", replace(Object, "getOwnPropertyDescriptor", () => () => ({ value: true }))],
  ["Object.getPrototypeOf", replace(Object, "getPrototypeOf", () => () => Array.prototype)],
  ["Object.prototype.hasOwnProperty", replace(Object.prototype, "hasOwnProperty", () => () => true)],
  ["Reflect.ownKeys", replace(Reflect, "ownKeys", () => () => [])],
  ["Set.prototype.has", replace(Set.prototype, "has", () => () => false)],
  ["Set.prototype.add", replace(Set.prototype, "add", () => function (this: unknown) { return this; })],
  ["Set.prototype.size", replaceGetter(Set.prototype, "size", () => () => 0)],
  ["Map.prototype.get", replace(Map.prototype, "get", () => () => undefined)],
  ["RegExp.prototype.exec", replace(RegExp.prototype, "exec", () => () => null)],
  ["RegExp.prototype.test", replace(RegExp.prototype, "test", () => () => false)],
  ["String.prototype.charCodeAt", replace(String.prototype, "charCodeAt", () => () => 0x41)],
  ["String.prototype.charAt", replace(String.prototype, "charAt", () => () => "x")],
  ["String.prototype.toLowerCase", replace(String.prototype, "toLowerCase", () => () => "passed")],
  ["String.fromCharCode", replace(String, "fromCharCode", () => () => "x")],
  ["String", replace(globalThis, "String", () => () => "x")],
  ["Number", replace(globalThis, "Number", () => () => 1)],
  ["Number.isSafeInteger", replace(Number, "isSafeInteger", () => () => false)],
  ["Number.isInteger", replace(Number, "isInteger", () => () => false)],
  ["Math.max", replace(Math, "max", () => () => 0)],
  ["Function.prototype.call", replace(Function.prototype, "call", () => () => undefined)],
  ["Function.prototype.apply", replace(Function.prototype, "apply", () => () => undefined)],
  ["Function.prototype.bind", replace(Function.prototype, "bind", () => () => () => undefined)],
  ["Object.prototype.value = true", pollute(() => ({ value: true }))],
  ["Object.prototype.passed = true", pollute(() => ({ passed: true }))],
  ["Object.prototype.passed = false", pollute(() => ({ passed: false }))],
  ["Object.prototype.pass and status", pollute(() => ({ pass: true, status: "PASS" }))],
  ["Object.prototype.deviceId", pollute(() => ({ deviceId: PRINTER }))],
  ["Object.prototype.simulated = true", pollute(() => ({ simulated: true }))],
  ["Object.prototype.mock = true", pollute(() => ({ mock: true }))],
  ["Object.prototype.trustDomain", pollute(() => ({ trustDomain: OTHER }))],
  ["Object.prototype.executorTrustDomains", pollute(() => ({ executorTrustDomains: [EXEC] }))],
  ["Object.prototype.type = execution_completed", pollute(() => ({ type: "execution_completed" }))],
  ["Object.prototype.source", pollute(() => ({ source: { deviceId: PRINTER, deviceType: "machine" } }))],
  ["Object.prototype.payload", pollute(() => ({ payload: { passed: true } }))],
  ["Object.prototype.events", pollute(() => ({ events: [ev("execution_completed", PRINTER)] }))],
  ["Object.prototype.instrument_result (pinned table)", pollute(() => ({ photo_comparison_result: { field: "result", read: () => "pass" } }))],
  ["DEVICE_REPORTED_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(DEVICE_REPORTED_EVENT_TYPES, "cv_inspection_result"))],
  ["SUBMITTED_EVENT_TYPES += execution_failed", mutate(pushOnto(SUBMITTED_EVENT_TYPES, "execution_failed"))],
  ["INSPECTION_EVENT_TYPES += execution_completed", mutate(pushOnto(INSPECTION_EVENT_TYPES, "execution_completed"))],
  ["NO_OUTCOME_LEVEL_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(NO_OUTCOME_LEVEL_EVENT_TYPES, "cv_inspection_result"))],
  ["EXECUTION_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(EXECUTION_EVENT_TYPES, "cv_inspection_result"))],
  ["NON_EXECUTOR_EVENT_TYPES += execution_completed", mutate(pushOnto(NON_EXECUTOR_EVENT_TYPES, "execution_completed"))],
  ["EVIDENCE_LEVELS += vibes", mutate(pushOnto(EVIDENCE_LEVELS, "vibes"))],
];

// -- main --
function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function main(): void {
  const id = process.argv[2];
  if (id === "--list") {
    write(SCENARIOS.map((s) => s[0]));
    return;
  }
  let scenario: [string, Apply] | undefined;
  for (let i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i]![0] === id) scenario = SCENARIOS[i];
  if (scenario === undefined) throw new Error(`no scenario ${JSON.stringify(id)}`);
  const clean = results();
  let undo: () => void = () => undefined;
  let patched: unknown;
  try {
    undo = scenario[1]();
    patched = results();
  } catch (err) {
    patched = `the scenario threw: ${String(err)}`;
  } finally {
    undo();
  }
  write({ scenario: id, clean, patched });
}

// Run only when invoked as a script (tsx evidence-level-realm.ts ...), never when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
