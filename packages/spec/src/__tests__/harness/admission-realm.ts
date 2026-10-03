/**
 * One realm for the realm-mutation harness (../profile-admission-intrinsics.test.ts).
 *
 * Why a child process: vitest runs its own runner in the realm of the test it
 * runs. A test that holds a replaced intrinsic across an event-loop turn
 * therefore breaks vitest itself, not only the code under test: with
 * Array.prototype[Symbol.iterator] replaced across a 300 ms timer, a test with
 * no @pcc/spec code in it never completes. So each scenario runs here, in a
 * process that holds only @pcc/spec, this file and Node (whose internals use
 * their own load-time primordials). That is also the threat: post-load code in
 * a process that loaded @pcc/spec first.
 *
 *   1. load: the static imports below;
 *   2. build every item, and run them clean;
 *   3. apply the scenario's change, run the items again, undo the change;
 *   4. print one JSON line: { scenario, clean, patched } or { scenario, clean, hung: true }.
 *
 * Usage: tsx admission-realm.ts <scenario id> | --list
 * Every builder runs before any change is applied. The code that runs while a
 * change is in place (`results`, `summarize`, `copyList` and the recipes'
 * items) uses index loops, literals and operators only.
 */
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { pathToFileURL } from "node:url";

import * as admissionModule from "../../evidence/profile-admission.js";
import {
  computeBundleSetDigest,
  NON_NUMERIC_UNIT,
  PROFILE_OBSERVATION_FIELD,
  profileAdmitsBundle,
  unverifiableProfileTerms,
  type AdmissionBundle,
  type ProfileAdmissionInput,
  type ProfileAdmissionResult,
  type ProfileObservation,
} from "../../evidence/profile-admission.js";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  deriveContradictions,
  EVIDENCE_LEVELS,
  evidenceLevelOf,
  evidenceLevelOfBundle,
  evidenceLevelRank,
  EXECUTION_EVENT_TYPES,
  executingDeviceIds,
  INSPECTION_EVENT_TYPES,
  inspectionFailed,
  meetsEvidenceLevel,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
} from "../../evidence/evidence-level.js";
import { computeMeasurementProfileDigest, type MeasurementProfileV1 } from "../../evidence/measurement-profile.js";
import { EVIDENCE_PRIMITIVES } from "../../evidence/primitives.js";
import { signingPreimage, TAGGED_DIGEST_PATTERN } from "../../evidence/signing-preimage.js";
import type { EvidenceSubject } from "../../evidence/subject-binding.js";
import { EVIDENCE_DEVICE_TYPES, EVIDENCE_EVENT_TYPES, type EvidenceEvent } from "../../types/evidence.js";
import { canonicalize, hashBundle, hashEvent } from "../../util/canonical.js";

// -- what this file itself calls while a change is in place, captured at load --
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectDeleteProperty = Reflect.deleteProperty;
const ObjectCreate = Object.create;
const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
const ReflectApply = Reflect.apply;
const setTimeoutAtLoad = setTimeout;
const PromiseAtLoad = Promise;
const clearTimeoutAtLoad = clearTimeout;
const hasOwn = (o: object, k: PropertyKey): boolean => ReflectApply(ObjectPrototypeHasOwnProperty, o, [k]) === true;

/** A property descriptor with a null prototype: once Object.prototype.value or .get is written, a literal would inherit it. */
export function nullDescriptor(fields: Record<string, unknown>): PropertyDescriptor {
  const d = ObjectCreate(null) as Record<string, unknown>;
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) d[keys[i]!] = fields[keys[i]!];
  return d as PropertyDescriptor;
}

// -- builders (profile-admission.test.ts), run before any change --
const JOB = "job-admission-1";
const KERNEL = "kernel-admission-1";
const PRINTER = "dev-printer";
const CAMERA = "dev-camera";
const SCALE = "dev-scale";
const PRINTER_VERSION = "IppAdapter-1.0.0";
const CAMERA_VERSION = "PhotoCameraAdapter-1.0.0";
const SCALE_VERSION = "ScaleAdapter-1.0.0";
const DOCUMENT = { kind: "documentHash", value: "sha256:" + "b".repeat(64) };
const UNIT = "0x" + "ab".repeat(32);
const OTHER_UNIT = "0x" + "cd".repeat(32);
const NONCE = "0x" + "ef".repeat(32);
const SUBJECT: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
const UNIT_SUBJECT: EvidenceSubject = { jobId: JOB, kernelId: KERNEL, settlementUnitId: UNIT, challengeNonce: NONCE };

const key = generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function defaultSource(device: string): Record<string, unknown> {
  if (device === PRINTER) {
    return { deviceType: "controller", adapterType: "ipp", adapterVersion: PRINTER_VERSION, firmwareVersion: "printer-fw-7.3" };
  }
  if (device === SCALE) {
    return { deviceType: "instrument", adapterType: "scale", adapterVersion: SCALE_VERSION, firmwareVersion: "scale-fw-1.0" };
  }
  return { deviceType: "camera", adapterType: "photo", adapterVersion: CAMERA_VERSION, firmwareVersion: "cam-fw-2.1.0" };
}

function mergeDefined<T extends Record<string, unknown>>(base: T, override?: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as T;
}

interface Draft {
  type: string;
  t: number;
  device: string;
  source?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  observation?: null | Partial<ProfileObservation>;
  simulated?: boolean;
  jobId?: string;
  kernelId?: string;
  timestamp?: string;
}

function defaultObservation(profile: MeasurementProfileV1, d: Draft): ProfileObservation {
  const sampleId = "sha256:" + createHash("sha256").update(`${d.device}|${d.type}|${d.t}`).digest("hex");
  const obs: ProfileObservation = {
    profileDigest: computeMeasurementProfileDigest(profile),
    primitiveId: profile.interpretation.evidenceTypeIds[0]!,
    object: { ...profile.outcome.objectIdentity },
    method: profile.measurement.method,
    quantity: profile.measurement.quantity,
    unit: profile.measurement.unit,
    sampleId,
  };
  if (profile.measurement.unit !== NON_NUMERIC_UNIT) obs.value = "12.5";
  return obs;
}

async function toEvent(d: Draft): Promise<EvidenceEvent> {
  const source = mergeDefined({ deviceId: d.device, kernelId: d.kernelId ?? KERNEL, ...defaultSource(d.device) }, d.source);
  if (d.simulated) (source as Record<string, unknown>).simulated = true;
  const payload = { jobId: d.jobId ?? JOB, ...(d.payload ?? {}) };
  const unsigned = { type: d.type, timestamp: d.timestamp ?? at(d.t), source, payload };
  const hash = await hashEvent(unsigned as unknown as Omit<EvidenceEvent, "hash" | "id">);
  return { ...unsigned, id: `${d.type}-${d.t}-${d.device}`, hash } as unknown as EvidenceEvent;
}

async function toBundle(drafts: Draft[], profile: MeasurementProfileV1): Promise<AdmissionBundle> {
  const events: EvidenceEvent[] = [];
  for (const d of drafts) {
    if (d.observation === null) {
      events.push(await toEvent(d));
      continue;
    }
    const merged = mergeDefined(
      defaultObservation(profile, d) as unknown as Record<string, unknown>,
      d.observation as Record<string, unknown> | undefined,
    );
    events.push(await toEvent({ ...d, payload: { ...(d.payload ?? {}), [PROFILE_OBSERVATION_FIELD]: merged } }));
  }
  const bundleHash = await hashBundle(events);
  const value = sign(null, signingPreimage(bundleHash), key.privateKey).toString("hex");
  return { bundleHash, events, kernelSignature: { signer: "0x1111111111111111111111111111111111111111", algorithm: "ed25519", value } };
}

const verifySignature = (b: AdmissionBundle) =>
  verify(null, signingPreimage(b.bundleHash), key.publicKey, Buffer.from((b.kernelSignature as { value: string }).value, "hex"));

const PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true } },
];
const PRINTED = PILOT.slice(0, 2);
const FAILURE: Draft[] = [{ type: "execution_failed", t: 11, device: PRINTER }];
const MASS_PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "instrument_result", t: 20, device: SCALE, payload: { passed: true } },
];

function inspectedPageProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/test/inspected-page/v1",
    outcome: { capabilityType: "document-printing", statement: "The page was printed and a separate camera inspected it.", objectIdentity: DOCUMENT },
    device: { deviceId: CAMERA, kind: "camera", adapterType: "photo", permittedAdapterVersions: [CAMERA_VERSION], permittedFirmwareVersions: ["cam-fw-2.1.0"] },
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

function deviceReportedProfile(): MeasurementProfileV1 {
  const p = inspectedPageProfile();
  p.device = { deviceId: PRINTER, kind: "controller", adapterType: "ipp", permittedAdapterVersions: [PRINTER_VERSION], permittedFirmwareVersions: ["printer-fw-7.3"] };
  p.capture = { ...p.capture, startCondition: "execution_started" };
  p.interpretation = { ...p.interpretation, acceptanceLevel: "device_reported", evidenceTypeIds: ["receipt.kernel_signed"] };
  return p;
}

function massProfile(): MeasurementProfileV1 {
  const p = inspectedPageProfile();
  p.device = { deviceId: SCALE, kind: "instrument", adapterType: "scale", permittedAdapterVersions: [SCALE_VERSION], permittedFirmwareVersions: ["scale-fw-1.0"] };
  p.measurement = { method: "load-cell", quantity: "mass", unit: "kg", sampling: { minSamples: 1 } };
  p.interpretation = { ...p.interpretation, evidenceTypeIds: ["artifact.hash"] };
  return p;
}

function edit(change: (p: MeasurementProfileV1) => void, base: () => MeasurementProfileV1 = inspectedPageProfile): MeasurementProfileV1 {
  const p = base();
  change(p);
  return p;
}

/** A full admission input; the pin is over exactly `bundles` unless `over` names one. */
async function input(
  profile: MeasurementProfileV1,
  bundles: AdmissionBundle[],
  over: Partial<ProfileAdmissionInput> = {},
  subject: EvidenceSubject = SUBJECT,
): Promise<ProfileAdmissionInput> {
  const pinnedBundleSetDigest =
    bundles.length > 0 ? await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)) : "sha256:" + "0".repeat(64);
  return {
    profile,
    committedDigest: computeMeasurementProfileDigest(profile),
    subject,
    bundles,
    pinnedBundleSetDigest,
    verifyBundleSignature: verifySignature,
    verifyPrimitiveInstance: () => true,
    ...over,
  };
}

/** A copy of `bundle` whose event `index` is re-hashed after `change`: its own hash verifies, the signed bundle hash does not. */
async function rehashed(bundle: AdmissionBundle, index: number, change: (e: Record<string, any>) => void): Promise<AdmissionBundle> {
  const events = structuredClone(bundle.events) as Record<string, any>[];
  change(events[index]!);
  const { type, timestamp, source, payload } = events[index]!;
  events[index]!.hash = await hashEvent({ type, timestamp, source, payload } as unknown as Omit<EvidenceEvent, "hash" | "id">);
  return { ...bundle, events };
}

/** The canonical text binding hashes for an event. */
function hashedText(e: unknown): string {
  const { type, timestamp, source, payload } = e as Record<string, unknown>;
  return canonicalize({ type, timestamp, source, payload });
}

/** The leg's obligation (profile-admission.test.ts 39-D): the claimed sampleId commits the capture the event carries. */
const capturesMatch = (_id: string, obs: EvidenceEvent): boolean => {
  const payload = obs.payload as Record<string, unknown>;
  const observation = payload[PROFILE_OBSERVATION_FIELD] as { sampleId: string };
  return observation.sampleId === payload.captureHash;
};

// -- evidence-level items: ordinary-object events, as every other caller passes them --
let seq = 0;
function ev(type: string, deviceId: string | undefined, payload: Record<string, unknown> = {}, extraSource: Record<string, unknown> = {}): EvidenceEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    type,
    timestamp: "2026-09-24T12:00:00.000Z",
    source: { ...(deviceId !== undefined ? { deviceId } : {}), deviceType: "controller", kernelId: KERNEL, ...extraSource },
    payload,
    hash: `sha256:${"0".repeat(64)}`,
  } as unknown as EvidenceEvent;
}
const LV = {
  started: ev("execution_started", PRINTER),
  progress: ev("execution_progress", PRINTER, { level: "submitted" }),
  completed: ev("execution_completed", PRINTER),
  failed: ev("execution_failed", PRINTER),
  cameraPassed: ev("cv_inspection_result", CAMERA, { passed: true }),
  cameraFailed: ev("cv_inspection_result", CAMERA, { passed: false }),
  cameraNoVerdict: ev("cv_inspection_result", CAMERA, { score: 0.9 }),
  printerInspects: ev("cv_inspection_result", PRINTER, { passed: true }),
  noDevice: ev("execution_completed", undefined),
  mockCompletion: ev("execution_completed", PRINTER, { mock: true }),
  simulatedCamera: ev("cv_inspection_result", CAMERA, { passed: true }, { simulated: true }),
  fakeFailure: ev("execution_failed", PRINTER, { mock: true }),
  verifiedLog: ev("printer_job_verified", PRINTER, { chainLength: 12 }),
  tempLogFailed: ev("temperature_log", PRINTER, { passed: false }),
  accessorVerdict: ev("cv_inspection_result", CAMERA, {}),
  accessorSimulated: ev("cv_inspection_result", CAMERA, { passed: true }),
};
/** How many times an accessor in an evidence-level item ran: never, if only own data is read. */
let ACCESSOR_RUNS = 0;
Object.defineProperty(LV.accessorVerdict.payload, "passed", nullDescriptor({ get: () => (ACCESSOR_RUNS++, false), enumerable: true, configurable: true }));
Object.defineProperty(LV.accessorSimulated.source, "simulated", nullDescriptor({ get: () => (ACCESSOR_RUNS++, true), enumerable: true, configurable: true }));
const L = {
  pilot: [LV.started, LV.completed, LV.cameraPassed],
  selfInspect: [LV.completed, LV.printerInspects],
  accepted: [LV.started, LV.progress],
  failedJob: [LV.started, LV.failed],
  noExecutor: [LV.cameraPassed],
  fabricated: [LV.mockCompletion, LV.simulatedCamera],
  verifiedLog: [LV.verifiedLog],
  empty: [] as EvidenceEvent[],
  printerDone: [LV.completed],
  printerRan: [LV.started, LV.completed],
  fakeExecutor: [LV.mockCompletion],
  completionFailure: [LV.completed, LV.failed],
  completionFailedInspection: [LV.completed, LV.cameraFailed],
  both: [LV.cameraFailed, LV.failed, LV.completed],
  failureAlone: [LV.failed],
  fakeFailure: [LV.completed, LV.fakeFailure],
  noVerdict: [LV.completed, LV.cameraNoVerdict],
};
const LEVEL_ITEMS: Array<[string, () => unknown]> = [
  ["levels: printer completes, camera inspects", () => evidenceLevelOfBundle(L.pilot)],
  ["levels: the printer inspecting itself", () => evidenceLevelOfBundle(L.selfInspect)],
  ["levels: accepted only", () => evidenceLevelOfBundle(L.accepted)],
  ["levels: a failed job", () => evidenceLevelOfBundle(L.failedJob)],
  ["levels: an inspection with no executing device", () => evidenceLevelOfBundle(L.noExecutor)],
  ["levels: fabricated completion and camera", () => evidenceLevelOfBundle(L.fabricated)],
  ["levels: printer_job_verified alone", () => evidenceLevelOfBundle(L.verifiedLog)],
  ["levels: an empty set", () => evidenceLevelOfBundle(L.empty)],
  ["levelOf: no device attribution", () => evidenceLevelOf(LV.noDevice, executingDeviceIds(L.printerDone))],
  ["levelOf: the camera, the printer executing", () => evidenceLevelOf(LV.cameraPassed, executingDeviceIds(L.printerRan))],
  ["levelOf: the camera, nobody executing", () => evidenceLevelOf(LV.cameraPassed, executingDeviceIds(L.noExecutor))],
  ["levelOf: a fabricated executor", () => evidenceLevelOf(LV.cameraPassed, executingDeviceIds(L.fakeExecutor))],
  ["contradictions: completion and failure", () => deriveContradictions(L.completionFailure)],
  ["contradictions: completion and a failed inspection", () => deriveContradictions(L.completionFailedInspection)],
  ["contradictions: both, in order", () => deriveContradictions(L.both)],
  ["contradictions: a failure alone", () => deriveContradictions(L.failureAlone)],
  ["contradictions: a fabricated failure", () => deriveContradictions(L.fakeFailure)],
  ["contradictions: a verdict-less inspection", () => deriveContradictions(L.noVerdict)],
  ["inspectionFailed: passed false", () => inspectionFailed(LV.cameraFailed)],
  ["inspectionFailed: no verdict", () => inspectionFailed(LV.cameraNoVerdict)],
  ["inspectionFailed: a non-inspection with passed false", () => inspectionFailed(LV.tempLogFailed)],
  ["meets: device_reported for inspected_output", () => meetsEvidenceLevel("device_reported", "inspected_output")],
  ["meets: submitted for device_reported", () => meetsEvidenceLevel("submitted", "device_reported")],
  ["meets: inspected_output for device_reported", () => meetsEvidenceLevel("inspected_output", "device_reported")],
  ["meets: null for submitted", () => meetsEvidenceLevel(null, "submitted")],
  ["rank: submitted", () => evidenceLevelRank("submitted")],
  ["rank: device_reported", () => evidenceLevelRank("device_reported")],
  ["rank: inspected_output", () => evidenceLevelRank("inspected_output")],
  ["inspectionFailed: an accessor verdict, never run", () => {
    ACCESSOR_RUNS = 0;
    const failed = inspectionFailed(LV.accessorVerdict);
    return [failed, ACCESSOR_RUNS];
  }],
  ["levelOf: an accessor simulated flag, never run", () => {
    ACCESSOR_RUNS = 0;
    const level = evidenceLevelOf(LV.accessorSimulated, executingDeviceIds(L.printerRan));
    return [level, ACCESSOR_RUNS];
  }],
];

