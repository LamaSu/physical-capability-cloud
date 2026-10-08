/**
 * TEST ONLY: the FundingRecordStore port's contract (services/funding-record-port.ts) as a reusable
 * conformance suite (fund-s2 review LOW-1). Every store must pass it: the test store
 * (test-funding-record-store.ts) today, and the store the Q9 table will back. The checks:
 *   - one record per scope: a second insert for a scope throws, and the first record stays;
 *   - one record per escrow, in ANY letter case: a lookup in any case finds the record, and an
 *     insert of the same address for another scope throws, in the same case or another;
 *   - an insert takes part in the caller's transaction, a savepoint included (reconcilePaidScope
 *     runs inside the accept's transaction): that transaction's reads see it, and a rollback undoes it.
 * Not in it yet: that lookups return finalized records only (review LOW-4), which waits for the
 * ruling on Q9's append-only table.
 *
 * Each check runs on a fresh in-memory database (initStore) with a store from the caller's factory,
 * which may create its table there. FUNDING_RECORD_STORE_CONTRACT holds the checks as functions that
 * throw, so a test can also show that a store breaking the contract fails them.
 */
import { describe, expect, it } from "vitest";
import { closeStore, getStore, initStore } from "../../db.js";
import {
  __setFundingRecordStoreForTest,
  sameAddress,
  type FundingRecordStore,
  type FundingVerificationRecord,
} from "../../services/funding-record-port.js";

const A = "0x" + "d4".repeat(20);
const A_UPPER = "0x" + "D4".repeat(20);
const B = "0x" + "e5".repeat(20);
const B_UPPER = "0x" + "E5".repeat(20);
/** The same address as `a`, in a third letter case: each hex letter alternates case. */
const mixedCase = (a: string) =>
  "0x" + [...a.slice(2)].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join("");

const record = (scopeId: string, escrowAddress: string): FundingVerificationRecord => ({
  scopeId,
  escrowAddress,
  buyer: "0x5555555555555555555555555555555555555555",
  chainId: 84532,
  blockNumber: "31337000",
  blockHash: "0x" + "c3".repeat(32),
  verifierVersion: "verifier-conformance/1",
  verifiedAt: "2026-10-08T12:00:00.000Z",
  finality: "finalized",
});

/** `found` is `expected` as kept: every field equal, the escrow address in any letter case. */
function expectKept(found: FundingVerificationRecord | null, expected: FundingVerificationRecord): void {
  expect(found).not.toBeNull();
  const { escrowAddress: foundAddress, ...foundRest } = found as FundingVerificationRecord;
  const { escrowAddress: expectedAddress, ...expectedRest } = expected;
  expect(foundRest).toEqual(expectedRest);
  expect(sameAddress(foundAddress, expectedAddress)).toBe(true);
}

/** Inserts `r` in a transaction of its own, which commits. */
const insert = (store: FundingRecordStore, r: FundingVerificationRecord) =>
  getStore().db.transaction((tx) => store.insert(tx, r));

export interface StoreContractCheck {
  name: string;
  run(store: FundingRecordStore): void;
}

export const FUNDING_RECORD_STORE_CONTRACT: readonly StoreContractCheck[] = [
  {
    name: "one record per scope: a second insert for the scope throws, and the first record stays",
    run(store) {
      const db = getStore().db;
      expect(store.findByScope(db, "scope_c1")).toBeNull();
      const first = record("scope_c1", A);
      insert(store, first);
      expectKept(store.findByScope(db, "scope_c1"), first);
      expect(() => insert(store, record("scope_c1", B))).toThrow();
      expectKept(store.findByScope(db, "scope_c1"), first);
      expect(store.findByEscrow(db, B)).toBeNull();
    },
  },
  {
    name: "one record per escrow in any letter case: a lookup in any case finds it; another scope's insert throws, in any case",
    run(store) {
      const db = getStore().db;
      expect(store.findByEscrow(db, A)).toBeNull();
      // Kept in upper case, found in every case; refused for another scope in every case.
      const upper = record("scope_c2", A_UPPER);
      insert(store, upper);
      for (const lookup of [A_UPPER, A, mixedCase(A)]) expectKept(store.findByEscrow(db, lookup), upper);
      for (const again of [A_UPPER, A, mixedCase(A)]) expect(() => insert(store, record("scope_c3", again)), again).toThrow();
      expect(store.findByScope(db, "scope_c3")).toBeNull();
      // Kept in lower case, the same.
      const lower = record("scope_c4", B);
      insert(store, lower);
      for (const lookup of [B, B_UPPER, mixedCase(B)]) expectKept(store.findByEscrow(db, lookup), lower);
      for (const again of [B, B_UPPER, mixedCase(B)]) expect(() => insert(store, record("scope_c5", again)), again).toThrow();
      expect(store.findByScope(db, "scope_c5")).toBeNull();
    },
  },
  {
    name: "an insert takes part in the caller's transaction (a savepoint too): its reads see it, and a rollback undoes it",
    run(store) {
      const db = getStore().db;
      const r = record("scope_c6", A);
      expect(() =>
        db.transaction((tx) => {
          store.insert(tx, r);
          expectKept(store.findByScope(tx, "scope_c6"), r);
          expectKept(store.findByEscrow(tx, A), r);
          throw new Error("caller rolls back");
        }),
      ).toThrow("caller rolls back");
      expect(store.findByScope(db, "scope_c6")).toBeNull();
      expect(store.findByEscrow(db, A)).toBeNull();
      // Nested, as reconcilePaidScope runs inside the accept's transaction: only the savepoint rolls back.
      db.transaction((outer) => {
        expect(() =>
          db.transaction((inner) => {
            store.insert(inner, r);
            throw new Error("savepoint rolls back");
          }),
        ).toThrow("savepoint rolls back");
        expect(store.findByScope(outer, "scope_c6")).toBeNull();
      });
      expect(store.findByScope(db, "scope_c6")).toBeNull();
      // A transaction that commits keeps it.
      insert(store, r);
      expectKept(store.findByScope(db, "scope_c6"), r);
      expectKept(store.findByEscrow(db, A), r);
    },
  },
];

const ENV = ["PCC_DB_PATH", "DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH"] as const;

/** Runs `fn` on a fresh in-memory database and a store from `makeStore`; closes it and restores the environment after. */
export function withFreshFundingRecordStore<T>(makeStore: () => FundingRecordStore, fn: (store: FundingRecordStore) => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  try {
    return fn(makeStore());
  } finally {
    __setFundingRecordStoreForTest(null);
    closeStore();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Registers one test per contract check for the stores `makeStore` makes. */
export function describeFundingRecordStoreConformance(label: string, makeStore: () => FundingRecordStore): void {
  describe(`FundingRecordStore conformance: ${label}`, () => {
    for (const check of FUNDING_RECORD_STORE_CONTRACT) {
      it(check.name, () => withFreshFundingRecordStore(makeStore, (store) => check.run(store)));
    }
  });
}
