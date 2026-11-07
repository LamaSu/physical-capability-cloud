/**
 * Provisioning stores only caller-supplied Ed25519 public keys.
 *
 *   - POST /api/auth/provision without publicKey → no signing key on file.
 *   - BYOK signatures verify against the stored public key.
 *   - Tamper with the message → valid:false.
 *   - Provisioning never returns private signing material.
 *   - Invalid public key → 400.
 *   - Unknown agent id → 404.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";
import {
  generateEd25519Keypair,
  signWithPrivateKeyHex,
} from "../auth/ed25519.js";

// Mock telemetry + audit + posthog so the provision flow doesn't try to
// reach external services during the test. Matches the canonical pattern
// in capability-facade.test.ts.
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
}));

describe("POST /api/auth/provision — Ed25519 BYOK + verify roundtrip", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("without publicKey: provisions an API key with no signing key on file", async () => {
    const provRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `operator-${Date.now()}@example.com`, name: "test" },
    });
    expect(provRes.statusCode).toBe(201);
    const provBody = JSON.parse(provRes.body) as {
      api_key: string;
      key_id: string;
      ed25519: {
        public_key: string | null;
        source: string;
      };
    };
    expect(provBody.api_key).toMatch(/^pcc_/);
    expect(provBody.ed25519).toEqual({ public_key: null, source: "none" });

    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/agents/${provBody.key_id}/verify`,
      payload: { message: "hello pcc agent provisioning", signature: "a".repeat(128) },
    });
    expect(verifyRes.statusCode).toBe(404);
    expect(JSON.parse(verifyRes.body).error).toBe("key_not_found");
  });

  it("BYOK: caller-supplied public key is stored AS-IS; no private leaks", async () => {
    const myKey = generateEd25519Keypair();
    const provRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: {
        email: `byok-${Date.now()}@example.com`,
        publicKey: myKey.publicKeyHex,
      },
    });
    expect(provRes.statusCode).toBe(201);
    const provBody = JSON.parse(provRes.body) as {
      key_id: string;
      ed25519: {
        public_key: string;
        source: string;
        private_key?: string;
      };
    };
    expect(provBody.ed25519).toEqual({ public_key: myKey.publicKeyHex, source: "byok" });
    // CRITICAL: BYOK path NEVER returns private material.
    expect(provBody.ed25519.private_key).toBeUndefined();

    // Verify endpoint works: we sign locally with our own private key.
    const message = "byok signed message";
    const sigHex = signWithPrivateKeyHex(myKey.privateKeyHex, Buffer.from(message));
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/);
    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/agents/${provBody.key_id}/verify`,
      payload: { message, signature: sigHex },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = JSON.parse(verifyRes.body) as { valid: boolean; key_id: string };
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.key_id).toBe(provBody.key_id);

    const tamperRes = await app.inject({
      method: "POST",
      url: `/api/agents/${provBody.key_id}/verify`,
      payload: { message: message + " tampered", signature: sigHex },
    });
    expect(tamperRes.statusCode).toBe(200);
    expect(JSON.parse(tamperRes.body).valid).toBe(false);
  });

  it("rejects invalid publicKey with 400", async () => {
    const provRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: {
        email: `bad-${Date.now()}@example.com`,
        publicKey: "not even hex",
      },
    });
    expect(provRes.statusCode).toBe(400);
    expect(JSON.parse(provRes.body).error).toBe("invalid_public_key");
  });

  it("verify on unknown agent id returns 404 (does not leak)", async () => {
    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/agents/no-such-agent/verify`,
      payload: { message: "x", signature: "a".repeat(128) },
    });
    expect(verifyRes.statusCode).toBe(404);
    expect(JSON.parse(verifyRes.body).error).toBe("key_not_found");
  });

  it("verify requires either message or message_base64", async () => {
    // Provision first to have a real key id.
    const provRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `bodytest-${Date.now()}@example.com` },
    });
    const keyId = JSON.parse(provRes.body).key_id;
    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/agents/${keyId}/verify`,
      payload: { signature: "a".repeat(128) },
    });
    expect(verifyRes.statusCode).toBe(400);
  });

  it("verify accepts base64-encoded message body", async () => {
    const myKey = generateEd25519Keypair();
    const provRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `b64-${Date.now()}@example.com`, publicKey: myKey.publicKeyHex },
    });
    const provBody = JSON.parse(provRes.body) as {
      key_id: string;
    };
    const messageBytes = Buffer.from([0x00, 0x01, 0xff, 0x10]);
    const sigHex = signWithPrivateKeyHex(myKey.privateKeyHex, messageBytes)!;
    const verifyRes = await app.inject({
      method: "POST",
      url: `/api/agents/${provBody.key_id}/verify`,
      payload: {
        message_base64: messageBytes.toString("base64"),
        signature: sigHex,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(JSON.parse(verifyRes.body).valid).toBe(true);
  });
});