// -- every item, built once --
let CASES: Array<[string, ProfileAdmissionInput]> = [];
let DIGEST_CASES: Array<[string, Pick<EvidenceSubject, "jobId" | "kernelId" | "settlementUnitId">, readonly string[]]> = [];
let TERM_CASES: Array<[string, MeasurementProfileV1]> = [];
/** Forged resolutions for the Promise.prototype.then rows: a real value mapped to the one a forger wants. */
const FORGE_FROM: string[] = [];
const FORGE_TO: string[] = [];
let INHERITABLE_RECORD: Record<string, unknown> = {};
const RECIPE: Record<string, any> = {};

async function buildCases(): Promise<void> {
  const p = inspectedPageProfile();
  const pilot = await toBundle(PILOT, p);
  const failure = await toBundle(FAILURE, p);
  const cases: Array<[string, ProfileAdmissionInput]> = [];
  const add = (label: string, value: ProfileAdmissionInput) => cases.push([label, value]);

  // admit
  add("admit: the pilot, inspected_output", await input(p, [pilot]));
  const dr = deviceReportedProfile();
  add("admit: device_reported on the printer's completion", await input(dr, [await toBundle(PILOT, dr)]));
  const mass = massProfile();
  add("admit: the mass profile, a decimal value", await input(mass, [await toBundle(MASS_PILOT, mass)]));
  add("admit: two bundles of one job", await input(p, [await toBundle(PILOT.slice(0, 2), p), await toBundle(PILOT.slice(2), p)]));
  const two = edit((x) => (x.measurement.sampling.minSamples = 2));
  add(
    "admit: two distinct samples for minSamples 2",
    await input(two, [await toBundle([...PRINTED, { ...PILOT[2]! }, { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true } }], two)]),
  );
  const unitDrafts = PILOT.map((d) => ({ ...d, payload: { ...(d.payload ?? {}), settlementUnitId: UNIT, challengeNonce: NONCE } }));
  add("admit: a unit-scoped job, unit and challenge committed", await input(p, [await toBundle(unitDrafts, p)], {}, UNIT_SUBJECT));
  const captureHash = "sha256:" + "d".repeat(64);
  const committedCapture = await toBundle([...PRINTED, { ...PILOT[2]!, payload: { passed: true, captureHash }, observation: { sampleId: captureHash } }], p);
  add("admit: a leg that checks the capture, which matches", await input(p, [committedCapture], { verifyPrimitiveInstance: capturesMatch }));
  // The window opens at the EARLIEST start event and closes at the LATEST end event: an observation between two
  // starts, or between two ends, is inside it.
  const fromStart = edit((x) => (x.capture = { ...x.capture, startCondition: "execution_started" }));
  add(
    "admit: an inspection between two starts (the window opens at the earliest)",
    await input(fromStart, [
      await toBundle(
        [PILOT[0]!, { type: "execution_started", t: 15, device: PRINTER }, { type: "execution_completed", t: 16, device: PRINTER }, { ...PILOT[2]!, t: 10 }],
        fromStart,
      ),
    ]),
  );
  const startToEnd = edit((x) => (x.capture = { ...x.capture, startCondition: "execution_started", endCondition: "execution_completed" }));
  add(
    "admit: an inspection between two ends (the window closes at the latest)",
    await input(startToEnd, [
      await toBundle([PILOT[0]!, PILOT[1]!, { type: "execution_completed", t: 30, device: PRINTER }, PILOT[2]!], startToEnd),
    ]),
  );

  // reject: the set, the signature, binding
  const pin2 = await computeBundleSetDigest(SUBJECT, [pilot.bundleHash, failure.bundleHash]);
  const omitted = await input(p, [pilot], { pinnedBundleSetDigest: pin2 });
  add("reject: a stored failure bundle left out of the pinned set", omitted);
  const presented = await computeBundleSetDigest(SUBJECT, [pilot.bundleHash]);
  RECIPE.omitted = { input: omitted, presented, pin: pin2, pilotHash: pilot.bundleHash };
  RECIPE.notAPin = { ...omitted, pinnedBundleSetDigest: "not-a-pin" };
  FORGE_FROM.push(presented);
  FORGE_TO.push(pin2);
  add("reject: a bundle outside the pinned set", await input(p, [pilot, failure], { pinnedBundleSetDigest: presented }));
  add("reject: a malformed pin", await input(p, [pilot], { pinnedBundleSetDigest: "0x" + "a".repeat(64) }));
  const signatureFails = await input(p, [pilot], { verifyBundleSignature: () => false });
  add("reject: the signature leg fails", signatureFails);
  RECIPE.signatureFails = signatureFails;
  const asyncSignatureFails = await input(p, [pilot], { verifyBundleSignature: async () => false });
  add("reject: an async signature leg answers false", asyncSignatureFails);
  RECIPE.asyncSignatureFails = asyncSignatureFails;
  const asyncPrimitiveFails = await input(p, [pilot], { verifyPrimitiveInstance: async () => false });
  add("reject: an async primitive leg answers false", asyncPrimitiveFails);
  RECIPE.asyncPrimitiveFails = asyncPrimitiveFails;
  add("admit: async legs that answer true", await input(p, [pilot], { verifyBundleSignature: async (b) => verifySignature(b), verifyPrimitiveInstance: async () => true }));
  add("reject: a leg answering with a thenable", await input(p, [pilot], { verifyBundleSignature: (() => ({ then: (f: (v: unknown) => void) => f(true) })) as unknown as () => boolean }));
  add("reject: a leg answering 1, truthy but not true", await input(p, [pilot], { verifyPrimitiveInstance: (() => 1) as unknown as () => boolean }));
  add("reject: an async leg answering \"true\", truthy but not true", await input(p, [pilot], { verifyPrimitiveInstance: (async () => "true") as unknown as () => Promise<boolean> }));
  add("reject: evidence from another job", await input(p, [await toBundle(PILOT.map((d) => ({ ...d, jobId: "job-other" })), p)]));
  add("reject: evidence from another kernel", await input(p, [await toBundle(PILOT.map((d) => ({ ...d, kernelId: "kernel-other" })), p)]));
  const altered = await toBundle(PILOT, p);
  (altered.events[2] as { payload: Record<string, unknown> }).payload.passed = false;
  add("reject: an event altered after hashing", await input(p, [altered]));
  add("reject: evidence for another settlement unit", await input(p, [await toBundle(unitDrafts, p)], {}, { ...UNIT_SUBJECT, settlementUnitId: OTHER_UNIT }));
  const unitOnly = PILOT.map((d) => ({ ...d, payload: { ...(d.payload ?? {}), settlementUnitId: UNIT } }));
  add("reject: the challenge nonce not committed", await input(p, [await toBundle(unitOnly, p)], {}, UNIT_SUBJECT));
  const kernelInPayload = await toBundle(PILOT.map((d) => ({ ...d, payload: { ...(d.payload ?? {}), kernelId: "kernel-other" } })), p);
  add("reject: a payload kernelId naming another kernel", await input(p, [kernelInPayload]));
  const OUTPUT = "sha256:" + "a".repeat(64);
  const outputSubject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL, outputHash: OUTPUT };
  add("reject: the output not committed", await input(p, [pilot], {}, outputSubject));
  const otherOutput = await toBundle(PILOT.map((d) => (d.type === "execution_completed" ? { ...d, payload: { outputHash: "sha256:" + "9".repeat(64) } } : d)), p);
  add("reject: another output committed", await input(p, [otherOutput], {}, outputSubject));
  const ownOutput = await toBundle(PILOT.map((d) => (d.type === "execution_completed" ? { ...d, payload: { outputHash: OUTPUT } } : d)), p);
  add("admit: the output committed", await input(p, [ownOutput], {}, outputSubject));
  // A score of its own, so flipping `passed` back cannot reproduce the pilot's inspection byte for byte.
  const failedInspection = await toBundle([...PRINTED, { ...PILOT[2]!, payload: { passed: false, score: 0.2 } }], p);
  const tampered = await rehashed(failedInspection, 2, (e) => (e.payload.passed = true));
  const tamperedInput = await input(p, [tampered]);
  add("reject: an inspection re-hashed after signing", tamperedInput);
  const realBundleHash = await hashBundle(tampered.events as unknown as EvidenceEvent[]);
  RECIPE.tampered = {
    input: tamperedInput,
    tamperedHash: (tampered.events[2] as EvidenceEvent).hash,
    originalHash: (failedInspection.events[2] as EvidenceEvent).hash,
  };
  FORGE_FROM.push(realBundleHash);
  FORGE_TO.push(failedInspection.bundleHash);
  const genuineFailure = await input(p, [failedInspection]);
  add("reject: a failed inspection (contradiction), genuine", genuineFailure);
  RECIPE.genuineFailure = { input: genuineFailure, text: hashedText(failedInspection.events[2]) };

  // reject: simulation, contradiction, failure, level
  add("reject: a simulated source", await input(p, [await toBundle(PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d)), p)]));
  add("reject: a payload.mock event", await input(p, [await toBundle([...PILOT, { type: "execution_progress", t: 5, device: PRINTER, payload: { mock: true } }], p)]));
  add("reject: completion and execution_failed", await input(p, [await toBundle([...PILOT, FAILURE[0]!], p)]));
  add("reject: a device failure", await input(p, [await toBundle([PILOT[0]!, { type: "execution_failed", t: 10, device: PRINTER }], p)]));
  add("reject: the printer inspecting its own output", await input(p, [await toBundle(PILOT.map((d) => (d.device === CAMERA ? { ...d, device: PRINTER } : d)), p)]));
  add("reject: printer_job_verified alone", await input(dr, [await toBundle([{ type: "printer_job_verified", t: 10, device: PRINTER }], dr)]));

  // reject: missing measurements, one exclusion each
  const cam = (over: Partial<Draft>) => [...PRINTED, { ...PILOT[2]!, ...over }];
  add("reject: an inspection from another camera", await input(p, [await toBundle(cam({ device: "dev-other-camera" }), p)]));
  add("reject: an unpermitted version", await input(p, [await toBundle(cam({ source: { adapterVersion: "PhotoCameraAdapter-9.9.9" } }), p)]));
  add("reject: no version at all", await input(p, [await toBundle(cam({ source: { adapterVersion: undefined, firmwareVersion: undefined } }), p)]));
  add("reject: an inspection before the window opened", await input(p, [await toBundle(cam({ t: 5 }), p)]));
  add("reject: an unparseable observation timestamp", await input(p, [await toBundle(cam({ timestamp: "not a date" }), p)]));
  // Two start events and two end events, so the window's earliest start and latest end are both computed.
  const windowed = edit((x) => (x.capture = { ...x.capture, startCondition: "execution_started", endCondition: "execution_completed" }));
  add(
    "reject: an inspection after the window closed",
    await input(windowed, [await toBundle([PILOT[0]!, PILOT[1]!, { type: "execution_completed", t: 12, device: PRINTER }, PILOT[2]!], windowed)]),
  );
  const earliest = edit((x) => (x.capture = { ...x.capture, startCondition: "execution_started" }));
  add(
    "reject: an inspection before the earliest start",
    await input(earliest, [
      await toBundle(
        [
          { type: "execution_started", t: 10, device: PRINTER },
          { type: "execution_started", t: 15, device: PRINTER },
          { type: "execution_completed", t: 20, device: PRINTER },
          { ...PILOT[2]!, t: 5 },
        ],
        earliest,
      ),
    ]),
  );
  add("reject: an inspection with no verdict", await input(p, [await toBundle(cam({ payload: { score: 0.97 } }), p)]));
  add("reject: no profileObservation record", await input(p, [await toBundle(cam({ observation: null }), p)]));
  add("reject: another object", await input(p, [await toBundle(cam({ observation: { object: { kind: "documentHash", value: "sha256:" + "c".repeat(64) } } }), p)]));
  add("reject: another primitive", await input(p, [await toBundle(cam({ observation: { primitiveId: "artifact.hash" } }), p)]));
  const scale = (observation: Partial<ProfileObservation>) => MASS_PILOT.map((d) => (d.device === SCALE ? { ...d, observation } : d));
  // The "value" in recipes run on the numeric profile: there, a value on an observation is expected, so
  // Object.prototype.value written cannot exclude the observation and mask what the input boundary read.
  const massPilot = await toBundle(MASS_PILOT, mass);
  const massFailure = await toBundle(FAILURE, mass);
  const massPin = await computeBundleSetDigest(SUBJECT, [massPilot.bundleHash, massFailure.bundleHash]);
  const massPresented = await computeBundleSetDigest(SUBJECT, [massPilot.bundleHash]);
  const forgedSignature = sign(null, signingPreimage("sha256:" + "f".repeat(64)), key.privateKey).toString("hex");
  const badlySigned = { ...massPilot, kernelSignature: { ...(massPilot.kernelSignature as Record<string, unknown>), value: forgedSignature } };
  RECIPE.massOmitted = { input: await input(mass, [massPilot], { pinnedBundleSetDigest: massPin }), presented: massPresented, pin: massPin };
  RECIPE.badlySigned = await input(mass, [badlySigned]);
  add("reject: a bundle signed over another digest (mass)", RECIPE.badlySigned);
  add("reject: a stored failure bundle left out of the pinned set (mass)", RECIPE.massOmitted.input);
  const exponent = await input(mass, [await toBundle(scale({ value: "1e-7" }), mass)]);
  add("reject: an exponent value (1e-7)", exponent);
  RECIPE.exponent = exponent;
  add("reject: a numeric observation with no value", await input(mass, [await toBundle(scale({ value: undefined }), mass)]));
  add("reject: a value on a unit-none observation", await input(p, [await toBundle(cam({ observation: { value: "3" } }), p)]));
  const frame = await input(p, [await toBundle(cam({ observation: { sampleId: "frame-7" } }), p)]);
  add("reject: a sampleId that is not a digest", frame);
  RECIPE.frame = frame;
  const reissue = "sha256:" + "c".repeat(64);
  add(
    "reject: one sample reissued, minSamples 2",
    await input(two, [await toBundle([...PRINTED, { ...PILOT[2]!, observation: { sampleId: reissue } }, { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true }, observation: { sampleId: reissue } }], two)]),
  );
  add("reject: the primitive leg fails", await input(p, [pilot], { verifyPrimitiveInstance: () => false }));
  add(
    "reject: a leg that writes to its frozen observation",
    await input(p, [pilot], {
      verifyPrimitiveInstance: (_id, observation) => {
        (observation.payload as Record<string, unknown>).passed = false;
        return true;
      },
    }),
  );
  const otherCapture = await toBundle(
    [...PRINTED, { ...PILOT[2]!, payload: { passed: true, captureHash: "sha256:" + "e".repeat(64) }, observation: { sampleId: captureHash } }],
    p,
  );
  const otherCaptureInput = await input(p, [otherCapture], { verifyPrimitiveInstance: capturesMatch });
  add("reject: a leg that checks the capture, which is another", otherCaptureInput);
  RECIPE.otherCapture = { input: otherCaptureInput, captureHash };

  // reject: terms, governance, the input boundary
  const term = async (label: string, change: (x: MeasurementProfileV1) => void) => {
    const q = edit(change);
    add(`reject: unverifiable ${label}`, await input(q, [await toBundle(PILOT, q)]));
  };
  await term("tolerance", (x) => (x.measurement.tolerance = { comparator: ">=", target: 0.9 }));
  await term("primitive id", (x) => (x.interpretation.evidenceTypeIds = ["capture.no_such_primitive"]));
  await term("device kind", (x) => (x.device.kind = "machine"));
  await term("start condition", (x) => (x.capture.startCondition = "printer_warm"));
  await term("wildcard pin", (x) => (x.device.permittedFirmwareVersions = ["*-unpinned-pilot"]));
  const loosened = edit((x) => (x.interpretation.acceptanceLevel = "device_reported"));
  add("reject: a profile changed after acceptance", await input(loosened, [pilot], { committedDigest: computeMeasurementProfileDigest(p) }));
  add("reject: a sha256:-family committed digest", await input(p, [pilot], { committedDigest: `sha256:${computeMeasurementProfileDigest(p).slice(2)}` }));
  add("reject: a proxy profile", await input(p, [pilot], { profile: new Proxy({ ...p }, {}) as unknown as MeasurementProfileV1 }));
  const accessorBundle = await toBundle(PILOT, p);
  Object.defineProperty((accessorBundle.events[2] as { payload: object }).payload, "passed", nullDescriptor({ get: () => true, enumerable: true, configurable: true }));
  const accessorDeep = await input(p, [accessorBundle], { pinnedBundleSetDigest: await computeBundleSetDigest(SUBJECT, [accessorBundle.bundleHash]) });
  add("reject: an accessor inside the bundles", accessorDeep);
  RECIPE.accessorDeep = accessorDeep;
  add("reject: no bundles", await input(p, []));

  // hold
  const held = (change: (x: MeasurementProfileV1) => void) => edit((x) => { change(x); x.onMissingData = "hold"; });
  const hold2 = held((x) => (x.measurement.sampling.minSamples = 2));
  add("hold: too few samples", await input(hold2, [await toBundle(PILOT, hold2)]));
  const holdC = edit((x) => (x.onContradiction = "hold"));
  add("hold: a contradiction", await input(holdC, [await toBundle([...PILOT, FAILURE[0]!], holdC)]));
  const holdL = held(() => undefined);
  add("hold: level not reached", await input(holdL, [await toBundle(PRINTED, holdL)]));
  const holdPilot = await toBundle(PILOT, holdL);
  add("hold: a bundle left out of the pin", await input(holdL, [holdPilot], { pinnedBundleSetDigest: await computeBundleSetDigest(SUBJECT, [holdPilot.bundleHash, (await toBundle(FAILURE, holdL)).bundleHash]) }));
  add("hold: no bundles", await input(holdL, []));
  // A malformed pin is invalid authority: it rejects even under onMissingData "hold" (a widened pin check would hold).
  const notAPinHold = await input(holdL, [holdPilot], { pinnedBundleSetDigest: "0x" + "a".repeat(64) });
  add("reject: a malformed pin under onMissingData hold", notAPinHold);
  RECIPE.notAPinHold = notAPinHold;
  CASES = cases;
  const BINDING_REJECTS = [
    "reject: evidence from another job",
    "reject: evidence from another kernel",
    "reject: a payload kernelId naming another kernel",
    "reject: evidence for another settlement unit",
    "reject: the challenge nonce not committed",
    "reject: the output not committed",
    "reject: another output committed",
    "reject: an event altered after hashing",
  ];
  RECIPE.bindingRejects = BINDING_REJECTS.map((label) => {
    const made = cases.find((c) => c[0] === label)![1];
    return { label, input: made, events: structuredClone((made.bundles[0] as AdmissionBundle).events) };
  });

  const h1 = "sha256:" + "1".repeat(64);
  const h2 = "sha256:" + "2".repeat(64);
  const holey: string[] = [h1];
  holey.length = 2;
  DIGEST_CASES = [
    ["digest: golden", { jobId: "job-golden-1", kernelId: "kernel-golden-1" }, [h2, h1, h2]],
    ["digest: golden with a unit", { jobId: "job-golden-1", kernelId: "kernel-golden-1", settlementUnitId: "0x" + "ab".repeat(32) }, [h1, h2]],
    ["digest: one hash", SUBJECT, [h1]],
    ["digest: the pilot set", SUBJECT, [pilot.bundleHash, failure.bundleHash]],
    ["digest: empty", SUBJECT, []],
    ["digest: an entry that is not a digest", SUBJECT, [h1, "not-a-digest"]],
    ["digest: a hole", SUBJECT, holey],
  ];

  TERM_CASES = [
    ["terms: a clean profile", inspectedPageProfile()],
    ["terms: every term at once", edit((x) => {
      x.measurement.tolerance = { comparator: ">=", target: 0.9 };
      x.measurement.sampling = { minSamples: 1, maxIntervalMs: 1000 };
      x.calibration = { required: true, procedureId: "cal-1", validityWindowSeconds: 3600 };
      x.witnesses = { requiredRoles: ["inspector"], independentOfClaimant: true };
      x.capture = { startCondition: "printer_warm", endCondition: "capture_complete", coverage: { policy: "continuous", minFraction: 0.9 } };
      x.device.kind = "machine";
      x.device.permittedAdapterVersions = ["*", CAMERA_VERSION];
      x.device.permittedFirmwareVersions = ["fw-*"];
      x.interpretation.evidenceTypeIds = ["capture.photo_nonced", "capture.no_such_primitive"];
    })],
    ["terms: one-shot below 1", edit((x) => (x.capture.coverage = { policy: "one-shot", minFraction: 0.5 }))],
    ["terms: an open end", edit((x) => (x.capture.endCondition = "open"))],
    ["terms: an unknown primitive", edit((x) => (x.interpretation.evidenceTypeIds = ["capture.no_such_primitive"]))],
    ["terms: a wildcard firmware pin", edit((x) => (x.device.permittedFirmwareVersions = ["*-unpinned-pilot"]))],
  ];

  INHERITABLE_RECORD = defaultObservation(p, PILOT[2]!) as unknown as Record<string, unknown>;

  // Accessors on the input itself, defined before any pollution, with null-prototype descriptors.
  const accessorPin = { ...RECIPE.massOmitted.input } as Record<string, unknown>;
  Object.defineProperty(accessorPin, "pinnedBundleSetDigest", nullDescriptor({ get: () => RECIPE.massOmitted.pin, enumerable: true, configurable: true }));
  RECIPE.accessorPin = accessorPin as unknown as ProfileAdmissionInput;
  const accessorLeg = { ...RECIPE.badlySigned } as Record<string, unknown>;
  Object.defineProperty(accessorLeg, "verifyBundleSignature", nullDescriptor({ get: () => verifySignature, enumerable: true, configurable: true }));
  RECIPE.accessorLeg = accessorLeg as unknown as ProfileAdmissionInput;
}

