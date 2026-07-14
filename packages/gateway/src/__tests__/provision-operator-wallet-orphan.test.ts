/**
 * H-12 orphan-wallet fix — lock-in tests for the operator-wallet provision path
 * (ROUND-3 audit-p0, review #2/#4).
 *
 * These assert the CORRECTED ordering and invariants:
 *   1. The encrypted envelope is durably PERSISTED (onchain_status:"pending")
 *      BEFORE the on-chain setAgentWallet tx is submitted — closing the orphan
 *      window where a tx-success + persist-failure left an unrecoverable
 *      on-chain wallet.
 *   2. If the pre-chain persist FAILS, the tx is NOT submitted (no orphan
 *      possible) and the API key is still provisioned with
 *      operator_wallet.source = "none".
 *   3. A failure of the SUCCESS audit-log call does NOT reclassify a written
 *      wallet as "failed" (audit-log isolation).
 *   4. The persisted envelope is `enc:v2:` (full-identity AAD format).
 *
 * The operator-wallet path only runs when a valid 32-byte KEK is configured, so
 * these tests set PCC_KEY_ENCRYPTION_KEK and mock the erc8004 write helpers
 * (generateOperatorWallet / setAgentWalletOnChain) — which the ambient
 * erc8004-identity-write.test.ts deliberately does not, so its wallet block
 * short-circuits.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// vi.mock is hoisted; create the mock fns via vi.hoisted so they exist first.
const {
  mockRegisterAgentOnChain,
  mockIsIdentityWriteEnabled,
  mockGetIdentityRegistryAddress,
  mockGenerateOperatorWallet,
  mockSetAgentWalletOnChain,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockRegisterAgentOnChain: vi.fn(),
  mockIsIdentityWriteEnabled: vi.fn(),
  mockGetIdentityRegistryAddress: vi.fn(
    () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  ),
  mockGenerateOperatorWallet: vi.fn(),
  mockSetAgentWalletOnChain: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../services/erc8004-identity-write.js", () => ({
  registerAgentOnChain: mockRegisterAgentOnChain,
  isIdentityWriteEnabled: mockIsIdentityWriteEnabled,
  getIdentityRegistryAddress: mockGetIdentityRegistryAddress,
  generateOperatorWallet: mockGenerateOperatorWallet,
  setAgentWalletOnChain: mockSetAgentWalletOnChain,
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: mockAuditLog,
    query: vi.fn(() => []),
    stats: vi.fn(() => []),
  },
}));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
}));

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore, getRepos } from "../db.js";

// Valid 32-byte KEK (64 hex chars) so encryptSecretAtRest produces enc:v2.
const TEST_KEK = "1f".repeat(32);
const ORIGINAL_KEK = process.env.PCC_KEY_ENCRYPTION_KEK;

const OP_WALLET = {
  address: "0xAbc0000000000000000000000000000000000001" as `0x${string}`,
  privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
};
const SET_WALLET_RESULT = {
  txHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
  registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as `0x${string}`,
  chainId: 84532,
  agentWallet: OP_WALLET.address,
};
const REGISTER_RESULT = {
  agentId: 7n,
  txHash: "0x" + "cd".repeat(32),
  registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  chainId: 84532,
};

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

describe("POST /api/auth/provision — operator wallet H-12 orphan fix", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuditLog.mockReset(); // drop any per-test throwing implementation
    process.env.PCC_KEY_ENCRYPTION_KEK = TEST_KEK;
    mockIsIdentityWriteEnabled.mockReturnValue(true);
    mockGetIdentityRegistryAddress.mockReturnValue(
      "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    );
    mockRegisterAgentOnChain.mockResolvedValue(REGISTER_RESULT);
    mockGenerateOperatorWallet.mockResolvedValue(OP_WALLET);
    mockSetAgentWalletOnChain.mockResolvedValue(SET_WALLET_RESULT);
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
  });

  afterAll(() => {
    if (ORIGINAL_KEK === undefined) delete process.env.PCC_KEY_ENCRYPTION_KEK;
    else process.env.PCC_KEY_ENCRYPTION_KEK = ORIGINAL_KEK;
  });

  it("persists the envelope (pending, enc:v2) BEFORE the on-chain assignment", async () => {
    const spy = vi.spyOn(getRepos().apiKeys, "recordOperatorWallet");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `orphan-a-${Date.now()}@example.com`, name: "OrphanA" },
    });
    expect(res.statusCode).toBe(201);

    // First persist happened, with status "pending" and an enc:v2 envelope.
    expect(spy).toHaveBeenCalled();
    const firstArg = spy.mock.calls[0]![1];
    expect(firstArg.onchainStatus).toBe("pending");
    expect(firstArg.onchainTxHash).toBeNull();
    expect(firstArg.privateKeyEnvelope).toMatch(
      /^enc:v2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/,
    );

    // …and it happened BEFORE the chain tx (no orphan window).
    expect(mockSetAgentWalletOnChain).toHaveBeenCalledTimes(1);
    expect(spy.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSetAgentWalletOnChain.mock.invocationCallOrder[0]!,
    );

    // Status advanced pending → written on tx success.
    const lastArg = spy.mock.calls[spy.mock.calls.length - 1]![1];
    expect(lastArg.onchainStatus).toBe("written");
    expect(lastArg.onchainTxHash).toBe(SET_WALLET_RESULT.txHash);

    const body = res.json();
    expect(body.operator_wallet.onchain_status).toBe("written");
    expect(body.operator_wallet.address).toBe(OP_WALLET.address);
  });

  it("does NOT submit the chain tx when the pre-chain persist fails (no orphan)", async () => {
    // Make the FIRST recordOperatorWallet (the pending persist) throw.
    vi.spyOn(getRepos().apiKeys, "recordOperatorWallet").mockImplementationOnce(
      () => {
        throw new Error("db unavailable");
      },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `orphan-b-${Date.now()}@example.com`, name: "OrphanB" },
    });

    // API key is still issued…
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.api_key).toMatch(/^pcc_live_/);

    // …but NO on-chain tx was submitted, so nothing can be orphaned.
    expect(mockSetAgentWalletOnChain).not.toHaveBeenCalled();
    expect(body.operator_wallet).toMatchObject({
      source: "none",
      custody: "none",
      reason: "wallet_not_created",
    });
  });

  it("keeps the wallet 'written' when the success audit-log call throws (audit isolation)", async () => {
    mockAuditLog.mockImplementation((e: { eventType?: string }) => {
      if (e?.eventType === "auth.agent_wallet_written") {
        throw new Error("audit sink down");
      }
    });
    const spy = vi.spyOn(getRepos().apiKeys, "recordOperatorWallet");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `orphan-c-${Date.now()}@example.com`, name: "OrphanC" },
    });
    expect(res.statusCode).toBe(201);

    // Chain assignment succeeded and the wallet was recorded "written"; the
    // audit-log throw must NOT flip it to "failed".
    expect(mockSetAgentWalletOnChain).toHaveBeenCalledTimes(1);
    const lastArg = spy.mock.calls[spy.mock.calls.length - 1]![1];
    expect(lastArg.onchainStatus).toBe("written");

    const body = res.json();
    expect(body.operator_wallet.onchain_status).toBe("written");
    expect(body.operator_wallet.onchain_error).toBeUndefined();
  });
});
