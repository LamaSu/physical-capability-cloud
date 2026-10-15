import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyRepository, createDatabase, migrateDatabase } from "../index.js";
import { scrubOperatorWalletPrivateKeys } from "../migrate.js";

const pendingTable = "operator_wallet_key_vacuum_pending";
const connections = new Set<Database.Database>();
const directories = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of connections) if (sqlite.open) sqlite.close();
  connections.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function filePath() {
  const directory = mkdtempSync(join(tmpdir(), "pcc-wallet-residue-"));
  directories.add(directory);
  return join(directory, "store.sqlite");
}

function open(dbPath: string) {
  const connection = createDatabase(dbPath);
  connections.add(connection.sqlite);
  return connection;
}

function pending(sqlite: Database.Database) {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(pendingTable) !== undefined;
}

function keyCount(sqlite: Database.Database) {
  return (sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE operator_wallet_private_key IS NOT NULL")
    .get() as { count: number }).count;
}

function otherColumns(sqlite: Database.Database) {
  const columns = (sqlite.pragma("table_info(api_keys)") as Array<{ name: string }>)
    .map(({ name }) => name).filter((name) => name !== "operator_wallet_private_key");
  return sqlite.prepare(`SELECT ${columns.join(", ")} FROM api_keys ORDER BY id`).all();
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

// Replay 396d6a4b's provisionApiKey INSERT and repository write order. These
// fields and UPDATEs match auth/api-key-auth.ts and repositories/api-keys.ts
// at that revision; only the removed recordOperatorWallet uses raw SQL.
function replay(seed: number, rows = 58, rounds = 20) {
  const dbPath = filePath();
  const { sqlite, db } = open(dbPath);
  migrateDatabase(sqlite);
  expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  sqlite.pragma("secure_delete = OFF");
  const repository = new ApiKeyRepository(db);
  const prng = random(seed);
  const keys: string[] = [];
  const ids: string[] = [];
  for (let index = 0; index < rows; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const key = "0x" + createHash("sha256").update(`N1-decoy:${seed}:${index}`).digest("hex");
    keys.push(key);
    ids.push(id);
    repository.insert({
      id, keyHash: createHash("sha256").update(`api-decoy:${seed}:${index}`).digest("hex"),
      keyPrefix: "pcc_live_decoy", operatorId: `decoy-${index}@example.test`,
      name: `Decoy operator ${index}`, description: "Operator capability: 3D printing",
      scopes: '["*"]', rateLimit: "1000/hour", usageCount: "0",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: null,
      metadata: JSON.stringify({ capability: "3D printing", provisionedAt: "2026-01-01T00:00:00.000Z", source: "landing-page" }),
      publicKey: createHash("sha256").update(`public-decoy:${index}`).digest("hex"),
    });
    repository.recordOnchainSuccess(id, {
      agentId: BigInt(index + 1), txHash: "0x" + "aa".repeat(32),
      registryAddress: "0x" + "bb".repeat(20), chainId: 84532,
    });
    sqlite.prepare(`UPDATE api_keys SET operator_wallet_address = ?,
      operator_wallet_private_key = ?, operator_wallet_custody = 'gateway',
      agent_wallet_onchain_status = 'written', agent_wallet_onchain_tx_hash = ?,
      agent_wallet_onchain_error = NULL WHERE id = ?`)
      .run("0x" + "cc".repeat(20), key, "0x" + "dd".repeat(32), id);
  }
  for (let round = 0; round < rounds; round++) {
    const shuffled = [...ids];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const next = Math.floor(prng() * (index + 1));
      [shuffled[index], shuffled[next]] = [shuffled[next], shuffled[index]];
    }
    for (const id of shuffled) repository.incrementUsage(id);
    if (round % 4 === 0) repository.revoke(ids[Math.floor(prng() * ids.length)]);
  }
  const before = otherColumns(sqlite);
  sqlite.close();
  return { dbPath, keys, before, rows };
}

function occurrences(bytes: Buffer, needle: string) {
  let count = 0;
  for (let offset = bytes.indexOf(needle); offset !== -1; offset = bytes.indexOf(needle, offset + 1)) count++;
  return count;
}

// Count overlapping 16-hex windows, including remnants of incomplete keys.
// Only counts reach assertion messages/logs; never print decoy contents.
function scan(dbPath: string, keys: string[]) {
  const windows = new Set(keys.flatMap((key) => {
    const hex = key.slice(2);
    return Array.from({ length: hex.length - 15 }, (_, index) => hex.slice(index, index + 16));
  }));
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) => {
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const complete = keys.reduce((count, key) => count + occurrences(bytes, key), 0);
    let fragments = 0;
    for (const match of bytes.toString("latin1").matchAll(/[0-9a-f]{16,}/g)) {
      for (let index = 0; index <= match[0].length - 16; index++) {
        if (windows.has(match[0].slice(index, index + 16))) fragments++;
      }
    }
    return { complete, fragments };
  });
}

