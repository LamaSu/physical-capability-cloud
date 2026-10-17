/**
 * Parity between the TypeScript compiler and the forge seam test.
 *
 * packages/contracts/test/VNextEconomicsSeam.t.sol funds a real VNextSettlementEscrow with literal
 * payouts and releases them. Those literals must be EXACTLY what compileEconomics emits for the same
 * example agreements, or the forge test proves nothing about this compiler. This test parses the
 * Solidity and compares every unit, fee and leg, in order.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { netSplitterFor, type PlanSplitUnit, type ServerEconomicsFacts } from "../economics/bind.js";
import * as compiler from "../economics/compile.js";
import { AGREEMENT_TEMPLATES, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import { simulateEconomics } from "../economics/simulate.js";
import type { EconomicAgreement } from "../economics/types.js";
import { clone, FEE_TREASURY } from "./economics-helpers.js";

const SOL = readFileSync(new URL("../../../contracts/test/VNextEconomicsSeam.t.sol", import.meta.url), "utf8");
const FORGE_EXAMPLES: Readonly<Record<string, string>> = {
  "spare-printer": "_exampleSparePrinter",
  "print-and-mail": "_examplePrintAndMail",
  "guild-repair": "_exampleGuildRepair",
  "lab-assay": "_exampleLabAssay",
  "deck-milestones": "_exampleDeckMilestones",
};

function body(fn: string): string {
  const start = SOL.indexOf(`function ${fn}(`);
  if (start < 0) throw new Error(`missing ${fn} in the forge test`);
  const next = SOL.indexOf("\n    function ", start + 1);
  return SOL.slice(start, next < 0 ? undefined : next);
}

function parseExample(fn: string) {
  const text = body(fn);
  const legs = new Map<number, Array<[string, string]>>();
  for (const m of text.matchAll(/u(\d+)\[(\d+)\] = _leg\(address\(0x([0-9a-fA-F]+)\), (\d+)\);/g)) {
    const u = Number(m[1]);
    const i = Number(m[2]);
    const list = legs.get(u) ?? [];
    list[i] = [`0x${m[3]!.toLowerCase().padStart(40, "0")}`, m[4]!];
    legs.set(u, list);
  }
  const units = [...text.matchAll(/cfgs\[(\d+)\] = _unit\("([^"]+)", (\d+), (\d+), (\d+), u(\d+)\);/g)].map((m) => ({
    unitRef: m[2]!,
    gross: m[4]!,
    fee: m[5]!,
    payouts: legs.get(Number(m[6]))!,
  }));
  return units;
}

describe("forge seam literals == compileEconomics output", () => {
  it("every template has a forge function, and every forge example belongs to a template", () => {
    expect(Object.keys(FORGE_EXAMPLES).sort()).toEqual(AGREEMENT_TEMPLATES.map((t) => t.templateId).sort());
    const functions = [...SOL.matchAll(/function (_example\w+)\(/g)].map((m) => m[1]!);
    const mapped = AGREEMENT_TEMPLATES.map((t) => FORGE_EXAMPLES[t.templateId]!);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(functions.sort()).toEqual(mapped.sort());
  });

  it("the fee constants match the examples' fee terms", () => {
    const treasury = `0x${((0xfeen << 148n) | 0xfeen).toString(16).padStart(40, "0")}`;
    expect(SOL).toContain("return address(uint160((uint256(0xfee) << 148) | 0xfee));");
    expect(treasury).toBe(FEE_TREASURY);
    for (const t of AGREEMENT_TEMPLATES) {
      const ag = t.build();
      expect(SOL).toContain(`uint256 constant FEE_BPS = ${ag.fee.feeBps};`);
      expect(treasury).toBe(ag.fee.feeRecipient);
    }
  });

  it.each(AGREEMENT_TEMPLATES)("$templateId matches its forge literals", (t) => {
    const r = compiler.compileEconomics(t.build(), t.compileOptions);
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    const fromSol = parseExample(FORGE_EXAMPLES[t.templateId]!);
    expect(fromSol.map((u) => u.unitRef)).toEqual(r.units.map((u) => u.unitRef));
    fromSol.forEach((u, i) => {
      const c = r.units[i]!;
      expect(u.gross).toBe(c.gross);
      expect(u.fee).toBe(c.fee);
      expect(u.payouts).toEqual(c.payouts.map((p) => [p.recipient, p.amount]));
    });
  });
});

/** Registry, clock, unit facts and quote conventions from economics-bind.test.ts. */
function server(ag: EconomicAgreement): ServerEconomicsFacts {
  return {
    feeBps: ag.fee.feeBps,
    feeRecipient: ag.fee.feeRecipient ?? "0x0000000000000000000000000000000000000000",
    currency: { code: "USDC", decimals: 6 },
    now: ag.asOf + 600,
    intendedUse: clone(ag.use),
    licenses: clone(ag.licenses),
    parties: ag.parties.flatMap((p) => (p.payTo === null ? [] : [{ partyId: p.partyId, payTo: p.payTo }])),
    unitFacts: Object.fromEntries(ag.units.map((u) => [u.unitRef, { components: clone(u.components), measures: clone(u.measures) }])),
    schedules: [PRINTER_KIT_SCHEDULE],
    forbiddenRecipients: ["0x00000000000000000000000000000000000e5c0f"],
  };
}

