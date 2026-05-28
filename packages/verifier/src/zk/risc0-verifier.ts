/**
 * Risc0 proof verifier.
 *
 * Risc0 is the secondary DCC5 system per scope §3.7 — Automata's
 * `tdx-attestation-sdk` uses Risc0 by default for the S2 TEE-wrap path.
 *
 * Same DI pattern as SP1: pluggable `risc0Verify` hook (local SDK / WASM),
 * optional `onchainVerifierRpc` for Path B (Groth16-wrap EVM verifier).
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §3.7 + §3.8.
 */

import type { ZkProofMetadata } from "@pcc/spec";
import type { ZkVerifyResult } from "./index.js";

export interface Risc0VerifyOptions {
  /** Risc0 SDK / WASM verify hook. */
  risc0Verify?: Risc0VerifyFn;
  /** Optional on-chain double-check RPC. */
  onchainVerifierRpc?: (
    chainId: number,
    addr: string,
    proofBytes: Uint8Array,
    publicInputs: { inputsHash: string; outputsHash: string },
  ) => Promise<{ valid: boolean; reason?: string }>;
  acceptUnverifiedInTest?: boolean;
}

export type Risc0VerifyFn = (
  proofBytes: Uint8Array,
  imageId: string,
  journal: { inputsHash: string; outputsHash: string },
) => Promise<{ valid: boolean; reason?: string }>;

export async function verifyRisc0Proof(
  proofBytesBase64: string,
  metadata: ZkProofMetadata,
  options: Risc0VerifyOptions = {},
): Promise<ZkVerifyResult> {
  let proofBytes: Uint8Array;
  try {
    proofBytes = base64ToBytes(proofBytesBase64);
  } catch (e) {
    return {
      valid: false,
      system: "risc0",
      statement: metadata.statement,
      reason: `proof base64 decode failed: ${e instanceof Error ? e.message : String(e)}`,
      vkMatch: false,
    };
  }

  if (proofBytes.length < 32) {
    return {
      valid: false,
      system: "risc0",
      statement: metadata.statement,
      reason: `proof too short: ${proofBytes.length} bytes`,
      vkMatch: false,
    };
  }

  const vkMatch = metadata.verificationKeyHash.length > 0;

  let valid = false;
  let reason: string | undefined;

  if (options.risc0Verify) {
    try {
      const r = await options.risc0Verify(proofBytes, metadata.verificationKeyHash, {
        inputsHash: metadata.publicInputsHash,
        outputsHash: metadata.publicOutputsHash,
      });
      valid = r.valid;
      if (!r.valid) reason = r.reason ?? "risc0 verify returned invalid";
    } catch (e) {
      reason = `risc0 verify threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (options.acceptUnverifiedInTest) {
    valid = vkMatch;
    if (!valid) reason = "vkMatch failed in test mode";
  } else {
    reason = "no risc0Verify backend wired (set options.risc0Verify)";
  }

  if (valid && options.onchainVerifierRpc && metadata.onchainVerifier) {
    try {
      const r = await options.onchainVerifierRpc(
        metadata.onchainVerifier.chainId,
        metadata.onchainVerifier.address,
        proofBytes,
        {
          inputsHash: metadata.publicInputsHash,
          outputsHash: metadata.publicOutputsHash,
        },
      );
      if (!r.valid) {
        valid = false;
        reason = `on-chain double-check failed: ${r.reason ?? "unknown"}`;
      }
    } catch (e) {
      valid = false;
      reason = `on-chain double-check threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    valid,
    system: "risc0",
    statement: metadata.statement,
    vkMatch,
    reason,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
