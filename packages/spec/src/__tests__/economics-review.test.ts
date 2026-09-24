/**
 * The adversarial review of the economics compiler (reviewer-adversarial-bravo, 2026-09-24): one
 * describe block per finding, named by its id in
 * /mnt/sparkbulk/pcc-reconciliation/returns/pcc-economics-work/review/FINDINGS.md. Each test is the
 * reviewer's repro, or the closest one, turned into the behavior the fix guarantees.
 */

import { describe, expect, it } from "vitest";
import { clausesFromCompositionManifest, splitsFromContributionGraph, splitsFromTrainingManifest, type ContributionGraph } from "../economics/adapters.js";
import { compileEconomics, type CompiledEconomics, type CompileOptions, type CompileResult } from "../economics/compile.js";
import {
  exampleDeckMilestones,
  exampleIncompatibleLicense,
  exampleLabAssay,
  examplePrintAndMail,
  exampleSparePrinter,
  PRINTER_KIT_SCHEDULE,
} from "../economics/examples.js";
import { MAX_INPUT_NODES, snapshotJson } from "../economics/input.js";
import { evaluateScheduleExact, exactFraction, isqrt, valueInCents } from "../economics/rates.js";
import { simulateEconomics } from "../economics/simulate.js";
import type { Clause, EconomicAgreement } from "../economics/types.js";
import { verifyAcceptedAgreement } from "../economics/verify.js";
import { computeManifestHash, type CompositionManifest } from "../types/composition-manifest.js";
import { computeScheduleHash, evaluateRateSchedule, type RateSchedule } from "../types/rate-schedule.js";
import { computeTrainingManifestHash } from "../types/training-manifest.js";
import { a, baseAgreement, clone } from "./economics-helpers.js";

const WITH_SCHEDULES: CompileOptions = { schedules: [PRINTER_KIT_SCHEDULE] };

