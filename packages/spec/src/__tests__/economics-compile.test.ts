/**
 * compileEconomics — the lane's required tests (technical pack §8) and every refusal, provoked.
 *
 *   exact payout conservation including rounding/dust ............ "conservation"
 *   nested split ................................................. "nested split"
 *   fixed upstream cost + residual composer margin ................ "upstream costs and a composer margin"
 *   incompatible license prevents accepted composition ............ "rights"
 *   changed rate/version after acceptance does not mutate old deal  "acceptance is immutable"
 *   optional contribution graph compiles into existing payout config  economics-adapters.test.ts
 */

import { describe, expect, it } from "vitest";
import { compileEconomics, type CompiledEconomics, type CompileOptions, type CompileResult } from "../economics/compile.js";
import {
  exampleDeckMilestones,
  exampleGuildRepair,
  exampleIncompatibleLicense,
  exampleLabAssay,
  examplePrintAndMail,
  exampleSparePrinter,
  PRINTER_KIT_SCHEDULE,
} from "../economics/examples.js";
import { REFUSAL_CODES, type RefusalCode } from "../economics/refusals.js";
import type { Clause, EconomicAgreement, License } from "../economics/types.js";
import { verifyAcceptedAgreement } from "../economics/verify.js";
import { computeScheduleHash, type RateSchedule } from "../types/rate-schedule.js";
import { a, baseAgreement, clone, prng, randBigint, shuffleAgreement } from "./economics-helpers.js";

const WITH_SCHEDULES: CompileOptions = { schedules: [PRINTER_KIT_SCHEDULE] };

