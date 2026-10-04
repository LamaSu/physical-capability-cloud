/**
 * WP-A round 8 (astra authz r2: "check existing identities for collisions before
 * enabling the broader normalization policy"). findIdentityCollisions groups the
 * stored identities by normalizeIdentity. It flags as `newMerge` the groups whose
 * spellings were DISTINCT under master's comparison (trim + lowercase): those are
 * the principals the new normalization would join.
 * scripts/identity-collision-audit.mjs runs it before deploy.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";
import { findIdentityCollisions, collisionAuditExit } from "../auth/identity-collisions.js";

/** Every table and column SOURCES reads (AZ-9 round 4: presence comes from SQLite's catalog). */
const FULL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  api_keys: ["operator_id"],
  shop_kernels: ["operator_address"],
  machine_registrations: ["tenant_id", "operator"],
  job_offers: ["poster_did"],
  ui_artifacts: ["owner"],
};
type FakeReader = { prepare(sql: string): { all(...p: unknown[]): unknown[] } };
/** Answers the catalog queries (sqlite_master, pragma_table_info) from `schema`; every other query goes to `reader`. */
function withCatalog(reader: FakeReader, schema: Readonly<Record<string, readonly string[]>> = FULL_SCHEMA): FakeReader {
  return {
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) return { all: (t: unknown) => (schema[String(t)] ? [{ name: String(t) }] : []) };
      if (sql.includes("pragma_table_info")) return { all: (t: unknown, c: unknown) => ((schema[String(t)] ?? []).includes(String(c)) ? [{ name: String(c) }] : []) };
      return reader.prepare(sql);
    },
  };
}
const EMPTY_ROWS: FakeReader = { prepare: () => ({ all: () => [] as unknown[] }) };
const schemaWithout = (table: string, column?: string): Record<string, readonly string[]> => {
  const s: Record<string, readonly string[]> = { ...FULL_SCHEMA };
  if (column === undefined) delete s[table];
  else s[table] = (s[table] ?? []).filter((c) => c !== column);
  return s;
};

