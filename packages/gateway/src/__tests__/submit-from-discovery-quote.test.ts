/**
 * N98: POST /api/jobs/submit-from-discovery quotes the operator's REGISTERED price.
 *
 * The quote used to come from the capability template's pricing hints, or 10 when there were none,
 * and every enabled operator pricing rule was applied whatever its condition. So a buyer's quote did
 * not match the price the operator registered (adk's runbook stops its rehearsal on that mismatch).
 * The registered price is the selected capability's own `pricing`; a rule applies only when its
 * condition holds on facts this route establishes; a capability with no declared price is refused.
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getKernelService } from "../services/kernel-service.js";
import { SETTLEMENT_CURRENCY } from "../services/quote-pricing.js";

// ---------------------------------------------------------------------------
// Mocks — mirror paid-job-flow.test.ts so the fast-track route runs hermetically.
// ---------------------------------------------------------------------------

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// getKernelService() is the ONLY thing createJobFromSession consults to decide
// local vs remote. Keep every other real export intact; only override this one
// so each test controls whether the gateway "owns" the target kernel.
vi.mock("../services/kernel-service.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/kernel-service.js")>();
  return {
    ...actual,
    getKernelService: vi.fn(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    }),
  };
});


async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

const KERNEL = "kernel-nyc";

/** Register a capability the way an operator does; `pricing` is stored as given (adk sends numbers). */
function registerCapability(id: string, type: string, pricing: Record<string, unknown> | null) {
  getRepos().capabilities.insert({
    id,
    kernelId: KERNEL,
    type,
    name: `${type} test capability`,
    description: "test",
    materials: [],
    tolerances: {},
    envelope: { x: 1, y: 1, z: 1, unit: "mm" as const },
    assuranceTiers: [0],
    pricing: pricing as never,
    availability: {},
    location: { lat: 40.7, lng: -74 },
  } as never);
}

async function submit(app: FastifyInstance, capabilityType: string, parameters?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId: KERNEL, capabilityType, userAgentId: "buyer-n98", ...(parameters ? { parameters } : {}) },
  });
}

