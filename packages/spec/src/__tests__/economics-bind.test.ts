/**
 * netSplitterFor — the economics half of the accepted-plan seam (composition #351 CompileDeps.splitNet).
 * The agreement is never taken on the caller's word: it must match what the payer accepted, and every
 * authority-bearing field must match server state, or the split is refused.
 */

import { describe, expect, it } from "vitest";
import { agreementUnitGross, netSplitterFor, type PlanSplitUnit, type ServerEconomicsFacts } from "../economics/bind.js";
import { compileEconomics } from "../economics/compile.js";
import { exampleIncompatibleLicense, exampleLabAssay, examplePrintAndMail, exampleSparePrinter, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import type { EconomicAgreement } from "../economics/types.js";

/**
 * Composition's NetSplitter contract, copied verbatim from #351 (feat/accepted-plan-compiler @ 69012b4e,
 * packages/spec/src/csd/accepted-plan-compiler.ts). When both branches are on master, replace this copy
 * with the import; until then the assignment below is the conformance check.
 */
interface ComposedSplitUnitInput { nodeId: string; operator: `0x${string}`; payoutAddress: `0x${string}`; quote: bigint; g: bigint; f: bigint; n: bigint }
type ComposedNetSplitResult =
  | { ok: true; units: ReadonlyArray<{ unitRef: string; gross: string; fee: string; net: string; payouts: ReadonlyArray<{ recipient: string; amount: string }> }>; economicTermsHash: string; rightsTermsHash: string }
  | { ok: false; code: string };
type ComposedNetSplitter = (units: readonly ComposedSplitUnitInput[]) => ComposedNetSplitResult;

const FEE = "0xfee0000000000000000000000000000000000fee";

/** What an honest server would know about this agreement's deal. */
function server(ag: EconomicAgreement, over: Partial<ServerEconomicsFacts> = {}): ServerEconomicsFacts {
  return {
    feeBps: ag.fee.feeBps,
    feeRecipient: ag.fee.feeRecipient ?? "0x0000000000000000000000000000000000000000",
    currency: { code: "USDC", decimals: 6 },
    now: ag.asOf + 600,
    intendedUse: structuredClone(ag.use),
    licenses: structuredClone(ag.licenses),
    parties: ag.parties.flatMap((p) => (p.payTo === null ? [] : [{ partyId: p.partyId, payTo: p.payTo }])),
    unitFacts: Object.fromEntries(ag.units.map((u) => [u.unitRef, { components: structuredClone(u.components), measures: structuredClone(u.measures) }])),
    schedules: [PRINTER_KIT_SCHEDULE],
    forbiddenRecipients: ["0x00000000000000000000000000000000000e5c0f"],
    ...over,
  };
}

/**
 * The units the accepted-plan compiler would hand over for this agreement, in its canonical order. By
 * default the operator is a party that is paid in the unit and its quote is 1 (a floor that any paid
 * operator clears); `quotes` sets real quotes and payout addresses per unit.
 */
function planUnits(ag: EconomicAgreement, order?: string[], quotes: Record<string, { quote: bigint; payoutAddress: string }> = {}): PlanSplitUnit[] {
  const refs = order ?? ag.units.map((u) => u.unitRef);
  const compiled = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
  return refs.map((ref) => {
    const g = BigInt(ag.units.find((u) => u.unitRef === ref)!.gross);
    const f = (g * BigInt(ag.fee.feeBps)) / 10000n;
    const firstPayee = compiled.ok ? compiled.units.find((u) => u.unitRef === ref)?.payouts[0]?.recipient : undefined;
    const q = quotes[ref] ?? { quote: 1n, payoutAddress: firstPayee ?? "0x0000000000000000000000000000000000000abc" };
    return { nodeId: ref, operator: q.payoutAddress, payoutAddress: q.payoutAddress, quote: q.quote, g, f, n: g - f };
  });
}

const refusal = (r: ReturnType<ReturnType<typeof netSplitterFor>>) => (r.ok ? "ok" : r.code);

describe("netSplitterFor", () => {
  it("conforms to composition's NetSplitter type and returns exactly compileEconomics' payouts, in plan order", () => {
    const ag = examplePrintAndMail();
    const splitter = netSplitterFor({ agreement: ag, accepted: null, server: server(ag) });
    const conforms: ComposedNetSplitter = splitter; // the conformance check
    expect(conforms).toBe(splitter);
    const r = splitter(planUnits(ag, ["b-mail", "a-print"]) as ComposedSplitUnitInput[]);
    if (!r.ok) throw new Error(r.code);
    const c = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
    if (!c.ok) throw new Error("fixture");
    expect(r.units.map((u) => u.unitRef)).toEqual(["b-mail", "a-print"]);
    expect(r.units[1]!.payouts).toEqual(c.units[0]!.payouts);
    expect(r.units[0]!.payouts).toEqual(c.units[1]!.payouts);
    expect([r.agreementHash, r.economicTermsHash, r.rightsTermsHash]).toEqual([c.agreementHash, c.economicTermsHash, c.rightsTermsHash]);
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

  it("asOf must be a recent server moment: a backdated or future agreement is refused (review N5)", () => {
    const ag = exampleSparePrinter();
    const run = (now: number, maxAgreementAgeSeconds?: number) =>
      refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag, { now, ...(maxAgreementAgeSeconds === undefined ? {} : { maxAgreementAgeSeconds }) }) })(planUnits(ag)));
    expect(run(ag.asOf)).toBe("ok");
    expect(run(ag.asOf + 86_400)).toBe("ok");
    expect(run(ag.asOf + 86_401)).toBe(`economics:AS_OF_OUT_OF_WINDOW:${ag.asOf}`); // backdated past the window
    expect(run(ag.asOf - 1)).toBe(`economics:AS_OF_OUT_OF_WINDOW:${ag.asOf}`); // dated in the future
    expect(run(ag.asOf + 3_600, 60)).toBe(`economics:AS_OF_OUT_OF_WINDOW:${ag.asOf}`);
  });

  it("the intended use is the server's, not the composer's description of itself (review N5)", () => {
    const ag = examplePrintAndMail();
    const run = (use: EconomicAgreement["use"]) => refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag, { intendedUse: use }) })(planUnits(ag)));
    expect(run({ ...ag.use, region: "EU" })).toBe("economics:USE_MISMATCH");
    expect(run({ ...ag.use, resell: false })).toBe("economics:USE_MISMATCH");
    expect(run({ ...ag.use })).toBe("ok");
  });

  it("a licensor is paid at its registry address: re-pointing it at another wallet is refused (review M3)", () => {
    const ag = exampleSparePrinter();
    const honest = server(ag);
    const redirected = exampleSparePrinter();
    const sam = redirected.parties.find((p) => p.partyId === "sam")!;
    redirected.parties.find((p) => p.partyId === "priya")!.payTo = sam.payTo;
    expect(refusal(netSplitterFor({ agreement: redirected, accepted: null, server: honest })(planUnits(redirected)))).toBe("economics:PARTY_MISMATCH:priya");
    const unregistered = server(ag, { parties: honest.parties.filter((p) => p.partyId !== "priya") });
    expect(refusal(netSplitterFor({ agreement: ag, accepted: null, server: unregistered })(planUnits(ag)))).toBe("economics:PARTY_NOT_REGISTERED:priya");
    // A declared distribution's parties are held to the registry too.
    const lab = exampleLabAssay();
    const labFacts = server(lab);
    const rerouted = exampleLabAssay();
    rerouted.parties.find((p) => p.partyId === "dataset-b")!.payTo = rerouted.parties.find((p) => p.partyId === "lab")!.payTo;
    expect(refusal(netSplitterFor({ agreement: rerouted, accepted: null, server: labFacts })(planUnits(rerouted)))).toBe("economics:PARTY_MISMATCH:dataset-b");
  });

  it("what runs in each unit is the server's: a dropped or under-counted licensed component is refused (review N5)", () => {
    const ag = examplePrintAndMail();
    const facts = server(ag);
    const run = (agreement: EconomicAgreement, f = facts) => refusal(netSplitterFor({ agreement, accepted: null, server: f })(planUnits(agreement)));
    const dropped = examplePrintAndMail();
    dropped.units[1]!.components = dropped.units[1]!.components.filter((c) => c.ref !== "method:address-verify@1");
    expect(run(dropped)).toBe("economics:UNIT_FACTS_MISMATCH:b-mail");
    const undercounted = examplePrintAndMail();
    const ranTwice = server(ag, { unitFacts: { ...facts.unitFacts, "b-mail": { components: [{ ref: "service:letter-mail@3", uses: "1" }, { ref: "method:address-verify@1", uses: "2" }], measures: [] } } });
    expect(run(undercounted, ranTwice)).toBe("economics:UNIT_FACTS_MISMATCH:b-mail");
    const unlisted = server(ag, { unitFacts: { "a-print": facts.unitFacts["a-print"]! } });
    expect(run(ag, unlisted)).toBe("economics:UNIT_FACTS_MISMATCH:b-mail");
    expect(run(ag)).toBe("ok");
  });

  it("an operator's quote is its price for its own work: add-ons are on top, never taken out of the operator (composition #2762)", () => {
    const ag = examplePrintAndMail(); // the print shop's quote is its fixed $12.00 on a $14.00 step
    const printshop = ag.parties.find((p) => p.partyId === "printshop")!.payTo!;
    const courier = ag.parties.find((p) => p.partyId === "courier")!.payTo!;
    const quotes = (printQuote: bigint) => ({
      "a-print": { quote: printQuote, payoutAddress: printshop },
      "b-mail": { quote: 5_000_000n, payoutAddress: courier },
    });
    const run = (printQuote: bigint) => refusal(netSplitterFor({ agreement: ag, accepted: null, server: server(ag) })(planUnits(ag, undefined, quotes(printQuote))));
    // $12.00 paid covers a quote whose net of the 2.35% fee is at most $12.00: a quote of $12.28 nets 11.9915.
    expect(run(12_000_000n)).toBe("ok");
    expect(run(12_288_000n)).toBe("ok");
    // A quote of $12.30 nets 12.01095 > $12.00 paid: the agreement takes from the operator's own work.
    expect(run(12_300_000n)).toBe("economics:OPERATOR_BELOW_QUOTE:a-print");
    // A step priced below the operator's quote is not covered at all.
    expect(run(14_000_001n)).toBe("economics:QUOTE_NOT_COVERED:a-print");
  });

  it("agreementUnitGross lets the plan reserve each unit's gross before compiling, and grants nothing", () => {
    const g = agreementUnitGross(examplePrintAndMail());
    expect(g).toEqual({ ok: true, gross: { "a-print": 14_000_000n, "b-mail": 8_000_000n } });
    expect(agreementUnitGross({ schema: "nope" })).toEqual({ ok: false, code: "economics:SCHEMA_INVALID" });
  });

  it("the protocol fee recipient stays the fee recipient: FEE is not in the payouts", () => {
    const ag = examplePrintAndMail();
    const r = netSplitterFor({ agreement: ag, accepted: null, server: server(ag) })(planUnits(ag));
    if (!r.ok) throw new Error(r.code);
    expect(r.units.flatMap((u) => u.payouts.map((p) => p.recipient))).not.toContain(FEE);
  });
});
