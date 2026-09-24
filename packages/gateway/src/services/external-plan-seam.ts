/**
 * The accept seam for an externally authored plan: reconciliation R9's pure part, chaining
 * R10 (live re-read) -> R11 (server-resolved programs, evidence's gate) -> R12 (the compiler).
 *
 *   agent DAG (claims) --R10--> live terms --R11--> programs --> AcceptedPlanInput --R12--> accepted deal
 *                                  reservation (durable, server-issued) ---^            (acceptedDealDigest)
 *
 * The agent supplies only the plan's SHAPE (nodes, edges), what it believes each node costs, and the
 * tier it buys each node at. Every other settlement term is the server's: operator and payout
 * address, gross, currency, program, evidence requirements, payer, fee, reclaim time, and the plan id
 * itself (derived from the reservation, so a caller cannot choose job ids that collide with another
 * plan's). The tier is the principal's purchase choice, constrained twice: R10 admits only a tier
 * the live row offers, and the reservation's `minTier`, when it carries one, is a floor — a delegated
 * agent cannot spend money the payer authorized for tier 2 on tier-0 work (invariant 11).
 *
 * This module performs no I/O: every read is an injected dependency, so the accept decision is a pure
 * function of (submission, principal, live state). The route (R9; it needs R28 money scopes) calls it
 * and then, in ONE transaction, consumes the reservation while sealing `plan.acceptedDealDigest` (R13).
 * The reservation checks here are an early pre-check; the consume must re-check them atomically and
 * RECOMPUTE the digest from the plan it encodes (the #351 consumer contract).
 *
 * Every input is read ONCE into owned plain data before it is used (the pattern that closed the
 * compiler and R10 under cross-family review): the submission, the principal, each dependency, the
 * policy and the reservation record. A getter, a proxy or a callback cannot change a value between
 * its check and its use, and a failure to READ data is a typed refusal. A dependency CALL that throws
 * is a server fault and propagates.
 */

import { createHash } from "node:crypto";
import {
  canonicalize,
  compileAcceptedPlan,
  copyPlanJson,
  type Address,
  type CompileViolation,
  type CompiledAcceptedPlan,
  type EvidenceRequirement,
  type NetSplitter,
  type PlanJsonObject,
  type PlanJsonRefusal,
  type ProgramGate,
} from "@pcc/spec";
import {
  revalidatePlanSnapshots,
  type NodeVerdict,
  type ResolvedNodeTerms,
  type RevalidationDeps,
  type SnapshotClaim,
} from "./plan-snapshot-revalidation.js";

/** A node as the agent submits it: its R10 claim, plus an optional program it expects. */
export interface ExternalPlanNode extends SnapshotClaim {
  /** Optional cross-check. The program itself is always resolved server-side. */
  committedProgramHash?: string | null;
  /**
   * N25: what the node runs ON, as plain JSON (e.g. the document hash and page count). The caller's
   * content, never authority. It is sealed in the accepted deal through the node's `planHash`.
   */
  inputs?: Record<string, unknown>;
  /** N25: execution constraints as plain JSON (e.g. a deadline). Sealed like `inputs`. */
  constraints?: Record<string, unknown>;
}

export interface ExternalPlanSubmission {
  requestId: string;
  /** The server-issued reservation (R13) this plan is to be funded from. */
  reservationId: string;
  nodes: ExternalPlanNode[];
  edges: Array<{ from: string; to: string }>;
}

/** What the R13 store returns for a reservation. The table itself is operator decision #2240. */
export interface ReservationRecord {
  reservationId: string;
  principal: string;
  requestId: string;
  currency: string;
  maxAmountBaseUnits: bigint;
  /** Unix seconds. */
  expiresAt: number;
  state: "issued" | "consumed" | "expired" | "released";
  /** The principal's paying wallet, recorded when the reservation was issued. */
  payer: Address;
  /** Optional floor: the lowest assurance tier the payer authorized this money for. */
  minTier?: number;
}

