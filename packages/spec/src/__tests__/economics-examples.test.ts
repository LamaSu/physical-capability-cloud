/**
 * Golden outputs for the five worked agreements (technical pack §8 RETURN: "5 nontechnical example
 * agreements with exact compiled economic outputs"). The amounts were checked by hand; the fixture is
 * the value any other implementation of docs/ECONOMIC_AGREEMENTS.md must reproduce.
 */

import { describe, expect, it } from "vitest";
import { compileEconomics } from "../economics/compile.js";
import { AGREEMENT_TEMPLATES, EXAMPLE_AGREEMENTS, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import golden from "./fixtures/economics-golden-v1.json";

type Golden = {
  agreementHash: string;
  economicTermsHash: string;
  rightsTermsHash: string;
  units: Record<string, { gross: string; fee: string; net: string; payouts: [string, string][] }>;
};

describe("golden example agreements", () => {
  it.each(EXAMPLE_AGREEMENTS.map((f) => [f.name, f] as const))("%s compiles to its pinned golden output", (_name, build) => {
    const r = compileEconomics(build(), { schedules: [PRINTER_KIT_SCHEDULE] });
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    const g = (golden.agreements as Record<string, Golden>)[r.agreementId]!;
    expect(g).toBeDefined();
    expect(r.agreementHash).toBe(g.agreementHash);
    expect(r.economicTermsHash).toBe(g.economicTermsHash);
    expect(r.rightsTermsHash).toBe(g.rightsTermsHash);
    expect(Object.fromEntries(r.units.map((u) => [u.unitRef, { gross: u.gross, fee: u.fee, net: u.net, payouts: u.payouts.map((p) => [p.recipient, p.amount]) }]))).toEqual(g.units);
  });

  it("the pinned schedule hash is the one @pcc/spec computes for the printer kit schedule", () => {
    expect(PRINTER_KIT_SCHEDULE.scheduleHash).toBe("0xe0e75ab2547d106ab6f3e211f0859cb85fe3f9bdb1b081dde24e20122d50f61a");
  });

  it("the listable templates are the five examples, each compiling with its own options to the same golden hashes", () => {
    expect(AGREEMENT_TEMPLATES.map((t) => t.build)).toEqual([...EXAMPLE_AGREEMENTS]);
    expect(new Set(AGREEMENT_TEMPLATES.map((t) => t.templateId)).size).toBe(AGREEMENT_TEMPLATES.length);
    for (const t of AGREEMENT_TEMPLATES) {
      const r = compileEconomics(t.build(), t.compileOptions);
      if (!r.ok) throw new Error(`${t.templateId}: ${JSON.stringify(r.refusals)}`);
      expect(r.agreementHash).toBe((golden.agreements as Record<string, Golden>)[r.agreementId]!.agreementHash);
      expect(t.build()).not.toBe(t.build()); // a fresh copy each time
    }
  });

  it("hand check: the lab assay's minimum royalty and lineage", () => {
    // 3% of $400.00 is $12.00, under the $15.00 minimum, so $15.00, split 70/18/12.
    const u = golden.agreements["ex4-lab-assay"].units.assay;
    const paid = Object.fromEntries(u.payouts.map(([r, amt]) => [r, amt]));
    expect(paid["0x0000000000000000000000000000000003a10003"]).toBe("10500000");
    expect(paid["0x000000000000000000000000000000000da7a004"]).toBe("2700000");
    expect(paid["0x000000000000000000000000000000000da7b005"]).toBe("1800000");
  });
});
