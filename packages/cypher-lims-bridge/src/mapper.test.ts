import { describe, expect, it } from "vitest";

import {
  cypherFederationServiceToMcpToolDef,
  cypherServiceToPccCapability,
  pccCapabilityToCypherService,
} from "./mapper.js";
import type { CypherFederationService, PccCapabilityShape } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures (from CYPHER-API-NOTES.md)
// ---------------------------------------------------------------------------

const WAYBIO_SERVICE: CypherFederationService = {
  _id: "svc_waybio_001",
  name: "Plasmid Cloning / Prep / Consultation",
  description: "Professional plasmid preparation services",
  category: "molecular-biology",
  status: "active",
  visibility: "public",
  pricing: {
    pricingModel: "quote",
    priceDescription: "Quote on request",
    currency: "USD",
    basePrice: undefined,
  },
  estimatedTurnaround: { min: 2, max: 4, unit: "weeks" },
  provider: {
    name: "WayBio",
    slug: "waybio",
    description: "Plasmid synthesis specialists",
    contactEmail: "orders@waybio.com",
    logo: "https://s3.us-east-2.amazonaws.com/cypherbio-files/waybio-logo.png",
  },
  stats: { totalOrders: 5, completedOrders: 3, reviewCount: 0 },
  sourceInstance: {
    _id: "inst_waybio",
    instanceId: "waybio",
    name: "WayBio LIMS",
    baseUrl: "https://waybio.cypherbio.ai",
  },
  orderFormSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["email", "company", "plasmidCount"],
    properties: {
      email: { type: "string", format: "email" },
      company: { type: "string" },
      plasmidCount: { type: "number", minimum: 1 },
    },
  },
  allowedOrganizations: [],
  allowedUsers: [],
};

const FLOCK_BIO_SERVICE: CypherFederationService = {
  _id: "svc_flock_001",
  name: "Pooled DNA Libraries",
  description: "High-throughput pooled DNA library services",
  category: "genomics",
  status: "active",
  visibility: "public",
  pricing: { pricingModel: "quote" },
  provider: { name: "Flock Bio", slug: "flockbio" },
  allowedOrganizations: [],
  allowedUsers: [],
};

/** Service without optional fields — tests edge-case handling. */
const MINIMAL_SERVICE: CypherFederationService = {
  _id: "svc_minimal_001",
  name: "Minimal Service",
  provider: { name: "Unknown Provider", slug: "unknown" },
  allowedOrganizations: [],
  allowedUsers: [],
};

// ---------------------------------------------------------------------------
// cypherServiceToPccCapability
// ---------------------------------------------------------------------------
describe("cypherServiceToPccCapability — WayBio fixture", () => {
  it("produces a PCC capability with type='molecular-biology' from category", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.type).toBe("molecular-biology");
  });

  it("produces kernelId from provider.slug", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.kernelId).toBe("waybio");
  });

  it("includes orderFormSchema as inputSchema", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.inputSchema).toBeDefined();
    expect(cap.inputSchema?.required).toContain("email");
  });

  it("carries pricing through (pricingModel='quote')", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.pricing.pricingModel).toBe("quote");
    expect(cap.pricing.priceDescription).toBe("Quote on request");
  });

  it("has source.system='cypher' and source.providerSlug='waybio'", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.source.system).toBe("cypher");
    expect(cap.source.providerSlug).toBe("waybio");
    expect(cap.source.serviceId).toBe("svc_waybio_001");
  });

  it("includes instanceBaseUrl from sourceInstance.baseUrl", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.source.instanceBaseUrl).toBe("https://waybio.cypherbio.ai");
  });

  it("includes assuranceTiers [1, 2] (external lab service)", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.assuranceTiers).toEqual(expect.arrayContaining([1, 2]));
  });

  it("generates a turnaround tag in the tags array", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.tags.some((t) => t.startsWith("turnaround:"))).toBe(true);
  });

  it("includes provider tag", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.tags).toContain("provider:waybio");
  });
});

describe("cypherServiceToPccCapability — Flock Bio fixture", () => {
  it("maps correctly for a different provider", () => {
    const cap = cypherServiceToPccCapability(FLOCK_BIO_SERVICE);
    expect(cap.kernelId).toBe("flockbio");
    expect(cap.type).toBe("genomics");
    expect(cap.source.providerSlug).toBe("flockbio");
  });
});

