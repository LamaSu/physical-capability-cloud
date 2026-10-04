/**
 * Kit-build requests (kits K2 slice 0): KitBuildSpecV1, kitMeetsBuildSpec,
 * decimalToBaseUnits, kitBuildRequestFromOffer and kitBuildSpecPrefill.
 */

import { describe, expect, it } from "vitest";
import {
  KIT_BUILD_CAPABILITY_TYPE,
  KIT_BUILD_SPEC_SCHEMA,
  KIT_REQUIRED_ROLES,
  OPPORTUNITY_SCHEMA,
  OpportunityDTOSchema,
  decimalToBaseUnits,
  kitBuildRequestFromOffer,
  kitBuildRequestId,
  kitBuildRequestTitle,
  kitBuildSpecPrefill,
  kitMeetsBuildSpec,
  parseKitBuildSpec,
  publicCapabilityUrls,
  type CapabilityKitManifestV1,
  type KitBuildFundingStatement,
  type KitBuildOfferView,
  type KitBuildSpecV1,
} from "../index.js";

const H = (c: string) => `sha256:${c.repeat(64)}` as const;
const T = (c: string) => `0x${c.repeat(64)}`;
const LIQUID = "pcc://capabilities/liquid-handling/v1";
const AS_OF = "2026-10-03T12:00:00.000Z";

/** The complete liquid-handling kit of kits-contracts.test.ts. */
function liquidHandlingKit(overrides: Partial<CapabilityKitManifestV1> = {}): CapabilityKitManifestV1 {
  return {
    schema: "pcc.capability-kit/v1",
    name: "OT-2 dye serial dilution",
    version: "1.0.0",
    parentKitDigest: null,
    capabilities: [{ csdUrl: LIQUID, capabilityContractDigest: H("a") }],
    artifacts: [
      { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: H("1") },
      { role: "labware-definition", name: "carrier-24x-2ml.json", mediaType: "application/json", digest: H("2") },
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

const spec = (overrides: Partial<KitBuildSpecV1> = {}): KitBuildSpecV1 => ({ schema: KIT_BUILD_SPEC_SCHEMA, csdUrl: LIQUID, ...overrides });

function offer(overrides: Partial<KitBuildOfferView> = {}): KitBuildOfferView {
  return {
    id: "offer-7",
    capabilityType: KIT_BUILD_CAPABILITY_TYPE,
    requirements: spec(),
    status: "open",
    pricing: { amount: 250.5, currency: "USDC", model: "fixed" },
    deadlineIso: null,
    ...overrides,
  };
}

function held(overrides: Partial<KitBuildFundingStatement> = {}): KitBuildFundingStatement {
  return { kind: "escrow", id: "esc-1", offerId: "offer-7", state: "held", amount: "250500000", currency: "USDC", verifiedAt: AS_OF, ...overrides };
}

describe("KitBuildSpecV1", () => {
  it("accepts a minimal spec and a full one", () => {
    expect(parseKitBuildSpec(spec())).toEqual(spec());
    const full = spec({
      capabilityContractDigest: H("a"),
      deviceFamilies: ["opentrons-ot2"],
      interfaces: ["http"],
      requiredRoles: ["tests", "method"],
      parentKitDigest: H("b"),
    });
    expect(parseKitBuildSpec(full)).toEqual(full);
  });

  const refused: Array<[string, unknown]> = [
    ["no schema", { csdUrl: LIQUID }],
    ["another schema", { ...spec(), schema: "pcc.kit-build-spec.v2" }],
    ["an extra key", { ...spec(), note: "x" }],
    ["a non-CSD url", spec({ csdUrl: "https://example.com/cap" })],
    ["an uppercase slug", spec({ csdUrl: "pcc://capabilities/Liquid/v1" })],
    ["a bad digest", spec({ capabilityContractDigest: "sha256:abc" as never })],
    ["a duplicate family", spec({ deviceFamilies: ["a", "a"] })],
    ["an empty family list", spec({ deviceFamilies: [] })],
    ["a multi-line label", spec({ interfaces: ["http\nx"] })],
    ["an unknown role", spec({ requiredRoles: ["rocket" as never] })],
    ["a duplicate role", spec({ requiredRoles: ["tests", "tests"] })],
    ["null", null],
    ["a string", "spec"],
  ];
  for (const [label, input] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseKitBuildSpec(input)).toBeNull();
    });
  }
});

