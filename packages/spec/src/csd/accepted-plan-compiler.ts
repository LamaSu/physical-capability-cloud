/**
 * Accepted-plan compiler — composition's half of MS-01 (reconciliation row R12).
 *
 * Input is a plan an EXTERNAL agent authored, AFTER the server has re-read every selected provider
 * (R10) and resolved every verification program (R11). Output is the deterministic structure the
 * V-next settlement compiler (escrow's R14 in `@pcc/contracts`) encodes, plus the node→execution-unit
 * map VCR consumes. PCC does no decomposition here: the plan's shape is the caller's. This module only
 * decides whether that shape can be funded EXACTLY, and in which canonical form.
 *
 * Guarantees — each is a fail-closed check with a typed violation:
 *  - ONE V-NEXT JOB PER OPERATOR. A V-next `PolicyIdentity` has exactly one operator, and that operator
 *    signs the EIP-712 `JobPolicy`; a payee who is not the operator never signs. A plan with several
 *    operators therefore compiles to several jobs — never one escrow that binds one operator's
 *    signature over another operator's terms.
 *  - CANONICAL UNIT ORDER. Unit order is money-significant: `unitsRoot` folds unit ids in array order,
 *    and the ids derive from `(milestoneIndex, stepId)`. The order is a topological sort of the caller's
 *    DAG with ties broken by nodeId, so the order a planner (often an LLM) listed nodes in cannot move
 *    a unit.
 *  - EXACT BIGINT ECONOMICS. Per unit: `f = floor(g·feeBps/10000)`, `n = g − f`, all bigint, and the
 *    payouts conserve EXACTLY (`Σ amount === n`). Conservation is checked per unit: a global total
 *    would let two units' errors cancel.
 *  - BOUNDED AUTHORITY. The plan's whole obligation (`Σ g`) must fit inside the server-issued
 *    reservation (R13), in its currency, for this request. Issuing and consuming the reservation
 *    atomically is the reservation store's job; the output names it so the consume can seal this plan.
 *  - ASSURANCE. Every non-zero-tier unit must carry a program hash AND pass the injected program gate
 *    (evidence's `assertAcceptedProgramForTier`, #349). A missing hash is refused here even if a
 *    permissive gate would approve it; with no gate injected, a non-zero tier is refused.
 *  - A SEALED DEAL. `acceptedDealDigest` = sha256 over the canonical form of the ENTIRE compiled deal:
 *    every job, every unit field (tier, fee, amounts, payees, order), the signing operators, the
 *    reservation, the currency and its decimals, and both v3 roots. This is the digest the reservation
 *    consume seals (MUST-CLOSE 8). The v3 `compositionRoot` is derived here from the same input and
 *    echoed into every unit, but it commits the PLAN (contract, providers, prices, wallets, program),
 *    NOT the settlement terms: two deals that differ only in a node's tier, the fee, or the signing
 *    operator share a compositionRoot and differ in acceptedDealDigest (cross-family review, #351).
 *    On-chain, each job's `prePolicyRoot` binds its own units.
 *  - SERVER-RESOLVED DECIMALS. Token decimals come from `SETTLEMENT_TOKEN_DECIMALS`, never from the
 *    caller: a wrong decimals value would make the committed cost disagree with the gross actually
 *    pulled (e.g. g = 10^7 at "6" vs "18" decimals). An unknown currency is refused.
 *  - TYPED REJECTION. Malformed runtime input (a non-string id, an array that stringifies to a valid
 *    one, a non-bigint amount) is refused with a typed violation — never a throw, never a coercion.
 *    Every node occurrence is validated, duplicates included, and the violations are sorted, so the
 *    diagnostics depend neither on input order nor on which duplicate came first.
 *  - FROZEN-ABI LIMITS. At most 16 units per job, 1–16 payout legs per unit, 256 legs per job;
 *    `5 <= g <= 2^128−1`; `feeBps <= 1000`; `n > 0`; operator ≠ payer; no zero addresses.
 *    (Recipient rules that need chain context — not the escrow, token or factory — and the calldata
 *    cap are the encoder's, which has that context.)
 *
 * Deliberately NOT done here: any ABI encoding (escrow's compiler does it), trusting caller-supplied
 * prices / wallets / programs (callers pass server-resolved values), or splitting an over-cap job
 * (that changes the economic structure; refuse and let the planner restructure).
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import {
  ADDRESS_PATTERN,
  CURRENCY_PATTERN,
  DIGEST_PATTERN,
  ID_PATTERN,
  deriveCompositionCommitment,
  type EvidenceRequirement,
  type MatchedDAG,
} from "./composition-commitment.js";
import type { Address } from "../types/common.js";

// ── Frozen V-next ABI limits (escrow's VNEXT_SETTLEMENT_ABI.md §2, §5) ─────────────────────────
export const MAX_UNITS_PER_JOB = 16;
export const MAX_PAYOUT_LEGS_PER_UNIT = 16;
export const MAX_PAYOUT_LEGS_PER_JOB = 256;
export const MIN_GROSS_BASE_UNITS = 5n;
export const MAX_GROSS_BASE_UNITS = (1n << 128n) - 1n;
export const MAX_FEE_BPS = 1000;
export const BPS_DENOMINATOR = 10_000n;
/** Stored in each UnitConfig; 0 means "not composed". */
export const COMPOSITION_SCHEMA_VERSION = 3;
/** Domain tag inside the accepted-deal digest's canonical preimage. */
export const ACCEPTED_DEAL_DOMAIN = "PCC:accepted-deal:v1";
/**
 * Settlement tokens this compiler will price, with their on-chain decimals. Server-owned: decimals
 * are never taken from a caller. Add a token here only with its real decimals.
 */
