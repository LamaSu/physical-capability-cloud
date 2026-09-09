/**
 * MeasurementProfileV1 (LO-SE-2) — the committed capture profile.
 *
 * Acceptance (memo): the same profile digest governs configuration, collection,
 * eligibility and verification. Negative control (memo): a post-commit
 * parameter or tolerance change must not authorize under the old digest.
 */
import { describe, it, expect } from "vitest";

import {
  MEASUREMENT_PROFILE_DOMAIN,
  computeMeasurementProfileDigest,
  validateMeasurementProfile,
  profileGoverns,
  acceptsInspectedOutput,
  InvalidMeasurementProfileError,
  type MeasurementProfileV1,
} from "../evidence/measurement-profile.js";
import { canonicalize, sha256 } from "../util/canonical.js";

/** The CP-0 print pilot's profile: one photo of the printed page. */
function printPilotProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/document-printing/inspected-page/v1",
    outcome: {
      capabilityType: "document-printing",
      statement: "The submitted document was printed on paper and the printed page was photographed.",
      objectIdentity: { kind: "documentHash", value: "sha256:" + "a".repeat(64) },
    },
    device: {
      deviceId: "dev-hp-3301-0D253A",
      kind: "camera",
      adapterType: "photo",
      permittedAdapterVersions: ["PhotoCameraAdapter-1.0.0"],
      permittedFirmwareVersions: ["*-unpinned-pilot"],
    },
    measurement: {
      method: "optical-capture",
      quantity: "printed-page-image",
      unit: "none",
      sampling: { minSamples: 1 },
    },
    capture: {
      startCondition: "printer_job_verified",
      endCondition: "capture_complete",
      coverage: { policy: "one-shot", minFraction: 1 },
    },
    calibration: { required: false },
    interpretation: {
      evidenceTypeIds: ["capture.photo_nonced", "receipt.kernel_signed"],
      acceptanceLevel: "inspected_output",
      onDeviceFailure: "reject",
    },
    simulationProhibited: true,
    witnesses: { requiredRoles: [], independentOfClaimant: false },
    onMissingData: "reject",
    onContradiction: "reject",
  };
}

describe("measurement profile — validation fails closed", () => {
  it("the print pilot profile validates", () => {
    expect(validateMeasurementProfile(printPilotProfile())).toEqual([]);
  });

  it("simulationProhibited must be asserted true, not defaulted", async () => {
    const p = { ...printPilotProfile(), simulationProhibited: false as unknown as true };
    expect(validateMeasurementProfile(p).some((v) => v.path === "simulationProhibited")).toBe(true);
    await expect(computeMeasurementProfileDigest(p)).rejects.toBeInstanceOf(InvalidMeasurementProfileError);
  });

  it("a mock adapter can never satisfy a profile", () => {
    const p = printPilotProfile();
    p.device.adapterType = "mock";
    expect(validateMeasurementProfile(p).some((v) => v.path === "device.adapterType")).toBe(true);
  });

  it("zero samples is vacuous", () => {
    const p = printPilotProfile();
    p.measurement.sampling.minSamples = 0;
    expect(validateMeasurementProfile(p).some((v) => v.path === "measurement.sampling.minSamples")).toBe(true);
  });

  it("required calibration without a validity window is rejected (stale calibration undetectable)", () => {
    const p = printPilotProfile();
    p.calibration = { required: true, procedureId: "cal-1" };
    expect(
      validateMeasurementProfile(p).some((v) => v.path === "calibration.validityWindowSeconds"),
    ).toBe(true);
  });

  it("an open version set is not a pinned device", () => {
    const p = printPilotProfile();
    p.device.permittedAdapterVersions = [];
    expect(validateMeasurementProfile(p).some((v) => v.path === "device.permittedAdapterVersions")).toBe(true);
  });

  it("required witness roles without independence are not witnesses", () => {
    const p = printPilotProfile();
    p.witnesses = { requiredRoles: ["inspector"], independentOfClaimant: false };
    expect(validateMeasurementProfile(p).some((v) => v.path === "witnesses.independentOfClaimant")).toBe(true);
  });

  it("an unknown acceptance level is rejected", () => {
    const p = printPilotProfile();
    (p.interpretation as { acceptanceLevel: string }).acceptanceLevel = "probably_fine";
    expect(validateMeasurementProfile(p).some((v) => v.path === "interpretation.acceptanceLevel")).toBe(true);
  });

  it("a non-object is rejected without throwing", () => {
    expect(validateMeasurementProfile(null).length).toBe(1);
    expect(validateMeasurementProfile("profile").length).toBe(1);
  });
});

