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
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import {
  passkeyRoutes,
  _resetPasskeyStoreForTests,
  _peekPasskeyStoreForTests,
  _seedRegisteredCredentialForTests,
  _getPendingChallengeForTests,
  _expireAllChallengesForTests,
} from "../routes/passkey.js";

// ── Real P-256 keypair fixture ────────────────────────────────────────

/**
 * Generate a real P-256 keypair, derive the SEC1 uncompressed public key,
 * and base64-encode it. Matches what the mobile passkey-manager would
 * persist in the register flow.
 */
function realP256Fixture(): {
  privateKey: Uint8Array;
  publicKeyBytes: Uint8Array;
  publicKeyB64: string;
} {
  const privateKey = p256.utils.randomPrivateKey();
  // Uncompressed (SEC1): 0x04 || X(32) || Y(32) = 65 bytes.
  const publicKeyBytes = p256.getPublicKey(privateKey, false);
  const publicKeyB64 = Buffer.from(publicKeyBytes).toString("base64");
  return { privateKey, publicKeyBytes, publicKeyB64 };
}

/**
 * Build a WebAuthn-style assertion bundle for a given challenge:
 * authenticatorData || sha256(clientDataJSON), signed with the private key.
 *
 * Returns base64-encoded strings the way the client would send them.
 */
function buildAssertion(opts: {
  privateKey: Uint8Array;
  challengeB64: string;
  origin?: string;
  authenticatorData?: Uint8Array;
}): {
  signature: string;
  authenticatorData: string;
  clientDataJSON: string;
} {
  // WebAuthn uses base64url for the challenge inside clientDataJSON.
  const challengeB64u = opts.challengeB64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const clientData = {
    type: "webauthn.get",
    challenge: challengeB64u,
    origin: opts.origin ?? "https://capability.network",
  };
  const clientDataJSONBytes = new TextEncoder().encode(JSON.stringify(clientData));

  // 37+ byte authenticatorData stub (rpIdHash 32 || flags 1 || counter 4).
  const authenticatorData =
    opts.authenticatorData ??
    (() => {
      const ad = new Uint8Array(37);
      // Some non-zero bytes so this is distinguishable across tests.
      for (let i = 0; i < 32; i++) ad[i] = i + 1;
      ad[32] = 0x05; // flags: UP=1, UV=1
      // counter zero
      return ad;
    })();

  // Signed message: authData || sha256(clientDataJSON).
  const clientDataHash = sha256(clientDataJSONBytes);
  const message = new Uint8Array(authenticatorData.length + clientDataHash.length);
  message.set(authenticatorData, 0);
  message.set(clientDataHash, authenticatorData.length);
  const messageHash = sha256(message);
  // Sign hash directly. p256.sign hashes the input by default, so we
  // pass the already-hashed message and rely on the signed-bytes equivalence
  // since hash(hash(x)) is what WebAuthn signs in practice (the platform
  // hashes the wire bytes once internally).
  // Approach: sign the raw message, server reconstructs message and hashes
  // identically. We're hashing here only because p256.verify auto-hashes
  // by default — to skip the implicit hash we need prehash:true OR pass
  // the raw message and trust the symmetric hash on both sides. We pick
  // the prehash:true path to match the implementation contract.
  const sig = p256.sign(messageHash, opts.privateKey, { prehash: false });
  const sigBytes = sig.toDERRawBytes();

  return {
    signature: Buffer.from(sigBytes).toString("base64"),
    authenticatorData: Buffer.from(authenticatorData).toString("base64"),
    clientDataJSON: Buffer.from(clientDataJSONBytes).toString("base64"),
  };
}

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

// ── Verify ────────────────────────────────────────────────────────────

describe("POST /api/passkey/verify", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetPasskeyStoreForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Issue a challenge for a freshly-seeded user with a real P-256 keypair. */
  async function setupUserAndChallenge(userId: string): Promise<{
    privateKey: Uint8Array;
    credentialId: string;
    challengeId: string;
    challengeB64: string;
  }> {
    const fixture = realP256Fixture();
    const credentialId = `cred-${userId}`;
    _seedRegisteredCredentialForTests({
      userId,
      credentialId,
      publicKey: fixture.publicKeyB64,
      authenticatorData: "auth-stub",
    });
    const challRes = await app.inject({
      method: "POST",
      url: "/api/passkey/challenge",
      payload: { userId },
    });
    expect(challRes.statusCode).toBe(200);
    const cb = challRes.json();
    return {
      privateKey: fixture.privateKey,
      credentialId,
      challengeId: cb.challengeId,
      challengeB64: cb.challenge,
    };
  }

  it("verifies a valid assertion and returns a session token", async () => {
    const { privateKey, credentialId, challengeId, challengeB64 } =
      await setupUserAndChallenge("user-delta");

    const assertion = buildAssertion({ privateKey, challengeB64 });

    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId,
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sessionToken).toBe("string");
    expect(body.sessionToken.length).toBeGreaterThan(20);
    expect(body.userId).toBe("user-delta");
    expect(body.credentialId).toBe(credentialId);

    // Challenge consumed; session created.
    const peek = _peekPasskeyStoreForTests();
    expect(peek.challenges).toBe(0);
    expect(peek.sessions).toBe(1);
  });

  it("rejects an expired challenge with 410", async () => {
    const { privateKey, credentialId, challengeId, challengeB64 } =
      await setupUserAndChallenge("user-echo");

    _expireAllChallengesForTests();

    const assertion = buildAssertion({ privateKey, challengeB64 });
    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId,
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("challenge_expired");
    // Challenge cleaned up.
    expect(_getPendingChallengeForTests(challengeId)).toBeNull();
  });

  it("rejects a wrong / unregistered credentialId with 404", async () => {
    const { privateKey, challengeId, challengeB64 } =
      await setupUserAndChallenge("user-foxtrot");

    const assertion = buildAssertion({ privateKey, challengeB64 });
    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId: "cred-DOES-NOT-EXIST",
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("credential_not_found");
  });

  it("rejects a replayed challenge on the second verify with 404", async () => {
    const { privateKey, credentialId, challengeId, challengeB64 } =
      await setupUserAndChallenge("user-golf");

    const assertion = buildAssertion({ privateKey, challengeB64 });

    const first = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId,
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });
    expect(first.statusCode).toBe(200);

    // Replay: same challenge, same assertion.
    const second = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId,
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });
    // After successful verify, the challenge is deleted, so the second
    // call gets a 404 ("not found"). This is the desired outcome —
    // replay is impossible because the nonce no longer exists.
    expect(second.statusCode).toBe(404);
    expect(second.json().error).toBe("challenge_not_found");
  });

  it("rejects a malformed signature with 401", async () => {
    const { credentialId, challengeId, challengeB64 } =
      await setupUserAndChallenge("user-hotel");

    // Build an assertion with a different (random) private key — the
    // signature will be perfectly well-formed P-256 but won't verify
    // against the stored public key.
    const wrongFixture = realP256Fixture();
    const assertion = buildAssertion({
      privateKey: wrongFixture.privateKey,
      challengeB64,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/passkey/verify",
      payload: {
        challengeId,
        credentialId,
        signature: assertion.signature,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    });

    // The challenge match check passes (clientDataJSON has the right
    // challenge), but signature verification fails against the wrong
    // public key.
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("signature_invalid");
  });
});
