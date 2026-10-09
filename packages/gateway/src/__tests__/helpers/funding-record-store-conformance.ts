/**
 * TEST ONLY: the FundingRecordStore port's contract (services/funding-record-port.ts) as a reusable
 * conformance suite (fund-s2 review LOW-1). Every store must pass it: the test store
 * (test-funding-record-store.ts) today, and the store the Q9 table will back. The checks:
 *   - one record per scope: a second insert for a scope throws, and the first record stays;
 *   - one record per escrow, in ANY letter case: a lookup in any case finds the record, and an
 *     insert of the same address for another scope throws, in the same case or another;
 *   - the escrow key is (chainId, folded address) (the steward's ruling 4): one funding address on
 *     two chains is two distinct records, and a lookup on one chain never finds the other's;
 *   - an insert takes part in the caller's transaction, a savepoint included (reconcilePaidScope
 *     runs inside the accept's transaction): that transaction's reads see it, and a rollback undoes it;
 *   - lookups return FINALIZED records only: a row in any other state (one another writer left, e.g.
 *     an unfinalized observation in Q9's append-only table) is invisible to every lookup;
 *   - uniqueness applies to finalized records only (a partial unique index): an unfinalized row
 *     never blocks a finalized insert, and is never blocked itself (the steward's ruling 3).
 *
 * Each check runs on a fresh in-memory database (initStore) with a store from the caller's factory,
 * which may create its table there. The store also gives `plant`, a store-native hook that writes a
 * row as another writer left it (unchecked, outside any transaction); the checks plant only rows that
 * are not finalized, which the port's own insert is never given. FUNDING_RECORD_STORE_CONTRACT holds
 * the checks as functions that throw, so a test can also show that a store breaking the contract
 * fails them.
 */
import { describe, expect, it } from "vitest";
import { closeStore, getStore, initStore } from "../../db.js";
import {
  __setFundingRecordStoreForTest,
  sameAddress,
  type FundingRecordStore,
  type FundingVerificationRecord,
} from "../../services/funding-record-port.js";

/** The chain every check keeps its records on, and two others. */
const CHAIN = 84532;
const CHAIN_2 = 545;
const CHAIN_3 = 11155111;
const A = "0x" + "d4".repeat(20);
const A_UPPER = "0x" + "D4".repeat(20);
const B = "0x" + "e5".repeat(20);
const B_UPPER = "0x" + "E5".repeat(20);
/** The same address as `a`, in a third letter case: each hex letter alternates case. */
const mixedCase = (a: string) =>
  "0x" + [...a.slice(2)].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join("");

