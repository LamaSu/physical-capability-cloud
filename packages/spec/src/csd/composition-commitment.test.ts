import { describe, it, expect } from "vitest";
import { deriveCompositionCommitment, deriveCapabilityContractRoot, type MatchedDAG } from "./composition-commitment.js";

const DIG_A = "0x" + "aa".repeat(32); // stand-in matchedCapabilityDigest (SHA-256 of resolved CSD)
const DIG_B = "0x" + "bb".repeat(32);

// The hackathon scenario: "a margherita pizza made and delivered", fully matched to two live caps.
const pizza: MatchedDAG = {
  requestId: "req.pizza.1",
  goal: "a 12-inch margherita pizza made and delivered to me in Manhattan",
  nodes: [
    { nodeId: "n0.make", matchStatus: "matched", matchedCapabilityDigest: DIG_A, matchedCapabilityId: "cap.marios.woodfired", estimatedCost: "12", currency: "USDC" },
    { nodeId: "n1.deliver", matchStatus: "matched", matchedCapabilityDigest: DIG_B, matchedCapabilityId: "cap.daves.courier", estimatedCost: "6", currency: "USDC" },
  ],
  edges: [{ from: "n0.make", to: "n1.deliver" }],
};

describe("composition-commitment", () => {
  it("fully-matched pizza+delivery plan -> committable compositionRoot (0x + 64 hex)", () => {
    const r = deriveCompositionCommitment(pizza);
    expect(r.committable).toBe(true);
    if (r.committable) {
      expect(r.compositionRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.nodeCount).toBe(2);
    }
  });

  it("deterministic: reordered nodes/edges -> identical compositionRoot", () => {
    const shuffled: MatchedDAG = { ...pizza, nodes: [pizza.nodes[1], pizza.nodes[0]] };
    const a = deriveCompositionCommitment(pizza);
    const b = deriveCompositionCommitment(shuffled);
    expect(a.committable && b.committable).toBe(true);
    if (a.committable && b.committable) expect(b.compositionRoot).toBe(a.compositionRoot);
  });

  it("the #1216 trap: one node matchStatus:'none' with a plausible 10 USDC -> UNCOMMITTABLE (not a template artifact)", () => {
    const halfTemplate: MatchedDAG = {
      ...pizza,
      nodes: [pizza.nodes[0], { nodeId: "n1.deliver", matchStatus: "none", estimatedCost: "10", currency: "USDC" }],
    };
    const r = deriveCompositionCommitment(halfTemplate);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toContain("n1.deliver");
  });

  it("matched node missing matchedCapabilityDigest -> UNCOMMITTABLE (binding missing)", () => {
    const noBinding: MatchedDAG = {
      ...pizza,
      nodes: [{ ...pizza.nodes[0], matchedCapabilityDigest: undefined }, pizza.nodes[1]],
    };
    expect(deriveCompositionCommitment(noBinding).committable).toBe(false);
  });

  it("a plan where the LEGACY template mislabels everything matched but with a foreign digest still commits a DISCOVERED root, and changing a matched capability changes the root", () => {
    const r1 = deriveCompositionCommitment(pizza);
    const swapped: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], matchedCapabilityDigest: DIG_B }, pizza.nodes[1]] };
    const r2 = deriveCompositionCommitment(swapped);
    expect(r1.committable && r2.committable).toBe(true);
    // a different matched capability (different contract digest) MUST yield a different commitment
    if (r1.committable && r2.committable) expect(r2.compositionRoot).not.toBe(r1.compositionRoot);
  });

  // === Re-anchor to the operator's reframe (#1299/#1301): a physical capability is anything that
  // can DO the task AND PROVE IT -- model, machine, OR human-with-phone -- priced/verified/settled
  // identically. Composition's demo is therefore a composite resolving ACROSS a DIGITAL leg + PHYSICAL
  // legs, provenance on each; one compositionRoot commits the mixed-executor AGREEMENT. That committed
  // root is also the declared-intent an assay checks drift against (#1301 "one mechanism or two").
  const DIG_C = "0x" + "cc".repeat(32);
  const mixed: MatchedDAG = {
    requestId: "req.storefront-audit.1",
    goal: "research the brand (digital), photograph its flagship storefront (human w/ phone), courier a sample to the lab",
    nodes: [
      // DIGITAL executor: a model via AIsa -- evidence IS the artifact (the researched brief).
      { nodeId: "n0.research", matchStatus: "matched", matchedCapabilityDigest: DIG_A, matchedCapabilityId: "cap.aisa.deepseek", estimatedCost: "2", currency: "USDC" },
      // PHYSICAL executor: a human with a phone -- receives a digital task, acts in the world, returns evidence.
      { nodeId: "n1.photograph", matchStatus: "matched", matchedCapabilityDigest: DIG_B, matchedCapabilityId: "cap.human.field-agent", estimatedCost: "15", currency: "USDC" },
      // PHYSICAL executor: a courier machine/operator.
      { nodeId: "n2.courier", matchStatus: "matched", matchedCapabilityDigest: DIG_C, matchedCapabilityId: "cap.daves.courier", estimatedCost: "9", currency: "USDC" },
    ],
    edges: [{ from: "n0.research", to: "n1.photograph" }, { from: "n1.photograph", to: "n2.courier" }],
  };

  it("the reframe demo (#1299): a composite across a DIGITAL leg (AIsa model) + PHYSICAL legs (human-with-phone, courier), all matched -> ONE committable compositionRoot over the mixed-executor agreement", () => {
    const r = deriveCompositionCommitment(mixed);
    expect(r.committable).toBe(true);
    if (r.committable) {
      expect(r.compositionRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.nodeCount).toBe(3);
    }
  });

  it("mixed-executor unmatched leg (#1299 'a market to fill'): if the human photo leg has no provider yet, the whole plan is UNCOMMITTABLE -- never a partial phantom root", () => {
    const gap: MatchedDAG = {
      ...mixed,
      nodes: [mixed.nodes[0], { nodeId: "n1.photograph", matchStatus: "none", estimatedCost: "10", currency: "USDC" }, mixed.nodes[2]],
    };
    const r = deriveCompositionCommitment(gap);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toContain("n1.photograph");
  });

  // === #1344 two-operator proof: the SAME job fulfilled by two operators (Lob's API vs a human with a
  // printer) must be provably the SAME capability contract yet GENUINELY different operators — so the
  // buyer's agent "cannot tell which fulfilled it" is a verifiable claim, not an assertion.
  it("the two-operator proof (#1344): same request + same contract, only the operator differs -> IDENTICAL capabilityContractRoot, DIFFERENT compositionRoot", () => {
    // Same request, same DAG shape, same per-leg evidence requirements. Only the MAIL leg's matched
    // provider (digest + id) differs — that is the operator, and it is the ONLY difference.
    const printAndMail = (mailDigest: string, mailCapId: string): MatchedDAG => ({
      requestId: "req.mail.certified-001",
      goal: "print and certified-mail a document",
      nodes: [
        { nodeId: "n0.print", matchStatus: "matched", matchedCapabilityDigest: DIG_A, matchedCapabilityId: "cap.kernel.hp-printer", estimatedCost: "1", currency: "USDC",
          evidenceRequirements: [{ requirementId: "r.print", evidenceTypeId: "printer.job-event", tier: 1 }] },
        { nodeId: "n1.mail", matchStatus: "matched", matchedCapabilityDigest: mailDigest, matchedCapabilityId: mailCapId, estimatedCost: "5", currency: "USDC",
          evidenceRequirements: [{ requirementId: "r.mail", evidenceTypeId: "carrier.scan-event", tier: 3 }] },
      ],
      edges: [{ from: "n0.print", to: "n1.mail" }],
    });
    const lobRun = printAndMail(DIG_B, "cap.lob.api");                 // operator A: Lob's API
    const humanRun = printAndMail(DIG_C, "cap.human.printer-and-car"); // operator B: a human with a printer

    // SAME capability contract -- provable, and it is exactly what the buyer agreed to:
    expect(deriveCapabilityContractRoot(humanRun)).toBe(deriveCapabilityContractRoot(lobRun));
    // ...yet GENUINELY different operators fulfilled it -- also provable, and the ONLY difference is the provider:
    const lob = deriveCompositionCommitment(lobRun);
    const human = deriveCompositionCommitment(humanRun);
    expect(lob.committable && human.committable).toBe(true);
    if (lob.committable && human.committable) {
      expect(human.compositionRoot).not.toBe(lob.compositionRoot);
    }
  });

  it("capabilityContractRoot is provider-agnostic but NOT contract-blind: change a leg's assurance tier and the contract root MUST change", () => {
    const base: MatchedDAG = {
      requestId: "req.x", goal: "g",
      nodes: [
        { nodeId: "n0", matchStatus: "matched", matchedCapabilityDigest: DIG_A, estimatedCost: "1", currency: "USDC",
          evidenceRequirements: [{ requirementId: "r0", evidenceTypeId: "carrier.scan-event", tier: 3 }] },
      ],
      edges: [],
    };
    const weakened: MatchedDAG = {
      ...base,
      nodes: [{ ...base.nodes[0], evidenceRequirements: [{ requirementId: "r0", evidenceTypeId: "carrier.scan-event", tier: 1 }] }],
    };
    expect(deriveCapabilityContractRoot(weakened)).not.toBe(deriveCapabilityContractRoot(base));
  });
});
