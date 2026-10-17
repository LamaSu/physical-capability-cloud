/**
 * The append-only SQLite funding record store. Callers supply their transaction or read handle;
 * this store opens no transaction, so its writes share the caller's commit or rollback/savepoint.
 * Production wiring remains with S1.2; fundingRecordStore() still exposes only test-installed stores.
 */
import { and, eq, schema } from "@pcc/store";
import {
  FUNDING_FINALITY,
  type FundingDbHandle,
  type FundingRecordStore,
  type FundingTx,
  type FundingVerificationRecord,
} from "./funding-record-port.js";

const table = schema.escrowFunding;

/** Rebuild the port record from typed columns without changing the stored verifier timestamp. */
function recordOf(row: typeof table.$inferSelect | undefined): FundingVerificationRecord | null {
  return row ? {
    scopeId: row.scopeId,
    escrowAddress: row.escrow,
    buyer: row.buyer,
    operator: row.operator,
    chainId: row.chainId,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    fundingBlockNumber: row.fundingBlockNumber,
    fundingBlockHash: row.fundingBlockHash,
    fundedAt: row.fundedAt,
    verifierVersion: row.verifierVersion,
    verifiedAt: row.verifiedAt,
    finality: FUNDING_FINALITY,
  } : null;
}

/** Stores only finalized records; unfinalized observations remain invisible to both lookups. */
export class SqliteFundingRecordStore implements FundingRecordStore {
  insert(tx: FundingTx, record: FundingVerificationRecord): void {
    tx.insert(table).values({
      scopeId: record.scopeId,
      chainId: record.chainId,
      escrow: record.escrowAddress.toLowerCase(),
      buyer: record.buyer.toLowerCase(),
      operator: record.operator.toLowerCase(),
      finality: FUNDING_FINALITY,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash.toLowerCase(),
      fundingBlockNumber: record.fundingBlockNumber,
      fundingBlockHash: record.fundingBlockHash.toLowerCase(),
      fundedAt: record.fundedAt,
      verifierVersion: record.verifierVersion,
      verifiedAt: record.verifiedAt,
    }).run();
  }

  findByEscrow(handle: FundingDbHandle, chainId: number, escrowAddress: string): FundingVerificationRecord | null {
    return recordOf(handle.select().from(table).where(and(
      eq(table.finality, FUNDING_FINALITY),
      eq(table.chainId, chainId),
      eq(table.escrow, escrowAddress.toLowerCase()),
    )).get());
  }

  findByScope(handle: FundingDbHandle, scopeId: string): FundingVerificationRecord | null {
    return recordOf(handle.select().from(table).where(and(
      eq(table.finality, FUNDING_FINALITY),
      eq(table.scopeId, scopeId),
    )).get());
  }
}