describe("N98: the discovery quote is the operator's registered price", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("quotes the registered price and currency, as adk registers them (numbers, USD), with no rule whose condition is unmet", async () => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USDC", baseCost: 25, minimum: 25 });
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(201);
    const { quote } = res.json();
    expect([quote.basePrice, quote.totalPrice, quote.currency]).toEqual(["25.00", "25.00", "USDC"]);
    expect(quote.adjustments).toEqual([]);
  });

  it("a type with template pricing hints is still quoted at the registered price, never the hint", async () => {
    registerCapability("cap-n98-lh", "liquid-handler", { currency: "USDC", baseCost: "15.00", minimum: "15.00" });
    const { quote } = (await submit(app, "liquid-handler")).json();
    expect([quote.basePrice, quote.totalPrice, quote.currency]).toEqual(["15.00", "15.00", "USDC"]);
  });

  it("quantity multiplies the registered price, and the volume rule applies only from its minimum quantity", async () => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "25.00" });
    const three = (await submit(app, "lab.absorbance", { quantity: 3 })).json().quote;
    expect([three.totalPrice, three.adjustments.length]).toEqual(["75.00", 0]);
    const ten = (await submit(app, "lab.absorbance", { quantity: 10 })).json().quote;
    // 10 x 25.00 = 250.00, and the default policy's "10+ units: 10% off" applies: 225.00.
    expect([ten.totalPrice, ten.adjustments.map((a: { ruleId: string }) => a.ruleId)]).toEqual(["225.00", ["volume-10"]]);
  });

  it("no capability of that type on the kernel is refused with an explicit code", async () => {
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error]).toEqual([404, "capability_not_found"]);
  });

  it.each([
    ["an empty pricing object", {}],
    ["no base price", { currency: "USDC", minimum: "5.00" }],
    ["a zero price", { currency: "USDC", baseCost: "0", minimum: "0" }],
    ["a malformed price", { currency: "USDC", baseCost: "abc", minimum: "1" }],
    ["a negative price", { currency: "USDC", baseCost: -5, minimum: -5 }],
    ["a price with more than two decimals", { currency: "USDC", baseCost: "25.005", minimum: "25.00" }],
    ["a sub-cent price", { currency: "USDC", baseCost: "0.001", minimum: "0.001" }],
    ["no currency", { currency: "", baseCost: "25.00", minimum: "25.00" }],
  ])("a capability with %s is refused as capability_price_undeclared", async (_label, pricing) => {
    registerCapability("cap-n98-bad", "lab.absorbance", pricing as Record<string, unknown> | null);
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error]).toEqual([422, "capability_price_undeclared"]);
  });

  it("two capabilities of the type on one kernel are refused as ambiguous, never priced from either", async () => {
    registerCapability("cap-n98-a", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "25.00" });
    registerCapability("cap-n98-b", "lab.absorbance", { currency: "USDC", baseCost: "30.00", minimum: "30.00" });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error]).toEqual([409, "capability_ambiguous"]);
  });

  it.each([[0], [-1], [1.5], ["3"], [1_000_001], [Number.NaN]])("quantity %s is refused", async (quantity) => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "25.00" });
    const res = await submit(app, "lab.absorbance", { quantity });
    expect([res.statusCode, res.json().error]).toEqual([400, "invalid_quantity"]);
  });

  it("the operator's declared minimum is a floor under the registered price times the quantity", async () => {
    registerCapability("cap-n98-min", "lab.absorbance", { currency: "USDC", baseCost: "5.00", minimum: "20.00" });
    const { quote } = (await submit(app, "lab.absorbance", { quantity: 2 })).json();
    expect([quote.basePrice, quote.totalPrice]).toEqual(["5.00", "20.00"]);
  });

  it("a material rule applies only when the order selects that material", async () => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "25.00" });
    const markup = { id: "petg-10", type: "material_markup", label: "PETG +10%", enabled: true, condition: { material: "PETG" }, impact: { mode: "percent", value: "10" } };
    getStore().db.update(schema.operatorPolicies)
      .set({ policy: { ...DEFAULT_OPERATOR_POLICY, pricingRules: [markup] } as never })
      .where(eq(schema.operatorPolicies.kernelId, KERNEL))
      .run();
    const petg = (await submit(app, "lab.absorbance", { material: "PETG" })).json().quote;
    expect([petg.totalPrice, petg.adjustments.map((a: { ruleId: string }) => a.ruleId)]).toEqual(["27.50", ["petg-10"]]);
    const pla = (await submit(app, "lab.absorbance", { material: "PLA" })).json().quote;
    expect([pla.totalPrice, pla.adjustments.length]).toEqual(["25.00", 0]);
  });

  it("usage rates the quote cannot measure are disclosed, not charged", async () => {
    registerCapability("cap-n98-fdm", "lab.absorbance", { currency: "USDC", baseCost: "5.00", perMinute: "0.08", perGram: "0.12", minimum: "5.00" });
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("5.00");
    expect(quote.unquotedUsage).toEqual({ perMinute: "0.08", perGram: "0.12" });
  });
});

// ---------------------------------------------------------------------------
// #498 round 2: astra pack-161 (DO-NOT-SHIP, F1-F5) + gateway bus #4995 (HIGH
// currency, MEDIUM precision). VERIFY BEFORE FIX: each block states the
// reviewer's repro; the assertions are the FIXED behaviour, run first against
// unmodified 32934d3a to record the actual-vs-expected failure line.
// ---------------------------------------------------------------------------

function setPolicy(patch: Record<string, unknown>) {
  getStore().db.update(schema.operatorPolicies)
    .set({ policy: { ...DEFAULT_OPERATOR_POLICY, ...patch } as never })
    .where(eq(schema.operatorPolicies.kernelId, KERNEL))
    .run();
}

function setPricingRules(rules: unknown) {
  setPolicy({ pricingRules: rules });
}

function rowCounts() {
  const { db } = getStore();
  return {
    sessions: db.select().from(schema.negotiationSessions).all().length,
    jobs: db.select().from(schema.jobs).all().length,
    scopes: db.select().from(schema.executionScopes).all().length,
    escrows: db.select().from(schema.escrows).all().length,
    milestones: db.select().from(schema.escrowMilestones).all().length,
  };
}

