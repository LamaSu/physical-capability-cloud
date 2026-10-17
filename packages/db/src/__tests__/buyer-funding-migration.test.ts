import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

const Q9_TRIGGERS = [
  "escrow_funding_no_update", "escrow_funding_no_delete", "escrow_funding_no_replace",
  "funding_prepares_frozen", "funding_prepares_signed_once", "funding_prepares_transitions",
  "funding_prepares_end_once", "funding_prepares_requested", "funding_prepares_no_delete",
  "funding_prepares_no_replace",
];
function withoutRowid(sqlite: Database.Database): [number, number] {
  const tables = sqlite.prepare("PRAGMA table_list").all() as Array<{ name: string; wr: number }>;
  return [tables.find((t) => t.name === "escrow_funding")!.wr, tables.find((t) => t.name === "funding_prepares")!.wr];
}

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
const q9Tables = ["escrow_funding", "funding_prepares"];
function master(sqlite: Database.Database, q9Only = false): MasterRow[] {
  return (sqlite.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as MasterRow[])
    .filter((row) => !q9Only || q9Tables.includes(row.tbl_name))
    .map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
}

describe("buyer funding migration", () => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    migrateDatabase(sqlite);
  });
  afterEach(() => sqlite.close());

  it("is idempotent across the entire sqlite_master", () => {
    const before = sqlite.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
    migrateDatabase(sqlite);
    expect(sqlite.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
  });

  it("upgrades a pre-Q9 proxy without changing its existing receipt and challenge rows", () => {
    sqlite.exec(`
      INSERT INTO gateway_receipts (id, job_id, kernel_id, chain_id, escrow, settlement_unit_id,
        package_digest, received_at, receipt_digest, signature_hex, kid, created_at)
      VALUES ('receipt-a', 'job-a', 'kernel-a', 84532, 'escrow-a', 'unit-a', 'package-a', 100,
        'receipt-digest-a', 'signature-a', 'kid-a', '2026-10-16T00:00:00.000Z');
      INSERT INTO settlement_challenges (id, job_id, chain_id, escrow, settlement_unit_id, nonce,
        t_challenge_ref, state, issued_at, expires_at)
      VALUES ('challenge-a', 'job-a', 84532, 'escrow-a', 'unit-a', 'nonce-a', 'ref-a', 'issued', 100, 200);
    `);
    const receipt = sqlite.prepare("SELECT * FROM gateway_receipts").all();
    const challenge = sqlite.prepare("SELECT * FROM settlement_challenges").all();
    const expected = master(sqlite, true);
    sqlite.exec("DROP TABLE escrow_funding; DROP TABLE funding_prepares;");
    expect(master(sqlite, true)).toEqual([]);
    migrateDatabase(sqlite);
    expect(master(sqlite, true)).toEqual(expected);
    expect(sqlite.prepare("SELECT * FROM gateway_receipts").all()).toEqual(receipt);
    expect(sqlite.prepare("SELECT * FROM settlement_challenges").all()).toEqual(challenge);
  });

  it("has a standalone 0007 mirror with the same Q9 sqlite_master objects as runtime", () => {
    const fresh = new Database(":memory:");
    try {
      fresh.exec(readFileSync(new URL("../migrations/0007_buyer_funding.sql", import.meta.url), "utf8"));
      expect(master(fresh, true)).toEqual(master(sqlite, true));
      expect(master(fresh, true).filter((row) => row.type === "trigger")).toHaveLength(10);
      expect(master(fresh, true).filter((row) => row.type === "trigger").map((row) => row.name).sort()).toEqual([...Q9_TRIGGERS].sort());
      expect(master(fresh, true).filter((row) => row.type === "index" && row.sql !== null)).toHaveLength(5);
      expect(withoutRowid(fresh)).toEqual([0, 1]);
      expect(withoutRowid(sqlite)).toEqual([0, 1]);
    } finally {
      fresh.close();
    }
  });
});
