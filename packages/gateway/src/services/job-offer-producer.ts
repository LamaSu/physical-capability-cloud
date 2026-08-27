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
 *   + currency), evidenceRequirements, requestId+nodeId+ordinal.
 *
 * compositionRoot + mixed-plan semantics (coord #1347, composition's answer to
 * this lane's #1337): build the FULL matched DAG (every node, not just the
 * matched ones) and hand it to deriveCompositionCommitment. When it returns
 * committable:true, every offer in the plan is stamped with that SAME
 * compositionRoot. When it returns committable:false because >=1 node is
 * genuinely unmatched, the WHOLE request is held -- no offers publish for the
 * matched subset either, because "there is no committable root for a
 * partially-matched plan" (composition's words) and publishing before the
 * plan commits would create a half-committed money-path state. The unmatched
 * legs are surfaced back to the caller (`held.unmatchedNodes`) as a demand
 * signal (#1299), not silently dropped.
 *
 * KNOWN, FLAGGED GAP (posted to composition 8a0f4de0 + gateway 0600b204 on the
 * #1276 bus thread, 2026-08-27): deriveCompositionCommitment's guard 2 also
 * requires a per-node matchedCapabilityDigest (0x + 64 hex, gateway #1238 /
 * branch feat/matched-capability-digest). That field does not exist ANYWHERE
 * in this codebase yet -- grepped lamasu/master + this worktree, zero hits.
 * Hard-gating publish on committable:true would therefore zero out 100% of
 * job-offer production (every real plan is "matched but digest-less"), which
 * is strictly worse than today's gap and would block coord #1344's demo. So:
 * when every node IS matched (unmatchedNodes is empty) but the commitment
 * still comes back committable:false purely for the missing-digest reason,
 * this producer DEGRADES GRACEFULLY -- it publishes the offers anyway, just
 * without a compositionRoot stamped (same posture as job-offers-store's own
 * `requirementsValidated:false` graceful-degrade for an unregistered schema).
 * The moment feat/matched-capability-digest lands and nodes carry a real
 * digest, this degrade path stops triggering automatically and every offer
 * gets a verifiable compositionRoot for free -- no further changes needed
 * here, since the digest is read defensively (see resolveDigest below)
 * rather than assumed absent.
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
import {
  deriveCompositionCommitment,
  type MatchedDAG,
  type MatchedEdge,
  type MatchedNode as CommitmentNode,
} from "./composition-commitment.js";

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

/**
 * Defensive read of a not-yet-landed field. feat/matched-capability-digest
 * has not merged (see file header) so CapabilityNode does not declare this
 * property today; reading it via an unknown-shaped cast means the instant
 * that branch lands and starts populating it, this producer picks it up
 * with zero further changes -- it does not need to know the exact final
 * type shape, only the field name gateway #1238 already committed to.
 */
function resolveDigest(node: CapabilityNode): string | undefined {
  const digest = (node as { matchedCapabilityDigest?: unknown }).matchedCapabilityDigest;
  return typeof digest === "string" ? digest : undefined;
}

export interface ProduceJobOffersResult {
  created: Array<{ nodeId: string; offerId: string }>;
  alreadyExisted: Array<{ nodeId: string; offerId: string }>;
  skippedUnmatched: string[];
  failed: Array<{ nodeId: string; reason: string }>;
  /**
   * Set when the WHOLE plan was held back because >=1 node is genuinely
   * unmatched (composition #1347: no partial publish on a mixed plan). When
   * set, `created`/`alreadyExisted` are empty and `skippedUnmatched` lists
   * every unmatched node -- surface these to the buyer as a demand signal.
   */
  held?: { reason: string; unmatchedNodes: string[] };
  /** The compositionRoot stamped on every created offer, when derivable (see KNOWN GAP above). */
  compositionRoot?: string;
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

  const matchByNodeId = new Map<string, ResolvedMatch>();
  const commitmentNodes: CommitmentNode[] = dag.map((node) => {
    const match = resolveMatch(node);
    if (match) matchByNodeId.set(node.id, match);
    return {
      nodeId: node.id,
      matchStatus: match ? "matched" : "none",
      matchedCapabilityDigest: resolveDigest(node),
      matchedCapabilityId: match?.capabilityId,
      estimatedCost: match ? String(node.estimatedCost) : undefined,
      currency: match ? request.currency : undefined,
    };
  });
  const edges: MatchedEdge[] = dag.flatMap((node) =>
    node.dependencies.map((depId) => ({ from: depId, to: node.id })),
  );
  const dagForCommitment: MatchedDAG = {
    requestId: request.id,
    goal: request.title,
    nodes: commitmentNodes,
    edges,
  };
  const commitment = deriveCompositionCommitment(dagForCommitment);

  if (!commitment.committable && commitment.unmatchedNodes.length > 0) {
    // Genuinely mixed plan -- hold the whole request per composition's #1347
    // answer. Nothing publishes, including the already-matched nodes.
    result.skippedUnmatched = commitment.unmatchedNodes;
    result.held = { reason: commitment.reason, unmatchedNodes: commitment.unmatchedNodes };
    return result;
  }

  // Either fully committable, or fully matched but missing the not-yet-landed
  // digest (DEGRADED_NO_DIGEST -- see file header). Either way every node here
  // is matched, so publish; stamp compositionRoot only when we actually have one.
  const compositionRoot = commitment.committable ? commitment.compositionRoot : undefined;

  for (let ordinal = 0; ordinal < dag.length; ordinal++) {
    const node = dag[ordinal]!;
    const match = matchByNodeId.get(node.id);
    if (!match) {
      // Unreachable given the guard above (would have hit the held branch),
      // kept as a fail-closed backstop rather than assuming the invariant.
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
  return result;
}
