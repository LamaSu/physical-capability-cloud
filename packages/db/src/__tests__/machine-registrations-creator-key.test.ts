import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

describe("machine registration creator key", () => {
  let sqlite: Database.Database;
  const guard = "machine_registrations_creator_key_set_once";
  const columns = () => sqlite.prepare("PRAGMA table_info(machine_registrations)").all();
  const row = (id = "reg-n345-a") => sqlite.prepare("SELECT * FROM machine_registrations WHERE id = ?").get(id);
  const triggers = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'machine_registrations' ORDER BY name").all();
  const expectedTriggers = [
    { name: "machine_registrations_creator_key_no_replace" },
    { name: "machine_registrations_creator_key_set_once" },
  ];

  beforeEach(() => { sqlite = new Database(":memory:"); migrateDatabase(sqlite); });
  afterEach(() => sqlite.close());

  function insert(id = "reg-n345-a", key: string | null = "key-n345-a", replace = false) {
    sqlite.prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO machine_registrations (
      id, name, category, manufacturer, model, description, photos, capabilities,
      space_requirements, pricing, operator, status, created_at, created_by_key_id
    ) VALUES (?, 'N345 machine', 'custom', 'Synthetic', 'Test', 'Original description',
      '[]', '[]', '{}', '{}', '{}', 'submitted', '2026-11-16T00:00:00.000Z', ?)`)
      .run(id, key);
  }

  it("DB1 machine_registrations has a nullable text created_by_key_id and both guards", () => {
    expect(columns()).toContainEqual(expect.objectContaining({ name: "created_by_key_id", type: "TEXT", notnull: 0, dflt_value: null }));
    expect(triggers()).toStrictEqual(expectedTriggers);
  });

  it("DB2 an existing table gains the column with every row null, and migrating again changes nothing", () => {
    sqlite.close();
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS machine_registrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        manufacturer TEXT NOT NULL,
        model TEXT NOT NULL,
        serial_number TEXT,
        description TEXT,
        photos TEXT NOT NULL,  -- JSON string[]
        capabilities TEXT NOT NULL,  -- JSON
        space_requirements TEXT NOT NULL,  -- JSON
        pricing TEXT NOT NULL,  -- JSON
        operator TEXT NOT NULL,  -- JSON
        compliance_regulations TEXT,  -- T2.3: JSON string[] of regulationIds (optional)
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_at TEXT,
        approved_at TEXT
      );
      INSERT INTO machine_registrations (id, name, category, manufacturer, model, photos,
        capabilities, space_requirements, pricing, operator, status, created_at)
      VALUES ('reg-n345-a', 'Existing', 'custom', 'Synthetic', 'Test', '[]', '[]', '{}', '{}', '{}', 'submitted', '2026-11-16');
    `);
    const original = row() as Record<string, unknown>;
    migrateDatabase(sqlite);
    expect(row()).toStrictEqual({ ...original, tenant_id: null, created_by_key_id: null });
    expect(triggers()).toStrictEqual(expectedTriggers);
    const migratedColumns = columns();
    const migratedRow = row();
    migrateDatabase(sqlite);
    expect(columns()).toStrictEqual(migratedColumns);
    expect(row()).toStrictEqual(migratedRow);
    expect(triggers()).toStrictEqual(expectedTriggers);
  });

  it("DB3 an update that changes a recorded key id is refused, to another value or to null", () => {
    insert();
    for (const key of ["key-n345-b", null]) {
      expect(() => sqlite.prepare("UPDATE machine_registrations SET created_by_key_id = ? WHERE id = ?").run(key, "reg-n345-a")).toThrow(guard);
      expect(row()).toMatchObject({ created_by_key_id: "key-n345-a" });
    }
  });

  it("DB4 other updates pass, including the same key id, and a row without a key id cannot gain one", () => {
    insert();
    sqlite.prepare("UPDATE machine_registrations SET status = 'active', description = 'Edited' WHERE id = ?").run("reg-n345-a");
    expect(row()).toMatchObject({ status: "active", description: "Edited", created_by_key_id: "key-n345-a" });
    expect(() => sqlite.prepare("UPDATE machine_registrations SET created_by_key_id = 'key-n345-a' WHERE id = ?").run("reg-n345-a")).not.toThrow();
    insert("reg-n345-null", null);
    expect(() => sqlite.prepare("UPDATE machine_registrations SET created_by_key_id = 'key-n345-c' WHERE id = ?").run("reg-n345-null")).toThrow(guard);
    expect(row("reg-n345-null")).toMatchObject({ created_by_key_id: null });
    expect(() => sqlite.prepare("UPDATE machine_registrations SET created_by_key_id = NULL WHERE id = ?").run("reg-n345-null")).not.toThrow();
  });

  it("DB5 a replace that changes a recorded key id is refused and the row is kept", () => {
    insert();
    sqlite.prepare("UPDATE machine_registrations SET description = 'Kept', status = 'active' WHERE id = ?").run("reg-n345-a");
    const before = row();
    for (const key of ["key-n345-b", null]) {
      expect(() => insert("reg-n345-a", key, true)).toThrow(guard);
      expect(row()).toStrictEqual(before);
    }
    insert("reg-n345-null", null);
    const nullBefore = row("reg-n345-null");
    expect(() => insert("reg-n345-null", "key-n345-b", true)).toThrow(guard);
    expect(row("reg-n345-null")).toStrictEqual(nullBefore);
    expect(() => insert("reg-n345-new", "key-n345-b")).not.toThrow();
    expect(row("reg-n345-new")).toMatchObject({ created_by_key_id: "key-n345-b" });
  });
});
