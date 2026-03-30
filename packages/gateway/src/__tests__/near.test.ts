/**
 * Tests for NEAR Protocol gateway routes.
 *
 * GET  /api/near/status         — integration status
 * POST /api/near/quote          — cross-chain payment quote
 * POST /api/near/intent         — submit cross-chain payment intent
 * GET  /api/near/intent/:id     — check intent status
 *
 * All tests run in mock mode (NEAR_MOCK=true / NODE_ENV=test).
 * No real 1Click API calls are made.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { nearRoutes } from "../routes/near.js";
import { resetNearMockState } from "../contracts/near-client.js";

// Ensure mock mode
process.env.NEAR_MOCK = "true";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(nearRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_QUOTE_BODY = {
  fromChain: "near",
  fromAsset: "USDC",
  toChain: "base",
  toAsset: "USDC",
  amount: "1000000",
};

// ---------------------------------------------------------------------------
// GET /api/near/status
// ---------------------------------------------------------------------------

describe("GET /api/near/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    resetNearMockState();
  });

  it("returns 200 with integration details", async () => {
    const res = await app.inject({ method: "GET", url: "/api/near/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.integration).toBe("near-chain-abstraction");
    expect(body.network).toBeDefined();
    expect(body.capabilities).toBeDefined();
  });

  it("includes supportedChains array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/near/status" });
    const body = res.json<{ supportedChains: string[] }>();
    expect(Array.isArray(body.supportedChains)).toBe(true);
    expect(body.supportedChains).toContain("near");
  });

  it("includes supportedAssets array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/near/status" });
    const body = res.json<{ supportedAssets: string[] }>();
    expect(Array.isArray(body.supportedAssets)).toBe(true);
    expect(body.supportedAssets).toContain("USDC");
  });

  it("reports mock=true in test mode", async () => {
    const res = await app.inject({ method: "GET", url: "/api/near/status" });
    const body = res.json<{ mock: boolean }>();
    expect(body.mock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/near/quote
// ---------------------------------------------------------------------------

describe("POST /api/near/quote", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    resetNearMockState();
  });

  afterEach(async () => {
    await app.close();
    resetNearMockState();
  });

  it("returns 200 with a valid quote", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: VALID_QUOTE_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ quote: Record<string, unknown> }>();
    expect(body.quote).toBeDefined();
    expect(body.quote.quoteId).toBeDefined();
    expect(body.quote.fromChain).toBe("near");
    expect(body.quote.toChain).toBe("base");
    expect(body.quote.fromAmount).toBe("1000000");
    expect(body.quote.validUntil).toBeDefined();
  });

  it("quote toAmount is less than fromAmount (fee deducted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: VALID_QUOTE_BODY,
    });

    const body = res.json<{ quote: { fromAmount: string; toAmount: string } }>();
    const from = BigInt(body.quote.fromAmount);
    const to = BigInt(body.quote.toAmount);
    expect(to).toBeLessThan(from);
  });

  it("returns 400 when fromChain is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { fromAsset: "USDC", toChain: "base", toAsset: "USDC", amount: "1000" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain("fromChain");
  });

  it("returns 400 when fromAsset is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { fromChain: "near", toChain: "base", toAsset: "USDC", amount: "1000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when toChain is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { fromChain: "near", fromAsset: "USDC", toAsset: "USDC", amount: "1000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when toAsset is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { fromChain: "near", fromAsset: "USDC", toChain: "base", amount: "1000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when amount is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { fromChain: "near", fromAsset: "USDC", toChain: "base", toAsset: "USDC" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when amount is zero", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { ...VALID_QUOTE_BODY, amount: "0" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("includes _meta with integration info", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: VALID_QUOTE_BODY,
    });
    const body = res.json<{ _meta: { integration: string } }>();
    expect(body._meta.integration).toBe("near-1click");
  });

  it("accepts optional recipient field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: { ...VALID_QUOTE_BODY, recipient: "alice.near" },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/near/intent (requires a prior quote)
// ---------------------------------------------------------------------------

describe("POST /api/near/intent", () => {
  let app: FastifyInstance;
  let quoteId: string;

  beforeEach(async () => {
    app = await buildApp();
    resetNearMockState();

    // Get a quote first
    const quoteRes = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: VALID_QUOTE_BODY,
    });
    quoteId = quoteRes.json<{ quote: { quoteId: string } }>().quote.quoteId;
  });

  afterEach(async () => {
    await app.close();
    resetNearMockState();
  });

  it("returns 200 with a valid intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId, workflowId: "workflow-001" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ intent: Record<string, unknown> }>();
    expect(body.intent).toBeDefined();
    expect(body.intent.intentId).toBeDefined();
    expect(body.intent.quoteId).toBe(quoteId);
    expect(body.intent.status).toBeDefined();
  });

  it("intent has a txHash in mock mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId, workflowId: "workflow-002" },
    });
    const body = res.json<{ intent: { txHash?: string } }>();
    expect(body.intent.txHash).toBeDefined();
  });

  it("intent has an explorerUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId, workflowId: "workflow-003" },
    });
    const body = res.json<{ intent: { explorerUrl?: string } }>();
    expect(body.intent.explorerUrl).toBeDefined();
    expect(body.intent.explorerUrl).toContain("nearblocks.io");
  });

  it("returns 400 when quoteId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { workflowId: "workflow-004" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain("quoteId");
  });

  it("returns 400 when workflowId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain("workflowId");
  });

  it("includes _meta with integration info", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId, workflowId: "workflow-005" },
    });
    const body = res.json<{ _meta: { integration: string } }>();
    expect(body._meta.integration).toBe("near-1click");
  });

  it("submitting with unknown quoteId still succeeds in mock mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId: "unknown-quote-id", workflowId: "workflow-006" },
    });
    // Mock mode creates a synthetic quote for unknown quoteIds
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/near/intent/:intentId
// ---------------------------------------------------------------------------

describe("GET /api/near/intent/:intentId", () => {
  let app: FastifyInstance;
  let intentId: string;

  beforeEach(async () => {
    app = await buildApp();
    resetNearMockState();

    // Quote then submit an intent
    const quoteRes = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: VALID_QUOTE_BODY,
    });
    const qId = quoteRes.json<{ quote: { quoteId: string } }>().quote.quoteId;

    const intentRes = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: { quoteId: qId, workflowId: "workflow-status-test" },
    });
    intentId = intentRes.json<{ intent: { intentId: string } }>().intent.intentId;
  });

  afterEach(async () => {
    await app.close();
    resetNearMockState();
  });

  it("returns 200 with intent status", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/near/intent/${encodeURIComponent(intentId)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: Record<string, unknown> }>();
    expect(body.status).toBeDefined();
    expect(body.status.intentId).toBe(intentId);
    expect(body.status.status).toBeDefined();
  });

  it("status contains chain info", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/near/intent/${encodeURIComponent(intentId)}`,
    });
    const body = res.json<{
      status: { fromChain: string; toChain: string; fromAmount: string; toAmount: string };
    }>();
    expect(body.status.fromChain).toBeDefined();
    expect(body.status.toChain).toBeDefined();
    expect(body.status.fromAmount).toBeDefined();
    expect(body.status.toAmount).toBeDefined();
  });

  it("returns 404 for unknown intentId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/near/intent/nonexistent-intent-xyz",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("intent_not_found");
  });

  it("includes _meta with integration info", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/near/intent/${encodeURIComponent(intentId)}`,
    });
    const body = res.json<{ _meta: { integration: string } }>();
    expect(body._meta.integration).toBe("near-1click");
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow: quote → intent → status
// ---------------------------------------------------------------------------

describe("NEAR end-to-end flow: quote → intent → status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    resetNearMockState();
  });

  afterEach(async () => {
    await app.close();
    resetNearMockState();
  });

  it("completes a full cross-chain payment flow", async () => {
    // Step 1: Get a quote
    const quoteRes = await app.inject({
      method: "POST",
      url: "/api/near/quote",
      payload: {
        fromChain: "near",
        fromAsset: "USDC",
        toChain: "base",
        toAsset: "USDC",
        amount: "5000000",
      },
    });
    expect(quoteRes.statusCode).toBe(200);
    const { quote } = quoteRes.json<{ quote: { quoteId: string; toAmount: string } }>();
    expect(quote.quoteId).toBeTruthy();

    // Step 2: Submit an intent
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/near/intent",
      payload: {
        quoteId: quote.quoteId,
        workflowId: "e2e-workflow-001",
      },
    });
    expect(intentRes.statusCode).toBe(200);
    const { intent } = intentRes.json<{
      intent: { intentId: string; status: string; txHash?: string };
    }>();
    expect(intent.intentId).toBeTruthy();
    expect(intent.status).toBeDefined();

    // Step 3: Poll status
    const statusRes = await app.inject({
      method: "GET",
      url: `/api/near/intent/${encodeURIComponent(intent.intentId)}`,
    });
    expect(statusRes.statusCode).toBe(200);
    const { status } = statusRes.json<{
      status: { intentId: string; status: string };
    }>();
    expect(status.intentId).toBe(intent.intentId);
    expect(status.status).toBeDefined();
  });
});
