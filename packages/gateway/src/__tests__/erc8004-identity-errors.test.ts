import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeContract: vi.fn(), waitForTransactionReceipt: vi.fn(), parseEventLogs: vi.fn(),
}));

vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ waitForTransactionReceipt: mocks.waitForTransactionReceipt }),
  createWalletClient: () => ({ writeContract: mocks.writeContract, account: { address: "0x1234567890123456789012345678901234567890" } }),
  parseEventLogs: mocks.parseEventLogs,
}));

import {
  getIdentityRegistryAddress, getIdentityWriteSigner, registerAgentOnChain,
  resetClientsForTest, setAgentWalletOnChain,
} from "../services/erc8004-identity-write.js";

const ENV_KEYS = ["PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "IDENTITY_REGISTRY_ADDRESS", "IDENTITY_REGISTRY_CHAIN_ID"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const KEY = `0x${"1".repeat(64)}` as `0x${string}`;
const HASH = `0x${"2".repeat(64)}` as `0x${string}`;
const REGISTER = { agentDid: "did:pcc:typed-failure", agentUrl: "https://example.invalid" };
const WALLET = { agentId: 1n, newWallet: "0x1234567890123456789012345678901234567890" as `0x${string}`, newWalletPrivateKey: KEY };

beforeEach(() => {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  resetClientsForTest();
  vi.clearAllMocks();
  mocks.writeContract.mockResolvedValue(HASH);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });
  mocks.parseEventLogs.mockReturnValue([{ args: { agentId: 1n } }]);
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
  resetClientsForTest();
});

describe("identity helper's own failures carry closed codes", () => {
  it.each(["register", "setAgentWallet"])("%s reports disabled by code", async (operation) => {
    await expect(operation === "register" ? registerAgentOnChain(REGISTER) : setAgentWalletOnChain(WALLET))
      .rejects.toMatchObject({ code: "identity_write_disabled" });
  });

  it("reports an invalid registry override by code", () => {
    process.env.IDENTITY_REGISTRY_ADDRESS = "https://rpc.example.invalid/v2/CANARY-rpc-key-7f3a";
    expect(() => getIdentityRegistryAddress()).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("reports an unknown registry chain by code", () => {
    process.env.IDENTITY_REGISTRY_CHAIN_ID = "123456";
    expect(() => getIdentityRegistryAddress()).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("reports invalid signer configuration by code", () => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = "CANARY-rpc-key-7f3a";
    expect(() => getIdentityWriteSigner()).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it.each(["register", "setAgentWallet"])("%s preserves invalid-key code instead of treating it as disabled", async (operation) => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = "CANARY-rpc-key-7f3a";
    await expect(operation === "register" ? registerAgentOnChain(REGISTER) : setAgentWalletOnChain(WALLET))
      .rejects.toMatchObject({ code: "config_invalid" });
  });

  it("reports an invalid capability hash by code before broadcasting", async () => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = KEY;
    await expect(registerAgentOnChain({ ...REGISTER, capabilityHash: "0xshort" }))
      .rejects.toMatchObject({ code: "config_invalid" });
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it.each(["register", "setAgentWallet"])("%s reports a reverted receipt by code", async (operation) => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = KEY;
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    await expect(operation === "register" ? registerAgentOnChain(REGISTER) : setAgentWalletOnChain(WALLET))
      .rejects.toMatchObject({ code: "tx_reverted" });
  });

  it("reports a missing Registered event by code", async () => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = KEY;
    mocks.parseEventLogs.mockReturnValue([]);
    await expect(registerAgentOnChain(REGISTER)).rejects.toMatchObject({ code: "tx_missing_event" });
  });
});
