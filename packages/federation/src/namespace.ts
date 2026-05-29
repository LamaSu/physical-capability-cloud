/**
 * Namespace — first-class multi-tenant boundary.
 *
 * Per scope §3.4 + §11.4. A namespace is a curated bundle of tools
 * owned by a DID (user, org, or PCC itself), with an ACL of
 * principal-DID → role. Examples:
 *
 *   - "pcc-public" — owned by PCC, public read
 *   - "anthropic-official-2026-05" — owned by Anthropic, public read
 *   - "user-acme-corp" — owned by Acme's primary DID, tenant-private
 *
 * Phase 1 ships the type + an in-memory ACL evaluator. The aggregator
 * gateway is responsible for persistence (table additions + Drizzle
 * migrations) and for binding the evaluator into its middleware. The
 * federation package keeps the types so other packages (CRDT
 * replicator, region router) can reference them.
 */

import type { VectorClock } from "./vector-clock.js";

export type NamespaceId = string;

/**
 * Namespace visibility — controls which principals can ever see the
 * namespace's tools. ACL roles inside `acl` further restrict who can
 * write / admin.
 */
export type NamespaceVisibility = "public" | "tenant-private" | "pcc-internal";

/** ACL role within a namespace. Roles are ordered: owner > writer > reader. */
export type NamespaceRole = "owner" | "writer" | "reader";

/** Ordered numeric ranks for role comparison. */
const ROLE_RANK: Record<NamespaceRole, number> = {
  reader: 1,
  writer: 2,
  owner: 3,
};

/**
 * Permission an operation requires. Caller must hold a role with rank
 * >= the required permission's rank to be allowed.
 */
export type NamespacePermission = "read" | "write" | "admin";

const PERMISSION_RANK: Record<NamespacePermission, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export interface Namespace {
  id: NamespaceId;
  displayName: string;
  description: string;
  ownerDid: string;
  visibility: NamespaceVisibility;
  createdAt: string;
  /** Region where this namespace was first created. */
  createdInRegion: string;
  /** ACL: principal-DID → role. */
  acl: Record<string, NamespaceRole>;
  /** Default trust-tier policy for tools in this namespace. */
  defaultTrustTier?: string;
  /** Max DCC class allowed in this namespace. */
  maxDccAllowed?: number;
  /** Lamport vector clock for ACL changes (separate from tool VC). */
  aclVectorClock: VectorClock;
}

/**
 * Result of an ACL evaluation. Carries the reason on deny so the API
 * can return a structured error message.
 */
export interface ACLEvaluation {
  allowed: boolean;
  reason?:
    | "no_principal"
    | "namespace_invisible"
    | "principal_not_in_acl"
    | "insufficient_role";
}

/**
 * Evaluate whether a principal can perform an operation on a namespace.
 *
 * Rules (in order):
 *   1. If the namespace's visibility is `public` AND the requested
 *      permission is `read`, allow.
 *   2. If `principalDid` is undefined → deny (`no_principal`).
 *   3. If `pcc-internal` namespace AND principal is not in ACL → deny
 *      (`namespace_invisible`).
 *   4. Look up principal's role in `acl`. If absent → deny
 *      (`principal_not_in_acl`).
 *   5. Compare principal's role rank vs required permission rank.
 */
export function evaluateNamespaceAcl(
  namespace: Namespace,
  principalDid: string | undefined,
  permission: NamespacePermission,
): ACLEvaluation {
  // Public read shortcut
  if (namespace.visibility === "public" && permission === "read") {
    return { allowed: true };
  }

  if (!principalDid) {
    return { allowed: false, reason: "no_principal" };
  }

  // Internal namespaces: hide from non-ACL principals entirely
  if (namespace.visibility === "pcc-internal" && !(principalDid in namespace.acl)) {
    return { allowed: false, reason: "namespace_invisible" };
  }

  const role = namespace.acl[principalDid];
  if (!role) {
    return { allowed: false, reason: "principal_not_in_acl" };
  }

  if (ROLE_RANK[role] < PERMISSION_RANK[permission]) {
    return { allowed: false, reason: "insufficient_role" };
  }

  return { allowed: true };
}

/**
 * Constants for the default PCC-public namespace. The aggregator's
 * default IndexedTool ingestion targets this namespace; existing
 * gateway behavior is unchanged.
 */
export const DEFAULT_PCC_PUBLIC_NAMESPACE_ID: NamespaceId = "pcc-public";

/**
 * Build the default PCC-public namespace record. Used at gateway boot
 * if no namespace exists yet (the Phase-1 migration seed).
 */
export function buildDefaultPccPublicNamespace(opts: {
  createdInRegion: string;
  ownerDid: string;
}): Namespace {
  return {
    id: DEFAULT_PCC_PUBLIC_NAMESPACE_ID,
    displayName: "PCC Public",
    description:
      "The default public namespace. All tools ingested via the auto-indexer land here unless an alternative namespace is specified.",
    ownerDid: opts.ownerDid,
    visibility: "public",
    createdAt: new Date().toISOString(),
    createdInRegion: opts.createdInRegion,
    acl: {
      [opts.ownerDid]: "owner",
    },
    aclVectorClock: { ticks: {} },
  };
}
