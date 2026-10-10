/**
 * Kits contracts: Capability Kit manifest identity and completeness,
 * OperatorBindingDTO and OpportunityDTO invariants (ledger R5/R6/R7/R8/R41/R45,
 * PX-13). Interface-only: no storage, no routes.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
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
  MAX_AS_OF_SKEW_MS,
  OPPORTUNITY_SCHEMA,
  OpportunityDTOSchema,
  approvedSetDigest,
  demandAggregateId,
  demandAggregateTitle,
  demandAggregatesFromRelease,
  evidenceIsExecutable,
  isPublicCapabilityUrl,
  opportunityDTOSchemaFor,
  primitivesAreExecutable,
  publicCapabilityUrls,
  readTimeIsNotInFuture,
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
import { renderParamsSchema } from "../evidence/primitive-params.js";
import { computeCsdEligibility } from "../evidence/eligibility.js";
import { canonicalize } from "../util/canonical.js";

/**
 * Run `fn` with the named primitives' verifiers marked live, then restore them. No tier 1-3 set is
 * executable with today's registry (ident.registered_key, which every live tier-1 primitive depends
 * on, is a stub), so the positive tier 1-3 cases need this to exist at all.
 */
function withLiveVerifiers<T>(ids: string[], fn: () => T): T {
  const touched = EVIDENCE_PRIMITIVES.filter((p) => ids.includes(p.id));
  const before = touched.map((p) => p.verifierStatus);
  try {
    for (const p of touched) (p as { verifierStatus: string }).verifierStatus = "live";
    return fn();
  } finally {
    touched.forEach((p, i) => ((p as { verifierStatus: string }).verifierStatus = before[i]!));
  }
}

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
    expect(parses(withEvidence(evidence(1, [{ id: "artifact.hash" }, { id: "ident.registered_key", bind: "execution_completed" }])))).toBe(true);
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
    // #365 releases a period only 24 hours after it ends (astra pack 112c), and a DTO read earlier cannot exist.
    expect(parses(aggregate({ asOf: "2026-09-01T00:00:00Z" }))).toBe(false); // the first instant after it: grace
    expect(parses(aggregate({ asOf: "2026-09-01T23:59:59Z" }))).toBe(false); // the grace's last second
    expect(parses(aggregate({ asOf: "2026-09-02T00:00:00+02:00" }))).toBe(false); // 22:00Z on the 1st
    expect(parses(aggregate({ asOf: "2026-09-02T00:00:00Z" }))).toBe(true); // the first instant after the grace
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
    // Pinned: the 9 CSDs loadBuiltinCsds registers. The set follows the registry, so a new built-in CSD
    // fails this pin by design: add its url here, in sorted position, in the same commit (as
    // document-print-and-mail/v1 was when this branch merged master, which registers it since 2d808180).
    expect([...BUILTIN_PUBLIC_CAPABILITY_URLS]).toEqual([
      "pcc://capabilities/2d-print/v1",
      "pcc://capabilities/cnc-3axis/v2",
      "pcc://capabilities/courier-route/v1",
      "pcc://capabilities/document-print-and-mail/v1",
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
      countedEvidence: "authenticated_order" as const,
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
        policy: { k: 5, evidenceFloor: "authenticated_order" as const },
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

    /** A self-consistent record with ANY policy: both digests computed the documented way. */
    const craftedRelease = (policy: { k: number; evidenceFloor: string }, countedEvidence: string, p = period) => {
      const body = {
        schema: "pcc.public-opportunity-release.v1" as const,
        period: p,
        policy,
        approvedSetDigest: digestOf([...new Set(approved.filter((u) => isPublicCapabilityUrl(u)))].sort(byCodeUnit)),
        aggregates: [{ ...aggregateRecord(cnc, "5-9", p), countedEvidence }],
      };
      return { ...body, digest: digestOf(body) };
    };

    it("astra pack 112c CRITICAL 1: only #365's one fixed policy is accepted (k 5, counted at authenticated_order)", () => {
      expect(demandAggregatesFromRelease(craftedRelease({ k: 5, evidenceFloor: "authenticated_order" }, "authenticated_order") as never, approved, asOf)).toHaveLength(1);
      // The verdict's case: a self-consistent record with k 0 and the query floor.
      refused(craftedRelease({ k: 0, evidenceFloor: "query" }, "query")).toThrow(/not a pcc.public-opportunity-release.v1 record/);
      refused(craftedRelease({ k: 4, evidenceFloor: "authenticated_order" }, "authenticated_order")).toThrow(/not a pcc.public-opportunity-release.v1 record/);
      refused(craftedRelease({ k: 5, evidenceFloor: "funded" }, "funded")).toThrow(/not a pcc.public-opportunity-release.v1 record/);
      // An aggregate counted at another class than the policy's floor.
      refused(craftedRelease({ k: 5, evidenceFloor: "authenticated_order" }, "query")).toThrow(/not a pcc.public-opportunity-release.v1 record/);
    });

    it("astra pack 112c CRITICAL 1: a period is releasable only after #365's 24-hour grace, by this clock", () => {
      vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z") });
      try {
        const september = craftedRelease({ k: 5, evidenceFloor: "authenticated_order" }, "authenticated_order", "2026-09");
        refused(september, approved, "2026-10-01T11:00:00Z").toThrow(/not releasable yet/);
        vi.setSystemTime(new Date("2026-10-01T23:59:59Z"));
        refused(september, approved, "2026-10-01T23:59:00Z").toThrow(/not releasable yet/);
        vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
        expect(demandAggregatesFromRelease(september as never, approved, "2026-10-02T00:00:00Z")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
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

    it("astra pack 112d CRITICAL 1: the aggregates must be in #365's canonical order (capabilityType strictly increasing)", () => {
      expect(cnc < liquid).toBe(true);
      // buildRelease recomputes both digests, so the reversed record is self-consistent: only its order is wrong.
      refused(buildRelease([aggregateRecord(liquid), aggregateRecord(cnc)])).toThrow(/aggregate 1 breaks #365's canonical order/);
      // The same aggregates in #365's order are accepted, in that order.
      const dtos = demandAggregatesFromRelease(buildRelease([aggregateRecord(cnc), aggregateRecord(liquid)]), approved, asOf);
      expect(dtos.map((d) => d.capabilityType)).toEqual([cnc, liquid]);
      // #365's own sort, applied to the reversed list, gives the accepted order.
      expect([liquid, cnc].sort(byCodeUnit)).toEqual([cnc, liquid]);
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

  it("HIGH 4c (v1, N128): params are checked by the shared closed table, and anything outside it fails closed", () => {
    const at = (tier: 0 | 1 | 2 | 3, ref: CsdEvidencePrimitiveRef, executable: boolean) =>
      parses({ ...kitRequest(), evidence: { tier, requiredPrimitives: [ref], executable } });
    // An unknown key, a missing required field, a value outside an enum and an out-of-bounds number are refused.
    expect(at(0, { id: "decl.self_attested", params: { apiKey: "sk_live_x" } }, true)).toBe(false);
    expect(at(2, { id: "capture.photo_nonced" }, false)).toBe(false);
    expect(at(2, { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC2", nonceType: "smoke" } }, false)).toBe(false);
    expect(at(1, { id: "fresh.challenge_bound", params: { maxAgeSeconds: 0 } }, false)).toBe(false);
    // What the table names passes, a oneOf included (v0's JSON-Schema subset refused every oneOf).
    expect(at(0, { id: "decl.self_attested", params: { schemaRef: `sha256:${"ab".repeat(32)}` } }, true)).toBe(true);
    expect(at(2, { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC2", nonceType: "qr" } }, false)).toBe(true);
    expect(at(1, { id: "telemetry.envelope_conformance", params: { envelope: "builtin-defaults" } }, false)).toBe(true);
  });

  it("executable means CUMULATIVELY tier-eligible with live verifiers (112c): the tier 0 floor, payer alone is not tier 2 or 3", () => {
    const decl = { id: "decl.self_attested" };
    const payer = { id: "approval.payer" };
    // Tier 0 is the permissionless floor, with or without the declaration primitive.
    expect(evidenceIsExecutable(0, [])).toBe(true);
    expect(evidenceIsExecutable(0, [decl])).toBe(true);
    // approval.payer supports tiers 2 and 3 only, so its tier 1 set is empty and the program caps at tier 0.
    for (const tier of [0, 1, 2, 3] as const) expect(evidenceIsExecutable(tier, [payer]), `payer at ${tier}`).toBe(false);
    expect(evidenceIsExecutable(3, [payer, payer])).toBe(false);
    // From tier 1 up the set is non-empty, and the declaration primitive alone is a tier 0 floor.
    for (const tier of [1, 2, 3] as const) {
      expect(evidenceIsExecutable(tier, []), `empty at tier ${tier}`).toBe(false);
      expect(evidenceIsExecutable(tier, [decl]), `decl at tier ${tier}`).toBe(false);
    }
    // A stub verifier (even a Family-G one), an unknown id and a stub dependency are not executable.
    expect(evidenceIsExecutable(2, [{ id: "approval.expert" }])).toBe(false);
    expect(evidenceIsExecutable(2, [payer, { id: "capture.photo_nonced" }])).toBe(false);
    expect(evidenceIsExecutable(2, [payer, { id: "made.up_primitive" }])).toBe(false);
    // Today no tier 1 set is executable: receipt.kernel_signed and confirm.execution_mode depend on the stub
    // ident.registered_key.
    const chain = [{ id: "ident.registered_key" }, { id: "receipt.kernel_signed" }, { id: "confirm.execution_mode" }];
    expect(evidenceIsExecutable(1, chain)).toBe(false);
  });

  it("astra pack 112c HIGH 4: the cumulative report caps payer-only evidence at tier 0, and so does evidenceIsExecutable", () => {
    const refs = [{ id: "approval.payer" }];
    const report = computeCsdEligibility(
      { url: "pcc://opportunity/evidence-requirement", evidence: { tier3: { description: "x", required: [], primitives: refs } } },
      { requireImplementedVerifier: true },
    );
    expect(report.eligibleTier).toBe(0);
    expect(evidenceIsExecutable(3, refs)).toBe(false);
  });

  it("with the chain's verifier live, tiers 1-3 become executable exactly when every tier through the target is eligible", () => {
    const chain = [{ id: "ident.registered_key" }, { id: "receipt.kernel_signed" }, { id: "confirm.execution_mode" }];
    const payer = { id: "approval.payer" };
    withLiveVerifiers(["ident.registered_key"], () => {
      // confirm.execution_mode supports tier 0 but its dependency cannot sit there, so tier 0 stays empty (the floor).
      expect(evidenceIsExecutable(1, chain)).toBe(true);
      // Tier 2 needs the human floor: payer approval completes it, the chain alone does not.
      expect(evidenceIsExecutable(2, chain)).toBe(false);
      expect(evidenceIsExecutable(2, [...chain, payer])).toBe(true);
      // Tier 3: receipt.kernel_signed supports only tiers 1-2, but it already sits in a lower tier for its dependants.
      expect(evidenceIsExecutable(3, [...chain, payer])).toBe(true);
      // A ref that cannot contribute at any tier up to the target makes the requirement not executable.
      expect(evidenceIsExecutable(1, [...chain, payer])).toBe(false);
      // Dependency closure: without receipt.kernel_signed, confirm.execution_mode has nothing to stand on, so a
      // requirement naming it is not executable; the reduced program is never judged in its place (astra pack 112d).
      expect(evidenceIsExecutable(1, [{ id: "ident.registered_key" }, { id: "confirm.execution_mode" }])).toBe(false);
      expect(evidenceIsExecutable(1, [{ id: "confirm.execution_mode" }])).toBe(false);
    });
    // Restored: the stub is a stub again.
    expect(evidenceIsExecutable(1, chain)).toBe(false);
  });

  it("astra pack 112d HIGH 4: a named primitive the dependency pass removes from every tier makes the requirement not executable", () => {
    const gate = { id: "confirm.execution_mode" };
    // The verdict's case: the live negative gate alone at tier 0. Its dependency (receipt.kernel_signed) is missing.
    expect(EVIDENCE_PRIMITIVES.find((p) => p.id === "confirm.execution_mode")?.verifierStatus).toBe("live");
    expect(EVIDENCE_PRIMITIVES.find((p) => p.id === "confirm.execution_mode")?.dependsOn).toContain("receipt.kernel_signed");
    expect(evidenceIsExecutable(0, [gate])).toBe(false);
    // A duplicate does not repair a missing dependency.
    expect(evidenceIsExecutable(0, [gate, gate])).toBe(false);
    // The tier-0 floor and decl.self_attested stay executable: nothing in them is dropped.
    expect(evidenceIsExecutable(0, [])).toBe(true);
    expect(evidenceIsExecutable(0, [{ id: "decl.self_attested" }])).toBe(true);
    withLiveVerifiers(["ident.registered_key"], () => {
      // receipt.kernel_signed without ident.registered_key is dropped, and confirm.execution_mode with it.
      expect(evidenceIsExecutable(1, [{ id: "receipt.kernel_signed" }, gate])).toBe(false);
      // A complete chain plus the gate at tier 0 and 1: everything named sits in some tier.
      expect(evidenceIsExecutable(1, [{ id: "ident.registered_key" }, { id: "receipt.kernel_signed" }, gate])).toBe(true);
    });
    // A funded offer cannot name the gate without its dependency and claim executable evidence...
    expect(parses({ ...fundedOffer(), evidence: { tier: 0, requiredPrimitives: [gate], executable: true } })).toBe(false);
    // ...nor carry it honestly as not executable; an unfunded kit request may describe it honestly.
    expect(parses({ ...fundedOffer(), evidence: { tier: 0, requiredPrimitives: [gate], executable: false } })).toBe(false);
    expect(parses({ ...kitRequest(), evidence: { tier: 0, requiredPrimitives: [gate], executable: false } })).toBe(true);
  });

  it("the executable flag must equal evidenceIsExecutable, in both directions, and funded kinds need it true", () => {
    const payer = { id: "approval.payer" };
    const truthful = "executable must be true exactly when requiredPrimitives is a complete tier-eligible set with live verifiers (evidenceIsExecutable)";
    // A funded offer with an executable requirement: the tier 0 floor (no tier 1-3 set is executable today).
    expect(parses({ ...fundedOffer(), evidence: evidence(0, []) })).toBe(true);
    expect(parses({ ...fundedOffer(), evidence: evidence(0, [{ id: "decl.self_attested" }]) })).toBe(true);
    // Payer approval alone at tier 2 is not executable, so a funded offer cannot carry it.
    expect(messagesOf({ ...fundedOffer(), evidence: evidence(2, [payer]) })).toEqual([
      "a funded_offer's evidence must be executable (see evidenceIsExecutable)",
    ]);
    // Params are still checked against the primitive, executable or not.
    expect(parses({ ...kitRequest(), evidence: evidence(2, [{ id: "approval.payer", params: { approverRole: "payer", claimIds: ["c-1"] } }]) })).toBe(true);
    // Claiming executable for a set that is not, and claiming non-executable for one that is, are both refused.
    expect(messagesOf({ ...kitRequest(), evidence: { tier: 2, requiredPrimitives: [payer], executable: true } })).toEqual([truthful]);
    expect(messagesOf({ ...kitRequest(), evidence: { tier: 1, requiredPrimitives: [], executable: true } })).toEqual([truthful]);
    expect(messagesOf({ ...kitRequest(), evidence: { tier: 0, requiredPrimitives: [], executable: false } })).toEqual([truthful]);
    // A funded kit_build_request is held to the same standard as a funded offer.
    const funded = { reward: { amount: "1", currency: "USDC", fundingStatus: "funded" }, authority: "authoritative", fundingRef: { kind: "escrow", id: "esc-9" } } as const;
    expect(parses({ ...kitRequest(), ...funded, evidence: evidence(0, []) })).toBe(true);
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

  it("v1 (N128): every ACTIVE primitive's paramsSchema is the closed table's rendering, and refs are checked by that table", () => {
    // One source: the registry's descriptor is rendered from evidence/primitive-params.ts, every object closed.
    for (const d of EVIDENCE_PRIMITIVES.filter((x) => x.status === "active")) {
      expect(d.paramsSchema, d.id).toEqual(renderParamsSchema(d.id));
      expect(d.paramsSchema.additionalProperties, d.id).toBe(false);
    }
    // The primitive v0 could not evaluate (its envelope is a oneOf) is checked like any other.
    const envelope = (params: Record<string, unknown>) =>
      parses({ ...kitRequest(), evidence: { tier: 1, requiredPrimitives: [{ id: "telemetry.envelope_conformance", params }], executable: false } });
    expect(envelope({ envelope: "builtin-defaults" })).toBe(true);
    expect(envelope({ envelope: [{ metric: "spindle_temp_c", unit: "degC", min: 10, max: 90 }] })).toBe(true);
    expect(envelope({ envelope: "custom" })).toBe(false);
    expect(envelope({ envelope: [{ metric: "spindle_temp_c", note: "x" }] })).toBe(false);
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

  // ── E. MEDIUM 7: a read time is never in the future ──

  /** An ISO instant `ms` from now, computed inside the test (no fake timers). */
  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
  const futureAsOf = "asOf is a read time: it may not run more than MAX_AS_OF_SKEW_MS ahead of the clock";
  const futureBinding = "a read time may not run more than MAX_AS_OF_SKEW_MS ahead of the clock";
  const bindingMessages = (v: unknown) => {
    const r = OperatorBindingDTOSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("MEDIUM 7: a future period with a forged future asOf is refused", () => {
    const forged = aggregate({ capabilityType: "pcc://capabilities/fdm/v2", releasePeriod: "2099-12", asOf: "2100-01-02T00:00:00Z" });
    expect(parses(forged)).toBe(false);
    // The period (and its 24-hour grace) really did end before this asOf, so the future asOf is the only reason.
    expect(messagesOf(forged)).toEqual([futureAsOf]);
  });

  it("MAX_AS_OF_SKEW_MS is 5 minutes, and the shared helper refuses anything beyond it or unparseable", () => {
    expect(MAX_AS_OF_SKEW_MS).toBe(5 * 60 * 1000);
    expect(readTimeIsNotInFuture("2026-09-24T12:00:00Z")).toBe(true);
    expect(readTimeIsNotInFuture(fromNow(60_000))).toBe(true);
    expect(readTimeIsNotInFuture(fromNow(10 * 60_000))).toBe(false);
    expect(readTimeIsNotInFuture("2100-01-01T00:00:00Z")).toBe(false);
    // An instant it cannot read is refused, never waved through.
    for (const garbage of ["", "yesterday", "NaN", "2026-13-45T99:99:99Z"]) expect(readTimeIsNotInFuture(garbage), garbage).toBe(false);
    // Offsets compare as absolute instants: ten minutes ahead is ahead in any zone.
    const ahead = new Date(Date.now() + 10 * 60_000);
    const tenAhead = `${new Date(ahead.getTime() + 2 * 3600_000).toISOString().slice(0, 19)}+02:00`;
    expect(readTimeIsNotInFuture(tenAhead)).toBe(false);
  });

  it("every OpportunityDTO kind accepts an asOf within the skew ahead (60 s, and just inside it) and refuses one beyond it (10 min)", () => {
    const kinds: Array<[string, (asOf: string) => unknown]> = [
      ["funded_offer", (asOf) => fundedOffer({ asOf })],
      ["kit_build_request", (asOf) => kitRequest({ asOf })],
      ["demand_aggregate", (asOf) => aggregate({ asOf })],
    ];
    for (const [kind, make] of kinds) {
      expect(parses(make(fromNow(60_000))), `${kind} +60 s`).toBe(true);
      expect(parses(make(fromNow(MAX_AS_OF_SKEW_MS - 1000))), `${kind} +skew-1s`).toBe(true);
      expect(parses(make(fromNow(MAX_AS_OF_SKEW_MS + 60_000))), `${kind} +skew+1 min`).toBe(false);
      expect(messagesOf(make(fromNow(10 * 60_000))), `${kind} +10 min`).toEqual([futureAsOf]);
      expect(parses(make(fromNow(-60_000))), `${kind} -60 s`).toBe(true);
      expect(parses(make("2100-01-01T00:00:00Z")), `${kind} year 2100`).toBe(false);
    }
  });

  it("a deadline is NOT restricted: it is a future promise, not a read time", () => {
    expect(parses(kitRequest({ deadline: "2100-01-01T00:00:00Z" }))).toBe(true);
    expect(parses(fundedOffer({ deadline: fromNow(30 * 24 * 3600_000) }))).toBe(true);
  });

  it("an OperatorBindingDTO's asOf and every binding's lastSeenAt are read times too", () => {
    const withSeen = (lastSeenAt: string | null) => {
      const b = binding();
      b.bindings = [{ ...b.bindings[0]!, lastSeenAt }];
      return b;
    };
    // asOf
    expect(OperatorBindingDTOSchema.safeParse(binding({ asOf: fromNow(60_000) })).success).toBe(true);
    expect(OperatorBindingDTOSchema.safeParse(binding({ asOf: fromNow(MAX_AS_OF_SKEW_MS - 1000) })).success).toBe(true);
    expect(bindingMessages(binding({ asOf: fromNow(10 * 60_000) }))).toEqual([futureBinding]);
    expect(OperatorBindingDTOSchema.safeParse(binding({ asOf: "2100-01-01T00:00:00Z" })).success).toBe(false);
    // lastSeenAt: null is "never seen", and a recent time is fine
    expect(OperatorBindingDTOSchema.safeParse(withSeen(null)).success).toBe(true);
    expect(OperatorBindingDTOSchema.safeParse(withSeen(fromNow(60_000))).success).toBe(true);
    expect(OperatorBindingDTOSchema.safeParse(withSeen(fromNow(-3600_000))).success).toBe(true);
    expect(bindingMessages(withSeen(fromNow(10 * 60_000)))).toEqual([futureBinding]);
    expect(OperatorBindingDTOSchema.safeParse(withSeen("2100-01-01T00:00:00Z")).success).toBe(false);
    // Any one binding in the list is enough to refuse it.
    const two = binding();
    two.bindings = [two.bindings[0]!, { ...two.bindings[0]!, id: "kernel-ot2-b", lastSeenAt: fromNow(10 * 60_000) }];
    expect(OperatorBindingDTOSchema.safeParse(two).success).toBe(false);
  });

  // ── F. MEDIUM 8: a semantic corpus pinned per literal, refinements included ──

  it("MEDIUM 8: a superRefine-only behaviour change moves a pinned corpus verdict (the fingerprint alone cannot see it)", () => {
    const refusesEverything = OpportunityDTOSchema.superRefine((_o, ctx) => ctx.addIssue({ code: "custom", message: "x" }));
    // The structural fingerprint is blind to the added refinement...
    expect(fingerprint(refusesEverything)).toBe(fingerprint(OpportunityDTOSchema));
    // ...the corpus is not: every accept case now fails, so the verdict test in the MEDIUM 8 block fails.
    const accepts = loadCorpus("pcc.opportunity.v1.json").cases.filter((k) => k.expect === "accept");
    expect(accepts.length).toBeGreaterThan(0);
    for (const k of accepts) expect(refusesEverything.safeParse(k.value).success, k.name).toBe(false);
  });
});

// ── pack 112 MEDIUM 8: a structural fingerprint of each contract ──

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

// ── the semantic corpus: what each literal accepts and refuses, refinements included (astra 112b) ──

type CorpusCase = { name: string; expect: "accept" | "reject"; value: unknown };
type Corpus = { literal: string; cases: CorpusCase[] };

const loadCorpus = (file: string): Corpus =>
  JSON.parse(readFileSync(new URL(`./kits-corpus/${file}`, import.meta.url), "utf8")) as Corpus;

/** First 16 hex of sha256 over the parsed corpus file, re-serialised: blind to whitespace, not to order or content. */
const corpusDigest = (file: string) => createHash("sha256").update(JSON.stringify(loadCorpus(file))).digest("hex").slice(0, 16);

/**
 * First 16 hex of sha256 over the bytes of the module that defines a literal (astra 112c MEDIUM 8): it moves on
 * ANY edit there, so a refinement whose effect lies outside the finite corpus cannot change the module unnoticed.
 */
const sourceDigest = (module: string) =>
  createHash("sha256").update(readFileSync(new URL(module, import.meta.url))).digest("hex").slice(0, 16);

const CONTRACTS: Array<{ literal: string; file: string; module: string; schema: z.ZodTypeAny }> = [
  { literal: OPPORTUNITY_SCHEMA, file: "pcc.opportunity.v1.json", module: "../types/opportunity.ts", schema: OpportunityDTOSchema },
  { literal: OPERATOR_BINDING_SCHEMA, file: "pcc.operator-binding.v0.json", module: "../types/operator-binding.ts", schema: OperatorBindingDTOSchema },
  { literal: KIT_MANIFEST_SCHEMA, file: "pcc.capability-kit-v1.json", module: "../types/capability-kit.ts", schema: CapabilityKitManifestV1Schema },
];

const verdictOf = (schema: z.ZodTypeAny, value: unknown) => (schema.safeParse(value).success ? "accept" : "reject");

describe("pack 112 MEDIUM 8 and 112b: every shape, enum or accepted-value change bumps the schema literal", () => {
  // The lock table pins, per literal, the schema's structural fingerprint, its semantic corpus (the accept and
  // reject cases in kits-corpus/, which cover every refinement rule) AND the digest of the module that defines it.
  // The fingerprint cannot see a refinement (ZodEffects is unwrapped); the corpus sees every refinement that moves
  // one of its cases; the module digest moves on any edit at all, so a refinement whose effect lies outside the
  // corpus still fails here (astra 112c MEDIUM 8). Consumers parse strictly, so any change to what a literal accepts
  // breaks an old reader: when this fails, bump the literal (a new version) and re-pin ALL of its values in the
  // same commit. Changing a pinned entry under an UNCHANGED literal is the review-blocking act. No in-repo test can
  // stop a PR from rewriting its own pins; the merge-gate review is the control. The one exception is the
  // pre-release window before the first merge, when no producer or consumer is deployed.
  const LOCK: Record<string, { literal: string; shape: string; corpus: string; source: string }> = {
    "pcc.opportunity.v1": { literal: "pcc.opportunity.v1", shape: "59ecc9a1d7d3d72a", corpus: "4d6e8b49722a4789", source: "e20c20bc1f3210a2" },
    "pcc.operator-binding.v0": { literal: "pcc.operator-binding.v0", shape: "ca2f94ba7aa72ade", corpus: "8e2aa2dd88af2f74", source: "4dbcbaa125103737" },
    "pcc.capability-kit/v1": { literal: "pcc.capability-kit/v1", shape: "0ade760b67d57c08", corpus: "99a0669d56f0e163", source: "5c97266f279b1ced" },
  };

  it("each contract literal is pinned to its exact shape, its exact corpus and its module's exact bytes", () => {
    const actual = Object.fromEntries(
      CONTRACTS.map((c) => [
        c.literal,
        { literal: c.literal, shape: fingerprint(c.schema), corpus: corpusDigest(c.file), source: sourceDigest(c.module) },
      ]),
    );
    expect(actual).toEqual(LOCK);
  });

  it("every corpus case gets the verdict it expects", () => {
    for (const c of CONTRACTS) {
      for (const k of loadCorpus(c.file).cases) {
        expect(verdictOf(c.schema, k.value), `${c.literal}: ${k.name}`).toBe(k.expect);
      }
    }
  });

  it("each corpus names its schema's literal, is well formed, and its accept cases carry that literal", () => {
    for (const c of CONTRACTS) {
      const corpus = loadCorpus(c.file);
      expect(Object.keys(corpus).sort(), c.file).toEqual(["cases", "literal"]);
      expect(corpus.literal, c.file).toBe(c.literal);
      const names = new Set<string>();
      for (const k of corpus.cases) {
        expect(Object.keys(k).sort(), k.name).toEqual(["expect", "name", "value"]);
        expect(["accept", "reject"], k.name).toContain(k.expect);
        expect(names.has(k.name), `duplicate case name: ${k.name}`).toBe(false);
        names.add(k.name);
        if (k.expect === "accept") expect((c.schema.parse(k.value) as { schema: string }).schema, k.name).toBe(c.literal);
      }
      expect(corpus.cases.some((k) => k.expect === "accept"), `${c.file} has accept cases`).toBe(true);
      expect(corpus.cases.some((k) => k.expect === "reject"), `${c.file} has reject cases`).toBe(true);
    }
  });

  it("wrapping a schema in an extra superRefine that refuses its first accept case flips a corpus verdict", () => {
    // This is what the structural fingerprint cannot do: it unwraps refinements, so it sees no difference at all.
    for (const c of CONTRACTS) {
      const corpus = loadCorpus(c.file);
      const first = corpus.cases.find((k) => k.expect === "accept")!;
      const firstKey = canonicalize(first.value);
      const wrapped = c.schema.superRefine((v, ctx) => {
        if (canonicalize(v) === firstKey) ctx.addIssue({ code: "custom", message: "refuses the first accept case" });
      });
      expect(fingerprint(wrapped), `${c.literal}: the fingerprint is blind to it`).toBe(fingerprint(c.schema));
      const flipped = corpus.cases.filter((k) => verdictOf(wrapped, k.value) !== k.expect).map((k) => k.name);
      expect(flipped.length, c.literal).toBeGreaterThanOrEqual(1);
      expect(flipped, c.literal).toContain(first.name);
    }
  });

  // For each refinement message a schema can emit, the corpus case that fails ONLY because of it (exactly one
  // issue, this message), so each rule is covered on its own, not hidden behind another failure.
  const FUTURE_AS_OF = "asOf is a read time: it may not run more than MAX_AS_OF_SKEW_MS ahead of the clock";
  const EXECUTABLE =
    "executable must be true exactly when requiredPrimitives is a complete tier-eligible set with live verifiers (evidenceIsExecutable)";
  const READ_TIME = "a read time may not run more than MAX_AS_OF_SKEW_MS ahead of the clock";
  const ISOLATING: Record<string, Array<[caseName: string, message: string]>> = {
    "pcc.opportunity.v1": [
      ["reject: an unknown evidence primitive", "evidence primitive made.up_primitive is unknown or not active"],
      ["reject: primitive params outside the descriptor's enum", "params do not match capture.photo_nonced's paramsSchema"],
      [
        "reject: primitive params with a key the closed params do not name (N128: an apiKey under decl.self_attested)",
        "params do not match decl.self_attested's paramsSchema",
      ],
      [
        "reject: a primitive whose required params are absent (N128: capture.photo_nonced needs media and minClass)",
        "params do not match capture.photo_nonced's paramsSchema",
      ],
      ["reject: an identifier param that is free text (N128: a claim id with spaces)", "params do not match approval.payer's paramsSchema"],
      ["reject: a bind that names no evidence field or event type (N128)", "bind must name an evidence field (EVIDENCE_BIND_FIELDS) or an event type"],
      ["reject: executable claimed for an empty tier 3 set", EXECUTABLE],
      ["reject: executable denied for an executable tier 0 set", EXECUTABLE],
      ["reject: executable claimed for payer approval alone at tier 3 (112c HIGH 4: its tier 1 is empty)", EXECUTABLE],
      ["reject: asOf in the future on a funded_offer", FUTURE_AS_OF],
      ["reject: asOf in the future on a kit_build_request", FUTURE_AS_OF],
      ["reject: asOf in the future on a demand_aggregate", FUTURE_AS_OF],
      ["reject: the verdict case: a future period with a forged future asOf", FUTURE_AS_OF],
      ["reject: a funded_offer whose evidence is truthfully not executable", "a funded_offer's evidence must be executable (see evidenceIsExecutable)"],
      ["reject: a funded kit_build_request that is not authoritative", "'funded' needs a server-verified (authoritative) source"],
      ["reject: a funded kit_build_request without its funding record", "a funded kit_build_request must name its funding record"],
      [
        "reject: a funded kit_build_request whose evidence is truthfully not executable",
        "a funded kit_build_request's evidence must be executable (see evidenceIsExecutable)",
      ],
      ["reject: an unfunded kit_build_request naming a funding record", "only a funded opportunity carries a fundingRef"],
      [
        "reject: a demand_aggregate for a private slug that is not an approved capability",
        "a demand_aggregate's capabilityType must be in the approved public capability set",
      ],
      ["reject: a demand_aggregate whose id is not derived", "a demand_aggregate's id is derived: demandAggregateId(releasePeriod, capabilityType)"],
      [
        "reject: a demand_aggregate whose title is not derived",
        "a demand_aggregate's title is derived: demandAggregateTitle(capabilityType, demandBand, releasePeriod)",
      ],
      [
        "reject: a demand_aggregate read in the last second of its period",
        "a demand_aggregate's release period must have closed, plus #365's release grace, before its asOf",
      ],
      [
        "reject: a demand_aggregate read at the first instant after its period closed, inside #365's 24-hour grace",
        "a demand_aggregate's release period must have closed, plus #365's release grace, before its asOf",
      ],
    ],
    "pcc.operator-binding.v0": [
      ["reject: a claim right for a type with no binding", "claim right for unbound type pcc://capabilities/hplc/v1"],
      ["reject: asOf in the future", READ_TIME],
      ["reject: lastSeenAt in the future", READ_TIME],
      ["reject: a describe carrying endpoint text", "describe is display text: it may not contain URL-scheme text such as https://"],
    ],
    "pcc.capability-kit/v1": [
      ["reject: a duplicate artifact (same role and name)", "duplicate artifact method/m.py"],
      ["reject: a duplicate capability", "duplicate capability pcc://capabilities/liquid-handling/v1"],
      ["reject: a duplicate compatibility.deviceFamilies entry", "duplicate entry in compatibility.deviceFamilies"],
      ["reject: a duplicate compatibility.models entry", "duplicate entry in compatibility.models"],
      ["reject: a duplicate compatibility.interfaces entry", "duplicate entry in compatibility.interfaces"],
      ["reject: a duplicate compatibility.platforms entry", "duplicate entry in compatibility.platforms"],
      ["reject: a duplicate declaredAssuranceTiers entry", "duplicate entry in declaredAssuranceTiers"],
      ["reject: a name in NFD (e + combining acute)", "name must be Unicode NFC"],
      ["reject: a description in NFD", "description must be Unicode NFC"],
      ["reject: a compatibility model in NFD", "compatibility.models[0] must be Unicode NFC"],
      ["reject: an artifact media type in NFD", "artifacts[1].mediaType must be Unicode NFC"],
    ],
  };
  /** A message that interpolates a type names its rule by the text before it. */
  const ruleOf = (message: string) => message.replace(/^(claim right for unbound type) .+$/, "$1");

  it("every refinement rule the corpus reaches has a case that fails only because of that rule", () => {
    for (const c of CONTRACTS) {
      const corpus = loadCorpus(c.file);
      const byName = new Map(corpus.cases.map((k) => [k.name, k]));
      const table = ISOLATING[c.literal]!;
      for (const [name, message] of table) {
        const k = byName.get(name);
        expect(k, `${c.literal}: no case named "${name}"`).toBeDefined();
        expect(k!.expect, name).toBe("reject");
        const r = c.schema.safeParse(k!.value);
        expect(r.success ? [] : r.error.issues.map((i) => i.message), name).toEqual([message]);
      }
      // And no case reaches a refinement message that the table does not account for.
      const reached = new Set<string>();
      for (const k of corpus.cases) {
        const r = c.schema.safeParse(k.value);
        if (!r.success) for (const i of r.error.issues) if (i.code === "custom") reached.add(ruleOf(i.message));
      }
      expect([...reached].sort(), c.literal).toEqual([...new Set(table.map(([, m]) => ruleOf(m)))].sort());
    }
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
