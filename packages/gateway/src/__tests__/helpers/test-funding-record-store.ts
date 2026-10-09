/**
 * TEST ONLY: a FundingRecordStore for the buyer-funding Stage 2 tests. Production has no store until
 * the operator decides the schema (Q9; services/funding-record-port.ts).
 *
 * The records live in a TEMP table on the test's own in-memory SQLite connection, the connection
 * every gateway query runs on. So an insert takes part in the caller's transaction exactly as a
 * real table's would: a rollback undoes it. Partial UNIQUE indexes hold the port's contract over
 * FINALIZED rows only (the steward's ruling 3): one finalized record per scope, and one per escrow
 * address in any letter case. Its lookups return finalized rows only, and `plant` may leave rows in
 * any other state (another writer's observations). It passes the conformance suite
 * (funding-record-store-conformance.ts). installCaseExactFundingRecordStore and
 * installFinalityBlindFundingRecordStore, below, are deliberately broken stores for the tests that
 * show the suite and reconcilePaidScope catch one.
 */
import { sql } from "@pcc/store";
import { getStore } from "../../db.js";
import {
  __setFundingRecordStoreForTest,
  type FundingDbHandle,
  type FundingRecordStore,
  type FundingVerificationRecord,
} from "../../services/funding-record-port.js";

interface Row {
  scope_id: string;
  escrow_address: string;
  buyer: string;
  chain_id: number;
  block_number: string;
  block_hash: string;
  verifier_version: string;
  verified_at: string;
  finality: string;
}

const toRecord = (r: Row): FundingVerificationRecord =>
  ({
    scopeId: r.scope_id,
    escrowAddress: r.escrow_address,
    buyer: r.buyer,
    chainId: r.chain_id,
    blockNumber: r.block_number,
    blockHash: r.block_hash,
    verifierVersion: r.verifier_version,
    verifiedAt: r.verified_at,
    finality: r.finality,
  }) as FundingVerificationRecord;

export interface TestFundingRecordStore extends FundingRecordStore {
  /** How many records are kept. */
  count(): number;
  /** Writes a row as given, unchecked and outside any transaction: a record some other writer left. */
  plant(record: object): void;
}

function insertRow(handle: FundingDbHandle, row: object): void {
  const r = row as Record<string, unknown>;
  handle.run(sql`INSERT INTO test_funding_records
    (scope_id, escrow_key, escrow_address, buyer, chain_id, block_number, block_hash, verifier_version, verified_at, finality)
    VALUES (${r.scopeId as string}, ${String(r.escrowAddress).toLowerCase()}, ${r.escrowAddress as string}, ${r.buyer as string},
      ${r.chainId as number}, ${r.blockNumber as string}, ${r.blockHash as string}, ${r.verifierVersion as string},
      ${r.verifiedAt as string}, ${r.finality as string})`);
}

/** Creates the table on the current store's connection and installs a store over it. */
export function installTestFundingRecordStore(): TestFundingRecordStore {
  const { db } = getStore();
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS test_funding_records (
    scope_id TEXT NOT NULL,
    escrow_key TEXT NOT NULL,
    escrow_address TEXT NOT NULL,
    buyer TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    block_number TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    verifier_version TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    finality TEXT NOT NULL
  )`);
  // Uniqueness over finalized rows only, as Q9's DDL will carry it (partial unique indexes).
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS temp.test_funding_records_finalized_scope
    ON test_funding_records (scope_id) WHERE finality = 'finalized'`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS temp.test_funding_records_finalized_escrow
    ON test_funding_records (escrow_key) WHERE finality = 'finalized'`);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertRow(tx, record);
    },
    findByEscrow(handle, escrowAddress) {
      const row = handle.get<Row | undefined>(
        sql`SELECT * FROM test_funding_records
          WHERE escrow_key = ${String(escrowAddress).toLowerCase()} AND finality = 'finalized'`,
      );
      return row ? toRecord(row) : null;
    },
    findByScope(handle, scopeId) {
      const row = handle.get<Row | undefined>(
        sql`SELECT * FROM test_funding_records WHERE scope_id = ${scopeId} AND finality = 'finalized'`,
      );
      return row ? toRecord(row) : null;
    },
    count() {
      return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM test_funding_records`).n;
    },
    plant(record) {
      insertRow(db, record);
    },
  };
  __setFundingRecordStoreForTest(store);
  return store;
}

