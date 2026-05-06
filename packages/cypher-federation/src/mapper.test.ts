import { describe, expect, it } from "vitest";

import {
  cypherServiceToPccCapability,
  pccCapabilityToCypherService,
} from "./mapper.js";
import type {
  CypherFederationService,
  CypherSourceInstance,
  PccCapabilitySummary,
} from "./types.js";

const PCC_INSTANCE: CypherSourceInstance = {
  instanceId: "pcc",
  name: "PCC",
  baseUrl: "https://capability.network/cypher/federation",
};

function sampleCypherService(over: Partial<CypherFederationService> = {}): CypherFederationService {
  return {
    _id: "srv_waybio_plasmid_prep",
    name: "Plasmid Cloning / Prep / Consultation",
    description: "Custom plasmid cloning, prep, and consult.",
    category: "Plasmid Services",
    status: "active",
    visibility: "public",
    pricing: { basePrice: 0, currency: "USD", pricingModel: "quote" },
    estimatedTurnaround: { min: 1, max: 3, unit: "weeks" },
    provider: { name: "WayBio", slug: "waybio" },
    sourceInstance: { instanceId: "waybio", name: "WayBio", baseUrl: "https://waybio.cypherbio.ai/api" },
    sourceServiceId: "internal-1",
    orderFormSchema: {
      type: "object",
      properties: {
        material: { enum: ["pUC19", "pET28a", "pET22b"] },
        plasmidCount: { type: "integer" },
      },
    },
    ...over,
  };
}

function samplePccCapability(over: Partial<PccCapabilitySummary> = {}): PccCapabilitySummary {
  return {
    id: "cap-fdm-1",
    kernelId: "kernel-printshop-alpha",
    type: "3d-printing",
    name: "FDM 3D Printing",
    description: "Polymer extrusion, build volume 250×210×220 mm",
    materials: ["PLA", "PETG", "ABS"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USD", baseCost: "12.00", pricingModel: "quote", priceDescription: "Per part" },
    location: { lat: 37.77, lng: -122.42 },
    tags: ["polymer", "fdm"],
    ...over,
  };
}

describe("cypherServiceToPccCapability", () => {
  it("maps essential fields", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService());
    expect(cap.id).toBe("cypher-waybio-srv_waybio_plasmid_prep");
    expect(cap.kernelId).toBe("cypher-waybio");
    expect(cap.type).toBe("plasmid-services");
    expect(cap.name).toBe("Plasmid Cloning / Prep / Consultation");
    expect(cap.pricing?.pricingModel).toBe("quote");
    expect(cap.pricing?.currency).toBe("USD");
  });

  it("extracts materials from orderFormSchema.material.enum", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService());
    expect(cap.materials).toEqual(["pUC19", "pET28a", "pET22b"]);
  });

  it("returns empty materials when no orderFormSchema is present", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService({ orderFormSchema: undefined }));
    expect(cap.materials).toEqual([]);
  });

  it("derives type from name when category is missing", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService({ category: undefined, name: "DNA Sequencing" }));
    expect(cap.type).toBe("dna-sequencing");
  });

  it("tags include source instance and pricing model", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService());
    expect(cap.tags).toContain("source:cypher-waybio");
    expect(cap.tags).toContain("pricing:quote");
  });

  it("forwards the orderFormSchema as inputSchema", () => {
    const cap = cypherServiceToPccCapability(sampleCypherService());
    expect(cap.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("pccCapabilityToCypherService", () => {
  it("produces a service with deterministic _id derived from the PCC cap id", () => {
    const svc = pccCapabilityToCypherService(samplePccCapability(), { sourceInstance: PCC_INSTANCE });
    expect(svc._id).toBe("pcc-pcc-cap-fdm-1");
    expect(svc.sourceServiceId).toBe("cap-fdm-1");
    expect(svc.sourceServiceProviderId).toBe("kernel-printshop-alpha");
  });

  it("preserves pricing model 'quote' cleanly", () => {
    const svc = pccCapabilityToCypherService(samplePccCapability(), { sourceInstance: PCC_INSTANCE });
    expect(svc.pricing.pricingModel).toBe("quote");
    expect(svc.pricing.currency).toBe("USD");
    expect(svc.pricing.basePrice).toBe(12); // numeric coercion of "12.00"
  });

  it("falls back to 0 when basePrice is missing", () => {
    const cap = samplePccCapability({ pricing: { currency: "USD", pricingModel: "quote" } });
    const svc = pccCapabilityToCypherService(cap, { sourceInstance: PCC_INSTANCE });
    expect(svc.pricing.basePrice).toBe(0);
  });

  it("uses default provider when none is supplied", () => {
    const svc = pccCapabilityToCypherService(samplePccCapability(), { sourceInstance: PCC_INSTANCE });
    expect(svc.provider.name).toBe("PCC");
    expect(svc.provider.slug).toBe("pcc");
  });

  it("uses overridden provider when supplied", () => {
    const svc = pccCapabilityToCypherService(samplePccCapability(), {
      sourceInstance: PCC_INSTANCE,
      provider: { name: "PrintShop Alpha", slug: "printshop-alpha", contactEmail: "alpha@x" },
    });
    expect(svc.provider.name).toBe("PrintShop Alpha");
  });

  it("synthesizes an order form schema when capability has none", () => {
    const cap = samplePccCapability({ inputSchema: undefined });
    const svc = pccCapabilityToCypherService(cap, { sourceInstance: PCC_INSTANCE });
    const ofs = svc.orderFormSchema as Record<string, unknown>;
    expect(ofs.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const props = ofs.properties as Record<string, unknown>;
    expect(props.quantity).toBeDefined();
    expect(props.material).toMatchObject({ enum: ["PLA", "PETG", "ABS"] });
    expect(ofs.required).toEqual(["quantity"]);
  });

  it("preserves a supplied orderFormSchema verbatim", () => {
    const cap = samplePccCapability({
      inputSchema: { type: "object", properties: { customField: { type: "string" } } },
    });
    const svc = pccCapabilityToCypherService(cap, { sourceInstance: PCC_INSTANCE });
    expect(svc.orderFormSchema).toMatchObject({
      properties: { customField: { type: "string" } },
    });
  });

  it("populates publishedAt with a parseable timestamp", () => {
    const svc = pccCapabilityToCypherService(samplePccCapability(), { sourceInstance: PCC_INSTANCE });
    expect(svc.publishedAt).toBeDefined();
    expect(Number.isFinite(Date.parse(svc.publishedAt!))).toBe(true);
  });
});

describe("round-trip: cypher → pcc → cypher", () => {
  it("preserves pricing model and currency", () => {
    const orig = sampleCypherService();
    const pcc = cypherServiceToPccCapability(orig);
    const back = pccCapabilityToCypherService(pcc, { sourceInstance: PCC_INSTANCE });
    expect(back.pricing.pricingModel).toBe(orig.pricing.pricingModel);
    expect(back.pricing.currency).toBe(orig.pricing.currency);
  });

  it("preserves description", () => {
    const orig = sampleCypherService();
    const pcc = cypherServiceToPccCapability(orig);
    const back = pccCapabilityToCypherService(pcc, { sourceInstance: PCC_INSTANCE });
    expect(back.description).toBe(orig.description);
  });
});
