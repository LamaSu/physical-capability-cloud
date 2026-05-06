/**
 * Local types for the Cypher Bio federation catalog.
 *
 * Mirrors the shape returned by `GET https://cypherbio.ai/backend/api/federation/services/public`
 * (no auth). Source: ai/.cache/cypherbio/CYPHER-API-NOTES.md (live snapshot 2026-05-06).
 *
 * NOTE: redefined locally rather than imported from `@pcc/cypher-lims-bridge`
 * or `@pcc/cypher-federation` because those packages are being scaffolded in
 * parallel (Track A / Track B). Refactor to share once those land.
 */
export type CypherPricingModel = "quote" | "fixed" | "subscription" | string;
export type CypherTurnaroundUnit = "weeks" | "days" | "hours" | string;

export interface CypherPricing {
  basePrice?: number;
  currency?: string;
  pricingModel: CypherPricingModel;
  priceDescription?: string;
}

export interface CypherTurnaround {
  min?: number;
  max?: number;
  unit: CypherTurnaroundUnit;
}

export interface CypherProvider {
  name: string;
  slug?: string;
  logoFileId?: string;
  description?: string;
  contactEmail?: string;
  /** S3 presigned URL — short-lived, may expire. */
  logo?: string;
}

export interface CypherStats {
  totalOrders?: number;
  completedOrders?: number;
  reviewCount?: number;
}

export interface CypherSourceInstance {
  _id?: string;
  instanceId?: string;
  name?: string;
  baseUrl?: string;
}

/**
 * A `Service` record from the Cypher Bio federation catalog. The `orderFormSchema`
 * is a JSON Schema (draft-07) describing the order form for this service —
 * different per provider, so typed loose.
 */
export interface CypherFederationService {
  _id: string;
  name: string;
  description?: string;
  category?: string;
  status?: string;
  visibility?: string;
  pricing: CypherPricing;
  estimatedTurnaround?: CypherTurnaround;
  provider: CypherProvider;
  stats?: CypherStats;
  sourceInstance?: CypherSourceInstance;
  sourceServiceId?: string;
  sourceServiceProviderId?: string;
  /** JSON Schema (draft-07) describing the order form. Loose-typed by design. */
  orderFormSchema?: Record<string, unknown>;
  termsAndConditionsUrl?: string;
  publishedAt?: string;
  lastSyncAt?: string;
  syncStatus?: string;
  allowedOrganizations?: string[];
  allowedUsers?: string[];
}
