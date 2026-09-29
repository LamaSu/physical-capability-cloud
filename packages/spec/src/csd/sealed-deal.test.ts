/**
 * parseSealedDeal: the R13 store's strict reader of a sealed deal (ChatGPT review of #402/#410/#415,
 * findings H1 and M6). Every deal the compiler can seal must parse, with its terms intact; anything
 * else must be a typed refusal, never an exception.
 */
import { describe, it, expect } from "vitest";
import {
  acceptedDealPreimage,
  compileAcceptedPlan,
  type AcceptedPlanInput,
  type AcceptedPlanNode,
  type CompileDeps,
  type NetSplitter,
  type ProgramGate,
} from "./accepted-plan-compiler.js";
import { MAX_SEALED_DEAL_BYTES, MAX_SEALED_DEAL_UNITS, MAX_SEALED_UNIT_BYTES, parseSealedDeal, type SealedDeal } from "./sealed-deal.js";
import { canonicalize } from "../util/canonical.js";

const ADDR = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const DIG = (b: string) => `0x${b.repeat(32)}`;
const PAYER = ADDR("11");
const OP_A = ADDR("aa");
const OP_B = ADDR("bb");
const LICENSOR = ADDR("c1");
const USDC = 1_000_000n;
const PROGRAM_T2 = DIG("d2");
const gate: ProgramGate = ({ committedProgramHash }) => (committedProgramHash === PROGRAM_T2 ? { ok: true } : { ok: false, code: "no" });

function node(p: Partial<AcceptedPlanNode> & { nodeId: string }): AcceptedPlanNode {
  return {
    capabilityId: `cap-${p.nodeId}`,
    capabilityType: "document-printing",
    csd: "document-print-and-mail",
    tierKey: "tier0",
    operator: OP_A,
    payoutAddress: ADDR("a1"),
    grossBaseUnits: 10n * USDC,
    matchedCapabilityDigest: DIG("0c"),
    committedProgramHash: null,
    evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }],
    ...p,
  };
}

function plan(p: Partial<AcceptedPlanInput> = {}): AcceptedPlanInput {
  return {
    planId: "plan.resv-1",
    requestId: "req-1",
    payer: PAYER,
    currency: "USDC",
    feeBps: 0,
    feeRecipient: ADDR("00"),
    reclaimAt: 1_900_000_000n,
    nodes: [node({ nodeId: "print" }), node({ nodeId: "mail", capabilityType: "mail.drop" })],
    edges: [{ from: "print", to: "mail" }],
    reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: 10_000n * USDC },
    ...p,
  };
}

/** Compile, then return the bytes the store keeps: the digest's preimage. */
function sealed(p: AcceptedPlanInput, deps: CompileDeps = { assertProgramForTier: gate }): string {
  const r = compileAcceptedPlan(p, deps);
  if (!r.ok) throw new Error(`fixture does not compile: ${JSON.stringify(r.violations)}`);
  const { acceptedDealDigest: _digest, ...rest } = r.plan;
  return acceptedDealPreimage(rest);
}

function parsed(bytes: string): SealedDeal {
  const r = parseSealedDeal(bytes);
  if (!r.ok) throw new Error(`expected a parse, got ${r.reason}`);
  return r.deal;
}

/** Edit the parsed deal, then RE-CANONICALIZE: the edit must be caught by a rule, not by the canonical check. */
function edit(bytes: string, f: (d: any) => void): string {
  const d = JSON.parse(bytes);
  f(d);
  return canonicalize(d);
}

