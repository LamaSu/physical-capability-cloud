/**
 * Round-trip tests for KernelKeychain.buildRegistrationProof — the kernel-side
 * primitive that produces the { signingAddress, signingProof } pair sent at
 * registration. The gateway recovers the signer from the proof and persists
 * signingAddress only if it matches, so these tests assert the proof this
 * primitive emits is exactly what the gateway will accept.
 */

import { describe, it, expect } from "vitest";
import { recoverMessageAddress } from "viem";
import { KernelKeychain, kernelSigningProofMessage } from "../kernel-keychain.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

describe("KernelKeychain.buildRegistrationProof", () => {
  it("emits the kernel's real signing address (matches getKernelAddress)", async () => {
    const kc = new KernelKeychain(TEST_MNEMONIC);
    const proof = await kc.buildRegistrationProof("kernel_abc");
    expect(proof.signingAddress).toBe(kc.getKernelAddress());
    expect(proof.signingProof).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("proof recovers to the claimed address (the gateway acceptance path)", async () => {
    const kc = new KernelKeychain(TEST_MNEMONIC);
    const kernelId = "kernel_abc";
    const proof = await kc.buildRegistrationProof(kernelId);

    const recovered = await recoverMessageAddress({
      message: kernelSigningProofMessage(kernelId),
      signature: proof.signingProof,
    });
    expect(recovered.toLowerCase()).toBe(proof.signingAddress.toLowerCase());
  });

  it("is bound to the kernelId — a proof does not recover under a different id", async () => {
    const kc = new KernelKeychain(TEST_MNEMONIC);
    const proof = await kc.buildRegistrationProof("kernel_abc");

    // Verify the SAME signature against a DIFFERENT kernelId's message: the
    // recovered address must NOT match the signer (cross-kernel replay fails).
    const recovered = await recoverMessageAddress({
      message: kernelSigningProofMessage("kernel_xyz"),
      signature: proof.signingProof,
    });
    expect(recovered.toLowerCase()).not.toBe(proof.signingAddress.toLowerCase());
  });

  it("distinct kernels produce distinct signing addresses", async () => {
    const kc1 = new KernelKeychain(TEST_MNEMONIC);
    const kc2 = new KernelKeychain(); // fresh random mnemonic
    const p1 = await kc1.buildRegistrationProof("k");
    const p2 = await kc2.buildRegistrationProof("k");
    expect(p1.signingAddress).not.toBe(p2.signingAddress);
  });
});
