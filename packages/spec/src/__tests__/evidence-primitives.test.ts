import { describe, it, expect } from "vitest";

import {
  EVIDENCE_PRIMITIVES,
  EvidencePrimitiveDefSchema,
  VOCAB_VERSION,
  VOCAB_MANIFEST_HASH,
  computeVocabManifestHash,
  getPrimitive,
  listPrimitives,
  type EvidencePrimitiveDef,
} from "../evidence/primitives.js";
import {
  computeCsdEligibility,
  type CsdEligibilityReport,
} from "../evidence/eligibility.js";
import { makeStubVerifier } from "../evidence/verifier-interface.js";
import { CsdSchema, type CSD } from "../csd/schema.js";
import { VerificationRuleSchema } from "../types/verification-program.js";
import { loadBuiltinCsds } from "../csd/registry.js";

// ── Built-in CSD JSON (backward-compat regression) ──────────────────
import fdmRaw from "../csds/fdm.csd.json" with { type: "json" };
import courierRouteRaw from "../csds/courier-route.csd.json" with { type: "json" };
import hotFoodPrepRaw from "../csds/hot-food-prep.csd.json" with { type: "json" };

// The four primitives with machinery already built/wired (verifier "live").
const LIVE_FIRST_CLASS = [
  "approval.payer",
  "receipt.kernel_signed",
  "confirm.execution_mode",
  "decl.self_attested",
];

// The locked golden manifest hash of the shipped v1 vocabulary.
// Any contract change (adding/removing a primitive, changing tierSupport, auth,
// params, deps, gates, status) moves this — the golden test then fails on purpose.
const GOLDEN_VOCAB_MANIFEST_HASH =
  "0x499f3a5de3f8dabd860ea90d232403db0f6a6b75d493723ce055a25c0a3c18ab";

// ── 1. The registry validates ───────────────────────────────────────

