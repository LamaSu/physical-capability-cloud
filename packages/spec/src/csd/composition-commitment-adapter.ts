/**
 * The ONE mapping from the gateway's stored plan (CapabilityNode[], as the agentic decomposer emits and
 * the request row persists) to the commitment module's MatchedDAG — used by GET /api/requests/:id/commitment
 * and intended for the job-offer producer, so the root an offer carries and the root the endpoint recomputes
 * come from the same bytes. Two mappings would be two algorithms.
 *
 * Honest degradation on today's master: CapabilityNode carries NO matchedCapabilityDigest (gateway #1238's
 * deal-snapshot digest lives on feat/matched-capability-digest) and NO per-node currency. A fully matched plan
 * therefore reports UNCOMMITTABLE with the named violation and a `blockedOn` explanation — never a phantom root.
 * The capabilityContractRoot (provider-agnostic) IS computable today, because it needs no digest.
 *
 * Evidence tiers: the decomposer emits flat evidence type ids (deriveEvidence), not per-requirement tiers, so
 * decomposer-derived requirements are committed at tier 0 = "declared by the decomposer, tier not negotiated".
 * Plans authored from a template (document-print-and-mail.plan.ts) carry real per-leg tiers.
 */

import type { CapabilityNode } from "../types/requests.js";
import {
  COMPOSITION_DOMAIN,
  CONTRACT_DOMAIN,
  deriveCapabilityContractRoot,
  deriveCompositionCommitment,
  type CommitmentResult,
  type MatchedDAG,
  type MatchedNode,
} from "./composition-commitment.js";

/** CapabilityNode plus the fields newer gateway branches stamp (absent on master today). */
export type CapabilityNodeWithBinding = CapabilityNode & {
  matchedCapabilityDigest?: string;
  currency?: string;
};

/**
 * Canonical decimal string for a JS number: no sign, no leading zeros, no exponent, <= 18 fraction digits.
 * Returns undefined for anything that cannot be represented canonically (NaN, Infinity, negatives, exponents).
 */
export function canonicalDecimal(n: number): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  const s = String(n);
  if (/[eE]/.test(s)) return undefined;
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(s) ? s : undefined;
}

export interface MappingOptions {
  /** Request-level currency (CapabilityRequest.currency) — used when a node carries none. */
  currency: string;
  goal?: string;
}

export function matchedDagFromCapabilityNodes(
  requestId: string,
  nodes: readonly CapabilityNode[],
  opts: MappingOptions,
): MatchedDAG {
  const mapped: MatchedNode[] = nodes.map((raw) => {
    const n = raw as CapabilityNodeWithBinding;
    const matched = n.matchStatus === "matched";
    const node: MatchedNode = {
      nodeId: n.id,
      capabilityType: n.capabilityType,
      matchStatus: matched ? "matched" : "none",
      evidenceRequirements: (n.evidenceRequirements ?? []).map((id) => ({ requirementId: id, evidenceTypeId: id, tier: 0 })),
    };
    if (matched) {
      node.matchedCapabilityDigest = n.matchedCapabilityDigest;
      node.matchedCapabilityId = n.matchedCapabilityId;
      node.estimatedCost = canonicalDecimal(n.estimatedCost);
      node.currency = n.currency ?? opts.currency;
    }
    return node;
  });
  const edges = nodes.flatMap((n) => (n.dependencies ?? []).map((dep) => ({ from: dep, to: n.id })));
  return { requestId, goal: opts.goal, nodes: mapped, edges };
}

export interface RequestCommitmentReport {
  requestId: string;
  nodeCount: number;
  edgeCount: number;
  matchedCount: number;
  domains: { composition: string; contract: string };
  /** The provider-bound commitment, or the fail-closed refusal with its reasons. */
  commitment: CommitmentResult;
  /** Provider-agnostic contract root — computable before matching; null only if the plan itself is invalid. */
  capabilityContractRoot: string | null;
  contractRootError?: string;
  /** Present when the plan is fully matched but cannot commit yet — names the missing binding, never fakes a root. */
  blockedOn?: string;
}

const DIGEST_BLOCK =
  "matchedCapabilityDigest is not stamped on this request's matched nodes (the deal-snapshot digest ships on gateway feat/matched-capability-digest, #1238). The plan is fully matched and its capabilityContractRoot is final, but a compositionRoot is refused until the binding exists.";

/** Recompute both roots from the STORED plan. Callers must pass the server-stored nodes, never client input. */
export function commitmentReportForRequest(
  requestId: string,
  nodes: readonly CapabilityNode[],
  opts: MappingOptions,
): RequestCommitmentReport {
  const dag = matchedDagFromCapabilityNodes(requestId, nodes, opts);
  const commitment = deriveCompositionCommitment(dag);
  let capabilityContractRoot: string | null = null;
  let contractRootError: string | undefined;
  try {
    capabilityContractRoot = deriveCapabilityContractRoot(dag);
  } catch (err) {
    contractRootError = err instanceof Error ? err.message : String(err);
  }
  const matchedCount = dag.nodes.filter((n) => n.matchStatus === "matched").length;
  const blockedOn =
    !commitment.committable &&
    commitment.unmatchedNodes.length === 0 &&
    commitment.violations.some((v) => v.includes("matchedCapabilityDigest"))
      ? DIGEST_BLOCK
      : undefined;
  return {
    requestId,
    nodeCount: dag.nodes.length,
    edgeCount: dag.edges.length,
    matchedCount,
    domains: { composition: COMPOSITION_DOMAIN, contract: CONTRACT_DOMAIN },
    commitment,
    capabilityContractRoot,
    ...(contractRootError ? { contractRootError } : {}),
    ...(blockedOn ? { blockedOn } : {}),
  };
}
