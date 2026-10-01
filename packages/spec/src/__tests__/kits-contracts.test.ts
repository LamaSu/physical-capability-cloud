/**
 * Kits contracts: Capability Kit manifest identity and completeness,
 * OperatorBindingDTO and OpportunityDTO invariants (ledger R5/R6/R7/R8/R41/R45,
 * PX-13). Interface-only: no storage, no routes.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as kit from "../types/capability-kit.js";
import {
  CapabilityKitManifestV1Schema,
  KIT_MANIFEST_SCHEMA,
  computeKitDigest,
  isAllowedLicenseExpression,
  normalizeKitManifest,
  validateKitCompleteness,
  type CapabilityKitManifestV1,
} from "../types/capability-kit.js";
import {
  OPERATOR_BINDING_SCHEMA,
  OperatorBindingDTOSchema,
  maskPayoutDestination,
  type OperatorBindingDTO,
} from "../types/operator-binding.js";
import {
  BUILTIN_PUBLIC_CAPABILITY_URLS,
  OPPORTUNITY_SCHEMA,
  OpportunityDTOSchema,
  PRIMITIVE_PARAMS_ANNOTATIONS,
  PRIMITIVE_PARAMS_KEYWORDS,
  approvedSetDigest,
  demandAggregateId,
  demandAggregateTitle,
  demandAggregatesFromRelease,
  evidenceIsExecutable,
  isPublicCapabilityUrl,
  opportunityDTOSchemaFor,
  primitivesAreExecutable,
  publicCapabilityUrls,
  validatePrimitiveParams,
  type DemandAggregateDTO,
  type FundedOfferDTO,
  type KitBuildRequestDTO,
  type OpportunityDemandBand,
  type PublicOpportunityReleaseRecord,
} from "../types/opportunity.js";
import type { SHA256 } from "../types/common.js";
import type { CsdEvidencePrimitiveRef } from "../csd/schema.js";
import { loadBuiltinCsds } from "../csd/registry.js";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";

const H = (c: string) => `sha256:${c.repeat(64)}` as const;
const T = (c: string) => `0x${c.repeat(64)}`;

function liquidHandlingKit(overrides: Partial<CapabilityKitManifestV1> = {}): CapabilityKitManifestV1 {
  return {
    schema: "pcc.capability-kit/v1",
    name: "OT-2 dye serial dilution",
    version: "1.0.0",
    parentKitDigest: null,
    capabilities: [
      { csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: H("a") },
    ],
    artifacts: [
      { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: H("1") },
      { role: "labware-definition", name: "carrier-24x-2ml.json", mediaType: "application/json", digest: H("2") },
      { role: "plr-resource", name: "carrier_24x_2ml.py", mediaType: "text/x-python", digest: H("3") },
      { role: "cad", name: "carrier.step", mediaType: "model/step", digest: H("4") },
      { role: "tests", name: "checks.json", mediaType: "application/json", digest: H("5") },
      { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("6") },
      { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("7") },
    ],
    compatibility: { deviceFamilies: ["opentrons-ot2"], interfaces: ["http"] },
    declaredAssuranceTiers: [1, 2],
    economics: { spdxLicense: "Apache-2.0", economicTermsHash: T("e") },
    ...overrides,
  };
}

describe("Capability Kit identity (computeKitDigest)", () => {
  it("is sha256:<hex>, independent of key order and of list order", async () => {
    const kit = liquidHandlingKit();
    const shuffled: CapabilityKitManifestV1 = {
      economics: { economicTermsHash: T("e"), spdxLicense: "Apache-2.0" },
      declaredAssuranceTiers: [2, 1],
      compatibility: { interfaces: ["http"], deviceFamilies: ["opentrons-ot2"] },
      artifacts: [...kit.artifacts].reverse(),
      capabilities: kit.capabilities,
      parentKitDigest: null,
      version: "1.0.0",
      name: kit.name,
      schema: "pcc.capability-kit/v1",
    };
    const a = await computeKitDigest(kit);
    const b = await computeKitDigest(shuffled);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes when any content changes: one artifact byte, the version, the lineage", async () => {
    const base = await computeKitDigest(liquidHandlingKit());
    const changedArtifact = liquidHandlingKit();
    changedArtifact.artifacts[0] = { ...changedArtifact.artifacts[0]!, digest: H("9") };
    expect(await computeKitDigest(changedArtifact)).not.toBe(base);
    expect(await computeKitDigest(liquidHandlingKit({ version: "1.0.1" }))).not.toBe(base);
    expect(await computeKitDigest(liquidHandlingKit({ parentKitDigest: base }))).not.toBe(base);
  });

  it("a fork names its parent by digest and gets its own identity", async () => {
    const parent = await computeKitDigest(liquidHandlingKit());
    const fork = liquidHandlingKit({ parentKitDigest: parent, version: "1.1.0", name: "OT-2 dilution (Hamilton port)" });
    const forkDigest = await computeKitDigest(fork);
    expect(forkDigest).not.toBe(parent);
    expect(normalizeKitManifest(fork).parentKitDigest).toBe(parent);
  });

  it("an invalid manifest never gets an identity", async () => {
    const bad: Array<[string, unknown]> = [
      ["unknown key", { ...liquidHandlingKit(), publisher: "someone" }],
      ["bare url without version", liquidHandlingKit({ capabilities: [{ csdUrl: "liquid-handling", capabilityContractDigest: H("a") }] })],
      ["url-only capability (no contract digest)", { ...liquidHandlingKit(), capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1" }] }],
      ["uppercase digest", liquidHandlingKit({ parentKitDigest: `sha256:${"A".repeat(64)}` })],
      ["non-semver version", liquidHandlingKit({ version: "latest" })],
      ["duplicate artifact", liquidHandlingKit({ artifacts: [...liquidHandlingKit().artifacts, liquidHandlingKit().artifacts[0]!] })],
      ["duplicate capability", liquidHandlingKit({ capabilities: [liquidHandlingKit().capabilities[0]!, liquidHandlingKit().capabilities[0]!] })],
      ["tier out of range", liquidHandlingKit({ declaredAssuranceTiers: [4] })],
      ["terms hash in the wrong format", liquidHandlingKit({ economics: { economicTermsHash: H("e") } })],
      ["no artifacts", liquidHandlingKit({ artifacts: [] })],
    ];
    for (const [label, m] of bad) {
      await expect(computeKitDigest(m), label).rejects.toThrow();
    }
  });
});

describe("computeKitDigest golden vectors (re-run when the canonicalizer changes: N15 / #359)", () => {
  // Pinned by hand; the minimal vector was re-derived independently in Python:
  // json.dumps(obj, sort_keys=True, separators=(",", ":")) -> sha256 matched.
  it("minimal kit", async () => {
    const minimal = {
      schema: "pcc.capability-kit/v1",
      name: "golden-minimal",
      version: "0.0.1",
      parentKitDigest: null,
      capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: H("a") }],
      artifacts: [{ role: "method", name: "m.py", mediaType: "text/x-python", digest: H("1") }],
    };
    expect(await computeKitDigest(minimal)).toBe(
      "sha256:e05bb524e98ed72c05d56036a1b96a2de5c1cc088fb0661761d867b8accc2527",
    );
  });

  it("full lab/workcell kit", async () => {
    expect(await computeKitDigest(liquidHandlingKit())).toBe(
      "sha256:50c2a3a84bb9fb663f4491f4f98f64e27fb52fa4613636a78e7ac0f60394d4f8",
    );
  });
});

describe("validateKitCompleteness (reusable kit vs one-off listing)", () => {
  it("accepts a kit another operator could deploy from the manifest alone", () => {
    expect(validateKitCompleteness(liquidHandlingKit())).toEqual({ complete: true, missing: [] });
  });

  it("flags a one-off listing: an adapter alone is not a reusable kit", () => {
    const oneOff = CapabilityKitManifestV1Schema.parse(
      liquidHandlingKit({
        artifacts: [{ role: "adapter", name: "adapter.ts", mediaType: "text/typescript", digest: H("1") }],
        economics: undefined,
      }),
    );
    const r = validateKitCompleteness(oneOff);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["role:tests", "role:install-recipe", "role:provenance-recipe", "license"]);
  });

  it("requires an implementation (adapter or method)", () => {
    const kit = liquidHandlingKit();
    const noImpl = { ...kit, artifacts: kit.artifacts.filter((a) => a.role !== "method") };
    expect(validateKitCompleteness(noImpl).missing).toContain("implementation");
  });

  it("a rights-terms hash satisfies the license requirement", () => {
    const kit = liquidHandlingKit({ economics: { rightsTermsHash: T("f") } });
    expect(validateKitCompleteness(kit).complete).toBe(true);
  });
});

function binding(overrides: Partial<OperatorBindingDTO> = {}): OperatorBindingDTO {
  return {
    schema: "pcc.operator-binding.v0",
    principal: { operatorId: "lab@kits.test", identityStatus: "self_asserted" },
    executorKinds: ["machine"],
    bindings: [
      {
        kind: "kernel",
        id: "kernel-ot2-a",
        capabilityType: "pcc://capabilities/liquid-handling/v1",
        kitDigest: H("c"),
        presence: "online",
        availability: {
          mode: "windows",
          windows: [{ start: "09:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] }],
          timezone: "America/Los_Angeles",
        },
        assuranceTierCap: 1,
        lastSeenAt: "2026-09-24T12:00:00Z",
      },
    ],
    payee: {
      kind: "wallet",
      maskedDestination: maskPayoutDestination("0x282Fa9C122b433864f8C8a8F2EfE411b52067539"),
      source: "payout-wallet-store (N21)",
      verified: false,
    },
    unmappedCapacity: [],
    moneyAuthority: "none",
    executionAuthority: { canClaimCapabilityTypes: ["pcc://capabilities/liquid-handling/v1"] },
    asOf: "2026-09-24T12:00:01Z",
    ...overrides,
  };
}

describe("OperatorBindingDTO", () => {
  it("accepts a well-formed projection", () => {
    expect(OperatorBindingDTOSchema.safeParse(binding()).success).toBe(true);
  });

  it("never carries money authority", () => {
    for (const moneyAuthority of ["operator", "settlement", "*"]) {
      const res = OperatorBindingDTOSchema.safeParse({ ...binding(), moneyAuthority });
      expect(res.success, moneyAuthority).toBe(false);
    }
  });

  it("masks payout destinations and rejects an unmasked address", () => {
    expect(maskPayoutDestination("0x282Fa9C122b433864f8C8a8F2EfE411b52067539")).toBe("0x282F…7539");
    expect(maskPayoutDestination("acct-1234")).toBe("…34");
    const leaked = binding();
    leaked.payee = { ...leaked.payee!, maskedDestination: "0x282Fa9C122b433864f8C8a8F2EfE411b52067539" };
    expect(OperatorBindingDTOSchema.safeParse(leaked).success).toBe(false);
  });

  it("derives claim rights from bindings: an unbound type cannot be claimable", () => {
    const res = OperatorBindingDTOSchema.safeParse(
      binding({ executionAuthority: { canClaimCapabilityTypes: ["pcc://capabilities/hplc/v1"] } }),
    );
    expect(res.success).toBe(false);
  });

  it("rejects smuggled fields such as key scopes", () => {
    expect(OperatorBindingDTOSchema.safeParse({ ...binding(), scopes: ["*"] }).success).toBe(false);
  });
});

// ── OpportunityDTO fixtures: one per kind ───────────────────────────

function kitRequest(overrides: Partial<KitBuildRequestDTO> = {}): KitBuildRequestDTO {
  return {
    schema: OPPORTUNITY_SCHEMA,
    id: "offer-1",
    kind: "kit_build_request",
    capabilityType: "pcc://capabilities/hplc/v1",
    title: "Build a reusable HPLC kit",
    reward: { amount: "250000000", currency: "USDC", fundingStatus: "unfunded" },
    kitRef: null,
    authority: "derived_signal",
    asOf: "2026-09-24T12:00:00Z",
    ...overrides,
  };
}

function fundedOffer(overrides: Partial<FundedOfferDTO> = {}): FundedOfferDTO {
  return {
    schema: OPPORTUNITY_SCHEMA,
    id: "offer-2",
    kind: "funded_offer",
    capabilityType: "pcc://capabilities/hplc/v1",
    capabilityContractDigest: H("d"),
    title: "Run an HPLC purity assay",
    reward: { amount: "40000000", currency: "USDC", fundingStatus: "funded" },
    fundingRef: { kind: "escrow", id: "esc-1" },
    kitRef: { kitDigest: H("c"), name: "HPLC kit" },
    authority: "authoritative",
    asOf: "2026-09-24T12:00:00Z",
    ...overrides,
  };
}

/**
 * A demand aggregate whose id and title are derived, as its producer must derive them.
 * It defaults to a BUILT-IN capability and to instants in the past, so a default
 * aggregate stays valid and only the field a test changes can refuse it.
 */
