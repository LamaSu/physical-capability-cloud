import { describe, it, expect } from "vitest";
import {
  deriveCompositionCommitment,
  deriveCapabilityContractRoot,
  explainSubstitution,
  validatePlan,
  COMPOSITION_DOMAIN,
  CONTRACT_DOMAIN,
  type MatchedDAG,
  type MatchedNode,
} from "./composition-commitment.js";
import vectors from "./composition-commitment.vectors.json" with { type: "json" };

const DIG_A = "0x" + "aa".repeat(32); // stand-in matchedCapabilityDigest (deal-snapshot digest)
const DIG_B = "0x" + "bb".repeat(32);
const DIG_C = "0x" + "cc".repeat(32);

const matched = (nodeId: string, capabilityType: string, digest: string, capId: string, cost: string, extra: Partial<MatchedNode> = {}): MatchedNode => ({
  nodeId, capabilityType, matchStatus: "matched", matchedCapabilityDigest: digest, matchedCapabilityId: capId, estimatedCost: cost, currency: "USDC", ...extra,
});

// The original hackathon scenario: "a margherita pizza made and delivered", fully matched to two live caps.
const pizza: MatchedDAG = {
  requestId: "req.pizza.1",
  goal: "a 12-inch margherita pizza made and delivered to me in Manhattan",
  nodes: [
    matched("n0.make", "pizza.make", DIG_A, "cap.marios.woodfired", "12"),
    matched("n1.deliver", "courier.dispatch", DIG_B, "cap.daves.courier", "6"),
  ],
  edges: [{ from: "n0.make", to: "n1.deliver" }],
};

// The operator's reframe (#1299/#1301): a composite across a DIGITAL leg (a model via AIsa) + PHYSICAL legs
// (a human with a phone, a courier) — one contract, provenance on every leg.
const mixed: MatchedDAG = {
  requestId: "req.storefront-audit.1",
  goal: "research the brand (digital), photograph its flagship storefront (human w/ phone), courier a sample to the lab",
  nodes: [
    matched("n0.research", "research.brief", DIG_A, "cap.aisa.deepseek", "2"),
    matched("n1.photograph", "field.photo", DIG_B, "cap.human.field-agent", "15", { evidenceRequirements: [{ requirementId: "r.photo", evidenceTypeId: "capture.photo_nonced", tier: 2 }] }),
    matched("n2.courier", "courier.dispatch", DIG_C, "cap.daves.courier", "9"),
  ],
  edges: [{ from: "n0.research", to: "n1.photograph" }, { from: "n1.photograph", to: "n2.courier" }],
};

