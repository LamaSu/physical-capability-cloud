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

  it("a profile whose version pins can never both be met", () => {
    const p = cameraProfile();
    p.device.permittedFirmwareVersions = ["fw-4.0.1"];
    expect(codes(checkProfileRegistration(request(p)))).toEqual(["unverifiable-term"]);
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
