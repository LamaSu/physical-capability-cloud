import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  planProvenance,
  provenancePlanDigest,
  defaultEmitterIndex,
  PROVENANCE_PLAN_SCHEMA,
  type ProvenancePlanInput,
} from "../evidence/provenance-plan.js";
import type { CSD } from "../csd/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
function builtinCsd(name: string): Pick<CSD, "url" | "evidence"> {
  return JSON.parse(readFileSync(resolve(here, `../csds/${name}.csd.json`), "utf-8"));
}

const RECEIPT_CORE = [
  { id: "ident.registered_key" },
  { id: "receipt.kernel_signed" },
  { id: "confirm.execution_mode", params: { expected: "real" } },
  { id: "artifact.hash", params: { mode: "plain" } },
];

/** A structured 2D-print contract: tier 1 = the kernel receipt core, tier 2 adds a
 *  nonce-bound photo and the payer's approval (the tier≥2 human floor). */
const PRINT_CSD: Pick<CSD, "url" | "evidence"> = {
  url: "pcc://capabilities/2d-print-structured/v1",
  evidence: {
    tier0: { description: "t0", required: ["jobId"], primitives: [{ id: "decl.self_attested" }] },
    tier1: { description: "t1", required: ["jobId"], primitives: [...RECEIPT_CORE] },
    tier2: {
      description: "t2",
      required: ["jobId"],
      primitives: [
        ...RECEIPT_CORE,
        { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC1" } },
        { id: "approval.payer" },
      ],
    },
  },
};

const IPP_AND_CAMERA: ProvenancePlanInput = {
  csd: PRINT_CSD,
  adapterTypes: ["ipp"],
  deviceRoles: ["camera"],
};

describe("planProvenance: an IPP printer with a camera (golden)", () => {
  const plan = planProvenance(IPP_AND_CAMERA);

  it("reaches tier 2, the highest tier the contract declares", () => {
    expect(plan.schema).toBe(PROVENANCE_PLAN_SCHEMA);
    expect(plan.contract).toEqual({ verdict: "ELIGIBLE", eligibleTier: 2, declaredTier: 2, cappedReason: null });
    expect(plan.achievableTier).toBe(2);
    expect(plan.cappedBy).toEqual([]);
    expect(plan.nextTier).toBeNull();
  });

  it("says where each required primitive comes from", () => {
    const t2 = plan.perTier.find((t) => t.tier === 2)!;
    expect(t2.missing).toEqual([]);
    expect(t2.settlementSteps).toEqual(["approval.payer"]);
    expect(t2.supplied).toContainEqual({ id: "capture.photo_nonced", sources: ["device-role:camera"] });
    expect(t2.supplied).toContainEqual({ id: "artifact.hash", sources: ["adapter:ipp", "device-role:camera"] });
    expect(t2.supplied).toContainEqual({ id: "receipt.kernel_signed", sources: ["adapter:ipp"] });
  });

  it("flags verifiers that are not live yet, without capping in report-only mode", () => {
    expect(plan.perTier.find((t) => t.tier === 2)!.stubVerifiers).toContain("capture.photo_nonced");
    expect(plan.advisories.some((a) => a.startsWith("verifiers not live yet for:"))).toBe(true);
  });

  it("has a stable digest (golden vector)", async () => {
    const digest = await provenancePlanDigest(plan);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).toBe(GOLDEN_IPP_CAMERA_DIGEST);
  });
});

// Pinned from the first run of this suite; any change to the plan's shape or
// the canonicalizer must update it deliberately.
const GOLDEN_IPP_CAMERA_DIGEST = "sha256:e30e012862dcbfbaed1acb0721b3feb9b1686c4fbad51c82ffb0cc6888de87f0";

