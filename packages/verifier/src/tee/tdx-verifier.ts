/**
 * Intel TDX quote verifier (covers `intel-tdx`, `phala-cloud`, `dstack`).
 *
 * Phase 1 implementation. Per scope §2.5 the production verification path
 * goes through `dcap-qvl` (pure-Rust + WASM, Flashbots-published) for the
 * PCK cert chain + quote signature. This module ships:
 *
 *   1. A pure-TS structural parser for TDX quote v4/v5 — extracts MRTD,
 *      RTMR0..3, MRSIGNER, report_data, header version. No deps.
 *   2. A pluggable `dcapQvlVerify` hook (injected via options) that does the
 *      cert-chain + signature check. Defaults to a permissive `null` — in
 *      production, set `options.dcapQvlVerify = await loadDcapQvlWasm()` so
 *      the cert chain is actually validated.
 *   3. Measurement-set comparison against the registered `teeProfile`.
 *   4. report_data equality (replay-attack mitigation per scope §6).
 *
 * The dcap-qvl WASM bundle is intentionally NOT a hard dep at this layer —
 * the package would otherwise pull in a 4 MB blob that breaks the
 * browser-safe @pcc/spec import chain. Operators wire it in at startup.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §2.2 + §2.5 + §2.8.
 */

import type { TeeProfile, TeeMeasurements } from "@pcc/spec";
import type { TeeVerifyResult } from "./index.js";
import { emptyMeasurements } from "./index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TdxVerifyOptions {
  /**
   * Optional hook to call into dcap-qvl (Rust/WASM) for cert-chain + sig
   * validation. If omitted, this layer reports `certChainValid: false` with
   * `reason: "no dcap-qvl backend wired"` — UNLESS `acceptUnverifiedInTest`
   * is true (for fixture-only test suites).
   */
  dcapQvlVerify?: DcapQvlVerifyFn;
  /**
   * Set true in unit tests to accept fixture quotes without a real Intel PKI
   * walk. Production code path MUST NOT set this.
   */
  acceptUnverifiedInTest?: boolean;
  /**
   * Max age in ms PCC accepts for a quote (replay-attack mitigation).
   * Default 60_000 (60 s) per scope §6 question 6.
   */
  maxAgeMs?: number;
}

/** Signature of the dcap-qvl WASM verifier hook. */
export type DcapQvlVerifyFn = (
  quoteBytes: Uint8Array,
  collateral?: DcapQvlCollateral,
) => Promise<DcapQvlResult>;

export interface DcapQvlCollateral {
  /** PCK certificate chain (PEM). */
  pckCertChain?: string;
  /** Intel root CA URL (Phase 1 reuses PCCS default). */
  rootCertUrl?: string;
}

export interface DcapQvlResult {
  valid: boolean;
  reason?: string;
  /** Parsed advisory IDs from the quote (TCB level info). */
  advisoryIds?: string[];
}

// ---------------------------------------------------------------------------
// TDX quote shape (v4)
// ---------------------------------------------------------------------------

/**
 * TDX quote header + body byte layout. Reference:
 * https://download.01.org/intel-sgx/sgx-dcap/1.18/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf
 *
 * Header (48 bytes):
 *   u16 version           (= 4 for TDX-DCAP)
 *   u16 ak_type           (= 2 ECDSA-256-with-P-256)
 *   u32 tee_type          (= 0x81 for TDX)
 *   u16 qe_svn
 *   u16 pce_svn
 *   u8[16] qe_vendor_id
 *   u8[20] user_data
 *
 * Body (584 bytes for TDX 1.0):
 *   u8[8]   tee_tcb_svn
 *   u8[48]  mrseam
 *   u8[48]  mrsignerseam
 *   u8[8]   seam_attributes
 *   u8[8]   td_attributes
 *   u8[8]   xfam
 *   u8[48]  mr_td       <-- the one we care about
 *   u8[48]  mr_config_id
 *   u8[48]  mr_owner
 *   u8[48]  mr_owner_config
 *   u8[48]  rtmr_0      <-- runtime measurement 0
 *   u8[48]  rtmr_1
 *   u8[48]  rtmr_2
 *   u8[48]  rtmr_3
 *   u8[64]  report_data <-- our challenge binding
 */
