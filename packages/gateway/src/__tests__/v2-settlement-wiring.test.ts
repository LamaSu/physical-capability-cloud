/**
 * Tests for the FULL V2 (EAS) settlement wiring — the gateway-side additions
 * that complete the MilestoneEscrowV2 path beyond the original EAS bridge.
 *
 * Covers (all pure / mocked — NO live chain, NO live oracle):
 *   1. PCCProtocolV2 ABI exposes createEscrowV2 with the V1-compatible shape
 *      (payer, arbiter, token, cwmId) — calldata round-trips.
 *   2. EscrowCreated event decodes with `escrow` as the first indexed param
 *      (the receipt-parsing contract for per-job escrow creation).
 *   3. V2 escrow-client write fns (submitEvidenceV2/submitAttestationV2/
 *      releaseMilestoneV2) dispatch the correct V2 ABI function + args, proven
 *      by spying on the viem wallet client's writeContract.
 *   4. Oracle client V2 round-trip: a request with mintEasAttestation:true gets a
 *      mock easAttestation.easUid back (the field the gateway previously dropped).
 *
 * These lock in the branch-by-abstraction contract: the V2 helpers are additive
 * and route to the V2 ABI, leaving the V1 helpers untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeFunctionData,
  decodeFunctionData,
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toBytes,
  parseUnits,
  formatUnits,
  isAddress,
  defineChain,
  decodeAbiParameters,
  http,
  type Hex,
} from "viem";
import { PCCProtocolV2ABI, MilestoneEscrowV2ABI } from "@pcc/contracts/abi";

/**
 * Assert the dispatched ABI is the V2 escrow ABI. We can't use reference
 * equality (toBe) against the imported MilestoneEscrowV2ABI: the escrow-client
 * is dynamically re-imported after vi.resetModules(), so it holds a SEPARATE
 * module instance of the same ABI. Instead we check for a V2-ONLY member
 * (`attestationUsed`, the single-use UID guard) that V1's MilestoneEscrowABI
 * does not have — a stable, semantic discriminator.
 */
function expectV2Abi(abi: unknown): void {
  expect(Array.isArray(abi)).toBe(true);
  const names = (abi as Array<{ name?: string }>).map((e) => e.name);
  expect(names).toContain("attestationUsed");
  // Sanity: the canonical import also has it (guards against the marker moving).
  expect((MilestoneEscrowV2ABI as ReadonlyArray<{ name?: string }>).some((e) => e.name === "attestationUsed")).toBe(true);
}

// ===========================================================================
// 1 & 2 — PCCProtocolV2 ABI: createEscrowV2 + EscrowCreated
// ===========================================================================