const tenPercent: NetSplitter = (units) => ({
  ok: true,
  agreementHash: DIG("a1"),
  economicTermsHash: DIG("e1"),
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

/** n nodes over ceil(n/16) operators, 16 units per job. */
function wide(n: number): AcceptedPlanInput {
  const ops = Array.from({ length: Math.ceil(n / 16) }, (_, i) => ADDR((0xa0 + i).toString(16)));
  const nodes = Array.from({ length: n }, (_, i) => node({ nodeId: `n${String(i).padStart(2, "0")}`, operator: ops[Math.floor(i / 16)]!, grossBaseUnits: USDC }));
  return plan({ nodes, edges: [] });
}

describe("every deal the compiler can seal parses, with its terms intact", () => {
  it("one operator, two units: identity, money and the reservation's inputs", () => {
    const d = parsed(sealed(plan()));
    expect(d).toMatchObject({ planId: "plan.resv-1", requestId: "req-1", reservationId: "resv-1", currency: "USDC", totalObligationBaseUnits: 20n * USDC, payers: [PAYER], minTier: 0 });
    expect(d.units.map((u) => [u.unitRef, u.nodeId, u.operator, u.payer, u.g, u.n, u.reclaimAt])).toEqual([
      [`plan.resv-1:${OP_A}#0`, "print", OP_A, PAYER, 10n * USDC, 10n * USDC, 1_900_000_000n],
      [`plan.resv-1:${OP_A}#1`, "mail", OP_A, PAYER, 10n * USDC, 10n * USDC, 1_900_000_000n],
    ]);
    expect(Object.isFrozen(d) && Object.isFrozen(d.units) && Object.isFrozen(d.units[0]) && Object.isFrozen(d.payers)).toBe(true);
  });

  it("two operators (two jobs), a fee, a tier-2 unit, and an economics split with agreement hashes", () => {
    const p = plan({
      feeBps: 235,
      feeRecipient: ADDR("fe"),
      nodes: [
        node({ nodeId: "print", tierKey: "tier2", committedProgramHash: PROGRAM_T2 }),
        node({ nodeId: "mail", capabilityType: "mail.drop", operator: OP_B, payoutAddress: ADDR("b1") }),
      ],
    });
    const d = parsed(sealed(p, { assertProgramForTier: gate, splitNet: tenPercent }));
    expect(d.units.map((u) => [u.unitRef, u.operator, u.tier, u.g, u.f, u.n])).toEqual([
      [`plan.resv-1:${OP_A}#0`, OP_A, 2, 10n * USDC, 235_000n, 9_765_000n],
      [`plan.resv-1:${OP_B}#0`, OP_B, 0, 10n * USDC, 235_000n, 9_765_000n],
    ]);
    expect(d.minTier).toBe(0);
    expect(d.payers).toEqual([PAYER, PAYER]);
  });

  it(`exactly ${MAX_SEALED_DEAL_UNITS} units parse; ${MAX_SEALED_DEAL_UNITS + 1} are refused (VCR's deal binding)`, () => {
    expect(parsed(sealed(wide(MAX_SEALED_DEAL_UNITS))).units).toHaveLength(MAX_SEALED_DEAL_UNITS);
    expect(parseSealedDeal(sealed(wide(MAX_SEALED_DEAL_UNITS + 1)))).toEqual({ ok: false, reason: "too-many-units" });
  });

  it("the largest unit a valid deal can hold (16 legs, the widest amounts) stays far under 16 KiB", () => {
    const legs16: NetSplitter = (units) => ({
      ok: true,
      agreementHash: DIG("a1"),
      economicTermsHash: DIG("e1"),
      rightsTermsHash: DIG("f1"),
      units: units.map((u) => ({
        unitRef: u.nodeId,
        gross: u.g.toString(),
        fee: u.f.toString(),
        net: u.n.toString(),
        payouts: Array.from({ length: 16 }, (_, i) => ({ recipient: i === 0 ? u.payoutAddress : ADDR((0x40 + i).toString(16)), amount: (i === 0 ? u.n - 15n : 1n).toString() })),
      })),
    });
    const big = sealed(plan({ nodes: [node({ nodeId: "print", grossBaseUnits: (1n << 128n) - 1n })], edges: [], reservation: { reservationId: "resv-1", requestId: "req-1", currency: "USDC", maxAmountBaseUnits: (1n << 128n) - 1n } }), { splitNet: legs16 });
    const unit = JSON.parse(big).jobs[0].units[0];
    expect(canonicalize(unit).length).toBeLessThan(MAX_SEALED_UNIT_BYTES / 4);
    expect(parsed(big).units[0]!.g).toBe((1n << 128n) - 1n);
  });
});

describe("anything else is a typed refusal", () => {
  const OK = sealed(plan());

  it("the reviewer's case: a MiB of 'y' that hashes right is not a deal; oversized bytes are refused before parsing", () => {
    expect(parseSealedDeal("y".repeat(MAX_SEALED_DEAL_BYTES))).toEqual({ ok: false, reason: "not-json" });
    expect(parseSealedDeal("y".repeat(MAX_SEALED_DEAL_BYTES + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parseSealedDeal(`${OK}${" ".repeat(MAX_SEALED_DEAL_BYTES)}`)).toEqual({ ok: false, reason: "too-large" });
    for (const x of ["", "{", "null", "[]", "42", '"deal"']) expect([x, parseSealedDeal(x).ok]).toEqual([x, false]);
    for (const x of [undefined, null, 42, {}, Buffer.from(OK)]) expect(parseSealedDeal(x as unknown)).toEqual({ ok: false, reason: "not-json" });
  });

  it("the bytes must be canonical: whitespace, reordered keys or a duplicate key are refused", () => {
    expect(parseSealedDeal(`${OK} `)).toEqual({ ok: false, reason: "not-canonical" });
    expect(parseSealedDeal(OK.replace('{"agreementHash"', '{ "agreementHash"'))).toEqual({ ok: false, reason: "not-canonical" });
    expect(parseSealedDeal(OK.replace('{"agreementHash":null,', '{"domain":"PCC:accepted-deal:v2","agreementHash":null,'))).toEqual({ ok: false, reason: "not-canonical" });
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(OK)).reverse()));
    expect(parseSealedDeal(reordered)).toEqual({ ok: false, reason: "not-canonical" });
  });

  it("the domain and the exact key set, at every level", () => {
    expect(parseSealedDeal(edit(OK, (d) => (d.domain = "PCC:accepted-deal:v1")))).toEqual({ ok: false, reason: "bad-domain" });
    for (const f of [
      (d: any) => (d.extra = 1),
      (d: any) => delete d.nodeToUnit,
      (d: any) => (d.jobs[0].extra = 1),
      (d: any) => (d.jobs[0].units[0].extra = 1),
      (d: any) => delete d.jobs[0].units[0].payouts,
      (d: any) => (d.jobs[0].units[0].payouts[0].extra = 1),
      (d: any) => (d.nodeToUnit[0].extra = 1),
      (d: any) => (d.jobs = {}),
      (d: any) => (d.agreementHash = DIG("a1")), // one of three agreement hashes set
      (d: any) => (d.jobs[0].units[0].requestedTier = 1), // requested != required
    ]) {
      expect(parseSealedDeal(edit(OK, f))).toEqual({ ok: false, reason: "bad-shape" });
    }
    expect(parseSealedDeal(OK.replace('{"agreementHash"', '{"__proto__":1,"agreementHash"')).ok).toBe(false);
  });

  it("the money: f and n recomputed from g and feeBps, legs summing to n, the total, the bounds", () => {
    for (const f of [
      (d: any) => (d.jobs[0].units[0].n = "9999999"),
      (d: any) => {
        d.jobs[0].units[0].payouts[0].amount = "9999999"; // legs no longer sum to n
      },
      (d: any) => (d.totalObligationBaseUnits = "19999999"),
      (d: any) => {
        const u = d.jobs[0].units[0];
        u.g = u.n = u.payouts[0].amount = "4"; // below the frozen ABI minimum
        d.totalObligationBaseUnits = "10000004";
      },
      (d: any) => (d.jobs[0].units[0].feeBps = 1001),
      (d: any) => (d.jobs[0].units[0].g = "010000000"),
      (d: any) => (d.jobs[0].units[0].payouts[0].amount = "-10000000"),
      (d: any) => (d.jobs[0].units[0].payouts = Array.from({ length: 17 }, () => ({ recipient: ADDR("a1"), amount: "1" }))),
      (d: any) => (d.jobs[0].units[0].reclaimAt = "0"),
      (d: any) => (d.jobs[0].units[0].reclaimAt = (1n << 64n).toString()),
      (d: any) => (d.currencyDecimals = 18),
      (d: any) => (d.currency = "USDT"),
      (d: any) => (d.jobs[0].units[0].feeRecipient = ADDR("fe")), // a fee recipient with feeBps 0
      (d: any) => {
        const u = d.jobs[0].units[0]; // a fee the fee rate does not give, with n and the legs consistent with it
        u.f = "1";
        u.n = u.payouts[0].amount = (BigInt(u.g) - 1n).toString();
      },
    ]) {
      expect(parseSealedDeal(edit(OK, f))).toEqual({ ok: false, reason: "bad-money" });
    }
    const zeroLeg = edit(OK, (d: any) => {
      const u = d.jobs[0].units[0];
      u.payouts = [{ recipient: ADDR("a1"), amount: u.n }, { recipient: LICENSOR, amount: "0" }];
    });
    expect(parseSealedDeal(zeroLeg)).toEqual({ ok: false, reason: "bad-money" });
  });

  it("identity: operators, payers, job ids, milestones, step ids and the node bindings", () => {
    for (const f of [
      (d: any) => (d.jobs[0].operator = OP_A.toUpperCase().replace("0X", "0x")),
      (d: any) => (d.jobs[0].jobId = "plan.resv-1:someone"),
      (d: any) => (d.jobs[0].payer = d.jobs[0].operator),
      (d: any) => (d.jobs[0].units[0].milestoneIndex = "1"),
      (d: any) => (d.jobs[0].units[0].stepId = DIG("5e")),
      (d: any) => (d.jobs[0].nodeIds = ["print", "print"]),
      (d: any) => (d.nodeToUnit[0].tier = 2),
      (d: any) => (d.nodeToUnit[0].planHash = `sha256:${"0".repeat(64)}`),
      (d: any) => (d.nodeToUnit[0].jobIndex = 1),
      (d: any) => (d.nodeToUnit[0].nodeId = "mail"),
      (d: any) => (d.nodeToUnit[1] = d.nodeToUnit[0]), // one unit bound twice, another not at all
      (d: any) => (d.planId = "plan.resv-2"), // every job id is derived from it
      (d: any) => (d.reservationId = ""),
      (d: any) => {
        // one node id twice, with its step ids and bindings made consistent: only uniqueness can catch it
        d.jobs[0].nodeIds = ["print", "print"];
        d.jobs[0].units[1].stepId = d.jobs[0].units[0].stepId;
        for (const b of d.nodeToUnit) Object.assign(b, { nodeId: "print", stepId: "print", stepIdBytes32: d.jobs[0].units[0].stepId });
      },
    ]) {
      expect(parseSealedDeal(edit(OK, f))).toEqual({ ok: false, reason: "bad-identity" });
    }
    expect(parseSealedDeal(edit(OK, (d: any) => d.nodeToUnit.pop()))).toEqual({ ok: false, reason: "bad-shape" });
  });

  it("two jobs may not share an operator", () => {
    const two = sealed(plan({ nodes: [node({ nodeId: "print" }), node({ nodeId: "mail", operator: OP_B, payoutAddress: ADDR("b1") })] }));
    const dup = edit(two, (d: any) => {
      d.jobs[1].operator = d.jobs[0].operator;
      d.jobs[1].jobId = d.jobs[0].jobId;
      d.nodeToUnit.forEach((b: any) => (b.operator = d.jobs[0].operator));
    });
    expect(parseSealedDeal(dup)).toEqual({ ok: false, reason: "bad-identity" });
  });

  it("never throws: a thousand one-character corruptions each parse or refuse", () => {
    const bytes = sealed(plan({ feeBps: 235, feeRecipient: ADDR("fe") }), { splitNet: tenPercent });
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      const at = (i * 7919) % bytes.length;
      const ch = String.fromCharCode(0x20 + ((i * 31) % 95));
      const r = parseSealedDeal(bytes.slice(0, at) + ch + bytes.slice(at + 1));
      if (!r.ok) refused++;
    }
    expect(refused).toBeGreaterThan(900);
  });
});

