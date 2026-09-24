/**
 * netSplitterFor — the economics half of the accepted-plan seam (composition #351 CompileDeps.splitNet).
 * The agreement is never taken on the caller's word: it must match what the payer accepted, and every
 * authority-bearing field must match server state, or the split is refused.
 */

import { describe, expect, it } from "vitest";
import { netSplitterFor, type PlanSplitUnit, type ServerEconomicsFacts } from "../economics/bind.js";
import { compileEconomics } from "../economics/compile.js";
import { examplePrintAndMail, exampleIncompatibleLicense, exampleSparePrinter, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import type { EconomicAgreement } from "../economics/types.js";

/**
 * Composition's NetSplitter contract, copied verbatim from #351 (feat/accepted-plan-compiler @ 69012b4e,
 * packages/spec/src/csd/accepted-plan-compiler.ts). When both branches are on master, replace this copy
 * with the import; until then the assignment below is the conformance check.
 */
interface ComposedSplitUnitInput { nodeId: string; operator: `0x${string}`; payoutAddress: `0x${string}`; g: bigint; f: bigint; n: bigint }
type ComposedNetSplitResult =
  | { ok: true; units: ReadonlyArray<{ unitRef: string; gross: string; fee: string; net: string; payouts: ReadonlyArray<{ recipient: string; amount: string }> }>; economicTermsHash: string; rightsTermsHash: string }
  | { ok: false; code: string };
type ComposedNetSplitter = (units: readonly ComposedSplitUnitInput[]) => ComposedNetSplitResult;

const FEE = "0xfee0000000000000000000000000000000000fee";

function server(ag: EconomicAgreement, over: Partial<ServerEconomicsFacts> = {}): ServerEconomicsFacts {
  return {
    feeBps: ag.fee.feeBps,
    feeRecipient: ag.fee.feeRecipient ?? "0x0000000000000000000000000000000000000000",
    currency: { code: "USDC", decimals: 6 },
    licenses: structuredClone(ag.licenses),
    schedules: [PRINTER_KIT_SCHEDULE],
    forbiddenRecipients: ["0x00000000000000000000000000000000000e5c0f"],
    ...over,
  };
}

/** The units the accepted-plan compiler would hand over for this agreement, in its canonical order. */
function planUnits(ag: EconomicAgreement, order?: string[]): PlanSplitUnit[] {
  const refs = order ?? ag.units.map((u) => u.unitRef);
  return refs.map((ref) => {
    const g = BigInt(ag.units.find((u) => u.unitRef === ref)!.gross);
    const f = (g * BigInt(ag.fee.feeBps)) / 10000n;
    return { nodeId: ref, operator: "0x0000000000000000000000000000000000000abc", payoutAddress: "0x0000000000000000000000000000000000000abc", g, f, n: g - f };
  });
}

const refusal = (r: ReturnType<ReturnType<typeof netSplitterFor>>) => (r.ok ? "ok" : r.code);

describe("netSplitterFor", () => {
  it("conforms to composition's NetSplitter type and returns exactly compileEconomics' payouts, in plan order", () => {
    const ag = examplePrintAndMail();
    const split: ComposedNetSplitter = netSplitterFor({ agreement: ag, accepted: null, server: server(ag) });
    const r = split(planUnits(ag, ["b-mail", "a-print"]) as ComposedSplitUnitInput[]);
    if (!r.ok) throw new Error(r.code);
    const c = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
    if (!c.ok) throw new Error("fixture");
    expect(r.units.map((u) => u.unitRef)).toEqual(["b-mail", "a-print"]);
    expect(r.units[1]!.payouts).toEqual(c.units[0]!.payouts);
    expect(r.units[0]!.payouts).toEqual(c.units[1]!.payouts);
    expect([r.economicTermsHash, r.rightsTermsHash]).toEqual([c.economicTermsHash, c.rightsTermsHash]);
    for (const u of r.units) expect(u.payouts.reduce((s, p) => s + BigInt(p.amount), 0n)).toBe(BigInt(u.net));
  });

  it("accepts the agreement the payer accepted, and refuses one changed since, naming the half that moved", () => {
    const ag = exampleSparePrinter();
    const c = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
    if (!c.ok) throw new Error("fixture");
    const accepted = { agreementHash: c.agreementHash, economicTermsHash: c.economicTermsHash, rightsTermsHash: c.rightsTermsHash };
    expect(netSplitterFor({ agreement: ag, accepted, server: server(ag) })(planUnits(ag)).ok).toBe(true);

    const changed = exampleSparePrinter();
    changed.licenses[0]!.grants.regions = ["US"]; // a rights-only change after acceptance
    expect(refusal(netSplitterFor({ agreement: changed, accepted, server: server(changed) })(planUnits(changed)))).toBe(
      "economics:AGREEMENT_HASH_MISMATCH:rights",
    );
  });

  it("refuses a fee, currency or quote the server did not set", () => {
    const ag = examplePrintAndMail();
    const run = (over: Partial<ServerEconomicsFacts>, units = planUnits(ag)) => refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag, over) })(units));
    expect(run({ feeBps: 200 })).toBe("economics:FEE_MISMATCH");
    expect(run({ feeRecipient: "0x0000000000000000000000000000000000000bad" })).toBe("economics:FEE_MISMATCH");
    expect(run({ currency: { code: "USDC", decimals: 18 } })).toBe("economics:CURRENCY_MISMATCH");
    const requoted = planUnits(ag).map((u) => (u.nodeId === "a-print" ? { ...u, g: u.g + 1n } : u));
    expect(run({}, requoted)).toBe("economics:GROSS_MISMATCH:a-print");
    expect(run({}, planUnits(ag).slice(0, 1))).toBe("economics:UNIT_SET_MISMATCH");
    expect(run({}, [...planUnits(ag), { ...planUnits(ag)[0]!, nodeId: "c-extra" }])).toBe("economics:UNIT_SET_MISMATCH");
    expect(run({}, [planUnits(ag)[0]!, planUnits(ag)[0]!])).toBe("economics:UNIT_SET_MISMATCH");
  });

  it("a zero fee is the zero address on the plan side and null in the agreement", () => {
    const ag = examplePrintAndMail();
    ag.fee = { feeBps: 0, feeRecipient: null };
    expect(netSplitterFor({ agreement: ag, accepted: null, server: server(ag) })(planUnits(ag)).ok).toBe(true);
  });

  it("licenses must be the server's registry copies, verbatim: an upgraded authority or unregistered license refuses", () => {
    const ag = examplePrintAndMail();
    const registry = structuredClone(ag.licenses);
    const inflated = examplePrintAndMail();
    inflated.licenses.find((l) => l.licenseId === "lic-laser-print-kit")!.authority = "externally-attested"; // caller claims more
    expect(refusal(netSplitterFor({ agreement: inflated, accepted: null, server: server(ag, { licenses: registry }) })(planUnits(ag)))).toBe(
      "economics:LICENSE_MISMATCH:lic-laser-print-kit@1",
    );
    expect(refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag, { licenses: registry.slice(1) }) })(planUnits(ag)))).toBe(
      "economics:LICENSE_NOT_REGISTERED:lic-laser-print-kit@1",
    );
  });

  it("passes the compiler's refusals through by name, and refuses a fee rule that diverged", () => {
    const bad = exampleIncompatibleLicense();
    expect(refusal(netSplitterFor({ agreement: bad, accepted: null, server: server(bad) })(planUnits(bad)))).toBe("economics:COMPILE_REFUSED:RIGHTS_INCOMPATIBLE");
    const ag = examplePrintAndMail();
    const skewed = planUnits(ag).map((u) => ({ ...u, f: u.f + 1n, n: u.n - 1n }));
    expect(refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag) })(skewed))).toBe("economics:FEE_RULE_DIVERGED:a-print");
  });

  it("decides from a snapshot: mutating the agreement or the server facts afterwards changes nothing", () => {
    const ag = examplePrintAndMail();
    const facts = server(ag);
    const split = netSplitterFor({ agreement: ag, accepted: null, server: facts });
    const before = JSON.stringify(split(planUnits(examplePrintAndMail())));
    ag.clauses = [];
    facts.feeBps = 999;
    facts.licenses = [];
    expect(JSON.stringify(split(planUnits(examplePrintAndMail())))).toBe(before);
  });

  it("an uncloneable or malformed agreement is a schema refusal, never a throw", () => {
    const ag = examplePrintAndMail();
    const withFn = { ...ag, sneaky: () => 1 };
    expect(refusal(netSplitterFor({ agreement: withFn, accepted: null, server: server(ag) })(planUnits(ag)))).toBe("economics:SCHEMA_INVALID");
    expect(refusal(netSplitterFor({ agreement: { schema: "nope" }, accepted: null, server: server(ag) })(planUnits(ag)))).toBe("economics:SCHEMA_INVALID");
  });

  it("the protocol fee recipient stays the fee recipient: FEE is not in the payouts", () => {
    const ag = examplePrintAndMail();
    const r = netSplitterFor({ agreement: ag, accepted: null, server: server(ag) })(planUnits(ag));
    if (!r.ok) throw new Error(r.code);
    expect(r.units.flatMap((u) => u.payouts.map((p) => p.recipient))).not.toContain(FEE);
  });
});
