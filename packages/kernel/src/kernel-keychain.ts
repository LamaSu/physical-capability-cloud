/**
 * KernelKeychain — BIP-32 key derivation for kernel-held signing keys.
 *
 * Agents route data but cannot forge kernel signatures.
 * The kernel has its own signing key at derivation path m/44'/60'/0'/1/0,
 * separate from the agent's operational key at m/44'/60'/0'/0/0.
 *
 * Architecture:
 *   Machine → raw data → KernelKeychain.sign(data) → signed envelope → Agent routes it → Storage
 *   The agent never has access to the kernel signing key.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import type { Signature } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Derivation paths
// ---------------------------------------------------------------------------

/**
 * Agent operational key: m/44'/60'/0'/0/0
 * This is the standard EVM BIP-44 path — used by the agent wallet (UnifiedKeychain).
 * The kernel key is intentionally on a DIFFERENT change index.
 */
const AGENT_EVM_PATH = "m/44'/60'/0'/0/0";

/**
 * Kernel signing key: m/44'/60'/0'/1/0
 * Change index = 1 (internal chain) separates this from the agent's external key.
 * Agent code must never derive this path.
 */
const KERNEL_SIGNING_PATH = "m/44'/60'/0'/1/0";

// ---------------------------------------------------------------------------
// Registration proof-of-possession
// ---------------------------------------------------------------------------

/**
 * Canonical message a kernel signs to PROVE possession of its signing key at
 * registration. Bound to the kernelId so a signature captured for one kernel
 * cannot be replayed to register a different kernel's signing address.
 *
 * This is the single source of truth for the message format — the gateway's
 * registration verifier imports THIS function so the signer and verifier can
 * never drift. Changing this string is a protocol change: it invalidates every
 * previously-issued proof, so version it rather than editing in place.
 */
export function kernelSigningProofMessage(kernelId: string): string {
  return `pcc-kernel-signing-key:${kernelId}`;
}

/** The `{ signingAddress, signingProof }` pair a kernel sends at registration. */
export interface KernelRegistrationProof {
  /** The kernel's secp256k1 signing address (checksummed 0x…). */
  signingAddress: Address;
  /** EIP-191 personal_sign signature over `kernelSigningProofMessage(kernelId)`. */
  signingProof: `0x${string}`;
}

// ---------------------------------------------------------------------------
// KernelKeychain
// ---------------------------------------------------------------------------

export class KernelKeychain {
  private readonly mnemonic: string;