describe("composition-commitment v2", () => {
  it("fully-matched plan -> committable: compositionRoot + capabilityContractRoot (0x + 64 hex each)", () => {
    const r = deriveCompositionCommitment(pizza);
    expect(r.committable).toBe(true);
    if (r.committable) {
      expect(r.compositionRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.capabilityContractRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.compositionRoot).not.toBe(r.capabilityContractRoot);
      expect(r.nodeCount).toBe(2);
    }
  });

  it("deterministic: reordered nodes/edges -> identical roots", () => {
    const shuffled: MatchedDAG = { ...pizza, nodes: [pizza.nodes[1], pizza.nodes[0]] };
    const a = deriveCompositionCommitment(pizza);
    const b = deriveCompositionCommitment(shuffled);
    expect(a.committable && b.committable).toBe(true);
    if (a.committable && b.committable) {
      expect(b.compositionRoot).toBe(a.compositionRoot);
      expect(b.capabilityContractRoot).toBe(a.capabilityContractRoot);
    }
  });

  it("the #1216 trap: one node matchStatus:'none' with a plausible 10 USDC -> UNCOMMITTABLE (not a template artifact)", () => {
    const halfTemplate: MatchedDAG = {
      ...pizza,
      nodes: [pizza.nodes[0], { nodeId: "n1.deliver", capabilityType: "courier.dispatch", matchStatus: "none", estimatedCost: "10", currency: "USDC" }],
    };
    const r = deriveCompositionCommitment(halfTemplate);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toContain("n1.deliver");
  });

  it("matched node missing matchedCapabilityDigest -> UNCOMMITTABLE with a named violation", () => {
    const noBinding: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], matchedCapabilityDigest: undefined }, pizza.nodes[1]] };
    const r = deriveCompositionCommitment(noBinding);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.violations.join(" ")).toMatch(/matchedCapabilityDigest/);
  });

  it("sol Q1 BLOCKER closed: omitted price/currency on a matched node no longer aliases '' -> UNCOMMITTABLE", () => {
    const noCost: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], estimatedCost: undefined }, pizza.nodes[1]] };
    const noCurrency: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], currency: undefined }, pizza.nodes[1]] };
    const emptyCost: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], estimatedCost: "" }, pizza.nodes[1]] };
    for (const d of [noCost, noCurrency, emptyCost]) expect(deriveCompositionCommitment(d).committable).toBe(false);
  });

  it("a different matched capability (different digest) -> DIFFERENT compositionRoot but the SAME capabilityContractRoot", () => {
    const r1 = deriveCompositionCommitment(pizza);
    const swapped: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], matchedCapabilityDigest: DIG_C, matchedCapabilityId: "cap.luigis.woodfired" }, pizza.nodes[1]] };
    const r2 = deriveCompositionCommitment(swapped);
    expect(r1.committable && r2.committable).toBe(true);
    if (r1.committable && r2.committable) {
      expect(r2.compositionRoot).not.toBe(r1.compositionRoot);
      expect(r2.capabilityContractRoot).toBe(r1.capabilityContractRoot);
    }
  });

  it("the reframe demo (#1299): digital + physical legs, all matched -> ONE committable plan", () => {
    const r = deriveCompositionCommitment(mixed);
    expect(r.committable).toBe(true);
    if (r.committable) expect(r.nodeCount).toBe(3);
  });

  it("mixed-executor unmatched leg (#1299 'a market to fill'): no provider for the human photo leg -> UNCOMMITTABLE, never a partial root", () => {
    const gap: MatchedDAG = {
      ...mixed,
      nodes: [mixed.nodes[0], { nodeId: "n1.photograph", capabilityType: "field.photo", matchStatus: "none", estimatedCost: "10", currency: "USDC" }, mixed.nodes[2]],
    };
    const r = deriveCompositionCommitment(gap);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.unmatchedNodes).toContain("n1.photograph");
  });

  // === sol Q3: the two-operator claim is proved by OPENING both plans, not by root inequality.
  const printAndMail = (mailDigest: string, mailCapId: string, mailCost = "5"): MatchedDAG => ({
    requestId: "req.mail.certified-001",
    goal: "print and certified-mail a document",
    nodes: [
      matched("n0.print", "document-printing", DIG_A, "cap.kernel.hp-printer", "1", { evidenceRequirements: [{ requirementId: "r.print", evidenceTypeId: "machine.execution_log", tier: 1 }] }),
      matched("n1.mail", "mail.drop", mailDigest, mailCapId, mailCost, { evidenceRequirements: [{ requirementId: "r.mail", evidenceTypeId: "confirm.target_system", tier: 2 }] }),
    ],
    edges: [{ from: "n0.print", to: "n1.mail" }],
  });

  it("two-operator proof: same job, only the mail-leg provider differs -> sameContract, different composition, pureOperatorSubstitution TRUE", () => {
    const lob = printAndMail(DIG_B, "cap.lob.api");
    const human = printAndMail(DIG_C, "cap.human.printer-and-car");
    const report = explainSubstitution(lob, human);
    expect(report.sameContract).toBe(true);
    expect(report.sameComposition).toBe(false);
    expect(report.pureOperatorSubstitution).toBe(true);
    expect(report.differingFields.map((d) => d.field).sort()).toEqual(["matchedCapabilityDigest", "matchedCapabilityId"]);
    expect(report.differingFields.every((d) => d.nodeId === "n1.mail")).toBe(true);
  });

  it("sol's counterexample: same operator, different PRICE -> different compositionRoot, same contract, but NOT a pure operator substitution", () => {
    const a = printAndMail(DIG_B, "cap.lob.api", "5");
    const b = printAndMail(DIG_B, "cap.lob.api", "6");
    const report = explainSubstitution(a, b);
    expect(report.sameContract).toBe(true);
    expect(report.sameComposition).toBe(false);
    expect(report.pureOperatorSubstitution).toBe(false);
    expect(report.differingFields).toEqual([{ nodeId: "n1.mail", field: "estimatedCost" }]);
  });

  it("sol Q3 bound roots: weakening a leg's assurance tier changes the contract root AND the composition root", () => {
    const strong = printAndMail(DIG_B, "cap.lob.api");
    const weak: MatchedDAG = { ...strong, nodes: [strong.nodes[0], { ...strong.nodes[1], evidenceRequirements: [{ requirementId: "r.mail", evidenceTypeId: "confirm.target_system", tier: 1 }] }] };
    const rs = deriveCompositionCommitment(strong);
    const rw = deriveCompositionCommitment(weak);
    expect(rs.committable && rw.committable).toBe(true);
    if (rs.committable && rw.committable) {
      expect(rw.capabilityContractRoot).not.toBe(rs.capabilityContractRoot);
      expect(rw.compositionRoot).not.toBe(rs.compositionRoot);
    }
  });

  it("sol Q3 BLOCKER closed: capabilityType is committed — a one-node 'print' plan and a one-node 'shred' plan no longer collide", () => {
    const print: MatchedDAG = { requestId: "r", nodes: [matched("n0", "document-printing", DIG_A, "c", "1")], edges: [] };
    const shred: MatchedDAG = { requestId: "r", nodes: [matched("n0", "document-shredding", DIG_A, "c", "1")], edges: [] };
    expect(deriveCapabilityContractRoot(shred)).not.toBe(deriveCapabilityContractRoot(print));
  });

  it("contract root is computable BEFORE matching (unmatched template plan) and equals the matched plan's contract root", () => {
    const template: MatchedDAG = { ...pizza, nodes: pizza.nodes.map((n) => ({ nodeId: n.nodeId, capabilityType: n.capabilityType, matchStatus: "none" as const })) };
    const r = deriveCompositionCommitment(pizza);
    expect(r.committable).toBe(true);
    if (r.committable) expect(deriveCapabilityContractRoot(template)).toBe(r.capabilityContractRoot);
  });

  // === sol Q2 HIGH: malformed graphs and hazardous identifiers are refused, with named violations.
  it("validation refuses: duplicate nodeId, dangling edge, self-loop, duplicate edge, cycle", () => {
    const base = pizza;
    const dup: MatchedDAG = { ...base, nodes: [base.nodes[0], { ...base.nodes[1], nodeId: "n0.make" }], edges: [] };
    const dangling: MatchedDAG = { ...base, edges: [{ from: "n0.make", to: "ghost" }] };
    const selfLoop: MatchedDAG = { ...base, edges: [{ from: "n0.make", to: "n0.make" }] };
    const dupEdge: MatchedDAG = { ...base, edges: [{ from: "n0.make", to: "n1.deliver" }, { from: "n0.make", to: "n1.deliver" }] };
    const cycle: MatchedDAG = { ...base, edges: [{ from: "n0.make", to: "n1.deliver" }, { from: "n1.deliver", to: "n0.make" }] };
    expect(validatePlan(dup).join(" ")).toMatch(/duplicate nodeId/);
    expect(validatePlan(dangling).join(" ")).toMatch(/not in the plan/);
    expect(validatePlan(selfLoop).join(" ")).toMatch(/self-loop/);
    expect(validatePlan(dupEdge).join(" ")).toMatch(/duplicate edge/);
    expect(validatePlan(cycle).join(" ")).toMatch(/cycle/);
    for (const d of [dup, dangling, selfLoop, dupEdge, cycle]) expect(deriveCompositionCommitment(d).committable).toBe(false);
  });

  it("validation refuses hazardous identifiers: whitespace, unpaired surrogate, non-ASCII, empty; and bad price/currency grammar", () => {
    const withSpace: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], nodeId: "a b" }, pizza.nodes[1]], edges: [] };
    const surrogate: MatchedDAG = { ...pizza, requestId: "\uD800" };
    const accented: MatchedDAG = { ...pizza, requestId: "réq" };
    const emptyType: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], capabilityType: "" }, pizza.nodes[1]] };
    const badCost: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], estimatedCost: "012" }, pizza.nodes[1]] };
    const badCurrency: MatchedDAG = { ...pizza, nodes: [{ ...pizza.nodes[0], currency: "usdc" }, pizza.nodes[1]] };
    for (const d of [withSpace, surrogate, accented, emptyType, badCost, badCurrency]) {
      expect(validatePlan(d).length).toBeGreaterThan(0);
      expect(deriveCompositionCommitment(d).committable).toBe(false);
    }
  });

  it("canonical order is separator-free and reorder-stable for prefix-related ids", () => {
    const mk = (id: string) => matched(id, "t", DIG_A, "c", "1");
    const dag: MatchedDAG = { requestId: "req.order", nodes: [mk("a"), mk("a.b"), mk("y"), mk("z")], edges: [{ from: "a", to: "z" }, { from: "a.b", to: "y" }] };
    const rev: MatchedDAG = { ...dag, nodes: [...dag.nodes].reverse(), edges: [...dag.edges].reverse() };
    const r1 = deriveCompositionCommitment(dag);
    const r2 = deriveCompositionCommitment(rev);
    expect(r1.committable && r2.committable).toBe(true);
    if (r1.committable && r2.committable) {
      expect(r2.compositionRoot).toBe(r1.compositionRoot);
      expect(r2.capabilityContractRoot).toBe(r1.capabilityContractRoot);
    }
  });

  // === Conformance corpus (sol Q4): the SAME vectors file is run by the gateway copy. A differing root means two
  // algorithms exist; fix the implementation, never the vector. Changing a vector = deliberate domain bump.
  it("CONFORMANCE CORPUS: every vector in composition-commitment.vectors.json reproduces byte-exact", () => {
    expect(vectors.domains).toMatchObject({ composition: COMPOSITION_DOMAIN, contract: CONTRACT_DOMAIN });
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors.vectors) {
      const version = ((v as { version?: number }).version ?? 2) as 2 | 3;
      const r = deriveCompositionCommitment(v.dag as MatchedDAG, { version });
      expect(r.committable, v.name).toBe(true);
      if (r.committable) {
        expect(r.compositionRoot, `${v.name}: compositionRoot`).toBe(v.compositionRoot);
        expect(r.capabilityContractRoot, `${v.name}: capabilityContractRoot`).toBe(v.capabilityContractRoot);
      }
      expect(deriveCapabilityContractRoot(v.dag as MatchedDAG, { version }), `${v.name}: standalone contract root`).toBe(v.capabilityContractRoot);
    }
    // the in-file fixtures ARE the first two vectors — keep them in lockstep
    const p = deriveCompositionCommitment(pizza);
    const m = deriveCompositionCommitment(mixed);
    if (p.committable) expect(p.compositionRoot).toBe(vectors.vectors[0].compositionRoot);
    if (m.committable) expect(m.compositionRoot).toBe(vectors.vectors[1].compositionRoot);
  });
});

