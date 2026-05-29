/**
 * Tests for env-driven key loading and JWKS generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import {
  loadSigningKey,
  generateJWKS,
  DEFAULT_KID,
  DEFAULT_ALG,
} from "../key-management.js";

const ENV_KEY = "PCC_AGENT_CARD_SIGNING_KEY";
const ENV_KID = "PCC_AGENT_CARD_SIGNING_KID";

async function makePkcs8Pem(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return exportPKCS8(privateKey);
}

describe("loadSigningKey", () => {
  const originalKey = process.env[ENV_KEY];
  const originalKid = process.env[ENV_KID];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    delete process.env[ENV_KID];
  });

  afterEach(() => {
    if (originalKey !== undefined) process.env[ENV_KEY] = originalKey;
    else delete process.env[ENV_KEY];
    if (originalKid !== undefined) process.env[ENV_KID] = originalKid;
    else delete process.env[ENV_KID];
  });

  it("returns null when env var is unset", async () => {
    const result = await loadSigningKey();
    expect(result).toBeNull();
  });

  it("returns null when env var is empty string", async () => {
    process.env[ENV_KEY] = "";
    const result = await loadSigningKey();
    expect(result).toBeNull();
  });

  it("returns null when env var is whitespace only", async () => {
    process.env[ENV_KEY] = "   \n  ";
    const result = await loadSigningKey();
    expect(result).toBeNull();
  });

  it("loads a valid PKCS#8 PEM and uses DEFAULT_KID when no kid env", async () => {
    process.env[ENV_KEY] = await makePkcs8Pem();
    const result = await loadSigningKey();
    expect(result).not.toBeNull();
    expect(result!.kid).toBe(DEFAULT_KID);
    expect(result!.alg).toBe(DEFAULT_ALG);
    expect(result!.privateKey).toBeDefined();
    expect(result!.publicKey).toBeDefined();
  });

  it("respects PCC_AGENT_CARD_SIGNING_KID override", async () => {
    process.env[ENV_KEY] = await makePkcs8Pem();
    process.env[ENV_KID] = "custom-kid-2026-q3";
    const result = await loadSigningKey();
    expect(result!.kid).toBe("custom-kid-2026-q3");
  });

  it("handles env vars with escaped newlines (Docker/Railway style)", async () => {
    const pem = await makePkcs8Pem();
    process.env[ENV_KEY] = pem.replace(/\n/g, "\\n");
    const result = await loadSigningKey();
    expect(result).not.toBeNull();
  });

  it("throws a clear error on SEC1-formatted PEM", async () => {
    // Synthetic SEC1 PEM — we don't need to generate a real one, just
    // trip the SEC1 detection branch with the marker string.
    process.env[ENV_KEY] =
      "-----BEGIN EC PRIVATE KEY-----\n" +
      "MHQCAQEEINOTNOTNOTNOTaREALkey==\n" +
      "-----END EC PRIVATE KEY-----\n";
    await expect(loadSigningKey()).rejects.toThrow(/SEC1.*PKCS#8/);
  });

  it("throws on malformed PEM that isn't recognizable", async () => {
    process.env[ENV_KEY] = "definitely not a pem";
    await expect(loadSigningKey()).rejects.toThrow(/PKCS#8|import/);
  });
});

describe("generateJWKS", () => {
  it("returns a JWKS document with one key when given a single public key", async () => {
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwks = await generateJWKS(publicKey, "k1");
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.kid).toBe("k1");
    expect(jwks.keys[0]!.use).toBe("sig");
    expect(jwks.keys[0]!.alg).toBe(DEFAULT_ALG);
    expect(jwks.keys[0]!.kty).toBe("EC");
    expect(jwks.keys[0]!.crv).toBe("P-256");
    // No private component
    expect(jwks.keys[0]!.d).toBeUndefined();
  });

  it("preserves x and y coordinates from the source key", async () => {
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    const sourceJwk = await exportJWK(publicKey);
    const jwks = await generateJWKS(publicKey, "k1");
    expect(jwks.keys[0]!.x).toBe(sourceJwk.x);
    expect(jwks.keys[0]!.y).toBe(sourceJwk.y);
  });
});
