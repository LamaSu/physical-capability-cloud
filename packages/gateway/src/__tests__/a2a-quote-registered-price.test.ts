/**
 * N100: A2A tasks/send "pcc-quote" (createPccQuote, a2a-tasks.ts) quotes the
 * operator's REGISTERED price through the SAME shared evaluator as discovery
 * and negotiation (#498 quote-pricing.ts) — never the template hint, never 10,
 * with VALIDATED rules only, and exact bigint bond math. The quote is computed
 * BEFORE the session insert, so a refusal creates no session row.
 *
 * VERIFY BEFORE FIX: every test here is the FIXED behaviour. Run first against
 * unmodified b7f54689 to record the actual-vs-expected failure line, per defect:
 *   - the price is the template hint or 10 (a2a-tasks.ts:314-316).
 *   - every enabled rule applies unconditionally (:318).
 *   - the currency is the template's or USDC, no settlement-currency check (:337).
 *   - the bond is float (:325, :338).
 *   - the session is inserted BEFORE the quote is computed (:285-312 before :314-338),
 *     so a refusal still leaves a "created" session row.
 *
 * Errors surface as JSON-RPC: HTTP 200, body.error.code === -32603, and
 * body.error.message is the SAME machine-readable code the other routes use
 * (the file's existing top-level catch wraps any thrown Error this way).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";

const KERNEL = "kernel-n100-a2a";
const TYPE = "liquid-handler"; // built-in template; basePricingHints.basePrice = "10.00"

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_A2A_AUTH_DISABLED = "true";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });

  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(schema.shopKernels).values({
    id: KERNEL,
    name: "N100 A2A Test Kernel",
    operatorAddress: "n100-a2a@test",
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "n100-a2a-key",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();

  const app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
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
  const policy = { ...DEFAULT_OPERATOR_POLICY, ...patch };
  const exists = db.select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, KERNEL)).get();
  if (exists) {
    db.update(schema.operatorPolicies).set({ policy: policy as never }).where(eq(schema.operatorPolicies.kernelId, KERNEL)).run();
  } else {
    db.insert(schema.operatorPolicies).values({ kernelId: KERNEL, policy: policy as never, updatedAt: new Date().toISOString() } as never).run();
  }
}

function rpcRequest(id: string | number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function sendQuote(app: FastifyInstance, rpcId: string, params: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/a2a/tasks/send",
    payload: rpcRequest(rpcId, "tasks/send", {
      skill: "pcc-quote",
      params: { userAgentId: "buyer-n100-a2a", kernelId: KERNEL, capabilityType: TYPE, ...params },
    }),
    headers: { "content-type": "application/json" },
  });
}

function sessionCount() {
  return getStore().db.select().from(schema.negotiationSessions).all().length;
}

describe("N100 A2A pcc-quote: the registered price, through the shared evaluator", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); __resetA2ATasksForTest(); });
  afterEach(async () => { await app.close(); closeStore(); });

  it("quotes the registered price x quantity, NEVER the template's basePricingHints ($10.00)", async () => {
    registerCap("cap-n100-a2a-1", KERNEL, TYPE, { currency: "USDC", baseCost: "37.50", minimum: "0.01" });
    const res = await sendQuote(app, "q1", { selections: { quantity: 3 } });
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect([quote.basePrice, quote.totalPrice, quote.currency]).toEqual(["37.50", "112.50", "USDC"]);
  });

  it("the operator's registered minimum is a floor under price x quantity", async () => {
    registerCap("cap-n100-a2a-2", KERNEL, TYPE, { currency: "USDC", baseCost: "5.00", minimum: "50.00" });
    const res = await sendQuote(app, "q2", {});
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect([quote.basePrice, quote.totalPrice]).toEqual(["5.00", "50.00"]);
  });

  it.each(["EUR", "USD"])("a registered %s price is refused (capability_price_unsupported_currency), no session row", async (currency) => {
    registerCap("cap-n100-a2a-cur", KERNEL, TYPE, { currency, baseCost: "10.00", minimum: "0.01" });
    const before = sessionCount();
    const res = await sendQuote(app, "q3", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32603);
    expect(res.json().error.message).toBe("capability_price_unsupported_currency");
    expect(sessionCount()).toBe(before);
  });

  it("a 13-digit exact baseCost at quantity 10 keeps exact cents (no Number for money)", async () => {
    registerCap("cap-n100-a2a-big", KERNEL, TYPE, { currency: "USDC", baseCost: "9999999999999.99", minimum: "0.01" });
    setPolicy({ pricingRules: [] });
    const res = await sendQuote(app, "q4", { selections: { quantity: 10 } });
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect(quote.totalPrice).toBe("99999999999999.90");
  });

  it("a malformed pricing rule is refused (operator_pricing_policy_invalid), no session row", async () => {
    registerCap("cap-n100-a2a-badrule", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPolicy({ pricingRules: [{ id: "bad", label: "bad", enabled: true, condition: {}, impact: { mode: "percent", value: "1" } }] }); // missing `type`
    const before = sessionCount();
    const res = await sendQuote(app, "q5", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toBe("operator_pricing_policy_invalid");
    expect(sessionCount()).toBe(before);
  });

  it("the DEFAULT policy's rush (+25%) and loyalty (-5%) rules no longer apply (no time/history fact)", async () => {
    registerCap("cap-n100-a2a-rl", KERNEL, TYPE, { currency: "USDC", baseCost: "100.00", minimum: "0.01" });
    const res = await sendQuote(app, "q6", { selections: { quantity: 1 } });
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect([quote.totalPrice, quote.adjustments]).toEqual(["100.00", []]);
  });

  it("the volume rule applies only from quantity >= 10", async () => {
    registerCap("cap-n100-a2a-vol", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    const nine = (await sendQuote(app, "q7a", { selections: { quantity: 9 } })).json().result.artifacts[0].data.quote;
    expect([nine.totalPrice, nine.adjustments]).toEqual(["225.00", []]);
    const ten = (await sendQuote(app, "q7b", { selections: { quantity: 10 } })).json().result.artifacts[0].data.quote;
    expect([ten.totalPrice, ten.adjustments.map((a: { ruleId: string }) => a.ruleId)]).toEqual(["225.00", ["volume-10"]]);
  });

  it("the bond is exact: a tie (total 0.10 at 5%) rounds half up to 0.01", async () => {
    registerCap("cap-n100-a2a-tie", KERNEL, TYPE, { currency: "USDC", baseCost: "0.10", minimum: "0.01" });
    const res = await sendQuote(app, "q8", { selections: { evidenceTier: "basic" } }); // tier 1 => 5% bond
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect(quote.bondAmount).toBe("0.01");
  });

  it("the bond is exact on a large total (15% tier)", async () => {
    registerCap("cap-n100-a2a-largebond", KERNEL, TYPE, { currency: "USDC", baseCost: "123456.78", minimum: "0.01" });
    const res = await sendQuote(app, "q9", { selections: { evidenceTier: "full" } }); // tier 2 => 15% bond
    expect(res.statusCode).toBe(200);
    const quote = res.json().result.artifacts[0].data.quote;
    expect(quote.bondAmount).toBe("18518.52");
  });

  it("an invalid bondPercentOverride is refused (operator_pricing_policy_invalid), no session row", async () => {
    registerCap("cap-n100-a2a-badbond", KERNEL, TYPE, { currency: "USDC", baseCost: "25.00", minimum: "0.01" });
    setPolicy({ bondPercentOverride: 150 });
    const before = sessionCount();
    const res = await sendQuote(app, "q10", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toBe("operator_pricing_policy_invalid");
    expect(sessionCount()).toBe(before);
  });

  it("a nonexistent capabilityId is refused as capability_not_found, no session row (never silently falls back)", async () => {
    registerCap("cap-n100-a2a-exists", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const before = sessionCount();
    const res = await sendQuote(app, "q11", { capabilityId: "cap-does-not-exist" });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toBe("capability_not_found");
    expect(sessionCount()).toBe(before);
  });

  it("kernel B's capabilityId on a kernel-A quote is refused (capability_kernel_mismatch), no session row", async () => {
    registerCap("cap-n100-a2a-ka", KERNEL, TYPE, { currency: "USDC", baseCost: "20.00", minimum: "0.01" });
    const KERNEL_B = "kernel-n100-a2a-b";
    const { db } = getStore();
    const now = new Date().toISOString();
    db.insert(schema.shopKernels).values({
      id: KERNEL_B, name: "Kernel B", operatorAddress: "b@test", location: { lat: 0, lng: 0 }, physicalAddress: "test",
      maxAssuranceTier: 2, publicKey: "b-key", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1.0.0",
    } as any).run();
    registerCap("cap-n100-a2a-kb", KERNEL_B, TYPE, { currency: "USDC", baseCost: "999.00", minimum: "0.01" });

    const before = sessionCount();
    const res = await sendQuote(app, "q12", { capabilityId: "cap-n100-a2a-kb" });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toBe("capability_kernel_mismatch");
    expect(sessionCount()).toBe(before);
  });
});