describe("planProvenance: what unlocks the next tier", () => {
  it("without the camera, stops at tier 1 and names the camera as the missing emitter", () => {
    const plan = planProvenance({ csd: PRINT_CSD, adapterTypes: ["ipp"] });
    expect(plan.achievableTier).toBe(1);
    expect(plan.nextTier).toEqual({
      tier: 2,
      missing: [{ id: "capture.photo_nonced", candidates: ["device-role:camera"] }],
      contractReasons: [],
      settlementSteps: ["approval.payer"],
    });
    expect(plan.cappedBy).toEqual(['tier2: nothing in this setup supplies "capture.photo_nonced"']);
  });

  it("an operator-declared emitter counts, and is flagged as a claim", () => {
    const plan = planProvenance({ csd: PRINT_CSD, adapterTypes: ["ipp"], adjustments: { add: ["capture.photo_nonced"] } });
    expect(plan.achievableTier).toBe(2);
    const t2 = plan.perTier.find((t) => t.tier === 2)!;
    expect(t2.supplied).toContainEqual({ id: "capture.photo_nonced", sources: ["operator"] });
    expect(plan.advisories.some((a) => a.includes("are claims"))).toBe(true);
  });

  it("an operator removal overrides the defaults", () => {
    const plan = planProvenance({ ...IPP_AND_CAMERA, adjustments: { remove: ["receipt.kernel_signed"] } });
    expect(plan.achievableTier).toBe(0);
    expect(plan.nextTier?.tier).toBe(1);
    expect(plan.nextTier?.missing.map((m) => m.id)).toEqual(["receipt.kernel_signed"]);
  });
});

describe("planProvenance: fail-closed rules", () => {
  it("never reads a self-declared tier", async () => {
    const withClaims = {
      ...PRINT_CSD,
      assuranceTiers: [0, 1, 2, 3],
      maxAssuranceTier: 3,
    } as unknown as Pick<CSD, "url" | "evidence">;
    const a = planProvenance({ ...IPP_AND_CAMERA, adapterTypes: ["ipp"], deviceRoles: [] });
    const b = planProvenance({ ...IPP_AND_CAMERA, csd: withClaims, adapterTypes: ["ipp"], deviceRoles: [] });
    expect(b.achievableTier).toBe(1);
    expect(await provenancePlanDigest(b)).toBe(await provenancePlanDigest(a));
  });

  it("a mock adapter caps at tier 0, even with every primitive declared", () => {
    const everything = [...defaultEmitterIndex().keys()];
    for (const adapterTypes of [["mock"], ["ipp", "mock"]]) {
      const plan = planProvenance({ csd: PRINT_CSD, adapterTypes, deviceRoles: ["camera"], adjustments: { add: everything } });
      expect(plan.achievableTier).toBe(0);
      expect(plan.cappedBy).toContain("a mock adapter caps the plan at tier 0");
    }
  });

  it("an adapter with no default manifest supplies nothing", () => {
    const plan = planProvenance({ csd: PRINT_CSD, adapterTypes: ["opentrons"] });
    expect(plan.achievableTier).toBe(0);
    expect(plan.advisories).toContain('adapter "opentrons" has no default emitter manifest; it supplies nothing');
  });

  it("a legacy free-text contract caps at tier 0 whatever the hardware (built-in 2d-print)", () => {
    const plan = planProvenance({ csd: builtinCsd("2d-print"), adapterTypes: ["ipp"], deviceRoles: ["camera"] });
    expect(plan.contract.verdict).toBe("CAPPED");
    expect(plan.contract.eligibleTier).toBe(0);
    expect(plan.achievableTier).toBe(0);
    expect(plan.cappedBy.join(" ")).toContain("legacy free-text");
  });

  it("the built-in print-and-mail contract stops at tier 0, and says both why and what is missing", () => {
    const plan = planProvenance({
      csd: builtinCsd("document-print-and-mail"),
      adapterTypes: ["ipp"],
      deviceRoles: ["camera"],
    });
    // The contract caps itself: tier 1 lists receipt.kernel_signed and
    // machine.execution_log without their dependency ident.registered_key.
    expect(plan.contract.verdict).toBe("CAPPED");
    expect(plan.contract.eligibleTier).toBe(0);
    expect(plan.achievableTier).toBe(0);
    expect(plan.nextTier?.tier).toBe(1);
    expect(plan.nextTier?.contractReasons.join(" ")).toContain('depends on "ident.registered_key"');
    // And no default emitter supplies machine.execution_log: a kit or custom adapter must.
    expect(plan.nextTier?.missing).toEqual([{ id: "machine.execution_log", candidates: [] }]);
    // Each reason is listed once, although the contract lists that primitive twice.
    expect(new Set(plan.cappedBy).size).toBe(plan.cappedBy.length);
  });

  it("keeps the tier≥2 human floor from the contract lint", () => {
    const noHuman: Pick<CSD, "url" | "evidence"> = {
      url: "pcc://capabilities/no-human/v1",
      evidence: {
        tier0: PRINT_CSD.evidence!.tier0,
        tier1: PRINT_CSD.evidence!.tier1,
        tier2: { description: "t2", required: ["jobId"], primitives: [...RECEIPT_CORE, { id: "capture.photo_nonced" }] },
      },
    };
    const plan = planProvenance({ csd: noHuman, adapterTypes: ["ipp"], deviceRoles: ["camera"] });
    expect(plan.achievableTier).toBe(1);
    expect(plan.cappedBy.join(" ")).toContain("human-attestation");
  });

  it("an unknown primitive in the contract blocks the tier it sits in", () => {
    const unknown: Pick<CSD, "url" | "evidence"> = {
      url: "pcc://capabilities/unknown-prim/v1",
      evidence: {
        tier0: PRINT_CSD.evidence!.tier0,
        tier1: { description: "t1", required: ["jobId"], primitives: [...RECEIPT_CORE, { id: "made.up_primitive" }] },
      },
    };
    const plan = planProvenance({ csd: unknown, adapterTypes: ["ipp"], adjustments: { add: ["made.up_primitive"] } });
    expect(plan.achievableTier).toBe(0);
    expect(plan.cappedBy.join(" ")).toContain('unknown primitive "made.up_primitive"');
    expect(plan.advisories).toContain('operator-added primitive "made.up_primitive" is not in the vocabulary; ignored');
  });

  it("an unachievable tier 0 blocks every higher tier", () => {
    const badFloor: Pick<CSD, "url" | "evidence"> = {
      url: "pcc://capabilities/bad-floor/v1",
      evidence: {
        tier0: { description: "t0", required: ["jobId"], primitives: [{ id: "decl.self_attested" }, { id: "reserved.or_unknown" }] },
        tier1: PRINT_CSD.evidence!.tier1,
      },
    };
    const plan = planProvenance({ csd: badFloor, adapterTypes: ["ipp"] });
    expect(plan.perTier.find((t) => t.tier === 1)!.achievable).toBe(true);
    expect(plan.achievableTier).toBe(0);
    expect(plan.nextTier?.tier).toBe(0);
  });

  it("in the oracle-enforcing mode, a stub verifier caps its tier", () => {
    const plan = planProvenance({ ...IPP_AND_CAMERA, requireImplementedVerifier: true });
    expect(plan.achievableTier).toBe(0);
    expect(plan.cappedBy.join(" ")).toContain("verifier not implemented");
  });
});

