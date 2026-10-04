/**
 * profileAdmitsBundle (LO-SE-2): does authenticated, bound evidence satisfy the
 * committed MeasurementProfile? Bundles here are real: production
 * hashEvent/hashBundle, an Ed25519 key signing signingPreimage(bundleHash), and
 * events that commit the job and kernel so LO-EV-9 binding genuinely passes.
 *
 * Round 2 answers the cross-family DO-NOT-SHIP on 29630a48 (pack 04): terms
 * are compared (F1), the presented set must open to the pinned set digest (F2),
 * samples are counted by sampleId (F3), and each version pin reads its own
 * field (F4). Evidence's rulings (bus #3419): value is a decimal string, and
 * the set digest binds the settlement unit.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

import {
  profileAdmitsBundle,
  computeBundleSetDigest,
  NON_NUMERIC_UNIT,
  PROFILE_OBSERVATION_FIELD,
  type AdmissionBundle,
  type ProfileAdmissionInput,
  type ProfileAdmissionResult,
  type ProfileObservation,
} from "../evidence/profile-admission.js";
import {
  computeMeasurementProfileDigest,
  profileGoverns,
  type MeasurementProfileV1,
} from "../evidence/measurement-profile.js";
import { signingPreimage } from "../evidence/signing-preimage.js";
import { canonicalize, hashBundle, hashEvent } from "../util/canonical.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "../evidence/subject-binding.js";
import type { EvidenceEvent } from "../types/evidence.js";
import { awaitedHere, fulfillsWithTrue, ownPromise } from "../util/primordials.js";

const JOB = "job-admission-1";
const KERNEL = "kernel-admission-1";
const PRINTER = "dev-printer";
const CAMERA = "dev-camera";
const SCALE = "dev-scale";

const PRINTER_VERSION = "IppAdapter-1.0.0";
const CAMERA_VERSION = "PhotoCameraAdapter-1.0.0";
const SCALE_VERSION = "ScaleAdapter-1.0.0";

const DOCUMENT = { kind: "documentHash", value: "sha256:" + "b".repeat(64) };

const key = generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** Per-device defaults for `source`, keyed by the device id (see the brief). */
function defaultSource(device: string): Record<string, unknown> {
  if (device === PRINTER) {
    return { deviceType: "controller", adapterType: "ipp", adapterVersion: PRINTER_VERSION, firmwareVersion: "printer-fw-7.3" };
  }
  if (device === SCALE) {
    return { deviceType: "instrument", adapterType: "scale", adapterVersion: SCALE_VERSION, firmwareVersion: "scale-fw-1.0" };
  }
  return { deviceType: "camera", adapterType: "photo", adapterVersion: CAMERA_VERSION, firmwareVersion: "cam-fw-2.1.0" };
}

/** Shallow-merge `override` over `base`; a key explicitly set to undefined is removed. */
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
}

/** The default `profileObservation` record for one draft, against `profile`. */
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
  const unsigned = { type: d.type, timestamp: at(d.t), source, payload };
  const hash = await hashEvent(unsigned as unknown as Omit<EvidenceEvent, "hash" | "id">);
  return { ...unsigned, id: `${d.type}-${d.t}-${d.device}`, hash } as unknown as EvidenceEvent;
}

/** Attaches `payload.profileObservation` to every draft unless it says `observation: null`. */
async function toBundle(drafts: Draft[], profile: MeasurementProfileV1): Promise<AdmissionBundle> {
  const events = await Promise.all(
    drafts.map((d) => {
      if (d.observation === null) return toEvent(d);
      const merged = mergeDefined(
        defaultObservation(profile, d) as unknown as Record<string, unknown>,
        d.observation as Record<string, unknown> | undefined,
      );
      return toEvent({ ...d, payload: { ...(d.payload ?? {}), [PROFILE_OBSERVATION_FIELD]: merged } });
    }),
  );
  const bundleHash = await hashBundle(events);
  const value = sign(null, signingPreimage(bundleHash), key.privateKey).toString("hex");
  return { bundleHash, events, kernelSignature: { signer: "0x1111111111111111111111111111111111111111", algorithm: "ed25519", value } };
}

const verifySignature = (b: AdmissionBundle) =>
  verify(null, signingPreimage(b.bundleHash), key.publicKey, Buffer.from((b.kernelSignature as { value: string }).value, "hex"));

/** printer execution_started t0, execution_completed t10, camera inspects (passed) at t20. */
const PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true } },
];

/** printer runs the job; the scale weighs the result. */
const MASS_PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "instrument_result", t: 20, device: SCALE, payload: { passed: true } },
];

function inspectedPageProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/test/inspected-page/v1",
    outcome: {
      capabilityType: "document-printing",
      statement: "The page was printed and a separate camera inspected it.",
      objectIdentity: DOCUMENT,
    },
    device: {
      deviceId: CAMERA,
      kind: "camera",
      adapterType: "photo",
      permittedAdapterVersions: [CAMERA_VERSION],
      permittedFirmwareVersions: ["cam-fw-2.1.0"],
    },
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

async function admit(
  profile: MeasurementProfileV1,
  bundles: AdmissionBundle[],
  over: Partial<ProfileAdmissionInput> = {},
): Promise<ProfileAdmissionResult> {
  const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
  // The caller pinned exactly these bundles.
  const pinnedBundleSetDigest =
    bundles.length > 0 ? await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)) : ("sha256:" + "0".repeat(64));
  return profileAdmitsBundle({
    profile,
    committedDigest: computeMeasurementProfileDigest(profile),
    subject,
    bundles,
    pinnedBundleSetDigest,
    verifyBundleSignature: verifySignature,
    verifyPrimitiveInstance: () => true,
    ...over,
  });
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("profile admission — admits evidence that satisfies the committed profile", () => {
  it("admits the pilot: printer completes, a separate camera inspects after completion", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)]);
    expect(r).toMatchObject({ decision: "admit", admits: true, reached: "inspected_output", qualifyingSamples: 1, reasons: [] });
  });

  it("admits a device_reported profile on the printer's own completion", async () => {
    const p = deviceReportedProfile();
    const r = await admit(p, [await toBundle(PILOT, p)]);
    expect(r.decision).toBe("admit");
  });

  it("admits the mass profile: the scale's positive-control reading (decimal-string value)", async () => {
    const p = massProfile();
    const r = await admit(p, [await toBundle(MASS_PILOT, p)]);
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 1 });
  });

  it("judges an inspection against the executing devices across several bundles of the same job", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2), p), await toBundle(PILOT.slice(2), p)]);
    expect(r.decision).toBe("admit");
  });
});

describe("profile admission — the committed profile governs (section 3: mutation after acceptance)", () => {
  it("a profile changed after acceptance is rejected", async () => {
    const accepted = inspectedPageProfile();
    const loosened = inspectedPageProfile();
    loosened.interpretation.acceptanceLevel = "device_reported";
    const r = await admit(loosened, [await toBundle(PILOT, accepted)], { committedDigest: computeMeasurementProfileDigest(accepted) });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["digest-mismatch"]);
  });

  it("a committed digest in the sha256: evidence-event family is rejected", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], { committedDigest: `sha256:${computeMeasurementProfileDigest(p).slice(2)}` });
    expect(codes(r)).toEqual(["digest-wrong-family"]);
  });
});

