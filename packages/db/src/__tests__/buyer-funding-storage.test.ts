import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../migrate.js";

type Row = Record<string, string | number | Buffer | null>;
const address = (n = 1) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = `0x${"ab".repeat(32)}`;
const stamp = "2026-10-16T00:00:00.000Z";
const states = ["pending_signature", "served", "superseded", "expired"] as const;
const signedColumns = ["operator_signature", "signature_verified_at", "signed_at", "served_payload", "served_payload_sha256"];
const endColumns = ["ended_at", "superseded_by"];

function observation(overrides: Row = {}): Row {
  return {
    scope_id: "scope-a", chain_id: 84532, escrow: address(), buyer: address(2), operator: address(3),
    finality: "finalized", block_number: "100", block_hash: hash, funding_block_number: "90",
    funding_block_hash: hash, funded_at: 100, verifier_version: "q9-test", verified_at: stamp,
    ...overrides,
  };
}
function prepare(state: string = "pending_signature", overrides: Row = {}): Row {
  return {
    id: "prepare-a", scope_id: "scope-a", job_id: "job-a", job_id_hash: hash,
    chain_id: 84532, escrow: address(), s01_record_sha256: "ab".repeat(32),
    s01_schedule_id: "vnext-testnet-short-v1", s01_schedule_testnet_only: 0,
    factory: address(2), implementation: address(3), usdc: address(4), payer: address(5), operator: address(6),
    terms_hash: hash, policy_nonce: "0", pre_policy_root: hash, accepted_policy_digest: hash,
    total_gross: "1000000", quote_snapshot: "{}", configs: "[]", unit_ids: "[]",
    expiry: 100, scope_expires_at: stamp, finality_f_s: 10, margin_m_s: 5,
    reclaim_at_earliest: 1000000, reclaim_at_latest: 1000001, reconcile_until: 200,
    typed_data_digest: hash, operator_signature: null, signature_verified_at: null, signed_at: null,
    served_payload: null, served_payload_sha256: null, state, created_at: stamp,
    signature_requested_at: null, ended_at: null, superseded_by: null,
    ...(state === "served" ? signedFields() : {}),
    ...(["superseded", "expired"].includes(state) ? { ended_at: stamp } : {}),
    ...(state === "superseded" ? { superseded_by: "prepare-next" } : {}),
    ...overrides,
  };
}
function signedFields(): Row {
  return {
    operator_signature: `0x${"ab".repeat(65)}`, signature_verified_at: stamp, signed_at: stamp,
    served_payload: Buffer.from("exact bytes"), served_payload_sha256: "ab".repeat(32),
  };
}