export const SETTLEMENT_TOKEN_DECIMALS: Readonly<Record<string, number>> = Object.freeze({ USDC: 6 });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type Bytes32 = `0x${string}`;

export interface AcceptedPlanNode {
  /** Stable node identity (the caller's, canonicalized). It is carried through to the execution unit. */
  nodeId: string;
  capabilityId: string;
  capabilityType: string;
  /** The CSD and tier key the node was quoted at, e.g. "document-print-and-mail" / "tier2". */
  csd: string;
  tierKey: string;
  /** Server-resolved from the live provider snapshot (R10), never the caller's claim. */
  operator: Address;
  /** The payout wallet the operator agent requested and the payer accepted (#1690). */
  payoutAddress: Address;
  /** Gross price in token base units, from the server-side quote. */
  grossBaseUnits: bigint;
  /** The deal-snapshot digest the quote was made against (R10 recomputes it from the live row). */
  matchedCapabilityDigest: string;
  /** Server-resolved program hash for (csd, tierKey); null at tier 0. */
  committedProgramHash: string | null;
  /** The node's evidence requirements from its CSD tier (committed in the v3 contract root). */
  evidenceRequirements: EvidenceRequirement[];
}

export interface AcceptedPlanEdge {
  from: string;
  to: string;
}

export interface ReservationRef {
  reservationId: string;
  requestId: string;
  currency: string;
  maxAmountBaseUnits: bigint;
}

export interface AcceptedPlanInput {
  planId: string;
  requestId: string;
  payer: Address;
  /** Settlement token symbol, e.g. "USDC". Its decimals come from `SETTLEMENT_TOKEN_DECIMALS`. */
  currency: string;
  feeBps: number;
  /** Must be the zero address when feeBps is 0, and non-zero otherwise. */
  feeRecipient: Address;
  /** Absolute unix time after which the payer may reclaim an unsettled unit. */
  reclaimAt: bigint;
  nodes: AcceptedPlanNode[];
  edges: AcceptedPlanEdge[];
  reservation: ReservationRef;
}

/** One settlement unit, in the frozen ABI's `UnitConfig` field order. */
export interface UnitConfigInput {
  milestoneIndex: bigint;
  stepId: Bytes32;
  requiredTier: number;
  requestedTier: number;
  g: bigint;
  f: bigint;
  n: bigint;
  feeBps: number;
  feeRecipient: Address;
  reclaimAt: bigint;
  compositionSchemaVersion: number;
  compositionRoot: Bytes32;
  payouts: PayoutEntry[];
}

export interface PayoutEntry {
  recipient: Address;
  amount: bigint;
}

/** One V-next job: one payer, one signing operator, its units in canonical order. */
export interface CompiledJob {
  /** Deterministic: `${planId}:${operator lowercase}`. The encoder hashes it into `jobIdHash`. */
  jobId: string;
  operator: Address;
  payer: Address;
  units: UnitConfigInput[];
  /** `nodeIds[i]` is the plan node that `units[i]` executes. */
  nodeIds: string[];
}

