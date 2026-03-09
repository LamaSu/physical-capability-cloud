import { describe, it, expect } from "vitest";
import { X402Middleware, type X402Config, type RoutePaymentMap } from "../x402-middleware.js";

const config: X402Config = {
  facilitatorUrl: "http://localhost:4020",
  network: "eip155:84532",
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  treasuryAddress: "0x0000000000000000000000000000000000000001",
};

const routes: RoutePaymentMap = {
  "POST /api/quote": {
    price: "$0.01",
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0x0000000000000000000000000000000000000001",
    description: "Quote a workflow",
  },
  "GET /api/search": {
    price: "$0.50",
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0x0000000000000000000000000000000000000001",
    description: "Search capabilities",
  },
};

describe("X402Middleware", () => {
  const mw = new X402Middleware(config, routes);

  describe("checkPayment", () => {
    it("returns requiresPayment=true for protected route without payment", () => {
      const result = mw.checkPayment("POST", "/api/quote");
      expect(result.requiresPayment).toBe(true);
      if (result.requiresPayment) {
        expect(result.payload.x402Version).toBe(2);
        expect(result.payload.resource.url).toBe("/api/quote");
        expect(result.payload.accepts).toHaveLength(1);
        expect(result.payload.accepts[0].amount).toBe("10000"); // $0.01 * 1e6
        expect(result.payload.accepts[0].network).toBe("eip155:84532");
      }
    });

    it("returns requiresPayment=false for free route", () => {
      const result = mw.checkPayment("GET", "/api/health");
      expect(result.requiresPayment).toBe(false);
    });

    it("returns requiresPayment=false when payment header provided", () => {
      const result = mw.checkPayment("POST", "/api/quote", "some-payment-data");
      expect(result.requiresPayment).toBe(false);
    });

    it("parses price correctly for $0.50", () => {
      const result = mw.checkPayment("GET", "/api/search");
      expect(result.requiresPayment).toBe(true);
      if (result.requiresPayment) {
        expect(result.payload.accepts[0].amount).toBe("500000");
      }
    });
  });

  describe("encodeHeader / decodePaymentSignature", () => {
    it("round-trips PaymentRequired through base64", () => {
      const result = mw.checkPayment("POST", "/api/quote");
      if (!result.requiresPayment) throw new Error("Expected requiresPayment");

      const encoded = mw.encodeHeader(result.payload);
      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);

      // Decode it back
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.resource.url).toBe("/api/quote");
    });
  });

  describe("verifyPayment", () => {
    it("mock always returns valid", async () => {
      const mockPayload = {
        x402Version: 2 as const,
        resource: { url: "/api/quote", description: "test" },
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
        },
        payload: {
          signature: "0xmocksig",
          authorization: {
            from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
            to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
            value: "10000",
            validAfter: "0",
            validBefore: "99999999999",
            nonce: "0x1234",
          },
        },
      };
      const result = await mw.verifyPayment(mockPayload);
      expect(result.valid).toBe(true);
      expect(result.payer).toBe(mockPayload.payload.authorization.from);
    });
  });

  describe("settlePayment", () => {
    it("mock always returns success", async () => {
      const mockPayload = {
        x402Version: 2 as const,
        resource: { url: "/api/quote", description: "test" },
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
        },
        payload: {
          signature: "0xmocksig",
          authorization: {
            from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
            to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
            value: "10000",
            validAfter: "0",
            validBefore: "99999999999",
            nonce: "0x1234",
          },
        },
      };
      const result = await mw.settlePayment(mockPayload);
      expect(result.success).toBe(true);
      expect(result.network).toBe("eip155:84532");
    });
  });
});
