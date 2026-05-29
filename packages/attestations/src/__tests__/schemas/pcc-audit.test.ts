import { describe, it, expect } from "vitest";
import {
  PCC_AUDIT_SCHEMA,
  PCC_AUDIT_SCHEMA_UID,
  toPCCAuditFields,
} from "../../schemas/pcc-audit.js";
import {
  encodeSchemaData,
  decodeSchemaData,
  parseSchemaString,
} from "../../schema-registry.js";

describe("pcc-audit schema", () => {
  it("schema string parses into 4 fields", () => {
    const fields = parseSchemaString(PCC_AUDIT_SCHEMA);
    expect(fields).toEqual([
      { type: "bytes32", name: "auditedBridgeNamespace" },
      { type: "bytes32", name: "auditReportCID" },
      { type: "uint8", name: "score" },
      { type: "string", name: "auditorOrg" },
    ]);
  });

  it("schema UID is a 32-byte hex string", () => {
    expect(PCC_AUDIT_SCHEMA_UID).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("encodes + decodes a valid payload (roundtrip)", () => {
    const data = {
      auditedBridgeNamespace: ("0x" + "11".repeat(32)) as `0x${string}`,
      auditReportCID: ("0x" + "22".repeat(32)) as `0x${string}`,
      score: 87,
      auditorOrg: "Trail of Bits",
    };
    const encoded = encodeSchemaData(PCC_AUDIT_SCHEMA, toPCCAuditFields(data));
    const decoded = decodeSchemaData(PCC_AUDIT_SCHEMA, encoded);
    expect(decoded.auditedBridgeNamespace).toBe(data.auditedBridgeNamespace);
    expect(decoded.auditReportCID).toBe(data.auditReportCID);
    expect(decoded.score).toBe(87);
    expect(decoded.auditorOrg).toBe("Trail of Bits");
  });

  it("rejects a score above 100", () => {
    expect(() =>
      toPCCAuditFields({
        auditedBridgeNamespace: ("0x" + "00".repeat(32)) as `0x${string}`,
        auditReportCID: ("0x" + "00".repeat(32)) as `0x${string}`,
        score: 101,
        auditorOrg: "x",
      }),
    ).toThrow(/score must be 0\.\.100/);
  });

  it("rejects an empty auditorOrg", () => {
    expect(() =>
      toPCCAuditFields({
        auditedBridgeNamespace: ("0x" + "00".repeat(32)) as `0x${string}`,
        auditReportCID: ("0x" + "00".repeat(32)) as `0x${string}`,
        score: 50,
        auditorOrg: "",
      }),
    ).toThrow(/non-empty/);
  });
});
