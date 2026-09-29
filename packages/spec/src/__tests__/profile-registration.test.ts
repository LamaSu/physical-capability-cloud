/**
 * checkProfileRegistration — what the gateway's append-only profile
 * registration route (bus #2621) runs before inserting a row.
 */
import { describe, it, expect } from "vitest";

import { checkProfileRegistration } from "../evidence/profile-registration.js";
import { computeMeasurementProfileDigest, type MeasurementProfileV1 } from "../evidence/measurement-profile.js";

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
    device: {
      deviceId: CAMERA,
      kind: "camera",
      adapterType: "photo",
      permittedAdapterVersions: [VERSION],
      permittedFirmwareVersions: [VERSION],
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

const request = (profile: unknown, over: Partial<{ capabilityType: string; deviceId: string; claimedDigest: string }> = {}) => ({
  capabilityType: "document-printing",
  deviceId: CAMERA,
  profile,
  ...over,
});

const codes = (r: ReturnType<typeof checkProfileRegistration>) => (r.ok ? [] : r.problems.map((p) => p.code));

describe("profile registration — accepts a registrable profile", () => {
  it("disjoint adapter and firmware pins are registrable: each pin is checked against its own evidence field", () => {
    const p = cameraProfile();
    p.device.permittedFirmwareVersions = ["cam-fw-2.1.0"];
    expect(checkProfileRegistration(request(p)).ok).toBe(true);
  });

  it("returns the server-computed digest", () => {
    const p = cameraProfile();
    const r = checkProfileRegistration(request(p));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profileDigest).toBe(computeMeasurementProfileDigest(p));
  });

  it("accepts a client digest only when it equals the server's", () => {
    const p = cameraProfile();
    expect(checkProfileRegistration(request(p, { claimedDigest: computeMeasurementProfileDigest(p) })).ok).toBe(true);
  });
});

describe("profile registration — refuses what could never govern the device's evidence", () => {
  it("an invalid profile", () => {
    const p = { ...cameraProfile(), simulationProhibited: false };
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["profile-invalid"]);
  });

  it("a non-object never throws", () => {
    expect(codes(checkProfileRegistration(request("not a profile")))).toEqual(["profile-invalid"]);
    expect(codes(checkProfileRegistration(request(null)))).toEqual(["profile-invalid"]);
  });

  it("a profile naming another device than the row it would be stored under", () => {
    expect(codes(checkProfileRegistration(request(cameraProfile(), { deviceId: "dev-other" })))).toEqual(["device-mismatch"]);
  });

  it("a profile for another capability type", () => {
    expect(codes(checkProfileRegistration(request(cameraProfile(), { capabilityType: "cnc-milling" })))).toEqual([
      "capability-type-mismatch",
    ]);
  });

  it("a profile with a term admission cannot evaluate (refused now, not discovered at settlement)", () => {
    const p = cameraProfile();
    p.measurement.tolerance = { comparator: ">=", target: 0.9 };
    const r = checkProfileRegistration(request(p));
    expect(codes(r)).toEqual(["unverifiable-term"]);
  });

  it("a version pin written as a pattern (pins are exact strings)", () => {
    const p = cameraProfile();
    p.device.permittedFirmwareVersions = ["*-unpinned-pilot"];
    const r = checkProfileRegistration(request(p));
    expect(codes(r)).toEqual(["unverifiable-term"]);
    expect(r.ok ? "" : r.problems[0]!.detail).toContain("exact strings");
  });

  it("a device kind no evidence source can carry", () => {
    const p = cameraProfile();
    p.device.kind = "machine";
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["unverifiable-term"]);
  });

  it("a primitive id that is not active in the vocabulary", () => {
    const p = cameraProfile();
    p.interpretation.evidenceTypeIds = ["capture.no_such_primitive"];
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["unverifiable-term"]);
  });

  it("a profile with an unknown term is invalid, so it can never be committed", () => {
    const p = { ...cameraProfile(), extraTerm: "never evaluated" };
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["profile-invalid"]);
  });

  it("a client digest that is not the digest of the submitted profile", () => {
    const p = cameraProfile();
    const other = cameraProfile();
    other.measurement.sampling.minSamples = 2;
    expect(codes(checkProfileRegistration(request(p, { claimedDigest: computeMeasurementProfileDigest(other) })))).toEqual([
      "digest-mismatch",
    ]);
  });

  it("a client digest in the sha256: evidence-event family", () => {
    const p = cameraProfile();
    const tagged = `sha256:${computeMeasurementProfileDigest(p).slice(2)}`;
    expect(codes(checkProfileRegistration(request(p, { claimedDigest: tagged })))).toEqual(["digest-mismatch"]);
  });

  it("reports every problem at once, so an operator can fix the profile in one pass", () => {
    const p = cameraProfile();
    p.measurement.tolerance = { comparator: ">=", target: 0.9 };
    const r = checkProfileRegistration(request(p, { deviceId: "dev-other", capabilityType: "cnc-milling", claimedDigest: "0x" + "0".repeat(64) }));
    expect(codes(r)).toEqual(["device-mismatch", "capability-type-mismatch", "unverifiable-term", "digest-mismatch"]);
  });
});

describe("profile registration — checks, digest and stored row are one copy (astra pack 39 discipline)", () => {
  it("the profile returned for storage is a copy, not the caller's object, and later mutation cannot reach it", () => {
    const p = cameraProfile();
    const r = checkProfileRegistration(request(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).not.toBe(p);
    p.device.deviceId = "dev-mutated-after-check";
    expect(r.profile.device.deviceId).toBe(CAMERA);
    expect(r.profileDigest).toBe(computeMeasurementProfileDigest(cameraProfile()));
  });

  it("a getter that lies after the first read cannot split what is checked from what is stored", () => {
    const p = cameraProfile();
    let reads = 0;
    Object.defineProperty(p.device, "deviceId", {
      enumerable: true,
      configurable: true,
      get: () => (reads++ === 0 ? CAMERA : "dev-other"),
    });
    const r = checkProfileRegistration(request(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.device.deviceId).toBe(CAMERA);
    expect(reads).toBe(1);
  });

  it("a request JSON cannot carry is refused as profile-invalid, never coerced", () => {
    const p = cameraProfile() as unknown as Record<string, unknown>;
    (p.measurement as Record<string, unknown>).sampling = { minSamples: Number.NaN };
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["profile-invalid"]);
  });
});
