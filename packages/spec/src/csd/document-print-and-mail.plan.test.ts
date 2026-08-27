import { describe, it, expect } from "vitest";
import { deriveCompositionCommitment, deriveCapabilityContractRoot, type MatchedDAG } from "./composition-commitment.js";
import {
  PRINT_AND_MAIL_LEGS,
  PRINT_AND_MAIL_EDGES,
  PROVIDER_GAPS,
  CARRIER_ACCEPTANCE_SCAN,
  buildPrintAndMailDAG,
  printAndMailContractPlan,
  printAndMailContractRoot,
  mailLegClosesOnCarrierScanOnly,
  proveTwoOperatorEquivalence,
  type LegMatch,
} from "./document-print-and-mail.plan.js";

const dig = (b: string) => "0x" + b.repeat(32);
const REQ = "req.mail.court-filing-001";

// Operator A — Lob's API fulfils every leg (print + insert + mail + tracking are Lob capabilities).
const LOB: Record<"print" | "handoff" | "mail" | "proof", LegMatch> = {
  print: { matchedCapabilityDigest: dig("a1"), matchedCapabilityId: "cap.lob.print", estimatedCost: "0.60", currency: "USDC" },
  handoff: { matchedCapabilityDigest: dig("a2"), matchedCapabilityId: "cap.lob.insert", estimatedCost: "0.40", currency: "USDC" },
  mail: { matchedCapabilityDigest: dig("a3"), matchedCapabilityId: "cap.lob.mail", estimatedCost: "1.20", currency: "USDC" },
  proof: { matchedCapabilityDigest: dig("a4"), matchedCapabilityId: "cap.lob.track", estimatedCost: "0.30", currency: "USDC" },
};
// Operator B — a human with a printer and a car, at the SAME contract prices (the buyer's offer).
const HUMAN: Record<"print" | "handoff" | "mail" | "proof", LegMatch> = {
  print: { matchedCapabilityDigest: dig("b1"), matchedCapabilityId: "cap.human.home-printer", estimatedCost: "0.60", currency: "USDC" },
  handoff: { matchedCapabilityDigest: dig("b2"), matchedCapabilityId: "cap.human.handoff", estimatedCost: "0.40", currency: "USDC" },
  mail: { matchedCapabilityDigest: dig("b3"), matchedCapabilityId: "cap.human.usps-drop", estimatedCost: "1.20", currency: "USDC" },
  proof: { matchedCapabilityDigest: dig("b4"), matchedCapabilityId: "cap.usps.tracking", estimatedCost: "0.30", currency: "USDC" },
};