/** The node → execution-unit map (VCR's contract, MUST-CLOSE 10). */
export interface NodeUnitBinding {
  nodeId: string;
  jobIndex: number;
  jobId: string;
  operator: Address;
  milestoneIndex: number;
  /** The string form VCR carries. */
  stepId: string;
  /** `keccak256(utf8(stepId))`, the `UnitConfig.stepId`. */
  stepIdBytes32: Bytes32;
  tier: number;
  committedProgramHash: string | null;
}

export interface CompiledAcceptedPlan {
  planId: string;
  requestId: string;
  reservationId: string;
  currency: string;
  /** The settlement token's decimals, resolved server-side. */
  currencyDecimals: number;
  /** sha256 over the canonical form of this whole compiled deal; what the reservation consume seals. */
  acceptedDealDigest: `0x${string}`;
  /** Σ g over every unit of every job. At most the reservation's maximum. */
  totalObligationBaseUnits: bigint;
  compositionRoot: Bytes32;
  capabilityContractRoot: Bytes32;
  jobs: CompiledJob[];
  nodeToUnit: NodeUnitBinding[];
}

export type CompileViolation =
  | { code: "invalid-plan-field"; field: string }
  | { code: "empty-plan" }
  | { code: "invalid-node-id"; nodeId: string }
  | { code: "duplicate-node"; nodeId: string }
  | { code: "invalid-node-field"; nodeId: string; field: string }
  | { code: "invalid-tier"; nodeId: string; tierKey: string }
  | { code: "operator-is-payer"; nodeId: string }
  | { code: "gross-out-of-range"; nodeId: string }
  | { code: "net-not-positive"; nodeId: string }
  | { code: "edge-unknown-node"; from: string; to: string }
  | { code: "self-loop"; nodeId: string }
  | { code: "duplicate-edge"; from: string; to: string }
  | { code: "cycle" }
  | { code: "fee-bps-out-of-range" }
  | { code: "fee-recipient-must-be-zero" }
  | { code: "fee-recipient-missing" }
  | { code: "program-on-tier-zero"; nodeId: string }
  | { code: "program-required-for-tier"; nodeId: string }
  | { code: "currency-not-settleable"; currency: string }
  | { code: "program-gate-missing"; nodeId: string }
  | { code: "program-gate-refused"; nodeId: string; reason: string }
  | { code: "mixed-programs-not-committable-v3"; programs: string[] }
  | { code: "reservation-request-mismatch" }
  | { code: "currency-mismatch" }
  | { code: "obligation-exceeds-reservation"; obligation: string; reservation: string }
  | { code: "too-many-units-for-operator"; operator: string; count: number }
  | { code: "payout-sum-mismatch"; nodeId: string; sum: string; net: string }
  | { code: "commitment-refused"; reason: string };

export type CompileResult =
  | { ok: true; plan: CompiledAcceptedPlan }
  | { ok: false; violations: CompileViolation[] };

/**
 * The program gate. Callers bind evidence's `assertAcceptedProgramForTier` to their CSD lookup:
 * `(a) => assertAcceptedProgramForTier({ ...a, tier: csdOf(a.csd).evidence[a.tierKey] })`.
 */
export type ProgramGate = (args: {
  csd: string;
  tierKey: string;
  committedProgramHash: string | null;
}) => { ok: true } | { ok: false; code: string };

export interface CompileDeps {
  /** Required whenever any node's tier is above 0. */
  assertProgramForTier?: ProgramGate;
}

// ── Small pure helpers (exported for direct testing) ─────────────────────────────────────────────

function toHex(b: Uint8Array): `0x${string}` {
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return `0x${h}`;
}

/** Tier number from a CSD tier key: "tier0".."tier3" -> 0..3; null for anything else. */
export function tierFromKey(tierKey: unknown): number | null {
  if (typeof tierKey !== "string") return null; // RegExp.exec would coerce ["tier2"] to "tier2"
  const m = /^tier([0-3])$/.exec(tierKey);
  return m ? Number(m[1]) : null;
}

/** `UnitConfig.stepId` for a node: keccak256 of the node id's UTF-8 bytes. */
export function stepIdBytes32(nodeId: string): Bytes32 {
  return toHex(keccak_256(new TextEncoder().encode(nodeId)));
}

/**
 * Render base units as the v3 root's canonical decimal string: no sign, no leading zeros, no
 * trailing fractional zeros, no exponent. `12_500_000n` at 6 decimals is "12.5"; `12_000_000n` is "12".
 */