describe("profile admission — only authenticated, bound evidence counts (section 3: job A/B, node A/B)", () => {
  it("a bundle whose signature leg fails is rejected", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], { verifyBundleSignature: () => false });
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
  });

  it("a signature verifier that throws counts as a failed signature", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], {
      verifyBundleSignature: () => {
        throw new Error("registry unavailable");
      },
    });
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
  });

  it("evidence from job A cannot satisfy job B", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT.map((d) => ({ ...d, jobId: "job-other" })), p)]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("job-mismatch");
  });

  it("evidence from node A cannot be substituted for node B", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT.map((d) => ({ ...d, kernelId: "kernel-other" })), p)]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("kernel-mismatch");
  });

  it("an event altered after hashing is rejected", async () => {
    const p = inspectedPageProfile();
    const b = await toBundle(PILOT, p);
    (b.events[2] as { payload: Record<string, unknown> }).payload.passed = false;
    const r = await admit(p, [b]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("event-hash-mismatch");
  });
});

describe("profile admission — simulated evidence cannot satisfy a non-simulated profile (section 3)", () => {
  it("a simulated source rejects the whole evidence set", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });

  it("a payload.mock event rejects too, even when a genuine inspection is present", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT, { type: "execution_progress", t: 5, device: PRINTER, payload: { mock: true } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });
});

describe("profile admission — levels come from the evidence contract", () => {
  it("a device's report on its own output is not inspected_output", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: PRINTER } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reached).toBe("device_reported");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("printer_job_verified alone proves no level, not even device_reported (the R5 print-leg case)", async () => {
    const p = deviceReportedProfile();
    const r = await admit(p, [await toBundle([{ type: "printer_job_verified", t: 10, device: PRINTER }], p)]);
    expect(r.reached).toBeNull();
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("level-not-reached follows onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2), p)]);
    expect(r.decision).toBe("hold");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });
});

describe("profile admission — missing measurements follow the committed policy (section 3)", () => {
  it("an inspection from a camera the profile does not name does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: "dev-other-camera" } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 from other devices");
  });

  it("an observation from an unpermitted version does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, source: { adapterVersion: "PhotoCameraAdapter-9.9.9" } } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("1 unpermitted version");
  });

  it("an observation with no version at all does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) =>
      d.device === CAMERA ? { ...d, source: { adapterVersion: undefined, firmwareVersion: undefined } } : d,
    );
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("an inspection before the printer completed is outside the capture window", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, t: 5 } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("1 outside the capture window");
  });

  it("fewer observations than minSamples is missing data", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, [await toBundle(PILOT, p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("missing measurements follow onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    p.onMissingData = "hold";
    expect((await admit(p, [await toBundle(PILOT, p)])).decision).toBe("hold");
  });

  it("no bundles at all is missing data", async () => {
    const r = await admit(inspectedPageProfile(), []);
    expect(codes(r)).toEqual(["no-bundles"]);
  });
});

describe("profile admission — failure and contradiction follow the committed policy (section 3)", () => {
  it("completion and execution_failed together is a contradiction", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p)]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["contradictory-evidence"]);
  });

  it("a contradiction follows onContradiction: hold", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    const r = await admit(p, [await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p)]);
    expect(r.decision).toBe("hold");
  });

  it("a reported device failure follows onDeviceFailure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([PILOT[0]!, { type: "execution_failed", t: 10, device: PRINTER }], p)]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("device-failure");
  });

  it("a hold finding never outranks a reject finding", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    p.onMissingData = "reject";
    const r = await admit(p, [
      await toBundle([...PILOT.slice(0, 2), { type: "execution_failed", t: 11, device: PRINTER }], p),
    ]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["contradictory-evidence", "level-not-reached"]);
  });
});

describe("profile admission — terms this version cannot evaluate fail closed, never skipped", () => {
  const cases: [string, (p: MeasurementProfileV1) => void, string][] = [
    ["a numeric tolerance", (p) => (p.measurement.tolerance = { comparator: ">=", target: 0.9 }), "measurement.tolerance"],
    ["required calibration", (p) => (p.calibration = { required: true, procedureId: "cal-1", validityWindowSeconds: 3600 }), "calibration.required"],
    ["required witnesses", (p) => (p.witnesses = { requiredRoles: ["inspector"], independentOfClaimant: true }), "witnesses.requiredRoles"],
    ["continuous coverage", (p) => (p.capture.coverage = { policy: "continuous", minFraction: 0.9 }), "coverage.policy"],
    ["a start token that is not an event type", (p) => (p.capture.startCondition = "printer_warm"), "startCondition"],
    ["an end token that is not an event type or open", (p) => (p.capture.endCondition = "capture_complete"), "endCondition"],
    ["a maxIntervalMs (continuous-capture) term", (p) => (p.measurement.sampling = { minSamples: 1, maxIntervalMs: 1000 }), "maxIntervalMs"],
    ["a one-shot coverage with minFraction below 1", (p) => (p.capture.coverage = { policy: "one-shot", minFraction: 0.5 }), "coverage.minFraction"],
    ["a device.kind that is not an evidence device type", (p) => (p.device.kind = "machine"), "device.kind"],
    ["a version pin containing a wildcard", (p) => (p.device.permittedFirmwareVersions = ["*-unpinned-pilot"]), "version pins are exact strings"],
    [
      "an evidenceTypeIds entry that is not an active primitive",
      (p) => (p.interpretation.evidenceTypeIds = ["capture.no_such_primitive"]),
      "is not an active vocabulary primitive",
    ],
  ];
  for (const [name, mutate, term] of cases) {
    it(`${name} → unverifiable-term`, async () => {
      const p = inspectedPageProfile();
      mutate(p);
      const r = await admit(p, [await toBundle(PILOT, p)]);
      expect(r.decision).toBe("reject");
      expect(codes(r)).toEqual(["unverifiable-term"]);
      expect(r.reasons[0]!.detail).toContain(term);
    });
  }
});

describe("profile admission — review #363 fixes (evidence #2777, probes P1-P3 inverted)", () => {
  const INSPECT = (payload: Record<string, unknown>): Draft => ({ type: "cv_inspection_result", t: 20, device: CAMERA, payload });
  const PRINTED = PILOT.slice(0, 2);

  it("P1: the same signed bundle presented twice counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const b = await toBundle(PILOT, p);
    const r = await admit(p, [b, b]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 from the profiled device");
  });

  it("P1b: one event listed twice inside one signed bundle counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, [await toBundle([...PILOT, PILOT[2]!], p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
  });

  it("P2: an inspection reporting passed:false is a failure, never a sample", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([...PRINTED, INSPECT({ passed: false, antiSpoofScore: 0.1 })], p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["contradictory-evidence", "missing-measurements"]);
    expect(r.reasons[1]!.detail).toContain("1 failed inspection(s)");
  });

  it("a failed inspection with no completion is a device failure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([PILOT[0]!, INSPECT({ passed: false })], p)]);
    expect(codes(r)).toContain("device-failure");
  });

  it("any non-true passed value is a negative verdict", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([...PRINTED, INSPECT({ passed: "yes" })], p)]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });
});

