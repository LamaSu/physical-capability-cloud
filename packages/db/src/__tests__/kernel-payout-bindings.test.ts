import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

const MIGRATION = readFileSync(new URL("../migrations/0008_kernel_payout_bindings.sql", import.meta.url), "utf8");
const NOW = "2026-10-26T00:00:00.000Z";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12";
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE = {
  id: "binding-a", kernel_id: "kernel-a", chain_id: 84532,
  payout_address: ADDRESS, bound_by_wallet: ADDRESS, proof_via: "siwe-session",
  proof_carrier: "key", consent_version: "kernel-payout-v1", consent_sha256: "a".repeat(64),
  created_at: NOW, revoked_at: null, revoked_by: null, revoke_reason: null,
};
const COLUMNS = Object.keys(BASE);
const REVOKE = "revoked_at = ?, revoked_by = 'owner', revoke_reason = 'owner_revoked'";

describe("kernel payout DDL parity", () => {
  it("D1: matches migration 0008 and the runtime block statement for statement", () => {
    const runtime = readFileSync(new URL("../migrate.ts", import.meta.url), "utf8");
    const blocks = [...runtime.matchAll(/sqlite\.exec\(`([\s\S]*?)`\);/g)]
      .map((match) => match[1]!)
      .filter((sql) => /CREATE TABLE IF NOT EXISTS kernel_payout_bindings\s*\(/.test(sql));
    expect(blocks).toHaveLength(1);
    const statements = (sql: string) => sql.replace(/--[^\n]*/g, "")
      .split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements(blocks[0]!)).toEqual(statements(MIGRATION));
  });
});

