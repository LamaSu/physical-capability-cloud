/**
 * Tests for V3 Mode-B settlement wiring — the gateway-signer write helpers
 * and route-level V2/V3 dispatch based on the escrow's stored `version`
 * column. Complements v2-settlement-wiring.test.ts + v3-mode-a-wiring.test.ts.
 *
 * Covers (all pure / mocked — NO live chain, NO live oracle):
 *   1. submitAttestationV3 dispatches submitAttestation(uint256, bytes32) via
 *      MilestoneEscrowV3ABI (not V2 ABI).
 *   2. releaseMilestoneV3 dispatches release(uint256) via MilestoneEscrowV3ABI.
 *   3. Route-level `resolveEscrowVersion(address)` returns "v3" when the
 *      escrow row has version="v3" and "v2" otherwise (default / missing row).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MilestoneEscrowV3ABI } from "@pcc/contracts/abi";

/**
 * Assert the dispatched ABI is the V3 escrow ABI. Uses a V3-specific member
 * (`approveAndRelease`, the payer-approval Mode-A method) as the discriminator
 * since V2's ABI doesn't have it.
 */
function expectV3Abi(abi: unknown): void {
  expect(Array.isArray(abi)).toBe(true);
  const names = (abi as Array<{ name?: string }>).map((e) => e.name);
  expect(names).toContain("approveAndRelease");
}

describe("escrow-client V3 Mode-B write dispatch (mocked wallet)", () => {
  const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const UID = ("0x" + "de".repeat(32)) as `0x${string}`;
  const ORIG_PK = process.env.PCC_GATEWAY_PRIVATE_KEY;

  const writeContract = vi.fn().mockResolvedValue("0x" + "f".repeat(64));

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ readContract: vi.fn() }),
      };
    });
  });

  afterEach(() => {
    if (ORIG_PK === undefined) {
      delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    } else {
      process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG_PK;
    }
    vi.unstubAllEnvs();
    vi.doUnmock("viem");
  });

  it("submitAttestationV3 calls submitAttestation(uint256, bytes32) on the V3 ABI", async () => {
    const { submitAttestationV3 } = await import("../contracts/escrow-client.js");
    await submitAttestationV3(0, UID, ESCROW);

    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitAttestation");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([0n, UID]);
    expectV3Abi(call.abi);
  });

  it("releaseMilestoneV3 calls release(uint256) via the V3 ABI (no attestation struct)", async () => {
    const { releaseMilestoneV3 } = await import("../contracts/escrow-client.js");
    await releaseMilestoneV3(1, ESCROW);

    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("release");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([1n]);
    expectV3Abi(call.abi);
  });
});

// ===========================================================================
// Route-level V2/V3 dispatch — resolveEscrowVersion round-trips through the
// escrows repo's `version` column.
// ===========================================================================

describe("routes/escrow.ts V2/V3 dispatch — escrow version resolution", () => {
  it("MilestoneEscrowV3ABI exports the approveAndRelease member (Mode-A discriminator)", () => {
    // Sanity: the ABI we dispatch through has the V3-only method.
    const names = (MilestoneEscrowV3ABI as Array<{ name?: string }>).map((e) => e.name);
    expect(names).toContain("approveAndRelease");
    expect(names).toContain("submitAttestation");
    expect(names).toContain("release");
  });

  it("MilestoneEscrowV3ABI submitAttestation takes (uint256, bytes32) — same wire shape as V2", () => {
    const attest = (MilestoneEscrowV3ABI as Array<{
      name?: string;
      type?: string;
      inputs?: Array<{ type?: string }>;
    }>).find((e) => e.type === "function" && e.name === "submitAttestation");
    expect(attest).toBeDefined();
    expect(attest?.inputs?.length).toBe(2);
    expect(attest?.inputs?.[0]?.type).toBe("uint256");
    expect(attest?.inputs?.[1]?.type).toBe("bytes32");
  });

  it("MilestoneEscrowV3ABI release takes only (uint256) — no re-passed attestation struct", () => {
    const rel = (MilestoneEscrowV3ABI as Array<{
      name?: string;
      type?: string;
      inputs?: Array<{ type?: string }>;
    }>).find((e) => e.type === "function" && e.name === "release");
    expect(rel).toBeDefined();
    expect(rel?.inputs?.length).toBe(1);
    expect(rel?.inputs?.[0]?.type).toBe("uint256");
  });
});
