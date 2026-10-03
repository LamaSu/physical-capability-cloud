/**
 * Tests for the ERC-8004 IdentityRegistry write helper + provision-route
 * integration + retry sweeper.
 *
 * Three test groups:
 *   1. Unit: helper behavior with mocked viem clients
 *   2. Integration: POST /api/auth/provision wires the helper correctly
 *   3. Real-chain smoke: actually writes to Base Sepolia (gated)
 *
 * The real-chain block only runs when:
 *   - RUN_ONCHAIN_TESTS=1
 *   - PCC_GATEWAY_PRIVATE_KEY is set
 *   - The signer has at least 25 µETH on Base Sepolia
 *
 * Sierra2's audit (2026-06-18) measured the canonical deployer wallet at
 * ~0.0000078 ETH on Base Sepolia — enough for a single agent register at
 * the ~0.0000051 ETH typical gas cost. The sufficiency check uses 5x
 * headroom, so it would currently SKIP — which is correct.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";

// All external services mocked at the module level.
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

// vi.mock is hoisted; use vi.hoisted to create the mocks BEFORE hoisting.
const { mockRegisterAgentOnChain, mockIsIdentityWriteEnabled, mockGetIdentityRegistryAddress } =
  vi.hoisted(() => ({
    mockRegisterAgentOnChain: vi.fn(),
    mockIsIdentityWriteEnabled: vi.fn(),
    mockGetIdentityRegistryAddress: vi.fn(
      () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    ),
  }));

vi.mock("../services/erc8004-identity-write.js", () => ({
  registerAgentOnChain: mockRegisterAgentOnChain,
  isIdentityWriteEnabled: mockIsIdentityWriteEnabled,
  getIdentityRegistryAddress: mockGetIdentityRegistryAddress,
  checkSignerFunding: vi.fn(async () => ({
    signer: undefined,
    balanceWei: 0n,
    balanceEth: "0",
    sufficientForOneRegister: false,
  })),
  resetClientsForTest: vi.fn(),
  readAgentURI: vi.fn(),
  getIdentityWriteSigner: vi.fn(),
}));

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore, getRepos } from "../db.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  // retire-the-wildcard #1099: the wallet path now requires a SIWE-verified
  // session (see routes/provision.ts + provision-wallet-siwe.test.ts). These
  // plugins are harmless to the email-path / sweeper tests below, which never
  // touch them.
  await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

/** Mirrors apps/dashboard/src/hooks/use-auth.ts buildSiweMessage exactly (see provision-wallet-siwe.test.ts). */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

/** Drive the real nonce -> sign -> verify flow for a fresh throwaway account. */
async function signIn(
  app: FastifyInstance,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<{ token: string }> {
  const nonceRes = await app.inject({
    method: "GET",
    url: "/api/auth/nonce",
    headers: { host: "pcc.test" },
  });
  const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };

  const message = buildSiweMessage({
    domain: "pcc.test",
    address: account.address,
    statement: "Sign in to Physical Capability Cloud",
    uri: "http://pcc.test",
    version: "1",
    chainId: 1,
    nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await account.signMessage({ message });

  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    headers: { host: "pcc.test" },
    payload: { message, signature },
  });
  if (verifyRes.statusCode !== 200) {
    throw new Error(`SIWE verify failed in test helper: ${verifyRes.statusCode} ${verifyRes.body}`);
  }
  const { token } = JSON.parse(verifyRes.body) as { token: string };
  return { token };
}

// ---------------------------------------------------------------------------
// Group 2: Provision-route integration tests (run first, no setup leak)
// ---------------------------------------------------------------------------

