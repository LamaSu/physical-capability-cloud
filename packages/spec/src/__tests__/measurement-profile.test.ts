/**
 * MeasurementProfileV1 (LO-SE-2) — the committed capture profile.
 *
 * Acceptance (memo): the same profile digest governs configuration, collection,
 * eligibility and verification. Negative control (memo): a post-commit
 * parameter or tolerance change must not authorize under the old digest.
 */
import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  MEASUREMENT_PROFILE_DOMAIN,
  MEASUREMENT_PROFILE_DIGEST_PATTERN,
  computeMeasurementProfileDigest,
  validateMeasurementProfile,
  profileGoverns,
  acceptsInspectedOutput,
  InvalidMeasurementProfileError,
  type MeasurementProfileV1,
} from "../evidence/measurement-profile.js";
import { canonicalize } from "../util/canonical.js";

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

/** Independent recomputation of the commitment-family digest. */
function expectedDigest(domain: string, profile: unknown): string {
  return "0x" + createHash("sha256").update(canonicalize({ domain, profile })).digest("hex");
}

/**
 * Rebuilds every plain object in `value`, recursively, with its keys
 * inserted in REVERSE order — a genuine key-order permutation. Unlike
 * `JSON.parse(JSON.stringify({...obj}))` (which preserves insertion order,
 * per the astra pack 40 finding at measurement-profile.test.ts:138-142 of
 * the prior revision), this actually changes `Object.keys()` order. Arrays
 * keep their element order; only object keys are reversed.
 */
function reversed<T>(value: T): T {
  if (Array.isArray(value)) return value.map((x) => reversed(x)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).reverse();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = reversed((value as Record<string, unknown>)[k]);
    return out as T;
  }
  return value;
}

