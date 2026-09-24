/**
 * profileAdmitsBundle (LO-SE-2): does authenticated, bound evidence satisfy the
 * committed MeasurementProfile? Bundles here are real: production
 * hashEvent/hashBundle, an Ed25519 key signing signingPreimage(bundleHash), and
 * events that commit the job and kernel so LO-EV-9 binding genuinely passes.
 */
import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  profileAdmitsBundle,
  type AdmissionBundle,
  type ProfileAdmissionInput,
} from "../evidence/profile-admission.js";
import { computeMeasurementProfileDigest, type MeasurementProfileV1 } from "../evidence/measurement-profile.js";
import { signingPreimage } from "../evidence/signing-preimage.js";
import { hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";

const JOB = "job-admission-1";
const KERNEL = "kernel-admission-1";
const PRINTER = "dev-printer";
const CAMERA = "dev-camera";
const CAMERA_VERSION = "PhotoCameraAdapter-1.0.0";
const PRINTER_VERSION = "IppAdapter-1.0.0";

const key = generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

interface Draft {
  type: string;
  t: number;
  device: string;
  version?: string;
  payload?: Record<string, unknown>;
  simulated?: boolean;
  jobId?: string;
  kernelId?: string;
}

async function toEvent(d: Draft): Promise<EvidenceEvent> {
  const source = {
    deviceId: d.device,
    deviceType: d.device === CAMERA ? "camera" : "machine",
    kernelId: d.kernelId ?? KERNEL,
    ...(d.version ? { firmwareVersion: d.version } : {}),
    ...(d.simulated ? { simulated: true } : {}),
  };
  const payload = { jobId: d.jobId ?? JOB, ...(d.payload ?? {}) };
  const unsigned = { type: d.type, timestamp: at(d.t), source, payload };
  const hash = await hashEvent(unsigned as unknown as Omit<EvidenceEvent, "hash" | "id">);
  return { ...unsigned, id: `${d.type}-${d.t}`, hash } as unknown as EvidenceEvent;
}

async function toBundle(drafts: Draft[]): Promise<AdmissionBundle> {
  const events = await Promise.all(drafts.map(toEvent));
  const bundleHash = await hashBundle(events);
  const value = sign(null, signingPreimage(bundleHash), key.privateKey).toString("hex");
  return { bundleHash, events, kernelSignature: { signer: "0x1111111111111111111111111111111111111111", algorithm: "ed25519", value } };
}

const verifySignature = (b: AdmissionBundle) =>
  verify(null, signingPreimage(b.bundleHash), key.publicKey, Buffer.from((b.kernelSignature as { value: string }).value, "hex"));

/** The pilot: the printer runs the job; a separate camera inspects the page after completion. */
const PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER, version: PRINTER_VERSION },
  { type: "execution_completed", t: 10, device: PRINTER, version: PRINTER_VERSION },
  { type: "cv_inspection_result", t: 20, device: CAMERA, version: CAMERA_VERSION, payload: { passed: true } },
];

function inspectedPageProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/test/inspected-page/v1",
    outcome: {
      capabilityType: "document-printing",
      statement: "The page was printed and a separate camera inspected it.",
      objectIdentity: { kind: "documentHash", value: "sha256:" + "b".repeat(64) },
    },
    device: {
      deviceId: CAMERA,
      kind: "camera",
      adapterType: "photo",
      permittedAdapterVersions: [CAMERA_VERSION],
      permittedFirmwareVersions: [CAMERA_VERSION],
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

/** A device_reported profile over the printer itself. */
function deviceReportedProfile(): MeasurementProfileV1 {
  const p = inspectedPageProfile();
  p.device = { ...p.device, deviceId: PRINTER, kind: "machine", adapterType: "ipp", permittedAdapterVersions: [PRINTER_VERSION], permittedFirmwareVersions: [PRINTER_VERSION] };
  p.capture = { ...p.capture, startCondition: "execution_started" };
  p.interpretation = { ...p.interpretation, acceptanceLevel: "device_reported" };
  return p;
}

async function admit(profile: MeasurementProfileV1, bundles: AdmissionBundle[], over: Partial<ProfileAdmissionInput> = {}) {
  return profileAdmitsBundle({
    profile,
    committedDigest: computeMeasurementProfileDigest(profile),
    subject: { jobId: JOB, kernelId: KERNEL },
    bundles,
    verifyBundleSignature: verifySignature,
    ...over,
  });
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("profile admission — admits evidence that satisfies the committed profile", () => {
  it("admits the pilot: printer completes, a separate camera inspects after completion", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT)]);
    expect(r).toMatchObject({ decision: "admit", admits: true, reached: "inspected_output", qualifyingObservations: 1, reasons: [] });
  });

  it("admits a device_reported profile on the printer's own completion", async () => {
    const r = await admit(deviceReportedProfile(), [await toBundle(PILOT)]);
    expect(r.decision).toBe("admit");
  });

  it("judges an inspection against the executing devices across several bundles of the same job", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT.slice(0, 2)), await toBundle(PILOT.slice(2))]);
    expect(r.decision).toBe("admit");
  });
});