describe("PCCProtocolV2 ABI (per-job escrow factory)", () => {
  it("createEscrowV2 has the V1-compatible (payer, arbiter, token, cwmId) signature", () => {
    const payer = ("0x" + "11".repeat(20)) as Hex;
    const arbiter = ("0x" + "22".repeat(20)) as Hex;
    const token = ("0x" + "33".repeat(20)) as Hex;
    const cwmId = ("0x" + "44".repeat(32)) as Hex;

    const data = encodeFunctionData({
      abi: PCCProtocolV2ABI,
      functionName: "createEscrowV2",
      args: [payer, arbiter, token, cwmId],
    });

    const decoded = decodeFunctionData({ abi: PCCProtocolV2ABI, data });
    expect(decoded.functionName).toBe("createEscrowV2");
    expect(decoded.args).toEqual([payer, arbiter, token, cwmId]);
  });

  it("EscrowCreated decodes with `escrow` as the first indexed param (topics[1])", () => {
    const escrow = ("0x" + "ab".repeat(20)) as Hex;
    const payer = ("0x" + "cd".repeat(20)) as Hex;
    const arbiter = ("0x" + "ef".repeat(20)) as Hex;
    const token = ("0x" + "12".repeat(20)) as Hex;
    const cwmId = ("0x" + "34".repeat(32)) as Hex;

    // Build the indexed topics exactly as a node would emit them.
    const topics = encodeEventTopics({
      abi: PCCProtocolV2ABI,
      eventName: "EscrowCreated",
      args: { escrow, payer, arbiter },
    });
    // Non-indexed args (token, cwmId) live in `data`, ABI-encoded in order.
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [token, cwmId],
    );

    const decoded = decodeEventLog({
      abi: PCCProtocolV2ABI,
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    expect(decoded.eventName).toBe("EscrowCreated");
    const args = decoded.args as Record<string, unknown>;
    // The escrow address is recoverable (the receipt-parsing contract).
    expect((args.escrow as string).toLowerCase()).toBe(escrow.toLowerCase());
    expect((args.payer as string).toLowerCase()).toBe(payer.toLowerCase());
  });
});

// ===========================================================================
// 3 — V2 escrow-client write fns dispatch the right V2 ABI function
// ===========================================================================

describe("escrow-client V2 write dispatch (mocked wallet)", () => {
  const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const HASH = ("0x" + "bc".repeat(32)) as `0x${string}`;
  const UID = ("0x" + "de".repeat(32)) as `0x${string}`;
  const ORIG_PK = process.env.PCC_GATEWAY_PRIVATE_KEY;

  // Capture writeContract calls.
  const writeContract = vi.fn().mockResolvedValue("0x" + "f".repeat(64));

  beforeEach(() => {
    vi.resetModules();
    writeContract.mockClear();
    // A real-looking key so isWriteEnabled() is true + getAccount() works.
    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    // Mock viem so the wallet client's writeContract is our spy, but keep the
    // real encoders (encodeFunctionData etc.) intact. getTransactionCount is now
    // required: every escrow write routes through the per-signer NonceManager,
    // which reads the pending nonce once and pins it explicitly (P2-SCALE).
    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({
          readContract: vi.fn(),
          getTransactionCount: vi.fn().mockResolvedValue(11),
        }),
      };
    });
  });

  afterEach(() => {
    if (ORIG_PK === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG_PK;
    vi.doUnmock("viem");
  });

  it("submitEvidenceV2 calls submitEvidence on the V2 ABI", async () => {
    const { submitEvidenceV2 } = await import("../contracts/escrow-client.js");
    await submitEvidenceV2(2, HASH, ESCROW);

    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitEvidence");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([2n, HASH]);
    expectV2Abi(call.abi);
  });

  it("submitAttestationV2 calls submitAttestation(uint256, bytes32 easUid) on the V2 ABI", async () => {
    const { submitAttestationV2 } = await import("../contracts/escrow-client.js");
    await submitAttestationV2(0, UID, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("submitAttestation");
    expect(call.args).toEqual([0n, UID]);
    expectV2Abi(call.abi);
  });

  it("releaseMilestoneV2 calls release(uint256) with ONLY the index (no struct)", async () => {
    const { releaseMilestoneV2 } = await import("../contracts/escrow-client.js");
    await releaseMilestoneV2(1, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("release");
    expect(call.args).toEqual([1n]);
    expectV2Abi(call.abi);
  });

  it("addMilestoneV2 calls addMilestone(...) with the 7-arg V2 signature", async () => {
    const { addMilestoneV2 } = await import("../contracts/escrow-client.js");
    const STEP = ("0x" + "11".repeat(32)) as `0x${string}`;
    const OPERATOR = ("0x" + "22".repeat(20)) as `0x${string}`;
    await addMilestoneV2(
      {
        stepId: STEP,
        operator: OPERATOR,
        amount: 10_000_000n, // 10 USDC (6dp)
        operatorBond: 0n,
        challengeWindowSeconds: 0,
        requiredTier: 0,
        jobId: "job-abc",
      },
      ESCROW,
    );

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("addMilestone");
    expect(call.address).toBe(ESCROW);
    // bytes32 stepId, address operator, amount, bond, windowSecs, tier, jobId
    expect(call.args).toEqual([STEP, OPERATOR, 10_000_000n, 0n, 0n, 0, "job-abc"]);
    expectV2Abi(call.abi);
  });

  it("fundEscrowV2 calls fund() on the V2 ABI", async () => {
    const { fundEscrowV2 } = await import("../contracts/escrow-client.js");
    await fundEscrowV2(ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("fund");
    expect(call.address).toBe(ESCROW);
    expect(call.args).toEqual([]);
    expectV2Abi(call.abi);
  });

  it("depositBondV2 calls depositBond(uint256) on the V2 ABI", async () => {
    const { depositBondV2 } = await import("../contracts/escrow-client.js");
    await depositBondV2(3, ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("depositBond");
    expect(call.args).toEqual([3n]);
    expectV2Abi(call.abi);
  });

  it("fileDisputeV2 calls fileDispute(uint256,uint256,bytes32,string) on the V2 ABI", async () => {
    const { fileDisputeV2 } = await import("../contracts/escrow-client.js");
    await fileDisputeV2(0, "5.00", HASH, "bad print", ESCROW);

    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("fileDispute");
    // bond "5.00" -> 5_000_000n (6dp)
    expect(call.args).toEqual([0n, 5_000_000n, HASH, "bad print"]);
    expectV2Abi(call.abi);
  });

  it("pins an explicit nonce from the NonceManager on every write (P2-SCALE)", async () => {
    const { submitAttestationV2, releaseMilestoneV2 } = await import(
      "../contracts/escrow-client.js"
    );
    // First write seeds from getTransactionCount() -> 11, second is monotonic (12).
    await submitAttestationV2(0, UID, ESCROW);
    await releaseMilestoneV2(1, ESCROW);

    expect(writeContract.mock.calls[0][0].nonce).toBe(11);
    expect(writeContract.mock.calls[1][0].nonce).toBe(12);
  });
});

// ===========================================================================
// 5 — V2 escrow-client READ fns dispatch the right V2 ABI function
// ===========================================================================

describe("escrow-client V2 read dispatch (mocked public client)", () => {
  const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;

  // Capture readContract calls. getEscrowStateV2 reads 7 scalars + N milestones;
  // we return shaped values per-function so the shaping code doesn't throw.
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "payer":
      case "arbiter":
      case "token":
        return "0x" + "00".repeat(20);
      case "cwmId":
        return "0x" + "00".repeat(32);
      case "funded":
        return false;
      case "totalAmount":
        return 0n;
      case "getMilestoneCount":
        return 0n; // no milestones -> no getMilestone calls, keeps the read simple
      case "getDispute":
        return {
          challenger: "0x" + "00".repeat(20),
          challengerBond: 0n,
          challengerEvidenceHash: "0x" + "00".repeat(32),
          reason: "",
          resolved: false,
          challengerWon: false,
        };
      default:
        return 0n;
    }
  });

  const getContractEvents = vi.fn(async () => [] as unknown[]);

  beforeEach(() => {
    vi.resetModules();
    readContract.mockClear();
    getContractEvents.mockClear();
    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createPublicClient: () => ({ readContract, getContractEvents }),
        createWalletClient: () => ({ writeContract: vi.fn() }),
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("viem");
  });

  it("getEscrowStateV2 reads scalars via the V2 ABI (getMilestoneCount on V2 ABI)", async () => {
    const { getEscrowStateV2 } = await import("../contracts/escrow-client.js");
    const state = await getEscrowStateV2(ESCROW);
    expect(state.address).toBe(ESCROW);
    expect(state.milestoneCount).toBe(0);
    // Every scalar read must have used the V2 ABI.
    const countCall = readContract.mock.calls.find((c) => c[0].functionName === "getMilestoneCount");
    expect(countCall).toBeDefined();
    expectV2Abi(countCall![0].abi);
  });

  it("getDisputeV2 reads getDispute via the V2 ABI", async () => {
    const { getDisputeV2 } = await import("../contracts/escrow-client.js");
    await getDisputeV2(0, ESCROW);
    const call = readContract.mock.calls.find((c) => c[0].functionName === "getDispute");
    expect(call).toBeDefined();
    expect(call![0].args).toEqual([0n]);
    expectV2Abi(call![0].abi);
  });

  it("getEventsV2 reads contract events via the V2 ABI", async () => {
    const { getEventsV2 } = await import("../contracts/escrow-client.js");
    await getEventsV2(ESCROW);
    expect(getContractEvents).toHaveBeenCalledTimes(1);
    expectV2Abi(getContractEvents.mock.calls[0][0].abi);
  });
});

