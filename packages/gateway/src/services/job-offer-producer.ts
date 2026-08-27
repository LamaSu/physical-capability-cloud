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
 * Mapping follows composition 8a0f4de0's #1289 spec (matched DAG -> job-offers):
 *   capabilityType, matchedCapabilityId, matchedKernelId, price (estimatedCost
 *   + currency), evidenceRequirements, requestId+nodeId+ordinal. UNMATCHED
 *   nodes are never published here (fail-closed) -- they fall through to the
 *   existing bounty flow unchanged.
 *
 * KNOWN GAP: compositionRoot is NOT stamped yet. Composition's
 * deriveCompositionCommitment(matchedDAG) is not present on lamasu/master as
 * of coord #1289/#1577 (grepped the full tree, zero hits) -- asked composition
 * where it lives; wire it in under requirements.compositionRoot once available.
 *
 * Two "matched" conventions exist in this codebase and both are handled here:
 *   - agentic/composite decompose (agentic-decomposer.ts): matchStatus +
 *     matchedCapabilityId + matchedKernelId
 *   - direct-match decompose (request-decomposer.ts decomposeDirectMatch):
 *     capabilityId + kernelId (RoutedCapabilityNode)
 */

import type { CapabilityNode, CapabilityRequest } from "@pcc/spec";
import { getJobOffersStore, type CreateJobOfferInput } from "./job-offers-store.js";
import type { RoutedCapabilityNode } from "./request-decomposer.js";

interface ResolvedMatch {
  capabilityId: string;
  kernelId: string;
}

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

export interface ProduceJobOffersResult {
  created: Array<{ nodeId: string; offerId: string }>;
  alreadyExisted: Array<{ nodeId: string; offerId: string }>;
  skippedUnmatched: string[];
  failed: Array<{ nodeId: string; reason: string }>;
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
  for (let ordinal = 0; ordinal < dag.length; ordinal++) {
    const node = dag[ordinal]!;
    const match = resolveMatch(node);
    if (!match) {
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
        // compositionRoot intentionally omitted -- see file header KNOWN GAP.
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

  return result;
}
