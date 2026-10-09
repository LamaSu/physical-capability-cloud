/**
 * TEST ONLY: a FundingRecordStore for the buyer-funding Stage 2 tests. Production has no store until
 * the operator decides the schema (Q9; services/funding-record-port.ts).
 *
 * The records live in a TEMP table on the test's own in-memory SQLite connection, the connection
 * every gateway query runs on. So an insert takes part in the caller's transaction exactly as a
 * real table's would: a rollback undoes it. Partial UNIQUE indexes hold the port's contract over
 * FINALIZED rows only (the steward's ruling 3): one finalized record per scope, and one per escrow
 * key, (chainId, escrow address in any letter case) (ruling 4). Its lookups return finalized rows
 * only, and `plant` may leave rows in any other state (another writer's observations). It passes the
 * conformance suite (funding-record-store-conformance.ts).
 *
 * The other installers below are deliberately BROKEN stores, each in one named way, for the tests
 * that show the suite and reconcilePaidScope catch one.
 */
import { sql } from "@pcc/store";
import { getStore } from "../../db.js";
import {
  __setFundingRecordStoreForTest,
  type FundingDbHandle,
  type FundingRecordStore,
  type FundingVerificationRecord,
} from "../../services/funding-record-port.js";

export interface TestFundingRecordStore extends FundingRecordStore {
  /** How many rows are kept, finalized or not. */
  count(): number;
  /** Writes a row as given, unchecked and outside any transaction: a record some other writer left. */
  plant(record: object): void;
}

/** The ways a SQL test store can break the port's contract (none: the conformant test store). */
interface Flaws {
  /** Lookups and unique keys ignore finality, as round 2's store did (ruling 3 broken). */
  finalityBlind?: boolean;
  /** The escrow key ignores the chain: one record per escrow address across chains (ruling 4 broken). */
  chainBlind?: boolean;
}

/**
 * A store over TEMP table `table`: each row keeps the record's JSON, its scope, chain, folded escrow
 * address and finality. The unique indexes and the lookups follow the port's contract, but for `flaws`.
 */
