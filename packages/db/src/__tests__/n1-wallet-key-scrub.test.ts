import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiKeyRepository,
  createDatabase,
  createStore,
  migrateDatabase,
  schema,
} from "../index.js";

const hexDecoy = "0x" + "de".repeat(32);
const markerDecoy = "SECRET-MARKER-KEY-1";
const privateKeyProperty = ["operator", "Wallet", "Private", "Key"].join("");
const connections = new Set<Database.Database>();
const directories = new Set<string>();

afterEach(() => {
  for (const sqlite of connections) {
    if (sqlite.open) sqlite.close();
  }
  connections.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function memoryDatabase() {
  const connection = createDatabase();
  connections.add(connection.sqlite);
  migrateDatabase(connection.sqlite);
  return connection;
}

function filePath() {
  const directory = mkdtempSync(join(tmpdir(), "pcc-wallet-scrub-"));
  directories.add(directory);
  return join(directory, "store.sqlite");
}

function insertLegacyKey(
  sqlite: Database.Database,
  id: string,
  privateKey: string,
  revoked = false,
) {
  sqlite.prepare(`
    INSERT INTO api_keys (
      id, key_hash, key_prefix, operator_id, name, description, scopes,
      rate_limit, usage_count, last_used_at, created_at, expires_at, revoked_at,
      metadata, public_key, onchain_agent_id, onchain_status, onchain_tx_hash,
      onchain_registry_address, onchain_chain_id, onchain_attempted_at,
      onchain_error, operator_wallet_address, operator_wallet_private_key,
      operator_wallet_custody, agent_wallet_onchain_status,
      agent_wallet_onchain_tx_hash, agent_wallet_onchain_error,
      smart_wallet_address, passkey_credential_id, passkey_public_key, passkey_rp_id
    ) VALUES (
      @id, @keyHash, 'pcc_test', 'operator-test', @name, 'fixture description', '["jobs"]',
      '120', '3', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', @revokedAt, '{"fixture":true}', 'test-public-key',
      '42', 'pending', 'fixture-registration-tx', 'fixture-registry', 31337,
      '2026-01-03T00:00:00.000Z', 'fixture-registration-error',
      '0x1111111111111111111111111111111111111111', @privateKey, 'gateway',
      'written', 'fixture-wallet-tx', 'fixture-wallet-error',
      'fixture-smart-wallet', 'fixture-credential', 'fixture-passkey', 'fixture.test'
    )
  `).run({
    id,
    keyHash: `hash-${id}`,
    name: `fixture-${id}`,
    revokedAt: revoked ? "2026-01-04T00:00:00.000Z" : null,
    privateKey,
  });
}

function remainingKeyCount(sqlite: Database.Database): number {
  return (sqlite.prepare(`
    SELECT COUNT(*) AS count FROM api_keys
    WHERE operator_wallet_private_key IS NOT NULL
  `).get() as { count: number }).count;
}

function otherColumns(sqlite: Database.Database) {
  const columns = (sqlite.pragma("table_info(api_keys)") as Array<{ name: string }>)
    .map(({ name }) => name)
    .filter((name) => name !== "operator_wallet_private_key")
    .map((name) => `"${name}"`);
  return sqlite.prepare(`SELECT ${columns.join(", ")} FROM api_keys ORDER BY id`).all();
}

describe("wallet key storage invariant", () => {
  it("scrubs hex and marker keys from revoked and active legacy rows while preserving all other columns", () => {
    const { sqlite } = memoryDatabase();
    insertLegacyKey(sqlite, "hex-active", hexDecoy);
    insertLegacyKey(sqlite, "hex-revoked", "0x" + "ad".repeat(32), true);
    insertLegacyKey(sqlite, "marker-active", markerDecoy);
    insertLegacyKey(sqlite, "marker-revoked", "SECRET-MARKER-KEY-2", true);
    const before = otherColumns(sqlite);
    sqlite.pragma("secure_delete = OFF");

    migrateDatabase(sqlite);

    expect(remainingKeyCount(sqlite)).toBe(0);
    expect(otherColumns(sqlite)).toEqual(before);
    expect(sqlite.pragma("secure_delete", { simple: true })).toBe(0);
  });

  it.each([
    { mode: "OFF", value: 0, restorePattern: /secure_delete\s*=\s*(OFF|0)\b/i },
    { mode: "FAST", value: 2, restorePattern: /secure_delete\s*=\s*(FAST|2)\b/i },
  ])("enables secure_delete for the scrub and restores $mode after success or an UPDATE error", ({ mode, value, restorePattern }) => {
    const statements: string[] = [];
    const sqlite = new Database(":memory:", { verbose: (sql) => statements.push(sql) });
    connections.add(sqlite);
    migrateDatabase(sqlite);
    insertLegacyKey(sqlite, "secure-delete-key", markerDecoy);
    sqlite.pragma(`secure_delete = ${mode}`);
    expect(sqlite.pragma("secure_delete", { simple: true })).toBe(value);

    const expectScrubOrder = () => {
      const enableIndex = statements.findIndex((sql) => /secure_delete\s*=\s*(ON|1)\b/i.test(sql));
      const updateIndex = statements.findIndex((sql) => /UPDATE\s+api_keys\s+SET\s+operator_wallet_private_key\s*=\s*NULL\b/i.test(sql));
      const restoreIndex = statements.findIndex((sql) => restorePattern.test(sql));
      expect(enableIndex).toBeGreaterThanOrEqual(0);
      expect(updateIndex).toBeGreaterThan(enableIndex);
      expect(restoreIndex).toBeGreaterThan(updateIndex);
      expect(sqlite.pragma("secure_delete", { simple: true })).toBe(value);
    };

    statements.length = 0;
    migrateDatabase(sqlite);

    expectScrubOrder();
    expect(remainingKeyCount(sqlite)).toBe(0);

    insertLegacyKey(sqlite, "secure-delete-aborted-key", hexDecoy);
    sqlite.exec(`
      CREATE TRIGGER abort_wallet_key_scrub
      BEFORE UPDATE OF operator_wallet_private_key ON api_keys
      BEGIN
        SELECT RAISE(ABORT, 'x');
      END
    `);
    statements.length = 0;

    expect(() => migrateDatabase(sqlite)).toThrow("x");

    expectScrubOrder();
    expect(remainingKeyCount(sqlite)).toBe(1);
  });

  it("keeps keys absent and other columns unchanged on a third migration", () => {
    const { sqlite } = memoryDatabase();
    insertLegacyKey(sqlite, "idempotent", markerDecoy);
    const before = otherColumns(sqlite);

    migrateDatabase(sqlite);
    expect(() => migrateDatabase(sqlite)).not.toThrow();

    expect(remainingKeyCount(sqlite)).toBe(0);
    expect(otherColumns(sqlite)).toEqual(before);
  });

  it("throws when the scrub cannot remove keys without exposing any decoy in the error or stack", () => {
    const { sqlite } = memoryDatabase();
    const decoys = [hexDecoy, markerDecoy];
    insertLegacyKey(sqlite, "blocked-hex", decoys[0]);
    insertLegacyKey(sqlite, "blocked-marker", decoys[1], true);
    sqlite.pragma("secure_delete = FAST");
    sqlite.exec(`
      CREATE TRIGGER prevent_wallet_key_scrub
      BEFORE UPDATE OF operator_wallet_private_key ON api_keys
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    let failure: unknown;
    try {
      migrateDatabase(sqlite);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(remainingKeyCount(sqlite)).toBe(2);
    expect(sqlite.pragma("secure_delete", { simple: true })).toBe(2);
    const error = failure as Error;
    expect(error.message).toContain("2");
    for (const decoy of decoys) {
      expect(error.message.includes(decoy)).toBe(false);
      expect((error.stack ?? "").includes(decoy)).toBe(false);
    }
    expect(error.message.includes("blocked-hex")).toBe(false);
    expect(error.message.includes("blocked-marker")).toBe(false);
    expect(error.message.includes("0x1111111111111111111111111111111111111111")).toBe(false);
  });

  it.each([hexDecoy, markerDecoy])("removes a decoy's bytes from a file database and any remaining WAL (%#)", (decoy) => {
    const dbPath = filePath();
    const { sqlite } = createDatabase(dbPath);
    connections.add(sqlite);
    migrateDatabase(sqlite);
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    sqlite.pragma("secure_delete = OFF");
    insertLegacyKey(sqlite, "file-key", decoy);
    sqlite.close();
    expect(readFileSync(dbPath).includes(Buffer.from(decoy))).toBe(true);

    const store = createStore({ dbPath, seed: false });
    store.close();

    const representations = [
      Buffer.from(decoy),
      Buffer.from(decoy.toLowerCase()),
      Buffer.from(Buffer.from(decoy).toString("hex")),
    ];
    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      for (const representation of representations) {
        expect(bytes.includes(representation)).toBe(false);
      }
    }
  });

  it("omits the private key column and value from every repository operation", () => {
    const statements: string[] = [];
    const sqlite = new Database(":memory:", { verbose: (sql) => statements.push(sql) });
    connections.add(sqlite);
    migrateDatabase(sqlite);
    insertLegacyKey(sqlite, "read-key", markerDecoy);
    const repository = new ApiKeyRepository(drizzle(sqlite, { schema }));
    statements.length = 0;
    const results: unknown[] = [];

    results.push(repository.findByHash("hash-read-key"));
    results.push(repository.findById("read-key"));
    results.push(repository.findByOperator("operator-test"));
    results.push(repository.findActiveByHash("hash-read-key"));
    results.push(repository.insert({
      id: "inserted-key",
      keyHash: "hash-inserted-key",
      keyPrefix: "pcc_test",
      operatorId: "operator-test",
      scopes: "[]",
      rateLimit: "120",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    results.push(repository.incrementUsage("read-key"));
    results.push(repository.listActive());
    results.push(repository.countByOperator("operator-test"));
    results.push(repository.recordOnchainSuccess("read-key", {
      agentId: 42n,
      txHash: "fixture-tx",
      registryAddress: "fixture-registry",
      chainId: 31337,
    }));
    results.push(repository.recordOnchainFailure("read-key", "fixture-error"));
    results.push(repository.listPendingOnchain());
    results.push(repository.setPasskeyCredential("read-key", {
      credentialId: "fixture-credential",
      publicKey: "fixture-public-key",
      rpId: "fixture.test",
    }));
    results.push(repository.revoke("read-key"));

    expect(statements.length).toBeGreaterThan(13);
    expect(statements.some((sql) => sql.includes("operator_wallet_private_key"))).toBe(false);
    for (const result of results) {
      const rows = Array.isArray(result) ? result : [result];
      for (const row of rows) {
        if (row !== null && typeof row === "object") {
          expect(Object.hasOwn(row, privateKeyProperty)).toBe(false);
        }
      }
      expect((JSON.stringify(result) ?? "").includes(markerDecoy)).toBe(false);
    }
    expect(typeof (repository as unknown as Record<string, unknown>).recordOperatorWallet).not.toBe("function");
  });
});
