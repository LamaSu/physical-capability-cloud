/**
 * Composition commitment v2 — verifiable roots over a MATCHED plan DAG.
 *
 * Composition-owned; self-contained (only @noble/hashes) so it drops into the landed gateway
 * (packages/gateway/src/services) unchanged. Consumes the matched DAG the agentic decomposer
 * (agentic-decomposer.ts) + the offer producer hold SERVER-SIDE and emits two deterministic roots any
 * agent can independently recompute:
 *
 *   capabilityContractRoot — PROVIDER-AGNOSTIC: what the buyer agreed to — per-leg capabilityType +
 *                            evidence requirements (evidenceTypeId + tier) + DAG shape. Computable
 *                            BEFORE matching. Two operators fulfilling the same contract share it.
 *   compositionRoot        — PROVIDER-BOUND: the contract root + per-leg provider binding
 *                            (matchedCapabilityDigest) + price. "What the fleet AGREED" for THIS run;
 *                            the trust surface behind GET /api/compose/{id}/commitment.
 *
 * v2 (2026-08-27) folds in the cross-family (sol / GPT-5.6) review of v1 — every item below was a
 * BLOCKER or HIGH there:
 *   - capabilityType is REQUIRED per node and committed in BOTH roots (v1's contract root was
 *     shape + evidence only, so a one-node "print" plan and a one-node "shred" plan collided).
 *   - estimatedCost + currency are REQUIRED on matched nodes and grammar-validated (v1 defaulted
 *     undefined to "", so omitted / null / "" plans aliased).
 *   - the contract root is bound INTO the composition preimage (v1 left a tier change invisible
 *     to compositionRoot).
 *   - the plan is VALIDATED before committing: printable-ASCII ids (kills unpaired-surrogate
 *     aliasing and the UTF-16-vs-bytewise ordering split across languages), unique node ids,
 *     edges reference plan nodes, no self-loops, no duplicate edges, acyclic, decimal price
 *     grammar, currency grammar, tier ∈ 0..3, no duplicate evidence requirements.
 *   - explainSubstitution(): the two-operator proof is NOT "same contract root + different
 *     composition root" (a different requestId or price also changes the composition root). It is:
 *     open both plans and show the ONLY differing fields are the provider bindings. The opener is
 *     here so the demo shows exactly that, phrased as PROVIDER SUBSTITUTABILITY.
 *
 * FAIL-CLOSED, and the guard is deliberately NOT on the budget. Per gateway #1215/#1216:
 * agentic-decomposer.ts UNMATCHED_UNIT_COST=10 gives an unmatched node a PLAUSIBLE price, so a
 * half-template plan has a sensible total and passes any budget check. The guard therefore requires
 * matchStatus==='matched' for EVERY node plus a present matchedCapabilityDigest (gateway #1238's
 * deal-snapshot binding — a mutable matchedCapabilityId alone is not committable).
 *
 * HARD INVARIANT FOR CALLERS (not enforceable in a pure function — sol Q2): feed this ONLY the
 * server-stored decomposer output for the WHOLE request, never client-supplied or truncated input.
 * The guards authenticate SYNTAX (a well-formed digest), not matching; only the stored, authenticated
 * plan makes the digest meaningful, and only the full node list makes "every node matched" mean
 * "the whole plan is matched". The offer producer (PR #294) recomputes from storage — keep it so.
 *
 * NON-SEMANTIC — deliberately excluded from both roots: goal (free text), matchedCapabilityId (mutable;
 * the digest is the binding), requirementId (a local label; evidenceTypeId + tier are the semantics),
 * matchedKernelId / name / score. Declared here so the omission is a decision, not an accident.
 *
 * Canonical ordering: nodes by nodeId; edges by (from, to) TUPLE compare; evidence requirements by
 * (evidenceTypeId, tier) tuple compare — separator-free, so no byte inside an id can alias the order
 * (a v1 gateway copy diverged from canonical by exactly one separator byte). Ids are printable ASCII,
 * so JavaScript's UTF-16 `<` equals bytewise UTF-8 order — the same order in any language.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export interface EvidenceRequirement {
  /** Local label — NOT committed (non-semantic). */
  requirementId: string;
  /** evidence-vocabulary v1 primitive id (e.g. "confirm.target_system") — committed. */
  evidenceTypeId: string;
  /** Assurance tier this requirement closes the leg at, 0..3 — committed. */
  tier: number;
}

