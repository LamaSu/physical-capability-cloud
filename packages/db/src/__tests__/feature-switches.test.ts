import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { migrateDatabase } from "../migrate.js";
import { featureSwitches } from "../schema/index.js";

const names = [
  "key_minting", "signups", "sign_in", "onboard_chat", "device_identify",
  "onboard_analysis", "commentary", "request_planner", "job_submission",
];

describe("N400 feature switches migration", () => {
  let sqlite: Database.Database;
  beforeEach(() => { sqlite = new Database(":memory:"); });
  afterEach(() => { sqlite.close(); });

  it("T11: seeds exactly nine switches, key minting off and all others on", () => {
    const before = Date.now();
    migrateDatabase(sqlite);
    const rows = sqlite.prepare("SELECT * FROM feature_switches").all() as Array<{
      name: string; enabled: number; updated_at: string; updated_by: string | null;
    }>;
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.name)).toEqual(names);
    for (const row of rows) {
      expect(row.enabled).toBe(row.name === "key_minting" ? 0 : 1);
      expect(row.updated_by).toBeNull();
      expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at);
      expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(row.updated_at)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("T11: later boots preserve every existing row and seed only missing rows", () => {
    migrateDatabase(sqlite);
    sqlite.prepare("UPDATE feature_switches SET enabled = 1, updated_at = ?, updated_by = ? WHERE name = 'key_minting'")
      .run("2026-01-01T00:00:00.000Z", "synthetic-admin");
    sqlite.prepare("UPDATE feature_switches SET enabled = 0 WHERE name != 'key_minting'").run();
    sqlite.prepare("DELETE FROM feature_switches WHERE name = 'sign_in'").run();
    const before = sqlite.prepare("SELECT * FROM feature_switches ORDER BY name").all();
    migrateDatabase(sqlite);
    migrateDatabase(sqlite);
    expect(sqlite.prepare("SELECT * FROM feature_switches WHERE name != 'sign_in' ORDER BY name").all()).toEqual(before);
    expect(sqlite.prepare("SELECT enabled, updated_by FROM feature_switches WHERE name = 'sign_in'").get())
      .toEqual({ enabled: 1, updated_by: null });
  });

  it("declares exactly the required columns and enforces the integer value constraint", () => {
    migrateDatabase(sqlite);
    expect(sqlite.prepare("PRAGMA table_info(feature_switches)").all()).toEqual([
      { cid: 0, name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: "enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "updated_by", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    for (const value of [2, -1, "yes", null]) {
      expect(() => sqlite.prepare("UPDATE feature_switches SET enabled = ? WHERE name = 'signups'").run(value)).toThrow();
    }
    const table = getTableConfig(featureSwitches);
    expect(table.name).toBe("feature_switches");
    expect(table.columns.map((c) => c.name)).toEqual(["name", "enabled", "updated_at", "updated_by"]);
    expect(table.checks).toHaveLength(1);
  });
});