function installSqlStore(table: string, flaws: Flaws): TestFundingRecordStore {
  const { db } = getStore();
  const t = sql.raw(table);
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS ${t} (
    scope_id TEXT NOT NULL,
    chain_id INTEGER,
    escrow_key TEXT NOT NULL,
    finality TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  // Uniqueness over finalized rows only, as Q9's DDL will carry it (partial unique indexes).
  const finalizedOnly = sql.raw(flaws.finalityBlind ? "" : "WHERE finality = 'finalized'");
  const escrowColumns = sql.raw(flaws.chainBlind ? "escrow_key" : "chain_id, escrow_key");
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`temp.${table}_scope`)} ON ${t} (scope_id) ${finalizedOnly}`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`temp.${table}_escrow`)} ON ${t} (${escrowColumns}) ${finalizedOnly}`);
  const andFinalized = sql.raw(flaws.finalityBlind ? "" : "AND finality = 'finalized'");

  const insertRow = (handle: FundingDbHandle, row: object) => {
    const r = row as Record<string, unknown>;
    handle.run(sql`INSERT INTO ${t} (scope_id, chain_id, escrow_key, finality, body)
      VALUES (${r.scopeId as string}, ${r.chainId as number}, ${String(r.escrowAddress).toLowerCase()}, ${String(r.finality)},
        ${JSON.stringify(row)})`);
  };
  const parse = (row: { body: string } | undefined) => (row ? (JSON.parse(row.body) as FundingVerificationRecord) : null);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertRow(tx, record);
    },
    findByEscrow(handle, chainId, escrowAddress) {
      const onChain = flaws.chainBlind ? sql`` : sql`AND chain_id = ${chainId}`;
      return parse(handle.get<{ body: string } | undefined>(
        sql`SELECT body FROM ${t} WHERE escrow_key = ${String(escrowAddress).toLowerCase()} ${onChain} ${andFinalized}`,
      ));
    },
    findByScope(handle, scopeId) {
      return parse(handle.get<{ body: string } | undefined>(sql`SELECT body FROM ${t} WHERE scope_id = ${scopeId} ${andFinalized}`));
    },
    count() {
      return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${t}`).n;
    },
    plant(record) {
      insertRow(db, record);
    },
  };
  __setFundingRecordStoreForTest(store);
  return store;
}

/** Creates the table on the current store's connection and installs the conformant test store over it. */
export function installTestFundingRecordStore(): TestFundingRecordStore {
  return installSqlStore("test_funding_records", {});
}

/**
 * Deliberately BROKEN: ignores finality, as round 2's store did. Its lookups return a row whatever its
 * finality, and its unique keys cover every row. The conformance suite must fail it on exactly the two
 * finality checks. reconcilePaidScope's defence-in-depth checks of a kept record (well formed, this
 * buyer's, this scope's) are pinned over it, since a conformant store never shows such a row.
 */
export function installFinalityBlindFundingRecordStore(): TestFundingRecordStore {
  return installSqlStore("test_funding_records_blind", { finalityBlind: true });
}

/**
 * Deliberately BROKEN: keys the escrow by its address alone, whatever the chain. The conformance suite
 * must fail it on exactly the chain-key check (ruling 4: one funding address on two chains is two
 * distinct records).
 */
export function installChainBlindFundingRecordStore(): TestFundingRecordStore {
  return installSqlStore("test_funding_records_chain_blind", { chainBlind: true });
}

/**
 * Deliberately BROKEN: a store that matches escrow addresses exactly as given (an ordinary
 * `WHERE escrow_address = ?`) and keeps no unique key on the escrow, only on the scope. It breaks the
 * port's contract (one record per escrow, in any letter case), as the fund-s2 review's probe P10 store
 * did, and keeps the rest of it (finalized-only lookups, the scope key, the chain in a lookup). The
 * conformance suite must fail it on exactly the checks that need one record per escrow, and
 * reconcilePaidScope must still let one funding activate only one scope over it (the port folds the
 * address before the store sees it).
 */
export function installCaseExactFundingRecordStore(): TestFundingRecordStore {
  const { db } = getStore();
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS test_funding_records_case_exact (
    scope_id TEXT NOT NULL,
    chain_id INTEGER,
    escrow_address TEXT NOT NULL,
    finality TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS temp.test_funding_records_case_exact_scope
    ON test_funding_records_case_exact (scope_id) WHERE finality = 'finalized'`);
  const insertExact = (handle: FundingDbHandle, row: object) => {
    const r = row as Record<string, unknown>;
    handle.run(sql`INSERT INTO test_funding_records_case_exact (scope_id, chain_id, escrow_address, finality, body)
      VALUES (${r.scopeId as string}, ${r.chainId as number}, ${r.escrowAddress as string}, ${String(r.finality)}, ${JSON.stringify(row)})`);
  };
  const parse = (row: { body: string } | undefined) => (row ? (JSON.parse(row.body) as FundingVerificationRecord) : null);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertExact(tx, record);
    },
    findByEscrow(handle, chainId, escrowAddress) {
      return parse(handle.get<{ body: string } | undefined>(
        sql`SELECT body FROM test_funding_records_case_exact
          WHERE escrow_address = ${escrowAddress} AND chain_id = ${chainId} AND finality = 'finalized'`,
      ));
    },
    findByScope(handle, scopeId) {
      return parse(handle.get<{ body: string } | undefined>(
        sql`SELECT body FROM test_funding_records_case_exact WHERE scope_id = ${scopeId} AND finality = 'finalized'`,
      ));
    },
    count() {
      return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM test_funding_records_case_exact`).n;
    },
    plant(record) {
      insertExact(db, record);
    },
  };
  __setFundingRecordStoreForTest(store);
  return store;
}
