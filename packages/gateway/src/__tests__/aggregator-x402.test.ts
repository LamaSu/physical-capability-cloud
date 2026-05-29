/**
 * End-to-end tests for x402 gating on POST /api/aggregator/invoke/:toolId.
 *
 * Strategy: spin up Fastify + in-memory store + aggregator routes, configure
 * the x402 gate via env vars, mock the facilitator with `setGlobalDispatcher`
 * is overkill — we use a fetch override on the gate config singleton by
 * temporarily mutating env + the in-test helper hook on `getX402GateConfig`.
 *
 * Tests cover the seven scenarios called out in scope §6.2/§8.x:
 *   1. Free tool (no pricing) → 200 unchanged
 *   2. Paid tool, no PAYMENT-SIGNATURE → 402 with priceTag
 *   3. Paid tool, malformed PAYMENT-SIGNATURE → 402 with error
 *   4. Paid tool, tampered amount → 402
 *   5. Paid tool, valid payment + verify-OK + settle-OK → 200 with payment
 *   6. Paid tool, settle returns success:false → 502
 *   7. Paid tool, idempotent replay → 200 with prior receipt
 *   8. Paid tool, facilitator /verify down → 503
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import {
  aggregatorRoutes,
  getAggregatorRegistry,
  _resetAggregatorRegistryForTests,
} from "../routes/aggregator/index.js";
import { initStore, closeStore } from "../db.js";
import {
  type IndexedTool,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";
import {
  toAtomicUsdc,
  priceTagHmac,
  type PriceTagFields,
} from "@pcc/aggregator";

const SHA = "sha256:" + "a".repeat(64);
const HMAC = "deadbeef".repeat(8); // 64 hex chars
const TREASURY = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function makePaidTool(perCallUsdc = "0.01"): IndexedTool {
  return {
    id: "paid-tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.example.com",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://api.example.com/paid",
    skills: [],
    domains: [],
    features: [],
    inputSchema: { type: "object" },
    description: "a paid tool",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    pricing: { perCallUsdc },
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
  };
}

function makeFreeTool(): IndexedTool {
  const t = makePaidTool();
  t.id = "free-tool-1";
  delete t.pricing;
  return t;
}

function setGateEnv(opts: { facilitatorUrl: string }) {
  process.env.PCC_X402_ENABLED = "true";
  process.env.PCC_X402_CHAIN = "base-sepolia";
  process.env.PCC_X402_FACILITATOR_URL = opts.facilitatorUrl;
  process.env.PCC_AGGREGATOR_TREASURY = TREASURY;
  process.env.PCC_X402_HMAC_KEY = HMAC;
}

function clearGateEnv() {
  delete process.env.PCC_X402_ENABLED;
  delete process.env.PCC_X402_CHAIN;
  delete process.env.PCC_X402_FACILITATOR_URL;
  delete process.env.PCC_AGGREGATOR_TREASURY;
  delete process.env.PCC_X402_HMAC_KEY;
}

/**
 * Build a base64-encoded PAYMENT-SIGNATURE header for the gateway's expected
 * (toolId, atomic-amount, network, payTo) tuple. Honors the gateway's HMAC
 * so the priceTag is valid.
 */
function buildPaymentSignature(
  toolId: string,
  atomic: string,
  options: {
    nonce?: string;
    from?: string;
    overrideAmount?: string;
    network?: string;
    payTo?: string;
  } = {},
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const validUntil = (nowSec + 300).toString();
  const network = options.network ?? "eip155:84532";
  const payTo = options.payTo ?? TREASURY;
  const tagFields: PriceTagFields = {
    toolId,
    amount: atomic,
    network,
    payTo,
    validUntil,
  };
  const tag = priceTagHmac(tagFields, HMAC);
  const reqs: X402PaymentRequirements = {
    scheme: "exact",
    network,
    amount: options.overrideAmount ?? atomic,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo,
    maxTimeoutSeconds: 300,
    extra: { priceTag: tag, validUntil, toolId },
  };
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: reqs,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: options.from ?? PAYER,
        to: payTo,
        value: options.overrideAmount ?? atomic,
        validAfter: (nowSec - 60).toString(),
        validBefore: (nowSec + 240).toString(),
        nonce: options.nonce ?? ("0x" + "fa".repeat(32)),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Mock global fetch to handle both /verify and /settle on the facilitator
 * AND the upstream tool URL.
 */
function installFetchMock(opts: {
  verifyOk?: boolean;
  settleOk?: boolean;
  verifyTimeout?: boolean;
  settleErrorReason?: string;
  upstreamStatus?: number;
  upstreamBody?: unknown;
}) {
  const upstreamStatus = opts.upstreamStatus ?? 200;
  const upstreamBody = opts.upstreamBody ?? { ok: true };
  const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/verify")) {
      if (opts.verifyTimeout) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err: Error & { name?: string } = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return new Response(
        JSON.stringify(
          opts.verifyOk ?? true
            ? { isValid: true, payer: PAYER }
            : { isValid: false, invalidReason: "INSUFFICIENT_FUNDS" },
        ),
        { status: opts.verifyOk ?? true ? 200 : 412 },
      );
    }
    if (url.endsWith("/settle")) {
      return new Response(
        JSON.stringify(
          opts.settleOk ?? true
            ? {
                success: true,
                transaction: "0x" + "ab".repeat(32),
                network: "eip155:84532",
                payer: PAYER,
              }
            : {
                success: false,
                errorReason: opts.settleErrorReason ?? "NONCE_USED",
                transaction: "0x" + "00".repeat(32),
                network: "eip155:84532",
              },
        ),
        { status: opts.settleOk ?? true ? 200 : 400 },
      );
    }
    // Upstream call.
    return new Response(JSON.stringify(upstreamBody), { status: upstreamStatus });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  return fakeFetch;
}

