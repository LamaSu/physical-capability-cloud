/**
 * PlanPresentation (product pack section 5, item 1): the typed read model a UI or an agent renders for
 * a caller-authored plan. It is built ONLY from server truth: the submission as proposed, R10's
 * verdicts, the seam's refusal or compiled deal, and the reservation store's seal record. It is
 * separate from the settlement encoding — nothing here is hashed, signed or funded — and it offers no
 * way to accept a plan (item 7): acceptance is the seam plus the reservation consume, server-side.
 *
 * Authority is assigned HERE, by the server, never taken from content (product invariant 2 and the
 * five-layer rule). `layer` is "B" (accepted deal) only when ALL of these hold; otherwise it is "C":
 *  - the outcome belongs to THIS submission: its `submissionDigest` equals the digest of the submission
 *    being displayed (so a genuine sealed outcome cannot be paired with a different submission);
 *  - the compiled plan is intact: `acceptedDealDigest` is re-derived from an owned copy of the plan and
 *    must equal the one it carries, and the plan is bound to the submission's request, reservation
 *    and plan id, and to exactly its node set;
 *  - the seal record names this reservation and exactly this deal digest.
 *
 * Every input is read ONCE into owned, validated data (the review pattern of #351/#355/#356). A
 * malformed input never throws: the presentation is `state: "invalid"` with a reason, Layer C, and
 * shows no nodes, money or deal — it never mixes data from inputs that do not agree.
 *
 * Node identity is the caller's node id, carried unchanged through every state (item 2):
 * proposed -> current | stale (diffs + the live re-quote) | refused -> compiled -> sealed, and into
 * the execution unit (job, milestone, stepId).
 */

import {
  acceptedDealDigest,
  copyPlanJson,
  type CanonicalPlan,
  type CompiledAcceptedPlan,
  type CompiledJob,
  type NodeUnitBinding,
  type PayoutEntry,
  type PlanJsonObject,
  type UnitConfigInput,
} from "@pcc/spec";
import { planIdForReservation, snapshotSubmission, submissionDigest, type ExternalPlanSubmission, type SeamResult, type SubmissionSnapshot } from "./external-plan-seam.js";
import type { SnapshotField } from "./plan-snapshot-revalidation.js";

export type PlanState = "proposed" | "needs-requote" | "refused" | "compiled" | "sealed" | "invalid";

export type PlanNodeState =
  | "proposed"
  | "current"
  | "stale"
  | "missing"
  | "unavailable"
  | "unpriceable"
  | "incompatible"
  | "invalid-claim"
  | "compiled"
  | "sealed";

export type InvalidReason =
  | "malformed-input"
  | "malformed-submission"
  | "submission-mismatch"
  | "malformed-outcome"
  | "plan-integrity"
  | "plan-binding";

/** Money as exact base units, rendered as strings (never a float) with the token's decimals. */
export interface Money {
  baseUnits: string;
  currency: string;
  decimals: number;
}

/** The server's live terms for a node, as displayed. */
export interface LiveView {
  capabilityType: string;
  kernelId: string;
  kernelStatus: string;
  csd: string;
  operator: string;
  priceDecimal: string;
  currency: string;
  assuranceTiers: number[];
  matchedCapabilityDigest: string;
}

export interface DiffView {
  field: SnapshotField;
  claimed: string;
  live: string;
}

export interface PlanNodePresentation {
  nodeId: string;
  capabilityId: string;
  state: PlanNodeState;
  /** What the caller proposed (Layer C, the caller's belief). */
  proposed: { price: string; currency: string; tierKey: string; kernelId: string; operator: string };
  /** The server's live terms, when R10 re-read them. */
  live?: LiveView;
  /** What changed between the proposal and the live row (item 5). */
  diffs?: DiffView[];
  /** Why the node cannot be accepted, for missing/unavailable/unpriceable/incompatible/invalid-claim. */
  reason?: string;
  /** The execution unit this node became, once compiled (item 2's last step). */
  unit?: { jobId: string; milestoneIndex: number; stepId: string; stepIdBytes32: string; tier: number; committedProgramHash: string | null };
  /** The unit's money, once compiled. */
  money?: { gross: Money; fee: Money; net: Money; payouts: Array<{ recipient: string; amount: Money }> };
  /**
   * What the unit runs ON, once compiled (N25): the node's execution inputs and constraints as the deal
   * seals them, and the planHash VCR recomputes. From the intact, bound plan, never the proposal.
   */
  execution?: { planHash: string; inputs: PlanJsonObject; constraints: PlanJsonObject };
}