describe("evidence vocabulary — registry validates", () => {
  it("ships exactly the 16 v1 primitives, all status:active", () => {
    expect(EVIDENCE_PRIMITIVES).toHaveLength(16);
    for (const d of EVIDENCE_PRIMITIVES) expect(d.status).toBe("active");
  });

  it("every primitive def conforms to EvidencePrimitiveDefSchema", () => {
    for (const d of EVIDENCE_PRIMITIVES) {
      const result = EvidencePrimitiveDefSchema.safeParse(d);
      if (!result.success) {
        console.error(`${d.id} invalid:`, result.error.errors);
      }
      expect(result.success).toBe(true);
    }
  });

  it("primitive ids are unique", () => {
    const ids = EVIDENCE_PRIMITIVES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("wire form is derived from the id (pcc.ev.<id>.v1)", () => {
    for (const d of EVIDENCE_PRIMITIVES) {
      expect(d.wire).toBe(`pcc.ev.${d.id}.v1`);
    }
  });

  it("tierSupport is non-empty and only decl.self_attested caps at tier 0", () => {
    for (const d of EVIDENCE_PRIMITIVES) {
      expect(d.tierSupport.length).toBeGreaterThan(0);
    }
    const decl = getPrimitive("decl.self_attested")!;
    expect(decl.tierSupport.map((t) => t.tier)).toEqual([0]);
  });

  it("the four first-class primitives are verifier 'live'; the rest are 'stub'", () => {
    for (const id of LIVE_FIRST_CLASS) {
      expect(getPrimitive(id)?.verifierStatus).toBe("live");
    }
    const live = EVIDENCE_PRIMITIVES.filter((d) => d.verifierStatus === "live");
    expect(live.map((d) => d.id).sort()).toEqual([...LIVE_FIRST_CLASS].sort());
  });

  it("dependsOn only references known primitives (dependency closure is resolvable)", () => {
    const ids = new Set(EVIDENCE_PRIMITIVES.map((d) => d.id));
    for (const d of EVIDENCE_PRIMITIVES) {
      for (const dep of d.dependsOn ?? []) expect(ids.has(dep)).toBe(true);
    }
  });

  it("approval.payer is the Family-G human floor at tier 2/3", () => {
    const payer = getPrimitive("approval.payer")!;
    expect(payer.family).toBe("attest");
    expect(payer.tierSupport.map((t) => t.tier)).toEqual([2, 3]);
  });

  it("listPrimitives filters by family", () => {
    const confirmFamily = listPrimitives("confirm");
    expect(confirmFamily.length).toBeGreaterThan(0);
    for (const d of confirmFamily) expect(d.family).toBe("confirm");
  });
});

// ── 2. Manifest hash (golden + deterministic + order-independent) ────

describe("evidence vocabulary — VOCAB_MANIFEST_HASH", () => {
  it("VOCAB_VERSION is 1", () => {
    expect(VOCAB_VERSION).toBe(1);
  });

  it("is a 0x-prefixed sha256 hex", () => {
    expect(VOCAB_MANIFEST_HASH).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("matches the locked golden hash", () => {
    expect(VOCAB_MANIFEST_HASH).toBe(GOLDEN_VOCAB_MANIFEST_HASH);
  });

  it("is deterministic across recomputation", () => {
    expect(computeVocabManifestHash(EVIDENCE_PRIMITIVES)).toBe(VOCAB_MANIFEST_HASH);
  });

  it("is order-independent (shuffled input → same hash)", () => {
    const shuffled = [...EVIDENCE_PRIMITIVES].reverse();
    expect(computeVocabManifestHash(shuffled)).toBe(VOCAB_MANIFEST_HASH);
  });

  it("changes when the contract changes (e.g. a tier is added)", () => {
    const mutated: EvidencePrimitiveDef[] = EVIDENCE_PRIMITIVES.map((d) =>
      d.id === "approval.payer"
        ? { ...d, tierSupport: [...d.tierSupport, { tier: 1 }] }
        : d,
    );
    expect(computeVocabManifestHash(mutated)).not.toBe(VOCAB_MANIFEST_HASH);
  });

  it("does NOT change when only prose (proves) changes", () => {
    const reworded: EvidencePrimitiveDef[] = EVIDENCE_PRIMITIVES.map((d) =>
      d.id === "approval.payer" ? { ...d, proves: "reworded prose only" } : d,
    );
    expect(computeVocabManifestHash(reworded)).toBe(VOCAB_MANIFEST_HASH);
  });
});

// ── 3. Eligibility lint (spec §5) ───────────────────────────────────

/** A CSD whose per-tier evidence references only known primitives, satisfying
 *  the tier floors — should be tier-2 eligible. */
const eligibleCsd: Pick<CSD, "url" | "evidence"> = {
  url: "pcc://capabilities/vocab-eligible/v1",
  evidence: {
    tier0: {
      description: "self-attested declaration",
      required: ["jobId", "timestamp"],
      primitives: [{ id: "decl.self_attested" }],
    },
    tier1: {
      description: "integrity + registered kernel receipt",
      required: ["jobId", "bundleHash"],
      primitives: [
        { id: "artifact.hash", params: { mode: "plain" } },
        { id: "ident.registered_key" },
        { id: "receipt.kernel_signed" },
      ],
    },
    tier2: {
      description: "payer approval + nonce-fresh photo",
      required: ["jobId", "outputPhotoCid"],
      primitives: [
        { id: "receipt.kernel_signed" },
        { id: "approval.payer" },
        { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC2" }, bind: "outputPhotoCid" },
      ],
    },
  },
};

describe("eligibility — a CSD referencing only known primitives is tier-N eligible", () => {
  let report: CsdEligibilityReport;
  it("is tier-2 eligible (report-only default)", () => {
    report = computeCsdEligibility(eligibleCsd);
    expect(report.verdict).toBe("ELIGIBLE");
    expect(report.eligibleTier).toBe(2);
    expect(report.declaredTier).toBe(2);
    for (const t of report.perTier) expect(t.eligible).toBe(true);
  });

  it("surfaces stub-verifier primitives as advisories without capping", () => {
    const r = computeCsdEligibility(eligibleCsd);
    const tier1 = r.perTier.find((t) => t.tier === 1)!;
    // artifact.hash + ident.registered_key are stub verifiers (advisory only).
    expect(tier1.stubVerifierPrimitives).toContain("artifact.hash");
    expect(tier1.eligible).toBe(true);
  });
});

describe("eligibility — an unknown primitive caps at tier 0", () => {
  const unknownCsd: Pick<CSD, "url" | "evidence"> = {
    url: "pcc://capabilities/vocab-unknown/v1",
    evidence: {
      tier0: {
        description: "floor",
        required: ["jobId"],
        primitives: [{ id: "decl.self_attested" }],
      },
      tier1: {
        description: "references an unknown primitive",
        required: ["jobId"],
        primitives: [{ id: "artifact.hash" }, { id: "unknown.bogus_primitive" }],
      },
      tier2: {
        description: "would-be tier 2",
        required: ["jobId"],
        primitives: [{ id: "approval.payer" }],
      },
    },
  };

  it("caps eligibleTier at 0 and reports CAPPED with the unknown id", () => {
    const report = computeCsdEligibility(unknownCsd);
    expect(report.eligibleTier).toBe(0);
    expect(report.verdict).toBe("CAPPED");
    expect(report.cappedReason).toMatch(/unknown primitive "unknown\.bogus_primitive"/);
  });

  it("stays listable (tier 0 is the permissionless floor)", () => {
    const report = computeCsdEligibility(unknownCsd);
    // eligibleTier never drops below 0 — the CSD is still listable.
    expect(report.eligibleTier).toBeGreaterThanOrEqual(0);
  });
});

describe("eligibility — tier floors (§5)", () => {
  it("tier ≥ 1 with only decl.self_attested caps below that tier", () => {
    const report = computeCsdEligibility({
      url: "pcc://capabilities/only-decl/v1",
      evidence: {
        tier0: { description: "", required: [], primitives: [{ id: "decl.self_attested" }] },
        tier1: { description: "", required: [], primitives: [{ id: "decl.self_attested" }] },
      },
    });
    expect(report.eligibleTier).toBe(0);
    const tier1 = report.perTier.find((t) => t.tier === 1)!;
    expect(tier1.reasons.join(" ")).toMatch(/non-declaration primitive/);
  });

  it("tier ≥ 2 without a Family-G primitive caps at tier 1 (the human floor)", () => {
    const report = computeCsdEligibility({
      url: "pcc://capabilities/no-family-g/v1",
      evidence: {
        tier0: { description: "", required: [], primitives: [{ id: "decl.self_attested" }] },
        tier1: {
          description: "",
          required: [],
          primitives: [{ id: "artifact.hash" }, { id: "ident.registered_key" }, { id: "receipt.kernel_signed" }],
        },
        tier2: {
          description: "",
          required: [],
          primitives: [{ id: "artifact.hash" }, { id: "receipt.kernel_signed" }, { id: "ident.registered_key" }],
        },
      },
    });
    expect(report.eligibleTier).toBe(1);
    const tier2 = report.perTier.find((t) => t.tier === 2)!;
    expect(tier2.reasons.join(" ")).toMatch(/human-attestation/);
  });

  it("a dependency absent from tier ≤ k caps the tier", () => {
    const report = computeCsdEligibility({
      url: "pcc://capabilities/broken-dep/v1",
      evidence: {
        tier0: { description: "", required: [], primitives: [{ id: "decl.self_attested" }] },
        // capture.photo_nonced dependsOn artifact.hash, which is absent here.
        tier1: { description: "", required: [], primitives: [{ id: "capture.photo_nonced" }] },
      },
    });
    expect(report.eligibleTier).toBe(0);
    const tier1 = report.perTier.find((t) => t.tier === 1)!;
    expect(tier1.reasons.join(" ")).toMatch(/depends on "artifact\.hash"/);
  });
});

// ── 4. Oracle-enforcing mode (spec §8 stub policy) ──────────────────

describe("eligibility — requireImplementedVerifier caps below report-only", () => {
  it("the oracle-enforcing path caps the eligible tier when verifiers are stubs", () => {
    const reportOnly = computeCsdEligibility(eligibleCsd);
    const enforcing = computeCsdEligibility(eligibleCsd, {
      requireImplementedVerifier: true,
    });
    expect(reportOnly.eligibleTier).toBe(2);
    expect(enforcing.eligibleTier).toBeLessThan(reportOnly.eligibleTier);
    expect(enforcing.verdict).toBe("CAPPED");
    // The cap reason names an unimplemented verifier.
    const allReasons = enforcing.perTier.flatMap((t) => t.reasons).join(" ");
    expect(allReasons).toMatch(/verifier not implemented/);
  });
});

// ── 5. Backward-compat regression (existing CSDs still validate) ────

describe("backward-compat — existing CSDs still validate", () => {
  it("all 8 built-in CSDs still load (additive primitives[] is optional)", () => {
    const registry = loadBuiltinCsds();
    expect(registry.size).toBe(8);
  });

  it("built-in CSD JSON with no primitives[] still parses under CsdSchema", () => {
    for (const raw of [fdmRaw, courierRouteRaw, hotFoodPrepRaw]) {
      const result = CsdSchema.safeParse(raw);
      if (!result.success) console.error("csd invalid:", result.error.errors);
      expect(result.success).toBe(true);
    }
  });

  it("a legacy (free-text-only) CSD lints as tier-0 (capped), still listable", () => {
    // courier-route declares tier0-3 with required[] only, no primitives[].
    const report = computeCsdEligibility(courierRouteRaw as unknown as Pick<CSD, "url" | "evidence">);
    expect(report.eligibleTier).toBe(0);
    expect(report.verdict).toBe("CAPPED");
    expect(report.cappedReason).toMatch(/legacy free-text/);
  });
});

// ── 6. Additive CSD field + new VerificationRule kind parse ─────────

describe("additive schema — CSD primitives[] and the primitive rule kind", () => {
  it("a full CSD carrying evidence.tierN.primitives[] parses", () => {
    const csd: CSD = {
      url: "pcc://capabilities/vocab-additive/v1",
      version: "1.0.0",
      status: "active",
      name: "Vocab Additive",
      description: "carries structured primitives[]",
      kind: "base",
      baseDefinition: null,
      parameters: [],
      constraints: [],
      pricing: { basePrice: "1.00", currency: "USDC" },
      evidence: {
        tier0: {
          description: "self-attested",
          required: ["jobId"],
          primitives: [{ id: "decl.self_attested", bind: "declaration" }],
        },
      },
    };
    const result = CsdSchema.safeParse(csd);
    if (!result.success) console.error("additive csd invalid:", result.error.errors);
    expect(result.success).toBe(true);
  });

  it("the new {kind:'primitive'} VerificationRule validates", () => {
    const rule = {
      kind: "primitive",
      id: "capture.photo_nonced",
      params: { media: "photo", minClass: "CC2" },
      bind: "outputPhotoCid",
    };
    expect(VerificationRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("legacy VerificationRule kinds still validate (no breakage)", () => {
    const geofence = {
      kind: "geofence",
      eventRef: { eventType: "dropoff" },
      lat: 37.77,
      lng: -122.42,
      radiusM: 50,
    };
    expect(VerificationRuleSchema.safeParse(geofence).success).toBe(true);
  });

  it("a primitive rule composes inside and/or", () => {
    const composed = {
      kind: "and",
      children: [
        { kind: "primitive", id: "approval.payer" },
        { kind: "primitive", id: "capture.photo_nonced" },
      ],
    };
    expect(VerificationRuleSchema.safeParse(composed).success).toBe(true);
  });
});

// ── 7. Verifier-interface stub (oracle lane contract) ───────────────

describe("verifier-interface — the fail-closed stub", () => {
  it("makeStubVerifier fails closed (met:false) — no silent passes", async () => {
    const stub = makeStubVerifier("capture.photo_nonced");
    const result = await stub.verify({}, {}, { vocabVersion: VOCAB_VERSION });
    expect(result.met).toBe(false);
    expect(result.detail.join(" ")).toMatch(/not implemented/);
  });
});