describe("aggregator x402 gating (e2e)", () => {
  beforeEach(() => {
    _resetAggregatorRegistryForTests();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    clearGateEnv();
  });
  afterEach(() => {
    closeStore();
    vi.restoreAllMocks();
    clearGateEnv();
    _resetAggregatorRegistryForTests();
  });

  describe("scenario 1: free tool", () => {
    it("returns 200 with NO payment field when tool has no pricing", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makeFreeTool());
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({});
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/free-tool-1",
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment).toBeUndefined();
      expect(body.receiptCID).toMatch(/^sha256:[0-9a-f]{64}$/);
      await app.close();
    });

    it("returns 200 unchanged when gate is disabled (no env)", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool());
      // gate disabled — no env set
      installFetchMock({});
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment).toBeUndefined();
      await app.close();
    });
  });

  describe("scenario 2: paid tool, no PAYMENT-SIGNATURE", () => {
    it("returns 402 with PAYMENT-REQUIRED header + body", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({});
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(402);
      expect(res.headers["payment-required"]).toBeTruthy();
      const body = res.json();
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0].amount).toBe(toAtomicUsdc("0.01"));
      expect(body.accepts[0].payTo).toBe(TREASURY);
      expect(body.accepts[0].extra.priceTag).toMatch(/^[0-9a-f]{64}$/);
      await app.close();
    });
  });

  describe("scenario 3: malformed PAYMENT-SIGNATURE", () => {
    it("returns 402 with error message", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool());
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({});
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": "not-base64-json!!" },
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body.error).toContain("malformed");
      await app.close();
    });
  });

  describe("scenario 4: tampered amount", () => {
    it("returns 402 with amount_mismatch when caller signed for wrong amount", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({});
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
        { overrideAmount: "1" }, // attacker tries to pay 0.000001
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body.error).toContain("amount_mismatch");
      await app.close();
    });
  });

  describe("scenario 5: valid payment, verify OK, settle OK", () => {
    it("returns 200 with payment field populated + receipt has paymentTxHash/pricePaidUsdc", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      const fetchSpy = installFetchMock({
        verifyOk: true,
        settleOk: true,
        upstreamBody: { ok: true, data: 42 },
      });
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment).toBeDefined();
      expect(body.payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.payment.pricePaidUsdc).toBe("0.01");
      expect(body.payment.payer.toLowerCase()).toBe(PAYER);
      expect(body.result).toEqual({ ok: true, data: 42 });
      // verify + settle + upstream = 3 fetch calls.
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.endsWith("/verify"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/settle"))).toBe(true);
      expect(urls.some((u) => u.includes("api.example.com/paid"))).toBe(true);
      await app.close();
    });
  });

  describe("scenario 6: upstream OK but settle fails", () => {
    it("returns 502 and discards the upstream response", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({
        verifyOk: true,
        settleOk: false,
        settleErrorReason: "NONCE_USED",
      });
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toBe("settlement_failed");
      expect(body.message).toContain("NONCE_USED");
      await app.close();
    });
  });

  describe("scenario 7: idempotent replay", () => {
    it("returns the prior receipt CID on a second attempt with the same nonce+from", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      const fetchSpy = installFetchMock({
        verifyOk: true,
        settleOk: true,
      });
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );
      const r1 = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(r1.statusCode).toBe(200);
      const firstCID = r1.json().receiptCID;

      // Reset upstream + facilitator call counts so we can assert NO calls.
      fetchSpy.mockClear();
      // Second attempt — same header.
      const r2 = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(r2.statusCode).toBe(200);
      const secondCID = r2.json().receiptCID;
      expect(secondCID).toBe(firstCID);
      // The replay must not have called the upstream, /verify, or /settle.
      expect(fetchSpy).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("scenario 8: facilitator /verify down", () => {
    it("returns 503 facilitator_unavailable", async () => {
      const reg = getAggregatorRegistry();
      reg.upsert(makePaidTool("0.01"));
      setGateEnv({ facilitatorUrl: "https://fac.test" });
      installFetchMock({ verifyTimeout: true });
      // Override the facilitator verify timeout to be ultra-short so the test
      // doesn't actually wait 5s. We do this by mutating the gate config
      // singleton — which we can't directly. Instead, rely on the abort
      // signal being honored by the mock.
      // The default 5s verify timeout means this test could be slow; cap via
      // the test's own timeout below.
      const app = Fastify();
      await app.register(aggregatorRoutes);
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/paid-tool-1",
        headers: { "payment-signature": header },
        payload: { args: {} },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe("facilitator_unavailable");
      await app.close();
    }, 10_000);
  });
});
