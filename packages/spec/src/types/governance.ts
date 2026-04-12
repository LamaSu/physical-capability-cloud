/**
 * Governance types — rate limiting, DLP redaction, scope-based access control.
 *
 * These types support the API Gateway Governance layer inspired by the
 * Venkiteela paper's Apigee X pattern, adapted for PCC's global physical ERP.
 */

import type { Id, Timestamp } from "./common.js";

// ── Rate Limiting ────────────────────────────────────────────────

/** Rate limit policy for an endpoint or endpoint group */
export interface RateLimitPolicy {
  id: Id;
  /** Route pattern (e.g., "/api/jobs/*", "/api/negotiate/*") */
  routePattern: string;
  /** Cost weight — higher = consumes more of the budget (default 1) */
  costWeight: number;
  /** Max requests per window for free tier */
  freeTierLimit: number;
  /** Max requests per window for paid tier */
  paidTierLimit: number;
  /** Max requests per window for enterprise tier */
  enterpriseTierLimit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Burst allowance (extra requests allowed in short burst) */
  burstAllowance: number;
  /** Human-readable description */
  description?: string;
}

/** Operator pricing tier for rate limiting */
export type OperatorTier = "free" | "paid" | "enterprise";

/** Rate limit check result */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Timestamp;
  limit: number;
  costCharged: number;
  tier: OperatorTier;
}

// ── DLP Redaction ────────────────────────────────────────────────

/** Sensitivity classification for data fields */
export type DataSensitivity = "public" | "restricted" | "private" | "secret";

/** DLP redaction rule for a specific field path */
export interface DLPRule {
  id: Id;
  /** JSON path to the field (e.g., "operatorAddress", "location.lat") */
  fieldPath: string;
  /** What resource type this applies to (e.g., "kernel", "job", "evidence") */
  resourceType: string;
  /** Sensitivity classification */
  sensitivity: DataSensitivity;
  /** Roles that can see the unredacted value */
  visibleToRoles: ApiScope[];
  /** Redaction strategy */
  redactionStrategy: "remove" | "mask" | "hash" | "regionalize";
  /** For "mask": the mask pattern (e.g., "0x****abcd") */
  maskPattern?: string;
  /** For "regionalize": precision level */
  regionPrecision?: "exact" | "city" | "region" | "country";
}

// ── Scope-Based Access Control ───────────────────────────────────

/** API scopes — what actions an API key is authorized to perform */
export type ApiScope =
  | "operator"       // manage own kernels, view own jobs, submit evidence
  | "requestor"      // browse capabilities, submit jobs, view own status
  | "verifier"       // access evidence for assigned jobs, submit verifications
  | "admin"          // full access
  | "agent"          // scoped to specific agent actions
  | "auditor"        // read-only access to audit logs and compliance
  | "template_author" // publish and manage templates
  | (string & {});    // extensible

/** Endpoint scope requirement */
export interface EndpointScope {
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Route pattern */
  routePattern: string;
  /** Required scopes (ANY of these grants access) */
  requiredScopes: ApiScope[];
  /** Description */
  description?: string;
}
