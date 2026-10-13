import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase } from "../index.js";

const NOW = "2026-10-13T00:00:00.000Z";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("wallet link migration", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ sqlite } = createDatabase());
    migrateDatabase(sqlite);
  });

  afterEach(() => { sqlite.close(); });

  function insertRequest(id: string, userCode: string, nonce = id, status = "pending_proof") {
    sqlite.prepare(`
      INSERT INTO wallet_link_requests (
        id, key_type, address_or_pubkey, role, label, chain_id, env, domain,
        nonce, user_code, status, message, consent_version, consent_sha256,
        requester_ip_class, created_at, expires_at
      ) VALUES (?, 'secp256k1', ?, 'agent', 'db-test', 84532, 'test',
        'capability.network', ?, ?, ?, 'message', 'wallet-link-v1', ?,
        '192.0.2.x', ?, ?)
    `).run(id, ADDRESS, nonce, userCode, status, "a".repeat(64), NOW, "2026-10-13T00:10:00.000Z");
  }

  function insertLink(id: string, accountId: string, address = ADDRESS, chainId = 84532) {
    sqlite.prepare(`
      INSERT INTO wallet_links (
        id, account_id, role, subject_type, key_type, address_or_pubkey,
        chain_id, label, consent_version, consent_sha256, proof_message,
        proof_signature, request_id, approved_by, created_at, expires_at
      ) VALUES (?, ?, 'agent', 'agent', 'secp256k1', ?, ?, 'db-test',
        'wallet-link-v1', ?, 'message', 'signature', ?, ?, ?, ?)
    `).run(id, accountId, address, chainId, "a".repeat(64), `request-${id}`, accountId, NOW, "2026-11-12T00:00:00.000Z");
  }

  it("enforces global active key uniqueness case-insensitively, then allows reuse after revocation", () => {
    insertLink("wl-first", "account-first");
    expect(() => insertLink("wl-second", "account-second", ADDRESS.toUpperCase()))
      .toThrow(/UNIQUE constraint failed/);
    insertLink("wl-other-chain", "account-second", ADDRESS, 99999);
    sqlite.prepare("UPDATE wallet_links SET revoked_at = ?, revoke_reason = 'owner_request' WHERE id = ?")
      .run(NOW, "wl-first");
    expect(() => insertLink("wl-relinked", "account-second", ADDRESS.toUpperCase())).not.toThrow();
  });

  it("keeps user codes unique across both pending statuses and releases finalized codes", () => {
    insertRequest("lr-first", "BCDFGHJK");
    expect(() => insertRequest("lr-second", "BCDFGHJK", "second", "awaiting_approval"))
      .toThrow(/UNIQUE constraint failed/);
    sqlite.prepare("UPDATE wallet_link_requests SET status = 'denied' WHERE id = ?").run("lr-first");
    expect(() => insertRequest("lr-reused", "BCDFGHJK", "reused", "awaiting_approval")).not.toThrow();
    expect(() => insertRequest("lr-third", "BCDFGHJK", "third")).toThrow(/UNIQUE constraint failed/);
  });

  it("keeps proof nonces globally unique after a request is finalized", () => {
    insertRequest("lr-first", "BCDFGHJK", "shared-nonce", "failed");
    expect(() => insertRequest("lr-second", "LMNPQRST", "shared-nonce"))
      .toThrow(/UNIQUE constraint failed/);
  });

  it("stores distinct creating and approving API key ids on a link request", () => {
    insertRequest("lr-keys", "BCDFGHJK");
    sqlite.prepare(`
      UPDATE wallet_link_requests
      SET created_by_key_id = ?, approved_by_key_id = ?, approved_by = ?
      WHERE id = ?
    `).run("key-creating", "key-approving", "account-owner", "lr-keys");
    expect(sqlite.prepare(`
      SELECT created_by_key_id, approved_by_key_id, approved_by
      FROM wallet_link_requests WHERE id = ?
    `).get("lr-keys")).toEqual({
      created_by_key_id: "key-creating",
      approved_by_key_id: "key-approving",
      approved_by: "account-owner",
    });
  });

  it("defaults anonymous creating and cookie approving key ids to null on requests", () => {
    insertRequest("lr-anonymous", "BCDFGHJK");
    expect(sqlite.prepare(`
      SELECT created_by_key_id, approved_by_key_id
      FROM wallet_link_requests WHERE id = ?
    `).get("lr-anonymous")).toEqual({ created_by_key_id: null, approved_by_key_id: null });
  });

  it("stores the copied creating key and approving key separately from the link account", () => {
    insertLink("wl-keys", "account-owner");
    sqlite.prepare(`
      UPDATE wallet_links SET created_by_key_id = ?, approved_by_key_id = ? WHERE id = ?
    `).run("key-creating", "key-approving", "wl-keys");
    expect(sqlite.prepare(`
      SELECT created_by_key_id, approved_by_key_id, approved_by, account_id
      FROM wallet_links WHERE id = ?
    `).get("wl-keys")).toEqual({
      created_by_key_id: "key-creating",
      approved_by_key_id: "key-approving",
      approved_by: "account-owner",
      account_id: "account-owner",
    });
  });

  it("defaults anonymous creating and cookie approving key ids to null on links", () => {
    insertLink("wl-cookie", "account-owner");
    expect(sqlite.prepare(`
      SELECT created_by_key_id, approved_by_key_id FROM wallet_links WHERE id = ?
    `).get("wl-cookie")).toEqual({ created_by_key_id: null, approved_by_key_id: null });
  });

  it("matches migration 0004 and runtime wallet DDL statement for statement", () => {
    const migration = readFileSync(new URL("../migrations/0004_wallet_links.sql", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../migrate.ts", import.meta.url), "utf8");
    const blocks = [...runtime.matchAll(/sqlite\.exec\(`([\s\S]*?)`\);/g)]
      .map((match) => match[1])
      .filter((sql) => /CREATE TABLE IF NOT EXISTS wallet_link_requests\s*\(/.test(sql));
    expect(blocks).toHaveLength(1);
    const statements = (sql: string) => sql.replace(/--[^\n]*/g, "")
      .split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements(blocks[0]!)).toEqual(statements(migration));
  });

  it("can rerun migrations without losing link requests or receipts", () => {
    insertRequest("lr-first", "BCDFGHJK");
    insertLink("wl-first", "account-first");
    expect(() => migrateDatabase(sqlite)).not.toThrow();
    expect(sqlite.prepare("SELECT id FROM wallet_link_requests").all()).toEqual([{ id: "lr-first" }]);
    expect(sqlite.prepare("SELECT id FROM wallet_links").all()).toEqual([{ id: "wl-first" }]);
    expect(() => insertLink("wl-second", "account-second")).toThrow(/UNIQUE constraint failed/);
  });
});
