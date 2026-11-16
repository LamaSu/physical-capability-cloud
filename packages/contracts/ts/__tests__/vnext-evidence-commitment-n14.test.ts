/**
 * N14 pins the G2 evidence commitment with the permanent format-1 layout label:
 * packages/contracts/src/libraries/VNextSettlementLib.sol:169 and docs/VNEXT_SETTLEMENT_ABI.md:146.
 * 0xb1391d21... was the retired format-2 value. The oracle confirmed the byte order on bus #2786.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { evidenceCommitment } from "../vnext/compiler.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../gateway/src/__tests__/fixtures/g2-settlement-vector-golden.json", import.meta.url),
    "utf8",
  ),
);
const body = JSON.parse(fixture.jcsBody);
const inputs = {
  chainId: BigInt(body.unitBinding.chainId),
  escrow: body.unitBinding.escrow as Address,
  settlementUnitId: body.unitBinding.settlementUnitId as Hex,
  compositionSchemaVersion: Number(body.compositionSchemaVersion),
  packageDigest: fixture.packageDigestV2 as Hex,
};
const GOLDEN = "0x31e2d4a7d0f62918322c7862c7eb45c1962c4767814302fba9fd4ab38bbe7f24";

describe("N14 evidence commitment: G2 settlement vector", () => {
  it("reproduces the format-1 evidence commitment golden", () => {
    expect(evidenceCommitment(inputs)).toBe(GOLDEN);
  });

  it("changes the commitment when the last packageDigestV2 byte is flipped", () => {
    const lastByte = Number.parseInt(inputs.packageDigest.slice(-2), 16) ^ 0x01;
    const packageDigest = `${inputs.packageDigest.slice(0, -2)}${lastByte.toString(16).padStart(2, "0")}` as Hex;

    expect(evidenceCommitment({ ...inputs, packageDigest })).not.toBe(GOLDEN);
  });
});
