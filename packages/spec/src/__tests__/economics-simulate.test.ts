/**
 * simulateEconomics — "show multiple revenue/cost/failure scenarios before deployment" (product pack §9).
 * The simulator runs the same compiler; these tests pin the escrow outcome rules it applies.
 */

import { describe, expect, it } from "vitest";
import { exampleDeckMilestones, examplePrintAndMail } from "../economics/examples.js";
import { simulateEconomics } from "../economics/simulate.js";

describe("simulateEconomics", () => {
  const deck = exampleDeckMilestones();

  it("all steps released: everyone is paid what the compile says, and the payer spends the full price", () => {
    const [r] = simulateEconomics(deck, [{ scenarioId: "all-good", label: "Every step done", grossOverrides: [], usesOverrides: [], outcomes: [] }]);
    if (!r!.ok) throw new Error(JSON.stringify(r));
    expect(r!.payer).toEqual({ partyId: "homeowner", spent: "8000000000", refunded: "0", reserved: "0" });
    expect(r!.fee).toEqual({ paid: "188000000", recipient: "0xfee0000000000000000000000000000000000fee" });
    expect(r!.paid).toEqual([
      { partyId: "contractor", amount: "3673600000" }, // 181.2 + 3058.85 + 433.55 (USD)
      { partyId: "designer", amount: "600000000" },
      { partyId: "inspector", amount: "250000000" },
      { partyId: "insurer", amount: "78000000" },
      { partyId: "lumber", amount: "3210400000" },
    ]);
  });

  it("the build step fails: its $6,500 comes back to the homeowner; nobody on that step is paid", () => {
    const [r] = simulateEconomics(deck, [
      { scenarioId: "build-fails", label: "Build fails", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "m2-build", outcome: "refunded" }] },
    ]);
    if (!r!.ok) throw new Error(JSON.stringify(r));
    expect(r!.payer).toEqual({ partyId: "homeowner", spent: "1500000000", refunded: "6500000000", reserved: "0" });
    expect(r!.paid.map((p) => p.partyId)).toEqual(["contractor", "designer", "inspector"]);
    expect(r!.paid.find((p) => p.partyId === "contractor")!.amount).toBe("614750000"); // 181.2 + 433.55
    expect(r!.fee.paid).toBe("35250000"); // no fee on a refunded step
  });

  it("an inspection still pending keeps its money reserved, not paid", () => {
    const [r] = simulateEconomics(deck, [
      { scenarioId: "waiting", label: "Waiting on the inspector", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "m3-inspect", outcome: "pending" }] },
    ]);
    if (!r!.ok) throw new Error(JSON.stringify(r));
    expect(r!.payer.reserved).toBe("700000000");
    expect(r!.paid.find((p) => p.partyId === "inspector")).toBeUndefined();
  });

  it("a lower price that no longer covers the lumber is shown as unfundable, with the compiler's reason", () => {
    const [r] = simulateEconomics(deck, [
      { scenarioId: "cheap", label: "Build at $3,000", grossOverrides: [{ unitRef: "m2-build", gross: "3000000000" }], usesOverrides: [], outcomes: [] },
    ]);
    expect(r!.ok).toBe(false);
    if (!r!.ok) expect(r!.refusals.map((x) => [x.code, x.path.join("/")])).toEqual([["OVER_ALLOCATED", "unit/m2-build"]]);
  });

  it("if the address check does not run, the inventor is not paid and the step's margin grows by exactly the fee", () => {
    const mail = examplePrintAndMail();
    const [ran, skipped] = simulateEconomics(mail, [
      { scenarioId: "ran", label: "Address check runs", grossOverrides: [], usesOverrides: [], outcomes: [] },
      { scenarioId: "skipped", label: "Address check skipped", grossOverrides: [], usesOverrides: [{ unitRef: "b-mail", ref: "method:address-verify@1", uses: "0" }], outcomes: [] },
    ]);
    if (!ran!.ok || !skipped!.ok) throw new Error("both scenarios should compile");
    const orbit = (s: typeof ran) => BigInt((s as { paid: { partyId: string; amount: string }[] }).paid.find((p) => p.partyId === "orbit")!.amount);
    expect(orbit(skipped) - orbit(ran)).toBe(250000n);
    expect(skipped!.paid.find((p) => p.partyId === "inventor")).toBeUndefined();
    expect(skipped!.agreementHash).not.toBe(ran!.agreementHash); // a different plan is a different agreement
  });

  it("scenarios that name unknown units, or are malformed, are refused on their own", () => {
    const [unknown, malformed] = simulateEconomics(deck, [
      { scenarioId: "typo", label: "Typo", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "m9-nope", outcome: "refunded" }] },
      { scenarioId: "bad", label: "Bad", grossOverrides: [], outcomes: [] },
    ]);
    expect(unknown!.ok).toBe(false);
    expect(malformed!.ok).toBe(false);
  });
});