describe("planProvenance: determinism", () => {
  it("gives the same digest under any permutation of the inputs and of the contract's refs", async () => {
    const base = await provenancePlanDigest(
      planProvenance({
        csd: PRINT_CSD,
        adapterTypes: ["ipp", "octoprint"],
        deviceRoles: ["camera", "sensor"],
        adjustments: { add: ["telemetry.gps_trail", "confirm.target_system"], remove: ["artifact.hash"] },
      }),
    );
    const reversedCsd: Pick<CSD, "url" | "evidence"> = {
      url: PRINT_CSD.url,
      evidence: Object.fromEntries(
        Object.entries(PRINT_CSD.evidence!).map(([k, t]) => [k, { ...t, primitives: [...(t.primitives ?? [])].reverse() }]),
      ),
    };
    const permuted = await provenancePlanDigest(
      planProvenance({
        csd: reversedCsd,
        adapterTypes: ["octoprint", " ipp ", "octoprint"],
        deviceRoles: ["sensor", "camera"],
        adjustments: { add: ["confirm.target_system", "telemetry.gps_trail"], remove: ["artifact.hash"] },
      }),
    );
    expect(permuted).toBe(base);
  });

  it("keeps the contract's reasons stable when the contract lists its refs in another order", async () => {
    const csd = builtinCsd("document-print-and-mail");
    const reversed: Pick<CSD, "url" | "evidence"> = {
      url: csd.url,
      evidence: Object.fromEntries(
        Object.entries(csd.evidence!).map(([k, t]) => [k, { ...t, primitives: [...(t.primitives ?? [])].reverse() }]),
      ),
    };
    const a = planProvenance({ csd, adapterTypes: ["ipp"] });
    const b = planProvenance({ csd: reversed, adapterTypes: ["ipp"] });
    expect(a.cappedBy.length).toBeGreaterThan(1);
    expect(b.cappedBy).toEqual(a.cappedBy);
    expect(await provenancePlanDigest(b)).toBe(await provenancePlanDigest(a));
  });

  it("the reverse index never suggests the mock adapter", () => {
    for (const candidates of defaultEmitterIndex().values()) {
      expect(candidates).not.toContain("adapter:mock");
    }
    expect(defaultEmitterIndex().get("capture.photo_nonced")).toEqual(["device-role:camera"]);
  });
});
