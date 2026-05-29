/**
 * TEE verifier dispatcher.
 *
 * Single entry point — `verifyTeeQuote(quote, profile, expectedReportData)`
 * — that routes to the per-vendor implementation. Each vendor module
 * (`./tdx-verifier.ts`, `./nitro-verifier.ts`, `./sgx-verifier.ts`) is pure
 * stateless TypeScript, no globals; the dispatcher chooses by
 * `IndexedTool.teeProfile.vendor`.
 *
 * Pure ESM, no Fastify / DB / IO. Network calls (e.g. Intel PCCS) are scoped
 * inside the verifier modules and gated by tests via fixture injection.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §2.
 */

import type { TeeProfile, TeeVendor } from "@pcc/spec";
import type { TeeMeasurements } from "@pcc/spec";

import { verifyTdxQuote, type TdxVerifyOptions } from "./tdx-verifier.js";
import { verifyNitroAttestation } from "./nitro-verifier.js";
import { verifySgxQuote } from "./sgx-verifier.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a single TEE quote verification. */
export interface TeeVerifyResult {
  /** True iff the quote signature + cert chain validates AND measurement matches. */
  valid: boolean;
  /** True iff the cert chain back to vendor root validated. */
  certChainValid: boolean;
  /** True iff the observed measurement matched the expected one. */
  measurementMatch: boolean;
  /** Parsed measurement view safe to store on the receipt. */
  measurements: TeeMeasurements;
  /** Human reason for failure when `!valid`. */
  reason?: string;
}

/** Options threaded through to vendor verifiers. */
export interface TeeVerifyOptions extends TdxVerifyOptions {
  /** Override timestamp source for tests (epoch ms). */
  now?: number;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Verify a TEE quote against a tool's declared `teeProfile`.
 *
 * `quote` is the base64-encoded raw quote bytes that came back from the
 * upstream (DCC4). `expectedReportData` is sha256(nonce ‖ args ‖ response)
 * that PCC recomputed; the quote's report_data must equal this.
 *
 * Returns a `TeeVerifyResult` — never throws on quote-shape errors (those
 * become `valid: false` with a reason). Throws ONLY on logic errors
 * (missing profile, unknown vendor).
 */
export async function verifyTeeQuote(
  quote: string,
  profile: TeeProfile | undefined,
  expectedReportData: string,
  options: TeeVerifyOptions = {},
): Promise<TeeVerifyResult> {
  if (!profile) {
    throw new Error(
      "verifyTeeQuote: tool has no teeProfile — cannot verify DCC4 quote",
    );
  }

  switch (profile.vendor) {
    case "intel-tdx":
    case "phala-cloud":
    case "dstack":
      return verifyTdxQuote(quote, profile, expectedReportData, options);
    case "aws-nitro":
      return verifyNitroAttestation(quote, profile, expectedReportData);
    case "intel-sgx":
      return verifySgxQuote(quote, profile, expectedReportData);
    case "amd-sev-snp":
      // Phase 1 stub: SEV-SNP adapter ships in Phase 2 per scope §1.4.
      return {
        valid: false,
        certChainValid: false,
        measurementMatch: false,
        measurements: emptyMeasurements(profile.vendor),
        reason:
          "amd-sev-snp adapter not implemented yet (Phase 2 per scope §1.4)",
      };
    default: {
      const v: TeeVendor = profile.vendor;
      throw new Error(`verifyTeeQuote: unknown vendor ${String(v)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — shared by verifier modules
// ---------------------------------------------------------------------------

export function emptyMeasurements(vendor: TeeVendor): TeeMeasurements {
  return {
    vendor,
    observedMeasurement: "",
    quoteFormat: "",
    reportData: "",
    expectedReportData: "",
    measurementMatch: false,
    certChainValid: false,
  };
}

export type { TeeProfile, TeeMeasurements };
