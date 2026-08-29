/**
 * Job-offer producer — the bridge between request decomposition/matching and
 * the job-offers marketplace (coord #1276: "a decomposed request never
 * becomes a claimable job offer").
 *
 * Creates one open job-offer per MATCHED capability-DAG node so it becomes
 * claimable via GET /api/job-offers/open + POST /api/job-offers/:id/claim.
 * Confirmed by direct source-read (this lane + d749deff's #1288): neither
 * POST /api/requests nor POST /api/requests/:id/publish ever called
 * getJobOffersStore()/store.create() before this file existed — the producer
 * was unbuilt, not merely unwired.
 *
 * v2 (coord #1467, superseding this lane's own v1): uses the CANONICAL
 * composition-commitment module + adapter from @pcc/spec directly —
 * `commitmentReportForRequest` — rather than a gateway-local copy. That
 * module now also backs GET /api/requests/:id/commitment (routes/requests.ts),
 * so an offer's stamped roots and that endpoint's live recompute are
 * PROVABLY the same algorithm, not two copies that can drift (v1's actual
 * bug: composition's own canonical had a NUL-byte separator defect that
 * would have shipped a second, silently-divergent copy here — coord #1423).
 *
 * NORMALIZATION, and why it exists: @pcc/spec's adapter recognizes ONLY the
 * agentic-decompose convention (matchStatus==='matched'); it does not know
 * about this codebase's SECOND convention (request-decomposer.ts's
 * decomposeDirectMatch -> RoutedCapabilityNode: bare capabilityId/kernelId,
 * no matchStatus at all). Left alone, every direct-match request — the
 * ORIGINAL #1276 repro (a single-node cnc-3axis request) — would be
 * reported as "unmatched" by the adapter and held. So this file overlays
 * matchStatus/matchedCapabilityId/matchedKernelId from `resolveMatch` (this
 * file's own dual-convention detector) onto a per-call copy of the DAG
 * BEFORE handing it to the canonical module. The commitment module owns the
 * crypto and validation; this file owns "which convention marks a node
 * matched", which is gateway-producer-specific, not composition's concern.
 *
 * ROOTS: capabilityContractRoot is provider-agnostic (needs no digest) and
 * is stamped whenever the plan itself is valid, EVEN while compositionRoot
 * is degraded (see below) — the buyer's agreement is pinned from the first
 * matched offer, before any provider is cryptographically bound.
 * compositionRoot is stamped only when the full commitment succeeds.
 *
 * DEGRADE, still relevant post gateway #1238/PR#300 (matchedCapabilityDigest
 * now emitted on agentic-matched nodes): direct-match nodes still carry no
 * digest, and any node matched before PR#300's deploy landed won't either.
 * When the ONLY problem is the missing digest (report.blockedOn is set —
 * @pcc/spec's own signal, shared with GET /api/requests/:id/commitment),
 * this producer degrades gracefully: publish anyway, without a
 * compositionRoot, rather than hard-refusing every real offer. Any OTHER
 * commitment failure (genuine unmatched node, or a plan-validation
 * violation — bad id/currency/decimal grammar, duplicate edges, etc.) HOLDS
 * the whole request per composition's #1347 answer: no committable root
 * exists for a partially-matched or invalid plan, and publishing before the
 * plan commits would create a half-committed money-path state.
 */

import type { CapabilityNode, CapabilityRequest } from "@pcc/spec";
import { commitmentReportForRequest } from "@pcc/spec";
import { getJobOffersStore, type CreateJobOfferInput } from "./job-offers-store.js";
import type { RoutedCapabilityNode } from "./request-decomposer.js";

interface ResolvedMatch {
  capabilityId: string;
  kernelId: string;
}

/** Two "matched" conventions exist in this codebase; this is the one place that reconciles them. */
function resolveMatch(node: CapabilityNode): ResolvedMatch | null {
  if (node.matchStatus === "matched" && node.matchedCapabilityId && node.matchedKernelId) {
    return { capabilityId: node.matchedCapabilityId, kernelId: node.matchedKernelId };
  }
  const routed = node as RoutedCapabilityNode;
  if (routed.capabilityId && routed.kernelId) {
    return { capabilityId: routed.capabilityId, kernelId: routed.kernelId };
  }
  return null;
}

/**
 * Normalize onto the agentic shape @pcc/spec's adapter understands, so a
 * direct-match node reads as matched too. Non-matched nodes pass through
 * unchanged (matchStatus:"none" either explicitly or by absence).
 */
