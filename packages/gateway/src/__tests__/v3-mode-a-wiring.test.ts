/**
 * Tests for the V3 Mode-A (payer-approval, oracle-free) settlement wiring —
 * the gateway-side additions that route settlement through the deployed
 * PCCProtocolV3 factory + MilestoneEscrowV3 when PCC_USE_V3_MODE_A=true.
 *
 * Covers (all pure / mocked — NO live chain, NO live oracle):
 *   1. PCCProtocolV3FactoryABI exposes createEscrowV3 with the V1/V2-compatible
 *      (payer, arbiter, token, cwmId) shape — calldata round-trips.
 *   2. EscrowCreated decodes with `escrow` as the first indexed param (topics[1]) —
 *      the receipt-parsing contract createEscrowV3 relies on.
 *   3. V3 escrow-client write fns (approveAndReleaseV3 / submitEvidenceV3) dispatch
 *      the correct V3 ABI function + args, proven by spying on writeContract.
 *   4. createEscrowV3 writes the factory then returns the EscrowCreated address.
 *   5. createJobFromSession Mode-A path: with PCC_USE_V3_MODE_A=true it selects the
 *      V3 factory + createEscrowV3, adds the milestone, then approves + funds the
 *      escrow upfront (the Mode-A "funded on create" contract).
 *   6. chain-config resolves milestoneEscrowFactoryV3 for base-sepolia.
 *
 * These lock in the branch-by-abstraction contract: the V3 Mode-A helpers are
 * additive and route to the V3 stack, leaving the V1/V2 helpers untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeFunctionData,
  decodeFunctionData,
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { MilestoneEscrowV3ABI } from "@pcc/contracts/abi";
import { getContractAddress } from "@pcc/contracts";
import { PCCProtocolV3FactoryABI } from "../contracts/escrow-client.js";

/**
 * Assert the dispatched ABI is the V3 escrow ABI. Reference equality (toBe)
 * against the imported MilestoneEscrowV3ABI won't hold — the escrow-client is
 * dynamically re-imported after vi.resetModules(), so it holds a SEPARATE module
 * instance of the same ABI. Instead we check for a V3-ONLY member
 * (`approveAndRelease`, the Mode-A payer release) that V1/V2 escrow ABIs lack —
 * a stable, semantic discriminator.
 */
function expectV3Abi(abi: unknown): void {
  expect(Array.isArray(abi)).toBe(true);
  const names = (abi as Array<{ name?: string }>).map((e) => e.name);
  expect(names).toContain("approveAndRelease");
  // Sanity: the canonical import also has it (guards against the marker moving).
  expect(
    (MilestoneEscrowV3ABI as ReadonlyArray<{ name?: string }>).some(
      (e) => e.name === "approveAndRelease",
    ),
  ).toBe(true);
}

// ===========================================================================
// 1 & 2 — PCCProtocolV3 factory ABI: createEscrowV3 + EscrowCreated
// ===========================================================================

