import { describe, it, expect } from "vitest";
import {
  compileAcceptedPlan,
  canonicalTopologicalOrder,
  unitEconomics,
  payoutsConserve,
  baseUnitsToCanonicalDecimal,
  stepIdBytes32,
  tierFromKey,
  MAX_UNITS_PER_JOB,
  COMPOSITION_SCHEMA_VERSION,
  type AcceptedPlanInput,
  type AcceptedPlanNode,
  type ProgramGate,
  type CompileViolation,
  type CompileDeps,
} from "./accepted-plan-compiler.js";
import { deriveCompositionCommitment } from "./composition-commitment.js";
import { acceptedDealDigest, SETTLEMENT_TOKEN_DECIMALS, type NetSplitter } from "./accepted-plan-compiler.js";

const ADDR = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const DIG = (b: string) => `0x${b.repeat(32)}`;
const PAYER = ADDR("11");
const OP_A = ADDR("aa");
const OP_B = ADDR("bb");
const PROGRAM_T2 = DIG("d2");
const USDC = 1_000_000n; // 6 decimals

function node(partial: Partial<AcceptedPlanNode> & { nodeId: string }): AcceptedPlanNode {
  return {
    capabilityId: `cap-${partial.nodeId}`,
    capabilityType: "document-printing",
    csd: "document-print-and-mail",
    tierKey: "tier0",
    operator: OP_A,
    payoutAddress: ADDR("a1"),
    grossBaseUnits: 10n * USDC,
    matchedCapabilityDigest: DIG("0c"),
    committedProgramHash: null,
    evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }],
    ...partial,
  };
}

function plan(partial: Partial<AcceptedPlanInput> = {}): AcceptedPlanInput {
  return {
    planId: "plan-1",
    requestId: "req-1",
    payer: PAYER,
    currency: "USDC",
    feeBps: 0,
    feeRecipient: ADDR("00"),
    reclaimAt: 1_900_000_000n,
    nodes: [node({ nodeId: "print" }), node({ nodeId: "mail", capabilityType: "mail.drop" })],
    edges: [{ from: "print", to: "mail" }],
    reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 100n * USDC },
    ...partial,
  };
}

/** A stand-in for evidence's assertAcceptedProgramForTier: one program per (csd, tier2). */
const gate: ProgramGate = ({ csd, tierKey, committedProgramHash }) =>
  csd === "document-print-and-mail" && tierKey === "tier2" && committedProgramHash?.toLowerCase() === PROGRAM_T2
    ? { ok: true }
    : { ok: false, code: "program-hash-mismatch" };

function codes(r: { ok: false; violations: CompileViolation[] }): string[] {
  return r.violations.map((x) => x.code);
}

describe("accepted-plan compiler — happy paths", () => {
  it("one operator -> one job; units in topological order; exact economics; the v3 root echoed into every unit", () => {
    const r = compileAcceptedPlan(plan({ feeBps: 235, feeRecipient: ADDR("fe") }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.jobs).toHaveLength(1);
    const job = r.plan.jobs[0]!;
    expect(job.operator).toBe(OP_A);
    expect(job.payer).toBe(PAYER);
    expect(job.nodeIds).toEqual(["print", "mail"]); // print -> mail, even though "mail" < "print"
    const u0 = job.units[0]!;
    expect(u0.milestoneIndex).toBe(0n);
    expect(u0.g).toBe(10_000_000n);
    expect(u0.f).toBe(235_000n); // floor(10_000_000 * 235 / 10_000)
    expect(u0.n).toBe(9_765_000n);
    expect(u0.payouts).toEqual([{ recipient: ADDR("a1"), amount: 9_765_000n }]);
    expect(u0.compositionSchemaVersion).toBe(COMPOSITION_SCHEMA_VERSION);
    expect(job.units.every((u) => u.compositionRoot === r.plan.compositionRoot)).toBe(true);
    expect(r.plan.totalObligationBaseUnits).toBe(20_000_000n);
    expect(r.plan.nodeToUnit.map((b) => [b.nodeId, b.jobIndex, b.milestoneIndex])).toEqual([
      ["print", 0, 0],
      ["mail", 0, 1],
    ]);
  });

  it("MULTI-OPERATOR: one V-next job per operator, each paying only its own nodes' wallets", () => {
    const r = compileAcceptedPlan(
      plan({
        nodes: [
          node({ nodeId: "print", operator: OP_A, payoutAddress: ADDR("a1") }),
          node({ nodeId: "mail", operator: OP_B, payoutAddress: ADDR("b1") }),
          node({ nodeId: "proof", operator: OP_A, payoutAddress: ADDR("a2") }),
        ],
        edges: [
          { from: "print", to: "mail" },
          { from: "mail", to: "proof" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.jobs.map((j) => j.operator)).toEqual([OP_A, OP_B]); // sorted by operator address
    expect(r.plan.jobs[0]!.nodeIds).toEqual(["print", "proof"]);
    expect(r.plan.jobs[1]!.nodeIds).toEqual(["mail"]);
    const recipientsA = r.plan.jobs[0]!.units.flatMap((u) => u.payouts.map((p) => p.recipient));
    expect(recipientsA).toEqual([ADDR("a1"), ADDR("a2")]);
    expect(r.plan.jobs[1]!.units[0]!.payouts[0]!.recipient).toBe(ADDR("b1"));
    // milestoneIndex restarts per job
    expect(r.plan.jobs[0]!.units.map((u) => u.milestoneIndex)).toEqual([0n, 1n]);
    expect(r.plan.jobs[1]!.units.map((u) => u.milestoneIndex)).toEqual([0n]);
    expect(r.plan.jobs.map((j) => j.jobId)).toEqual([`plan-1:${OP_A}`, `plan-1:${OP_B}`]);
  });

  it("the compositionRoot is the v3 derivation over the SAME plan bytes (one algorithm, not two)", () => {
    const r = compileAcceptedPlan(plan());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const direct = deriveCompositionCommitment(
      {
        requestId: "req-1",
        nodes: [
          { nodeId: "print", capabilityType: "document-printing", matchStatus: "matched", matchedCapabilityDigest: DIG("0c"), matchedCapabilityId: "cap-print", estimatedCost: "10", currency: "USDC", operatorSettlementAddress: ADDR("a1"), evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }] },
          { nodeId: "mail", capabilityType: "mail.drop", matchStatus: "matched", matchedCapabilityDigest: DIG("0c"), matchedCapabilityId: "cap-mail", estimatedCost: "10", currency: "USDC", operatorSettlementAddress: ADDR("a1"), evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }] },
        ],
        edges: [{ from: "print", to: "mail" }],
      },
      { version: 3 },
    );
    expect(direct.committable).toBe(true);
    if (direct.committable) {
      expect(r.plan.compositionRoot).toBe(direct.compositionRoot);
      expect(r.plan.capabilityContractRoot).toBe(direct.capabilityContractRoot);
    }
  });

  it("a non-zero tier compiles only through the program gate, and the program lands in the root", () => {
    const tiered = plan({ nodes: [node({ nodeId: "pm", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] });
    const r = compileAcceptedPlan(tiered, { assertProgramForTier: gate });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.jobs[0]!.units[0]!.requiredTier).toBe(2);
    expect(r.plan.jobs[0]!.units[0]!.requestedTier).toBe(2);
    expect(r.plan.nodeToUnit[0]!.committedProgramHash).toBe(PROGRAM_T2);
    // the same plan without the program would commit a different root (program is committed)
    const tier0 = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "pm" })], edges: [] }));
    expect(tier0.ok && tier0.plan.compositionRoot !== r.plan.compositionRoot).toBe(true);
  });
});

