/**
 * N1 (Gate A): provisioning seals the custodial wallet key at rest, and FAILS
 * CLOSED with no valid KEK.
 *
 *   - With a KEK: the plaintext column is NULL, the sealed column is set, and
 *     the blob unseals (for THAT row and address) to the key the response
 *     returned once. The response contract is unchanged.
 *   - With no KEK (unset, blank, wrong length, not base64, no id), in every
 *     NODE_ENV: the API key is still issued, no wallet is minted, no on-chain
 *     agentWallet is assigned, nothing is stored anywhere, the response says
 *     `custodialWallet: "unavailable: custody key not configured"`, and a
 *     ONE-TIME alert fires ("[custody] NO KEK:" on stderr, plus Sentry when
 *     enabled). The alert never echoes a configured value.
 *   - No log line, audit/analytics call or other response carries the key, and
 *     no error path falls back to plaintext.
 *
 * Every key is generated here; the KEK is random bytes. The chain is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sql, unsealCustodialKey, CustodyUnsealError } from "@pcc/store";

const audit = vi.hoisted(() => ({ log: vi.fn() }));
const posthog = vi.hoisted(() => ({ trackServerEvent: vi.fn() }));
vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: audit }));
vi.mock("../services/posthog-service.js", () => posthog);
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: vi.fn(() => true) }));

const sentry = vi.hoisted(() => ({
  isSentryEnabled: vi.fn(() => false),
  initSentry: vi.fn(),
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock("../sentry.js", () => sentry);

const chain = vi.hoisted(() => ({
  isIdentityWriteEnabled: vi.fn(() => true),
  registerAgentOnChain: vi.fn(),
  getIdentityRegistryAddress: vi.fn(() => "0x8004A818BFB912233c491871b3d84c89A494BD9e"),
  generateOperatorWallet: vi.fn(),
  setAgentWalletOnChain: vi.fn(),
}));
vi.mock("../services/erc8004-identity-write.js", () => chain);

import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import {
  resetCustodyAlertForTest,
  custodyKekConfigured,
  CUSTODY_NO_KEK_PREFIX,
  CUSTODIAL_WALLET_UNAVAILABLE,
} from "../services/custody-guard.js";

type Row = Record<string, unknown>;
type Body = {
  api_key: string;
  key_id: string;
  onchain: { status: string; agentId?: string };
  operator_wallet: Record<string, unknown> & { private_key?: string; address?: string };
};

const KEK_ENV = "PCC_CUSTODY_KEK";
const KEK_ID_ENV = "PCC_CUSTODY_KEK_ID";

describe("N1: provisioning seals the custodial key and fails closed without a KEK", () => {
  let app: FastifyInstance;
  let kekBytes: Buffer;
  let seq = 0;
  let logLines: string[];
  let consoleOut: string[];
  let errorSpy: MockInstance<Parameters<typeof console.error>, void>;
  let spies: Array<{ mockRestore(): void }>;
  const savedEnv = {
    kek: process.env[KEK_ENV],
    id: process.env[KEK_ID_ENV],
    nodeEnv: process.env.NODE_ENV,
  };

  const raw = (id: string): Row =>
    (getStore().db.all(sql`SELECT * FROM api_keys WHERE id = ${id}`) as Row[])[0];

  /** All api_keys rows as one string: a stand-in for "grep the database file". */
  const wholeTable = (): string => JSON.stringify(getStore().db.all(sql`SELECT * FROM api_keys`));

  function arrangeChain(opts: { assignmentFails?: boolean; assignmentError?: string } = {}) {
    const issuedKey = generatePrivateKey();
    const address = privateKeyToAccount(issuedKey).address;
    chain.generateOperatorWallet.mockResolvedValue({ address, privateKey: issuedKey });
    if (opts.assignmentFails) {
      chain.setAgentWalletOnChain.mockRejectedValue(
        new Error(opts.assignmentError ?? "synthetic: setAgentWallet reverted"),
      );
    } else {
      chain.setAgentWalletOnChain.mockResolvedValue({
        txHash: `0x${"22".repeat(32)}`,
        registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        chainId: 84532,
        agentWallet: address,
      });
    }
    return { issuedKey, address };
  }

  async function provision(): Promise<{ res: Awaited<ReturnType<FastifyInstance["inject"]>>; body: Body }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `n1-custody-${++seq}@example.com`, name: "n1 custody" },
    });
    return { res, body: res.json() as Body };
  }

  /** Everything this test run has written anywhere a log aggregator could read it. */
  const everythingLogged = (): string =>
    [
      ...logLines,
      ...consoleOut,
      JSON.stringify(audit.log.mock.calls),
      JSON.stringify(posthog.trackServerEvent.mock.calls),
      JSON.stringify(sentry.Sentry.captureMessage.mock.calls),
      JSON.stringify(sentry.Sentry.captureException.mock.calls),
    ].join("\n");

  beforeEach(async () => {
    // Reset ONLY this file's hoisted mocks (a global reset would also wipe the
    // canProvision stub made inside a vi.mock factory), then set every default.
    for (const fn of [
      chain.isIdentityWriteEnabled,
      chain.registerAgentOnChain,
      chain.getIdentityRegistryAddress,
      chain.generateOperatorWallet,
      chain.setAgentWalletOnChain,
      sentry.isSentryEnabled,
      sentry.Sentry.captureMessage,
      sentry.Sentry.captureException,
      audit.log,
      posthog.trackServerEvent,
    ]) {
      fn.mockReset();
    }
    resetCustodyAlertForTest();
    kekBytes = randomBytes(32);
    process.env[KEK_ENV] = kekBytes.toString("base64");
    process.env[KEK_ID_ENV] = "k1";
    chain.isIdentityWriteEnabled.mockReturnValue(true);
    chain.getIdentityRegistryAddress.mockReturnValue("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    chain.registerAgentOnChain.mockResolvedValue({
      agentId: 7n,
      txHash: `0x${"11".repeat(32)}`,
      registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      chainId: 84532,
    });
    sentry.isSentryEnabled.mockReturnValue(false);

    logLines = [];
    consoleOut = [];
    errorSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      consoleOut.push(a.map(String).join(" "));
    });
    spies = [errorSpy];
    for (const m of ["log", "info", "warn", "debug"] as const) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          consoleOut.push(a.map(String).join(" "));
        }),
      );
    }

    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({
      logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } },
    });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    for (const spy of spies) spy.mockRestore();
    for (const [name, v] of [
      [KEK_ENV, savedEnv.kek],
      [KEK_ID_ENV, savedEnv.id],
      ["NODE_ENV", savedEnv.nodeEnv],
    ] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  // ── With a KEK ──────────────────────────────────────────────────────
  for (const scenario of [
    { name: "on-chain assignment written", fails: false, status: "written" },
    { name: "on-chain assignment failed", fails: true, status: "failed" },
  ]) {
    describe(`with a KEK, ${scenario.name}`, () => {
      it("stores the key sealed: plaintext NULL, sealed set, and the blob unseals to the key returned once", async () => {
        const { issuedKey, address } = arrangeChain({ assignmentFails: scenario.fails });
        const { res, body } = await provision();
        expect(res.statusCode).toBe(201);
        expect(body.operator_wallet.private_key === issuedKey).toBe(true); // returned once, by design

        const row = raw(body.key_id);
        expect(row.operator_wallet_private_key).toBeNull();
        const blob = String(row.operator_wallet_key_sealed);
        expect(blob).toMatch(/^pcc-seal:v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
        expect(
          unsealCustodialKey(blob, { rowId: body.key_id, address }) === issuedKey,
          "the sealed blob unseals to the issued key",
        ).toBe(true);
        expect(row.operator_wallet_address).toBe(address);
        expect(row.operator_wallet_custody).toBe("gateway");
        expect(row.agent_wallet_onchain_status).toBe(scenario.status);
        // Bound to this row and this address.
        expect(() => unsealCustodialKey(blob, { rowId: `${body.key_id}x`, address })).toThrow(CustodyUnsealError);
        expect(() =>
          unsealCustodialKey(blob, { rowId: body.key_id, address: privateKeyToAccount(generatePrivateKey()).address }),
        ).toThrow(CustodyUnsealError);
        // The key is in no api_keys column, in any casing; the KEK is nowhere either.
        const table = wholeTable().toLowerCase();
        expect(table).not.toContain(issuedKey.slice(2).toLowerCase());
        expect(table).not.toContain(kekBytes.toString("base64").toLowerCase());
        // The alert is for the missing-KEK case only.
        expect(errorSpy.mock.calls.filter((c) => String(c[0]).startsWith(CUSTODY_NO_KEK_PREFIX))).toHaveLength(0);
      });

      it("keeps the response contract: same operator_wallet fields, key present exactly once in the body", async () => {
        const { issuedKey } = arrangeChain({ assignmentFails: scenario.fails });
        const { res, body } = await provision();
        expect(res.statusCode).toBe(201);
        const expectedFields = scenario.fails
          ? ["address", "custody", "onchain_error", "onchain_status", "private_key", "source", "warning"]
          : ["address", "custody", "onchain_status", "onchain_tx_hash", "private_key", "source", "warning"];
        expect(Object.keys(body.operator_wallet).sort()).toEqual(expectedFields);
        expect(body.operator_wallet.source).toBe("server-minted");
        expect(body.operator_wallet.custody).toBe("gateway");
        expect(body.operator_wallet.onchain_status).toBe(scenario.status);
        expect("custodialWallet" in body.operator_wallet).toBe(false);
        // The key appears in the response body exactly once, in operator_wallet.private_key.
        expect(res.body.split(issuedKey).length - 1).toBe(1);
        expect(body.onchain.status).toBe("written");
        expect(body.api_key).toMatch(/^pcc_live_/);
      });

      it("no log line, console output, audit or analytics call carries the key or the KEK", async () => {
        const { issuedKey } = arrangeChain({ assignmentFails: scenario.fails });
        await provision();
        const logged = everythingLogged().toLowerCase();
        expect(logged.length).toBeGreaterThan(0);
        expect(logged).not.toContain(issuedKey.slice(2).toLowerCase());
        expect(logged).not.toContain(kekBytes.toString("base64").toLowerCase());
        expect(logged).not.toContain(kekBytes.toString("hex").toLowerCase());
      });
    });
  }

  it("a library that echoes the key in its error cannot carry it into the response, the row or any log", async () => {
    const issuedKey = generatePrivateKey();
    const address = privateKeyToAccount(issuedKey).address;
    chain.generateOperatorWallet.mockResolvedValue({ address, privateKey: issuedKey });
    chain.setAgentWalletOnChain.mockRejectedValue(
      new Error(
        `signing failed for ${issuedKey}; bare ${issuedKey.slice(2).toUpperCase()}; again ${issuedKey.slice(2)}`,
      ),
    );
    const { res, body } = await provision();
    expect(res.statusCode).toBe(201);
    expect(body.operator_wallet.onchain_status).toBe("failed");
    const bare = issuedKey.slice(2).toLowerCase();
    // The response carries the key exactly once (operator_wallet.private_key), nowhere else.
    expect(res.body.toLowerCase().split(bare).length - 1).toBe(1);
    expect(String(body.operator_wallet.onchain_error)).toContain("[redacted]");
    // Not in the persisted error column either: the whole table holds no trace.
    expect(wholeTable().toLowerCase()).not.toContain(bare);
    expect(String(raw(body.key_id).agent_wallet_onchain_error)).toContain("[redacted]");
    expect(everythingLogged().toLowerCase()).not.toContain(bare);
  });

  // ── With no KEK ─────────────────────────────────────────────────────
  const noKek: Array<[string, Record<string, string | undefined>]> = [
    ["KEK unset", { [KEK_ENV]: undefined }],
    ["KEK blank", { [KEK_ENV]: "" }],
    ["KEK whitespace only", { [KEK_ENV]: "   " }],
    ["KEK 31 bytes", { [KEK_ENV]: randomBytes(31).toString("base64") }],
    ["KEK 33 bytes", { [KEK_ENV]: randomBytes(33).toString("base64") }],
    ["KEK hex instead of base64", { [KEK_ENV]: randomBytes(32).toString("hex") }],
    ["KEK not base64", { [KEK_ENV]: "S3CRET-LOOKING-BUT-NOT-A-KEK-VALUE" }],
    ["KEK id unset", { [KEK_ID_ENV]: undefined }],
    ["KEK id blank", { [KEK_ID_ENV]: "" }],
    ["KEK id malformed", { [KEK_ID_ENV]: "k:1" }],
    ["both unset", { [KEK_ENV]: undefined, [KEK_ID_ENV]: undefined }],
  ];
  const applyEnv = (o: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  it.each(noKek)(
    "[neg] with %s: the API key is still issued, no wallet is minted or stored, and the response says why",
    async (_name, overrides) => {
      applyEnv(overrides);
      const { issuedKey } = arrangeChain();
      const { res, body } = await provision();

      expect(res.statusCode).toBe(201);
      expect(body.api_key).toMatch(/^pcc_live_/);
      const stored = getRepos().apiKeys.findById(body.key_id);
      expect(stored).toBeDefined();
      expect(stored!.revokedAt).toBeNull();

      // The existing field, with the explanation added.
      expect(body.operator_wallet).toEqual({
        source: "none",
        custodialWallet: "unavailable: custody key not configured",
      });
      expect(body.operator_wallet).toEqual({ source: "none", custodialWallet: CUSTODIAL_WALLET_UNAVAILABLE });
      expect(res.body).not.toContain("private_key\":\"0x"); // no wallet key in the body
      // The sponsored mint is unaffected.
      expect(body.onchain.status).toBe("written");
      expect(chain.registerAgentOnChain).toHaveBeenCalledTimes(1);
      expect(raw(body.key_id).onchain_agent_id).toBe("7");

      // No wallet minted, so no on-chain agentWallet assigned to an address we would have to forget.
      expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
      expect(chain.setAgentWalletOnChain).not.toHaveBeenCalled();

      // Nothing stored anywhere: no address, no plaintext, no sealed blob.
      const row = raw(body.key_id);
      expect(row.operator_wallet_address).toBeNull();
      expect(row.operator_wallet_private_key).toBeNull();
      expect(row.operator_wallet_key_sealed).toBeNull();
      expect(wholeTable().toLowerCase()).not.toContain(issuedKey.slice(2).toLowerCase());
    },
  );

  it.each(["production", "staging", "development", "test", "Production", "", undefined])(
    "[neg] fails closed in EVERY environment (NODE_ENV=%s): no custody key means no custodial wallet",
    async (nodeEnv) => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      delete process.env[KEK_ENV];
      delete process.env[KEK_ID_ENV];
      arrangeChain();
      const { res, body } = await provision();
      expect(res.statusCode).toBe(201);
      expect(body.operator_wallet).toEqual({ source: "none", custodialWallet: CUSTODIAL_WALLET_UNAVAILABLE });
      expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
      expect(raw(body.key_id).operator_wallet_private_key).toBeNull();
      expect(raw(body.key_id).operator_wallet_key_sealed).toBeNull();
    },
  );

  describe("the one-time alert", () => {
    const noKekCalls = () => errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("[custody] NO KEK:"));

    it("fires ONCE across many refused provisions: console.error with the stable prefix, and Sentry when enabled", async () => {
      delete process.env[KEK_ENV];
      sentry.isSentryEnabled.mockReturnValue(true);
      arrangeChain();
      await provision();
      await provision();
      await provision();
      expect(noKekCalls()).toHaveLength(1);
      const message = String(noKekCalls()[0][0]);
      expect(message.startsWith(CUSTODY_NO_KEK_PREFIX)).toBe(true);
      expect(message).toContain(KEK_ENV);
      expect(sentry.Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(sentry.Sentry.captureMessage).toHaveBeenCalledWith(message, "error");
    });

    it("does not call Sentry when Sentry is not initialised (console.error only)", async () => {
      delete process.env[KEK_ENV];
      sentry.isSentryEnabled.mockReturnValue(false);
      arrangeChain();
      await provision();
      expect(noKekCalls()).toHaveLength(1);
      expect(sentry.Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("never echoes a configured value: the alert names the variable and the problem only", async () => {
      const secretish = "S3CRET-LOOKING-BUT-NOT-A-KEK-VALUE";
      process.env[KEK_ENV] = secretish;
      process.env[KEK_ID_ENV] = "id-that-is-fine";
      sentry.isSentryEnabled.mockReturnValue(true);
      arrangeChain();
      const { res } = await provision();
      expect(noKekCalls()).toHaveLength(1);
      const everything = `${everythingLogged()}\n${res.body}`;
      expect(everything).not.toContain(secretish);
      expect(String(noKekCalls()[0][0])).toContain(KEK_ENV);
    });

    it("a Sentry that throws cannot break provisioning (the alert is best-effort)", async () => {
      delete process.env[KEK_ENV];
      sentry.isSentryEnabled.mockReturnValue(true);
      sentry.Sentry.captureMessage.mockImplementation(() => {
        throw new Error("sentry transport down");
      });
      arrangeChain();
      const { res, body } = await provision();
      expect(res.statusCode).toBe(201);
      expect(body.operator_wallet).toEqual({ source: "none", custodialWallet: CUSTODIAL_WALLET_UNAVAILABLE });
      expect(noKekCalls()).toHaveLength(1);
    });

    it("re-reads the environment per call: once a valid KEK is set, wallets are created and sealed again", async () => {
      delete process.env[KEK_ENV];
      arrangeChain();
      const first = await provision();
      expect(first.body.operator_wallet).toEqual({ source: "none", custodialWallet: CUSTODIAL_WALLET_UNAVAILABLE });

      process.env[KEK_ENV] = kekBytes.toString("base64");
      const { issuedKey, address } = arrangeChain();
      const second = await provision();
      expect(second.body.operator_wallet.private_key === issuedKey).toBe(true);
      expect(raw(second.body.key_id).operator_wallet_private_key).toBeNull();
      expect(
        unsealCustodialKey(String(raw(second.body.key_id).operator_wallet_key_sealed), {
          rowId: second.body.key_id,
          address,
        }) === issuedKey,
      ).toBe(true);
      // And the first, refused row still holds nothing.
      expect(raw(first.body.key_id).operator_wallet_key_sealed).toBeNull();
    });

    it("raises no alert and adds no message when identity writes are off (no custodial wallet was wanted)", async () => {
      delete process.env[KEK_ENV];
      chain.isIdentityWriteEnabled.mockReturnValue(false);
      arrangeChain();
      const { res, body } = await provision();
      expect(res.statusCode).toBe(201);
      expect(body.operator_wallet).toEqual({ source: "none" });
      expect(body.onchain).toEqual({ status: "disabled" });
      expect(noKekCalls()).toHaveLength(0);
      expect(chain.generateOperatorWallet).not.toHaveBeenCalled();
    });

    it("fails CLOSED when reading the environment itself throws: it never throws and never says 'configured'", () => {
      const hostile = {
        get [KEK_ENV]() {
          throw new Error("env access exploded");
        },
      } as unknown as Record<string, string | undefined>;
      expect(() => custodyKekConfigured(hostile)).not.toThrow();
      expect(custodyKekConfigured(hostile)).toBe(false);
    });

    it("the guard itself: false (and one alert) without a KEK, true with one, and it never throws", () => {
      expect(custodyKekConfigured({ [KEK_ENV]: kekBytes.toString("base64"), [KEK_ID_ENV]: "k1" })).toBe(true);
      expect(noKekCalls()).toHaveLength(0);
      expect(custodyKekConfigured({})).toBe(false);
      expect(custodyKekConfigured({ [KEK_ENV]: "x" })).toBe(false);
      expect(noKekCalls()).toHaveLength(1);
      errorSpy.mockImplementation(() => {
        throw new Error("console is broken");
      });
      resetCustodyAlertForTest();
      expect(() => custodyKekConfigured({})).not.toThrow();
      expect(custodyKekConfigured({})).toBe(false);
    });
  });

  // ── Never a plaintext fallback ──────────────────────────────────────
  it("[neg] a KEK that vanishes between the check and the write still never produces plaintext", async () => {
    const { issuedKey } = arrangeChain();
    // The guard passes, the wallet is minted, then the KEK disappears before recordOperatorWallet.
    chain.setAgentWalletOnChain.mockImplementation(async () => {
      delete process.env[KEK_ENV];
      return { txHash: `0x${"22".repeat(32)}`, registryAddress: "0x0", chainId: 84532, agentWallet: "0x0" };
    });
    const { res, body } = await provision();
    expect(res.statusCode).toBe(201);
    const row = raw(body.key_id);
    expect(row.operator_wallet_private_key).toBeNull();
    expect(row.operator_wallet_key_sealed).toBeNull();
    expect(wholeTable().toLowerCase()).not.toContain(issuedKey.slice(2).toLowerCase());
    expect(everythingLogged().toLowerCase()).not.toContain(issuedKey.slice(2).toLowerCase());
  });

  it("static guard: nothing in db or gateway source writes the plaintext column except the NULL in recordOperatorWallet", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoPackages = resolve(here, "..", "..", "..");
    const roots = [join(repoPackages, "db", "src"), join(repoPackages, "gateway", "src")];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === "__tests__" || name === "node_modules") continue;
          walk(p);
        } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/operatorWalletPrivateKey|operator_wallet_private_key/.test(line)) {
                hits.push(`${relative(repoPackages, p)}:${i + 1}: ${line.trim()}`);
              }
            });
        }
      }
    };
    roots.forEach(walk);
    // Allowed: the column declaration, its safeAddColumn, comments, and the NULL.
    const writes = hits.filter(
      (h) =>
        !/^\S+:\d+: (\/\/|\*|\/\*)/.test(h) &&
        !/operatorWalletPrivateKey: text\("operator_wallet_private_key"\)/.test(h) &&
        !/safeAddColumn\("api_keys", "operator_wallet_private_key", "TEXT"\)/.test(h) &&
        !/operatorWalletPrivateKey: null,/.test(h),
    );
    expect(writes).toEqual([]);
  });
});
