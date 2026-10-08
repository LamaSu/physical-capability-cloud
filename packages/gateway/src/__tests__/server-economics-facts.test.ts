/**
 * serverEconomicsFacts (R15-core, steward #6691): the facts the economics binding checks an agreement against are
 * the server's, from server sources only. Where a source does not exist yet (operator item 27's license and party
 * registries, the plan's intended use, what runs in each unit, a unit's rate facts), the facts are REFUSED by name;
 * nothing stands in for them.
 *
 * REAL code on the end-to-end path: the facts service, the contributors registry (in memory), economics'
 * `agreementUnitGross` and `netSplitterFor`, R10 `revalidatePlanSnapshots`, the accept seam and R12
 * `compileAcceptedPlan`. STAND-INS, labelled as such: item 27's registries and the two plan sources (none exists
 * yet, so the tests answer as an honest server would, from the agreement's own terms), the live rows, evidence's
 * requirement map and the R13 reservation record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, computeScheduleHash, economics, type EvidenceRequirement, type RateSchedule } from "@pcc/spec";
import { closeStore, getRepos, initStore } from "../db.js";
import {
  ECONOMICS_FACTS_REFUSAL_CODES,
  configuredProtocolFee,
  economicsBindingFor,
  ownedJson,
  productionEconomicsFactsSources,
  sealedSchedules,
  serverEconomicsFacts,
  type EconomicsFactsRequest,
  type EconomicsFactsSources,
  type PlanNodeRef,
} from "../services/server-economics-facts.js";
import { acceptExternalPlan, type ExternalPlanSubmission, type ReservationRecord, type SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";

type EconomicAgreement = economics.EconomicAgreement;

const TREASURY = "0xfee0000000000000000000000000000000000fee"; // the examples' fee recipient
const TOKEN = "0x00000000000000000000000000000000000e5c0f";
const FACTORY = "0x00000000000000000000000000000000000fac70";
const ZERO = "0x0000000000000000000000000000000000000000";
const AS_OF = economics.examplePrintAndMail().asOf;
const NOW = AS_OF + 600;
const ENV = { PCC_PROTOCOL_FEE_BPS: "235", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY, PCC_FORBIDDEN_RECIPIENTS: `${TOKEN},${FACTORY}` };
const NODES: PlanNodeRef[] = [
  { nodeId: "a-print", capabilityId: "cap-print" },
  { nodeId: "b-mail", capabilityId: "cap-mail" },
];

const codes = (r: { ok: boolean; refusals?: Array<{ code: string }> }) => (r.ok ? "ok" : r.refusals!.map((x) => x.code));
const request = (agreement: unknown, over: Partial<EconomicsFactsRequest> = {}): EconomicsFactsRequest => ({ agreement, nodes: NODES, currency: "USDC", now: NOW, ...over });

/** Today's sources (configuration set): the contributors registry, and no item 27 registries or plan sources. */
const today = (env: NodeJS.ProcessEnv = { ...ENV }): EconomicsFactsSources => ({ ...productionEconomicsFactsSources(), env });

/**
 * Every source present. Item 27's registries and the plan sources do not exist yet, so these stand-ins answer as an
 * honest server would: its registry copies equal the agreement's licenses and payout addresses, and each node runs
 * what the agreement's unit says.
 */
function honest(ag: EconomicAgreement, over: Partial<EconomicsFactsSources> = {}): EconomicsFactsSources {
  const licenses = new Map(ag.licenses.map((l) => [`${l.licenseId}@${l.version}`, structuredClone(l)] as const));
  const payTo = new Map(ag.parties.flatMap((p) => (p.payTo === null ? [] : [[p.partyId, p.payTo] as const])));
  return {
    env: { ...ENV },
    sealedSchedules,
    licenseRegistry: (id, version) => structuredClone(licenses.get(`${id}@${version}`)) ?? null,
    partyRegistry: (id) => payTo.get(id) ?? null,
    intendedUse: () => structuredClone(ag.use),
    unitFacts: (nodes) =>
      Object.fromEntries(
        nodes.map((n) => {
          const u = ag.units.find((x) => x.unitRef === n.nodeId);
          return [n.nodeId, { components: structuredClone(u?.components ?? []), measures: structuredClone(u?.measures ?? []) }];
        }),
      ),
    ...over,
  };
}

function publish(s: RateSchedule): void {
  getRepos().contributors.publishSchedule({
    scheduleHash: s.scheduleHash,
    version: s.version,
    segmentsJson: canonicalize(s.segments),
    notes: s.notes ?? null,
    publishedBy: "0x00000000000000000000000000000000009a1a03",
    publishedAt: s.publishedAt,
  });
}

function sealed(segments: RateSchedule["segments"]): RateSchedule {
  const body = { version: 1, segments, publishedAt: "2026-06-01T00:00:00Z" };
  return { ...body, scheduleHash: computeScheduleHash(body) };
}

/** The spare-printer example, with its kit royalty pinned from `s` instead of the bundled schedule. */
function pinnedTo(s: RateSchedule): EconomicAgreement {
  const ag = economics.exampleSparePrinter();
  ag.licenses[0]!.requires.payments[0]!.rule = { kind: "percent_by_schedule", scheduleHash: s.scheduleHash, of: "gross", min: null, max: null };
  const royalty = ag.clauses.find((c) => c.clauseId === "kit-royalty")!;
  if (royalty.rule.kind !== "percent" || royalty.rule.rateSource === null) throw new Error("fixture");
  royalty.rule.rateSource.scheduleHash = s.scheduleHash;
  return ag;
}