/** Server fee and timing policy. Never taken from the caller. */
export interface SettlementPolicy {
  feeBps: number;
  feeRecipient: Address;
  /** Seconds after acceptance at which the payer may reclaim an unsettled unit. */
  reclaimAfterSec: number;
}

export interface SeamDeps {
  revalidation: RevalidationDeps;
  /** R11: the program for (csd, tier), e.g. evidence's `resolveAcceptedProgram`; null when none. */
  resolveProgram(csd: string, tierKey: string): string | null;
  /** R11: evidence's `assertAcceptedProgramForTier`, bound to the CSD lookup. */
  assertProgramForTier: ProgramGate;
  /** The evidence requirements of a CSD tier (evidence owns this mapping); null when the tier has none. */
  evidenceFor(csd: string, tierKey: string): EvidenceRequirement[] | null;
  /** R13: a read of the durable reservation store. */
  loadReservation(reservationId: string): ReservationRecord | null;
  policy: SettlementPolicy;
  /** Unix seconds. */
  now(): number;
  /**
   * R15, optional: present only when an economic agreement applies to this plan. The route binds it per
   * request, to the agreement and the server's facts. Royalties go ON TOP (economics #3025, option b):
   * each unit's gross is the agreement's, and it must cover the operator's live quote.
   */
  economics?: EconomicsBinding;
}

export interface EconomicsBinding {
  /** Economics' `agreementUnitGross(agreement)`: the agreement's gross per plan node, in base units. */
  unitGross(): { ok: true; gross: Record<string, bigint> } | { ok: false; code: string };
  /** Economics' `netSplitterFor(...)`, bound to the agreement and the server's facts. The compiler calls it. */
  splitNet: NetSplitter;
}

export interface SeamContext {
  /** The authenticated principal (from the route's auth, never from the body). */
  principal: string;
  tenantId?: string | null;
}

/** One execution-JSON field the seam refused (N25), in (nodeId, field) order. */
export interface ExecJsonProblem {
  nodeId: string;
  field: "inputs" | "constraints";
  reason: PlanJsonRefusal;
}

export type SeamRefusal =
  | { stage: "submission"; reason: "malformed-submission" }
  | { stage: "submission"; reason: "invalid-execution-json"; fields: ExecJsonProblem[] }
  | {
      stage: "reservation";
      reason: "not-found" | "not-issued" | "expired" | "wrong-principal" | "wrong-request" | "malformed-reservation";
    }
  | { stage: "revalidation"; verdicts: NodeVerdict[] }
  | { stage: "currency"; nodeId: string; reason: "node-currency-differs-from-reservation" }
  | { stage: "tier"; nodeId: string; reason: "below-reservation-minimum" }
  | { stage: "program"; nodeId: string; reason: "claimed-program-mismatch" }
  | { stage: "evidence"; nodeId: string; reason: "no-evidence-contract-for-tier" }
  | { stage: "compile"; violations: CompileViolation[] }
  | {
      stage: "economics";
      reason: "agreement-refused" | "agreement-unreadable" | "unit-gross-missing" | "quote-not-covered";
      nodeId?: string;
      code?: string;
    };

/**
 * `submissionDigest` fingerprints the submission EXACTLY as evaluated (see `submissionDigest`), so a
 * read model can prove the submission it displays is the one this outcome belongs to. `verdicts` is
 * every node's R10 verdict, present whenever R10 ran. Neither grants anything.
 */
export type SeamResult =
  | { ok: true; plan: CompiledAcceptedPlan; resolved: ResolvedNodeTerms[]; verdicts: NodeVerdict[]; submissionDigest: `0x${string}` }
  | { ok: false; refusal: SeamRefusal; verdicts?: NodeVerdict[]; submissionDigest?: `0x${string}` };

/** The plan id is derived from the reservation: one reservation, one plan, and no caller-chosen job ids. */
export function planIdForReservation(reservationId: string): string {
  return `plan.${reservationId}`;
}

// ── Read-once snapshots ──────────────────────────────────────────────────────────────────────────

