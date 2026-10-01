import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { buildEd25519RegistrationProof } from "@pcc/kernel-sdk";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

/**
 * A fresh Ed25519 proof-of-possession for `kernelId`. WP-C: the owner in the
 * last test registers WITH a proven signer, so the kernel's authorized ceiling
 * is 1 (fresh reputation). The tier assertion there can then tell the two
 * outcomes apart: the owner's omitted claim (0) serves 0, while an applied
 * attacker claim of 3 would serve min(3, 1) = 1. Without a signer the ceiling
 * is 0 and both outcomes would read 0.
 */
function ownerSigningProof(kernelId: string) {
  const kp = nacl.sign.keyPair();
  return buildEd25519RegistrationProof(kernelId, {
    algorithm: "ed25519",
    privateKey: kp.secretKey,
    expectedPublicKey: Buffer.from(kp.publicKey).toString("hex"),
  });
}

describe("POST /api/kernels authentication and ownership", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(kernelRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("keeps GET public but rejects an unauthenticated signing-key bind", async () => {
    expect((await app.inject({ method: "GET", url: "/api/kernels" })).statusCode).toBe(200);
    const kp = nacl.sign.keyPair();
    const proof = buildEd25519RegistrationProof("victim-kernel", {
      algorithm: "ed25519",
      privateKey: kp.secretKey,
      expectedPublicKey: Buffer.from(kp.publicKey).toString("hex"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: { id: "victim-kernel", ...proof },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("api_key_required");
  });

  it("does not let one authenticated actor bind a kernel owned by another", async () => {
    const owner = provisionApiKey({ operatorId: "operator-owner", scopes: ["operator"] }).rawKey;
    const attacker = provisionApiKey({ operatorId: "operator-attacker", scopes: ["operator"] }).rawKey;
    const first = await app.inject({
      method: "POST",
      url: "/api/kernels",
      headers: { authorization: `Bearer ${owner}` },
      payload: { id: "owned-kernel", name: "Owned" },
    });
    expect(first.statusCode).toBe(201);

    const kp = nacl.sign.keyPair();
    const proof = buildEd25519RegistrationProof("owned-kernel", {
      algorithm: "ed25519",
      privateKey: kp.secretKey,
      expectedPublicKey: Buffer.from(kp.publicKey).toString("hex"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/kernels",
      headers: { authorization: `Bearer ${attacker}` },
      payload: { id: "owned-kernel", ...proof },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an authenticated non-owner mutation without a signing proof", async () => {
    const owner = provisionApiKey({ operatorId: "operator-owner", scopes: ["operator"] }).rawKey;
    const attacker = provisionApiKey({ operatorId: "operator-attacker", scopes: ["operator"] }).rawKey;
    const first = await app.inject({
      method: "POST",
      url: "/api/kernels",
      headers: { authorization: `Bearer ${owner}` },
      payload: { id: "owned-profile", name: "Owner profile", ...ownerSigningProof("owned-profile") },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().kernel.signingKey?.algorithm).toBe("ed25519");

    const response = await app.inject({
      method: "POST",
      url: "/api/kernels",
      headers: { authorization: `Bearer ${attacker}` },
      payload: { id: "owned-profile", name: "Attacker profile", maxAssuranceTier: 3 },
    });
    expect(response.statusCode).toBe(403);

    const stored = await app.inject({
      method: "GET",
      url: "/api/kernels/owned-profile",
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(stored.json().kernel.name).toBe("Owner profile");
    // Old assertion: maxAssuranceTier === 2 (the unsafe default claim, served
    // raw). WP-C: the omitted claim defaults to 0 and the DTO serves
    // min(claim, ceiling=1) = 0. The attacker's claim of 3 was never stored.
    expect(stored.json().kernel.maxAssuranceTier).toBe(0);
    expect(getRepos().kernels.findById("owned-profile")?.maxAssuranceTier).toBe(0);
  });
});