let seq = 0;
function key(operatorId: string): void {
  const { keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `collide-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
}

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  key("Alice@X.test");
  key("alice@x.test"); // same under master (trim + lowercase): an existing merge, not a new one
  key("straße@x.test");
  key("STRASSE@x.test"); // distinct under master, one identity under case folding: NEW merge
  key("ｖｉｃｔｉｍ@x.test");
  key("victim@x.test"); // NFKC: NEW merge
  key("alıce@x.test"); // dotless i: its own identity, never merged with alice
  key("bob@x.test");
});

afterAll(() => closeStore());

describe("findIdentityCollisions", () => {
  it("groups spellings that normalize alike and flags the NEW merges", () => {
    const { collisions, read } = findIdentityCollisions((getStore().db as unknown as { $client: never }).$client);
    expect(read).toContain("api_keys.operator_id");
    const by = Object.fromEntries(collisions.map((c) => [c.spellings.join(" | "), c.newMerge]));
    expect(by).toEqual({
      "Alice@X.test | alice@x.test": false,
      "STRASSE@x.test | straße@x.test": true,
      "victim@x.test | ｖｉｃｔｉｍ@x.test": true,
    });
  });

  it("[neg] dotless i and unrelated identities are in no group", () => {
    const { collisions } = findIdentityCollisions((getStore().db as unknown as { $client: never }).$client);
    const all = collisions.flatMap((c) => c.spellings);
    expect(all).not.toContain("alıce@x.test");
    expect(all).not.toContain("bob@x.test");
  });
});


/**
 * AZ-9 (astra pack 95, HIGH): the pre-deploy audit must FAIL CLOSED. Before the
 * fix, identity-collision-audit.mjs exited 0 whenever no new merge was found —
 * including when EVERY identity source threw and the audit read nothing. It then
 * reported "safe to deploy" after examining zero identities.
 */
describe("collisionAuditExit — the pre-deploy audit fails closed (AZ-9)", () => {
  const ALL_SOURCES = [
    "api_keys.operator_id",
    "shop_kernels.operator_address",
    "machine_registrations.tenant_id",
    "machine_registrations.operator.walletAddress",
    "machine_registrations.operator.email",
    "job_offers.poster_did",
    "ui_artifacts.owner",
  ];

  it("[neg] a database whose catalog lists NONE of the sources skips every source, and the exit is 4 (not 0)", () => {
    const { collisions, read, skipped } = findIdentityCollisions(withCatalog(EMPTY_ROWS, {}));
    expect(collisions).toEqual([]);
    expect(read).toEqual([]);
    expect(skipped.length).toBe(ALL_SOURCES.length);
    const verdict = collisionAuditExit({ newMerges: 0, read, skipped, allowedAbsent: [] });
    expect(verdict.code).toBe(4);
  });

  it("[neg] a Reader whose prepare() always throws (the catalog too) FAILS every source, and the exit is 4", () => {
    const throwing = { prepare(): never { throw Object.assign(new Error("no such table: absent_everywhere"), { code: "SQLITE_ERROR" }); } };
    const { read, skipped, failed } = findIdentityCollisions(throwing);
    expect(read).toEqual([]);
    expect(skipped).toEqual([]);
    expect(failed.length).toBe(ALL_SOURCES.length);
    expect(collisionAuditExit({ newMerges: 0, read, skipped, failed, allowedAbsent: ALL_SOURCES }).code).toBe(4);
  });

  it("[neg] a required source (api_keys / shop_kernels) that is unreadable is exit 4, even if allowlisted", () => {
    expect(collisionAuditExit({ newMerges: 0, read: ["shop_kernels.operator_address"], skipped: ["api_keys.operator_id"], allowedAbsent: ["api_keys.operator_id"] }).code).toBe(4);
    expect(collisionAuditExit({ newMerges: 0, read: ["api_keys.operator_id"], skipped: ["shop_kernels.operator_address"], allowedAbsent: [] }).code).toBe(4);
  });

  it("[neg] an unreadable OPTIONAL source is exit 4 unless it is explicitly allowlisted", () => {
    const read = ["api_keys.operator_id", "shop_kernels.operator_address"];
    expect(collisionAuditExit({ newMerges: 0, read, skipped: ["ui_artifacts.owner"], allowedAbsent: [] }).code).toBe(4);
    expect(collisionAuditExit({ newMerges: 0, read, skipped: ["ui_artifacts.owner"], allowedAbsent: ["ui_artifacts.owner"] }).code).toBe(0);
  });

  it("a NEW merge is exit 3, and a clean full read is exit 0", () => {
    const read = ALL_SOURCES;
    expect(collisionAuditExit({ newMerges: 2, read, skipped: [], allowedAbsent: [] }).code).toBe(3);
    expect(collisionAuditExit({ newMerges: 0, read, skipped: [], allowedAbsent: [] }).code).toBe(0);
  });

  it("[neg] a blocking skip OUTRANKS a clean no-merge result (incomplete beats safe)", () => {
    expect(collisionAuditExit({ newMerges: 0, read: ["api_keys.operator_id"], skipped: ["shop_kernels.operator_address"], allowedAbsent: [] }).code).toBe(4);
  });
});

// astra pack 95b, AZ-9 (HIGH): an allowlisted OPTIONAL source must fail open only on
// a CONFIRMED absence ("no such table" / "no such column"), never on any other read
// error. A corrupt or I/O-failing table is unread data, not a missing table.
describe("AZ-9 round 2: only a confirmed absence is allowlistable (astra pack 95b)", () => {
  const CORRUPT = () => Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
  function readerFailing(sourceTable: string, err: () => Error) {
    return withCatalog({
      prepare(sql: string) {
        if (sql.includes(`FROM ${sourceTable}`)) throw err();
        return { all: () => [] as unknown[] };
      },
    });
  }

  it("[neg] astra's reproduction: an allowlisted source whose query fails with SQLITE_CORRUPT is exit 4, not 0", () => {
    const out = findIdentityCollisions(readerFailing("ui_artifacts", CORRUPT));
    const verdict = collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never);
    expect(verdict.code).toBe(4);
  });

  it("[neg] an I/O error on an allowlisted source is exit 4", () => {
    const io = () => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const out = findIdentityCollisions(readerFailing("job_offers", io));
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["job_offers.poster_did"] } as never).code).toBe(4);
  });

  it("control: a table the CATALOG lacks, on an allowlisted source, is still exit 0", () => {
    const out = findIdentityCollisions(withCatalog(EMPTY_ROWS, schemaWithout("ui_artifacts")));
    expect(out.skipped).toEqual(["ui_artifacts.owner"]); // skipped by the catalog, not read and not failed
    expect(out.read).not.toContain("ui_artifacts.owner");
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(0);
  });

  it("control: a column the CATALOG lacks, on an allowlisted source, is exit 0", () => {
    const out = findIdentityCollisions(withCatalog(EMPTY_ROWS, schemaWithout("ui_artifacts", "owner")));
    expect(out.skipped).toEqual(["ui_artifacts.owner"]); // skipped by the catalog, not read and not failed
    expect(out.read).not.toContain("ui_artifacts.owner");
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(0);
  });

  it("[neg] a query that fails part-way through .all() is a FAILED read (exit 4), even when allowlisted", () => {
    const reader = withCatalog({
      prepare(sql: string) {
        if (sql.includes("FROM ui_artifacts")) return { all: () => { throw CORRUPT(); } };
        return { all: () => [] as unknown[] };
      },
    });
    const out = findIdentityCollisions(reader);
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(4);
  });

  it("[neg] INCOMPLETE outranks a new merge: a failed source with newMerges > 0 is 4, not 3", () => {
    const out = findIdentityCollisions(readerFailing("job_offers", CORRUPT));
    expect(collisionAuditExit({ newMerges: 2, ...out, allowedAbsent: [] } as never).code).toBe(4);
  });

  it("[neg] only a missing TABLE or COLUMN is absence: 'no such file or directory' on an allowlisted source is exit 4", () => {
    const enoent = () => Object.assign(new Error("ENOENT: no such file or directory, open '/data/pcc.sqlite'"), { code: "ENOENT" });
    const out = findIdentityCollisions(readerFailing("ui_artifacts", enoent));
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(4);
  });

  it("an EMPTY table counts as read", () => {
    const out = findIdentityCollisions(withCatalog(EMPTY_ROWS));
    expect(out.read.length).toBe(7);
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: [] } as never).code).toBe(0);
  });
});


// AZ-9 round 3 (astra pack 95c): a "confirmed absence" must be a GENUINE SQLite
// error, never message text alone: an Error whose code is exactly SQLITE_ERROR and
// whose message is SQLite's exact "no such table: <name>" / "no such column: <name>"
// (what better-sqlite3, the store's driver, throws). Anything else is `failed`.
describe("AZ-9 round 3: absence is a genuine SQLite error, never message text alone (astra pack 95c)", () => {
  function readerThrowing(sourceTable: string, thrown: () => unknown) {
    return withCatalog({
      prepare(sql: string) {
        if (sql.includes(`FROM ${sourceTable}`)) throw thrown();
        return { all: () => [] };
      },
    });
  }
  const allowUi = ["ui_artifacts.owner"];
  const exitFor = (out: ReturnType<typeof findIdentityCollisions>) =>
    collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: allowUi }).code;

  it("[neg] astra's reproduction: an absence-looking message with a conflicting code (SQLITE_CORRUPT) is failed, exit 4", () => {
    const misleading = () => Object.assign(new Error("no such table: ui_artifacts"), { code: "SQLITE_CORRUPT" });
    const out = findIdentityCollisions(readerThrowing("ui_artifacts", misleading));
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(out.skipped).not.toContain("ui_artifacts.owner");
    expect(exitFor(out)).toBe(4);
  });

  it("[neg] astra's reproduction: a thrown STRING with the absence wording is failed, exit 4", () => {
    const out = findIdentityCollisions(readerThrowing("ui_artifacts", () => "no such table: ui_artifacts"));
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(exitFor(out)).toBe(4);
  });

  it("[neg] an Error with the absence wording but no SQLite code is failed, exit 4", () => {
    const out = findIdentityCollisions(readerThrowing("ui_artifacts", () => new Error("no such table: ui_artifacts")));
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(exitFor(out)).toBe(4);
  });

  it("[neg] SQLITE_ERROR without SQLite's exact form (no ': <name>', other case, trailing text, a wrapper prefix) is failed, exit 4", () => {
    for (const message of [
      "no such table",
      "No such table: ui_artifacts",
      "no such table: ui_artifacts\nmore",
      "query failed: no such table: ui_artifacts",
    ]) {
      const out = findIdentityCollisions(readerThrowing("ui_artifacts", () => Object.assign(new Error(message), { code: "SQLITE_ERROR" })));
      expect(out.failed, message).toContain("ui_artifacts.owner");
      expect(exitFor(out), message).toBe(4);
    }
  });

  it("[neg] a non-Error object carrying the absence message and code is failed, exit 4", () => {
    const out = findIdentityCollisions(readerThrowing("ui_artifacts", () => ({ message: "no such table: ui_artifacts", code: "SQLITE_ERROR" })));
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(exitFor(out)).toBe(4);
  });

  it("[neg] a failure while PROCESSING rows (after .all()) is reported as failed, exit 4, not thrown out of the audit", () => {
    const poisoned = { get v(): string { throw new Error("row decode failed"); } };
    const reader = withCatalog({
      prepare(sql: string) {
        return { all: () => (sql.includes("FROM ui_artifacts") ? [poisoned] : []) };
      },
    });
    const out = findIdentityCollisions(reader);
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(out.read).not.toContain("ui_artifacts.owner");
    expect(exitFor(out)).toBe(4);
  });

  it("[neg] round 4: a GENUINE driver error ('no such table' / 'no such column' from the real better-sqlite3) from a source the catalog LISTS is failed, never excused", async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const { initStore, getStore } = await import("../db.js");
    initStore({ seed: false });
    const client = (getStore().db as unknown as { $client: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }).$client;
    const cases: Array<[string, string]> = [
      ["FROM ui_artifacts", "FROM ui_artifacts_absent_95c"],
      ["SELECT DISTINCT owner AS v FROM ui_artifacts", "SELECT DISTINCT owner_absent_95c AS v FROM api_keys"],
    ];
    for (const [needle, replacement] of cases) {
      // The catalog is asked about the real ui_artifacts.owner (present); only the DATA query is redirected,
      // so the real driver throws its genuine absence error for a source the catalog says exists.
      const out = findIdentityCollisions({ prepare: (sql: string) => client.prepare(sql.replace(needle, replacement)) });
      expect(out.failed, replacement).toContain("ui_artifacts.owner");
      expect(out.skipped, replacement).not.toContain("ui_artifacts.owner");
      expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] }).code, replacement).toBe(4);
    }
  });
});

// AZ-9 round 4 (astra pack 95d): no error's SHAPE can prove an absence, because any code that throws can
// forge one (an ordinary Error with the right code and message, a subclass, accessors, a trailing newline,
// a whitespace-free suffix, a processing failure shaped like an absence). Absence is read from SQLite's own
// catalog BEFORE the source is queried; once the catalog says the source exists, ANY failure is `failed`.
describe("AZ-9 round 4: a source the catalog says EXISTS is never excused, whatever its error looks like (astra pack 95d)", () => {
  /** A fake database whose catalog lists every SOURCES table and column, and whose ui_artifacts query throws `thrown`. */
  function presentButThrowing(thrown: () => unknown) {
    const schema: Record<string, string[]> = {
      api_keys: ["operator_id"], shop_kernels: ["operator_address"], machine_registrations: ["tenant_id", "operator"],
      job_offers: ["poster_did"], ui_artifacts: ["owner"],
    };
    return {
      prepare(sql: string) {
        if (sql.includes("sqlite_master")) return { all: (t: unknown) => (schema[String(t)] ? [{ name: String(t) }] : []) };
        if (sql.includes("pragma_table_info")) return { all: (t: unknown, c: unknown) => ((schema[String(t)] ?? []).includes(String(c)) ? [{ name: String(c) }] : []) };
        if (sql.includes("FROM ui_artifacts")) throw thrown();
        return { all: () => [] as unknown[] };
      },
    };
  }
  const allowUi = ["ui_artifacts.owner"];
  const verdictOf = (out: ReturnType<typeof findIdentityCollisions>) =>
    collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: allowUi }).code;
  const forged: Array<[string, () => unknown]> = [
    ["an ORDINARY Error with code SQLITE_ERROR and the exact absence message", () => Object.assign(new Error("no such table: ui_artifacts"), { code: "SQLITE_ERROR" })],
    ["an Error SUBCLASS with the accepted shape", () => { class Spoof extends Error { code = "SQLITE_ERROR"; } return new Spoof("no such table: ui_artifacts"); }],
    ["accessor-backed code and message", () => { const e = new Error("x"); Object.defineProperty(e, "code", { get: () => "SQLITE_ERROR" }); Object.defineProperty(e, "message", { get: () => "no such table: ui_artifacts" }); return e; }],
    ["a TRAILING newline after an exact message", () => Object.assign(new Error("no such table: ui_artifacts\n"), { code: "SQLITE_ERROR" })],
    ["a whitespace-free SUFFIX", () => Object.assign(new Error("no such table: ui_artifacts;other_failure"), { code: "SQLITE_ERROR" })],
    ["a THROWING accessor (it must not escape the audit)", () => { const e = new Error("x"); Object.defineProperty(e, "code", { get: () => { throw new Error("accessor"); } }); return e; }],
  ];
  for (const [label, thrown] of forged) {
    it(`[neg] astra's reproduction: ${label}, from a source the catalog lists, is failed (exit 4)`, () => {
      const out = findIdentityCollisions(presentButThrowing(thrown));
      expect(out.failed).toContain("ui_artifacts.owner");
      expect(out.skipped).not.toContain("ui_artifacts.owner");
      expect(verdictOf(out)).toBe(4);
    });
  }

  it("[neg] astra's reproduction: a PROCESSING failure shaped like an absence is failed (exit 4)", () => {
    const shaped = Object.assign(new Error("no such column: owner"), { code: "SQLITE_ERROR" });
    const poisoned = { get v(): string { throw shaped; } };
    const db = presentButThrowing(() => new Error("unused"));
    const reader = {
      prepare(sql: string) {
        if (sql.includes("FROM ui_artifacts")) return { all: () => [poisoned] };
        return db.prepare(sql);
      },
    };
    const out = findIdentityCollisions(reader);
    expect(out.failed).toContain("ui_artifacts.owner");
    expect(verdictOf(out)).toBe(4);
  });

  it("the REAL driver's catalog decides absence: a missing table and a missing column are skipped, and nothing else is", () => {
    const client = (getStore().db as unknown as { $client: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }).$client;
    // Rename what the catalog is ASKED about, so the real better-sqlite3 catalog answers "absent" without touching the database.
    const renamed = (from: string, to: string) => ({
      prepare: (sql: string) => {
        const stmt = client.prepare(sql);
        return { all: (...p: unknown[]) => stmt.all(...p.map((x) => (x === from ? to : x))) };
      },
    });
    for (const [what, reader] of [
      ["missing table", renamed("ui_artifacts", "ui_artifacts_absent_95e")],
      ["missing column", renamed("owner", "owner_absent_95e")],
    ] as const) {
      const out = findIdentityCollisions(reader);
      expect(out.skipped, what).toEqual(["ui_artifacts.owner"]);
      expect(out.failed, what).toEqual([]);
      expect(verdictOf(out), what).toBe(0);
    }
  });
});