export interface PlanPresentation {
  schema: "pcc.plan-presentation.v1";
  /** "B" only for an intact plan, bound to this submission, whose digest the store sealed; else "C". */
  layer: "B" | "C";
  state: PlanState;
  /** Present only when `state` is "invalid": nothing else is shown then. */
  invalid?: { reason: InvalidReason };
  requestId: string | null;
  reservationId: string | null;
  planId?: string;
  /** Server time of the evaluation: the quote timestamp for every `live` block (item 4). */
  asOf: string;
  nodes: PlanNodePresentation[];
  edges: Array<{ from: string; to: string }>;
  /** Totals and obligations of the compiled deal (item 6); absent before compilation. */
  preview?: {
    gross: Money;
    fee: Money;
    net: Money;
    payoutsByRecipient: Array<{ recipient: string; amount: Money }>;
    tierByNode: Array<{ nodeId: string; tier: number }>;
    reclaimAt: string;
  };
  /** The compiled deal's commitments (item 8): immutable once sealed. */
  deal?: {
    acceptedDealDigest: string;
    compositionRoot: string;
    capabilityContractRoot: string;
    agreementHash: string | null;
    economicTermsHash: string | null;
    rightsTermsHash: string | null;
    sealed: boolean;
  };
  /** Why the seam refused, normalized (never the caller's own structure). */
  refusal?: { stage: string; reason?: string; nodeId?: string; codes?: string[] };
}

/** What the reservation store holds after the atomic consume (R13). */
export interface SealRecord {
  reservationId: string;
  acceptedDealDigest: string;
}

export interface PresentPlanArgs {
  submission: ExternalPlanSubmission;
  /** The seam's answer for THIS submission, once evaluated. */
  outcome?: SeamResult;
  /** The store's seal record for the submission's reservation, if the consume has happened (R13). */
  sealed?: SealRecord | null;
  /** Server time of the evaluation, ISO 8601. */
  asOf: string;
}

// ── Read-once validation. Any failure below throws inside `presentPlan`'s single catch, which does
//    not inspect what was thrown and returns an "invalid" presentation. ──────────────────────────

function fail(): never {
  throw new Error("invalid");
}
function need(ok: boolean): void {
  if (!ok) fail();
}
function obj(x: unknown): Record<string, unknown> {
  need(typeof x === "object" && x !== null);
  return x as Record<string, unknown>;
}
function isStr(x: unknown): x is string {
  return typeof x === "string";
}
function isBig(x: unknown): x is bigint {
  return typeof x === "bigint";
}
function isInt(x: unknown, lo: number, hi: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
}
function str(x: unknown): string {
  need(isStr(x));
  return x as string;
}
function strOrNull(x: unknown): string | null {
  need(x === null || isStr(x));
  return x as string | null;
}
/** A list's items, its length read once and bounded, each item read once. */
function listOf<T>(x: unknown, max: number, item: (v: unknown) => T): T[] {
  need(Array.isArray(x));
  const n: unknown = (x as unknown[]).length;
  need(isInt(n, 0, max));
  const out: T[] = [];
  for (let i = 0; i < (n as number); i++) out.push(item((x as unknown[])[i]));
  return out;
}

const VERDICT_STATUSES = new Set(["current", "stale", "missing", "unavailable", "unpriceable", "incompatible", "invalid-claim"]);
const DIFF_FIELDS = new Set(["capabilityType", "csd", "currency", "kernelId", "matchedCapabilityDigest", "operator", "price", "tier"]);
const REFUSAL_STAGES = new Set(["submission", "reservation", "revalidation", "currency", "tier", "program", "evidence", "compile"]);

function readLive(x: unknown): LiveView {
  const o = obj(x);
  return {
    capabilityType: str(o.capabilityType),
    kernelId: str(o.kernelId),
    kernelStatus: str(o.kernelStatus),
    csd: str(o.csd),
    operator: str(o.operator),
    priceDecimal: str(o.priceDecimal),
    currency: str(o.currency),
    assuranceTiers: listOf(o.assuranceTiers, 4, (t) => {
      need(isInt(t, 0, 3));
      return t as number;
    }),
    matchedCapabilityDigest: str(o.matchedCapabilityDigest),
  };
}