function normalizeForCommitment(node: CapabilityNode): CapabilityNode {
  const match = resolveMatch(node);
  if (!match) return node;
  return {
    ...node,
    matchStatus: "matched",
    matchedCapabilityId: match.capabilityId,
    matchedKernelId: match.kernelId,
  };
}

export interface ProduceJobOffersResult {
  created: Array<{ nodeId: string; offerId: string }>;
  alreadyExisted: Array<{ nodeId: string; offerId: string }>;
  skippedUnmatched: string[];
  failed: Array<{ nodeId: string; reason: string }>;
  /**
   * Set when the WHOLE plan was held back — a genuinely unmatched node, or a
   * plan-validation violation unrelated to the digest gap (composition #1347:
   * no partial publish on a mixed or invalid plan). When set, `created`/
   * `alreadyExisted` are empty; surface `unmatchedNodes` to the buyer as a
   * demand signal and `violations` for anything else that tripped the guard.
   */
  held?: { reason: string; unmatchedNodes: string[]; violations: string[] };
  /** Stamped on every created offer once the full commitment succeeds. */
  compositionRoot?: string;
  /** Stamped on every created offer whenever the plan is valid — provider-agnostic, needs no digest. */
  capabilityContractRoot?: string;
}

/**
 * For each MATCHED node in request.capabilityDag, create (or find, if already
 * created -- idempotent on "bridge:<requestId>:<nodeId>") an open job-offer.
 * `ordinal` is the node's index in capabilityDag so the whole plan can be
 * reconstructed from offers alone.
 */
export async function produceJobOffersForRequest(
  request: CapabilityRequest,
): Promise<ProduceJobOffersResult> {
  const store = getJobOffersStore();
  const result: ProduceJobOffersResult = {
    created: [],
    alreadyExisted: [],
    skippedUnmatched: [],
    failed: [],
  };

  const dag = request.capabilityDag ?? [];
  if (dag.length === 0) return result;

  const report = commitmentReportForRequest(
    request.id,
    dag.map(normalizeForCommitment),
    { currency: request.currency, goal: request.title },
  );

  if (!report.commitment.committable && !report.blockedOn) {
    result.skippedUnmatched = report.commitment.unmatchedNodes;
    result.held = {
      reason: report.commitment.reason,
      unmatchedNodes: report.commitment.unmatchedNodes,
      violations: report.commitment.violations,
    };
    return result;
  }

  const compositionRoot = report.commitment.committable ? report.commitment.compositionRoot : undefined;
  const capabilityContractRoot = report.capabilityContractRoot ?? undefined;

  const matchByNodeId = new Map<string, ResolvedMatch>();
  for (const node of dag) {
    const match = resolveMatch(node);
    if (match) matchByNodeId.set(node.id, match);
  }

  for (let ordinal = 0; ordinal < dag.length; ordinal++) {
    const node = dag[ordinal]!;
    const match = matchByNodeId.get(node.id);
    if (!match) {
      // Unreachable given the guard above (a genuinely unmatched node would
      // have hit the held branch), kept as a fail-closed backstop.
      result.skippedUnmatched.push(node.id);
      continue;
    }

    const idempotencyKey = `bridge:${request.id}:${node.id}`;
    const input: CreateJobOfferInput = {
      capabilityType: node.capabilityType,
      requirements: {
        requestId: request.id,
        nodeId: node.id,
        ordinal,
        matchedCapabilityId: match.capabilityId,
        matchedKernelId: match.kernelId,
        name: node.name,
        description: node.description,
        materials: node.materials,
        ...(compositionRoot ? { compositionRoot } : {}),
        ...(capabilityContractRoot ? { capabilityContractRoot } : {}),
      },
      pricing: {
        amount: node.estimatedCost,
        currency: request.currency,
        model: "fixed",
      },
      evidenceRequirements: {
        artifacts_required: node.evidenceRequirements,
      },
      deadline: request.deadline,
      validUntilIso: request.deadline,
      posterDid: request.requesterEmail ?? request.requesterWallet ?? null,
      idempotencyKey,
    };

    const created = await store.create(input);
    if (!created.ok) {
      const reason = "reason" in created ? created.reason : "unknown_error";
      result.failed.push({ nodeId: node.id, reason });
      continue;
    }
    if (created.created) {
      result.created.push({ nodeId: node.id, offerId: created.offer.id });
    } else {
      result.alreadyExisted.push({ nodeId: node.id, offerId: created.offer.id });
    }
  }

  if (compositionRoot) result.compositionRoot = compositionRoot;
  if (capabilityContractRoot) result.capabilityContractRoot = capabilityContractRoot;
  return result;
}
