/**
 * Tests for the Week 4 passkey server endpoints.
 *
 *   POST /api/passkey/register   (commit 1)
 *   POST /api/passkey/challenge  (commit 2 — stub described, tests added then)
 *   POST /api/passkey/verify     (commit 3 — stub described, tests added then)
 *
 * The register suite is the only one populated in commit 1. Subsequent
 * commits add the challenge + verify suites incrementally.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  passkeyRoutes,
  _resetPasskeyStoreForTests,
  _peekPasskeyStoreForTests,
  _seedRegisteredCredentialForTests,
  _getPendingChallengeForTests,
  _expireAllChallengesForTests,
} from "../routes/passkey.js";

// ── Fixture helpers ───────────────────────────────────────────────────

/**
 * Build a 65-byte SEC1 uncompressed P-256 public key, base64-encoded. We
 * don't bother with a real keygen here because register() does shape-only
 * validation; commit 3's verify() suite uses real @noble/curves keys.
 */
function fakeUncompressedP256B64(seed = 1): string {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04; // uncompressed prefix
  for (let i = 1; i < 65; i++) {
    bytes[i] = (seed * 13 + i * 7) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(passkeyRoutes);
  await app.ready();
  return app;
}

// ── Suites ────────────────────────────────────────────────────────────

describe("POST /api/passkey/register", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetPasskeyStoreForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("registers a new passkey and returns ok + credentialId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload: {
        userId: "user-alpha",
        credentialId: "cred-AAAA",
        publicKey: fakeUncompressedP256B64(1),
        authenticatorData: "AAAA-auth-data",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.credentialId).toBe("cred-AAAA");
    expect(body.userId).toBe("user-alpha");
    expect(typeof body.registeredAt).toBe("string");
    expect(body.registeredAt.length).toBeGreaterThan(10);

    // Store-level: one credential, no challenges, no sessions.
    const peek = _peekPasskeyStoreForTests();
    expect(peek.credentials).toBe(1);
    expect(peek.challenges).toBe(0);
    expect(peek.sessions).toBe(0);
  });

  it("rejects a duplicate credentialId with 409", async () => {
    const payload = {
      userId: "user-alpha",
      credentialId: "cred-DUPE",
      publicKey: fakeUncompressedP256B64(2),
      authenticatorData: "auth-data",
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload,
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe("duplicate_credential");

    // Still only one entry in the store.
    expect(_peekPasskeyStoreForTests().credentials).toBe(1);
  });

  it("rejects malformed input with 400", async () => {
    // Missing fields
    const noUser = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload: {
        credentialId: "cred",
        publicKey: fakeUncompressedP256B64(3),
        authenticatorData: "auth",
      },
    });
    expect(noUser.statusCode).toBe(400);
    expect(noUser.json().error).toBe("invalid_body");

    // Wrong-shape public key (not 65 bytes)
    const badKey = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload: {
        userId: "user-x",
        credentialId: "cred-x",
        publicKey: Buffer.from(new Uint8Array([0x04, 0x01])).toString("base64"),
        authenticatorData: "auth",
      },
    });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().error).toBe("invalid_public_key");

    // Public key with wrong leading byte
    const badPrefix = new Uint8Array(65);
    badPrefix[0] = 0x05; // not 0x04
    const wrongPrefix = await app.inject({
      method: "POST",
      url: "/api/passkey/register",
      payload: {
        userId: "user-y",
        credentialId: "cred-y",
        publicKey: Buffer.from(badPrefix).toString("base64"),
        authenticatorData: "auth",
      },
    });
    expect(wrongPrefix.statusCode).toBe(400);
    expect(wrongPrefix.json().error).toBe("invalid_public_key");
  });
});

// ── Challenge ─────────────────────────────────────────────────────────

describe("POST /api/passkey/challenge", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetPasskeyStoreForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("issues a 32-byte challenge with TTL when the user is registered", async () => {
    _seedRegisteredCredentialForTests({
      userId: "user-bravo",
      credentialId: "cred-BBBB",
      publicKey: fakeUncompressedP256B64(4),
      authenticatorData: "auth",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId: "user-bravo" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.challengeId).toBe("string");
    expect(body.challengeId.length).toBeGreaterThan(0);
    expect(typeof body.challenge).toBe("string");
    // 32 raw bytes → 44 chars in standard base64.
    expect(body.challenge.length).toBeGreaterThanOrEqual(43);
    // Decoded length is 32.
    const decoded = Buffer.from(body.challenge, "base64");
    expect(decoded.length).toBe(32);

    // Expires roughly 5 min in the future.
    const expiresAtMs = Date.parse(body.expiresAt);
    const drift = expiresAtMs - Date.now();
    expect(drift).toBeGreaterThan(4 * 60 * 1000);
    expect(drift).toBeLessThan(6 * 60 * 1000);

    // Store contains exactly one pending challenge.
    expect(_peekPasskeyStoreForTests().challenges).toBe(1);
    const pending = _getPendingChallengeForTests(body.challengeId);
    expect(pending).not.toBeNull();
    expect(pending?.userId).toBe("user-bravo");
    expect(pending?.used).toBe(false);
  });

  it("returns 404 when the user has no registered passkey", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId: "ghost-user" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("user_not_registered");
    expect(_peekPasskeyStoreForTests().challenges).toBe(0);
  });

  it("expires challenges and sweeps them on the next call", async () => {
    _seedRegisteredCredentialForTests({
      userId: "user-charlie",
      credentialId: "cred-CCCC",
      publicKey: fakeUncompressedP256B64(5),
      authenticatorData: "auth",
    });

    // Issue challenge #1, then force-expire it.
    const first = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId: "user-charlie" },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().challengeId as string;
    _expireAllChallengesForTests();

    // Issue challenge #2 — this should trigger sweep + delete the expired one.
    const second = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId: "user-charlie" },
    });
    expect(second.statusCode).toBe(200);

    // Only the new (un-expired) challenge survives.
    expect(_peekPasskeyStoreForTests().challenges).toBe(1);
    expect(_getPendingChallengeForTests(firstId)).toBeNull();
  });

  it("rejects malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId: 123 }, // wrong type
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});
