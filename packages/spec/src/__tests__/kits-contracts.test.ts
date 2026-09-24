/**
 * Kits contracts: Capability Kit manifest identity and completeness,
 * OperatorBindingDTO and OpportunityDTO invariants (ledger R5/R6/R7/R8/R41/R45,
 * PX-13). Interface-only: no storage, no routes.
 */

import { describe, it, expect } from "vitest";
import {
  CapabilityKitManifestV1Schema,
  computeKitDigest,
  normalizeKitManifest,
  validateKitCompleteness,
  type CapabilityKitManifestV1,
} from "../types/capability-kit.js";
import {
  OperatorBindingDTOSchema,
  maskPayoutDestination,
  type OperatorBindingDTO,
} from "../types/operator-binding.js";
import { OpportunityDTOSchema, type OpportunityDTO } from "../types/opportunity.js";

const H = (c: string) => `sha256:${c.repeat(64)}`;
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
      declaredAssuranceTiers: [2, 1, 2],
      compatibility: { interfaces: ["http"], deviceFamilies: ["opentrons-ot2", "opentrons-ot2"] },
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
        availability: { hours: "9-17" },
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

function opportunity(overrides: Partial<OpportunityDTO> = {}): OpportunityDTO {
  return {
    schema: "pcc.opportunity.v0",
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

describe("OpportunityDTO", () => {
  it("accepts an unfunded kit-build request and a verified funded offer", () => {
    expect(OpportunityDTOSchema.safeParse(opportunity()).success).toBe(true);
    const funded = opportunity({
      kind: "funded_offer",
      reward: { amount: "40000000", currency: "USDC", fundingStatus: "funded" },
      authority: "authoritative",
      kitRef: { kitDigest: H("c"), name: "HPLC kit" },
    });
    expect(OpportunityDTOSchema.safeParse(funded).success).toBe(true);
  });

  it("'funded' needs an authoritative, server-verified source", () => {
    const claimedFunded = opportunity({ reward: { amount: "1", currency: "USDC", fundingStatus: "funded" } });
    expect(OpportunityDTOSchema.safeParse(claimedFunded).success).toBe(false);
  });

  it("a funded_offer must actually be funded", () => {
    const res = OpportunityDTOSchema.safeParse(opportunity({ kind: "funded_offer", authority: "authoritative" }));
    expect(res.success).toBe(false);
  });

  it("a demand aggregate is a banded signal with no reward", () => {
    const agg = opportunity({ kind: "demand_aggregate", reward: undefined, demandBand: "5-9", authority: "derived_signal" });
    expect(OpportunityDTOSchema.safeParse(agg).success).toBe(true);
    expect(OpportunityDTOSchema.safeParse({ ...agg, reward: { amount: "1", currency: "USDC", fundingStatus: "unfunded" } }).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse({ ...agg, demandBand: undefined }).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse({ ...agg, authority: "authoritative" }).success).toBe(false);
  });

  it("never carries requester data, float amounts, multi-line titles or fine-grained locations", () => {
    expect(OpportunityDTOSchema.safeParse({ ...opportunity(), requesterId: "alice@example.com" }).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse(opportunity({ reward: { amount: "12.5", currency: "USDC", fundingStatus: "unfunded" } })).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse(opportunity({ title: "need hplc\nplease call 555" })).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse(opportunity({ location: { country: "US", region: "CA", ...({ lat: 37.7 } as object) } })).success).toBe(false);
    expect(OpportunityDTOSchema.safeParse(opportunity({ location: { country: "usa" } })).success).toBe(false);
  });
});
