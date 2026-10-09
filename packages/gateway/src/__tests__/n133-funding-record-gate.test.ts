/**
 * Buyer funding plan, Stage 2 (research/buyer-funding-plan-20261008.md):
 *   - S2.1: buyerFundingVerdict passes a REAL escrow only on the finalized verification record kept
 *     for the scope, of this escrow and this buyer. No record store (production until Q9) refuses
 *     it, as before; the mock rule is unchanged.
 *   - The accept route calls reconcilePaidScope when that record exists, in the accept's own
 *     transaction. With no store nothing observable changes.
 * Negatives are tagged (neg-...) for the mutation runner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, schema, sql } from "@pcc/store";
import {
  buyerFundingRefusal,
  buyerFundingVerdict,
  scopeFundingRefusal,
} from "../services/scope-acceptance.js";
import { __setFundingRecordStoreForTest, fundingRecordStore, type FundingRecordStore } from "../services/funding-record-port.js";
import {
  installCaseExactFundingRecordStore,
  installTestFundingRecordStore,
  type TestFundingRecordStore,
} from "./helpers/test-funding-record-store.js";
import {
  ACTIVATION_TTL,
  BUYER,
  CHAIN_ID,
  ESCROW_A,
  ESCROW_B,
  KERNEL,
  MIN,
  OTHER,
  T0,
  TERMS,
  TTL,
  acceptScope,
  basePolicy,
  db,
  fundingStatusNow,
  installActivationTerms,
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

describe("S2.1 buyerFundingVerdict: a real escrow passes only on the scope's finalized record, of this escrow and this buyer", () => {
  it("(neg-gate-nostore) no store (production wiring): every real escrow is refused escrow_not_buyer_funded, as before", () => {
    expect(fundingRecordStore()).toBeNull();
    expect(buyerFundingVerdict(escrow(), BUYER, SCOPE)).toEqual({ kind: "refused", reason: "escrow_not_buyer_funded" });
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("(neg-gate-norecord) a store with no record of this escrow for the scope: escrow_not_buyer_funded", () => {
    const store = installTestFundingRecordStore();
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
    store.plant(verification(SCOPE, { escrowAddress: ESCROW_B })); // the scope's record is another escrow's
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
  });

  it("the escrow's finalized record, this buyer's, naming this scope: record_funded", () => {
    const store = installTestFundingRecordStore();
    const record = verification(SCOPE);
    store.plant(record);
    expect(buyerFundingVerdict(escrow(), BUYER, SCOPE)).toEqual({ kind: "record_funded", record });
    expect(buyerFundingRefusal(escrow({ contractAddress: ESCROW_A.toUpperCase().replace("0X", "0x") }), BUYER, SCOPE)).toBeNull();
  });

  it("(gate-escrow-case) the gate matches the scope's record to the escrow row in any letter case", () => {
    // Over a store that matches letter case exactly: the record is kept in lower case (the port folds
    // it), and the escrow row names the contract in upper case.
    const store = installCaseExactFundingRecordStore();
    const record = verification(SCOPE);
    store.plant(record);
    const upper = "0x" + ESCROW_A.slice(2).toUpperCase();
    expect(buyerFundingVerdict(escrow({ contractAddress: upper }), BUYER, SCOPE)).toEqual({ kind: "record_funded", record });
  });

  it("(neg-gate-scope) a record of this escrow naming another scope does not fund this one; without a scope id (the mint) none does", () => {
    const store = installTestFundingRecordStore();
    store.plant(verification("scope_elsewhere"));
    // The gate reads the scope's own record (an escrow lookup would need the expected chain, ruling 4).
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("escrow_not_buyer_funded");
    expect(buyerFundingRefusal(escrow(), BUYER)).toBe("funding_record_scope_mismatch");
  });

  it("(neg-gate-scope-store) a store answering for this scope with another scope's record is not believed", () => {
    const real = installTestFundingRecordStore();
    __setFundingRecordStoreForTest({ ...real, findByScope: () => verification("scope_elsewhere") });
    expect(buyerFundingRefusal(escrow(), BUYER, SCOPE)).toBe("funding_record_scope_mismatch");
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

  it("(neg-gate-wrongescrow) a store answering for the scope with another escrow's record is not believed", () => {
    const real = installTestFundingRecordStore();
    const lying: FundingRecordStore = {
      insert: real.insert,
      findByEscrow: real.findByEscrow,
      findByScope: () => verification(SCOPE, { escrowAddress: ESCROW_B }),
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

  it("(neg-accept-prod) in a production process a store and activation terms left installed are never consulted, even with a matching record", async () => {
    const store = installTestFundingRecordStore();
    installActivationTerms();
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
    installActivationTerms(); // the expected chain and the TTL (rulings 4 and 5)
    const jobRow = () => db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    const job = jobRow();
    vi.setSystemTime(T0 + 10 * MIN); // the operator accepts later
    const accepted = await acceptScope(f, scopeId);
    expect(jobRow()).toEqual(job); // no job-row write, no job status (ruling 7)
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      accepted: true,
      scopeId,
      kernelId: KERNEL,
      jobId,
      status: "active",
      fundingRefusal: null,
      // The activation without its record (NIT-2): no buyer wallet, block hash or verifier build.
      activation: {
        kind: "activated",
        activatedAt: iso(T0 + 10 * MIN),
        expiresAt: iso(T0 + 10 * MIN + ACTIVATION_TTL),
        escrowAddress: ESCROW_A,
      },
    });
    expect(accepted.payload).not.toContain(record.blockHash);
    expect(accepted.payload).not.toContain(record.verifierVersion);
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 10 * MIN + ACTIVATION_TTL) });
    expect(store.count()).toBe(1);
    expect((await writeAs(f, scopeId)).statusCode).toBe(201);
  });

  it("(neg-accept-live) an already_active outcome inside the accept is answered live (NIT-1)", async () => {
    // Unreachable today (the accept moves the scope to awaiting_funding); a TEMP trigger makes the
    // scope live inside the accept's own transaction, so reconcilePaidScope answers already_active.
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    installActivationTerms();
    db().run(sql`CREATE TEMP TRIGGER test_live_at_accept AFTER UPDATE OF status ON main.execution_scopes
      WHEN NEW.status = 'awaiting_funding' BEGIN UPDATE execution_scopes SET status = 'active' WHERE id = NEW.id; END`);
    const accepted = await acceptScope(f, scopeId);
    db().run(sql`DROP TRIGGER temp.test_live_at_accept`);
    expect(accepted.json()).toEqual({
      accepted: true,
      scopeId,
      kernelId: KERNEL,
      jobId,
      status: "active",
      fundingRefusal: null,
      activation: { kind: "already_active", expiresAt: iso(T0 + TTL), escrowAddress: ESCROW_A },
    });
    expect(scopeRow(scopeId).status).toBe("active");
  });

  it("(neg-accept-blocked) the buyer blocked since the mint: the accept stands, the scope waits, nothing activates", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    installActivationTerms();
    setPolicy(KERNEL, { ...basePolicy(), blockedAgents: [BUYER] });
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "buyer_blocked" });
    expect(accepted.json().activation).toEqual({ kind: "refused", reason: "buyer_blocked" });
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-accept-noterms) a stored record, but no expected chain or TTL installed (today's default): the accept stands, the activation is refused, nothing else is written", async () => {
    const store = installTestFundingRecordStore();
    for (const [terms, reason] of [
      [null, "expected_chain_unavailable"], // nothing installed: neither value
      [{ expectedChainId: null, postActivationTtlMs: ACTIVATION_TTL }, "expected_chain_unavailable"],
      [{ expectedChainId: CHAIN_ID, postActivationTtlMs: null }, "activation_ttl_unavailable"],
    ] as const) {
      if (terms) installActivationTerms(terms);
      const res = await submit(f);
      const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
      setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
      db().run(sql`DELETE FROM test_funding_records`);
      db().transaction((tx) => store.insert(tx, verification(scopeId)));
      const accepted = await acceptScope(f, scopeId);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json(), reason).toEqual({
        accepted: true,
        scopeId,
        kernelId: KERNEL,
        jobId,
        status: "awaiting_funding",
        fundingRefusal: reason,
        activation: { kind: "refused", reason },
      });
      expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
      expect(store.count()).toBe(1); // only the verifier's record
      expect((await writeAs(f, scopeId)).statusCode).toBe(403);
    }
  });

  it("(accept-ttl) the TTL the source gives for the scope sets its write time from the activation", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    installActivationTerms({ expectedChainId: CHAIN_ID, postActivationTtlMs: 2 * 24 * 60 * MIN });
    vi.setSystemTime(T0 + 7 * MIN);
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.json()).toMatchObject({ status: "active", activation: { kind: "activated", expiresAt: iso(T0 + 7 * MIN + 2 * 24 * 60 * MIN) } });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 7 * MIN + 2 * 24 * 60 * MIN) });
    expect(TERMS.postActivationTtlMs).not.toBe(2 * 24 * 60 * MIN);
  });

  it("(dto-q3b) the review's Q3b: a scope awaiting acceptance whose bound record's row reads created is not funded_verified, and the accept does not activate it", async () => {
    const store = installTestFundingRecordStore();
    installActivationTerms();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "created" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    expect(fundingStatusNow(store, scopeId)).toMatchObject({ state: "unknown", binding: "bound", scope: { sourceStatus: "awaiting_acceptance" } });
    const accepted = await acceptScope(f, scopeId);
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "escrow_not_funded" });
    expect(accepted.json().activation).toBeUndefined();
    expect(fundingStatusNow(store, scopeId)).toMatchObject({ state: "unknown", binding: "bound", scope: { sourceStatus: "awaiting_funding" } });
  });

  it("(neg-accept-atomic) a failure inside the activation rolls the accept back too: 500, nothing changed", async () => {
    const store = installTestFundingRecordStore();
    const res = await submit(f);
    const { scopeId, escrowId } = res.json() as { scopeId: string; escrowId: string };
    setEscrow(escrowId, { contractAddress: ESCROW_A, status: "funded" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    installActivationTerms();
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
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "escrow_not_buyer_funded" });
    expect(accepted.json().activation).toBeUndefined();
    expect(scopeRow(first.scopeId).status).toBe("awaiting_funding");
  });
});
