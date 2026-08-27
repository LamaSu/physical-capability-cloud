/**
 * document.print-and-mail — the composite plan template (operator directive #1344; demo doc #1585 §3-4).
 *
 * PCC's first real service: "your agent can now print and mail documents". Four legs, a linear DAG:
 *
 *   print ─▶ handoff ─▶ mail ─▶ proof
 *
 * Each leg declares the provider-neutral capabilityType that must be MATCHED and the evidence that
 * CLOSES it (evidence-vocabulary v1 primitive ids, packages/spec/src/evidence/primitives.ts) at its
 * assurance tier. This template is what the capabilityContractRoot commits to — the buyer's contract —
 * and what both operators in the two-operator proof (Lob's API vs a human with a printer and a car)
 * must satisfy identically.
 *
 * THE ONE MECHANISM THAT MAKES IT WORK (demo doc §3, design C): postage is bought UPSTREAM, so the
 * carrier issues the tracking number before any human touches the envelope. The worker's job is purely
 * physical — print, fold, stuff, affix the pre-printed label, drop. The MAIL leg then closes ONLY on
 * the carrier's own acceptance scan (`confirm.target_system` over an authenticated webhook, matcher
 * "carrier.acceptance_scan") — proof the worker CANNOT author. A photograph never substitutes; that is
 * enforced structurally: a plan whose mail leg closes on a photo has a DIFFERENT contract root, so it is
 * a different contract, and `mailLegClosesOnCarrierScanOnly()` refuses it outright.
 *
 * Vocabulary: the print leg reuses the existing `document-printing` type (contract-builder template +
 * pcc://capabilities/2d-print/v1; kernel-hp-printer on Spark is the real hardware); the handoff leg reuses
 * pcc-courier's `courier.confirm` (geofenced handoff proof). `mail.drop` and `mail.track` are NEW leg types:
 * no mail domain existed in the decomposer (a "mail" step would classify as generic logistics with
 * delivery_confirmation) — they are listed in PROVIDER_GAPS: a market to fill (#1299), not an error.
 *
 * Tier note (honest): the carrier scan as an independent SIGNED CHANNEL primitive is not yet in
 * evidence-vocabulary v1 (evidence lane #1544 named "signed sensor channels" as the forward gap);
 * `confirm.target_system` supports tier 2 with an authenticated webhook. Tier 3 on the proof leg rides
 * that plus `confirm.recipient_signature`; a dedicated `channel.carrier_scan` primitive is PROPOSED to
 * evidence c25c8f97, not invented here.
 *
 * Companion CSD (registrable, kind=workflow): ../csds/document-print-and-mail.csd.json.
 */

import {
  deriveCapabilityContractRoot,
  deriveCompositionCommitment,
  explainSubstitution,
  type EvidenceRequirement,
  type MatchedDAG,
  type MatchedNode,
  type SubstitutionReport,
} from "./composition-commitment.js";

export type LegId = "print" | "handoff" | "mail" | "proof";
export type LegKind = "make" | "process" | "deliver" | "inspect";

export interface PlanLeg {
  nodeId: LegId;
  name: string;
  /** Provider-neutral capability identity the matcher must satisfy for this leg. */
  capabilityType: string;
  /** Decomposer StepKind hint (drives HOURS_BY_KIND / category defaults). */
  kind: LegKind;
  /** Assurance tier the leg is contracted at. */
  tier: 0 | 1 | 2 | 3;
  /** Evidence that CLOSES the leg (committed into the contract root). */
  closes: EvidenceRequirement[];
  /** Evidence that must NEVER close the leg on its own (refused by mailLegClosesOnCarrierScanOnly). */
  neverCloses: readonly string[];
}

export const CARRIER_ACCEPTANCE_SCAN = "confirm.target_system";
export const CARRIER_SCAN_MATCHER = "carrier.acceptance_scan";
export const PHOTO_PRIMITIVES = ["capture.photo_nonced", "photo_of_printed_output", "photo_at_dropoff", "decl.self_attested"] as const;