describe("PCCProtocolV3 factory ABI (Mode-A escrow factory)", () => {
  it("createEscrowV3 has the (payer, arbiter, token, cwmId) signature", () => {
    const payer = ("0x" + "11".repeat(20)) as Hex;
    const arbiter = ("0x" + "22".repeat(20)) as Hex;
    const token = ("0x" + "33".repeat(20)) as Hex;
    const cwmId = ("0x" + "44".repeat(32)) as Hex;

    const data = encodeFunctionData({
      abi: PCCProtocolV3FactoryABI,
      functionName: "createEscrowV3",
      args: [payer, arbiter, token, cwmId],
    });

    const decoded = decodeFunctionData({ abi: PCCProtocolV3FactoryABI, data });
    expect(decoded.functionName).toBe("createEscrowV3");
    expect(decoded.args).toEqual([payer, arbiter, token, cwmId]);
  });

  it("EscrowCreated decodes with `escrow` as the first indexed param (topics[1])", () => {
    const escrow = ("0x" + "ab".repeat(20)) as Hex;
    const payer = ("0x" + "cd".repeat(20)) as Hex;
    const arbiter = ("0x" + "ef".repeat(20)) as Hex;
    const token = ("0x" + "12".repeat(20)) as Hex;
    const cwmId = ("0x" + "34".repeat(32)) as Hex;

    const topics = encodeEventTopics({
      abi: PCCProtocolV3FactoryABI,
      eventName: "EscrowCreated",
      args: { escrow, payer, arbiter },
    });
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [token, cwmId],
    );

    const decoded = decodeEventLog({
      abi: PCCProtocolV3FactoryABI,
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    expect(decoded.eventName).toBe("EscrowCreated");
    const args = decoded.args as Record<string, unknown>;
    expect((args.escrow as string).toLowerCase()).toBe(escrow.toLowerCase());
    expect((args.payer as string).toLowerCase()).toBe(payer.toLowerCase());
  });
});

// ===========================================================================
// 3 & 4 — V3 escrow-client write fns dispatch the right V3 ABI function
// ===========================================================================

describe("escrow-client V3 write dispatch (mocked wallet)", () => {
  const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const FACTORY = ("0x" + "7e".repeat(20)) as `0x${string}`;
  const NEW_ESCROW = ("0x" + "5e".repeat(20)) as `0x${string}`;
  const HASH = ("0x" + "bc".repeat(32)) as `0x${string}`;
  const ORIG_PK = process.env.PCC_GATEWAY_PRIVATE_KEY;

  const writeContract = vi.fn().mockResolvedValue("0x" + "f".repeat(64));
  const waitForTransactionReceipt = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    waitForTransactionReceipt.mockReset();
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    // EscrowCreated receipt whose decode yields NEW_ESCROW.
    const receiptTopics = encodeEventTopics({
      abi: PCCProtocolV3FactoryABI,
      eventName: "EscrowCreated",
      args: {
        escrow: NEW_ESCROW,
        payer: ("0x" + "00".repeat(20)) as Hex,
        arbiter: ("0x" + "00".repeat(20)) as Hex,
      },
    });
    const receiptData = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [("0x" + "33".repeat(20)) as Hex, ("0x" + "00".repeat(32)) as Hex],
    );
    waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [{ topics: receiptTopics, data: receiptData, address: NEW_ESCROW }],
    });

    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ waitForTransactionReceipt }),
      };
    });
  });

  afterEach(() => {
    if (ORIG_PK === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG_PK;
    vi.doUnmock("viem");
  });

  it("approveAndReleaseV3 calls approveAndRelease(uint256) on the V3 ABI", async () => {
    const { approveAndReleaseV3 } = await import("../contracts/escrow-client.js");
    await approveAndReleaseV3(0, ESCROW);

    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("approveAndRelease");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([0n]);
    expectV3Abi(call.abi);
  });

  it("submitEvidenceV3 calls submitEvidence(uint256, bytes32) on the V3 ABI", async () => {
    const { submitEvidenceV3 } = await import("../contracts/escrow-client.js");
    await submitEvidenceV3(0, HASH, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitEvidence");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([0n, HASH]);
    expectV3Abi(call.abi);
  });

  it("createEscrowV3 writes the factory then returns the EscrowCreated address", async () => {
    const { createEscrowV3 } = await import("../contracts/escrow-client.js");
    const payer = ("0x" + "11".repeat(20)) as `0x${string}`;
    const token = ("0x" + "33".repeat(20)) as `0x${string}`;
    const cwmId = ("0x" + "44".repeat(32)) as `0x${string}`;

    const addr = await createEscrowV3(payer, payer, token, cwmId, FACTORY);

    // Wrote createEscrowV3 to the factory.
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("createEscrowV3");
    expect(call.address).toBe(FACTORY);
    expect(call.args).toEqual([payer, payer, token, cwmId]);
    // Returned the decoded escrow address from the EscrowCreated log.
    expect(addr.toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
  });
});

// ===========================================================================
// 5 — createJobFromSession Mode-A path: V3 factory + createEscrowV3, then
// addMilestone + approve + fund (the "funded on create" Mode-A contract).
// ===========================================================================

describe("createJobFromSession V3 Mode-A on-chain wiring (mocked wallet, real store)", () => {
  const BASE_SEPOLIA_MOCK_USDC = "0x18bef3dee9f4f97f7cec16db0c4a0a930f478470";
  const FACTORY_V3 = "0x786e85b17b288115e2f9230868e0bc94cbff5534";
  const NEW_ESCROW = ("0x" + "5e".repeat(20)) as `0x${string}`;

  const ORIG = {
    pk: process.env.PCC_GATEWAY_PRIVATE_KEY,
    mock: process.env.MOCK_SETTLEMENT,
    v3: process.env.PCC_USE_V3_MODE_A,
    v2: process.env.PCC_USE_EAS_V2,
    net: process.env.PCC_NETWORK,
    env: process.env.MOCK_USDC_ADDRESS,
    db: process.env.PCC_DB_PATH,
  };

  const writeContract = vi.fn().mockResolvedValue("0x" + "a".repeat(64));
  const waitForTransactionReceipt = vi.fn();
  const getTransactionCount = vi.fn().mockResolvedValue(5);
  const readContract = vi.fn().mockResolvedValue(1n);

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    waitForTransactionReceipt.mockReset();
    getTransactionCount.mockClear();
    readContract.mockClear();

    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.MOCK_SETTLEMENT = "false"; // exercise the REAL on-chain branch
    process.env.PCC_USE_V3_MODE_A = "true"; // V3 Mode-A path
    delete process.env.PCC_USE_EAS_V2; // ensure only the V3 branch is exercised
    process.env.PCC_NETWORK = "base-sepolia";
    delete process.env.MOCK_USDC_ADDRESS; // use chain-config token
    process.env.PCC_DB_PATH = ":memory:";

    // EscrowCreated receipt whose decode yields NEW_ESCROW. addMilestone / approve /
    // fund receipts just need status:"success".
    const receiptTopics = encodeEventTopics({
      abi: PCCProtocolV3FactoryABI,
      eventName: "EscrowCreated",
      args: {
        escrow: NEW_ESCROW,
        payer: ("0x" + "00".repeat(20)) as Hex,
        arbiter: ("0x" + "00".repeat(20)) as Hex,
      },
    });
    const receiptData = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [BASE_SEPOLIA_MOCK_USDC as Hex, ("0x" + "00".repeat(32)) as Hex],
    );
    waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [{ topics: receiptTopics, data: receiptData, address: NEW_ESCROW }],
    });

    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ waitForTransactionReceipt, getTransactionCount, readContract }),
      };
    });

    vi.doMock("../services/kernel-service.js", () => ({
      getKernelService: vi.fn().mockReturnValue({ config: { kernelId: "kernel-test-v3" } }),
      initKernelService: vi.fn(),
      resetKernelService: vi.fn(),
    }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      PCC_GATEWAY_PRIVATE_KEY: ORIG.pk,
      MOCK_SETTLEMENT: ORIG.mock,
      PCC_USE_V3_MODE_A: ORIG.v3,
      PCC_USE_EAS_V2: ORIG.v2,
      PCC_NETWORK: ORIG.net,
      MOCK_USDC_ADDRESS: ORIG.env,
      PCC_DB_PATH: ORIG.db,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.doUnmock("viem");
    vi.doUnmock("../services/kernel-service.js");
  });

  it("selects the V3 factory + createEscrowV3, then addMilestone + approve + fund", { timeout: 15000 }, async () => {
    const { initStore, closeStore } = await import("../db.js");
    initStore({ seed: true });
    try {
      const { createJobFromSession } = await import("../routes/paid-job-flow.js");

      const session = {
        id: "sess-v3-modea",
        status: "committed",
        userAgentId: "0x" + "11".repeat(20),
        kernelId: "kernel-nyc",
        capabilityType: "liquid-handler",
        capabilityId: null,
        network: null,
        selections: {},
        operatorConstraints: {},
        scheduling: {},
        quote: { totalPrice: "10.00", currency: "USDC", bondAmount: "0.00" },
        contractTerms: {
          milestones: [
            { stepId: "step-aaa", amount: "10.00", bondAmount: "0.00", challengeWindowSeconds: 0 },
          ],
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
          assuranceTier: 0,
        },
        jobId: "job-v3-modea",
        escrowAddress: null,
        cwmId: "cwm-v3-modea",
        transitions: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        committedAt: new Date().toISOString(),
      } as any;

      const result = await createJobFromSession(session);
      expect(result.escrowAddress.toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
      // Mode A funds upfront -> escrow status is "funded", not "created".
      expect(result.escrowStatus).toBe("funded");

      // First on-chain write = createEscrowV3 targeting the V3 factory with the
      // chain-config token.
      const createCall = writeContract.mock.calls.find(
        (c) => c[0].functionName === "createEscrowV3",
      );
      expect(createCall).toBeDefined();
      expect((createCall![0].address as string).toLowerCase()).toBe(FACTORY_V3);
      // args: [payer, arbiter, token, cwmId] — payer == arbiter == gateway signer.
      expect((createCall![0].args[2] as string).toLowerCase()).toBe(
        BASE_SEPOLIA_MOCK_USDC.toLowerCase(),
      );
      expect((createCall![0].args[0] as string)).toBe(createCall![0].args[1]);

      // addMilestone on the new escrow (V2 ABI, 7-arg).
      const addCall = writeContract.mock.calls.find(
        (c) => c[0].functionName === "addMilestone",
      );
      expect(addCall).toBeDefined();
      expect((addCall![0].address as string).toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
      expect(addCall![0].args).toHaveLength(7);
      expect(addCall![0].args[6]).toBe("job-v3-modea");

      // approve (MockUSDC) then fund (V3 escrow) — the upfront-funding Mode-A step.
      const approveCall = writeContract.mock.calls.find((c) => c[0].functionName === "approve");
      expect(approveCall).toBeDefined();
      // approve target = the new escrow; amount = 10 USDC (6dp).
      expect((approveCall![0].args[0] as string).toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
      expect(approveCall![0].args[1]).toBe(10_000_000n);

      const fundCall = writeContract.mock.calls.find((c) => c[0].functionName === "fund");
      expect(fundCall).toBeDefined();
      expect((fundCall![0].address as string).toLowerCase()).toBe(NEW_ESCROW.toLowerCase());

      // Ordering: create -> addMilestone -> approve -> fund.
      const idx = (fn: string) => writeContract.mock.calls.findIndex((c) => c[0].functionName === fn);
      expect(idx("createEscrowV3")).toBeLessThan(idx("addMilestone"));
      expect(idx("addMilestone")).toBeLessThan(idx("approve"));
      expect(idx("approve")).toBeLessThan(idx("fund"));

      // The V1/V2 factory functions were NOT used (branch isolation).
      expect(writeContract.mock.calls.some((c) => c[0].functionName === "createEscrowV2")).toBe(false);
      expect(writeContract.mock.calls.some((c) => c[0].functionName === "createEscrow")).toBe(false);
    } finally {
      closeStore();
    }
  });
});

// ===========================================================================
// 6 — chain-config resolves the V3 factory for base-sepolia.
// ===========================================================================

describe("chain-config milestoneEscrowFactoryV3", () => {
  it("getContractAddress resolves the deployed V3 factory for base-sepolia", () => {
    const addr = getContractAddress("base-sepolia", "milestoneEscrowFactoryV3");
    expect(addr.toLowerCase()).toBe("0x786e85b17b288115e2f9230868e0bc94cbff5534");
  });
});