describe("profile admission — evaluates only what was hashed (coord-watch rule, evidence #3079)", () => {
  it("a getter that answered false to the hash cannot answer true to admission", async () => {
    const p = inspectedPageProfile();
    const b = await toBundle([...PILOT.slice(0, 2), { ...PILOT[2]!, payload: { passed: false } }], p);
    const payload = (b.events[2] as { payload: Record<string, unknown> }).payload;
    // Measure how many times binding reads `passed`, so the lie starts exactly after binding.
    // LO-EV-9's binding (#341) runs no caller code either: it refuses the accessor without
    // running its getter, so binding reads it 0 times and the lie starts at the first read.
    let reads = 0;
    Object.defineProperty(payload, "passed", { get: () => (reads++, false), enumerable: true, configurable: true });
    const probe = await verifyEvidenceSubjectBinding({
      bundleHash: b.bundleHash,
      events: b.events,
      subject: { jobId: JOB, kernelId: KERNEL },
    });
    expect(probe, "binding refuses data that carries code, at the event that carries it").toMatchObject({ ok: false, reason: "malformed-event", eventIndex: 2 });
    expect(reads, "reads of the getter during binding").toBe(0);
    const readsDuringBinding = reads;
    // Now: truthful (false, as hashed) for binding's reads, then true on every later read.
    reads = 0;
    Object.defineProperty(payload, "passed", {
      get: () => reads++ >= readsDuringBinding,
      enumerable: true,
      configurable: true,
    });
    const r = await admit(p, [b]);
    // Since astra pack 127, data that carries code (an accessor anywhere) is refused before
    // anything is read, so the getter never runs at all: stronger than evaluating its first answer.
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(r.reasons[0]!.detail).toMatch(/input\.bundles\.0\.events\.2\.payload\.passed: an accessor/);
    expect(r.qualifyingSamples).toBe(0);
  });

  it("contradictions come from evidence's deriveContradictions, named by kind", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p)]);
    expect(r.reasons[0]).toMatchObject({ code: "contradictory-evidence" });
    expect(r.reasons[0]!.detail).toContain("completion-and-failure");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F1: terms are compared", () => {
  const PRINTED = PILOT.slice(0, 2);

  it("an observation naming a different object is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { object: { kind: "documentHash", value: "sha256:" + "c".repeat(64) } } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("not matching outcome.objectIdentity");
  });

  it("an inspection with no passed field (the record is still present) is excluded, never a sample", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { score: 0.97 } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(r.reasons[0]!.detail).toContain("without a positive verdict");
  });

  it("a bare signed inspection with no profileObservation record does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true }, observation: null }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(r.reasons[0]!.detail).toContain("without a profileObservation record");
  });

  it("an observation naming another (active) primitive is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { primitiveId: "artifact.hash" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("not matching interpretation.evidenceTypeIds");
  });

  it("an observation naming a different method is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { method: "manual-count" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("not matching measurement.method");
  });

  it("an observation naming a different quantity is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { quantity: "page-count" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("not matching measurement.quantity");
  });

  it("an observation carrying another valid profile's digest is excluded", async () => {
    const p = inspectedPageProfile();
    const other = inspectedPageProfile();
    other.measurement.sampling.minSamples = 2;
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { profileDigest: computeMeasurementProfileDigest(other) } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("not matching the committed profile digest");
  });

  it("the mass profile admits a decimal-string value (positive control)", async () => {
    const p = massProfile();
    const r = await admit(p, [await toBundle(MASS_PILOT, p)]);
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 1 });
  });

  it("an observation with the wrong unit is excluded", async () => {
    const p = massProfile();
    const drafts = MASS_PILOT.map((d) => (d.device === SCALE ? { ...d, observation: { unit: "g" } } : d));
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("not matching measurement.unit");
  });

  const badValues: [string, unknown][] = [
    ["removed", undefined],
    ["a JSON number, not a string", 12.5],
    ["exponent notation", "1e-7"],
    ["a leading zero", "01.5"],
  ];
  for (const [name, value] of badValues) {
    it(`a numeric observation with value ${name} is excluded`, async () => {
      const p = massProfile();
      const drafts = MASS_PILOT.map((d) =>
        d.device === SCALE ? { ...d, observation: { value } as Partial<ProfileObservation> } : d,
      );
      const r = await admit(p, [await toBundle(drafts, p)]);
      expect(r.reasons[0]!.detail).toContain("without a decimal-string value");
    });
  }

  it("a non-numeric (unit none) observation carrying a value is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { value: "3" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("with a value on a non-numeric (unit none) observation");
  });

  it("the primitive leg returning false excludes the observation", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], { verifyPrimitiveInstance: () => false });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });

  it("a primitive leg that throws excludes the observation the same way", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], {
      verifyPrimitiveInstance: () => {
        throw new Error("verifier unavailable");
      },
    });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });

  it("the primitive leg receives the primitive id, a frozen snapshot, and the frozen bound event set", async () => {
    const p = inspectedPageProfile();
    const b = await toBundle(PILOT, p);
    const cameraEvent = b.events[2] as EvidenceEvent;
    const calls: { id: string; observation: EvidenceEvent; events: readonly EvidenceEvent[] }[] = [];
    const r = await admit(p, [b], {
      verifyPrimitiveInstance: (id, observation, events) => {
        calls.push({ id, observation, events });
        return true;
      },
    });
    expect(r.decision).toBe("admit");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.id).toBe("capture.photo_nonced");
    expect(call.observation.hash).toBe(cameraEvent.hash);
    expect(call.observation).not.toBe(cameraEvent);
    expect(call.events.some((e) => e.hash === cameraEvent.hash)).toBe(true);
    expect(Object.isFrozen(call.observation)).toBe(true);
    expect(Object.isFrozen(call.observation.payload)).toBe(true);
  });

  it("a leg that mutates its observation throws, and a throwing leg is a failure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], {
      verifyPrimitiveInstance: (_id, observation) => {
        (observation.payload as Record<string, unknown>).passed = false;
        return true;
      },
    });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F2: the pinned set", () => {
  const subject = { jobId: JOB, kernelId: KERNEL };
  const FAILURE: Draft[] = [{ type: "execution_failed", t: 11, device: PRINTER }];

  it("omitting a stored failure bundle from the presented set cannot produce admit", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash, b2.bundleHash]);
    const r = await admit(p, [b1], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch"]);
    expect(r.reasons[0]!.detail).toContain("a bundle is missing or was not pinned");
  });

  it("an omitted bundle follows onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash, b2.bundleHash]);
    const r = await admit(p, [b1], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("hold");
  });

  it("presenting the full pinned set surfaces the contradiction the omission would have hidden", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash, b2.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("a bundle outside the pinned set is rejected even though it verifies", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    // b2 (the extra, unpinned bundle) is a failure bundle: since evaluation
    // does not stop at the mismatch, the contradiction it makes with b1's
    // completion is also found.
    expect(codes(r)).toContain("bundle-set-mismatch");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("a malformed pin is rejected, never recomputed", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT, p)], { pinnedBundleSetDigest: "0x" + "a".repeat(64) });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-pin-invalid"]);

    // A malformed pin is invalid authority, not merely missing data: it must
    // reject even under onMissingData: "hold".
    const held = inspectedPageProfile();
    held.onMissingData = "hold";
    const r2 = await admit(held, [await toBundle(PILOT, held)], { pinnedBundleSetDigest: "0x" + "a".repeat(64) });
    expect(r2.decision).toBe("reject");
    expect(codes(r2)).toEqual(["bundle-set-pin-invalid"]);
  });

  it("a mismatched set is never admitted, and the evidence presented is still evaluated", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    p.onContradiction = "reject";
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const b3 = await toBundle([{ type: "camera_snapshot", t: 25, device: CAMERA, observation: null }], p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash, b2.bundleHash]);
    let signatureCalls = 0;
    const r = await admit(p, [b1, b2, b3], {
      pinnedBundleSetDigest: pin,
      verifyBundleSignature: (b) => {
        signatureCalls++;
        return verifySignature(b);
      },
    });
    // Never admit on a mismatch, but a hard reject in what WAS presented
    // still decides: the mismatch (hold) cannot hide the contradiction
    // (reject), so reject outranks hold. Mismatch is found first.
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch", "contradictory-evidence"]);
    // Every presented bundle's leg ran, including the extra one: a mismatch
    // no longer short-circuits authentication and binding.
    expect(signatureCalls).toBe(3);
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F2: computeBundleSetDigest", () => {
  const subject = { jobId: JOB, kernelId: KERNEL };
  const h1 = "sha256:" + "1".repeat(64);
  const h2 = "sha256:" + "2".repeat(64);

  it("is order-insensitive and de-duplicating", async () => {
    const a = await computeBundleSetDigest(subject, [h1, h2]);
    const b = await computeBundleSetDigest(subject, [h2, h1, h1]);
    expect(a).toBe(b);
  });

  it("is job-bound: another jobId gives a different digest", async () => {
    const a = await computeBundleSetDigest(subject, [h1, h2]);
    const b = await computeBundleSetDigest({ ...subject, jobId: "job-other" }, [h1, h2]);
    expect(a).not.toBe(b);
  });

  it("is domain-separated from hashBundle over the same hashes", async () => {
    const setDigest = await computeBundleSetDigest(subject, [h1, h2]);
    const bundleDigest = await hashBundle([{ hash: h1 }, { hash: h2 }] as unknown as EvidenceEvent[]);
    expect(setDigest).not.toBe(bundleDigest);
  });

  it("is sha256:-tagged, 64 lowercase hex", async () => {
    expect(await computeBundleSetDigest(subject, [h1])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws on an empty set", async () => {
    await expect(computeBundleSetDigest(subject, [])).rejects.toThrow();
  });

  it("throws on an entry that is not a sha256: tagged digest", async () => {
    await expect(computeBundleSetDigest(subject, ["not-a-digest"])).rejects.toThrow();
  });

  it("binds settlementUnitId when the subject names one", async () => {
    const withUnit = await computeBundleSetDigest({ ...subject, settlementUnitId: "0x" + "1".repeat(64) }, [h1, h2]);
    const withoutUnit = await computeBundleSetDigest(subject, [h1, h2]);
    expect(withUnit).not.toBe(withoutUnit);
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F3: samples, not events", () => {
  const PRINTED = PILOT.slice(0, 2);
  const S = "sha256:" + "c".repeat(64);

  it("a sample reissued with a new timestamp counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const drafts = [
      ...PRINTED,
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true }, observation: { sampleId: S } },
      { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true }, observation: { sampleId: S } },
    ];
    const b = await toBundle(drafts, p);
    expect((b.events[2] as EvidenceEvent).hash).not.toBe((b.events[3] as EvidenceEvent).hash);
    const r = await admit(p, [b]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 repeating a counted sample");
  });

  it("two distinct captures are two samples", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const drafts = [
      ...PRINTED,
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true } },
      { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true } },
    ];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 2 });
  });

  it("a sampleId that is not a sha256: digest is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { sampleId: "frame-7" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("without a sha256: sampleId");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F4: split version pins", () => {
  function splitPinProfile(): MeasurementProfileV1 {
    const p = inspectedPageProfile();
    p.device = { ...p.device, permittedAdapterVersions: ["cam-A"], permittedFirmwareVersions: ["fw-1"] };
    return p;
  }

  it("each pin is checked against its own field (disjoint pins, both present, admits)", async () => {
    const p = splitPinProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterVersion: "cam-A", firmwareVersion: "fw-1" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.decision).toBe("admit");
  });

  it("a version present only in the other list does not count", async () => {
    const p = splitPinProfile();
    for (const source of [
      { adapterVersion: "fw-1", firmwareVersion: "fw-1" },
      { adapterVersion: "cam-A", firmwareVersion: "cam-A" },
    ]) {
      const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source }];
      const r = await admit(p, [await toBundle(drafts, p)]);
      expect(r.reasons[0]!.detail).toContain("unpermitted version");
    }
  });

  it("the old one-field convention (firmwareVersion alone) does not count", async () => {
    const p = splitPinProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterVersion: undefined, firmwareVersion: "cam-A" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("unpermitted version");
  });

  it("device kind is compared with source.deviceType", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { deviceType: "thermal_camera" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });

  it("adapter type is compared with source.adapterType", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterType: "mock-photo" } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });

  it("a missing adapterType does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterType: undefined } }];
    const r = await admit(p, [await toBundle(drafts, p)]);
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });
});

