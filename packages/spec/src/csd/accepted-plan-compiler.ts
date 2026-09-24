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
 *    would let two units' errors cancel. Each unit pays one leg (the payout address receives n), or,
 *    when an agreement applies, economics' split (R15, injected as `splitNet`), which must name
 *    exactly the plan's units, agree with these g/f/n, and use 1–16 legs to non-zero addresses.
 *  - BOUNDED AUTHORITY. The plan's whole obligation (`Σ g`) must fit inside the server-issued
 *    reservation (R13), in its currency, for this request. Issuing and consuming the reservation
 *    atomically is the reservation store's job; the output names it so the consume can seal this plan.
 *  - ASSURANCE. Every non-zero-tier unit must carry a program hash AND pass the injected program gate
 *    (evidence's `assertAcceptedProgramForTier`, #349). A missing hash is refused here even if a
 *    permissive gate would approve it; with no gate injected, a non-zero tier is refused.
 *  - A SEALED DEAL. `acceptedDealDigest` = sha256 over the canonical form of the ENTIRE compiled deal:
 *    every job, every unit field (tier, fee, amounts, payees, order), the signing operators, the
 *    reservation, the currency and its decimals, both v3 roots, and economics' two terms hashes
 *    (null when no agreement applies). This is the digest the reservation
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
  /** Economics' terms hashes when an agreement split the payouts (R15); null otherwise. Both sealed. */
  economicTermsHash: `0x${string}` | null;
  rightsTermsHash: `0x${string}` | null;
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
  | { code: "commitment-refused"; reason: string }
  | { code: "economics-refused"; reason: string }
  | { code: "economics-malformed"; detail: string }
  | { code: "economics-mismatch"; nodeId: string; field: "gross" | "fee" | "net" }
  | { code: "invalid-payout-leg"; nodeId: string; index: number }
  | { code: "too-many-payout-legs"; nodeId: string; count: number };

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

/** One unit as the economics splitter sees it, in canonical plan order. */
export interface SplitUnitInput {
  nodeId: string;
  operator: Address;
  payoutAddress: Address;
  g: bigint;
  f: bigint;
  n: bigint;
}

/**
 * Economics' split of each unit's net (R15: economics' `compileEconomics`, bound by the route to the
 * accepted agreement). Amounts are integer base-unit strings, as economics emits them; `unitRef` is
 * the composition node id.
 */
export type NetSplitResult =
  | {
      ok: true;
      units: ReadonlyArray<{
        unitRef: string;
        gross: string;
        fee: string;
        net: string;
        payouts: ReadonlyArray<{ recipient: string; amount: string }>;
      }>;
      economicTermsHash: string;
      rightsTermsHash: string;
    }
  | { ok: false; code: string };

export type NetSplitter = (units: readonly SplitUnitInput[]) => NetSplitResult;

export interface CompileDeps {
  /** Required whenever any node's tier is above 0. */
  assertProgramForTier?: ProgramGate;
  /** Optional economics split (R15). Without it each unit pays one leg: `payoutAddress` receives `n`. */
  splitNet?: NetSplitter;
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

/**
 * Bounds on the input the compiler will copy: resource safety at the money-path boundary. These are
 * PRODUCT limits, not V-next ABI limits (the ABI's are per job: 16 units, 256 legs). A plan beyond
 * them is refused before any element is read.
 */
export const MAX_PLAN_NODES = 1024;
export const MAX_PLAN_EDGES = 4096;
export const MAX_EVIDENCE_REQUIREMENTS_PER_NODE = 64;

/**
 * A compiler-owned stand-in for a structurally invalid value (a function, a non-array where a list
 * belongs, an object where a primitive belongs). No caller reference survives the snapshot, and this
 * value fails every check the compiler makes, so validation refuses it.
 */
const NOT_DATA: object = Object.freeze(Object.create(null));

/** Primitives are immutable and kept; anything else becomes NOT_DATA. */
function leaf(v: unknown): unknown {
  return (typeof v === "object" && v !== null) || typeof v === "function" ? NOT_DATA : v;
}

/**
 * A frozen plain copy of a list, each item copied by `item`, its length read once. A primitive is kept
 * for validation to name; any other non-array becomes NOT_DATA. Over `max`, `over` is called BEFORE
 * any element is read.
 */
function copyList(x: unknown, max: number, over: () => never, item: (v: unknown) => unknown): unknown {
  if (!Array.isArray(x)) return leaf(x);
  const n = lengthOf(x);
  if (n === null) throw new TypeError("lying length");
  if (n > max) over();
  const out: unknown[] = [];
  for (let k = 0; k < n; k++) out.push(item(x[k]));
  return Object.freeze(out);
}

/** A frozen plain copy of the named fields of a plain object; primitives kept, functions become NOT_DATA. */
function copyFields(
  x: unknown,
  fields: readonly string[],
  extra: (o: Record<string, unknown>, out: Record<string, unknown>) => void = () => {},
): unknown {
  if (typeof x !== "object" || x === null) return leaf(x);
  const o = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = leaf(o[f]);
  extra(o, out);
  return Object.freeze(out);
}

const NODE_FIELDS = [
  "nodeId", "capabilityId", "capabilityType", "csd", "tierKey", "operator", "payoutAddress",
  "grossBaseUnits", "matchedCapabilityDigest", "committedProgramHash",
] as const;

/**
 * Copy the caller's input into compiler-owned, frozen plain data, reading every property and every
 * array length EXACTLY ONCE, before anything else runs (cross-family review of 4479b79a and ce18cf42).
 * Validation, the injected program gate and economics splitter, unit construction and the digest all
 * see only this copy. Nothing in it is a caller reference: primitives are copied, and every other
 * value where data belongs becomes NOT_DATA. A throw while reading, or a lying length, is a typed
 * refusal. The catch never inspects the thrown value (a hostile value could throw again): a bound is
 * recognized by the identity of a token this function owns.
 */
function snapshotInput(untrusted: unknown): AcceptedPlanInput | { refused: CompileViolation } {
  const BOUND = Object.freeze({});
  let boundField = "input";
  const over = (field: string) => (): never => {
    boundField = field;
    throw BOUND;
  };
  try {
    if (typeof untrusted !== "object" || untrusted === null) return { refused: { code: "invalid-plan-field", field: "input" } };
    const i = untrusted as Record<string, unknown>;
    const copy = {
      planId: leaf(i.planId),
      requestId: leaf(i.requestId),
      payer: leaf(i.payer),
      currency: leaf(i.currency),
      feeBps: leaf(i.feeBps),
      feeRecipient: leaf(i.feeRecipient),
      reclaimAt: leaf(i.reclaimAt),
      nodes: copyList(i.nodes, MAX_PLAN_NODES, over("nodes"), (n) =>
        copyFields(n, NODE_FIELDS, (o, out) => {
          out.evidenceRequirements = copyList(o.evidenceRequirements, MAX_EVIDENCE_REQUIREMENTS_PER_NODE, over("evidenceRequirements"), (r) =>
            copyFields(r, ["requirementId", "evidenceTypeId", "tier"]),
          );
        }),
      ),
      edges: copyList(i.edges, MAX_PLAN_EDGES, over("edges"), (e) => copyFields(e, ["from", "to"])),
      reservation: copyFields(i.reservation, ["reservationId", "requestId", "currency", "maxAmountBaseUnits"]),
    };
    return Object.freeze(copy) as unknown as AcceptedPlanInput;
  } catch (e) {
    return { refused: { code: "invalid-plan-field", field: e === BOUND ? boundField : "input" } };
  }
}

/**
 * The program gate's ANSWER, read once and defensively. The gate itself is trusted server code (if it
 * throws, that propagates as a server fault); a malformed answer is a refusal, never an exception.
 */
function readGateResult(g: unknown): { ok: true } | { ok: false; code: string } {
  try {
    if (typeof g !== "object" || g === null) return { ok: false, code: "malformed-gate-result" };
    const r = g as Record<string, unknown>;
    const ok = r.ok;
    if (ok === true) return { ok: true };
    if (ok !== false) return { ok: false, code: "malformed-gate-result" };
    const code = r.code;
    return { ok: false, code: typeof code === "string" ? code : "malformed-gate-result" };
  } catch {
    return { ok: false, code: "malformed-gate-result" };
  }
}

/** Compile an accepted, server-validated plan into V-next jobs. Fail closed on any violation. */
export function compileAcceptedPlan(untrusted: AcceptedPlanInput, deps: CompileDeps = {}): CompileResult {
  // Only compiler-owned, frozen data from here on: see `snapshotInput`.
  const snap = snapshotInput(untrusted);
  if ("refused" in snap) return { ok: false, violations: [snap.refused] };
  const input = snap;
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
    const gate = readGateResult(deps.assertProgramForTier({ csd: n.csd, tierKey: n.tierKey, committedProgramHash: n.committedProgramHash }));
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

  // Payouts: one leg per unit (the payout address receives n), or economics' split, which must agree
  // with this compiler's own economics and conserve EXACTLY per unit — refused, never repaired.
  const econOf = new Map(order.map((id) => [id, unitEconomics(byId.get(id)!.grossBaseUnits, input.feeBps)]));
  const payoutsOf = new Map<string, PayoutEntry[]>();
  let economicTermsHash: `0x${string}` | null = null;
  let rightsTermsHash: `0x${string}` | null = null;
  if (deps.splitNet) {
    const split = splitPayouts(order, byId, econOf, deps.splitNet);
    if (!split.ok) return { ok: false, violations: sortViolations(split.violations) };
    for (const [id, legs] of split.payouts) payoutsOf.set(id, legs);
    economicTermsHash = split.economicTermsHash;
    rightsTermsHash = split.rightsTermsHash;
  } else {
    for (const id of order) payoutsOf.set(id, [{ recipient: byId.get(id)!.payoutAddress, amount: econOf.get(id)!.n }]);
  }

  // Jobs in operator-address order; units in canonical plan order within each job. (The frozen
  // ABI's 256 legs per job is implied: at most 16 units per job, at most 16 legs per unit.)
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
      const { g, f, n: net } = econOf.get(id)!;
      const payouts = payoutsOf.get(id)!;
      if (!payoutsConserve(payouts, net)) {
        // Unreachable: both payout paths above are checked. Kept as the last guard before encoding.
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
    economicTermsHash,
    rightsTermsHash,
    jobs,
    nodeToUnit,
  };
  return { ok: true, plan: { ...unsealed, acceptedDealDigest: acceptedDealDigest(unsealed) } };
}

/** Integer base units: canonical (no sign, no leading zeros) and at most 78 digits (a uint256 has 78). */
const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

/** An integer base-unit string as a bigint, or null. */
function baseUnits(x: unknown): bigint | null {
  return typeof x === "string" && BASE_UNITS.test(x) ? BigInt(x) : null;
}

/** One payout leg and one unit of a splitter's answer, copied into plain data. */
interface LegSnapshot {
  recipient: unknown;
  amount: unknown;
}
interface UnitSnapshot {
  unitRef: unknown;
  gross: unknown;
  fee: unknown;
  net: unknown;
  payouts: LegSnapshot[] | "not-array" | { tooMany: number };
}
type SplitSnapshot =
  | { ok: true; economicTermsHash: unknown; rightsTermsHash: unknown; units: Array<UnitSnapshot | null> | "not-array" | "too-many" }
  | { ok: false; code: unknown }
  | "malformed";

/** A plain array length, or null for a length that is not a non-negative integer (a proxy can lie). */
function lengthOf(a: readonly unknown[]): number | null {
  const n: unknown = a.length;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Copy a splitter's answer into compiler-owned plain data, reading every property EXACTLY ONCE and
 * every array's length once, before any validation (cross-family review of af425ede). Getters,
 * proxies and arrays that grow while being read cannot change what is validated, and validation
 * cannot see a different value than the one used: only this copy is inspected afterwards. A throw
 * while reading is a malformed answer, never an exception.
 */
function snapshotSplit(res: unknown, maxUnits: number): SplitSnapshot {
  try {
    if (typeof res !== "object" || res === null) return "malformed";
    const r = res as Record<string, unknown>;
    const ok = r.ok;
    if (ok === false) return { ok: false, code: r.code };
    if (ok !== true) return "malformed";
    const economicTermsHash = r.economicTermsHash;
    const rightsTermsHash = r.rightsTermsHash;
    const unitsRaw = r.units;
    if (!Array.isArray(unitsRaw)) return { ok: true, economicTermsHash, rightsTermsHash, units: "not-array" };
    const unitCount = lengthOf(unitsRaw);
    if (unitCount === null) return { ok: true, economicTermsHash, rightsTermsHash, units: "not-array" };
    if (unitCount > maxUnits) return { ok: true, economicTermsHash, rightsTermsHash, units: "too-many" };
    const units: Array<UnitSnapshot | null> = [];
    for (let i = 0; i < unitCount; i++) {
      const u: unknown = unitsRaw[i];
      if (typeof u !== "object" || u === null) {
        units.push(null);
        continue;
      }
      const ur = u as Record<string, unknown>;
      const unitRef = ur.unitRef;
      const gross = ur.gross;
      const fee = ur.fee;
      const net = ur.net;
      const payoutsRaw = ur.payouts;
      let payouts: UnitSnapshot["payouts"] = "not-array";
      if (Array.isArray(payoutsRaw)) {
        const legCount = lengthOf(payoutsRaw);
        if (legCount !== null && legCount > MAX_PAYOUT_LEGS_PER_UNIT) payouts = { tooMany: legCount };
        else if (legCount !== null) {
          const legs: LegSnapshot[] = [];
          for (let k = 0; k < legCount; k++) {
            const leg: unknown = payoutsRaw[k];
            if (typeof leg !== "object" || leg === null) legs.push({ recipient: undefined, amount: undefined });
            else {
              const lr = leg as Record<string, unknown>;
              legs.push({ recipient: lr.recipient, amount: lr.amount });
            }
          }
          payouts = legs;
        }
      }
      units.push({ unitRef, gross, fee, net, payouts });
    }
    return { ok: true, economicTermsHash, rightsTermsHash, units };
  } catch {
    return "malformed";
  }
}

/**
 * Ask economics to split each unit's net, then hold its answer to this compiler's own numbers:
 * exactly the plan's units, the same gross/fee/net, 1–16 legs to non-zero addresses with positive
 * amounts, and Σ legs === n per unit. Anything else is a violation. The splitter itself is trusted
 * server code: if it THROWS, that is a server fault and propagates, rather than being read as a
 * refusal. What it RETURNS is untrusted and is only ever inspected through `snapshotSplit`.
 */
function splitPayouts(
  order: readonly string[],
  byId: ReadonlyMap<string, AcceptedPlanNode>,
  econOf: ReadonlyMap<string, { g: bigint; f: bigint; n: bigint }>,
  splitNet: NetSplitter,
):
  | { ok: true; payouts: Map<string, PayoutEntry[]>; economicTermsHash: `0x${string}`; rightsTermsHash: `0x${string}` }
  | { ok: false; violations: CompileViolation[] } {
  const malformed = (detail: string) => ({ ok: false as const, violations: [{ code: "economics-malformed" as const, detail }] });
  const res = splitNet(
    order.map((id) => {
      const node = byId.get(id)!;
      const e = econOf.get(id)!;
      return { nodeId: id, operator: node.operator, payoutAddress: node.payoutAddress, g: e.g, f: e.f, n: e.n };
    }),
  );
  const snap = snapshotSplit(res, order.length);
  if (snap === "malformed") return malformed("result");
  if (!snap.ok) return { ok: false, violations: [{ code: "economics-refused", reason: show(snap.code) }] };
  if (!isDigest(snap.economicTermsHash) || !isDigest(snap.rightsTermsHash)) return malformed("terms-hash");
  if (snap.units === "not-array") return malformed("units");
  if (snap.units === "too-many") return malformed("unit-set");
  const byRef = new Map<string, UnitSnapshot>();
  for (const u of snap.units) {
    if (u === null || !isId(u.unitRef) || byRef.has(u.unitRef)) return malformed("unit-ref");
    byRef.set(u.unitRef, u);
  }
  if (byRef.size !== order.length || order.some((id) => !byRef.has(id))) return malformed("unit-set");

  const v: CompileViolation[] = [];
  const payouts = new Map<string, PayoutEntry[]>();
  for (const id of order) {
    const u = byRef.get(id)!;
    const e = econOf.get(id)!;
    if (baseUnits(u.gross) !== e.g) v.push({ code: "economics-mismatch", nodeId: id, field: "gross" });
    if (baseUnits(u.fee) !== e.f) v.push({ code: "economics-mismatch", nodeId: id, field: "fee" });
    if (baseUnits(u.net) !== e.n) v.push({ code: "economics-mismatch", nodeId: id, field: "net" });
    if (u.payouts === "not-array") {
      v.push({ code: "economics-malformed", detail: `payouts:${id}` });
      continue;
    }
    if (!Array.isArray(u.payouts)) {
      v.push({ code: "too-many-payout-legs", nodeId: id, count: u.payouts.tooMany });
      continue;
    }
    const legs: PayoutEntry[] = [];
    u.payouts.forEach((leg, i) => {
      const amount = baseUnits(leg.amount);
      if (!isNonZeroAddress(leg.recipient) || amount === null || amount <= 0n) {
        v.push({ code: "invalid-payout-leg", nodeId: id, index: i });
        return;
      }
      legs.push({ recipient: leg.recipient, amount });
    });
    if (legs.length === u.payouts.length && !payoutsConserve(legs, e.n)) {
      const sum = legs.reduce((acc, p) => acc + p.amount, 0n);
      v.push({ code: "payout-sum-mismatch", nodeId: id, sum: sum.toString(), net: e.n.toString() });
    }
    payouts.set(id, legs);
  }
  if (v.length > 0) return { ok: false, violations: v };
  return {
    ok: true,
    payouts,
    economicTermsHash: snap.economicTermsHash.toLowerCase() as `0x${string}`,
    rightsTermsHash: snap.rightsTermsHash.toLowerCase() as `0x${string}`,
  };
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
    economicTermsHash: lc(plan.economicTermsHash),
    rightsTermsHash: lc(plan.rightsTermsHash),
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