const record = (scopeId: string, escrowAddress: string, chainId = CHAIN): FundingVerificationRecord => ({
  scopeId,
  escrowAddress,
  buyer: "0x5555555555555555555555555555555555555555",
  chainId,
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

/** A store under test, with the store-native hook that writes a row as another writer left it. */
export interface ConformanceStore extends FundingRecordStore {
  plant(row: object): void;
}

/** `record` as another writer may leave it: the same fields, but not finalized. */
const unfinalized = (r: FundingVerificationRecord, finality = "latest"): object => ({ ...r, finality });

export interface StoreContractCheck {
  name: string;
  run(store: ConformanceStore): void;
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
      expect(store.findByEscrow(db, CHAIN, B)).toBeNull();
    },
  },
  {
    name: "one record per escrow in any letter case: a lookup in any case finds it; another scope's insert throws, in any case",
    run(store) {
      const db = getStore().db;
      expect(store.findByEscrow(db, CHAIN, A)).toBeNull();
      // Kept in upper case, found in every case; refused for another scope in every case.
      const upper = record("scope_c2", A_UPPER);
      insert(store, upper);
      for (const lookup of [A_UPPER, A, mixedCase(A)]) expectKept(store.findByEscrow(db, CHAIN, lookup), upper);
      for (const again of [A_UPPER, A, mixedCase(A)]) expect(() => insert(store, record("scope_c3", again)), again).toThrow();
      expect(store.findByScope(db, "scope_c3")).toBeNull();
      // Kept in lower case, the same.
      const lower = record("scope_c4", B);
      insert(store, lower);
      for (const lookup of [B, B_UPPER, mixedCase(B)]) expectKept(store.findByEscrow(db, CHAIN, lookup), lower);
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
          expectKept(store.findByEscrow(tx, CHAIN, A), r);
          throw new Error("caller rolls back");
        }),
      ).toThrow("caller rolls back");
      expect(store.findByScope(db, "scope_c6")).toBeNull();
      expect(store.findByEscrow(db, CHAIN, A)).toBeNull();
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
      expectKept(store.findByEscrow(db, CHAIN, A), r);
    },
  },
  {
    name: "lookups return finalized records only: an unfinalized row is invisible to every lookup",
    run(store) {
      const db = getStore().db;
      // Rows another writer left for one scope and escrow, none finalized ("FINALIZED" is not the word).
      store.plant(unfinalized(record("scope_u1", A)));
      store.plant(unfinalized(record("scope_u1", A_UPPER), "safe"));
      store.plant(unfinalized(record("scope_u1", A), "FINALIZED"));
      expect(store.findByScope(db, "scope_u1")).toBeNull();
      for (const lookup of [A, A_UPPER, mixedCase(A)]) expect(store.findByEscrow(db, CHAIN, lookup), lookup).toBeNull();
      db.transaction((tx) => {
        expect(store.findByScope(tx, "scope_u1")).toBeNull();
        expect(store.findByEscrow(tx, CHAIN, A)).toBeNull();
      });
    },
  },
  {
    name: "uniqueness applies to finalized records only: an unfinalized row never blocks a finalized insert, nor is blocked by one",
    run(store) {
      const db = getStore().db;
      // 1. Unfinalized rows for (scope X, escrow E), the escrow in two letter cases.
      store.plant(unfinalized(record("scope_u2", B)));
      store.plant(unfinalized(record("scope_u2", B_UPPER)));
      // 2. Both lookups miss them.
      expect(store.findByScope(db, "scope_u2")).toBeNull();
      expect(store.findByEscrow(db, CHAIN, B)).toBeNull();
      // 3. A finalized insert for (X, E) succeeds, and 4. both lookups now return it.
      const kept = record("scope_u2", B);
      insert(store, kept);
      expectKept(store.findByScope(db, "scope_u2"), kept);
      expectKept(store.findByEscrow(db, CHAIN, B_UPPER), kept);
      // 5. A second finalized insert for X, or for E, still throws.
      expect(() => insert(store, record("scope_u2", A))).toThrow();
      expect(() => insert(store, record("scope_u3", B))).toThrow();
      // 6. Further unfinalized rows for X and for E are not blocked, and change no answer.
      store.plant(unfinalized(record("scope_u2", A)));
      store.plant(unfinalized(record("scope_u4", B)));
      expectKept(store.findByScope(db, "scope_u2"), kept);
      expectKept(store.findByEscrow(db, CHAIN, B), kept);
      expect(store.findByScope(db, "scope_u4")).toBeNull();
      expect(store.findByEscrow(db, CHAIN, A)).toBeNull();
    },
  },
  {
    name: "the escrow key is (chainId, folded address): one funding address on two chains is two distinct records",
    run(store) {
      const db = getStore().db;
      // The same contract address on two chains: two fundings, two scopes, both kept.
      const onFirst = record("scope_k1", A, CHAIN);
      const onSecond = record("scope_k2", A_UPPER, CHAIN_2);
      insert(store, onFirst);
      insert(store, onSecond);
      // Each chain's lookup, in any letter case, finds its own; a third chain finds none.
      for (const lookup of [A, A_UPPER, mixedCase(A)]) {
        expectKept(store.findByEscrow(db, CHAIN, lookup), onFirst);
        expectKept(store.findByEscrow(db, CHAIN_2, lookup), onSecond);
        expect(store.findByEscrow(db, CHAIN_3, lookup), lookup).toBeNull();
      }
      // On either chain the key is still unique, in any letter case.
      expect(() => insert(store, record("scope_k3", mixedCase(A), CHAIN))).toThrow();
      expect(() => insert(store, record("scope_k4", A, CHAIN_2))).toThrow();
      expect(store.findByScope(db, "scope_k3")).toBeNull();
      expect(store.findByScope(db, "scope_k4")).toBeNull();
      // A third chain takes a third record.
      const onThird = record("scope_k5", A, CHAIN_3);
      insert(store, onThird);
      expectKept(store.findByEscrow(db, CHAIN_3, A_UPPER), onThird);
    },
  },
];

const ENV = ["PCC_DB_PATH", "DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH"] as const;

/** Runs `fn` on a fresh in-memory database and a store from `makeStore`; closes it and restores the environment after. */
export function withFreshFundingRecordStore<T>(makeStore: () => ConformanceStore, fn: (store: ConformanceStore) => T): T {
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
export function describeFundingRecordStoreConformance(label: string, makeStore: () => ConformanceStore): void {
  describe(`FundingRecordStore conformance: ${label}`, () => {
    for (const check of FUNDING_RECORD_STORE_CONTRACT) {
      it(check.name, () => withFreshFundingRecordStore(makeStore, (store) => check.run(store)));
    }
  });
}