describe("profile admission — round 3 (astra pack 39): one snapshot, precedence, leg obligations", () => {
  const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
  const FAILURE: Draft[] = [{ type: "execution_failed", t: 11, device: PRINTER }];

  it("39-A: popping a presented bundle right after the call started does not remove it from what is evaluated", async () => {
    const p = inspectedPageProfile();
    const pilotBundle = await toBundle(PILOT, p);
    const failureBundle = await toBundle(FAILURE, p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [pilotBundle.bundleHash, failureBundle.bundleHash]);
    const bundles = [pilotBundle, failureBundle];
    // Built by hand: admit() awaits internally before calling
    // profileAdmitsBundle, which would leave nothing to pop before the
    // snapshot is taken.
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    bundles.pop(); // the old code evaluated only the surviving pilot bundle, and admitted
    const r = await pending;
    expect(r.decision).not.toBe("admit");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("39-A: mutating an already-presented bundle's events right after the call started changes nothing", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const bundles = [bundle];
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [bundle.bundleHash]);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    const events = bundle.events as unknown as EvidenceEvent[];
    (events[2] as unknown as { payload: Record<string, unknown> }).payload.passed = false;
    events.push({
      id: "junk-event",
      type: "camera_snapshot",
      timestamp: at(999),
      source: { deviceId: CAMERA, deviceType: "camera", kernelId: KERNEL },
      payload: {},
      hash: "sha256:" + "9".repeat(64),
    } as unknown as EvidenceEvent);
    const r = await pending;
    expect(r.decision).toBe("admit"); // exactly as without the mutation
  });

  it("39-B: the profile's minSamples changed during suspension does not weaken the committed threshold", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const bundle = await toBundle(PILOT, p); // one qualifying observation
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [bundle.bundleHash]);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    p.measurement.sampling.minSamples = 1; // would satisfy the weakened threshold
    const r = await pending;
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("39-B: the profile's onContradiction changed during suspension does not soften the committed policy", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "reject";
    const bundle = await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [bundle.bundleHash]);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    p.onContradiction = "hold"; // would turn the reject into a hold
    const r = await pending;
    expect(r.decision).toBe("reject");
  });

  it("39-B: profileGoverns's snapshot is frozen", () => {
    const p = inspectedPageProfile();
    const digest = computeMeasurementProfileDigest(p);
    const governance = profileGoverns(digest, p);
    expect(governance.governs).toBe(true);
    expect(Object.isFrozen(governance.profile)).toBe(true);
  });

  it("the subject changed during suspension does not change which job is evaluated", async () => {
    const p = inspectedPageProfile();
    const mutableSubject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const bundle = await toBundle(PILOT, p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(mutableSubject, [bundle.bundleHash]);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: mutableSubject,
      bundles: [bundle],
      pinnedBundleSetDigest,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    mutableSubject.jobId = "job-other";
    const r = await pending;
    const baseline = await admit(p, [bundle]);
    expect(r).toEqual(baseline);
    expect(r.decision).toBe("admit");
  });

  it("39-C: a mismatch with a fabricated event among what was presented rejects on the mismatch first, then the fabrication", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const drafts2 = PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d));
    const b2 = await toBundle(drafts2, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch", "simulated-evidence"]);
  });

  it("39-D: the leg's obligation — a sampleId that truly commits the capture admits", async () => {
    const p = inspectedPageProfile();
    const captureHash = "sha256:" + "d".repeat(64);
    const drafts = [
      ...PILOT.slice(0, 2),
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true, captureHash }, observation: { sampleId: captureHash } },
    ];
    // The obligation pattern an oracle verifier must meet: check that the
    // claimed sampleId actually commits the raw capture, not just that it is
    // shaped like one. A leg of () => true proves nothing.
    const capturesMatch = (_id: string, obs: EvidenceEvent): boolean => {
      const payload = obs.payload as Record<string, unknown>;
      const observation = payload[PROFILE_OBSERVATION_FIELD] as { sampleId: string };
      return observation.sampleId === payload.captureHash;
    };
    const r = await admit(p, [await toBundle(drafts, p)], { verifyPrimitiveInstance: capturesMatch });
    expect(r.decision).toBe("admit");
  });

  it("39-E: the leg's obligation — a record attached to another capture is excluded", async () => {
    const p = inspectedPageProfile();
    const claimedSampleId = "sha256:" + "d".repeat(64);
    const actualCaptureHash = "sha256:" + "e".repeat(64); // a different capture
    const drafts = [
      ...PILOT.slice(0, 2),
      {
        type: "cv_inspection_result",
        t: 20,
        device: CAMERA,
        payload: { passed: true, captureHash: actualCaptureHash },
        observation: { sampleId: claimedSampleId },
      },
    ];
    const capturesMatch = (_id: string, obs: EvidenceEvent): boolean => {
      const payload = obs.payload as Record<string, unknown>;
      const observation = payload[PROFILE_OBSERVATION_FIELD] as { sampleId: string };
      return observation.sampleId === payload.captureHash;
    };
    const r = await admit(p, [await toBundle(drafts, p)], { verifyPrimitiveInstance: capturesMatch });
    expect(r.decision).toBe("reject");
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });
});