type VerdictView =
  | { nodeId: string; status: "current"; live: LiveView }
  | { nodeId: string; status: "stale"; live: LiveView; diffs: DiffView[] }
  | { nodeId: string; status: Exclude<PlanNodeState, "proposed" | "current" | "stale" | "compiled" | "sealed">; reason: string };

function readVerdict(x: unknown): VerdictView {
  const o = obj(x);
  const nodeId = str(o.nodeId);
  const status = str(o.status);
  need(VERDICT_STATUSES.has(status)); // a forged status such as "sealed" is refused
  if (status === "current") return { nodeId, status, live: readLive(o.resolved) };
  if (status === "stale") {
    return {
      nodeId,
      status,
      live: readLive(o.live),
      diffs: listOf(o.diffs, 16, (d) => {
        const r = obj(d);
        const field = str(r.field);
        need(DIFF_FIELDS.has(field));
        return { field: field as SnapshotField, claimed: str(r.claimed), live: str(r.live) };
      }),
    };
  }
  return { nodeId, status: status as Exclude<VerdictView["status"], "current" | "stale">, reason: str(o.reason) };
}

function readPayout(x: unknown): PayoutEntry {
  const o = obj(x);
  const recipient = str(o.recipient);
  const amount = o.amount;
  need(isBig(amount));
  return { recipient: recipient as PayoutEntry["recipient"], amount: amount as bigint };
}

function readUnit(x: unknown): UnitConfigInput {
  const o = obj(x);
  const u = {
    milestoneIndex: o.milestoneIndex,
    stepId: o.stepId,
    requiredTier: o.requiredTier,
    requestedTier: o.requestedTier,
    g: o.g,
    f: o.f,
    n: o.n,
    feeBps: o.feeBps,
    feeRecipient: o.feeRecipient,
    reclaimAt: o.reclaimAt,
    compositionSchemaVersion: o.compositionSchemaVersion,
    compositionRoot: o.compositionRoot,
    payouts: listOf(o.payouts, 16, readPayout),
  };
  need(
    isBig(u.milestoneIndex) && isStr(u.stepId) && isInt(u.requiredTier, 0, 3) && isInt(u.requestedTier, 0, 3) &&
      isBig(u.g) && isBig(u.f) && isBig(u.n) && isInt(u.feeBps, 0, 10_000) && isStr(u.feeRecipient) &&
      isBig(u.reclaimAt) && isInt(u.compositionSchemaVersion, 0, 65_535) && isStr(u.compositionRoot),
  );
  return u as UnitConfigInput;
}

function readJob(x: unknown): CompiledJob {
  const o = obj(x);
  const job = {
    jobId: str(o.jobId),
    operator: str(o.operator),
    payer: str(o.payer),
    units: listOf(o.units, 16, readUnit),
    nodeIds: listOf(o.nodeIds, 16, str),
  };
  need(job.units.length === job.nodeIds.length && job.units.length > 0);
  return job as CompiledJob;
}

/** Execution JSON (N25), copied once as bounded plain JSON; anything else is invalid. */
function planJson(x: unknown): PlanJsonObject {
  const c = copyPlanJson(x);
  need(c.ok);
  return (c as { ok: true; value: PlanJsonObject }).value;
}

/** An owned copy of a node's canonicalPlan, field by field (its hash is re-derived in the digest). */
function readCanonicalPlan(x: unknown): CanonicalPlan {
  const o = obj(x);
  const cap = obj(o.capability);
  const amount = obj(o.amount);
  const job = obj(o.job);
  const assurance = obj(o.assurance);
  const cp = {
    schema: str(o.schema),
    planId: str(o.planId),
    planNodeId: str(o.planNodeId),
    capability: { type: str(cap.type), id: str(cap.id), csd: str(cap.csd), matchedCapabilityDigest: str(cap.matchedCapabilityDigest) },
    operator: str(o.operator),
    payTo: str(o.payTo),
    amount: { baseUnits: str(amount.baseUnits), currency: str(amount.currency), decimals: amount.decimals },
    job: { jobId: str(job.jobId), milestoneIndex: job.milestoneIndex, stepId: str(job.stepId) },
    assurance: {
      tier: assurance.tier,
      tierKey: str(assurance.tierKey),
      committedProgramHash: strOrNull(assurance.committedProgramHash),
      evidence: listOf(assurance.evidence, 64, (r) => {
        const e = obj(r);
        const out = { requirementId: str(e.requirementId), evidenceTypeId: str(e.evidenceTypeId), tier: e.tier };
        need(isInt(out.tier, 0, 3));
        return out;
      }),
    },
    inputs: planJson(o.inputs),
    constraints: planJson(o.constraints),
  };
  need(isInt(cp.amount.decimals, 0, 18) && isInt(cp.job.milestoneIndex, 0, 15) && isInt(cp.assurance.tier, 0, 3));
  return cp as CanonicalPlan;
}

