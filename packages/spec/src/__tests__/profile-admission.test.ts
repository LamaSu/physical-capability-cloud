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

import { describe, it, expect } from "vitest";

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
    let reads = 0;
    Object.defineProperty(payload, "passed", { get: () => (reads++, false), enumerable: true, configurable: true });
    const probe = await verifyEvidenceSubjectBinding({
      bundleHash: b.bundleHash,
      events: b.events,
      subject: { jobId: JOB, kernelId: KERNEL },
    });
    expect(probe.ok).toBe(true);
    const readsDuringBinding = reads;
    // Now: truthful (false, as hashed) for binding's reads, then true on every later read.
    reads = 0;
    Object.defineProperty(payload, "passed", {
      get: () => reads++ >= readsDuringBinding,
      enumerable: true,
      configurable: true,
    });
    const r = await admit(p, [b]);
    expect(codes(r)).not.toContain("unbound-bundle");
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
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
