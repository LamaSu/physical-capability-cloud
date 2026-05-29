import { describe, it, expect, beforeEach } from "vitest";
import {
  requirePayment,
  recordSettlement,
  type X402GateConfig,
  type GateRequestContext,
} from "../x402-gate.js";
import {
  toAtomicUsdc,
  priceTagHmac,
  type PriceTagFields,
} from "../pricing.js";
import { NonceCache } from "../x402-nonce-cache.js";
import {
  type IndexedTool,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const HMAC = "abcdef0123456789".repeat(4);
const TREASURY = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x2222222222222222222222222222222222222222";
const NETWORK = "eip155:84532";
const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-paid",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://example.test",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://api.example.test/x",
    skills: [],
    domains: [],
    features: [],
    inputSchema: { type: "object" },
    description: "paid tool",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    pricing: { perCallUsdc: "0.01" }, // 10000 atomic
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function mkConfig(
  facilitatorFetch: typeof fetch,
  override: Partial<X402GateConfig> = {},
): X402GateConfig {
  return {
    enabled: true,
    network: NETWORK,
    usdcAddress: USDC,
    payTo: TREASURY,
    maxTimeoutSeconds: 300,
    facilitator: {
      url: "https://facilitator.test",
      fetchImpl: facilitatorFetch,
      verifyTimeoutMs: 200,
      settleTimeoutMs: 200,
    },
    hmacSecretHex: HMAC,
    nonceCache: new NonceCache(),
    now: () => NOW_MS,
    ...override,
  };
}

const ctx: GateRequestContext = {
  resourceUrl: "/api/aggregator/invoke/tool-paid",
};

/**
 * Build a fully-signed PAYMENT-SIGNATURE header value for a given tool/amount,
 * including the price-tag the gate's challenge would have embedded.
 */
function buildPaymentHeader(
  toolId: string,
  amountAtomic: string,
  hmac: string,
  payTo: string,
  network: string,
  nowSec: number,
  options: {
    validForSec?: number;
    nonce?: string;
    from?: string;
    overrideAmount?: string;
    overridePayTo?: string;
    overrideNetwork?: string;
    overrideToValue?: string; // for to-mismatch test
    expired?: boolean;
    skipTag?: boolean;
  } = {},
): string {
  const validUntil = (
    nowSec + (options.validForSec ?? 300)
  ).toString();
  const tagFields: PriceTagFields = {
    toolId,
    amount: amountAtomic,
    network,
    payTo,
    validUntil,
  };
  const tag = priceTagHmac(tagFields, hmac);
  const reqs: X402PaymentRequirements = {
    scheme: "exact",
    network: options.overrideNetwork ?? network,
    amount: options.overrideAmount ?? amountAtomic,
    asset: USDC,
    payTo: options.overridePayTo ?? payTo,
    maxTimeoutSeconds: 300,
    extra: options.skipTag
      ? undefined
      : { priceTag: tag, validUntil, toolId },
  };
  const validAfter = options.expired
    ? (nowSec - 600).toString()
    : (nowSec - 60).toString();
  const validBefore = options.expired
    ? (nowSec - 300).toString()
    : (nowSec + 300).toString();
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: reqs,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: options.from ?? PAYER,
        to: options.overrideToValue ?? options.overridePayTo ?? payTo,
        value: options.overrideAmount ?? amountAtomic,
        validAfter,
        validBefore,
        nonce: options.nonce ?? ("0x" + "cd".repeat(32)),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function mockFacFetch(
  verifyOk: boolean,
  settleOk: boolean,
  options: { invalidReason?: string; errorReason?: string; throwOnVerify?: boolean; throwOnSettle?: boolean } = {},
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/verify")) {
      if (options.throwOnVerify) {
        const err: Error & { name?: string } = new Error("aborted");
        err.name = "AbortError";
        // Simulate timeout via abort signal handling
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(err));
          if (init?.signal?.aborted) reject(err);
        });
      }
      return new Response(
        JSON.stringify(
          verifyOk
            ? { isValid: true, payer: PAYER }
            : { isValid: false, invalidReason: options.invalidReason ?? "INSUFFICIENT_FUNDS" },
        ),
        { status: verifyOk ? 200 : 412 },
      );
    }
    if (url.endsWith("/settle")) {
      if (options.throwOnSettle) {
        const err: Error & { name?: string } = new Error("aborted");
        err.name = "AbortError";
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(err));
          if (init?.signal?.aborted) reject(err);
        });
      }
      return new Response(
        JSON.stringify(
          settleOk
            ? {
                success: true,
                transaction: "0x" + "ab".repeat(32),
                network: NETWORK,
                payer: PAYER,
              }
            : {
                success: false,
                errorReason: options.errorReason ?? "NONCE_USED",
                transaction: "0x" + "0".repeat(64),
                network: NETWORK,
              },
        ),
        { status: settleOk ? 200 : 400 },
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("requirePayment", () => {
  let fetchUsed: typeof fetch;
  beforeEach(() => {
    fetchUsed = mockFacFetch(true, true);
  });

  describe("free path", () => {
    it("returns 'free' if gate is disabled", async () => {
      const cfg = mkConfig(fetchUsed, { enabled: false });
      const v = await requirePayment(makeTool(), ctx, cfg);
      expect(v.kind).toBe("free");
    });

    it("returns 'free' if tool has no pricing", async () => {
      const cfg = mkConfig(fetchUsed);
      const t = makeTool({ pricing: undefined });
      const v = await requirePayment(t, ctx, cfg);
      expect(v.kind).toBe("free");
    });

    it("returns 'free' if perCallUsdc is '0'", async () => {
      const cfg = mkConfig(fetchUsed);
      const t = makeTool({ pricing: { perCallUsdc: "0" } });
      const v = await requirePayment(t, ctx, cfg);
      expect(v.kind).toBe("free");
    });
  });

  describe("challenge (402) path", () => {
    it("returns 402 with PAYMENT-REQUIRED header when no signature header", async () => {
      const cfg = mkConfig(fetchUsed);
      const v = await requirePayment(makeTool(), ctx, cfg);
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.status).toBe(402);
      expect(v.body.x402Version).toBe(2);
      expect(v.body.accepts[0]?.amount).toBe(toAtomicUsdc("0.01"));
      expect(v.body.accepts[0]?.payTo).toBe(TREASURY);
      expect(v.body.accepts[0]?.network).toBe(NETWORK);
      expect(v.body.accepts[0]?.extra?.priceTag).toMatch(/^[0-9a-f]{64}$/);
      expect(v.headers["PAYMENT-REQUIRED"]).toMatch(/.+/);
    });

    it("returns 402 with error if PAYMENT-SIGNATURE is malformed base64", async () => {
      const cfg = mkConfig(fetchUsed);
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: "not-valid-base64-json!!!" },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("malformed");
    });

    it("returns 402 if amount differs from gateway price", async () => {
      const cfg = mkConfig(fetchUsed);
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
        { overrideAmount: "5" }, // wrong amount
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("amount_mismatch");
    });

    it("returns 402 if payTo differs from gateway treasury", async () => {
      const cfg = mkConfig(fetchUsed);
      const wrongTreasury = "0x9999999999999999999999999999999999999999";
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        wrongTreasury, // signed for wrong treasury
        NETWORK,
        NOW_SEC,
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("payTo_mismatch");
    });

    it("returns 402 if authorization window is expired", async () => {
      const cfg = mkConfig(fetchUsed);
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
        { expired: true },
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("expired");
    });

    it("returns 402 if price-tag is tampered", async () => {
      const cfg = mkConfig(fetchUsed);
      const decoded = Buffer.from(
        buildPaymentHeader(
          "tool-paid",
          toAtomicUsdc("0.01"),
          HMAC,
          TREASURY,
          NETWORK,
          NOW_SEC,
        ),
        "base64",
      ).toString();
      const obj = JSON.parse(decoded) as X402PaymentPayload;
      // Tamper with the tag in-place after a valid header was constructed
      if (obj.accepted.extra) {
        obj.accepted.extra.priceTag = "0".repeat(64);
      }
      const header = Buffer.from(JSON.stringify(obj)).toString("base64");
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("priceTag_mismatch");
    });

    it("returns 402 if facilitator says isValid:false", async () => {
      const cfg = mkConfig(mockFacFetch(false, false, { invalidReason: "BAD_SIG" }));
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("challenge");
      if (v.kind !== "challenge") return;
      expect(v.body.error).toContain("payment_invalid");
      expect(v.body.error).toContain("BAD_SIG");
    });
  });

  describe("verified path", () => {
    it("returns verified verdict + settle thunk when payment OK", async () => {
      const cfg = mkConfig(mockFacFetch(true, true));
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("verified");
      if (v.kind !== "verified") return;
      const settle = await v.settle();
      expect(settle.ok).toBe(true);
      if (!settle.ok) return;
      expect(settle.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(settle.pricePaidUsdc).toBe("0.01");
      expect(settle.payer.toLowerCase()).toBe(PAYER);
    });

    it("settle thunk returns ok:false (502) if facilitator /settle says success:false", async () => {
      const cfg = mkConfig(mockFacFetch(true, false));
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("verified");
      if (v.kind !== "verified") return;
      const settle = await v.settle();
      expect(settle.ok).toBe(false);
      if (settle.ok) return;
      expect(settle.status).toBe(502);
      expect(settle.reason).toContain("settle_failed");
    });
  });

  describe("facilitator unavailable", () => {
    it("returns 503 when facilitator /verify times out", async () => {
      const cfg = mkConfig(mockFacFetch(true, true, { throwOnVerify: true }), {
        facilitator: {
          url: "https://facilitator.test",
          fetchImpl: mockFacFetch(true, true, { throwOnVerify: true }),
          verifyTimeoutMs: 10,
        },
      });
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
      );
      const v = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v.kind).toBe("facilitator_unavailable");
      if (v.kind !== "facilitator_unavailable") return;
      expect(v.status).toBe(503);
    });
  });

  describe("idempotency replay", () => {
    it("returns replayedCID on a second attempt with the same nonce+from", async () => {
      const cfg = mkConfig(mockFacFetch(true, true));
      const header = buildPaymentHeader(
        "tool-paid",
        toAtomicUsdc("0.01"),
        HMAC,
        TREASURY,
        NETWORK,
        NOW_SEC,
      );
      const v1 = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v1.kind).toBe("verified");
      if (v1.kind !== "verified") return;
      // Simulate the route having signed a receipt and called recordSettlement.
      const recCID = "sha256:" + "9".repeat(64);
      recordSettlement(v1.paymentPayload, recCID, cfg);

      // Second attempt with the same header should hit the cache.
      const v2 = await requirePayment(
        makeTool(),
        { ...ctx, paymentSignatureHeader: header },
        cfg,
      );
      expect(v2.kind).toBe("verified");
      if (v2.kind !== "verified") return;
      expect(v2.replayedCID).toBe(recCID);
    });
  });
});

describe("recordSettlement", () => {
  it("writes (nonce, from, cid) into the nonce cache", () => {
    const cache = new NonceCache();
    const cfg = mkConfig(mockFacFetch(true, true), { nonceCache: cache });
    const nonce = "0x" + "ee".repeat(32);
    const payload: X402PaymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: NETWORK,
        amount: "1000",
        asset: USDC,
        payTo: TREASURY,
        maxTimeoutSeconds: 300,
      },
      payload: {
        signature: "0xfe",
        authorization: {
          from: PAYER,
          to: TREASURY,
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce,
        },
      },
    };
    recordSettlement(payload, "sha256:" + "1".repeat(64), cfg);
    expect(cache.get(nonce, PAYER)?.receiptCID).toBe("sha256:" + "1".repeat(64));
  });
});