function aggregate(
  o: {
    capabilityType?: string;
    demandBand?: OpportunityDemandBand;
    releasePeriod?: string;
    asOf?: string;
    releaseDigest?: SHA256;
  } = {},
): DemandAggregateDTO {
  const capabilityType = o.capabilityType ?? "pcc://capabilities/cnc-3axis/v2";
  const demandBand = o.demandBand ?? "5-9";
  const releasePeriod = o.releasePeriod ?? "2026-08";
  return {
    schema: OPPORTUNITY_SCHEMA,
    kind: "demand_aggregate",
    id: demandAggregateId(releasePeriod, capabilityType),
    capabilityType,
    title: demandAggregateTitle(capabilityType, demandBand, releasePeriod),
    demandBand,
    releasePeriod,
    releaseDigest: o.releaseDigest ?? H("e"),
    authority: "derived_signal",
    asOf: o.asOf ?? "2026-09-02T00:00:00Z",
  };
}

/** An evidence requirement that states its executability truthfully (evidenceIsExecutable). */
const evidence = (tier: 0 | 1 | 2 | 3, requiredPrimitives: CsdEvidencePrimitiveRef[]) => ({
  tier,
  requiredPrimitives,
  executable: evidenceIsExecutable(tier, requiredPrimitives),
});

const parses = (v: unknown) => OpportunityDTOSchema.safeParse(v).success;