describe("accepted-plan compiler — determinism (settlement order is independent of LLM array order)", () => {
  const nodes = [
    node({ nodeId: "a", operator: OP_B }),
    node({ nodeId: "b" }),
    node({ nodeId: "c", operator: OP_B }),
    node({ nodeId: "d" }),
    node({ nodeId: "e" }),
  ];
  const edges = [
    { from: "e", to: "a" },
    { from: "d", to: "b" },
    { from: "b", to: "c" },
  ];

  it("every permutation of nodes and edges compiles to byte-identical output", () => {
    const base = compileAcceptedPlan(plan({ nodes, edges }));
    expect(base.ok).toBe(true);
    const perms: [AcceptedPlanNode[], typeof edges][] = [
      [[...nodes].reverse(), [...edges].reverse()],
      [[nodes[2]!, nodes[0]!, nodes[4]!, nodes[1]!, nodes[3]!], [edges[1]!, edges[2]!, edges[0]!]],
    ];
    for (const [n, e] of perms) {
      expect(compileAcceptedPlan(plan({ nodes: n, edges: e }))).toEqual(base);
    }
  });

  it("compiling the same accepted plan twice is idempotent (same units, same unit ids downstream)", () => {
    expect(compileAcceptedPlan(plan())).toEqual(compileAcceptedPlan(plan()));
  });

  it("topological constraints beat alphabetical order", () => {
    expect(canonicalTopologicalOrder(["a", "z"], [{ from: "z", to: "a" }])).toEqual(["z", "a"]);
    expect(canonicalTopologicalOrder(["b", "a", "c"], [])).toEqual(["a", "b", "c"]);
    expect(canonicalTopologicalOrder(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toBeNull();
  });
});

describe("accepted-plan compiler — REQUIRED negative controls", () => {
  it("total compiled obligation exceeds the reservation -> refused", () => {
    const r = compileAcceptedPlan(plan({ reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 20n * USDC - 1n } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("obligation-exceeds-reservation");
    // exactly at the reservation is allowed
    const at = compileAcceptedPlan(plan({ reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 20n * USDC } }));
    expect(at.ok).toBe(true);
  });

  it("a reservation issued for request A cannot fund a plan for request B", () => {
    const r = compileAcceptedPlan(plan({ reservation: { reservationId: "resv-1", requestId: "req-OTHER", currency: "USDC", maxAmountBaseUnits: 100n * USDC } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("reservation-request-mismatch");
  });

  it("a reservation in another currency cannot fund the plan", () => {
    const r = compileAcceptedPlan(plan({ reservation: { reservationId: "resv-1", requestId: "req-1", currency: "EURC", maxAmountBaseUnits: 100n * USDC } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("currency-mismatch");
  });

  it("caller chooses an unapproved verification program -> refused by the gate", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "pm", tierKey: "tier2", committedProgramHash: DIG("66") })], edges: [] }), { assertProgramForTier: gate });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContainEqual({ code: "program-gate-refused", nodeId: "pm", reason: "program-hash-mismatch" });
  });

  it("a non-zero tier with NO gate injected is refused (the gate cannot be skipped by omission)", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "pm", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("program-gate-missing");
  });

  it("tier 0 carrying a program is refused (assurance cannot be claimed without its tier)", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "pm", committedProgramHash: PROGRAM_T2 })], edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("program-on-tier-zero");
  });

  it("two DIFFERENT programs in one plan are refused under v3, never silently collapsed to one", () => {
    const openGate: ProgramGate = () => ({ ok: true });
    const r = compileAcceptedPlan(
      plan({
        nodes: [
          node({ nodeId: "x", tierKey: "tier2", committedProgramHash: DIG("d2") }),
          node({ nodeId: "y", tierKey: "tier2", committedProgramHash: DIG("d3") }),
        ],
        edges: [],
      }),
      { assertProgramForTier: openGate },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("mixed-programs-not-committable-v3");
  });

  it("a duplicated node is refused (one node can never yield two units, so no double obligation)", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "print" }), node({ nodeId: "print" })], edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("duplicate-node");
  });

  it("a cycle, a self-loop, an unknown edge endpoint and a duplicate edge are all refused", () => {
    const cyc = compileAcceptedPlan(plan({ edges: [{ from: "print", to: "mail" }, { from: "mail", to: "print" }] }));
    expect(cyc.ok === false && codes(cyc).includes("cycle")).toBe(true);
    const self = compileAcceptedPlan(plan({ edges: [{ from: "print", to: "print" }] }));
    expect(self.ok === false && codes(self).includes("self-loop")).toBe(true);
    const unk = compileAcceptedPlan(plan({ edges: [{ from: "print", to: "ghost" }] }));
    expect(unk.ok === false && codes(unk).includes("edge-unknown-node")).toBe(true);
    const dup = compileAcceptedPlan(plan({ edges: [{ from: "print", to: "mail" }, { from: "print", to: "mail" }] }));
    expect(dup.ok === false && codes(dup).includes("duplicate-edge")).toBe(true);
  });

  it(`more than ${MAX_UNITS_PER_JOB} units for one operator is refused, never truncated or silently split`, () => {
    const many = Array.from({ length: MAX_UNITS_PER_JOB + 1 }, (_, i) => node({ nodeId: `n${String(i).padStart(2, "0")}`, grossBaseUnits: USDC }));
    const r = compileAcceptedPlan(plan({ nodes: many, edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("too-many-units-for-operator");
    const ok = compileAcceptedPlan(plan({ nodes: many.slice(0, MAX_UNITS_PER_JOB), edges: [] }));
    expect(ok.ok).toBe(true);
  });

  it("operator == payer is refused (the escrow requires operator != payer)", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", operator: PAYER })], edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("operator-is-payer");
  });

  it("fee rules: feeBps>0 needs a recipient, feeBps==0 needs the zero recipient, feeBps>1000 is out of range", () => {
    const a = compileAcceptedPlan(plan({ feeBps: 100, feeRecipient: ADDR("00") }));
    expect(a.ok === false && codes(a).includes("fee-recipient-missing")).toBe(true);
    const b = compileAcceptedPlan(plan({ feeBps: 0, feeRecipient: ADDR("fe") }));
    expect(b.ok === false && codes(b).includes("fee-recipient-must-be-zero")).toBe(true);
    const c = compileAcceptedPlan(plan({ feeBps: 1001, feeRecipient: ADDR("fe") }));
    expect(c.ok === false && codes(c).includes("fee-bps-out-of-range")).toBe(true);
  });

  it("gross outside [5, 2^128-1] is refused", () => {
    const lo = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", grossBaseUnits: 4n })], edges: [] }));
    expect(lo.ok === false && codes(lo).includes("gross-out-of-range")).toBe(true);
    const hi = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", grossBaseUnits: 1n << 128n })], edges: [] }));
    expect(hi.ok === false && codes(hi).includes("gross-out-of-range")).toBe(true);
    const five = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", grossBaseUnits: 5n })], edges: [], reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 5n } }));
    expect(five.ok).toBe(true);
  });
});

describe("exact-economics primitives (R34 === conservation)", () => {
  it("unitEconomics floors the fee exactly as the escrow does", () => {
    expect(unitEconomics(7n, 1000)).toEqual({ g: 7n, f: 0n, n: 7n }); // floor(0.7)
    expect(unitEconomics(10_000n, 1000)).toEqual({ g: 10_000n, f: 1_000n, n: 9_000n });
    expect(unitEconomics(9_999n, 1)).toEqual({ g: 9_999n, f: 0n, n: 9_999n }); // floor(0.9999)
  });

  it("payoutsConserve is EXACT: over- and under-allocation by one base unit both fail", () => {
    const n = 976_500n;
    const r = ADDR("a1");
    expect(payoutsConserve([{ recipient: r, amount: n }], n)).toBe(true);
    expect(payoutsConserve([{ recipient: r, amount: n + 1n }], n)).toBe(false);
    expect(payoutsConserve([{ recipient: r, amount: n - 1n }], n)).toBe(false);
    expect(payoutsConserve([{ recipient: r, amount: 500_000n }, { recipient: r, amount: 476_500n }], n)).toBe(true);
  });

  it("no JS Number rounding: a 2^53+1 gross stays exact through compile", () => {
    const big = (1n << 53n) + 1n;
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", grossBaseUnits: big })], edges: [], reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: big } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.jobs[0]!.units[0]!.g).toBe(big);
      expect(r.plan.jobs[0]!.units[0]!.n).toBe(big);
    }
  });

  it("baseUnitsToCanonicalDecimal renders the v3 cost string canonically", () => {
    expect(baseUnitsToCanonicalDecimal(12_500_000n, 6)).toBe("12.5");
    expect(baseUnitsToCanonicalDecimal(12_000_000n, 6)).toBe("12");
    expect(baseUnitsToCanonicalDecimal(1n, 6)).toBe("0.000001");
    expect(baseUnitsToCanonicalDecimal(0n, 6)).toBe("0");
    expect(baseUnitsToCanonicalDecimal(42n, 0)).toBe("42");
  });
});

