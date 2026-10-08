/**
 * Buyer funding Stage 2: the FundingRecordStore port's contract, as the conformance suite in
 * helpers/funding-record-store-conformance.ts states it (fund-s2 review LOW-1). The test store passes
 * it; a store that matches escrow letter case exactly fails it, so the suite is not vacuous.
 */
import { describe, it, expect } from "vitest";
import {
  describeFundingRecordStoreConformance,
  FUNDING_RECORD_STORE_CONTRACT,
  withFreshFundingRecordStore,
} from "./helpers/funding-record-store-conformance.js";
import { installCaseExactFundingRecordStore, installTestFundingRecordStore } from "./helpers/test-funding-record-store.js";

describeFundingRecordStoreConformance("the test store (helpers/test-funding-record-store.ts)", installTestFundingRecordStore);

describe("the conformance suite is not vacuous", () => {
  it("(neg-conformance-case) a store that matches escrow letter case exactly fails the per-escrow check, and only it", () => {
    const outcome = FUNDING_RECORD_STORE_CONTRACT.map((check) => {
      try {
        withFreshFundingRecordStore(installCaseExactFundingRecordStore, (store) => check.run(store));
        return "passed";
      } catch {
        return "failed";
      }
    });
    expect(outcome).toEqual(["passed", "failed", "passed"]);
  });
});