describe("measurement profile — digest uses the production canonicalizer", () => {
  it("digest equals sha256(canonicalize({domain, profile})) computed independently", async () => {
    const p = printPilotProfile();
    const digest = await computeMeasurementProfileDigest(p);
    const expected = await sha256(canonicalize({ domain: MEASUREMENT_PROFILE_DOMAIN, profile: p }));
    expect(digest).toBe(expected);
    expect(digest.startsWith("sha256:")).toBe(true);
  });

  it("is stable across key order (canonicalizer sorts)", async () => {
    const a = printPilotProfile();
    const reordered = JSON.parse(JSON.stringify({ ...a })) as MeasurementProfileV1;
    expect(await computeMeasurementProfileDigest(reordered)).toBe(await computeMeasurementProfileDigest(a));
  });

  it("is domain-separated: the same body under another domain differs", async () => {
    const p = printPilotProfile();
    const real = await computeMeasurementProfileDigest(p);
    const other = await sha256(canonicalize({ domain: "PCC:something-else:v1", profile: p }));
    expect(real).not.toBe(other);
  });
});

describe("measurement profile — the mutation negative control", () => {
  it("governs when the presented profile is the committed one", async () => {
    const p = printPilotProfile();
    const committed = await computeMeasurementProfileDigest(p);
    const res = await profileGoverns(committed, p);
    expect(res.governs).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("a post-commit TOLERANCE change cannot authorize under the old digest", async () => {
    const original = printPilotProfile();
    original.measurement.tolerance = { comparator: ">=", target: 0.9 };
    const committed = await computeMeasurementProfileDigest(original);

    const loosened = printPilotProfile();
    loosened.measurement.tolerance = { comparator: ">=", target: 0.1 };

    const res = await profileGoverns(committed, loosened);
    expect(res.governs).toBe(false);
    expect(res.reasons.join(" ")).toContain("digest mismatch");
  });

  it("a post-commit SAMPLING change cannot authorize under the old digest", async () => {
    const original = printPilotProfile();
    original.measurement.sampling = { minSamples: 5, maxIntervalMs: 1000 };
    const committed = await computeMeasurementProfileDigest(original);

    const thinned = printPilotProfile();
    thinned.measurement.sampling = { minSamples: 1, maxIntervalMs: 60000 };

    expect((await profileGoverns(committed, thinned)).governs).toBe(false);
  });

  it("a post-commit DEVICE swap cannot authorize under the old digest", async () => {
    const original = printPilotProfile();
    const committed = await computeMeasurementProfileDigest(original);
    const swapped = printPilotProfile();
    swapped.device.deviceId = "dev-some-other-camera";
    expect((await profileGoverns(committed, swapped)).governs).toBe(false);
  });

  it("an invalid presented profile never governs, and never throws", async () => {
    const committed = await computeMeasurementProfileDigest(printPilotProfile());
    const bad = { ...printPilotProfile(), simulationProhibited: false as unknown as true };
    const res = await profileGoverns(committed, bad);
    expect(res.governs).toBe(false);
    expect(res.presentedDigest).toBeNull();
    expect(res.reasons.join(" ")).toContain("simulationProhibited");
  });
});

describe("measurement profile — result levels stay separate", () => {
  it("inspected_output supports a sensor-grounded claim", () => {
    expect(acceptsInspectedOutput(printPilotProfile())).toBe(true);
  });

  it("device_reported does NOT — a completion event is the device's own word", () => {
    const p = printPilotProfile();
    p.interpretation.acceptanceLevel = "device_reported";
    expect(acceptsInspectedOutput(p)).toBe(false);
  });

  it("submitted does NOT — a spool receipt proves only that a request was made", () => {
    const p = printPilotProfile();
    p.interpretation.acceptanceLevel = "submitted";
    expect(acceptsInspectedOutput(p)).toBe(false);
  });

  it("changing the accepted level changes the digest (a level is a committed term)", async () => {
    const strict = printPilotProfile();
    const committed = await computeMeasurementProfileDigest(strict);
    const weakened = printPilotProfile();
    weakened.interpretation.acceptanceLevel = "device_reported";
    expect((await profileGoverns(committed, weakened)).governs).toBe(false);
  });
});
