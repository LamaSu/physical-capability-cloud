import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { buildEd25519RegistrationProof } from "@pcc/kernel-sdk";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, initStore } from "../db.js";

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
    const owner = provisionApiKey({ operatorId: "operator-owner" }).rawKey;
    const attacker = provisionApiKey({ operatorId: "operator-attacker" }).rawKey;
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
});
