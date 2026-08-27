import { describe, it, expect } from "vitest";
import type { CapabilityNode } from "../types/requests.js";
import { canonicalDecimal, matchedDagFromCapabilityNodes, commitmentReportForRequest } from "./composition-commitment-adapter.js";

const DIG = (b: string) => "0x" + b.repeat(32);

function node(partial: Partial<CapabilityNode> & { id: string; capabilityType: string }): CapabilityNode {
  return {
    requestId: "req-1",
    name: partial.id,
    description: "",
    category: "fabrication",
    estimatedCost: 10,
    estimatedHours: 1,
    dependencies: [],
    parallel: false,
    status: "pending",
    materials: [],
    evidenceRequirements: ["photo_of_completed_work"],
    ...partial,
  };
}

describe("composition-commitment adapter (CapabilityNode[] -> MatchedDAG)", () => {
  it("canonicalDecimal: numbers become canonical decimal strings; unrepresentable values become undefined", () => {
    expect(canonicalDecimal(12)).toBe("12");
    expect(canonicalDecimal(0.6)).toBe("0.6");
    expect(canonicalDecimal(0)).toBe("0");
    expect(canonicalDecimal(NaN)).toBeUndefined();
    expect(canonicalDecimal(-1)).toBeUndefined();
    expect(canonicalDecimal(1e21)).toBeUndefined();
  });

  it("maps ids, types, dependencies->edges, evidence (tier 0 = declared, not negotiated) and request currency", () => {
    const nodes = [
      node({ id: "req-1-step-1", capabilityType: "pizza.make", matchStatus: "matched", matchedCapabilityId: "cap.a", estimatedCost: 12 }),
      node({ id: "req-1-step-2", capabilityType: "courier.dispatch", matchStatus: "matched", matchedCapabilityId: "cap.b", estimatedCost: 6, dependencies: ["req-1-step-1"] }),
    ];
    const dag = matchedDagFromCapabilityNodes("req-1", nodes, { currency: "USDC", goal: "pizza" });
    expect(dag.edges).toEqual([{ from: "req-1-step-1", to: "req-1-step-2" }]);
    expect(dag.nodes[0]).toMatchObject({ nodeId: "req-1-step-1", capabilityType: "pizza.make", matchStatus: "matched", estimatedCost: "12", currency: "USDC" });
    expect(dag.nodes[0].evidenceRequirements).toEqual([{ requirementId: "photo_of_completed_work", evidenceTypeId: "photo_of_completed_work", tier: 0 }]);
  });

  it("master today (matched but NO digest): UNCOMMITTABLE with the named violation + blockedOn, while the contract root is final", () => {
    const nodes = [node({ id: "n1", capabilityType: "pizza.make", matchStatus: "matched", matchedCapabilityId: "cap.a", estimatedCost: 12 })];
    const r = commitmentReportForRequest("req-1", nodes, { currency: "USDC" });
    expect(r.commitment.committable).toBe(false);
    if (!r.commitment.committable) {
      expect(r.commitment.unmatchedNodes).toEqual([]);
      expect(r.commitment.violations.join(" ")).toMatch(/matchedCapabilityDigest/);
    }
    expect(r.blockedOn).toMatch(/matchedCapabilityDigest/);
    expect(r.capabilityContractRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.matchedCount).toBe(1);
  });

  it("a digest-stamped plan (the digest branch merged) commits BOTH roots; a different provider digest changes only the composition root", () => {
    const withDigest = (d: string) => [
      { ...node({ id: "n1", capabilityType: "pizza.make", matchStatus: "matched", matchedCapabilityId: "cap.a", estimatedCost: 12 }), matchedCapabilityDigest: d },
    ] as CapabilityNode[];
    const a = commitmentReportForRequest("req-1", withDigest(DIG("aa")), { currency: "USDC" });
    const b = commitmentReportForRequest("req-1", withDigest(DIG("bb")), { currency: "USDC" });
    expect(a.commitment.committable && b.commitment.committable).toBe(true);
    if (a.commitment.committable && b.commitment.committable) {
      expect(a.commitment.compositionRoot).not.toBe(b.commitment.compositionRoot);
      expect(a.commitment.capabilityContractRoot).toBe(b.commitment.capabilityContractRoot);
      expect(a.capabilityContractRoot).toBe(a.commitment.capabilityContractRoot);
    }
    expect(a.blockedOn).toBeUndefined();
  });

  it("an unmatched node (the #1216 trap, plausible cost 10) is reported as unmatched, not blocked-on-digest", () => {
    const nodes = [
      node({ id: "n1", capabilityType: "pizza.make", matchStatus: "matched", matchedCapabilityId: "cap.a", estimatedCost: 12 }),
      node({ id: "n2", capabilityType: "courier.dispatch", matchStatus: "none", estimatedCost: 10, dependencies: ["n1"] }),
    ];
    const r = commitmentReportForRequest("req-1", nodes, { currency: "USDC" });
    expect(r.commitment.committable).toBe(false);
    if (!r.commitment.committable) expect(r.commitment.unmatchedNodes).toEqual(["n2"]);
    expect(r.blockedOn).toBeUndefined();
    expect(r.capabilityContractRoot).toMatch(/^0x[0-9a-f]{64}$/); // the buyer's contract is still well-defined
  });
});