describe("astra, round 2 of R13 (D): the assurance structure only the compiler produces", () => {
  const withPrograms = (a: string | null, b: string | null) =>
    plan({
      nodes: [
        node({ nodeId: "print", tierKey: a === null ? "tier0" : "tier2", committedProgramHash: a }),
        node({ nodeId: "mail", capabilityType: "mail.drop", tierKey: b === null ? "tier0" : "tier2", committedProgramHash: b }),
      ],
    });

  it("a unit above tier 0 with NO committed program is refused (astra's forgery: a tier-0 deal relabelled tier 2)", () => {
    const forged = edit(sealed(plan()), (d) => {
      for (const j of d.jobs) for (const u of j.units) {
        u.requiredTier = 2;
        u.requestedTier = 2;
      }
      for (const b of d.nodeToUnit) b.tier = 2; // committedProgramHash stays null
    });
    expect(parseSealedDeal(forged)).toEqual({ ok: false, reason: "bad-assurance" });
  });

  it("a tier-0 unit that commits a program is refused", () => {
    const forged = edit(sealed(plan()), (d) => {
      d.nodeToUnit[0].committedProgramHash = PROGRAM_T2;
    });
    expect(parseSealedDeal(forged)).toEqual({ ok: false, reason: "bad-assurance" });
  });

  it("two different programs in one deal are refused: the compiler commits at most one (v2); one program, or none, parses", () => {
    const one = sealed(withPrograms(PROGRAM_T2, PROGRAM_T2));
    expect(parseSealedDeal(one).ok).toBe(true);
    expect(parseSealedDeal(sealed(withPrograms(PROGRAM_T2, null))).ok).toBe(true);
    const forged = edit(one, (d) => {
      d.nodeToUnit[1].committedProgramHash = DIG("e3");
    });
    expect(parseSealedDeal(forged)).toEqual({ ok: false, reason: "bad-assurance" });
  });
});