export function baseUnitsToCanonicalDecimal(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError("decimals must be an integer in 0..18");
  }
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/** Per-unit fee split, exactly as the escrow computes it at funding. */
export function unitEconomics(g: bigint, feeBps: number): { g: bigint; f: bigint; n: bigint } {
  const f = (g * BigInt(feeBps)) / BPS_DENOMINATOR; // non-negative operands: bigint division floors
  return { g, f, n: g - f };
}

/** The escrow's `PayoutSumMismatch` rule: the legs must sum to `n` EXACTLY, 1 base unit included. */
export function payoutsConserve(payouts: readonly PayoutEntry[], n: bigint): boolean {
  let sum = 0n;
  for (const p of payouts) sum += p.amount;
  return sum === n;
}

/**
 * Deterministic topological order (Kahn's algorithm; among ready nodes, the smallest nodeId goes
 * first). Returns null when the edges contain a cycle. Independent of the input array order.
 */
export function canonicalTopologicalOrder(
  nodeIds: readonly string[],
  edges: readonly AcceptedPlanEdge[],
): string[] | null {
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const next = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    next.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const ready = [...nodeIds].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of next.get(id)!) {
      const d = indegree.get(to)! - 1;
      indegree.set(to, d);
      if (d === 0) {
        // keep `ready` sorted: insert at its sorted position
        let i = 0;
        while (i < ready.length && ready[i]! < to) i++;
        ready.splice(i, 0, to);
      }
    }
  }
  return order.length === nodeIds.length ? order : null;
}

function isAddress(a: unknown): a is Address {
  return typeof a === "string" && ADDRESS_PATTERN.test(a);
}

function isNonZeroAddress(a: unknown): a is Address {
  return isAddress(a) && a.toLowerCase() !== ZERO_ADDRESS;
}

// Pattern checks demand a real string first: RegExp.test coerces, so ["plan-1"] would pass as "plan-1".
function isId(x: unknown): x is string {
  return typeof x === "string" && ID_PATTERN.test(x);
}

function isCurrency(x: unknown): x is string {
  return typeof x === "string" && CURRENCY_PATTERN.test(x);
}

function isDigest(x: unknown): x is string {
  return typeof x === "string" && DIGEST_PATTERN.test(x);
}

/** A diagnostic's string form. Never throws, even on a value with no string conversion. */
function show(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return String(x);
  } catch {
    return `<${typeof x}>`;
  }
}

// ── The compiler ─────────────────────────────────────────────────────────────────────────────────