export interface MatchedNode {
  nodeId: string;
  /** Provider-neutral capability identity (e.g. "document-printing", "mail.drop") — REQUIRED, in both roots. */
  capabilityType: string;
  matchStatus: "matched" | "none";
  /**
   * 0x-prefixed matchedCapabilityDigest = digest of the DEAL SNAPSHOT the match was made against
   * (capabilityId, type, kernelId, price, currency, assuranceTiers — gateway #1238). It answers "did
   * the capability I matched change underneath me". REQUIRED on a matched node.
   */
  matchedCapabilityDigest?: string;
  matchedCapabilityId?: string;
  /** Decimal string, e.g. "12" or "0.60" — REQUIRED on a matched node. Unmatched nodes carry the plausible 10 — never used. */
  estimatedCost?: string;
  /** Uppercase currency code, e.g. "USDC" — REQUIRED on a matched node. */
  currency?: string;
  evidenceRequirements?: EvidenceRequirement[];
}
export interface MatchedEdge { from: string; to: string; }
export interface MatchedDAG {
  requestId: string;
  goal?: string;
  nodes: MatchedNode[];
  edges: MatchedEdge[];
}

export type CommitmentResult =
  | { committable: true; compositionRoot: string; capabilityContractRoot: string; nodeCount: number }
  | { committable: false; reason: string; unmatchedNodes: string[]; violations: string[] };

export const COMPOSITION_DOMAIN = "PCC:composition-commitment:v2";
export const CONTRACT_DOMAIN = "PCC:capability-contract:v2";

/** 1-128 printable ASCII characters, no whitespace. Applies to every committed identifier. */
export const ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
export const DIGEST_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** Canonical decimal: no sign, no leading zeros, at most 18 fraction digits. */
export const COST_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
export const CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{2,11}$/;
export const MAX_TIER = 3;

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
/** length-prefixed field (u32 BE length || bytes) — unambiguous, injective concatenation. */
function lp(s: string): Uint8Array {
  const b = utf8(s);
  if (b.length > 0xffffffff) throw new Error("lp: field exceeds u32 length");
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, false);
  return concat(len, b);
}
function toHex(b: Uint8Array): string {
  let h = ""; for (const x of b) h += x.toString(16).padStart(2, "0"); return "0x" + h;
}
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Canonical edge order: (from, to) tuple compare — separator-free. Returns 0 for equal edges. */
function cmpEdge(a: MatchedEdge, b: MatchedEdge): number { return cmpStr(a.from, b.from) || cmpStr(a.to, b.to); }
/** Canonical evidence-requirement order: (evidenceTypeId, tier) tuple compare. */
function cmpReq(a: EvidenceRequirement, b: EvidenceRequirement): number {
  return cmpStr(a.evidenceTypeId, b.evidenceTypeId) || a.tier - b.tier;
}
function sortedNodes(nodes: MatchedNode[]): MatchedNode[] {
  return [...nodes].sort((a, b) => cmpStr(a.nodeId, b.nodeId));
}
function sortedEdges(edges: MatchedEdge[]): MatchedEdge[] { return [...edges].sort(cmpEdge); }

/**
 * Validate a plan's structure and field grammars. Returns the list of violations (empty = valid).
 * Matching-dependent fields (digest, price, currency) are checked only on matched nodes, so a
 * not-yet-matched plan can still have a valid, computable capabilityContractRoot.
 */