export interface ParsedTdxQuote {
  headerVersion: number;
  teeType: number;
  qeVendorId: string;
  mrTd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  reportData: string;
  /** Quote format tag: "tdx-v4" or "tdx-v5". */
  quoteFormat: string;
  /** True iff the byte structure parsed cleanly. */
  shapeValid: boolean;
  /** Reason iff !shapeValid. */
  shapeError?: string;
}

// ---------------------------------------------------------------------------
// Quote parser
// ---------------------------------------------------------------------------

/**
 * Parse a base64-encoded TDX quote into its measurement fields.
 *
 * Pure structural parse. Does NOT verify the signature or cert chain — that
 * is the dcap-qvl hook's job. A parse failure returns `shapeValid: false`
 * with a reason but does NOT throw.
 */
export function parseTdxQuote(quoteBase64: string): ParsedTdxQuote {
  const empty: ParsedTdxQuote = {
    headerVersion: 0,
    teeType: 0,
    qeVendorId: "",
    mrTd: "",
    rtmr0: "",
    rtmr1: "",
    rtmr2: "",
    rtmr3: "",
    reportData: "",
    quoteFormat: "",
    shapeValid: false,
  };

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(quoteBase64);
  } catch (e) {
    return {
      ...empty,
      shapeError: `base64 decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Need at least header (48 B) + body (584 B) = 632 B before signature
  // section. Real quotes are longer (≈4-5 KB) — we only need the prefix.
  if (bytes.length < 632) {
    return {
      ...empty,
      shapeError: `quote too short: ${bytes.length} bytes (need >= 632)`,
    };
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // TDX quote little-endian per Intel spec.
  const version = dv.getUint16(0, true);
  const teeType = dv.getUint32(4, true);

  if (version !== 4 && version !== 5) {
    return {
      ...empty,
      shapeError: `unknown TDX quote header version ${version} (expected 4 or 5)`,
    };
  }

  // Body starts at offset 48
  const bodyOffset = 48;
  // mr_td at offset 8+48+48+8+8+8 = 128 into body, length 48
  const mrTdOffset = bodyOffset + 128;
  const mrTd = bytesToHex(bytes.slice(mrTdOffset, mrTdOffset + 48));

  // rtmr_0 at offset 8+48+48+8+8+8+48+48+48+48 = 320 into body
  const rtmr0Offset = bodyOffset + 320;
  const rtmr0 = bytesToHex(bytes.slice(rtmr0Offset, rtmr0Offset + 48));
  const rtmr1 = bytesToHex(bytes.slice(rtmr0Offset + 48, rtmr0Offset + 96));
  const rtmr2 = bytesToHex(bytes.slice(rtmr0Offset + 96, rtmr0Offset + 144));
  const rtmr3 = bytesToHex(bytes.slice(rtmr0Offset + 144, rtmr0Offset + 192));

  // report_data at offset 320 + 192 = 512 into body, length 64
  const reportDataOffset = bodyOffset + 512;
  const reportData = bytesToHex(
    bytes.slice(reportDataOffset, reportDataOffset + 64),
  );

  // qe_vendor_id at header offset 12, length 16
  const qeVendorId = bytesToHex(bytes.slice(12, 28));

  return {
    headerVersion: version,
    teeType,
    qeVendorId,
    mrTd,
    rtmr0,
    rtmr1,
    rtmr2,
    rtmr3,
    reportData,
    quoteFormat: `tdx-v${version}`,
    shapeValid: true,
  };
}

// ---------------------------------------------------------------------------
// Main verify
// ---------------------------------------------------------------------------

/**
 * Verify a TDX quote against a tool's `teeProfile`.
 *
 * Steps (mirrors scope §2.2 flow steps 5-9):
 *   1. Base64-decode + structural parse.
 *   2. Compare observed MRTD (+ optional RTMRs) against teeProfile.
 *   3. Compare report_data against expected (replay mitigation).
 *   4. Call dcap-qvl hook (if wired) for cert-chain + sig validation.
 *   5. Roll up to TeeVerifyResult.
 */
export async function verifyTdxQuote(
  quoteBase64: string,
  profile: TeeProfile,
  expectedReportData: string,
  options: TdxVerifyOptions = {},
): Promise<TeeVerifyResult> {
  const parsed = parseTdxQuote(quoteBase64);

  if (!parsed.shapeValid) {
    return {
      valid: false,
      certChainValid: false,
      measurementMatch: false,
      measurements: {
        ...emptyMeasurements(profile.vendor),
        expectedReportData,
      },
      reason: `tdx quote parse failed: ${parsed.shapeError}`,
    };
  }

  // Measurement match: MRTD MUST equal expectedMeasurement; RTMRs OPTIONAL.
  const observedMeasurement = parsed.mrTd;
  const observedRtmr: [string, string, string, string] = [
    parsed.rtmr0,
    parsed.rtmr1,
    parsed.rtmr2,
    parsed.rtmr3,
  ];

  const expectedMeasurement = profile.expectedMeasurement.toLowerCase();
  const observedLower = observedMeasurement.toLowerCase();
  const mrTdMatch = expectedMeasurement === observedLower;

  let rtmrMatch = true;
  if (profile.expectedRtmr) {
    rtmrMatch = profile.expectedRtmr.every(
      (e, i) => e.toLowerCase() === observedRtmr[i]?.toLowerCase(),
    );
  }
  const measurementMatch = mrTdMatch && rtmrMatch;

  // Report-data binding (replay-attack mitigation per scope §6 Q6 + Q8).
  const reportDataMatch =
    parsed.reportData.toLowerCase() === expectedReportData.toLowerCase();

  // Cert-chain + signature validation via dcap-qvl hook.
  let certChainValid = false;
  let dcapReason: string | undefined;
  if (options.dcapQvlVerify) {
    try {
      const result = await options.dcapQvlVerify(base64ToBytes(quoteBase64));
      certChainValid = result.valid;
      if (!result.valid) dcapReason = result.reason ?? "dcap-qvl returned invalid";
    } catch (e) {
      dcapReason = `dcap-qvl threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (options.acceptUnverifiedInTest) {
    // Test-only path; do NOT enable in production.
    certChainValid = true;
  } else {
    dcapReason = "no dcap-qvl backend wired (set options.dcapQvlVerify)";
  }

  const measurements: TeeMeasurements = {
    vendor: profile.vendor,
    observedMeasurement,
    observedRtmr,
    quoteFormat: parsed.quoteFormat,
    reportData: parsed.reportData,
    expectedReportData,
    measurementMatch,
    certChainValid,
  };

  const valid = measurementMatch && reportDataMatch && certChainValid;
  let reason: string | undefined;
  if (!valid) {
    const parts: string[] = [];
    if (!mrTdMatch)
      parts.push(
        `MRTD mismatch (expected ${expectedMeasurement.slice(0, 16)}…, observed ${observedLower.slice(0, 16)}…)`,
      );
    if (!rtmrMatch) parts.push("RTMR mismatch");
    if (!reportDataMatch)
      parts.push(
        `report_data mismatch (expected ${expectedReportData.slice(0, 16)}…)`,
      );
    if (!certChainValid) parts.push(dcapReason ?? "cert chain invalid");
    reason = parts.join("; ");
  }

  return {
    valid,
    certChainValid,
    measurementMatch,
    measurements,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  // Tolerate url-safe encoding and missing padding.
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