/**
 * TEST ONLY, and deliberately BROKEN: a store that ignores finality, as round 2's store did. Its
 * lookups return a row whatever its finality, and its unique keys cover every row. It breaks the port's
 * finalized-only contract (the steward's ruling 3), so the conformance suite must fail it on exactly
 * the two finality checks. reconcilePaidScope's defence-in-depth checks of a kept record (well formed,
 * this buyer's, this scope's) are pinned over it, since a conformant store never shows such a row.
 */
export function installFinalityBlindFundingRecordStore(): TestFundingRecordStore {
  const { db } = getStore();
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS test_funding_records_blind (
    scope_id TEXT NOT NULL UNIQUE,
    escrow_key TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  )`);
  const insertBlind = (handle: FundingDbHandle, row: object) => {
    const r = row as Record<string, unknown>;
    handle.run(sql`INSERT INTO test_funding_records_blind (scope_id, escrow_key, body)
      VALUES (${r.scopeId as string}, ${String(r.escrowAddress).toLowerCase()}, ${JSON.stringify(row)})`);
  };
  const parse = (row: { body: string } | undefined) => (row ? (JSON.parse(row.body) as FundingVerificationRecord) : null);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertBlind(tx, record);
    },
    findByEscrow(handle, escrowAddress) {
      return parse(handle.get<{ body: string } | undefined>(
        sql`SELECT body FROM test_funding_records_blind WHERE escrow_key = ${String(escrowAddress).toLowerCase()}`,
      ));
    },
    findByScope(handle, scopeId) {
      return parse(handle.get<{ body: string } | undefined>(sql`SELECT body FROM test_funding_records_blind WHERE scope_id = ${scopeId}`));
    },
    count() {
      return db.get<{ n: number }>(sql`SELECT count(*) AS n FROM test_funding_records_blind`).n;
    },
    plant(record) {
      insertBlind(db, record);
    },
  };
  __setFundingRecordStoreForTest(store);
  return store;
}

/**
 * TEST ONLY, and deliberately BROKEN: a store that matches escrow addresses exactly as given (an
 * ordinary `WHERE escrow_address = ?`) and keeps no unique key on the escrow, only on the scope. It
 * breaks the port's contract (one record per escrow, in any letter case), as the fund-s2 review's
 * probe P10 store did, and keeps the rest of it (finalized-only lookups and scope key). The
 * conformance suite must fail it on exactly that check, and reconcilePaidScope must still let one
 * funding activate only one scope over it (the address is folded before the store sees it).
 */
export function installCaseExactFundingRecordStore(): TestFundingRecordStore {
  const { db } = getStore();
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS test_funding_records_case_exact (
    scope_id TEXT NOT NULL,
    escrow_address TEXT NOT NULL,
    finality TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS temp.test_funding_records_case_exact_scope
    ON test_funding_records_case_exact (scope_id) WHERE finality = 'finalized'`);
  const insertExact = (handle: FundingDbHandle, row: object) => {
    const r = row as Record<string, unknown>;
    handle.run(sql`INSERT INTO test_funding_records_case_exact (scope_id, escrow_address, finality, body)
      VALUES (${r.scopeId as string}, ${r.escrowAddress as string}, ${String(r.finality)}, ${JSON.stringify(row)})`);
  };
  const parse = (row: { body: string } | undefined) => (row ? (JSON.parse(row.body) as FundingVerificationRecord) : null);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertExact(tx, record);
    },
    findByEscrow(handle, escrowAddress) {
      return parse(handle.get<{ body: string } | undefined>(
        sql`SELECT body FROM test_funding_records_case_exact WHERE escrow_address = ${escrowAddress} AND finality = 'finalized'`,
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
