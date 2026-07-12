/**
 * Unit tests for the #235 Ed25519 registration proof and registerKernel's
 * two-POST flow.
 *
 * Two independent verification paths for the proof:
 *   - here: verify the tweetnacl-produced detached signature with node:crypto
 *     (the SPKI-prefix reconstruction the gateway uses), proving cross-library
 *     RFC-8032 compatibility;
 *   - kernel-signing-sdk-e2e.test.ts (gateway package): posts this proof through
 *     the REAL gateway registry and asserts the signer binds — closing the loop.
 */

import { describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import nacl from "tweetnacl";
import type { DigitalKernelManifest } from "@pcc/spec";
import {
  buildEd25519RegistrationProof,
  signingProofMessage,
  registerKernel,
} from "../index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Verify a raw Ed25519 detached signature the way the gateway does (node:crypto). */
function verifyWithNodeCrypto(pubHex: string, message: Uint8Array, sigHex: string): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, Buffer.from(pubHex, "hex")]);
  const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  return verify(null, Buffer.from(message), keyObject, Buffer.from(sigHex, "hex"));
}

/** A structurally-valid manifest; registerKernel only reads id/name/maxAssuranceTier. */
function testManifest(kernelId = "k-test-235"): DigitalKernelManifest {
  return {
    manifestVersion: "1.0.0",
    kernelId,
    name: "Test Kernel 235",
    description: "unit-test kernel",
    builder: { agentId: "agent:test-235" },
    capabilityType: "temperature-converter",
    workflowSteps: [
      { stepId: "s1", stepType: "transform", description: "convert", dependsOn: [] },
    ],
    pricing: { currency: "USDC", baseUSD: 0 },
    maxAssuranceTier: 1,
    endpointURL: "https://kernel.example.com/run",
    sessionKeyPolicy: { maxTTLSeconds: 3600, allowedActions: ["evidence_submit"] },
    status: "pending",
  } as unknown as DigitalKernelManifest;
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

/** A fetch stub that records each call and replays queued responses in order. */
function mockFetch(responders: Array<(url: string, body: any) => { status: number; json: unknown }>) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init: any) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    const { status, json } = responder(String(url), body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ── buildEd25519RegistrationProof ────────────────────────────────────────────

describe("buildEd25519RegistrationProof", () => {
  const SEED = new Uint8Array(32).fill(7);
  const kp = nacl.sign.keyPair.fromSeed(SEED);

  it("emits a detached proof node:crypto verifies against the kernelId-bound challenge", () => {
    const kernelId = "k-roundtrip-235";
    const proof = buildEd25519RegistrationProof(kernelId, kp.secretKey);

    expect(proof.signingKeyAlgorithm).toBe("ed25519");
    expect(proof.signingPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.signingProof).toMatch(/^[0-9a-f]{128}$/);
    // The emitted pubkey is exactly the tweetnacl keypair's public half.
    expect(Buffer.from(proof.signingPublicKey, "hex")).toEqual(Buffer.from(kp.publicKey));

    const challenge = new TextEncoder().encode(signingProofMessage(kernelId));
    expect(verifyWithNodeCrypto(proof.signingPublicKey, challenge, proof.signingProof)).toBe(true);
  });

  it("accepts a 32-byte seed and a 64-byte secretKey interchangeably (identical output)", () => {
    const kernelId = "k-seed-vs-secret";
    const fromSecret = buildEd25519RegistrationProof(kernelId, kp.secretKey);
    const fromSeed = buildEd25519RegistrationProof(kernelId, SEED);
    expect(fromSeed).toEqual(fromSecret);
  });

  it("binds the proof to the kernelId (a proof does not verify for a different kernelId)", () => {
    const proof = buildEd25519RegistrationProof("kernel-A", kp.secretKey);
    const otherChallenge = new TextEncoder().encode(signingProofMessage("kernel-B"));
    expect(verifyWithNodeCrypto(proof.signingPublicKey, otherChallenge, proof.signingProof)).toBe(false);
  });

  it("throws on a key that is neither 32 nor 64 bytes", () => {
    expect(() => buildEd25519RegistrationProof("k", new Uint8Array(16))).toThrow(
      /must be 32.*64.*bytes/,
    );
  });

  it("uses the canonical, kernelId-bound challenge string", () => {
    expect(signingProofMessage("abc")).toBe("pcc-kernel-signing-key:abc");
  });
});

// ── registerKernel with opts.signingKey (#235 two-POST flow) ──────────────────

describe("registerKernel — signing-key registration (#235)", () => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  const pubHex = Buffer.from(kp.publicKey).toString("hex");

  it("POSTs /api/kernels THEN /api/kernels/register, in order, with correct bodies; reports signerBound", async () => {
    const manifest = testManifest("k-flow-235");
    const { fetchImpl, calls } = mockFetch([
      // 1st POST — signing proof to /api/kernels → gateway binds our key
      (_url, _body) => ({
        status: 201,
        json: {
          kernel: { signingKey: { algorithm: "ed25519", publicKey: `0x${pubHex}` }, signingAddress: null },
          created: true,
        },
      }),
      // 2nd POST — marketplace manifest
      (_url, _body) => ({ status: 200, json: { kernelId: "k-flow-235", status: "pending" } }),
    ]);

    const res = await registerKernel("https://gw.example.com/", manifest, {
      apiKey: "pcc_live_test",
      fetchImpl,
      signingKey: { principalPrivateKey: kp.secretKey },
    });

    // Two calls, in the mandated order.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://gw.example.com/api/kernels");
    expect(calls[1].url).toBe("https://gw.example.com/api/kernels/register");
    expect(calls[0].method).toBe("POST");
    expect(calls[1].method).toBe("POST");

    // 1st body: the signing fields + manifest identity fields.
    expect(calls[0].body).toMatchObject({
      id: "k-flow-235",
      name: "Test Kernel 235",
      maxAssuranceTier: 1,
      signingKeyAlgorithm: "ed25519",
      signingPublicKey: pubHex,
    });
    expect(calls[0].body.signingProof).toMatch(/^[0-9a-f]{128}$/);
    // Auth header propagated to the signing POST.
    expect(calls[0].headers["Authorization"]).toBe("Bearer pcc_live_test");

    // 2nd body: unchanged marketplace shape.
    expect(calls[1].body).toEqual({ manifest });

    // Result: marketplace fields + signing outcome.
    expect(res.kernelId).toBe("k-flow-235");
    expect(res.status).toBe("pending");
    expect(res.signing).toEqual({
      signerBound: true,
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${pubHex}` },
      provenPublicKey: pubHex,
    });
  });

  it("reports signerBound:false when the gateway already bound a DIFFERENT signer (set-once)", async () => {
    const manifest = testManifest("k-setonce-235");
    const otherPub = Buffer.from(
      nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey,
    ).toString("hex");
    const { fetchImpl } = mockFetch([
      (_url, _body) => ({
        status: 200, // upsert of an existing kernel
        json: {
          kernel: { signingKey: { algorithm: "ed25519", publicKey: `0x${otherPub}` }, signingAddress: null },
          created: false,
        },
      }),
      (_url, _body) => ({ status: 200, json: { kernelId: "k-setonce-235", status: "pending" } }),
    ]);

    const res = await registerKernel("https://gw.example.com", manifest, {
      fetchImpl,
      signingKey: { principalPrivateKey: kp.secretKey },
    });

    expect(res.signing?.signerBound).toBe(false);
    expect(res.signing?.registeredSigner).toEqual({ algorithm: "ed25519", publicKey: `0x${otherPub}` });
    expect(res.signing?.provenPublicKey).toBe(pubHex);
  });

  it("reports signerBound:false when the gateway persisted no signer (null)", async () => {
    const manifest = testManifest("k-nullsigner-235");
    const { fetchImpl } = mockFetch([
      (_url, _body) => ({
        status: 201,
        json: { kernel: { signingKey: null, signingAddress: null }, created: true },
      }),
      (_url, _body) => ({ status: 200, json: { kernelId: "k-nullsigner-235", status: "pending" } }),
    ]);

    const res = await registerKernel("https://gw.example.com", manifest, {
      fetchImpl,
      signingKey: { principalPrivateKey: kp.secretKey },
    });
    expect(res.signing?.signerBound).toBe(false);
    expect(res.signing?.registeredSigner).toBeNull();
  });

  it("throws KernelRegistrationError if the signing POST itself fails (non-2xx)", async () => {
    const manifest = testManifest("k-signfail-235");
    const { fetchImpl, calls } = mockFetch([
      (_url, _body) => ({ status: 500, json: { error: "boom" } }),
    ]);

    await expect(
      registerKernel("https://gw.example.com", manifest, {
        fetchImpl,
        signingKey: { principalPrivateKey: kp.secretKey },
      }),
    ).rejects.toMatchObject({ name: "KernelRegistrationError", statusCode: 500 });
    // Marketplace POST must NOT have run after the signing POST failed.
    expect(calls).toHaveLength(1);
  });
});

// ── backward compatibility (no opts.signingKey) ───────────────────────────────

describe("registerKernel — backward compatible without signingKey", () => {
  it("makes exactly ONE POST to /api/kernels/register with body {manifest} and no signing field", async () => {
    const manifest = testManifest("k-compat-235");
    const { fetchImpl, calls } = mockFetch([
      (_url, _body) => ({ status: 200, json: { kernelId: "k-compat-235", status: "pending" } }),
    ]);

    const res = await registerKernel("https://gw.example.com/", manifest, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gw.example.com/api/kernels/register");
    expect(calls[0].body).toEqual({ manifest });
    expect(res).toEqual({
      kernelId: "k-compat-235",
      status: "pending",
      nextStep: undefined,
      message: undefined,
    });
    expect(res.signing).toBeUndefined();
  });
});