function readBinding(x: unknown): NodeUnitBinding {
  const o = obj(x);
  const b = {
    nodeId: str(o.nodeId),
    jobIndex: o.jobIndex,
    jobId: str(o.jobId),
    operator: str(o.operator),
    milestoneIndex: o.milestoneIndex,
    stepId: str(o.stepId),
    stepIdBytes32: str(o.stepIdBytes32),
    tier: o.tier,
    committedProgramHash: strOrNull(o.committedProgramHash),
    canonicalPlan: readCanonicalPlan(o.canonicalPlan),
    planHash: str(o.planHash),
  };
  need(isInt(b.jobIndex, 0, 1023) && isInt(b.milestoneIndex, 0, 15) && isInt(b.tier, 0, 3));
  return b as NodeUnitBinding;
}

/** An owned copy of the WHOLE compiled plan: every field the deal digest commits to. */
function readPlan(x: unknown): CompiledAcceptedPlan {
  const o = obj(x);
  const p = {
    planId: str(o.planId),
    requestId: str(o.requestId),
    reservationId: str(o.reservationId),
    currency: str(o.currency),
    currencyDecimals: o.currencyDecimals,
    acceptedDealDigest: str(o.acceptedDealDigest),
    totalObligationBaseUnits: o.totalObligationBaseUnits,
    compositionRoot: str(o.compositionRoot),
    capabilityContractRoot: str(o.capabilityContractRoot),
    agreementHash: strOrNull(o.agreementHash),
    economicTermsHash: strOrNull(o.economicTermsHash),
    rightsTermsHash: strOrNull(o.rightsTermsHash),
    jobs: listOf(o.jobs, 1024, readJob),
    nodeToUnit: listOf(o.nodeToUnit, 1024, readBinding),
  };
  need(isInt(p.currencyDecimals, 0, 18) && isBig(p.totalObligationBaseUnits) && p.jobs.length > 0);
  return p as CompiledAcceptedPlan;
}

type RefusalView = NonNullable<PlanPresentation["refusal"]> & { verdicts?: VerdictView[] };

function readRefusal(x: unknown): RefusalView {
  const o = obj(x);
  const stage = str(o.stage);
  need(REFUSAL_STAGES.has(stage));
  const out: RefusalView = { stage };
  if (stage === "revalidation") out.verdicts = listOf(o.verdicts, 1024, readVerdict);
  else if (stage === "compile") out.codes = listOf(o.violations, 4096, (v) => str(obj(v).code));
  else {
    out.reason = str(o.reason);
    if (o.nodeId !== undefined) out.nodeId = str(o.nodeId);
    // N25: each refused execution-JSON field, as "<field>:<reason>@<nodeId>".
    if (stage === "submission" && out.reason === "invalid-execution-json") {
      out.codes = listOf(o.fields, 2048, (f) => {
        const e = obj(f);
        return `${str(e.field)}:${str(e.reason)}@${str(e.nodeId)}`;
      });
    }
  }
  return out;
}

type OutcomeView =
  | { ok: true; plan: CompiledAcceptedPlan; verdicts: VerdictView[]; submissionDigest: string }
  | { ok: false; refusal: RefusalView; verdicts?: VerdictView[]; submissionDigest: string };

function readOutcome(x: unknown): OutcomeView {
  const o = obj(x);
  const ok = o.ok;
  need(ok === true || ok === false);
  const digest = str(o.submissionDigest);
  const verdictsRaw = o.verdicts;
  const verdicts = verdictsRaw === undefined ? undefined : listOf(verdictsRaw, 1024, readVerdict);
  if (ok === true) {
    const plan = readPlan(o.plan);
    need(verdicts !== undefined);
    return { ok: true, plan, verdicts: verdicts!, submissionDigest: digest };
  }
  return { ok: false, refusal: readRefusal(o.refusal), ...(verdicts ? { verdicts } : {}), submissionDigest: digest };
}

/** The plan must be intact and bound to this submission; each binding must name its own unit. */
function planIsIntact(plan: CompiledAcceptedPlan): boolean {
  const { acceptedDealDigest: carried, ...rest } = plan;
  return acceptedDealDigest(rest).toLowerCase() === carried.toLowerCase();
}