export function validatePlan(dag: MatchedDAG): string[] {
  const v: string[] = [];
  if (!ID_PATTERN.test(dag?.requestId ?? "")) v.push("requestId: must be 1-128 printable ASCII characters");
  if (!Array.isArray(dag?.nodes) || dag.nodes.length === 0) { v.push("nodes: empty plan"); return v; }
  const ids = new Set<string>();
  for (const n of dag.nodes) {
    const tag = `node ${String(n?.nodeId)}`;
    if (!ID_PATTERN.test(n?.nodeId ?? "")) v.push(`${tag}: nodeId must be 1-128 printable ASCII characters`);
    if (ids.has(n.nodeId)) v.push(`${tag}: duplicate nodeId`);
    ids.add(n.nodeId);
    if (!ID_PATTERN.test(n?.capabilityType ?? "")) v.push(`${tag}: capabilityType is required (1-128 printable ASCII characters)`);
    if (n.matchStatus !== "matched" && n.matchStatus !== "none") v.push(`${tag}: matchStatus must be 'matched' or 'none'`);
    if (n.matchStatus === "matched") {
      if (!DIGEST_PATTERN.test(n.matchedCapabilityDigest ?? "")) v.push(`${tag}: matched node missing/invalid matchedCapabilityDigest (0x + 64 hex)`);
      if (!COST_PATTERN.test(n.estimatedCost ?? "")) v.push(`${tag}: matched node missing/invalid estimatedCost (canonical decimal string)`);
      if (!CURRENCY_PATTERN.test(n.currency ?? "")) v.push(`${tag}: matched node missing/invalid currency (e.g. USDC)`);
    }
    const seen = new Set<string>();
    for (const r of n.evidenceRequirements ?? []) {
      if (!ID_PATTERN.test(r?.requirementId ?? "")) v.push(`${tag}: evidence requirementId must be printable ASCII`);
      if (!ID_PATTERN.test(r?.evidenceTypeId ?? "")) v.push(`${tag}: evidenceTypeId must be printable ASCII`);
      if (!Number.isInteger(r?.tier) || r.tier < 0 || r.tier > MAX_TIER) v.push(`${tag}: evidence tier must be an integer 0..${MAX_TIER}`);
      const k = JSON.stringify([r?.evidenceTypeId, r?.tier]);
      if (seen.has(k)) v.push(`${tag}: duplicate evidence requirement ${r.evidenceTypeId}@${r.tier}`);
      seen.add(k);
    }
  }
  const edgeKeys = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const e of dag.edges ?? []) {
    if (!ids.has(e?.from) || !ids.has(e?.to)) { v.push(`edge ${e?.from}->${e?.to}: references a node not in the plan`); continue; }
    if (e.from === e.to) v.push(`edge ${e.from}->${e.to}: self-loop`);
    const k = JSON.stringify([e.from, e.to]);
    if (edgeKeys.has(k)) v.push(`edge ${e.from}->${e.to}: duplicate edge`);
    edgeKeys.add(k);
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  // acyclicity — DFS with colors (0 unvisited, 1 on stack, 2 done)
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    const c = color.get(id) ?? 0;
    if (c === 1) return true;
    if (c === 2) return false;
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) if (visit(next)) return true;
    color.set(id, 2);
    return false;
  };
  if ([...ids].some((id) => visit(id))) v.push("edges: cycle detected (plan must be a DAG)");
  return v;
}

function contractRootUnchecked(dag: MatchedDAG): string {
  const nodeBytes = sortedNodes(dag.nodes).map((n) => {
    const reqBytes = [...(n.evidenceRequirements ?? [])]
      .sort(cmpReq)
      .map((r) => concat(lp(r.evidenceTypeId), lp(String(r.tier))));
    // provider, price, currency, requestId, goal: EXCLUDED by design (provider-agnostic).
    return concat(lp(n.nodeId), lp(n.capabilityType), lp(String(reqBytes.length)), ...reqBytes);
  });
  const edgeBytes = sortedEdges(dag.edges).map((e) => concat(lp(e.from), lp(e.to)));
  const preimage = concat(
    utf8(CONTRACT_DOMAIN),
    lp(String(dag.nodes.length)),
    ...nodeBytes,
    lp(String(dag.edges.length)),
    ...edgeBytes,
  );
  return toHex(keccak_256(preimage));
}

/**
 * Derive the provider-agnostic capabilityContractRoot. Valid BEFORE matching (unmatched nodes are
 * fine — only structure, types and evidence are committed). Throws on an invalid plan: a commitment
 * over a malformed plan is meaningless, and callers must not be able to mistake one for a root.
 */
export function deriveCapabilityContractRoot(dag: MatchedDAG): string {
  const violations = validatePlan(dag);
  if (violations.length > 0) throw new Error(`INVALID_PLAN: ${violations.join("; ")}`);
  return contractRootUnchecked(dag);
}

/**
 * Derive the compositionRoot (and the contract root it binds), or refuse. Deterministic: canonical
 * ordering throughout, so the same matched plan always yields the same roots regardless of input order.
 */
