/**
 * Ed25519 registration proof-of-possession for third-party kernels (#235).
 *
 * A digital kernel signs evidence bundles with its principal Ed25519 key (see
 * `createKernelHandler`). Before the gateway will authenticate those signed
 * bundles for settlement, the kernel must PROVE possession of that same key at
 * registration by signing a kernelId-bound challenge. This module builds that
 * proof from the kernel's principal private key so `registerKernel` can send it
 * on `POST /api/kernels`.
 *
 * The proven key MUST be the SAME principal key the adapter wires into
 * `createKernelHandler` — the gateway's settlement path matches each evidence
 * bundle's signature against the registered signer. Proving a throwaway key
 * would permanently (set-once) bind an identity that never signs evidence.
 */

import nacl from "tweetnacl";
import { toHex } from "./job-handler.js";

/**
 * Canonical challenge a kernel signs to prove possession of its Ed25519 signing
 * key at registration. Bound to `kernelId` so a proof captured for one kernel
 * cannot be replayed to register another kernel's key.
 *
 * SINGLE SOURCE OF TRUTH: `kernelSigningProofMessage()` in `@pcc/kernel`
 * (packages/kernel/src/kernel-keychain.ts). It is inlined here — byte-identical —
 * because `@pcc/kernel` is a private, heavy workspace package (viem, bip32/39,
 * helia, storacha) and this SDK is published + intentionally lightweight;
 * depending on it would be unpublishable and bloat every install. Drift is
 * guarded by the gateway integration test (`kernel-signing-sdk-e2e.test.ts`),
 * which posts THIS module's proof through the real gateway — and the gateway
 * imports the `@pcc/kernel` function — so any divergence fails CI. If the
 * challenge is ever hoisted into `@pcc/spec`, import it from there instead.
 *
 * Changing this string is a protocol change: it invalidates every
 * previously-issued proof. Version it rather than editing in place.
 */
export function signingProofMessage(kernelId: string): string {
  return `pcc-kernel-signing-key:${kernelId}`;
}

/** The Ed25519 signing fields sent on `POST /api/kernels` (the #235 lane). */
export interface Ed25519RegistrationProof {
  /** Discriminator selecting the gateway's ed25519 verification lane. */
  signingKeyAlgorithm: "ed25519";
  /** Raw 32-byte Ed25519 public key, hex-encoded (64 chars, no 0x prefix). */
  signingPublicKey: string;
  /**
   * Raw detached Ed25519 signature over the UTF-8 bytes of the challenge
   * (`signingProofMessage(kernelId)`), hex-encoded (128 chars, no 0x prefix,
   * NO EIP-191 prefix).
   */
  signingProof: string;
}

/**
 * Build the Ed25519 registration proof for a kernel's principal signing key.
 *
 * Derives the public key from the secret key, signs the kernelId-bound
 * challenge with a raw detached Ed25519 signature, and hex-encodes both. The
 * output is the exact set of `signing*` fields `POST /api/kernels` expects.
 *
 * @param kernelId            The kernelId being registered. MUST match the `id`
 *   sent in the same registration body, or the gateway cannot verify the
 *   binding and will store a null signer (fail closed).
 * @param principalPrivateKey The kernel's principal Ed25519 secret key — either
 *   a 64-byte tweetnacl `secretKey` (the format `createKernelHandler` takes) or
 *   a 32-byte seed. Any other length throws.
 */
export function buildEd25519RegistrationProof(
  kernelId: string,
  principalPrivateKey: Uint8Array,
): Ed25519RegistrationProof {
  let keyPair: nacl.SignKeyPair;
  if (principalPrivateKey.length === 64) {
    keyPair = nacl.sign.keyPair.fromSecretKey(principalPrivateKey);
  } else if (principalPrivateKey.length === 32) {
    keyPair = nacl.sign.keyPair.fromSeed(principalPrivateKey);
  } else {
    throw new Error(
      `buildEd25519RegistrationProof: principalPrivateKey must be 32 (seed) or ` +
        `64 (tweetnacl secretKey) bytes, got ${principalPrivateKey.length}`,
    );
  }

  const challenge = new TextEncoder().encode(signingProofMessage(kernelId));
  const signature = nacl.sign.detached(challenge, keyPair.secretKey);

  return {
    signingKeyAlgorithm: "ed25519",
    signingPublicKey: toHex(keyPair.publicKey),
    signingProof: toHex(signature),
  };
}