describe("kitMeetsBuildSpec", () => {
  it("a complete kit for the capability meets the minimal spec, with the default required roles", () => {
    expect(kitMeetsBuildSpec(liquidHandlingKit(), spec())).toEqual({ ok: true });
    expect(KIT_REQUIRED_ROLES.length).toBeGreaterThan(0);
  });

  it("meets a spec that pins the revision, families, interfaces, roles and parent when the kit has them all", () => {
    const kit = liquidHandlingKit({ parentKitDigest: H("b") });
    const full = spec({ capabilityContractDigest: H("a"), deviceFamilies: ["opentrons-ot2"], interfaces: ["http"], requiredRoles: ["labware-definition"], parentKitDigest: H("b") });
    expect(kitMeetsBuildSpec(kit, full)).toEqual({ ok: true });
  });

  const unmet: Array<[string, CapabilityKitManifestV1, KitBuildSpecV1, string]> = [
    ["another capability", liquidHandlingKit(), spec({ csdUrl: "pcc://capabilities/cnc-3axis/v2" }), "capability_missing"],
    ["another CSD revision", liquidHandlingKit(), spec({ capabilityContractDigest: H("c") }), "contract_revision_mismatch"],
    ["a missing device family", liquidHandlingKit(), spec({ deviceFamilies: ["opentrons-ot2", "hamilton-star"] }), "device_family_missing"],
    ["a missing interface", liquidHandlingKit(), spec({ interfaces: ["opcua"] }), "interface_missing"],
    ["no compatibility at all", liquidHandlingKit({ compatibility: undefined }), spec({ interfaces: ["http"] }), "interface_missing"],
    ["a missing requested role", liquidHandlingKit(), spec({ requiredRoles: ["cad"] }), "role_missing"],
    ["a missing default role", liquidHandlingKit({ artifacts: liquidHandlingKit().artifacts.filter((a) => a.role !== "tests") }), spec(), "role_missing"],
    ["an incomplete kit (no implementation)", liquidHandlingKit({ artifacts: liquidHandlingKit().artifacts.filter((a) => a.role !== "method") }), spec(), "incomplete_kit"],
    ["another parent", liquidHandlingKit({ parentKitDigest: H("d") }), spec({ parentKitDigest: H("b") }), "parent_mismatch"],
    ["no parent when one is requested", liquidHandlingKit(), spec({ parentKitDigest: H("b") }), "parent_mismatch"],
  ];
  for (const [label, kit, s, reason] of unmet) {
    it(`does not meet it with ${label} (${reason})`, () => {
      const result = kitMeetsBuildSpec(kit, s);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });
  }
});

describe("decimalToBaseUnits", () => {
  const cases: Array<[number, number, string | null]> = [
    [250.5, 6, "250500000"],
    [1, 6, "1000000"],
    [0.1, 6, "100000"],
    [0.000001, 6, "1"],
    [12.34, 2, "1234"],
    [0.0000001, 6, null],
    [1.1234567, 6, null],
    [0, 6, null],
    [-5, 6, null],
    [Number.NaN, 6, null],
    [Number.POSITIVE_INFINITY, 6, null],
    [1e21, 6, null],
  ];
  for (const [amount, decimals, expected] of cases) {
    it(`${amount} with ${decimals} decimals -> ${expected}`, () => {
      expect(decimalToBaseUnits(amount, decimals)).toBe(expected);
    });
  }
});

