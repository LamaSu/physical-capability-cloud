import { describe, expect, it } from "vitest";
import { sql } from "@pcc/store";
import { getStore } from "../db.js";
import { SqliteFundingRecordStore } from "../services/sqlite-funding-record-store.js";
import type { FundingVerificationRecord } from "../services/funding-record-port.js";
import {
  describeFundingRecordStoreConformance,
  withFreshFundingRecordStore,
  type ConformanceStore,
} from "./helpers/funding-record-store-conformance.js";

const record = (over: Partial<FundingVerificationRecord> = {}): FundingVerificationRecord => ({
  scopeId: "scope_sqlite",
  chainId: 84532,
  escrowAddress: "0x" + "a1".repeat(20),
  buyer: "0x" + "b2".repeat(20),
  operator: "0x" + "c3".repeat(20),
  blockNumber: "18446744073709551615",
  blockHash: "0x" + "d4".repeat(32),
  fundingBlockNumber: "18446744073709551614",
  fundingBlockHash: "0x" + "e5".repeat(32),
  fundedAt: 1791460800,
  verifierVersion: "verifier-sqlite/1",
  verifiedAt: "2026-10-08T12:00:00.123Z",
  finality: "finalized",
  ...over,
});

/** A raw SQL writer stands in for S1.2's future unfinalized observations. */
class ConformanceSqliteStore extends SqliteFundingRecordStore implements ConformanceStore {
  plant(row: object): void {
    const r = row as FundingVerificationRecord;
    getStore().db.run(sql`INSERT INTO escrow_funding (
      scope_id, chain_id, escrow, buyer, operator, finality, block_number, block_hash,
      funding_block_number, funding_block_hash, funded_at, verifier_version, verified_at
    ) VALUES (
      ${r.scopeId}, ${r.chainId}, ${r.escrowAddress.toLowerCase()}, ${r.buyer.toLowerCase()},
      ${r.operator.toLowerCase()}, ${r.finality}, ${r.blockNumber}, ${r.blockHash.toLowerCase()},
      ${r.fundingBlockNumber}, ${r.fundingBlockHash.toLowerCase()}, ${r.fundedAt}, ${r.verifierVersion}, ${r.verifiedAt}
    )`);
  }
}

const makeStore = () => new ConformanceSqliteStore();
describeFundingRecordStoreConformance("the Q9 SQLite store", makeStore);

describe("Q9 SQLite funding record storage", () => {
  it("normalizes every address and hash, preserves lossless blocks and verifiedAt, and writes finalized", () => {
    withFreshFundingRecordStore(makeStore, (store) => {
      const r = record({
        escrowAddress: "0x" + "A1".repeat(20),
        buyer: "0x" + "B2".repeat(20),
        operator: "0x" + "C3".repeat(20),
        blockHash: "0x" + "D4".repeat(32),
        fundingBlockHash: "0x" + "E5".repeat(32),
      });
      const db = getStore().db;
      db.transaction((tx) => store.insert(tx, r));
      const expected = record();
      expect(store.findByScope(db, r.scopeId)).toEqual(expected);
      expect(store.findByEscrow(db, r.chainId, r.escrowAddress)).toEqual(expected);
      expect(db.get<{ finality: string; block_type: string; funding_block_type: string }>(sql`
        SELECT finality, typeof(block_number) AS block_type, typeof(funding_block_number) AS funding_block_type
        FROM escrow_funding
      `)).toEqual({ finality: "finalized", block_type: "text", funding_block_type: "text" });
    });
  });

  it("a raw latest row is invisible, never blocks a finalized record and is never blocked by it", () => {
    withFreshFundingRecordStore(makeStore, (store) => {
      const r = record();
      const db = getStore().db;
      store.plant({ ...r, finality: "latest" });
      expect(store.findByScope(db, r.scopeId)).toBeNull();
      expect(store.findByEscrow(db, r.chainId, r.escrowAddress)).toBeNull();
      db.transaction((tx) => store.insert(tx, r));
      store.plant({ ...r, finality: "latest" });
      expect(store.findByScope(db, r.scopeId)).toEqual(r);
      expect(store.findByEscrow(db, r.chainId, r.escrowAddress)).toEqual(r);
      expect(db.get<{ n: number }>(sql`SELECT count(*) AS n FROM escrow_funding`).n).toBe(3);
    });
  });

  for (const mutation of ["UPDATE escrow_funding SET verifier_version = 'changed'", "DELETE FROM escrow_funding"]) {
    it(`refuses raw ${mutation.split(" ")[0]}, including in a transaction that then rolls back`, () => {
      withFreshFundingRecordStore(makeStore, (store) => {
        const db = getStore().db;
        const r = record();
        db.transaction((tx) => store.insert(tx, r));
        expect(() => db.run(sql.raw(mutation))).toThrow();
        expect(() => db.transaction((tx) => {
          store.insert(tx, record({ scopeId: "scope_rolled_back", escrowAddress: "0x" + "f6".repeat(20) }));
          tx.run(sql.raw(mutation));
        })).toThrow();
        expect(store.findByScope(db, "scope_rolled_back")).toBeNull();
        expect(store.findByScope(db, r.scopeId)).toEqual(r);
        expect(db.get<{ n: number }>(sql`SELECT count(*) AS n FROM escrow_funding`).n).toBe(1);
      });
    });
  }
});
