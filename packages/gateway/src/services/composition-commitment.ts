/**
 * Composition commitment — a verifiable `compositionRoot` over a MATCHED plan DAG.
 *
 * Composition-owned; self-contained (only @noble/hashes) so it drops into the landed gateway
 * (packages/gateway/src/services) unchanged. Consumes the matched DAG that the agentic decomposer
 * (agentic-decomposer.ts) + /api/compose produce, and emits a deterministic compositionRoot an agent
 * can independently recompute — the trust surface behind GET /api/compose/{id}/commitment ("what the
 * fleet AGREED vs what it EXECUTED").
 *
 * FAIL-CLOSED, and the guard is deliberately NOT on the budget. Per gateway #1215/#1216:
 * agentic-decomposer.ts UNMATCHED_UNIT_COST=10 means an unmatched node returns a PLAUSIBLE 10 USDC that
 * flows into derivedBudget — so a half-template plan has a sensible total and would pass any budget/
 * usedFallback check. The guard therefore requires per-node matchStatus==='matched' for EVERY node,
 * plus a present matchedCapabilityDigest (the deal-snapshot binding gateway #1238 emits — a mutable
 * matchedCapabilityId alone is not committable). A plan that is not fully, verifiably matched returns
 * UNCOMMITTABLE rather than committing a template artifact.
 *
 * Copied verbatim from composition 8a0f4de0's canonical source
 * (pcc-inc3a/packages/spec/src/csd/composition-commitment.ts, coord #1347) into
 * packages/gateway/src/services per their explicit instruction — designed to
 * drop in unchanged. When their task-1 merge lands the same file at this same
 * path on lamasu/master, this copy becomes a no-op replace (no rebase needed).
 */

import { keccak_256 } from "@noble/hashes/sha3";

export interface MatchedNode {
  nodeId: string;
  matchStatus: "matched" | "none";
  /**
   * 0x-prefixed matchedCapabilityDigest = digest of the DEAL SNAPSHOT the match was made against
   * (capabilityId, type, kernelId, price, currency, assuranceTiers — gateway #1238, branch
   * feat/matched-capability-digest). It answers "did the capability I matched change underneath me",
   * which is what makes this commitment meaningful. It is DEAL-snapshot identity, NOT contract-definition
   * (CSD) identity — the CSD join does not exist on a matched capability today; the stronger CSD digest is
   * a separate task, needed only for the inc-3a v2 ON-CHAIN compositionRoot, not this off-chain verify surface.
   */
  matchedCapabilityDigest?: string;
  matchedCapabilityId?: string;
  estimatedCost?: string; // decimal uint string; unmatched nodes carry the plausible 10 — see guard
  currency?: string;
  evidenceRequirements?: { requirementId: string; evidenceTypeId: string; tier: number }[];
}
export interface MatchedEdge { from: string; to: string; }
export interface MatchedDAG {
  requestId: string;
  goal?: string;
  nodes: MatchedNode[];
  edges: MatchedEdge[];
}

export type CommitmentResult =
  | { committable: true; compositionRoot: string; nodeCount: number }
  | { committable: false; reason: string; unmatchedNodes: string[] };

const DOMAIN = "PCC:composition-commitment:v1";

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
/** length-prefixed field (u32 BE length || bytes) — unambiguous, injective concatenation. */
function lp(s: string): Uint8Array {
  const b = utf8(s); const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, false);
  return concat(len, b);
}
function toHex(b: Uint8Array): string {
  let h = ""; for (const x of b) h += x.toString(16).padStart(2, "0"); return "0x" + h;
}

/**
 * Derive the compositionRoot, or refuse. Deterministic: nodes + edges are canonically sorted, so the
 * same matched plan always yields the same root regardless of input ordering.
 */