describe("POST /api/auth/provision — ERC-8004 wire-up", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  it("returns { onchain: 'disabled' } when write is not configured", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "test@example.com", name: "Test Op" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.api_key).toMatch(/^pcc_live_/);
    expect(body.onchain).toEqual({ status: "disabled" });
    expect(mockRegisterAgentOnChain).not.toHaveBeenCalled();
  });

  it("writes on-chain identity + records DB columns on success", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockResolvedValue({
      agentId: 42n,
      txHash: "0xdeadbeef" + "0".repeat(56),
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });

    // retire-the-wildcard #1099: the wallet path requires a SIWE-verified
    // session — a bare walletAddress claim is no longer trusted (see
    // provision-wallet-siwe.test.ts). Prove ownership of a fresh throwaway
    // account instead of asserting an unprovable hardcoded address.
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(app, account);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        walletAddress: account.address,
        name: "Test Wallet Op",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.onchain).toMatchObject({
      status: "written",
      agentId: "42",
      txHash: expect.stringMatching(/^0xdeadbeef/),
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    expect(mockRegisterAgentOnChain).toHaveBeenCalledTimes(1);

    // DB row should carry the onchain_* fields
    const stored = getRepos().apiKeys.findById(body.key_id);
    expect(stored?.onchainAgentId).toBe("42");
    expect(stored?.onchainStatus).toBe("written");
    expect(stored?.onchainChainId).toBe(84532);

    // The helper should have been called with a did:pcc:<wallet> DID
    const call = mockRegisterAgentOnChain.mock.calls[0][0];
    expect(call.agentDid).toBe(`did:pcc:${account.address.toLowerCase()}`);
  });

  it("returns 201 with onchain='pending' when chain write throws", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockRejectedValue(new Error("RPC unreachable"));

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "fail@example.com", name: "Op Fails Onchain" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.api_key).toBeTruthy();
    expect(body.onchain.status).toBe("pending");
    expect(body.onchain.registryAddress).toBe(
      "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );

    // DB row should reflect the failure but stay 'pending' for retry
    const stored = getRepos().apiKeys.findById(body.key_id);
    expect(stored?.onchainStatus).toBe("pending");
    expect(stored?.onchainError).toContain("RPC unreachable");
    expect(stored?.onchainAgentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 3: Sweeper unit tests
// ---------------------------------------------------------------------------

describe("ERC-8004 identity retry sweeper", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  it("picks up pending keys + writes them on next pass", async () => {
    // Seed a row with no on-chain identity by provisioning while write is disabled.
    mockIsIdentityWriteEnabled.mockReturnValue(false);
    const seedRes = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "sweep@example.com" },
    });
    const keyId = seedRes.json().key_id;

    // First call to provision left it onchain=disabled (no onchainStatus set)
    expect(
      getRepos().apiKeys.findById(keyId)?.onchainAgentId,
    ).toBeFalsy();

    // Now flip the write on + arrange success, and run a single sweep pass.
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockResolvedValue({
      agentId: 99n,
      txHash: "0xfeed" + "0".repeat(60),
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });

    const { runSweep } = await import("../services/erc8004-identity-sweeper.js");
    const result = await runSweep({
      batchSize: 5,
      gatewayUrl: "https://capability.network",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const stored = getRepos().apiKeys.findById(keyId);
    expect(stored?.onchainAgentId).toBe("99");
    expect(stored?.onchainStatus).toBe("written");
  });

  it("re-fails are kept 'pending' for next pass", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(false);
    const seed = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "stillfailing@example.com" },
    });
    const keyId = seed.json().key_id;

    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockRegisterAgentOnChain.mockRejectedValue(new Error("nonce too low"));

    const { runSweep } = await import("../services/erc8004-identity-sweeper.js");
    const result = await runSweep({
      batchSize: 5,
      gatewayUrl: "https://capability.network",
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const stored = getRepos().apiKeys.findById(keyId);
    expect(stored?.onchainStatus).toBe("pending");
    expect(stored?.onchainError).toContain("nonce too low");
  });

  it("empty sweep is a no-op", async () => {
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    const { runSweep } = await import("../services/erc8004-identity-sweeper.js");
    const result = await runSweep({
      batchSize: 5,
      gatewayUrl: "https://capability.network",
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Group 4: Helper-module input validation lives in
// `erc8004-identity-write-helper.test.ts` (no vi.mock on the helper).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Group 5: Real-chain smoke test (gated, skipped by default)
// ---------------------------------------------------------------------------

const SHOULD_RUN_ONCHAIN =
  process.env.RUN_ONCHAIN_TESTS === "1" && !!process.env.PCC_GATEWAY_PRIVATE_KEY;

describe.skipIf(!SHOULD_RUN_ONCHAIN)(
  "erc8004-identity-write — REAL Base Sepolia (gated)",
  () => {
    it("registers an agent + reads it back from chain", async () => {
      // Use the actual module, not the mock
      vi.resetModules();
      const realMod = await vi.importActual<
        typeof import("../services/erc8004-identity-write.js")
      >("../services/erc8004-identity-write.js");
      realMod.resetClientsForTest();

      // Pre-flight: skip if underfunded
      const funding = await realMod.checkSignerFunding();
      if (!funding.sufficientForOneRegister) {
        console.warn(
          `[onchain-test] skipping: signer ${funding.signer} has ${funding.balanceEth} ETH (need ≥0.000025)`,
        );
        return;
      }

      const result = await realMod.registerAgentOnChain({
        agentDid: `did:pcc:test-${Date.now()}`,
        agentUrl: "https://capability.network",
      });

      expect(result.agentId).toBeGreaterThan(0n);
      expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(result.chainId).toBe(84532);

      // Read it back
      const readURI = await realMod.readAgentURI(result.agentId);
      expect(readURI).toContain("agent-registration.json");
      console.log(
        `[onchain-test] minted agentId=${result.agentId} tx=${result.txHash}`,
      );
    }, 90_000);
  },
);