function ok(r: CompileResult): CompiledEconomics {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.refusals, null, 1)}`);
  return r;
}
const refusals = (r: CompileResult) => (r.ok ? [] : r.refusals.map((x) => [x.code, x.path] as const));
const codes = (r: CompileResult) => (r.ok ? [] : r.refusals.map((x) => x.code));

function schedule(segments: RateSchedule["segments"]): RateSchedule {
  const body = { version: 1, segments, publishedAt: "2026-06-01T00:00:00Z" };
  return { ...body, scheduleHash: computeScheduleHash(body) };
}

/** Example 1, re-pointed at another schedule: the license names it, the clause pins `bps` from it. */
function printerOn(s: RateSchedule, bps: number, gross = "25000000", recorded?: { evaluatedAt: number; jobValueCents: number }): EconomicAgreement {
  const ag = exampleSparePrinter();
  ag.units[0]!.gross = gross;
  ag.licenses[0]!.requires.payments[0]!.rule = { kind: "percent_by_schedule", scheduleHash: s.scheduleHash, of: "gross", min: null, max: null };
  ag.clauses.find((c) => c.clauseId === "kit-royalty")!.rule = {
    kind: "percent",
    bps,
    of: "gross",
    min: null,
    max: null,
    rateSource: { scheduleHash: s.scheduleHash, evaluatedAt: recorded?.evaluatedAt ?? ag.asOf, context: { jobValueCents: recorded?.jobValueCents ?? 0, jobsPerDay: 3, captureClass: null } },
  };
  return ag;
}

// ── C1: split fan-out ───────────────────────────────────────────────────────

describe("C1: the number of allocations is bounded before anything is expanded", () => {
  /** The reviewer's layered DAG: L levels of k splits, every split paying every split of the next level. */
  function dag(L: number, k = 8, m = 8): EconomicAgreement {
    const parties = [
      { partyId: "buyer", label: "B", kind: "person" as const, payTo: a(0xb1) },
      ...Array.from({ length: m }, (_, i) => ({ partyId: `p${i}`, label: `P${i}`, kind: "person" as const, payTo: a(0x1000 + i) })),
    ];
    const ids = (l: number) => (l === 0 ? ["L0_0"] : Array.from({ length: k }, (_, j) => `L${l}_${j}`));
    const splits = [];
    for (let l = 0; l < L; l++) {
      for (const id of ids(l)) {
        const to = l === L - 1 ? parties.slice(1).map((p) => ({ party: p.partyId })) : ids(l + 1).map((s) => ({ split: s }));
        splits.push({ splitId: id, label: id, members: to.map((t) => ({ to: t, weight: 1, role: null, subject: null })) });
      }
    }
    return baseAgreement({
      parties,
      splits,
      fee: { feeBps: 0, feeRecipient: null },
      clauses: [{ clauseId: "rest", label: "All", role: "operator", to: { split: "L0_0" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "residual" } }],
    });
  }

  it("32,768 allocations still compile, exactly", () => {
    const c = ok(compileEconomics(dag(5)));
    expect(c.units[0]!.legs).toHaveLength(8);
    expect(c.units[0]!.payouts.reduce((s, p) => s + BigInt(p.amount), 0n)).toBe(1_000_000n);
  });

  it("262 thousand, 2 million and 16 million allocations are refused in milliseconds, never thrown or run out of memory", () => {
    const started = Date.now();
    for (const L of [6, 7, 8]) {
      expect(refusals(compileEconomics(dag(L)))).toEqual([["TOO_MANY_ALLOCATIONS", []]]);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the plain-tree variant (112 clauses into 31 splits of 32 parties) is refused too", () => {
    const parties = [{ partyId: "buyer", label: "B", kind: "person" as const, payTo: a(0xb1) }, ...Array.from({ length: 33 }, (_, i) => ({ partyId: `q${i}`, label: `Q${i}`, kind: "person" as const, payTo: a(0x2000 + i) }))];
    const children = Array.from({ length: 31 }, (_, i) => ({
      splitId: `s${String(i + 1).padStart(2, "0")}`,
      label: `Child ${i}`,
      members: parties.slice(1, 33).map((p) => ({ to: { party: p.partyId }, weight: 1, role: null, subject: null })),
    }));
    const root = {
      splitId: "s00",
      label: "Root",
      members: [{ to: { party: "q32" }, weight: 1, role: null, subject: null }, ...children.map((s) => ({ to: { split: s.splitId }, weight: 1, role: null, subject: null }))],
    };
    const clauses: Clause[] = Array.from({ length: 112 }, (_, i) => ({ clauseId: `c${String(i).padStart(3, "0")}`, label: `C${i}`, role: "operator", to: { split: "s00" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 78, of: "net", min: null, max: null, rateSource: null } }));
    clauses.push({ clauseId: "rest", label: "Rest", role: "operator", to: { split: "s00" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "residual" } });
    expect(refusals(compileEconomics(baseAgreement({ parties, splits: [root, ...children], clauses })))).toEqual([["TOO_MANY_ALLOCATIONS", []]]);
  });
});

// ── H1, N3: pinned rates ─────────────────────────────────────────────────────

describe("H1: a pinned rate is checked at asOf, for every unit's value, not at a moment the composer picked", () => {
  const byValue = schedule([{ kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 10000, bpsLow: 50, bpsHigh: 400 }]);

  it("a $25,000 job cannot pin the under-$100 rate by recording a job value of 0", () => {
    const low = printerOn(byValue, 50, "25000000000", { evaluatedAt: 1_790_000_000, jobValueCents: 0 });
    expect(refusals(compileEconomics(low, { schedules: [byValue] }))).toEqual([["RATE_PIN_MISMATCH", ["clause", "kit-royalty", "rateSource"]]]);
    // The schedule's real rate for this job is 400 bps; the recorded context is ignored, not trusted.
    const c = ok(compileEconomics(printerOn(byValue, 400, "25000000000"), { schedules: [byValue] }));
    expect(c.rates).toEqual([{ clauseId: "kit-royalty", scheduleHash: byValue.scheduleHash, bps: 400, verified: true }]);
    expect(c.totals.byParty.find((p) => p.partyId === "priya")!.amount).toBe("1000000000");
  });

  it("a decaying rate is the rate at asOf, not the one ten years later", () => {
    const decay = schedule([{ kind: "linear-decay", startTime: 1_790_000_000, endTime: 1_790_000_000 + 315_360_000, startBps: 1000, endBps: 100 }]);
    const late = printerOn(decay, 100, "25000000", { evaluatedAt: 1_790_000_000 + 315_359_999, jobValueCents: 2500 });
    expect(codes(compileEconomics(late, { schedules: [decay] }))).toEqual(["RATE_PIN_MISMATCH"]);
    expect(compileEconomics(printerOn(decay, 1000), { schedules: [decay] }).ok).toBe(true);
  });

  it("a gap in the schedule at asOf is 0 bps, even when the composer records a moment inside the next segment", () => {
    const later = schedule([{ kind: "constant", startTime: 1_790_000_001, endTime: null, bps: 40 }]);
    const pinned = printerOn(later, 40, "25000000", { evaluatedAt: 1_790_000_005, jobValueCents: 2500 });
    expect(codes(compileEconomics(pinned, { schedules: [later] }))).toEqual(["RATE_PIN_MISMATCH"]);
  });

  it("an adoption-indexed rate needs the server's jobs-per-day; without it a required pin is unverified, never guessed", () => {
    const adoption = schedule([{ kind: "adoption-indexed", startTime: 0, endTime: null, scale: 1000, floorBps: 10, capBps: 500 }]);
    const ag = printerOn(adoption, 100);
    expect(codes(compileEconomics(ag, { schedules: [adoption] }))).toEqual(["RATE_UNVERIFIED"]);
    expect(compileEconomics(ag, { schedules: [adoption], rateFacts: { jobsPerDay: 100, captureClass: null } }).ok).toBe(true); // 1000 / sqrt(100)
    expect(codes(compileEconomics(printerOn(adoption, 99), { schedules: [adoption], rateFacts: { jobsPerDay: 100, captureClass: null } }))).toEqual(["RATE_PIN_MISMATCH"]);
    expect(compileEconomics(printerOn(adoption, 500), { schedules: [adoption], rateFacts: { jobsPerDay: 0, captureClass: null } }).ok).toBe(true); // cap
  });

  it("a capture-class rate uses the server's class, and the schedule's default when the server has none", () => {
    const byClass = schedule([{ kind: "capture-class-indexed", startTime: 0, endTime: null, byClass: { CC3: 120 }, default: 60 }]);
    expect(compileEconomics(printerOn(byClass, 60), { schedules: [byClass] }).ok).toBe(true);
    expect(compileEconomics(printerOn(byClass, 120), { schedules: [byClass], rateFacts: { jobsPerDay: null, captureClass: "CC3" } }).ok).toBe(true);
    expect(codes(compileEconomics(printerOn(byClass, 120), { schedules: [byClass] }))).toEqual(["RATE_PIN_MISMATCH"]);
  });

  it("an exponential decay has no exact value to round, so a required pin on one is unverified (N3)", () => {
    const exp = schedule([{ kind: "exponential-decay", startTime: 0, endTime: null, startBps: 500, endBps: 50, decayPerSecond: 1e-9 }]);
    expect(codes(compileEconomics(printerOn(exp, 90), { schedules: [exp] }))).toEqual(["RATE_UNVERIFIED"]);
    // A curve that starts at or below its floor is the floor, exactly.
    const flat = schedule([{ kind: "exponential-decay", startTime: 0, endTime: null, startBps: 40, endBps: 50, decayPerSecond: 1e-9 }]);
    expect(compileEconomics(printerOn(flat, 50), { schedules: [flat] }).ok).toBe(true);
  });
});

describe("N3: exact rate arithmetic", () => {
  const at = (s: RateSchedule, now: number, extra: Partial<Parameters<typeof evaluateScheduleExact>[1]> = {}) =>
    evaluateScheduleExact(s, { now, valueCents: 0n, jobsPerDay: null, captureClass: null, ...extra });

  it("linear decay rounds half up exactly, as Math.round does", () => {
    const s = schedule([{ kind: "linear-decay", startTime: 0, endTime: 6, startBps: 0, endBps: 3 }]);
    expect(at(s, 1)).toEqual({ ok: true, bps: 1, segmentIndex: 0 }); // 0.5 → 1
    expect(at(s, 3)).toEqual({ ok: true, bps: 2, segmentIndex: 0 }); // 1.5 → 2
    const down = schedule([{ kind: "linear-decay", startTime: 0, endTime: 4, startBps: 3, endBps: 0 }]);
    expect(at(down, 2)).toEqual({ ok: true, bps: 2, segmentIndex: 0 }); // 1.5 → 2
  });

  it("scale / sqrt(jobsPerDay) rounds half up exactly", () => {
    const s = schedule([{ kind: "adoption-indexed", startTime: 0, endTime: null, scale: 5, floorBps: 0, capBps: 10000 }]);
    expect(at(s, 0, { jobsPerDay: 4 })).toEqual({ ok: true, bps: 3, segmentIndex: 0 }); // 2.5 → 3
    expect(at(s, 0, { jobsPerDay: 3 })).toEqual({ ok: true, bps: 3, segmentIndex: 0 }); // 2.886…
    expect(at(s, 0, { jobsPerDay: 7 })).toEqual({ ok: true, bps: 2, segmentIndex: 0 }); // 1.889…
    const frac = schedule([{ kind: "adoption-indexed", startTime: 0, endTime: null, scale: 1234.5, floorBps: 0, capBps: 10000 }]);
    expect(at(frac, 0, { jobsPerDay: 9 })).toEqual({ ok: true, bps: 412, segmentIndex: 0 }); // 411.5 → 412
  });

  it("agrees with the published float evaluator wherever the float result is far from a rounding boundary", () => {
    const kinds: RateSchedule[] = [
      schedule([{ kind: "linear-decay", startTime: 100, endTime: 1_000_100, startBps: 900, endBps: 37 }]),
      schedule([{ kind: "adoption-indexed", startTime: 0, endTime: null, scale: 777.25, floorBps: 5, capBps: 300 }]),
      schedule([{ kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 5000, bpsLow: 30, bpsHigh: 90 }]),
    ];
    let compared = 0;
    for (const s of kinds) {
      for (let t = 0; t < 400; t++) {
        const now = 100 + t * 2_497;
        const jobsPerDay = 1 + t * 3;
        const cents = BigInt(t * 37);
        const exact = evaluateScheduleExact(s, { now, valueCents: cents, jobsPerDay, captureClass: null });
        const float = evaluateRateSchedule(s, { now, jobValueCents: Number(cents), jobsPerDay });
        const seg = s.segments[0]!;
        const raw =
          seg.kind === "linear-decay"
            ? seg.startBps + ((seg.endBps - seg.startBps) * (now - seg.startTime)) / (seg.endTime - seg.startTime)
            : seg.kind === "adoption-indexed"
              ? seg.scale / Math.sqrt(jobsPerDay)
              : 0;
        if (Math.abs((raw % 1) - 0.5) < 1e-6) continue; // at a boundary only exact arithmetic is right
        expect(exact).toMatchObject({ ok: true, bps: float.bps });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it("integer helpers are exact", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(10n ** 40n)).toBe(10n ** 20n);
    expect(isqrt(10n ** 40n - 1n)).toBe(10n ** 20n - 1n);
    const f = exactFraction(1234.5);
    expect(f.p * 2n).toBe(f.q * 2469n); // exactly 2469/2
    expect(exactFraction(0.1).p * 10n > exactFraction(0.1).q).toBe(true); // 0.1 as a double is slightly more than 1/10
    expect(valueInCents(25_000_000n, 6)).toBe(2500n);
    expect(valueInCents(1n, 0)).toBe(100n);
    expect(valueInCents(999n, 18)).toBe(0n);
  });
});

// ── H2 ───────────────────────────────────────────────────────────────────────

describe("H2: every compiled deal is paid work, so use.commercial cannot be switched off", () => {
  it("commercial: false is a schema refusal, and the noncommercial dataset stays refused", () => {
    const ag = exampleIncompatibleLicense() as unknown as { use: { commercial: boolean } };
    ag.use.commercial = false;
    expect(refusals(compileEconomics(ag))).toEqual([["SCHEMA_INVALID", []]]);
    expect(codes(compileEconomics(exampleIncompatibleLicense()))).toEqual(["RIGHTS_INCOMPATIBLE"]);
  });
});

// ── H3, L6 ───────────────────────────────────────────────────────────────────

describe("H3: requirements and clauses pair one to one", () => {
  const twoFees = () => {
    const ag = examplePrintAndMail();
    const lic = ag.licenses.find((l) => l.licenseId === "lic-address-verify")!;
    lic.requires.payments = [lic.requires.payments[0]!, { ...lic.requires.payments[0]!, requirementId: "maintenance-fee" }];
    return ag;
  };

  it("two identical required payments with one clause: the second is missing", () => {
    // Pairing is by requirementId, then clauseId: "maintenance-fee" < "per-use", so "per-use" is left unpaid.
    expect(refusals(compileEconomics(twoFees()))).toEqual([["LICENSE_PAYMENT_MISSING", ["license", "lic-address-verify@1", "per-use"]]]);
  });

  it("two clauses meet two identical requirements, and a third clause is not a payment the license asked for", () => {
    const ag = twoFees();
    const fee = ag.clauses.find((c) => c.clauseId === "address-check-fee")!;
    ag.clauses.push({ ...clone(fee), clauseId: "address-check-fee-2" });
    const c = ok(compileEconomics(ag));
    expect(c.totals.byParty.find((p) => p.partyId === "inventor")!.amount).toBe("500000");
    ag.clauses.push({ ...clone(fee), clauseId: "address-check-fee-3" });
    expect(refusals(compileEconomics(ag))).toEqual([["LICENSE_PAYMENT_UNMATCHED", ["clause", "address-check-fee-3", "lic-address-verify@1"]]]);
  });
});

describe("L6: a required payment is about the licensed component", () => {
  it("a royalty relabelled as another component meets nothing", () => {
    const ag = exampleSparePrinter();
    ag.clauses.find((c) => c.clauseId === "kit-royalty")!.subject = "model:someone-elses-model";
    expect(refusals(compileEconomics(ag, WITH_SCHEDULES))).toEqual([
      ["LICENSE_PAYMENT_MISSING", ["license", "lic-octoprint-fdm-kit@2", "royalty"]],
      ["LICENSE_PAYMENT_UNMATCHED", ["clause", "kit-royalty", "lic-octoprint-fdm-kit@2"]],
    ]);
  });
});

// ── M1 ───────────────────────────────────────────────────────────────────────

describe("M1: a once-per-agreement payment is spread over every unit that runs the component", () => {
  function kitAgreement(): EconomicAgreement {
    const kit = "kit:k@1";
    return baseAgreement({
      parties: [...baseAgreement().parties, { partyId: "licensor", label: "Kit licensor", kind: "person", payTo: a(0x71) }],
      units: [
        { unitRef: "a-jobA-optional-precheck", label: "Precheck", gross: "2000000", components: [{ ref: kit, uses: "1" }], measures: [] },
        { unitRef: "b-jobA-main", label: "Main A", gross: "50000000", components: [{ ref: kit, uses: "1" }], measures: [] },
        { unitRef: "c-jobB-main", label: "Main B", gross: "50000000", components: [{ ref: kit, uses: "1" }], measures: [] },
      ],
      clauses: [
        ...baseAgreement().clauses,
        { clauseId: "kit-fee", label: "Kit fee, once", role: "integrator", to: { party: "licensor" }, subject: kit, appliesTo: { oncePerAgreementUsing: kit }, underLicense: { licenseId: "lic-kit", version: 1 }, rule: { kind: "fixed", amount: "1000000" } },
      ],
      licenses: [
        {
          licenseId: "lic-kit",
          version: 1,
          label: "Kit: a flat fee per agreement",
          licensor: "licensor",
          subject: kit,
          class: "proprietary",
          shareAlikeTag: null,
          grants: { commercialUse: true, compose: true, resell: true, modify: false, fieldsOfUse: ["*"], regions: ["*"] },
          requires: { attribution: false, payments: [{ requirementId: "flat", role: "integrator", per: "agreement", payee: { licensor: true }, rule: { kind: "fixed", amount: "1000000" } }] },
          validFrom: null,
          validUntil: null,
          authority: "registry-anchored",
        },
      ],
    });
  }

  it("the fee is shared by gross, so naming a cheap unit first does not concentrate it there", () => {
    const c = ok(compileEconomics(kitAgreement()));
    const share = (ref: string) => c.units.find((u) => u.unitRef === ref)!.clauses.find((x) => x.clauseId === "kit-fee")!.amount;
    // 1,000,000 by 2 : 50 : 50 → 19607.84 / 490196.07 / 490196.07 → floors 19607 / 490196 / 490196, +1 to the precheck.
    expect([share("a-jobA-optional-precheck"), share("b-jobA-main"), share("c-jobB-main")]).toEqual(["19608", "490196", "490196"]);
  });

  it("a refunded unit refunds only its share: the licensor keeps what the released units ran", () => {
    const [r] = simulateEconomics(kitAgreement(), [
      { scenarioId: "precheck-fails", label: "Precheck refunded", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "a-jobA-optional-precheck", outcome: "refunded" }] },
    ]);
    if (!r!.ok) throw new Error(JSON.stringify(r));
    expect(r!.paid.find((p) => p.partyId === "licensor")!.amount).toBe("980392");
  });

  it("only a fixed or pass-through amount can be owed once per agreement", () => {
    const ag = kitAgreement();
    ag.clauses.find((c) => c.clauseId === "kit-fee")!.rule = { kind: "percent", bps: 100, of: "gross", min: null, max: null, rateSource: null };
    expect(refusals(compileEconomics(ag))).toEqual([["SCHEMA_INVALID", []]]);
  });

  it("clean-room round 3 (P78): when every weight is 0, every share is 0 and each unit is refused for its gross, never thrown", () => {
    const ag = kitAgreement();
    for (const u of ag.units) u.gross = "0";
    expect(refusals(compileEconomics(ag))).toEqual(ag.units.map((u) => ["GROSS_OUT_OF_RANGE", ["unit", u.unitRef]]));
  });
});

// ── M2, M4, L1, L2, L3, L4 ───────────────────────────────────────────────────

describe("M2: the server states the fee; an author-set fee cannot shrink a royalty of net", () => {
  it("a 10% 'fee' to the lab is refused when the server charges 2.35% to the treasury", () => {
    const ag = exampleLabAssay();
    ag.fee = { feeBps: 1000, feeRecipient: ag.parties.find((p) => p.partyId === "lab")!.payTo };
    const server = { fee: { feeBps: 235, feeRecipient: "0xfee0000000000000000000000000000000000fee" } };
    expect(refusals(compileEconomics(ag, server))).toEqual([["FEE_INVALID", ["fee", "server-fee"]]]);
    expect(compileEconomics(exampleLabAssay(), server).ok).toBe(true);
  });
});

describe("M4, L1: options are validated and refused, never thrown on and never silently ignored", () => {
  it("a misspelled authority floor is refused instead of disabling the floor", () => {
    const ag = exampleLabAssay();
    ag.licenses[0]!.authority = "self-asserted";
    const typo = { authorityFloor: "registry_anchored" } as unknown as CompileOptions;
    expect(refusals(compileEconomics(ag, typo))).toEqual([["SCHEMA_INVALID", ["options"]]]);
    expect(codes(compileEconomics(ag))).toEqual(["AUTHORITY_BELOW_FLOOR"]);
  });

  it.each([
    ["null options", null],
    ["a forbidden recipient that is a number", { forbiddenRecipients: [123] }],
    ["forbidden recipients as a string", { forbiddenRecipients: "0xabc" }],
    ["schedules as an object", { schedules: {} }],
    ["an unknown option", { strictness: "lax" }],
  ])("%s: SCHEMA_INVALID at options", (_, options) => {
    expect(refusals(compileEconomics(exampleSparePrinter(), options as unknown as CompileOptions))).toEqual([["SCHEMA_INVALID", ["options"]]]);
  });

  it("verify and simulate answer malformed arguments instead of throwing", () => {
    const ag = exampleSparePrinter();
    expect(verifyAcceptedAgreement({} as never, ag)).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    expect(verifyAcceptedAgreement(null as never, ag)).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    const [bad] = simulateEconomics(ag, "x" as never);
    expect(bad).toMatchObject({ scenarioId: "scenarios", ok: false });
    const [r] = simulateEconomics(ag, [{ scenarioId: "s", label: "S", grossOverrides: [], usesOverrides: [], outcomes: [] }], null as never);
    expect(r!.ok ? [] : r!.refusals.map((x) => [x.code, x.path])).toEqual([["SCHEMA_INVALID", ["options"]]]);
  });
});

describe("L2: accessors and Proxy traps cannot throw out of the compiler or show it two values", () => {
  it("a throwing getter is a schema refusal in compile, verify and simulate", () => {
    const ag = exampleSparePrinter() as unknown as Record<string, unknown>;
    Object.defineProperty(ag, "agreementId", { enumerable: true, get() { throw new Error("boom"); } });
    expect(refusals(compileEconomics(ag))).toEqual([["SCHEMA_INVALID", []]]);
    expect(verifyAcceptedAgreement({ agreementHash: `0x${"0".repeat(64)}`, economicTermsHash: `0x${"0".repeat(64)}`, rightsTermsHash: `0x${"0".repeat(64)}` }, ag)).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    expect(simulateEconomics(ag, [{ scenarioId: "s", label: "S", grossOverrides: [], usesOverrides: [], outcomes: [] }])[0]!.ok).toBe(false);
  });

  it("Proxy traps that throw, and a getter that answers differently each time, are refused", () => {
    const hostile = new Proxy(exampleSparePrinter(), { ownKeys() { throw new Error("trap"); } });
    expect(refusals(compileEconomics(hostile))).toEqual([["SCHEMA_INVALID", []]]);
    let reads = 0;
    const flipping = exampleSparePrinter() as unknown as Record<string, unknown>;
    Object.defineProperty(flipping, "asOf", { enumerable: true, get: () => (reads++ === 0 ? 1_790_000_000 : 1) });
    expect(refusals(compileEconomics(flipping))).toEqual([["SCHEMA_INVALID", []]]);
  });

  it("a Proxy that only reads is compiled from one consistent snapshot", () => {
    const seen: string[] = [];
    const watched = new Proxy(exampleSparePrinter(), {
      getOwnPropertyDescriptor(t, k) {
        seen.push(String(k));
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    expect(JSON.stringify(compileEconomics(watched, WITH_SCHEDULES))).toBe(JSON.stringify(compileEconomics(exampleSparePrinter(), WITH_SCHEDULES)));
    expect(seen.filter((k) => k === "asOf")).toHaveLength(1); // read exactly once
  });
});

describe("L3: a supplied schedule body is trusted only for the hash it has", () => {
  it("a decoy body under the real label is refused in either order", () => {
    const decoy = { ...PRINTER_KIT_SCHEDULE, segments: [{ kind: "constant" as const, startTime: 0, endTime: null, bps: 1 }] };
    for (const schedules of [[decoy, PRINTER_KIT_SCHEDULE], [PRINTER_KIT_SCHEDULE, decoy]]) {
      expect(refusals(compileEconomics(exampleSparePrinter(), { schedules }))).toEqual([["SCHEMA_INVALID", ["options"]]]);
    }
    expect(compileEconomics(exampleSparePrinter(), { schedules: [PRINTER_KIT_SCHEDULE, clone(PRINTER_KIT_SCHEDULE)] }).ok).toBe(true);
  });
});

describe("L4: a schema refusal does not depend on array order", () => {
  it("an invalid label is the same refusal wherever the party sits", () => {
    const at = (i: number) => {
      const ag = exampleSparePrinter();
      ag.parties[2]!.label = "bad\u0001label";
      const [bad] = ag.parties.splice(2, 1);
      ag.parties.splice(i, 0, bad!);
      return refusals(compileEconomics(ag, WITH_SCHEDULES));
    };
    expect(at(0)).toEqual([["SCHEMA_INVALID", []]]);
    expect(at(2)).toEqual(at(0));
  });
});

// ── L5, N1 ───────────────────────────────────────────────────────────────────

describe("L5, N1: scenarios are sets of per-unit facts, sized for real agreements", () => {
  it("two outcomes or two prices for one unit are refused, not resolved by order", () => {
    const deck = exampleDeckMilestones();
    for (const outcomes of [
      [{ unitRef: "m2-build", outcome: "released" as const }, { unitRef: "m2-build", outcome: "refunded" as const }],
      [{ unitRef: "m2-build", outcome: "refunded" as const }, { unitRef: "m2-build", outcome: "released" as const }],
    ]) {
      const [r] = simulateEconomics(deck, [{ scenarioId: "dup", label: "Dup", grossOverrides: [], usesOverrides: [], outcomes }]);
      expect(r!.ok ? [] : r!.refusals.map((x) => [x.code, x.path])).toEqual([["SCHEMA_INVALID", ["scenario"]]]);
    }
    const [g] = simulateEconomics(deck, [
      { scenarioId: "dup", label: "Dup", grossOverrides: [{ unitRef: "m2-build", gross: "3000000000" }, { unitRef: "m2-build", gross: "6500000000" }], usesOverrides: [], outcomes: [] },
    ]);
    expect(g!.ok).toBe(false);
  });

  it("an all-refunded scenario for a 20-unit agreement is accepted", () => {
    const units = Array.from({ length: 20 }, (_, i) => ({ unitRef: `u${String(i).padStart(2, "0")}`, label: `U${i}`, gross: "1000000", components: [], measures: [] }));
    const [r] = simulateEconomics(baseAgreement({ units }), [
      { scenarioId: "all-fail", label: "Everything fails", grossOverrides: [], usesOverrides: [], outcomes: units.map((u) => ({ unitRef: u.unitRef, outcome: "refunded" as const })) },
    ]);
    if (!r!.ok) throw new Error(JSON.stringify(r));
    expect(r!.payer).toEqual({ partyId: "buyer", spent: "0", refunded: "20000000", reserved: "0" });
    expect(r!.paid).toEqual([]);
  });
});

// ── L9 ───────────────────────────────────────────────────────────────────────

describe("L9: bounds are checked on every requirement kind that has them", () => {
  it("a percent_by_schedule requirement with min > max is INVALID_BOUNDS, used or not", () => {
    const ag = exampleSparePrinter();
    ag.licenses.push({
      ...clone(ag.licenses[0]!),
      licenseId: "lic-unused",
      subject: "kit:unused@1",
      requires: { attribution: false, payments: [{ requirementId: "bounded", role: "integrator", per: "using-unit", payee: { licensor: true }, rule: { kind: "percent_by_schedule", scheduleHash: PRINTER_KIT_SCHEDULE.scheduleHash, of: "gross", min: "10", max: "5" } }] },
    });
    expect(refusals(compileEconomics(ag, WITH_SCHEDULES))).toEqual([["INVALID_BOUNDS", ["license", "lic-unused@2", "requirement", "bounded"]]]);
  });
});

// ── L10 ──────────────────────────────────────────────────────────────────────

describe("L10: acceptance binds agreementHash", () => {
  it("the terms hashes alone do not bind asOf, which is why agreementHash is what acceptance records", () => {
    const c = ok(compileEconomics(exampleSparePrinter(), WITH_SCHEDULES));
    const backdated = exampleSparePrinter();
    backdated.asOf -= 315_360_000;
    backdated.terms.acceptBy = null;
    const b = ok(compileEconomics(backdated, WITH_SCHEDULES));
    expect([b.economicTermsHash, b.rightsTermsHash]).toEqual([c.economicTermsHash, c.rightsTermsHash]);
    expect(b.agreementHash).not.toBe(c.agreementHash);
    expect(verifyAcceptedAgreement({ agreementHash: c.agreementHash, economicTermsHash: c.economicTermsHash, rightsTermsHash: c.rightsTermsHash }, backdated)).toMatchObject({ ok: false, changed: ["envelope"] });
  });
});

// ── Adapters: M5, M6, M7, L7, L8 ─────────────────────────────────────────────

describe("M5, M6: contribution graphs", () => {
  const node = (nodeId: string, party: string | null, retainWeight: number, extra: Partial<ContributionGraph["nodes"][number]> = {}): ContributionGraph["nodes"][number] => ({
    nodeId,
    label: nodeId,
    party,
    role: "integrator",
    subject: null,
    componentRef: null,
    participationRequired: false,
    retainWeight,
    ...extra,
  });
  const parties = ["m", "x", "y"].map((p, i) => ({ partyId: p, label: p, kind: "person" as const, payTo: a(0x60 + i) }));
  const pool = (to: Clause["to"]): Clause => ({ clauseId: "pool", label: "Pool", role: "integrator", to, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 1000, of: "gross", min: null, max: null, rateSource: null } });
  const run = (g: ContributionGraph, used = new Set<string>()) => {
    const r = splitsFromContributionGraph(g, used, "g");
    if (!r.ok) return r.refusals.map((x) => x.code).join(",");
    const ag = baseAgreement({
      parties: [...baseAgreement().parties, ...parties],
      splits: r.splits,
      clauses: [pool(r.rootPayee), ...baseAgreement().clauses],
      fee: { feeBps: 0, feeRecipient: null },
    });
    return Object.fromEntries(ok(compileEconomics(ag)).totals.byParty.map((p) => [p.partyId, p.amount]));
  };

  it("a routing node is a pool: when one of its edges drops, the rest of the pool shares its inflow (specified, docs §8)", () => {
    const g: ContributionGraph = {
      schema: "pcc.contribution-graph.v1",
      graphId: "g",
      root: "M",
      nodes: [node("M", "m", 50), node("R", null, 0), node("X", "x", 1), node("Y", "y", 1)],
      edges: [
        { from: "M", to: "R", weight: 50, accepted: true },
        { from: "R", to: "X", weight: 1, accepted: true },
        { from: "R", to: "Y", weight: 1, accepted: false },
      ],
    };
    // Pool of 100,000: m keeps 50%, the routing pool R gets 50%, and X is the pool's only accepted member.
    expect(run(g)).toMatchObject({ m: "50000", x: "50000" });
  });

  it("the root obeys participation: a root whose component did not run is owed nothing (M6)", () => {
    const g: ContributionGraph = {
      schema: "pcc.contribution-graph.v1",
      graphId: "g",
      root: "M",
      nodes: [node("M", "m", 1, { componentRef: "fw:not-run", participationRequired: true })],
      edges: [],
    };
    expect(run(g, new Set(["something-else"]))).toBe("GRAPH_EMPTY");
    expect(run(g, new Set(["fw:not-run"]))).toMatchObject({ m: "100000" });
  });
});

describe("M7, L7: training manifests and lookup tables", () => {
  const tm = (datasets: Array<{ datasetIpId: string; weightBps: number }>) => {
    const body = { modelIpId: "model:m", datasets, trainedAt: "2026-09-01T00:00:00Z" };
    return { ...body, manifestHash: computeTrainingManifestHash(body) };
  };
  const code = (r: ReturnType<typeof splitsFromTrainingManifest>) => (r.ok ? "ok" : r.refusals.map((x) => x.code).join(","));

  it("dataset weights that do not total 10000 are refused, not used to overpay a dataset (M7)", () => {
    expect(code(splitsFromTrainingManifest({ manifest: tm([{ datasetIpId: "ds:1", weightBps: 2500 }]), modelAuthorParty: "x", passThroughBps: 4000, datasetParty: { "ds:1": "y" } }, "lin"))).toBe("MANIFEST_INVALID");
    expect(code(splitsFromTrainingManifest({ manifest: tm([]), modelAuthorParty: "x", passThroughBps: 4000, datasetParty: {} }, "lin"))).toBe("MANIFEST_INVALID");
    expect(code(splitsFromTrainingManifest({ manifest: tm([{ datasetIpId: "ds:1", weightBps: 10000 }]), modelAuthorParty: "x", passThroughBps: 4000, datasetParty: { "ds:1": "y" } }, "lin"))).toBe("ok");
  });

  it("prototype keys are not parties (L7)", () => {
    expect(code(splitsFromTrainingManifest({ manifest: tm([{ datasetIpId: "constructor", weightBps: 10000 }]), modelAuthorParty: "x", passThroughBps: 4000, datasetParty: {} }, "lin"))).toBe("UNKNOWN_CONTRIBUTOR");
    const body = { capabilityIpId: "cap:print", entries: [{ ipId: "ip:a", role: "integrator" as const, contributorAddress: "__proto__", rateScheduleHash: `0x${"ab".repeat(32)}` }], builtAt: "2026-09-24T00:00:00Z" };
    const m = { ...body, manifestHash: computeManifestHash(body) } as unknown as CompositionManifest;
    const rateSource = { scheduleHash: `0x${"ab".repeat(32)}`, evaluatedAt: 0, context: { jobValueCents: 0, jobsPerDay: 0, captureClass: null } };
    const r = clausesFromCompositionManifest({ manifest: m, pinnedRates: [{ bps: 10, rateSource }], partyByAddress: {}, appliesTo: { allUnits: true }, idPrefix: "p" });
    expect(r.ok ? "ok" : r.refusals.map((x) => x.code).join(",")).toBe("UNKNOWN_CONTRIBUTOR");
  });
});

describe("L8: the CompositionManifest adapter emits only valid ids and real members", () => {
  const SCHED = `0x${"ab".repeat(32)}`;
  const rateSource = { scheduleHash: SCHED, evaluatedAt: 0, context: { jobValueCents: 0, jobsPerDay: 0, captureClass: null } };
  const run = (entries: CompositionManifest["entries"]) => {
    const body = { capabilityIpId: "cap:print", entries, builtAt: "2026-09-24T00:00:00Z" };
    return clausesFromCompositionManifest({
      manifest: { ...body, manifestHash: computeManifestHash(body) },
      pinnedRates: [{ bps: 100, rateSource }],
      partyByAddress: { [a(0x11)]: "alice", [a(0x12)]: "bob" },
      appliesTo: { allUnits: true },
      idPrefix: "m",
    });
  };
  const entry = (ipId: string, addr: number, groupBps?: number) => ({ ipId, role: "integrator" as const, contributorAddress: a(addr), rateScheduleHash: SCHED, ...(groupBps === undefined ? {} : { groupBps }) });

  it.each([["ip with space"], ["x".repeat(129)], ["😀".repeat(100)]])("ipId %j is refused as an invalid id", (ipId) => {
    const r = run([entry(ipId, 0x11)]);
    expect(r.ok ? "ok" : r.refusals.map((x) => x.code).join(",")).toBe("INVALID_ID");
  });

  it("a co-author with groupBps 0 holds no share and is not made a zero-weight member", () => {
    const r = run([entry("ip:a", 0x11, 10000), entry("ip:a", 0x12, 0)]);
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.splits).toEqual([]);
    expect(r.clauses[0]!.to).toEqual({ party: "alice" });
  });
});

// ── Clean-room round 2 (spec at bad29552) ────────────────────────────────────

describe("clean-room round 2: ids, options and value bands", () => {
  it("P28: a duplicated split id gives the same refusals in any order (id-resolving checks are skipped)", () => {
    const loop = { splitId: "s", label: "Loop", members: [{ to: { split: "s" }, weight: 1, role: null, subject: null }] };
    const plain = { splitId: "s", label: "Plain", members: [{ to: { party: "seller" }, weight: 1, role: null, subject: null }] };
    const run = (splits: EconomicAgreement["splits"]) => refusals(compileEconomics(baseAgreement({ splits, clauses: [{ ...baseAgreement().clauses[0]!, to: { split: "s" } }] })));
    expect(run([loop, plain])).toEqual([["DUPLICATE_ID", ["split", "s"]]]);
    expect(run([plain, loop])).toEqual(run([loop, plain]));
  });

  it("P62: rateFacts fields may each be omitted, meaning null", () => {
    const byClass = schedule([{ kind: "capture-class-indexed", startTime: 0, endTime: null, byClass: { CC3: 120 }, default: 60 }]);
    expect(compileEconomics(printerOn(byClass, 120), { schedules: [byClass], rateFacts: { captureClass: "CC3" } }).ok).toBe(true);
    expect(compileEconomics(printerOn(byClass, 60), { schedules: [byClass], rateFacts: {} }).ok).toBe(true);
  });

  it("the server's fee option obeys the fee rules of §2 itself", () => {
    const bad = { fee: { feeBps: 0, feeRecipient: "0xfee0000000000000000000000000000000000fee" } };
    expect(refusals(compileEconomics(exampleSparePrinter(), { ...WITH_SCHEDULES, ...bad }))).toEqual([["SCHEMA_INVALID", ["options"]]]);
  });

  it("P73/P74: a zero-span linear decay or a segment ending before it starts is a malformed schedule option", () => {
    for (const segments of [
      [{ kind: "linear-decay" as const, startTime: 10, endTime: 10, startBps: 100, endBps: 50 }],
      [{ kind: "constant" as const, startTime: 10, endTime: 5, bps: 40 }],
    ]) {
      const body = { version: 1, segments, publishedAt: "2026-06-01T00:00:00Z" };
      const bad: RateSchedule = { ...body, scheduleHash: computeScheduleHash(body) };
      expect(refusals(compileEconomics(exampleSparePrinter(), { schedules: [bad] }))).toEqual([["SCHEMA_INVALID", ["options"]]]);
    }
  });

  it("v1 limitation, specified: a required scheduled royalty whose units fall in different value bands is refused, never under-paid", () => {
    const byValue = schedule([{ kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 10000, bpsLow: 50, bpsHigh: 400 }]);
    const ag = printerOn(byValue, 400, "25000000000");
    ag.units.push({ unitRef: "small", label: "A $25 job", gross: "25000000", components: [{ ref: "kit:octoprint-fdm@2", uses: "1" }], measures: [] });
    ag.clauses.find((c) => c.clauseId === "printer-owner")!.appliesTo = { allUnits: true };
    // One clause over both units cannot match both bands; per-band clauses have no requirement key.
    expect(codes(compileEconomics(ag, { schedules: [byValue] }))).toEqual(["RATE_PIN_MISMATCH"]);
    const perBand = clone(ag);
    const royalty = perBand.clauses.find((c) => c.clauseId === "kit-royalty")!;
    perBand.clauses = perBand.clauses.filter((c) => c.clauseId !== "kit-royalty");
    perBand.clauses.push({ ...clone(royalty), clauseId: "kit-royalty-big", appliesTo: { units: ["print"] } });
    perBand.clauses.push({ ...clone(royalty), clauseId: "kit-royalty-small", appliesTo: { units: ["small"] }, rule: { ...(royalty.rule as Extract<Clause["rule"], { kind: "percent" }>), bps: 50 } });
    expect(codes(compileEconomics(perBand, { schedules: [byValue] }))).toEqual([
      "LICENSE_PAYMENT_MISSING",
      "LICENSE_PAYMENT_UNMATCHED",
      "LICENSE_PAYMENT_UNMATCHED",
    ]);
  });
});

// ── coord-watch cross-family review of #360 (astra), P1-3 ───────────────────

describe("coord-watch #360 P1-3: every payout-bearing pinned rate must verify, license or not", () => {
  const freeClause = (scheduleHash: string): Clause => ({
    clauseId: "tip",
    label: "A royalty nobody required",
    role: "integrator",
    to: { party: "priya" },
    subject: null,
    appliesTo: { allUnits: true },
    underLicense: null,
    rule: { kind: "percent", bps: 10, of: "gross", min: null, max: null, rateSource: { scheduleHash, evaluatedAt: 1_790_000_000, context: { jobValueCents: 0, jobsPerDay: 0, captureClass: null } } },
  });

  it("an absent schedule body refuses at the clause", () => {
    const ag = exampleSparePrinter();
    ag.clauses.push(freeClause(`0x${"cd".repeat(32)}`));
    expect(refusals(compileEconomics(ag, WITH_SCHEDULES))).toEqual([["RATE_UNVERIFIED", ["clause", "tip", "rateSource"]]]);
  });

  it("an unevaluable segment refuses at the clause", () => {
    const exp = schedule([{ kind: "exponential-decay", startTime: 0, endTime: null, startBps: 500, endBps: 5, decayPerSecond: 1e-9 }]);
    const ag = exampleSparePrinter();
    ag.clauses.push(freeClause(exp.scheduleHash));
    expect(refusals(compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE, exp] }))).toEqual([["RATE_UNVERIFIED", ["clause", "tip", "rateSource"]]]);
  });

  it("a pin that pays in no unit is not payout-bearing and is not refused", () => {
    const ag = exampleSparePrinter();
    ag.clauses.push({ ...freeClause(`0x${"cd".repeat(32)}`), appliesTo: { usingComponent: "kit:never-used" } });
    expect(compileEconomics(ag, WITH_SCHEDULES).ok).toBe(true);
  });
});

// ── Clean-room round 3 (spec at 0ab9cdbf) ────────────────────────────────────

describe("clean-room round 3: schedule bodies, unit selection, the verified flag and input size", () => {
  const pinned = (clauseId: string, scheduleHash: string, appliesTo: Clause["appliesTo"], bps = 10): Clause => ({
    clauseId,
    label: "A royalty nobody required",
    role: "integrator",
    to: { party: "priya" },
    subject: null,
    appliesTo,
    underLicense: null,
    rule: { kind: "percent", bps, of: "gross", min: null, max: null, rateSource: { scheduleHash, evaluatedAt: 1_790_000_000, context: { jobValueCents: 0, jobsPerDay: 0, captureClass: null } } },
  });

  it("P84: an unknown key inside a segment is dropped before hashing, as the registry does when it publishes", () => {
    const clean = schedule([{ kind: "constant", startTime: 0, endTime: null, bps: 100 }]);
    const noted = { ...clean, segments: [{ ...clean.segments[0]!, note: "x" }] } as unknown as RateSchedule;
    const r = ok(compileEconomics(printerOn(clean, 100), { schedules: [noted] }));
    expect(r.rates).toEqual([{ clauseId: "kit-royalty", scheduleHash: clean.scheduleHash, bps: 100, verified: true }]);
    // A label computed over the key is a body that does not hash to its own label.
    const relabelled = { ...noted, scheduleHash: computeScheduleHash({ version: 1, segments: noted.segments }) };
    expect(relabelled.scheduleHash).not.toBe(clean.scheduleHash);
    expect(refusals(compileEconomics(printerOn(relabelled, 100), { schedules: [relabelled] }))).toEqual([["SCHEMA_INVALID", ["options"]]]);
  });

  it("a capture-class-indexed segment's byClass is the one closed object in a schedule body", () => {
    const body = { version: 1, segments: [{ kind: "capture-class-indexed", startTime: 0, endTime: null, byClass: { CC3: 120, CC9: 5 }, default: 60 }], publishedAt: "2026-06-01T00:00:00Z" };
    const bad = { ...body, scheduleHash: computeScheduleHash(body as unknown as RateSchedule) } as unknown as RateSchedule;
    expect(refusals(compileEconomics(printerOn(bad, 60), { schedules: [bad] }))).toEqual([["SCHEMA_INVALID", ["options"]]]);
  });

  it("P89: a clause that names only unknown units pays in no unit, so its missing body is not a refusal", () => {
    const ag = exampleSparePrinter();
    ag.clauses.push(pinned("ghost", `0x${"cd".repeat(32)}`, { units: ["nope"] }));
    expect(codes(compileEconomics(ag, WITH_SCHEDULES))).toEqual(["UNKNOWN_REFERENCE"]);
  });

  it("P81: the pin of a clause that pays in no unit is never compared, so it is not verified, body or not", () => {
    const matching = schedule([{ kind: "constant", startTime: 0, endTime: null, bps: 10 }]);
    const contradicting = schedule([{ kind: "constant", startTime: 0, endTime: null, bps: 100 }]);
    for (const [s, supplied] of [
      [`0x${"cd".repeat(32)}`, []],
      [matching.scheduleHash, [matching]],
      [contradicting.scheduleHash, [contradicting]],
    ] as const) {
      const ag = exampleSparePrinter();
      ag.clauses.push(pinned("tip", s, { usingComponent: "kit:never-used" }));
      const r = ok(compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE, ...supplied] }));
      expect(r.rates.find((x) => x.clauseId === "tip")).toEqual({ clauseId: "tip", scheduleHash: s, bps: 10, verified: false });
      expect(r.rates.find((x) => x.clauseId === "kit-royalty")!.verified).toBe(true);
      expect(r.notEligible).toContainEqual({ clauseId: "tip", reason: "component-not-used" });
    }
  });

  it("input depth: containers may sit at depths 0..63, and a scalar at depth 64", () => {
    const nest = (containers: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < containers; i++) v = [v];
      return v;
    };
    expect(snapshotJson(nest(64)).ok).toBe(true);
    expect(snapshotJson(nest(65))).toEqual({ ok: false, reason: expect.stringContaining("nests deeper than 64") });
  });

  it("input size: every value counts once, containers and the input itself included", () => {
    // 1 outer array + 16 inner arrays + scalars = exactly MAX_INPUT_NODES values; one more scalar is refused.
    const scalars = MAX_INPUT_NODES - 17;
    const build = (extra: number) =>
      Array.from({ length: 16 }, (_, i) => new Array<number>(Math.floor(scalars / 16) + (i < scalars % 16 ? 1 : 0) + (i === 0 ? extra : 0)).fill(0));
    expect(snapshotJson(build(0)).ok).toBe(true);
    expect(snapshotJson(build(1))).toEqual({ ok: false, reason: `more than ${MAX_INPUT_NODES} values` });
  });

  it("only own enumerable properties are read, as JSON.stringify does", () => {
    const o = { x: 1 };
    Object.defineProperty(o, "hidden", { value: 2, enumerable: false });
    expect(snapshotJson(o)).toEqual({ ok: true, value: { x: 1 } });
  });
});
