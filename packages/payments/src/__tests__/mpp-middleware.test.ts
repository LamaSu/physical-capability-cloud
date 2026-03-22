import { describe, it, expect } from "vitest";
import { MppMiddleware } from "../mpp-middleware.js";
import type { MppRouteMap } from "../mpp-middleware.js";

const TEST_SECRET_KEY = "test-secret-key-for-hmac-challenges";
const TEST_RECIPIENT = "0x0000000000000000000000000000000000000001" as const;
const TEST_CURRENCY = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const routes: MppRouteMap = {
  "POST /api/quote": {
    amount: "10000", // $0.01 in USDC atomic units
    description: "Quote a workflow",
  },
  "GET /api/search": {
    amount: "500000", // $0.50
    description: "Search capabilities",
  },
};

describe("MppMiddleware", () => {
  const mw = new MppMiddleware({
    secretKey: TEST_SECRET_KEY,
    recipient: TEST_RECIPIENT,
    currency: TEST_CURRENCY,
    testnet: true,
    routes,
  });

  describe("getRouteHandler", () => {
    it("returns isProtected=true for protected route", () => {
      const result = mw.getRouteHandler("POST", "/api/quote");
      expect(result.isProtected).toBe(true);
      if (result.isProtected) {
        expect(result.routeConfig.amount).toBe("10000");
        expect(result.routeConfig.description).toBe("Quote a workflow");
      }
    });

    it("returns isProtected=false for free route", () => {
      const result = mw.getRouteHandler("GET", "/api/health");
      expect(result.isProtected).toBe(false);
    });

    it("is case-insensitive on method", () => {
      const result = mw.getRouteHandler("post", "/api/quote");
      expect(result.isProtected).toBe(true);
    });
  });

  describe("createChargeHandler", () => {
    it("returns a function", () => {
      const handler = mw.createChargeHandler(routes["POST /api/quote"]);
      expect(typeof handler).toBe("function");
    });
  });

  describe("getProtectedRoutes", () => {
    it("lists all protected routes", () => {
      const list = mw.getProtectedRoutes();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        method: "POST",
        path: "/api/quote",
        amount: "10000",
        description: "Quote a workflow",
      });
      expect(list[1]).toMatchObject({
        method: "GET",
        path: "/api/search",
        amount: "500000",
      });
    });
  });

  describe("parsePrice", () => {
    it("converts $0.01 to 10000", () => {
      expect(MppMiddleware.parsePrice("$0.01")).toBe("10000");
    });

    it("converts $0.50 to 500000", () => {
      expect(MppMiddleware.parsePrice("$0.50")).toBe("500000");
    });

    it("converts 1 to 1000000", () => {
      expect(MppMiddleware.parsePrice("1")).toBe("1000000");
    });

    it("returns 0 for invalid input", () => {
      expect(MppMiddleware.parsePrice("invalid")).toBe("0");
    });

    it("converts $0.001 to 1000", () => {
      expect(MppMiddleware.parsePrice("$0.001")).toBe("1000");
    });
  });

  describe("getMppx / realm", () => {
    it("exposes the underlying mppx instance", () => {
      const mppx = mw.getMppx();
      expect(mppx).toBeDefined();
    });

    it("exposes realm via getter", () => {
      expect(mw.realm).toBeDefined();
      expect(typeof mw.realm).toBe("string");
    });
  });
});