describe("OpportunityDTO", () => {
  it("accepts an unfunded kit-build request, a funded offer bound to its funding record, and a derived demand aggregate", () => {
    expect(parses(kitRequest())).toBe(true);
    expect(parses(fundedOffer())).toBe(true);
    expect(parses(aggregate())).toBe(true);
  });

  it("the kinds are a strict discriminated union: no unknown kind, no field borrowed from another kind", () => {
    expect(parses({ ...kitRequest(), kind: "bounty" })).toBe(false);
    expect(parses({ ...kitRequest(), demandBand: "5-9" })).toBe(false);
    expect(parses({ ...aggregate(), fundingRef: { kind: "escrow", id: "esc-1" } })).toBe(false);
  });

  it("'funded' needs an authoritative source AND a funding record", () => {
    const funded = { amount: "1", currency: "USDC", fundingStatus: "funded" } as const;
    const esc = { kind: "escrow", id: "esc-9" } as const;
    expect(parses(kitRequest({ reward: funded }))).toBe(false);
    expect(parses(kitRequest({ reward: funded, authority: "authoritative" }))).toBe(false);
    expect(parses(kitRequest({ reward: funded, fundingRef: esc }))).toBe(false);
    expect(parses(kitRequest({ reward: funded, authority: "authoritative", fundingRef: esc }))).toBe(true);
    // Only funded work names a funding record.
    expect(parses(kitRequest({ fundingRef: esc }))).toBe(false);
  });

  it("a funded_offer must actually be funded, authoritative and bound to its record", () => {
    expect(parses({ ...fundedOffer(), reward: { amount: "1", currency: "USDC", fundingStatus: "unfunded" } })).toBe(false);
    expect(parses({ ...fundedOffer(), fundingRef: undefined })).toBe(false);
    expect(parses({ ...fundedOffer(), authority: "derived_signal" })).toBe(false);
  });

  it("a demand aggregate is a banded signal with no reward", () => {
    expect(parses({ ...aggregate(), reward: { amount: "1", currency: "USDC", fundingStatus: "unfunded" } })).toBe(false);
    expect(parses({ ...aggregate(), demandBand: undefined })).toBe(false);
    expect(parses({ ...aggregate(), authority: "authoritative" })).toBe(false);
  });

  it("a demand aggregate carries only derived public fields: no location, evidence, deadline, kitRef or capability digest", () => {
    expect(parses({ ...aggregate(), location: { country: "US" } })).toBe(false);
    expect(parses({ ...aggregate(), evidence: evidence(1, []) })).toBe(false);
    expect(parses({ ...aggregate(), deadline: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(parses({ ...aggregate(), kitRef: null })).toBe(false);
    expect(parses({ ...aggregate(), capabilityContractDigest: H("e") })).toBe(false);
  });

  it("never carries requester data, float amounts, multi-line titles or fine-grained locations", () => {
    expect(parses({ ...kitRequest(), requesterId: "alice@example.com" })).toBe(false);
    expect(parses(kitRequest({ reward: { amount: "12.5", currency: "USDC", fundingStatus: "unfunded" } }))).toBe(false);
    expect(parses(kitRequest({ title: "need hplc\nplease call 555" }))).toBe(false);
    expect(parses(kitRequest({ location: { country: "US", region: "CA", ...({ lat: 37.7 } as object) } }))).toBe(false);
    expect(parses(kitRequest({ location: { country: "usa" } }))).toBe(false);
  });
});

describe("v0 amendment 1 (2026-09-29): A2, A3, A5, A6", () => {
  it("A2: a funded_offer must pin the capabilityContractDigest", () => {
    expect(parses(fundedOffer())).toBe(true);
    expect(parses({ ...fundedOffer(), capabilityContractDigest: undefined })).toBe(false);
    expect(parses({ ...fundedOffer(), capabilityContractDigest: "sha256:XYZ" })).toBe(false);
  });

  it("A2: the pin is optional on a kit_build_request and forbidden on a demand_aggregate", () => {
    expect(parses(kitRequest())).toBe(true);
    expect(parses(kitRequest({ capabilityContractDigest: H("e") }))).toBe(true);
    expect(parses({ ...aggregate(), capabilityContractDigest: H("e") })).toBe(false);
  });

  it("A3: requiredPrimitives uses the CSD evidence-primitive grammar with active ids only", () => {
    const withEvidence = (e: unknown) => ({ ...kitRequest(), evidence: e });
    expect(parses(withEvidence(evidence(1, [{ id: "artifact.hash" }, { id: "ident.registered_key", bind: "source" }])))).toBe(true);
    expect(parses(withEvidence(evidence(1, [{ id: "made.up_primitive" }])))).toBe(false);
    expect(parses(withEvidence({ tier: 1, requiredPrimitives: [{ id: "artifact.hash", smuggled: true }], executable: false }))).toBe(false);
    // The v0 field name is gone; a strict schema refuses it.
    expect(parses(withEvidence({ tier: 1, requiredPrimitives: [], executable: true, requiredEventClasses: ["photo"] }))).toBe(false);
  });

  it("A5: a demand_aggregate needs a well-formed releasePeriod; no other kind carries one", () => {
    expect(parses(aggregate())).toBe(true);
    expect(parses({ ...aggregate(), releasePeriod: undefined })).toBe(false);
    for (const bad of ["2026-13", "2026-9", "26-09", "2026-09-01", "1999-12"]) {
      expect(parses(aggregate({ releasePeriod: bad })), bad).toBe(false);
    }
    expect(parses({ ...fundedOffer(), releasePeriod: "2026-09" })).toBe(false);
  });

  it("A6: artifact names are safe relative paths, so an installer can't be walked out of the kit", async () => {
    const withName = (name: string) =>
      liquidHandlingKit({
        artifacts: [...liquidHandlingKit().artifacts, { role: "docs", name, mediaType: "text/markdown", digest: H("9") }],
      });
    for (const ok of ["README.md", "tests/test_method_plan.py", "labware/pcc_carrier_24_tube_2ml_screwcap.json"]) {
      expect(CapabilityKitManifestV1Schema.safeParse(withName(ok)).success, ok).toBe(true);
    }
    for (const bad of ["../x", "../../etc/passwd", "/etc/passwd", "a/../b", "a\\b", "./a", "a//b", "a/", "tests/.."]) {
      expect(CapabilityKitManifestV1Schema.safeParse(withName(bad)).success, bad).toBe(false);
      await expect(computeKitDigest(withName(bad)), bad).rejects.toThrow();
    }
  });
});

describe("v0 amendment 1 (2026-09-29): A1, capability types are CSD urls", () => {
  it("a binding's capabilityType must be a CSD url, not a legacy type string", () => {
    const legacy = binding();
    legacy.bindings = [{ ...legacy.bindings[0]!, capabilityType: "3d-printing" }];
    legacy.executionAuthority = { canClaimCapabilityTypes: [] };
    expect(OperatorBindingDTOSchema.safeParse(legacy).success).toBe(false);
  });

  it("claim rights must be CSD urls as well", () => {
    const res = OperatorBindingDTOSchema.safeParse(binding({ executionAuthority: { canClaimCapabilityTypes: ["liquid-handling"] } }));
    expect(res.success).toBe(false);
  });

  it("unmappedCapacity lists legacy capacity honestly and is required", () => {
    const withUnmapped = binding({ unmappedCapacity: [{ kind: "kernel", id: "kernel-fdm-b", legacyType: "3d-printing" }] });
    expect(OperatorBindingDTOSchema.safeParse(withUnmapped).success).toBe(true);
    const { unmappedCapacity: _drop, ...missing } = binding();
    expect(OperatorBindingDTOSchema.safeParse(missing).success).toBe(false);
    const smuggled = binding({ unmappedCapacity: [{ kind: "kernel", id: "k", legacyType: "x", ...({ claimable: true } as object) }] });
    expect(OperatorBindingDTOSchema.safeParse(smuggled).success).toBe(false);
  });

  it("unmapped capacity can never become claimable", () => {
    const res = OperatorBindingDTOSchema.safeParse(
      binding({
        unmappedCapacity: [{ kind: "kernel", id: "kernel-fdm-b", legacyType: "3d-printing" }],
        executionAuthority: { canClaimCapabilityTypes: ["pcc://capabilities/liquid-handling/v1", "3d-printing"] },
      }),
    );
    expect(res.success).toBe(false);
  });
});

describe("v0 amendment 1 (2026-09-29): A7, onboarding artifact roles", () => {
  it("a device kit can carry its intake schema and safety envelope as artifacts", async () => {
    const kit = liquidHandlingKit({
      artifacts: [
        ...liquidHandlingKit().artifacts,
        { role: "intake-schema", name: "intake/device-intake.schema.json", mediaType: "application/schema+json", digest: H("7") },
        { role: "safety-envelope", name: "safety-envelope.json", mediaType: "application/json", digest: H("8") },
      ],
    });
    expect(CapabilityKitManifestV1Schema.safeParse(kit).success).toBe(true);
    await expect(computeKitDigest(kit)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("an unknown role is still refused", () => {
    const kit = liquidHandlingKit({
      artifacts: [...liquidHandlingKit().artifacts, { role: "wishlist" as never, name: "x.json", mediaType: "application/json", digest: H("7") }],
    });
    expect(CapabilityKitManifestV1Schema.safeParse(kit).success).toBe(false);
  });
});

// ── astra pack 112 findings (each reproduced first on b9f3491d) ─────────────
describe("pack 112 reproductions", () => {
  it("CRITICAL 1: a demand_aggregate carries no free text, invented id, kitRef or invented slug", () => {
    expect(parses(aggregate())).toBe(true);
    expect(parses({ ...aggregate(), id: "alice-example-com" })).toBe(false);
    expect(parses({ ...aggregate(), title: "Alice needs HPLC at 123 Main St" })).toBe(false);
    expect(parses({ ...aggregate(), kitRef: { kitDigest: H("c"), name: "alice@example.com" } })).toBe(false);
    // A title that overstates the band is not the derived title.
    expect(parses({ ...aggregate(), title: demandAggregateTitle("pcc://capabilities/cnc-3axis/v2", "100+", "2026-08") })).toBe(false);
    // Invented slugs, with id and title derived by the helper: a name, a date, an overlong slug.
    for (const slug of ["alice-at-123-main-st", "hplc-2026", "a".repeat(41)]) {
      expect(parses(aggregate({ capabilityType: `pcc://capabilities/${slug}/v1` })), slug).toBe(false);
    }
  });

  it("HIGH 2: completeness is structural only, needs a real SPDX expression and distinct required artifacts", () => {
    const same = H("5");
    const kit = liquidHandlingKit({
      artifacts: [
        { role: "adapter", name: "a.py", mediaType: "text/x-python", digest: same },
        { role: "tests", name: "t.py", mediaType: "text/x-python", digest: same },
        { role: "install-recipe", name: "i.md", mediaType: "text/markdown", digest: same },
        { role: "provenance-recipe", name: "p.json", mediaType: "application/json", digest: same },
      ],
      economics: { spdxLicense: "not-a-license" },
    });
    const res = validateKitCompleteness(CapabilityKitManifestV1Schema.parse(kit));
    expect(res.complete).toBe(false);
    expect(res.missing).toEqual(expect.arrayContaining(["license", "distinct-artifacts"]));
  });

  it("HIGH 2: license expressions: allow-listed ids (ASCII case-insensitive), LicenseRef-, AND/OR, WITH, parentheses", () => {
    for (const ok of [
      "Apache-2.0",
      "mit",
      "MIT OR Apache-2.0",
      "GPL-2.0-only WITH Classpath-exception-2.0",
      "(MIT AND CC-BY-4.0) OR LicenseRef-acme-1",
      "CERN-OHL-S-2.0",
    ]) {
      expect(isAllowedLicenseExpression(ok), ok).toBe(true);
    }
    for (const bad of ["not-a-license", "", "MIT OR", "(MIT", "MIT)", "MIT WITH not-an-exception", "MIT and Apache-2.0", "MIT Apache-2.0", "MİT"]) {
      expect(isAllowedLicenseExpression(bad), bad).toBe(false);
    }
    expect(validateKitCompleteness(liquidHandlingKit({ economics: { spdxLicense: "MIT OR Apache-2.0" } })).complete).toBe(true);
  });

  it("HIGH 3: 'funded' needs an authoritative funding-record reference, not just strings", () => {
    expect(parses({ ...fundedOffer(), fundingRef: undefined })).toBe(false);
    expect(parses(fundedOffer())).toBe(true);
    expect(parses({ ...fundedOffer(), fundingRef: { kind: "escrow", id: "" } })).toBe(false);
    expect(parses({ ...fundedOffer(), fundingRef: { kind: "invoice", id: "inv-1" } })).toBe(false);
  });

  it("HIGH 4: executable requirements admit only live primitives, and params must match the primitive", () => {
    const withReq = (e: unknown) => ({ ...fundedOffer(), evidence: e });
    // artifact.hash is active but its verifier is a stub: a funded offer can't require it,
    // whether the requirement claims to be executable or admits it is not.
    expect(parses(withReq({ tier: 1, requiredPrimitives: [{ id: "artifact.hash" }], executable: true }))).toBe(false);
    expect(parses(withReq({ tier: 1, requiredPrimitives: [{ id: "artifact.hash" }], executable: false }))).toBe(false);
    expect(parses(withReq(evidence(0, [{ id: "decl.self_attested" }])))).toBe(true);
    // An unfunded kit request may describe stub requirements, but only as non-executable.
    const stub = [{ id: "capture.photo_nonced", params: { media: "photo", minClass: "CC2" } }];
    expect(parses({ ...kitRequest(), evidence: evidence(2, stub) })).toBe(true);
    expect(parses({ ...kitRequest(), evidence: { ...evidence(2, stub), executable: true } })).toBe(false);
    // Params are checked against the primitive's paramsSchema: enum, required, additionalProperties.
    for (const params of [{ media: "photo", minClass: "CC999" }, { minClass: "CC2" }, { media: "photo", minClass: "CC2", extra: 1 }]) {
      const e = evidence(2, [{ id: "capture.photo_nonced", params }]);
      expect(parses({ ...kitRequest(), evidence: e }), JSON.stringify(params)).toBe(false);
    }
  });

  it("MEDIUM 5: payee masking is exact, and availability is a closed, typed shape", () => {
    const withPayee = (maskedDestination: string) => {
      const b = binding();
      b.payee = { ...b.payee!, maskedDestination };
      return b;
    };
    expect(OperatorBindingDTOSchema.safeParse(withPayee("0x282F…7539")).success).toBe(true);
    expect(OperatorBindingDTOSchema.safeParse(withPayee("…34")).success).toBe(true);
    for (const leak of [
      "0X282FA9C122B433864F8C8A8F2EFE411B52067539…",
      "acct-1234567890123456…",
      "0x282Fa9C122b433864f8C8a8F2EfE411b52067539",
      "0x282F……7539",
      "0x282F…75391",
    ]) {
      expect(OperatorBindingDTOSchema.safeParse(withPayee(leak)).success, leak).toBe(false);
    }
    const withAvailability = (availability: unknown) => {
      const b = binding();
      b.bindings = [{ ...b.bindings[0]!, availability: availability as never }];
      return b;
    };
    expect(OperatorBindingDTOSchema.safeParse(withAvailability({ mode: "cron", cron: "0 9 * * 1-5", timezone: "UTC" })).success).toBe(true);
    expect(OperatorBindingDTOSchema.safeParse(withAvailability(null)).success).toBe(true);
    for (const smuggle of [
      { moneyAuthority: "*", payoutDestination: "0x282Fa9C122b433864f8C8a8F2EfE411b52067539" },
      { mode: "delegate-to-agent", agentEndpoint: "https://agent.example/a2a" },
      { mode: "windows", windows: [{ start: "09:00", end: "17:00", scopes: ["*"] }] },
    ]) {
      expect(OperatorBindingDTOSchema.safeParse(withAvailability(smuggle)).success, JSON.stringify(smuggle)).toBe(false);
    }
  });

  it("MEDIUM 6: duplicate set entries and non-NFC text are rejected, not silently collapsed", async () => {
    const dupe = liquidHandlingKit({ compatibility: { interfaces: ["opentrons", "opentrons"] } });
    expect(CapabilityKitManifestV1Schema.safeParse(dupe).success).toBe(false);
    await expect(computeKitDigest(dupe)).rejects.toThrow();
    expect(CapabilityKitManifestV1Schema.safeParse(liquidHandlingKit({ declaredAssuranceTiers: [1, 2, 2] })).success).toBe(false);
    // "Pipetté": e + U+0301 (NFD) is refused; U+00E9 (NFC) is accepted.
    expect(CapabilityKitManifestV1Schema.safeParse(liquidHandlingKit({ name: "Pipetté kit" })).success).toBe(false);
    expect(CapabilityKitManifestV1Schema.safeParse(liquidHandlingKit({ name: "Pipetté kit" })).success).toBe(true);
  });

  it("MEDIUM 6: set-valued lists sort by Unicode code point, not by UTF-16 code unit", async () => {
    // UTF-16 order puts U+1F600 (surrogates 0xD83D 0xDE00) before U+FFFD; code-point order is the reverse.
    const kit = liquidHandlingKit({ compatibility: { interfaces: ["\u{1F600}", "�"] } });
    expect(normalizeKitManifest(kit).compatibility?.interfaces).toEqual(["�", "\u{1F600}"]);
    const swapped = liquidHandlingKit({ compatibility: { interfaces: ["�", "\u{1F600}"] } });
    expect(await computeKitDigest(swapped)).toBe(await computeKitDigest(kit));
  });

  it("MEDIUM 7: timestamps are real, and a release period closed before asOf", () => {
    expect(parses({ ...aggregate(), asOf: "yesterday" })).toBe(false);
    expect(parses(aggregate({ asOf: "2026-08-15T00:00:00Z" }))).toBe(false); // the period is still open
    expect(parses(aggregate({ asOf: "2026-08-31T23:59:59Z" }))).toBe(false); // its last second
    expect(parses(aggregate({ asOf: "2026-09-01T00:00:00+02:00" }))).toBe(false); // 22:00Z on the 31st
    expect(parses(aggregate({ asOf: "2026-09-01T00:00:00Z" }))).toBe(true); // the first instant after it
    expect(parses(aggregate({ releasePeriod: "2099-12" }))).toBe(false); // a future period
    expect(parses(kitRequest({ asOf: "2026-09-24" }))).toBe(false);
    expect(parses(kitRequest({ deadline: "next week" }))).toBe(false);
    expect(OperatorBindingDTOSchema.safeParse(binding({ asOf: "now" })).success).toBe(false);
    const stale = binding();
    stale.bindings = [{ ...stale.bindings[0]!, lastSeenAt: "a while ago" }];
    expect(OperatorBindingDTOSchema.safeParse(stale).success).toBe(false);
  });
});

// ── astra pack 112b (verdict on 072f9a17): each reproduction was run first on that head ──
describe("astra pack 112b", () => {
  // Independent of the implementation: sorted-key canonical JSON hashed by node:crypto, so the
  // digests below do not lean on util/canonical or @noble/hashes.
  const canon = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canon).join(",")}]`
      : v !== null && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(v);
  const digestOf = (v: unknown): SHA256 => `sha256:${createHash("sha256").update(canon(v), "utf8").digest("hex")}`;
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  /** An iterable that counts how many times it is iterated. */
  const counted = (items: string[]) => {
    const state = { iterations: 0 };
    return {
      state,
      iterable: {
        [Symbol.iterator]() {
          state.iterations++;
          return items[Symbol.iterator]();
        },
      } as Iterable<string>,
    };
  };
  const messagesOf = (v: unknown) => {
    const r = OpportunityDTOSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  // ── A. CRITICAL 1: public demand names only approved public capabilities, and names its release ──

  it("CRITICAL 1: a private slug (alice-smith) is refused as public demand", () => {
    const capabilityType = "pcc://capabilities/alice-smith/v1";
    // Slug syntax is not a privacy boundary: the url is well-formed, and so are its derived id and title.
    expect(isPublicCapabilityUrl(capabilityType)).toBe(true);
    expect(parses(aggregate({ capabilityType }))).toBe(false);
    // Membership is the ONLY reason: the same aggregate for a built-in passes, and nothing else is reported.
    expect(parses(aggregate())).toBe(true);
    expect(messagesOf(aggregate({ capabilityType }))).toEqual([
      "a demand_aggregate's capabilityType must be in the approved public capability set",
    ]);
  });

  it("the built-in public set is exactly the CSDs compiled into @pcc/spec, sorted by code unit and frozen", () => {
    // Pinned. document-print-and-mail/v1 is not in it: that is a draft workflow CSD which
    // loadBuiltinCsds does not register and the package build does not ship (only its own test imports it).
    expect([...BUILTIN_PUBLIC_CAPABILITY_URLS]).toEqual([
      "pcc://capabilities/2d-print/v1",
      "pcc://capabilities/cnc-3axis/v2",
      "pcc://capabilities/courier-route/v1",
      "pcc://capabilities/fdm/v2",
      "pcc://capabilities/hot-food-prep/v1",
      "pcc://capabilities/laser-cut/v2",
      "pcc://capabilities/make-pizza/v1",
      "pcc://capabilities/sla/v2",
    ]);
    // And it is what the registry itself says, filtered and sorted.
    const fromRegistry = loadBuiltinCsds().list().map((c) => c.url).filter((u) => isPublicCapabilityUrl(u));
    expect([...BUILTIN_PUBLIC_CAPABILITY_URLS]).toEqual([...new Set(fromRegistry)].sort(byCodeUnit));
    expect(Object.isFrozen(BUILTIN_PUBLIC_CAPABILITY_URLS)).toBe(true);
    for (const capabilityType of BUILTIN_PUBLIC_CAPABILITY_URLS) {
      expect(parses(aggregate({ capabilityType })), capabilityType).toBe(true);
    }
  });

  it("publicCapabilityUrls: the built-ins plus ACTIVE kits' csd urls, deduplicated, sorted by code unit and frozen", () => {
    expect([...publicCapabilityUrls()]).toEqual([...BUILTIN_PUBLIC_CAPABILITY_URLS]);
    const kitUrl = "pcc://capabilities/liquid-handling/v1";
    const urls = publicCapabilityUrls([kitUrl, "pcc://capabilities/fdm/v2", kitUrl]);
    expect([...urls]).toEqual([...BUILTIN_PUBLIC_CAPABILITY_URLS, kitUrl].sort(byCodeUnit));
    expect(Object.isFrozen(urls)).toBe(true);
    expect(() => (urls as string[]).push("pcc://capabilities/x/v1")).toThrow();
  });

  it("publicCapabilityUrls THROWS on any entry that is not a public capability url, and iterates its input once", () => {
    for (const bad of [
      42,
      null,
      undefined,
      {},
      "",
      "https://agent.example/claim",
      "alice@example.com",
      "pcc://capabilities/Alice/v1",
      "pcc://capabilities/hplc-2026/v1",
      "pcc://capabilities/a-b-c-d-e/v1",
      "pcc://capabilities/x/v1234567",
    ]) {
      expect(() => publicCapabilityUrls([bad as never]), String(bad)).toThrow(/entry 0 is not a public capability url/);
    }
    // A bad entry among good ones is never dropped silently.
    expect(() => publicCapabilityUrls(["pcc://capabilities/liquid-handling/v1", "pcc://capabilities/hplc-2026/v1"])).toThrow(/entry 1/);
    // An object is not a string even when its text is a public capability url.
    const lookalike = { toString: () => "pcc://capabilities/alice-smith/v1" };
    expect(() => publicCapabilityUrls([lookalike as never])).toThrow(/entry 0/);
    const input = counted(["pcc://capabilities/liquid-handling/v1"]);
    expect(publicCapabilityUrls(input.iterable)).toContain("pcc://capabilities/liquid-handling/v1");
    expect(input.state.iterations).toBe(1);
  });

  it("approvedSetDigest is byte-identical to #365's: pinned by a golden vector over a fixed two-url list", () => {
    // #365 (kit-demand.ts) hashes canonicalize(ids): the publishable urls, deduplicated, sorted by code unit.
    // Here, independently: the JSON text of that array (strings only) hashed by node:crypto.
    const urls = ["pcc://capabilities/fdm/v2", "pcc://capabilities/cnc-3axis/v2"];
    const sorted = ["pcc://capabilities/cnc-3axis/v2", "pcc://capabilities/fdm/v2"];
    const independent = `sha256:${createHash("sha256").update(Buffer.from(JSON.stringify(sorted), "utf8")).digest("hex")}`;
    expect(approvedSetDigest(urls)).toBe(independent);
    expect(approvedSetDigest(urls)).toBe("sha256:d8db4afb1321319fe719596fbdfeb2422ff154e56771c610c471de1412120762");
    // Order, repeats and entries that are not public capability urls do not change it; a different set does.
    expect(approvedSetDigest([...sorted, ...urls])).toBe(independent);
    expect(approvedSetDigest([...urls, "pcc://capabilities/hplc-2026/v1", "not a url", 42 as never])).toBe(independent);
    const lookalike = { toString: () => "pcc://capabilities/alice-smith/v1" };
    expect(approvedSetDigest([...urls, lookalike as never])).toBe(independent);
    expect(approvedSetDigest([...urls, "pcc://capabilities/sla/v2"])).not.toBe(independent);
    expect(approvedSetDigest([])).toBe(`sha256:${createHash("sha256").update("[]").digest("hex")}`);
    const input = counted(urls);
    expect(approvedSetDigest(input.iterable)).toBe(independent);
    expect(input.state.iterations).toBe(1);
  });

  it("opportunityDTOSchemaFor: a demand_aggregate must be IN the set the schema was built with", () => {
    const hplc = "pcc://capabilities/hplc/v1";
    expect(parses(aggregate({ capabilityType: hplc }))).toBe(false); // not a built-in
    const forKits = opportunityDTOSchemaFor(publicCapabilityUrls([hplc]));
    expect(forKits.safeParse(aggregate({ capabilityType: hplc })).success).toBe(true);
    expect(forKits.safeParse(aggregate()).success).toBe(true); // the built-ins stay
    expect(opportunityDTOSchemaFor([hplc]).safeParse(aggregate()).success).toBe(false); // only what it was given
    // Membership applies to demand only: funded work and kit requests may name any capability url.
    expect(parses(fundedOffer())).toBe(true);
    expect(parses(kitRequest())).toBe(true);
  });

  it("opportunityDTOSchemaFor snapshots the set once: later changes, and a lying has(), widen nothing", () => {
    const hplc = "pcc://capabilities/hplc/v1";
    const lathe = "pcc://capabilities/lathe/v1";
    const set = new Set([hplc]);
    const schema = opportunityDTOSchemaFor(set);
    set.add(lathe);
    set.delete(hplc);
    expect(schema.safeParse(aggregate({ capabilityType: hplc })).success).toBe(true);
    expect(schema.safeParse(aggregate({ capabilityType: lathe })).success).toBe(false);
    class LyingSet extends Set<string> {
      override has(): boolean {
        return true;
      }
    }
    const liar = opportunityDTOSchemaFor(new LyingSet([hplc]));
    expect(liar.safeParse(aggregate({ capabilityType: hplc })).success).toBe(true);
    expect(liar.safeParse(aggregate({ capabilityType: lathe })).success).toBe(false);
    // Only strings that pass isPublicCapabilityUrl enter the snapshot.
    const syntactic = opportunityDTOSchemaFor(["pcc://capabilities/hplc-2026/v1", 42 as never]);
    expect(syntactic.safeParse(aggregate({ capabilityType: "pcc://capabilities/hplc-2026/v1" })).success).toBe(false);
    // ...and an object whose text is a public capability url is not a string, so it does not enter either.
    const lookalike = { toString: () => "pcc://capabilities/alice-smith/v1" };
    const objectOnly = opportunityDTOSchemaFor([lookalike as never]);
    expect(objectOnly.safeParse(aggregate({ capabilityType: "pcc://capabilities/alice-smith/v1" })).success).toBe(false);
    const input = counted([hplc]);
    opportunityDTOSchemaFor(input.iterable);
    expect(input.state.iterations).toBe(1);
  });

  it("a demand_aggregate carries the releaseDigest of its release record, and no other kind does", () => {
    const { releaseDigest: _omitted, ...without } = aggregate();
    expect(parses(without)).toBe(false);
    for (const bad of ["", "sha256:abc", `sha256:${"E".repeat(64)}`, "e".repeat(64), `sha1:${"e".repeat(40)}`]) {
      expect(parses({ ...aggregate(), releaseDigest: bad }), bad).toBe(false);
    }
    expect(parses({ ...fundedOffer(), releaseDigest: H("e") })).toBe(false);
    expect(parses({ ...kitRequest(), releaseDigest: H("e") })).toBe(false);
  });

  describe("demandAggregatesFromRelease", () => {
    const period = "2026-08";
    const asOf = "2026-09-02T00:00:00Z";
    const liquid = "pcc://capabilities/liquid-handling/v1";
    const cnc = "pcc://capabilities/cnc-3axis/v2";
    const approved = publicCapabilityUrls([liquid]);
    const aggregateRecord = (capabilityType: string, demandBand: OpportunityDemandBand = "5-9", p = period) => ({
      schema: "pcc.public-opportunity-aggregate.v1" as const,
      capabilityType,
      demandBand,
      countedEvidence: "authenticated_order",
      period: p,
    });
    /** A release built the way #365's buildPublicRelease builds one, with both digests computed independently. */
    const buildRelease = (
      aggregates: ReturnType<typeof aggregateRecord>[],
      approvedUrls: readonly string[] = approved,
      p = period,
    ): PublicOpportunityReleaseRecord => {
      const body = {
        schema: "pcc.public-opportunity-release.v1" as const,
        period: p,
        policy: { k: 5, evidenceFloor: "authenticated_order" },
        approvedSetDigest: digestOf([...new Set(approvedUrls.filter((u) => isPublicCapabilityUrl(u)))].sort(byCodeUnit)),
        aggregates,
      };
      return { ...body, digest: digestOf(body) };
    };
    const refused = (release: unknown, urls: Iterable<string> = approved, when = asOf) =>
      expect(() => demandAggregatesFromRelease(release as PublicOpportunityReleaseRecord, urls, when));

    it("accepts a hand-built release whose digests were computed independently", () => {
      const release = buildRelease([aggregateRecord(cnc, "10-24"), aggregateRecord(liquid, "100+")]);
      const dtos = demandAggregatesFromRelease(release, approved, asOf);
      expect(dtos).toEqual([
        {
          schema: OPPORTUNITY_SCHEMA,
          kind: "demand_aggregate",
          id: "demand:2026-08:cnc-3axis:v2",
          capabilityType: cnc,
          title: "Demand for cnc-3axis v2: 10-24 verified requesters (2026-08)",
          demandBand: "10-24",
          releasePeriod: period,
          releaseDigest: release.digest,
          authority: "derived_signal",
          asOf,
        },
        {
          schema: OPPORTUNITY_SCHEMA,
          kind: "demand_aggregate",
          id: "demand:2026-08:liquid-handling:v1",
          capabilityType: liquid,
          title: "Demand for liquid-handling v1: 100+ verified requesters (2026-08)",
          demandBand: "100+",
          releasePeriod: period,
          releaseDigest: release.digest,
          authority: "derived_signal",
          asOf,
        },
      ]);
      const schema = opportunityDTOSchemaFor(approved);
      for (const d of dtos) expect(schema.safeParse(d).success).toBe(true);
      expect(demandAggregatesFromRelease(buildRelease([]), approved, asOf)).toEqual([]);
    });

    it("iterates the approved set once, so a one-shot generator works", () => {
      const input = counted([...approved]);
      expect(demandAggregatesFromRelease(buildRelease([aggregateRecord(cnc)]), input.iterable, asOf)).toHaveLength(1);
      expect(input.state.iterations).toBe(1);
      function* once() {
        yield* approved;
      }
      expect(demandAggregatesFromRelease(buildRelease([aggregateRecord(cnc)]), once(), asOf)).toHaveLength(1);
    });

    it("throws on a tampered digest, and on content changed after the digest was computed", () => {
      const release = buildRelease([aggregateRecord(cnc)]);
      refused({ ...release, digest: H("0") }).toThrow(/digest does not match/);
      refused({ ...release, aggregates: [aggregateRecord(cnc, "100+")] }).toThrow(/digest does not match/);
      refused({ ...release, period: "2026-07", aggregates: [aggregateRecord(cnc, "5-9", "2026-07")] }).toThrow(/digest does not match/);
    });

    it("throws when the release was built with a different approved set", () => {
      const forBuiltins = buildRelease([aggregateRecord(cnc)], BUILTIN_PUBLIC_CAPABILITY_URLS);
      refused(forBuiltins, approved).toThrow(/different approved set/);
      refused(buildRelease([aggregateRecord(cnc)], approved), BUILTIN_PUBLIC_CAPABILITY_URLS).toThrow(/different approved set/);
      expect(demandAggregatesFromRelease(forBuiltins, BUILTIN_PUBLIC_CAPABILITY_URLS, asOf)).toHaveLength(1);
    });

    it("throws on an aggregate whose capabilityType is outside the approved set", () => {
      // Both digests are valid: only the membership check stands between this record and a DTO.
      const release = buildRelease([aggregateRecord("pcc://capabilities/alice-smith/v1")]);
      refused(release).toThrow(/aggregate 0 is not an approved public capability/);
      refused(buildRelease([aggregateRecord(cnc), aggregateRecord("pcc://capabilities/hplc/v1")])).toThrow(/aggregate 1 is not an approved/);
    });

    it("throws on an aggregate for a different period than the record", () => {
      refused(buildRelease([aggregateRecord(cnc, "5-9", "2026-07")])).toThrow(/aggregate 0 is for a different period/);
    });

    it("throws on a record that is not exactly a pcc.public-opportunity-release.v1", () => {
      const release = buildRelease([aggregateRecord(cnc)]);
      const notARecord = /not a pcc.public-opportunity-release.v1 record/;
      for (const bad of [null, undefined, "release", [], {}, { ...release, schema: "pcc.public-opportunity-release.v2" }]) {
        refused(bad).toThrow(notARecord);
      }
      refused({ ...release, note: "extra" }).toThrow(notARecord);
      refused({ ...release, policy: { ...release.policy, floorHint: 1 } }).toThrow(notARecord);
      refused({ ...release, aggregates: [{ ...aggregateRecord(cnc), requester: "alice" }] }).toThrow(notARecord);
      refused(buildRelease([aggregateRecord(cnc, "1-4" as never)])).toThrow(notARecord);
      refused(buildRelease([], approved, "2026-13")).toThrow(notARecord);
      refused({ ...release, aggregates: undefined }).toThrow(notARecord);
    });

    it("throws on a repeated capabilityType", () => {
      refused(buildRelease([aggregateRecord(cnc), aggregateRecord(cnc, "10-24")])).toThrow(/aggregate 1 repeats a capability type/);
    });

    it("throws when a DTO would be invalid: an asOf before the period closed, or not a timestamp", () => {
      const release = buildRelease([aggregateRecord(cnc)]);
      refused(release, approved, "2026-08-15T00:00:00Z").toThrow(/aggregate 0 is not a valid demand_aggregate/);
      refused(release, approved, "yesterday").toThrow(/aggregate 0 is not a valid demand_aggregate/);
    });
  });

  // ── B. HIGH 4: "executable" means tier-eligible with live verifiers ──

  it("HIGH 4a: an empty tier-3 primitive set is not executable", () => {
    expect(evidenceIsExecutable(3, [])).toBe(false);
    expect(parses({ ...fundedOffer(), evidence: { tier: 3, requiredPrimitives: [], executable: true } })).toBe(false);
    // Saying so truthfully does not help a funded offer, which needs executable evidence...
    expect(parses({ ...fundedOffer(), evidence: { tier: 3, requiredPrimitives: [], executable: false } })).toBe(false);
    // ...but an unfunded kit request may describe a requirement that cannot be checked yet.
    expect(parses({ ...kitRequest(), evidence: { tier: 3, requiredPrimitives: [], executable: false } })).toBe(true);
  });

  it("HIGH 4b: decl.self_attested (tier 0 only) is not an executable tier-3 requirement", () => {
    const decl = [{ id: "decl.self_attested" }];
    expect(evidenceIsExecutable(3, decl)).toBe(false);
    expect(parses({ ...fundedOffer(), evidence: { tier: 3, requiredPrimitives: decl, executable: true } })).toBe(false);
    expect(parses({ ...kitRequest(), evidence: { tier: 3, requiredPrimitives: decl, executable: false } })).toBe(true);
  });

  it("HIGH 4c: an unsupported params-schema construct fails closed", () => {
    expect(validatePrimitiveParams({ oneOf: [{ type: "string" }] }, 42)).toBe(false);
    expect(validatePrimitiveParams({ type: "string", pattern: "^a$" }, "b")).toBe(false);
    // Refused even when the value would satisfy the construct: it is never silently skipped.
    expect(validatePrimitiveParams({ oneOf: [{ type: "string" }] }, "x")).toBe(false);
    expect(validatePrimitiveParams({ type: "string", pattern: "^a$" }, "a")).toBe(false);
  });

  it("executable means tier-eligible with live verifiers: the tier 0 floor, a tier 2 and 3 positive case, and the rules behind them", () => {
    const decl = { id: "decl.self_attested" };
    const payer = { id: "approval.payer" };
    // Tier 0 is the permissionless floor, with or without the declaration primitive.
    expect(evidenceIsExecutable(0, [])).toBe(true);
    expect(evidenceIsExecutable(0, [decl])).toBe(true);
    // approval.payer is live, Family G, supports tiers 2 and 3 and has no dependency: a complete set there.
    expect(evidenceIsExecutable(2, [payer])).toBe(true);
    expect(evidenceIsExecutable(3, [payer])).toBe(true);
    expect(evidenceIsExecutable(3, [payer, payer])).toBe(true);
    // Only at the tiers it supports.
    expect(evidenceIsExecutable(0, [payer])).toBe(false);
    expect(evidenceIsExecutable(1, [payer])).toBe(false);
    // From tier 1 up the set is non-empty, and the declaration primitive alone is a tier 0 floor.
    for (const tier of [1, 2, 3] as const) {
      expect(evidenceIsExecutable(tier, []), `empty at tier ${tier}`).toBe(false);
      expect(evidenceIsExecutable(tier, [decl]), `decl at tier ${tier}`).toBe(false);
    }
    // Dependency closure: confirm.execution_mode is live and supports tier 2, but needs receipt.kernel_signed in the set.
    expect(evidenceIsExecutable(2, [payer, { id: "confirm.execution_mode" }])).toBe(false);
    // A stub verifier (even a Family-G one), an unknown id and a stub dependency are not executable.
    expect(evidenceIsExecutable(2, [{ id: "approval.expert" }])).toBe(false);
    expect(evidenceIsExecutable(2, [payer, { id: "capture.photo_nonced" }])).toBe(false);
    expect(evidenceIsExecutable(2, [payer, { id: "made.up_primitive" }])).toBe(false);
    // At the time of writing no tier 1 set is executable: the live tier 1 primitives (receipt.kernel_signed,
    // confirm.execution_mode) depend on ident.registered_key, whose verifier is a stub.
  });

  it("the executable flag must equal evidenceIsExecutable, in both directions, and funded kinds need it true", () => {
    const payer = { id: "approval.payer" };
    const truthful = "executable must be true exactly when requiredPrimitives is a complete tier-eligible set with live verifiers (evidenceIsExecutable)";
    // A funded offer with an executable tier 2 requirement (params checked against the primitive) and a tier 0 floor.
    expect(parses({ ...fundedOffer(), evidence: evidence(2, [payer]) })).toBe(true);
    expect(parses({ ...fundedOffer(), evidence: evidence(2, [{ id: "approval.payer", params: { approverRole: "payer", claimIds: ["c-1"] } }]) })).toBe(true);
    expect(parses({ ...fundedOffer(), evidence: evidence(0, []) })).toBe(true);
    expect(parses({ ...fundedOffer(), evidence: evidence(0, [{ id: "decl.self_attested" }]) })).toBe(true);
    // Claiming executable for a set that is not, and claiming non-executable for one that is, are both refused.
    expect(messagesOf({ ...kitRequest(), evidence: { tier: 2, requiredPrimitives: [payer], executable: false } })).toEqual([truthful]);
    expect(messagesOf({ ...kitRequest(), evidence: { tier: 1, requiredPrimitives: [], executable: true } })).toEqual([truthful]);
    // A funded kit_build_request is held to the same standard as a funded offer.
    const funded = { reward: { amount: "1", currency: "USDC", fundingStatus: "funded" }, authority: "authoritative", fundingRef: { kind: "escrow", id: "esc-9" } } as const;
    expect(parses({ ...kitRequest(), ...funded, evidence: evidence(2, [payer]) })).toBe(true);
    expect(messagesOf({ ...kitRequest(), ...funded, evidence: evidence(1, []) })).toEqual([
      "a funded kit_build_request's evidence must be executable (see evidenceIsExecutable)",
    ]);
    expect(messagesOf({ ...fundedOffer(), evidence: evidence(1, []) })).toEqual([
      "a funded_offer's evidence must be executable (see evidenceIsExecutable)",
    ]);
  });

  it("primitivesAreExecutable stays exported, as a necessary condition only", () => {
    expect(primitivesAreExecutable([])).toBe(true); // vacuous, yet evidenceIsExecutable(3, []) is false
    expect(primitivesAreExecutable([{ id: "decl.self_attested" }])).toBe(true); // live, yet not tier-3 eligible
    expect(primitivesAreExecutable([{ id: "artifact.hash" }])).toBe(false); // a stub verifier
    expect(evidenceIsExecutable(3, [])).toBe(false);
    expect(evidenceIsExecutable(3, [{ id: "decl.self_attested" }])).toBe(false);
  });

  it("validatePrimitiveParams fails closed: any keyword outside the supported set refuses the params", () => {
    const ok = (schema: Record<string, unknown>, value: unknown) => validatePrimitiveParams(schema, value);
    // Every unsupported keyword is refused even where the value satisfies the rest of the schema.
    const unsupported: Array<[string, unknown]> = [
      ["oneOf", [{ type: "string" }]],
      ["anyOf", [{ type: "string" }]],
      ["allOf", [{ type: "string" }]],
      ["not", { type: "number" }],
      ["$ref", "#/definitions/x"],
      ["pattern", "^x$"],
      ["format", "email"],
      ["minimum", 0],
      ["maximum", 9],
      ["minLength", 1],
      ["maxLength", 9],
      ["const", "x"],
      ["if", { type: "string" }],
      ["multipleOf", 1],
      ["minItems", 0],
      ["uniqueItems", true],
      ["patternProperties", {}],
      ["dependencies", {}],
    ];
    for (const [keyword, arg] of unsupported) {
      expect(ok({ type: "string", [keyword]: arg }, "x"), keyword).toBe(false);
    }
    // An unknown or array type, or a missing type with any other keyword, is refused.
    for (const type of ["null", "any", "String", ["string"], ["string", "null"], 1, null]) {
      expect(ok({ type }, "x"), JSON.stringify(type)).toBe(false);
    }
    expect(ok({ enum: ["x"] }, "x")).toBe(false);
    expect(ok({ properties: {} }, {})).toBe(false);
    expect(ok({ required: [] }, {})).toBe(false);
    // "Any value" (no type, or annotations only) is refused: no active primitive uses one.
    expect(ok({}, "x")).toBe(false);
    expect(ok({ description: "anything" }, "x")).toBe(false);
    expect(ok({ default: 1, examples: [1] }, 1)).toBe(false);
    // A malformed supported keyword is refused, whatever the node's type.
    for (const bad of [
      { type: "object", required: "a" },
      { type: "object", required: [1] },
      { type: "object", properties: [] },
      { type: "object", properties: "x" },
      { type: "object", additionalProperties: "no" },
      { type: "object", additionalProperties: null },
      { type: "object", additionalProperties: [] },
      { type: "array", items: "x" },
      { type: "array", items: [{ type: "string" }] }, // the tuple form
      { type: "string", enum: "abc" },
      { type: "string", properties: [] },
    ]) {
      expect(ok(bad, bad.type === "array" ? [] : bad.type === "string" ? "abc" : {}), JSON.stringify(bad)).toBe(false);
    }
    expect(ok("x" as never, "x")).toBe(false);
    expect(ok(null as never, "x")).toBe(false);
  });

  it("validatePrimitiveParams still evaluates what it supports, ignores annotations, and checks the nodes a value reaches", () => {
    const ok = (schema: Record<string, unknown>, value: unknown) => validatePrimitiveParams(schema, value);
    // Annotations carry no validation.
    expect(ok({ type: "string", description: "d", title: "t", $comment: "c", examples: ["a"], default: "a" }, "b")).toBe(true);
    // type and enum.
    expect(ok({ type: "string" }, "x")).toBe(true);
    expect(ok({ type: "string" }, 1)).toBe(false);
    expect(ok({ type: "string", enum: ["a", "b"] }, "b")).toBe(true);
    expect(ok({ type: "string", enum: ["a", "b"] }, "c")).toBe(false);
    expect(ok({ type: "number" }, 1.5)).toBe(true);
    expect(ok({ type: "number" }, Number.NaN)).toBe(false);
    expect(ok({ type: "number" }, Number.POSITIVE_INFINITY)).toBe(false);
    expect(ok({ type: "integer" }, 2)).toBe(true);
    expect(ok({ type: "integer" }, 1.5)).toBe(false);
    expect(ok({ type: "boolean" }, false)).toBe(true);
    expect(ok({ type: "boolean" }, "false")).toBe(false);
    // items: an object schema, checked per element.
    expect(ok({ type: "array", items: { type: "string" } }, ["a", "b"])).toBe(true);
    expect(ok({ type: "array", items: { type: "string" } }, ["a", 1])).toBe(false);
    expect(ok({ type: "array" }, [1, "a"])).toBe(true);
    expect(ok({ type: "array" }, "a")).toBe(false);
    // properties, required (own keys only) and additionalProperties.
    const obj = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(ok(obj, { a: "x" })).toBe(true);
    expect(ok(obj, {})).toBe(false);
    expect(ok(obj, { a: 1 })).toBe(false);
    expect(ok(obj, { a: "x", extra: 1 })).toBe(true); // additionalProperties absent: extras allowed
    expect(ok({ ...obj, additionalProperties: true }, { a: "x", extra: 1 })).toBe(true);
    expect(ok({ ...obj, additionalProperties: false }, { a: "x", extra: 1 })).toBe(false);
    expect(ok({ type: "object", required: ["toString"] }, {})).toBe(false); // an inherited key is not present
    // A property named like an inherited key is an ordinary extra property, never a schema from the prototype.
    expect(ok({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, JSON.parse('{"constructor":1}'))).toBe(false);
    expect(ok({ type: "object", properties: { a: { type: "string" } }, additionalProperties: true }, JSON.parse('{"constructor":1,"toString":2}'))).toBe(true);
    expect(ok({ type: "object", additionalProperties: { type: "number" } }, JSON.parse('{"constructor":1}'))).toBe(true);
    expect(ok({ type: "object", additionalProperties: { type: "number" } }, JSON.parse('{"constructor":"x"}'))).toBe(false);
    expect(ok({ type: "object" }, null)).toBe(false);
    expect(ok({ type: "object" }, [])).toBe(false);
    // additionalProperties as an object schema validates the extra properties.
    const typed = { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } };
    expect(ok(typed, { a: "x", b: 1, c: 2 })).toBe(true);
    expect(ok(typed, { a: "x", b: "y" })).toBe(false);
    expect(ok({ type: "object", additionalProperties: {} }, { b: 1 })).toBe(false); // {} would mean "any value"
    // Nodes the value does not reach are not evaluated; one it reaches with unsupported grammar refuses.
    const lazy = { type: "object", properties: { x: { oneOf: [{ type: "string" }] } }, additionalProperties: true };
    expect(ok(lazy, {})).toBe(true);
    expect(ok(lazy, { other: 1 })).toBe(true);
    expect(ok(lazy, { x: "s" })).toBe(false);
    expect(ok({ type: "array", items: { oneOf: [] } }, [])).toBe(true);
    expect(ok({ type: "array", items: { oneOf: [] } }, [1])).toBe(false);
  });

  it("every ACTIVE primitive's paramsSchema stays inside the grammar validatePrimitiveParams supports", () => {
    const supported = new Set([...PRIMITIVE_PARAMS_KEYWORDS, ...PRIMITIVE_PARAMS_ANNOTATIONS]);
    const types = new Set(["string", "number", "integer", "boolean", "array", "object"]);
    const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
    /** Every way a schema node, or one below it, leaves the supported grammar. */
    const offences = (node: unknown, path: string): string[] => {
      if (!rec(node)) return [`${path}: not an object schema`];
      const unsupportedKeywords = Object.keys(node).filter((k) => !supported.has(k));
      if (unsupportedKeywords.length > 0) return [`${path}: unsupported keyword ${unsupportedKeywords.join(", ")}`];
      if (typeof node.type !== "string" || !types.has(node.type)) return [`${path}: no single known type`];
      const own: string[] = [];
      if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((k) => typeof k === "string"))) own.push(`${path}: required is not a list of strings`);
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean" && !rec(node.additionalProperties)) own.push(`${path}: additionalProperties is not a boolean or a schema`);
      if (node.items !== undefined && !rec(node.items)) own.push(`${path}: items is not an object schema`);
      if (node.properties !== undefined && !rec(node.properties)) own.push(`${path}: properties is not an object`);
      return [
        ...own,
        ...Object.entries(rec(node.properties) ? node.properties : {}).flatMap(([k, v]) => offences(v, `${path}.properties.${k}`)),
        ...(rec(node.items) ? offences(node.items, `${path}.items`) : []),
        ...(rec(node.additionalProperties) ? offences(node.additionalProperties, `${path}.additionalProperties`) : []),
      ];
    };
    // The walker sees what it should (so a clean result below is not vacuous).
    expect(offences({ type: "object", properties: { a: { oneOf: [] } } }, "s")).toEqual(["s.properties.a: unsupported keyword oneOf"]);
    expect(offences({ type: "array", items: {} }, "s")).toEqual(["s.items: no single known type"]);
    expect(offences({ type: "object", required: "a", additionalProperties: 1 }, "s")).toHaveLength(2);
    expect(offences({ type: "object", properties: { a: { type: "string", enum: ["x"], default: "x" } }, required: ["a"], additionalProperties: false }, "s")).toEqual([]);

    const active = EVIDENCE_PRIMITIVES.filter((d) => d.status === "active");
    const found = active.flatMap((d) => offences(d.paramsSchema, "paramsSchema").map((o) => `${d.id} @ ${o}`));
    // Pinned: today exactly one ACTIVE primitive, a stub, uses grammar outside the supported set. A future
    // primitive that uses oneOf (or anything else) fails here, instead of its params failing open.
    expect(found).toEqual(["telemetry.envelope_conformance @ paramsSchema.properties.envelope: unsupported keyword oneOf"]);
    // A primitive may not go live while its params schema is outside the grammar.
    for (const d of active.filter((x) => x.verifierStatus === "live")) {
      expect(offences(d.paramsSchema, "paramsSchema"), d.id).toEqual([]);
    }
    // The exception fails closed: params that reach the unsupported node are refused; the rest validate as usual.
    const stub = EVIDENCE_PRIMITIVES.find((d) => d.id === "telemetry.envelope_conformance")!;
    expect(stub.verifierStatus).toBe("stub");
    expect(validatePrimitiveParams(stub.paramsSchema, { envelope: "builtin-defaults" })).toBe(false);
    expect(validatePrimitiveParams(stub.paramsSchema, { source: "stream" })).toBe(true);
    expect(parses({ ...kitRequest(), evidence: { tier: 1, requiredPrimitives: [{ id: stub.id, params: { envelope: "builtin-defaults" } }], executable: false } })).toBe(false);
  });

  // ── C. Finding 2 (MEDIUM): an honest license allow-list ──

  it("finding 2 (policy): a real SPDX id outside PCC's allow-list (EUPL-1.2) is refused by policy", () => {
    expect(isAllowedLicenseExpression("EUPL-1.2")).toBe(false);
    // Other real SPDX ids and references outside the list are refused too, however well-formed.
    for (const outside of ["EUPL-1.1", "Sleepycat", "DocumentRef-acme:LicenseRef-custom", "MIT OR EUPL-1.2", "GPL-2.0+", "GPL-2.0-only WITH Bison-exception-2.2"]) {
      expect(isAllowedLicenseExpression(outside), outside).toBe(false);
    }
    // A kit that names such a license has no license until the list is extended by PR (or a rights-terms hash covers it).
    const eupl = liquidHandlingKit({ economics: { spdxLicense: "EUPL-1.2" } });
    expect(validateKitCompleteness(eupl)).toEqual({ complete: false, missing: ["license"] });
    expect(validateKitCompleteness({ ...eupl, economics: { spdxLicense: "EUPL-1.2", rightsTermsHash: T("f") } }).complete).toBe(true);
  });

  it("finding 2: an allowed expression is accepted, and the SPDX-validator name is gone from the module", () => {
    expect(isAllowedLicenseExpression("MIT OR Apache-2.0")).toBe(true);
    expect(validateKitCompleteness(liquidHandlingKit({ economics: { spdxLicense: "MIT OR Apache-2.0" } })).complete).toBe(true);
    // Renamed, not aliased: nothing claims to be a general SPDX validator.
    expect("isSpdxLicenseExpression" in kit).toBe(false);
    expect("isAllowedLicenseExpression" in kit).toBe(true);
  });

  // ── D. MEDIUM 5: masking, and describe ──

  const withPayee = (maskedDestination: string) => {
    const b = binding();
    b.payee = { ...b.payee!, maskedDestination };
    return b;
  };
  const acceptsMask = (maskedDestination: string) => OperatorBindingDTOSchema.safeParse(withPayee(maskedDestination)).success;
  const withDescribe = (describe?: string) => {
    const b = binding();
    b.bindings = [{ ...b.bindings[0]!, availability: { mode: "manual-claim", ...(describe !== undefined ? { describe } : {}) } }];
    return b;
  };
  const evm = "0x282Fa9C122b433864f8C8a8F2EfE411b52067539";

  it("MEDIUM 5a: a short destination is never shown in full", () => {
    const masked = maskPayoutDestination("AB");
    expect(masked).toBe("…");
    expect(masked).not.toContain("AB");
  });

  it("maskPayoutDestination: under 8 characters shows none, under 40 shows the last 2, otherwise the first 6 and last 4", () => {
    expect(maskPayoutDestination("")).toBe("…");
    expect(maskPayoutDestination("1234567")).toBe("…"); // 7
    expect(maskPayoutDestination("12345678")).toBe("…78"); // 8
    expect(maskPayoutDestination("acct-1234567")).toBe("…67"); // 12
    expect(maskPayoutDestination("x".repeat(39))).toBe("…xx"); // 39
    expect(maskPayoutDestination(`abcdef${"-".repeat(30)}wxyz`)).toBe("abcdef…wxyz"); // 40
    expect(maskPayoutDestination(evm)).toBe("0x282F…7539"); // an EVM address, 42: 6+4
    // It trims first, so padding cannot push a short destination over a threshold.
    expect(maskPayoutDestination("  AB  ")).toBe("…");
    expect(maskPayoutDestination(`\n  12345678\t`)).toBe("…78");
    expect(maskPayoutDestination(` ${"x".repeat(7)} `)).toBe("…");
  });

  it("maskPayoutDestination reveals at most 25% at every length, and always produces a form the schema accepts", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (let n = 0; n <= 120; n++) {
      const destination = Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");
      const masked = maskPayoutDestination(destination);
      expect((masked.length - 1) * 4, `shown of ${n}`).toBeLessThanOrEqual(n);
      expect(acceptsMask(masked), `form at ${n}`).toBe(true);
    }
  });

  it("the schema accepts three forms of mask, and only those: it checks the FORM, not the source length", () => {
    for (const ok of ["…", "…34", "0x282F…7539", "abcdef…ghij"]) expect(acceptsMask(ok), ok).toBe(true);
    for (const bad of [
      "",
      " …",
      "……",
      "…3",
      "…345",
      "abcde…ghij",
      "abcdef…ghi",
      "abcdef…ghijk",
      "abcdef……ghij",
      "…ab…",
      "ab…",
      "abcdef",
      evm,
    ]) {
      expect(acceptsMask(bad), bad).toBe(false);
    }
    // "abcdef…ghij" masks a longer value, but a 10-character value would reconstruct to it: the form cannot
    // tell, so the helper's thresholds are what guarantee the ratio.
    expect(maskPayoutDestination("abcdefghij")).toBe("…ij");
  });

  it("MEDIUM 5b: availability.describe may not carry URL-scheme text (the 'never an endpoint' claim)", () => {
    expect(OperatorBindingDTOSchema.safeParse(withDescribe("POST jobs to https://agent.example/claim")).success).toBe(false);
    for (const refused of [
      "HTTP://x",
      "see https://a.b",
      "ftp://host/file",
      "ssh://git@host/repo",
      "s3://bucket/key",
      "custom+scheme.v1://x",
      "wss://relay.example",
      "a://",
    ]) {
      expect(OperatorBindingDTOSchema.safeParse(withDescribe(refused)).success, refused).toBe(false);
    }
    // Plain display text is fine, colons and slashes included.
    for (const plain of ["Weekdays 9 to 5, message the lab first", "", "Open 09:00 // 17:00", "Ask in the lab chat: no links here", "Call 555-0100"]) {
      expect(OperatorBindingDTOSchema.safeParse(withDescribe(plain)).success, plain).toBe(true);
    }
    const r = OperatorBindingDTOSchema.safeParse(withDescribe("POST jobs to https://agent.example/claim"));
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      "describe is display text: it may not contain URL-scheme text such as https://",
    ]);
  });

  it("control for 5b: the same binding without describe parses (else the fixture is wrong)", () => {
    const r = OperatorBindingDTOSchema.safeParse(withDescribe());
    expect(r.success ? "ok" : JSON.stringify(r.error.issues)).toBe("ok");
  });
});

// ── pack 112 MEDIUM 8: a shape or enum change must bump the schema literal ──

/** A structural fingerprint of a zod schema: keys, strictness, types, enums, literals and checks (not messages). */
function shapeOf(schema: unknown): unknown {
  const def = (schema as { _def: Record<string, unknown> })._def;
  const t = def.typeName as string;
  const checks = () =>
    (def.checks as Array<Record<string, unknown>>).map(({ message: _message, regex, ...c }) => ({
      ...c,
      ...(regex instanceof RegExp ? { regex: String(regex) } : {}),
    }));
  const len = (v: unknown) => (v as { value: number } | null)?.value ?? null;
  switch (t) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, unknown>)();
      return { o: Object.keys(shape).sort().map((k) => [k, shapeOf(shape[k])]), keys: def.unknownKeys };
    }
    case "ZodOptional":
    case "ZodNullable":
      return { [t]: shapeOf(def.innerType) };
    case "ZodArray":
      return { a: shapeOf(def.type), min: len(def.minLength), max: len(def.maxLength), exact: len(def.exactLength) };
    case "ZodEnum":
      return { e: [...(def.values as string[])].sort() };
    case "ZodLiteral":
      return { l: def.value };
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { [t]: (def.options as unknown[]).map(shapeOf) };
    case "ZodEffects":
      return shapeOf(def.schema);
    case "ZodRecord":
      return { r: shapeOf(def.valueType) };
    case "ZodString":
    case "ZodNumber":
      return { [t]: checks() };
    default:
      return t;
  }
}

const fingerprint = (schema: unknown) =>
  createHash("sha256").update(JSON.stringify(shapeOf(schema))).digest("hex").slice(0, 16);

describe("pack 112 MEDIUM 8: every shape or enum change bumps the schema literal", () => {
  // Consumers parse strictly, so an added optional field or enum value breaks an
  // old reader. When this fails, bump the literal (a new version) and re-pin BOTH
  // values in the same commit. Re-pinning a fingerprint under an unchanged literal
  // is the defect this test exists to catch; the one exception is the pre-release
  // window before the first merge, when no producer or consumer is deployed.
  it("each contract literal is pinned to its exact shape", () => {
    expect({ literal: OPPORTUNITY_SCHEMA, shape: fingerprint(OpportunityDTOSchema) }).toEqual({
      literal: "pcc.opportunity.v0",
      shape: "91d25641c69b4970",
    });
    expect({ literal: OPERATOR_BINDING_SCHEMA, shape: fingerprint(OperatorBindingDTOSchema) }).toEqual({
      literal: "pcc.operator-binding.v0",
      shape: "ca2f94ba7aa72ade",
    });
    expect({ literal: KIT_MANIFEST_SCHEMA, shape: fingerprint(CapabilityKitManifestV1Schema) }).toEqual({
      literal: "pcc.capability-kit/v1",
      shape: "0ade760b67d57c08",
    });
  });

  it("the fingerprint moves on an added optional field, an added enum value, a changed check or loosened strictness", () => {
    const base = z.object({ a: z.enum(["x", "y"]), b: z.string().max(10) }).strict();
    const f = fingerprint(base);
    expect(fingerprint(z.object({ a: z.enum(["x", "y"]), b: z.string().max(10) }).strict())).toBe(f);
    expect(fingerprint(base.extend({ c: z.string().optional() }))).not.toBe(f);
    expect(fingerprint(z.object({ a: z.enum(["x", "y", "z"]), b: z.string().max(10) }).strict())).not.toBe(f);
    expect(fingerprint(z.object({ a: z.enum(["x", "y"]), b: z.string().max(11) }).strict())).not.toBe(f);
    expect(fingerprint(base.passthrough())).not.toBe(f);
  });
});