/** An owned stand-in for a non-primitive where a primitive belongs: fails every check, holds no caller reference. */
const NOT_DATA: object = Object.freeze(Object.create(null));

function leaf(v: unknown): unknown {
  return (typeof v === "object" && v !== null) || typeof v === "function" ? NOT_DATA : v;
}

/** A list's elements, its length read once and capped; null for a non-array or a lying or over-cap length. */
function listOnce(x: unknown, max: number): unknown[] | null {
  if (!Array.isArray(x)) return null;
  const n: unknown = x.length;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) return null;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(x[i]);
  return out;
}

const MAX_SUBMISSION_NODES = 1024;
const MAX_SUBMISSION_EDGES = 4096;
const NODE_FIELDS = [
  "nodeId", "capabilityId", "price", "currency", "tierKey", "kernelId", "operator",
  "capabilityType", "csd", "matchedCapabilityDigest", "committedProgramHash",
] as const;

/** A node's execution JSON as read once (N25): absent, an owned plain-JSON copy, or why it was refused. */
export type ExecJsonSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "json"; readonly value: PlanJsonObject }
  | { readonly kind: "invalid"; readonly reason: PlanJsonRefusal };

export type SubmissionNodeSnapshot = Readonly<Record<(typeof NODE_FIELDS)[number], unknown>> & {
  readonly inputs: ExecJsonSnapshot;
  readonly constraints: ExecJsonSnapshot;
};

/**
 * A submission as owned plain data: every field read exactly once. Non-primitives become NOT_DATA,
 * except each node's execution JSON, which is copied as bounded plain JSON (`copyPlanJson`).
 */
export interface SubmissionSnapshot {
  requestId: unknown;
  reservationId: unknown;
  nodes: ReadonlyArray<SubmissionNodeSnapshot | null>;
  edges: ReadonlyArray<Readonly<{ from: unknown; to: unknown }> | null>;
}

const ABSENT: ExecJsonSnapshot = Object.freeze({ kind: "absent" });

/** Read one execution-JSON field (its value was read once by the caller of this function). */
function execSnapshot(x: unknown): ExecJsonSnapshot {
  if (x === undefined) return ABSENT;
  const c = copyPlanJson(x);
  return Object.freeze(c.ok ? { kind: "json" as const, value: c.value } : { kind: "invalid" as const, reason: c.reason });
}

