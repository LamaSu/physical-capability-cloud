/**
 * Unit tests for submitAttestationV2 (escrow-client.ts).
 *
 * Mocks ONLY:
 *   - viem  (createPublicClient, createWalletClient)
 *   - viem/accounts  (privateKeyToAccount)
 *   - @pcc/contracts  (ABI re-exports, getDeployment, getContractAddress)
 *
 * The REAL submitAttestationV2 source is under test. oracle-client is NOT
 * mocked here — escrow-client does not import it.
 *
 * The escrow-client module caches wallet/public clients as module-level
 * singletons. vi.resetModules() is called in beforeEach so each test gets
 * a fresh module instance and a fresh createWalletClient call.
 *
 * Asserts:
 *   - writeContract is called with functionName "submitAttestation"
 *   - args[0] === BigInt(milestoneIndex)
 *   - args[1] === easUid
 *   - address === contractAddress passed to submitAttestationV2
 *   - abi is MilestoneEscrowV2ABI (checked via the mock)
 *
 * Authored by: test-writer-hotel (split from eas-attestation-bridge.test.ts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by vitest — must be at module top level)
// We use factory functions that read from the module registry at call-time.
// ---------------------------------------------------------------------------

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      readContract: vi.fn(),
      getBalance: vi.fn(),
    }),
    createWalletClient: vi.fn().mockReturnValue({
      writeContract: vi.fn().mockResolvedValue("0xhash_v2_attest"),
    }),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: "0xGATEWAY" as `0x${string}`,
  }),
}));

// Mock @pcc/contracts so we don't need a full monorepo build during test.
// MilestoneEscrowV2ABI just needs to be a distinct value the test can check.
const MOCK_V2_ABI = [{ name: "submitAttestation", type: "function" }] as const;

vi.mock("@pcc/contracts", () => ({
  MilestoneEscrowABI: [],
  MilestoneEscrowV2ABI: MOCK_V2_ABI,
  MockUSDCABI: [],
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
  getDeployment: vi.fn().mockImplementation(() => {
    throw new Error("no deployment in test");
  }),
  getContractAddress: vi.fn().mockImplementation(() => {
    throw new Error("no contract in test");
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitAttestationV2 — escrow-client", () => {
  beforeEach(() => {
    // Reset modules so the escrow-client singleton (_walletClient) is cleared
    // between tests. Without this, createWalletClient is only called once
    // and subsequent tests miss the spy.
    vi.resetModules();

    // Re-apply mocks after resetModules (vi.mock calls are always re-hoisted
    // per file but the mock implementations need to be consistent with the
    // module reset).
    vi.mock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn(),
          getBalance: vi.fn(),
        }),
        createWalletClient: vi.fn().mockReturnValue({
          writeContract: vi.fn().mockResolvedValue("0xhash_v2_attest"),
        }),
      };
    });

    vi.mock("viem/accounts", () => ({
      privateKeyToAccount: vi.fn().mockReturnValue({
        address: "0xGATEWAY" as `0x${string}`,
      }),
    }));

    vi.mock("@pcc/contracts", () => ({
      MilestoneEscrowABI: [],
      MilestoneEscrowV2ABI: MOCK_V2_ABI,
      MockUSDCABI: [],
      MilestoneStatus: {},
      milestoneStatusName: vi.fn().mockReturnValue("unknown"),
      getDeployment: vi.fn().mockImplementation(() => {
        throw new Error("no deployment in test");
      }),
      getContractAddress: vi.fn().mockImplementation(() => {
        throw new Error("no contract in test");
      }),
    }));

    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.ESCROW_CONTRACT_ADDRESS = "0xEscrowV2Address";
  });

  it("calls writeContract with submitAttestation functionName, milestoneIndex BigInt, and easUid", async () => {
    // Dynamic import after resetModules ensures fresh singleton state
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");
    const { createWalletClient } = await import("viem");

    const milestoneIndex = 0;
    const easUid = "0xeasuiddeadbeef" as `0x${string}`;
    const escrowAddr = "0xEscrowV2Address" as `0x${string}`;

    await submitAttestationV2(milestoneIndex, easUid, escrowAddr);

    // createWalletClient is called lazily on first write operation
    const walletMockFn = createWalletClient as ReturnType<typeof vi.fn>;
    expect(walletMockFn).toHaveBeenCalled();

    const walletInstance = walletMockFn.mock.results[0].value;
    expect(walletInstance.writeContract).toHaveBeenCalledOnce();

    const callArgs = walletInstance.writeContract.mock.calls[0][0];
    expect(callArgs.functionName).toBe("submitAttestation");
    expect(callArgs.args[0]).toBe(BigInt(milestoneIndex));
    expect(callArgs.args[1]).toBe(easUid);
    expect(callArgs.address).toBe(escrowAddr);
  });

  it("uses MilestoneEscrowV2ABI (not V1) when calling writeContract", async () => {
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");
    const { createWalletClient } = await import("viem");

    const easUid = "0xeasuid_v2_abi_check" as `0x${string}`;
    await submitAttestationV2(0, easUid, "0xEscrowV2Address" as `0x${string}`);

    const walletMockFn = createWalletClient as ReturnType<typeof vi.fn>;
    const walletInstance = walletMockFn.mock.results[0].value;
    const callArgs = walletInstance.writeContract.mock.calls[0][0];

    // The ABI passed must be the V2 ABI (our mock value)
    expect(callArgs.abi).toBe(MOCK_V2_ABI);
  });

  it("returns transactionHash and status submitted", async () => {
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");

    const result = await submitAttestationV2(
      1,
      "0xeasuid_return_check" as `0x${string}`,
      "0xEscrowV2Address" as `0x${string}`,
    );

    expect(result.transactionHash).toBe("0xhash_v2_attest");
    expect(result.status).toBe("submitted");
  });
});
