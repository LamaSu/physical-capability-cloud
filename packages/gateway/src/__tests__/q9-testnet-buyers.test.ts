import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { reconcilePaidScope, RECONCILE_REFUSALS } from "../services/reconcile-paid-scope.js";
import { paidScopeActivationTerms } from "../services/paid-scope-activation-terms.js";
import { fundingBindingRefusal, testnetBuyerAllowance, testnetBuyerRefusal } from "../services/funding-binding.js";
import { FUNDING_BINDINGS, projectFundingStatus } from "../readmodels/funding-status.js";
import { escrowForJob } from "../services/scope-acceptance.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  BUYER, OTHER, ESCROW_A, TERMS, db, paidScope, scopeRow, setUpFixture, tearDownFixture, verification,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

const testnetTerms = { ...TERMS, testnetOnly: true };
const refused = { kind: "refused", reason: "testnet_buyer_not_allowed" };
const checksummedEntry = getAddress(ESCROW_A);
const checksumPosition = [...checksummedEntry].findIndex((c, i) => i > 1 && /[A-Fa-f]/.test(c));
const badChecksumEntry = checksummedEntry.slice(0, checksumPosition)
  + (checksummedEntry[checksumPosition] === checksummedEntry[checksumPosition].toUpperCase()
    ? checksummedEntry[checksumPosition].toLowerCase() : checksummedEntry[checksumPosition].toUpperCase())
  + checksummedEntry.slice(checksumPosition + 1);
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

  it.each([
    ["unset list", undefined, BUYER, "testnet_buyer_not_allowed"],
    ["explicitly listed", BUYER, BUYER, "bound"],
    ["unlisted", OTHER, BUYER, "testnet_buyer_not_allowed"],
    ["malformed after a valid buyer", `${BUYER},bad`, BUYER, "testnet_buyer_not_allowed"],
    ["empty", "", BUYER, "testnet_buyer_not_allowed"],
    ["all-uppercase", `0x${"AB".repeat(20)}`, BUYER, "testnet_buyer_not_allowed"],
    ["checksummed", checksummedEntry, ESCROW_A, "bound"],
    ["bad mixed-case checksum", `${BUYER},${badChecksumEntry}`, BUYER, "testnet_buyer_not_allowed"],
  ] as const)("DTO and reconcile agree with the shared allowance for %s", async (_case, list, buyer, expected) => {
    const { scopeId } = await paidScope(f, { buyer });
    setBuyers(list);
    const scope = scopeRow(scopeId);
    const escrow = escrowForJob(scope.jobId)!;
    const record = verification(scopeId, { buyer });
    const allowance = testnetBuyerAllowance(testnetTerms);
    const binding = fundingBindingRefusal(record, scope, escrow, testnetTerms.expectedChainId, allowance) ?? "bound";
    const dto = projectFundingStatus(scope, record, escrow, testnetTerms.expectedChainId, new Date().toISOString(), allowance);
    const reconciled = reconcilePaidScope(scopeId, record, testnetTerms);
    const reason = reconciled.kind === "activated" ? "bound" : reconciled.kind === "refused" ? reconciled.reason : reconciled.kind;
    expect(binding).toBe(expected);
    expect(dto.binding).toBe(expected);
    expect(reason).toBe(expected);
    expect(dto.state).toBe(expected === "bound" ? "funded_verified" : "unknown");
    expect(dto.verification === null).toBe(expected !== "bound");
  });

  it("an omitted testnetOnly field and even a missing runtime allowance fail closed", async () => {
    const { scopeId } = await paidScope(f);
    const scope = scopeRow(scopeId);
    const escrow = escrowForJob(scope.jobId)!;
    const record = verification(scopeId);
    const missing = { ...testnetTerms } as Record<string, unknown>;
    delete missing.testnetOnly;
    setBuyers(undefined);
    const allowance = testnetBuyerAllowance(missing as never);
    expect(allowance.testnetOnly).toBe(true);
    expect(testnetBuyerRefusal(record, allowance)).toBe("testnet_buyer_not_allowed");
    expect(testnetBuyerRefusal(record, undefined as never)).toBe("testnet_buyer_not_allowed");
    expect(projectFundingStatus(scope, record, escrow, TERMS.expectedChainId, new Date().toISOString(), allowance))
      .toMatchObject({ binding: "testnet_buyer_not_allowed", state: "unknown", verification: null });
    expect(reconcilePaidScope(scopeId, record, missing as never)).toEqual(refused);
    expect(store.count()).toBe(0);
  });

  it("the shared binding and DTO return the same refusal and hide verification", async () => {
    const { scopeId } = await paidScope(f);
    const scope = scopeRow(scopeId);
    const escrow = escrowForJob(scope.jobId)!;
    const record = verification(scopeId);
    setBuyers(`${BUYER},bad`);
    const allowance = testnetBuyerAllowance(testnetTerms);
    const before = JSON.stringify([scope, escrow, record]);
    expect(fundingBindingRefusal(record, scope, escrow, TERMS.expectedChainId, allowance)).toBe("testnet_buyer_not_allowed");
    const dto = projectFundingStatus(scope, record, escrow, TERMS.expectedChainId, new Date().toISOString(), allowance);
    expect(dto).toMatchObject({ binding: "testnet_buyer_not_allowed", state: "unknown", verification: null });
    expect(JSON.stringify([scope, escrow, record])).toBe(before);
    expect(reconcilePaidScope(scopeId, record, testnetTerms)).toEqual(refused);
    expect(testnetBuyerRefusal(record, { ...allowance, buyers: BUYER })).toBeNull();
  });
});