describe("buyer funding storage checks, indexes and lifecycle", () => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    migrateDatabase(sqlite);
  });
  afterEach(() => sqlite.close());
  function insert(table: string, row: Row) {
    const columns = Object.keys(row);
    return sqlite.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((c) => row[c]));
  }
  function update(values: Row) {
    const columns = Object.keys(values);
    return sqlite.prepare(`UPDATE funding_prepares SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = 'prepare-a'`)
      .run(...columns.map((c) => values[c]));
  }
  function rejected(table: string, build: (overrides: Row) => Row, column: string, values: Row[string][]) {
    for (const value of values) {
      expect(() => insert(table, build({ [column]: value })), `${table}.${column} = ${String(value)}`).toThrow(/CHECK/);
    }
  }

  const escrowAddresses = ["escrow", "buyer", "operator"];
  const prepareAddresses = ["escrow", "factory", "implementation", "usdc", "payer", "operator"];
  it("expands NZADDR checks on every assigned column, including the zero clause", () => {
    const bad = [`0x${"AB".repeat(20)}`, address().slice(0, -1), `${address()}0`, `0x${"0".repeat(39)}g`, `00${"a".repeat(40)}`, address(0)];
    for (const c of escrowAddresses) rejected("escrow_funding", observation, c, bad);
    for (const c of prepareAddresses) rejected("funding_prepares", (x) => prepare("pending_signature", x), c, bad);
    insert("escrow_funding", observation());
    insert("funding_prepares", prepare());
  });
  it("expands HASH32 checks on every assigned column and accepts 0x00..01", () => {
    const bad = [`0x${"AB".repeat(32)}`, hash.slice(0, -1), `${hash}0`, `0x${"a".repeat(63)}g`, `00${"a".repeat(64)}`, hash.slice(2)];
    for (const c of ["block_hash", "funding_block_hash"]) rejected("escrow_funding", observation, c, bad);
    for (const c of ["job_id_hash", "terms_hash", "pre_policy_root", "accepted_policy_digest", "typed_data_digest"]) {
      rejected("funding_prepares", (x) => prepare("pending_signature", x), c, bad);
    }
    const tinyHash = `0x${"0".repeat(63)}1`;
    insert("escrow_funding", observation({ block_hash: tinyHash, funding_block_hash: tinyHash }));
    insert("funding_prepares", prepare("pending_signature", Object.fromEntries(
      ["job_id_hash", "terms_hash", "pre_policy_root", "accepted_policy_digest", "typed_data_digest"].map((c) => [c, tinyHash]),
    )));
  });
  it("checks the two unprefixed SHA-256 pins and variable-length hex signatures", () => {
    const pinBad = ["AB".repeat(32), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, hash];
    for (const c of ["s01_record_sha256", "served_payload_sha256"]) {
      rejected("funding_prepares", (x) => prepare("pending_signature", x), c, pinBad);
    }
    rejected("funding_prepares", (x) => prepare("pending_signature", x), "operator_signature", [
      "0x", `0x${"AB".repeat(65)}`, `0x${"a".repeat(129)}`, `0x${"a".repeat(131)}`, `0x${"a".repeat(129)}g`, "ab".repeat(65),
    ]);
    insert("funding_prepares", prepare("served", {
      s01_record_sha256: `${"0".repeat(63)}1`, served_payload_sha256: `${"0".repeat(63)}1`,
      operator_signature: `0x${"0".repeat(129)}1`,
    }));
    insert("funding_prepares", prepare("served", {
      id: "longer-erc1271", scope_id: "scope-long", escrow: address(12),
      operator_signature: `0x${"ab".repeat(96)}`,
    }));
  });
  it("expands canonical UINT64 and UINT256 checks on all assigned columns", () => {
    for (const c of ["block_number", "funding_block_number"]) {
      rejected("escrow_funding", observation, c, ["", "01", "-1", "1.0", "a", "1".repeat(21)]);
    }
    for (const c of ["policy_nonce", "total_gross"]) {
      rejected("funding_prepares", (x) => prepare("pending_signature", x), c, ["", "01", "-1", "1.0", "a", "1".repeat(79)]);
    }
    for (const [i, value] of ["0", "1", "9".repeat(20)].entries()) {
      insert("escrow_funding", observation({ scope_id: `scope-${i}`, escrow: address(i + 10), block_number: value, funding_block_number: value }));
    }
    for (const [i, value] of ["0", "1", "9".repeat(78)].entries()) {
      insert("funding_prepares", prepare("pending_signature", { id: `prepare-${i}`, scope_id: `scope-${i}`, escrow: address(i + 10), policy_nonce: value, total_gross: value }));
    }
  });
  it("checks the scalar ranges and closed state and finality vocabularies", () => {
    for (const [column, values] of Object.entries({ scope_id: ["", "a".repeat(201)], chain_id: [0, -1], funded_at: [0, -1], verifier_version: ["", "a".repeat(101)], finality: ["final", "FINALIZED"] })) {
      rejected("escrow_funding", observation, column, values);
    }
    for (const [column, values] of Object.entries({ chain_id: [0, -1], s01_schedule_testnet_only: [-1, 2], finality_f_s: [-1], margin_m_s: [-1], state: ["pending", "other"] })) {
      rejected("funding_prepares", (x) => prepare("pending_signature", x), column, values);
    }
    insert("escrow_funding", observation({ scope_id: "a", verifier_version: "a" }));
    insert("escrow_funding", observation({ scope_id: "a".repeat(200), verifier_version: "a".repeat(100), escrow: address(9) }));
  });
  it("refuses a NULL or empty prepare id, and a prepare id over 200 characters", () => {
    for (const id of [null, "", "p".repeat(201)]) {
      expect(() => insert("funding_prepares", prepare("pending_signature", { id }))).toThrow(/NOT NULL|CHECK/);
    }
    insert("funding_prepares", prepare("pending_signature", { id: "p" }));
  });

  it("INTEGER affinity cannot smuggle nonnumeric TEXT or fractional REAL into checked columns", () => {
    const nearMisses = ["abc", "12x", 5.5];
    for (const c of ["chain_id", "funded_at"]) rejected("escrow_funding", observation, c, nearMisses);
    for (const c of ["chain_id", "expiry", "s01_schedule_testnet_only", "finality_f_s", "margin_m_s", "reclaim_at_earliest", "reclaim_at_latest", "reconcile_until"]) {
      rejected("funding_prepares", (overrides) => prepare("pending_signature", overrides), c, nearMisses);
    }
    // SQLite affinity stores these as INTEGER, so the typeof() constraints admit them.
    insert("escrow_funding", observation({ chain_id: "7", funded_at: "7.0" }));
    insert("funding_prepares", prepare("pending_signature", { id: "integer-affinity", chain_id: "7", expiry: "7.0" }));
  });

  it("checks JSON syntax, requires a unit_ids array, and keeps served bytes as nonempty BLOB", () => {
    for (const c of ["quote_snapshot", "configs", "unit_ids"]) rejected("funding_prepares", (x) => prepare("pending_signature", x), c, ["not-json"]);
    rejected("funding_prepares", (x) => prepare("pending_signature", x), "unit_ids", ["{}", "null", '"array"']);
    rejected("funding_prepares", (x) => prepare("pending_signature", x), "served_payload", ["text bytes", Buffer.alloc(0)]);
    insert("funding_prepares", prepare("served"));
  });
  it.each(states)("checks ordering on %s rows and applies the nine-day rule only outside testnet", (state) => {
    rejected("funding_prepares", (x) => prepare(state, x), "reclaim_at_latest", [999999]);
    rejected("funding_prepares", (x) => prepare(state, x), "expiry", [1000000]);
    for (const testnet of [0, 1]) {
      expect(() => insert("funding_prepares", prepare(state, { s01_schedule_testnet_only: testnet, reconcile_until: 999991 }))).toThrow(/CHECK/);
    }
    expect(() => insert("funding_prepares", prepare(state, { reconcile_until: 222401 }))).toThrow(/CHECK/);
    insert("funding_prepares", prepare(state, { reconcile_until: 222400 }));
    insert("funding_prepares", prepare(state, { id: "testnet", scope_id: "testnet", escrow: address(8), s01_schedule_testnet_only: 1, reconcile_until: 999990 }));
  });
  it("enforces both finalized partial uniques while latest rows never block or are blocked", () => {
    insert("escrow_funding", observation({ finality: "latest" }));
    insert("escrow_funding", observation({ finality: "latest" }));
    insert("escrow_funding", observation());
    expect(() => insert("escrow_funding", observation({ escrow: address(8) }))).toThrow(/escrow_funding_no_replace/);
    expect(() => insert("escrow_funding", observation({ scope_id: "another" }))).toThrow(/escrow_funding_no_replace/);
    insert("escrow_funding", observation({ finality: "latest" }));
    insert("escrow_funding", observation({ scope_id: "other-chain", chain_id: 31337 }));
    expect(sqlite.prepare("SELECT count(*) AS n FROM escrow_funding").get()).toEqual({ n: 5 });
  });
  it("refuses explicit nonpositive escrow ids without poisoning implicit rowid inserts", () => {
    for (const id of [-1, 0]) expect(() => insert("escrow_funding", observation({ id }))).toThrow(/CHECK/);
    insert("escrow_funding", observation({ scope_id: "implicit-one" }));
    insert("escrow_funding", observation({ scope_id: "implicit-two", escrow: address(8) }));
    expect(sqlite.prepare("SELECT id FROM escrow_funding ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.each(states)("K1 keeps every %s row's chain and escrow reserved", (state) => {
    insert("funding_prepares", prepare(state));
    expect(() => insert("funding_prepares", prepare("pending_signature", { id: "b", scope_id: "b" }))).toThrow(/funding_prepares_no_replace/);
    insert("funding_prepares", prepare("pending_signature", { id: "c", scope_id: "c", chain_id: 31337 }));
  });
  it.each(["pending_signature", "served"])("K2 refuses a second live scope when the first is %s", (state) => {
    insert("funding_prepares", prepare(state));
    for (const next of ["pending_signature", "served"]) {
      expect(() => insert("funding_prepares", prepare(next, { id: "b", escrow: address(8) }))).toThrow(/funding_prepares_no_replace/);
    }
    insert("funding_prepares", prepare("expired", { id: "c", escrow: address(9) }));
  });
  it("supersedes before insertion so K2 frees the scope, while ended rows coexist", () => {
    insert("funding_prepares", prepare("served"));
    sqlite.transaction(() => {
      update({ state: "superseded", ended_at: stamp, superseded_by: "prepare-next" });
      insert("funding_prepares", prepare("pending_signature", { id: "prepare-next", escrow: address(8) }));
    })();
    insert("funding_prepares", prepare("expired", { id: "expired", escrow: address(9) }));
    expect(sqlite.prepare("SELECT count(*) AS n FROM funding_prepares").get()).toEqual({ n: 3 });
  });
  it("escrow_funding rejects UPDATE and DELETE, and aborts and rolls back their caller transactions", () => {
    insert("escrow_funding", observation());
    for (const statement of ["UPDATE escrow_funding SET verified_at = 'changed'", "DELETE FROM escrow_funding"]) {
      expect(() => sqlite.exec(statement)).toThrow(/escrow_funding is append-only/);
      expect(() => sqlite.transaction(() => {
        insert("escrow_funding", observation({ scope_id: "rolled-back", escrow: address(9) }));
        sqlite.exec(statement);
      })()).toThrow(/escrow_funding is append-only/);
      expect(sqlite.inTransaction).toBe(false);
      expect(sqlite.prepare("SELECT scope_id, verified_at FROM escrow_funding").all()).toEqual([{ scope_id: "scope-a", verified_at: stamp }]);
    }
  });
  /** Covers the PRIMARY KEY and every unique index, including partial unique indexes.
   * A new unique key without a matching BEFORE INSERT guard must fail its REPLACE probe. */
  function uniqueKeys(table: string): Array<{ columns: string[]; predicate: string }> {
    const indexList = sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; partial: number }>;
    const unique = indexList.filter((index) => index.unique === 1).map((index) => {
      const columns = (sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
        .sort((a, b) => a.seqno - b.seqno).map((part) => part.name);
      const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name) as { sql: string | null };
      return { columns, predicate: index.partial ? (row.sql?.split(/\bWHERE\b/i)[1]?.trim() ?? "") : "" };
    });
    const primary = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (primary.length > 0) unique.push({ columns: primary, predicate: "" });
    return [...new Map(unique.map((key) => [`${key.columns.join(",")}|${key.predicate}`, key])).values()];
  }

  function snapshot(table: string) {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  }

  function insertUsing(table: string, record: Row, verb: "INSERT OR REPLACE INTO" | "REPLACE INTO" | "INSERT INTO"): void {
    const columns = Object.keys(record);
    sqlite.prepare(`${verb} ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => record[column]));
  }

  it.each(["escrow_funding", "funding_prepares"])("guard covers every discovered unique key in %s, preserving a full row under REPLACE", (table) => {
    const keys = uniqueKeys(table);
    for (const expected of ["id", "scope_id", "chain_id,escrow"]) {
      expect(keys.some((key) => key.columns.join(",") === expected), `${table} ${expected}`).toBe(true);
    }
    const guard = new RegExp(`${table}_no_replace`);
    for (const { columns, predicate } of keys) {
      // Each key gets a rollback-only savepoint, so the immutable seed can be re-used.
      const existing = table === "escrow_funding"
        ? observation({ id: 100, scope_id: "scope-pin", chain_id: 84532, escrow: address(15) })
        : prepare("pending_signature", { id: "prepare-pin", scope_id: "scope-pin", chain_id: 84532, escrow: address(15) });
      const candidate = table === "escrow_funding"
        ? observation({ id: 101, scope_id: "scope-next", chain_id: 31337, escrow: address(16), buyer: address(17), operator: address(18), block_hash: `0x${"cd".repeat(32)}` })
        : prepare("pending_signature", { id: "prepare-next", scope_id: "scope-next", job_id: "job-next", chain_id: 31337, escrow: address(16), payer: address(17) });
      if (table === "escrow_funding" && /finality\s*=\s*'latest'/i.test(predicate)) {
        existing.finality = "latest";
        candidate.finality = "latest";
      }
      for (const column of columns) candidate[column] = existing[column];
      expect(() => sqlite.transaction(() => {
        insert(table, existing);
        const before = snapshot(table);
        for (const verb of ["INSERT OR REPLACE INTO", "REPLACE INTO"] as const) {
          expect(() => insertUsing(table, candidate, verb), `${table} ${columns.join(",")} ${verb}`).toThrow(guard);
          expect(snapshot(table)).toEqual(before);
        }
        expect(() => insertUsing(table, candidate, "INSERT INTO")).toThrow(guard);
        expect(snapshot(table)).toEqual(before);
        throw new Error("rollback guard probe");
      })()).toThrow("rollback guard probe");
      expect(snapshot(table)).toEqual([]);
    }
  });

  it("funding_prepares has no hidden rowid for INSERT OR REPLACE or UPDATE OR REPLACE", () => {
    insert("funding_prepares", prepare("served"));
    const before = snapshot("funding_prepares");
    expect(() => insertUsing("funding_prepares", { ...prepare("pending_signature", { id: "new", scope_id: "new", escrow: address(8) }), rowid: 1 }, "INSERT OR REPLACE INTO"))
      .toThrow(/no column named rowid|no such column/i);
    expect(snapshot("funding_prepares")).toEqual(before);
    expect(() => sqlite.exec("UPDATE OR REPLACE funding_prepares SET rowid = 1 WHERE id = 'prepare-a'"))
      .toThrow(/no such column/i);
    expect(snapshot("funding_prepares")).toEqual(before);
  });

  it("UPDATE OR REPLACE cannot bypass either table's immutability", () => {
    insert("escrow_funding", observation());
    insert("funding_prepares", prepare("served"));
    const escrowBefore = snapshot("escrow_funding");
    const preparesBefore = snapshot("funding_prepares");
    expect(() => sqlite.exec("UPDATE OR REPLACE escrow_funding SET scope_id = 'new'"))
      .toThrow(/escrow_funding is append-only/);
    expect(() => sqlite.exec("UPDATE OR REPLACE funding_prepares SET escrow = 'new'"))
      .toThrow(/funding_prepares_frozen/);
    expect(snapshot("escrow_funding")).toEqual(escrowBefore);
    expect(snapshot("funding_prepares")).toEqual(preparesBefore);
  });

  for (const oldState of states) for (const newState of states) {
    const allowed = (oldState === "pending_signature" && newState !== "pending_signature") || (oldState === "served" && ["expired", "superseded"].includes(newState));
    it(`T3 ${oldState} -> ${newState} ${allowed ? "passes" : "raises"}`, () => {
      insert("funding_prepares", prepare(oldState));
      const values: Row = { state: newState };
      if (newState === "served" && oldState === "pending_signature") Object.assign(values, signedFields());
      if (["expired", "superseded"].includes(newState) && ["pending_signature", "served"].includes(oldState)) {
        values.ended_at = stamp;
        values.superseded_by = newState === "superseded" ? "prepare-next" : null;
      }
      if (allowed) expect(() => update(values)).not.toThrow();
      else expect(() => update(values)).toThrow(/funding_prepares_transitions/);
    });
  }
  it.each(states)("T1 freezes every identity, pin, term and time column in %s", (state) => {
    const row = prepare(state);
    insert("funding_prepares", row);
    const frozen = Object.keys(row).filter((c) => ![...signedColumns, ...endColumns, "state", "signature_requested_at"].includes(c));
    expect(frozen).toContain("id");
    for (const column of frozen) {
      expect(() => sqlite.exec(`UPDATE funding_prepares SET ${column} = ${column}`), column).toThrow(/funding_prepares_frozen/);
    }
  });
  it.each(states)("T2 signs once, T4 ends once and T5 limits requests while %s", (state) => {
    insert("funding_prepares", prepare(state));
    for (const column of signedColumns) {
      expect(() => sqlite.exec(`UPDATE funding_prepares SET ${column} = ${column}`), column).toThrow(/funding_prepares_signed_once/);
    }
    for (const column of endColumns) {
      expect(() => sqlite.exec(`UPDATE funding_prepares SET ${column} = ${column}`), column).toThrow(/funding_prepares_end_once/);
    }
    const request = () => update({ signature_requested_at: stamp });
    if (state === "pending_signature") {
      expect(request).not.toThrow();
      expect(request).not.toThrow();
    } else expect(request).toThrow(/funding_prepares_requested/);
  });
  it.each(signedColumns)("served requires %s", (column) => {
    expect(() => insert("funding_prepares", prepare("served", { [column]: null }))).toThrow(/CHECK/);
    insert("funding_prepares", prepare());
    expect(() => update({ state: "served", ...signedFields(), [column]: null })).toThrow(/CHECK/);
  });
  it("checks ended and superseded metadata at insert and forbids every DELETE", () => {
    for (const state of ["superseded", "expired"]) {
      expect(() => insert("funding_prepares", prepare(state, { ended_at: null }))).toThrow(/CHECK/);
    }
    expect(() => insert("funding_prepares", prepare("superseded", { superseded_by: null }))).toThrow(/CHECK/);
    for (const state of ["pending_signature", "served", "expired"]) {
      expect(() => insert("funding_prepares", prepare(state, { superseded_by: "wrong" }))).toThrow(/CHECK/);
    }
    for (const [i, state] of states.entries()) {
      insert("funding_prepares", prepare(state, { id: `p-${i}`, scope_id: `s-${i}`, escrow: address(i + 10) }));
      expect(() => sqlite.prepare("DELETE FROM funding_prepares WHERE id = ?").run(`p-${i}`)).toThrow(/funding_prepares_no_delete/);
    }
  });
  it("pins every column to exactly one UPDATE OF list, including id in T1 and state only in T3", () => {
    const columns = sqlite.prepare("PRAGMA table_info(funding_prepares)").all() as Array<{ name: string }>;
    const triggers = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'funding_prepares'").all() as Array<{ name: string; sql: string }>;
    const coverage = new Map<string, string[]>();
    for (const trigger of triggers) {
      const match = trigger.sql.match(/UPDATE\s+OF\s+([\s\S]*?)\s+ON\s+funding_prepares/i);
      if (!match) continue;
      for (const column of match[1].split(",").map((c) => c.trim())) coverage.set(column, [...(coverage.get(column) ?? []), trigger.name]);
    }
    expect([...coverage.keys()].sort()).toEqual(columns.map((c) => c.name).sort());
    for (const { name } of columns) expect(coverage.get(name), name).toHaveLength(1);
    expect(coverage.get("id")).toEqual(["funding_prepares_frozen"]);
    expect(coverage.get("state")).toEqual(["funding_prepares_transitions"]);
  });
});