describe("profile admission — the LO-SE-3 failure-bearing negative is refused by outcome policy (astra pack 40, finding 40-9)", () => {
  const FIXTURE = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/lose3-execution-log-bundle.json", import.meta.url)), "utf8"),
  ) as {
    kernelPublicKeyHex: string;
    bundle: AdmissionBundle;
    negatives: { failureBearingBundle: AdmissionBundle };
  };
  const fixtureKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(FIXTURE.kernelPublicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  const verifyFixture = (b: AdmissionBundle) =>
    verify(null, signingPreimage(b.bundleHash), fixtureKey, Buffer.from((b.kernelSignature as { value: string }).value, "hex"));
  const lose3Subject = { jobId: "job-lose3-consumer-run-001", kernelId: "kernel-hp-3301-golden" };

  async function run(bundle: AdmissionBundle) {
    const p = deviceReportedProfile();
    p.device = { ...p.device, deviceId: "dev-hp-3301-0D253A" };
    return profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: lose3Subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(lose3Subject, [bundle.bundleHash]),
      verifyBundleSignature: verifyFixture,
      verifyPrimitiveInstance: () => true,
    });
  }

  it("the failure-bearing bundle authenticates and binds, then is rejected as a completion-and-failure contradiction", async () => {
    const r = await run(FIXTURE.negatives.failureBearingBundle);
    expect(codes(r)).not.toContain("unauthenticated-bundle");
    expect(codes(r)).not.toContain("unbound-bundle");
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
    expect(r.reasons.find((x) => x.code === "contradictory-evidence")!.detail).toContain("completion-and-failure");
  });

  it("the positive bundle raises no contradiction; it is refused only because it carries no profile observation", async () => {
    const r = await run(FIXTURE.bundle);
    expect(codes(r)).not.toContain("unauthenticated-bundle");
    expect(codes(r)).not.toContain("unbound-bundle");
    expect(codes(r)).not.toContain("contradictory-evidence");
    expect(r.decision).not.toBe("admit");
  });
});

// ── astra r3 (pack 74, gpt-5.6-sol) ──
describe("profile admission — astra r3 (pack 74): the committed profile is the evaluated profile", () => {
  /** The pilot profile, JSON-parsed, with measurement.sampling holding only a "__proto__" member. */
  function protoProfile(minSamples: number): MeasurementProfileV1 {
    const json = JSON.stringify(inspectedPageProfile()).replace('"sampling":{"minSamples":1}', `"sampling":{"__proto__":{"minSamples":${minSamples}}}`);
    expect(json).toContain('"__proto__"');
    return JSON.parse(json) as MeasurementProfileV1;
  }
  /** The digest a copy that dropped the __proto__ member would carry: sampling hashed as {}. */
  function digestOfStripped(p: MeasurementProfileV1): string {
    const stripped = JSON.parse(JSON.stringify(p).replace(/"sampling":\{"__proto__":\{[^}]*\}\}/, '"sampling":{}'));
    return "0x" + createHash("sha256").update(canonicalize({ domain: "PCC:measurement-profile:v1", profile: stripped })).digest("hex");
  }

  it("a JSON __proto__ member cannot carry a weaker minSamples under a stricter commitment: reject, never admit", async () => {
    const committed = protoProfile(2);
    const presented = protoProfile(1);
    const committedDigest = digestOfStripped(committed);
    expect(digestOfStripped(presented)).toBe(committedDigest); // the bytes a stripping copy would hash are identical
    // One qualifying sample, its observation naming the committed digest (the commitment asked for two).
    const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), profileDigest: committedDigest } }));
    const bundles = [await toBundle(drafts, inspectedPageProfile())];
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    // Called directly: the admit() helper computes a default digest from the presented profile,
    // which now refuses a __proto__ member outright (computeMeasurementProfileDigest throws).
    expect(() => computeMeasurementProfileDigest(presented)).toThrow(/__proto__/);
    const r = await profileAdmitsBundle({
      profile: presented,
      committedDigest,
      subject,
      bundles,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("profile-invalid");
    expect(r.reasons.map((x) => x.detail).join(" ")).toMatch(/__proto__/);
  });

  it("a throwing getter on a top-level input field resolves to reject; the call never throws", async () => {
    const p = inspectedPageProfile();
    const bundles = [await toBundle(PILOT, p)];
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    } as Record<string, unknown>;
    Object.defineProperty(input, "pinnedBundleSetDigest", {
      enumerable: true,
      get() {
        throw Object.create(null);
      },
    });
    const r = await profileAdmitsBundle(input as unknown as ProfileAdmissionInput);
    expect(r.decision).toBe("reject");
  });
});

