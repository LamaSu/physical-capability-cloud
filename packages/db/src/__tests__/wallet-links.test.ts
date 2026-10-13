import type Database from "better-sqlite3";
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

  it("can rerun migrations without losing link requests or receipts", () => {
    insertRequest("lr-first", "BCDFGHJK");
    insertLink("wl-first", "account-first");
    expect(() => migrateDatabase(sqlite)).not.toThrow();
    expect(sqlite.prepare("SELECT id FROM wallet_link_requests").all()).toEqual([{ id: "lr-first" }]);
    expect(sqlite.prepare("SELECT id FROM wallet_links").all()).toEqual([{ id: "wl-first" }]);
    expect(() => insertLink("wl-second", "account-second")).toThrow(/UNIQUE constraint failed/);
  });
});