/** Read a submission once. Null when it cannot be read as a submission at all. Never throws. */
export function snapshotSubmission(sub: unknown): SubmissionSnapshot | null {
  try {
    if (typeof sub !== "object" || sub === null) return null;
    const s = sub as Record<string, unknown>;
    const requestId = leaf(s.requestId);
    const reservationId = leaf(s.reservationId);
    const nodesRaw = listOnce(s.nodes, MAX_SUBMISSION_NODES);
    const edgesRaw = listOnce(s.edges, MAX_SUBMISSION_EDGES);
    if (!nodesRaw || !edgesRaw) return null;
    const nodes = nodesRaw.map((n) => {
      if (typeof n !== "object" || n === null) return null;
      const o = n as Record<string, unknown>;
      const out = {} as Record<(typeof NODE_FIELDS)[number], unknown> & { inputs: ExecJsonSnapshot; constraints: ExecJsonSnapshot };
      for (const f of NODE_FIELDS) out[f] = leaf(o[f]);
      out.inputs = execSnapshot(o.inputs);
      out.constraints = execSnapshot(o.constraints);
      return Object.freeze(out);
    });
    const edges = edgesRaw.map((e) => {
      if (typeof e !== "object" || e === null) return null;
      const o = e as Record<string, unknown>;
      return Object.freeze({ from: leaf(o.from), to: leaf(o.to) });
    });
    return Object.freeze({ requestId, reservationId, nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
  } catch {
    return null;
  }
}

/** A type-tagged, collision-free encoding of one snapshot value (absent, null and "null" all differ). */
function tag(v: unknown): unknown[] {
  if (v === undefined) return ["u"];
  if (v === null) return ["z"];
  if (typeof v === "string") return ["s", v];
  if (typeof v === "number") return ["n", Number.isFinite(v) ? v : String(v)];
  if (typeof v === "boolean") return ["b", v];
  if (typeof v === "bigint") return ["i", v.toString()];
  return ["x"];
}

/** Execution JSON's encoding: absent, `{}` and an invalid value all differ; JSON by its canonical form. */
function execTag(e: ExecJsonSnapshot): unknown[] {
  return e.kind === "absent" ? ["ea"] : e.kind === "json" ? ["ej", canonicalize(e.value)] : ["ex", e.reason];
}

/**
 * sha256 over a deterministic encoding of the submission AS EVALUATED (fields in a fixed order).
 * v2 added each node's execution JSON (N25).
 */
export function submissionDigest(snap: SubmissionSnapshot): `0x${string}` {
  const pre = JSON.stringify([
    "PCC:external-plan-submission:v2",
    tag(snap.requestId),
    tag(snap.reservationId),
    snap.nodes.map((n) => (n === null ? ["null-node"] : [...NODE_FIELDS.map((f) => tag(n[f])), execTag(n.inputs), execTag(n.constraints)])),
    snap.edges.map((e) => (e === null ? ["null-edge"] : [tag(e.from), tag(e.to)])),
  ]);
  return `0x${createHash("sha256").update(pre, "utf8").digest("hex")}`;
}

/** A reservation record as owned plain data, or why it cannot be used. */
type ReservationRead =
  | { ok: true; r: Record<keyof ReservationRecord, unknown> }
  | { ok: false; reason: "not-found" | "malformed-reservation" };

function readReservation(raw: unknown): ReservationRead {
  if (raw === null || raw === undefined) return { ok: false, reason: "not-found" };
  try {
    if (typeof raw !== "object") return { ok: false, reason: "malformed-reservation" };
    const o = raw as Record<string, unknown>;
    const r = {
      reservationId: leaf(o.reservationId),
      principal: leaf(o.principal),
      requestId: leaf(o.requestId),
      currency: leaf(o.currency),
      maxAmountBaseUnits: leaf(o.maxAmountBaseUnits),
      expiresAt: leaf(o.expiresAt),
      state: leaf(o.state),
      payer: leaf(o.payer),
      minTier: leaf(o.minTier),
    };
    const minTierOk = r.minTier === undefined || (typeof r.minTier === "number" && Number.isInteger(r.minTier) && r.minTier >= 0 && r.minTier <= 3);
    if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt) || !minTierOk) {
      return { ok: false, reason: "malformed-reservation" };
    }
    return { ok: true, r };
  } catch {
    return { ok: false, reason: "malformed-reservation" };
  }
}

/** The agreement's gross per node, copied once into owned data; each value must be a bigint. */
type UnitGrossRead =
  | { ok: true; gross: ReadonlyMap<string, bigint> }
  | { ok: false; reason: "agreement-refused"; code: string }
  | { ok: false; reason: "agreement-unreadable" };

function readUnitGross(raw: unknown): UnitGrossRead {
  try {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "agreement-unreadable" };
    const o = raw as Record<string, unknown>;
    const ok = o.ok;
    if (ok === false) {
      const code = leaf(o.code);
      return { ok: false, reason: "agreement-refused", code: typeof code === "string" ? code : "unknown" };
    }
    if (ok !== true) return { ok: false, reason: "agreement-unreadable" };
    const g: unknown = o.gross;
    if (typeof g !== "object" || g === null) return { ok: false, reason: "agreement-unreadable" };
    const keys = Object.keys(g);
    if (keys.length > MAX_SUBMISSION_NODES) return { ok: false, reason: "agreement-unreadable" };
    const gross = new Map<string, bigint>();
    for (const k of keys) {
      const v: unknown = (g as Record<string, unknown>)[k];
      if (typeof v === "bigint") gross.set(k, v); // anything else is simply not a gross for k
    }
    return { ok: true, gross };
  } catch {
    return { ok: false, reason: "agreement-unreadable" };
  }
}

