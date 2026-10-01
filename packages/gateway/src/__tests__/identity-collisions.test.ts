/**
 * WP-A round 8 (astra authz r2: "check existing identities for collisions before
 * enabling the broader normalization policy"). findIdentityCollisions groups the
 * stored identities by normalizeIdentity. It flags as `newMerge` the groups whose
 * spellings were DISTINCT under master's comparison (trim + lowercase): those are
 * the principals the new normalization would join.
 * scripts/identity-collision-audit.mjs runs it before deploy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";
import { findIdentityCollisions, collisionAuditExit } from "../auth/identity-collisions.js";

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

  it("[neg] a Reader whose prepare() always throws skips every source, and the exit is 4 (not 0)", () => {
    const throwing = { prepare() { throw new Error("no such table"); } };
    const { collisions, read, skipped } = findIdentityCollisions(throwing);
    expect(collisions).toEqual([]);
    expect(read).toEqual([]);
    expect(skipped.length).toBe(ALL_SOURCES.length);
    const verdict = collisionAuditExit({ newMerges: 0, read, skipped, allowedAbsent: [] });
    expect(verdict.code).toBe(4);
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
    return {
      prepare(sql: string) {
        if (sql.includes(`FROM ${sourceTable}`)) throw err();
        return { all: () => [] as unknown[] };
      },
    };
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

  it("control: a CONFIRMED missing table on an allowlisted source is still exit 0", () => {
    const missing = () => Object.assign(new Error("no such table: ui_artifacts"), { code: "SQLITE_ERROR" });
    const out = findIdentityCollisions(readerFailing("ui_artifacts", missing));
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(0);
  });

  it("control: a CONFIRMED missing column on an allowlisted source is exit 0", () => {
    const missing = () => Object.assign(new Error("no such column: owner"), { code: "SQLITE_ERROR" });
    const out = findIdentityCollisions(readerFailing("ui_artifacts", missing));
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: ["ui_artifacts.owner"] } as never).code).toBe(0);
  });

  it("[neg] a query that fails part-way through .all() is a FAILED read (exit 4), even when allowlisted", () => {
    const reader = {
      prepare(sql: string) {
        if (sql.includes("FROM ui_artifacts")) return { all: () => { throw CORRUPT(); } };
        return { all: () => [] as unknown[] };
      },
    };
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
    const out = findIdentityCollisions({ prepare: () => ({ all: () => [] as unknown[] }) });
    expect(out.read.length).toBe(7);
    expect(collisionAuditExit({ newMerges: 0, ...out, allowedAbsent: [] } as never).code).toBe(0);
  });
});

