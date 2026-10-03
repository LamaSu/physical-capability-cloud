/**
 * N100: POST /api/negotiate/session/:id/quote quotes the operator's REGISTERED
 * price through the SAME shared evaluator discovery uses (#498 quote-pricing.ts),
 * never the template's basePricingHints, never 10, with VALIDATED rules only
 * (quantity/material facts only — rush/offpeak/loyalty never apply on this
 * route) and exact bigint bond math. A session's capabilityId is checked
 * against both the TYPE and the KERNEL, at creation and at quote.
 *
 * VERIFY BEFORE FIX: every test here is the FIXED behaviour. Run first against
 * unmodified b7f54689 to record the actual-vs-expected failure line, per defect:
 *   1. price falls to the template hint ($10.00 for liquid-handler), never the
 *      registered price.
 *   3. applyPricingRules applies every ENABLED rule unconditionally (float).
 *   4. the bond is float: ((adjustedPrice * bondPercent) / 100).toFixed(2).
 *   5. capabilityId is checked against TYPE only, never KERNEL.
 *
 * ALL external calls are mocked implicitly — this route makes none.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { negotiationRoutes } from "../routes/negotiation.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";

const KERNEL = "kernel-n100-neg";
const TYPE = "liquid-handler"; // built-in template; basePricingHints.basePrice = "10.00"

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });

  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(schema.shopKernels).values({
    id: KERNEL,
    name: "N100 Negotiation Test Kernel",
    operatorAddress: "n100-neg@test",
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "n100-neg-key",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();

  const app = Fastify({ logger: false });
  await app.register(negotiationRoutes);
  await app.ready();
  return app;
}

function registerCap(id: string, kernelId: string, type: string, pricing: Record<string, unknown> | null) {
  getStore().db.insert(schema.capabilities).values({
    id,
    kernelId,
    type,
    name: `${type} test capability`,
    description: "test",
    materials: [],
    assuranceTiers: [0, 1, 2],
    pricing: pricing as never,
    availability: {},
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
  } as never).run();
}

function setPolicy(patch: Record<string, unknown>) {
  const { db } = getStore();
  const exists = db.select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, KERNEL)).get();
  const policy = { ...DEFAULT_OPERATOR_POLICY, ...patch };
  if (exists) {
    db.update(schema.operatorPolicies).set({ policy: policy as never }).where(eq(schema.operatorPolicies.kernelId, KERNEL)).run();
  } else {
    db.insert(schema.operatorPolicies).values({ kernelId: KERNEL, policy: policy as never, updatedAt: new Date().toISOString() } as never).run();
  }
}

async function createSession(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/negotiate/session", payload: { userAgentId: "buyer-n100", kernelId: KERNEL, capabilityType: TYPE, ...body } });
}
function select(app: FastifyInstance, id: string, selections: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/negotiate/session/${id}/select`, payload: { selections } });
}
function quote(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` });
}

async function quotedBody(app: FastifyInstance, selections: Record<string, unknown>, createBody: Record<string, unknown> = {}) {
  const create = await createSession(app, createBody);
  expect(create.statusCode).toBe(200);
  const id = create.json().session.id;
  if (Object.keys(selections).length > 0) {
    expect((await select(app, id, selections)).statusCode).toBe(200);
  }
  return { id, res: await quote(app, id) };
}

function sessionRow(id: string) {
  return getStore().db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.id, id)).get();
}

describe("N100 negotiation /quote: the registered price, through the shared evaluator", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });
  afterEach(async () => { await app.close(); closeStore(); });

  it("quotes the registered price x quantity, NEVER the template's basePricingHints ($10.00)", async () => {
    registerCap("cap-n100-neg-1", KERNEL, TYPE, { currency: "USDC", baseCost: "37.50", minimum: "0.01" });
    const { res } = await quotedBody(app, { quantity: 3 });
    expect(res.statusCode).toBe(200);
    const { quote: q } = res.json();
    expect([q.basePrice, q.totalPrice, q.currency]).toEqual(["37.50", "112.50", "USDC"]);
  });

  it("the operator's registered minimum is a floor under price x quantity", async () => {
    registerCap("cap-n100-neg-2", KERNEL, TYPE, { currency: "USDC", baseCost: "5.00", minimum: "50.00" });
    const { res } = await quotedBody(app, {});
    expect(res.statusCode).toBe(200);
    expect([res.json().quote.basePrice, res.json().quote.totalPrice]).toEqual(["5.00", "50.00"]);
  });

  it.each(["EUR", "USD"])("a registered %s price is refused (422 capability_price_unsupported_currency), no conversion", async (currency) => {
    registerCap("cap-n100-neg-cur", KERNEL, TYPE, { currency, baseCost: "10.00", minimum: "0.01" });
    const { id, res } = await quotedBody(app, {});
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect([body.error, body.currency, body.settlementCurrency]).toEqual(["capability_price_unsupported_currency", currency, "USDC"]);
    // No session mutation on refusal.
    const row = sessionRow(id);
    expect(row!.quote).toBeNull();
    expect(row!.status).not.toBe("quoted");
  });

  it("a 13-digit exact baseCost at quantity 10 keeps exact cents (no Number for money)", async () => {
    registerCap("cap-n100-neg-big", KERNEL, TYPE, { currency: "USDC", baseCost: "9999999999999.99", minimum: "0.01" });
    setPolicy({ pricingRules: [] });
    const { res } = await quotedBody(app, { quantity: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().quote.totalPrice).toBe("99999999999999.90");
  });

  it("a malformed pricing rule is refused (422 operator_pricing_policy_invalid), no session mutation", async () => {
    registerCap("cap-n100-neg-badrule", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPolicy({ pricingRules: [{ id: "bad", label: "bad", enabled: true, condition: {}, impact: { mode: "percent", value: "1" } }] }); // missing `type`
    const { id, res } = await quotedBody(app, {});
    expect(res.statusCode).toBe(422);
    expect([res.json().error, res.json().reason]).toEqual(["operator_pricing_policy_invalid", "invalid-type"]);
    const row = sessionRow(id);
    expect(row!.quote).toBeNull();
  });

  it("the DEFAULT policy's rush (+25%) and loyalty (-5%) rules no longer apply (no time/history fact)", async () => {
    registerCap("cap-n100-neg-rl", KERNEL, TYPE, { currency: "USDC", baseCost: "100.00", minimum: "0.01" });
    // DEFAULT_OPERATOR_POLICY (no override row): rush + loyalty-5 enabled, quantity 1 so volume-10 (minQuantity 10) is also unmet.
    const { res } = await quotedBody(app, { quantity: 1 });
    expect(res.statusCode).toBe(200);
    expect([res.json().quote.totalPrice, res.json().quote.adjustments]).toEqual(["100.00", []]);
  });

  it("the volume rule applies only from quantity >= 10", async () => {
    registerCap("cap-n100-neg-vol", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    const nine = await quotedBody(app, { quantity: 9 });
    expect([nine.res.json().quote.totalPrice, nine.res.json().quote.adjustments]).toEqual(["225.00", []]);
    const ten = await quotedBody(app, { quantity: 10 });
    expect([ten.res.json().quote.totalPrice, ten.res.json().quote.adjustments.map((a: { ruleId: string }) => a.ruleId)]).toEqual(["225.00", ["volume-10"]]);
  });

  it("the bond is exact: a tie (total 0.10 at 5%) rounds half up to 0.01, not a float 0.00/0.01 inconsistency", async () => {
    registerCap("cap-n100-neg-tie", KERNEL, TYPE, { currency: "USDC", baseCost: "0.10", minimum: "0.01" });
    const { res } = await quotedBody(app, { evidenceTier: "basic" }); // tier 1 => 5% bond
    expect(res.statusCode).toBe(200);
    expect(res.json().quote.bondAmount).toBe("0.01");
  });

  it("the bond is exact on a large total (15% tier)", async () => {
    registerCap("cap-n100-neg-largebond", KERNEL, TYPE, { currency: "USDC", baseCost: "123456.78", minimum: "0.01" });
    const { res } = await quotedBody(app, { evidenceTier: "full" }); // tier 2 => 15% bond
    expect(res.statusCode).toBe(200);
    expect(res.json().quote.bondAmount).toBe("18518.52");
  });

  it("an invalid bondPercentOverride is refused (422 operator_pricing_policy_invalid / invalid-bond-percent), no session mutation", async () => {
    registerCap("cap-n100-neg-badbond", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPolicy({ bondPercentOverride: 150 });
    const { id, res } = await quotedBody(app, {});
    expect(res.statusCode).toBe(422);
    expect([res.json().error, res.json().reason]).toEqual(["operator_pricing_policy_invalid", "invalid-bond-percent"]);
    const row = sessionRow(id);
    expect(row!.quote).toBeNull();
  });

  it("a nonexistent capabilityId is refused as capability_not_found AT CREATION, never silently falling back to another row of the type", async () => {
    registerCap("cap-n100-neg-exists", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const { db } = getStore();
    const before = db.select().from(schema.negotiationSessions).all().length;
    const res = await createSession(app, { capabilityId: "cap-does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("capability_not_found");
    expect(db.select().from(schema.negotiationSessions).all().length).toBe(before);
  });

  // ── capabilityId: checked against KERNEL as well as TYPE (defect 5) ──────

  it("kernel B's capabilityId on a kernel-A session is refused AT CREATION (409 capability_kernel_mismatch), no session row inserted", async () => {
    registerCap("cap-n100-neg-a", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const KERNEL_B = "kernel-n100-neg-b";
    const { db } = getStore();
    const now = new Date().toISOString();
    db.insert(schema.shopKernels).values({
      id: KERNEL_B, name: "Kernel B", operatorAddress: "b@test", location: { lat: 0, lng: 0 }, physicalAddress: "test",
      maxAssuranceTier: 2, publicKey: "b-key", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1.0.0",
    } as any).run();
    registerCap("cap-n100-neg-b", KERNEL_B, TYPE, { currency: "USDC", baseCost: "999.00", minimum: "0.01" });

    const before = db.select().from(schema.negotiationSessions).all().length;
    const res = await createSession(app, { capabilityId: "cap-n100-neg-b" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("capability_kernel_mismatch");
    expect(db.select().from(schema.negotiationSessions).all().length).toBe(before);
  });

  it("kernel B's capabilityId on a kernel-A session is refused AT QUOTE too (defense in depth), no session mutation", async () => {
    registerCap("cap-n100-neg-a2", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const KERNEL_B = "kernel-n100-neg-b2";
    const { db } = getStore();
    const now = new Date().toISOString();
    db.insert(schema.shopKernels).values({
      id: KERNEL_B, name: "Kernel B2", operatorAddress: "b2@test", location: { lat: 0, lng: 0 }, physicalAddress: "test",
      maxAssuranceTier: 2, publicKey: "b2-key", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1.0.0",
    } as any).run();
    registerCap("cap-n100-neg-b2", KERNEL_B, TYPE, { currency: "USDC", baseCost: "999.00", minimum: "0.01" });

    // Create a legitimate session (no capabilityId — type-only, unambiguous), then
    // directly set its capabilityId to kernel B's row — the only way to reach the
    // quote-time gate once creation itself refuses the mismatch.
    const create = await createSession(app, {});
    expect(create.statusCode).toBe(200);
    const id = create.json().session.id;
    db.update(schema.negotiationSessions).set({ capabilityId: "cap-n100-neg-b2" }).where(eq(schema.negotiationSessions.id, id)).run();

    const res = await quote(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("capability_kernel_mismatch");
    const row = sessionRow(id);
    expect(row!.quote).toBeNull();
    expect(row!.status).not.toBe("quoted");
  });

  it("a capabilityId of the WRONG TYPE is refused AT CREATION (409 capability_type_mismatch)", async () => {
    registerCap("cap-n100-neg-wrongtype", KERNEL, "centrifuge", { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    registerCap("cap-n100-neg-righttype", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const res = await createSession(app, { capabilityId: "cap-n100-neg-wrongtype" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("capability_type_mismatch");
  });
});
