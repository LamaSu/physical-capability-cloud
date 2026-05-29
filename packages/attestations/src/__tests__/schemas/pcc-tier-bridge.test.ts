import { describe, it, expect } from "vitest";
import {
  PCC_BRIDGE_TIER_SCHEMA,
  PCC_BRIDGE_TIER_SCHEMA_UID,
  toPCCBridgeTierFields,
} from "../../schemas/pcc-tier-bridge.js";
import {
  encodeSchemaData,
  decodeSchemaData,
  parseSchemaString,
} from "../../schema-registry.js";

describe("pcc-tier-bridge schema", () => {
  it("schema string parses into 3 fields", () => {
    const fields = parseSchemaString(PCC_BRIDGE_TIER_SCHEMA);
    expect(fields).toEqual([
      { type: "address", name: "bridgeMaintainer" },
      { type: "uint8", name: "tier" },
      { type: "bytes32", name: "evidenceCID" },
    ]);
  });

  it("schema UID is a 32-byte hex string", () => {
    expect(PCC_BRIDGE_TIER_SCHEMA_UID).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("encodes + decodes a valid payload (roundtrip)", () => {
    const data = {
      bridgeMaintainer:
        "0x1111111111111111111111111111111111111111" as `0x${string}`,
      tier: 2 as const,
      evidenceCID: ("0x" + "ab".repeat(32)) as `0x${string}`,
    };
    const encoded = encodeSchemaData(
      PCC_BRIDGE_TIER_SCHEMA,
      toPCCBridgeTierFields(data),
    );
    const decoded = decodeSchemaData(PCC_BRIDGE_TIER_SCHEMA, encoded);
    expect(decoded.bridgeMaintainer).toBe(data.bridgeMaintainer);
    expect(decoded.tier).toBe(2);
    expect(decoded.evidenceCID).toBe(data.evidenceCID);
  });

  it("rejects an out-of-range tier", () => {
    expect(() =>
      toPCCBridgeTierFields({
        bridgeMaintainer:
          "0x1111111111111111111111111111111111111111" as `0x${string}`,
        // @ts-expect-error — testing runtime validation
        tier: 9,
        evidenceCID: ("0x" + "00".repeat(32)) as `0x${string}`,
      }),
    ).toThrow(/tier must be 0\.\.3/);
  });
});
