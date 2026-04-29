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
