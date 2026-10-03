/**
 * One realm for the registration realm-mutation harness
 * (../profile-registration-intrinsics.test.ts), built like admission-realm.ts:
 * a child process holding only @pcc/spec, this file and Node. It loads, builds
 * every registration request, runs them clean, makes one change after load,
 * runs them again, undoes it, and prints one JSON line:
 * { scenario, clean, patched } or { scenario, clean, hung: true }.
 * Results are serialized only after the change is undone.
 *
 * Usage: tsx registration-realm.ts <scenario id> | --list
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { checkProfileRegistration, type ProfileRegistrationRequest } from "../../evidence/profile-registration.js";
import { computeMeasurementProfileDigest, type MeasurementProfileV1 } from "../../evidence/measurement-profile.js";

// -- what this file itself calls while a change is in place, captured at load --
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectDeleteProperty = Reflect.deleteProperty;
const ReflectApply = Reflect.apply;
const ObjectCreate = Object.create;
const setTimeoutAtLoad = setTimeout;
const clearTimeoutAtLoad = clearTimeout;

function nullDescriptor(fields: Record<string, unknown>): PropertyDescriptor {
  const d = ObjectCreate(null) as Record<string, unknown>;
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) d[keys[i]!] = fields[keys[i]!];
  return d as PropertyDescriptor;
}

// -- builders (profile-registration.test.ts), run before any change --
const CAMERA = "dev-camera";
const VERSION = "PhotoCameraAdapter-1.0.0";

function cameraProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/test/inspected-page/v1",
    outcome: {
      capabilityType: "document-printing",
      statement: "The page was printed and a separate camera inspected it.",
      objectIdentity: { kind: "documentHash", value: "sha256:" + "c".repeat(64) },
    },
    device: { deviceId: CAMERA, kind: "camera", adapterType: "photo", permittedAdapterVersions: [VERSION], permittedFirmwareVersions: [VERSION] },
    measurement: { method: "optical-capture", quantity: "printed-page-image", unit: "none", sampling: { minSamples: 1 } },
    capture: { startCondition: "execution_completed", endCondition: "open", coverage: { policy: "one-shot", minFraction: 1 } },
    calibration: { required: false },
    interpretation: { evidenceTypeIds: ["capture.photo_nonced"], acceptanceLevel: "inspected_output", onDeviceFailure: "reject" },
    simulationProhibited: true,
    witnesses: { requiredRoles: [], independentOfClaimant: false },
    onMissingData: "reject",
    onContradiction: "reject",
  };
}

function edit(change: (p: MeasurementProfileV1) => void): MeasurementProfileV1 {
  const p = cameraProfile();
  change(p);
  return p;
}

const request = (profile: unknown, over: Partial<{ capabilityType: string; deviceId: string; claimedDigest: string }> = {}): ProfileRegistrationRequest => ({
  capabilityType: "document-printing",
  deviceId: CAMERA,
  profile,
  ...over,
});

let CASES: Array<[string, ProfileRegistrationRequest]> = [];

function buildCases(): void {
  const cases: Array<[string, ProfileRegistrationRequest]> = [];
  const add = (label: string, value: ProfileRegistrationRequest) => cases.push([label, value]);
  const p = cameraProfile();
  add("accepted: the camera profile", request(p));
  add("accepted: with the matching client digest", request(p, { claimedDigest: computeMeasurementProfileDigest(p) }));
  add("accepted: disjoint adapter and firmware pins", request(edit((x) => (x.device.permittedFirmwareVersions = ["cam-fw-2.1.0"]))));
  add("accepted: a numeric profile", request(edit((x) => {
    x.measurement = { method: "load-cell", quantity: "mass", unit: "kg", sampling: { minSamples: 2 } };
    x.interpretation = { ...x.interpretation, evidenceTypeIds: ["artifact.hash", "capture.photo_nonced"] };
  })));
  add("refused: an invalid profile", request({ ...cameraProfile(), simulationProhibited: false }));
  add("refused: a profile that is not an object", request("not a profile"));
  add("refused: another device", request(p, { deviceId: "dev-other" }));
  add("refused: another capability type", request(p, { capabilityType: "cnc-milling" }));
  add("refused: a tolerance", request(edit((x) => (x.measurement.tolerance = { comparator: ">=", target: 0.9 }))));
  add("refused: a wildcard pin", request(edit((x) => (x.device.permittedFirmwareVersions = ["*-unpinned-pilot"]))));
  add("refused: a device kind no source carries", request(edit((x) => (x.device.kind = "machine"))));
  add("refused: an inactive primitive", request(edit((x) => (x.interpretation.evidenceTypeIds = ["capture.no_such_primitive"]))));
  add("refused: required calibration", request(edit((x) => (x.calibration = { required: true, procedureId: "cal-1", validityWindowSeconds: 3600 }))));
  add("refused: required witnesses", request(edit((x) => (x.witnesses = { requiredRoles: ["inspector"], independentOfClaimant: true }))));
  add("refused: continuous coverage", request(edit((x) => (x.capture.coverage = { policy: "continuous", minFraction: 0.9 }))));
  add("refused: a start token that is not an event type", request(edit((x) => (x.capture.startCondition = "printer_warm"))));
  add("refused: an unknown term", request({ ...cameraProfile(), extraTerm: "never evaluated" }));
  const other = edit((x) => (x.measurement.sampling.minSamples = 2));
  add("refused: a client digest of another profile", request(p, { claimedDigest: computeMeasurementProfileDigest(other) }));
  add("refused: a client digest in the sha256: family", request(p, { claimedDigest: `sha256:${computeMeasurementProfileDigest(p).slice(2)}` }));
  add("refused: every problem at once", request(edit((x) => (x.measurement.tolerance = { comparator: ">=", target: 0.9 })), {
    deviceId: "dev-other",
    capabilityType: "cnc-milling",
    claimedDigest: "0x" + "0".repeat(64),
  }));
  const getter = cameraProfile();
  Object.defineProperty(getter.device, "deviceId", nullDescriptor({ enumerable: true, configurable: true, get: () => CAMERA }));
  add("refused: a getter in the profile", request(getter));
  add("refused: a NaN in the profile", request(edit((x) => ((x.measurement.sampling as { minSamples: number }).minSamples = Number.NaN))));
  // Refused only by the integer check (2.5 >= 1), so "patch: Number.isInteger" can tell a live call from the captured one.
  add("refused: a fractional minimum sample count", request(edit((x) => (x.measurement.sampling.minSamples = 2.5))));
  add("refused: a proxy request", new Proxy(request(p), {}));
  CASES = cases;
}

// -- running the requests while a change is in place: index loops only --
export type Row = [kind: string, label: string, value: unknown];

function results(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < CASES.length; i++) {
    let value: unknown;
    try {
      value = checkProfileRegistration(CASES[i]![1]);
    } catch {
      value = "threw";
    }
    rows[i] = ["registration", CASES[i]![0], value];
  }
  return rows;
}

// -- the changes --
type Apply = () => () => void;

function replace(target: object, key: PropertyKey, make: (original: any) => unknown): Apply {
  return () => {
    const original = ReflectGetOwnPropertyDescriptor(target, key)!;
    ReflectDefineProperty(target, key, nullDescriptor({ configurable: original.configurable, enumerable: original.enumerable, writable: original.writable, value: make(original.value) }));
    return () => void ReflectDefineProperty(target, key, original);
  };
}

function pollute(values: () => Record<string, unknown>): Apply {
  return () => {
    const v = values();
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      ReflectDefineProperty(Object.prototype, keys[i]!, nullDescriptor({ value: v[keys[i]!], writable: true, configurable: true, enumerable: false }));
    }
    return () => {
      for (let i = 0; i < keys.length; i++) ReflectDeleteProperty(Object.prototype, keys[i]!);
    };
  };
}

const HashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;

const SCENARIOS: Array<[string, Apply]> = [
  ["patch: Array.prototype.map", replace(Array.prototype, "map", () => () => [])],
  ["patch: Array.prototype.filter", replace(Array.prototype, "filter", () => () => [])],
  ["patch: Array.prototype.some", replace(Array.prototype, "some", () => () => false)],
  ["patch: Array.prototype.every", replace(Array.prototype, "every", () => () => true)],
  ["patch: Array.prototype.includes", replace(Array.prototype, "includes", () => () => true)],
  ["patch: Array.prototype.indexOf", replace(Array.prototype, "indexOf", () => () => 2)],
  ["patch: Array.prototype.join", replace(Array.prototype, "join", () => () => "")],
  ["patch: Array.prototype.push", replace(Array.prototype, "push", () => () => 0)],
  ["patch: Array.prototype.sort", replace(Array.prototype, "sort", (o) => function (this: unknown[]) { return ReflectApply(o, this, []).reverse(); })],
  ["patch: Array.prototype.slice", replace(Array.prototype, "slice", () => () => [])],
  ["patch: Array.prototype.concat", replace(Array.prototype, "concat", () => () => [])],
  ["patch: Array.prototype[Symbol.iterator]", replace(Array.prototype, Symbol.iterator, () => function* () {})],
  ["patch: %ArrayIteratorPrototype%.next", replace(ArrayIteratorPrototype, "next", () => () => ({ done: true, value: undefined }))],
  ["patch: Array.isArray", replace(Array, "isArray", () => () => false)],
  ["patch: Object.keys", replace(Object, "keys", () => () => [])],
  ["patch: Object.entries", replace(Object, "entries", () => () => [])],
  ["patch: Object.values", replace(Object, "values", () => () => [])],
  ["patch: Object.assign", replace(Object, "assign", () => (t: unknown) => t)],
  ["patch: Object.freeze", replace(Object, "freeze", () => (v: unknown) => v)],
  ["patch: Object.isFrozen", replace(Object, "isFrozen", () => () => true)],
  ["patch: Object.getOwnPropertyDescriptor", replace(Object, "getOwnPropertyDescriptor", () => () => undefined)],
  ["patch: Object.getPrototypeOf", replace(Object, "getPrototypeOf", () => () => null)],
  // astra pack 188: plainDataCopy's intrinsics (it captures its own at load), each in its dangerous direction.
  ["patch: Object.create", replace(Object, "create", () => () => ({}))],
  ["patch: Object.defineProperty", replace(Object, "defineProperty", () => (o: unknown) => o)],
  ["patch: Object.is", replace(Object, "is", () => () => true)],
  ["patch: Reflect.ownKeys", replace(Reflect, "ownKeys", () => () => [])],
  ["patch: Reflect.apply", replace(Reflect, "apply", () => () => true)],
  ["patch: JSON.stringify", replace(JSON, "stringify", () => () => '"x"')],
  ["patch: String", replace(globalThis, "String", () => () => "x")],
  ["patch: Number.isFinite", replace(Number, "isFinite", () => () => true)],
  ["patch: Number.isInteger", replace(Number, "isInteger", () => () => true)],
  ["patch: Set.prototype.has", replace(Set.prototype, "has", () => () => true)],
  ["patch: Map.prototype.get", replace(Map.prototype, "get", () => () => ({ status: "active" }))],
  ["patch: RegExp.prototype.test", replace(RegExp.prototype, "test", () => () => true)],
  ["patch: String.prototype.trim", replace(String.prototype, "trim", () => () => "x")],
  ["patch: String.prototype.charCodeAt", replace(String.prototype, "charCodeAt", () => () => 0x30)],
  ["patch: String.prototype.includes", replace(String.prototype, "includes", () => () => false)],
  ["patch: Function.prototype.call", replace(Function.prototype, "call", () => () => undefined)],
  ["patch: Object.prototype.hasOwnProperty", replace(Object.prototype, "hasOwnProperty", () => () => true)],
  ["patch: Hash.prototype.update", replace(HashPrototype, "update", (o) => function (this: unknown) { return ReflectApply(o, this, ["tampered"]); })],
  ["patch: Hash.prototype.digest", replace(HashPrototype, "digest", () => () => "0".repeat(64))],
  ["patch: Object.prototype.claimedDigest", pollute(() => ({ claimedDigest: "0x" + "1".repeat(64) }))],
  ["patch: Object.prototype.tolerance", pollute(() => ({ tolerance: { comparator: ">=", target: 1 } }))],
  ["patch: Object.prototype.value = true", pollute(() => ({ value: true }))],
];

// -- main --
const HANG_MS = 20_000;

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function main(): void {
  const id = process.argv[2];
  if (id === "--list") {
    const ids: string[] = [];
    for (let i = 0; i < SCENARIOS.length; i++) ids[i] = SCENARIOS[i]![0];
    write(ids);
    return;
  }
  let scenario: [string, Apply] | undefined;
  for (let i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i]![0] === id) scenario = SCENARIOS[i];
  if (scenario === undefined) throw new Error(`no scenario ${JSON.stringify(id)}`);
  buildCases();
  const clean = results();
  let undo: () => void = () => undefined;
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      undo();
    }
  };
  const watchdog = setTimeoutAtLoad(() => {
    restore();
    write({ scenario: id, clean, hung: true });
    process.exit(0);
  }, HANG_MS);
  let patched: unknown;
  try {
    undo = scenario[1]();
    patched = results();
  } catch (err) {
    patched = `the scenario threw: ${String(err)}`;
  } finally {
    restore();
  }
  clearTimeoutAtLoad(watchdog);
  write({ scenario: id, clean, patched });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