// AZ-9 round 4 hardening (found by the author, before review): SQLite resolves table and column names
// case-insensitively, and a source may be a VIEW. A catalog check that compared names exactly, or listed
// only tables, would read a present source as ABSENT, which an allowlist then excuses: fail OPEN.
describe("AZ-9 round 4: the catalog check matches SQLite's own name resolution (mixed case, views)", () => {
  type Raw = { prepare(sql: string): { all(...p: unknown[]): unknown[] }; exec(sql: string): unknown };
  const raw = () => (getStore().db as unknown as { $client: Raw }).$client;
  // The audit asks the catalog about "ui_artifacts"."owner" exactly as in production; the DATABASE varies.
  // (This is the file's last describe: replacing the in-memory store's ui_artifacts affects no other test.)

  it("[neg] a table stored as \"UI_Artifacts\" with column \"Owner\" is PRESENT (read, never skipped)", () => {
    raw().exec('DROP TABLE IF EXISTS ui_artifacts; CREATE TABLE "UI_Artifacts" ("Owner" TEXT); INSERT INTO "UI_Artifacts" ("Owner") VALUES (\'case95e@x.test\')');
    const out = findIdentityCollisions(raw());
    expect(out.read).toContain("ui_artifacts.owner");
    expect(out.skipped).not.toContain("ui_artifacts.owner");
    expect(out.failed).not.toContain("ui_artifacts.owner");
  });

  it("[neg] a source that is a VIEW named ui_artifacts is PRESENT (read, never skipped)", () => {
    raw().exec('DROP TABLE IF EXISTS ui_artifacts; CREATE TABLE IF NOT EXISTS ui_base_view95e (owner TEXT); CREATE VIEW ui_artifacts AS SELECT owner FROM ui_base_view95e');
    const out = findIdentityCollisions(raw());
    expect(out.read).toContain("ui_artifacts.owner");
    expect(out.skipped).not.toContain("ui_artifacts.owner");
  });
});