describe("document.print-and-mail plan template", () => {
  it("is a 4-leg linear DAG: print -> handoff -> mail -> proof, with new-vocabulary legs declared as provider gaps", () => {
    expect(PRINT_AND_MAIL_LEGS.map((l) => l.nodeId)).toEqual(["print", "handoff", "mail", "proof"]);
    expect(PRINT_AND_MAIL_EDGES).toEqual([{ from: "print", to: "handoff" }, { from: "handoff", to: "mail" }, { from: "mail", to: "proof" }]);
    expect(PROVIDER_GAPS).toEqual(["mail.drop", "mail.track"]);
    expect(PRINT_AND_MAIL_LEGS[0].capabilityType).toBe("document-printing"); // reuses the existing type
  });

  it("the MAIL leg closes ONLY on the carrier's acceptance scan — never a photo, never a self-declaration", () => {
    const mail = PRINT_AND_MAIL_LEGS.find((l) => l.nodeId === "mail")!;
    expect(mail.closes.map((c) => c.evidenceTypeId)).toEqual([CARRIER_ACCEPTANCE_SCAN]);
    expect(mailLegClosesOnCarrierScanOnly(printAndMailContractPlan(REQ))).toBe(true);
    // a plan whose mail leg closes on a photo is REFUSED
    const photoMail: MatchedDAG = buildPrintAndMailDAG(REQ, "g", {});
    photoMail.nodes.find((n) => n.nodeId === "mail")!.evidenceRequirements = [{ requirementId: "x", evidenceTypeId: "capture.photo_nonced", tier: 2 }];
    expect(mailLegClosesOnCarrierScanOnly(photoMail)).toBe(false);
    // ...and it is ALSO a different contract: a photo-substitute shape can never match the buyer's contract root
    expect(deriveCapabilityContractRoot(photoMail)).not.toBe(printAndMailContractRoot(REQ));
  });

  it("the buyer's contract root is computable BEFORE any operator is matched, and the template plan is (correctly) UNCOMMITTABLE", () => {
    const template = printAndMailContractPlan(REQ);
    expect(printAndMailContractRoot(REQ)).toMatch(/^0x[0-9a-f]{64}$/);
    const r = deriveCompositionCommitment(template);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toEqual(["print", "handoff", "mail", "proof"]);
  });

  it("THE TWO-OPERATOR PROOF (#1344): Lob's API vs a human with a printer -> identical contract root, different composition roots, and the ONLY differing fields are the provider bindings", () => {
    const lobRun = buildPrintAndMailDAG(REQ, "print and certified-mail a court filing", LOB);
    const humanRun = buildPrintAndMailDAG(REQ, "print and certified-mail a court filing", HUMAN);
    const rl = deriveCompositionCommitment(lobRun);
    const rh = deriveCompositionCommitment(humanRun);
    expect(rl.committable && rh.committable).toBe(true);
    if (rl.committable && rh.committable) {
      expect(rh.capabilityContractRoot).toBe(rl.capabilityContractRoot);
      expect(rh.capabilityContractRoot).toBe(printAndMailContractRoot(REQ)); // == what the buyer agreed to, pre-match
      expect(rh.compositionRoot).not.toBe(rl.compositionRoot);
    }
    const proof = proveTwoOperatorEquivalence(lobRun, humanRun);
    expect(proof.sameContract).toBe(true);
    expect(proof.pureOperatorSubstitution).toBe(true);
    expect(proof.contractRoot).toBe(printAndMailContractRoot(REQ));
    expect(new Set(proof.differingFields.map((d) => d.field))).toEqual(new Set(["matchedCapabilityDigest", "matchedCapabilityId"]));
    expect(new Set(proof.differingFields.map((d) => d.nodeId))).toEqual(new Set(["print", "handoff", "mail", "proof"]));
  });

  it("honesty check: if the human run charged more on the mail leg it is NOT a pure operator substitution", () => {
    const lobRun = buildPrintAndMailDAG(REQ, "g", LOB);
    const pricier = buildPrintAndMailDAG(REQ, "g", { ...HUMAN, mail: { ...HUMAN.mail, estimatedCost: "2.00" } });
    const proof = proveTwoOperatorEquivalence(lobRun, pricier);
    expect(proof.sameContract).toBe(true);
    expect(proof.pureOperatorSubstitution).toBe(false);
    expect(proof.differingFields.some((d) => d.nodeId === "mail" && d.field === "estimatedCost")).toBe(true);
  });

  it("a partially fulfilled run (no mail provider yet) is UNCOMMITTABLE — the gap is a market to fill, not a phantom root", () => {
    const { mail: _mail, ...noMail } = HUMAN;
    const r = deriveCompositionCommitment(buildPrintAndMailDAG(REQ, "g", noMail));
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toEqual(["mail"]);
  });

  it("GOLDEN: the print-and-mail contract root + Lob-run composition root (v2 domains, computed 2026-08-27 11:21 PDT; also vector #3 of the conformance corpus)", () => {
    expect(printAndMailContractRoot(REQ)).toBe("0x22758b967845f388db141a41a756b19287ebf10f366ffc55a8ddcbef37b94d02");
    const lobRun = deriveCompositionCommitment(buildPrintAndMailDAG(REQ, "g", LOB));
    expect(lobRun.committable).toBe(true);
    if (lobRun.committable) expect(lobRun.compositionRoot).toBe("0x873069a90d6c046ddf942cfba67de1ea3785aa0aa4fefe84888fa5f22bcb2317");
  });
});
