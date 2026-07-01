/**
 * Tests for the Option B passkey backend (Phase A).
 *
 * Covers the endpoint contract + rate limit + feature-flag gate. Real
 * cryptographic verification is exercised end-to-end in a follow-up E2E
 * test with a mock authenticator (deferred to Phase B PR when the frontend
 * lands). This suite locks in:
 *   - PCC_PASSKEY_ENABLED gate: 503 when unset
 *   - challenge endpoint returns sessionId + challenge (base64url 32B)
 *     + rpId + WebAuthn pubKeyCredParams shape
 *   - verify-attestation with a bogus attestation returns 400 (real
 *     verify fails; deferred stub mode is gone)
 *   - missing session returns 404
 *   - rate-limit: 30/hour per IP
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { passkeyRoutes, _resetPasskeyRateForTests } from "../routes/passkey.js";
import { initStore, closeStore } from "../db.js";

async function buildApp() {
  const app = Fastify();
  await app.register(passkeyRoutes);
  return app;
}

beforeAll(async () => {
  await initStore({ path: ":memory:" });
});

afterAll(async () => {
  await closeStore();
});

beforeEach(() => {
  _resetPasskeyRateForTests();
});

describe("PCC_PASSKEY_ENABLED gate", () => {
  it("returns 503 when the flag is not set", async () => {
    delete process.env.PCC_PASSKEY_ENABLED;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("passkey_not_enabled");
  });
});

describe("POST /api/onboard/passkey/register-challenge", () => {
  beforeEach(() => {
    process.env.PCC_PASSKEY_ENABLED = "true";
  });

  it("returns session + challenge + rpId + WebAuthn pubKeyCredParams", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof body.challenge).toBe("string");
    expect(body.challenge.length).toBeGreaterThanOrEqual(42);
    expect(typeof body.rpId).toBe("string");
    expect(body.ttl_ms).toBeGreaterThan(0);
    const algs = (body.pubKeyCredParams as Array<{ alg: number }>).map((p) => p.alg);
    expect(algs).toContain(-7);
    expect(algs).toContain(-257);
    expect(body.authenticatorSelection.userVerification).toBe("preferred");
  });

  it("honors explicit rpId in the body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: { rpId: "capability.network" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rpId).toBe("capability.network");
  });
});

describe("POST /api/onboard/passkey/verify-attestation", () => {
  beforeEach(() => {
    process.env.PCC_PASSKEY_ENABLED = "true";
  });

  it("400s when required fields are missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s when the sessionId is unknown", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: {
        sessionId: "0".repeat(32),
        attestationResponse: { id: "x", rawId: "x", response: {}, type: "public-key" } as any,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/session_not_found_or_expired/);
  });

  it("rejects a bogus attestation with 400 (real cryptographic verify)", async () => {
    const app = await buildApp();
    const challengeRes = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: {},
    });
    const { sessionId } = challengeRes.json();

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: {
        sessionId,
        attestationResponse: {
          id: "fake-id",
          rawId: "fake-id",
          response: {
            attestationObject: "not-a-real-attestation",
            clientDataJSON: "not-real-either",
          },
          type: "public-key",
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        } as any,
      },
    });
    // Real SimpleWebAuthn rejects garbage with 400.
    expect(verifyRes.statusCode).toBe(400);
    expect(verifyRes.json().error).toMatch(/webauthn_verify/);
  });
});

describe("rate limit", () => {
  beforeEach(() => {
    process.env.PCC_PASSKEY_ENABLED = "true";
  });

  it("hits 429 after 30 challenge requests from the same IP within an hour", async () => {
    const app = await buildApp();
    let lastStatus = 0;
    for (let i = 0; i < 32; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/onboard/passkey/register-challenge",
        payload: {},
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});
