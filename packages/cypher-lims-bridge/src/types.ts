/**
 * @pcc/cypher-lims-bridge — type definitions
 *
 * Mirrors the JSON schemas observed in the live Cypher Bio API
 * (https://cypherbio.ai/backend) as documented in
 * ~/.cache/cypherbio/CYPHER-API-NOTES.md.
 *
 * All shapes are intentionally permissive — Cypher's API is not formally
 * documented for `cyp_lims_*` keys (the OpenAPI doc returns 403), so we keep
 * unknown fields rather than reject them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// JSON Schema (draft-07) — used in federation orderFormSchema
// ---------------------------------------------------------------------------

export interface JsonSchemaDraft07 {
  $schema?: string;
  $id?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaDraft07>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchemaDraft07 | JsonSchemaDraft07[];
  additionalProperties?: boolean | JsonSchemaDraft07;
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JsonSchemaDraft07[];
  anyOf?: JsonSchemaDraft07[];
  allOf?: JsonSchemaDraft07[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Federation catalog
// ---------------------------------------------------------------------------

export interface CypherPricing {
  basePrice?: number;
  currency?: string;
  pricingModel: 'quote' | 'fixed' | 'tiered' | string;
  priceDescription?: string;
}

export interface CypherTurnaround {
  min?: number;
  max?: number;
  unit: 'weeks' | 'days' | 'hours' | string;
}

export interface CypherProvider {
  name: string;
  slug: string;
  logoFileId?: string;
  description?: string;
  contactEmail?: string;
  /** Presigned S3 URL — short-lived. */
  logo?: string;
}

export interface CypherSourceInstance {
  _id: string;
  instanceId: string;
  name: string;
  baseUrl: string;
}

export interface CypherFederationStats {
  totalOrders?: number;
  completedOrders?: number;
  reviewCount?: number;
}

export interface CypherFederationService {
  _id: string;
  name: string;
  description?: string;
  category?: string;
  status?: string;
  visibility?: string;
  pricing?: CypherPricing;
  estimatedTurnaround?: CypherTurnaround;
  provider: CypherProvider;
  stats?: CypherFederationStats;
  sourceInstance?: CypherSourceInstance;
  sourceServiceId?: string;
  sourceServiceProviderId?: string;
  orderFormSchema?: JsonSchemaDraft07;
  termsAndConditionsUrl?: string;
  publishedAt?: string;
  lastSyncAt?: string;
  syncStatus?: string;
  allowedOrganizations?: string[];
  allowedUsers?: string[];
}

// ---------------------------------------------------------------------------
// LIMS module
// ---------------------------------------------------------------------------

export interface CypherLimsRequest {
  _id: string;
  /** Human-readable identifier (e.g. "REQ-20260506-0001"). */
  requestNumber: string;
  workType?: string;
  status?: string;
  visibility?: string;
  organizationId?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CypherLimsWorkflow {
  _id: string;
  workflowLineageId?: string;
  name?: string;
  visibility?: string;
  organizationId?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CypherLimsStep {
  _id: string;
  name?: string;
  workflowId?: string;
  workflowLineageId?: string;
  requestId?: string;
  status?: string;
  workType?: string;
  /** Free-form payload describing the step's parameters. */
  data?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CypherLimsMeasurementDataPoint {
  /** Sample, container, or other lineage anchor — Cypher accepts several shapes. */
  sampleId?: string;
  containerId?: string;
  stepId?: string;
  /** Numeric or categorical reading. */
  value?: number | string;
  unit?: string;
  metric?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface CypherLimsMeasurementBatch {
  /** When supplied, the runtime parses CSV inline. */
  csvData?: string;
  /** Pre-uploaded file ID (from /api/files/upload). */
  fileId?: string;
  /** Inline structured points — preferred for small batches. */
  dataPoints?: CypherLimsMeasurementDataPoint[];
  /** Optional context for the batch. */
  stepId?: string;
  sampleId?: string;
  uploadBatchId?: string;
  [key: string]: unknown;
}

export interface CypherLimsRecordWorkPayload {
  stepId: string;
  payload: Record<string, unknown>;
  operatorId?: string;
}

// ---------------------------------------------------------------------------
// Pagination wrapper
// ---------------------------------------------------------------------------

export interface CypherPaginationParams {
  limit?: number;
  offset?: number;
  workType?: string;
}

// ---------------------------------------------------------------------------
// Client response wrapper
// ---------------------------------------------------------------------------

export interface CypherApiResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

// ---------------------------------------------------------------------------
// PCC capability mapping target
// ---------------------------------------------------------------------------

/**
 * Subset of PCC's CapabilityDTO that we can populate from a Cypher federation
 * service. Full DTO is defined in `@pcc/types` — we keep a local minimal shape
 * to avoid an inter-package dependency at this stage.
 */
export interface PccCapabilityShape {
  id: string;
  kernelId: string;
  type: string;
  name: string;
  description?: string;
  materials: string[];
  pricing: {
    currency?: string;
    basePrice?: number;
    pricingModel?: string;
    priceDescription?: string;
  };
  location?: { lat: number; lng: number };
  tags: string[];
  assuranceTiers: number[];
  /** Order/intake schema, lifted from federation orderFormSchema. */
  inputSchema?: JsonSchemaDraft07;
  /** Provenance — links back to the Cypher federation entry. */
  source: {
    system: 'cypher';
    serviceId: string;
    providerSlug: string;
    instanceBaseUrl?: string;
  };
}

/**
 * MCP-style tool definition. Mirrors the shape used by `apps/dashboard/public/agent-package.json`.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchemaDraft07;
  endpoint: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string };
  /** Optional metadata pinning the tool to its origin. */
  source?: 'pcc' | 'cypher' | string;
}
