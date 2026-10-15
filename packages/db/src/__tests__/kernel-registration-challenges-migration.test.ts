import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

describe("kernel registration challenge migration", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    migrateDatabase(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertChallenge(createdByKeyId: string | null = "key-original") {
    sqlite.prepare(`
      INSERT INTO kernel_registration_challenges (
        id, kernel_id, algorithm, signer, created_by_key_id, nonce, env,
        chain_id, domain, message, issued_at, expires_at
      ) VALUES (
        'challenge-original', 'kernel-original', 'ed25519', '0x1234', ?,
        'nonce-original', 'prod', 84532, 'capability.network',
        'UFBDLUtFUk5FTC1SRUctVjEK', '2026-10-14T18:00:00.000Z',
        '2026-10-14T18:10:00.000Z'
      )
    `).run(createdByKeyId);
  }

  it("creates all challenge fields with an optional consumption timestamp", () => {
    const columns = sqlite.prepare("PRAGMA table_info(kernel_registration_challenges)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.map(({ name }) => name)).toEqual([
      "id", "kernel_id", "algorithm", "signer", "created_by_key_id", "nonce",
      "env", "chain_id", "domain", "message", "issued_at", "expires_at", "consumed_at",
    ]);
    expect(columns.find(({ name }) => name === "message")?.notnull).toBe(1);
    expect(columns.find(({ name }) => name === "consumed_at")?.notnull).toBe(0);
    insertChallenge();
    expect(sqlite.prepare("SELECT consumed_at FROM kernel_registration_challenges").get()).toEqual({
      consumed_at: null,
    });
  });

  it("preserves the exact stored message and challenge state on repeated migration", () => {
    insertChallenge();
    sqlite.prepare("UPDATE kernel_registration_challenges SET consumed_at = ? WHERE id = ?")
      .run("2026-10-14T18:01:00.000Z", "challenge-original");
    const original = sqlite.prepare("SELECT * FROM kernel_registration_challenges").get();

    migrateDatabase(sqlite);
    migrateDatabase(sqlite);

    expect(sqlite.prepare("SELECT * FROM kernel_registration_challenges").get()).toEqual(original);
  });

  it.each(["key-original", null])("keeps the issuing key immutable when it is %s", (createdByKeyId) => {
    insertChallenge(createdByKeyId);

    expect(() => sqlite.prepare("UPDATE kernel_registration_challenges SET created_by_key_id = ?")
      .run("key-other")).toThrow("Registration challenge creator is immutable");
    expect(sqlite.prepare("SELECT created_by_key_id FROM kernel_registration_challenges").get()).toEqual({
      created_by_key_id: createdByKeyId,
    });
    expect(() => sqlite.prepare("UPDATE kernel_registration_challenges SET consumed_at = ?")
      .run("2026-10-14T18:01:00.000Z")).not.toThrow();
  });

  it("creates the challenge table before the final wallet key scrub", () => {
    sqlite.exec("DROP TABLE kernel_registration_challenges");
    sqlite.prepare(`
      INSERT INTO api_keys (
        id, key_hash, key_prefix, operator_id, name, scopes, rate_limit,
        usage_count, created_at, operator_wallet_private_key
      ) VALUES ('legacy', 'hash', 'prefix', 'operator', 'name', '[]', '120',
        '0', '2026-10-14T18:00:00.000Z', 'legacy-marker')
    `).run();
    sqlite.exec(`
      CREATE TRIGGER reject_wallet_key_scrub BEFORE UPDATE OF operator_wallet_private_key ON api_keys
      BEGIN SELECT RAISE(ABORT, 'injected scrub failure'); END;
    `);

    expect(() => migrateDatabase(sqlite)).toThrow("injected scrub failure");

    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kernel_registration_challenges'
    `).get()).toEqual({ name: "kernel_registration_challenges" });
  });
});
