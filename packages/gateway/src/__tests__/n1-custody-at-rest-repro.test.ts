/**
 * N1 (Gate A) REPRODUCTION: a provisioned custodial wallet key is stored in
 * PLAINTEXT in api_keys.operator_wallet_private_key.
 *
 * Provisioning mints a per-operator EOA, returns its private key ONCE in the
 * response (by design, N78 withdrawn), and ALSO persists the key through
 * recordOperatorWallet (routes/provision.ts, two call sites: on-chain
 * assignment written, and on-chain assignment failed). At ac676c81 that copy is
 * the raw hex key, readable by anyone who can read the database file, a backup,
 * or a `SELECT *`. The decided fix (operator item 12) seals it at rest:
 * AES-256-GCM under a KEK from PCC_CUSTODY_KEK, in a new nullable column
 * api_keys.operator_wallet_key_sealed, with the plaintext column left NULL.
 *
 * These tests assert the POST-FIX state, so they FAIL on the unfixed code and
 * the failure names the column that still holds the key:
 *   - "[repro] no api_keys column holds the issued key"  -> lists the columns
 *   - "[repro] the key is stored sealed"                 -> sealed column unset
 * The controls ("control: ...") pass both before and after: they prove the
 * setup really reached the wallet path and that the response contract (the key
 * is returned once to its caller) is unchanged.
 *
 * Every key here is generated inside the test (viem generatePrivateKey) and the
 * KEK is random bytes. Nothing reads a real key, an env file or a real database.
 * The assertions never print key material: they compare booleans and column
 * names, so a failing run is safe to save as evidence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sql } from "@pcc/store";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
}));

// The chain is entirely synthetic: no RPC, no signer, no real key.
const chain = vi.hoisted(() => ({
  isIdentityWriteEnabled: vi.fn(() => true),
  registerAgentOnChain: vi.fn(),
  getIdentityRegistryAddress: vi.fn(
    () => "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  ),
  generateOperatorWallet: vi.fn(),
  setAgentWalletOnChain: vi.fn(),
}));
vi.mock("../services/erc8004-identity-write.js", () => chain);

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore, getStore } from "../db.js";

type Row = Record<string, unknown>;

/** The columns of a raw api_keys row whose value contains the key (hex, any case, 0x or not). */
function columnsHolding(row: Row, key: string): string[] {
  const bare = key.replace(/^0x/i, "").toLowerCase();
  return Object.entries(row)
    .filter(([, v]) => typeof v === "string" && v.toLowerCase().includes(bare))
    .map(([col]) => col)
    .sort();
}

/** SELECT * on purpose: this is what a stolen backup or an ad-hoc query sees. */
function rawKeyRow(keyId: string): Row {
  const rows = getStore().db.all(
    sql`SELECT * FROM api_keys WHERE id = ${keyId}`,
  ) as Row[];
  expect(rows.length, "exactly one api_keys row for the provisioned key").toBe(1);
  return rows[0];
}

describe("N1 repro: provisioned custodial key at rest", () => {
  let app: FastifyInstance;
  let seq = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Synthetic KEK (32 random bytes, base64) and id. Unused on the unfixed
    // code; required by the fix, which refuses to store a key without one.
    process.env.PCC_CUSTODY_KEK = randomBytes(32).toString("base64");
    process.env.PCC_CUSTODY_KEK_ID = "k1";
    chain.isIdentityWriteEnabled.mockReturnValue(true);
    chain.registerAgentOnChain.mockResolvedValue({
      agentId: 7n,
      txHash: `0x${"11".repeat(32)}`,
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_CUSTODY_KEK;
    delete process.env.PCC_CUSTODY_KEK_ID;
  });

  /** Provision one operator whose wallet is minted by the (synthetic) generator. */
  async function provisionWithWallet(opts: { assignmentFails: boolean }) {
    const issuedKey = generatePrivateKey();
    const address = privateKeyToAccount(issuedKey).address;
    chain.generateOperatorWallet.mockResolvedValue({
      address,
      privateKey: issuedKey,
    });
    if (opts.assignmentFails) {
      chain.setAgentWalletOnChain.mockRejectedValue(
        new Error("synthetic: setAgentWallet reverted"),
      );
    } else {
      chain.setAgentWalletOnChain.mockResolvedValue({
        txHash: `0x${"22".repeat(32)}`,
        registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        chainId: 84532,
        agentWallet: address,
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `n1-repro-${++seq}@example.com`, name: "n1 repro" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      key_id: string;
      operator_wallet: { private_key?: string; address?: string; onchain_status?: string };
    };
    return { body, issuedKey, address, row: rawKeyRow(body.key_id) };
  }

  for (const scenario of [
    { name: "on-chain assignment written", assignmentFails: false, status: "written" },
    { name: "on-chain assignment failed", assignmentFails: true, status: "failed" },
  ]) {
    describe(scenario.name, () => {
      it("control: the wallet path ran and the response still returns the key once", async () => {
        const { body, issuedKey, address, row } = await provisionWithWallet(scenario);
        expect(body.operator_wallet.onchain_status).toBe(scenario.status);
        expect(body.operator_wallet.address === address, "response carries the wallet address").toBe(true);
        expect(
          body.operator_wallet.private_key === issuedKey,
          "response carries the issued key (returned once, by design)",
        ).toBe(true);
        expect(row.operator_wallet_address === address, "address stored on the row").toBe(true);
        expect(row.operator_wallet_custody).toBe("gateway");
        expect(row.agent_wallet_onchain_status).toBe(scenario.status);
      });

      it("[repro] no api_keys column holds the issued key", async () => {
        const { issuedKey, row } = await provisionWithWallet(scenario);
        // Post-fix: []. At ac676c81: ["operator_wallet_private_key"].
        expect(columnsHolding(row, issuedKey)).toEqual([]);
      });

      it("[repro] the plaintext column operator_wallet_private_key is NULL", async () => {
        const { row } = await provisionWithWallet(scenario);
        // Post-fix: NULL. At ac676c81: the raw hex key. A boolean, so a failing
        // run never echoes the value.
        expect(row.operator_wallet_private_key == null, "plaintext column must be NULL").toBe(true);
      });

      it("[repro] the sealed column operator_wallet_key_sealed holds a pcc-seal:v1 blob", async () => {
        const { row } = await provisionWithWallet(scenario);
        // Post-fix: a sealed blob. At ac676c81 the column does not exist at all.
        const sealed = row.operator_wallet_key_sealed;
        expect(
          typeof sealed === "string" && sealed.startsWith("pcc-seal:v1:"),
          "sealed column must hold a pcc-seal:v1 blob",
        ).toBe(true);
      });
    });
  }
});