export const PRINT_AND_MAIL_LEGS: readonly PlanLeg[] = [
  {
    nodeId: "print",
    name: "Print the document",
    capabilityType: "document-printing",
    kind: "make",
    tier: 1,
    closes: [
      { requirementId: "print.job-log", evidenceTypeId: "machine.execution_log", tier: 1 },
      { requirementId: "print.receipt", evidenceTypeId: "receipt.kernel_signed", tier: 1 },
    ],
    neverCloses: [],
  },
  {
    nodeId: "handoff",
    name: "Fold, stuff, affix the pre-printed carrier label",
    capabilityType: "courier.confirm",
    kind: "process",
    tier: 2,
    closes: [
      { requirementId: "handoff.photo", evidenceTypeId: "capture.photo_nonced", tier: 2 },
      { requirementId: "handoff.label", evidenceTypeId: "artifact.hash", tier: 1 },
    ],
    neverCloses: [],
  },
  {
    nodeId: "mail",
    name: "Drop into the carrier's mail stream",
    capabilityType: "mail.drop",
    kind: "deliver",
    tier: 2,
    closes: [{ requirementId: "mail.acceptance-scan", evidenceTypeId: CARRIER_ACCEPTANCE_SCAN, tier: 2 }],
    neverCloses: PHOTO_PRIMITIVES,
  },
  {
    nodeId: "proof",
    name: "Delivery proof from the carrier",
    capabilityType: "mail.track",
    kind: "inspect",
    tier: 3,
    closes: [
      { requirementId: "proof.delivery-scan", evidenceTypeId: "confirm.target_system", tier: 2 },
      { requirementId: "proof.signature", evidenceTypeId: "confirm.recipient_signature", tier: 2 },
    ],
    neverCloses: PHOTO_PRIMITIVES,
  },
];

export const PRINT_AND_MAIL_EDGES: readonly { from: LegId; to: LegId }[] = [
  { from: "print", to: "handoff" },
  { from: "handoff", to: "mail" },
  { from: "mail", to: "proof" },
];

/** Leg types with NO registered provider on lamasu/master as of 2026-08-27 — a market to fill (#1299). */
export const PROVIDER_GAPS: readonly string[] = ["mail.drop", "mail.track"];

/** What one operator binds to one leg — the ONLY thing that may differ between two operators' runs. */
export interface LegMatch {
  matchedCapabilityDigest: string;
  matchedCapabilityId: string;
  estimatedCost: string;
  currency: string;
}

/**
 * Build the MatchedDAG for a print-and-mail request from per-leg matches. Legs without a match are
 * emitted as matchStatus:'none' WITHOUT a price (the decomposer's plausible 10 is exactly the trap the
 * commitment guard exists for; the template never fakes one).
 */
export function buildPrintAndMailDAG(
  requestId: string,
  goal: string,
  matches: Partial<Record<LegId, LegMatch>>,
): MatchedDAG {
  const nodes: MatchedNode[] = PRINT_AND_MAIL_LEGS.map((leg) => {
    const m = matches[leg.nodeId];
    return m
      ? { nodeId: leg.nodeId, capabilityType: leg.capabilityType, matchStatus: "matched", ...m, evidenceRequirements: [...leg.closes] }
      : { nodeId: leg.nodeId, capabilityType: leg.capabilityType, matchStatus: "none", evidenceRequirements: [...leg.closes] };
  });
  return { requestId, goal, nodes, edges: PRINT_AND_MAIL_EDGES.map((e) => ({ ...e })) };
}

/** The unmatched (template) plan — the buyer's CONTRACT before any operator is chosen. */
export function printAndMailContractPlan(requestId: string, goal = "print and mail a document"): MatchedDAG {
  return buildPrintAndMailDAG(requestId, goal, {});
}

/** The buyer's contract root — computable before matching, identical for every fulfilling operator. */
export function printAndMailContractRoot(requestId = "req.template"): string {
  return deriveCapabilityContractRoot(printAndMailContractPlan(requestId));
}

/**
 * Structural refusal (demo doc §3 / hackathon #1436): the MAIL leg must close on the carrier's own scan
 * and on nothing that a worker can author. Returns false for any plan where the mail leg lacks the
 * carrier-scan closure or lists a photo/self-declaration among its closers.
 */
export function mailLegClosesOnCarrierScanOnly(dag: MatchedDAG): boolean {
  const mail = dag.nodes.find((n) => n.nodeId === "mail");
  if (!mail) return false;
  const closers = (mail.evidenceRequirements ?? []).map((r) => r.evidenceTypeId);
  if (!closers.includes(CARRIER_ACCEPTANCE_SCAN)) return false;
  return !closers.some((c) => (PHOTO_PRIMITIVES as readonly string[]).includes(c));
}

/**
 * The two-operator proof, as a verifiable statement: open both runs and confirm the contract is the
 * same and ONLY the provider bindings differ. Anything else differing (price, requestId, evidence) makes
 * it NOT a pure operator substitution — which is the honest answer, not a weaker claim.
 */
export function proveTwoOperatorEquivalence(runA: MatchedDAG, runB: MatchedDAG): SubstitutionReport & { contractRoot: string | null } {
  const report = explainSubstitution(runA, runB);
  const ra = deriveCompositionCommitment(runA);
  return { ...report, contractRoot: report.sameContract && ra.committable ? ra.capabilityContractRoot : null };
}
