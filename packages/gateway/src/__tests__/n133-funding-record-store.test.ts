/**
 * Buyer funding Stage 2: the FundingRecordStore port's contract, as the conformance suite in
 * helpers/funding-record-store-conformance.ts states it (fund-s2 review LOW-1; the steward's ruling 3).
 * The test store passes it; each deliberately broken store fails exactly the checks of the property
 * it breaks, so the suite is not vacuous.
 */
import { describe, it, expect } from "vitest";
import {
  describeFundingRecordStoreConformance,
  FUNDING_RECORD_STORE_CONTRACT,
  withFreshFundingRecordStore,
  type ConformanceStore,
} from "./helpers/funding-record-store-conformance.js";
import {
  installCaseExactFundingRecordStore,
  installFinalityBlindFundingRecordStore,
  installTestFundingRecordStore,
} from "./helpers/test-funding-record-store.js";

describeFundingRecordStoreConformance("the test store (helpers/test-funding-record-store.ts)", installTestFundingRecordStore);

/** Which contract checks a store passes, in the suite's order. */
const outcomes = (makeStore: () => ConformanceStore) =>
  FUNDING_RECORD_STORE_CONTRACT.map((check) => {
    try {
      withFreshFundingRecordStore(makeStore, (store) => check.run(store));
      return "passed";
    } catch {
      return "failed";
    }
  });

describe("the conformance suite is not vacuous", () => {
  it("(neg-conformance-case) a store that matches escrow letter case exactly, with no unique escrow key, fails the two checks that need one record per escrow, and only them", () => {
    // The per-escrow check (any letter case), and the finalized-uniqueness check's "a second finalized
    // record for the escrow throws".
    expect(outcomes(installCaseExactFundingRecordStore)).toEqual(["passed", "failed", "passed", "passed", "failed"]);
  });

  it("(neg-conformance-finality) a store that ignores finality fails the two finalized-only checks, and only them (ruling 3)", () => {
    expect(outcomes(installFinalityBlindFundingRecordStore)).toEqual(["passed", "passed", "passed", "failed", "failed"]);
  });
});
