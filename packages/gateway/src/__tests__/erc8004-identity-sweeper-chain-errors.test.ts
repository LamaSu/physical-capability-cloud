import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionExecutionError, HttpRequestError } from "viem";
import { closeStore, getRepos, initStore } from "../db.js";

const { mockRegisterAgentOnChain, mockIsIdentityWriteEnabled } = vi.hoisted(() => ({
  mockRegisterAgentOnChain: vi.fn(),
  mockIsIdentityWriteEnabled: vi.fn(),
}));

vi.mock("../services/erc8004-identity-write.js", () => ({
  registerAgentOnChain: mockRegisterAgentOnChain,
  isIdentityWriteEnabled: mockIsIdentityWriteEnabled,
}));

import {
  runSweep,
  startIdentitySweeper,
  stopIdentitySweeper,
} from "../services/erc8004-identity-sweeper.js";

const CANARY = "CANARY-rpc-key-7f3a";
const RPC_URL = `https://rpc.example.invalid/v2/${CANARY}`;
const KEY_ID = "sweeper-chain-error-key";

function rpcError(wrapped: boolean) {
  const http = new HttpRequestError({
    url: RPC_URL,
    status: 401,
    body: { method: "eth_sendRawTransaction" },
  });
  return wrapped
    ? new ContractFunctionExecutionError(http, {
      abi: [],
      functionName: "register",
      contractAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    })
    : http;
}

describe("ERC-8004 sweeper uses only closed error codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", ":memory:");
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    initStore({ seed: false });
    getRepos().apiKeys.insert({
      id: KEY_ID,
      keyHash: "sweeper-chain-error-hash",
      keyPrefix: "pcc_live_test",
      operatorId: "sweeper-chain-error-operator",
      scopes: '["*"]',
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    stopIdentitySweeper();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeStore();
  });

  it.each([false, true])("stores a code for a real viem HTTP error (wrapped=%s)", async (wrapped) => {
    const error = rpcError(wrapped);
    expect(error.message).toContain(CANARY);
    mockRegisterAgentOnChain.mockRejectedValue(error);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runSweep({
      batchSize: 5,
      gatewayUrl: "https://capability.network",
      logger,
    });

    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    const stored = getRepos().apiKeys.findById(KEY_ID);
    expect.soft(stored?.onchainStatus).toBe("pending");
    expect.soft(stored?.onchainError).toBe("rpc_unavailable");
    expect.soft(JSON.stringify(stored)).not.toContain(CANARY);
    expect.soft(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain(CANARY);
    expect.soft(logger.warn).toHaveBeenCalledWith({ keyId: KEY_ID, code: "rpc_unavailable" }, "retry failed");
  });

  it("logs a code when the scheduled sweep itself rejects", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ERC8004_SWEEPER_DISABLED", "false");
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    const error = rpcError(false);
    expect(error.message).toContain(CANARY);
    vi.spyOn(getRepos().apiKeys, "listPendingOnchain").mockImplementation(() => { throw error; });
    const logger = { info: vi.fn(), warn: vi.fn() };

    startIdentitySweeper({ intervalMs: 10, batchSize: 5, logger });
    await vi.advanceTimersByTimeAsync(10);

    expect.soft(logger.warn).toHaveBeenCalledTimes(1);
    expect.soft(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain(CANARY);
    expect.soft(logger.warn).toHaveBeenCalledWith({ code: "rpc_unavailable" }, "sweep error");
  });
});
