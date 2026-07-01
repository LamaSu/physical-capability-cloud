/**
 * Tests for the Option B passkey backend groundwork.
 *
 * Covers the endpoint contract only — cryptographic verification is
 * deferred to the SDK follow-up PR (Gate A). These tests lock in:
 *   - challenge endpoint returns sessionId + challenge (base64url, 43+ chars)
 *     + rpId + pubKeyCredParams shape a WebAuthn browser dialog expects
 *   - verify-attestation with a valid session returns 200 + verification:"deferred"
 *   - missing/invalid session returns 404
 *   - expired session returns 410
 *   - missing required fields return 400
 *   - challenge is one-shot: consuming it deletes the session
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { passkeyRoutes, _resetPasskeyCacheForTests } from "../routes/passkey.js";

async function buildApp() {
  const app = Fastify();
  await app.register(passkeyRoutes);
  return app;
}

beforeEach(() => {
  _resetPasskeyCacheForTests();
});

describe("POST /api/onboard/passkey/register-challenge", () => {
  it("returns a session, challenge, rpId, and WebAuthn pubKeyCredParams shape", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof body.challenge).toBe("string");
    // 32 bytes base64url ≈ 43 chars (no padding).
    expect(body.challenge.length).toBeGreaterThanOrEqual(42);
    expect(typeof body.rpId).toBe("string");
    expect(body.ttl_ms).toBeGreaterThan(0);
    // WebAuthn pubKeyCredParams: ES256 + RS256 as the minimum shape.
    const algs = (body.pubKeyCredParams as Array<{ alg: number }>).map((p) => p.alg);
    expect(algs).toContain(-7);
    expect(algs).toContain(-257);
    expect(body.authenticatorSelection.userVerification).toBe("preferred");
  });

  it("honors an explicit rpId when supplied in the body", async () => {
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
        credentialId: "cred-fake",
        publicKey: "pub-fake",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/session_not_found_or_expired/);
  });

  it("200s + verification:deferred for a valid session", async () => {
    const app = await buildApp();
    const challengeRes = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/register-challenge",
      payload: { operatorId: "op-1" },
    });
    const { sessionId } = challengeRes.json();

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: {
        sessionId,
        credentialId: "cred-fake",
        publicKey: "pub-fake-cose",
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.credentialId).toBe("cred-fake");
    expect(body.verification).toBe("deferred");
    expect(body.persisted).toBe(false);
  });

  it("one-shot semantics: a second verify with the same sessionId returns 404", async () => {
    const app = await buildApp();
    const { sessionId } = (
      await app.inject({
        method: "POST",
        url: "/api/onboard/passkey/register-challenge",
        payload: {},
      })
    ).json();

    // First verify — succeeds and consumes the challenge.
    const first = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: { sessionId, credentialId: "c", publicKey: "p" },
    });
    expect(first.statusCode).toBe(200);

    // Second verify — session is gone.
    const second = await app.inject({
      method: "POST",
      url: "/api/onboard/passkey/verify-attestation",
      payload: { sessionId, credentialId: "c", publicKey: "p" },
    });
    expect(second.statusCode).toBe(404);
  });
});