describe("v3: payer-authorized verification-program pinning (astra R5 item 1, #1633)", () => {
  const base = (vectors.vectors[0] as { dag: MatchedDAG }).dag;
  const PROG = "0x" + "ab".repeat(32);
  const pinned: MatchedDAG = { ...base, verificationProgramHash: PROG };

  it("v2 REFUSES a program-carrying plan — a selection can never be silently dropped", () => {
    expect(() => deriveCapabilityContractRoot(pinned)).toThrow(/requires \{ version: 3 \}/);
    const r = deriveCompositionCommitment(pinned);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.violations.join(" ")).toMatch(/requires \{ version: 3 \}/);
  });

  it("v3 pinned vs v3 unpinned vs v2: all three contract roots AND composition roots are pairwise distinct (a stripped selection always changes the root)", () => {
    const v2 = deriveCompositionCommitment(base);
    const v3u = deriveCompositionCommitment(base, { version: 3 });
    const v3p = deriveCompositionCommitment(pinned, { version: 3 });
    expect(v2.committable && v3u.committable && v3p.committable).toBe(true);
    if (v2.committable && v3u.committable && v3p.committable) {
      const contracts = [v2.capabilityContractRoot, v3u.capabilityContractRoot, v3p.capabilityContractRoot];
      const compositions = [v2.compositionRoot, v3u.compositionRoot, v3p.compositionRoot];
      expect(new Set(contracts).size).toBe(3);
      expect(new Set(compositions).size).toBe(3);
    }
  });

  it("v3 is deterministic and case-normalizes the program hash; a malformed hash is refused by name", () => {
    const upper = deriveCompositionCommitment({ ...base, verificationProgramHash: PROG.toUpperCase().replace("0X", "0x") }, { version: 3 });
    const lower = deriveCompositionCommitment(pinned, { version: 3 });
    expect(upper).toEqual(lower);
    const bad = deriveCompositionCommitment({ ...base, verificationProgramHash: "not-a-hash" }, { version: 3 });
    expect(bad.committable).toBe(false);
    if (!bad.committable) expect(bad.violations.join(" ")).toMatch(/verificationProgramHash: must be 0x/);
  });

  it("substitution opener: differing ONLY in the program is NOT operator substitution, and pinned-vs-stripped lands in different domains (sameContract false)", () => {
    const otherProg = { ...base, verificationProgramHash: "0x" + "cd".repeat(32) };
    const progOnly = explainSubstitution(pinned, otherProg);
    expect(progOnly.sameContract).toBe(false);
    expect(progOnly.pureOperatorSubstitution).toBe(false);
    expect(progOnly.differingFields).toContainEqual({ nodeId: null, field: "verificationProgramHash" });
    const stripped = explainSubstitution(pinned, base);
    expect(stripped.sameContract).toBe(false);
    expect(stripped.pureOperatorSubstitution).toBe(false);
  });
});

