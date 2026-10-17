/**
 * FC-8 (astra pack 61, CRITICAL): a value must be safe to LOG. The e2e scripts
 * printed raw gateway responses, leaking a Lit usageKey, a provisioned api_key,
 * and reflected x-oracle-key headers. safeLogJson redacts by key name (so a
 * secret with no recognizable value shape is still dropped) and by value shape.
 */
import { describe, it, expect } from "vitest";
import { redactLogValue, safeLogJson, isSensitiveLogKey } from "../util/redact-log.js";

describe("redact-log (FC-8)", () => {
  it("[neg] drops a Lit usageKey whose value has NO recognizable secret shape", () => {
    const out = safeLogJson({ status: "ok", usageKey: "lit_secret_123" });
    expect(out).not.toContain("lit_secret_123");
    expect(out).toContain("[redacted]");
  });

  it("[neg] drops api_key / apiKey / private_key / oracleKey / authorization regardless of value", () => {
    const out = safeLogJson({
      api_key: "pcc_live_whatever",
      apiKey: "ABC",
      private_key_pkcs8_base64: "MC4CAQ...",
      oracleKey: "ok_123",
      authorization: "Bearer xyz",
      nested: { sessionKey: "s", token: "t" },
    });
    for (const leak of ["pcc_live_whatever", "\"ABC\"", "MC4CAQ", "ok_123", "Bearer xyz", "\"s\"", "\"t\""]) {
      expect(out, leak).not.toContain(leak);
    }
  });

  it("keeps non-sensitive fields intact", () => {
    const out = safeLogJson({ kernelId: "kernel-1", status: "online", count: 3, ok: true });
    expect(out).toContain("kernel-1");
    expect(out).toContain("online");
    expect(out).toContain("3");
  });

  it("[neg] a secret-SHAPED string under an innocuous key is still caught by the shape layer", () => {
    const out = safeLogJson({ note: "here is sk-abcdefghijklmnopqrstuvwx and more" });
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("isSensitiveLogKey matches the credential families and spares ordinary ids", () => {
    for (const k of ["key", "api_key", "apiKey", "usageKey", "x-oracle-key", "private_key", "privateKey", "secret", "clientSecret", "authorization", "sessionKey", "mnemonic", "seedPhrase", "password", "csrfToken", "downloadKey", "webhookToken"]) {
      expect(isSensitiveLogKey(k), k).toBe(true);
    }
    for (const k of ["kernelId", "status", "count", "operatorAddress", "escrowAddress", "jobId", "email"]) {
      expect(isSensitiveLogKey(k), k).toBe(false);
    }
  });

  it("caps arrays and depth, and never throws on a cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => safeLogJson(cyclic)).not.toThrow();
    const big = safeLogJson({ xs: Array.from({ length: 250 }, (_, i) => i) });
    expect(big).toContain("more]");
  });

  it("redactLogValue leaves primitives alone", () => {
    expect(redactLogValue(5)).toBe(5);
    expect(redactLogValue(true)).toBe(true);
    expect(redactLogValue(null)).toBe(null);
  });
});
