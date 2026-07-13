/**
 * Money-path tests: kernel Ed25519 signing-key registration with
 * proof-of-possession (Option C, wire contract WIRE SHAPE 1).
 *
 * Companion to kernel-signing-address.test.ts (the secp256k1 lane, #230). The
 * fleet is natively Ed25519 (kernel-sdk / pcc-node), so the gateway registry
 * must prove + serve a raw Ed25519 signing key alongside the existing EVM
 * address. The oracle's #52 machine.execution_log verifier reads
 * `KernelDTO.signingKey` (the algorithm-tagged union) to authenticate each
 * signed log entry before releasing escrow.
 *
 * Security invariant under test — FAIL CLOSED (a wrong "registered" signer
 * could clear settlement for a forged machine log):
 *   - valid ed25519 detached proof over the kernelId-bound challenge
 *       → served as signingKey:{algorithm:"ed25519", publicKey:"0x"+64hex}
 *   - proof by a DIFFERENT key than claimed / absent / garbage
 *       → signingKey null, NEVER persisted
 *   - proof bound to a DIFFERENT kernelId (replay)   → signingKey null
 *   - set-once: a generic upsert cannot OVERWRITE an already-proven signer
 *   - an ed25519 kernel serves signingAddress=null (the secp256k1 compat alias
 *     is empty; the identity lives on signingKey)
 *
 * Keys + signatures are generated in-test with the gateway's own node:crypto
 * Ed25519 helpers (generateEd25519Keypair + signWithPrivateKeyHex), signing the
 * UTF-8 bytes of kernelSigningProofMessage(id) — the same challenge the
 * secp256k1 lane uses, so the two families share one replay-safe binding.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { generateEd25519Keypair, signWithPrivateKeyHex } from "../auth/ed25519.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";

type Signer =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };

interface KernelBody {
  kernel: {
    signingAddress?: string | null;
    signingKey?: Signer | null;
  };
}

// Two distinct Ed25519 keypairs (raw 32-byte seeds/pubkeys, hex, no 0x).
const KP_A = generateEd25519Keypair();
const KP_B = generateEd25519Keypair();

/** Produce a 128-hex detached Ed25519 proof over the kernelId-bound challenge. */
function ed25519Proof(privateKeyHex: string, kernelId: string): string {
  const sig = signWithPrivateKeyHex(
    privateKeyHex,
    Buffer.from(kernelSigningProofMessage(kernelId), "utf8"),
  );
  if (sig === null) throw new Error("test setup: failed to sign ed25519 proof");
  return sig;
}

