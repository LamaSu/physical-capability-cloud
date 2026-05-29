import { describe, it, expect } from "vitest";
import {
  verifyWithFacilitator,
  settleWithFacilitator,
  FacilitatorNetworkError,
  type X402FacilitatorConfig,
} from "../x402-facilitator.js";
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
} from "@pcc/spec";

function makePayload(): X402PaymentPayload {
  const requirements: X402PaymentRequirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 300,
  };
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x1111111111111111111111111111111111111111",
        value: "1000",
        validAfter: "1700000000",
        validBefore: "1700000300",
        nonce: "0x" + "cd".repeat(32),
      },
    },
  };
  return payload;
}

function makeRequirements(
  override?: Partial<X402PaymentRequirements>,
): X402PaymentRequirements {
  return { ...makePayload().accepted, ...(override ?? {}) };
}

/**
 * Construct a fetch impl that returns a fixed status+body for the next call,
 * and records every request it sees so tests can assert on URL / body.
 */
function mockFetch(
  responder: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init });
    const r = await responder(url, init);
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fakeFetch, calls };
}

const baseConfig = (
  fetchImpl: typeof fetch,
  extra: Partial<X402FacilitatorConfig> = {},
): X402FacilitatorConfig => ({
  url: "https://example.test/facilitator",
  fetchImpl,
  verifyTimeoutMs: 200,
  settleTimeoutMs: 200,
  ...extra,
});

describe("verifyWithFacilitator", () => {
  it("returns isValid:true on a 200 happy path", async () => {
    const mf = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        isValid: true,
        payer: "0x2222222222222222222222222222222222222222",
      }),
    }));
    const result = await verifyWithFacilitator(
      baseConfig(mf.fetch),
      makePayload(),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0x2222222222222222222222222222222222222222");
    expect(mf.calls[0]?.url).toBe("https://example.test/facilitator/verify");
    expect(mf.calls[0]?.init?.method).toBe("POST");
  });

  it("returns isValid:false on a 412 with invalidReason", async () => {
    const mf = mockFetch(() => ({
      status: 412,
      body: JSON.stringify({
        isValid: false,
        invalidReason: "INSUFFICIENT_FUNDS",
      }),
    }));
    const result = await verifyWithFacilitator(
      baseConfig(mf.fetch),
      makePayload(),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("INSUFFICIENT_FUNDS");
  });

  it("throws FacilitatorNetworkError on a 500", async () => {
    const mf = mockFetch(() => ({
      status: 500,
      body: "Internal Server Error",
    }));
    await expect(
      verifyWithFacilitator(
        baseConfig(mf.fetch),
        makePayload(),
        makeRequirements(),
      ),
    ).rejects.toThrow(FacilitatorNetworkError);
  });

  it("throws FacilitatorNetworkError on an unparseable body", async () => {
    const mf = mockFetch(() => ({ status: 200, body: "not-json" }));
    await expect(
      verifyWithFacilitator(
        baseConfig(mf.fetch),
        makePayload(),
        makeRequirements(),
      ),
    ).rejects.toThrow(/unparseable/);
  });

  it("throws timeout kind when the request takes too long", async () => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    try {
      await verifyWithFacilitator(
        baseConfig(slowFetch, { verifyTimeoutMs: 10 }),
        makePayload(),
        makeRequirements(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FacilitatorNetworkError);
      expect((err as FacilitatorNetworkError).kind).toBe("timeout");
    }
  });

  it("includes CDP API headers when credentials configured", async () => {
    const mf = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ isValid: true }),
    }));
    await verifyWithFacilitator(
      baseConfig(mf.fetch, {
        cdpApiKeyId: "key-abc",
        cdpApiKeySecret: "secret-xyz",
      }),
      makePayload(),
      makeRequirements(),
    );
    const headers = mf.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-cdp-api-key-id"]).toBe("key-abc");
    expect(headers["x-cdp-api-key-secret"]).toBe("secret-xyz");
  });
});

describe("settleWithFacilitator", () => {
  it("returns success:true + transaction hash on 200", async () => {
    const mf = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        success: true,
        transaction: "0x" + "ab".repeat(32),
        network: "eip155:84532",
        payer: "0x2222222222222222222222222222222222222222",
      }),
    }));
    const result = await settleWithFacilitator(
      baseConfig(mf.fetch),
      makePayload(),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.network).toBe("eip155:84532");
    expect(mf.calls[0]?.url).toBe("https://example.test/facilitator/settle");
  });

  it("returns success:false + errorReason for a 4xx with typed body", async () => {
    const mf = mockFetch(() => ({
      status: 400,
      body: JSON.stringify({
        success: false,
        errorReason: "NONCE_USED",
        transaction: "0x" + "0".repeat(64),
        network: "eip155:84532",
      }),
    }));
    const result = await settleWithFacilitator(
      baseConfig(mf.fetch),
      makePayload(),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("NONCE_USED");
  });

  it("throws FacilitatorNetworkError on 500", async () => {
    const mf = mockFetch(() => ({ status: 500, body: "boom" }));
    await expect(
      settleWithFacilitator(
        baseConfig(mf.fetch),
        makePayload(),
        makeRequirements(),
      ),
    ).rejects.toThrow(FacilitatorNetworkError);
  });

  it("throws on unparseable 200 body", async () => {
    const mf = mockFetch(() => ({ status: 200, body: "not-json" }));
    await expect(
      settleWithFacilitator(
        baseConfig(mf.fetch),
        makePayload(),
        makeRequirements(),
      ),
    ).rejects.toThrow(/unparseable/);
  });

  it("throws timeout kind for slow settle", async () => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    try {
      await settleWithFacilitator(
        baseConfig(slowFetch, { settleTimeoutMs: 10 }),
        makePayload(),
        makeRequirements(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FacilitatorNetworkError);
      expect((err as FacilitatorNetworkError).kind).toBe("timeout");
    }
  });
});