export function deriveCompositionCommitment(dag: MatchedDAG): CommitmentResult {
  const violations = validatePlan(dag);
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  // GUARD 1 (the #1216 trap): every node must be matched. matchStatus, never the budget.
  const unmatched = nodes.filter((n) => n.matchStatus !== "matched").map((n) => n.nodeId);
  if (unmatched.length > 0) {
    return {
      committable: false,
      reason: `UNCOMMITTABLE: ${unmatched.length} of ${nodes.length} node(s) not matched (fallback/template plan — refusing to commit a template artifact)`,
      unmatchedNodes: unmatched,
      violations,
    };
  }
  // GUARD 2: structure + bindings + grammars must all be valid (covers the missing-digest case).
  if (violations.length > 0) {
    return { committable: false, reason: `UNCOMMITTABLE: invalid plan — ${violations.join("; ")}`, unmatchedNodes: [], violations };
  }

  const capabilityContractRoot = contractRootUnchecked(dag);
  const nodeBytes = sortedNodes(dag.nodes).map((n) =>
    concat(
      lp(n.nodeId),
      lp(n.capabilityType),
      lp(n.matchedCapabilityDigest!.toLowerCase()),
      lp(n.estimatedCost!),
      lp(n.currency!),
    ),
  );
  const edgeBytes = sortedEdges(dag.edges).map((e) => concat(lp(e.from), lp(e.to)));
  // Canonical preimage: DOMAIN || requestId || contractRoot || nodeCount || sorted nodes || edgeCount || sorted edges.
  const preimage = concat(
    utf8(COMPOSITION_DOMAIN),
    lp(dag.requestId),
    lp(capabilityContractRoot),
    lp(String(dag.nodes.length)),
    ...nodeBytes,
    lp(String(dag.edges.length)),
    ...edgeBytes,
  );
  return { committable: true, compositionRoot: toHex(keccak_256(preimage)), capabilityContractRoot, nodeCount: dag.nodes.length };
}

// ---------------------------------------------------------------------------
// The opener — what actually proves the two-operator claim (sol Q3).
// ---------------------------------------------------------------------------

export interface FieldDifference { nodeId: string | null; field: string; }
export interface SubstitutionReport {
  /** Both plans commit to the same capabilityContractRoot (same contract). */
  sameContract: boolean;
  /** Both plans commit to the same compositionRoot (same run — nothing differs). */
  sameComposition: boolean;
  /** Every field that differs between the two opened plans. */
  differingFields: FieldDifference[];
  /**
   * TRUE only when the contract is identical AND the only differences are provider bindings
   * (matchedCapabilityDigest / matchedCapabilityId) on one or more legs. This — not root inequality —
   * is the verifiable form of "identical contract, different operator".
   */
  pureOperatorSubstitution: boolean;
}

const PROVIDER_FIELDS: ReadonlySet<string> = new Set(["matchedCapabilityDigest", "matchedCapabilityId"]);
const NODE_FIELDS = ["capabilityType", "matchedCapabilityDigest", "matchedCapabilityId", "estimatedCost", "currency"] as const;

function canonReqs(n: MatchedNode): string {
  return JSON.stringify([...(n.evidenceRequirements ?? [])].sort(cmpReq).map((r) => [r.evidenceTypeId, r.tier]));
}
function canonEdges(dag: MatchedDAG): string {
  return JSON.stringify(sortedEdges(dag.edges).map((e) => [e.from, e.to]));
}

/** Open two committed plans and report exactly what differs. Uncommittable input ⇒ nothing is provable. */
export function explainSubstitution(a: MatchedDAG, b: MatchedDAG): SubstitutionReport {
  const ra = deriveCompositionCommitment(a);
  const rb = deriveCompositionCommitment(b);
  if (!ra.committable || !rb.committable) {
    return { sameContract: false, sameComposition: false, differingFields: [{ nodeId: null, field: "uncommittable" }], pureOperatorSubstitution: false };
  }
  const diffs: FieldDifference[] = [];
  if (a.requestId !== b.requestId) diffs.push({ nodeId: null, field: "requestId" });
  const na = new Map(a.nodes.map((n) => [n.nodeId, n] as const));
  const nb = new Map(b.nodes.map((n) => [n.nodeId, n] as const));
  for (const id of new Set([...na.keys(), ...nb.keys()])) {
    const x = na.get(id); const y = nb.get(id);
    if (!x || !y) { diffs.push({ nodeId: id, field: "presence" }); continue; }
    for (const f of NODE_FIELDS) {
      const fx = f === "matchedCapabilityDigest" ? (x[f] ?? "").toLowerCase() : (x[f] ?? "");
      const fy = f === "matchedCapabilityDigest" ? (y[f] ?? "").toLowerCase() : (y[f] ?? "");
      if (fx !== fy) diffs.push({ nodeId: id, field: f });
    }
    if (canonReqs(x) !== canonReqs(y)) diffs.push({ nodeId: id, field: "evidenceRequirements" });
  }
  if (canonEdges(a) !== canonEdges(b)) diffs.push({ nodeId: null, field: "edges" });
  const sameContract = ra.capabilityContractRoot === rb.capabilityContractRoot;
  const providerOnly = diffs.length > 0 && diffs.every((d) => d.nodeId !== null && PROVIDER_FIELDS.has(d.field));
  return {
    sameContract,
    sameComposition: ra.compositionRoot === rb.compositionRoot,
    differingFields: diffs,
    pureOperatorSubstitution: sameContract && providerOnly,
  };
}