describe("identity helpers", () => {
  it("stepIdBytes32 is keccak256(utf8(nodeId)): 32 bytes, deterministic, distinct per node", () => {
    const a = stepIdBytes32("print");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stepIdBytes32("print")).toBe(a);
    expect(stepIdBytes32("mail")).not.toBe(a);
  });

  it("tierFromKey accepts tier0..tier3 only", () => {
    expect(tierFromKey("tier0")).toBe(0);
    expect(tierFromKey("tier3")).toBe(3);
    expect(tierFromKey("tier4")).toBeNull();
    expect(tierFromKey("TIER2")).toBeNull();
    expect(tierFromKey("2")).toBeNull();
    expect(tierFromKey(["tier2"])).toBeNull(); // no RegExp coercion of non-strings
  });
});

describe("cross-family review of #351 (sol + astra): every settlement term is sealed", () => {
  const openGate: ProgramGate = () => ({ ok: true });
  const deal = (p: AcceptedPlanInput, g: ProgramGate = gate) => {
    const r = compileAcceptedPlan(p, { assertProgramForTier: g });
    if (!r.ok) throw new Error(JSON.stringify(r.violations));
    return r.plan;
  };

  it("TIER: swapping which node is tier2 keeps the PLAN root but changes the sealed deal digest", () => {
    const a = deal(plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 }), node({ nodeId: "y" })], edges: [] }));
    const b = deal(plan({ nodes: [node({ nodeId: "x" }), node({ nodeId: "y", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] }));
    // The v3 compositionRoot commits the plan (contract, providers, prices, wallets, program) — not unit tiers:
    expect(a.compositionRoot).toBe(b.compositionRoot);
    // ...so the tier is sealed by the accepted-deal digest instead:
    expect(a.acceptedDealDigest).not.toBe(b.acceptedDealDigest);
    expect(a.jobs[0]!.units.map((u) => u.requiredTier)).toEqual([2, 0]);
    expect(b.jobs[0]!.units.map((u) => u.requiredTier)).toEqual([0, 2]);
  });

  it("TIER, isolated (sol's counterexample): tier1 vs tier2 with the SAME program and nothing else different", () => {
    const t1 = deal(plan({ nodes: [node({ nodeId: "x", tierKey: "tier1", committedProgramHash: PROGRAM_T2 })], edges: [] }), openGate);
    const t2 = deal(plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] }), openGate);
    expect(t1.compositionRoot).toBe(t2.compositionRoot); // the plan root does not carry the unit tier
    expect(t1.jobs[0]!.units[0]!.requiredTier).toBe(1);
    expect(t2.jobs[0]!.units[0]!.requiredTier).toBe(2);
    expect(t1.acceptedDealDigest).not.toBe(t2.acceptedDealDigest); // ...the sealed deal does
  });

  it("FEE: changing the fee changes every net payout and the sealed deal digest", () => {
    const a = deal(plan());
    const b = deal(plan({ feeBps: 1000, feeRecipient: ADDR("fe") }));
    expect(a.compositionRoot).toBe(b.compositionRoot);
    expect(a.acceptedDealDigest).not.toBe(b.acceptedDealDigest);
    expect(b.jobs[0]!.units[0]!.n).toBe(9_000_000n);
  });

  it("OPERATOR: re-assigning the signing operator (same payout wallets) changes the sealed deal digest", () => {
    const a = deal(plan());
    const b = deal(plan({ nodes: [node({ nodeId: "print" }), node({ nodeId: "mail", capabilityType: "mail.drop", operator: OP_B })] }));
    expect(a.compositionRoot).toBe(b.compositionRoot); // same wallets, same plan
    expect(a.jobs).toHaveLength(1);
    expect(b.jobs).toHaveLength(2);
    expect(a.acceptedDealDigest).not.toBe(b.acceptedDealDigest);
  });

  it("DECIMALS are server-resolved: USDC is 6; an unknown currency is refused (no caller decimals to spoof)", () => {
    expect(SETTLEMENT_TOKEN_DECIMALS.USDC).toBe(6);
    const ok = deal(plan());
    expect(ok.currencyDecimals).toBe(6);
    const r = compileAcceptedPlan(plan({ currency: "EURC", reservation: { reservationId: "resv-1", requestId: "req-1", currency: "EURC", maxAmountBaseUnits: 100n * USDC } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("currency-not-settleable");
    // a prototype key is not a settlement token
    const proto = compileAcceptedPlan(plan({ currency: "CONSTRUCTOR" as string, reservation: { reservationId: "resv-1", requestId: "req-1", currency: "CONSTRUCTOR", maxAmountBaseUnits: 100n * USDC } }));
    expect(proto.ok === false && codes(proto).includes("currency-not-settleable")).toBe(true);
  });

  it("a non-zero tier with NO program hash is refused even when a permissive gate would approve it", () => {
    const r = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "pm", tierKey: "tier2", committedProgramHash: null })], edges: [] }), { assertProgramForTier: openGate });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toContain("program-required-for-tier");
  });

  it("rejection diagnostics are permutation-stable (sorted), not input-ordered", () => {
    const bad = [node({ nodeId: "a", grossBaseUnits: 4n }), node({ nodeId: "b", grossBaseUnits: 4n })];
    const r1 = compileAcceptedPlan(plan({ nodes: bad, edges: [] }));
    const r2 = compileAcceptedPlan(plan({ nodes: [...bad].reverse(), edges: [] }));
    expect(r1.ok).toBe(false);
    expect(r1).toEqual(r2);
  });

  it("DUPLICATES (astra's confirmation counterexample): the diagnostics do not depend on which duplicate comes first", () => {
    const bad = node({ nodeId: "x", grossBaseUnits: 4n });
    const good = node({ nodeId: "x", grossBaseUnits: 10n * USDC });
    const r1 = compileAcceptedPlan(plan({ nodes: [bad, good], edges: [] }));
    const r2 = compileAcceptedPlan(plan({ nodes: [good, bad], edges: [] }));
    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(codes(r1)).toEqual(["duplicate-node", "gross-out-of-range"]);
    const three = compileAcceptedPlan(plan({ nodes: [good, good, good], edges: [] }));
    expect(three.ok).toBe(false);
    if (!three.ok) expect(codes(three)).toEqual(["duplicate-node"]); // once per id, not per extra copy
  });

  it("malformed runtime input gets a typed rejection, never a throw", () => {
    const junk: AcceptedPlanInput[] = [
      plan({ nodes: [node({ nodeId: "p", operator: 42 as unknown as `0x${string}` })], edges: [] }),
      plan({ nodes: [Object.create(null) as AcceptedPlanNode], edges: [] }),
      plan({ nodes: [{ ...node({ nodeId: "p" }), nodeId: Object.create(null) as string }], edges: [] }), // String() of it throws
      plan({ edges: [{ from: Object.create(null) as string, to: "mail" }] }),
      plan({ nodes: null as unknown as AcceptedPlanNode[] }),
      plan({ reservation: null as unknown as AcceptedPlanInput["reservation"] }),
    ];
    for (const p of junk) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = compileAcceptedPlan(p);
      }).not.toThrow();
      expect(r?.ok).toBe(false);
    }
  });

  it("pattern checks do not coerce: an array that stringifies to a valid id, currency or tier is refused", () => {
    const cases: Array<[AcceptedPlanInput, string]> = [
      [plan({ planId: ["plan-1"] as unknown as string }), "invalid-plan-field"],
      [plan({ currency: ["USDC"] as unknown as string }), "invalid-plan-field"],
      [plan({ nodes: [node({ nodeId: ["p"] as unknown as string })], edges: [] }), "invalid-node-id"],
      [plan({ nodes: [node({ nodeId: "p", tierKey: ["tier0"] as unknown as string })], edges: [] }), "invalid-tier"],
    ];
    for (const [p, code] of cases) {
      const r = compileAcceptedPlan(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r)).toContain(code);
    }
  });

  it("the deal digest is a pure function of the compiled deal (recomputable by any holder)", () => {
    const d = deal(plan({ feeBps: 235, feeRecipient: ADDR("fe") }));
    const { acceptedDealDigest: sealed, ...rest } = d;
    expect(acceptedDealDigest(rest)).toBe(sealed);
    expect(sealed).toMatch(/^0x[0-9a-f]{64}$/);
    // one base unit anywhere changes it
    const tampered = { ...rest, jobs: rest.jobs.map((j, i) => (i === 0 ? { ...j, units: j.units.map((u, k) => (k === 0 ? { ...u, n: u.n - 1n } : u)) } : j)) };
    expect(acceptedDealDigest(tampered)).not.toBe(sealed);
  });
});