describe("v3: negotiated payout wallet — operatorSettlementAddress (#1690)", () => {
  const base = (vectors.vectors[0] as { dag: MatchedDAG }).dag;
  const PROG = "0x" + "ab".repeat(32);
  const WALLET = "0x" + "42".repeat(20);
  const withWallet = (w: string): MatchedDAG => ({
    ...base,
    verificationProgramHash: PROG,
    nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, operatorSettlementAddress: w } : n)),
  });

  it("v2 REFUSES a wallet-carrying plan — the negotiated destination can never be silently dropped", () => {
    const plain = { ...base, nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, operatorSettlementAddress: WALLET } : n)) };
    expect(() => deriveCapabilityContractRoot(plain)).toThrow(/operatorSettlementAddress: requires \{ version: 3 \}/);
    const r = deriveCompositionCommitment(plain);
    expect(r.committable).toBe(false);
    if (!r.committable) expect(r.violations.join(" ")).toMatch(/operatorSettlementAddress: requires/);
  });

  it("the wallet moves ONLY the composition root: contract root is byte-identical with and without it (provider-bound, buyer-agnostic)", () => {
    const withoutW = deriveCompositionCommitment({ ...base, verificationProgramHash: PROG }, { version: 3 });
    const withW = deriveCompositionCommitment(withWallet(WALLET), { version: 3 });
    expect(withoutW.committable && withW.committable).toBe(true);
    if (withoutW.committable && withW.committable) {
      expect(withW.capabilityContractRoot).toBe(withoutW.capabilityContractRoot);
      expect(withW.compositionRoot).not.toBe(withoutW.compositionRoot);
    }
  });

  it("case-normalized in preimage AND opener; malformed address refused by name", () => {
    const lower = deriveCompositionCommitment(withWallet(WALLET), { version: 3 });
    const upper = deriveCompositionCommitment(withWallet(WALLET.toUpperCase().replace("0X", "0x")), { version: 3 });
    expect(upper).toEqual(lower);
    const bad = deriveCompositionCommitment(withWallet("0xnope"), { version: 3 });
    expect(bad.committable).toBe(false);
    if (!bad.committable) expect(bad.violations.join(" ")).toMatch(/operatorSettlementAddress must be 0x \+ 40 hex/);
  });

  it("opener: two operators differing in digest + wallet is STILL pure operator substitution (the wallet is a provider binding)", () => {
    const opA = withWallet(WALLET);
    const opB: MatchedDAG = {
      ...opA,
      nodes: opA.nodes.map((n, i) =>
        i === 0 ? { ...n, matchedCapabilityDigest: "0x" + "ee".repeat(32), operatorSettlementAddress: "0x" + "99".repeat(20) } : n,
      ),
    };
    const rep = explainSubstitution(opA, opB);
    expect(rep.sameContract).toBe(true);
    expect(rep.pureOperatorSubstitution).toBe(true);
    expect(rep.differingFields.map((f) => f.field).sort()).toEqual(["matchedCapabilityDigest", "operatorSettlementAddress"]);
  });
});
