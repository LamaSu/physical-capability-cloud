/**
 * TDX quote verifier tests.
 *
 * Fixture-driven. We synthesize a TDX v4 quote with known MRTD / RTMRs /
 * report_data, then assert:
 *   - parser extracts the right bytes
 *   - measurement comparison passes when teeProfile matches
 *   - measurement comparison fails when MRTD differs
 *   - report_data binding (replay mitigation) fails when expected mismatches
 *   - dcap-qvl hook is dispatched and its result propagates
 *
 * No live Intel PCCS — dcapQvlVerify is a stub.
 */

import { describe, it, expect } from "vitest";
import {
  parseTdxQuote,
  verifyTdxQuote,
} from "../tdx-verifier.js";
import type { TeeProfile } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Fixture: synthesize a minimum-size TDX v4 quote with known bytes
// ---------------------------------------------------------------------------

const MRTD_HEX = "a".repeat(96); // 48 bytes hex
const RTMR0_HEX = "b".repeat(96);
const RTMR1_HEX = "c".repeat(96);
const RTMR2_HEX = "d".repeat(96);
const RTMR3_HEX = "e".repeat(96);
const REPORT_DATA_HEX = "f".repeat(128); // 64 bytes hex

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
}

function makeTdxQuoteV4(opts?: {
  mrTd?: string;
  rtmr0?: string;
  rtmr1?: string;
  rtmr2?: string;
  rtmr3?: string;
  reportData?: string;
  version?: number;
}): string {
  // Buffer layout: 48 header + 584 body + 100 sig = 732 bytes
  const totalLen = 48 + 584 + 100;
  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);

  // Header: version (u16 LE)
  dv.setUint16(0, opts?.version ?? 4, true);
  // ak_type
  dv.setUint16(2, 2, true);
  // tee_type
  dv.setUint32(4, 0x81, true);
  // qe_vendor_id at offset 12 (16 bytes) — leave zero

  // Body starts at offset 48
  // mr_td at offset 48 + 128 = 176, length 48
  const mrTd = hexToBytes(opts?.mrTd ?? MRTD_HEX);
  buf.set(mrTd, 176);

  // rtmr_0..3 at offset 48 + 320 = 368, length 48 each
  const r0 = hexToBytes(opts?.rtmr0 ?? RTMR0_HEX);
  const r1 = hexToBytes(opts?.rtmr1 ?? RTMR1_HEX);
  const r2 = hexToBytes(opts?.rtmr2 ?? RTMR2_HEX);
  const r3 = hexToBytes(opts?.rtmr3 ?? RTMR3_HEX);
  buf.set(r0, 368);
  buf.set(r1, 368 + 48);
  buf.set(r2, 368 + 96);
  buf.set(r3, 368 + 144);

  // report_data at offset 48 + 512 = 560, length 64
  const rd = hexToBytes(opts?.reportData ?? REPORT_DATA_HEX);
  buf.set(rd, 560);

  return bytesToBase64(buf);
}

const baseProfile: TeeProfile = {
  vendor: "intel-tdx",
  expectedMeasurement: MRTD_HEX,
  quoteFormat: "tdx-v4",
};

const baseProfileWithRtmr: TeeProfile = {
  ...baseProfile,
  expectedRtmr: [RTMR0_HEX, RTMR1_HEX, RTMR2_HEX, RTMR3_HEX],
};

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parseTdxQuote", () => {
  it("parses a well-formed v4 quote", () => {
    const q = makeTdxQuoteV4();
    const parsed = parseTdxQuote(q);
    expect(parsed.shapeValid).toBe(true);
    expect(parsed.headerVersion).toBe(4);
    expect(parsed.quoteFormat).toBe("tdx-v4");
    expect(parsed.mrTd).toBe(MRTD_HEX);
    expect(parsed.rtmr0).toBe(RTMR0_HEX);
    expect(parsed.rtmr1).toBe(RTMR1_HEX);
    expect(parsed.rtmr2).toBe(RTMR2_HEX);
    expect(parsed.rtmr3).toBe(RTMR3_HEX);
    expect(parsed.reportData).toBe(REPORT_DATA_HEX);
  });

  it("rejects a too-short quote", () => {
    const small = bytesToBase64(new Uint8Array(100));
    const parsed = parseTdxQuote(small);
    expect(parsed.shapeValid).toBe(false);
    expect(parsed.shapeError).toMatch(/too short/);
  });

  it("rejects an unknown header version", () => {
    const q = makeTdxQuoteV4({ version: 99 });
    const parsed = parseTdxQuote(q);
    expect(parsed.shapeValid).toBe(false);
    expect(parsed.shapeError).toMatch(/header version 99/);
  });

  it("rejects invalid base64 cleanly", () => {
    const parsed = parseTdxQuote("not-valid-base64-!@#");
    // base64 may decode garbage; the length check or version catch it
    expect(parsed.shapeValid).toBe(false);
  });

  it("supports v5", () => {
    const q = makeTdxQuoteV4({ version: 5 });
    const parsed = parseTdxQuote(q);
    expect(parsed.shapeValid).toBe(true);
    expect(parsed.headerVersion).toBe(5);
    expect(parsed.quoteFormat).toBe("tdx-v5");
  });
});

