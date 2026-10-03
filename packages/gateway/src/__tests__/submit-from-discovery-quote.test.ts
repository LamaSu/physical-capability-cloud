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
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { getKernelService } from "../services/kernel-service.js";

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
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);
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
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USD", baseCost: 25, minimum: 25 });
    const res = await submit(app, "lab.absorbance");
    expect(res.statusCode).toBe(201);
    const { quote } = res.json();
    expect([quote.basePrice, quote.totalPrice, quote.currency]).toEqual(["25.00", "25.00", "USD"]);
    expect(quote.adjustments).toEqual([]);
  });

  it("a type with template pricing hints is still quoted at the registered price, never the hint", async () => {
    registerCapability("cap-n98-lh", "liquid-handler", { currency: "USDC", baseCost: "15.00", minimum: "15.00" });
    const { quote } = (await submit(app, "liquid-handler")).json();
    expect([quote.basePrice, quote.totalPrice, quote.currency]).toEqual(["15.00", "15.00", "USDC"]);
  });

  it("quantity multiplies the registered price, and the volume rule applies only from its minimum quantity", async () => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USD", baseCost: "25.00", minimum: "25.00" });
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
    ["no base price", { currency: "USD", minimum: "5.00" }],
    ["a zero price", { currency: "USD", baseCost: "0", minimum: "0" }],
    ["a malformed price", { currency: "USD", baseCost: "abc", minimum: "1" }],
    ["a negative price", { currency: "USD", baseCost: -5, minimum: -5 }],
    ["a price with more than two decimals", { currency: "USD", baseCost: "25.005", minimum: "25.00" }],
    ["a sub-cent price", { currency: "USD", baseCost: "0.001", minimum: "0.001" }],
    ["no currency", { currency: "", baseCost: "25.00", minimum: "25.00" }],
  ])("a capability with %s is refused as capability_price_undeclared", async (_label, pricing) => {
    registerCapability("cap-n98-bad", "lab.absorbance", pricing as Record<string, unknown> | null);
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error]).toEqual([422, "capability_price_undeclared"]);
  });

  it("two capabilities of the type on one kernel are refused as ambiguous, never priced from either", async () => {
    registerCapability("cap-n98-a", "lab.absorbance", { currency: "USD", baseCost: "25.00", minimum: "25.00" });
    registerCapability("cap-n98-b", "lab.absorbance", { currency: "USD", baseCost: "30.00", minimum: "30.00" });
    const res = await submit(app, "lab.absorbance");
    expect([res.statusCode, res.json().error]).toEqual([409, "capability_ambiguous"]);
  });

  it.each([[0], [-1], [1.5], ["3"], [1_000_001], [Number.NaN]])("quantity %s is refused", async (quantity) => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USD", baseCost: "25.00", minimum: "25.00" });
    const res = await submit(app, "lab.absorbance", { quantity });
    expect([res.statusCode, res.json().error]).toEqual([400, "invalid_quantity"]);
  });

  it("the operator's declared minimum is a floor under the registered price times the quantity", async () => {
    registerCapability("cap-n98-min", "lab.absorbance", { currency: "USD", baseCost: "5.00", minimum: "20.00" });
    const { quote } = (await submit(app, "lab.absorbance", { quantity: 2 })).json();
    expect([quote.basePrice, quote.totalPrice]).toEqual(["5.00", "20.00"]);
  });

  it("a material rule applies only when the order selects that material", async () => {
    registerCapability("cap-n98-abs", "lab.absorbance", { currency: "USD", baseCost: "25.00", minimum: "25.00" });
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