function planIsBound(plan: CompiledAcceptedPlan, snap: SubmissionSnapshot, nodeIds: string[]): boolean {
  if (plan.requestId !== snap.requestId || plan.reservationId !== snap.reservationId) return false;
  if (plan.planId !== planIdForReservation(snap.reservationId as string)) return false;
  const bound = plan.nodeToUnit.map((b) => b.nodeId);
  if (new Set(bound).size !== bound.length || bound.length !== nodeIds.length) return false;
  if (!nodeIds.every((id) => bound.includes(id))) return false;
  // Every binding names exactly the unit that carries its node, so identity and money cannot mix.
  return plan.nodeToUnit.every((b) => {
    const job = plan.jobs[b.jobIndex];
    const cp = b.canonicalPlan;
    return (
      job !== undefined &&
      job.jobId === b.jobId &&
      job.nodeIds[b.milestoneIndex] === b.nodeId &&
      job.units[b.milestoneIndex] !== undefined &&
      // N25: the node's execution contract names this plan, this node and this unit.
      cp.planId === plan.planId &&
      cp.planNodeId === b.nodeId &&
      cp.job.jobId === b.jobId &&
      cp.job.milestoneIndex === b.milestoneIndex
    );
  });
}

function money(amount: bigint, plan: CompiledAcceptedPlan): Money {
  return { baseUnits: amount.toString(), currency: plan.currency, decimals: plan.currencyDecimals };
}

/** A display string for a proposal field (a primitive from the submission snapshot). */
function shown(x: unknown): string {
  return typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" || typeof x === "bigint" ? String(x) : `<${x === null ? "null" : typeof x}>`;
}

