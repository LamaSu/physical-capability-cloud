/**
 * Money-path tests: kernel signing-address registration with proof-of-possession.
 *
 * Goal (evidence primitive #52, machine.execution_log settlement): persist a
 * kernel's REAL secp256k1 signing address at registration ONLY when the caller
 * proves possession of that key, so the oracle can later authenticate the
 * kernel's signed machine logs before releasing escrowed funds.
 *
 * Security invariant under test — FAIL CLOSED:
 *   - valid proof (recovers to the claimed address) → persisted + returned
 *   - mismatched / absent / garbage proof            → null, NEVER persisted
 *   - proof bound to a DIFFERENT kernelId (replay)    → null, NEVER persisted
 *   - set-once: a generic upsert cannot OVERWRITE an already-proven signer
 *
 * Proofs are generated with a real viem test account (privateKeyToAccount →
 * signMessage over the kernelId-bound message), independent of the kernel
 * keychain, to prove the gateway verifies any secp256k1 signer generically.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

// Anvil/hardhat well-known test keys (public, throwaway). Two distinct signers.
const PK_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PK_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);

interface KernelBody {
  kernel: { signingAddress?: string | null };
}

describe("POST /api/kernels — signing-address proof-of-possession (primitive #52)", () => {
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

  it("persists a signing address proven by a matching EIP-191 signature", async () => {
    const id = `kernel_sig_valid_${Date.now()}`;
    const signingProof = await accountA.signMessage({
      message: kernelSigningProofMessage(id),
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Signed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address,
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    // Returned on the create response…
    const created = JSON.parse(create.body) as KernelBody;
    expect(created.kernel.signingAddress).toBe(accountA.address);

    // …and on GET /api/kernels/:id (the endpoint the oracle fetches).
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as KernelBody;
    // Checksummed address per the pinned contract.
    expect(body.kernel.signingAddress).toBe(accountA.address);

    // …and on GET /api/kernels (list).
    const list = await app.inject({ method: "GET", url: "/api/kernels" });
    const listBody = JSON.parse(list.body) as { kernels: Array<{ id: string; signingAddress?: string | null }> };
    const found = listBody.kernels.find((k) => k.id === id);
    expect(found?.signingAddress).toBe(accountA.address);
  });

  it("stores null when the proof recovers to a DIFFERENT address than claimed", async () => {
    const id = `kernel_sig_mismatch_${Date.now()}`;
    // Sign with key B but claim address A → recovered B !== claimed A → reject.
    const signingProof = await accountB.signMessage({
      message: kernelSigningProofMessage(id),
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Mismatch Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address, // claimed A, but proof is from B
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("stores null when signingProof is absent (claimed address alone is not enough)", async () => {
    const id = `kernel_sig_absent_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Unproven Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address, // no proof
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("stores null for a garbage / malformed proof", async () => {
    const id = `kernel_sig_garbage_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Garbage Proof Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address,
        signingProof: "0xnot-a-real-signature",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("stores null when the proof is bound to a DIFFERENT kernelId (replay protection)", async () => {
    const id = `kernel_sig_replay_${Date.now()}`;
    // Attacker holds a valid proof for some OTHER kernel and tries to reuse it.
    const proofForOther = await accountA.signMessage({
      message: kernelSigningProofMessage("some_other_kernel_id"),
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Replay Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address,
        signingProof: proofForOther, // valid signature, wrong binding
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("stores null by default when no signing fields are supplied", async () => {
    const id = `kernel_sig_none_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "No Signing Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("is set-once: a later upsert cannot overwrite an already-proven signer", async () => {
    const id = `kernel_sig_setonce_${Date.now()}`;
    // First register with a valid proof for A.
    const proofA = await accountA.signMessage({
      message: kernelSigningProofMessage(id),
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Set-Once Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingAddress: accountA.address,
        signingProof: proofA,
      },
    });
    expect(first.statusCode).toBe(201);

    // Attacker re-registers (upsert) the same id, proving THEIR OWN key B.
    const proofB = await accountB.signMessage({
      message: kernelSigningProofMessage(id),
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Hijack Attempt",
        signingAddress: accountB.address,
        signingProof: proofB,
      },
    });
    // Upsert of an existing kernel returns 200 (created: false).
    expect(second.statusCode).toBe(200);

    // The original proven signer must be untouched.
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingAddress).toBe(accountA.address);
  });
});
