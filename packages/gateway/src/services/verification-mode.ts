/**
 * Verification-Modes Router — Mode A / B / C dispatch for settlement gating.
 *
 * Per pcc-deliberation #066 / owner directive in #063:
 *
 *   Mode A — user-attested check-off (oracle-FREE)
 *     Operator → user delivers proof (photo/stream/document); the PAYER calls
 *     MilestoneEscrowV3.approveAndRelease(milestoneIndex). Used for
 *     user-verifiable evidence where oracle attestation is overkill (and
 *     reduces oracle load at scale). Default for assurance tier 0-1.
 *
 *   Mode B — oracle-attested (CURRENT behavior)
 *     Oracle mints an EAS attestation; MilestoneEscrowV2/V3.submitAttestation
 *     binds it; release fires after the challenge window. Default for
 *     regulated tier 2-3 (medical, aerospace, pharma).
 *
 *   Mode C — dispute / juror
 *     Routes the milestone to a dispute path. Today that's the oracle's
 *     dispute handler; tomorrow it's an m-of-n juror pool (post-#066 roadmap).
 *
 * All v2 behavior is gated by PCC_EVIDENCE_V2_ENABLED. When the flag is unset,
 * `selectVerificationMode` still resolves a mode (for inspection/testing) but
 * `runVerification` returns a flag-off stub so production paths route to the
 * legacy Mode-B flow (verifyWithOracle) by default.
 *
 * NOTE: MilestoneEscrowV3 is being drafted in parallel (pcc-contracts repo,
 * branch feat/escrow-v3-payer-approval). Until its ABI lands, Mode A here
 * uses a forward-typed STUB ABI that mirrors the expected interface. The
 * actual on-chain call wiring is deferred — `runVerification` for Mode A
 * returns the calldata + target without executing any transaction.
 *
 * NO chain transactions are executed by this module. NO Railway env mutations.
 * NO deploy implications. This is draft-only routing logic.
 */