function expectNoFragments(dbPath: string, keys: string[]) {
  expect(scan(dbPath, keys).map(({ fragments }) => fragments)).toEqual([0, 0, 0]);
}

describe("wallet key residue compaction", () => {
  it.each([7, 11, 3])("removes updated-row residue and every 16-hex fragment (seed %i)", (seed) => {
    const { dbPath, keys, before, rows } = replay(seed);
    const initial = scan(dbPath, keys);
    expect(initial[0].complete).toBeGreaterThan(keys.length);
    const { sqlite } = open(dbPath);

    migrateDatabase(sqlite);

    const after = scan(dbPath, keys);
    console.info(`N1 residue seed=${seed} rows=${rows} before=${JSON.stringify(initial)} after=${JSON.stringify(after)}`);
    expect(keyCount(sqlite)).toBe(0);
    expect(otherColumns(sqlite)).toEqual(before);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number }).count).toBe(rows);
    expectNoFragments(dbPath, keys);
    expect(pending(sqlite)).toBe(false);
    sqlite.close();
    expectNoFragments(dbPath, keys);
  });

  it("retries an interrupted compaction after the UPDATE commits", () => {
    const { dbPath, keys } = replay(7);
    const { sqlite } = open(dbPath);
    const exec = sqlite.exec.bind(sqlite);
    const spy = vi.spyOn(sqlite, "exec").mockImplementation((sql) => {
      if (/^VACUUM\b/i.test(sql.trim())) throw new Error("injected compaction interruption");
      return exec(sql);
    });

    expect(() => migrateDatabase(sqlite)).toThrow("injected compaction interruption");
    expect(keyCount(sqlite)).toBe(0);
    expect(pending(sqlite)).toBe(true);
    spy.mockRestore();
    sqlite.close();

    const retry = open(dbPath).sqlite;
    migrateDatabase(retry);
    expectNoFragments(dbPath, keys);
    expect(pending(retry)).toBe(false);
    retry.close();
    expectNoFragments(dbPath, keys);
  });

  it.each([
    { busy: 1, log: 5, checkpointed: 0 },
    { busy: 0, log: 5, checkpointed: 4 },
  ])("checks checkpoint results with bounded retries ($busy/$log/$checkpointed)", (result) => {
    const { dbPath, keys } = replay(11);
    const { sqlite } = open(dbPath);
    const pragma = sqlite.pragma.bind(sqlite);
    let attempts = 0;
    const spy = vi.spyOn(sqlite, "pragma").mockImplementation((sql, options) => {
      if (/^wal_checkpoint\(TRUNCATE\)$/i.test(sql)) {
        attempts++;
        return [result];
      }
      return pragma(sql, options);
    });

    expect(() => migrateDatabase(sqlite)).toThrow("Wallet private key scrub checkpoint failed");
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
    expect(keyCount(sqlite)).toBe(0);
    expect(pending(sqlite)).toBe(true);
    spy.mockRestore();
    sqlite.close();

    const retry = open(dbPath).sqlite;
    migrateDatabase(retry);
    expect(pending(retry)).toBe(false);
    expectNoFragments(dbPath, keys);
  });

  it("retains retry state if the checkpoint after clearing the flag fails", () => {
    const { dbPath, keys } = replay(7);
    const { sqlite } = open(dbPath);
    const pragma = sqlite.pragma.bind(sqlite);
    let attempts = 0;
    const spy = vi.spyOn(sqlite, "pragma").mockImplementation((sql, options) => {
      if (/^wal_checkpoint\(TRUNCATE\)$/i.test(sql) && ++attempts > 1) {
        return [{ busy: 1, log: 5, checkpointed: 0 }];
      }
      return pragma(sql, options);
    });

    expect(() => migrateDatabase(sqlite)).toThrow("Wallet private key scrub checkpoint failed");
    expect(pending(sqlite)).toBe(true);
    spy.mockRestore();
    sqlite.close();
    const retry = open(dbPath).sqlite;
    migrateDatabase(retry);
    expect(pending(retry)).toBe(false);
    expectNoFragments(dbPath, keys);
  });

  it("retries a transient busy checkpoint and accepts a later clean result", () => {
    const { dbPath, keys } = replay(11);
    const { sqlite } = open(dbPath);
    const pragma = sqlite.pragma.bind(sqlite);
    let attempts = 0;
    vi.spyOn(sqlite, "pragma").mockImplementation((sql, options) => {
      if (/^wal_checkpoint\(TRUNCATE\)$/i.test(sql) && ++attempts === 1) {
        return [{ busy: 1, log: 5, checkpointed: 0 }];
      }
      return pragma(sql, options);
    });

    migrateDatabase(sqlite);

    expect(attempts).toBe(3);
    expect(pending(sqlite)).toBe(false);
    expectNoFragments(dbPath, keys);
  });

  it("never VACUUMs a fresh, already-NULL, or successfully compacted second boot", () => {
    const dbPath = filePath();
    const { sqlite } = open(dbPath);
    const spy = vi.spyOn(sqlite, "exec");
    const vacuums = () => spy.mock.calls.filter(([sql]) => /^VACUUM\b/i.test(sql.trim())).length;
    migrateDatabase(sqlite);
    expect(vacuums()).toBe(0);
    expect(pending(sqlite)).toBe(false);
    sqlite.prepare(`INSERT INTO api_keys (id, key_hash, key_prefix, operator_id, scopes, created_at)
      VALUES ('clean', 'clean-hash', 'pcc_decoy', 'clean-operator', '[]', '2026-01-01')`).run();
    migrateDatabase(sqlite);
    expect(vacuums()).toBe(0);
    expect(pending(sqlite)).toBe(false);
    sqlite.prepare("UPDATE api_keys SET operator_wallet_private_key = ? WHERE id = 'clean'")
      .run("0x" + "de".repeat(32));
    migrateDatabase(sqlite);
    expect(vacuums()).toBe(1);
    expect(pending(sqlite)).toBe(false);
    migrateDatabase(sqlite);
    expect(vacuums()).toBe(1);
    sqlite.close();
    const secondBoot = open(dbPath).sqlite;
    const secondSpy = vi.spyOn(secondBoot, "exec");
    migrateDatabase(secondBoot);
    expect(secondSpy.mock.calls.some(([sql]) => /^VACUUM\b/i.test(sql.trim()))).toBe(false);
    expect(pending(secondBoot)).toBe(false);
  });

  it("commits the UPDATE and flag together, VACUUMs outside the transaction, then checkpoints before clearing", () => {
    const { dbPath, keys } = replay(3);
    const { sqlite } = open(dbPath);
    const exec = sqlite.exec.bind(sqlite);
    const pragma = sqlite.pragma.bind(sqlite);
    const events: string[] = [];
    vi.spyOn(sqlite, "exec").mockImplementation((sql) => {
      if (sql.includes(`CREATE TABLE IF NOT EXISTS ${pendingTable}`)) {
        expect(sqlite.inTransaction).toBe(true);
        expect(keyCount(sqlite)).toBe(0);
        events.push("flag");
      }
      if (/^VACUUM\b/i.test(sql.trim())) {
        expect(sqlite.inTransaction).toBe(false);
        expect(keyCount(sqlite)).toBe(0);
        expect(pending(sqlite)).toBe(true);
        events.push("vacuum");
      }
      if (sql.includes(`DROP TABLE ${pendingTable}`)) {
        expect(events.at(-1)).toBe("checkpoint");
        events.push("clear");
      }
      return exec(sql);
    });
    vi.spyOn(sqlite, "pragma").mockImplementation((sql, options) => {
      if (/^wal_checkpoint\(TRUNCATE\)$/i.test(sql)) {
        expect(sqlite.inTransaction).toBe(false);
        expect(pending(sqlite)).toBe(events.at(-1) !== "clear");
        events.push("checkpoint");
      }
      return pragma(sql, options);
    });

    migrateDatabase(sqlite);

    expect(events).toEqual(["flag", "vacuum", "checkpoint", "clear", "checkpoint"]);
    expectNoFragments(dbPath, keys);
    expect(existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`).length : 0).toBe(0);
  });

  it("rolls back the UPDATE if recording the pending flag fails", () => {
    const { dbPath } = replay(7);
    const { sqlite } = open(dbPath);
    sqlite.pragma("secure_delete = FAST");
    const exec = sqlite.exec.bind(sqlite);
    vi.spyOn(sqlite, "exec").mockImplementation((sql) => {
      if (sql.includes(`CREATE TABLE IF NOT EXISTS ${pendingTable}`)) throw new Error("injected flag failure");
      return exec(sql);
    });

    expect(() => migrateDatabase(sqlite)).toThrow("injected flag failure");
    expect(keyCount(sqlite)).toBe(58);
    expect(pending(sqlite)).toBe(false);
    expect(sqlite.pragma("secure_delete", { simple: true })).toBe(2);
  });

  it("remains a no-op when the legacy column is absent", () => {
    const { sqlite } = open(":memory:");
    sqlite.exec("CREATE TABLE api_keys (id TEXT PRIMARY KEY)");
    const spy = vi.spyOn(sqlite, "exec");
    scrubOperatorWalletPrivateKeys(sqlite);
    expect(spy).not.toHaveBeenCalled();
    expect(pending(sqlite)).toBe(false);
  });
});
