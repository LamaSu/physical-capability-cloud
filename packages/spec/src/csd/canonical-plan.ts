/**
 * The per-node execution contract an accepted deal seals (reconciliation row N25; VCR #2300 and #2332).
 *
 * VCR recomputes `planHash = sha256(canonicalize(canonicalPlan))` from the plan bytes it receives,
 * never trusting a supplied hash. It requires that hash to equal the node's `planHash` sealed in
 * `acceptedDealDigest`. VCR routes no money from these fields: finalize pays what the chain froze for
 * the unit. The content is the approver's and the kernel's view of WHAT runs:
 *   - which capability;
 *   - for which operator and payee;
 *   - at what exact price (base units, never a 2dp USD figure);
 *   - in which job and unit;
 *   - at which assurance, with which evidence;
 *   - on which inputs, under which constraints.
 *
 * Everything but `inputs` and `constraints` is the server's (R10 live terms, R11 programs, the
 * compiler's job and unit). Those two are the caller's plain-JSON content (see `plan-json.ts`).
 * Addresses and hashes are lowercased, because hex case carries no meaning.
 *
 * planHash byte form: "sha256:" + lowercase hex of sha256(UTF-8(canonicalize(canonicalPlan))). This
 * is VCR's algorithm, checked byte-exactly against crossrepo-accepted-bundle-v1.
 */

import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import type { PlanJsonObject } from "./plan-json.js";

export const CANONICAL_PLAN_SCHEMA = "pcc.canonical-plan/v2";

export interface CanonicalPlanEvidence {
  requirementId: string;
  evidenceTypeId: string;
  tier: number;
}

export interface CanonicalPlan {
  schema: typeof CANONICAL_PLAN_SCHEMA;
  planId: string;
  planNodeId: string;
  capability: { type: string; id: string; csd: string; matchedCapabilityDigest: string };
  /** The signing operator, lowercased. */
  operator: string;
  /** The server-resolved payout address, lowercased (never a role such as "operator"). */
  payTo: string;
  /** The unit's gross: exact base units of the settlement token. */
  amount: { baseUnits: string; currency: string; decimals: number };
  job: { jobId: string; milestoneIndex: number; stepId: string };
  assurance: { tier: number; tierKey: string; committedProgramHash: string | null; evidence: CanonicalPlanEvidence[] };
  inputs: PlanJsonObject;
  constraints: PlanJsonObject;
}

export type PlanHash = `sha256:${string}`;

/** VCR's planHash of a canonical plan (see the module header for the byte form). */
export function planHashOf(canonicalPlan: CanonicalPlan): PlanHash {
  const digest = sha256(new TextEncoder().encode(canonicalize(canonicalPlan)));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