import {
  verifyWithOracle,
  isEvidenceV2Enabled,
  type OracleVerifyRequest,
  type OracleResponse,
} from "./oracle-client.js";
import { encodeFunctionData, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three verification modes from pcc-deliberation #066. */
export type VerificationMode = "A" | "B" | "C";

/**
 * Caller intent. Only `"dispute"` forces Mode C; `"settle"` and undefined
 * fall through to assurance-tier rules below.
 */
export type VerificationIntent = "settle" | "dispute";

export interface SelectVerificationModeInput {
  /** Job assurance tier (0-3). Drives the A vs B default. */
  assuranceTier: number;
  /** Caller intent. Defaults to "settle". */
  intent?: VerificationIntent;
}

export interface SelectVerificationModeOutput {
  mode: VerificationMode;
  /** Plain-English why-this-mode, for telemetry + audit log. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Mode-selection rules (pcc-deliberation #063)
// ---------------------------------------------------------------------------

/**
 * Choose a verification mode for a milestone given assurance tier + intent.
 *
 * Rules (deterministic, in order):
 *   1. intent === "dispute"  →  Mode C  (explicit override)
 *   2. assuranceTier >= 2    →  Mode B  (regulated — oracle attestation required)
 *   3. assuranceTier in 0|1  →  Mode A  (user-attested check-off, oracle-free)
 *   4. fallback              →  Mode B  (safe default — never lower the bar silently)
 */
export function selectVerificationMode(
  input: SelectVerificationModeInput,
): SelectVerificationModeOutput {
  const intent = input.intent ?? "settle";

  if (intent === "dispute") {
    return {
      mode: "C",
      rationale: "intent=dispute — routed to dispute path",
    };
  }

  // Tier 2-3 = regulated. Always oracle (Mode B).
  if (input.assuranceTier >= 2) {
    return {
      mode: "B",
      rationale: `assuranceTier=${input.assuranceTier} (regulated) — oracle attestation required`,
    };
  }

  // Tier 0-1 = user-verifiable. Mode A (oracle-free).
  if (input.assuranceTier === 0 || input.assuranceTier === 1) {
    return {
      mode: "A",
      rationale: `assuranceTier=${input.assuranceTier} (user-verifiable) — payer-approval release (oracle-free)`,
    };
  }

  // Unknown tier — safe default.
  return {
    mode: "B",
    rationale: `assuranceTier=${input.assuranceTier} (unknown) — defaulting to oracle (safe)`,
  };
}

// ---------------------------------------------------------------------------
// V3 escrow ABI stub — Mode A target
// ---------------------------------------------------------------------------
//
// MilestoneEscrowV3 is being drafted in parallel (see implementer-oscar's
// branch in pcc-contracts: feat/escrow-v3-payer-approval). Until that ABI
// lands, this stub mirrors the expected signature so this router compiles.
// When the real ABI exists, callers should swap the import.

/**
 * Stub V3 escrow ABI fragment for `approveAndRelease(uint256 milestoneIndex)`.
 * The buyer/payer calls this to release a Mode-A user-attested milestone.
 * Replace with `MilestoneEscrowV3ABI` once published from @pcc/contracts.
 */
export const MilestoneEscrowV3ABIStub = [
  {
    type: "function",
    name: "approveAndRelease",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Build calldata for MilestoneEscrowV3.approveAndRelease(milestoneIndex).
 * Pure encoding — no transaction is sent. The caller (a future paid-job-flow
 * wiring or a dashboard "Approve" button) submits this calldata via the
 * payer's wallet.
 */
export function encodeApproveAndReleaseV3(milestoneIndex: number): Hex {
  return encodeFunctionData({
    abi: MilestoneEscrowV3ABIStub,
    functionName: "approveAndRelease",
    args: [BigInt(milestoneIndex)],
  });
}

// ---------------------------------------------------------------------------
// Mode-dispatch results
// ---------------------------------------------------------------------------

export interface ModeAResult {
  mode: "A";
  /** Escrow address the payer-approval call targets. */
  escrowAddress: string;
  milestoneIndex: number;
  /** ABI-encoded calldata for MilestoneEscrowV3.approveAndRelease. */
  calldata: Hex;
  /** Plain-English instruction for the operator's "deliver proof" handoff. */
  payerInstruction: string;
}

export interface ModeBResult {
  mode: "B";
  oracle: OracleResponse;
}

export interface ModeCResult {
  mode: "C";
  route: "dispute";
  reason: string;
  /**
   * Today: the oracle's dispute endpoint (gateway forwards to /verify with
   * intent=dispute). Tomorrow: m-of-n juror pool. Wiring lives outside this
   * router; this is a routing marker.
   */
  next: "oracle-dispute" | "juror-pool";
}

export interface ModeFlagOffResult {
  mode: "FLAG_OFF";
  reason: "PCC_EVIDENCE_V2_ENABLED is not set — legacy Mode-B (oracle) is the only path";
}

export type RunVerificationResult =
  | ModeAResult
  | ModeBResult
  | ModeCResult
  | ModeFlagOffResult;

// ---------------------------------------------------------------------------
// Mode-A input (oracle-free)
// ---------------------------------------------------------------------------

export interface RunVerificationModeAInput {
  mode: "A";
  escrowAddress: string;
  /** Index of the milestone the payer is approving. */
  milestoneIndex: number;
  /** Optional operator-supplied note (proof URL, photo CID, etc) for audit. */
  proofNote?: string;
}

export interface RunVerificationModeBInput {
  mode: "B";
  /** Forwarded to verifyWithOracle. */
  oracleRequest: OracleVerifyRequest;
}

export interface RunVerificationModeCInput {
  mode: "C";
  /** Reason the milestone is being disputed (for telemetry + audit). */
  reason: string;
}

export type RunVerificationInput =
  | RunVerificationModeAInput
  | RunVerificationModeBInput
  | RunVerificationModeCInput;

// ---------------------------------------------------------------------------
// runVerification — gated dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute the selected verification mode.
 *
 * IMPORTANT — flag-off behavior: if `PCC_EVIDENCE_V2_ENABLED` is unset, this
 * function returns a `ModeFlagOffResult` for Modes A and C. Callers should
 * then fall through to the legacy Mode-B path (call verifyWithOracle
 * directly). Mode B is ALWAYS executed regardless of the flag, because
 * routing Mode B through this dispatcher costs nothing and gives uniform
 * telemetry. This preserves 100% backwards compatibility with v1 callers.
 *
 * NO chain transactions are sent by this function. Mode A returns calldata
 * the payer must submit; Mode C returns a routing marker. The actual on-chain
 * sends happen in higher-level wiring (paid-job-flow.ts, escrow-client.ts).
 */
export async function runVerification(
  input: RunVerificationInput,
): Promise<RunVerificationResult> {
  // Mode B (oracle) is always available — it's the legacy path.
  if (input.mode === "B") {
    const oracle = await verifyWithOracle(input.oracleRequest);
    return { mode: "B", oracle };
  }

  // Mode A and Mode C require the v2 flag.
  if (!isEvidenceV2Enabled()) {
    return {
      mode: "FLAG_OFF",
      reason:
        "PCC_EVIDENCE_V2_ENABLED is not set — legacy Mode-B (oracle) is the only path",
    };
  }

  if (input.mode === "A") {
    const calldata = encodeApproveAndReleaseV3(input.milestoneIndex);
    return {
      mode: "A",
      escrowAddress: input.escrowAddress,
      milestoneIndex: input.milestoneIndex,
      calldata,
      payerInstruction: input.proofNote
        ? `Payer to approve milestone ${input.milestoneIndex}. Proof: ${input.proofNote}`
        : `Payer to approve milestone ${input.milestoneIndex}.`,
    };
  }

  // Mode C — dispute. Today: route to oracle dispute endpoint (handler outside
  // this module). Tomorrow: juror pool.
  return {
    mode: "C",
    route: "dispute",
    reason: input.reason,
    next: "oracle-dispute",
  };
}

// ---------------------------------------------------------------------------
// Convenience: select + run in one call (telemetry-friendly)
// ---------------------------------------------------------------------------

export interface VerifyWithModeInput {
  assuranceTier: number;
  intent?: VerificationIntent;
  /** Carries through to the dispatcher per chosen mode. */
  modeAInput?: Omit<RunVerificationModeAInput, "mode">;
  modeBInput?: Omit<RunVerificationModeBInput, "mode">;
  modeCInput?: Omit<RunVerificationModeCInput, "mode">;
}

export interface VerifyWithModeOutput {
  selection: SelectVerificationModeOutput;
  result: RunVerificationResult;
}

/**
 * High-level helper: choose a mode by tier+intent, then run it.
 *
 * Throws if the chosen mode's input is missing. Designed for the eventual
 * `paid-job-flow.ts` wiring: the route picks tier+intent, constructs all three
 * mode inputs defensively, and lets this helper dispatch.
 */
export async function verifyWithMode(
  input: VerifyWithModeInput,
): Promise<VerifyWithModeOutput> {
  const selection = selectVerificationMode({
    assuranceTier: input.assuranceTier,
    intent: input.intent,
  });

  let result: RunVerificationResult;
  switch (selection.mode) {
    case "A":
      if (!input.modeAInput) {
        throw new Error(
          "verifyWithMode: selection=A but modeAInput is missing",
        );
      }
      result = await runVerification({ mode: "A", ...input.modeAInput });
      break;
    case "B":
      if (!input.modeBInput) {
        throw new Error(
          "verifyWithMode: selection=B but modeBInput is missing",
        );
      }
      result = await runVerification({ mode: "B", ...input.modeBInput });
      break;
    case "C":
      if (!input.modeCInput) {
        throw new Error(
          "verifyWithMode: selection=C but modeCInput is missing",
        );
      }
      result = await runVerification({ mode: "C", ...input.modeCInput });
      break;
  }

  return { selection, result };
}
