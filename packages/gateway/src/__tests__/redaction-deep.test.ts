/**
 * Unit tests for redactSecretsDeep / isSecretFieldName (WP-D D1): the structured
 * redaction the onboarding chat applies to tool results, the model request, the
 * stored history and every reply.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  redactSecretsDeep,
  isSecretFieldName,
  REDACTED_VALUE,
  SPEC_SECRET_FIELD_RE,
  type Redaction,
} from "../redaction.js";

const LIVE_KEY = "pcc_live_" + "Q7xR2m".repeat(6) + "_k9";
const TEST_KEY = "pcc_test_" + "z9".repeat(12);
const PRIVATE_KEY = "0x" + "ab12cd34".repeat(8);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const PUBLIC_ADDRESS = "0x" + "1234abcd".repeat(5);
const ED25519_PKCS8 = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFakeFakeFakeFake\n-----END PRIVATE KEY-----";

const collect = <T>(value: T) => {
  const seen: Redaction[] = [];
  const out = redactSecretsDeep(value, (r) => seen.push(r));
  return { out, seen, json: JSON.stringify(out) };
};

describe("isSecretFieldName", () => {
  it("matches every name in the WP-D D1 list, in any case", () => {
    const specNames = [
      "api_key", "apikey", "apiKey", "API_KEY", "raw_key", "rawkey", "private_key", "privatekey", "privateKey",
      "secret", "client_secret", "clientSecret", "access_token", "accessToken", "refresh_token", "id_token",
      "token", "TOKEN", "password", "passphrase", "mnemonic", "seed", "authorization", "Authorization", "cookie",
    ];
    for (const name of specNames) {
      expect(SPEC_SECRET_FIELD_RE.test(name), name).toBe(true);
      expect(isSecretFieldName(name), name).toBe(true);
    }
  });

  it("also catches compound secret names the provision route and HTTP bodies use", () => {
    for (const name of [
      "private_key_pkcs8_base64", // /api/auth/provision ed25519 block
      "operatorWalletPrivateKey", "webhookSecret", "webhook_secret", "secretAccessKey", "stripe_secret_key",
      "x-api-key", "set-cookie", "sessionToken", "x-admin-token", "signingKey", "passwordHash", "seed_phrase",
      "credentials", "jwt",
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
  });

  it("leaves public and identifier names alone", () => {
    for (const name of [
      "publicKey", "public_key", "apiKeyId", "key_id", "keyPrefix", "idempotencyKey", "maxTokens", "tokenType",
      "tokenId", "authorizationUrl", "cookieConsent", "wallet", "address", "signature",
    ]) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });
});

describe("redactSecretsDeep", () => {
  it("redacts a nested secret field and a string-embedded Bearer JWT (WP-D negative test)", () => {
    const { out, seen, json } = collect({ a: { b: { privateKey: PRIVATE_KEY } }, note: `call it with Bearer ${JWT} please` });
    expect(out.a.b.privateKey).toBe(REDACTED_VALUE);
    expect(out.note).toBe(`call it with Bearer ${REDACTED_VALUE} please`);
    expect(json).not.toContain(PRIVATE_KEY);
    expect(json).not.toContain(JWT);
    expect(seen).toEqual(
      expect.arrayContaining([
        { path: "$.a.b.privateKey", kind: "secret-field", value: PRIVATE_KEY },
        { path: "$.note", kind: "secret-shaped", value: JWT }, // reported without the "Bearer " scheme
      ]),
    );
  });

  it("replaces every credential shape in free text with [REDACTED]", () => {
    const text = [
      `live ${LIVE_KEY}`, `test ${TEST_KEY}`, `pk ${PRIVATE_KEY}`, `jwt ${JWT}`, `pkcs8 ${ED25519_PKCS8}`,
      `pem ${PEM}`, `stripe sk_live_${"a1".repeat(12)}`, `hook whsec_${"b2".repeat(12)}`,
    ].join(" | ");
    const { out, seen } = collect(text);
    for (const secret of [LIVE_KEY, TEST_KEY, PRIVATE_KEY, JWT, ED25519_PKCS8, "MC4CAQAwBQYDK2VwBCIEIFake", "a1a1a1a1", "b2b2b2b2"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(`live ${REDACTED_VALUE}`);
    expect(seen.map((r) => r.value)).toEqual(expect.arrayContaining([LIVE_KEY, TEST_KEY, PRIVATE_KEY, JWT, ED25519_PKCS8]));
  });

  it("redacts the whole secret-named value, whatever its shape", () => {
    const { out, json } = collect({
      api_key: "opaque-value-without-any-known-shape",
      authorization: { scheme: "bearer", value: "opaque" },
      ed25519: { public_key: "short", private_key_pkcs8_base64: "not-even-base64" },
    });
    expect(out.api_key).toBe(REDACTED_VALUE);
    expect(out.authorization).toBe(REDACTED_VALUE);
    expect(out.ed25519.private_key_pkcs8_base64).toBe(REDACTED_VALUE);
    expect(out.ed25519.public_key).toBe("short");
    expect(json).not.toContain("opaque");
    expect(json).not.toContain("not-even-base64");
  });

  it("walks JSON serialized inside a string, so a secret-named field there is caught", () => {
    const { out, seen } = collect({ content: JSON.stringify({ webhook_secret: "opaque-hook-secret", ok: true }) });
    expect(out.content).not.toContain("opaque-hook-secret");
    expect(JSON.parse(out.content)).toEqual({ webhook_secret: REDACTED_VALUE, ok: true });
    expect(seen[0]).toMatchObject({ path: "$.content<json>.webhook_secret", value: "opaque-hook-secret" });
  });

  it("redacts a secret used as an object key, keeping keys unique", () => {
    const { out, json } = collect({ [LIVE_KEY]: 1, [TEST_KEY]: 2 });
    expect(json).not.toContain(LIVE_KEY);
    expect(json).not.toContain(TEST_KEY);
    expect(Object.values(out).sort()).toEqual([1, 2]);
  });

  it("leaves public values and empty secret slots alone and never mutates its input", () => {
    const input = {
      wallet: PUBLIC_ADDRESS, publicKey: "0x" + "aa".repeat(20), idempotencyKey: "abc-123",
      hasApiKey: false, token: null, password: "", note: "0xdeadbeef is short hex",
    };
    const copy = JSON.parse(JSON.stringify(input));
    const { out, seen } = collect(input);
    expect(input).toEqual(copy);
    expect(out).toEqual(copy);
    expect(seen).toHaveLength(0);
  });

  it("is idempotent: a second pass changes nothing and reports nothing", () => {
    const once = redactSecretsDeep({
      api_key: LIVE_KEY, note: `Bearer ${JWT}`, body: JSON.stringify({ secret: "s3cr3t-value" }), [TEST_KEY]: true,
    });
    const { out, seen } = collect(once);
    expect(out).toEqual(once);
    expect(seen).toHaveLength(0);
  });

  it("fails closed on a cycle and on excessive depth", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    expect((redactSecretsDeep(a) as Record<string, unknown>).self).toBe(REDACTED_VALUE);

    let deep: Record<string, unknown> = { note: LIVE_KEY };
    for (let i = 0; i < 100; i += 1) deep = { next: deep };
    const json = JSON.stringify(redactSecretsDeep(deep));
    expect(json).not.toContain(LIVE_KEY);
    expect(json).toContain(REDACTED_VALUE);
  });

  it("a __proto__ key from JSON.parse stays an own, redacted property and pollutes nothing", () => {
    const parsed = JSON.parse(`{"__proto__":{"api_key":"${LIVE_KEY}"},"b":1}`);
    const out = redactSecretsDeep(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe(`{"__proto__":{"api_key":"${REDACTED_VALUE}"},"b":1}`);
    expect(({} as Record<string, unknown>).api_key).toBeUndefined();
  });
});
