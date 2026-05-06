/**
 * @pcc/cypher-lims-bridge — federation <-> capability mapper
 *
 * Two directions:
 *  - cypherServiceToPccCapability: Cypher federation entry -> PCC capability shape.
 *    Used to cross-list Cypher providers (WayBio, Flock Bio, ...) in PCC discovery.
 *  - pccCapabilityToCypherService: minimal reverse map. Used when an operator
 *    wants to publish a PCC capability into Cypher's federation catalog.
 *
 * Plus a helper that emits an MCP-style tool definition from a Cypher service
 * so the cross-listed entry shows up in agent packages.
 */

import type {
  CypherFederationService,
  JsonSchemaDraft07,
  McpToolDefinition,
  PccCapabilityShape,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Translate the federation `category` into a PCC capability `type`. */
function categoryToType(category: string | undefined): string {
  if (!category) return 'lab-services';
  // Cypher categories are kebab-case strings ("molecular-biology", "genomics", ...).
  // PCC types are also kebab-case — we forward as-is, only lowercasing for safety.
  return category.toLowerCase().trim();
}

/** Build a turnaround tag like "turnaround:2-4-weeks" for use in PCC tags. */
function turnaroundTag(svc: CypherFederationService): string | null {
  const t = svc.estimatedTurnaround;
  if (!t || (t.min === undefined && t.max === undefined)) return null;
  const range = t.min !== undefined && t.max !== undefined && t.min !== t.max
    ? `${t.min}-${t.max}`
    : String(t.min ?? t.max ?? '');
  if (!range) return null;
  return `turnaround:${range}-${t.unit ?? 'days'}`;
}

/** Fallback baseUrl when the federation entry doesn't carry sourceInstance. */
function inferProviderBaseUrl(svc: CypherFederationService): string | undefined {
  return svc.sourceInstance?.baseUrl ?? undefined;
}

/** Stable PCC capability id for a Cypher federation entry. */
function deriveCapabilityId(svc: CypherFederationService): string {
  const slug = svc.provider?.slug ?? 'cypher';
  return `cypher:${slug}:${svc._id}`;
}

// ---------------------------------------------------------------------------
// Cypher -> PCC
// ---------------------------------------------------------------------------

/**
 * Map a Cypher federation service entry to a PCC `Capability` shape.
 *
 * The mapping is intentionally lossy in the PCC direction — Cypher's federation
 * model carries provider-specific fields (allowedOrganizations, sourceInstance,
 * lastSyncAt) that have no PCC analogue. Those are NOT silently dropped: they
 * survive on the `source` field for any caller that needs to round-trip back
 * to the Cypher entry.
 */
export function cypherServiceToPccCapability(
  svc: CypherFederationService,
): PccCapabilityShape {
  const tags: string[] = [];
  if (svc.provider?.slug) tags.push(`provider:${svc.provider.slug}`);
  if (svc.visibility) tags.push(`visibility:${svc.visibility}`);
  if (svc.status) tags.push(`status:${svc.status}`);
  const tt = turnaroundTag(svc);
  if (tt) tags.push(tt);
  if (svc.pricing?.pricingModel) tags.push(`pricing:${svc.pricing.pricingModel}`);

  // Most Cypher services are quote-based — list as supporting tier 1 at minimum.
  // (Tier 0 is self-attested, which doesn't fit a multi-week external service.)
  const assuranceTiers: number[] = [1, 2];

  return {
    id: deriveCapabilityId(svc),
    kernelId: svc.provider?.slug ?? 'cypher-unknown',
    type: categoryToType(svc.category),
    name: svc.name,
    description: svc.description,
    materials: [],
    pricing: {
      currency: svc.pricing?.currency,
      basePrice: svc.pricing?.basePrice,
      pricingModel: svc.pricing?.pricingModel,
      priceDescription: svc.pricing?.priceDescription,
    },
    tags,
    assuranceTiers,
    inputSchema: svc.orderFormSchema,
    source: {
      system: 'cypher',
      serviceId: svc._id,
      providerSlug: svc.provider?.slug ?? 'unknown',
      instanceBaseUrl: inferProviderBaseUrl(svc),
    },
  };
}

// ---------------------------------------------------------------------------
// PCC -> Cypher (minimal reverse — used for publishing PCC services to Cypher)
// ---------------------------------------------------------------------------

/**
 * Reverse map: build a Cypher federation service payload from a PCC capability.
 *
 * Only the fields a federation publisher needs to send are emitted. Cypher
 * fills in `_id`, `publishedAt`, `sourceInstance`, `stats` server-side.
 */
export function pccCapabilityToCypherService(
  cap: PccCapabilityShape,
): Omit<CypherFederationService, '_id'> {
  const providerSlug = cap.kernelId;
  return {
    name: cap.name,
    description: cap.description,
    category: cap.type,
    status: 'active',
    visibility: 'public',
    pricing: cap.pricing.pricingModel
      ? {
          basePrice: cap.pricing.basePrice,
          currency: cap.pricing.currency,
          pricingModel: cap.pricing.pricingModel,
          priceDescription: cap.pricing.priceDescription,
        }
      : undefined,
    provider: {
      name: providerSlug,
      slug: providerSlug,
    },
    orderFormSchema: cap.inputSchema,
    allowedOrganizations: [],
    allowedUsers: [],
  };
}

// ---------------------------------------------------------------------------
// Cypher -> MCP tool definition (for cross-listing in agent packages)
// ---------------------------------------------------------------------------

/**
 * Lift a Cypher federation entry into a partial MCP tool definition. The
 * `input_schema` is the federation `orderFormSchema` (typically a JSON Schema
 * draft-07 with `email`, `company`, ...); the `endpoint` points at the PCC
 * negotiate-session route, since orders flow into Cypher via a PCC negotiate
 * commit, not by hitting Cypher directly.
 *
 * Callers (e.g., the dashboard or agent-package builder) can post-process this
 * to inject project-specific fields like `kernelId` defaults.
 */
export function cypherFederationServiceToMcpToolDef(
  svc: CypherFederationService,
): McpToolDefinition {
  const inputSchema: JsonSchemaDraft07 = svc.orderFormSchema ?? {
    type: 'object',
    description: 'No order form schema published; supply free-form params.',
    additionalProperties: true,
  };

  const slug = svc.provider?.slug ?? 'cypher';
  const safeName = svc.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return {
    name: `cypher_${slug}_${safeName || svc._id}`,
    description: svc.description ?? `Cypher federation service: ${svc.name}`,
    input_schema: inputSchema,
    endpoint: { method: 'POST', path: '/api/negotiate/session' },
    source: 'cypher',
  };
}
