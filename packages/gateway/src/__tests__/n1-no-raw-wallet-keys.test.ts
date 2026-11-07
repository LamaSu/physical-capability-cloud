import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase, migrateDatabase, sql } from "@pcc/store";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: () => true }));
const chain = vi.hoisted(() => ({
  registerAgentOnChain: vi.fn(),
  isIdentityWriteEnabled: vi.fn(),
  generateOperatorWallet: vi.fn(),
  setAgentWalletOnChain: vi.fn(),
}));
vi.mock("../services/erc8004-identity-write.js", () => ({
  ...chain,
  getIdentityRegistryAddress: () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
}));

import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { provisionRoutes } from "../routes/provision.js";

const DECOY_KEY = `0x${"de".repeat(32)}`;
const DECOY_MARKER = "SECRET-MARKER-KEY-provision";
const LEGACY_WALLET = `0x${"b".repeat(40)}`;
const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const txHash = `0x${"a".repeat(64)}`;

function remainingKeys(): number {
  return getStore().db.get<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM api_keys WHERE operator_wallet_private_key IS NOT NULL
  `)!.count;
}

describe("provisioning stores no operator wallet key", () => {
  let app: FastifyInstance;
  let directory: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
    delete process.env.DATABASE_URL;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    chain.isIdentityWriteEnabled.mockReturnValue(true);
    chain.registerAgentOnChain.mockResolvedValue({ agentId: 42n, txHash, registryAddress, chainId: 84532 });
    chain.generateOperatorWallet.mockResolvedValue({ address: LEGACY_WALLET, privateKey: DECOY_KEY });
    chain.setAgentWalletOnChain.mockResolvedValue({ txHash });
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const provision = () => app.inject({
    method: "POST", url: "/api/auth/provision", payload: { email: "n1@example.com" },
  });

  it("writes the identity without minting, assigning, returning, or recording a wallet", async () => {
    const response = await provision();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.api_key).toMatch(/^pcc_live_/);
    expect(body.onchain.status).toBe("written");
    expect(body.operator_wallet).toEqual({ source: "none" });
    expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
    expect(chain.setAgentWalletOnChain).not.toHaveBeenCalled();
    expect(response.body).not.toContain(DECOY_KEY);
    expect(remainingKeys()).toBe(0);
    const row = getStore().db.get<{ operator_wallet_address: string | null }>(sql`
      SELECT operator_wallet_address FROM api_keys WHERE id = ${body.key_id}
    `);
    expect(row?.operator_wallet_address).toBeNull();
  });

  it("preserves disabled identity writes and exposes no custodial wallet writer", async () => {
    chain.isIdentityWriteEnabled.mockReturnValue(false);
    const response = await provision();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.api_key).toMatch(/^pcc_live_/);
    expect(body.operator_wallet).toEqual({ source: "none" });
    expect(body.onchain).toEqual({ status: "disabled" });
    expect(chain.registerAgentOnChain).not.toHaveBeenCalled();
    expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
    expect(chain.setAgentWalletOnChain).not.toHaveBeenCalled();
    expect(remainingKeys()).toBe(0);
    expect(typeof Reflect.get(getRepos().apiKeys, "recordOperatorWallet")).not.toBe("function");
  });

  it("scrubs legacy file-backed keys at initStore and keeps provisioning key-free", async () => {
    closeStore();
    directory = mkdtempSync(join(tmpdir(), "pcc-n1-provision-"));
    const dbPath = join(directory, "legacy.sqlite");
    const { sqlite } = createDatabase(dbPath);
    try {
      migrateDatabase(sqlite);
      const insert = sqlite.prepare(`
        INSERT INTO api_keys (
          id, key_hash, key_prefix, operator_id, scopes, rate_limit, created_at,
          revoked_at, operator_wallet_address, operator_wallet_private_key
        ) VALUES (?, ?, ?, ?, '[]', '100', '2026-01-01T00:00:00Z', ?, ?, ?)
      `);
      insert.run("legacy-active", "legacy-active-hash", "pcc_test_", "legacy@example.com", null, LEGACY_WALLET, DECOY_KEY);
      insert.run("legacy-revoked", "legacy-revoked-hash", "pcc_test_", "legacy@example.com", "2026-01-02T00:00:00Z", LEGACY_WALLET, DECOY_MARKER);
    } finally {
      sqlite.close();
    }
    vi.stubEnv("PCC_DB_PATH", dbPath);
    initStore({ seed: false });
    expect(remainingKeys()).toBe(0);
    const response = await provision();
    expect(response.statusCode).toBe(201);
    expect(response.json().operator_wallet).toEqual({ source: "none" });
    expect(response.json().onchain.status).toBe("written");
    expect(response.body).not.toContain(DECOY_KEY);
    expect(response.body).not.toContain(DECOY_MARKER);
    expect(remainingKeys()).toBe(0);
    expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
    expect(chain.setAgentWalletOnChain).not.toHaveBeenCalled();
  });
});