describe("economics split (R15): economics splits each unit's net; the compiler holds it to its own numbers", () => {
  const LICENSOR = ADDR("c1");
  const withSplit = (p: AcceptedPlanInput, splitNet: NetSplitter) => compileAcceptedPlan(p, { splitNet });
  /** A stand-in for economics' compileEconomics: 10% of each unit's net to a licensor, the rest to the payout address. */
  const tenPercent: NetSplitter = (units) => ({
    ok: true,
    agreementHash: DIG("A1"),
    economicTermsHash: DIG("E1"),
    rightsTermsHash: DIG("f1"),
    units: units.map((u) => {
      const royalty = u.n / 10n;
      return {
        unitRef: u.nodeId,
        gross: u.g.toString(),
        fee: u.f.toString(),
        net: u.n.toString(),
        payouts: [
          { recipient: u.payoutAddress, amount: (u.n - royalty).toString() },
          { recipient: LICENSOR, amount: royalty.toString() },
        ],
      };
    }),
  });
  const tweak = (f: (u: ReturnType<typeof tenPercentUnits>[number]) => object): NetSplitter => (units) => {
    const r = tenPercent(units);
    if (!r.ok) return r;
    return { ...r, units: r.units.map((u) => ({ ...u, ...f(u) })) };
  };
  const tenPercentUnits = (units: Parameters<NetSplitter>[0]) => {
    const r = tenPercent(units);
    if (!r.ok) throw new Error("x");
    return r.units;
  };
  const fee235 = plan({ feeBps: 235, feeRecipient: ADDR("fe") });

  it("splits each unit's net exactly, seals both terms hashes, and receives units in canonical order", () => {
    const seen: string[][] = [];
    const spy: NetSplitter = (units) => {
      seen.push(units.map((u) => u.nodeId));
      return tenPercent(units);
    };
    const r = withSplit(plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [...fee235.nodes].reverse() }), spy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toEqual([["print", "mail"]]); // canonical plan order, whatever order the planner listed
    const u0 = r.plan.jobs[0]!.units[0]!;
    expect(u0.payouts).toEqual([
      { recipient: ADDR("a1"), amount: 8_788_500n },
      { recipient: LICENSOR, amount: 976_500n },
    ]);
    expect(u0.payouts.reduce((a, p) => a + p.amount, 0n)).toBe(u0.n);
    expect(r.plan.agreementHash).toBe(DIG("a1")); // lowercased
    expect(r.plan.economicTermsHash).toBe(DIG("e1")); // lowercased
    expect(r.plan.rightsTermsHash).toBe(DIG("f1"));
    const plainDeal = compileAcceptedPlan(fee235);
    expect(plainDeal.ok).toBe(true);
    if (plainDeal.ok) {
      expect([plainDeal.plan.agreementHash, plainDeal.plan.economicTermsHash, plainDeal.plan.rightsTermsHash]).toEqual([null, null, null]);
    }
    if (plainDeal.ok) expect(r.plan.acceptedDealDigest).not.toBe(plainDeal.plan.acceptedDealDigest);
  });

  it("the terms hashes are sealed: a different economicTermsHash alone changes the deal digest", () => {
    const a = withSplit(fee235, tenPercent);
    const b = withSplit(fee235, (units) => ({ ...(tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>), economicTermsHash: DIG("e2") }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.plan.jobs).toEqual(a.plan.jobs); // same money...
      expect(b.plan.acceptedDealDigest).not.toBe(a.plan.acceptedDealDigest); // ...different terms, different deal
    }
  });

  it("the agreement hash is sealed (economics #2755): a different agreementHash alone — same money, same terms hashes — changes the deal digest", () => {
    const a = withSplit(fee235, tenPercent);
    const b = withSplit(fee235, (units) => ({ ...(tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>), agreementHash: DIG("a2") }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.plan.jobs).toEqual(a.plan.jobs);
      expect([b.plan.economicTermsHash, b.plan.rightsTermsHash]).toEqual([a.plan.economicTermsHash, a.plan.rightsTermsHash]);
      expect(b.plan.agreementHash).toBe(DIG("a2"));
      expect(b.plan.acceptedDealDigest).not.toBe(a.plan.acceptedDealDigest); // an envelope change (asOf, version) is a different deal
      const { acceptedDealDigest: sealed, ...rest } = a.plan;
      expect(acceptedDealDigest({ ...rest, agreementHash: DIG("a2") as `0x${string}` })).not.toBe(sealed);
      expect(acceptedDealDigest({ ...rest, agreementHash: null })).not.toBe(sealed);
      expect(acceptedDealDigest({ ...rest, agreementHash: DIG("A1") as `0x${string}` })).toBe(sealed); // hex case carries no meaning
    }
  });

  it("the agreement hash is required: missing, malformed or non-string is refused as malformed, on an otherwise COMPLETE answer", () => {
    const complete = (units: Parameters<NetSplitter>[0]) => tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
    const without: NetSplitter = (u) => {
      const { agreementHash: _dropped, ...rest } = complete(u);
      return rest as unknown as ReturnType<NetSplitter>;
    };
    const bad: unknown[] = [undefined, null, "", "0xabc", DIG("a1") + "\n", ` ${DIG("a1")}`, DIG("a1").slice(2), "0x" + "g".repeat(64), 42, {}, [DIG("a1")]];
    const cases: NetSplitter[] = [without, ...bad.map((h): NetSplitter => (u) => ({ ...complete(u), agreementHash: h as string }))];
    for (const split of cases) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = withSplit(fee235, split);
      }).not.toThrow();
      expect(r).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "agreement-hash" }] });
    }
  });

  it("the agreement hash is read exactly once: the validated value is the sealed value; a throwing getter is malformed", () => {
    const baseline = withSplit(fee235, tenPercent);
    if (!baseline.ok) throw new Error("setup");
    const reads: number[] = [];
    const flipping = (second: string): NetSplitter => (units) => {
      let n = 0;
      reads.push(0);
      return Object.defineProperty({ ...(tenPercent(units) as object) }, "agreementHash", {
        enumerable: true,
        get: () => {
          reads[reads.length - 1] = ++n;
          return n === 1 ? DIG("a1") : second;
        },
      }) as ReturnType<NetSplitter>;
    };
    for (const second of ["invalid", DIG("a2")]) {
      const r = withSplit(fee235, flipping(second));
      expect(r).toEqual(baseline); // the whole deal, digest included: the first (validated) read is what is sealed
    }
    expect(reads).toEqual([1, 1]);
    const throwing: NetSplitter = (units) =>
      Object.defineProperty({ ...(tenPercent(units) as object) }, "agreementHash", {
        enumerable: true,
        get: () => {
          throw new Error("boom");
        },
      }) as ReturnType<NetSplitter>;
    let r: ReturnType<typeof compileAcceptedPlan> | undefined;
    expect(() => {
      r = withSplit(fee235, throwing);
    }).not.toThrow();
    expect(r).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "result" }] });
  });

  /** A stand-in for option (b): the operator keeps exactly its quote's net; the licensor gets the rest of n. */
  const grossUp: NetSplitter = (units) => ({
    ok: true,
    agreementHash: DIG("a1"),
    economicTermsHash: DIG("e1"),
    rightsTermsHash: DIG("f1"),
    units: units.map((u) => {
      const own = u.quote - (u.quote * 235n) / 10_000n;
      const royalty = u.n - own;
      return {
        unitRef: u.nodeId,
        gross: u.g.toString(),
        fee: u.f.toString(),
        net: u.n.toString(),
        payouts: royalty > 0n ? [{ recipient: u.payoutAddress, amount: own.toString() }, { recipient: LICENSOR, amount: royalty.toString() }] : [{ recipient: u.payoutAddress, amount: u.n.toString() }],
      };
    }),
  });

  it("the operator's quote reaches the splitter (economics option b: royalties on top); without one it equals g", () => {
    const seen: Array<Array<{ nodeId: string; quote: bigint; g: bigint }>> = [];
    const spy: NetSplitter = (units) => {
      seen.push(units.map((u) => ({ nodeId: u.nodeId, quote: u.quote, g: u.g })));
      return grossUp(units);
    };
    const grossedUp = plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [node({ nodeId: "print", grossBaseUnits: 11n * USDC, quoteBaseUnits: 10n * USDC }), node({ nodeId: "mail", capabilityType: "mail.drop" })] });
    expect(withSplit(grossedUp, spy).ok).toBe(true);
    expect(seen[0]).toEqual([
      { nodeId: "print", quote: 10n * USDC, g: 11n * USDC },
      { nodeId: "mail", quote: 10n * USDC, g: 10n * USDC }, // no quote given: the quote IS the gross
    ]);
  });

  it("a quote above the gross, zero, negative or not a bigint is refused; exactly the gross is fine", () => {
    const at = (q: unknown) => compileAcceptedPlan(plan({ nodes: [node({ nodeId: "print", quoteBaseUnits: q as bigint }), node({ nodeId: "mail", capabilityType: "mail.drop" })] }));
    for (const q of [10n * USDC + 1n, 0n, -1n, 10, "10000000", null]) {
      const r = at(q);
      expect([q, r.ok === false && r.violations]).toEqual([q, [{ code: "invalid-node-field", nodeId: "print", field: "quoteBaseUnits" }]]);
    }
    expect(at(10n * USDC).ok).toBe(true);
  });

  it("the quote is read once, with the rest of the node: the splitter sees the value that was validated", () => {
    let reads = 0;
    const n = { ...node({ nodeId: "print", grossBaseUnits: 11n * USDC }) } as Record<string, unknown>;
    Object.defineProperty(n, "quoteBaseUnits", { enumerable: true, get: () => (reads++ === 0 ? 10n * USDC : 11n * USDC + 1n) });
    const quotes: bigint[] = [];
    const spy: NetSplitter = (units) => {
      quotes.push(...units.map((u) => u.quote));
      return grossUp(units);
    };
    const r = withSplit(plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [n as unknown as AcceptedPlanNode, node({ nodeId: "mail", capabilityType: "mail.drop" })] }), spy);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
    expect(quotes).toEqual([10n * USDC, 10n * USDC]);
  });

  it("reviewer-alpha #4: a quote that differs from the gross is refused WITHOUT an agreement; an equal one is fine", () => {
    const at = (q: bigint) => compileAcceptedPlan(plan({ nodes: [node({ nodeId: "print", grossBaseUnits: 11n * USDC, quoteBaseUnits: q }), node({ nodeId: "mail", capabilityType: "mail.drop" })] }));
    expect(at(10n * USDC)).toEqual({ ok: false, violations: [{ code: "quote-without-agreement", nodeId: "print" }] });
    expect(at(11n * USDC).ok).toBe(true);
  });

  it("reviewer-alpha #4: with an agreement, the operator's legs must carry at least its quote's net; the compiler checks it too", () => {
    const stingy: NetSplitter = (units) => {
      const r = grossUp(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return {
        ...r,
        units: r.units.map((u) => (u.unitRef === "print" ? { ...u, payouts: [{ recipient: ADDR("a1"), amount: "1" }, { recipient: LICENSOR, amount: (BigInt(u.net) - 1n).toString() }] } : u)),
      };
    };
    const p = plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [node({ nodeId: "print", grossBaseUnits: 11n * USDC, quoteBaseUnits: 10n * USDC }), node({ nodeId: "mail", capabilityType: "mail.drop" })] });
    expect(withSplit(p, stingy)).toEqual({ ok: false, violations: [{ code: "operator-below-quote", nodeId: "print" }] });
    expect(withSplit(p, grossUp).ok).toBe(true); // exactly the quote's net is enough
    // Addresses match case-insensitively: a checksummed payoutAddress paid at its lowercase spelling is paid.
    const lowerLegs: NetSplitter = (units) => {
      const r = grossUp(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return { ...r, units: r.units.map((u) => ({ ...u, payouts: u.payouts.map((l) => ({ ...l, recipient: l.recipient.toLowerCase() })) })) };
    };
    const mixed = plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [node({ nodeId: "print", payoutAddress: ADDR("A1"), grossBaseUnits: 11n * USDC, quoteBaseUnits: 10n * USDC }), node({ nodeId: "mail", capabilityType: "mail.drop" })] });
    expect(withSplit(mixed, lowerLegs).ok).toBe(true);
  });

  it("reviewer-alpha #3b: a lying payouts length never puts an unsafe integer into the diagnostics", () => {
    const lying: NetSplitter = (units) => {
      const r = tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return { ...r, units: r.units.map((u) => ({ ...u, payouts: new Proxy([], { get: (t, k) => (k === "length" ? 2 ** 53 : Reflect.get(t, k)) }) as unknown as typeof u.payouts })) };
    };
    const r = withSplit(fee235, lying);
    expect(r.ok === false && r.violations.map((v) => (v as { count?: number }).count)).toEqual([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  });

  it("an economics refusal is a compile refusal", () => {
    const r = withSplit(fee235, () => ({ ok: false, code: "license-incompatible" }));
    expect(r.ok === false && r.violations).toEqual([{ code: "economics-refused", reason: "license-incompatible" }]);
  });

  it("economics that disagrees with the compiler's gross/fee/net is refused, never adopted", () => {
    const r = withSplit(fee235, tweak((u) => ({ fee: (BigInt(u.fee) + 1n).toString() })));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toEqual([
        { code: "economics-mismatch", nodeId: "mail", field: "fee" },
        { code: "economics-mismatch", nodeId: "print", field: "fee" },
      ]); // one per unit, each named
    }
    const g = withSplit(fee235, tweak((u) => ({ gross: `${u.gross}0` })));
    expect(g.ok === false && g.violations.every((v) => v.code === "economics-mismatch")).toBe(true);
  });

  it("exactly the plan's units: a missing, extra or duplicated unit is refused", () => {
    const drop: NetSplitter = (units) => {
      const r = tenPercent(units);
      return r.ok ? { ...r, units: r.units.slice(1) } : r;
    };
    const extra: NetSplitter = (units) => {
      const r = tenPercent(units);
      return r.ok ? { ...r, units: [...r.units, { ...r.units[0]!, unitRef: "ghost" }] } : r;
    };
    const dup: NetSplitter = (units) => {
      const r = tenPercent(units);
      return r.ok ? { ...r, units: [r.units[0]!, r.units[0]!] } : r; // same cardinality, one ref twice
    };
    expect(withSplit(fee235, drop)).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "unit-set" }] });
    expect(withSplit(fee235, extra)).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "unit-set" }] });
    expect(withSplit(fee235, dup)).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "unit-ref" }] });
  });

  it("legs must conserve EXACTLY: one base unit over or under is refused", () => {
    for (const delta of [1n, -1n]) {
      const r = withSplit(fee235, tweak((u) => ({ payouts: [u.payouts[0]!, { ...u.payouts[1]!, amount: (BigInt(u.payouts[1]!.amount) + delta).toString() }] })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r)).toEqual(["payout-sum-mismatch", "payout-sum-mismatch"]); // every unit reported, not just the first
    }
  });

  it("a leg to the zero address, a zero or fractional or non-string amount, or more than 16 legs is refused", () => {
    const bad = [
      { recipient: ADDR("00"), amount: "1" },
      { recipient: LICENSOR, amount: "0" },
      { recipient: LICENSOR, amount: "1.5" },
      { recipient: LICENSOR, amount: 5 as unknown as string },
      { recipient: "0x1234", amount: "1" },
    ];
    for (const leg of bad) {
      const r = withSplit(fee235, tweak((u) => ({ payouts: [...u.payouts, leg] })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r)).toContain("invalid-payout-leg");
    }
    const many = withSplit(fee235, tweak((u) => ({ payouts: Array.from({ length: 17 }, () => ({ recipient: LICENSOR, amount: "1" })) })));
    expect(many.ok === false && codes(many)).toEqual(["too-many-payout-legs", "too-many-payout-legs"]);
  });

  it("malformed economics output is refused, never a throw — bad hashes tested on an otherwise COMPLETE answer", () => {
    const complete = (units: Parameters<NetSplitter>[0]) => tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
    const cases: Array<[NetSplitter, string]> = [
      [() => null as unknown as ReturnType<NetSplitter>, "result"],
      [() => ({ ok: "yes" }) as unknown as ReturnType<NetSplitter>, "result"],
      [(u) => ({ ...complete(u), economicTermsHash: "0xabc" }), "terms-hash"],
      [(u) => ({ ...complete(u), rightsTermsHash: DIG("f1") + "\n" }), "terms-hash"],
      [(u) => ({ ...complete(u), units: "x" as unknown as [] }), "units"],
    ];
    for (const [split, detail] of cases) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = withSplit(fee235, split);
      }).not.toThrow();
      expect(r).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail }] });
    }
  });

  it("astra: a getter that grows the payouts array cannot smuggle a 17th leg past the cap", () => {
    const grow: NetSplitter = (units) => {
      const r = tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return {
        ...r,
        units: r.units.map((u) => {
          const legs: Array<{ recipient: string; amount: string }> = [];
          const first = {
            get recipient() {
              for (let i = 0; i < 16; i++) legs.push({ recipient: LICENSOR, amount: "1" }); // grows mid-read
              return ADDR("a1");
            },
            amount: (BigInt(u.net) - 16n).toString(),
          };
          legs.push(first as { recipient: string; amount: string });
          return { ...u, payouts: legs };
        }),
      };
    };
    const r = withSplit(fee235, grow);
    expect(r.ok).toBe(false); // only the leg that existed when the length was read is considered: n-16 != n
    if (!r.ok) expect(codes(r)).toEqual(["payout-sum-mismatch", "payout-sum-mismatch"]);
  });

  it("astra: a hash getter is read exactly once; the validated value is the sealed value", () => {
    let reads = 0;
    const flip: NetSplitter = (units) => {
      const r = tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return Object.defineProperty({ ...r }, "economicTermsHash", {
        enumerable: true,
        get: () => (reads++ === 0 ? DIG("e1") : "invalid"),
      });
    };
    const r = withSplit(fee235, flip);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.economicTermsHash).toBe(DIG("e1"));
  });

  it("astra: throwing getters and proxies in the ANSWER are refused as malformed; a throwing SPLITTER is a server fault and propagates", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const answers: unknown[] = [
      Object.defineProperty({}, "ok", { get: boom }),
      Object.defineProperty({ ok: false }, "code", { get: boom }),
      new Proxy({}, { get: boom }),
      { ok: true, agreementHash: DIG("a1"), economicTermsHash: DIG("e1"), rightsTermsHash: DIG("f1"), units: [Object.defineProperty({}, "unitRef", { get: boom })] },
      { ok: true, agreementHash: DIG("a1"), economicTermsHash: DIG("e1"), rightsTermsHash: DIG("f1"), units: new Proxy([], { get: (t, k) => (k === "length" ? 2 : boom()) }) },
    ];
    for (const a of answers) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = withSplit(fee235, () => a as ReturnType<NetSplitter>);
      }).not.toThrow();
      expect(r).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "result" }] });
    }
    expect(() => withSplit(fee235, boom as unknown as NetSplitter)).toThrow("boom");
  });

  it("every split term is sealed on its own: rights hash, recipient, amount and leg order each change the digest; unit order does not", () => {
    const base = withSplit(fee235, tenPercent);
    if (!base.ok) throw new Error("setup");
    const digestOf = (split: NetSplitter) => {
      const r = withSplit(fee235, split);
      if (!r.ok) throw new Error(JSON.stringify(r.violations));
      return r.plan.acceptedDealDigest;
    };
    const rightsOnly: NetSplitter = (u) => ({ ...(tenPercent(u) as Extract<ReturnType<NetSplitter>, { ok: true }>), rightsTermsHash: DIG("f2") });
    const agreementOnly: NetSplitter = (u) => ({ ...(tenPercent(u) as Extract<ReturnType<NetSplitter>, { ok: true }>), agreementHash: DIG("b2") });
    const recipientOnly = tweak((u) => ({ payouts: [u.payouts[0]!, { ...u.payouts[1]!, recipient: ADDR("c2") }] }));
    const amountOnly = tweak((u) => ({ payouts: [{ ...u.payouts[0]!, amount: (BigInt(u.payouts[0]!.amount) - 1n).toString() }, { ...u.payouts[1]!, amount: (BigInt(u.payouts[1]!.amount) + 1n).toString() }] }));
    const orderOnly = tweak((u) => ({ payouts: [u.payouts[1]!, u.payouts[0]!] }));
    const unitsReversed: NetSplitter = (u) => {
      const r = tenPercent(u) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return { ...r, units: [...r.units].reverse() };
    };
    for (const s of [rightsOnly, agreementOnly, recipientOnly, amountOnly, orderOnly]) expect(digestOf(s)).not.toBe(base.plan.acceptedDealDigest);
    expect(digestOf(unitsReversed)).toBe(base.plan.acceptedDealDigest);
    // with UNEQUAL units, a positional (not by-reference) match would put print's legs on mail
    const uneven = plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [node({ nodeId: "print" }), node({ nodeId: "mail", capabilityType: "mail.drop", grossBaseUnits: 3n * USDC })] });
    const inOrder = withSplit(uneven, tenPercent);
    const reversed = withSplit(uneven, unitsReversed);
    expect(inOrder.ok && reversed.ok).toBe(true);
    if (inOrder.ok && reversed.ok) {
      expect(reversed.plan.acceptedDealDigest).toBe(inOrder.plan.acceptedDealDigest);
      expect(reversed.plan.jobs[0]!.units.map((u) => u.g)).toEqual([10n * USDC, 3n * USDC]);
    }
  });

  it("net-only drift, a substituted unit, and opposite per-unit errors that would cancel globally are each refused", () => {
    const n = withSplit(fee235, tweak((u) => ({ net: (BigInt(u.net) + 1n).toString() })));
    expect(n.ok === false && n.violations).toEqual([
      { code: "economics-mismatch", nodeId: "mail", field: "net" },
      { code: "economics-mismatch", nodeId: "print", field: "net" },
    ]);
    const swap: NetSplitter = (units) => {
      const r = tenPercent(units) as Extract<ReturnType<NetSplitter>, { ok: true }>;
      return { ...r, units: [r.units[0]!, { ...r.units[1]!, unitRef: "ghost" }] };
    };
    expect(withSplit(fee235, swap)).toEqual({ ok: false, violations: [{ code: "economics-malformed", detail: "unit-set" }] });
    let k = 0;
    const cancel = tweak((u) => {
      const d = k++ === 0 ? 1n : -1n; // +1 on the first unit, -1 on the second: the global total still matches
      return { payouts: [u.payouts[0]!, { ...u.payouts[1]!, amount: (BigInt(u.payouts[1]!.amount) + d).toString() }] };
    });
    const c = withSplit(fee235, cancel);
    expect(c.ok === false && codes(c)).toEqual(["payout-sum-mismatch", "payout-sum-mismatch"]);
  });

  it("non-canonical, signed, spaced or over-long amount strings are refused (JS `$` does not admit a final newline)", () => {
    for (const amount of ["-1", "01", "+1", "1e3", " 1", "1 ", "1\n", "1".padEnd(79, "0")]) {
      const r = withSplit(fee235, tweak((u) => ({ payouts: [...u.payouts, { recipient: LICENSOR, amount }] })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r)).toContain("invalid-payout-leg");
    }
  });

  it("astra: empty payouts, a single full leg, sparse legs, revoked proxies, lying lengths and throwing leg getters", () => {
    expect(codes(withSplit(fee235, tweak(() => ({ payouts: [] }))) as { ok: false; violations: CompileViolation[] })).toEqual(["payout-sum-mismatch", "payout-sum-mismatch"]);
    expect(withSplit(fee235, tweak((u) => ({ payouts: [{ recipient: ADDR("a1"), amount: u.net }] }))).ok).toBe(true);
    const sparse = withSplit(fee235, tweak((u) => {
      const legs = new Array(2);
      legs[0] = u.payouts[0];
      return { payouts: legs };
    }));
    expect(sparse.ok === false && sparse.violations.filter((x) => x.code === "invalid-payout-leg").map((x) => (x as { index: number }).index)).toEqual([1, 1]);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const boomLeg = { get recipient(): string { throw new Error("late"); }, amount: "1" };
    const answers: Array<[NetSplitter, string]> = [
      [() => proxy as ReturnType<NetSplitter>, "result"],
      [tweak(() => ({ payouts: new Proxy([], { get: (t, k) => (k === "length" ? -1 : Reflect.get(t, k)) }) })), "payouts"],
      [(u) => ({ ...(tenPercent(u) as object), units: new Proxy([], { get: (t, k) => (k === "length" ? "2" : Reflect.get(t, k)) }) }) as unknown as ReturnType<NetSplitter>, "units"],
      [tweak((u) => ({ payouts: [u.payouts[0]!, boomLeg] })), "result"],
    ];
    for (const [split, detail] of answers) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = withSplit(fee235, split);
      }).not.toThrow();
      expect(r?.ok).toBe(false);
      if (r && !r.ok) expect(r.violations.every((x) => x.code === "economics-malformed" && (x as { detail: string }).detail.startsWith(detail))).toBe(true);
    }
  });

  it("the 78-digit bound: 78 digits parse (and fail conservation); 79 digits are not an amount", () => {
    const at = (amount: string) => withSplit(fee235, tweak((u) => ({ payouts: [...u.payouts, { recipient: LICENSOR, amount }] })));
    const d78 = at("9".repeat(78));
    expect(d78.ok === false && codes(d78)).toEqual(["payout-sum-mismatch", "payout-sum-mismatch"]);
    const d79 = at("1".padEnd(79, "0"));
    expect(d79.ok === false && codes(d79)).toEqual(["invalid-payout-leg", "invalid-payout-leg"]);
  });

  it("astra: an answer getter that mutates the CALLER's input cannot change the compiled deal or make it throw", () => {
    const p = plan({ feeBps: 235, feeRecipient: ADDR("fe") });
    const mutate = (mutation: () => void): NetSplitter => (units) =>
      Object.defineProperty({ ...(tenPercent(units) as object) }, "economicTermsHash", {
        enumerable: true,
        get() {
          mutation();
          return DIG("e1");
        },
      }) as ReturnType<NetSplitter>;
    const baseline = compileAcceptedPlan(plan({ feeBps: 235, feeRecipient: ADDR("fe") }), { splitNet: tenPercent });
    expect(baseline.ok).toBe(true); // so two identical refusals cannot satisfy the equality below
    const swapped = compileAcceptedPlan(p, { splitNet: mutate(() => (p.feeRecipient = LICENSOR)) });
    expect(swapped).toEqual(baseline); // the WHOLE plan, digest included, is the untouched baseline
    const q = plan({ feeBps: 235, feeRecipient: ADDR("fe") });
    const late = compileAcceptedPlan(q, {
      splitNet: mutate(() =>
        Object.defineProperty(q, "feeRecipient", {
          get() {
            throw new Error("late");
          },
        }),
      ),
    });
    expect(late.ok).toBe(true); // the compiler never re-reads the caller's object
  });

  it("boundaries are accepted: exactly 16 legs per unit, repeated recipients, and 16 units x 16 legs = 256 legs per job", () => {
    const sixteen = (units: Parameters<NetSplitter>[0]): ReturnType<NetSplitter> => ({
      ok: true,
      agreementHash: DIG("a1"),
      economicTermsHash: DIG("e1"),
      rightsTermsHash: DIG("f1"),
      units: units.map((u) => ({
        unitRef: u.nodeId,
        gross: u.g.toString(),
        fee: u.f.toString(),
        net: u.n.toString(),
        payouts: Array.from({ length: 16 }, (_, i) => ({ recipient: i % 2 ? LICENSOR : u.payoutAddress, amount: (i === 0 ? u.n - 15n : 1n).toString() })),
      })),
    });
    const many = Array.from({ length: MAX_UNITS_PER_JOB }, (_, i) => node({ nodeId: `n${String(i).padStart(2, "0")}`, grossBaseUnits: USDC }));
    const r = withSplit(plan({ nodes: many, edges: [] }), sixteen);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.jobs).toHaveLength(1);
      expect(r.plan.jobs[0]!.units.reduce((a, u) => a + u.payouts.length, 0)).toBe(256);
    }
  });

  function unitsOf(): Parameters<NetSplitter>[0] {
    return [{ nodeId: "print", operator: OP_A, payoutAddress: ADDR("a1"), quote: 10n * USDC, g: 10n * USDC, f: 235_000n, n: 9_765_000n }];
  }
});

