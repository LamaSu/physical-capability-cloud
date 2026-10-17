import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ContractFunctionExecutionError, HttpRequestError, TransactionExecutionError } from "viem";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: () => true }));
vi.mock("../auth/api-key-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api-key-auth.js")>();
  return { ...actual, provisionApiKey: vi.fn(actual.provisionApiKey) };
});
const chain = vi.hoisted(() => ({
  registerAgentOnChain: vi.fn(),
  setAgentWalletOnChain: vi.fn(),
  generateOperatorWallet: vi.fn(),
}));
vi.mock("../services/erc8004-identity-write.js", () => ({
  ...chain,
  isIdentityWriteEnabled: () => true,
  getIdentityRegistryAddress: () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
}));

import { provisionApiKey, resolveApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { auditRoutes } from "../routes/audit.js";
import { provisionRoutes } from "../routes/provision.js";
import { auditService } from "../services/audit-service.js";

const CANARY = "CANARY-rpc-key-7f3a";
const URL = `https://rpc.example.invalid/v2/${CANARY}`;
const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const txHash = `0x${"a".repeat(64)}`;
// Literal expectations keep route regressions runnable before the module exists.
// T4 independently checks the exported closed set and every classifier mapping.
const EXPECTED_CODES = [
  "identity_write_disabled", "config_invalid", "rpc_unavailable", "insufficient_funds",
  "rpc_rejected", "tx_reverted", "tx_missing_event", "signing_failed",
  "wallet_generation_failed", "unknown",
];

function rpcError(depth: number) {
  let error = new HttpRequestError({ url: URL, status: 401, body: { error: CANARY } });
  expect(error.message).toContain(URL); // viem's genuine URL-bearing format
  if (depth >= 1) {
    error = new TransactionExecutionError(error, { account: null }) as typeof error;
  }
  if (depth >= 2) {
    error = new ContractFunctionExecutionError(error, {
      abi: [], functionName: "register", contractAddress: registryAddress,
    }) as typeof error;
  }
  expect(error.message).toContain(CANARY);
  return error;
}

describe("provision error codes at every sink (T1, T2, T5)", () => {
  let app: FastifyInstance;
  let logs: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    logs = [];
    app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => logs.push(line) } } });
    app.addHook("onRequest", async (req) => {
      const key = resolveApiKey(req);
      if (key) req.operatorId = key.operatorId;
    });
    await app.register(provisionRoutes);
    await app.register(auditRoutes);
    await app.ready();
    chain.registerAgentOnChain.mockResolvedValue({ agentId: 42n, txHash, registryAddress, chainId: 84532 });
    chain.generateOperatorWallet.mockResolvedValue({ address: `0x${"b".repeat(40)}`, privateKey: `0x${"c".repeat(64)}` });
    chain.setAgentWalletOnChain.mockResolvedValue({ txHash });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
  });

  const provision = () => app.inject({
    method: "POST", url: "/api/auth/provision", payload: { email: "codes@example.com" },
  });

  it.each([0, 1, 2])("T1: wallet assignment failure at wrapper depth %i is never reached", async (depth) => {
    chain.setAgentWalletOnChain.mockRejectedValueOnce(rpcError(depth));
    const res = await provision();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect.soft(res.body).not.toContain(CANARY);
    expect.soft(body.operator_wallet).toEqual({ source: "none" });
    expect.soft(body.onchain.status).toBe("written");
    expect.soft(chain.generateOperatorWallet).not.toHaveBeenCalled();
    expect.soft(chain.setAgentWalletOnChain).not.toHaveBeenCalled();
    const stored = getRepos().apiKeys.findById(body.key_id);
    expect.soft(stored?.onchainStatus).toBe("written");
    expect.soft(stored?.operatorWalletAddress).toBeNull();
    expect.soft(stored?.agentWalletOnchainError).toBeNull();
    expect.soft(JSON.stringify(logs)).not.toContain(CANARY);
    expect.soft(logs.map((line) => JSON.parse(line))).toEqual([]);
  });

  it.each([0, 1, 2])("T2: registration failure at wrapper depth %i is code-only, including the caller's audit view", async (depth) => {
    chain.registerAgentOnChain.mockRejectedValueOnce(rpcError(depth));
    const res = await provision();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect.soft(res.body).not.toContain(CANARY);
    expect.soft(body.onchain.status).toBe("pending");
    const stored = getRepos().apiKeys.findById(body.key_id);
    expect.soft(EXPECTED_CODES).toContain(stored?.onchainError);
    expect.soft(stored?.onchainError).toBe("rpc_unavailable");
    expect.soft(JSON.stringify(logs)).not.toContain(CANARY);
    expect.soft(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ keyId: body.key_id, code: "rpc_unavailable" }),
    ]);
    const entries = auditService.query({ actor: body.operator_id, eventType: "auth.onchain_identity_failed" });
    expect.soft(JSON.stringify(entries)).not.toContain(CANARY);
    expect.soft(entries).toHaveLength(1);
    expect.soft(entries[0]?.metadata).toEqual({ code: "rpc_unavailable" });
    const audit = await app.inject({
      method: "GET", url: "/api/audit/log?eventType=auth.onchain_identity_failed",
      headers: { authorization: `Bearer ${body.api_key}` },
    });
    expect.soft(audit.statusCode).toBe(200);
    expect.soft(audit.body).not.toContain(CANARY);
    expect.soft(audit.json()).toMatchObject({ scoped: true, count: 1, entries: [{ metadata: { code: "rpc_unavailable" } }] });
  });

  it.each([0, 1, 2])("wallet generation failure at wrapper depth %i is never reached", async (depth) => {
    chain.generateOperatorWallet.mockRejectedValueOnce(rpcError(depth));
    const res = await provision();
    expect(res.statusCode).toBe(201);
    expect.soft(res.body).not.toContain(CANARY);
    expect.soft(res.json().onchain.status).toBe("written");
    expect.soft(res.json().operator_wallet).toEqual({ source: "none" });
    expect.soft(chain.generateOperatorWallet).not.toHaveBeenCalled();
    expect.soft(chain.setAgentWalletOnChain).not.toHaveBeenCalled();
    expect.soft(JSON.stringify(logs)).not.toContain(CANARY);
    expect.soft(logs.map((line) => JSON.parse(line))).toEqual([]);
  });

  it.each([URL, `Maximum 5 ${URL}`])("T5: an untyped provisioning error is a fixed 500 (%s)", async (message) => {
    vi.mocked(provisionApiKey).mockImplementationOnce(() => { throw new Error(message); });
    const res = await provision();
    expect.soft(res.statusCode).toBe(500);
    expect.soft(res.json()).toEqual({ error: "provision_failed", message: "Failed to provision key" });
    expect.soft(res.body).not.toContain(CANARY);
  });

  it.each([
    ["too_many_keys", 429, "too_many_keys", "Maximum 5 active API keys per operator"],
    ["invalid_public_key", 400, "invalid_public_key", "publicKey must be a 32-byte Ed25519 public key (64 hex chars, optional 0x prefix)"],
    ["provision_in_progress", 500, "provision_failed", "Key provisioning in progress — try again in a moment"],
  ] as const)("T5: typed %s retains its status and fixed wording", async (code, status, error, message) => {
    vi.mocked(provisionApiKey).mockImplementationOnce(() => { throw Object.assign(new Error(URL), { code }); });
    const res = await provision();
    expect.soft(res.statusCode).toBe(status);
    expect.soft(res.json()).toEqual({ error, message });
    expect.soft(res.body).not.toContain(CANARY);
  });

  it("the real key limit throws a typed code", async () => {
    const actual = await vi.importActual<typeof import("../auth/api-key-auth.js")>("../auth/api-key-auth.js");
    for (let i = 0; i < 5; i++) actual.provisionApiKey({ operatorId: "limit@example.com" });
    expect(() => actual.provisionApiKey({ operatorId: "limit@example.com" })).toThrowError(
      expect.objectContaining({ code: "too_many_keys" }),
    );
  });

  it("the real reentrant provisioning lock throws a typed code", async () => {
    const actual = await vi.importActual<typeof import("../auth/api-key-auth.js")>("../auth/api-key-auth.js");
    const repo = getRepos().apiKeys;
    vi.spyOn(repo, "countByOperator").mockImplementationOnce(() => {
      expect(() => actual.provisionApiKey({ operatorId: "lock@example.com" })).toThrowError(
        expect.objectContaining({ code: "provision_in_progress" }),
      );
      return 0;
    });
    actual.provisionApiKey({ operatorId: "lock@example.com" });
  });
});
