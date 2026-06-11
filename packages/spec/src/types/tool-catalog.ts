/**
 * Tool Catalog — registry of adapter/kernel packages independent of live operators.
 *
 * The existing /api/capabilities tier requires a live kernel + operator to
 * instantiate a capability. The tool-catalog tier sits above that — it
 * registers the TOOLS people have built (adapters, kernels, integrations)
 * so demand can ping a capability type even when no operator is currently
 * running. Bounties at the type level reach tool maintainers who can then
 * recruit operators or stand one up.
 *
 * Source of truth for tool source code stays in external repos
 * (LamaSu/<adapter-name>, github.com/<author>/<integration>). The catalog
 * holds metadata only: repo URL, npm package name, capability types
 * implemented, maintainer DID for attribution + demand routing.
 */

import { z } from "zod";

import type { Id, Timestamp } from "./common.js";

/**
 * Maturity status of a registered tool — drives discoverability rankings
 * and demand routing weight.
 */
export type ToolMaturityStatus =
  | "experimental" // no operators known to run this; demand-discovery only
  | "beta" // at least one operator runs it in production
  | "stable" // multiple operators, production-tested
  | "deprecated" // maintainer no longer accepting bug fixes / feature work
  | "archived"; // removed from active listings; metadata preserved

/**
 * A registered tool — adapter, kernel, integration, or workflow library
 * that an operator could install to expose new capabilities on PCC.
 *
 * NOT a capability instance. Capability instances are operator-bound
 * (see CapabilityDTO + /api/capabilities). A tool can have many capability
 * instances OR zero. The catalog tracks the tool regardless.
 */
export interface ToolCatalogEntry {
  /** Stable internal id — opaque, immutable; used by demand-signal routing */
  id: Id;
  /** npm package name (preferred; can be undefined if unpublished) */
  packageName?: string;
  /** Display name shown in marketplace/discovery surfaces */
  name: string;
  /** Short description of what the tool does */
  description: string;
  /** Repository URL (github.com/...) */
  repoUrl: string;
  /** Homepage / docs URL */
  homepageUrl?: string;
  /**
   * PCC capability types this tool implements (e.g., "lab-automation/v1",
   * "3d-printing", "hplc"). One tool can implement multiple types.
   */
  capabilityTypes: string[];
  /** Maintainer's ERC-8004 / DID identifier — for attribution + demand routing */
  maintainerDid: Id;
  /** Optional contact URI (mailto: / https:) for support inquiries */
  maintainerContact?: string;
  /** SPDX license identifier (e.g., "Apache-2.0", "MIT") */
  license?: string;
  /** Programming language / runtime (e.g., "typescript", "python") */
  language?: string;
  /** Current maturity status */
  status: ToolMaturityStatus;
  /** Semver version tag of the latest release */
  latestVersion?: string;
  /**
   * Approximate count of operators currently running this tool's adapters.
   * Computed from /api/capabilities — refreshed on read, NOT stored.
   * Present in DTO responses, omitted on registration input.
   */
  liveOperatorCount?: number;
  /** ISO 8601 — registration time */
  registeredAt: Timestamp;
  /** ISO 8601 — last metadata refresh */
  updatedAt: Timestamp;
  /** Free-form keywords/tags for search */
  tags?: string[];
}

/**
 * Registration payload — fields a tool maintainer submits via
 * POST /api/tool-catalog/register.
 *
 * Server stamps: id, registeredAt, updatedAt, liveOperatorCount.
 */
export type ToolCatalogRegistration = Omit<
  ToolCatalogEntry,
  "id" | "registeredAt" | "updatedAt" | "liveOperatorCount"
>;

export const ToolCatalogRegistrationSchema = z.object({
  packageName: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  repoUrl: z.string().url(),
  homepageUrl: z.string().url().optional(),
  capabilityTypes: z.array(z.string().min(1)).min(1).max(50),
  maintainerDid: z.string().min(1),
  maintainerContact: z.string().min(1).max(500).optional(),
  license: z.string().min(1).max(60).optional(),
  language: z.string().min(1).max(40).optional(),
  status: z.enum([
    "experimental",
    "beta",
    "stable",
    "deprecated",
    "archived",
  ] as const).default("experimental"),
  latestVersion: z.string().min(1).max(60).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

/**
 * Filter query for GET /api/tool-catalog — paginated browse + filter surface.
 */
export interface ToolCatalogQuery {
  capabilityType?: string;
  status?: ToolMaturityStatus;
  language?: string;
  search?: string;
  offset?: number;
  limit?: number;
}

export const ToolCatalogQuerySchema = z.object({
  capabilityType: z.string().min(1).optional(),
  status: z
    .enum(["experimental", "beta", "stable", "deprecated", "archived"] as const)
    .optional(),
  language: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * Paginated listing response from GET /api/tool-catalog.
 */
export interface ToolCatalogListing {
  entries: ToolCatalogEntry[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Demand signal targeting a capability TYPE rather than a specific operator.
 * The catalog routes the bounty/demand to tool maintainers who implement that
 * capability type, even if no operator is currently running their tool.
 *
 * Companion to existing /api/bounty endpoints; this one fans out per-type.
 */
export interface TypeLevelBountyRequest {
  capabilityType: string;
  description: string;
  budgetUSD: number;
  /** Optional: target specific maintainers; otherwise all matching tools get notified */
  preferredMaintainers?: Id[];
  /** Optional: deadline (ISO 8601). Defaults to 30 days from now */
  deadline?: Timestamp;
}

export const TypeLevelBountyRequestSchema = z.object({
  capabilityType: z.string().min(1),
  description: z.string().min(1).max(4000),
  budgetUSD: z.number().positive(),
  preferredMaintainers: z.array(z.string().min(1)).max(50).optional(),
  deadline: z.string().datetime().optional(),
});

/**
 * Server response when a type-level bounty is created.
 */
export interface TypeLevelBountyResponse {
  bountyId: Id;
  capabilityType: string;
  matchingToolsNotified: number;
  matchingTools: Array<Pick<ToolCatalogEntry, "id" | "name" | "maintainerDid">>;
  expiresAt: Timestamp;
}
