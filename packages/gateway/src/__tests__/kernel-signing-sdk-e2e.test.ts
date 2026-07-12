/**
 * SDK ↔ gateway loop-closer for #235.
 *
 * The kernel-sdk's `registerKernel` used to POST only the marketplace endpoint,
 * which has no proof logic — so every SDK adapter landed at a null
 * registeredSigner and could never settle. This test proves the fix end to end:
 * a proof built by the SDK's `buildEd25519RegistrationProof` (tweetnacl under the
 * hood) is accepted + persisted by the REAL gateway registry (`POST /api/kernels`,
 * node:crypto verification), and served back as the bound Ed25519 signer.
 *
 * Cross-library check: the key is minted with the gateway's own node:crypto
 * `generateEd25519Keypair` (a 32-byte seed); feeding that seed to the SDK's
 * tweetnacl-based builder must derive the SAME public key — otherwise the
 * settlement identity would not match the evidence-signing key.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildEd25519RegistrationProof } from "@pcc/kernel-sdk";
import { generateEd25519Keypair } from "../auth/ed25519.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

type Signer =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };

interface KernelBody {
  kernel: { signingAddress?: string | null; signingKey?: Signer | null };
}

describe("SDK buildEd25519RegistrationProof → POST /api/kernels (#235 loop-closer)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(kernelRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("binds the SDK-proven Ed25519 key as the kernel's settlement signer", async () => {
    const id = `kernel_sdk_e2e_${Date.now()}`;

    // Mint a principal key with the gateway's node:crypto helper (32-byte seed).
    const kp = generateEd25519Keypair();
    const seed = Buffer.from(kp.privateKeyHex, "hex"); // 32 bytes

    // The SDK builds the proof from that seed (tweetnacl fromSeed).
    const proof = buildEd25519RegistrationProof(id, new Uint8Array(seed));

    // Cross-library: tweetnacl-derived pubkey == node:crypto-derived pubkey.
    expect(proof.signingPublicKey).toBe(kp.publicKeyHex);
    expect(proof.signingKeyAlgorithm).toBe("ed25519");

    // Post exactly what the SDK produces (id + name + proof fields).
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "SDK E2E Kernel",
        signingKeyAlgorithm: proof.signingKeyAlgorithm,
        signingPublicKey: proof.signingPublicKey,
        signingProof: proof.signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const expectedKey = `0x${kp.publicKeyHex}`;
    const created = JSON.parse(create.body) as KernelBody;
    expect(created.kernel.signingKey).toEqual({ algorithm: "ed25519", publicKey: expectedKey });
    expect(created.kernel.signingAddress).toBeNull();

    // Persisted + served (the endpoint the oracle #52 verifier reads).
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toEqual({ algorithm: "ed25519", publicKey: expectedKey });
  });

  it("fails closed: a proof built for a DIFFERENT kernelId does not bind (replay-safe)", async () => {
    const id = `kernel_sdk_e2e_replay_${Date.now()}`;
    const kp = generateEd25519Keypair();
    const seed = new Uint8Array(Buffer.from(kp.privateKeyHex, "hex"));

    // Proof bound to some OTHER kernelId — the challenge won't match `id`.
    const proof = buildEd25519RegistrationProof("some_other_kernel", seed);

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "SDK E2E Replay Kernel",
        signingKeyAlgorithm: proof.signingKeyAlgorithm,
        signingPublicKey: proof.signingPublicKey,
        signingProof: proof.signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
  });
});
