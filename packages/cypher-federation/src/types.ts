/**
 * Shared types for the @pcc/cypher-federation peer package.
 *
 * Cypher-side shapes match the live API surface documented in
 * `~/.cache/cypherbio/CYPHER-API-NOTES.md`. PCC-side shapes are a
 * minimal subset of what `@pcc/spec` exposes — we don't import that
 * package here to keep this peer self-contained per the Track A spec.
 *
 * `CypherCredentials` is the response payload from
 * `POST /api/federation/instances/register`. The exact field set is
 * undocumented externally; we model it as `instanceId` + opaque
 * `apiKey` + `secret`, which matches what Cypher's frontend assumes
 * after register.
 */

// ── Cypher-side shapes (federation registry + service catalog) ─────────────────

/** Pricing model on a Cypher federation service. */
export type CypherPricingModel = "fixed" | "quote" | "tiered" | "subscription";

/** Cypher service estimated turnaround. */
export interface CypherTurnaround {
  min: number;
  max: number;
  unit: "hours" | "days" | "weeks" | "months";
}

/** Cypher service pricing. */
export interface CypherPricing {
  /** Numeric base price in `currency`. May be 0 for `pricingModel: "quote"`. */
  basePrice: number;
  currency: string;
  pricingModel: CypherPricingModel;
  /** Free-text price hint shown in the catalog tile. */
  priceDescription?: string;
}

/** Cypher service provider summary. */
export interface CypherProvider {
  /** Provider name shown in the catalog. */
  name: string;
  /** URL slug used in `https://<slug>.cypherbio.ai/`. */
  slug: string;
  /** Description shown on the provider's storefront. */
  description?: string;
  /** Contact email. */
  contactEmail?: string;
  /** S3 file id of the provider logo. */
  logoFileId?: string;
  /** Pre-signed S3 URL of the logo (populated by the catalog endpoint). */
  logo?: string;
}

/** Pointer back to the federation instance that owns the service. */
export interface CypherSourceInstance {
  /** Mongo `_id` of the federation instance row inside Cypher. */
  _id?: string;
  /** Stable ID Cypher uses to refer to this instance in URLs. */
  instanceId: string;
  /** Display name. */
  name: string;
  /** Federation peer base URL (where Cypher POSTs orders). */
  baseUrl: string;
}

/** Cypher service stats (populated server-side). */
export interface CypherServiceStats {
  totalOrders?: number;
  completedOrders?: number;
  reviewCount?: number;
  averageRating?: number;
}

/** A federation service as advertised in `/api/federation/services/{public,browse}`. */
export interface CypherFederationService {
  /** Mongo `_id`. */
  _id: string;
  name: string;
  description?: string;
  category?: string;
  status?: "active" | "draft" | "suspended" | "retired";
  visibility?: "public" | "organization" | "private";

  pricing: CypherPricing;
  estimatedTurnaround?: CypherTurnaround;
  provider: CypherProvider;
  stats?: CypherServiceStats;
  sourceInstance: CypherSourceInstance;
  /** Service ID inside the source instance's own service catalog. */
  sourceServiceId: string;
  /** Provider record ID inside the source instance. */
  sourceServiceProviderId?: string;

  /**
   * JSON Schema (draft-07) for the order form Cypher should render
   * for the requester. Synthesized from the underlying capability
   * input_schema when the source is PCC.
   */
  orderFormSchema?: Record<string, unknown>;

  termsAndConditionsUrl?: string;
  publishedAt?: string;
  lastSyncAt?: string;
  syncStatus?: "in_sync" | "syncing" | "stale" | "error";
  allowedOrganizations?: string[];
  allowedUsers?: string[];
}

/** Federation instance row inside Cypher's registry. */
export interface CypherInstance {
  /** Mongo `_id`. */
  _id: string;
  /** Stable id used in URLs. */
  instanceId: string;
  name: string;
  baseUrl: string;
  description?: string;
  contactEmail?: string;
  status?: "active" | "pending" | "disconnected";
  registeredAt?: string;
}

/** Credentials Cypher returns after `POST /api/federation/instances/register`. */
export interface CypherCredentials {
  /** API key Cypher will send in `X-Federation-Key` (or equivalent) on every callback. */
  apiKey: string;
  /** Optional secret for HMAC verification of inbound bodies. */
  secret?: string;
  /** Echo of the registered instanceId. */
  instanceId: string;
  /** Whatever expiry policy Cypher imposes (ISO timestamp or null). */
  expiresAt?: string | null;
}

/** Federation order priority — drives PCC assurance-tier mapping. */
export type CypherOrderPriority = "standard" | "rush" | "express" | "scheduled";