/** Build the read model. Pure and total: the same arguments always give the same presentation, and it never throws. */
export function presentPlan(args: PresentPlanArgs): PlanPresentation {
  let snap: SubmissionSnapshot | null = null;
  let asOf = "";
  try {
    const a = obj(args);
    const submissionRaw = a.submission;
    const outcomeRaw = a.outcome;
    const sealedRaw = a.sealed;
    asOf = str(a.asOf);
    snap = snapshotSubmission(submissionRaw);
    if (!snap || !isStr(snap.requestId) || !isStr(snap.reservationId)) return invalid("malformed-submission", asOf, snap);

    const nodes = snap.nodes.filter((n): n is NonNullable<typeof n> => n !== null && isStr(n.nodeId));
    const nodeIds = nodes.map((n) => n.nodeId as string);
    const outcome = outcomeRaw === undefined ? undefined : readOutcome(outcomeRaw);
    if (outcome && outcome.submissionDigest !== submissionDigest(snap)) return invalid("submission-mismatch", asOf, snap);

    const plan = outcome?.ok ? outcome.plan : undefined;
    if (plan && !planIsIntact(plan)) return invalid("plan-integrity", asOf, snap);
    if (plan && !planIsBound(plan, snap, nodeIds)) return invalid("plan-binding", asOf, snap);
    const verdictList = outcome ? (outcome.ok ? outcome.verdicts : outcome.verdicts ?? outcome.refusal.verdicts ?? []) : [];
    if (!verdictList.every((v) => nodeIds.includes(v.nodeId))) return invalid("malformed-outcome", asOf, snap);
    if (plan && !(verdictList.length === nodeIds.length && verdictList.every((v) => v.status === "current"))) {
      return invalid("malformed-outcome", asOf, snap);
    }
    // All units of one compiled deal share one reclaim time; a plan where they differ is not intact.
    const reclaims = plan ? [...new Set(plan.jobs.flatMap((j) => j.units.map((u) => u.reclaimAt.toString())))] : [];
    if (plan && reclaims.length !== 1) return invalid("plan-integrity", asOf, snap);

    let sealed = false;
    if (plan && sealedRaw !== undefined && sealedRaw !== null) {
      const s = obj(sealedRaw);
      const sealedReservation = str(s.reservationId);
      const sealedDigest = str(s.acceptedDealDigest);
      sealed = sealedReservation === snap.reservationId && sealedDigest.toLowerCase() === plan.acceptedDealDigest.toLowerCase();
    }

    let state: PlanState;
    if (!outcome) state = "proposed";
    else if (outcome.ok) state = sealed ? "sealed" : "compiled";
    else if (outcome.refusal.stage === "revalidation" && (outcome.refusal.verdicts ?? []).length > 0 && outcome.refusal.verdicts!.every((v) => v.status === "stale")) {
      state = "needs-requote";
    } else state = "refused";

    const verdictOf = new Map(verdictList.map((v) => [v.nodeId, v]));
    const bindingOf = new Map((plan?.nodeToUnit ?? []).map((b) => [b.nodeId, b]));
    const presented: PlanNodePresentation[] = nodes
      .map((n) => {
        const id = n.nodeId as string;
        const out: PlanNodePresentation = {
          nodeId: id,
          capabilityId: shown(n.capabilityId),
          state: "proposed",
          proposed: { price: shown(n.price), currency: shown(n.currency), tierKey: shown(n.tierKey), kernelId: shown(n.kernelId), operator: shown(n.operator) },
        };
        const v = verdictOf.get(id);
        if (v) {
          out.state = v.status;
          if (v.status === "current") out.live = v.live;
          else if (v.status === "stale") {
            out.live = v.live;
            out.diffs = v.diffs;
          } else out.reason = v.reason;
        }
        const b = bindingOf.get(id);
        if (plan && b) {
          const u = plan.jobs[b.jobIndex]!.units[b.milestoneIndex]!;
          out.state = sealed ? "sealed" : "compiled";
          out.unit = { jobId: b.jobId, milestoneIndex: b.milestoneIndex, stepId: b.stepId, stepIdBytes32: b.stepIdBytes32, tier: b.tier, committedProgramHash: b.committedProgramHash };
          out.money = {
            gross: money(u.g, plan),
            fee: money(u.f, plan),
            net: money(u.n, plan),
            payouts: u.payouts.map((p) => ({ recipient: p.recipient, amount: money(p.amount, plan) })),
          };
          out.execution = { planHash: b.planHash, inputs: b.canonicalPlan.inputs, constraints: b.canonicalPlan.constraints };
        }
        return out;
      })
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

    const presentation: PlanPresentation = {
      schema: "pcc.plan-presentation.v1",
      layer: sealed ? "B" : "C",
      state,
      requestId: snap.requestId,
      reservationId: snap.reservationId,
      asOf,
      nodes: presented,
      edges: snap.edges
        .filter((e): e is NonNullable<typeof e> => e !== null && isStr(e.from) && isStr(e.to))
        .map((e) => ({ from: e.from as string, to: e.to as string })),
    };
    if (outcome && !outcome.ok) {
      const { verdicts: _v, ...refusal } = outcome.refusal;
      presentation.refusal = refusal;
    }
    if (plan) {
      presentation.planId = plan.planId;
      let gross = 0n;
      let fee = 0n;
      let net = 0n;
      const byRecipient = new Map<string, bigint>();
      for (const j of plan.jobs) {
        for (const u of j.units) {
          gross += u.g;
          fee += u.f;
          net += u.n;
          for (const p of u.payouts) {
            const k = p.recipient.toLowerCase();
            byRecipient.set(k, (byRecipient.get(k) ?? 0n) + p.amount);
          }
        }
      }
      presentation.preview = {
        gross: money(gross, plan),
        fee: money(fee, plan),
        net: money(net, plan),
        payoutsByRecipient: [...byRecipient.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([recipient, amount]) => ({ recipient, amount: money(amount, plan) })),
        tierByNode: plan.nodeToUnit.map((b) => ({ nodeId: b.nodeId, tier: b.tier })).sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
        reclaimAt: reclaims[0]!,
      };
      presentation.deal = {
        acceptedDealDigest: plan.acceptedDealDigest,
        compositionRoot: plan.compositionRoot,
        capabilityContractRoot: plan.capabilityContractRoot,
        agreementHash: plan.agreementHash,
        economicTermsHash: plan.economicTermsHash,
        rightsTermsHash: plan.rightsTermsHash,
        sealed,
      };
    }
    return presentation;
  } catch {
    return invalid(snap ? "malformed-outcome" : "malformed-input", asOf, snap);
  }
}

function invalid(reason: InvalidReason, asOf: string, snap: SubmissionSnapshot | null): PlanPresentation {
  return {
    schema: "pcc.plan-presentation.v1",
    layer: "C",
    state: "invalid",
    invalid: { reason },
    requestId: snap && isStr(snap.requestId) ? snap.requestId : null,
    reservationId: snap && isStr(snap.reservationId) ? snap.reservationId : null,
    asOf,
    nodes: [],
    edges: [],
  };
}