// -- running items while a change is in place: index loops, literals and operators only --
export type Row = [kind: string, label: string, value: unknown];

function summarize(r: ProfileAdmissionResult): unknown {
  const reasons: unknown[] = [];
  const list = r.reasons;
  for (let i = 0; i < list.length; i++) reasons[i] = [list[i]!.code, list[i]!.detail];
  return { decision: r.decision, admits: r.admits, reached: r.reached, qualifyingSamples: r.qualifyingSamples, reasons };
}

function copyList(list: unknown): unknown {
  if (typeof list !== "object" || list === null) return list;
  const out: unknown[] = [];
  const l = list as unknown[];
  for (let i = 0; i < l.length; i++) out[i] = l[i];
  return out;
}

async function admissionRow(label: string, made: ProfileAdmissionInput): Promise<Row> {
  let value: unknown;
  try {
    value = summarize(await profileAdmitsBundle(made));
  } catch {
    value = "threw";
  }
  return ["admission", label, value];
}

async function results(): Promise<Row[]> {
  const rows: Row[] = [];
  let n = 0;
  for (let i = 0; i < CASES.length; i++) rows[n++] = await admissionRow(CASES[i]![0], CASES[i]![1]);
  for (let i = 0; i < DIGEST_CASES.length; i++) {
    let value: unknown;
    try {
      value = await computeBundleSetDigest(DIGEST_CASES[i]![1], DIGEST_CASES[i]![2]);
    } catch {
      value = "threw";
    }
    rows[n++] = ["digest", DIGEST_CASES[i]![0], value];
  }
  for (let i = 0; i < TERM_CASES.length; i++) {
    let value: unknown;
    try {
      value = copyList(unverifiableProfileTerms(TERM_CASES[i]![1]));
    } catch {
      value = "threw";
    }
    rows[n++] = ["terms", TERM_CASES[i]![0], value];
  }
  for (let i = 0; i < LEVEL_ITEMS.length; i++) {
    let value: unknown;
    try {
      value = copyList(LEVEL_ITEMS[i]![1]());
    } catch {
      value = "threw";
    }
    rows[n++] = ["levels", LEVEL_ITEMS[i]![0], value];
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
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      ReflectDefineProperty(Object.prototype, keys[i]!, nullDescriptor({ value: v[keys[i]!], writable: true, configurable: true, enumerable: false }));
    }
    return () => {
      for (let i = 0; i < keys.length; i++) ReflectDeleteProperty(Object.prototype, keys[i]!);
    };
  };
}