function ok(r: CompileResult): CompiledEconomics {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.refusals, null, 1)}`);
  return r;
}

function codes(r: CompileResult): RefusalCode[] {
  if (r.ok) throw new Error("expected a refusal, got ok");
  return r.refusals.map((x) => x.code);
}

/** The escrow's own funding rules (docs/VNEXT_SETTLEMENT_ABI.md §5), checked on every compiled unit. */
function assertFundable(c: CompiledEconomics, feeBps: number): void {
  expect(c.units.length).toBeGreaterThanOrEqual(1);
  expect(c.units.length).toBeLessThanOrEqual(16);
  let totalLegs = 0;
  for (const u of c.units) {
    const g = BigInt(u.gross);
    const f = BigInt(u.fee);
    const n = BigInt(u.net);
    expect(g >= 5n && g <= (1n << 128n) - 1n).toBe(true);
    expect(f).toBe((g * BigInt(feeBps)) / 10000n);
    expect(n).toBe(g - f);
    expect(n > 0n).toBe(true);
    expect(u.payouts.length).toBeGreaterThanOrEqual(1);
    expect(u.payouts.length).toBeLessThanOrEqual(16);
    let sum = 0n;
    for (const p of u.payouts) {
      expect(BigInt(p.amount) > 0n).toBe(true);
      expect(p.recipient).toMatch(/^0x[0-9a-f]{40}$/);
      expect(p.recipient).not.toBe("0x0000000000000000000000000000000000000000");
      sum += BigInt(p.amount);
    }
    expect(sum).toBe(n); // Σ amount == n, exactly: PayoutSumMismatch is unreachable for compiled output
    // Attribution accounts for every base unit of every leg.
    for (const l of u.legs) {
      expect(l.attribution.reduce((s, x) => s + BigInt(x.amount), 0n)).toBe(BigInt(l.amount));
    }
    totalLegs += u.payouts.length;
  }
  expect(totalLegs).toBeLessThanOrEqual(256);
}

// ── Required: exact payout conservation including rounding/dust ─────────────

describe("conservation", () => {
  it("every example compiles to fundable units that sum to net exactly", () => {
    for (const f of [exampleSparePrinter, examplePrintAndMail, exampleGuildRepair, exampleLabAssay, exampleDeckMilestones]) {
      const ag = f();
      assertFundable(ok(compileEconomics(ag, WITH_SCHEDULES)), ag.fee.feeBps);
    }
  });

  it("dust: 3 equal percentage shares of an indivisible net land exactly, with the leftover by rule", () => {
    const ag = baseAgreement({
      parties: [
        { partyId: "buyer", label: "Buyer", kind: "person", payTo: a(1) },
        { partyId: "p1", label: "One", kind: "person", payTo: a(0x11) },
        { partyId: "p2", label: "Two", kind: "person", payTo: a(0x12) },
        { partyId: "p3", label: "Three", kind: "person", payTo: a(0x13) },
      ],
      units: [{ unitRef: "u1", label: "Unit", gross: "100", components: [], measures: [] }],
      fee: { feeBps: 0, feeRecipient: null },
      clauses: (["p1", "p2", "p3"] as const).map((p, i) => ({
        clauseId: `c${i + 1}`,
        label: `Share ${i + 1}`,
        role: "operator" as const,
        to: { party: p },
        subject: null,
        appliesTo: { allUnits: true as const },
        underLicense: null,
        rule: { kind: "percent" as const, bps: i === 2 ? 3334 : 3333, of: "net" as const, min: null, max: null, rateSource: null },
      })),
    });
    const c = ok(compileEconomics(ag));
    // 100 over 3333/3333/3334 bps: exact 33.33, 33.33, 33.34 → floors 33,33,33 → leftover 1 → largest remainder is c3.
    expect(c.units[0]!.clauses).toEqual([
      { clauseId: "c1", amount: "33" },
      { clauseId: "c2", amount: "33" },
      { clauseId: "c3", amount: "34" },
    ]);
    assertFundable(c, 0);
  });

  it("dust: a 50/50 split of an odd net needs no residual and gives the extra unit to the lower clause id", () => {
    const ag = baseAgreement({
      parties: [
        { partyId: "buyer", label: "Buyer", kind: "person", payTo: a(1) },
        { partyId: "x", label: "X", kind: "person", payTo: a(0x21) },
        { partyId: "y", label: "Y", kind: "person", payTo: a(0x22) },
      ],
      units: [{ unitRef: "u1", label: "Unit", gross: "101", components: [], measures: [] }],
      fee: { feeBps: 0, feeRecipient: null },
      clauses: [
        { clauseId: "b-half", label: "Y half", role: "operator", to: { party: "y" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 5000, of: "net", min: null, max: null, rateSource: null } },
        { clauseId: "a-half", label: "X half", role: "operator", to: { party: "x" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 5000, of: "net", min: null, max: null, rateSource: null } },
      ],
    });
    const c = ok(compileEconomics(ag));
    expect(c.units[0]!.clauses).toEqual([
      { clauseId: "a-half", amount: "51" },
      { clauseId: "b-half", amount: "50" },
    ]);
  });

  it("property: 2,000 random agreements either compile with Σ legs == net per unit or refuse by name", () => {
    const rand = prng(8);
    let compiled = 0;
    for (let t = 0; t < 2000; t++) {
      const nParties = 2 + Math.floor(rand() * 6);
      const parties = Array.from({ length: nParties }, (_, i) => ({
        partyId: `p${i}`,
        label: `Party ${i}`,
        kind: "person" as const,
        payTo: a(0x1000 + (i % 5)), // shared addresses on purpose
      }));
      const nUnits = 1 + Math.floor(rand() * 4);
      const units = Array.from({ length: nUnits }, (_, i) => ({
        unitRef: `u${i}`,
        label: `Unit ${i}`,
        gross: (5n + randBigint(rand, 10n ** BigInt(3 + Math.floor(rand() * 12)))).toString(),
        components: [],
        measures: [{ key: "pages", value: String(Math.floor(rand() * 50)) }],
      }));
      const clauses: Clause[] = [];
      const nClauses = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < nClauses; k++) {
        const to = { party: `p${1 + Math.floor(rand() * (nParties - 1))}` };
        const pick = rand();
        const rule: Clause["rule"] =
          pick < 0.35
            ? { kind: "percent", bps: 1 + Math.floor(rand() * 3999), of: rand() < 0.5 ? "gross" : "net", min: rand() < 0.2 ? "3" : null, max: null, rateSource: null }
            : pick < 0.6
              ? { kind: "fixed", amount: String(Math.floor(rand() * 5000)) }
              : pick < 0.8
                ? { kind: "per_use", rate: String(Math.floor(rand() * 100)), per: { measure: "pages" }, cap: rand() < 0.5 ? "1000" : null }
                : { kind: "pass_through", cost: String(Math.floor(rand() * 3000)), markupBps: Math.floor(rand() * 2000), costRef: null };
        clauses.push({
          clauseId: `k${k}`,
          label: `Clause ${k}`,
          role: (["operator", "verifier", "integrator", "assembler"] as const)[k % 4]!,
          to,
          subject: rand() < 0.5 ? `subj${k % 3}` : null,
          appliesTo: rand() < 0.5 ? { allUnits: true } : { units: [`u${Math.floor(rand() * nUnits)}`] },
          underLicense: null,
          rule,
        });
      }
      clauses.push({ clauseId: "zz-rest", label: "Rest", role: "assembler", to: { party: "p1" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "residual" } });
      const feeBps = Math.floor(rand() * 1001);
      const ag = baseAgreement({ parties, units, clauses, fee: { feeBps, feeRecipient: feeBps > 0 ? a(0xfee) : null }, payer: "p0" });
      const r = compileEconomics(ag);
      if (r.ok) {
        compiled++;
        assertFundable(r, feeBps);
      } else {
        // The only money refusal random terms can hit here: over-allocation. Anything else is a bug.
        expect(new Set(r.refusals.map((x) => x.code))).toEqual(new Set(["OVER_ALLOCATED"]));
      }
    }
    expect(compiled).toBeGreaterThan(500);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("shuffling every input array and upper-casing addresses changes no output byte", () => {
    for (const f of [exampleSparePrinter, examplePrintAndMail, exampleGuildRepair, exampleLabAssay, exampleDeckMilestones]) {
      const reference = JSON.stringify(ok(compileEconomics(f(), WITH_SCHEDULES)));
      for (let seed = 1; seed <= 25; seed++) {
        expect(JSON.stringify(ok(compileEconomics(shuffleAgreement(f(), seed), WITH_SCHEDULES)))).toBe(reference);
      }
    }
  });

  it("the compiler does not mutate its input", () => {
    const ag = exampleGuildRepair();
    const before = JSON.stringify(ag);
    compileEconomics(ag);
    expect(JSON.stringify(ag)).toBe(before);
  });
});

// ── Required: nested split ───────────────────────────────────────────────────

describe("nested split", () => {
  it("the guild's residual flows treasury 10% / members 90%, then members by hours, to the base unit", () => {
    const c = ok(compileEconomics(exampleGuildRepair()));
    const u = c.units[0]!;
    const byParty = Object.fromEntries(u.legs.map((l) => [l.partyIds.join(","), l.amount]));
    // residual 130579615 → treasury 13057961.5 / members 117521653.5 → tie on remainder → treasury (party:… sorts first)
    expect(byParty["guild-treasury"]).toBe("13057962");
    // members 117521653 by 5/3/1 → floors 65289807/39173884/13057961, leftover 1 → Cy (largest remainder 4/9)
    expect(byParty["ana"]).toBe("65289807");
    expect(byParty["ben"]).toBe("39173884");
    expect(byParty["cy"]).toBe("13057962");
    const cy = u.legs.find((l) => l.partyIds.includes("cy"))!;
    expect(cy.attribution).toEqual([{ clauseId: "guild", partyId: "cy", path: ["guild", "guild-share", "members-by-hours"], amount: "13057962" }]);
    // The treasury member overrode the inherited role.
    expect(u.legs.find((l) => l.partyIds.includes("guild-treasury"))!.roles).toEqual(["network-treasury"]);
  });

  it("a nine-deep chain of splits is refused; eight is fine", () => {
    const chain = (depth: number): EconomicAgreement => {
      const splits = Array.from({ length: depth }, (_, i) => ({
        splitId: `s${i}`,
        label: `Level ${i}`,
        members:
          i === depth - 1
            ? [{ to: { party: "seller" }, weight: 1, role: null, subject: null }]
            : [
                { to: { party: "seller" }, weight: 1, role: null, subject: null },
                { to: { split: `s${i + 1}` }, weight: 1, role: null, subject: null },
              ],
      }));
      return baseAgreement({ splits, clauses: [{ ...baseAgreement().clauses[0]!, to: { split: "s0" } }] });
    };
    assertFundable(ok(compileEconomics(chain(8))), 235);
    expect(codes(compileEconomics(chain(9)))).toContain("SPLIT_TOO_DEEP");
  });
});

// ── Required: fixed upstream cost + residual composer margin ─────────────────

describe("upstream costs and a composer margin", () => {
  it("print-and-mail pays fixed upstream prices and gives the composer exactly what is left of each step", () => {
    const c = ok(compileEconomics(examplePrintAndMail()));
    const [print, mail] = c.units;
    expect(print!.unitRef).toBe("a-print");
    expect(print!.clauses).toEqual([
      { clauseId: "orbit-margin", amount: "1671000" }, // 14.000000 − 0.329000 fee − 12.000000
      { clauseId: "print-cost", amount: "12000000" },
    ]);
    expect(mail!.clauses).toEqual([
      { clauseId: "address-check-fee", amount: "250000" },
      { clauseId: "courier-fee", amount: "5000000" },
      { clauseId: "orbit-margin", amount: "1882000" }, // 8.000000 − 0.188000 − 5.000000 − 0.680000 − 0.250000
      { clauseId: "postage", amount: "680000" },
    ]);
    // The courier's fee and the postage are two legs to one wallet: different subject, so both stay visible.
    const courierLegs = mail!.legs.filter((l) => l.partyIds.includes("courier"));
    expect(courierLegs.map((l) => [l.subjects[0], l.amount])).toEqual([
      ["postage", "680000"],
      ["service:letter-mail@3", "5000000"],
    ]);
  });

  it("when upstream costs exceed the price, the deal is refused, not silently short-paid", () => {
    const ag = examplePrintAndMail();
    ag.units[0]!.gross = "12100000"; // net 11815650 < the print shop's fixed 12000000
    const r = compileEconomics(ag);
    expect(codes(r)).toEqual(["OVER_ALLOCATED"]);
    if (!r.ok) expect(r.refusals[0]!.path).toEqual(["unit", "a-print"]);
  });

  it("nobody is paid by default: an unallocated remainder with no residual clause is refused", () => {
    const ag = examplePrintAndMail();
    ag.clauses = ag.clauses.filter((c) => c.clauseId !== "orbit-margin");
    expect(codes(compileEconomics(ag))).toEqual(["UNALLOCATED_REMAINDER", "UNALLOCATED_REMAINDER"]);
  });
});

// ── Required: incompatible license prevents accepted composition ─────────────

describe("rights", () => {
  it("a non-commercial dataset in a paid job is refused, and no split is produced", () => {
    const r = compileEconomics(exampleIncompatibleLicense());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals).toEqual([
      {
        code: "RIGHTS_INCOMPATIBLE",
        message: "license lic-weld-defects@1: commercial use is not granted",
        path: ["component", "dataset:weld-defects@1", "lic-weld-defects@1", "commercial-use"],
      },
    ]);
    expect("units" in r).toBe(false); // refused means refused: no payouts object at all
  });

  it("unknown rights are refused, never assumed", () => {
    const ag = exampleSparePrinter();
    ag.licenses = [];
    ag.clauses = ag.clauses.map((c) => ({ ...c, underLicense: null }));
    expect(codes(compileEconomics(ag, WITH_SCHEDULES))).toEqual(["RIGHTS_UNKNOWN"]);
  });

  const lab = () => exampleLabAssay();
  const withLicense = (mut: (l: License) => void, useMut?: (u: EconomicAgreement["use"]) => void) => {
    const ag = lab();
    mut(ag.licenses.find((l) => l.licenseId === "lic-peak-detect")!);
    if (useMut) useMut(ag.use);
    return compileEconomics(ag);
  };
  const condition = (r: CompileResult) => (r.ok ? [] : r.refusals.filter((x) => x.code === "RIGHTS_INCOMPATIBLE").map((x) => x.path[3]));

  it.each([
    ["compose", (l: License) => void (l.grants.compose = false), (u: EconomicAgreement["use"]) => void (u.composite = true)],
    ["resell", (l: License) => void (l.grants.resell = false), (u: EconomicAgreement["use"]) => void (u.resell = true)],
    ["modify", (l: License) => void (l.grants.modify = false), (u: EconomicAgreement["use"]) => void (u.modifies = ["model:peak-detect@3"])],
    ["field-of-use", (l: License) => void (l.grants.fieldsOfUse = ["genomics"]), undefined],
    ["region", (l: License) => void (l.grants.regions = ["EU"]), undefined],
    ["commercial-use", (l: License) => void (l.class = "noncommercial"), undefined],
  ])("refuses when %s is not granted", (name, mut, useMut) => {
    expect(condition(withLicense(mut, useMut))).toEqual([name]);
  });

  it("share-alike propagates to a resold composite unless the outbound terms carry the same tag", () => {
    const shareAlike = (l: License) => {
      l.class = "share-alike";
      l.shareAlikeTag = "open-models-sa";
    };
    expect(condition(withLicense(shareAlike, (u) => void (u.resell = true)))).toEqual(["share-alike"]);
    expect(
      withLicense(shareAlike, (u) => {
        u.resell = true;
        u.outbound = { class: "share-alike", shareAlikeTag: "open-models-sa" };
      }).ok,
    ).toBe(true);
    // Used as-is and not resold: share-alike does not propagate.
    expect(withLicense(shareAlike).ok).toBe(true);
  });

  it("an expired license and a self-asserted license are refused", () => {
    expect(codes(withLicense((l) => void (l.validUntil = 1_790_000_000)))).toEqual(["LICENSE_NOT_IN_FORCE"]);
    expect(codes(withLicense((l) => void (l.validFrom = 1_790_000_001)))).toEqual(["LICENSE_NOT_IN_FORCE"]);
    expect(codes(withLicense((l) => void (l.authority = "self-asserted")))).toEqual(["AUTHORITY_BELOW_FLOOR"]);
    // The floor is the server's to raise.
    expect(codes(compileEconomics(lab(), { authorityFloor: "externally-attested" }))).toEqual([
      "AUTHORITY_BELOW_FLOOR",
      "AUTHORITY_BELOW_FLOOR",
    ]);
  });

  it("a license's required payment cannot be dropped, lowered or re-routed", () => {
    const dropped = lab();
    dropped.clauses = dropped.clauses.filter((c) => c.clauseId !== "model-royalty");
    expect(codes(compileEconomics(dropped))).toEqual(["LICENSE_PAYMENT_MISSING"]);

    const lowered = lab();
    const royalty = lowered.clauses.find((c) => c.clauseId === "model-royalty")!;
    royalty.rule = { kind: "percent", bps: 200, of: "gross", min: "15000000", max: null, rateSource: null };
    expect(codes(compileEconomics(lowered))).toEqual(["LICENSE_PAYMENT_MISSING", "LICENSE_PAYMENT_UNMATCHED"]);

    const rerouted = lab();
    rerouted.splits[0]!.members[1]!.weight = 1000; // dataset A's share shrinks: not the licensor's distribution
    expect(codes(compileEconomics(rerouted))).toEqual(["LICENSE_PAYMENT_MISSING", "LICENSE_PAYMENT_UNMATCHED"]);

    const toSomeoneElse = lab();
    toSomeoneElse.clauses.find((c) => c.clauseId === "model-royalty")!.to = { party: "lab" };
    expect(codes(compileEconomics(toSomeoneElse))).toEqual(["LICENSE_PAYMENT_MISSING", "LICENSE_PAYMENT_UNMATCHED"]);
  });

  it("the rights report says what the buyer accepted, including attribution duties", () => {
    const c = ok(compileEconomics(lab()));
    expect(c.rights).toEqual([
      { licenseId: "lic-hplc-protocol", version: 2, subject: "csd:hplc-assay@2", licensor: "protocol-author", class: "permissive", attributionRequired: true, authority: "counterparty-accepted", compatible: true },
      { licenseId: "lic-peak-detect", version: 3, subject: "model:peak-detect@3", licensor: "model-author", class: "proprietary", attributionRequired: true, authority: "registry-anchored", compatible: true },
    ]);
  });
});

// ── Required: changed rate/version after acceptance does not mutate the old deal ─

describe("acceptance is immutable", () => {
  const accepted = () => {
    const c = ok(compileEconomics(exampleSparePrinter(), WITH_SCHEDULES));
    return { agreementHash: c.agreementHash, economicTermsHash: c.economicTermsHash, rightsTermsHash: c.rightsTermsHash };
  };

  it("the accepted agreement verifies and recompiles to the identical deal after a new schedule version is published", () => {
    const acc = accepted();
    expect(verifyAcceptedAgreement(acc, exampleSparePrinter()).ok).toBe(true);
    // Priya publishes v2 of her schedule at 0.80%. The accepted deal pins v1's hash and rate, so
    // compiling it again, with both schedules available, yields byte-identical output.
    const body = { version: 2, segments: [{ kind: "constant" as const, startTime: 0, endTime: null, bps: 80 }], publishedAt: "2026-09-22T00:00:00Z" };
    const v2: RateSchedule = { ...body, scheduleHash: computeScheduleHash(body) };
    const before = JSON.stringify(ok(compileEconomics(exampleSparePrinter(), WITH_SCHEDULES)));
    const after = JSON.stringify(ok(compileEconomics(exampleSparePrinter(), { schedules: [PRINTER_KIT_SCHEDULE, v2] })));
    expect(after).toBe(before);
  });

  it("a license version bumped after acceptance is refused as a RIGHTS change", () => {
    const acc = accepted();
    const changed = exampleSparePrinter();
    changed.licenses[0]!.version = 3;
    changed.clauses[0]!.underLicense = { licenseId: "lic-octoprint-fdm-kit", version: 3 };
    const v = verifyAcceptedAgreement(acc, changed);
    expect(v).toMatchObject({ ok: false, code: "AGREEMENT_HASH_MISMATCH", changed: ["rights", "economics"] });
    // A pure rights change (payments untouched) is named as rights only.
    const rightsOnly = exampleSparePrinter();
    rightsOnly.licenses[0]!.grants.regions = ["US"];
    expect(verifyAcceptedAgreement(acc, rightsOnly)).toMatchObject({ ok: false, changed: ["rights"] });
  });

  it("a re-pinned rate after acceptance is refused as an ECONOMICS change", () => {
    const acc = accepted();
    const changed = exampleSparePrinter();
    const r = changed.clauses[0]!.rule;
    if (r.kind !== "percent") throw new Error("fixture");
    r.bps = 80;
    expect(verifyAcceptedAgreement(acc, changed)).toMatchObject({ ok: false, changed: ["economics"] });
    const envelope = exampleSparePrinter();
    envelope.asOf += 1;
    expect(verifyAcceptedAgreement(acc, envelope)).toMatchObject({ ok: false, changed: ["envelope"] });
  });

  it("a pinned rate is checked against its schedule: tampered bodies and wrong pins are refused", () => {
    const wrongPin = exampleSparePrinter();
    const r = wrongPin.clauses[0]!.rule;
    if (r.kind !== "percent") throw new Error("fixture");
    r.bps = 10; // the schedule gives 40
    // The license names the schedule, so the pinned clause no longer meets it either way.
    expect(codes(compileEconomics(wrongPin, WITH_SCHEDULES))).toEqual(["RATE_PIN_MISMATCH"]);

    const tampered: RateSchedule = { ...PRINTER_KIT_SCHEDULE, segments: [{ kind: "constant", startTime: 0, endTime: null, bps: 10 }] };
    expect(codes(compileEconomics(exampleSparePrinter(), { schedules: [tampered] }))).toEqual(["SCHEDULE_HASH_MISMATCH"]);

    // Without the body, a license that names a schedule cannot be satisfied: the rate is unverified.
    expect(codes(compileEconomics(exampleSparePrinter()))).toEqual(["RATE_UNVERIFIED"]);
  });
});

// ── Participation (MUST CLOSE 7, 9) ──────────────────────────────────────────

describe("participation decides eligibility", () => {
  it("a declared contributor whose component runs nowhere in the job is owed nothing", () => {
    const ag = examplePrintAndMail();
    // The address check did not run in this job's plan.
    ag.units[1]!.components = ag.units[1]!.components.filter((c) => c.ref !== "method:address-verify@1");
    const c = ok(compileEconomics(ag));
    expect(c.notEligible).toEqual([{ clauseId: "address-check-fee", reason: "component-not-used" }]);
    expect(c.totals.byParty.find((p) => p.partyId === "inventor")).toBeUndefined();
    // Its would-be fee stays in the step and flows to the residual, not to anyone by default.
    expect(c.units[1]!.clauses.find((x) => x.clauseId === "orbit-margin")!.amount).toBe("2132000");
  });

  it("a participation-gated clause pays only inside the unit where the component runs", () => {
    const c = ok(compileEconomics(examplePrintAndMail()));
    const inventorUnits = c.units.filter((u) => u.legs.some((l) => l.partyIds.includes("inventor"))).map((u) => u.unitRef);
    expect(inventorUnits).toEqual(["b-mail"]); // released with the mail step, refunded with it
  });

  it("per-use pricing counts uses, and a once-per-job fee is charged in one unit only", () => {
    const ag = examplePrintAndMail();
    ag.units[0]!.components.push({ ref: "method:address-verify@1", uses: "3" });
    const c = ok(compileEconomics(ag));
    expect(c.units[0]!.clauses.find((x) => x.clauseId === "address-check-fee")!.amount).toBe("750000");
    const once = clone(ag);
    const fee = once.clauses.find((x) => x.clauseId === "address-check-fee")!;
    fee.appliesTo = { oncePerJobUsing: "method:address-verify@1" };
    fee.rule = { kind: "fixed", amount: "400000" };
    fee.underLicense = null;
    once.licenses.find((l) => l.licenseId === "lic-address-verify")!.requires.payments = [];
    const c2 = ok(compileEconomics(once));
    const owed = c2.units.flatMap((u) => u.clauses.filter((x) => x.clauseId === "address-check-fee").map((x) => [u.unitRef, x.amount]));
    expect(owed).toEqual([["a-print", "400000"]]); // the first unit (by unitRef) that runs it
  });
});

// ── Same recipient / same role / provenance (MUST CLOSE 8) ───────────────────

describe("identity is never lost", () => {
  it("one wallet paid in two roles is two legs; the lab is both operator and assembler", () => {
    const c = ok(compileEconomics(exampleLabAssay()));
    const lab = c.units[0]!.legs.filter((l) => l.partyIds.includes("lab"));
    expect(lab.map((l) => [l.roles[0], l.amount])).toEqual([
      ["assembler", "53647000"],
      ["operator", "320000000"],
    ]);
  });

  it("two clauses with the same identity merge into one leg that keeps both attributions", () => {
    const ag = baseAgreement({
      clauses: [
        ...baseAgreement().clauses,
        { clauseId: "bonus", label: "Bonus", role: "operator", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "1000" } },
      ],
    });
    const c = ok(compileEconomics(ag));
    expect(c.units[0]!.legs).toHaveLength(1);
    expect(c.units[0]!.legs[0]!.attribution.map((x) => [x.clauseId, x.amount])).toEqual([
      ["bonus", "1000"],
      ["rest", "975500"],
    ]);
  });

  it("two parties sharing one wallet keep separate attribution inside the merged leg", () => {
    const ag = baseAgreement({
      parties: [...baseAgreement().parties, { partyId: "seller-alias", label: "Seller (second profile)", kind: "person", payTo: a(0x5e) }],
      clauses: [
        ...baseAgreement().clauses,
        { clauseId: "alias", label: "Alias", role: "operator", to: { party: "seller-alias" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "7" } },
      ],
    });
    const leg = ok(compileEconomics(ag)).units[0]!.legs[0]!;
    expect(leg.partyIds).toEqual(["seller", "seller-alias"]);
  });

  it("more than 16 identities compact by wallet (lossless), and more than 16 wallets refuse", () => {
    const parties = [{ partyId: "buyer", label: "Buyer", kind: "person" as const, payTo: a(1) }];
    const clauses: Clause[] = [];
    for (let i = 0; i < 17; i++) {
      parties.push({ partyId: `w${i}`, label: `Worker ${i}`, kind: "person", payTo: a(0x100 + (i % 4)) });
      clauses.push({ clauseId: `c${String(i).padStart(2, "0")}`, label: `Pay ${i}`, role: "operator", to: { party: `w${i}` }, subject: `task-${i}`, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "10" } });
    }
    clauses.push({ clauseId: "rest", label: "Rest", role: "assembler", to: { party: "w0" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "residual" } });
    const c = ok(compileEconomics(baseAgreement({ parties, clauses })));
    expect(c.units[0]!.legs).toHaveLength(4);
    expect(c.units[0]!.legs.every((l) => l.compacted)).toBe(true);
    expect(c.units[0]!.legs[0]!.roles).toEqual(["assembler", "operator"]);
    assertFundable(c, 235);

    const many = baseAgreement({
      parties: parties.map((p, i) => ({ ...p, payTo: a(0x200 + i) })),
      clauses,
    });
    expect(codes(compileEconomics(many))).toEqual(["TOO_MANY_LEGS"]);
  });
});

// ── Composition node ids are valid unit references ───────────────────────────

describe("ids match the accepted-plan compiler's grammar", () => {
  it("any printable-ASCII node id (1-128, no space) is a valid unitRef", () => {
    const odd = 'print#1("a4"),\\b|c';
    const ag = baseAgreement({ units: [{ ...baseAgreement().units[0]!, unitRef: odd }] });
    const c = ok(compileEconomics(ag));
    expect(c.units[0]!.unitRef).toBe(odd);
    expect(compileEconomics(shuffleAgreement(ag, 3)).ok).toBe(true);
  });

  it("a space, a control character, non-ASCII, or 129 characters is refused", () => {
    for (const bad of ["print 1", "print\u00011", "print\u00e9", "x".repeat(129), ""]) {
      const r = compileEconomics(baseAgreement({ units: [{ ...baseAgreement().units[0]!, unitRef: bad }] }));
      expect(r.ok ? [] : r.refusals.map((x) => x.code)).toContain("SCHEMA_INVALID");
    }
  });
});

// ── Every refusal, provoked ──────────────────────────────────────────────────

describe("every refusal code is reachable", () => {
  const pctRule = { kind: "percent" as const, bps: 100, of: "gross" as const, min: "10", max: "5", rateSource: null };
  const provoke: Record<RefusalCode, () => { input: unknown; options?: CompileOptions }> = {
    SCHEMA_INVALID: () => ({ input: { ...baseAgreement(), extra: "smuggled term" } }),
    DUPLICATE_ID: () => ({ input: baseAgreement({ units: [...baseAgreement().units, ...baseAgreement().units] }) }),
    DUPLICATE_LICENSE_SUBJECT: () => {
      const ag = examplePrintAndMail();
      ag.licenses.push({ ...ag.licenses[0]!, licenseId: "another" });
      return { input: ag };
    },
    UNKNOWN_REFERENCE: () => ({ input: baseAgreement({ payer: "nobody" }) }),
    SPLIT_CYCLE: () => ({
      input: baseAgreement({
        splits: [{ splitId: "loop", label: "Loop", members: [{ to: { split: "loop" }, weight: 1, role: null, subject: null }] }],
        clauses: [{ ...baseAgreement().clauses[0]!, to: { split: "loop" } }],
      }),
    }),
    SPLIT_TOO_DEEP: () => {
      const splits = Array.from({ length: 9 }, (_, i) => ({
        splitId: `d${i}`,
        label: `D${i}`,
        members: [i === 8 ? { to: { party: "seller" }, weight: 1, role: null, subject: null } : { to: { split: `d${i + 1}` }, weight: 1, role: null, subject: null }],
      }));
      return { input: baseAgreement({ splits, clauses: [{ ...baseAgreement().clauses[0]!, to: { split: "d0" } }] }) };
    },
    DUPLICATE_SPLIT_MEMBER: () => ({
      input: baseAgreement({
        splits: [{ splitId: "dup", label: "Dup", members: [{ to: { party: "seller" }, weight: 1, role: null, subject: null }, { to: { party: "seller" }, weight: 2, role: null, subject: null }] }],
        clauses: [{ ...baseAgreement().clauses[0]!, to: { split: "dup" } }],
      }),
    }),
    FEE_INVALID: () => ({ input: baseAgreement({ fee: { feeBps: 235, feeRecipient: null } }) }),
    OFFER_EXPIRED: () => ({ input: baseAgreement({ terms: { acceptBy: 1_789_999_999, changePolicy: "new-version-required" } }) }),
    ECONOMICS_UNDECIDED_OD4: () => ({
      input: baseAgreement({
        clauses: [...baseAgreement().clauses, { clauseId: "future", label: "5% of all future revenue", role: "integrator", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "downstream", bps: 500, horizon: "forever" } }],
      }),
    }),
    INVALID_BOUNDS: () => ({
      input: baseAgreement({
        clauses: [...baseAgreement().clauses, { clauseId: "bounded", label: "Bounded", role: "verifier", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: pctRule }],
      }),
    }),
    SCHEDULE_HASH_MISMATCH: () => ({
      input: exampleSparePrinter(),
      options: { schedules: [{ ...PRINTER_KIT_SCHEDULE, segments: [{ kind: "constant", startTime: 0, endTime: null, bps: 1 }] }] },
    }),
    RATE_PIN_MISMATCH: () => {
      const ag = exampleSparePrinter();
      (ag.clauses[0]!.rule as { bps: number }).bps = 39;
      return { input: ag, options: WITH_SCHEDULES };
    },
    RIGHTS_UNKNOWN: () => ({ input: baseAgreement({ units: [{ ...baseAgreement().units[0]!, components: [{ ref: "mystery-module", uses: "1" }] }] }) }),
    LICENSE_NOT_IN_FORCE: () => {
      const ag = exampleLabAssay();
      ag.licenses[0]!.validUntil = 1;
      return { input: ag };
    },
    AUTHORITY_BELOW_FLOOR: () => {
      const ag = exampleLabAssay();
      ag.licenses[0]!.authority = "self-asserted";
      return { input: ag };
    },
    RIGHTS_INCOMPATIBLE: () => ({ input: exampleIncompatibleLicense() }),
    LICENSE_PAYMENT_MISSING: () => {
      const ag = exampleLabAssay();
      ag.clauses = ag.clauses.filter((c) => c.clauseId !== "model-royalty");
      return { input: ag };
    },
    LICENSE_PAYMENT_UNMATCHED: () => {
      const ag = examplePrintAndMail();
      ag.clauses.find((c) => c.clauseId === "print-cost")!.underLicense = { licenseId: "lic-laser-print-kit", version: 1 };
      return { input: ag };
    },
    RATE_UNVERIFIED: () => ({ input: exampleSparePrinter() }),
    GROSS_OUT_OF_RANGE: () => ({ input: baseAgreement({ units: [{ ...baseAgreement().units[0]!, gross: "4" }] }) }),
    UNKNOWN_MEASURE: () => ({
      input: baseAgreement({
        clauses: [...baseAgreement().clauses, { clauseId: "pages", label: "Per page", role: "operator", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "per_use", rate: "10", per: { measure: "pages" }, cap: null } }],
      }),
    }),
    OVER_ALLOCATED: () => ({
      input: baseAgreement({
        clauses: [...baseAgreement().clauses, { clauseId: "big", label: "Too big", role: "operator", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "999999999" } }],
      }),
    }),
    MULTIPLE_RESIDUALS: () => ({
      input: baseAgreement({ clauses: [...baseAgreement().clauses, { ...baseAgreement().clauses[0]!, clauseId: "rest2" }] }),
    }),
    UNALLOCATED_REMAINDER: () => ({
      input: baseAgreement({
        clauses: [{ clauseId: "half", label: "Half", role: "operator", to: { party: "seller" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 5000, of: "net", min: null, max: null, rateSource: null } }],
      }),
    }),
    UNRESOLVED_PARTY: () => ({ input: baseAgreement({ parties: [baseAgreement().parties[0]!, { ...baseAgreement().parties[1]!, payTo: null }] }) }),
    FORBIDDEN_RECIPIENT: () => ({ input: baseAgreement(), options: { forbiddenRecipients: [a(0x5e)] } }),
    TOO_MANY_LEGS: () => {
      const parties = [baseAgreement().parties[0]!, ...Array.from({ length: 17 }, (_, i) => ({ partyId: `x${i}`, label: `X${i}`, kind: "person" as const, payTo: a(0x300 + i) }))];
      const clauses: Clause[] = parties.slice(1).map((p, i) => ({ clauseId: `c${i}`, label: `C${i}`, role: "operator", to: { party: p.partyId }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "1" } }));
      clauses.push({ ...baseAgreement().clauses[0]!, to: { party: "x0" } });
      return { input: baseAgreement({ parties, clauses }) };
    },
  };

  it("the provocation table covers every code", () => {
    expect(Object.keys(provoke).sort()).toEqual(Object.keys(REFUSAL_CODES).sort());
  });

  it.each(Object.keys(REFUSAL_CODES) as RefusalCode[])("%s", (code) => {
    const { input, options } = provoke[code]();
    const r = compileEconomics(input, options);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.code)).toContain(code);
  });

  it("refusals are complete and deterministic: every broken unit is reported, in a fixed order", () => {
    const ag = baseAgreement({
      units: [
        { unitRef: "u2", label: "Two", gross: "4", components: [], measures: [] },
        { unitRef: "u1", label: "One", gross: "3", components: [], measures: [] },
      ],
    });
    const r = compileEconomics(ag);
    expect(r.ok ? [] : r.refusals.map((x) => x.path)).toEqual([
      ["unit", "u1"],
      ["unit", "u2"],
    ]);
  });
});