// AZ-9 round 5 (astra pack 95e, DO-NOT-SHIP at a25e0f4e): the audit judges MAIN-schema
// state only, and the catalog read and the data read must always resolve the SAME
// object. pragma_table_info silently omits generated columns and hidden virtual-table
// columns even though a plain SELECT can read them (HIGH finding 1), and an unqualified
// pragma/data query can be shadowed by a TEMP table of the same name, or resolve a
// table that exists only in an attached schema, while the main catalog disagrees (HIGH
// finding 2). Every case below uses the real better-sqlite3 driver, as the existing
// AZ-9 round-4 tests do (this is the file's new last describe block: it leaves
// ui_artifacts absent after every test, regardless of what the block above left behind).
describe("AZ-9 round 5: the catalog and the data read must resolve the SAME main-schema object (astra pack 95e)", () => {
  type Raw = { prepare(sql: string): { all(...p: unknown[]): unknown[] }; exec(sql: string): unknown };
  const raw = () => (getStore().db as unknown as { $client: Raw }).$client;

  // Resets to a known, empty main-schema slate before AND after every test in this
  // block: drops ui_artifacts whether it is currently a table or a view (the block
  // above leaves it a view), drops any TEMP shadow, and detaches `aux` if attached.
  const reset = () => {
    const client = raw();
    // Schema-qualified (never bare): a bare DROP TABLE IF EXISTS is itself subject to
    // the TEMP-shadow resolution this block tests for, so when both a temp and a main
    // copy exist, an unqualified drop silently takes the TEMP one and leaves main's
    // copy behind (confirmed empirically while writing these tests).
    try { client.exec("DROP VIEW IF EXISTS main.ui_artifacts"); } catch { /* it's a table, not a view */ }
    try { client.exec("DROP TABLE IF EXISTS main.ui_artifacts"); } catch { /* already gone */ }
    try { client.exec("DROP TABLE IF EXISTS main.ui_base_view95e"); } catch { /* n/a */ }
    try { client.exec("DROP TABLE IF EXISTS temp.ui_artifacts"); } catch { /* no temp shadow */ }
    try { client.exec("DETACH DATABASE aux"); } catch { /* not attached */ }
  };
  beforeAll(reset);
  afterEach(reset);

  describe("case 1: a generated column holding colliding identities must be read, not skipped (finding 1)", () => {
    it("a VIRTUAL generated column", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (raw_owner TEXT, owner TEXT GENERATED ALWAYS AS (raw_owner) VIRTUAL)");
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('Gen95eVirtual@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('gen95evirtual@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      expect(out.skipped).not.toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Gen95eVirtual@collide.test"));
      expect(group?.spellings).toEqual(["Gen95eVirtual@collide.test", "gen95evirtual@collide.test"]);
    });

    it("a STORED generated column", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (raw_owner TEXT, owner TEXT GENERATED ALWAYS AS (raw_owner) STORED)");
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('Gen95eStored@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('gen95estored@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      expect(out.skipped).not.toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Gen95eStored@collide.test"));
      expect(group?.spellings).toEqual(["Gen95eStored@collide.test", "gen95estored@collide.test"]);
    });

    it("a generated column added by ALTER TABLE", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (raw_owner TEXT)");
      client.exec("ALTER TABLE ui_artifacts ADD COLUMN owner TEXT GENERATED ALWAYS AS (raw_owner) VIRTUAL");
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('Gen95eAlter@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (raw_owner) VALUES ('gen95ealter@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      expect(out.skipped).not.toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Gen95eAlter@collide.test"));
      expect(group?.spellings).toEqual(["Gen95eAlter@collide.test", "gen95ealter@collide.test"]);
    });
  });

  describe("case 2: a TEMP table shadowing main must not hide or misreport main's collisions (finding 2, TEMP shadow)", () => {
    it("[misread] colliding identities in main.ui_artifacts are found even when an empty, SAME-shaped temp.ui_artifacts(owner) shadows the unqualified name", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (owner TEXT)"); // main
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('Temp95eShadow@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('temp95eshadow@collide.test')").run();
      client.exec("CREATE TEMP TABLE ui_artifacts (owner TEXT)"); // empty shadow, same column name
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Temp95eShadow@collide.test"));
      expect(group?.spellings).toEqual(["Temp95eShadow@collide.test", "temp95eshadow@collide.test"]);
    });

    // Beyond the brief's literal fixture: a same-named empty TEMP shadow can still
    // coincidentally agree with main on column presence (both happen to declare
    // `owner`), which would not catch a column catalog check that resolves the
    // PRAGMA to the wrong schema on its own. A temp shadow that LACKS the column
    // pins that specifically: a temp shadow with a DIFFERENT shape, where "present"
    // flips if the column check resolves against temp instead of main.
    it("[skipped] colliding identities in main.ui_artifacts are still found when a DIFFERENTLY-shaped temp.ui_artifacts shadows the unqualified name", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (owner TEXT)"); // main
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('Temp95eDiffShadow@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('temp95ediffshadow@collide.test')").run();
      client.exec("CREATE TEMP TABLE ui_artifacts (unrelated_col TEXT)"); // shadow lacks `owner` entirely
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      expect(out.skipped).not.toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Temp95eDiffShadow@collide.test"));
      expect(group?.spellings).toEqual(["Temp95eDiffShadow@collide.test", "temp95ediffshadow@collide.test"]);
    });
  });

  describe("case 3: an optional table that exists ONLY in an attached schema must not be read as if it were main (finding 2, attached-only)", () => {
    it("main-schema absence means skipped, and the attached copy is ignored — even though it holds colliding identities", () => {
      const client = raw();
      // main genuinely lacks ui_artifacts (the block's beforeAll/afterEach guarantee this); the ONLY copy lives in `aux`.
      client.exec("ATTACH ':memory:' AS aux");
      client.exec("CREATE TABLE aux.ui_artifacts (owner TEXT)");
      client.prepare("INSERT INTO aux.ui_artifacts (owner) VALUES ('Aux95eOnly@collide.test')").run();
      client.prepare("INSERT INTO aux.ui_artifacts (owner) VALUES ('aux95eonly@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.skipped).toContain("ui_artifacts.owner");
      expect(out.read).not.toContain("ui_artifacts.owner");
      expect(out.failed).not.toContain("ui_artifacts.owner");
      expect(out.collisions.some((c) => c.spellings.includes("Aux95eOnly@collide.test"))).toBe(false);
    });
  });

  describe("case 5 [control]: scenarios astra's Q3 list also asks for, expected to already pass before this fix", () => {
    it("[control] WITHOUT ROWID is recognized as an ordinary table", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (owner TEXT PRIMARY KEY) WITHOUT ROWID");
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('Wr95eOwner@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (owner) VALUES ('wr95eowner@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Wr95eOwner@collide.test"));
      expect(group?.spellings).toEqual(["Wr95eOwner@collide.test", "wr95eowner@collide.test"]);
    });

    it("[control] an ordinary (non-generated) column added by ALTER TABLE ADD COLUMN is recognized", () => {
      const client = raw();
      client.exec("CREATE TABLE ui_artifacts (id INTEGER)");
      client.exec("ALTER TABLE ui_artifacts ADD COLUMN owner TEXT");
      client.prepare("INSERT INTO ui_artifacts (id, owner) VALUES (1, 'Alt95eAdd@collide.test')").run();
      client.prepare("INSERT INTO ui_artifacts (id, owner) VALUES (2, 'alt95eadd@collide.test')").run();
      const out = findIdentityCollisions(client);
      expect(out.read).toContain("ui_artifacts.owner");
      const group = out.collisions.find((c) => c.sources.includes("ui_artifacts.owner") && c.spellings.includes("Alt95eAdd@collide.test"));
      expect(group?.spellings).toEqual(["Alt95eAdd@collide.test", "alt95eadd@collide.test"]);
    });

    it("[control] a catalog call returning a non-array fails every source; it never crashes the audit and never reports them skipped", () => {
      const nonArrayCatalog: FakeReader = { prepare: () => ({ all: () => undefined as unknown as unknown[] }) };
      const out = findIdentityCollisions(nonArrayCatalog);
      expect(out.failed.length).toBe(7);
      expect(out.skipped).toEqual([]);
      expect(out.read).toEqual([]);
    });
  });
});