function both(a: Apply, b: Apply): Apply {
  return () => {
    const undoA = a();
    const undoB = b();
    return () => {
      undoB();
      undoA();
    };
  };
}

const HashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;
const SubtleCryptoPrototype = Object.getPrototypeOf(globalThis.crypto.subtle) as object;

function forged(v: unknown): unknown {
  if (typeof v !== "string") return v;
  for (let i = 0; i < FORGE_FROM.length; i++) if (FORGE_FROM[i] === v) return FORGE_TO[i];
  return v;
}

/** Promise.prototype.then, forging a resolution it carries: a value in FORGE_FROM becomes its FORGE_TO. */
function forgingThen(original: (this: Promise<unknown>, f?: unknown, r?: unknown) => unknown) {
  return function (this: Promise<unknown>, f?: unknown, r?: unknown) {
    const onFulfilled = typeof f === "function" ? (v: unknown) => (f as (x: unknown) => unknown)(forged(v)) : f;
    return ReflectApply(original, this, [onFulfilled, r]);
  };
}

const FORGED_ADMIT = () => ({ decision: "admit", admits: true, reached: "inspected_output", qualifyingSamples: 1, reasons: [] });

/** What a forger swaps in: false becomes true, a carried digest becomes its FORGE_TO, an admission result admits. */
function forgedAnything(v: unknown): unknown {
  if (v === false) return true;
  if (typeof v === "object" && v !== null && hasOwn(v, "decision")) return FORGED_ADMIT();
  return forged(v);
}

