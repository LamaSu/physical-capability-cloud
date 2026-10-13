/**
 * Parity between the TypeScript compiler and the forge seam test.
 *
 * packages/contracts/test/VNextEconomicsSeam.t.sol funds a real VNextSettlementEscrow with literal
 * payouts and releases them. Those literals must be EXACTLY what compileEconomics emits for the same
 * example agreements, or the forge test proves nothing about this compiler. This test parses the
 * Solidity and compares every unit, fee and leg, in order.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileEconomics } from "../economics/compile.js";
import { exampleDeckMilestones, exampleGuildRepair, examplePrintAndMail } from "../economics/examples.js";
import type { EconomicAgreement } from "../economics/types.js";

const SOL = readFileSync(new URL("../../../contracts/test/VNextEconomicsSeam.t.sol", import.meta.url), "utf8");

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
    nodeId: m[2]!,
    gross: m[4]!,
    fee: m[5]!,
    payouts: legs.get(Number(m[6]))!,
  }));
  return units;
}

describe("forge seam literals == compileEconomics output", () => {
  it("the fee constants match the examples' fee terms", () => {
    const ag = examplePrintAndMail();
    expect(SOL).toContain(`uint256 constant FEE_BPS = ${ag.fee.feeBps};`);
    const treasury = `0x${((0xfeen << 148n) | 0xfeen).toString(16).padStart(40, "0")}`;
    expect(SOL).toContain("return address(uint160((uint256(0xfee) << 148) | 0xfee));");
    expect(treasury).toBe(ag.fee.feeRecipient);
  });

  it.each([
    ["_examplePrintAndMail", examplePrintAndMail],
    ["_exampleGuildRepair", exampleGuildRepair],
    ["_exampleDeckMilestones", exampleDeckMilestones],
  ] as const)("%s", (fn, build: () => EconomicAgreement) => {
    const r = compileEconomics(build());
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    const fromSol = parseExample(fn);
    expect(fromSol.map((u) => u.nodeId)).toEqual(r.units.map((u) => u.unitRef));
    fromSol.forEach((u, i) => {
      const c = r.units[i]!;
      expect(u.gross).toBe(c.gross);
      expect(u.fee).toBe(c.fee);
      expect(u.payouts).toEqual(c.payouts.map((p) => [p.recipient, p.amount]));
    });
  });
});
