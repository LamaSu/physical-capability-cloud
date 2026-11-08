import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { initStore, closeStore, getStore } from "../db.js";
import { fundingRecordStore, __setFundingRecordStoreForTest } from "../services/funding-record-port.js";
import { SqliteFundingRecordStore } from "../services/sqlite-funding-record-store.js";
import { verification } from "./helpers/paid-scope-fixture.js";

beforeEach(() => { vi.stubEnv("PCC_DB_PATH", ":memory:"); initStore({ seed: false }); __setFundingRecordStoreForTest(null); });
afterEach(() => { vi.stubEnv("NODE_ENV", "test"); __setFundingRecordStoreForTest(null); closeStore(); vi.unstubAllEnvs(); });
describe("production funding store", () => {
  it("W1: no installed test store is null", () => expect(fundingRecordStore()).toBeNull());
  it("W2: installed store is normalised", () => {
    const store = { insert: vi.fn(), findByScope: vi.fn(), findByEscrow: vi.fn() };
    __setFundingRecordStoreForTest(store);
    const r = verification("w2", { escrowAddress: "0x" + "Ab".repeat(20) });
    getStore().db.transaction(tx => fundingRecordStore()!.insert(tx, r));
    fundingRecordStore()!.findByEscrow(getStore().db, r.chainId, r.escrowAddress);
    expect(store.insert.mock.calls[0][1].escrowAddress).toBe(r.escrowAddress.toLowerCase());
    expect(store.findByEscrow.mock.calls[0][2]).toBe(r.escrowAddress.toLowerCase());
  });
  it("W3: production singleton reads the transaction's SQLite insert", () => {
    __setFundingRecordStoreForTest(new SqliteFundingRecordStore());
    vi.stubEnv("NODE_ENV", "production");
    const store = fundingRecordStore();
    expect(store).not.toBeNull();
    expect(fundingRecordStore()).toBe(store);
    const r = verification("w3", { escrowAddress: "0x" + "Ab".repeat(20) });
    getStore().db.transaction(tx => {
      store!.insert(tx, r);
      expect(store!.findByScope(tx, r.scopeId)?.escrowAddress).toBe(r.escrowAddress.toLowerCase());
      expect(store!.findByEscrow(tx, r.chainId, r.escrowAddress)?.scopeId).toBe(r.scopeId);
    });
    expect(store!.findByScope(getStore().db, r.scopeId)).not.toBeNull();
  });
  it("W4: test setter refuses production", () => { vi.stubEnv("NODE_ENV", "production"); expect(() => __setFundingRecordStoreForTest(null)).toThrow("test processes only"); });
});
