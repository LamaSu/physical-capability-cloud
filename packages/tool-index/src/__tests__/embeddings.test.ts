/**
 * Tests for OpenAIEmbeddingProvider error masking and the maskSecrets helper.
 *
 * Security context: OpenAI error responses sometimes echo back the inbound
 * request (including the Authorization: Bearer sk-… header). Without
 * masking, those bodies surface in thrown Error.message strings — which
 * frequently get logged to disk, shipped to Sentry, or piped to operator
 * dashboards. This suite locks down the masking contract.
 */
import { describe, expect, it, vi } from "vitest";

import {
  OpenAIEmbeddingProvider,
  maskSecrets,
} from "../embeddings.js";

const FAKE_KEY = "sk-test_1234567890abcdefghijklmnopqrstuv";
const OTHER_KEY = "sk-other_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: string;
}): Response {
  // Minimal Response shim — vitest runs on Node 20+ with native Response,
  // but constructing it through the global keeps us independent of fetch
  // polyfills in older toolchains.
  return new Response(opts.body ?? "", {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
  });
}

describe("maskSecrets", () => {
  it("masks the exact API key passed in", () => {
    const text = `oops: Authorization: Bearer ${FAKE_KEY}`;
    const masked = maskSecrets(text, FAKE_KEY);
    expect(masked).not.toContain(FAKE_KEY);
    expect(masked).toContain("sk-***REDACTED***");
  });

  it("masks any sk-* shaped token, not just the configured key", () => {
    const text = `multi tenant leak: ${OTHER_KEY}`;
    const masked = maskSecrets(text, FAKE_KEY);
    expect(masked).not.toContain(OTHER_KEY);
    expect(masked).toContain("sk-***REDACTED***");
  });

  it("masks Authorization headers regardless of token shape", () => {
    const text = `request echo: authorization: someopaquetoken123`;
    const masked = maskSecrets(text, FAKE_KEY);
    expect(masked.toLowerCase()).toContain("authorization");
    expect(masked).not.toContain("someopaquetoken123");
    expect(masked).toContain("***REDACTED***");
  });

  it("masks api_key, api-key, and apikey variants", () => {
    const variants = [
      `"api_key": "abcde12345"`,
      `"api-key": "abcde12345"`,
      `"apikey": "abcde12345"`,
      `api_key=abcde12345`,
    ];
    for (const v of variants) {
      const masked = maskSecrets(v, FAKE_KEY);
      expect(masked, `failed for variant: ${v}`).not.toContain("abcde12345");
      expect(masked).toContain("***REDACTED***");
    }
  });

  it("masks Bearer tokens in any position", () => {
    const variants = [
      "header: Authorization: Bearer foo.bar.baz",
      "leading Bearer xyz123 in body",
      "trailing... Bearer abc_def-ghi",
    ];
    for (const v of variants) {
      const masked = maskSecrets(v, FAKE_KEY);
      expect(masked, `failed for variant: ${v}`).not.toMatch(
        /Bearer\s+(foo\.bar\.baz|xyz123|abc_def-ghi)/,
      );
      expect(masked).toContain("Bearer ***REDACTED***");
    }
  });

  it("passes clean text through unchanged", () => {
    const clean = "rate limit exceeded for organization org_123";
    expect(maskSecrets(clean, FAKE_KEY)).toBe(clean);
  });

  it("handles empty string", () => {
    expect(maskSecrets("", FAKE_KEY)).toBe("");
  });

  it("handles missing/empty apiKey arg without crashing", () => {
    const text = `still mask sk-aaaaaaaaaaaaaaaaaaaaaaaa here`;
    const masked = maskSecrets(text, "");
    expect(masked).toContain("sk-***REDACTED***");
  });
});

describe("OpenAIEmbeddingProvider error masking", () => {
  it("401 response containing the API key — thrown message is redacted", async () => {
    const body = JSON.stringify({
      error: {
        message: `Invalid API key. The key you supplied (${FAKE_KEY}) is not valid.`,
        type: "invalid_request_error",
      },
    });
    const fetchImpl = vi.fn(async () =>
      makeResponse({ ok: false, status: 401, statusText: "Unauthorized", body }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    await expect(provider.embed(["hello"])).rejects.toThrow(
      /OpenAI embeddings failed: 401/,
    );
    try {
      await provider.embed(["hello"]);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(FAKE_KEY);
      expect(msg).toContain("sk-***REDACTED***");
    }
  });

  it("500 response containing Authorization: Bearer sk-xxx — masked", async () => {
    const body = `Internal Server Error\nReceived request with Authorization: Bearer ${FAKE_KEY}\n`;
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        body,
      }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    try {
      await provider.embed(["hello"]);
      throw new Error("expected embed() to reject");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(FAKE_KEY);
      expect(msg).toContain("Bearer ***REDACTED***");
    }
  });

  it("429 response containing JSON api_key field — masked", async () => {
    const body = JSON.stringify({
      error: {
        message: "rate_limit_exceeded",
        api_key: FAKE_KEY,
      },
    });
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body,
      }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    try {
      await provider.embed(["hello"]);
      throw new Error("expected embed() to reject");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(FAKE_KEY);
      // Either the exact-key match OR the sk-* generic OR the api_key field
      // pattern should have masked it. Just assert the secret is gone and
      // some redaction marker is present.
      expect(msg).toContain("***REDACTED***");
    }
  });

  it("clean error body without secrets passes through unchanged", async () => {
    const body = "Service temporarily unavailable, please retry";
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        body,
      }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    try {
      await provider.embed(["hello"]);
      throw new Error("expected embed() to reject");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("503");
      expect(msg).toContain(body);
      expect(msg).not.toContain("***REDACTED***");
    }
  });

  it("Bearer token in any position within error body is masked", async () => {
    const body = `prefix Bearer leakedtoken.part2.part3 suffix Bearer another_token-here end`;
    const fetchImpl = vi.fn(async () =>
      makeResponse({ ok: false, status: 400, statusText: "Bad Request", body }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    try {
      await provider.embed(["hello"]);
      throw new Error("expected embed() to reject");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("leakedtoken.part2.part3");
      expect(msg).not.toContain("another_token-here");
      // Should have at least two Bearer redactions.
      const matches = msg.match(/Bearer \*\*\*REDACTED\*\*\*/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("does not include this.apiKey in the thrown message when fetch text() fails", async () => {
    // Simulate a Response where .text() rejects — we still need to produce
    // a non-leaking error.
    const fakeRes = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => {
        throw new Error("body parse failed");
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => fakeRes) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider(FAKE_KEY, fetchImpl);
    try {
      await provider.embed(["hello"]);
      throw new Error("expected embed() to reject");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(FAKE_KEY);
      expect(msg).toContain("502");
    }
  });
});