/** Compile an accepted, server-validated plan into V-next jobs. Fail closed on any violation. */
export function compileAcceptedPlan(input: AcceptedPlanInput, deps: CompileDeps = {}): CompileResult {
  const v: CompileViolation[] = [];

  // Plan-level fields.
  if (!isId(input.planId)) v.push({ code: "invalid-plan-field", field: "planId" });
  if (!isId(input.requestId)) v.push({ code: "invalid-plan-field", field: "requestId" });
  if (!isNonZeroAddress(input.payer)) v.push({ code: "invalid-plan-field", field: "payer" });
  if (!isCurrency(input.currency)) v.push({ code: "invalid-plan-field", field: "currency" });
  const currencyDecimals =
    isCurrency(input.currency) && Object.prototype.hasOwnProperty.call(SETTLEMENT_TOKEN_DECIMALS, input.currency)
      ? SETTLEMENT_TOKEN_DECIMALS[input.currency]!
      : undefined;
  if (isCurrency(input.currency) && currencyDecimals === undefined) {
    v.push({ code: "currency-not-settleable", currency: input.currency });
  }
  if (typeof input.reclaimAt !== "bigint" || input.reclaimAt <= 0n) {
    v.push({ code: "invalid-plan-field", field: "reclaimAt" });
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > MAX_FEE_BPS) {
    v.push({ code: "fee-bps-out-of-range" });
  } else if (input.feeBps === 0) {
    if (!isAddress(input.feeRecipient) || input.feeRecipient.toLowerCase() !== ZERO_ADDRESS) {
      v.push({ code: "fee-recipient-must-be-zero" });
    }
  } else if (!isNonZeroAddress(input.feeRecipient)) {
    v.push({ code: "fee-recipient-missing" });
  }
  const r = input.reservation;
  if (!r || !isId(r.reservationId) || typeof r.maxAmountBaseUnits !== "bigint") {
    v.push({ code: "invalid-plan-field", field: "reservation" });
  } else {
    if (r.requestId !== input.requestId) v.push({ code: "reservation-request-mismatch" });
    if (r.currency !== input.currency) v.push({ code: "currency-mismatch" });
  }

  // Nodes. EVERY occurrence is validated, duplicates included, so the diagnostics are a function of
  // the set of nodes and never of which duplicate came first (cross-family review, #351).
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const nodeStageStart = v.length;
  if (nodes.length === 0) v.push({ code: "empty-plan" });
  const occurrences = new Map<string, number>();
  for (const n of nodes) {
    if (isId(n?.nodeId)) occurrences.set(n.nodeId, (occurrences.get(n.nodeId) ?? 0) + 1);
  }
  for (const [id, count] of occurrences) if (count > 1) v.push({ code: "duplicate-node", nodeId: id });
  for (const n of nodes) {
    const id = n?.nodeId;
    if (!isId(id)) {
      v.push({ code: "invalid-node-id", nodeId: show(id) });
      continue;
    }
    if (!isId(n.capabilityId)) v.push({ code: "invalid-node-field", nodeId: id, field: "capabilityId" });
    if (!isId(n.capabilityType)) v.push({ code: "invalid-node-field", nodeId: id, field: "capabilityType" });
    if (!isId(n.csd)) v.push({ code: "invalid-node-field", nodeId: id, field: "csd" });
    if (tierFromKey(n.tierKey) === null) v.push({ code: "invalid-tier", nodeId: id, tierKey: show(n.tierKey) });
    if (!isNonZeroAddress(n.operator)) v.push({ code: "invalid-node-field", nodeId: id, field: "operator" });
    else if (isAddress(input.payer) && n.operator.toLowerCase() === input.payer.toLowerCase()) {
      v.push({ code: "operator-is-payer", nodeId: id });
    }
    if (!isNonZeroAddress(n.payoutAddress)) v.push({ code: "invalid-node-field", nodeId: id, field: "payoutAddress" });
    if (!isDigest(n.matchedCapabilityDigest)) {
      v.push({ code: "invalid-node-field", nodeId: id, field: "matchedCapabilityDigest" });
    }
    if (n.committedProgramHash !== null && !isDigest(n.committedProgramHash)) {
      v.push({ code: "invalid-node-field", nodeId: id, field: "committedProgramHash" });
    }
    if (!Array.isArray(n.evidenceRequirements)) {
      v.push({ code: "invalid-node-field", nodeId: id, field: "evidenceRequirements" });
    }
    if (typeof n.grossBaseUnits !== "bigint" || n.grossBaseUnits < MIN_GROSS_BASE_UNITS || n.grossBaseUnits > MAX_GROSS_BASE_UNITS) {
      v.push({ code: "gross-out-of-range", nodeId: id });
    } else if (Number.isInteger(input.feeBps) && input.feeBps >= 0 && input.feeBps <= MAX_FEE_BPS) {
      if (unitEconomics(n.grossBaseUnits, input.feeBps).n <= 0n) v.push({ code: "net-not-positive", nodeId: id });
    }
  }
  // Every later stage assumes unique, well-formed nodes (it reads operators, tiers and grosses without
  // re-checking them). A malformed node set is refused here, with a typed violation and no throw.
  if (v.length > nodeStageStart) return { ok: false, violations: sortViolations(v) };
  const byId = new Map<string, AcceptedPlanNode>(nodes.map((n) => [n.nodeId, n]));
  const tierOf = new Map<string, number>(nodes.map((n) => [n.nodeId, tierFromKey(n.tierKey)!]));

  // Edges and order.
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const seenEdges = new Set<string>();
  let edgesOk = true;
  for (const e of edges) {
    if (!byId.has(e?.from) || !byId.has(e?.to)) {
      v.push({ code: "edge-unknown-node", from: show(e?.from), to: show(e?.to) });
      edgesOk = false;
      continue;
    }
    if (e.from === e.to) {
      v.push({ code: "self-loop", nodeId: e.from });
      edgesOk = false;
      continue;
    }
    const key = JSON.stringify([e.from, e.to]);
    if (seenEdges.has(key)) {
      v.push({ code: "duplicate-edge", from: e.from, to: e.to });
      edgesOk = false;
      continue;
    }
    seenEdges.add(key);
  }
  const order = edgesOk ? canonicalTopologicalOrder([...byId.keys()], edges) : null;
  if (edgesOk && order === null) v.push({ code: "cycle" });

  // Assurance: every non-zero tier passes the program gate; tier 0 carries no program.
  const programs = new Set<string>();
  for (const [id, n] of byId) {
    const tier = tierOf.get(id);
    if (tier === undefined) continue;
    if (tier === 0) {
      if (n.committedProgramHash !== null) v.push({ code: "program-on-tier-zero", nodeId: id });
      continue;
    }
    if (n.committedProgramHash === null) {
      v.push({ code: "program-required-for-tier", nodeId: id });
      continue;
    }
    if (!deps.assertProgramForTier) {
      v.push({ code: "program-gate-missing", nodeId: id });
      continue;
    }
    const gate = deps.assertProgramForTier({ csd: n.csd, tierKey: n.tierKey, committedProgramHash: n.committedProgramHash });
    if (!gate.ok) {
      v.push({ code: "program-gate-refused", nodeId: id, reason: gate.code });
      continue;
    }
    if (typeof n.committedProgramHash === "string") programs.add(n.committedProgramHash.toLowerCase());
  }
  // v3 commits ONE program per plan. Two different programs cannot be committed under v3; refuse
  // rather than silently committing one of them (reconciliation note, finding A).
  if (programs.size > 1) v.push({ code: "mixed-programs-not-committable-v3", programs: [...programs].sort() });

  // Authority: the whole obligation fits inside the reservation.
  let total = 0n;
  for (const n of byId.values()) if (typeof n.grossBaseUnits === "bigint") total += n.grossBaseUnits;
  if (r && typeof r.maxAmountBaseUnits === "bigint" && total > r.maxAmountBaseUnits) {
    v.push({ code: "obligation-exceeds-reservation", obligation: total.toString(), reservation: r.maxAmountBaseUnits.toString() });
  }

  // One job per operator, capped.
  const byOperator = new Map<string, string[]>();
  for (const id of order ?? []) {
    const op = byId.get(id)!.operator.toLowerCase();
    byOperator.set(op, [...(byOperator.get(op) ?? []), id]);
  }
  for (const [op, ids] of byOperator) {
    if (ids.length > MAX_UNITS_PER_JOB) v.push({ code: "too-many-units-for-operator", operator: op, count: ids.length });
  }

  if (v.length > 0 || order === null || !r || currencyDecimals === undefined) {
    return { ok: false, violations: sortViolations(v) };
  }

  // The v3 root, derived from the same bytes the units come from.
  const program = programs.size === 1 ? [...programs][0]! : undefined;
  const dag: MatchedDAG = {
    requestId: input.requestId,
    nodes: order.map((id) => {
      const n = byId.get(id)!;
      return {
        nodeId: id,
        capabilityType: n.capabilityType,
        matchStatus: "matched" as const,
        matchedCapabilityDigest: n.matchedCapabilityDigest,
        matchedCapabilityId: n.capabilityId,
        estimatedCost: baseUnitsToCanonicalDecimal(n.grossBaseUnits, currencyDecimals),
        currency: input.currency,
        operatorSettlementAddress: n.payoutAddress,
        evidenceRequirements: n.evidenceRequirements,
      };
    }),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    ...(program !== undefined ? { verificationProgramHash: program } : {}),
  };
  const commitment = deriveCompositionCommitment(dag, { version: 3 });
  if (!commitment.committable) {
    return { ok: false, violations: [{ code: "commitment-refused", reason: commitment.reason }] };
  }
  const compositionRoot = commitment.compositionRoot as Bytes32;

  // Jobs in operator-address order; units in canonical plan order within each job.
  const jobs: CompiledJob[] = [];
  const nodeToUnit: NodeUnitBinding[] = [];
  const operators = [...byOperator.keys()].sort();
  for (const [jobIndex, op] of operators.entries()) {
    const ids = byOperator.get(op)!;
    const first = byId.get(ids[0]!)!;
    const jobId = `${input.planId}:${op}`;
    const units: UnitConfigInput[] = [];
    for (const [milestoneIndex, id] of ids.entries()) {
      const n = byId.get(id)!;
      const tier = tierOf.get(id)!;
      const { g, f, n: net } = unitEconomics(n.grossBaseUnits, input.feeBps);
      const payouts: PayoutEntry[] = [{ recipient: n.payoutAddress, amount: net }];
      if (!payoutsConserve(payouts, net)) {
        // Unreachable with one leg carrying `n`; kept so any future split path is checked here.
        const sum = payouts.reduce((acc, p) => acc + p.amount, 0n);
        return { ok: false, violations: [{ code: "payout-sum-mismatch", nodeId: id, sum: sum.toString(), net: net.toString() }] };
      }
      units.push({
        milestoneIndex: BigInt(milestoneIndex),
        stepId: stepIdBytes32(id),
        requiredTier: tier,
        requestedTier: tier,
        g,
        f,
        n: net,
        feeBps: input.feeBps,
        feeRecipient: input.feeRecipient,
        reclaimAt: input.reclaimAt,
        compositionSchemaVersion: COMPOSITION_SCHEMA_VERSION,
        compositionRoot,
        payouts,
      });
      nodeToUnit.push({
        nodeId: id,
        jobIndex,
        jobId,
        operator: first.operator,
        milestoneIndex,
        stepId: id,
        stepIdBytes32: stepIdBytes32(id),
        tier,
        committedProgramHash: n.committedProgramHash,
      });
    }
    jobs.push({ jobId, operator: first.operator, payer: input.payer, units, nodeIds: [...ids] });
  }

  const unsealed = {
    planId: input.planId,
    requestId: input.requestId,
    reservationId: r.reservationId,
    currency: input.currency,
    currencyDecimals,
    totalObligationBaseUnits: total,
    compositionRoot,
    capabilityContractRoot: commitment.capabilityContractRoot as Bytes32,
    jobs,
    nodeToUnit,
  };
  return { ok: true, plan: { ...unsealed, acceptedDealDigest: acceptedDealDigest(unsealed) } };
}