describe("profile admission — the committed profile governs (section 3: mutation after acceptance)", () => {
  it("a profile changed after acceptance is rejected", async () => {
    const accepted = inspectedPageProfile();
    const loosened = inspectedPageProfile();
    loosened.interpretation.acceptanceLevel = "device_reported";
    const r = await admit(loosened, [await toBundle(PILOT)], { committedDigest: computeMeasurementProfileDigest(accepted) });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["digest-mismatch"]);
  });

  it("a committed digest in the sha256: evidence-event family is rejected", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT)], { committedDigest: `sha256:${computeMeasurementProfileDigest(p).slice(2)}` });
    expect(codes(r)).toEqual(["digest-wrong-family"]);
  });
});

describe("profile admission — only authenticated, bound evidence counts (section 3: job A/B, node A/B)", () => {
  it("a bundle whose signature leg fails is rejected", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT)], { verifyBundleSignature: () => false });
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
  });

  it("a signature verifier that throws counts as a failed signature", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT)], {
      verifyBundleSignature: () => {
        throw new Error("registry unavailable");
      },
    });
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
  });

  it("evidence from job A cannot satisfy job B", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT.map((d) => ({ ...d, jobId: "job-other" })))]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("job-mismatch");
  });

  it("evidence from node A cannot be substituted for node B", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle(PILOT.map((d) => ({ ...d, kernelId: "kernel-other" })))]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("kernel-mismatch");
  });

  it("an event altered after hashing is rejected", async () => {
    const b = await toBundle(PILOT);
    (b.events[2] as { payload: Record<string, unknown> }).payload.passed = false;
    const r = await admit(inspectedPageProfile(), [b]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("event-hash-mismatch");
  });
});

describe("profile admission — simulated evidence cannot satisfy a non-simulated profile (section 3)", () => {
  it("a simulated source rejects the whole evidence set", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });

  it("a payload.mock event rejects too, even when a genuine inspection is present", async () => {
    const drafts = [...PILOT, { type: "execution_progress", t: 5, device: PRINTER, version: PRINTER_VERSION, payload: { mock: true } }];
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });
});

describe("profile admission — levels come from the evidence contract", () => {
  it("a device's report on its own output is not inspected_output", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: PRINTER, version: PRINTER_VERSION } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(r.reached).toBe("device_reported");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("printer_job_verified alone proves no level, not even device_reported (the R5 print-leg case)", async () => {
    const r = await admit(deviceReportedProfile(), [await toBundle([{ type: "printer_job_verified", t: 10, device: PRINTER, version: PRINTER_VERSION }])]);
    expect(r.reached).toBeNull();
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("level-not-reached follows onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2))]);
    expect(r.decision).toBe("hold");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });
});

describe("profile admission — missing measurements follow the committed policy (section 3)", () => {
  it("an inspection from a camera the profile does not name does not count", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: "dev-other-camera" } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 from other devices");
  });

  it("an observation from an unpermitted version does not count", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, version: "PhotoCameraAdapter-9.9.9" } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(r.reasons[0]!.detail).toContain("1 unpermitted version");
  });

  it("an observation with no version at all does not count", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, version: undefined } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("an inspection before the printer completed is outside the capture window", async () => {
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, t: 5 } : d));
    const r = await admit(inspectedPageProfile(), [await toBundle(drafts)]);
    expect(r.reasons[0]!.detail).toContain("1 outside the capture window");
  });

  it("fewer observations than minSamples is missing data", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, [await toBundle(PILOT)]);
    expect(r).toMatchObject({ decision: "reject", qualifyingObservations: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("missing measurements follow onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    p.onMissingData = "hold";
    expect((await admit(p, [await toBundle(PILOT)])).decision).toBe("hold");
  });

  it("no bundles at all is missing data", async () => {
    const r = await admit(inspectedPageProfile(), []);
    expect(codes(r)).toEqual(["no-bundles"]);
  });
});

