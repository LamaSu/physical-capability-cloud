/**
 * Third-party digital kernel marketplace manifest.
 *
 * A DigitalKernelManifest is the declarative registration document a
 * third-party builder submits to open a kernel to the PCC marketplace.
 *
 * Lifecycle:
 *   draft -> pending -> verified -> (optional) suspended
 *
 * - `draft`: client-side only, never persisted server-side.
 * - `pending`: registered via POST /api/kernels/register. Invisible to the
 *   marketplace listing until a verifier smoke-test runs.
 * - `verified`: passed the gateway's touchstone smoke test; visible in the
 *   /marketplace listing and eligible for job routing.
 * - `suspended`: admin-muted. Not returned by /marketplace listings.
 *
 * This is a types-only module (no runtime code). Safe for browser import.
 */

import type { AgentRegistryId } from "../identity/erc8004.js";
import type { DigitalWorkflowStep } from "./contract-builder.js";

// ---------------------------------------------------------------------------
// Manifest status
// ---------------------------------------------------------------------------

/** Lifecycle status of a registered kernel manifest. */
export type KernelManifestStatus = "draft" | "pending" | "verified" | "suspended";

// ---------------------------------------------------------------------------
// Builder attribution
// ---------------------------------------------------------------------------

/**
 * The entity that authored and maintains a kernel.
 *
 * `agentId` is the ERC-8004 registered identity (reputation target).
 * `contactURI` is an optional mailto/https URI for support notifications.
 */
export interface KernelBuilder {
  /** ERC-8004 agent id of the builder (reputation + attribution target) */
  agentId: AgentRegistryId;
  /** Optional contact URI (mailto:, https:, etc.) for support + suspension notices */
  contactURI?: string;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * USDC-denominated pricing for a kernel's per-job execution.
 *
 * `baseUSD` is the always-charged base fee; `perStepUSD` multiplies the
 * workflowSteps count for workflows where step depth drives cost.
 */
export interface KernelPricing {
  /** Settlement currency — USDC only in v1 */
  currency: "USDC";
  /** Base per-job fee in USD (always charged) */
  baseUSD: number;
  /** Optional per-step fee (multiplied by workflowSteps.length) */
  perStepUSD?: number;
}

// ---------------------------------------------------------------------------
// SessionKey policy (third-party authorization scope)
// ---------------------------------------------------------------------------

/**
 * Declarative scope the kernel advertises for incoming sessionKeys.
 *
 * Callers must present a sessionKey with `expiresAt - issuedAt <= maxTTLSeconds`
 * and whose `scope.allowedActions` is a subset of `allowedActions`.
 */
export interface SessionKeyPolicy {
  /** Maximum session TTL in seconds the kernel will accept */
  maxTTLSeconds: number;
  /** Session actions the kernel accepts (subset of SessionAction values) */
  allowedActions: string[];
}

// ---------------------------------------------------------------------------
// Main manifest
// ---------------------------------------------------------------------------

/**
 * Full manifest submitted by a third-party kernel builder.
 *
 * Field-level guarantees:
 *   - `manifestVersion` is a compatibility tag. Only "1.0.0" is currently
 *     accepted by the marketplace registry.
 *   - `kernelId` is globally unique. The gateway rejects duplicate
 *     registrations; builders should collision-avoid with a DNS-style prefix
 *     (e.g. `k8-temperature-converter-acme`).
 *   - `endpointURL` MUST be an HTTPS URL. HTTP is rejected at register-time.
 *   - `workflowSteps` MUST be non-empty — a kernel with no steps cannot
 *     produce evidence.
 *   - `maxAssuranceTier` is clamped to 0..3.
 *   - `status` starts at `"pending"` when the gateway mints the registration;
 *     clients that post `"draft"` will see it coerced to `"pending"`.
 *   - `registeredAt` / `verifiedAt` are server-stamped and never trusted
 *     from the client body.
 */
export interface DigitalKernelManifest {
  /** Manifest schema version — pinned to "1.0.0" in v1 */
  manifestVersion: "1.0.0";
  /** Globally unique kernel identifier (DNS-style prefixing recommended) */
  kernelId: string;
  /** Human-readable name shown in the marketplace */
  name: string;
  /** One-paragraph description of what this kernel does */
  description: string;
  /** Builder attribution (reputation target) */
  builder: KernelBuilder;
  /** Capability type this kernel advertises (e.g., "temperature-converter", "accounting-reconcile") */
  capabilityType: string;
  /** Declarative DAG of workflow steps executed per job */
  workflowSteps: DigitalWorkflowStep[];
  /** Pricing model for the kernel */
  pricing: KernelPricing;
  /** Highest assurance tier this kernel supports (0..3) */
  maxAssuranceTier: 0 | 1 | 2 | 3;
  /** Optional touchstone library id used during smoke tests */
  touchstoneLibraryId?: string;
  /** HTTPS endpoint where job-handler is served */
  endpointURL: string;
  /** Declarative sessionKey policy */
  sessionKeyPolicy: SessionKeyPolicy;
  /** ISO 8601 timestamp when the gateway accepted the registration */
  registeredAt?: string;
  /** ISO 8601 timestamp when smoke-test verification last passed */
  verifiedAt?: string;
  /** Current lifecycle status */
  status: KernelManifestStatus;
}

// ---------------------------------------------------------------------------
// Registry responses
// ---------------------------------------------------------------------------

/** Summary view of a registered kernel as returned by GET /marketplace */
export interface KernelMarketplaceEntry {
  kernelId: string;
  name: string;
  description: string;
  capabilityType: string;
  builder: KernelBuilder;
  pricing: KernelPricing;
  maxAssuranceTier: 0 | 1 | 2 | 3;
  endpointURL: string;
  status: KernelManifestStatus;
  verifiedAt?: string;
  /** Optional aggregate score 0..1, populated by reputation facade when available */
  assuranceScore?: number;
}

/** Registry filters accepted by GET /api/kernels/marketplace */
export interface MarketplaceFilters {
  capabilityType?: string;
  minAssuranceTier?: 0 | 1 | 2 | 3;
  sortBy?: "assuranceScore" | "price";
}
