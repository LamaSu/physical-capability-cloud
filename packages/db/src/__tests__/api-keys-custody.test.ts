/**
 * N1 (Gate A): ApiKeyRepository.recordOperatorWallet stores the custodial key
 * SEALED, never as plaintext, and refuses to store anything without a valid KEK.
 * Also pins the migration: one nullable column, added idempotently, nothing
 * existing dropped or altered.
 *
 * All keys, addresses and KEKs are random bytes generated here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createStore,
  createDatabase,
  migrateDatabase,
  CUSTODY_KEK_ENV,
  CUSTODY_KEK_ID_ENV,
  CustodyKekUnavailableError,
  CustodyUnsealError,
  unsealCustodialKey,
  type Store,
} from "../index.js";

type Row = Record<string, unknown>;

const randKeyHex = () => `0x${randomBytes(32).toString("hex")}`;
const randAddress = () => `0x${randomBytes(20).toString("hex")}`;

describe("N1: ApiKeyRepository.recordOperatorWallet seals the custodial key", () => {
  let store: Store;
  let kekB64: string;
  const saved = { k: process.env[CUSTODY_KEK_ENV], i: process.env[CUSTODY_KEK_ID_ENV] };

  function insertKey(id: string): void {
    store.repos.apiKeys.insert({
      id,
      keyHash: `hash-${id}-${randomBytes(4).toString("hex")}`,
      keyPrefix: "pcc_test",
      operatorId: `op-${id}`,
      scopes: JSON.stringify(["operator"]),
      rateLimit: "1000/hour",
      createdAt: new Date().toISOString(),
    });
  }

  const raw = (id: string): Row =>
    (store.db.all(sql`SELECT * FROM api_keys WHERE id = ${id}`) as Row[])[0];

  const wallet = (over: Partial<{ privateKey: string; address: string }> = {}) => ({
    address: randAddress(),
    privateKey: randKeyHex(),
    onchainStatus: "written" as const,
    onchainTxHash: `0x${"ab".repeat(32)}`,
    onchainError: null,
    ...over,
  });

  beforeEach(() => {
    store = createStore({ seed: false });
    kekB64 = randomBytes(32).toString("base64");
    process.env[CUSTODY_KEK_ENV] = kekB64;
    process.env[CUSTODY_KEK_ID_ENV] = "k1";
  });

  afterEach(() => {
    store.close();
    for (const [name, v] of [
      [CUSTODY_KEK_ENV, saved.k],
      [CUSTODY_KEK_ID_ENV, saved.i],
    ] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  it("stores the sealed blob, leaves the plaintext column NULL, and unseals to the key", () => {
    insertKey("row-a");
    const w = wallet();
    const returned = store.repos.apiKeys.recordOperatorWallet("row-a", w);
    const row = raw("row-a");

    expect(row.operator_wallet_private_key).toBeNull();
    expect(typeof row.operator_wallet_key_sealed).toBe("string");
    expect(String(row.operator_wallet_key_sealed)).toMatch(/^pcc-seal:v1:k1:/);
    expect(unsealCustodialKey(String(row.operator_wallet_key_sealed), { rowId: "row-a", address: w.address })).toBe(
      w.privateKey,
    );
    // The key is nowhere in the row, in any column, in any casing.
    const bare = w.privateKey.slice(2);
    for (const v of Object.values(row)) {
      if (typeof v === "string") {
        expect(v.toLowerCase()).not.toContain(bare.toLowerCase());
      }
    }
    // The rest of the wallet record is stored as before.
    expect(row.operator_wallet_address).toBe(w.address);
    expect(row.operator_wallet_custody).toBe("gateway");
    expect(row.agent_wallet_onchain_status).toBe("written");
    expect(row.agent_wallet_onchain_tx_hash).toBe(w.onchainTxHash);
    // The returned row carries the sealed value, not the key.
    expect(returned?.operatorWalletPrivateKey).toBeNull();
    expect(returned?.operatorWalletKeySealed).toBe(row.operator_wallet_key_sealed);
  });

  it("clears a legacy plaintext value on the row when it records the wallet", () => {
    insertKey("row-legacy");
    const legacy = randKeyHex();
    store.db.run(sql`UPDATE api_keys SET operator_wallet_private_key = ${legacy} WHERE id = 'row-legacy'`);
    expect(raw("row-legacy").operator_wallet_private_key).toBe(legacy);
    store.repos.apiKeys.recordOperatorWallet("row-legacy", wallet());
    expect(raw("row-legacy").operator_wallet_private_key).toBeNull();
  });

  it("a second record (written then failed) re-seals under a fresh IV and still unseals", () => {
    insertKey("row-twice");
    const w = wallet();
    store.repos.apiKeys.recordOperatorWallet("row-twice", w);
    const first = String(raw("row-twice").operator_wallet_key_sealed);
    store.repos.apiKeys.recordOperatorWallet("row-twice", {
      ...w,
      onchainStatus: "failed",
      onchainTxHash: null,
      onchainError: "synthetic failure",
    });
    const row = raw("row-twice");
    const second = String(row.operator_wallet_key_sealed);
    expect(second).not.toBe(first);
    expect(second.split(":")[3]).not.toBe(first.split(":")[3]); // new IV
    expect(unsealCustodialKey(second, { rowId: "row-twice", address: w.address })).toBe(w.privateKey);
    expect(row.operator_wallet_private_key).toBeNull();
    expect(row.agent_wallet_onchain_status).toBe("failed");
  });

  it("[neg] the sealed blob is bound to its row: copied to another row it does not unseal", () => {
    insertKey("row-1");
    insertKey("row-2");
    const w = wallet();
    store.repos.apiKeys.recordOperatorWallet("row-1", w);
    const blob = String(raw("row-1").operator_wallet_key_sealed);
    expect(() => unsealCustodialKey(blob, { rowId: "row-2", address: w.address })).toThrow(CustodyUnsealError);
    expect(() => unsealCustodialKey(blob, { rowId: "row-1", address: randAddress() })).toThrow(CustodyUnsealError);
  });

  const noKek: Array<[string, Record<string, string | undefined>]> = [
    ["KEK unset", { [CUSTODY_KEK_ENV]: undefined }],
    ["KEK blank", { [CUSTODY_KEK_ENV]: "" }],
    ["KEK wrong length (31 bytes)", { [CUSTODY_KEK_ENV]: randomBytes(31).toString("base64") }],
    ["KEK not base64", { [CUSTODY_KEK_ENV]: "definitely-not-a-key" }],
    ["KEK id unset", { [CUSTODY_KEK_ID_ENV]: undefined }],
    ["KEK id blank", { [CUSTODY_KEK_ID_ENV]: "   " }],
  ];

  it.each(noKek)(
    "[neg] with %s it REFUSES: throws CustodyKekUnavailableError and writes nothing at all",
    (_name, overrides) => {
      insertKey("row-nokek");
      const before = raw("row-nokek");
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const w = wallet();
      expect(() => store.repos.apiKeys.recordOperatorWallet("row-nokek", w)).toThrow(CustodyKekUnavailableError);
      const after = raw("row-nokek");
      // Not even the address or the status was recorded: the row is byte-for-byte as it was.
      expect(after).toEqual(before);
      expect(after.operator_wallet_private_key).toBeNull();
      expect(after.operator_wallet_key_sealed).toBeNull();
      expect(after.operator_wallet_address).toBeNull();
      // And no plaintext key landed anywhere in the database.
      const hits = store.db.all(
        sql`SELECT id FROM api_keys WHERE operator_wallet_private_key LIKE ${`%${w.privateKey.slice(2)}%`}`,
      );
      expect(hits).toHaveLength(0);
    },
  );

  it("[neg] a malformed key is refused before any write", () => {
    insertKey("row-badkey");
    const before = raw("row-badkey");
    expect(() =>
      store.repos.apiKeys.recordOperatorWallet("row-badkey", wallet({ privateKey: "not-a-key" })),
    ).toThrow();
    expect(() =>
      store.repos.apiKeys.recordOperatorWallet("row-badkey", wallet({ address: "0x123" })),
    ).toThrow();
    expect(raw("row-badkey")).toEqual(before);
  });
});

describe("N1: the sealed column is added by migrate.ts, additively and idempotently", () => {
  const cols = (store: Store): Array<{ name: string; type: string; notnull: number; dflt_value: unknown }> =>
    store.db.all(sql`PRAGMA table_info(api_keys)`) as never;

  it("a fresh database has operator_wallet_key_sealed (nullable TEXT) next to the legacy plaintext column", () => {
    const store = createStore({ seed: false });
    try {
      const byName = new Map(cols(store).map((c) => [c.name, c]));
      const sealed = byName.get("operator_wallet_key_sealed");
      expect(sealed).toBeDefined();
      expect(sealed!.type).toBe("TEXT");
      expect(sealed!.notnull).toBe(0);
      expect(sealed!.dflt_value).toBeNull();
      // Nothing existing was dropped or altered.
      const legacy = byName.get("operator_wallet_private_key");
      expect(legacy).toBeDefined();
      expect(legacy!.type).toBe("TEXT");
      expect(legacy!.notnull).toBe(0);
      for (const c of [
        "operator_wallet_address",
        "operator_wallet_custody",
        "agent_wallet_onchain_status",
        "agent_wallet_onchain_tx_hash",
        "agent_wallet_onchain_error",
        "smart_wallet_address",
      ]) {
        expect(byName.has(c)).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("an existing database in the pre-N1 shape gains the column, keeps its rows, and re-running is a no-op", () => {
    const { sqlite } = createDatabase(":memory:");
    // The api_keys table as it stood before N1: the original CREATE plus the
    // wallet columns the earlier safeAddColumn calls had added.
    sqlite.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
        operator_id TEXT NOT NULL, name TEXT, description TEXT, scopes TEXT NOT NULL,
        rate_limit TEXT NOT NULL DEFAULT '1000/hour', usage_count TEXT NOT NULL DEFAULT '0',
        last_used_at TEXT, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, metadata TEXT,
        operator_wallet_address TEXT, operator_wallet_private_key TEXT
      );
    `);
    const legacyKey = randKeyHex();
    const legacyAddr = randAddress();
    sqlite
      .prepare(
        `INSERT INTO api_keys (id, key_hash, key_prefix, operator_id, scopes, created_at,
           operator_wallet_address, operator_wallet_private_key)
         VALUES ('legacy-row', 'h', 'p', 'op', '["operator"]', 'now', ?, ?)`,
      )
      .run(legacyAddr, legacyKey);

    migrateDatabase(sqlite);
    const names = (sqlite.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("operator_wallet_key_sealed");
    expect(names).toContain("operator_wallet_private_key");

    // The legacy row is untouched by the migration (sealing is the operator's script).
    const row = sqlite.prepare("SELECT * FROM api_keys WHERE id = 'legacy-row'").get() as Row;
    expect(row.operator_wallet_private_key).toBe(legacyKey);
    expect(row.operator_wallet_key_sealed).toBeNull();
    expect(row.operator_wallet_address).toBe(legacyAddr);

    // Idempotent.
    expect(() => migrateDatabase(sqlite)).not.toThrow();
    const again = (sqlite.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).filter(
      (c) => c.name === "operator_wallet_key_sealed",
    );
    expect(again).toHaveLength(1);
    sqlite.close();
  });
});
