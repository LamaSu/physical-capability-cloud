/**
 * zkSNARK verifier dispatcher (DCC5).
 *
 * Routes a `zkProof` + `zkProofMetadata` pair to the per-system verifier:
 *
 *   - sp1   → ./sp1-verifier.ts   (primary; scope §3.7)
 *   - risc0 → ./risc0-verifier.ts (secondary, Automata default for S2)
 *   - noir  → reuses ../noir-proof-service.ts (PCC-internal narrow proofs)
 *
 * Statement discriminator (from metadata):
 *   - "tee-wrap" (S2, default): proof asserts a DCC4 TDX quote verifies
 *     under Intel's PKI. Generated via Automata Boundless market.
 *   - "faithful-execution" (S1, operator opt-in): proof asserts O = L(I) for
 *     the tool's compiled RISC-V ELF.
 *
 * Pure stateless. No on-chain RPCs; the per-system verifiers may dispatch
 * to an injected `onchainVerifierRpc` for EVM-side double-check, but the
 * default path validates locally against the verification key digest.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §3.
 */

import type { ZkProofMetadata, ZkSystem } from "@pcc/spec";
import { verifySp1Proof, type Sp1VerifyOptions } from "./sp1-verifier.js";
import { verifyRisc0Proof, type Risc0VerifyOptions } from "./risc0-verifier.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ZkVerifyResult {
  /** True iff the proof passed the per-system verify. */
  valid: boolean;
  /** Which system handled the proof. */
  system: ZkSystem;
  /** What was proven: "tee-wrap" or "faithful-execution". */
  statement: "tee-wrap" | "faithful-execution";
  /** Human reason on failure. */
  reason?: string;
  /** True iff the verification-key digest matched what metadata claimed. */
  vkMatch: boolean;
}

export interface ZkVerifyOptions extends Sp1VerifyOptions, Risc0VerifyOptions {
  /** Override timestamp for tests. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Verify a DCC5 zk-proof against the receipt's `zkProofMetadata`.
 *
 * Returns a `ZkVerifyResult`. Never throws on proof-shape errors (those
 * become `valid: false` with a reason). Throws ONLY on dispatcher logic
 * errors (missing metadata, unknown system).
 */
export async function verifyZkProof(
  proofBytesBase64: string,
  metadata: ZkProofMetadata | undefined,
  options: ZkVerifyOptions = {},
): Promise<ZkVerifyResult> {
  if (!metadata) {
    throw new Error(
      "verifyZkProof: zkProofMetadata missing — cannot dispatch by system",
    );
  }

  switch (metadata.zkSystem) {
    case "sp1":
      return verifySp1Proof(proofBytesBase64, metadata, options);
    case "risc0":
      return verifyRisc0Proof(proofBytesBase64, metadata, options);
    case "noir":
      // Noir is wired via ../noir-proof-service.ts. Phase 1 returns a
      // structural-only check here; full Noir verify lives in the
      // narrow-proofs path (tier_compliance.nr etc.).
      return {
        valid: false,
        system: "noir",
        statement: metadata.statement,
        reason:
          "DCC5 Noir path is Phase 2 — narrow Noir proofs use NoirProofService directly",
        vkMatch: false,
      };
    case "halo2":
    case "plonky3":
      // Phase 1 deferral per scope §3.7: Halo2 collapses into Noir/SP1
      // backends; Plonky3 is the SP1 internal STARK.
      return {
        valid: false,
        system: metadata.zkSystem,
        statement: metadata.statement,
        reason: `DCC5 ${metadata.zkSystem} not implemented (Phase 2 / use sp1)`,
        vkMatch: false,
      };
    default: {
      const sys: ZkSystem = metadata.zkSystem;
      throw new Error(`verifyZkProof: unknown system ${String(sys)}`);
    }
  }
}