// ---------------------------------------------------------------------------
// Verifier tests
// ---------------------------------------------------------------------------

describe("verifyTdxQuote — happy path", () => {
  it("MRTD match + dcap-qvl pass + report_data match → valid", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX, {
      dcapQvlVerify: async () => ({ valid: true }),
    });
    expect(res.valid).toBe(true);
    expect(res.certChainValid).toBe(true);
    expect(res.measurementMatch).toBe(true);
    expect(res.measurements.vendor).toBe("intel-tdx");
    expect(res.measurements.observedMeasurement).toBe(MRTD_HEX);
    expect(res.measurements.reportData).toBe(REPORT_DATA_HEX);
  });

  it("RTMR-match profile + matching RTMRs → valid", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfileWithRtmr, REPORT_DATA_HEX, {
      dcapQvlVerify: async () => ({ valid: true }),
    });
    expect(res.valid).toBe(true);
    expect(res.measurements.observedRtmr).toEqual([
      RTMR0_HEX,
      RTMR1_HEX,
      RTMR2_HEX,
      RTMR3_HEX,
    ]);
  });

  it("acceptUnverifiedInTest path works without a dcap-qvl hook", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(true);
    expect(res.certChainValid).toBe(true);
  });
});

describe("verifyTdxQuote — failures", () => {
  it("MRTD mismatch → invalid with reason", async () => {
    const q = makeTdxQuoteV4({ mrTd: "1".repeat(96) });
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(false);
    expect(res.measurementMatch).toBe(false);
    expect(res.reason).toMatch(/MRTD mismatch/);
  });

  it("RTMR mismatch → invalid", async () => {
    const q = makeTdxQuoteV4({ rtmr0: "1".repeat(96) });
    const res = await verifyTdxQuote(q, baseProfileWithRtmr, REPORT_DATA_HEX, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/RTMR mismatch/);
  });

  it("report_data mismatch → invalid (replay mitigation)", async () => {
    const q = makeTdxQuoteV4();
    const wrongExpected = "0".repeat(128);
    const res = await verifyTdxQuote(q, baseProfile, wrongExpected, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/report_data mismatch/);
  });

  it("dcap-qvl returns invalid → invalid with cert chain reason", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX, {
      dcapQvlVerify: async () => ({ valid: false, reason: "PCK cert expired" }),
    });
    expect(res.valid).toBe(false);
    expect(res.certChainValid).toBe(false);
    expect(res.reason).toMatch(/PCK cert expired/);
  });

  it("no dcap-qvl backend wired AND not test-mode → invalid", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX);
    expect(res.valid).toBe(false);
    expect(res.certChainValid).toBe(false);
    expect(res.reason).toMatch(/no dcap-qvl backend wired/);
  });

  it("malformed quote (too short) → invalid with shape error", async () => {
    const bad = bytesToBase64(new Uint8Array(50));
    const res = await verifyTdxQuote(bad, baseProfile, REPORT_DATA_HEX, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/quote parse failed/);
  });

  it("dcap-qvl hook throws → caught + reported", async () => {
    const q = makeTdxQuoteV4();
    const res = await verifyTdxQuote(q, baseProfile, REPORT_DATA_HEX, {
      dcapQvlVerify: async () => {
        throw new Error("intel pccs unreachable");
      },
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/intel pccs unreachable/);
  });
});

describe("verifyTdxQuote — case insensitivity on measurements", () => {
  it("UPPER vs lower MRTD still matches", async () => {
    const q = makeTdxQuoteV4();
    const profileUpper: TeeProfile = {
      vendor: "intel-tdx",
      expectedMeasurement: MRTD_HEX.toUpperCase(),
      quoteFormat: "tdx-v4",
    };
    const res = await verifyTdxQuote(q, profileUpper, REPORT_DATA_HEX, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(true);
  });
});