export function deriveCompositionCommitment(dag: MatchedDAG): CommitmentResult {
  // GUARD 1 (the #1216 trap): every node must be matched. matchStatus, never the budget.
  const unmatched = dag.nodes.filter((n) => n.matchStatus !== "matched").map((n) => n.nodeId);
  if (unmatched.length > 0) {
    return {
      committable: false,
      reason: `UNCOMMITTABLE: ${unmatched.length} of ${dag.nodes.length} node(s) not matched (fallback/template plan — refusing to commit a template artifact)`,
      unmatchedNodes: unmatched,
    };
  }
  // GUARD 2: the binding must be present — a matched node without a contract digest is not committable.
  const noDigest = dag.nodes.filter((n) => !n.matchedCapabilityDigest || !/^0x[0-9a-fA-F]{64}$/.test(n.matchedCapabilityDigest)).map((n) => n.nodeId);
  if (noDigest.length > 0) {
    return {
      committable: false,
      reason: `UNCOMMITTABLE: ${noDigest.length} matched node(s) missing/invalid matchedCapabilityDigest (the node->capability binding)`,
      unmatchedNodes: [],
    };
  }
  if (dag.nodes.length === 0) {
    return { committable: false, reason: "UNCOMMITTABLE: empty plan", unmatchedNodes: [] };
  }

  // Canonical preimage: DOMAIN || requestId || nodeCount || sorted nodes || edgeCount || sorted edges.
  const nodeBytes = [...dag.nodes]
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .map((n) =>
      concat(
        lp(n.nodeId),
        lp(n.matchedCapabilityDigest!.toLowerCase()),
        lp(n.estimatedCost ?? ""),
        lp(n.currency ?? ""),
      ),
    );
  const edgeBytes = [...dag.edges]
    .sort((a, b) => (a.from + " " + a.to < b.from + " " + b.to ? -1 : 1))
    .map((e) => concat(lp(e.from), lp(e.to)));

  const preimage = concat(
    utf8(DOMAIN),
    lp(dag.requestId),
    lp(String(dag.nodes.length)),
    ...nodeBytes,
    lp(String(dag.edges.length)),
    ...edgeBytes,
  );

  return { committable: true, compositionRoot: toHex(keccak_256(preimage)), nodeCount: dag.nodes.length };
}

const CONTRACT_DOMAIN = "PCC:capability-contract:v1";

/**
 * Derive the capabilityContractRoot — a PROVIDER-AGNOSTIC, request-agnostic commitment over just the
 * capability CONTRACT of a plan: per-node evidence requirements (evidenceTypeId + tier) + the DAG shape.
 * It deliberately EXCLUDES the matched provider (matchedCapabilityDigest / matchedCapabilityId), price,
 * currency, requestId and goal — so two runs of the same job fulfilled by DIFFERENT operators (e.g. Lob's
 * API vs a human with a printer — #1344's two-operator proof) yield the SAME capabilityContractRoot while
 * their compositionRoots differ. That pair — one identical contract root over two different composition
 * roots — is the verifiable form of "identical contract, different operator, and the buyer cannot tell
 * which fulfilled it".
 *
 * Field-shape note: the per-leg requirements come from MatchedNode.evidenceRequirements; the real
 * decomposer/CSD must populate them per leg (flagged to evidence c25c8f97 / oracle c158bf91). The
 * mechanism is provider/price-agnostic by construction regardless of that field's final shape; with no
 * evidenceRequirements populated it degrades to a pure DAG-shape commitment. This is ADDITIVE — it never
 * touches deriveCompositionCommitment, so the offer producer building against that root is unaffected.
 */
export function deriveCapabilityContractRoot(dag: MatchedDAG): string {
  const nodeBytes = [...dag.nodes]
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .map((n) => {
      // per-leg evidence requirements, canonically sorted; provider + price EXCLUDED.
      const reqBytes = [...(n.evidenceRequirements ?? [])]
        .sort((a, b) => (a.evidenceTypeId + "#" + a.tier < b.evidenceTypeId + "#" + b.tier ? -1 : 1))
        .map((r) => concat(lp(r.evidenceTypeId), lp(String(r.tier))));
      return concat(lp(n.nodeId), lp(String(reqBytes.length)), ...reqBytes);
    });
  const edgeBytes = [...dag.edges]
    .sort((a, b) => (a.from + " " + a.to < b.from + " " + b.to ? -1 : 1))
    .map((e) => concat(lp(e.from), lp(e.to)));
  const preimage = concat(
    utf8(CONTRACT_DOMAIN),
    lp(String(dag.nodes.length)),
    ...nodeBytes,
    lp(String(dag.edges.length)),
    ...edgeBytes,
  );
  return toHex(keccak_256(preimage));
}
