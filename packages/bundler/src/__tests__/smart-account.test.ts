import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Address, Hex } from "viem";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Mock permissionless to avoid network calls in tests
// ---------------------------------------------------------------------------

vi.mock("permissionless/accounts", () => ({
  toSimpleSmartAccount: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
    const index = (params.index as bigint) ?? 0n;
    // Simulate CREATE2 determinism: different salt → different address
    // Use inline literal addresses (valid 40-char hex) to avoid hoisting issues
    const address =
      index === 0n
        ? ("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address)
        : ("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12" as Address);
    return {
      getAddress: vi.fn().mockResolvedValue(address),
      signUserOperation: vi.fn().mockResolvedValue("0xsignature"),
      address,
    };
  }),
}));

vi.mock("permissionless", () => ({
  createSmartAccountClient: vi.fn().mockReturnValue({
    sendUserOperation: vi.fn().mockResolvedValue("0xuserophash" as Hex),
  }),
}));

vi.mock("permissionless/clients/pimlico", () => ({
  createPimlicoClient: vi.fn().mockReturnValue({
    getPaymasterData: vi.fn(),
    getPaymasterStubData: vi.fn(),
  }),
}));

// Mock viem's createPublicClient to avoid network calls
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      getCode: vi.fn().mockResolvedValue("0x"),
      getChainId: vi.fn().mockResolvedValue(84532),
      readContract: vi.fn().mockResolvedValue(0n),
      estimateFeesPerGas: vi.fn().mockResolvedValue({
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 100000000n,
      }),
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  SmartAccountClient,
  ENTRY_POINT_V07,
  SIMPLE_ACCOUNT_FACTORY_V07,
  createGaslessClient,
  buildCoinbasePaymasterUrl,
} from "../smart-account.js";
import type { SmartAccountConfig, CoinbasePaymasterConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_BUNDLER_URL = "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=test";
const TEST_RPC_URL = "https://sepolia.base.org";

function makeConfig(overrides: Partial<SmartAccountConfig> = {}): SmartAccountConfig {
  return {
    privateKey: TEST_PRIVATE_KEY,
    implementation: "simple",
    saltNonce: 0n,
    bundler: {
      bundlerUrl: TEST_BUNDLER_URL,
      chain: baseSepolia,
      rpcUrl: TEST_RPC_URL,
      entryPoint: "0.7",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmartAccountClient", () => {
  describe("create()", () => {
    it("creates with valid config", async () => {
      const client = await SmartAccountClient.create(makeConfig());
      expect(client).toBeDefined();
      expect(client.signerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(client.implementation).toBe("simple");
      expect(client.chain).toBe(baseSepolia);
    });

    it("exposes the smart account address as a valid hex address", async () => {
      const client = await SmartAccountClient.create(makeConfig());
      expect(client.smartAccountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("defaults implementation to simple", async () => {
      const config = makeConfig();
      delete (config as any).implementation;
      const client = await SmartAccountClient.create(config);
      expect(client.implementation).toBe("simple");
    });
  });

  describe("encodeExecute()", () => {
    let client: SmartAccountClient;

    beforeEach(async () => {
      client = await SmartAccountClient.create(makeConfig());
    });

    it("produces valid hex calldata", async () => {
      const target = "0x1111111111111111111111111111111111111111" as Address;
      const data = client.encodeExecute(target, 0n, "0x");
      expect(data).toMatch(/^0x[0-9a-fA-F]+$/);
      // execute(address,uint256,bytes) selector = 0xb61d27f6
      expect(data.slice(0, 10)).toBe("0xb61d27f6");
    });

    it("encodes non-zero value", async () => {
      const target = "0x2222222222222222222222222222222222222222" as Address;
      const data = client.encodeExecute(target, 1000000000000000000n, "0x1234");
      expect(data).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(data.length).toBeGreaterThan(10);
    });

    it("encodes calldata with function selector", async () => {
      const target = "0x3333333333333333333333333333333333333333" as Address;
      const innerData = "0xdeadbeef" as Hex;
      const data = client.encodeExecute(target, 0n, innerData);
      // The calldata should be longer than a bare call
      expect(data.length).toBeGreaterThan(74);
    });
  });

  describe("encodeBatch()", () => {
    let client: SmartAccountClient;

    beforeEach(async () => {
      client = await SmartAccountClient.create(makeConfig());
    });

    it("produces valid hex calldata for single-item batch", async () => {
      const calls = [
        {
          target: "0x1111111111111111111111111111111111111111" as Address,
          value: 0n,
          data: "0x" as Hex,
        },
      ];
      const data = client.encodeBatch(calls);
      expect(data).toMatch(/^0x[0-9a-fA-F]+$/);
      // executeBatch(address[],uint256[],bytes[]) — 4-byte selector
      // Actual keccak256("executeBatch(address[],uint256[],bytes[])")[:4] = 0x47e1da2a
      expect(data.slice(0, 10)).toBe("0x47e1da2a");
    });

    it("produces valid calldata for multi-item batch", async () => {
      const calls = [
        {
          target: "0x1111111111111111111111111111111111111111" as Address,
          value: 0n,
          data: "0xdeadbeef" as Hex,
        },
        {
          target: "0x2222222222222222222222222222222222222222" as Address,
          value: 1000n,
          data: "0xcafebabe" as Hex,
        },
        {
          target: "0x3333333333333333333333333333333333333333" as Address,
          value: 0n,
          data: "0x" as Hex,
        },
      ];
      const data = client.encodeBatch(calls);
      expect(data).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(data.slice(0, 10)).toBe("0x47e1da2a");
    });

    it("batch calldata differs from single execute calldata", async () => {
      const target = "0x1111111111111111111111111111111111111111" as Address;
      const execData = client.encodeExecute(target, 0n, "0x");
      const batchData = client.encodeBatch([{ target, value: 0n, data: "0x" }]);
      expect(execData).not.toBe(batchData);
    });
  });

  describe("counterfactual address determinism", () => {
    it("same inputs produce same address", async () => {
      const config = makeConfig({ saltNonce: 0n });
      const client1 = await SmartAccountClient.create(config);
      const client2 = await SmartAccountClient.create(config);
      expect(client1.smartAccountAddress).toBe(client2.smartAccountAddress);
    });

    it("different salt nonce produces different address", async () => {
      const config0 = makeConfig({ saltNonce: 0n });
      const config1 = makeConfig({ saltNonce: 1n });
      const client0 = await SmartAccountClient.create(config0);
      const client1 = await SmartAccountClient.create(config1);
      expect(client0.smartAccountAddress).not.toBe(client1.smartAccountAddress);
    });
  });

  describe("getState()", () => {
    it("returns expected state fields", async () => {
      const client = await SmartAccountClient.create(makeConfig());
      const state = await client.getState();
      expect(state.address).toBe(client.smartAccountAddress);
      expect(state.signerAddress).toBe(client.signerAddress);
      expect(state.implementation).toBe("simple");
      expect(typeof state.deployed).toBe("boolean");
      expect(typeof state.nonce).toBe("bigint");
    });

    it("reports undeployed account when code is 0x", async () => {
      const client = await SmartAccountClient.create(makeConfig());
      const state = await client.getState();
      // Mock returns "0x" for getCode → undeployed
      expect(state.deployed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// PaymasterClient — policy enforcement tests
// ---------------------------------------------------------------------------

import { PaymasterClient } from "../paymaster.js";

describe("PaymasterClient — policy enforcement", () => {
  let paymaster: PaymasterClient;
  const AGENT = "0x1111111111111111111111111111111111111111" as Address;

  beforeEach(() => {
    paymaster = new PaymasterClient({
      url: "https://api.pimlico.io/v2/base-sepolia/rpc?apikey=test",
      mode: "full",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks when daily budget is exhausted", async () => {
    paymaster.setDailyBudget(0n);
    const result = await paymaster.sponsor({}, AGENT);
    expect(result.sponsored).toBe(false);
  });

  it("blocks after rate limit exceeded", async () => {
    paymaster.setRateLimit(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            result: {
              paymasterAndData: "0xdeadbeef",
              verificationGasLimit: "500000",
              maxFeePerGas: "1000000000",
            },
          }),
      }),
    );

    const r1 = await paymaster.sponsor({}, AGENT);
    expect(r1.sponsored).toBe(true);

    const r2 = await paymaster.sponsor({}, AGENT);
    expect(r2.sponsored).toBe(false);
  });

  it("allows after daily reset", async () => {
    paymaster.setDailyBudget(0n);
    let result = await paymaster.sponsor({}, AGENT);
    expect(result.sponsored).toBe(false);

    paymaster.resetDaily();
    paymaster.setDailyBudget(1_000_000_000_000_000_000n);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            result: {
              paymasterAndData: "0xdeadbeef",
              verificationGasLimit: "500000",
              maxFeePerGas: "1000000000",
            },
          }),
      }),
    );

    result = await paymaster.sponsor({}, AGENT);
    expect(result.sponsored).toBe(true);
  });

  it("tracks approved contract count", () => {
    paymaster.approveContract(AGENT);
    expect(paymaster.getStats().approvedContracts).toBe(1);

    paymaster.revokeContract(AGENT);
    expect(paymaster.getStats().approvedContracts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coinbase Paymaster configuration
// ---------------------------------------------------------------------------

describe("Coinbase Paymaster configuration", () => {
  it("builds correct URL for base-sepolia with API key", () => {
    const url = buildCoinbasePaymasterUrl({
      cdpApiKey: "mykey123",
      chain: "base-sepolia",
    });
    expect(url).toBe(
      "https://api.developer.coinbase.com/rpc/v1/base-sepolia/mykey123",
    );
  });

  it("builds correct URL for base mainnet with API key", () => {
    const url = buildCoinbasePaymasterUrl({
      cdpApiKey: "mykey123",
      chain: "base",
    });
    expect(url).toBe(
      "https://api.developer.coinbase.com/rpc/v1/base/mykey123",
    );
  });

  it("uses paymasterBundlerUrl directly when provided", () => {
    const customUrl = "https://custom.paymaster.example.com/rpc";
    const url = buildCoinbasePaymasterUrl({
      paymasterBundlerUrl: customUrl,
      chain: "base-sepolia",
    });
    expect(url).toBe(customUrl);
  });

  it("throws when neither cdpApiKey nor paymasterBundlerUrl provided", () => {
    expect(() =>
      buildCoinbasePaymasterUrl({ chain: "base-sepolia" }),
    ).toThrow();
  });

  it("createGaslessClient builds correct config and delegates to SmartAccountClient.create", async () => {
    // Spy on SmartAccountClient.create to avoid network calls
    // and verify that the correct config is passed
    const createSpy = vi.spyOn(SmartAccountClient, "create").mockResolvedValue({
      signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
      smartAccountAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address,
      implementation: "simple" as const,
      chain: baseSepolia,
      getState: vi.fn(),
      encodeExecute: vi.fn(),
      encodeBatch: vi.fn(),
      encodeOperation: vi.fn(),
      sendUserOp: vi.fn(),
      waitForUserOp: vi.fn(),
    } as unknown as SmartAccountClient);

    const client = await createGaslessClient({
      privateKey: TEST_PRIVATE_KEY,
      coinbaseConfig: {
        cdpApiKey: "test-api-key",
        chain: "base-sepolia",
      },
    });

    expect(createSpy).toHaveBeenCalledOnce();
    const callArgs = createSpy.mock.calls[0][0];

    // Verify the config passed to SmartAccountClient.create
    expect(callArgs.privateKey).toBe(TEST_PRIVATE_KEY);
    expect(callArgs.bundler.bundlerUrl).toContain("coinbase.com");
    expect(callArgs.bundler.bundlerUrl).toContain("test-api-key");
    expect(callArgs.bundler.bundlerUrl).toContain("base-sepolia");
    expect(callArgs.bundler.paymasterUrl).toBe(callArgs.bundler.bundlerUrl);

    createSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("ERC-4337 constants", () => {
  it("EntryPoint v0.7 address is correct", () => {
    expect(ENTRY_POINT_V07).toBe("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
  });

  it("SimpleAccount factory v0.7 address is correct", () => {
    expect(SIMPLE_ACCOUNT_FACTORY_V07).toBe("0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985");
  });
});
