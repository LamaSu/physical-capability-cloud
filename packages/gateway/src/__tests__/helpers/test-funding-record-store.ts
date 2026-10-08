/**
 * TEST ONLY: a FundingRecordStore for the buyer-funding Stage 2 tests. Production has no store until
 * the operator decides the schema (Q9; services/funding-record-port.ts).
 *
 * The records live in a TEMP table on the test's own in-memory SQLite connection, the connection
 * every gateway query runs on. So an insert takes part in the caller's transaction exactly as a
 * real table's would: a rollback undoes it. UNIQUE keys hold the port's contract: one record per
 * scope, and one per escrow address in any letter case.
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
    scope_id TEXT NOT NULL UNIQUE,
    escrow_key TEXT NOT NULL UNIQUE,
    escrow_address TEXT NOT NULL,
    buyer TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    block_number TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    verifier_version TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    finality TEXT NOT NULL
  )`);
  const store: TestFundingRecordStore = {
    insert(tx, record) {
      insertRow(tx, record);
    },
    findByEscrow(handle, escrowAddress) {
      const row = handle.get<Row | undefined>(
        sql`SELECT * FROM test_funding_records WHERE escrow_key = ${String(escrowAddress).toLowerCase()}`,
      );
      return row ? toRecord(row) : null;
    },
    findByScope(handle, scopeId) {
      const row = handle.get<Row | undefined>(sql`SELECT * FROM test_funding_records WHERE scope_id = ${scopeId}`);
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
