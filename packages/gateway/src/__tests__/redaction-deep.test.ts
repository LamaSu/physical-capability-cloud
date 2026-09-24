/**
 * Unit tests for redactSecretsDeep / isSecretFieldName (WP-D D1): the structured
 * redaction the onboarding chat applies to tool results, the model request, the
 * stored history and every reply.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { english } from "viem/accounts";
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
      // WP-D R6: generic auth names and the session header/cookie
      "auth", "llm_auth", "basicAuth", "hmac", "webhookHmac", "X-PCC-Session", "pcc_session",
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

  it("many colliding redacted keys stay unique without quadratic renaming", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 20_000; i += 1) input[`pcc_live_${String(i).padStart(8, "0")}`] = i;
    const t0 = performance.now();
    const out = redactSecretsDeep(input);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(Object.keys(out)).toHaveLength(20_000);
    expect(JSON.stringify(out)).not.toContain("pcc_live_");
  });
});

// ── WP-D R1: every deep-scan shape is linear ─────────────────────────

describe("redactSecretsDeep runs in linear time (WP-D R1)", () => {
  const SIZE = 200 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  // The reviewer's probes (80 KB of '-eyJ' took 1.5 s in the old JWT regex) and the
  // same trick aimed at every other shape and context rule.
  const ADVERSARIAL: Record<string, string> = {
    "-eyJ": fill("-eyJ"),
    "-eyJaaaaaa.": fill("-eyJaaaaaa."),
    "_eyJ two segments": fill("_eyJabcdef.ghijkl."),
    "-sk-": fill("-sk-"),
    "short pcc keys": fill("pcc_live_abcde."),
    "63 hex + g": fill("a".repeat(63) + "g"),
    "PEM with no END": `-----BEGIN PRIVATE KEY-----${fill("-----END A")}`,
    "Bearer ": fill("Bearer "),
    "Basic ": fill("Basic YTpi "),
    "authorization: ": fill("authorization: "),
    "://userinfo": fill(`://${"a".repeat(50)}:`),
    "PKCS#8 head": fill("MC4CAQAwBQYDK2VwBCIEI+"),
    "JSON array of -eyJ": JSON.stringify(Array.from({ length: SIZE / 7 }, () => "-eyJ")),
  };

  it("redacts each 200 KB adversarial string in under 100 ms", () => {
    redactSecretsDeep(`warm up ${LIVE_KEY} Bearer ${JWT}`); // compile the regexes first
    for (const [name, input] of Object.entries(ADVERSARIAL)) {
      const t0 = performance.now();
      redactSecretsDeep(input);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${ms.toFixed(1)} ms`).toBeLessThan(100);
    }
  });

  it("still finds a real secret at the end of adversarial text", () => {
    const { out } = collect(`${fill("-eyJ")} ${LIVE_KEY} ${JWT}`);
    expect(out).not.toContain(LIVE_KEY);
    expect(out).not.toContain(JWT);
    expect(out.endsWith(`${REDACTED_VALUE} ${REDACTED_VALUE}`)).toBe(true);
  });

  it("a JWT after '-' or '_' is still caught, as the regex caught it", () => {
    for (const prefix of ["-", "_", "x_", ".", "="]) {
      const { out } = collect(`${prefix}${JWT} rest`);
      expect(out, prefix).toBe(`${prefix}${REDACTED_VALUE} rest`);
    }
  });
});

// ── WP-D R6: duplicate keys, plural and generic names, Basic, userinfo ─

describe("redactSecretsDeep closes the R6 gaps", () => {
  it("a duplicate key in embedded JSON cannot hide a secret from the scrub", () => {
    for (const text of [
      `{"k":"${LIVE_KEY}","k":"x"}`, // a key-shaped value hidden by a later duplicate
      `{"api_key":"opaque-secret-value","api_key":null}`, // an opaque secret hidden the same way
      `[{"note":"${LIVE_KEY}","note":"fine"}]`,
    ]) {
      for (const value of [text, { body: text }, [text]]) {
        const json = JSON.stringify(redactSecretsDeep(value));
        expect(json, text).not.toContain(LIVE_KEY);
        expect(json, text).not.toContain("opaque-secret-value");
      }
    }
  });

  it("an unchanged JSON string is still scrubbed for shapes the parse cannot see", () => {
    // A 64-digit JSON number is a float once parsed; the text still holds the digits.
    const text = `{"n":${"1".repeat(64)}}`;
    expect(redactSecretsDeep(text)).toBe(`{"n":${REDACTED_VALUE}}`);
  });

  it("plural secret names hold collections of secrets; a number under one is a count", () => {
    const uuid = "3f2b8c1e-9d4a-4b7e-a2c6-5e8f1d0b9a7c";
    const { out, json } = collect({
      api_keys: ["opaque-one"], tokens: [uuid], sessionTokens: [uuid], refresh_tokens: { a: uuid },
      maxTokens: 4096, input_tokens: 12, total_tokens: 30,
    });
    expect(json).not.toContain(uuid);
    expect(json).not.toContain("opaque-one");
    expect(out).toMatchObject({ maxTokens: 4096, input_tokens: 12, total_tokens: 30 });
  });

  it("generic auth, hmac, session and key names are secrets; parameter keys are not", () => {
    const uuid = "7a1c9e3b-2f4d-4c8a-b6e0-1d5f9a3c7e2b";
    const uuidKey = "0b5e2d7c-4a1f-4e9b-8c3d-6f2a1b0e9d8c";
    const b64 = "q8V3xZ2mR7tK9pL4wN6yB1cD5fG0hJ==";
    const hex = "9f".repeat(20);
    const { out, json } = collect({
      auth: uuid, hmac: b64, "X-PCC-Session": uuid, llm_auth: "Bearer opaque", key: b64,
      signing: { key: "short" }, wallet: { keys: ["abc"] }, hexKey: { key: hex }, items: [{ key: uuidKey }],
      params: [{ key: "gradient_duration_min" }, { key: "color" }], keys: { active: 2, wildcard_keys: 0 },
    });
    for (const secret of [uuid, uuidKey, b64, hex, "short", "abc", "opaque"]) expect(json, secret).not.toContain(secret);
    expect(out.params).toEqual([{ key: "gradient_duration_min" }, { key: "color" }]);
    expect(out.keys).toEqual({ active: 2, wildcard_keys: 0 });
  });

  it("scrubs a Basic credential, any Authorization value, and URL userinfo from text", () => {
    const basic = Buffer.from("operator:hunter2-password").toString("base64");
    const text = [
      `curl -H 'Authorization: Basic ${basic}' https://api.example.com`,
      `use Basic ${basic} to sign in`,
      "proxy-authorization=opaque-proxy-credential",
      "Authorization: Token 12ab34cd",
      "clone https://bob:hunter2@github.com/x.git or postgres://svc:p4ss@db:5432/app",
    ].join("\n");
    const { out, seen } = collect(text);
    for (const secret of [basic, "opaque-proxy-credential", "12ab34cd", "bob:hunter2", "svc:p4ss"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain(`Authorization: Basic ${REDACTED_VALUE}`);
    expect(out).toContain(`https://${REDACTED_VALUE}@github.com/x.git`);
    expect(seen.map((r) => r.value)).toEqual(expect.arrayContaining([basic, "bob:hunter2", "svc:p4ss"]));
  });

  it("leaves prose that merely mentions the scheme words alone", () => {
    const prose = "The Basic plan includes support. Bearer bonds are paper. The authorization header is missing.";
    expect(redactSecretsDeep(prose)).toBe(prose);
  });

  it("stays idempotent across the new rules", () => {
    const once = redactSecretsDeep({
      a: `Authorization: Basic ${Buffer.from("u:secret-pw").toString("base64")}`,
      b: "https://u:p@host/x", c: `{"k":"${LIVE_KEY}","k":"x"}`, tokens: ["t"],
    });
    const { out, seen } = collect(once);
    expect(out).toEqual(once);
    expect(seen).toHaveLength(0);
  });
});

describe("redactSecretsDeep closes the round-3 coverage gaps (WP-D round 4, L5)", () => {
  const leaks = (value: unknown, secret: string) => JSON.stringify(redactSecretsDeep(value)).includes(secret);

  it("parses BOM-prefixed JSON (the trimmed text), so a secret field inside it is removed", () => {
    const text = '﻿{"api_key":"opaque-bom-value"}';
    expect(leaks(text, "opaque-bom-value")).toBe(false);
    expect(leaks({ body: text }, "opaque-bom-value")).toBe(false);
  });

  it.each<[string, string, string]>([
    ["a secret-named URL query parameter (access_token)", "https://cb.test/return?access_token=opaqueQueryToken123&state=1", "opaqueQueryToken123"],
    ["a secret-named URL query parameter (api_key)", "GET /v1/items?api_key=opaqueApiKeyValue9&page=2", "opaqueApiKeyValue9"],
    ["a password=value pair", "login with password=hunter2-correct-horse please", "hunter2-correct-horse"],
    ["an X-Api-Key header line", "X-Api-Key: opaque-header-key-77\nAccept: */*", "opaque-header-key-77"],
    ["a Cookie header line", "Cookie: pcc_session=6f1c2a9e-8b3d-4c5e-9f7a-1b2c3d4e5f60; theme=dark", "6f1c2a9e-8b3d-4c5e-9f7a-1b2c3d4e5f60"],
    ["a secret-named JSON fragment inside prose", 'the config is {"api_key":"opaque in prose value"} and more', "opaque in prose value"],
  ])("removes %s", (_name, text, secret) => {
    expect(leaks(text, secret)).toBe(false);
    expect(leaks({ note: text }, secret)).toBe(false);
  });

  it("keeps what follows a redacted query parameter or header line", () => {
    expect(redactSecretsDeep("https://cb.test/return?access_token=opaqueQueryToken123&state=1")).toContain("&state=1");
    expect(redactSecretsDeep("X-Api-Key: opaque-header-key-77\nAccept: */*")).toContain("\nAccept: */*");
  });

  it("a string session / sessionId / sid is a secret; an object named session is walked, not erased", () => {
    const uuid = "6f1c2a9e-8b3d-4c5e-9f7a-1b2c3d4e5f60";
    for (const key of ["session", "sessionId", "sid"]) expect(leaks({ [key]: uuid }, uuid)).toBe(false);
    const info = { session: { address: "0x" + "12".repeat(20), expiresAt: "2026-09-25T00:00:00Z" } };
    expect(redactSecretsDeep(info)).toEqual(info);
  });

  it.each<[string, string]>([
    ["a GitHub fine-grained PAT", "github_pat_" + "A1b2C3d4E5".repeat(4)],
    ["a Google API key", "AIza" + "Sy0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 35)],
    ["an npm token", "npm_" + "a1B2c3D4e5".repeat(4).slice(0, 36)],
  ])("removes %s in plain text", (_name, token) => {
    expect(leaks(`see ${token} end`, token)).toBe(false);
  });

  it("removes a 12- or 24-word BIP-39 seed phrase; keeps 11 words, ordinary prose and a repeated word", () => {
    const words = english.slice(100, 124);
    const seed12 = words.slice(0, 12).join(" ");
    const seed24 = words.join(" ");
    expect(leaks(`zzqx ${seed12} zzqx`, seed12)).toBe(false);
    expect(leaks(`backup:\n${seed24}\n`, seed24)).toBe(false);
    const eleven = words.slice(0, 11).join(" ");
    expect(redactSecretsDeep(`zzqx ${eleven}.`)).toContain(eleven);
    const prose = "The operator ships the order today and the buyer confirms the delivery at the dock.";
    expect(redactSecretsDeep(prose)).toBe(prose);
    const repeated = "word ".repeat(40);
    expect(redactSecretsDeep(repeated)).toBe(repeated);
  });

  it("stays linear on adversarial label and word input", () => {
    for (const text of ["a=".repeat(200_000), "token:".repeat(100_000), "abandon ".repeat(100_000), '"password":"'.repeat(50_000)]) {
      const t0 = performance.now();
      redactSecretsDeep(text);
      expect(performance.now() - t0).toBeLessThan(1_500);
    }
  });

  it("is still idempotent: a second pass over the new detectors' output changes and reports nothing", () => {
    const once = redactSecretsDeep({
      note: 'X-Api-Key: abc123def456\n{"password":"p w d"} password=abc see github_pat_' + "x".repeat(30),
    });
    const seen: unknown[] = [];
    expect(redactSecretsDeep(once, (r) => seen.push(r))).toEqual(once);
    expect(seen).toHaveLength(0);
  });
});