/** The events a forged binding answer carries, for the case being run. */
let CURRENT_EVENTS: unknown[] | null = null;

/**
 * The admission result, read through the promise's own `.then` as a caller might, into a promise this harness
 * made and gave its own `constructor`, so the harness's own `await` reads nothing on Promise.prototype.
 */
function viaThen(made: ProfileAdmissionInput): Promise<unknown> {
  const settled = new PromiseAtLoad<unknown>((resolve) => {
    profileAdmitsBundle(made).then((r) => resolve(summarize(r)), () => resolve("threw"));
  });
  // Not an async function's promise: the harness's own `await` on it must read its own constructor.
  ReflectDefineProperty(settled, "constructor", nullDescriptor({ value: PromiseAtLoad }));
  return settled;
}

/** Every scenario: an id, the change, and the items it runs (all of them unless named). */
interface Scenario {
  id: string;
  apply: Apply;
  items?: () => Promise<Row[]>;
}

const PATCH_ROWS: Array<[string, Apply]> = [
  ["Array.prototype.map", replace(Array.prototype, "map", () => () => [])],
  ["Array.prototype.filter", replace(Array.prototype, "filter", () => () => [])],
  ["Array.prototype.some", replace(Array.prototype, "some", () => () => false)],
  ["Array.prototype.every", replace(Array.prototype, "every", () => () => true)],
  ["Array.prototype.includes", replace(Array.prototype, "includes", () => () => true)],
  ["Array.prototype.indexOf", replace(Array.prototype, "indexOf", () => () => 2)],
  ["Array.prototype.find", replace(Array.prototype, "find", () => () => undefined)],
  ["Array.prototype.findIndex", replace(Array.prototype, "findIndex", () => () => -1)],
  ["Array.prototype.join", replace(Array.prototype, "join", () => () => "")],
  ["Array.prototype.push", replace(Array.prototype, "push", () => () => 0)],
  ["Array.prototype.sort", replace(Array.prototype, "sort", (o) => function (this: unknown[]) { return ReflectApply(o, this, []).reverse(); })],
  ["Array.prototype.slice", replace(Array.prototype, "slice", () => () => [])],
  ["Array.prototype.concat", replace(Array.prototype, "concat", () => () => [])],
  ["Array.prototype[Symbol.iterator]", replace(Array.prototype, Symbol.iterator, () => function* () {})],
  ["%ArrayIteratorPrototype%.next", replace(ArrayIteratorPrototype, "next", () => () => ({ done: true, value: undefined }))],
  ["Array.from", replace(Array, "from", () => () => [])],
  ["Array.isArray", replace(Array, "isArray", () => () => false)],
  ["Object.keys", replace(Object, "keys", () => () => [])],
  ["Object.entries", replace(Object, "entries", () => () => [])],
  ["Object.values", replace(Object, "values", () => () => [])],
  ["Object.assign", replace(Object, "assign", () => (t: unknown) => t)],
  ["Object.freeze", replace(Object, "freeze", () => (v: unknown) => v)],
  ["Object.isFrozen", replace(Object, "isFrozen", () => () => true)],
  ["Object.getOwnPropertyDescriptor", replace(Object, "getOwnPropertyDescriptor", () => () => undefined)],
  ["Object.getPrototypeOf", replace(Object, "getPrototypeOf", () => () => null)],
  ["Object.create", replace(Object, "create", () => () => ({}))],
  ["Object.prototype.hasOwnProperty", replace(Object.prototype, "hasOwnProperty", () => () => true)],
  ["Reflect.ownKeys", replace(Reflect, "ownKeys", () => () => [])],
  ["JSON.stringify", replace(JSON, "stringify", () => () => '"x"')],
  ["JSON.parse", replace(JSON, "parse", () => () => ({}))],
  ["String", replace(globalThis, "String", () => () => "x")],
  ["Number.isFinite", replace(Number, "isFinite", () => () => true)],
  ["Date.parse", replace(Date, "parse", () => () => 0)],
  ["Math.min", replace(Math, "min", () => () => -Infinity)],
  ["Math.max", replace(Math, "max", () => () => Infinity)],
  ["Set.prototype.has", replace(Set.prototype, "has", () => () => false)],
  ["Set.prototype.add", replace(Set.prototype, "add", () => function (this: unknown) { return this; })],
  ["Set.prototype.size", replaceGetter(Set.prototype, "size", () => () => 1)],
  ["Map.prototype.get", replace(Map.prototype, "get", () => () => ({ status: "active" }))],
  ["Map.prototype.set", replace(Map.prototype, "set", () => function (this: unknown) { return this; })],
  ["RegExp.prototype.test", replace(RegExp.prototype, "test", () => () => true)],
  ["RegExp.prototype.exec", replace(RegExp.prototype, "exec", () => () => ({}))],
  ["String.prototype.trim", replace(String.prototype, "trim", () => () => "x")],
  ["String.prototype.charCodeAt", replace(String.prototype, "charCodeAt", () => () => 0x30)],
  ["String.prototype.includes", replace(String.prototype, "includes", () => () => false)],
  ["String.prototype.padStart", replace(String.prototype, "padStart", () => () => "zz")],
  ["Number.prototype.toString", replace(Number.prototype, "toString", () => () => "0")],
  ["Function.prototype.call", replace(Function.prototype, "call", () => () => undefined)],
  ["Function.prototype.apply", replace(Function.prototype, "apply", () => () => undefined)],
  ["structuredClone", replace(globalThis, "structuredClone", () => () => [])],
  ["TextEncoder.prototype.encode", replace(TextEncoder.prototype, "encode", () => () => new Uint8Array(0))],
  ["crypto.subtle.digest", replace(SubtleCryptoPrototype, "digest", () => () => Promise.resolve(new ArrayBuffer(32)))],
  ["Hash.prototype.update", replace(HashPrototype, "update", (o) => function (this: unknown) { return ReflectApply(o, this, ["tampered"]); })],
  ["Hash.prototype.digest", replace(HashPrototype, "digest", () => () => "0".repeat(64))],
  ["Promise.prototype.then, forging a carried digest", replace(Promise.prototype, "then", forgingThen)],
  ["Promise.prototype.constructor", replace(Promise.prototype, "constructor", () => function NotPromise() {})],
  ["Object.prototype.passed = true", pollute(() => ({ passed: true }))],
  ["Object.prototype.value = \"12.5\"", pollute(() => ({ value: "12.5" }))],
  ["Object.prototype.adapterVersion and firmwareVersion", pollute(() => ({ adapterVersion: CAMERA_VERSION, firmwareVersion: "cam-fw-2.1.0" }))],
  ["Object.prototype.deviceId", pollute(() => ({ deviceId: PRINTER }))],
  ["Object.prototype.settlementUnitId", pollute(() => ({ settlementUnitId: UNIT }))],
  ["Object.prototype.profileObservation", pollute(() => ({ [PROFILE_OBSERVATION_FIELD]: INHERITABLE_RECORD }))],
  ["Object.prototype.passed = false", pollute(() => ({ passed: false }))],
  ["Object.prototype.simulated = true", pollute(() => ({ simulated: true }))],
  ["Object.prototype.value = true", pollute(() => ({ value: true }))],
  ["Array.prototype[1] = a tagged digest", () => {
    ReflectDefineProperty(Array.prototype, "1", nullDescriptor({ value: "sha256:" + "3".repeat(64), writable: true, configurable: true, enumerable: false }));
    return () => void ReflectDeleteProperty(Array.prototype, "1");
  }],
  ["Object.prototype.mock = true", pollute(() => ({ mock: true }))],
];