let savedDbPath: string | undefined;
beforeEach(() => {
  savedDbPath = process.env.PCC_DB_PATH;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
});
afterEach(() => {
  closeStore();
  if (savedDbPath === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = savedDbPath;
});

describe("today: the facts item 27 and the missing sources would supply are refused by name", () => {
  it("production's sources are configuration and the contributors registry, nothing more", () => {
    const s = productionEconomicsFactsSources();
    expect(s.env).toBe(process.env);
    expect(s.sealedSchedules).toBe(sealedSchedules);
    expect([s.licenseRegistry, s.partyRegistry, s.intendedUse, s.unitFacts]).toEqual([null, null, null, null]);
  });

  it("an agreement that cites licenses: every missing source is named, in a fixed order, and no binding is built", () => {
    const expected = ["LICENSE_REGISTRY_UNAVAILABLE", "PARTY_REGISTRY_UNAVAILABLE", "INTENDED_USE_UNAVAILABLE", "UNIT_FACTS_UNAVAILABLE"];
    expect(codes(serverEconomicsFacts(request(economics.examplePrintAndMail()), today()))).toEqual(expected);
    const bound = economicsBindingFor({ ...request(economics.examplePrintAndMail()), accepted: null }, today());
    expect(bound.ok).toBe(false);
    expect(codes(bound)).toEqual(expected);
  });

  it("an agreement that cites no license needs no license registry; the other missing sources still refuse", () => {
    const ag = economics.examplePrintAndMail();
    ag.licenses = [];
    expect(codes(serverEconomicsFacts(request(ag), today()))).toEqual(["PARTY_REGISTRY_UNAVAILABLE", "INTENDED_USE_UNAVAILABLE", "UNIT_FACTS_UNAVAILABLE"]);
  });

  it("the refusal codes are a closed list, and every refusal is one of them", () => {
    expect(new Set(ECONOMICS_FACTS_REFUSAL_CODES).size).toBe(ECONOMICS_FACTS_REFUSAL_CODES.length);
    const r = serverEconomicsFacts(request({ not: "an agreement" }, { nodes: "x" as never, now: -1, currency: "USDT" }), today({}));
    expect(codes(r)).toEqual([
      "AGREEMENT_UNREADABLE",
      "PLAN_INVALID",
      "CLOCK_INVALID",
      "CURRENCY_NOT_SUPPORTED",
      "FEE_NOT_CONFIGURED",
      "FORBIDDEN_RECIPIENTS_NOT_CONFIGURED",
      "PARTY_REGISTRY_UNAVAILABLE",
      "INTENDED_USE_UNAVAILABLE",
      "UNIT_FACTS_UNAVAILABLE",
    ]);
    for (const c of codes(r)) expect(ECONOMICS_FACTS_REFUSAL_CODES).toContain(c);
  });
});

describe("with every source present, the facts are the server's", () => {
  it("fee and forbidden recipients from configuration, decimals from the compiler's table, the request's clock, registry rows", () => {
    const ag = economics.examplePrintAndMail();
    const r = serverEconomicsFacts(request(ag), honest(ag));
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.facts).toMatchObject({ feeBps: 235, feeRecipient: TREASURY, currency: { code: "USDC", decimals: 6 }, now: NOW, schedules: [] });
    expect(r.facts.forbiddenRecipients).toEqual([TOKEN, FACTORY]);
    expect(r.facts.licenses.map((l) => `${l.licenseId}@${l.version}`)).toEqual(["lic-address-verify@1", "lic-laser-print-kit@1", "lic-letter-mail@3"]);
    expect(r.facts.parties.map((p) => p.partyId)).toEqual(["buyer", "courier", "inventor", "orbit", "printshop"]);
    expect(Object.keys(r.facts.unitFacts)).toEqual(["a-print", "b-mail"]);
    // Policy values are left to the binding and the compiler, never filled in here.
    for (const k of ["maxAgreementAgeSeconds", "rateFacts", "authorityFloor"]) expect(Object.prototype.hasOwnProperty.call(r.facts, k)).toBe(false);
  });

  it("a zero fee is the zero address, as the accept-time compiler prices it", () => {
    const ag = economics.examplePrintAndMail();
    const r = serverEconomicsFacts(request(ag), honest(ag, { env: { ...ENV, PCC_PROTOCOL_FEE_BPS: "0" } }));
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect([r.facts.feeBps, r.facts.feeRecipient]).toEqual([0, ZERO]);
  });

  it("a registry that does not hold a cited license or party leaves it out, so the binding refuses for it by name", () => {
    const ag = economics.examplePrintAndMail();
    const r = serverEconomicsFacts(request(ag), honest(ag, { licenseRegistry: () => null, partyRegistry: (id) => (id === "courier" ? null : TREASURY) }));
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.facts.licenses).toEqual([]);
    expect(r.facts.parties.map((p) => p.partyId)).not.toContain("courier");
  });
});