describe.each(["runtime", "standalone"] as const)("kernel payout bindings (%s)", (source) => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    if (source === "runtime") migrateDatabase(sqlite);
    else sqlite.exec(MIGRATION);
  });
  afterEach(() => sqlite.close());

  function insert(patch: Record<string, unknown> = {}, verb = "INSERT INTO") {
    const row: Record<string, unknown> = { ...BASE, ...patch };
    sqlite.prepare(`${verb} kernel_payout_bindings (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
      .run(...COLUMNS.map((column) => row[column]));
  }
  const rows = () => sqlite.prepare("SELECT * FROM kernel_payout_bindings ORDER BY id").all();
  const revoke = (id = BASE.id) => sqlite.prepare(`UPDATE kernel_payout_bindings SET ${REVOKE} WHERE id = ?`).run(NOW, id);

  it("D2: rerunning migrations preserves active and revoked history and schema", () => {
    insert();
    revoke();
    insert({ id: "binding-b" });
    const before = rows();
    const objects = sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'kernel_payout_bindings' ORDER BY name").all();
    if (source === "runtime") migrateDatabase(sqlite);
    else sqlite.exec(MIGRATION);
    expect(rows()).toEqual(before);
    expect(sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'kernel_payout_bindings' ORDER BY name").all()).toEqual(objects);
  });

  const badValues: Array<[string, Record<string, unknown>]> = [
    ["empty id", { id: "" }], ["long id", { id: "i".repeat(201) }],
    ["empty kernel", { kernel_id: "" }], ["long kernel", { kernel_id: "k".repeat(201) }],
    ...["payout_address", "bound_by_wallet"].flatMap((column): Array<[string, Record<string, unknown>]> =>
      [ADDRESS.toUpperCase(), ZERO, "0x1234", `0x${"g".repeat(40)}`, `aa${"a".repeat(40)}`]
        .map((address) => [`${column}: ${address}`, { [column]: address }])),
    ["different payout and binder", { payout_address: OTHER_ADDRESS }],
    ...["abc", "12x", 5.5, 0, -1].map((chain): [string, Record<string, unknown>] => [`chain ${chain}`, { chain_id: chain }]),
    ["self-link proof", { proof_via: "self-link:agent" }], ["cookie carrier", { proof_carrier: "cookie" }],
    ["empty version", { consent_version: "" }], ["long version", { consent_version: "v".repeat(101) }],
    ["uppercase sha", { consent_sha256: "A".repeat(64) }], ["short sha", { consent_sha256: "a".repeat(63) }],
    ["nonhex sha", { consent_sha256: "z".repeat(64) }],
  ];
  it.each(badValues)("D3: refuses invalid CHECK value: %s", (_name, patch) => {
    expect(() => insert(patch)).toThrow(/CHECK constraint failed/);
    expect(rows()).toEqual([]);
  });

  it.each(["7", 5.0, 1e3])("D3: permits integer affinity for %s", (chain) => {
    insert({ chain_id: chain });
    expect(sqlite.prepare("SELECT typeof(chain_id) AS type, chain_id FROM kernel_payout_bindings").get())
      .toEqual({ type: "integer", chain_id: Number(chain) });
  });

  const badRevocations: Array<[string, unknown, unknown, unknown]> = [
    ["invalid actor", NOW, "stranger", "owner_revoked"],
    ["invalid reason", NOW, "owner", "other"],
    ["admin/owner reason", NOW, "admin", "owner_revoked"],
    ["admin/rebound", NOW, "admin", "rebound"],
    ["owner/admin reason", NOW, "owner", "admin_revoked"],
    ["missing actor and reason", NOW, null, null],
    ["missing actor", NOW, null, "owner_revoked"],
    ["missing reason", NOW, "owner", null],
    ["missing time", null, "owner", "owner_revoked"],
    ["actor only", null, "owner", null],
    ["reason only", null, null, "owner_revoked"],
  ];
  it.each(badRevocations)("D3: refuses invalid revocation: %s", (_name, at, who, reason) => {
    insert();
    const before = rows();
    // Use UPDATE so born_active cannot mask the enum and reason/actor CHECKs.
    expect(() => sqlite.prepare("UPDATE kernel_payout_bindings SET revoked_at = ?, revoked_by = ?, revoke_reason = ?")
      .run(at, who, reason)).toThrow();
    expect(rows()).toEqual(before);
  });

  it("D4: refuses DELETE and preserves the original row", () => {
    insert();
    const before = rows();
    expect(() => sqlite.exec("DELETE FROM kernel_payout_bindings")).toThrow(/keeps its history/);
    expect(rows()).toEqual(before);
  });

  const immutable: Array<[string, unknown]> = [
    ["id", "binding-new"], ["kernel_id", "kernel-new"], ["chain_id", 1],
    ["payout_address", OTHER_ADDRESS], ["bound_by_wallet", OTHER_ADDRESS],
    ["proof_via", "other"], ["proof_carrier", "bearer-session"],
    ["consent_version", "kernel-payout-v2"], ["consent_sha256", "b".repeat(64)],
    ["created_at", "2026-10-27T00:00:00.000Z"],
  ];
  it.each(immutable)("D5: refuses changing immutable %s during a revoke", (column, value) => {
    insert();
    const before = rows();
    expect(() => sqlite.prepare(`UPDATE kernel_payout_bindings SET ${column} = ?, ${REVOKE}`).run(value, NOW))
      .toThrow(/kernel_payout_bindings_revoke_only/);
    expect(rows()).toEqual(before);
  });

  it("D5: refuses changing both wallet columns even when their equality CHECK holds", () => {
    insert();
    const before = rows();
    expect(() => sqlite.prepare(`UPDATE kernel_payout_bindings SET payout_address = ?, bound_by_wallet = ?, ${REVOKE}`)
      .run(OTHER_ADDRESS, OTHER_ADDRESS, NOW)).toThrow(/kernel_payout_bindings_revoke_only/);
    expect(rows()).toEqual(before);
  });

  it("D5: permits one revoke, then refuses a second revoke and un-revoke", () => {
    insert();
    expect(() => revoke()).not.toThrow();
    const before = rows();
    expect(() => revoke()).toThrow(/kernel_payout_bindings_revoke_only/);
    expect(() => sqlite.exec("UPDATE kernel_payout_bindings SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL"))
      .toThrow(/kernel_payout_bindings_revoke_only/);
    expect(rows()).toEqual(before);
  });

  it.each(["INSERT OR REPLACE INTO", "REPLACE INTO"])("D6: %s cannot replace an id or an active kernel/chain", (verb) => {
    insert();
    const before = rows();
    expect(() => insert({ kernel_id: "another-kernel" }, verb)).toThrow(/kernel_payout_bindings_no_replace/);
    expect(rows()).toEqual(before);
    expect(() => insert({ id: "another-id" }, verb)).toThrow(/kernel_payout_bindings_no_replace/);
    expect(rows()).toEqual(before);
    // Even a revoked historical id cannot be replaced by an active insert.
    revoke();
    const revoked = rows();
    expect(() => insert({}, verb)).toThrow(/kernel_payout_bindings_no_replace/);
    expect(rows()).toEqual(revoked);
  });

  it("D6: UPDATE OR REPLACE cannot replace an id or an active kernel/chain", () => {
    insert();
    insert({ id: "binding-b", kernel_id: "kernel-b" });
    const before = rows();
    expect(() => sqlite.prepare(`UPDATE OR REPLACE kernel_payout_bindings SET id = 'binding-a', ${REVOKE} WHERE id = 'binding-b'`)
      .run(NOW)).toThrow(/kernel_payout_bindings_revoke_only/);
    expect(rows()).toEqual(before);
    expect(() => sqlite.exec("UPDATE OR REPLACE kernel_payout_bindings SET kernel_id = 'kernel-a', chain_id = 84532 WHERE id = 'binding-b'"))
      .toThrow(/kernel_payout_bindings_revoke_only/);
    expect(rows()).toEqual(before);
  });

  it("D7: refuses a second active row and permits a new one after revocation", () => {
    insert();
    const before = rows();
    expect(() => insert({ id: "binding-b" })).toThrow();
    expect(rows()).toEqual(before);
    revoke();
    expect(() => insert({ id: "binding-b" })).not.toThrow();
    expect(rows()).toHaveLength(2);
    expect(sqlite.prepare("SELECT id FROM kernel_payout_bindings WHERE revoked_at IS NULL").all()).toEqual([{ id: "binding-b" }]);
    expect(() => insert({ id: "binding-another-chain", chain_id: 1 })).not.toThrow();
    expect(() => insert({ id: "binding-another-kernel", kernel_id: "kernel-b" })).not.toThrow();
  });

  it("D8: rejects rowid replacement forms without changing the row", () => {
    insert();
    const before = rows();
    // If the table had a hidden rowid, this otherwise valid insert would replace
    // rowid 1 despite using a fresh id and kernel that pass no_replace.
    const replacement = { ...BASE, id: "binding-rowid", kernel_id: "kernel-rowid" };
    expect(() => sqlite.prepare(`INSERT OR REPLACE INTO kernel_payout_bindings (rowid, ${COLUMNS.join(", ")})
      VALUES (1, ${COLUMNS.map(() => "?").join(", ")})`).run(...Object.values(replacement)))
      .toThrow(/no column named rowid/);
    expect(rows()).toEqual(before);
    expect(() => sqlite.prepare(`UPDATE OR REPLACE kernel_payout_bindings SET rowid = 1, ${REVOKE}`).run(NOW))
      .toThrow(/no such column: rowid/);
    expect(rows()).toEqual(before);
  });

  it.each([
    { revoked_at: NOW }, { revoked_by: "owner" }, { revoke_reason: "owner_revoked" },
    { revoked_at: NOW, revoked_by: "owner", revoke_reason: "owner_revoked" },
    { revoked_at: NOW, revoked_by: "admin", revoke_reason: "admin_revoked" },
  ])("D9: refuses to insert a row already carrying revocation: %j", (patch) => {
    expect(() => insert(patch)).toThrow(/kernel_payout_bindings_born_active/);
    expect(rows()).toEqual([]);
  });
});
