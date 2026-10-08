/**
 * Buyer funding plan, Stage 2 (research/buyer-funding-plan-20261008.md):
 *   - S2.1: buyerFundingVerdict passes a REAL escrow only on the finalized verification record of
 *     (escrow, buyer) that names the scope. No record store (production until Q9) refuses it, as
 *     before; the mock rule is unchanged.
 *   - The accept route calls reconcilePaidScope when that record exists, in the accept's own
 *     transaction. With no store nothing observable changes.
 * Negatives are tagged (neg-...) for the mutation runner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buyerFundingRefusal,
  buyerFundingVerdict,
  scopeFundingRefusal,
} from "../services/scope-acceptance.js";
import { __setFundingRecordStoreForTest, fundingRecordStore, type FundingRecordStore } from "../services/funding-record-port.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  BUYER,
  ESCROW_A,
  ESCROW_B,
  KERNEL,
  MIN,
  OTHER,
  T0,
  TTL,
  acceptScope,
  basePolicy,
  db,
  iso,
  paidScope,
  scopeRow,
  setEscrow,
  setPolicy,
  setUpFixture,
  submit,
  tearDownFixture,
  verification,
  writeAs,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

let f: Fixture;

beforeEach(async () => {
  f = await setUpFixture();
});
afterEach(async () => {
  await tearDownFixture(f);
});

const escrow = (over: Partial<{ payer: string; status: string; contractAddress: string }> = {}) => ({
  payer: BUYER,
  status: "funded",
  contractAddress: ESCROW_A,
  ...over,
});
const SCOPE = "scope_s21";

describe("S2.1 buyerFundingVerdict: a real escrow passes only on its finalized record of this buyer, naming this scope", () => {
  it("(neg-gate-nostore) no store (production wiring): every real escrow is refused escrow_not_buyer_funded, as before", () => {
    expect(fundingRecordStore()).toBeNull();
    expect(buyerFundingVerdict(escrow(), BUYER, SCOPE)).toEqual({ kind: "refused", reason: "escrow_not_buyer_funded" });
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("(neg-gate-norecord) a store with no record of the escrow: escrow_not_buyer_funded", () => {
    const store = installTestFundingRecordStore();
    store.plant(verification(SCOPE, { escrowAddress: ESCROW_B })); // another escrow's record
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("the escrow's finalized record, this buyer's, naming this scope: record_funded", () => {
    const store = installTestFundingRecordStore();
    const record = verification(SCOPE);
    store.plant(record);
    expect(buyerFundingVerdict(escrow(), BUYER, SCOPE)).toEqual({ kind: "record_funded", record });
    expect(buyerFundingRefusal(escrow({ contractAddress: ESCROW_A.toUpperCase().replace("0X", "0x") }), BUYER, SCOPE)).toBeNull();
  });

  it("(neg-gate-scope) a record naming another scope does not fund this one; without a scope id (the mint) none does", () => {
    const store = installTestFundingRecordStore();
    store.plant(verification("scope_elsewhere"));
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("funding_record_scope_mismatch");
    expect(buyerFundingRefusal(escrow(), BUYER)).toBe("funding_record_scope_mismatch");
  });

  it("(neg-gate-buyer) a record whose verified payer is another buyer is not this buyer's funding", () => {
    const store = installTestFundingRecordStore();
    store.plant(verification(SCOPE, { buyer: OTHER }));
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("(neg-gate-malformed) a kept row that is not finalized or not well formed is not funding", () => {
    const store = installTestFundingRecordStore();
    store.plant({ ...verification(SCOPE), finality: "latest" });
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("(neg-gate-wrongescrow) a store answering with another escrow's record is not believed", () => {
    const real = installTestFundingRecordStore();
    const lying: FundingRecordStore = {
      insert: real.insert,
      findByScope: real.findByScope,
      findByEscrow: () => verification(SCOPE, { escrowAddress: ESCROW_B }),
    };
    __setFundingRecordStoreForTest(lying);
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("the mock rule is unchanged, record store or not", () => {
    const mock = (over: Partial<{ payer: string; status: string; contractAddress: string }> = {}) =>
      escrow({ contractAddress: "mock-escrow-x", ...over });
    for (const install of [false, true]) {
      if (install) installTestFundingRecordStore().plant(verification(SCOPE));
      expect(buyerFundingVerdict(mock(), BUYER, SCOPE)).toEqual({ kind: "mock_funded" });
      expect(buyerFundingRefusal(undefined, BUYER)).toBe("escrow_missing");
      expect(buyerFundingRefusal(mock({ payer: OTHER }), BUYER)).toBe("escrow_payer_not_buyer");
      expect(buyerFundingRefusal(mock({ status: "created" }), BUYER)).toBe("escrow_not_funded");
      // The row's preconditions hold for a real escrow too, record or not.
      expect(buyerFundingRefusal(escrow({ status: "created" }), BUYER, SCOPE)).toBe("escrow_not_funded");
      expect(buyerFundingRefusal(escrow({ payer: OTHER }), BUYER, SCOPE)).toBe("escrow_payer_not_buyer");
      process.env.MOCK_SETTLEMENT = "false";
      expect(buyerFundingRefusal(mock(), BUYER)).toBe("mock_escrow");
      process.env.MOCK_SETTLEMENT = "true";
    }
  });

  it("a gateway-funded real escrow is still escrow_not_buyer_funded (N133's regression), with a store and no record", async () => {
    installTestFundingRecordStore();
    const { scopeId } = await paidScope(f, { real: "0x" + "b".repeat(40), accept: false });
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "escrow_not_buyer_funded" });
    expect(scopeFundingRefusal(scopeRow(scopeId))).toBe("escrow_not_buyer_funded");
  });
});

describe("the accept route and reconcilePaidScope", () => {
  /** Mints the buyer's job, changes its escrow row, and accepts: the answer and the scope after. */
  async function acceptWith(over: Partial<{ payer: string; status: string; contractAddress: string }> | null) {
    const res = await submit(f);
    const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
    if (over) setEscrow(escrowId, over);
    const accepted = await acceptScope(f, scopeId);
    return { scopeId, jobId, accepted };
  }

  it("(neg-accept-nostore) with no store (production wiring) every accept answers exactly what it answered before", async () => {
    const cases = [
      [{ contractAddress: "0x" + "b".repeat(40), status: "funded" }, "awaiting_funding", "escrow_not_buyer_funded"], // gateway-funded
      [{ contractAddress: ESCROW_A, status: "created" }, "awaiting_funding", "escrow_not_funded"],
      [{ contractAddress: ESCROW_A, payer: OTHER }, "awaiting_funding", "escrow_payer_not_buyer"],
      [null, "active", null], // the test's mock escrow
    ] as const;
    for (const [over, status, fundingRefusal] of cases) {
      const { scopeId, jobId, accepted } = await acceptWith(over);
      expect(accepted.statusCode).toBe(200);
      // Exactly the old body: no new key, and the mint's TTL untouched.
      expect(accepted.json()).toEqual({ accepted: true, scopeId, kernelId: KERNEL, jobId, status, fundingRefusal });
      expect(scopeRow(scopeId)).toMatchObject({ status, expiresAt: iso(T0 + TTL) });
    }
  });

  it("(neg-accept-prod) in a production process a store left installed is never consulted, even with a matching record", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    store.plant(verification(scopeId));
    process.env.NODE_ENV = "production";
    const accepted = await acceptScope(f, scopeId);
    process.env.NODE_ENV = "test";
    expect(accepted.json()).toEqual({
      accepted: true,
      scopeId,
      kernelId: KERNEL,
      jobId,
      status: "awaiting_funding",
      fundingRefusal: "escrow_not_buyer_funded",
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
  });

  it("(neg-accept-record) a finalized record the verifier stored before the accept: the accept activates through reconcile, TTL from then", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    vi.setSystemTime(T0 + 3 * MIN);
    const record = verification(scopeId);
    db().transaction((tx) => store.insert(tx, record)); // the verifier's own write
    vi.setSystemTime(T0 + 10 * MIN); // the operator accepts later
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      accepted: true,
      scopeId,
      kernelId: KERNEL,
      jobId,
      status: "active",
      fundingRefusal: null,
      activation: {
        kind: "activated",
        scopeId,
        escrowAddress: ESCROW_A,
        activatedAt: iso(T0 + 10 * MIN),
        expiresAt: iso(T0 + 10 * MIN + TTL),
        record,
      },
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 10 * MIN + TTL) });
    expect(store.count()).toBe(1);
    expect((await writeAs(f, scopeId)).statusCode).toBe(201);
  });

  it("(neg-accept-blocked) the buyer blocked since the mint: the accept stands, the scope waits, nothing activates", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    setPolicy(KERNEL, { ...basePolicy(), blockedAgents: [BUYER] });
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: "awaiting_funding",
      fundingRefusal: "buyer_blocked",
      activation: { kind: "refused", reason: "buyer_blocked" },
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-accept-atomic) a failure inside the activation rolls the accept back too: 500, nothing changed", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    const failing: TestFundingRecordStore = {
      ...store,
      findByScope: () => {
        throw new Error("store read failed");
      },
    };
    __setFundingRecordStoreForTest(failing);
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.statusCode).toBe(500);
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_acceptance", expiresAt: iso(T0 + TTL) });
  });

  it("a record for another of the buyer's scopes does not activate this one at the accept", async () => {
    const store = installTestFundingRecordStore();
    const first = await paidScope(f, { real: ESCROW_A, accept: false });
    const second = await paidScope(f, { real: ESCROW_B, accept: false });
    store.plant(verification(second.scopeId, { escrowAddress: ESCROW_A })); // ESCROW_A's record names the other scope
    const accepted = await acceptScope(f, first.scopeId);
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "funding_record_scope_mismatch" });
    expect(accepted.json().activation).toBeUndefined();
    expect(scopeRow(first.scopeId).status).toBe("awaiting_funding");
  });
});