// ===========================================================================
// 6 — Token resolution: chain-config FIRST, MOCK_USDC_ADDRESS env fallback only.
//
// Regression guard for the live-smoke step-2 stall: the escrow was minted with
// _token = 0x5f2eb54d… (the Flow-EVM mockUSDC, leaked into MOCK_USDC_ADDRESS on
// a base-sepolia deployment) while the payer holds its balance in base-sepolia's
// chain-config mockUSDC 0x18bef3…. fund() then reverts. The resolver must prefer
// chain-config for a deployed network and only fall back to env where the
// network has no chain-config token (e.g. localhost forge deploys).
// ===========================================================================

describe("escrow-client resolveMockUSDCAddress (token precedence)", () => {
  const BASE_SEPOLIA_MOCK_USDC = "0x18bef3dee9f4f97f7cec16db0c4a0a930f478470";
  const FLOW_MOCK_USDC = "0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9";
  const ORIG_ENV = process.env.MOCK_USDC_ADDRESS;
  const ORIG_NET = process.env.PCC_NETWORK;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.MOCK_USDC_ADDRESS;
    else process.env.MOCK_USDC_ADDRESS = ORIG_ENV;
    if (ORIG_NET === undefined) delete process.env.PCC_NETWORK;
    else process.env.PCC_NETWORK = ORIG_NET;
  });

  it("prefers chain-config mockUSDC for base-sepolia EVEN when MOCK_USDC_ADDRESS env is the Flow token", async () => {
    // The exact polluted-env condition from the live smoke.
    process.env.MOCK_USDC_ADDRESS = FLOW_MOCK_USDC;
    const { resolveMockUSDCAddress } = await import("../contracts/escrow-client.js");
    const token = resolveMockUSDCAddress("base-sepolia");
    expect(token?.toLowerCase()).toBe(BASE_SEPOLIA_MOCK_USDC.toLowerCase());
    // NOT the Flow token the payer holds 0 of.
    expect(token?.toLowerCase()).not.toBe(FLOW_MOCK_USDC.toLowerCase());
  });

  it("returns chain-config mockUSDC for base-sepolia when env is unset", async () => {
    delete process.env.MOCK_USDC_ADDRESS;
    const { resolveMockUSDCAddress } = await import("../contracts/escrow-client.js");
    expect(resolveMockUSDCAddress("base-sepolia")?.toLowerCase()).toBe(
      BASE_SEPOLIA_MOCK_USDC.toLowerCase(),
    );
  });

  it("falls back to MOCK_USDC_ADDRESS env for localhost (no chain-config token)", async () => {
    const LOCAL_TOKEN = "0x1111111111111111111111111111111111111111";
    process.env.MOCK_USDC_ADDRESS = LOCAL_TOKEN;
    const { resolveMockUSDCAddress } = await import("../contracts/escrow-client.js");
    // localhost chain-config has mockUSDC: undefined -> env fallback.
    expect(resolveMockUSDCAddress("localhost")?.toLowerCase()).toBe(LOCAL_TOKEN.toLowerCase());
  });

  it("returns undefined for localhost when neither chain-config nor env has a token", async () => {
    delete process.env.MOCK_USDC_ADDRESS;
    const { resolveMockUSDCAddress } = await import("../contracts/escrow-client.js");
    expect(resolveMockUSDCAddress("localhost")).toBeUndefined();
  });

  it("flow-evm-testnet resolves its OWN chain-config token (the Flow one), not base-sepolia's", async () => {
    delete process.env.MOCK_USDC_ADDRESS;
    const { resolveMockUSDCAddress } = await import("../contracts/escrow-client.js");
    // Proves the resolver is network-parameterized, not globally pinned.
    expect(resolveMockUSDCAddress("flow-evm-testnet")?.toLowerCase()).toBe(
      FLOW_MOCK_USDC.toLowerCase(),
    );
  });
});