describe("measurement profile — validation fails closed", () => {
  it("the print pilot profile validates", () => {
    expect(validateMeasurementProfile(printPilotProfile())).toEqual([]);
  });

  it("simulationProhibited must be asserted true, not defaulted", () => {
    const p = { ...printPilotProfile(), simulationProhibited: false as unknown as true };
    expect(validateMeasurementProfile(p).some((v) => v.path === "simulationProhibited")).toBe(true);
    expect(() => computeMeasurementProfileDigest(p)).toThrow(InvalidMeasurementProfileError);
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

describe("measurement profile — digest is the commitment family over the production canonicalizer", () => {
  it("digest equals 0x + hex(sha256(canonicalize({domain, profile}))) computed independently", () => {
    const p = printPilotProfile();
    expect(computeMeasurementProfileDigest(p)).toBe(expectedDigest(MEASUREMENT_PROFILE_DOMAIN, p));
  });

  it("is 0x + 64 lowercase hex, never the sha256:-tagged evidence-event family", () => {
    const digest = computeMeasurementProfileDigest(printPilotProfile());
    expect(digest).toMatch(MEASUREMENT_PROFILE_DIGEST_PATTERN);
    expect(digest.startsWith("sha256:")).toBe(false);
  });

  it("the print pilot profile digest is pinned (a drift in form or content fails here)", () => {
    expect(computeMeasurementProfileDigest(printPilotProfile())).toBe(PINNED_PRINT_PILOT_DIGEST);
  });

  it("is stable across key order: a genuinely reversed-key profile digests the same (canonicalizer sorts)", () => {
    const a = printPilotProfile();
    const reordered = reversed(a);
    // Prove this is a REAL permutation, unlike a JSON round-trip of a spread.
    expect(Object.keys(reordered)).toEqual([...Object.keys(a)].reverse());
    expect(computeMeasurementProfileDigest(reordered)).toBe(computeMeasurementProfileDigest(a));
  });

  it("is domain-separated: the same body under another domain differs", () => {
    const p = printPilotProfile();
    expect(computeMeasurementProfileDigest(p)).not.toBe(expectedDigest("PCC:something-else:v1", p));
  });
});

describe("measurement profile — the mutation negative control", () => {
  it("governs when the presented profile is the committed one", () => {
    const p = printPilotProfile();
    const res = profileGoverns(computeMeasurementProfileDigest(p), p);
    expect(res.governs).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("a post-commit TOLERANCE change cannot authorize under the old digest", () => {
    const original = printPilotProfile();
    original.measurement.tolerance = { comparator: ">=", target: 0.9 };
    const committed = computeMeasurementProfileDigest(original);

    const loosened = printPilotProfile();
    loosened.measurement.tolerance = { comparator: ">=", target: 0.1 };

    const res = profileGoverns(committed, loosened);
    expect(res.governs).toBe(false);
    expect(res.reasons.join(" ")).toContain("digest mismatch");
  });

  it("a post-commit SAMPLING change cannot authorize under the old digest", () => {
    const original = printPilotProfile();
    original.measurement.sampling = { minSamples: 5, maxIntervalMs: 1000 };
    const committed = computeMeasurementProfileDigest(original);

    const thinned = printPilotProfile();
    thinned.measurement.sampling = { minSamples: 1, maxIntervalMs: 60000 };

    expect(profileGoverns(committed, thinned).governs).toBe(false);
  });

  it("a post-commit DEVICE swap cannot authorize under the old digest", () => {
    const committed = computeMeasurementProfileDigest(printPilotProfile());
    const swapped = printPilotProfile();
    swapped.device.deviceId = "dev-some-other-camera";
    expect(profileGoverns(committed, swapped).governs).toBe(false);
  });

  it("an invalid presented profile never governs, and never throws", () => {
    const committed = computeMeasurementProfileDigest(printPilotProfile());
    const bad = { ...printPilotProfile(), simulationProhibited: false as unknown as true };
    const res = profileGoverns(committed, bad);
    expect(res.governs).toBe(false);
    expect(res.presentedDigest).toBeNull();
    expect(res.reasons.join(" ")).toContain("simulationProhibited");
  });
});

describe("measurement profile — a committed digest in the wrong family fails closed", () => {
  const hex = computeMeasurementProfileDigest(printPilotProfile()).slice(2);

  it("the same hash in the sha256:-tagged evidence-event form is rejected as the wrong family", () => {
    const res = profileGoverns(`sha256:${hex}`, printPilotProfile());
    expect(res.governs).toBe(false);
    expect(res.presentedDigest).toBeNull();
    expect(res.reasons.join(" ")).toContain("evidence-event family");
  });

  it("uppercase hex is rejected (one canonical spelling per digest)", () => {
    expect(profileGoverns(`0x${hex.toUpperCase()}`, printPilotProfile()).governs).toBe(false);
  });

  it("a truncated digest is rejected", () => {
    expect(profileGoverns(`0x${hex.slice(0, 62)}`, printPilotProfile()).governs).toBe(false);
  });

  it("a non-string committed digest is rejected without throwing", () => {
    expect(profileGoverns(null as unknown as string, printPilotProfile()).governs).toBe(false);
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

  it("changing the accepted level changes the digest (a level is a committed term)", () => {
    const committed = computeMeasurementProfileDigest(printPilotProfile());
    const weakened = printPilotProfile();
    weakened.interpretation.acceptanceLevel = "device_reported";
    expect(profileGoverns(committed, weakened).governs).toBe(false);
  });
});

/**
 * Pinned digest of printPilotProfile(), computed independently as
 * "0x" + sha256(canonicalize({domain: "PCC:measurement-profile:v1", profile})).
 */
const PINNED_PRINT_PILOT_DIGEST =
  "0x7efecb6c05ae4241a87dc5082f7c9d1bac9158060a78beb01dcdfb2496e9bb6a";

describe("measurement profile — validation fails closed on unknown terms and non-finite values", () => {
  it("the unmodified print pilot profile still validates with zero violations", () => {
    expect(validateMeasurementProfile(printPilotProfile())).toEqual([]);
  });

  const cases: [string, (p: Record<string, unknown>) => void, string][] = [
    ["an unknown root key", (p) => (p.extraTerm = "nope"), "extraTerm"],
    [
      "an unknown measurement key",
      (p) => ((p.measurement as Record<string, unknown>).resolution = "1080p"),
      "measurement.resolution",
    ],
    ["an unknown device key", (p) => ((p.device as Record<string, unknown>).serial = "SN-1"), "device.serial"],
    [
      "a non-finite maxIntervalMs",
      (p) => ((p.measurement as { sampling: Record<string, unknown> }).sampling.maxIntervalMs = Infinity),
      "measurement.sampling.maxIntervalMs",
    ],
    [
      "a permittedAdapterVersions entry that is an empty string",
      (p) => ((p.device as Record<string, unknown>).permittedAdapterVersions = [""]),
      "device.permittedAdapterVersions",
    ],
    [
      "a permittedAdapterVersions entry that is a number",
      (p) => ((p.device as Record<string, unknown>).permittedAdapterVersions = [42]),
      "device.permittedAdapterVersions",
    ],
    [
      "a permittedFirmwareVersions entry that is an empty string",
      (p) => ((p.device as Record<string, unknown>).permittedFirmwareVersions = [""]),
      "device.permittedFirmwareVersions",
    ],
    [
      "an evidenceTypeIds entry that is a number",
      (p) => ((p.interpretation as Record<string, unknown>).evidenceTypeIds = [7]),
      "interpretation.evidenceTypeIds",
    ],
    ["a non-boolean calibration.required", (p) => (p.calibration = { required: "yes" }), "calibration.required"],
    [
      "a non-finite calibration.validityWindowSeconds",
      (p) => (p.calibration = { required: true, procedureId: "cal-1", validityWindowSeconds: Infinity }),
      "calibration.validityWindowSeconds",
    ],
    [
      "a witnesses.requiredRoles entry that is an empty string",
      (p) => ((p.witnesses as Record<string, unknown>).requiredRoles = [""]),
      "witnesses.requiredRoles",
    ],
  ];
  for (const [name, mutate, path] of cases) {
    it(`${name} is a violation at ${path}`, () => {
      const p = printPilotProfile() as unknown as Record<string, unknown>;
      mutate(p);
      const violations = validateMeasurementProfile(p);
      expect(violations.some((v) => v.path === path)).toBe(true);
    });
  }
});

describe("round 2 (astra pack 40)", () => {
  describe("calibration: optional fields validate even when calibration is not required", () => {
    const cases: [string, (p: Record<string, unknown>) => void, string[]][] = [
      [
        "procedureId alone, calibration not required",
        (p) => { p.calibration = { required: false, procedureId: "cal-1" }; },
        ["calibration.procedureId"],
      ],
      [
        "validityWindowSeconds alone, calibration not required",
        (p) => { p.calibration = { required: false, validityWindowSeconds: 3600 }; },
        ["calibration.validityWindowSeconds"],
      ],
      [
        "both fields, both malformed, calibration not required",
        (p) => { p.calibration = { required: false, procedureId: 42, validityWindowSeconds: -1 }; },
        ["calibration.procedureId", "calibration.validityWindowSeconds"],
      ],
      [
        "calibration required, but procedureId is not a string",
        (p) => { p.calibration = { required: true, procedureId: 42, validityWindowSeconds: 3600 }; },
        ["calibration.procedureId"],
      ],
    ];
    for (const [name, mutate, paths] of cases) {
      it(`${name} -> violation at ${paths.join(" and ")}`, () => {
        const p = printPilotProfile() as unknown as Record<string, unknown>;
        mutate(p);
        const violations = validateMeasurementProfile(p);
        for (const path of paths) {
          expect(violations.some((v) => v.path === path)).toBe(true);
        }
      });
    }
  });

  describe("sparse arrays are rejected (index-based check catches holes .every() would skip)", () => {
    it("device.permittedAdapterVersions = new Array(1) is a violation", () => {
      const p = printPilotProfile() as unknown as Record<string, unknown>;
      (p.device as Record<string, unknown>).permittedAdapterVersions = new Array(1);
      expect(validateMeasurementProfile(p).some((v) => v.path === "device.permittedAdapterVersions")).toBe(true);
    });

    it("interpretation.evidenceTypeIds with a hole (a.length = 2 after one push) is a violation", () => {
      const p = printPilotProfile() as unknown as Record<string, unknown>;
      const a = ["capture.photo_nonced"];
      a.length = 2;
      (p.interpretation as Record<string, unknown>).evidenceTypeIds = a;
      expect(validateMeasurementProfile(p).some((v) => v.path === "interpretation.evidenceTypeIds")).toBe(true);
    });

    it("witnesses.requiredRoles = new Array(2) is a violation", () => {
      const p = printPilotProfile() as unknown as Record<string, unknown>;
      (p.witnesses as Record<string, unknown>).requiredRoles = new Array(2);
      expect(validateMeasurementProfile(p).some((v) => v.path === "witnesses.requiredRoles")).toBe(true);
    });
  });

  describe("profileGoverns never throws, even on inputs JSON.stringify itself would choke on", () => {
    const FAKE_COMMITTED = `0x${"a".repeat(64)}`;

    it("a bigint committed digest: digest-wrong-family, reason names the type, never throws", () => {
      let res: ReturnType<typeof profileGoverns> | undefined;
      expect(() => {
        res = profileGoverns(10n as unknown as string, printPilotProfile());
      }).not.toThrow();
      expect(res!.governs).toBe(false);
      expect(res!.code).toBe("digest-wrong-family");
      expect(res!.reasons.join(" ")).toContain("type bigint");
    });

    it("a cyclic presented profile: profile-invalid, never throws", () => {
      const p = printPilotProfile() as unknown as Record<string, unknown>;
      p.selfCycle = p;
      let res: ReturnType<typeof profileGoverns> | undefined;
      expect(() => {
        res = profileGoverns(FAKE_COMMITTED, p as unknown as MeasurementProfileV1);
      }).not.toThrow();
      expect(res!.governs).toBe(false);
      expect(res!.code).toBe("profile-invalid");
    });

    it("a NaN measurement.sampling.minSamples: profile-invalid, never throws", () => {
      const p = printPilotProfile();
      (p.measurement.sampling as { minSamples: number }).minSamples = NaN;
      let res: ReturnType<typeof profileGoverns> | undefined;
      expect(() => {
        res = profileGoverns(FAKE_COMMITTED, p);
      }).not.toThrow();
      expect(res!.governs).toBe(false);
      expect(res!.code).toBe("profile-invalid");
    });
  });

  describe("the governing snapshot is an independent, deep-frozen copy", () => {
    it("deep-equals the input profile but is not the same object", () => {
      const p = printPilotProfile();
      const committed = computeMeasurementProfileDigest(p);
      const res = profileGoverns(committed, p);
      expect(res.governs).toBe(true);
      expect(res.profile).toEqual(p);
      expect(res.profile).not.toBe(p);
    });

    it("the snapshot and its nested measurement object are both frozen", () => {
      const p = printPilotProfile();
      const committed = computeMeasurementProfileDigest(p);
      const res = profileGoverns(committed, p);
      expect(Object.isFrozen(res.profile)).toBe(true);
      expect(Object.isFrozen(res.profile!.measurement)).toBe(true);
    });

    it("mutating the caller's profile after the call does not change the returned snapshot", () => {
      const p = printPilotProfile();
      const committed = computeMeasurementProfileDigest(p);
      const res = profileGoverns(committed, p);
      p.measurement.method = "MUTATED-AFTER-CALL";
      p.device.deviceId = "MUTATED-AFTER-CALL";
      expect(res.profile!.measurement.method).not.toBe("MUTATED-AFTER-CALL");
      expect(res.profile!.device.deviceId).not.toBe("MUTATED-AFTER-CALL");
    });
  });

  it("a lying measurement.sampling getter: first read wins, in both the digest and the returned snapshot", () => {
    const p = printPilotProfile();
    let reads = 0;
    Object.defineProperty(p.measurement, "sampling", {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return reads === 1 ? { minSamples: 2 } : { minSamples: 1 };
      },
    });

    const firstReadProfile = printPilotProfile();
    firstReadProfile.measurement.sampling = { minSamples: 2 };
    const expectedDigestValue = computeMeasurementProfileDigest(firstReadProfile);

    const res = profileGoverns(expectedDigestValue, p);
    expect(res.presentedDigest).toBe(expectedDigestValue);
    expect(res.profile!.measurement.sampling.minSamples).toBe(2);
  });

  it("computeMeasurementProfileDigest reads a lying getter once: the first read is what is validated and digested (lane mutation check)", () => {
    const p = printPilotProfile();
    let reads = 0;
    Object.defineProperty(p.measurement, "sampling", {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return reads === 1 ? { minSamples: 2 } : { minSamples: 1 };
      },
    });
    const firstRead = printPilotProfile();
    firstRead.measurement.sampling = { minSamples: 2 };
    const secondRead = printPilotProfile();
    secondRead.measurement.sampling = { minSamples: 1 };
    const digest = computeMeasurementProfileDigest(p);
    expect(digest).toBe(computeMeasurementProfileDigest(firstRead));
    expect(digest).not.toBe(computeMeasurementProfileDigest(secondRead));
    expect(reads).toBe(1);
  });

  describe("key order: a real reversal (not a JSON round-trip of a spread), via reversed()", () => {
    it("reversed() really reverses keys at the top level and one nested level", () => {
      const p = printPilotProfile();
      const r = reversed(p);
      expect(Object.keys(r)).toEqual([...Object.keys(p)].reverse());
      expect(Object.keys(r.device)).toEqual([...Object.keys(p.device)].reverse());
    });

    it("computeMeasurementProfileDigest(reversed(p)) equals the digest of p", () => {
      const p = printPilotProfile();
      expect(computeMeasurementProfileDigest(reversed(p))).toBe(computeMeasurementProfileDigest(p));
    });
  });

  it("computeMeasurementProfileDigest throws InvalidMeasurementProfileError on a profile JSON cannot carry (NaN)", () => {
    const p = printPilotProfile();
    (p.measurement.sampling as { minSamples: number }).minSamples = NaN;
    expect(() => computeMeasurementProfileDigest(p)).toThrow(InvalidMeasurementProfileError);
  });
});

// ── astra (packs 73 and 74, gpt-5.6-sol): the one-pass copy must not turn a JSON "__proto__"
// key into inherited, unhashed authority, and must never throw on a hostile thrown value ──
describe("plain-data boundary: __proto__ keys and hostile getters (astra packs 73, 74)", () => {
  /** A JSON-parsed pilot profile whose measurement.sampling holds only a "__proto__" member. */
  function protoSampling(minSamples: number): MeasurementProfileV1 {
    const json = JSON.stringify(printPilotProfile()).replace(
      '"sampling":{"minSamples":1}',
      `"sampling":{"__proto__":{"minSamples":${minSamples}}}`,
    );
    expect(json).toContain('"__proto__"');
    return JSON.parse(json) as MeasurementProfileV1;
  }

  it("a JSON __proto__ member is refused, so it can never yield a digest", () => {
    expect(() => computeMeasurementProfileDigest(protoSampling(2))).toThrow(/__proto__/);
  });

  it("governance refuses a profile carrying a __proto__ member as invalid, whatever the digest", () => {
    const g = profileGoverns(`0x${"0".repeat(64)}`, protoSampling(1));
    expect(g.governs).toBe(false);
    expect(g.code).toBe("profile-invalid");
    expect(g.reasons.join(" ")).toMatch(/__proto__/);
  });

  it("a getter throwing a value String() cannot format yields governs:false, never a throw", () => {
    const hostile = { ...printPilotProfile() } as Record<string, unknown>;
    Object.defineProperty(hostile, "onMissingData", {
      enumerable: true,
      get() {
        throw Object.create(null);
      },
    });
    let result: ReturnType<typeof profileGoverns> | undefined;
    expect(() => {
      result = profileGoverns(`0x${"0".repeat(64)}`, hostile as unknown as MeasurementProfileV1);
    }).not.toThrow();
    expect(result?.governs).toBe(false);
    expect(result?.code).toBe("profile-invalid");
  });
});

// ── astra (pack 125, gpt-5.6-sol) and pack 124's follow-up: the copy holds exactly what the hash covers ──
describe("plain-data boundary: no inherited values, and -0 is 0 (astra packs 124, 125)", () => {
  it("a polluted Object.prototype cannot supply a term: the copy has no prototype", () => {
    const p = printPilotProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples;
    const proto = Object.prototype as Record<string, unknown>;
    proto.minSamples = 2;
    try {
      expect(() => computeMeasurementProfileDigest(p as unknown as MeasurementProfileV1)).toThrow(/minSamples/);
      const g = profileGoverns(`0x${"0".repeat(64)}`, p as unknown as MeasurementProfileV1);
      expect(g.governs).toBe(false);
      expect(g.code).toBe("profile-invalid");
    } finally {
      delete proto.minSamples;
    }
  });

  it("an inherited getter that throws never makes profileGoverns throw", () => {
    const p = printPilotProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples;
    Object.defineProperty(Object.prototype, "minSamples", { configurable: true, get() { throw Object.create(null); } });
    try {
      let g: ReturnType<typeof profileGoverns> | undefined;
      expect(() => { g = profileGoverns(`0x${"0".repeat(64)}`, p as unknown as MeasurementProfileV1); }).not.toThrow();
      expect(g?.governs).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>).minSamples;
    }
  });

  it("-0 is copied as 0, so the governed profile is the one the digest covers", () => {
    const withTarget = (t: number) => {
      const p = printPilotProfile();
      p.measurement = { method: "load-cell", quantity: "mass", unit: "kg", sampling: { minSamples: 1 }, tolerance: { comparator: "<=", target: t } };
      return p;
    };
    const g = profileGoverns(computeMeasurementProfileDigest(withTarget(0)), withTarget(-0));
    expect(g.governs).toBe(true);
    expect(Object.is(g.profile?.measurement.tolerance?.target, 0)).toBe(true);
    expect(Object.getPrototypeOf(g.profile)).toBeNull();
  });
});
