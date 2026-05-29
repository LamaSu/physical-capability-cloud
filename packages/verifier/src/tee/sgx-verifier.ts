/**
 * Intel SGX (legacy) quote verifier.
 *
 * SGX DCAP quotes share the same Intel PKI infrastructure as TDX but the
 * body shape differs: SGX measures an MRENCLAVE + MRSIGNER + per-enclave
 * report_data. Phase 1 ships a minimal parse + comparison; the cert chain
 * goes through the same dcap-qvl hook pattern as TDX.
 *
 * SGX is deprecated on client per scope §1.1 — kept for legacy operators
 * (Secret Network, Oasis, Apache Teaclave 1.x) but not the primary path.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §1.1 + §1.2.
 */

import type { TeeProfile, TeeMeasurements } from "@pcc/spec";
import type { TeeVerifyResult } from "./index.js";
import { emptyMeasurements } from "./index.js";

export interface SgxVerifyOptions {
  dcapQvlVerify?: (q: Uint8Array) => Promise<{ valid: boolean; reason?: string }>;
  acceptUnverifiedInTest?: boolean;
}

export interface ParsedSgxQuote {
  headerVersion: number;
  mrEnclave: string;
  mrSigner: string;
  reportData: string;
  quoteFormat: string;
  shapeValid: boolean;
  shapeError?: string;
}

/**
 * Parse a base64-encoded SGX DCAP quote (version 3).
 *
 * SGX quote v3 layout (relevant offsets):
 *   Header 48 B
 *   ReportBody 384 B
 *     u8[8]   cpu_svn
 *     u8[4]   misc_select
 *     u8[28]  reserved1
 *     u8[16]  attributes
 *     u8[32]  mr_enclave        <-- offset 64
 *     u8[32]  reserved2
 *     u8[32]  mr_signer         <-- offset 128
 *     u8[96]  reserved3
 *     u16     isv_prod_id
 *     u16     isv_svn
 *     u8[60]  reserved4
 *     u8[64]  report_data       <-- offset 320
 */
export function parseSgxQuote(quoteBase64: string): ParsedSgxQuote {
  const empty: ParsedSgxQuote = {
    headerVersion: 0,
    mrEnclave: "",
    mrSigner: "",
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

  if (bytes.length < 432) {
    return {
      ...empty,
      shapeError: `quote too short: ${bytes.length} bytes (need >= 432)`,
    };
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(0, true);
  if (version !== 3) {
    return {
      ...empty,
      shapeError: `unknown SGX quote header version ${version} (expected 3)`,
    };
  }

  const bodyOffset = 48;
  const mrEnclave = bytesToHex(
    bytes.slice(bodyOffset + 64, bodyOffset + 64 + 32),
  );
  const mrSigner = bytesToHex(
    bytes.slice(bodyOffset + 128, bodyOffset + 128 + 32),
  );
  const reportData = bytesToHex(
    bytes.slice(bodyOffset + 320, bodyOffset + 320 + 64),
  );

  return {
    headerVersion: version,
    mrEnclave,
    mrSigner,
    reportData,
    quoteFormat: "sgx-v3",
    shapeValid: true,
  };
}

export async function verifySgxQuote(
  quoteBase64: string,
  profile: TeeProfile,
  expectedReportData: string,
  options: SgxVerifyOptions = {},
): Promise<TeeVerifyResult> {
  const parsed = parseSgxQuote(quoteBase64);

  if (!parsed.shapeValid) {
    return {
      valid: false,
      certChainValid: false,
      measurementMatch: false,
      measurements: {
        ...emptyMeasurements(profile.vendor),
        expectedReportData,
      },
      reason: `sgx quote parse failed: ${parsed.shapeError}`,
    };
  }

  const expected = profile.expectedMeasurement.toLowerCase();
  const observed = parsed.mrEnclave.toLowerCase();
  const mrEnclaveMatch = expected === observed;

  let mrSignerMatch = true;
  if (profile.expectedSigner) {
    mrSignerMatch =
      profile.expectedSigner.toLowerCase() === parsed.mrSigner.toLowerCase();
  }
  const measurementMatch = mrEnclaveMatch && mrSignerMatch;

  const reportDataMatch =
    parsed.reportData.toLowerCase() === expectedReportData.toLowerCase();

  let certChainValid = false;
  let dcapReason: string | undefined;
  if (options.dcapQvlVerify) {
    try {
      const r = await options.dcapQvlVerify(base64ToBytes(quoteBase64));
      certChainValid = r.valid;
      if (!r.valid) dcapReason = r.reason ?? "dcap-qvl returned invalid";
    } catch (e) {
      dcapReason = `dcap-qvl threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (options.acceptUnverifiedInTest) {
    certChainValid = true;
  } else {
    dcapReason = "no dcap-qvl backend wired";
  }

  const measurements: TeeMeasurements = {
    vendor: profile.vendor,
    observedMeasurement: parsed.mrEnclave,
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
    if (!mrEnclaveMatch) parts.push("MRENCLAVE mismatch");
    if (!mrSignerMatch) parts.push("MRSIGNER mismatch");
    if (!reportDataMatch) parts.push("report_data mismatch");
    if (!certChainValid) parts.push(dcapReason ?? "cert chain invalid");
    reason = parts.join("; ");
  }

  return { valid, certChainValid, measurementMatch, measurements, reason };
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

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
