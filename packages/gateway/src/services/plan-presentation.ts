/**
 * PlanPresentation (product pack section 5, item 1): the typed read model a UI or an agent renders for
 * a caller-authored plan. It is built ONLY from server truth: the submission as proposed, R10's
 * verdicts, the seam's refusal or compiled deal, and the reservation store's seal. It is separate from
 * the settlement encoding — nothing here is hashed, signed or funded — and it offers no way to accept
 * a plan (item 7): acceptance is the seam plus the reservation consume, server-side.
 *
 * Authority is assigned HERE, by the server, never taken from content (product invariant 2 and the
 * five-layer rule). `layer` is "B" (accepted deal) only when the reservation store has sealed exactly
 * this plan's `acceptedDealDigest`. Everything else — proposed, re-quote needed, refused, compiled but
 * not yet sealed — is "C". No field a caller supplies can raise it.
 *
 * Node identity is the caller's node id, carried unchanged through every state (item 2):
 * proposed -> current | stale (with diffs and the live re-quote) | refused -> compiled -> sealed, and
 * into the execution unit (job, milestone, step id).
 */

import type { CompiledAcceptedPlan } from "@pcc/spec";
import type { ExternalPlanSubmission, SeamRefusal, SeamResult } from "./external-plan-seam.js";
import type { FieldDiff, LiveTerms, NodeVerdict } from "./plan-snapshot-revalidation.js";

export type PlanState = "proposed" | "needs-requote" | "refused" | "compiled" | "sealed";

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

/** Money as exact base units, rendered as strings (never a float) with the token's decimals. */
export interface Money {
  baseUnits: string;
  currency: string;
  decimals: number;
}

export interface PlanNodePresentation {
  nodeId: string;
  capabilityId: string;
  state: PlanNodeState;
  /** What the caller proposed (Layer C, the caller's belief). */
  proposed: { price: string; currency: string; tierKey: string; kernelId: string; operator: string };
  /** The server's live terms, when R10 re-read them. */
  live?: Pick<
    LiveTerms,
    "capabilityType" | "kernelId" | "kernelStatus" | "csd" | "operator" | "priceDecimal" | "currency" | "assuranceTiers" | "matchedCapabilityDigest"
  >;
  /** What changed between the proposal and the live row (item 5). */
  diffs?: FieldDiff[];
  /** Why the node cannot be accepted, for missing/unavailable/unpriceable/incompatible/invalid-claim. */
  reason?: string;
  /** The execution unit this node became, once compiled (item 2's last step). */
  unit?: { jobId: string; milestoneIndex: number; stepId: string; stepIdBytes32: string; tier: number; committedProgramHash: string | null };
  /** The unit's money, once compiled. */
  money?: { gross: Money; fee: Money; net: Money; payouts: Array<{ recipient: string; amount: Money }> };
}

export interface PlanPresentation {
  schema: "pcc.plan-presentation.v1";
  /** "B" only for a plan whose deal digest the reservation store sealed; "C" otherwise. Server-assigned. */
  layer: "B" | "C";
  state: PlanState;
  requestId: string;
  reservationId: string;
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
    economicTermsHash: string | null;
    rightsTermsHash: string | null;
    sealed: boolean;
  };
  refusal?: SeamRefusal;
}

export interface PresentPlanArgs {
  submission: ExternalPlanSubmission;
  /** The seam's answer, once the plan has been evaluated. */
  outcome?: SeamResult;
  /** The digest the reservation store sealed for this reservation, if any (R13). */
  sealedDigest?: string | null;
  /** Server time of the evaluation, ISO 8601. */
  asOf: string;
}

/** A display string for a caller-supplied value. Never throws, even on a value with no string form. */
function show(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return String(x);
  } catch {
    return `<${typeof x}>`;
  }
}

function money(amount: bigint, plan: CompiledAcceptedPlan): Money {
  return { baseUnits: amount.toString(), currency: plan.currency, decimals: plan.currencyDecimals };
}

function nodeStateOf(v: NodeVerdict): PlanNodeState {
  return v.status;
}