// ── The seam ─────────────────────────────────────────────────────────────────────────────────────

export function acceptExternalPlan(sub: ExternalPlanSubmission, ctx: SeamContext, deps: SeamDeps): SeamResult {
  // Dependencies and policy, read once, before any input. They are server wiring: if they cannot be
  // read, or are not functions, that is a wiring fault reported as a TypeError — the only exception
  // the seam raises itself. Each is later called with `deps` as its receiver, so method-style
  // dependencies keep their `this`.
  let revalidation: unknown;
  let resolveProgramFn: unknown;
  let gateFn: unknown;
  let evidenceForFn: unknown;
  let loadReservationFn: unknown;
  let nowFnRaw: unknown;
  let feeBps: unknown;
  let feeRecipient: unknown;
  let reclaimAfterSec: unknown;
  let economicsRaw: unknown;
  let unitGrossFn: unknown;
  let econSplitFn: unknown;
  try {
    revalidation = deps.revalidation;
    resolveProgramFn = deps.resolveProgram;
    gateFn = deps.assertProgramForTier;
    evidenceForFn = deps.evidenceFor;
    loadReservationFn = deps.loadReservation;
    nowFnRaw = deps.now;
    const policy: unknown = deps.policy;
    const pol = (typeof policy === "object" && policy !== null ? policy : {}) as Record<string, unknown>;
    feeBps = leaf(pol.feeBps);
    feeRecipient = leaf(pol.feeRecipient);
    reclaimAfterSec = leaf(pol.reclaimAfterSec);
    economicsRaw = deps.economics;
    if (economicsRaw !== undefined && typeof economicsRaw === "object" && economicsRaw !== null) {
      unitGrossFn = (economicsRaw as Record<string, unknown>).unitGross;
      econSplitFn = (economicsRaw as Record<string, unknown>).splitNet;
    }
  } catch {
    throw new TypeError("acceptExternalPlan: SeamDeps could not be read (a wiring fault)");
  }
  const call = (fn: unknown, args: unknown[]): unknown => Reflect.apply(fn as (...a: unknown[]) => unknown, deps, args);
  const resolveProgram = resolveProgramFn;
  const assertProgramForTier = gateFn;
  const evidenceFor = evidenceForFn;
  const loadReservation = loadReservationFn;
  const nowFn = nowFnRaw;
  if (
    typeof revalidation !== "object" ||
    revalidation === null ||
    typeof resolveProgram !== "function" ||
    typeof assertProgramForTier !== "function" ||
    typeof evidenceFor !== "function" ||
    typeof loadReservation !== "function" ||
    typeof nowFn !== "function" ||
    typeof reclaimAfterSec !== "number" ||
    !Number.isSafeInteger(reclaimAfterSec) ||
    reclaimAfterSec < 0 ||
    (economicsRaw !== undefined && (typeof unitGrossFn !== "function" || typeof econSplitFn !== "function"))
  ) {
    throw new TypeError("acceptExternalPlan: malformed SeamDeps (functions, an integer reclaimAfterSec, and economics as { unitGross, splitNet } when present)");
  }

  // The submission, read once. Everything below uses only this copy.
  const snap = snapshotSubmission(sub);
  if (!snap || typeof snap.requestId !== "string" || typeof snap.reservationId !== "string") {
    return { ok: false, refusal: { stage: "submission", reason: "malformed-submission" } };
  }
  const requestId = snap.requestId;
  const reservationId = snap.reservationId;
  const submissionDigestValue = submissionDigest(snap);
  const refuse = (refusal: SeamRefusal, verdicts?: NodeVerdict[]): SeamResult => ({
    ok: false,
    refusal,
    submissionDigest: submissionDigestValue,
    ...(verdicts ? { verdicts } : {}),
  });

  // N25: execution JSON that is not bounded plain JSON is refused, naming EVERY bad field in a fixed
  // order. It is content, so this reveals nothing about any reservation.
  const badExec: ExecJsonProblem[] = [];
  for (const n of snap.nodes) {
    if (!n) continue;
    for (const field of ["inputs", "constraints"] as const) {
      const e = n[field];
      if (e.kind === "invalid") badExec.push({ nodeId: typeof n.nodeId === "string" ? n.nodeId : "", field, reason: e.reason });
    }
  }
  if (badExec.length > 0) {
    badExec.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    return refuse({ stage: "submission", reason: "invalid-execution-json", fields: badExec });
  }

  // Authority first. The id in the submission is only a lookup key; authority is the stored record
  // plus the authenticated principal, and an empty principal matches nothing.
  let principal: unknown;
  let tenantId: unknown;
  try {
    principal = leaf(ctx?.principal);
    tenantId = leaf(ctx?.tenantId ?? null);
  } catch {
    principal = undefined;
  }
  if (typeof principal !== "string" || principal.length === 0) {
    return refuse({ stage: "reservation", reason: "wrong-principal" });
  }
  const read = readReservation(call(loadReservation, [reservationId]));
  if (!read.ok) return refuse({ stage: "reservation", reason: read.reason });
  const resv = read.r;
  if (resv.principal !== principal) return refuse({ stage: "reservation", reason: "wrong-principal" });
  if (resv.requestId !== requestId) return refuse({ stage: "reservation", reason: "wrong-request" });
  if (resv.state !== "issued") return refuse({ stage: "reservation", reason: "not-issued" });
  // Whole seconds (a `Date.now() / 1000` clock must not make BigInt throw). A broken clock is a
  // server fault: throw rather than let NaN compare as "not expired".
  const now = Math.floor(call(nowFn, []) as number);
  if (!Number.isFinite(now)) throw new TypeError("acceptExternalPlan: deps.now() must return finite unix seconds");
  if ((resv.expiresAt as number) <= now) return refuse({ stage: "reservation", reason: "expired" });

  // R10 on the COPIED nodes. Anything but `current` everywhere is refused with the verdicts (a stale
  // verdict carries the re-quote the agent can re-submit against).
  const revalidated = revalidatePlanSnapshots(snap.nodes as unknown as SnapshotClaim[], revalidation as RevalidationDeps, {
    tenantId: (typeof tenantId === "string" ? tenantId : null) as string | null,
  });
  const verdicts = revalidated.verdicts;
  if (!revalidated.ok) {
    return refuse({ stage: "revalidation", verdicts: verdicts.filter((v) => v.status !== "current") }, verdicts);
  }
  const resolved = verdicts.map((v) => (v as Extract<NodeVerdict, { status: "current" }>).resolved);
  const claimed = new Map<string, unknown>();
  const execOf = new Map<string, SubmissionNodeSnapshot>();
  for (const n of snap.nodes) {
    if (n && typeof n.nodeId === "string") {
      claimed.set(n.nodeId, n.committedProgramHash);
      execOf.set(n.nodeId, n);
    }
  }
  const execValue = (e: ExecJsonSnapshot | undefined): PlanJsonObject | undefined => (e?.kind === "json" ? e.value : undefined);

  // R15 (economics, option b): with an agreement, each node's gross is the agreement's, and it must
  // cover the operator's live quote. The agreement's gross map is read once, before any node.
  let grossOf: ReadonlyMap<string, bigint> | null = null;
  if (economicsRaw !== undefined) {
    const read = readUnitGross(Reflect.apply(unitGrossFn as () => unknown, economicsRaw, []));
    if (!read.ok) {
      return refuse(read.reason === "agreement-refused" ? { stage: "economics", reason: read.reason, code: read.code } : { stage: "economics", reason: read.reason }, verdicts);
    }
    grossOf = read.gross;
  }

  const nodes = [];
  for (const r of resolved) {
    const quote = r.grossBaseUnits;
    let gross = quote;
    if (grossOf !== null) {
      const g = grossOf.get(r.nodeId);
      if (g === undefined) return refuse({ stage: "economics", nodeId: r.nodeId, reason: "unit-gross-missing" }, verdicts);
      if (g < quote) return refuse({ stage: "economics", nodeId: r.nodeId, reason: "quote-not-covered" }, verdicts);
      gross = g;
    }
    if (r.currency !== resv.currency) {
      return refuse({ stage: "currency", nodeId: r.nodeId, reason: "node-currency-differs-from-reservation" }, verdicts);
    }
    if (resv.minTier !== undefined && !(r.tier >= (resv.minTier as number))) {
      return refuse({ stage: "tier", nodeId: r.nodeId, reason: "below-reservation-minimum" }, verdicts);
    }
    // R11: the program is the server's for (csd, tier). A claimed one is only a cross-check.
    const resolvedProgram = r.tier === 0 ? null : leaf(call(resolveProgram, [r.csd, r.tierKey]));
    const program = typeof resolvedProgram === "string" ? resolvedProgram : null; // anything else fails closed below
    const claim = claimed.get(r.nodeId);
    if (claim !== undefined) {
      if (claim !== null && typeof claim !== "string") return refuse({ stage: "submission", reason: "malformed-submission" }, verdicts);
      if ((claim === null ? null : claim.toLowerCase()) !== (program === null ? null : program.toLowerCase())) {
        return refuse({ stage: "program", nodeId: r.nodeId, reason: "claimed-program-mismatch" }, verdicts);
      }
    }
    const evidence = call(evidenceFor, [r.csd, r.tierKey]) as EvidenceRequirement[] | null;
    if (!evidence) return refuse({ stage: "evidence", nodeId: r.nodeId, reason: "no-evidence-contract-for-tier" }, verdicts);
    nodes.push({
      nodeId: r.nodeId,
      capabilityId: r.capabilityId,
      capabilityType: r.capabilityType,
      csd: r.csd,
      tierKey: r.tierKey,
      operator: r.operator,
      payoutAddress: r.payoutAddress,
      grossBaseUnits: gross,
      ...(grossOf !== null ? { quoteBaseUnits: quote } : {}),
      matchedCapabilityDigest: r.matchedCapabilityDigest,
      committedProgramHash: program, // null here at a non-zero tier is refused by the compiler
      evidenceRequirements: evidence, // the compiler copies it once into owned data
      // N25: the node's own execution JSON, already an owned copy (absent means {}).
      inputs: execValue(execOf.get(r.nodeId)?.inputs),
      constraints: execValue(execOf.get(r.nodeId)?.constraints),
    });
  }

  // R12: the deterministic compile, on owned values only. The compiler re-checks the reservation's
  // request, currency and ceiling, gates every non-zero tier through evidence's program check, and
  // seals the whole deal.
  const compiled = compileAcceptedPlan(
    {
      planId: planIdForReservation(reservationId),
      requestId,
      payer: resv.payer as Address,
      currency: resv.currency as string,
      feeBps: feeBps as number,
      feeRecipient: feeRecipient as Address,
      reclaimAt: BigInt(now) + BigInt(reclaimAfterSec),
      nodes,
      edges: snap.edges.map((e) => ({ from: e?.from as string, to: e?.to as string })),
      reservation: {
        reservationId: resv.reservationId as string,
        requestId: resv.requestId as string,
        currency: resv.currency as string,
        maxAmountBaseUnits: resv.maxAmountBaseUnits as bigint,
      },
    },
    {
      assertProgramForTier: (a) => call(assertProgramForTier, [a]) as ReturnType<ProgramGate>,
      // Called with the economics binding as its receiver, like every other dependency.
      ...(economicsRaw !== undefined
        ? { splitNet: (units: Parameters<NetSplitter>[0]) => Reflect.apply(econSplitFn as NetSplitter, economicsRaw, [units]) as ReturnType<NetSplitter> }
        : {}),
    },
  );
  if (!compiled.ok) return refuse({ stage: "compile", violations: compiled.violations }, verdicts);
  return { ok: true, plan: compiled.plan, resolved, verdicts, submissionDigest: submissionDigestValue };
}