/** Exported data admission or evidence-level read: each written as post-load code could; a frozen one refuses. */
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
const DATA_ROWS: Array<[string, Apply]> = [
  ["DEVICE_REPORTED_EVENT_TYPES += printer_job_verified", mutate(pushOnto(DEVICE_REPORTED_EVENT_TYPES, "printer_job_verified"))],
  ["SUBMITTED_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(SUBMITTED_EVENT_TYPES, "cv_inspection_result"))],
  ["INSPECTION_EVENT_TYPES += execution_completed", mutate(pushOnto(INSPECTION_EVENT_TYPES, "execution_completed"))],
  ["NO_OUTCOME_LEVEL_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(NO_OUTCOME_LEVEL_EVENT_TYPES, "cv_inspection_result"))],
  ["EXECUTION_EVENT_TYPES += cv_inspection_result", mutate(pushOnto(EXECUTION_EVENT_TYPES, "cv_inspection_result"))],
  ["EXECUTION_EVENT_TYPES[0] = cv_inspection_result", mutate(() => {
    const list = EXECUTION_EVENT_TYPES as unknown as string[];
    const before = list[0];
    list[0] = "cv_inspection_result";
    return () => void (list[0] = before!);
  })],
  ["EVIDENCE_LEVELS += vibes", mutate(pushOnto(EVIDENCE_LEVELS, "vibes"))],
  ["EVIDENCE_EVENT_TYPES += printer_warm", mutate(pushOnto(EVIDENCE_EVENT_TYPES, "printer_warm"))],
  ["EVIDENCE_DEVICE_TYPES += machine", mutate(pushOnto(EVIDENCE_DEVICE_TYPES, "machine"))],
  ["EVIDENCE_PRIMITIVES += an active capture.no_such_primitive", mutate(pushOnto(EVIDENCE_PRIMITIVES, { ...EVIDENCE_PRIMITIVES[0]!, id: "capture.no_such_primitive", status: "active" }))],
  ["EVIDENCE_PRIMITIVES capture.photo_nonced status = deprecated", mutate(() => {
    let def: { status: string } | undefined;
    for (let i = 0; i < EVIDENCE_PRIMITIVES.length; i++) if (EVIDENCE_PRIMITIVES[i]!.id === "capture.photo_nonced") def = EVIDENCE_PRIMITIVES[i] as unknown as { status: string };
    const before = def!.status;
    def!.status = "deprecated";
    return () => void (def!.status = before);
  })],
];

/** Targeted recipes: changes a generic replacement cannot express. Each runs its own items. */
const one = (label: string, made: () => ProfileAdmissionInput) => async (): Promise<Row[]> => [await admissionRow(label, made())];

const RECIPES: Scenario[] = [
  {
    // astra pack 167: RegExp.prototype.compile rewrites a RegExp's matcher in place, frozen or not.
    id: "recipe: DECIMAL_VALUE_PATTERN recompiled to .*",
    apply: () => {
      const pattern = (admissionModule as Record<string, unknown>).DECIMAL_VALUE_PATTERN;
      if (!(pattern instanceof RegExp)) return () => undefined;
      const source = pattern.source;
      pattern.compile(".*");
      return () => void pattern.compile(source);
    },
    items: one("an exponent value (1e-7)", () => RECIPE.exponent),
  },
  {
    id: "recipe: TAGGED_DIGEST_PATTERN (signing-preimage.ts) recompiled to .*",
    apply: () => {
      const source = TAGGED_DIGEST_PATTERN.source;
      TAGGED_DIGEST_PATTERN.compile(".*");
      return () => void TAGGED_DIGEST_PATTERN.compile(source);
    },
    items: async () => [
      await admissionRow("a sampleId that is not a digest", RECIPE.frame),
      await admissionRow("a pin that is not a digest", RECIPE.notAPin),
      await admissionRow("a malformed pin under onMissingData hold", RECIPE.notAPinHold),
    ],
  },
  {
    // astra pack 162's HIGH: `"value" in descriptor` consults Object.prototype. The accessor is
    // defined (null-prototype descriptor) before the pollution is written.
    id: "recipe: Object.prototype.value written; an accessor pin on the input",
    apply: pollute(() => ({ value: RECIPE.massOmitted.presented })),
    items: one("an accessor pin, a stored failure bundle left out", () => RECIPE.accessorPin),
  },
  {
    id: "recipe: Object.prototype.value written; an accessor signature leg on the input",
    apply: pollute(() => ({ value: () => true })),
    items: one("an accessor signature leg, a bundle signed over another digest", () => RECIPE.accessorLeg),
  },
  {
    id: "recipe: Object.prototype.value written; an accessor deep in the bundles (codeInData)",
    apply: pollute(() => ({ value: true })),
    items: one("an accessor deep in the bundles", () => RECIPE.accessorDeep),
  },
  {
    // unverifiableProfileTerms is exported: a caller may pass an ordinary object. It reads own data only, so a
    // term written on Object.prototype is never taken for the profile's (identical, not merely more terms).
    id: "recipe: Object.prototype.tolerance and maxIntervalMs written; unverifiableProfileTerms on an ordinary profile",
    apply: pollute(() => ({ tolerance: { comparator: ">=", target: 1 }, maxIntervalMs: 5 })),
    items: async () => {
      const rows: Row[] = [];
      for (let i = 0; i < TERM_CASES.length; i++) {
        let value: unknown;
        try {
          value = copyList(unverifiableProfileTerms(TERM_CASES[i]![1]));
        } catch {
          value = "threw";
        }
        rows[i] = ["terms", TERM_CASES[i]![0], value];
      }
      return rows;
    },
  },
  {
    id: "recipe: Promise.prototype.then forges the presented set digest",
    apply: replace(Promise.prototype, "then", forgingThen),
    items: async () => {
      let digest: unknown;
      try {
        digest = await computeBundleSetDigest(SUBJECT, [RECIPE.omitted.pilotHash]);
      } catch {
        digest = "threw";
      }
      return [["digest", "the presented set", digest], await admissionRow("a stored failure bundle left out", RECIPE.omitted.input)];
    },
  },
  {
    id: "recipe: Promise.prototype.then forges binding's bundle hash",
    apply: replace(Promise.prototype, "then", forgingThen),
    items: one("an inspection re-hashed after signing", () => RECIPE.tampered.input),
  },
  {
    // `await` reads a promise's constructor; with it replaced, every await resolves through `then`.
    id: "recipe: Promise.prototype.constructor and then forge a leg's false, a digest and a result",
    apply: both(
      replace(Promise.prototype, "constructor", () => function NotPromise() {}),
      replace(Promise.prototype, "then", (original) => function (this: Promise<unknown>, f?: unknown, r?: unknown) {
        const onFulfilled = typeof f === "function" ? (v: unknown) => (f as (x: unknown) => unknown)(forgedAnything(v)) : f;
        return ReflectApply(original, this, [onFulfilled, r]);
      }),
    ),
    items: async () => {
      let digest: unknown;
      try {
        digest = await computeBundleSetDigest(SUBJECT, [RECIPE.omitted.pilotHash]);
      } catch {
        digest = "threw";
      }
      return [
        await admissionRow("the signature leg fails", RECIPE.signatureFails),
        await admissionRow("an async signature leg answers false", RECIPE.asyncSignatureFails),
        await admissionRow("an async primitive leg answers false", RECIPE.asyncPrimitiveFails),
        await admissionRow("a stored failure bundle left out", RECIPE.omitted.input),
        ["digest", "the presented set", digest],
        ["admission", "the result read through .then", await viaThen(RECIPE.signatureFails)],
      ];
    },
  },
  {
    // binding's failure is resolved as an ordinary object: a `then` on Object.prototype can turn it into ok.
    id: "recipe: Object.prototype.then forges binding's failure into ok, with the presented events",
    apply: () => {
      const install = (): void =>
        void ReflectDefineProperty(Object.prototype, "then", nullDescriptor({
          configurable: true,
          writable: true,
          value: function (this: object, resolve: (v: unknown) => void) {
            ReflectDeleteProperty(Object.prototype, "then");
            try {
              const forgeIt = hasOwn(this, "ok") && (this as { ok: unknown }).ok === false && CURRENT_EVENTS !== null;
              resolve(forgeIt ? { ok: true, events: CURRENT_EVENTS } : this);
            } finally {
              install();
            }
          },
        }));
      install();
      return () => void ReflectDeleteProperty(Object.prototype, "then");
    },
    items: async () => {
      const rows: Row[] = [];
      const list = RECIPE.bindingRejects as Array<{ label: string; input: ProfileAdmissionInput; events: unknown[] }>;
      for (let i = 0; i < list.length; i++) {
        CURRENT_EVENTS = list[i]!.events;
        rows[i] = await admissionRow(list[i]!.label, list[i]!.input);
      }
      CURRENT_EVENTS = null;
      return rows;
    },
  },
  {
    id: "recipe: Object.prototype.then forges the result admission resolves with",
    apply: () => {
      const install = (): void =>
        void ReflectDefineProperty(Object.prototype, "then", nullDescriptor({
          configurable: true,
          writable: true,
          value: function (this: object, resolve: (v: unknown) => void) {
            ReflectDeleteProperty(Object.prototype, "then");
            try {
              resolve(hasOwn(this, "decision") ? FORGED_ADMIT() : this);
            } finally {
              install();
            }
          },
        }));
      install();
      return () => void ReflectDeleteProperty(Object.prototype, "then");
    },
    items: one("the signature leg fails", () => RECIPE.signatureFails),
  },
  {
    id: "recipe: Array.prototype.sort swaps a re-hashed event back into the signed list",
    apply: replace(Array.prototype, "sort", (original) => function (this: unknown[], ...args: unknown[]) {
      const out = ReflectApply(original, this, args) as unknown[];
      for (let i = 0; i < out.length; i++) if (out[i] === RECIPE.tampered.tamperedHash) out[i] = RECIPE.tampered.originalHash;
      return ReflectApply(original, out, args);
    }),
    items: one("an inspection re-hashed after signing", () => RECIPE.tampered.input),
  },
  {
    id: "recipe: JSON.parse answers a passing verdict for a signed failure",
    apply: replace(JSON, "parse", (original) => function (s: string, reviver?: unknown) {
      const v = ReflectApply(original, JSON, [s, reviver]);
      if (s === RECIPE.genuineFailure.text) (v as { payload: Record<string, unknown> }).payload.passed = true;
      return v;
    }),
    items: one("a failed inspection, genuine", () => RECIPE.genuineFailure.input),
  },
  {
    id: "recipe: structuredClone hands the primitive leg a capture that matches",
    apply: replace(globalThis, "structuredClone", (original) => (v: unknown, o?: unknown) => {
      const out = original(v, o) as Array<{ payload?: Record<string, unknown> }>;
      for (let i = 0; i < out.length; i++) {
        const payload = out[i]?.payload;
        if (payload !== undefined && payload.captureHash !== undefined) payload.captureHash = RECIPE.otherCapture.captureHash;
      }
      return out;
    }),
    items: one("a leg that checks the capture, which is another", () => RECIPE.otherCapture.input),
  },
];

export const SCENARIOS: Scenario[] = [
  ...PATCH_ROWS.map(([label, apply]) => ({ id: `patch: ${label}`, apply })),
  ...DATA_ROWS.map(([label, apply]) => ({ id: `data: ${label}`, apply })),
  ...RECIPES,
];

// -- main --
const HANG_MS = 20_000;

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (id === "--list") {
    write(SCENARIOS.map((s) => s.id));
    return;
  }
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${JSON.stringify(id)}`);
  await buildCases();
  const items = scenario.items ?? results;
  const clean = await items();
  let restored = false;
  let undo: () => void = () => undefined;
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
    undo = scenario.apply();
    patched = await items();
  } catch (err) {
    patched = `the scenario threw: ${String(err)}`;
  } finally {
    restore();
  }
  clearTimeoutAtLoad(watchdog);
  write({ scenario: id, clean, patched });
}

// Run only when invoked as a script (tsx admission-realm.ts ...), never when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