describe("input snapshot (astra review of 4479b79a): the compiler reads the caller's input exactly once", () => {
  it("a getter on the input is read once; the validated value is the value used", () => {
    let reads = 0;
    const p = Object.defineProperty(plan({ feeBps: 235 }), "feeRecipient", {
      enumerable: true,
      get: () => (reads++ === 0 ? ADDR("fe") : ADDR("00")),
    });
    const r = compileAcceptedPlan(p);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.jobs[0]!.units[0]!.feeRecipient).toBe(ADDR("fe"));
  });

  it("the program gate cannot change a node after its validation by mutating the caller's input", () => {
    const p = plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] });
    const sneaky: ProgramGate = (a) => {
      (p.nodes[0] as { grossBaseUnits: bigint }).grossBaseUnits = 1n; // after validation, before use
      return gate(a);
    };
    const r = compileAcceptedPlan(p, { assertProgramForTier: sneaky });
    const baseline = compileAcceptedPlan(plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] }), { assertProgramForTier: gate });
    expect(baseline.ok).toBe(true);
    expect(r).toEqual(baseline);
  });

  it("a throwing input getter, a lying length or an over-bound list is a typed refusal, never a throw", () => {
    const cases: Array<[unknown, string]> = [
      [Object.defineProperty(plan(), "payer", { enumerable: true, get: () => { throw new Error("x"); } }), "input"],
      [plan({ nodes: new Proxy([], { get: (t, k) => (k === "length" ? 1.5 : Reflect.get(t, k)) }) as unknown as AcceptedPlanNode[] }), "input"],
      [plan({ nodes: Array.from({ length: 1025 }, (_, i) => node({ nodeId: `n${i}` })) }), "nodes"],
      [null, "input"],
    ];
    for (const [input, field] of cases) {
      let r: ReturnType<typeof compileAcceptedPlan> | undefined;
      expect(() => {
        r = compileAcceptedPlan(input as AcceptedPlanInput);
      }).not.toThrow();
      expect(r).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field }] });
    }
  });
});