// ===========================================================================
// 7 — createJobFromSession real-settlement V2 path: createEscrowV2 with the
// chain-config token, THEN addMilestone (the smoke's step-1→step-2 fix).
//
// Drives the actual SUT (paid-job-flow.createJobFromSession) with the real
// in-memory store + a viem wallet spy. Asserts the on-chain call sequence the
// smoke needs: createEscrowV2(payer, arbiter, CHAIN-CONFIG-token, cwmId) →
// addMilestone(...) on the new escrow, so /state reads milestoneCount>=1 and
// the escrow's token == the one the payer holds.
// ===========================================================================

describe("createJobFromSession V2 on-chain wiring (mocked wallet, real store)", () => {
  const BASE_SEPOLIA_MOCK_USDC = "0x18bef3dee9f4f97f7cec16db0c4a0a930f478470";
  const FLOW_MOCK_USDC = "0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9";
  const NEW_ESCROW = ("0x" + "5e".repeat(20)) as `0x${string}`;

  const ORIG = {
    pk: process.env.PCC_GATEWAY_PRIVATE_KEY,
    mock: process.env.MOCK_SETTLEMENT,
    v2: process.env.PCC_USE_EAS_V2,
    net: process.env.PCC_NETWORK,
    env: process.env.MOCK_USDC_ADDRESS,
    db: process.env.PCC_DB_PATH,
  };

  // Capture all on-chain writes in order.
  const writeContract = vi.fn().mockResolvedValue("0x" + "a".repeat(64));
  // EscrowCreated receipt: `escrow` is the first indexed topic. We feed a log
  // whose decode yields NEW_ESCROW so extractEscrowCreatedAddress returns it.
  const waitForTransactionReceipt = vi.fn();
  // P0-1: createJobFromSession now pins explicit nonces (getTransactionCount) and
  // verifies milestones landed on-chain (readContract -> getMilestoneCount). Mock
  // both so the public client exposes the methods the new sequencing logic calls.
  const getTransactionCount = vi.fn().mockResolvedValue(5);
  const readContract = vi.fn().mockResolvedValue(1n); // getMilestoneCount >= the 1 milestone

  beforeEach(async () => {
    vi.resetModules();
    writeContract.mockClear();
    waitForTransactionReceipt.mockReset();
    getTransactionCount.mockClear();
    readContract.mockClear();

    process.env.PCC_GATEWAY_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.MOCK_SETTLEMENT = "false"; // exercise the REAL on-chain branch
    process.env.PCC_USE_EAS_V2 = "true"; // V2 (createEscrowV2 + addMilestone)
    process.env.PCC_NETWORK = "base-sepolia";
    // Polluted env: the Flow token. The fix must IGNORE this in favor of
    // chain-config for base-sepolia.
    process.env.MOCK_USDC_ADDRESS = FLOW_MOCK_USDC;
    process.env.PCC_DB_PATH = ":memory:";

    // Build receipt data using the REAL viem (from the top-level static import).
    // These values are captured before the mock below replaces the viem registry
    // entry — the top-level bindings are live ESM references that aren't affected
    // by vi.resetModules() or vi.doMock.
    const receiptTopics = encodeEventTopics({
      abi: PCCProtocolV2ABI,
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
      status: "success", // P0-1: addMilestone now asserts receipt.status === "success"
      logs: [{ topics: receiptTopics, data: receiptData, address: NEW_ESCROW }],
    });

    // Mock viem using the same async importOriginal pattern that the escrow-client
    // tests use. importOriginal returns the REAL viem module (resolved by Vitest
    // before the mock takes effect), so callers that need real implementations
    // (chain-config.js → defineChain, escrow-client.ts → encodeFunctionData, etc.)
    // all get working functions. Only createWalletClient and createPublicClient are
    // replaced with spies that return our pre-wired mock clients.
    vi.doMock("viem", async (importOriginal) => {
      const actual = await importOriginal<typeof import("viem")>();
      return {
        ...actual,
        createWalletClient: () => ({ writeContract }),
        createPublicClient: () => ({ waitForTransactionReceipt, getTransactionCount, readContract }),
      };
    });

    // Stub getKernelService so paid-job-flow.createJobFromSession can resolve
    // the local kernel ID without depending on the real kernel-service singleton.
    // This prevents the "Not initialised" CI failure (module isolation: paid-job-
    // flow's static import of kernel-service resolves a DIFFERENT module instance
    // than the one an earlier test file may have initialized). Each test gets a
    // clean stub with a kernel ID, so no cross-test state leaks either.
    vi.doMock("../services/kernel-service.js", () => ({
      getKernelService: vi.fn().mockReturnValue({ config: { kernelId: "kernel-test-v2" } }),
      initKernelService: vi.fn(),
      resetKernelService: vi.fn(),
    }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      PCC_GATEWAY_PRIVATE_KEY: ORIG.pk,
      MOCK_SETTLEMENT: ORIG.mock,
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

  it("createEscrowV2 uses the chain-config token (0x18bef3…), NOT the Flow env token, then addMilestone", { timeout: 15000 }, async () => {
    const { initStore, closeStore } = await import("../db.js");
    initStore({ seed: true });
    try {
      const { createJobFromSession } = await import("../routes/paid-job-flow.js");

      // Minimal committed session row (the shape createJobFromSession reads).
      const session = {
        id: "sess-v2-token",
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
        jobId: "job-v2-token",
        escrowAddress: null,
        cwmId: "cwm-v2-token",
        transitions: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        committedAt: new Date().toISOString(),
      } as any;

      const result = await createJobFromSession(session);
      // Address compare is checksum-case-insensitive (viem returns EIP-55 mixed
      // case from decodeEventLog; the literal is lowercase).
      expect(result.escrowAddress.toLowerCase()).toBe(NEW_ESCROW.toLowerCase());

      // First write = createEscrowV2 carrying the CHAIN-CONFIG token.
      const createCall = writeContract.mock.calls.find(
        (c) => c[0].functionName === "createEscrowV2",
      );
      expect(createCall).toBeDefined();
      // args: [payer, arbiter, token, cwmId]
      const tokenArg = (createCall![0].args[2] as string).toLowerCase();
      expect(tokenArg).toBe(BASE_SEPOLIA_MOCK_USDC.toLowerCase());
      expect(tokenArg).not.toBe(FLOW_MOCK_USDC.toLowerCase());

      // A subsequent write = addMilestone on the new escrow (the step-2 fix:
      // an empty escrow's fund() reverts "No milestones").
      const addCall = writeContract.mock.calls.find(
        (c) => c[0].functionName === "addMilestone",
      );
      expect(addCall).toBeDefined();
      expect((addCall![0].address as string).toLowerCase()).toBe(NEW_ESCROW.toLowerCase());
      // V2 addMilestone is 7-arg: [stepId, operator, amount, bond, window, tier, jobId]
      expect(addCall![0].args).toHaveLength(7);
      expect(addCall![0].args[6]).toBe("job-v2-token");

      // Ordering: createEscrowV2 must come before addMilestone.
      const createIdx = writeContract.mock.calls.findIndex((c) => c[0].functionName === "createEscrowV2");
      const addIdx = writeContract.mock.calls.findIndex((c) => c[0].functionName === "addMilestone");
      expect(createIdx).toBeLessThan(addIdx);
    } finally {
      closeStore();
    }
  });
});

// ===========================================================================
// 4 — Oracle client V2 round-trip (the previously-dropped easAttestation field)
// ===========================================================================

describe("oracle-client V2 EAS fields", () => {
  const ORIG_KEY = process.env.PCC_ORACLE_KEY;

  beforeEach(() => {
    vi.resetModules();
    // No oracle key -> mockVerification path (deterministic, no network).
    delete process.env.PCC_ORACLE_KEY;
  });

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.PCC_ORACLE_KEY;
    else process.env.PCC_ORACLE_KEY = ORIG_KEY;
  });

  it("returns a mock easAttestation.easUid when mintEasAttestation is requested", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle({
      escrowAddress: "0x0000000000000000000000000000000000000000",
      jobId: "job-v2",
      kernelId: "kernel-x",
      evidenceHash: "0x" + "ab".repeat(32),
      assuranceTier: 0,
      chainId: 84532,
      mintEasAttestation: true,
      stepId: "0x" + "cc".repeat(32),
      schemaUid: "0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93",
    });

    expect(res.result.verified).toBe(true);
    expect(res.easAttestation).not.toBeNull();
    expect(res.easAttestation?.easUid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.easAttestation?.schemaUid).toBe(
      "0x5acb07db80019928f2aa8798cb0bebaee46a863f28d4b5aaf5a9e04902be8b93",
    );
  });

  it("returns easAttestation:null on the V1 path (no minting requested)", async () => {
    const { verifyWithOracle } = await import("../services/oracle-client.js");
    const res = await verifyWithOracle({
      escrowAddress: "0x0000000000000000000000000000000000000000",
      jobId: "job-v1",
      kernelId: "kernel-x",
      evidenceHash: "0x" + "ab".repeat(32),
      assuranceTier: 0,
      chainId: 84532,
    });

    expect(res.attestation).not.toBeNull();
    expect(res.easAttestation ?? null).toBeNull();
  });
});
