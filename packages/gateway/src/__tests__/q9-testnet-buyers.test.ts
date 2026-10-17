import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { reconcilePaidScope, RECONCILE_REFUSALS } from "../services/reconcile-paid-scope.js";
import { paidScopeActivationTerms } from "../services/paid-scope-activation-terms.js";
import { fundingBindingRefusal, testnetBuyerRefusal } from "../services/funding-binding.js";
import { FUNDING_BINDINGS, projectFundingStatus } from "../readmodels/funding-status.js";
import { escrowForJob } from "../services/scope-acceptance.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  BUYER, OTHER, ESCROW_A, TERMS, db, paidScope, scopeRow, setUpFixture, tearDownFixture, verification,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

const testnetTerms = { ...TERMS, testnetOnly: true };
const refused = { kind: "refused", reason: "testnet_buyer_not_allowed" };
let f: Fixture;
let store: TestFundingRecordStore;

beforeEach(async () => {
  f = await setUpFixture();
  store = installTestFundingRecordStore();
  for (const name of ["PCC_VNEXT_ALLOW_TESTNET_RECORD", "PCC_VNEXT_TESTNET_BUYERS", "PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_RECORD_LABEL"]) {
    vi.stubEnv(name, undefined);
    delete process.env[name];
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tearDownFixture(f);
});

function setBuyers(value: string | undefined): void {
  if (value === undefined) delete process.env.PCC_VNEXT_TESTNET_BUYERS;
  else process.env.PCC_VNEXT_TESTNET_BUYERS = value;
}

function configuredTerms(scopeId: string) {
  process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
  return { ...paidScopeActivationTerms(scopeRow(scopeId)), postActivationTtlMs: TERMS.postActivationTtlMs };
}

describe("Q9 testnet live-window buyer allowance", () => {
  it("the exact flag without a list refuses before BEGIN IMMEDIATE and writes nothing", async () => {
    const { scopeId } = await paidScope(f);
    process.env.PCC_VNEXT_ALLOW_TESTNET_RECORD = "1";
    const terms = configuredTerms(scopeId);
    expect(terms).toMatchObject({ expectedChainId: 84532, testnetOnly: true });
    const begin = vi.spyOn(db(), "transaction");
    expect(reconcilePaidScope(scopeId, verification(scopeId), terms)).toEqual(refused);
    expect(begin).not.toHaveBeenCalled();
    expect(store.count()).toBe(0);
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
  });

  it("a list without the flag cannot resolve the record, so activation refuses", async () => {
    const { scopeId } = await paidScope(f);
    setBuyers(BUYER);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const terms = configuredTerms(scopeId);
    expect(terms.expectedChainId).toBeNull();
    expect(warn.mock.calls).toEqual([["vnext_record_refused R-c"]]);
    expect(reconcilePaidScope(scopeId, verification(scopeId), terms)).toEqual({ kind: "refused", reason: "expected_chain_unavailable" });
    expect(store.count()).toBe(0);
  });

  it("both settings allow a listed buyer", async () => {
    const { scopeId } = await paidScope(f);
    process.env.PCC_VNEXT_ALLOW_TESTNET_RECORD = "1";
    setBuyers(`${OTHER},${BUYER}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), configuredTerms(scopeId)).kind).toBe("activated");
    expect(store.count()).toBe(1);
  });

  it.each([
    ["unlisted buyer", OTHER],
    ["malformed list even after a match", `${BUYER},not-an-address`],
    ["empty list", ""],
    ["empty entry after a match", `${BUYER},`],
    ["empty entry before a match", `,${BUYER}`],
    ["space within an entry", `${BUYER}, ${OTHER}`],
    ["trailing newline", `${BUYER}\n`],
    ["tab", `${BUYER},\t${OTHER}`],
  ])("%s refuses every buyer and writes nothing", async (_name, list) => {
    const { scopeId } = await paidScope(f);
    process.env.PCC_VNEXT_ALLOW_TESTNET_RECORD = "1";
    setBuyers(list);
    expect(reconcilePaidScope(scopeId, verification(scopeId), configuredTerms(scopeId))).toEqual(refused);
    expect(store.count()).toBe(0);
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
  });

  it("normalizes a checksummed entry to match a lowercase buyer", async () => {
    const buyer = ESCROW_A;
    const checksummed = getAddress(buyer);
    expect(checksummed).not.toBe(buyer);
    const { scopeId } = await paidScope(f, { buyer });
    setBuyers(checksummed);
    expect(reconcilePaidScope(scopeId, verification(scopeId, { buyer }), testnetTerms).kind).toBe("activated");
  });

  it("a bad-checksum mixed-case entry makes even a listed buyer refuse", async () => {
    const { scopeId } = await paidScope(f);
    const valid = getAddress(ESCROW_A);
    const index = [...valid].findIndex((c, i) => i > 1 && /[A-Fa-f]/.test(c));
    const bad = valid.slice(0, index) + (valid[index] === valid[index].toUpperCase() ? valid[index].toLowerCase() : valid[index].toUpperCase()) + valid.slice(index + 1);
    setBuyers(`${BUYER},${bad}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), testnetTerms)).toEqual(refused);
    expect(store.count()).toBe(0);
  });

  it.each([undefined, "", `${BUYER},bad`, OTHER])("non-testnet terms ignore list %s", async (list) => {
    const { scopeId } = await paidScope(f);
    setBuyers(list);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
  });

  it("record checks precede the allowance, which precedes the scope lookup", () => {
    expect(reconcilePaidScope("absent", verification("absent", { operator: "bad" }), testnetTerms)).toEqual({ kind: "refused", reason: "record_malformed" });
    expect(reconcilePaidScope("absent", verification("absent", { chainId: 1 }), testnetTerms)).toEqual({ kind: "refused", reason: "record_chain_mismatch" });
    expect(reconcilePaidScope("absent", verification("other"), testnetTerms)).toEqual({ kind: "refused", reason: "record_scope_mismatch" });
    const begin = vi.spyOn(db(), "transaction");
    expect(reconcilePaidScope("absent", verification("absent"), testnetTerms)).toEqual(refused);
    expect(begin).not.toHaveBeenCalled();
    for (const codes of [RECONCILE_REFUSALS, FUNDING_BINDINGS]) {
      const index = codes.indexOf("testnet_buyer_not_allowed");
      expect(codes[index - 1]).toBe("record_scope_mismatch");
      expect(codes[index + 1]).toMatch(/scope_not_found|record_buyer_not_scope_buyer/);
    }
  });

  it("the shared binding and DTO return the same refusal and hide verification", async () => {
    const { scopeId } = await paidScope(f);
    const scope = scopeRow(scopeId);
    const escrow = escrowForJob(scope.jobId)!;
    const record = verification(scopeId);
    const allowance = { testnetOnly: true, buyers: `${BUYER},bad` };
    const before = JSON.stringify([scope, escrow, record]);
    expect(fundingBindingRefusal(record, scope, escrow, TERMS.expectedChainId, allowance)).toBe("testnet_buyer_not_allowed");
    const dto = projectFundingStatus(scope, record, escrow, TERMS.expectedChainId, new Date().toISOString(), allowance);
    expect(dto).toMatchObject({ binding: "testnet_buyer_not_allowed", state: "unknown", verification: null });
    expect(JSON.stringify([scope, escrow, record])).toBe(before);
    setBuyers(allowance.buyers);
    expect(reconcilePaidScope(scopeId, record, testnetTerms)).toEqual(refused);
    expect(testnetBuyerRefusal(record, { ...allowance, buyers: BUYER })).toBeNull();
  });
});