describe("input snapshot, round 3 (astra review of ce18cf42): no caller reference survives, nothing escapes", () => {
  /** A local splitter (one full leg per unit), so this block does not depend on another block's fixtures. */
  const oneLeg: NetSplitter = (units) => ({
    ok: true,
    agreementHash: DIG("a1"),
    economicTermsHash: DIG("e1"),
    rightsTermsHash: DIG("f1"),
    units: units.map((u) => ({ unitRef: u.nodeId, gross: String(u.g), fee: String(u.f), net: String(u.n), payouts: [{ recipient: u.payoutAddress, amount: String(u.n) }] })),
  });
  /** Wrap a value so every property read is counted by path (arrays included: length and indices). */
  function counting<T>(value: T, counts: Map<string, number>, path = "$"): T {
    if (typeof value !== "object" || value === null) return value;
    return new Proxy(value as object, {
      get(target, key, receiver) {
        const k = `${path}.${String(key)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counting(Reflect.get(target, key, receiver), counts, k);
      },
    }) as T;
  }

  it("every property of the input — plan fields, node fields, nested evidence, edges, reservation, lengths, indices — is read at most once, and the result equals the plain compile", () => {
    const counts = new Map<string, number>();
    const input = plan({ feeBps: 235, feeRecipient: ADDR("fe"), nodes: [node({ nodeId: "print", tierKey: "tier2", committedProgramHash: PROGRAM_T2 }), node({ nodeId: "mail", capabilityType: "mail.drop" })] });
    const viaProxy = compileAcceptedPlan(counting(input, counts), { assertProgramForTier: gate });
    const plain = compileAcceptedPlan(input, { assertProgramForTier: gate });
    expect(plain.ok).toBe(true);
    expect(viaProxy).toEqual(plain);
    const reread = [...counts.entries()].filter(([, n]) => n > 1);
    expect(reread).toEqual([]);
    expect(counts.get("$.nodes.0.evidenceRequirements.0.tier")).toBe(1);
    expect(counts.get("$.reservation.maxAmountBaseUnits")).toBe(1);
  });

  it("a callable reservation or node is refused as data, and never becomes a live caller reference", () => {
    const resv = Object.assign(() => {}, { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 100n * USDC });
    const splitterMutating: NetSplitter = (units) => {
      (resv as { reservationId: string }).reservationId = "bad id";
      return oneLeg(units);
    };
    const r = compileAcceptedPlan(plan({ reservation: resv as unknown as AcceptedPlanInput["reservation"] }), { splitNet: splitterMutating });
    expect(r.ok === false && r.violations).toContainEqual({ code: "invalid-plan-field", field: "reservation" });
    let touched = false;
    const callableNode = Object.assign(() => {}, node({ nodeId: "print" }));
    Object.defineProperty(callableNode, "capabilityId", { get: () => ((touched = true), "cap") });
    const n = compileAcceptedPlan(plan({ nodes: [callableNode as unknown as AcceptedPlanNode], edges: [] }));
    expect(n.ok === false && codes(n)).toContain("invalid-node-id");
    expect(touched).toBe(false);
  });

  it("a non-array container is not retained: revoking a proxy mid-snapshot cannot throw later", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const p = Object.defineProperty(plan({ nodes: proxy as unknown as AcceptedPlanNode[] }), "edges", {
      enumerable: true,
      get() {
        revoke();
        return [];
      },
    });
    let r: ReturnType<typeof compileAcceptedPlan> | undefined;
    expect(() => {
      r = compileAcceptedPlan(p);
    }).not.toThrow();
    expect(r?.ok === false && codes(r as { ok: false; violations: CompileViolation[] })).toContain("empty-plan");
  });

  it("a hostile thrown value (a revoked proxy) cannot make the catch itself throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const p = Object.defineProperty(plan(), "payer", { enumerable: true, get: () => { throw proxy; } });
    let r: ReturnType<typeof compileAcceptedPlan> | undefined;
    expect(() => {
      r = compileAcceptedPlan(p);
    }).not.toThrow();
    expect(r).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field: "input" }] });
  });

  it("a malformed ANSWER from the program gate is a refusal; the gate throwing is a server fault", () => {
    const tiered = plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] });
    const answers: unknown[] = [
      Object.defineProperty({}, "ok", { get: () => { throw new Error("x"); } }),
      Object.defineProperty({ ok: false }, "code", { get: () => { throw new Error("x"); } }),
      { ok: "yes" },
      null,
    ];
    for (const a of answers) {
      const r = compileAcceptedPlan(tiered, { assertProgramForTier: () => a as ReturnType<ProgramGate> });
      expect(r.ok === false && r.violations).toEqual([{ code: "program-gate-refused", nodeId: "x", reason: "malformed-gate-result" }]);
    }
    expect(() => compileAcceptedPlan(tiered, { assertProgramForTier: () => { throw new Error("gate down"); } })).toThrow("gate down");
  });

  it("each cap holds at its limit and refuses one above, before reading any element", () => {
    const opAddr = (i: number) => `0x${"a".repeat(36)}${i.toString(16).padStart(4, "0")}` as `0x${string}`;
    const nodesN = (count: number) => Array.from({ length: count }, (_, i) => node({ nodeId: `n${i}`, operator: opAddr(Math.floor(i / 16)), grossBaseUnits: USDC }));
    const wide = (count: number) => plan({ nodes: nodesN(count), edges: [], reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: BigInt(count) * USDC } });
    expect(compileAcceptedPlan(wide(1024)).ok).toBe(true);
    let reads = 0;
    const counted = new Proxy(nodesN(1025), { get: (t, k, r) => (typeof k === "string" && /^[0-9]+$/.test(k) && reads++, Reflect.get(t, k, r)) });
    expect(compileAcceptedPlan(plan({ nodes: counted, edges: [] }))).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field: "nodes" }] });
    expect(reads).toBe(0);
    const ninetyTwo = nodesN(92);
    const pairs: Array<{ from: string; to: string }> = [];
    for (let a = 0; a < 92 && pairs.length < 4097; a++) for (let b = a + 1; b < 92 && pairs.length < 4097; b++) pairs.push({ from: `n${a}`, to: `n${b}` });
    const reservation = { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 92n * USDC };
    expect(compileAcceptedPlan(plan({ nodes: ninetyTwo, edges: pairs.slice(0, 4096), reservation })).ok).toBe(true);
    expect(compileAcceptedPlan(plan({ nodes: ninetyTwo, edges: pairs, reservation }))).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field: "edges" }] });
    const reqs = (count: number) => Array.from({ length: count }, (_, i) => ({ requirementId: `r${i}`, evidenceTypeId: `ev.${i}`, tier: 0 }));
    expect(compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", evidenceRequirements: reqs(64) })], edges: [] })).ok).toBe(true);
    expect(compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", evidenceRequirements: reqs(65) })], edges: [] }))).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field: "evidenceRequirements" }] });
  });

  it("a splitter that mutates the caller's reservation and nested evidence directly cannot change the deal", () => {
    const fresh = () => plan({ feeBps: 235, feeRecipient: ADDR("fe") });
    const p = fresh();
    const tampering: NetSplitter = (units) => {
      p.reservation.reservationId = "bad id";
      p.nodes[0]!.evidenceRequirements[0]!.tier = 3;
      return oneLeg(units);
    };
    const baseline = compileAcceptedPlan(fresh(), { splitNet: oneLeg });
    expect(baseline.ok).toBe(true);
    expect(compileAcceptedPlan(p, { splitNet: tampering })).toEqual(baseline);
  });
});

describe("round 4 (astra review of 0571c00c): dependencies are read once; the answer's scalars are normalized", () => {
  const oneLeg: NetSplitter = (units) => ({
    ok: true,
    agreementHash: DIG("a1"),
    economicTermsHash: DIG("e1"),
    rightsTermsHash: DIG("f1"),
    units: units.map((u) => ({ unitRef: u.nodeId, gross: String(u.g), fee: String(u.f), net: String(u.n), payouts: [{ recipient: u.payoutAddress, amount: String(u.n) }] })),
  });
  const tiered = () => plan({ nodes: [node({ nodeId: "x", tierKey: "tier2", committedProgramHash: PROGRAM_T2 })], edges: [] });

  it("a gate that swaps deps.splitNet for a throwing getter cannot make the compiler throw or change the deal", () => {
    const baseline = compileAcceptedPlan(tiered(), { assertProgramForTier: gate, splitNet: oneLeg });
    expect(baseline.ok).toBe(true);
    const deps: CompileDeps = {
      splitNet: oneLeg,
      assertProgramForTier: (a) => {
        Object.defineProperty(deps, "splitNet", {
          get() {
            throw new Error("late dependency read");
          },
        });
        return gate(a);
      },
    };
    let r: ReturnType<typeof compileAcceptedPlan> | undefined;
    expect(() => {
      r = compileAcceptedPlan(tiered(), deps);
    }).not.toThrow();
    expect(r).toEqual(baseline);
  });

  it("each dependency slot is read exactly once, even through a getter that changes its answer", () => {
    let gateReads = 0;
    let splitReads = 0;
    const deps = {} as CompileDeps;
    Object.defineProperty(deps, "assertProgramForTier", { get: () => (gateReads++ === 0 ? gate : undefined) });
    Object.defineProperty(deps, "splitNet", { get: () => (splitReads++ === 0 ? oneLeg : undefined) });
    const r = compileAcceptedPlan(tiered(), deps);
    expect(r.ok).toBe(true);
    expect([gateReads, splitReads]).toEqual([1, 1]);
  });

  it("a dependency slot that is present but not a function fails closed", () => {
    expect(compileAcceptedPlan(tiered(), { assertProgramForTier: gate, splitNet: null as unknown as NetSplitter })).toEqual({
      ok: false,
      violations: [{ code: "economics-malformed", detail: "dependency" }],
    }); // never a silent single-leg default when economics was wired
    const r = compileAcceptedPlan(tiered(), { assertProgramForTier: {} as unknown as ProgramGate });
    expect(r.ok === false && r.violations).toEqual([{ code: "program-gate-missing", nodeId: "x" }]);
  });

  it("an object-valued refusal code is never converted by the caller's own toString", () => {
    let called = false;
    const code = { toString: () => ((called = true), "sneaky") };
    const r = compileAcceptedPlan(plan(), { splitNet: () => ({ ok: false, code }) as unknown as ReturnType<NetSplitter> });
    expect(r).toEqual({ ok: false, violations: [{ code: "economics-refused", reason: "<object>" }] });
    expect(called).toBe(false);
  });

  it("the edges and evidence caps also refuse before reading any element", () => {
    let reads = 0;
    const counting = <T extends object>(arr: T[]): T[] =>
      new Proxy(arr, { get: (t, k, rcv) => (typeof k === "string" && /^[0-9]+$/.test(k) && reads++, Reflect.get(t, k, rcv)) });
    const edges = counting(Array.from({ length: 4097 }, () => ({ from: "print", to: "mail" })));
    expect(compileAcceptedPlan(plan({ edges }))).toEqual({ ok: false, violations: [{ code: "invalid-plan-field", field: "edges" }] });
    const reqs = counting(Array.from({ length: 65 }, (_, i) => ({ requirementId: `r${i}`, evidenceTypeId: `ev.${i}`, tier: 0 })));
    expect(compileAcceptedPlan(plan({ nodes: [node({ nodeId: "p", evidenceRequirements: reqs })], edges: [] }))).toEqual({
      ok: false,
      violations: [{ code: "invalid-plan-field", field: "evidenceRequirements" }],
    });
    expect(reads).toBe(0);
  });
});