describe("configuration that is unset or malformed refuses; it is never defaulted or skipped", () => {
  const ag = economics.examplePrintAndMail();
  const run = (env: NodeJS.ProcessEnv) => serverEconomicsFacts(request(ag), honest(ag, { env }));

  it("the protocol fee", () => {
    const { PCC_PROTOCOL_FEE_BPS: _bps, ...noFee } = ENV;
    expect(codes(run(noFee))).toEqual(["FEE_NOT_CONFIGURED"]);
    for (const bps of ["", "2.35", "1e2", "0x64", "+5", "-1", "1001", "0235"]) expect([bps, codes(run({ ...ENV, PCC_PROTOCOL_FEE_BPS: bps }))]).toEqual([bps, ["FEE_NOT_CONFIGURED"]]);
    expect(codes(run({ ...ENV, PCC_PROTOCOL_FEE_RECIPIENT: "" }))).toEqual(["FEE_NOT_CONFIGURED"]);
    expect(codes(run({ ...ENV, PCC_PROTOCOL_FEE_RECIPIENT: ZERO }))).toEqual(["FEE_NOT_CONFIGURED"]); // a fee nobody can receive
    expect(run({ ...ENV, PCC_PROTOCOL_FEE_BPS: " 1000 " }).ok).toBe(true);
  });

  it("the forbidden recipients", () => {
    const { PCC_FORBIDDEN_RECIPIENTS: _f, ...none } = ENV;
    expect(codes(run(none))).toEqual(["FORBIDDEN_RECIPIENTS_NOT_CONFIGURED"]);
    expect(codes(run({ ...ENV, PCC_FORBIDDEN_RECIPIENTS: " , " }))).toEqual(["FORBIDDEN_RECIPIENTS_NOT_CONFIGURED"]);
    const bad = run({ ...ENV, PCC_FORBIDDEN_RECIPIENTS: `${TOKEN},0xfactory` });
    expect(bad.ok ? null : bad.refusals).toEqual([{ code: "FORBIDDEN_RECIPIENTS_INVALID", detail: "entry 2" }]);
    const many = Array.from({ length: 65 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`).join(",");
    expect(codes(run({ ...ENV, PCC_FORBIDDEN_RECIPIENTS: many }))).toEqual(["FORBIDDEN_RECIPIENTS_INVALID"]);
    const trailing = run({ ...ENV, PCC_FORBIDDEN_RECIPIENTS: `${TOKEN.toUpperCase().replace("0X", "0x")},${TOKEN},` });
    if (!trailing.ok) throw new Error(JSON.stringify(trailing.refusals));
    expect(trailing.facts.forbiddenRecipients).toEqual([TOKEN]);
  });

  it("configuredProtocolFee, which the preview shares, reads the same strict form", () => {
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "235", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toEqual({ feeBps: 235, feeRecipient: TREASURY });
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "0x64", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toBeNull();
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "1e2", PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toBeNull();
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: "235", PCC_PROTOCOL_FEE_RECIPIENT: ZERO })).toBeNull();
  });
});

describe("the clock and the currency are the server's", () => {
  const ag = economics.examplePrintAndMail();

  it("a clock reading that is not whole unix seconds in the safe range refuses", () => {
    for (const now of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1900000000", null]) {
      expect([now, codes(serverEconomicsFacts(request(ag, { now: now as number }), honest(ag)))]).toEqual([now, ["CLOCK_INVALID"]]);
    }
  });

  it("a currency without server-owned decimals refuses, prototype names included", () => {
    for (const currency of ["USDT", "usdc", "", "toString", "__proto__", "constructor", "hasOwnProperty", 6]) {
      expect([currency, codes(serverEconomicsFacts(request(ag, { currency: currency as string }), honest(ag)))]).toEqual([currency, ["CURRENCY_NOT_SUPPORTED"]]);
    }
  });
});

describe("unreadable input is refused by name and never throws", () => {
  it("an agreement with an accessor is refused without running it; a throwing Proxy and a schema failure are refused too", () => {
    const ag = economics.examplePrintAndMail();
    let reads = 0;
    const withGetter = { ...ag };
    Object.defineProperty(withGetter, "fee", { enumerable: true, get: () => (reads++, ag.fee) });
    const trap = new Proxy({}, { ownKeys: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    for (const bad of [withGetter, trap, { ...ag, extra: 1 }, null, "agreement", 42]) {
      expect(codes(serverEconomicsFacts(request(bad), honest(ag)))).toEqual(["AGREEMENT_UNREADABLE"]);
    }
    expect(reads).toBe(0);
  });

  it("with an unreadable agreement, refusals that depend on its content are not guessed; missing sources still are named", () => {
    expect(codes(serverEconomicsFacts(request({ nope: true }), today()))).toEqual([
      "AGREEMENT_UNREADABLE",
      "PARTY_REGISTRY_UNAVAILABLE",
      "INTENDED_USE_UNAVAILABLE",
      "UNIT_FACTS_UNAVAILABLE",
    ]);
  });

  it("a plan that is not a list of distinct node ids, each with its capability, is refused, and no plan source is asked", () => {
    const ag = economics.examplePrintAndMail();
    const asked = vi.fn(() => null);
    const sources = honest(ag, { intendedUse: asked, unitFacts: asked });
    const tooMany = Array.from({ length: 1025 }, (_, i) => ({ nodeId: `n${i}`, capabilityId: "cap" }));
    for (const nodes of ["a-print", [NODES[0], NODES[0]], [{ nodeId: "a-print" }], [{ ...NODES[0], extra: 1 }], [{ nodeId: "has space", capabilityId: "c" }], tooMany]) {
      expect(codes(serverEconomicsFacts(request(ag, { nodes: nodes as PlanNodeRef[] }), sources))).toEqual(["PLAN_INVALID"]);
    }
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("rate schedules: only the registry's sealed bodies, and never a default for a fact the server lacks", () => {
  it("a pin verifies only against a body the registry holds", () => {
    const ag = economics.exampleSparePrinter(); // names PRINTER_KIT_SCHEDULE
    const before = serverEconomicsFacts(request(ag, { nodes: [{ nodeId: ag.units[0]!.unitRef, capabilityId: "cap" }] }), honest(ag));
    if (!before.ok) throw new Error(JSON.stringify(before.refusals));
    expect(before.facts.schedules).toEqual([]); // not published: the binding refuses the pin (RATE_UNVERIFIED)
    publish(economics.PRINTER_KIT_SCHEDULE);
    const after = serverEconomicsFacts(request(ag, { nodes: [{ nodeId: ag.units[0]!.unitRef, capabilityId: "cap" }] }), honest(ag));
    if (!after.ok) throw new Error(JSON.stringify(after.refusals));
    expect(after.facts.schedules).toEqual([economics.PRINTER_KIT_SCHEDULE]);
  });

  it("a stored row whose body no longer hashes to its label is left out, so the pin stays unverified", () => {
    const s = economics.PRINTER_KIT_SCHEDULE;
    // The label of the 0.40% schedule over a 4.00% body: well formed, so only the hash check can catch it.
    publish({ ...s, segments: [{ kind: "constant", startTime: 0, endTime: null, bps: 400 }] });
    const ag = economics.exampleSparePrinter();
    const r = serverEconomicsFacts(request(ag), honest(ag));
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.facts.schedules).toEqual([]);
  });

  it("no registry at all is refused when the agreement names a schedule, and does not matter when it names none", () => {
    closeStore();
    const pinned = economics.exampleSparePrinter();
    expect(codes(serverEconomicsFacts(request(pinned), honest(pinned)))).toEqual(["SCHEDULE_REGISTRY_UNAVAILABLE"]);
    const plain = economics.examplePrintAndMail();
    expect(serverEconomicsFacts(request(plain), honest(plain)).ok).toBe(true);
  });

  it("a schedule whose rate depends on a unit's capture class or jobs per day refuses; a constant one does not", () => {
    const byClass = sealed([{ kind: "capture-class-indexed", startTime: 0, endTime: null, byClass: { CC3: 120 }, default: 40 }]);
    const byAdoption = sealed([{ kind: "adoption-indexed", startTime: 0, endTime: null, scale: 400, floorBps: 10, capBps: 100 }]);
    const constant = sealed([{ kind: "constant", startTime: 0, endTime: null, bps: 40 }]);
    for (const s of [byClass, byAdoption, constant]) publish(s);
    const run = (s: RateSchedule) => {
      const ag = pinnedTo(s);
      return serverEconomicsFacts(request(ag), honest(ag));
    };
    // Without the class, a capture-class segment would verify the pin at its `default` (40), not the class's 120.
    expect(codes(run(byClass))).toEqual(["RATE_FACTS_UNAVAILABLE"]);
    expect(codes(run(byAdoption))).toEqual(["RATE_FACTS_UNAVAILABLE"]);
    expect(run(constant).ok).toBe(true);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────────────────────────

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const PAYER = A("11");
const RESERVATION: ReservationRecord = {
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  requestId: "req-1",
  currency: "USDC",
  maxAmountBaseUnits: 30_000_000n,
  expiresAt: NOW + 3600,
  state: "issued",
  payer: PAYER,
};
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  "print|tier0": [{ requirementId: "print.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
  "mail|tier0": [{ requirementId: "mail.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};

/**
 * The print-and-mail example's deal: the print shop prints (its live price 12.00 USDC) and the courier mails (5.00).
 * The agreement grosses each unit up (14.00 and 8.00) for Orbit's margin and the address check's royalty.
 */
function world(ag: EconomicAgreement, policyFeeBps = 235) {
  const payTo = (id: string) => ag.parties.find((p) => p.partyId === id)!.payTo! as `0x${string}`;
  const caps: LiveCapability[] = [
    { id: "cap-print", type: "print", kernelId: "k-print", pricing: { currency: "USDC", baseCost: "12.00", minimum: "12.00" }, assuranceTiers: [0], tenantId: null },
    { id: "cap-mail", type: "mail", kernelId: "k-mail", pricing: { currency: "USDC", baseCost: "5.00", minimum: "5.00" }, assuranceTiers: [0], tenantId: null },
  ];
  const kernels: LiveKernel[] = [
    { id: "k-print", operatorAddress: payTo("printshop"), status: "online" },
    { id: "k-mail", operatorAddress: payTo("courier"), status: "online" },
  ];
  const deps: Omit<SeamDeps, "economics"> = {
    revalidation: {
      loadCapabilities: (ids) => caps.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => kernels.filter((k) => ids.includes(k.id)),
      csdForType: (t) => t,
    },
    resolveProgram: () => null,
    assertProgramForTier: () => ({ ok: true }),
    evidenceFor: (csd, tierKey) => EVIDENCE[`${csd}|${tierKey}`] ?? null,
    loadReservation: (id) => (id === RESERVATION.reservationId ? { ...RESERVATION } : null),
    policy: { feeBps: policyFeeBps, feeRecipient: TREASURY as `0x${string}`, reclaimAfterSec: 7 * 24 * 3600 },
    now: () => NOW,
  };
  const submission: ExternalPlanSubmission = {
    requestId: "req-1",
    reservationId: "resv-1",
    nodes: [
      { nodeId: "a-print", capabilityId: "cap-print", price: "12.00", currency: "USDC", tierKey: "tier0", kernelId: "k-print", operator: payTo("printshop") },
      { nodeId: "b-mail", capabilityId: "cap-mail", price: "5.00", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: payTo("courier") },
    ],
    edges: [{ from: "a-print", to: "b-mail" }],
  };
  return { deps, submission, payTo };
}

const CTX = { principal: "agent:buyer-1" };

describe("end to end: once item 27's registries and the plan sources exist, these facts bind a real agreement through the real seam", () => {
  it("accepts the print-and-mail deal, pays each party at its registered address, and seals the agreement's hash", () => {
    const ag = economics.examplePrintAndMail();
    const bound = economicsBindingFor({ ...request(ag), accepted: null }, honest(ag));
    if (!bound.ok) throw new Error(JSON.stringify(bound.refusals));
    const { deps, submission, payTo } = world(ag);
    const r = acceptExternalPlan(submission, CTX, { ...deps, economics: bound.binding });
    if (!r.ok) throw new Error(JSON.stringify(r.refusal, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

    const compiled = economics.compileEconomics(ag, { fee: { feeBps: 235, feeRecipient: TREASURY }, forbiddenRecipients: [TOKEN, FACTORY] });
    if (!compiled.ok) throw new Error("fixture");
    expect([r.plan.agreementHash, r.plan.economicTermsHash, r.plan.rightsTermsHash]).toEqual([compiled.agreementHash, compiled.economicTermsHash, compiled.rightsTermsHash]);
    const unitOf = (nodeId: string) => {
      const job = r.plan.jobs.find((j) => j.nodeIds.includes(nodeId))!;
      return job.units[job.nodeIds.indexOf(nodeId)]!;
    };
    const paid = (nodeId: string, who: string) => unitOf(nodeId).payouts.filter((p) => p.recipient.toLowerCase() === payTo(who).toLowerCase()).reduce((s, p) => s + p.amount, 0n);
    expect([unitOf("a-print").g, unitOf("b-mail").g]).toEqual([14_000_000n, 8_000_000n]); // the agreement's gross, above the quotes
    expect(paid("a-print", "printshop")).toBe(12_000_000n);
    expect(paid("b-mail", "courier")).toBe(5_680_000n); // the fee and the postage at cost
    expect(paid("b-mail", "inventor")).toBe(250_000n);
    for (const id of ["a-print", "b-mail"]) {
      const u = unitOf(id);
      expect(u.payouts.reduce((s, p) => s + p.amount, 0n)).toBe(u.n);
    }
  });

  it("binds what the payer accepted, and refuses an absent acceptance instead of taking it as a new one", () => {
    const ag = economics.examplePrintAndMail();
    const c = economics.compileEconomics(ag, {});
    if (!c.ok) throw new Error("fixture");
    const accepted = { agreementHash: c.agreementHash, economicTermsHash: c.economicTermsHash, rightsTermsHash: c.rightsTermsHash };
    const { deps, submission } = world(ag);
    const run = (req: Parameters<typeof economicsBindingFor>[0]) => {
      const bound = economicsBindingFor(req, honest(ag));
      if (!bound.ok) throw new Error(JSON.stringify(bound.refusals));
      return acceptExternalPlan(submission, CTX, { ...deps, economics: bound.binding });
    };
    expect(run({ ...request(ag), accepted }).ok).toBe(true);
    const absent = run(request(ag) as Parameters<typeof economicsBindingFor>[0]);
    expect(absent.ok ? null : absent.refusal).toEqual({ stage: "compile", violations: [{ code: "economics-refused", reason: "economics:AGREEMENT_HASH_MISMATCH:SCHEMA_INVALID" }] });
  });

  it("the registries are the authority: a registry that disagrees with the agreement refuses it at the seam", () => {
    const ag = economics.examplePrintAndMail();
    const { deps, submission } = world(ag);
    const reason = (sources: EconomicsFactsSources, policyFeeBps?: number) => {
      const bound = economicsBindingFor({ ...request(ag), accepted: null }, sources);
      if (!bound.ok) throw new Error(JSON.stringify(bound.refusals));
      const d = policyFeeBps === undefined ? deps : world(ag, policyFeeBps).deps;
      const r = acceptExternalPlan(submission, CTX, { ...d, economics: bound.binding });
      if (r.ok || r.refusal.stage !== "compile") return r.ok ? "ok" : r.refusal.stage;
      const v = r.refusal.violations[0]!;
      return v.code === "economics-refused" ? v.reason : v.code;
    };
    const weaker = honest(ag).licenseRegistry!;
    const first = `${ag.licenses[0]!.licenseId}@${ag.licenses[0]!.version}`; // the binding checks the agreement's licenses in order
    expect(reason(honest(ag, { licenseRegistry: (id, v) => ({ ...weaker(id, v)!, authority: "self-asserted" as const }) }))).toBe(`economics:LICENSE_MISMATCH:${first}`);
    const parties = honest(ag).partyRegistry!;
    expect(reason(honest(ag, { partyRegistry: (id) => (id === "courier" ? A("ee") : parties(id)) }))).toBe("economics:PARTY_MISMATCH:courier");
    expect(reason(honest(ag, { intendedUse: () => ({ ...ag.use, resell: !ag.use.resell }) }))).toBe("economics:USE_MISMATCH");
    expect(reason(honest(ag, { unitFacts: () => ({ "a-print": { components: [], measures: [] }, "b-mail": { components: [], measures: [] } }) }))).toBe("economics:UNIT_FACTS_MISMATCH:a-print");
    // A seam priced at another fee than the configured one cannot fund the agreement: it fails closed.
    expect(reason(honest(ag), 100)).toBe("economics:FEE_RULE_DIVERGED:a-print");
  });

  it("read once: the binding keeps the copy its facts were looked up for, whatever happens to the caller's object", () => {
    const ag = economics.examplePrintAndMail();
    const bound = economicsBindingFor({ ...request(ag), accepted: null }, honest(ag));
    if (!bound.ok) throw new Error(JSON.stringify(bound.refusals));
    ag.units[0]!.gross = "99000000";
    ag.parties.find((p) => p.partyId === "courier")!.payTo = A("ee");
    const gross = bound.binding.unitGross();
    expect(gross.ok ? gross.gross : null).toEqual({ "a-print": 14_000_000n, "b-mail": 8_000_000n });
    const { deps, submission } = world(economics.examplePrintAndMail());
    expect(acceptExternalPlan(submission, CTX, { ...deps, economics: bound.binding }).ok).toBe(true);
  });
});

describe("the sources are server wiring", () => {
  const ag = economics.examplePrintAndMail();

  it("a source that answers malformed data, or for another license, is refused by name", () => {
    const parties = honest(ag).partyRegistry!;
    const r = serverEconomicsFacts(request(ag), honest(ag, { partyRegistry: (id) => (id === "courier" ? "not-an-address" : parties(id)) }));
    expect(r.ok ? null : r.refusals).toEqual([{ code: "SERVER_FACTS_INVALID", detail: "parties.1.payTo" }]);
    const licenses = honest(ag).licenseRegistry!;
    const swapped = serverEconomicsFacts(request(ag), honest(ag, { licenseRegistry: (id, v) => licenses(id === "lic-letter-mail" ? "lic-laser-print-kit" : id, id === "lic-letter-mail" ? 1 : v) }));
    expect(codes(swapped)).toEqual(["SERVER_FACTS_INVALID"]);
  });

  it("the parties a license names are looked up from the registry's copy, so an agreement cannot widen the lookups", () => {
    const registered = economics.examplePrintAndMail();
    const ag = economics.examplePrintAndMail();
    const lic = ag.licenses.find((l) => l.licenseId === "lic-laser-print-kit")!;
    const payment = { requirementId: "x", role: "operator" as const, per: "using-unit" as const, rule: { kind: "fixed" as const, amount: "1" } };
    lic.requires.payments = Array.from({ length: 8 }, (_, i) => ({
      ...payment,
      requirementId: `x${i}`,
      payee: { distribution: Array.from({ length: 32 }, (_, j) => ({ party: `stranger-${i}-${j}`, weight: 1, role: null, subject: null })) },
    }));
    const asked: string[] = [];
    const parties = honest(registered).partyRegistry!;
    const r = serverEconomicsFacts(request(ag), honest(registered, { partyRegistry: (id) => (asked.push(id), parties(id)) }));
    expect(r.ok).toBe(true);
    expect(asked.filter((id) => id.startsWith("stranger-"))).toEqual([]); // the binding then refuses the license (LICENSE_MISMATCH)
  });

  it("a malformed license row is refused before anything reads its parties, never thrown", () => {
    for (const bad of [{ licenseId: "lic-laser-print-kit", version: 1 }, { requires: null }, "row", 7]) {
      const r = serverEconomicsFacts(request(ag), honest(ag, { licenseRegistry: () => bad as never }));
      expect(r.ok ? null : r.refusals).toEqual([{ code: "SERVER_FACTS_INVALID", detail: "licenses (the registry answered a malformed license)" }]);
    }
  });

  it("sources without configuration are unconfigured: process.env is never read in their place", () => {
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    try {
      const { env: _env, ...noEnv } = honest(ag);
      expect(codes(serverEconomicsFacts(request(ag), noEnv as EconomicsFactsSources))).toEqual(["FEE_NOT_CONFIGURED", "FORBIDDEN_RECIPIENTS_NOT_CONFIGURED"]);
    } finally {
      for (const k of Object.keys(ENV)) if (saved[k] === undefined) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("a plan source that cannot say is a missing fact", () => {
    expect(codes(serverEconomicsFacts(request(ag), honest(ag, { intendedUse: () => null })))).toEqual(["INTENDED_USE_UNAVAILABLE"]);
    expect(codes(serverEconomicsFacts(request(ag), honest(ag, { unitFacts: () => null })))).toEqual(["UNIT_FACTS_UNAVAILABLE"]);
  });

  it("a source that throws is a server fault and propagates, as a dependency fault does in the seam", () => {
    const boom = () => {
      throw new Error("database is down");
    };
    expect(() => serverEconomicsFacts(request(ag), honest(ag, { partyRegistry: boom }))).toThrow("database is down");
  });
});

// ── EC6 round 2: the ChatGPT verdict on e6b13331 (SHIP-WITH-FIXES, M1 and M2) ──────────────────────

const TRAPS = [
  "apply", "construct", "defineProperty", "deleteProperty", "get", "getOwnPropertyDescriptor", "getPrototypeOf",
  "has", "isExtensible", "ownKeys", "preventExtensions", "set", "setPrototypeOf",
] as const;

/** A Proxy that forwards every operation to its target and logs each trap that runs, so a test can assert none did. */
function counted<T extends object>(target: T, ran: string[]): T {
  const forward = Reflect as unknown as Record<string, (...args: unknown[]) => unknown>;
  const handler: ProxyHandler<T> = {};
  for (const trap of TRAPS) Object.defineProperty(handler, trap, { value: (...args: unknown[]) => (ran.push(trap), forward[trap]!(...args)) });
  return new Proxy(target, handler);
}

function revokedProxy(): object {
  const r = Proxy.revocable({}, {});
  r.revoke();
  return r.proxy;
}

/** The verdict's reproduction: a trap that throws a revoked Proxy, which `instanceof` cannot inspect without throwing. */
function revokedThrower(): object {
  const revoked = revokedProxy();
  return new Proxy({}, {
    ownKeys() {
      throw revoked;
    },
  });
}

describe("the request is read without running any code it carries (EC6 M1)", () => {
  const MISSING = ["PARTY_REGISTRY_UNAVAILABLE", "INTENDED_USE_UNAVAILABLE", "UNIT_FACTS_UNAVAILABLE"];

  it("the trap log is live: snapshotJson, the reader the service no longer uses, runs a counted Proxy's traps", () => {
    const ran: string[] = [];
    expect(economics.snapshotJson(counted(economics.examplePrintAndMail(), ran)).ok).toBe(true);
    expect(ran).toEqual(expect.arrayContaining(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]));
  });

  it("a Proxy agreement, at the root or nested anywhere, is refused by name from both entry points, and none of its traps runs", () => {
    const ag = economics.examplePrintAndMail();
    const ran: string[] = [];
    const deep = structuredClone(ag);
    deep.licenses[0]!.requires.payments = counted(deep.licenses[0]!.requires.payments, ran);
    const variants: unknown[] = [
      counted(structuredClone(ag), ran),
      { ...structuredClone(ag), fee: counted(structuredClone(ag.fee), ran) },
      { ...structuredClone(ag), parties: counted(structuredClone(ag.parties), ran) },
      { ...structuredClone(ag), units: [counted(structuredClone(ag.units[0]!), ran), ...structuredClone(ag.units.slice(1))] },
      deep,
    ];
    for (const bad of variants) {
      expect(codes(serverEconomicsFacts(request(bad), honest(ag)))).toEqual(["AGREEMENT_UNREADABLE"]);
      expect(codes(economicsBindingFor({ ...request(bad), accepted: null }, honest(ag)))).toEqual(["AGREEMENT_UNREADABLE"]);
    }
    expect(ran).toEqual([]);
  });

  it("a Proxy that would answer like data (a getPrototypeOf trap with a side effect) is refused without asking it", () => {
    const ag = economics.examplePrintAndMail();
    let sideEffects = 0;
    const benign = new Proxy(structuredClone(ag), { getPrototypeOf: () => (sideEffects++, Object.prototype) });
    expect(codes(serverEconomicsFacts(request(benign), honest(ag)))).toEqual(["AGREEMENT_UNREADABLE"]);
    expect(sideEffects).toBe(0);
  });

  it("a Proxy plan, the node list or one node, is refused by name; no trap runs and no plan source is asked", () => {
    const ag = economics.examplePrintAndMail();
    const ran: string[] = [];
    const asked = vi.fn(() => null);
    const sources = honest(ag, { intendedUse: asked, unitFacts: asked });
    for (const nodes of [counted(structuredClone(NODES), ran), [counted({ ...NODES[0]! }, ran), { ...NODES[1]! }]]) {
      expect(codes(serverEconomicsFacts(request(ag, { nodes }), sources))).toEqual(["PLAN_INVALID"]);
      expect(codes(economicsBindingFor({ ...request(ag, { nodes }), accepted: null }, sources))).toEqual(["PLAN_INVALID"]);
    }
    expect(ran).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });

  it("a Proxy request runs no trap: each field reads as absent, and each is refused by name", () => {
    const ag = economics.examplePrintAndMail();
    const ran: string[] = [];
    const expected = ["AGREEMENT_UNREADABLE", "PLAN_INVALID", "CLOCK_INVALID", "CURRENCY_NOT_SUPPORTED"];
    expect(codes(serverEconomicsFacts(counted(request(ag), ran), honest(ag)))).toEqual(expected);
    expect(codes(economicsBindingFor(counted({ ...request(ag), accepted: null }, ran), honest(ag)))).toEqual(expected);
    expect(ran).toEqual([]);
  });

  it("a Proxy acceptance runs no trap and reaches the binding as absent, which refuses it; it is never taken as null", () => {
    const ag = economics.examplePrintAndMail();
    const c = economics.compileEconomics(ag, {});
    if (!c.ok) throw new Error("fixture");
    const hashes = { agreementHash: c.agreementHash, economicTermsHash: c.economicTermsHash, rightsTermsHash: c.rightsTermsHash };
    const { deps, submission } = world(ag);
    const ran: string[] = [];
    for (const accepted of [counted({ ...hashes }, ran), revokedProxy(), revokedThrower()]) {
      const bound = economicsBindingFor({ ...request(ag), accepted: accepted as typeof hashes }, honest(ag));
      if (!bound.ok) throw new Error(JSON.stringify(bound.refusals));
      const r = acceptExternalPlan(submission, CTX, { ...deps, economics: bound.binding });
      expect(r.ok ? null : r.refusal).toEqual({ stage: "compile", violations: [{ code: "economics-refused", reason: "economics:AGREEMENT_HASH_MISMATCH:SCHEMA_INVALID" }] });
    }
    expect(ran).toEqual([]);
    const plain = economicsBindingFor({ ...request(ag), accepted: { ...hashes } }, honest(ag)); // control: the same hashes as data
    if (!plain.ok) throw new Error(JSON.stringify(plain.refusals));
    expect(acceptExternalPlan(submission, CTX, { ...deps, economics: plain.binding }).ok).toBe(true);
  });

  it("the verdict's reproduction: a trap that throws a revoked Proxy is refused by name from both entry points, not thrown", () => {
    const bad = revokedThrower();
    expect(() => economics.snapshotJson(bad)).toThrow(TypeError); // what the old reader let escape
    expect(codes(serverEconomicsFacts(request(bad), today()))).toEqual(["AGREEMENT_UNREADABLE", ...MISSING]);
    expect(codes(economicsBindingFor({ ...request(bad), accepted: null }, today()))).toEqual(["AGREEMENT_UNREADABLE", ...MISSING]);
  });

  it("a revoked Proxy as the agreement, the node list, one node or the request itself is refused by name", () => {
    const ag = economics.examplePrintAndMail();
    expect(codes(serverEconomicsFacts(request(revokedProxy()), honest(ag)))).toEqual(["AGREEMENT_UNREADABLE"]);
    expect(codes(serverEconomicsFacts(request(ag, { nodes: revokedProxy() as PlanNodeRef[] }), honest(ag)))).toEqual(["PLAN_INVALID"]);
    expect(codes(serverEconomicsFacts(request(ag, { nodes: [revokedProxy() as PlanNodeRef, NODES[1]!] }), honest(ag)))).toEqual(["PLAN_INVALID"]);
    expect(codes(serverEconomicsFacts(revokedProxy() as EconomicsFactsRequest, honest(ag)))).toEqual(["AGREEMENT_UNREADABLE", "PLAN_INVALID", "CLOCK_INVALID", "CURRENCY_NOT_SUPPORTED"]);
  });

  it("for values that are not Proxies, ownedJson accepts and refuses what snapshotJson does, and returns an equal copy", () => {
    const nest = (n: number): unknown => (n === 0 ? 0 : [nest(n - 1)]);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const shared = { x: 1 };
    const holey: number[] = [];
    holey[0] = 1;
    holey[2] = 3;
    const withGetter = Object.defineProperty({ a: 1 }, "b", { enumerable: true, get: () => 2 });
    const hidden = Object.defineProperty({ a: 1 }, "b", { enumerable: false, value: 2 });
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: [1, { b: null }] });
    class Box {
      a = 1;
    }
    const args = (function (..._values: unknown[]) {
      return arguments; // an arguments object: Object.prototype, with an own Symbol.iterator
    })(1, "two");
    const cases: Array<[string, unknown]> = [
      ["print-and-mail", economics.examplePrintAndMail()],
      ["spare-printer", economics.exampleSparePrinter()],
      ["primitives", [0, -0, 1.5, "", "x", true, false, null]],
      ["a shared, not cyclic, reference", { a: shared, b: shared }],
      ["a null-prototype object", bare],
      ["an own __proto__ key", JSON.parse('{"__proto__": {"a": 1}}')],
      ["a non-enumerable key", hidden],
      ["an array's extra key", Object.assign([1, 2], { extra: 3 })],
      ["a frozen object", Object.freeze({ a: Object.freeze([1]) })],
      ["64 levels", nest(64)],
      ["65 levels", nest(65)],
      ["65,536 entries", new Array(65_536).fill(0)],
      ["65,537 entries", new Array(65_537).fill(0)],
      ["over a million values", Array.from({ length: 16 }, () => new Array(65_536).fill(0))],
      ["a hole", holey],
      ["an accessor", withGetter],
      ["a symbol key", { [Symbol("s")]: 1 }],
      ["an arguments object", args],
      ["a cycle", cyclic],
      ["a Date", new Date(0)],
      ["a Map", new Map()],
      ["a class instance", new Box()],
      ["another prototype", Object.create({ a: 1 })],
      ["a String object", new String("x")],
      ["a typed array", new Uint8Array(2)],
      ["a function", () => 1],
      ["a bigint", 1n],
      ["undefined", undefined],
      ["a symbol", Symbol("s")],
      ["undefined in an object", { a: undefined }],
    ];
    const accepted: string[] = [];
    for (const [label, value] of cases) {
      const theirs = economics.snapshotJson(value);
      const ours = ownedJson(value);
      expect([label, ours.ok]).toEqual([label, theirs.ok]);
      if (ours.ok && theirs.ok) {
        expect([label, ours.value]).toEqual([label, theirs.value]);
        accepted.push(label);
      }
    }
    // Both sides of the parity are exercised: the boundary cases fall where snapshotJson puts them.
    expect(accepted).toEqual([
      "print-and-mail", "spare-printer", "primitives", "a shared, not cyclic, reference", "a null-prototype object",
      "an own __proto__ key", "a non-enumerable key", "an array's extra key", "a frozen object", "64 levels", "65,536 entries",
    ]);
  });
});

describe("a source's malformed answer is refused by name before anything reads it (EC6 M2)", () => {
  const ag = economics.exampleSparePrinter(); // names a schedule
  const INVALID = [{ code: "SERVER_FACTS_INVALID", detail: "schedules (the registry answered malformed schedules)" }];
  const withSchedules = (answer: unknown) => serverEconomicsFacts(request(ag), honest(ag, { sealedSchedules: () => answer as SealedAnswer }));
  type SealedAnswer = ReturnType<EconomicsFactsSources["sealedSchedules"]>;

  it("the verdict's three cases, schedules: null, [null] and [{ segments: null }], are refused, not thrown", () => {
    for (const schedules of [null, [null], [{ segments: null }]]) {
      const r = withSchedules({ available: true, schedules });
      expect([schedules, r.ok ? null : r.refusals]).toEqual([schedules, INVALID]);
    }
  });

  it("any other answer that is not SealedSchedules is refused the same way; a Proxy answer runs none of its traps", () => {
    const ran: string[] = [];
    const good = economics.PRINTER_KIT_SCHEDULE;
    const answers: Array<[string, unknown]> = [
      ["no answer", null],
      ["a string", "schedules"],
      ["no available", { schedules: [] }],
      ["available is not a boolean", { available: "yes", schedules: [] }],
      ["an extra key", { available: true, schedules: [good], extra: 1 }],
      ["a schedule with no segments", { available: true, schedules: [{ ...good, segments: [] }] }],
      ["more schedules than lookups", { available: true, schedules: Array.from({ length: 65 }, () => good) }],
      ["a Proxy answer", counted({ available: true, schedules: [good] }, ran)],
      ["a Proxy schedule", { available: true, schedules: [counted({ ...good }, ran)] }],
      ["the revoked-Proxy thrower", revokedThrower()],
    ];
    for (const [label, answer] of answers) {
      const r = withSchedules(answer);
      expect([label, r.ok ? null : r.refusals]).toEqual([label, INVALID]);
    }
    expect(ran).toEqual([]);
  });

  it("controls: a well-formed answer is read as before", () => {
    const one = withSchedules({ available: true, schedules: [economics.PRINTER_KIT_SCHEDULE] });
    if (!one.ok) throw new Error(JSON.stringify(one.refusals));
    expect(one.facts.schedules).toEqual([economics.PRINTER_KIT_SCHEDULE]);
    expect(codes(withSchedules({ available: false, schedules: [] }))).toEqual(["SCHEDULE_REGISTRY_UNAVAILABLE"]);
    const byClass = sealed([{ kind: "capture-class-indexed", startTime: 0, endTime: null, byClass: { CC3: 120 }, default: 40 }]);
    expect(codes(withSchedules({ available: true, schedules: [byClass] }))).toEqual(["RATE_FACTS_UNAVAILABLE"]);
  });

  it("a license answer is copied the same way: a Proxy row runs none of its traps, and the revoked-Proxy thrower is refused, not thrown", () => {
    const plain = economics.examplePrintAndMail();
    const ran: string[] = [];
    const licenses = honest(plain).licenseRegistry!;
    const rows = [(id: string, version: number) => counted(licenses(id, version)!, ran), () => revokedThrower()];
    for (const row of rows) {
      const r = serverEconomicsFacts(request(plain), honest(plain, { licenseRegistry: row as EconomicsFactsSources["licenseRegistry"] }));
      expect(r.ok ? null : r.refusals).toEqual([{ code: "SERVER_FACTS_INVALID", detail: "licenses (the registry answered a malformed license)" }]);
    }
    expect(ran).toEqual([]);
  });

  it("a schedules source that throws is a server fault and still propagates, from both entry points", () => {
    const down = honest(ag, {
      sealedSchedules: () => {
        throw new Error("registry is down");
      },
    });
    expect(() => serverEconomicsFacts(request(ag), down)).toThrow("registry is down");
    expect(() => economicsBindingFor({ ...request(ag), accepted: null }, down)).toThrow("registry is down");
  });

  it("a configuration value that is not a string reads as unset: refused by name, never thrown", () => {
    const plain = economics.examplePrintAndMail();
    const run = (env: Record<string, unknown>) => codes(serverEconomicsFacts(request(plain), honest(plain, { env: env as NodeJS.ProcessEnv })));
    expect(run({ ...ENV, PCC_PROTOCOL_FEE_BPS: 235 })).toEqual(["FEE_NOT_CONFIGURED"]);
    expect(run({ ...ENV, PCC_PROTOCOL_FEE_RECIPIENT: { toString: () => TREASURY } })).toEqual(["FEE_NOT_CONFIGURED"]);
    expect(run({ ...ENV, PCC_FORBIDDEN_RECIPIENTS: [TOKEN, FACTORY] })).toEqual(["FORBIDDEN_RECIPIENTS_NOT_CONFIGURED"]);
    expect(configuredProtocolFee({ PCC_PROTOCOL_FEE_BPS: 235 as unknown as string, PCC_PROTOCOL_FEE_RECIPIENT: TREASURY })).toBeNull();
  });
});
