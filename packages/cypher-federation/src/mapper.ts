/**
 * Bidirectional mapper between PCC `Capability` summaries and Cypher
 * federation `Service` documents.
 *
 * The two directions are not symmetric — Cypher's catalog has more
 * presentation metadata (provider info, S3 logo URLs, JSON Schema
 * order forms) than PCC's capability shape. We round-trip the bits
 * that are stable across both, and fill the rest with sane defaults.
 *
 * Track A spec: define our own minimal mapper here. Track B's
 * `cypher-lims-bridge` only goes Cypher → PCC; the new direction
 * (PCC → Cypher) is the contribution this package adds.
 */

import type {
  CypherFederationService,
  CypherProvider,
  CypherSourceInstance,
  PccCapabilitySummary,
} from "./types.js";

// ── Cypher → PCC ────────────────────────────────────────────────

/**
 * Convert a Cypher federation service into a PCC capability summary.
 *
 * The PCC side has no concept of `pricingModel: "quote"` per se —
 * we model "quote" services with `pricing.pricingModel: "quote"` in
 * the summary; downstream PCC consumers can treat that as a flag to
 * route through the negotiation API rather than the build-contract
 * flow.
 */
export function cypherServiceToPccCapability(
  svc: CypherFederationService,
): PccCapabilitySummary {
  return {
    id: `cypher-${svc.sourceInstance.instanceId}-${svc._id}`,
    kernelId: `cypher-${svc.sourceInstance.instanceId}`,
    type: deriveTypeFromCategory(svc.category, svc.name),
    name: svc.name,
    description: svc.description,
    materials: extractMaterials(svc),
    assuranceTiers: [0, 1], // Cypher's federation doesn't expose ALCOA tiers; default to 0/1.
    pricing: {
      currency: svc.pricing.currency,
      baseCost: svc.pricing.basePrice ?? 0,
      pricingModel: svc.pricing.pricingModel,
      priceDescription: svc.pricing.priceDescription,
    },
    tags: buildTags(svc),
    inputSchema:
      svc.orderFormSchema && typeof svc.orderFormSchema === "object" ? svc.orderFormSchema : undefined,
  };
}

// ── PCC → Cypher ────────────────────────────────────────────────

export interface InstanceContext {
  /** PCC's federation instance row inside Cypher. */
  sourceInstance: CypherSourceInstance;
  /** Provider summary used for every PCC-originated service entry. */
  provider?: CypherProvider;
  /**
   * URL where Cypher links to terms-and-conditions for PCC services.
   * Optional — Cypher tolerates absence.
   */
  termsAndConditionsUrl?: string;
}

/**
 * Convert a PCC capability into a Cypher federation service entry
 * suitable for `POST /api/federation/services`.
 *
 * Cypher requires `_id` to be unique within its catalog; we use a
 * deterministic id derived from the PCC capability id so the same
 * capability re-publishes idempotently.
 */
export function pccCapabilityToCypherService(
  cap: PccCapabilitySummary,
  ctx: InstanceContext,
): CypherFederationService {
  const provider: CypherProvider =
    ctx.provider ?? {
      name: ctx.sourceInstance.name,
      slug: ctx.sourceInstance.instanceId,
      description:
        "Physical Capability Cloud — assurance-tiered manufacturing capabilities. Settled on Base Sepolia (testnet) via MilestoneEscrow.",
    };

  // Map PCC capability bits onto the Cypher catalog shape.
  return {
    _id: `pcc-${ctx.sourceInstance.instanceId}-${cap.id}`,
    name: cap.name,
    description: cap.description,
    category: cap.type,
    status: "active",
    visibility: "public",
    pricing: {
      basePrice: pricingNumeric(cap.pricing?.baseCost),
      currency: cap.pricing?.currency ?? "USD",
      pricingModel: cap.pricing?.pricingModel ?? "quote",
      priceDescription: cap.pricing?.priceDescription ?? "Quote on submit (settled via PCC escrow)",
    },
    estimatedTurnaround: { min: 1, max: 7, unit: "days" },
    provider,
    sourceInstance: ctx.sourceInstance,
    sourceServiceId: cap.id,
    sourceServiceProviderId: cap.kernelId,
    orderFormSchema: cap.inputSchema ?? synthesizeOrderForm(cap),
    termsAndConditionsUrl: ctx.termsAndConditionsUrl,
    publishedAt: new Date().toISOString(),
    syncStatus: "in_sync",
  };
}

// ── helpers ─────────────────────────────────────────────────────

function pricingNumeric(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function deriveTypeFromCategory(category: string | undefined, name: string): string {
  if (category && category.length > 0) {
    return category.toLowerCase().replace(/\s+/g, "-");
  }
  // Fallback: best-effort guess from the service name.
  return name.toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

function extractMaterials(svc: CypherFederationService): string[] {
  // Some Cypher services embed materials in orderFormSchema.properties.material.enum
  const ofs = svc.orderFormSchema as
    | { properties?: { material?: { enum?: unknown[] } } }
    | undefined;
  const mat = ofs?.properties?.material?.enum;
  if (Array.isArray(mat)) {
    return mat.filter((m): m is string => typeof m === "string");
  }
  return [];
}

function buildTags(svc: CypherFederationService): string[] {
  const tags: string[] = [];
  if (svc.category) tags.push(svc.category);
  tags.push(`source:cypher-${svc.sourceInstance.instanceId}`);
  if (svc.pricing.pricingModel) tags.push(`pricing:${svc.pricing.pricingModel}`);
  return tags;
}

/**
 * If a PCC capability has no inputSchema, synthesize a minimal JSON
 * Schema draft-07 form so Cypher's order UI has something to render.
 */
function synthesizeOrderForm(cap: PccCapabilitySummary): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    notes: {
      type: "string",
      title: "Job notes",
      description: `Free-text instructions for the PCC operator running the ${cap.name} job.`,
    },
    quantity: {
      type: "integer",
      title: "Quantity",
      minimum: 1,
      default: 1,
    },
  };
  if ((cap.materials?.length ?? 0) > 0) {
    properties.material = {
      type: "string",
      title: "Material",
      enum: cap.materials,
    };
  }
  if ((cap.assuranceTiers?.length ?? 0) > 0) {
    properties.assuranceTier = {
      type: "integer",
      title: "Assurance tier",
      enum: cap.assuranceTiers,
      default: cap.assuranceTiers?.[0] ?? 0,
    };
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: `${cap.name} order`,
    type: "object",
    properties,
    required: ["quantity"],
  };
}