  /**
   * Create a KernelKeychain from a mnemonic or from the KERNEL_MNEMONIC env var.
   *
   * @param mnemonic - BIP-39 mnemonic. If omitted, reads KERNEL_MNEMONIC from env.
   *   If env is also empty, a fresh mnemonic is generated (useful in tests).
   */
  constructor(mnemonic?: string) {
    if (mnemonic) {
      if (!validateMnemonic(mnemonic, wordlist)) {
        throw new Error("KernelKeychain: Invalid BIP-39 mnemonic provided");
      }
      this.mnemonic = mnemonic;
    } else {
      const envMnemonic = process.env["KERNEL_MNEMONIC"];
      if (envMnemonic) {
        if (!validateMnemonic(envMnemonic, wordlist)) {
          throw new Error("KernelKeychain: Invalid KERNEL_MNEMONIC env var — not a valid BIP-39 mnemonic");
        }
        this.mnemonic = envMnemonic;
      } else {
        // Generate a fresh mnemonic for test/dev environments
        this.mnemonic = generateMnemonic(wordlist, 128);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: key derivation
  // ---------------------------------------------------------------------------

  /** Derive the master HD key from the mnemonic */
  private getMasterKey(): HDKey {
    const seed = mnemonicToSeedSync(this.mnemonic);
    return HDKey.fromMasterSeed(seed);
  }

  /**
   * Derive the kernel signing key (m/44'/60'/0'/1/0).
   * This is intentionally private — callers use signEvidence() instead.
   */
  private getKernelSigningKey(): `0x${string}` {
    const master = this.getMasterKey();
    const node = master.derive(KERNEL_SIGNING_PATH);
    if (!node.privateKey) {
      throw new Error("KernelKeychain: Failed to derive kernel signing key");
    }
    return `0x${Buffer.from(node.privateKey).toString("hex")}` as `0x${string}`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the Ethereum address for the kernel signing key.
   * Safe to expose — this is the public identity of the kernel signer.
   */
  getKernelAddress(): Address {
    const privateKey = this.getKernelSigningKey();
    const account = privateKeyToAccount(privateKey);
    return account.address;
  }

  /**
   * Get the Ethereum address for the agent operational key (m/44'/60'/0'/0/0).
   * Exposed for reference — demonstrates the separation between agent and kernel keys.
   */
  getAgentAddress(): Address {
    const master = this.getMasterKey();
    const node = master.derive(AGENT_EVM_PATH);
    if (!node.privateKey) {
      throw new Error("KernelKeychain: Failed to derive agent key");
    }
    const privateKey = `0x${Buffer.from(node.privateKey).toString("hex")}` as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    return account.address;
  }

  /**
   * Sign data with the kernel signing key.
   *
   * The data is signed as an Ethereum personal_sign message (EIP-191 prefix).
   * This ensures the signature is verifiable against the kernel's Ethereum address.
   *
   * @param data - The string to sign (typically a SHA-256 hash like "sha256:abc...")
   * @returns A Signature with signer address, algorithm, and hex-encoded value
   */
  async signEvidence(data: string): Promise<Signature> {
    const privateKey = this.getKernelSigningKey();
    const account = privateKeyToAccount(privateKey);

    // signMessage applies EIP-191 prefix: "\x19Ethereum Signed Message:\n" + length + data
    const signatureHex = await account.signMessage({ message: data });

    return {
      signer: account.address,
      algorithm: "secp256k1",
      value: signatureHex,
    };
  }

  /**
   * Build the registration proof-of-possession for this kernel's signing key.
   *
   * Signs the kernelId-bound message (`kernelSigningProofMessage(kernelId)`)
   * with the kernel signing key and returns the claimed address plus the
   * signature. The gateway recovers the signer from the proof and persists
   * `signingAddress` only if it matches — so it can later authenticate this
   * kernel's signed machine logs for settlement.
   *
   * Send both fields in the `POST /api/kernels` body:
   *   { ...manifest, signingAddress, signingProof }
   *
   * @param kernelId - The kernelId being registered (must match the id in the
   *   same registration body, or the gateway cannot verify the binding).
   */
  async buildRegistrationProof(kernelId: string): Promise<KernelRegistrationProof> {
    const message = kernelSigningProofMessage(kernelId);
    const signature = await this.signEvidence(message);
    return {
      signingAddress: this.getKernelAddress(),
      signingProof: signature.value as `0x${string}`,
    };
  }

  /**
   * Verify that a signature was produced by this kernel's signing key.
   *
   * @param data - The original data that was signed
   * @param signature - The Signature to verify
   * @returns true if the signature is valid and the signer matches the kernel address
   */
  async verifySignature(data: string, signature: Signature): Promise<boolean> {
    try {
      const { verifyMessage } = await import("viem");
      const kernelAddress = this.getKernelAddress();

      const isValid = await verifyMessage({
        address: signature.signer,
        message: data,
        signature: signature.value as `0x${string}`,
      });

      return isValid && signature.signer.toLowerCase() === kernelAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Export a summary for logging (no secrets).
   */
  summary(): Record<string, string> {
    return {
      kernelAddress: this.getKernelAddress(),
      agentAddress: this.getAgentAddress(),
      derivationPath: KERNEL_SIGNING_PATH,
      mnemonic: `${this.mnemonic.split(" ").slice(0, 3).join(" ")}... (${this.mnemonic.split(" ").length} words)`,
    };
  }
}