// ── astra r4 (pack 125, gpt-5.6-sol): the snapshot must not inherit mutable, unhashed values ──
describe("profile admission — astra r4 (pack 125): inherited values never reach the decision", () => {
  it("a polluted Object.prototype cannot supply minSamples, before or after the first await", async () => {
    const p = inspectedPageProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples; // the profile's own term is gone
    const proto = Object.prototype as Record<string, unknown>;
    proto.minSamples = 2; // what validation would read through inheritance
    try {
      let committedDigest: string;
      try {
        committedDigest = computeMeasurementProfileDigest(p as unknown as MeasurementProfileV1);
      } catch {
        return; // refused: no commitment can be computed, which closes the bypass at its source
      }
      // An enumerable getter read during the copy schedules the prototype's change for after the first await.
      const presented = { ...p };
      Object.defineProperty(presented, "onMissingData", {
        enumerable: true,
        get() {
          queueMicrotask(() => { proto.minSamples = 1; });
          return "reject";
        },
      });
      const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), profileDigest: committedDigest } }));
      const bundles = [await toBundle(drafts, inspectedPageProfile())];
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: presented as unknown as MeasurementProfileV1,
        committedDigest,
        subject,
        bundles,
        pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
        verifyBundleSignature: verifySignature,
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).not.toBe("admit");
    } finally {
      delete proto.minSamples;
    }
  });

  it("an inherited getter that throws during validation resolves to reject; the call never throws", async () => {
    const p = inspectedPageProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples;
    Object.defineProperty(Object.prototype, "minSamples", {
      configurable: true,
      get() {
        throw Object.create(null);
      },
    });
    try {
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: p as unknown as MeasurementProfileV1,
        committedDigest: "0x" + "0".repeat(64),
        subject,
        bundles: [],
        pinnedBundleSetDigest: "sha256:" + "0".repeat(64),
        verifyBundleSignature: verifySignature,
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).toBe("reject");
    } finally {
      delete (Object.prototype as Record<string, unknown>).minSamples;
    }
  });
});

// ── astra r5 (pack 127, gpt-5.6-sol): no code supplied with the data runs during admission ──
describe("profile admission — astra r5 (pack 127): a data getter cannot change inherited behavior mid-call", () => {
  it("a getter scheduling an Array.prototype.includes swap cannot admit an uncommitted primitive", async () => {
    const committed = inspectedPageProfile(); // commits capture.photo_nonced only
    const committedDigest = computeMeasurementProfileDigest(committed);
    const original = Array.prototype.includes;
    const presented = { ...committed } as Record<string, unknown>;
    Object.defineProperty(presented, "onMissingData", {
      enumerable: true,
      get() {
        queueMicrotask(() => {
          // after the first await: every includes() answers yes
          Array.prototype.includes = function () { return true; } as typeof Array.prototype.includes;
        });
        return "reject";
      },
    });
    try {
      // the camera's observation names a primitive the profile never committed
      const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), primitiveId: "artifact.hash" } }));
      const bundles = [await toBundle(drafts, committed)];
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: presented as unknown as MeasurementProfileV1,
        committedDigest,
        subject,
        bundles,
        pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
        verifyBundleSignature: verifySignature,
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).not.toBe("admit");
    } finally {
      Array.prototype.includes = original;
    }
  });
});

describe("profile admission — astra r5 (pack 127): no data-supplied code, and own membership checks", () => {
  it("a proxy anywhere in the data is refused before any trap runs", async () => {
    const p = inspectedPageProfile();
    let trapped = 0;
    const proxied = new Proxy({ ...p }, { get: (t, k) => { trapped++; return Reflect.get(t, k); }, ownKeys: (t) => { trapped++; return Reflect.ownKeys(t); } });
    const r = await admit(p, [await toBundle(PILOT, p)], { profile: proxied as unknown as MeasurementProfileV1 });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(trapped).toBe(0);
  });

  it("an accessor on the input object itself is refused, and its getter never runs", async () => {
    const p = inspectedPageProfile();
    const bundles = [await toBundle(PILOT, p)];
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    let ran = false;
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
    } as Record<string, unknown>;
    Object.defineProperty(input, "bundles", { enumerable: true, get() { ran = true; return bundles; } });
    const r = await profileAdmitsBundle(input as unknown as ProfileAdmissionInput);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(ran).toBe(false);
  });

  it("membership in committed lists does not go through Array.prototype.includes", async () => {
    const p = inspectedPageProfile();
    const committedDigest = computeMeasurementProfileDigest(p);
    const original = Array.prototype.includes;
    const bundles = [await toBundle(PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), primitiveId: "artifact.hash" } })), p)];
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const pin = await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash));
    // A process-level change that admission's own membership checks must not consult.
    Array.prototype.includes = function () { return true; } as typeof Array.prototype.includes;
    try {
      const r = await profileAdmitsBundle({ profile: p, committedDigest, subject, bundles, pinnedBundleSetDigest: pin, verifyBundleSignature: verifySignature, verifyPrimitiveInstance: () => true });
      expect(r.decision).not.toBe("admit");
    } finally {
      Array.prototype.includes = original;
    }
  });
});

// ── astra r6 (pack 154, gpt-5.6-sol): an inherited array index is input-supplied code too ──
describe("profile admission — astra r6 (pack 154): sparse arrays with a custom prototype", () => {
  it("an inherited numeric getter on the bundles array never runs", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    let ran = false;
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, "0", { get() { ran = true; return bundle; } });
    const bundles = [] as unknown as AdmissionBundle[];
    Object.setPrototypeOf(bundles, proto);
    (bundles as unknown as { length: number }).length = 1;
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const r = await profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    });
    expect(ran).toBe(false);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
  });

  it("an inherited getter on a bundle object's custom prototype never runs, and what it would serve is absent from the copy", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    let ran = false;
    const { events, ...rest } = bundle as unknown as Record<string, unknown>;
    const proto = Object.create(Object.prototype, { events: { get() { ran = true; return events; } } });
    const crafted = Object.assign(Object.create(proto), rest) as unknown as AdmissionBundle;
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const r = await profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [crafted],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    });
    expect(ran).toBe(false);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["unbound-bundle"]);
  });
});

