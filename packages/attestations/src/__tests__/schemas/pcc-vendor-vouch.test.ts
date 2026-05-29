import { describe, it, expect } from "vitest";
import {
  PCC_VENDOR_VOUCH_SCHEMA,
  PCC_VENDOR_VOUCH_SCHEMA_UID,
  toPCCVendorVouchFields,
} from "../../schemas/pcc-vendor-vouch.js";
import {
  encodeSchemaData,
  decodeSchemaData,
  parseSchemaString,
} from "../../schema-registry.js";
import { ZERO_ADDRESS } from "../../constants.js";

describe("pcc-vendor-vouch schema", () => {
  it("schema string parses into 4 fields", () => {
    const fields = parseSchemaString(PCC_VENDOR_VOUCH_SCHEMA);
    expect(fields).toEqual([
      { type: "address", name: "voucher" },
      { type: "address", name: "vouched" },
      { type: "uint8", name: "confidence" },
      { type: "string", name: "note" },
    ]);
  });

  it("schema UID is a 32-byte hex string", () => {
    expect(PCC_VENDOR_VOUCH_SCHEMA_UID).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("encodes + decodes a valid payload (roundtrip)", () => {
    const data = {
      voucher: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      vouched: "0x2222222222222222222222222222222222222222" as `0x${string}`,
      confidence: 85,
      note: "Integrated 5 times — solid",
    };
    const encoded = encodeSchemaData(
      PCC_VENDOR_VOUCH_SCHEMA,
      toPCCVendorVouchFields(data),
    );
    const decoded = decodeSchemaData(PCC_VENDOR_VOUCH_SCHEMA, encoded);
    expect(decoded.voucher).toBe(data.voucher);
    expect(decoded.vouched).toBe(data.vouched);
    expect(decoded.confidence).toBe(85);
    expect(decoded.note).toBe(data.note);
  });

  it("permits an empty note", () => {
    const data = {
      voucher: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      vouched: "0x2222222222222222222222222222222222222222" as `0x${string}`,
      confidence: 10,
      note: "",
    };
    expect(() => toPCCVendorVouchFields(data)).not.toThrow();
  });

  it("rejects self-vouching", () => {
    expect(() =>
      toPCCVendorVouchFields({
        voucher: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        vouched: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        confidence: 100,
        note: "I vouch for myself",
      }),
    ).toThrow(/Self-vouching/);
  });

  it("rejects vouching for the zero address", () => {
    expect(() =>
      toPCCVendorVouchFields({
        voucher: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        vouched: ZERO_ADDRESS,
        confidence: 50,
        note: "x",
      }),
    ).toThrow(/zero address/);
  });

  it("rejects confidence above 100", () => {
    expect(() =>
      toPCCVendorVouchFields({
        voucher: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        vouched: "0x2222222222222222222222222222222222222222" as `0x${string}`,
        confidence: 150,
        note: "x",
      }),
    ).toThrow(/Confidence must be 0\.\.100/);
  });
});
