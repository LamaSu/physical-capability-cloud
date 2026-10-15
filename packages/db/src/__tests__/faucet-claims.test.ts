import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase } from "../index.js";

const NOW = "2026-10-13T00:00:00.000Z";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("faucet claim migration", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ sqlite } = createDatabase());
    migrateDatabase(sqlite);
  });

  afterEach(() => { sqlite.close(); });

  function insertClaim(overrides: Record<string, unknown> = {}) {
    const claim = {
      link_id: "wl-first", token: "eth", seq: 1, account_id: "account-first",
      address: ADDRESS, chain_id: 84532, amount: "0.0001", status: "pending",
      tx_hash: null, error_class: null, created_at: NOW, updated_at: NOW,
      ...overrides,
    };
    sqlite.prepare(`
      INSERT INTO faucet_claims (
        link_id, token, seq, account_id, address, chain_id, amount,
        status, tx_hash, error_class, created_at, updated_at
      ) VALUES (
        @link_id, @token, @seq, @account_id, @address, @chain_id, @amount,
        @status, @tx_hash, @error_class, @created_at, @updated_at
      )
    `).run(claim);
  }

  it("matches migration 0005 and runtime DDL statement for statement", () => {
    const migration = readFileSync(new URL("../migrations/0005_faucet_claims.sql", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../migrate.ts", import.meta.url), "utf8");
    const blocks = [...runtime.matchAll(/sqlite\.exec\(`([\s\S]*?)`\);/g)]
      .map((match) => match[1])
      .filter((sql) => /CREATE TABLE IF NOT EXISTS faucet_claims\s*\(/.test(sql));
    expect(blocks).toHaveLength(1);
    const statements = (sql: string) => sql.replace(/--[^\n]*/g, "")
      .split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements(blocks[0]!)).toEqual(statements(migration));
  });

  it("defaults new claims to zero attempts with no lease or last attempt", () => {
    insertClaim();
    expect(sqlite.prepare("SELECT attempts, lease_until, last_attempt_at FROM faucet_claims").get())
      .toEqual({ attempts: 0, lease_until: null, last_attempt_at: null });
  });

  it("refuses duplicate claim keys while allowing different sequence and token", () => {
    insertClaim();
    expect(() => insertClaim()).toThrow(/UNIQUE constraint failed/);
    expect(() => insertClaim({ seq: 2 })).not.toThrow();
    expect(() => insertClaim({ token: "usdc", amount: "1" })).not.toThrow();
  });

  it("refuses duplicate transaction hashes and allows several unfinished claims", () => {
    const hash = `0x${randomBytes(32).toString("hex")}`;
    insertClaim({ status: "succeeded", tx_hash: hash });
    expect(() => insertClaim({ seq: 2, status: "succeeded", tx_hash: hash }))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insertClaim({ seq: 3 })).not.toThrow();
    expect(() => insertClaim({ seq: 4, status: "failed", error_class: "timeout" })).not.toThrow();
  });

  it.each([
    { token: "eth", amount: "1" },
    { token: "usdc", amount: "0.0001" },
    { token: "other", amount: "1" },
  ])("refuses unpromised token and amount $token / $amount", (claim) => {
    expect(() => insertClaim(claim)).toThrow(/CHECK constraint failed/);
  });

  it("accepts the exact ETH and USDC claim amounts", () => {
    expect(() => insertClaim()).not.toThrow();
    expect(() => insertClaim({ token: "usdc", amount: "1" })).not.toThrow();
  });

  it("requires a transaction hash exactly when status is succeeded", () => {
    const hash = `0x${randomBytes(32).toString("hex")}`;
    expect(() => insertClaim({ status: "succeeded" })).toThrow(/CHECK constraint failed/);
    expect(() => insertClaim({ status: "pending", tx_hash: hash })).toThrow(/CHECK constraint failed/);
    expect(() => insertClaim({ status: "failed", tx_hash: hash })).toThrow(/CHECK constraint failed/);
    expect(() => insertClaim({ status: "succeeded", tx_hash: hash })).not.toThrow();
  });

  it("refuses statuses outside pending, succeeded and failed", () => {
    expect(() => insertClaim({ status: "complete" })).toThrow(/CHECK constraint failed/);
  });

  it("indexes the address, account and global cap windows", () => {
    const indexes = sqlite.prepare("PRAGMA index_list('faucet_claims')").all() as Array<{
      name: string; unique: number; partial: number;
    }>;
    const indexedColumns = (name: string) => (sqlite.prepare(`PRAGMA index_info('${name}')`).all() as Array<{
      name: string;
    }>).map((column) => column.name);
    for (const columns of [["address", "created_at"], ["account_id", "created_at"], ["created_at"]]) {
      expect(indexes.some((index) => JSON.stringify(indexedColumns(index.name)) === JSON.stringify(columns)))
        .toBe(true);
    }
    expect(indexes.some((index) => index.unique === 1 && index.partial === 1
      && JSON.stringify(indexedColumns(index.name)) === JSON.stringify(["tx_hash"]))).toBe(true);
  });

  it("keeps claims and their uniqueness constraints across migration reruns", () => {
    const hash = `0x${randomBytes(32).toString("hex")}`;
    insertClaim({ status: "succeeded", tx_hash: hash });
    const before = sqlite.prepare("SELECT * FROM faucet_claims").all();
    expect(() => migrateDatabase(sqlite)).not.toThrow();
    expect(sqlite.prepare("SELECT * FROM faucet_claims").all()).toEqual(before);
    expect(() => insertClaim()).toThrow(/UNIQUE constraint failed/);
    expect(() => insertClaim({ seq: 2, status: "succeeded", tx_hash: hash }))
      .toThrow(/UNIQUE constraint failed/);
  });
});
