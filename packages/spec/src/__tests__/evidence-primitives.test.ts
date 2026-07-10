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

// The primitives with machinery already built/wired (verifier "live").
// v1 first-class (4) + two settlement-verified additions (gateway #230
// signing-key registration + pcc-oracle #13 machine-log chain auth).
const LIVE_FIRST_CLASS = [
  "approval.payer",
  "receipt.kernel_signed",
  "confirm.execution_mode",
  "decl.self_attested",
  "ident.registered_key",
  "machine.execution_log",
];

// The locked golden manifest hash of the shipped vocabulary (v1 16 + the
// v1.5-industrial #52-#55 = 20 active defs). Any contract change (adding/removing
// a primitive, changing tierSupport, auth, params, deps, gates, status) moves
// this — the golden test then fails on purpose. Recomputed for the additive
// v1.5-industrial cut (was 0x499f3a5d… for the v1-only 16-primitive contract).
const GOLDEN_VOCAB_MANIFEST_HASH =
  "0x9e034dd9df85748de1bac4d199bd3928f6c4477b81eb20a83264bcd7fdd441ed";

// ── 1. The registry validates ───────────────────────────────────────

describe("evidence vocabulary — registry validates", () => {
  it("ships the 16 v1 + 4 v1.5-industrial primitives (20), all status:active", () => {
    expect(EVIDENCE_PRIMITIVES).toHaveLength(20);
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

  it("the LIVE_FIRST_CLASS primitives are verifier 'live'; the rest are 'stub'", () => {
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
  it("VOCAB_VERSION is 2 (additive v1.5-industrial bump)", () => {
    expect(VOCAB_VERSION).toBe(2);
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

// ── 8. v1.5-industrial primitives (#52-#55) ─────────────────────────

const INDUSTRIAL_IDS = [
  "machine.execution_log",
  "telemetry.envelope_conformance",
  "telemetry.coverage_gate",
  "process.batch_record",
];

describe("v1.5-industrial — the four sensor/machine-log primitives", () => {
  it("all four are registered and active; #52 is now verifier 'live', the rest stay 'stub'", () => {
    for (const id of INDUSTRIAL_IDS) {
      const def = getPrimitive(id);
      expect(def, id).toBeDefined();
      expect(def!.status).toBe("active");
      if (id === "machine.execution_log") {
        // #52 — oracle binding shipped (gateway #230 signingAddress persistence +
        // pcc-oracle #13 #47/#52 resolver+wiring); verifierStatus flipped live.
        expect(def!.verifierStatus).toBe("live");
      } else {
        // Machinery is live/extracted, but the ORACLE binding is the settlement
        // lane's work — so verifierStatus stays "stub" (fail-closed, spec §8).
        expect(def!.verifierStatus).toBe("stub");
      }
    }
  });

  it("every industrial def conforms to the schema (Family L 'record' is a valid enum member)", () => {
    for (const id of INDUSTRIAL_IDS) {
      const result = EvidencePrimitiveDefSchema.safeParse(getPrimitive(id));
      if (!result.success) console.error(`${id} invalid:`, result.error.errors);
      expect(result.success).toBe(true);
    }
  });

  it("#52 machine.execution_log is Family L (record) and binds the program hash + registered key", () => {
    const m = getPrimitive("machine.execution_log")!;
    expect(m.family).toBe("record");
    expect(m.dependsOn).toEqual(
      expect.arrayContaining(["artifact.hash", "ident.registered_key"]),
    );
    expect(m.tierSupport.map((t) => t.tier)).toEqual([1, 2, 3]);
  });

  it("#54 telemetry.coverage_gate is a negative gate spanning tiers 0-3", () => {
    const g = getPrimitive("telemetry.coverage_gate")!;
    expect(g.gates).toBe(true);
    expect(g.tierSupport.map((t) => t.tier)).toEqual([0, 1, 2, 3]);
  });

  it("MODELING FIX (task step 3): machine logs bind to #52 (record), not a doc.* audit-trail primitive", () => {
    // #38 doc.audit_trail is a future v1.5 doc primitive whose ALCOA predicate
    // (old/new-value change records) does not fit a controller trace. The
    // machine-log home is #52 machine.execution_log; no doc.* primitive in this
    // cut exists to mis-bind machine logs to.
    expect(getPrimitive("machine.execution_log")!.family).toBe("record");
    expect(EVIDENCE_PRIMITIVES.filter((d) => d.id.startsWith("doc."))).toHaveLength(0);
  });

  it("dependsOn of the new primitives resolves within the registry (closure holds)", () => {
    const ids = new Set(EVIDENCE_PRIMITIVES.map((d) => d.id));
    for (const id of INDUSTRIAL_IDS) {
      for (const dep of getPrimitive(id)!.dependsOn ?? []) {
        expect(ids.has(dep), `${id} depends on ${dep}`).toBe(true);
      }
    }
  });
});

describe("v1.5-industrial — a sensor/machine-log CSD is tier-eligible via the new primitives", () => {
  // A CNC/mill CSD leaning on power_profile (#53 envelope) + #52 machine log.
  const sensorCsd: Pick<CSD, "url" | "evidence"> = {
    url: "pcc://capabilities/cnc-milling-industrial/v1",
    evidence: {
      tier0: {
        description: "self-attested floor",
        required: ["jobId", "gcodeHash"],
        primitives: [{ id: "decl.self_attested" }],
      },
      tier1: {
        description: "signed machine log + power envelope + coverage gate",
        required: ["jobId", "machineLogChainCid", "sensorSummaryCid"],
        primitives: [
          { id: "artifact.hash", params: { mode: "redacted-commit" } },
          { id: "ident.registered_key" },
          { id: "receipt.kernel_signed" },
          { id: "machine.execution_log", params: { logKind: "command_trace" }, bind: "machineLogChainCid" },
          { id: "telemetry.envelope_conformance", params: { envelope: "builtin-defaults" }, bind: "sensorSummaryCid" },
          { id: "telemetry.coverage_gate" },
        ],
      },
      tier2: {
        description: "payer sign-off + cross-corroborated machine log/envelope",
        required: ["jobId", "approvalSig"],
        primitives: [
          { id: "receipt.kernel_signed" },
          { id: "approval.payer" },
          { id: "machine.execution_log", params: { logKind: "command_trace" } },
          { id: "telemetry.envelope_conformance" },
        ],
      },
    },
  };

  it("is tier-2 eligible in report-only mode, carried by #53 (#52 is now verifier 'live')", () => {
    const report = computeCsdEligibility(sensorCsd);
    expect(report.verdict).toBe("ELIGIBLE");
    expect(report.eligibleTier).toBe(2);
    for (const t of report.perTier) expect(t.eligible).toBe(true);
    // #52 machine.execution_log flipped to verifier "live" (gateway #230 +
    // pcc-oracle #13); #53 telemetry.envelope_conformance remains stub-advisory.
    const tier1 = report.perTier.find((t) => t.tier === 1)!;
    expect(tier1.stubVerifierPrimitives).toContain("telemetry.envelope_conformance");
  });

  it("fails CLOSED under oracle enforcement (industrial verifiers are stubs) — caps below 2", () => {
    const enforcing = computeCsdEligibility(sensorCsd, {
      requireImplementedVerifier: true,
    });
    expect(enforcing.eligibleTier).toBeLessThan(2);
    expect(enforcing.verdict).toBe("CAPPED");
    const reasons = enforcing.perTier.flatMap((t) => t.reasons).join(" ");
    expect(reasons).toMatch(/verifier not implemented/);
  });

  it("stays listable at tier 0+ (permissionless floor holds with industrial primitives present)", () => {
    expect(computeCsdEligibility(sensorCsd).eligibleTier).toBeGreaterThanOrEqual(0);
  });
});
