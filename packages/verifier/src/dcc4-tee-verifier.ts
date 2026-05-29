/**
 * DCC4 — TEE quote verifier (top-level entry point).
 *
 * Wraps the vendor dispatcher in `./tee/index.ts` with the DCC4-specific
 * checks the dcc-evaluator needs:
 *
 *   - The receipt must carry a `teeQuote` (raw bytes).
 *   - The tool must have a registered `teeProfile`.
 *   - The PCC-recomputed `expectedReportData` MUST equal what the quote
 *     embedded (replay-attack mitigation per scope §6).
 *   - The vendor-specific verifier must return `valid: true`.
 *
 * Returns a structured `Dcc4Verdict` that the dcc-evaluator consumes to
 * emit a `DccEvaluationFinding`.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §2.
 */

import type { IndexedTool, InvocationReceipt } from "@pcc/spec";
import { verifyTeeQuote, type TeeVerifyOptions } from "./tee/index.js";

export interface Dcc4VerifyOptions extends TeeVerifyOptions {
  /**
   * If true, accept fixture-only quotes without dcap-qvl cert walk.
   * Used only by unit tests; production code path leaves false.
   */
  acceptUnverifiedInTest?: boolean;
}

export interface Dcc4Verdict {
  /** True iff the quote passed all DCC4 checks. */
  valid: boolean;
  /** Human-friendly description for the receipt finding. */
  details: string;
  /** Cause for `!valid`. */
  reason?: string;
  /** Convenience copy of the parsed measurements (caller embeds in receipt). */
  measurementMatch: boolean;
  certChainValid: boolean;
  /**
   * Parsed teeMeasurements view that the caller can persist on the receipt's
   * `teeMeasurements` field. Always populated, even on failure (with
   * default empty values).
   */
  measurements: import("@pcc/spec").TeeMeasurements;
}

/**
 * Verify the DCC4 attestation on an invocation receipt.
 *
 * Caller (dcc-evaluator) supplies the recomputed `expectedReportData` —
 * sha256(nonce ‖ canonical(args) ‖ canonical(response)) — that the upstream
 * tool was supposed to bind into the quote's `report_data`.
 */
export async function verifyDcc4(
  receipt: InvocationReceipt,
  tool: IndexedTool | undefined,
  expectedReportData: string,
  options: Dcc4VerifyOptions = {},
): Promise<Dcc4Verdict> {
  if (!receipt.teeQuote) {
    return failVerdict(
      "DCC4: teeQuote missing on receipt",
      "teeQuote missing",
    );
  }

  if (!tool) {
    return failVerdict(
      "DCC4: tool registry entry missing — cannot dispatch by vendor",
      "tool registry missing",
    );
  }

  if (!tool.teeProfile) {
    return failVerdict(
      `DCC4: tool ${tool.id} has no teeProfile — register via /claim-tee first`,
      "tool.teeProfile not registered",
    );
  }

  const result = await verifyTeeQuote(
    receipt.teeQuote,
    tool.teeProfile,
    expectedReportData,
    options,
  );

  if (result.valid) {
    return {
      valid: true,
      details: `DCC4: ${tool.teeProfile.vendor} quote verified (MRTD/MR ${result.measurements.observedMeasurement.slice(0, 16)}…)`,
      measurementMatch: result.measurementMatch,
      certChainValid: result.certChainValid,
      measurements: result.measurements,
    };
  }

  return {
    valid: false,
    details: `DCC4: ${tool.teeProfile.vendor} quote verification failed (${result.reason ?? "unknown"})`,
    reason: result.reason,
    measurementMatch: result.measurementMatch,
    certChainValid: result.certChainValid,
    measurements: result.measurements,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failVerdict(details: string, reason: string): Dcc4Verdict {
  return {
    valid: false,
    details,
    reason,
    measurementMatch: false,
    certChainValid: false,
    measurements: {
      vendor: "intel-tdx", // placeholder for fail path
      observedMeasurement: "",
      quoteFormat: "",
      reportData: "",
      expectedReportData: "",
      measurementMatch: false,
      certChainValid: false,
    },
  };
}
