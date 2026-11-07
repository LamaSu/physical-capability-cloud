import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

describe("gateway receipt settlement storage", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    migrateDatabase(sqlite);
  });

  afterEach(() => sqlite.close());

  const escrow = `0x${"ab".repeat(20)}`;
  const unit = `0x${"cd".repeat(32)}`;
  const challenge = (id: string, jobId = "job-a", state = "issued") =>
    sqlite.prepare(`
      INSERT INTO settlement_challenges
        (id, job_id, chain_id, escrow, settlement_unit_id, nonce, t_challenge_ref,
         state, issued_at, expires_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, 100, 200)
    `).run(id, jobId, escrow, unit, `0x${"ef".repeat(32)}`, `challenge:${id}`, state);

  const receipt = (id: string, jobId: string, settlementUnitId = unit) =>
    sqlite.prepare(`
      INSERT INTO gateway_receipts
        (id, job_id, kernel_id, chain_id, escrow, settlement_unit_id, package_digest,
         received_at, receipt_digest, signature_hex, kid, created_at)
      VALUES (?, ?, 'kernel-a', 1, ?, ?, ?, 150, ?, ?, 'receipt-kid', '2026-10-13T00:00:00.000Z')
    `).run(id, jobId, escrow, settlementUnitId, `0x${"12".repeat(32)}`, `0x${"34".repeat(32)}`, `0x${"56".repeat(64)}`);

  it("stores every signed receipt field and enforces unique jobs and units", () => {
    receipt("receipt-a", "job-a");
    const row = sqlite.prepare("SELECT * FROM gateway_receipts WHERE id = ?").get("receipt-a");
    expect(row).toEqual({
      id: "receipt-a", job_id: "job-a", kernel_id: "kernel-a", chain_id: 1,
      escrow, settlement_unit_id: unit, package_digest: `0x${"12".repeat(32)}`,
      received_at: 150, receipt_digest: `0x${"34".repeat(32)}`,
      signature_hex: `0x${"56".repeat(64)}`, kid: "receipt-kid",
      created_at: "2026-10-13T00:00:00.000Z",
    });
    expect(() => receipt("receipt-b", "job-b")).toThrow(/UNIQUE/);
    expect(() => receipt("receipt-c", "job-a", `0x${"99".repeat(32)}`)).toThrow(/UNIQUE/);
  });

  it("allows at most one issued challenge per unit, across jobs", () => {
    challenge("challenge-a");
    expect(() => challenge("challenge-b")).toThrow(/UNIQUE/);
    expect(() => challenge("challenge-c", "job-b")).toThrow(/UNIQUE/);
    sqlite.prepare("UPDATE settlement_challenges SET state = 'consumed', consumed_at = 150 WHERE id = ?")
      .run("challenge-a");
    challenge("challenge-d");
    expect(sqlite.prepare("SELECT count(*) AS n FROM settlement_challenges").get()).toEqual({ n: 2 });
  });

  it("rejects challenge states outside the issued and consumed vocabulary", () => {
    expect(() => challenge("challenge-a", "job-a", "other")).toThrow(/CHECK/);
  });

  it("keeps receipts and challenges when the migration runs again", () => {
    receipt("receipt-a", "job-a");
    challenge("challenge-a");
    migrateDatabase(sqlite);
    expect(sqlite.prepare("SELECT id FROM gateway_receipts").all()).toEqual([{ id: "receipt-a" }]);
    expect(sqlite.prepare("SELECT id FROM settlement_challenges").all()).toEqual([{ id: "challenge-a" }]);
  });
});
