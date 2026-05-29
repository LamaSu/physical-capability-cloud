/**
 * DCC5 — zkSNARK proof verifier (top-level entry point).
 *
 * Mirrors the dcc4-tee-verifier.ts pattern. The dcc-evaluator calls this
 * to convert a receipt's `zkProof` + `zkProofMetadata` into a structured
 * `Dcc5Verdict` finding.
 *
 * Receipt-side schema notes:
 *   - `zkProof`: opaque base64 bytes
 *   - `zkProofMetadata`: parsed view (system, statement, vk hash, …)
 *   - `zkSystem`: top-level convenience copy
 *   - `zkProofVerifierAddress`: top-level on-chain verifier ref
 *
 * For S2 (TEE-wrap), the dcc-evaluator MUST first confirm DCC4 was valid —
 * a DCC5 S2 proof only makes sense as an upgrade of a verified DCC4 receipt.
 * That cross-class dependency is enforced by the evaluator, not here.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §3.
 */

import type { InvocationReceipt } from "@pcc/spec";
import { verifyZkProof, type ZkVerifyOptions } from "./zk/index.js";

export interface Dcc5VerifyOptions extends ZkVerifyOptions {
  acceptUnverifiedInTest?: boolean;
}

export interface Dcc5Verdict {
  valid: boolean;
  details: string;
  reason?: string;
  /** True iff metadata matched the wire vk digest. */
  vkMatch: boolean;
  /** Echo of statement under proof for receipt findings. */
  statement?: "tee-wrap" | "faithful-execution";
}

/**
 * Verify the DCC5 attestation on an invocation receipt.
 */
export async function verifyDcc5(
  receipt: InvocationReceipt,
  options: Dcc5VerifyOptions = {},
): Promise<Dcc5Verdict> {
  if (!receipt.zkProof) {
    return {
      valid: false,
      details: "DCC5: zkProof missing on receipt",
      reason: "zkProof missing",
      vkMatch: false,
    };
  }

  if (!receipt.zkProofMetadata) {
    return {
      valid: false,
      details: "DCC5: zkProofMetadata missing — cannot dispatch by system",
      reason: "zkProofMetadata missing",
      vkMatch: false,
    };
  }

  const result = await verifyZkProof(
    receipt.zkProof,
    receipt.zkProofMetadata,
    options,
  );

  if (result.valid) {
    return {
      valid: true,
      details: `DCC5: ${result.system} ${result.statement} proof verified`,
      vkMatch: result.vkMatch,
      statement: result.statement,
    };
  }

  return {
    valid: false,
    details: `DCC5: ${result.system} ${result.statement} proof verification failed (${result.reason ?? "unknown"})`,
    reason: result.reason,
    vkMatch: result.vkMatch,
    statement: result.statement,
  };
}