describe("cypherServiceToPccCapability — edge cases", () => {
  it("handles missing provider.logo gracefully (no throw)", () => {
    const svc: CypherFederationService = {
      ...WAYBIO_SERVICE,
      provider: { name: "WayBio", slug: "waybio" }, // no logo
    };
    expect(() => cypherServiceToPccCapability(svc)).not.toThrow();
  });

  it("handles missing stats gracefully", () => {
    const svc: CypherFederationService = { ...WAYBIO_SERVICE, stats: undefined };
    expect(() => cypherServiceToPccCapability(svc)).not.toThrow();
  });

  it("handles empty allowedOrganizations array", () => {
    const cap = cypherServiceToPccCapability({ ...WAYBIO_SERVICE, allowedOrganizations: [] });
    expect(cap.source.system).toBe("cypher");
  });

  it("falls back to 'lab-services' type when category is missing", () => {
    const cap = cypherServiceToPccCapability(MINIMAL_SERVICE);
    expect(cap.type).toBe("lab-services");
  });

  it("handles missing sourceInstance (no instanceBaseUrl)", () => {
    const cap = cypherServiceToPccCapability(MINIMAL_SERVICE);
    expect(cap.source.instanceBaseUrl).toBeUndefined();
  });

  it("handles pricingModel='fixed' variant", () => {
    const svc: CypherFederationService = {
      ...WAYBIO_SERVICE,
      pricing: { pricingModel: "fixed", basePrice: 500, currency: "USD" },
    };
    const cap = cypherServiceToPccCapability(svc);
    expect(cap.pricing.pricingModel).toBe("fixed");
    expect(cap.tags).toContain("pricing:fixed");
  });

  it("stable capability id format: 'cypher:<slug>:<_id>'", () => {
    const cap = cypherServiceToPccCapability(WAYBIO_SERVICE);
    expect(cap.id).toBe("cypher:waybio:svc_waybio_001");
  });
});

// ---------------------------------------------------------------------------
// cypherFederationServiceToMcpToolDef
// ---------------------------------------------------------------------------
describe("cypherFederationServiceToMcpToolDef", () => {
  it("produces a valid MCP tool definition with a name, description, input_schema, endpoint", () => {
    const toolDef = cypherFederationServiceToMcpToolDef(WAYBIO_SERVICE);
    expect(toolDef.name).toBeDefined();
    expect(toolDef.description).toBeDefined();
    expect(toolDef.input_schema).toBeDefined();
    expect(toolDef.endpoint).toBeDefined();
    expect(toolDef.endpoint.method).toBe("POST");
    expect(toolDef.endpoint.path).toBe("/api/negotiate/session");
  });

  it("name starts with 'cypher_' and includes provider slug", () => {
    const toolDef = cypherFederationServiceToMcpToolDef(WAYBIO_SERVICE);
    expect(toolDef.name).toMatch(/^cypher_waybio_/);
  });

  it("input_schema equals orderFormSchema when present", () => {
    const toolDef = cypherFederationServiceToMcpToolDef(WAYBIO_SERVICE);
    expect(toolDef.input_schema).toMatchObject({
      required: expect.arrayContaining(["email", "company", "plasmidCount"]),
    });
  });

  it("falls back to permissive schema when orderFormSchema is missing", () => {
    const toolDef = cypherFederationServiceToMcpToolDef(MINIMAL_SERVICE);
    expect(toolDef.input_schema.additionalProperties).toBe(true);
  });

  it("source='cypher' on the returned definition", () => {
    const toolDef = cypherFederationServiceToMcpToolDef(WAYBIO_SERVICE);
    expect(toolDef.source).toBe("cypher");
  });
});

// ---------------------------------------------------------------------------
// pccCapabilityToCypherService (reverse map)
// ---------------------------------------------------------------------------
describe("pccCapabilityToCypherService", () => {
  const PCC_CAP: PccCapabilityShape = {
    id: "cypher:waybio:svc_waybio_001",
    kernelId: "waybio",
    type: "molecular-biology",
    name: "Plasmid Cloning / Prep / Consultation",
    description: "Professional plasmid preparation services",
    materials: [],
    pricing: { pricingModel: "quote", currency: "USD" },
    tags: ["provider:waybio"],
    assuranceTiers: [1, 2],
    source: { system: "cypher", serviceId: "svc_waybio_001", providerSlug: "waybio" },
  };

  it("maps name and description through", () => {
    const svc = pccCapabilityToCypherService(PCC_CAP);
    expect(svc.name).toBe(PCC_CAP.name);
    expect(svc.description).toBe(PCC_CAP.description);
  });

  it("sets status='active' and visibility='public'", () => {
    const svc = pccCapabilityToCypherService(PCC_CAP);
    expect(svc.status).toBe("active");
    expect(svc.visibility).toBe("public");
  });

  it("carries pricing model through", () => {
    const svc = pccCapabilityToCypherService(PCC_CAP);
    expect(svc.pricing?.pricingModel).toBe("quote");
  });

  it("sets provider.slug from kernelId", () => {
    const svc = pccCapabilityToCypherService(PCC_CAP);
    expect(svc.provider.slug).toBe("waybio");
  });
});
