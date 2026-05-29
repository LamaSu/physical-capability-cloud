/**
 * End-to-end test: signed agent card served at /.well-known/agent-card.json
 * verifies against the JWKS served at /.well-known/jwks.json.
 *
 * Covers the gateway integration of @pcc/a2a-signing:
 *   - Boot path: initSigningKey() pulls the env-configured PEM into memory.
 *   - Serve path: well-known.ts signs the card in-flight when a key is loaded.
 *   - Verify path: jwks.json route serves the public key with matching kid.
 *
 * When PCC_AGENT_CARD_SIGNING_KEY is unset, the legacy unsigned shape is
 * served (backwards compat).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generateKeyPair, exportPKCS8 } from "jose";
import { wellKnownRoutes } from "../routes/well-known.js";
import { jwksRoutes } from "../routes/jwks.js";
import { initSigningKey, _resetForTests } from "../signing-key.js";
import { initStore, closeStore } from "../db.js";
import { verifyAgentCard } from "@pcc/a2a-signing";

const ENV_KEY = "PCC_AGENT_CARD_SIGNING_KEY";
const ENV_KID = "PCC_AGENT_CARD_SIGNING_KID";

async function buildAppWithSigning(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_GATEWAY_URL = "https://test.capability.network";
  initStore({ seed: false });

  // Generate a fresh ES256 PKCS#8 key for this test run
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env[ENV_KEY] = await exportPKCS8(privateKey);
  process.env[ENV_KID] = "test-kid-signed";

  _resetForTests();
  await initSigningKey();

  const app = Fastify({ logger: false });
  await app.register(wellKnownRoutes);
  await app.register(jwksRoutes);
  await app.ready();
  return app;
}

async function buildAppWithoutSigning(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_GATEWAY_URL = "https://test.capability.network";
  delete process.env[ENV_KEY];
  delete process.env[ENV_KID];
  initStore({ seed: false });

  _resetForTests();
  await initSigningKey();

  const app = Fastify({ logger: false });
  await app.register(wellKnownRoutes);
  await app.register(jwksRoutes);
  await app.ready();
  return app;
}

function cleanupEnv(originalKey: string | undefined, originalKid: string | undefined) {
  if (originalKey !== undefined) process.env[ENV_KEY] = originalKey;
  else delete process.env[ENV_KEY];
  if (originalKid !== undefined) process.env[ENV_KID] = originalKid;
  else delete process.env[ENV_KID];
}

describe("Signed Agent Card — end-to-end roundtrip", () => {
  let app: FastifyInstance;
  const originalKey = process.env[ENV_KEY];
  const originalKid = process.env[ENV_KID];

  beforeAll(async () => {
    app = await buildAppWithSigning();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    cleanupEnv(originalKey, originalKid);
  });

  it("/.well-known/agent-card.json includes signatures array when signing enabled", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signatures).toBeDefined();
    expect(Array.isArray(body.signatures)).toBe(true);
    expect(body.signatures.length).toBe(1);
    expect(typeof body.signatures[0].protected).toBe("string");
    expect(typeof body.signatures[0].signature).toBe("string");
  });

  it("/.well-known/agent-card.json preserves original card fields alongside signatures", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });
    const body = res.json();
    expect(body.protocolVersion).toBe("1.0");
    expect(body.name).toBeDefined();
    expect(body.skills).toBeDefined();
  });

  it("/.well-known/jwks.json serves the active public key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/jwk-set+json");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("public, max-age=300");

    const body = res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBe(1);
    expect(body.keys[0].kid).toBe("test-kid-signed");
    expect(body.keys[0].kty).toBe("EC");
    expect(body.keys[0].crv).toBe("P-256");
    expect(body.keys[0].use).toBe("sig");
    expect(body.keys[0].alg).toBe("ES256");
    // No private component leaked
    expect(body.keys[0].d).toBeUndefined();
  });

  it("ROUNDTRIP: signed card + JWKS-fetched key verify correctly", async () => {
    const cardRes = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });
    const signedCard = cardRes.json();

    const jwksRes = await app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    const jwks = jwksRes.json();

    const result = await verifyAgentCard(signedCard, { jwks });
    expect(result.valid).toBe(true);
    expect(result.kid).toBe("test-kid-signed");
    expect(result.card?.protocolVersion).toBe("1.0");
  });

  it("ROUNDTRIP detects tampering: flipped field fails verification", async () => {
    const cardRes = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });
    const signedCard = cardRes.json();

    const jwksRes = await app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    const jwks = jwksRes.json();

    // Tamper: change `name` after signing
    const tampered = { ...signedCard, name: "Evil Gateway" };

    const result = await verifyAgentCard(tampered, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/verify_failed/);
  });

  it("per-kernel card endpoint structure unaffected by signing (kernel not seeded)", async () => {
    // We don't seed a kernel in this test app, so we expect a 404 — the
    // important thing is the route isn't broken by the signing wiring.
    const res = await app.inject({
      method: "GET",
      url: "/api/kernels/does-not-exist/agent-card.json",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Signed Agent Card — backwards compat (no signing key)", () => {
  let app: FastifyInstance;
  const originalKey = process.env[ENV_KEY];
  const originalKid = process.env[ENV_KID];

  beforeAll(async () => {
    app = await buildAppWithoutSigning();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    cleanupEnv(originalKey, originalKid);
  });

  it("serves an UNSIGNED card when PCC_AGENT_CARD_SIGNING_KEY is unset", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // No signatures key at all — unsigned, legacy shape preserved
    expect(body.signatures).toBeUndefined();
    expect(body.protocolVersion).toBe("1.0");
  });

  it("/.well-known/jwks.json returns an empty JWKS when no key is configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toEqual([]);
  });
});