describe("kitBuildRequestFromOffer", () => {
  it("a held escrow bound to THIS offer makes the request funded and authoritative, with the escrow's own amount", () => {
    const dto = kitBuildRequestFromOffer(offer(), held(), AS_OF)!;
    expect(dto).toEqual({
      schema: OPPORTUNITY_SCHEMA,
      kind: "kit_build_request",
      id: "kit-build:offer-7",
      capabilityType: LIQUID,
      title: "Build a Capability Kit for liquid-handling v1",
      reward: { amount: "250500000", currency: "USDC", fundingStatus: "funded" },
      fundingRef: { kind: "escrow", id: "esc-1" },
      authority: "authoritative",
      asOf: AS_OF,
    });
    expect(OpportunityDTOSchema.safeParse(dto).success).toBe(true);
  });

  it("the funded reward is the held amount, even when the offer's pricing says something else", () => {
    const dto = kitBuildRequestFromOffer(offer({ pricing: { amount: 9999, currency: "USDC", model: "fixed" } }), held({ amount: "100" }), AS_OF)!;
    expect(dto.reward).toEqual({ amount: "100", currency: "USDC", fundingStatus: "funded" });
  });

  it("a funding statement verified for ANOTHER offer refuses the whole request", () => {
    expect(kitBuildRequestFromOffer(offer(), held({ offerId: "offer-8" }), AS_OF)).toBeNull();
  });

  for (const state of ["released", "refunded", "unknown"] as const) {
    it(`an escrow that is ${state} leaves the request unfunded: derived_signal, no fundingRef`, () => {
      const dto = kitBuildRequestFromOffer(offer(), held({ state }), AS_OF)!;
      expect(dto.authority).toBe("derived_signal");
      expect(dto.fundingRef).toBeUndefined();
      expect(dto.reward).toEqual({ amount: "250500000", currency: "USDC", fundingStatus: "unfunded" });
    });
  }

  for (const [label, f] of [
    ["no amount", held({ amount: "" })],
    ["a zero amount", held({ amount: "0" })],
    ["a decimal amount", held({ amount: "1.5" })],
    ["a leading zero", held({ amount: "0100" })],
    ["no currency", held({ currency: "" })],
    ["no escrow id", held({ id: "" })],
  ] as const) {
    it(`a held statement with ${label} cannot make it funded`, () => {
      const dto = kitBuildRequestFromOffer(offer(), f, AS_OF)!;
      expect(dto.authority).toBe("derived_signal");
      expect(dto.reward?.fundingStatus).not.toBe("funded");
      expect(dto.fundingRef).toBeUndefined();
    });
  }

  it("without funding, an exactly convertible fixed USDC price shows as an unfunded reward", () => {
    const dto = kitBuildRequestFromOffer(offer(), null, AS_OF)!;
    expect(dto.reward).toEqual({ amount: "250500000", currency: "USDC", fundingStatus: "unfunded" });
    expect(dto.authority).toBe("derived_signal");
  });

  for (const [label, pricing] of [
    ["another currency", { amount: 1, currency: "ETH", model: "fixed" }],
    ["a quote-required price", { amount: 1, currency: "USDC", model: "quote-required" }],
    ["more than 6 decimals", { amount: 1.1234567, currency: "USDC", model: "fixed" }],
    ["no pricing", null],
  ] as const) {
    it(`without funding, ${label} shows no reward at all`, () => {
      const dto = kitBuildRequestFromOffer(offer({ pricing }), null, AS_OF)!;
      expect(dto.reward).toBeUndefined();
      expect(dto.authority).toBe("derived_signal");
    });
  }

  it("is null for an offer that is not an open, valid kits.build request", () => {
    expect(kitBuildRequestFromOffer(offer({ capabilityType: "courier.dispatch" }), null, AS_OF)).toBeNull();
    for (const status of ["claimed", "in_progress", "delivered", "completed", "cancelled", "expired"]) {
      expect(kitBuildRequestFromOffer(offer({ status }), held(), AS_OF), status).toBeNull();
    }
    expect(kitBuildRequestFromOffer(offer({ requirements: { csdUrl: LIQUID } }), null, AS_OF)).toBeNull();
    expect(kitBuildRequestFromOffer(offer({ requirements: null }), null, AS_OF)).toBeNull();
  });

  it("derives its id and title; no poster text reaches the DTO", () => {
    const dto = kitBuildRequestFromOffer(offer({ requirements: { ...spec(), title: "free text" } }), null, AS_OF);
    expect(dto).toBeNull(); // an extra key fails the strict spec
    const ok = kitBuildRequestFromOffer(offer(), null, AS_OF)!;
    expect(ok.id).toBe(kitBuildRequestId("offer-7"));
    expect(ok.title).toBe(kitBuildRequestTitle(LIQUID));
  });

  it("carries a pinned revision and a valid deadline through; a malformed deadline or a future asOf yields null", () => {
    const pinned = kitBuildRequestFromOffer(offer({ requirements: spec({ capabilityContractDigest: H("a") }), deadlineIso: "2026-12-01T00:00:00.000Z" }), null, AS_OF)!;
    expect(pinned.capabilityContractDigest).toBe(H("a"));
    expect(pinned.deadline).toBe("2026-12-01T00:00:00.000Z");
    expect(kitBuildRequestFromOffer(offer({ deadlineIso: "next tuesday" }), null, AS_OF)).toBeNull();
    expect(kitBuildRequestFromOffer(offer(), null, "2099-01-01T00:00:00.000Z")).toBeNull();
  });
});

describe("kitBuildSpecPrefill", () => {
  const approved = publicCapabilityUrls([LIQUID]);

  it("drafts a spec for an approved public capability, and derives nothing else", () => {
    expect(kitBuildSpecPrefill(LIQUID, approved)).toEqual({ schema: KIT_BUILD_SPEC_SCHEMA, csdUrl: LIQUID });
  });

  it("is null for a capability that is not approved or not a public capability url", () => {
    expect(kitBuildSpecPrefill(LIQUID, publicCapabilityUrls([]))).toBeNull();
    expect(kitBuildSpecPrefill("pcc://capabilities/alice-smith-1234/v1", [...approved, "pcc://capabilities/alice-smith-1234/v1"])).toBeNull();
    expect(kitBuildSpecPrefill("not a url", approved)).toBeNull();
  });

  it("its draft parses as a spec and a complete kit for the capability meets it", () => {
    const draft = kitBuildSpecPrefill(LIQUID, approved)!;
    expect(parseKitBuildSpec(draft)).toEqual(draft);
    expect(kitMeetsBuildSpec(liquidHandlingKit(), draft)).toEqual({ ok: true });
  });
});