// ── the dashboard's browser build (CI run 37090398492): no static node:util in admission ──
describe("profile admission: the proxy check is loaded at runtime, and fails closed without one", () => {
  it("profile-admission.ts has no static node:util import (vite has no node:util)", () => {
    const source = readFileSync(fileURLToPath(new URL("../evidence/profile-admission.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']node:util["']|require\(\s*["']node:util["']\s*\)/);
  });

  it("a proxy input is still refused before any trap runs", async () => {
    let trapped = 0;
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const target = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const input = new Proxy(target, { get: (t, k, r) => (trapped++, Reflect.get(t, k, r)), getOwnPropertyDescriptor: (t, k) => (trapped++, Reflect.getOwnPropertyDescriptor(t, k)) });
    const r = await profileAdmitsBundle(input as ProfileAdmissionInput);
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(trapped).toBe(0);
  });

  it("without a trap-free proxy check (a browser, or Node before 20.16), admission rejects as input-unreadable", async () => {
    // Every input is built with the check present; only admission runs without it.
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    expect(codes(await profileAdmitsBundle(input))).not.toContain("input-unreadable");
    // No trap-free proxy check, as in the dashboard's browser build: node:util offers no isProxy there.
    vi.resetModules();
    vi.doMock("node:util", () => ({ types: {} }));
    try {
      const fresh = await import("../evidence/profile-admission.js");
      const r = await fresh.profileAdmitsBundle(input);
      expect(r.decision).toBe("reject");
      expect(codes(r)).toEqual(["input-unreadable"]);
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });
});

// ── astra pack 187 (#519): what a caller receives through the promise, and through every promise derived from it ──
/**
 * Native `then`, `catch` and `finally` build the promise they return with
 * SpeciesConstructor(promise, %Promise%), that is
 * `promise.constructor[Symbol.species]`. #363 round 9 gave each returned
 * promise its own `constructor` (the Promise captured at load) and `then`, but
 * the global Promise's species is a configurable accessor: code running after
 * load can replace it with a constructor whose "promise" is a forged thenable,
 * and `await profileAdmitsBundle(signatureFails).then((x) => x)` receives the
 * forgery. Checked with it: `.catch` and `.finally` looked up on
 * Promise.prototype, and the promise `.then` returned (not pinned) awaited
 * after Promise.prototype.then and .constructor are replaced.
 *
 * Every input and clean value is built before a change; each change is undone
 * in `finally`. The test's own awaits never run on a promise a live change can
 * reach (see `deliveredUnder`).
 */
describe("profile admission — astra pack 187: .then, .catch and .finally deliver what admission decided", () => {
  const FORGED_ADMIT = { decision: "admit", admits: true, reached: "inspected_output", qualifyingSamples: 1, reasons: [] };
  const FORGED_DIGEST = "sha256:" + "f".repeat(64);
  const SUBJECT: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
  const SET = ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)];

  /** astra's `signatureFails`: a well-formed input, pinned to its own bundle, whose signature leg answers false. */
  async function signatureFails(): Promise<ProfileAdmissionInput> {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    return {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: SUBJECT,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(SUBJECT, [bundle.bundleHash]),
      verifyBundleSignature: () => false,
      verifyPrimitiveInstance: () => true,
    };
  }

  /** astra's recipe: a constructor that calls its executor with two no-op functions and returns a thenable resolving with `forged`. */
  function forgingSpecies(forged: unknown) {
    return function Forged(executor: (resolve: () => void, reject: () => void) => void) {
      executor(
        () => undefined,
        () => undefined,
      );
      return {
        then(resolve: (value: unknown) => void) {
          resolve(forged);
        },
      };
    };
  }

  /** Replace Promise[Symbol.species] (a configurable accessor on the global Promise), as code running after load can. */
  function speciesReplaced(species: unknown): () => () => void {
    return () => {
      const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
      Object.defineProperty(Promise, Symbol.species, { value: species, configurable: true });
      return () => void Object.defineProperty(Promise, Symbol.species, original);
    };
  }

  /** Replace Promise.prototype[name] with a method answering a thenable that resolves with `forged`. `this` still gets a handler, so nothing is left unhandled. */
  function methodReplaced(name: "catch" | "finally", forged: unknown): () => () => void {
    return () => {
      const original = Object.getOwnPropertyDescriptor(Promise.prototype, name)!;
      const thenBefore = Promise.prototype.then;
      Object.defineProperty(Promise.prototype, name, {
        ...original,
        value: function (this: Promise<unknown>) {
          thenBefore.call(this, undefined, () => undefined);
          return {
            then(resolve: (value: unknown) => void) {
              resolve(forged);
            },
          };
        },
      });
      return () => void Object.defineProperty(Promise.prototype, name, original);
    };
  }

  /**
   * What `deliver` hands its caller while `change` is in place ("threw" for a
   * rejection). Only for changes that leave Promise.prototype.then and
   * .constructor alone: this helper's own promise is awaited while the change
   * is live, and `await` reads both (the then-and-constructor test awaits
   * inline instead).
   */
  async function deliveredUnder(change: () => () => void, deliver: () => Promise<unknown>): Promise<unknown> {
    const undo = change();
    try {
      return await deliver();
    } catch {
      return "threw";
    } finally {
      undo();
    }
  }

  const unchanged = () => () => undefined;

  /** Every way a caller consumes the promise, each USING the promise `.then`, `.catch` or `.finally` returns. */
  const SHAPES: Array<[string, (p: Promise<unknown>) => Promise<unknown>]> = [
    ["p.then((x) => x)", (p) => p.then((x) => x)],
    ["p.then((x) => x).then((y) => y)", (p) => p.then((x) => x).then((y) => y)],
    ['p.then(undefined, () => "caught")', (p) => p.then(undefined, () => "caught")],
    ['p.catch(() => "caught")', (p) => p.catch(() => "caught")],
    ["p.finally(() => undefined)", (p) => p.finally(() => undefined)],
  ];

  /** Each shape whose value under `change` differs from its clean value, as "shape: clean -> delivered". `make` runs under the change too. */
  async function forgedShapes(change: () => () => void, make: () => Promise<unknown>): Promise<string[]> {
    const out: string[] = [];
    for (const [name, consume] of SHAPES) {
      const clean = await deliveredUnder(unchanged, () => consume(make()));
      const delivered = await deliveredUnder(change, () => consume(make()));
      if (JSON.stringify(delivered) !== JSON.stringify(clean)) out.push(`${name}: ${JSON.stringify(clean)} -> ${JSON.stringify(delivered)}`);
    }
    return out;
  }

  /** "label: expected -> delivered" for each pair that differs, so one failure shows every case. */
  function mismatches(pairs: Array<[string, unknown, unknown]>): string[] {
    const out: string[] = [];
    for (const [label, delivered, expected] of pairs) {
      if (JSON.stringify(delivered) !== JSON.stringify(expected)) out.push(`${label}: ${JSON.stringify(expected)} -> ${JSON.stringify(delivered)}`);
    }
    return out;
  }

  it("astra's recipe: with Promise[Symbol.species] replaced, await profileAdmitsBundle(signatureFails).then((x) => x) is still the rejection", async () => {
    const made = await signatureFails();
    const clean = await profileAdmitsBundle(made);
    expect(codes(clean)).toEqual(["unauthenticated-bundle"]);
    const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
    Object.defineProperty(Promise, Symbol.species, { value: forgingSpecies(FORGED_ADMIT), configurable: true });
    let delivered: unknown;
    try {
      delivered = await profileAdmitsBundle(made).then((x) => x);
    } finally {
      Object.defineProperty(Promise, Symbol.species, original);
    }
    expect(delivered).toEqual(clean);
  });

  it("the replaced species, through every shape: admission's result is never forged", async () => {
    const made = await signatureFails();
    expect(await forgedShapes(speciesReplaced(forgingSpecies(FORGED_ADMIT)), () => profileAdmitsBundle(made))).toEqual([]);
  });

  it("the replaced species, through every shape: a chained digest is the digest", async () => {
    expect(await forgedShapes(speciesReplaced(forgingSpecies(FORGED_DIGEST)), () => computeBundleSetDigest(SUBJECT, SET))).toEqual([]);
  });

  it("the replaced species, through every shape: a rejected digest (the empty set) is never turned into a value", async () => {
    expect(await forgedShapes(speciesReplaced(forgingSpecies(FORGED_DIGEST)), () => computeBundleSetDigest(SUBJECT, []))).toEqual([]);
  });

  it("the replaced species, through every shape: fulfillsWithTrue's promise (util/primordials.ts) delivers false as false", async () => {
    expect(await forgedShapes(speciesReplaced(forgingSpecies(true)), () => fulfillsWithTrue(Promise.resolve(false)) as Promise<boolean>)).toEqual([]);
  });

  it("Promise.prototype.catch replaced after load: p.catch(...) still delivers admission's rejection, the digest, and a digest's rejection", async () => {
    const made = await signatureFails();
    const clean = await profileAdmitsBundle(made);
    const digest = await computeBundleSetDigest(SUBJECT, SET);
    expect(
      mismatches([
        ["admission", await deliveredUnder(methodReplaced("catch", FORGED_ADMIT), () => profileAdmitsBundle(made).catch(() => "caught")), clean],
        ["digest", await deliveredUnder(methodReplaced("catch", FORGED_DIGEST), () => computeBundleSetDigest(SUBJECT, SET).catch(() => "caught")), digest],
        ["rejected digest", await deliveredUnder(methodReplaced("catch", FORGED_DIGEST), () => computeBundleSetDigest(SUBJECT, []).catch(() => "caught")), "caught"],
      ]),
    ).toEqual([]);
  });

  it("Promise.prototype.finally replaced after load: p.finally(...) still delivers admission's rejection, the digest, and a digest's rejection", async () => {
    const made = await signatureFails();
    const clean = await profileAdmitsBundle(made);
    const digest = await computeBundleSetDigest(SUBJECT, SET);
    expect(
      mismatches([
        ["admission", await deliveredUnder(methodReplaced("finally", FORGED_ADMIT), () => profileAdmitsBundle(made).finally(() => undefined)), clean],
        ["digest", await deliveredUnder(methodReplaced("finally", FORGED_DIGEST), () => computeBundleSetDigest(SUBJECT, SET).finally(() => undefined)), digest],
        ["rejected digest", await deliveredUnder(methodReplaced("finally", FORGED_DIGEST), () => computeBundleSetDigest(SUBJECT, []).finally(() => undefined)), "threw"],
      ]),
    ).toEqual([]);
  });

  it("Promise.prototype.then and .constructor replaced after load: the promise p.then(...) returns, awaited or chained, still delivers the rejection", async () => {
    const made = await signatureFails();
    const clean = await profileAdmitsBundle(made);
    // Both taken before any change: `derived` is awaited under it, and `chained` gets its second link under it.
    const derived = profileAdmitsBundle(made).then((x) => x);
    const chained = profileAdmitsBundle(made).then((x) => x);
    const hasOwn = Object.prototype.hasOwnProperty;
    const forge = (v: unknown) => (typeof v === "object" && v !== null && hasOwn.call(v, "decision") ? FORGED_ADMIT : v);
    const thenBefore = Promise.prototype.then;
    const then = Object.getOwnPropertyDescriptor(Promise.prototype, "then")!;
    const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")!;
    Object.defineProperty(Promise.prototype, "constructor", { ...constructor, value: function NotPromise() {} });
    Object.defineProperty(Promise.prototype, "then", {
      ...then,
      value: function (this: Promise<unknown>, f?: unknown, r?: unknown) {
        const onFulfilled = typeof f === "function" ? (v: unknown) => (f as (x: unknown) => unknown)(forge(v)) : f;
        return thenBefore.call(this, onFulfilled as (x: unknown) => unknown, r as (e: unknown) => unknown);
      },
    });
    let awaited: unknown;
    let secondLink: unknown;
    try {
      awaited = await derived;
      secondLink = await chained.then((y) => y);
    } finally {
      Object.defineProperty(Promise.prototype, "then", then);
      Object.defineProperty(Promise.prototype, "constructor", constructor);
    }
    expect(
      mismatches([
        ["await p.then((x) => x)", awaited, clean],
        ["await p.then((x) => x).then((y) => y), second link under the change", secondLink, clean],
      ]),
    ).toEqual([]);
  });

  it("a caller holding any promise these functions return cannot re-point the species every other caller's .then uses", async () => {
    const made = await signatureFails();
    const clean = await profileAdmitsBundle(made);
    const held = computeBundleSetDigest(SUBJECT, SET);
    await held;
    const holder = held.constructor as unknown as object;
    const before = Object.getOwnPropertyDescriptor(holder, Symbol.species);
    let repointed = true;
    let delivered: unknown;
    try {
      try {
        Object.defineProperty(holder, Symbol.species, { value: forgingSpecies(FORGED_ADMIT), configurable: true });
      } catch {
        repointed = false;
      }
      delivered = await profileAdmitsBundle(made).then((x) => x);
    } finally {
      if (before !== undefined) {
        try {
          Object.defineProperty(holder, Symbol.species, before);
        } catch {
          // a frozen holder: nothing was changed
        }
      }
    }
    expect(delivered).toEqual(clean);
    expect(repointed).toBe(false);
  });

  it("admission's own await of binding's answer looks nothing up on it: binding's own resolution is the only `then` lookup", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: SUBJECT,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(SUBJECT, [bundle.bundleHash]),
      verifyBundleSignature: verifySignature,
      verifyPrimitiveInstance: () => true,
    };
    const hasOwn = Object.prototype.hasOwnProperty;
    // Lookups of `then` on binding's answer ({ ok, events }), counted per answer object; the getter answers
    // undefined, as an absent `then` would, so nothing else changes.
    const lookups = new Map<object, number>();
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get(this: unknown) {
        if (typeof this === "object" && this !== null && hasOwn.call(this, "ok") && hasOwn.call(this, "events")) {
          lookups.set(this, (lookups.get(this) ?? 0) + 1);
        }
        return undefined;
      },
    });
    let r: ProfileAdmissionResult | undefined;
    try {
      r = await profileAdmitsBundle(input);
    } finally {
      delete (Object.prototype as Record<string, unknown>).then;
    }
    expect(r?.decision).toBe("admit");
    // LO-EV-9's binding (#341) answers with a frozen null-prototype object, so no inherited `then` is ever
    // looked up on its answer: not when its own promise resolves, and not by any await of it, admission's
    // included. A polluted Object.prototype.then cannot reach admission through binding's answer.
    expect([...lookups.values()]).toEqual([]);
    const answer = await verifyEvidenceSubjectBinding({ bundleHash: bundle.bundleHash, events: bundle.events, subject: SUBJECT });
    expect(Object.getPrototypeOf(answer), "binding's answer has no prototype to inherit `then` from").toBeNull();
    expect(Object.isFrozen(answer)).toBe(true);
  });

  it("awaitedHere (util/primordials.ts): awaiting it looks nothing up on the value; awaiting an ownPromise looks `then` up once", async () => {
    const value = { k: 1 };
    // Both settled before the lookup is counted: Promise.resolve looks `then` up on the value itself.
    const here = awaitedHere(Promise.resolve(value));
    const handedOut = ownPromise(Promise.resolve(value));
    await Promise.resolve();
    let lookups = 0;
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get(this: unknown) {
        if (this === value) lookups++;
        return undefined;
      },
    });
    let first: unknown;
    let afterFirst = -1;
    let second: unknown;
    try {
      first = await here;
      afterFirst = lookups;
      second = await handedOut;
    } finally {
      delete (Object.prototype as Record<string, unknown>).then;
    }
    expect(first).toBe(value);
    expect(afterFirst).toBe(0);
    // Why only a primitive or a null-prototype object is handed out through ownPromise.
    expect(second).toBe(value);
    expect(lookups).toBe(1);
  });
});