function liveOf(t: LiveTerms): NonNullable<PlanNodePresentation["live"]> {
  return {
    capabilityType: t.capabilityType,
    kernelId: t.kernelId,
    kernelStatus: t.kernelStatus,
    csd: t.csd,
    operator: t.operator,
    priceDecimal: t.priceDecimal,
    currency: t.currency,
    assuranceTiers: [...t.assuranceTiers],
    matchedCapabilityDigest: t.matchedCapabilityDigest,
  };
}

/** Build the read model. Pure: the same arguments always give the same presentation. */
export function presentPlan(args: PresentPlanArgs): PlanPresentation {
  const { submission, outcome } = args;
  const verdicts = new Map<string, NodeVerdict>((outcome?.verdicts ?? []).map((v) => [v.nodeId, v]));
  const plan = outcome?.ok ? outcome.plan : undefined;
  const sealed =
    plan !== undefined &&
    typeof args.sealedDigest === "string" &&
    args.sealedDigest.toLowerCase() === plan.acceptedDealDigest.toLowerCase();

  let state: PlanState;
  if (!outcome) state = "proposed";
  else if (outcome.ok) state = sealed ? "sealed" : "compiled";
  else if (outcome.refusal.stage === "revalidation" && outcome.refusal.verdicts.every((v) => v.status === "stale")) state = "needs-requote";
  else state = "refused";

  const unitOf = new Map((plan?.nodeToUnit ?? []).map((b) => [b.nodeId, b]));
  const unitConfigOf = new Map(
    (plan?.jobs ?? []).flatMap((j) => j.units.map((u, i) => [j.nodeIds[i]!, u] as const)),
  );

  const nodes: PlanNodePresentation[] = (Array.isArray(submission?.nodes) ? submission.nodes : [])
    .filter((n) => n && typeof n.nodeId === "string")
    .map((n) => {
      const out: PlanNodePresentation = {
        nodeId: n.nodeId,
        capabilityId: show(n.capabilityId),
        state: "proposed",
        proposed: { price: show(n.price), currency: show(n.currency), tierKey: show(n.tierKey), kernelId: show(n.kernelId), operator: show(n.operator) },
      };
      const v = verdicts.get(n.nodeId);
      if (v) {
        out.state = nodeStateOf(v);
        if (v.status === "current") out.live = liveOf(v.resolved);
        else if (v.status === "stale") {
          out.live = liveOf(v.live);
          out.diffs = v.diffs.map((d) => ({ ...d }));
        } else out.reason = v.reason;
      }
      const b = unitOf.get(n.nodeId);
      const u = unitConfigOf.get(n.nodeId);
      if (plan && b && u) {
        out.state = sealed ? "sealed" : "compiled";
        out.unit = {
          jobId: b.jobId,
          milestoneIndex: b.milestoneIndex,
          stepId: b.stepId,
          stepIdBytes32: b.stepIdBytes32,
          tier: b.tier,
          committedProgramHash: b.committedProgramHash,
        };
        out.money = {
          gross: money(u.g, plan),
          fee: money(u.f, plan),
          net: money(u.n, plan),
          payouts: u.payouts.map((p) => ({ recipient: p.recipient, amount: money(p.amount, plan) })),
        };
      }
      return out;
    })
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

  const presentation: PlanPresentation = {
    schema: "pcc.plan-presentation.v1",
    layer: sealed ? "B" : "C",
    state,
    requestId: show(submission?.requestId),
    reservationId: show(submission?.reservationId),
    asOf: args.asOf,
    nodes,
    edges: (Array.isArray(submission?.edges) ? submission.edges : [])
      .filter((e) => e && typeof e.from === "string" && typeof e.to === "string")
      .map((e) => ({ from: e.from, to: e.to })),
  };
  if (outcome && !outcome.ok) presentation.refusal = outcome.refusal;
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
      tierByNode: plan.nodeToUnit.map((b) => ({ nodeId: b.nodeId, tier: b.tier })).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
      reclaimAt: (plan.jobs[0]?.units[0]?.reclaimAt ?? 0n).toString(),
    };
    presentation.deal = {
      acceptedDealDigest: plan.acceptedDealDigest,
      compositionRoot: plan.compositionRoot,
      capabilityContractRoot: plan.capabilityContractRoot,
      economicTermsHash: plan.economicTermsHash,
      rightsTermsHash: plan.rightsTermsHash,
      sealed,
    };
  }
  return presentation;
}
