/**
 * Pure-unit tests for the ERC-8004 IdentityRegistry write helper.
 *
 * No vi.mock on the helper module — we test its real env-handling
 * surface directly. The chain is never touched because none of these
 * tests actually call `registerAgentOnChain` against a live RPC.
 */

import { describe, it, expect, beforeEach } from "vitest";

// Capture original env so we can restore between tests.
const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset relevant env vars before each test (other env stays as-is).
  delete process.env.PCC_GATEWAY_PRIVATE_KEY;
  delete process.env.DEPLOYER_PRIVATE_KEY;
  delete process.env.IDENTITY_REGISTRY_ADDRESS;
  delete process.env.IDENTITY_REGISTRY_CHAIN_ID;
});

describe("erc8004-identity-write helper — env handling", () => {
  it("reports write disabled when no private key is set", async () => {
    const mod = await import("../services/erc8004-identity-write.js");
    expect(mod.isIdentityWriteEnabled()).toBe(false);
    expect(mod.getIdentityWriteSigner()).toBeUndefined();
  });

  it("reports write enabled when PCC_GATEWAY_PRIVATE_KEY is set", async () => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = "0x" + "a".repeat(64);
    const mod = await import("../services/erc8004-identity-write.js");
    mod.resetClientsForTest();
    expect(mod.isIdentityWriteEnabled()).toBe(true);
    expect(mod.getIdentityWriteSigner()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("reports write enabled when DEPLOYER_PRIVATE_KEY is the fallback", async () => {
    process.env.DEPLOYER_PRIVATE_KEY = "0x" + "c".repeat(64);
    const mod = await import("../services/erc8004-identity-write.js");
    mod.resetClientsForTest();
    expect(mod.isIdentityWriteEnabled()).toBe(true);
  });

  it("returns the Daydreams default registry address on chain 84532", async () => {
    process.env.IDENTITY_REGISTRY_CHAIN_ID = "84532";
    const mod = await import("../services/erc8004-identity-write.js");
    expect(mod.getIdentityRegistryAddress()).toBe(
      "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );
  });

  it("honors IDENTITY_REGISTRY_ADDRESS override", async () => {
    process.env.IDENTITY_REGISTRY_ADDRESS =
      "0x1234567890123456789012345678901234567890";
    const mod = await import("../services/erc8004-identity-write.js");
    expect(mod.getIdentityRegistryAddress()).toBe(
      "0x1234567890123456789012345678901234567890",
    );
  });

  it("rejects invalid IDENTITY_REGISTRY_ADDRESS", async () => {
    process.env.IDENTITY_REGISTRY_ADDRESS = "not-an-address";
    const mod = await import("../services/erc8004-identity-write.js");
    expect(() => mod.getIdentityRegistryAddress()).toThrow(/not a valid EVM/);
  });

  it("registerAgentOnChain throws when write is disabled", async () => {
    const mod = await import("../services/erc8004-identity-write.js");
    await expect(
      mod.registerAgentOnChain({
        agentDid: "did:pcc:abc",
        agentUrl: "https://example.com",
      }),
    ).rejects.toThrow(/write is disabled/);
  });

  it("registerAgentOnChain rejects bad capabilityHash before broadcasting", async () => {
    process.env.PCC_GATEWAY_PRIVATE_KEY = "0x" + "b".repeat(64);
    const mod = await import("../services/erc8004-identity-write.js");
    mod.resetClientsForTest();
    await expect(
      mod.registerAgentOnChain({
        agentDid: "did:pcc:bad",
        agentUrl: "https://example.com",
        capabilityHash: "0xshort" as `0x${string}`,
      }),
    ).rejects.toThrow(/0x-prefixed 32-byte hex/);
  });

  it("checkSignerFunding returns sufficient=false with no key", async () => {
    const mod = await import("../services/erc8004-identity-write.js");
    const funding = await mod.checkSignerFunding();
    expect(funding.signer).toBeUndefined();
    expect(funding.sufficientForOneRegister).toBe(false);
    expect(funding.balanceWei).toBe(0n);
  });
});

// Restore env at suite end (best-effort hygiene for parallel test files).
process.on("exit", () => {
  process.env = originalEnv;
});
