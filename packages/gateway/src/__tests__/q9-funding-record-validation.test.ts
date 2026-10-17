import { describe, expect, it } from "vitest";
import { isWellFormedFundingRecord, type FundingVerificationRecord } from "../services/funding-record-port.js";

const valid = (): FundingVerificationRecord => ({
  scopeId: "scope_validation",
  escrowAddress: "0x" + "a1".repeat(20),
  buyer: "0x" + "b2".repeat(20),
  operator: "0x" + "c3".repeat(20),
  chainId: 84532,
  blockNumber: "100",
  blockHash: "0x" + "d4".repeat(32),
  fundingBlockNumber: "99",
  fundingBlockHash: "0x" + "e5".repeat(32),
  fundedAt: 1791460800,
  verifierVersion: "verifier-validation/1",
  verifiedAt: "2026-10-08T12:00:00.000Z",
  finality: "finalized",
});

describe("Q9 funding record validator", () => {
  const nearMisses: Record<string, unknown[]> = {
    operator: [undefined, null, 1, "", "0x" + "a".repeat(39), "0x" + "a".repeat(41), "0x" + "a".repeat(39) + "g"],
    fundingBlockNumber: [undefined, null, 99, "", "-1", "+1", " 1", "1 ", "01", "1.0", "1e1", "18446744073709551616", "9".repeat(21)],
    fundingBlockHash: [undefined, null, 1, "", "0x" + "a".repeat(63), "0x" + "a".repeat(65), "0x" + "a".repeat(63) + "g"],
    fundedAt: [undefined, null, "1", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1],
  };
  for (const [field, values] of Object.entries(nearMisses)) {
    it(`requires a well-formed ${field}`, () => {
      for (const value of values) expect(isWellFormedFundingRecord({ ...valid(), [field]: value }), String(value)).toBe(false);
      const missing: Record<string, unknown> = { ...valid() };
      delete missing[field];
      expect(isWellFormedFundingRecord(missing)).toBe(false);
    });
  }

  for (const field of ["escrowAddress", "buyer", "operator"]) {
    it(`refuses the zero address in ${field}`, () => {
      expect(isWellFormedFundingRecord({ ...valid(), [field]: "0x" + "0".repeat(40) })).toBe(false);
    });
  }

  it("refuses noncanonical read-block decimal spellings even when the funding block is zero", () => {
    for (const blockNumber of ["01", "+1", " 1", "1 ", "-1"]) {
      expect(isWellFormedFundingRecord({ ...valid(), fundingBlockNumber: "0", blockNumber }), blockNumber).toBe(false);
    }
    expect(isWellFormedFundingRecord({ ...valid(), fundingBlockNumber: "0", blockNumber: "1" })).toBe(true);
  });

  it("compares funding and read blocks as BigInts, including above the safe integer range", () => {
    for (const [fundingBlockNumber, blockNumber] of [["10", "9"], ["9007199254740993", "9007199254740992"]]) {
      expect(isWellFormedFundingRecord({ ...valid(), fundingBlockNumber, blockNumber })).toBe(false);
    }
    for (const [fundingBlockNumber, blockNumber] of [["9", "10"], ["9007199254740992", "9007199254740993"], ["18446744073709551615", "18446744073709551615"]]) {
      expect(isWellFormedFundingRecord({ ...valid(), fundingBlockNumber, blockNumber })).toBe(true);
    }
  });

  it("accepts boundary values and either hex letter case", () => {
    expect(isWellFormedFundingRecord(valid())).toBe(true);
    for (const fundingBlockNumber of ["0", "1", "18446744073709551615"]) {
      expect(isWellFormedFundingRecord({ ...valid(), fundingBlockNumber, blockNumber: "18446744073709551615" })).toBe(true);
    }
    for (const fundedAt of [1, Number.MAX_SAFE_INTEGER]) {
      expect(isWellFormedFundingRecord({ ...valid(), fundedAt })).toBe(true);
    }
    expect(isWellFormedFundingRecord({
      ...valid(),
      operator: "0x" + "AB".repeat(20),
      fundingBlockHash: "0x" + "EF".repeat(32),
    })).toBe(true);
    expect(isWellFormedFundingRecord({ ...valid(), operator: "0x" + "0".repeat(39) + "1" })).toBe(true);
  });
});