describe("N98 r2 (#498): F1 exact arithmetic end to end (no Number for money)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it("reviewer's repro: a 13-digit baseCost at quantity 10 with no rules keeps exact cents (32934d3a truncates to .91)", async () => {
    registerCapability("cap-f1-big", "lab.absorbance", { currency: "USDC", baseCost: "9999999999999.99", minimum: "0.01" });
    setPricingRules([]);
    const { quote } = (await submit(app, "lab.absorbance", { quantity: 10 })).json();
    expect(quote.totalPrice).toBe("99999999999999.90");
    expect(quote.adjustments).toEqual([]);
  });

  it("a large subtotal with a +7.5% rule: 1234567.89 * 1.075 = 1327160.48175 (exact) -> half-up cents 1327160.48", async () => {
    registerCapability("cap-f1-pct", "lab.absorbance", { currency: "USDC", baseCost: "1234567.89", minimum: "0.01" });
    setPricingRules([{ id: "r1", type: "custom", label: "7.5%", enabled: true, condition: {}, impact: { mode: "percent", value: "7.5" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    // 1234567.89 * 0.075 = 92592.59175 exactly; total = 1234567.89 + 92592.59175 = 1327160.48175,
    // which rounds half-up to the cent as 1327160.48 (the .00175 tail is below half a cent).
    expect(quote.totalPrice).toBe("1327160.48");
    expect(quote.adjustments).toEqual([{ ruleId: "r1", label: "7.5%", impact: "92592.59" }]);
  });

  it("a tie: subtotal 0.01 with a +50% rule gives 0.02 (half up)", async () => {
    registerCapability("cap-f1-tie", "lab.absorbance", { currency: "USDC", baseCost: "0.01", minimum: "0.01" });
    setPricingRules([{ id: "tie", type: "custom", label: "+50%", enabled: true, condition: {}, impact: { mode: "percent", value: "50" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("0.02");
  });

  it("a negative tie: subtotal 0.01 with a -50% rule gives total 0.01, impact -0.01 (half away from zero)", async () => {
    registerCapability("cap-f1-negtie", "lab.absorbance", { currency: "USDC", baseCost: "0.01", minimum: "0.01" });
    setPricingRules([{ id: "negtie", type: "custom", label: "-50%", enabled: true, condition: {}, impact: { mode: "percent", value: "-50" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("0.01");
    expect(quote.adjustments).toEqual([{ ruleId: "negtie", label: "-50%", impact: "-0.01" }]);
  });

  it("a rule that would push the total below zero floors at 0.00", async () => {
    registerCapability("cap-f1-floor", "lab.absorbance", { currency: "USDC", baseCost: "10.00", minimum: "0.01" });
    setPricingRules([{ id: "floor", type: "custom", label: "-150%", enabled: true, condition: {}, impact: { mode: "percent", value: "-150" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("0.00");
  });

  it("a flat rule with 6 decimals: 10.00 + 0.123456 = 10.123456 (exact) -> half-up cents 10.12", async () => {
    registerCapability("cap-f1-flat6", "lab.absorbance", { currency: "USDC", baseCost: "10.00", minimum: "0.01" });
    setPricingRules([{ id: "flat6", type: "custom", label: "flat 6dp", enabled: true, condition: {}, impact: { mode: "flat", value: "0.123456" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("10.12");
    expect(quote.adjustments).toEqual([{ ruleId: "flat6", label: "flat 6dp", impact: "0.12" }]);
  });
});

describe("N98 r2 (#498): F2 only the settlement currency (USDC)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it.each([
    ["EUR", { currency: "EUR", baseCost: "25.00", minimum: "25.00" }],
    ["ETH", { currency: "ETH", baseCost: "0.50", minimum: "0.01" }],
    ["USD (also refused, not just non-ISO tokens)", { currency: "USD", baseCost: "10.00", minimum: "0.01" }],
  ])("reviewer's repro: a registered %s quote is refused before any escrow forms (gateway bus #4995 HIGH)", async (_label, pricing) => {
    registerCapability("cap-f2", "lab.absorbance", pricing as Record<string, unknown>);
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("capability_price_unsupported_currency");
    expect(body.currency).toBe((pricing as Record<string, unknown>).currency);
    expect(body.settlementCurrency).toBe("USDC");
  });

  it("malformed currency syntax stays capability_price_undeclared / invalid-currency, not the new unsupported-currency code", async () => {
    registerCapability("cap-f2-bad-syntax", "lab.absorbance", { currency: "usdc", baseCost: "10.00", minimum: "0.01" });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error, res.json().reason]).toEqual([422, "capability_price_undeclared", "invalid-currency"]);
  });

  it("SETTLEMENT_CURRENCY is exported as USDC", () => {
    expect(SETTLEMENT_CURRENCY).toBe("USDC");
  });
});

describe("N98 r2 (#498): F3 usage rates validated before disclosed", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it("reviewer's repro: perMinute:{toString:null} no longer 500s -- 422 invalid-usage", async () => {
    registerCapability("cap-f3-throw", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01", perMinute: { toString: null } });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error, res.json().reason]).toEqual([422, "capability_price_undeclared", "invalid-usage"]);
  });

  it("an arbitrary object is refused, never disclosed as [object Object]", async () => {
    registerCapability("cap-f3-obj", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01", perMinute: { a: 1 } });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error, res.json().reason]).toEqual([422, "capability_price_undeclared", "invalid-usage"]);
  });

  it.each([
    ["a negative rate", { perMinute: -0.5 }],
    ["exponential notation", { perMinute: "1e3" }],
  ])("%s is refused as invalid-usage", async (_label, extra) => {
    registerCapability("cap-f3-bad", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01", ...extra });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error, res.json().reason]).toEqual([422, "capability_price_undeclared", "invalid-usage"]);
  });

  it("a canonical rate (0.015) is disclosed exactly; a zero rate (0) is omitted", async () => {
    registerCapability("cap-f3-ok", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01", perMinute: "0.015", perGram: 0 });
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.unquotedUsage).toEqual({ perMinute: "0.015" });
  });
});

describe("N98 r2 (#498): F4 malformed pricing rules are refused, never applied", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it.each([
    ["false", false],
    ["null", null],
    ["0", 0],
    ["an empty array", []],
  ])("reviewer's repro: condition %s on the volume rule is refused (32934d3a treats it as an unconditional -10%% at qty 1)", async (_label, badCondition) => {
    registerCapability("cap-f4-cond", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    const volume10 = { ...DEFAULT_OPERATOR_POLICY.pricingRules[0]!, condition: badCondition };
    setPricingRules([volume10]);
    const res = await submit(app, "lab.absorbance", { quantity: 1 });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("operator_pricing_policy_invalid");
    expect(body.ruleIndex).toBe(0);
    expect(body.ruleId).toBe("volume-10");
  });

  it("reviewer's repro: impact.value 'abc' with an empty condition (32934d3a quotes a NaN total)", async () => {
    registerCapability("cap-f4-nan", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "bad-value", type: "custom", label: "bad", enabled: true, condition: {}, impact: { mode: "percent", value: "abc" } }]);
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("operator_pricing_policy_invalid");
    expect(body.ruleId).toBe("bad-value");
    expect(body.reason).toBe("invalid-impact-value");
  });
});

describe("N98 r2 (#498): F5 discriminating tests", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it("a disabled rule whose condition holds never applies", async () => {
    registerCapability("cap-f5-disabled", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "disabled-ok", type: "custom", label: "disabled", enabled: false, condition: {}, impact: { mode: "percent", value: "-50" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect([quote.totalPrice, quote.adjustments]).toEqual(["25.00", []]);
  });

  it("a valid empty condition {} always applies", async () => {
    registerCapability("cap-f5-empty", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "empty-ok", type: "custom", label: "flat -1", enabled: true, condition: {}, impact: { mode: "flat", value: "-1.00" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect(quote.totalPrice).toBe("24.00");
  });

  it("two conditions, exactly one fails: not applied (the every->some mutant must die here)", async () => {
    registerCapability("cap-f5-conj", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "conj", type: "custom", label: "qty+material", enabled: true, condition: { minQuantity: 5, material: "PETG" }, impact: { mode: "percent", value: "-10" } }]);
    const onlyQty = (await submit(app, "lab.absorbance", { quantity: 10, material: "PLA" })).json().quote;
    expect([onlyQty.totalPrice, onlyQty.adjustments]).toEqual(["250.00", []]);
    const both = (await submit(app, "lab.absorbance", { quantity: 10, material: "PETG" })).json().quote;
    expect([both.totalPrice, both.adjustments.map((a: { ruleId: string }) => a.ruleId)]).toEqual(["225.00", ["conj"]]);
  });

  it("a timeWindow condition never applies (the route has no current-time fact)", async () => {
    registerCapability("cap-f5-tw", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "tw", type: "custom", label: "offpeak", enabled: true, condition: { timeWindow: { start: "00:00", end: "23:59" } }, impact: { mode: "percent", value: "-99" } }]);
    const { quote } = (await submit(app, "lab.absorbance")).json();
    expect([quote.totalPrice, quote.adjustments]).toEqual(["25.00", []]);
  });

  it("an unknown condition key never applies, and is NOT a validation error", async () => {
    registerCapability("cap-f5-unknown", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "unk", type: "custom", label: "future-fact", enabled: true, condition: { futureFact: "x" }, impact: { mode: "percent", value: "-50" } }]);
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(201);
    expect([res.json().quote.totalPrice, res.json().quote.adjustments]).toEqual(["25.00", []]);
  });

  it("a valid baseCost with an invalid minimum stays 422 invalid-minimum (pinned, unaffected by the move)", async () => {
    registerCapability("cap-f5-minimum", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "abc" });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error, res.json().reason]).toEqual([422, "capability_price_undeclared", "invalid-minimum"]);
  });

  it.each([
    ["no capability registered", () => {}, undefined, 404],
    ["an invalid price", () => registerCapability("cap-f5-row-price", "lab.absorbance", { currency: "USDC", baseCost: "abc" }), undefined, 422],
    ["an unsupported currency", () => registerCapability("cap-f5-row-currency", "lab.absorbance", { currency: "EUR", baseCost: "25.00" }), undefined, 422],
    ["an invalid quantity", () => registerCapability("cap-f5-row-qty", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" }), { quantity: 0 }, 400],
    ["an ambiguous capability", () => {
      registerCapability("cap-f5-row-amb-a", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
      registerCapability("cap-f5-row-amb-b", "lab.absorbance", { currency: "USDC", baseCost: "30.00", minimum: "0.01" });
    }, undefined, 409],
    ["an emergency stop", () => {
      registerCapability("cap-f5-row-estop", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
      setPolicy({ emergencyStop: true });
    }, undefined, 503],
  ])("every refusal (%s) leaves no session, job, scope, escrow or milestone row", async (_label, setup, params, expectedStatus) => {
    (setup as () => void)();
    const before = rowCounts();
    const res = await submit(app, "lab.absorbance", params as Record<string, unknown> | undefined);
    expect(res.statusCode).toBe(expectedStatus);
    expect(rowCounts()).toEqual(before);
  });

  it("every refusal (a malformed pricing rule) leaves no session, job, scope, escrow or milestone row", async () => {
    registerCapability("cap-f5-row-rules", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "bad", type: "custom", label: "bad", enabled: true, condition: null, impact: { mode: "percent", value: "1" } }]);
    const before = rowCounts();
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    expect(rowCounts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// N98 round 3 (#498, astra 218 F6 HIGH): every PricingRule field must conform to the published
// contract (packages/spec/src/types/operator-policy.ts PricingRule) before a rule can move money.
// Written first and run against unmodified 51a74a5c to record the failure lines.
// ---------------------------------------------------------------------------

describe("N98 r3 (#498): F6 a rule that breaks the PricingRule contract is refused, never applied", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); closeStore(); });

  it("reviewer's repro: a rule with no `type` is refused with invalid-type (51a74a5c quotes and funds 125.00)", async () => {
    registerCapability("cap-f6-type", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "missing-type", label: "invalid", enabled: true, condition: {}, impact: { mode: "flat", value: "100.00" } }]);
    const before = rowCounts();
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect([body.error, body.ruleIndex, body.ruleId, body.reason]).toEqual(["operator_pricing_policy_invalid", 0, "missing-type", "invalid-type"]);
    expect(rowCounts()).toEqual(before);
  });

  it.each([
    ["an empty string", ""],
    ["a number", 7],
    ["null", null],
  ])("a rule whose `type` is %s is refused with invalid-type", async (_label, badType) => {
    registerCapability("cap-f6-type-bad", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "bad-type", type: badType, label: "invalid", enabled: true, condition: {}, impact: { mode: "flat", value: "100.00" } }]);
    const before = rowCounts();
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe("invalid-type");
    expect(rowCounts()).toEqual(before);
  });

  it("the same property: an impact.value given as a JSON number (the contract says string) is refused, never applied", async () => {
    registerCapability("cap-f6-num", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "num-value", type: "custom", label: "flat 100", enabled: true, condition: {}, impact: { mode: "flat", value: 100 } }]);
    const before = rowCounts();
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(422);
    expect([res.json().ruleId, res.json().reason]).toEqual(["num-value", "invalid-impact-value"]);
    expect(rowCounts()).toEqual(before);
  });

  it("a contract-conforming rule with the same values is still applied (the check is not a blanket refusal)", async () => {
    registerCapability("cap-f6-ok", "lab.absorbance", { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPricingRules([{ id: "ok-flat", type: "custom", label: "flat 100", enabled: true, condition: {}, impact: { mode: "flat", value: "100.00" } }]);
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json().quote.totalPrice).toBe("125.00");
  });
});