function planUnits(ag: EconomicAgreement): PlanSplitUnit[] {
  const compiled = compiler.compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.refusals));
  return compiled.units.map((u) => {
    const g = BigInt(u.gross);
    const f = (g * BigInt(ag.fee.feeBps)) / 10000n;
    const payee = u.payouts[0]!.recipient;
    return { nodeId: u.unitRef, operator: payee, payoutAddress: payee, quote: 1n, g, f, n: g - f };
  });
}

describe("CC6: all-released simulation legs == netSplitterFor legs == forge-funded legs", () => {
  it.each(AGREEMENT_TEMPLATES)("$templateId preserves every recipient and amount in unit and leg order", (t) => {
    const ag = t.build();
    const facts = server(ag);
    const options: compiler.CompileOptions = {
      schedules: facts.schedules,
      forbiddenRecipients: facts.forbiddenRecipients,
      fee: { feeBps: facts.feeBps, feeRecipient: facts.feeRecipient },
    };

    // ScenarioResult exposes totals and party aggregates, not ordered recipient legs. Observe the
    // real compile consumed by the simulator; restore the call-through spy before invoking the binder.
    const compile = vi.spyOn(compiler, "compileEconomics");
    let simulationCompile: compiler.CompileResult;
    let simulation: ReturnType<typeof simulateEconomics>[number];
    try {
      const results = simulateEconomics(ag, [{
        scenarioId: "all-good",
        label: "Every step done",
        grossOverrides: [],
        usesOverrides: [],
        outcomes: ag.units.map((u) => ({ unitRef: u.unitRef, outcome: "released" })),
      }], options);
      expect(results).toHaveLength(1);
      simulation = results[0]!;
      expect(compile).toHaveBeenCalledTimes(1);
      expect(compile).toHaveBeenCalledWith(ag, options);
      simulationCompile = clone(compile.mock.results[0]!.value as compiler.CompileResult);
    } finally {
      compile.mockRestore();
    }
    if (!simulation.ok) throw new Error(JSON.stringify(simulation.refusals));
    if (!simulationCompile.ok) throw new Error(JSON.stringify(simulationCompile.refusals));

    expect(simulation.units).toEqual(simulationCompile.units.map((u) => ({
      unitRef: u.unitRef, outcome: "released", gross: u.gross, fee: u.fee, net: u.net,
    })));
    expect(simulation.agreementHash).toBe(simulationCompile.agreementHash);
    expect(simulation.payer).toEqual({ partyId: ag.payer, spent: simulationCompile.totals.gross, refunded: "0", reserved: "0" });
    expect(simulation.fee).toEqual({ paid: simulationCompile.totals.fee, recipient: facts.feeRecipient });
    const paid = new Map<string, bigint>();
    for (const u of simulationCompile.units) {
      for (const leg of u.legs) {
        for (const a of leg.attribution) paid.set(a.partyId, (paid.get(a.partyId) ?? 0n) + BigInt(a.amount));
      }
    }
    expect(simulation.paid).toEqual([...paid].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([partyId, amount]) => ({ partyId, amount: amount.toString() })));

    const split = netSplitterFor({ agreement: ag, accepted: null, server: facts })(planUnits(ag));
    if (!split.ok) throw new Error(split.code);
    const simulatedLegs = simulationCompile.units.map((u) => ({
      unitRef: u.unitRef, payouts: u.legs.map((l) => [l.recipient, l.amount]),
    }));
    const boundLegs = split.units.map((u) => ({
      unitRef: u.unitRef, payouts: u.payouts.map((p) => [p.recipient, p.amount]),
    }));
    const forgeLegs = parseExample(FORGE_EXAMPLES[t.templateId]!).map((u) => ({ unitRef: u.unitRef, payouts: u.payouts }));
    expect(simulatedLegs).toEqual(boundLegs);
    expect(boundLegs).toEqual(forgeLegs);
  });
});