/** Inbound order body from Cypher. */
export interface CypherOrder {
  /** Cypher's order id. */
  _id: string;
  /** Human-readable order number, e.g. "FED-20260506-0001". */
  orderNumber: string;
  /** Federation service id this order targets. */
  federatedServiceId: string;
  /** Order form payload as filled in by the requester. */
  orderData: Record<string, unknown>;
  /** Priority — drives turnaround SLA and (in this peer) PCC assurance tier. */
  priority?: CypherOrderPriority;
  /** Optional quote request body for `pricingModel: "quote"` services. */
  quoteRequest?: Record<string, unknown>;
  /** Requester identity (set by Cypher). */
  requester?: { userId?: string; email?: string; orgId?: string };
  /** ISO timestamp set by Cypher when the order was created. */
  createdAt?: string;
  /** Status when received. Always `pending` for fresh orders. */
  status?: "pending" | "accepted" | "in_progress" | "completed" | "failed" | "cancelled";
}

/** Body PCC sends back to Cypher on settle (POST `/api/federation/orders/:id/status`). */
export interface CypherOrderUpdate {
  /** Cypher order id. */
  orderId: string;
  /** New status. */
  status: "accepted" | "in_progress" | "completed" | "failed" | "cancelled";
  /** Free-text message shown in the order activity feed. */
  message?: string;
  /** Settlement payload PCC produces — opaque blob, Cypher stores as-is. */
  settlement?: {
    pccJobId?: string;
    evidenceBundleId?: string;
    escrowAddress?: string;
    txHash?: string;
    completedAt?: string;
  };
}

/** Federation status snapshot (response to `GET /api/federation/status`). */
export interface FederationStatus {
  /** Whether this peer is currently registered. */
  registered: boolean;
  /** ISO timestamp of last successful sync. */
  lastSyncAt?: string;
  /** Number of orders currently open for this peer. */
  openOrders?: number;
  /** Number of services currently published. */
  publishedServices?: number;
}

// ── PCC-side shapes (minimal subset of @pcc/spec.Capability) ───────────────────

/** Minimal PCC capability summary used by the manifest builder + mapper. */
export interface PccCapabilitySummary {
  id: string;
  kernelId: string;
  type: string;
  name: string;
  description?: string;
  materials?: string[];
  /** Tiers this capability supports (0-3). */
  assuranceTiers?: number[];
  pricing?: {
    currency: string;
    baseCost?: string | number;
    minimum?: string | number;
    pricingModel?: CypherPricingModel;
    priceDescription?: string;
  };
  location?: { lat: number; lng: number };
  tags?: string[];
  /**
   * Optional JSON Schema describing what `params` to send in
   * `/api/jobs/submit`. Track B's `cypher-lims-bridge` does not need
   * this; Track A uses it to synthesize an order form schema for
   * Cypher's UI.
   */
  inputSchema?: Record<string, unknown>;
}

/** Manifest body for `POST /api/federation/instances/register`. */
export interface FederationManifest {
  instanceId: string;
  name: string;
  baseUrl: string;
  description?: string;
  contactEmail: string;
  /**
   * Optional initial service set. Cypher may choose to publish these
   * immediately or wait for `POST /api/federation/services` calls.
   * The manifest pre-populates this from PCC's capability catalog.
   */
  services?: PccCapabilitySummary[];
}

// ── A2A intent shape (subset, locally redefined per Track A spec) ──────────────

/**
 * Minimal A2A intent shape used by `OrderTranslator`. We don't import
 * `@pcc/a2a` because Track A spec says: "DEFINE YOUR OWN minimal
 * mapper here, do not import from `@pcc/cypher-lims-bridge`". The same
 * isolation principle applies to a2a — DRY can come post-merge.
 *
 * This shape mirrors `SubmitWorkflowIntent` from `@pcc/a2a/types` but
 * with the bits we need (capability target, params, escrow tier,
 * callback). Track B's translator may end up with a similar shape;
 * we leave deduplication to a future pass.
 */
export interface PccA2aIntent {
  /** Always `submit_workflow` for federation orders. */
  type: "submit_workflow";
  /** Target PCC capability id. */
  capabilityId: string;
  /** Free-form params for `/api/jobs/submit`. */
  params: Record<string, unknown>;
  /** Assurance tier 0-3, derived from order priority. */
  assuranceTier: 0 | 1 | 2 | 3;
  /** URL Cypher polls / PCC pushes settlement to. */
  callbackUrl?: string;
  /** Origin metadata. */
  origin: {
    source: "cypher-federation";
    cypherOrderId: string;
    cypherOrderNumber: string;
    cypherInstanceId?: string;
  };
}

/** PCC settlement event body (subset). */
export interface PccSettlementEvent {
  /** PCC job id. */
  jobId: string;
  /** Final status. */
  status: "completed" | "failed" | "cancelled";
  /** Evidence bundle id (Tier-1+). */
  evidenceBundleId?: string;
  /** On-chain escrow address. */
  escrowAddress?: string;
  /** Settlement transaction hash. */
  txHash?: string;
  /** Completion timestamp (ISO). */
  completedAt?: string;
  /** Free-text failure reason (when status != completed). */
  reason?: string;
}