describe("POST /api/kernels — Ed25519 signing-key proof-of-possession (primitive #52, Option C)", () => {
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

  it("persists an Ed25519 signing key proven by a matching detached signature", async () => {
    const id = `kernel_ed_valid_${Date.now()}`;
    const signingProof = ed25519Proof(KP_A.privateKeyHex, id);
    const expectedKey = `0x${KP_A.publicKeyHex}`;

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Ed25519 Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: expectedKey,
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    // Returned on the create response…
    const created = JSON.parse(create.body) as KernelBody;
    expect(created.kernel.signingKey).toEqual({
      algorithm: "ed25519",
      publicKey: expectedKey,
    });
    // …with the secp256k1 compat alias EMPTY for an ed25519 kernel.
    expect(created.kernel.signingAddress).toBeNull();

    // …and on GET /api/kernels/:id (the endpoint the oracle #52 verifier fetches).
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toEqual({
      algorithm: "ed25519",
      publicKey: expectedKey,
    });
    expect(body.kernel.signingAddress).toBeNull();

    // …and on GET /api/kernels (list).
    const list = await app.inject({ method: "GET", url: "/api/kernels" });
    const listBody = JSON.parse(list.body) as {
      kernels: Array<{ id: string; signingKey?: Signer | null }>;
    };
    const found = listBody.kernels.find((k) => k.id === id);
    expect(found?.signingKey).toEqual({ algorithm: "ed25519", publicKey: expectedKey });
  });

  it("accepts a bare (no-0x) public key on input and normalizes it to 0x+lowercase", async () => {
    const id = `kernel_ed_no0x_${Date.now()}`;
    const signingProof = ed25519Proof(KP_A.privateKeyHex, id);

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Ed25519 Bare Pub",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: KP_A.publicKeyHex, // no 0x prefix on input
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    // Served value carries the pinned "0x"+lowercase convention regardless of
    // input framing.
    expect(body.kernel.signingKey).toEqual({
      algorithm: "ed25519",
      publicKey: `0x${KP_A.publicKeyHex}`,
    });
  });

  it("stores null when the proof verifies against a DIFFERENT key than claimed", async () => {
    const id = `kernel_ed_mismatch_${Date.now()}`;
    // Sign with key B but claim key A → verify(A, sigFromB) fails → reject.
    const signingProof = ed25519Proof(KP_B.privateKeyHex, id);

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Mismatch Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${KP_A.publicKeyHex}`, // claimed A, proof is from B
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("stores null when signingProof is absent (claimed pubkey alone is not enough)", async () => {
    const id = `kernel_ed_absent_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Unproven Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${KP_A.publicKeyHex}`, // no proof
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
  });

  it("stores null for a garbage / malformed ed25519 signature", async () => {
    const id = `kernel_ed_garbage_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Garbage Proof Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${KP_A.publicKeyHex}`,
        signingProof: "0xnot-a-real-signature", // not 128-hex → rejected
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
  });

  it("stores null when the claimed public key is malformed (wrong length)", async () => {
    const id = `kernel_ed_badpub_${Date.now()}`;
    // A valid-length signature but a claimed pubkey that is not 64 hex → the
    // pubkey normalizer fails closed before any verify is attempted.
    const signingProof = ed25519Proof(KP_A.privateKeyHex, id);
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Bad Pub Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: "0xdeadbeef", // too short
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
  });

  it("stores null when the proof is bound to a DIFFERENT kernelId (replay protection)", async () => {
    const id = `kernel_ed_replay_${Date.now()}`;
    // Attacker holds a valid proof for some OTHER kernel and tries to reuse it.
    const proofForOther = ed25519Proof(KP_A.privateKeyHex, "some_other_kernel_id");

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Replay Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${KP_A.publicKeyHex}`,
        signingProof: proofForOther, // valid signature, wrong kernelId binding
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
  });

  it("stores null by default when no signing fields are supplied", async () => {
    const id = `kernel_ed_none_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "No Signing Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toBeNull();
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("is set-once: a later upsert cannot overwrite an already-proven Ed25519 signer", async () => {
    const id = `kernel_ed_setonce_${Date.now()}`;
    const expectedKey = `0x${KP_A.publicKeyHex}`;
    // First register with a valid proof for A.
    const proofA = ed25519Proof(KP_A.privateKeyHex, id);
    const first = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Set-Once Ed Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: expectedKey,
        signingProof: proofA,
      },
    });
    expect(first.statusCode).toBe(201);

    // Attacker re-registers (upsert) the same id, proving THEIR OWN key B.
    const proofB = ed25519Proof(KP_B.privateKeyHex, id);
    const second = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Hijack Attempt",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${KP_B.publicKeyHex}`,
        signingProof: proofB,
      },
    });
    expect(second.statusCode).toBe(409);

    // The original proven signer (A) must be untouched.
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toEqual({ algorithm: "ed25519", publicKey: expectedKey });
  });

  it("a set-once ed25519 signer cannot be hijacked by a later secp256k1 proof (cross-family)", async () => {
    const id = `kernel_ed_setonce_x_${Date.now()}`;
    const expectedKey = `0x${KP_A.publicKeyHex}`;
    const proofA = ed25519Proof(KP_A.privateKeyHex, id);
    const first = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Ed Set-Once Cross",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: expectedKey,
        signingProof: proofA,
      },
    });
    expect(first.statusCode).toBe(201);

    // Attacker upserts with a valid secp256k1 proof for their OWN EVM key.
    const attacker = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const secpProof = await attacker.signMessage({ message: kernelSigningProofMessage(id) });
    const second = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Cross Hijack",
        signingAddress: attacker.address,
        signingProof: secpProof,
      },
    });
    expect(second.statusCode).toBe(409);

    // The original ed25519 signer must be untouched; no secp256k1 address leaks in.
    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    expect(body.kernel.signingKey).toEqual({ algorithm: "ed25519", publicKey: expectedKey });
    expect(body.kernel.signingAddress).toBeNull();
  });

  it("atomically allows only one of two concurrent SET-ONCE binds", async () => {
    const id = `kernel_ed_cas_${Date.now()}`;
    expect((await app.inject({
      method: "POST", url: "/api/kernels", payload: { id, name: "CAS Kernel" },
    })).statusCode).toBe(201);

    const bind = (kp: typeof KP_A) => app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        signingKeyAlgorithm: "ed25519",
        signingPublicKey: `0x${kp.publicKeyHex}`,
        signingProof: ed25519Proof(kp.privateKeyHex, id),
      },
    });
    const [a, b] = await Promise.all([bind(KP_A), bind(KP_B)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    const stored = (await app.inject({ method: "GET", url: `/api/kernels/${id}` })).json() as KernelBody;
    expect([
      `0x${KP_A.publicKeyHex}`,
      `0x${KP_B.publicKeyHex}`,
    ]).toContain((stored.kernel.signingKey as Extract<Signer, { algorithm: "ed25519" }>).publicKey);
  });

  it("serves the tagged secp256k1 signingKey for a secp256k1 kernel (union covers both families)", async () => {
    // The #230 lane still works AND now also surfaces the tagged union so the
    // oracle #52 verifier can branch on `signingKey.algorithm` for either family.
    const account = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const id = `kernel_secp_tagged_${Date.now()}`;
    const signingProof = await account.signMessage({ message: kernelSigningProofMessage(id) });

    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Secp Tagged Kernel",
        operatorAddress: "0xOperatorWallet12345678901234567890123456",
        // No signingKeyAlgorithm → defaults to the secp256k1 lane (unchanged #230).
        signingAddress: account.address,
        signingProof,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as KernelBody;
    // Compat alias preserved…
    expect(body.kernel.signingAddress).toBe(account.address);
    // …and the tagged union carries the same checksummed address.
    expect(body.kernel.signingKey).toEqual({
      algorithm: "secp256k1",
      address: account.address,
    });
  });
});