/** Deterministic total order over violations, so a rejected plan's diagnostics are permutation-stable. */
function sortViolations(v: CompileViolation[]): CompileViolation[] {
  return [...v].sort((a, b) => {
    const x = canonicalize(a);
    const y = canonicalize(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * sha256 over the canonical JSON of the whole compiled deal (bigints as decimal strings, addresses
 * and hashes lowercased — hex case carries no meaning). Any change to any settlement-significant
 * term — tier, fee, amount, payee, signing operator, unit order, reservation, currency or decimals —
 * changes this digest.
 */
export function acceptedDealDigest(plan: Omit<CompiledAcceptedPlan, "acceptedDealDigest">): `0x${string}` {
  const lc = (x: string | null) => (x === null ? null : x.toLowerCase());
  const preimage = canonicalize({
    domain: ACCEPTED_DEAL_DOMAIN,
    planId: plan.planId,
    requestId: plan.requestId,
    reservationId: plan.reservationId,
    currency: plan.currency,
    currencyDecimals: plan.currencyDecimals,
    totalObligationBaseUnits: plan.totalObligationBaseUnits.toString(),
    compositionRoot: lc(plan.compositionRoot),
    capabilityContractRoot: lc(plan.capabilityContractRoot),
    jobs: plan.jobs.map((j) => ({
      jobId: j.jobId,
      operator: lc(j.operator),
      payer: lc(j.payer),
      nodeIds: j.nodeIds,
      units: j.units.map((u) => ({
        milestoneIndex: u.milestoneIndex.toString(),
        stepId: lc(u.stepId),
        requiredTier: u.requiredTier,
        requestedTier: u.requestedTier,
        g: u.g.toString(),
        f: u.f.toString(),
        n: u.n.toString(),
        feeBps: u.feeBps,
        feeRecipient: lc(u.feeRecipient),
        reclaimAt: u.reclaimAt.toString(),
        compositionSchemaVersion: u.compositionSchemaVersion,
        compositionRoot: lc(u.compositionRoot),
        payouts: u.payouts.map((p) => ({ recipient: lc(p.recipient), amount: p.amount.toString() })),
      })),
    })),
    nodeToUnit: plan.nodeToUnit.map((b) => ({
      nodeId: b.nodeId,
      jobIndex: b.jobIndex,
      jobId: b.jobId,
      operator: lc(b.operator),
      milestoneIndex: b.milestoneIndex,
      stepId: b.stepId,
      stepIdBytes32: lc(b.stepIdBytes32),
      tier: b.tier,
      committedProgramHash: lc(b.committedProgramHash),
    })),
  });
  return toHex(sha256(new TextEncoder().encode(preimage)));
}