describe("profile admission — failure and contradiction follow the committed policy (section 3)", () => {
  it("completion and execution_failed together is a contradiction", async () => {
    const r = await admit(inspectedPageProfile(), [
      await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER, version: PRINTER_VERSION }]),
    ]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["contradictory-evidence"]);
  });

  it("a contradiction follows onContradiction: hold", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    const r = await admit(p, [await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER, version: PRINTER_VERSION }])]);
    expect(r.decision).toBe("hold");
  });

  it("a reported device failure follows onDeviceFailure", async () => {
    const r = await admit(inspectedPageProfile(), [
      await toBundle([PILOT[0]!, { type: "execution_failed", t: 10, device: PRINTER, version: PRINTER_VERSION }]),
    ]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("device-failure");
  });

  it("a hold finding never outranks a reject finding", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    p.onMissingData = "reject";
    const r = await admit(p, [
      await toBundle([...PILOT.slice(0, 2), { type: "execution_failed", t: 11, device: PRINTER, version: PRINTER_VERSION }]),
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
  ];
  for (const [name, mutate, term] of cases) {
    it(`${name} → unverifiable-term`, async () => {
      const p = inspectedPageProfile();
      mutate(p);
      const r = await admit(p, [await toBundle(PILOT)]);
      expect(r.decision).toBe("reject");
      expect(codes(r)).toEqual(["unverifiable-term"]);
      expect(r.reasons[0]!.detail).toContain(term);
    });
  }
});

describe("profile admission — review #363 fixes (evidence #2777, probes P1-P3 inverted)", () => {
  const INSPECT = (payload: Record<string, unknown>, version = CAMERA_VERSION): Draft => ({
    type: "cv_inspection_result",
    t: 20,
    device: CAMERA,
    version,
    payload,
  });
  const PRINTED = PILOT.slice(0, 2);

  it("P1: the same signed bundle presented twice counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const b = await toBundle(PILOT);
    const r = await admit(p, [b, b]);
    expect(r).toMatchObject({ decision: "reject", qualifyingObservations: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("P1b: one event listed twice inside one signed bundle counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, [await toBundle([...PILOT, PILOT[2]!])]);
    expect(r).toMatchObject({ decision: "reject", qualifyingObservations: 1 });
  });

  it("P2: an inspection reporting passed:false is a failure, never a sample", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle([...PRINTED, INSPECT({ passed: false, antiSpoofScore: 0.1 })])]);
    expect(r).toMatchObject({ decision: "reject", qualifyingObservations: 0 });
    expect(codes(r)).toEqual(["contradictory-evidence", "missing-measurements"]);
    expect(r.reasons[1]!.detail).toContain("1 failed inspection(s)");
  });

  it("a failed inspection with no completion is a device failure", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle([PILOT[0]!, INSPECT({ passed: false })])]);
    expect(codes(r)).toContain("device-failure");
  });

  it("any non-true passed value is a negative verdict", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle([...PRINTED, INSPECT({ passed: "yes" })])]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("an inspection with no passed field claims no verdict and still counts", async () => {
    const r = await admit(inspectedPageProfile(), [await toBundle([...PRINTED, INSPECT({ score: 0.97 })])]);
    expect(r).toMatchObject({ decision: "admit", qualifyingObservations: 1 });
  });

  it("P3a/P3b: pin lists that share no string can never be satisfied, so the profile fails closed", async () => {
    const p = inspectedPageProfile();
    p.device.permittedFirmwareVersions = ["fw-4.0.1"];
    for (const version of [CAMERA_VERSION, "fw-4.0.1"]) {
      const r = await admit(p, [await toBundle([...PRINTED, INSPECT({ passed: true }, version)])]);
      expect(codes(r)).toEqual(["unverifiable-term"]);
      expect(r.reasons[0]!.detail).toContain("share no string");
    }
  });

  it("an observation counts only when its version is in BOTH pin lists", async () => {
    const p = inspectedPageProfile();
    p.device.permittedAdapterVersions = ["cam-A", "cam-B"];
    p.device.permittedFirmwareVersions = ["cam-B", "cam-C"];
    for (const [version, expected] of [["cam-A", "reject"], ["cam-C", "reject"], ["cam-B", "admit"]] as const) {
      const r = await admit(p, [await toBundle([...PRINTED, INSPECT({ passed: true }, version)])]);
      expect(r.decision).toBe(expected);
    }
  });
});
