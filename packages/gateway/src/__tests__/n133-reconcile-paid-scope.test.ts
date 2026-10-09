/**
 * Buyer funding plan, Stage 2, S2.2 (research/buyer-funding-plan-20261008.md): reconcilePaidScope.
 *
 * A paid write scope goes from awaiting_funding to active exactly once, on its buyer's finalized
 * verification record, in one SQLite transaction that re-reads the stop, the block list and the
 * scope, inserts the record and compare-and-sets the scope, with the TTL starting at activation.
 * Each negative of the plan is a test here, tagged (neg-...) for the mutation runner: deleting the
 * guard it names makes that test fail.
 *
 * The record store is the test-only one (helpers/test-funding-record-store.ts): a TEMP table on the
 * test's own connection, so its inserts roll back with the transaction.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, eq, schema, sql } from "@pcc/store";
import { MAX_POST_ACTIVATION_TTL_MS, reconcilePaidScope, RECONCILE_REFUSALS } from "../services/reconcile-paid-scope.js";
import { __setFundingRecordStoreForTest, fundingRecordStore, isWellFormedFundingRecord } from "../services/funding-record-port.js";
import {
  installCaseExactFundingRecordStore,
  installFinalityBlindFundingRecordStore,
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
  iso,
  paidScope,
  revokeScope,
  scopeRow,
  setEscrow,
  setPolicy,
  setUpFixture,
  tearDownFixture,
  verification,
  writeAs,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

let f: Fixture;
let store: TestFundingRecordStore;

beforeEach(async () => {
  f = await setUpFixture();
  store = installTestFundingRecordStore();
});
afterEach(async () => {
  await tearDownFixture(f);
});

const refused = (reason: (typeof RECONCILE_REFUSALS)[number]) => ({ kind: "refused", reason });

describe("S2.2 accept: a paid scope goes from awaiting_funding to active exactly once, its TTL from activation", () => {
  it("activates once at the verification, expiresAt = activation + the TTL (fake clock); a repeat changes nothing (accept-once)", async () => {
    const { scopeId } = await paidScope(f); // minted and accepted at T0
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);

    // The buyer funds; the verifier reads the finalized block 20 minutes after the mint.
    vi.setSystemTime(T0 + 20 * MIN);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual({
      kind: "activated",
      scopeId,
      escrowAddress: ESCROW_A,
      activatedAt: iso(T0 + 20 * MIN),
      expiresAt: iso(T0 + 20 * MIN + ACTIVATION_TTL), // the caller's TTL from activation, not the mint's T0 + TTL
      record,
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 20 * MIN + ACTIVATION_TTL) });
    expect(store.count()).toBe(1);
    expect(store.findByScope(db(), scopeId)).toEqual(record);
    expect((await writeAs(f, scopeId)).statusCode).toBe(201);

    // Exactly once: a later reconcile of the same funding is already_active, with the kept record.
    vi.setSystemTime(T0 + 30 * MIN);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual({
      kind: "already_active",
      scopeId,
      escrowAddress: ESCROW_A,
      expiresAt: iso(T0 + 20 * MIN + ACTIVATION_TTL),
      record,
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 20 * MIN + ACTIVATION_TTL) });
    expect(store.count()).toBe(1);
  });

  it("an escrow address in another letter case is the same escrow", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_A.toUpperCase().replace("0X", "0x") }), TERMS).kind).toBe(
      "activated",
    );
  });

  it("a record the verifier stored first is activated on, not inserted twice (pre-stored)", async () => {
    const { scopeId } = await paidScope(f);
    const stored = verification(scopeId);
    db().transaction((tx) => store.insert(tx, stored));
    vi.setSystemTime(T0 + 5 * MIN);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toMatchObject({ kind: "activated", record: stored, expiresAt: iso(T0 + 5 * MIN + ACTIVATION_TTL) });
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
  });
});

describe("rulings 4 and 5: the expected chain and the post-activation TTL are required inputs", () => {
  /** Spies on every store read and write, to show a refusal read and wrote nothing. */
  function spyStore() {
    return [vi.spyOn(store, "findByScope"), vi.spyOn(store, "findByEscrow"), vi.spyOn(store, "insert")];
  }

  it("(neg-chain-input) no usable expected chain is expected_chain_unavailable, before anything is read or written", async () => {
    const { scopeId } = await paidScope(f);
    const before = scopeRow(scopeId);
    const spies = spyStore();
    for (const expectedChainId of [null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "84532"]) {
      const terms = { ...TERMS, expectedChainId } as never;
      expect(reconcilePaidScope(scopeId, verification(scopeId), terms), String(expectedChainId)).toEqual(refused("expected_chain_unavailable"));
    }
    expect(reconcilePaidScope(scopeId, verification(scopeId), undefined as never)).toEqual(refused("expected_chain_unavailable"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(scopeRow(scopeId)).toEqual(before);
    expect(store.count()).toBe(0);
  });

  it("(neg-ttl-input) no usable post-activation TTL is activation_ttl_unavailable, before anything is read or written", async () => {
    const { scopeId } = await paidScope(f);
    const before = scopeRow(scopeId);
    const spies = spyStore();
    for (const postActivationTtlMs of [null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600000", MAX_POST_ACTIVATION_TTL_MS + 1]) {
      const terms = { ...TERMS, postActivationTtlMs } as never;
      expect(reconcilePaidScope(scopeId, verification(scopeId), terms), String(postActivationTtlMs)).toEqual(refused("activation_ttl_unavailable"));
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(scopeRow(scopeId)).toEqual(before);
    expect(store.count()).toBe(0);
  });

  it("(ttl-bound) the TTL bound is 356 days, reclaimAt's 365-day ceiling less the 9 days before the primary verdict; the bound itself and 1 ms activate", async () => {
    expect(MAX_POST_ACTIVATION_TTL_MS).toBe(356 * 24 * 60 * MIN);
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId), { ...TERMS, postActivationTtlMs: MAX_POST_ACTIVATION_TTL_MS })).toMatchObject({
      kind: "activated",
      expiresAt: iso(T0 + MAX_POST_ACTIVATION_TTL_MS),
    });
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId, { escrowAddress: ESCROW_B }), { ...TERMS, postActivationTtlMs: 1 })).toMatchObject({
      kind: "activated",
      expiresAt: iso(T0 + 1),
    });
  });

  it("(ttl-from-input) the scope's write time is the caller's TTL from activation, not the mint's 1 h", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    vi.setSystemTime(T0 + 20 * MIN);
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId), { ...TERMS, postActivationTtlMs: 3 * 24 * 60 * MIN })).toMatchObject({
      kind: "activated",
      expiresAt: iso(T0 + 20 * MIN + 3 * 24 * 60 * MIN),
    });
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId, { escrowAddress: ESCROW_B }), { ...TERMS, postActivationTtlMs: 90 * MIN })).toMatchObject({
      kind: "activated",
      expiresAt: iso(T0 + 20 * MIN + 90 * MIN),
    });
    expect(scopeRow(one.scopeId).expiresAt).toBe(iso(T0 + 20 * MIN + 3 * 24 * 60 * MIN));
    expect(scopeRow(two.scopeId).expiresAt).toBe(iso(T0 + 20 * MIN + 90 * MIN));
  });

  it("(neg-record-chain) a record from any chain but the expected one is record_chain_mismatch, and nothing is written", async () => {
    const { scopeId } = await paidScope(f);
    // A record on 84532 while the expected chain is another id, and the other way round.
    expect(reconcilePaidScope(scopeId, verification(scopeId, { chainId: 84532 }), { ...TERMS, expectedChainId: 8453 })).toEqual(
      refused("record_chain_mismatch"),
    );
    expect(reconcilePaidScope(scopeId, verification(scopeId, { chainId: 545 }), TERMS)).toEqual(refused("record_chain_mismatch"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
    // The control: the expected chain's record activates.
    expect(reconcilePaidScope(scopeId, verification(scopeId, { chainId: CHAIN_ID }), TERMS).kind).toBe("activated");
  });

  it("(neg-kept-chain) a kept record from another chain is not this funding: a live scope's repeat is never already_active on it", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    db().run(sql`DELETE FROM test_funding_records`);
    store.plant(verification(scopeId, { chainId: 545 })); // the same escrow address, kept for this scope, on another chain
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("active");
  });

  it("(neg-reactivate-expired) a scope that lapsed after activation is never activated again on the same funding", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    const terms = { ...TERMS, postActivationTtlMs: 30 * MIN };
    expect(reconcilePaidScope(scopeId, record, terms)).toMatchObject({ kind: "activated", expiresAt: iso(T0 + 30 * MIN) });
    vi.setSystemTime(T0 + 31 * MIN);
    // GET scope moves a live scope past its TTL to expired (device-relay.ts GET /scope/:scopeId).
    expect((await f.app.inject({ method: "GET", url: `/api/relay/${KERNEL}/scope/${scopeId}` })).json()).toMatchObject({ status: "expired" });
    const after = scopeRow(scopeId);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, record, terms)).toEqual(refused("scope_not_awaiting_funding"));
    expect(reconcilePaidScope(scopeId, record, { ...terms, postActivationTtlMs: 24 * 60 * MIN })).toEqual(refused("scope_not_awaiting_funding"));
    expect(insert).not.toHaveBeenCalled();
    expect(scopeRow(scopeId)).toEqual(after);
    expect(store.count()).toBe(1);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-reactivate-lapsed-active) a scope past its TTL that still reads active gets already_active with its old expiry: nothing moves, and it cannot write", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, { ...TERMS, postActivationTtlMs: 30 * MIN }).kind).toBe("activated");
    vi.setSystemTime(T0 + 31 * MIN);
    const after = scopeRow(scopeId);
    expect(after.status).toBe("active");
    expect(reconcilePaidScope(scopeId, record, TERMS)).toMatchObject({ kind: "already_active", expiresAt: iso(T0 + 30 * MIN) });
    expect(scopeRow(scopeId)).toEqual(after);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-reactivate-second-scope) one funding never activates a second scope, before or after the first one's TTL lapses", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_A });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId), { ...TERMS, postActivationTtlMs: 30 * MIN }).kind).toBe("activated");
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId), TERMS)).toEqual(refused("escrow_bound_to_other_scope"));
    vi.setSystemTime(T0 + 31 * MIN);
    await f.app.inject({ method: "GET", url: `/api/relay/${KERNEL}/scope/${one.scopeId}` }); // one lapses to expired
    expect(scopeRow(one.scopeId).status).toBe("expired");
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId), TERMS)).toEqual(refused("escrow_bound_to_other_scope"));
    expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(1);
  });
});

describe("S2.2 negatives (the plan's Stage 2 list)", () => {
  it("(neg-estop) the e-stop engaged between verify and activate: refused, the scope stays awaiting, nothing recorded", async () => {
    const { scopeId } = await paidScope(f);
    const policy = basePolicy();
    const record = verification(scopeId); // verified ...
    setPolicy(KERNEL, { ...policy, emergencyStop: true }); // ... then the stop lands
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("kernel_emergency_stopped"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);

    // A policy that cannot be read cannot show the stop clear.
    db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
      VALUES (${KERNEL}, ${"[]"}, ${new Date().toISOString()}, ${"test"})`);
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("policy_unavailable"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);

    // Cleared while the window is open, the same funding activates it.
    setPolicy(KERNEL, policy);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
  });

  it("(neg-blocked) a buyer blocked since the accept is refused; nothing recorded", async () => {
    const { scopeId } = await paidScope(f);
    setPolicy(KERNEL, { ...basePolicy(), blockedAgents: [BUYER.toUpperCase().replace("0X", "0x")] });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("buyer_blocked"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-blocklist-malformed) a block list that is present but not an array of strings is policy_unavailable, never 'nobody blocked'", async () => {
    const { scopeId } = await paidScope(f);
    const policy = basePolicy();
    // P9 of the fund-s2 review: a string naming the buyer (the kernel's policy engine reads it as
    // blocked); then a null, a number, and an array holding a non-string.
    for (const blockedAgents of [BUYER, null, 42, [OTHER, 7]]) {
      setPolicy(KERNEL, { ...policy, blockedAgents });
      expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS), JSON.stringify(blockedAgents)).toEqual(refused("policy_unavailable"));
      expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
      expect(store.count()).toBe(0);
    }
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
    // A policy with no block list blocks nobody, as before; nor does a list of other buyers.
    const noList = { ...policy };
    delete noList.blockedAgents;
    setPolicy(KERNEL, noList);
    const other = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(other.scopeId, verification(other.scopeId, { escrowAddress: ESCROW_B }), TERMS).kind).toBe("activated");
    setPolicy(KERNEL, { ...policy, blockedAgents: [OTHER] });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
  });

  it("(neg-revoked) a scope the operator revoked never activates", async () => {
    const { scopeId } = await paidScope(f);
    expect((await revokeScope(f, scopeId)).statusCode).toBe(200);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_revoked"));
    expect(scopeRow(scopeId).status).toBe("revoked");
    expect(store.count()).toBe(0);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-unaccepted) funding never skips the operator's acceptance: a scope awaiting it is refused", async () => {
    const { scopeId } = await paidScope(f, { accept: false });
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_not_awaiting_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect(store.count()).toBe(0);
  });

  // reconcilePaidScope is synchronous on the gateway's one connection, so two calls in one process
  // run one after the other: these two tests are sequential and in-process, not races. The
  // cross-connection case is neg-two-connections, below.
  it("(neg-twice) two sequential, in-process reconciles of one scope with the same funding: the first activates, the second is already_active", async () => {
    const { scopeId } = await paidScope(f);
    const first = reconcilePaidScope(scopeId, verification(scopeId), TERMS);
    const second = reconcilePaidScope(scopeId, verification(scopeId), TERMS);
    expect([first.kind, second.kind]).toEqual(["activated", "already_active"]);
    expect(scopeRow(scopeId).status).toBe("active");
    expect(store.count()).toBe(1);
  });

  it("(neg-race-escrow) two sequential, in-process reconciles of one scope, each record of the job's escrow at its turn: the second is refused", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    const insert = vi.spyOn(store, "insert");
    const first = reconcilePaidScope(scopeId, verification(scopeId), TERMS); // the job's escrow is ESCROW_A
    // Between the calls the job's escrow row is re-pointed to ESCROW_B, so the second record IS the
    // job's escrow's at its turn: it is refused because the scope is bound to ESCROW_A's funding,
    // not because ESCROW_B is some other job's escrow.
    setEscrow(escrowId, { contractAddress: ESCROW_B });
    const second = reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_B }), TERMS);
    expect(first.kind).toBe("activated");
    expect(second).toEqual(refused("scope_bound_to_other_funding"));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(store.count()).toBe(1);
    expect(store.findByScope(db(), scopeId)?.escrowAddress).toBe(ESCROW_A);
  });

  it("(neg-other-funding) a live scope's record is never replaced by another escrow's", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
    // The job's escrow row is re-pointed to another contract (a replacement), and its record arrives.
    setEscrow(escrowId, { contractAddress: ESCROW_B });
    expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_B }), TERMS)).toEqual(
      refused("scope_bound_to_other_funding"),
    );
    expect(store.count()).toBe(1);
    expect(store.findByScope(db(), scopeId)?.escrowAddress).toBe(ESCROW_A);
  });

  it("(neg-active-mock) a scope already live on other funding (a test's mock escrow) is refused a real record", async () => {
    const { scopeId, escrowId } = await paidScope(f, { real: null }); // the mock escrow, accepted: live
    expect(scopeRow(scopeId).status).toBe("active");
    setEscrow(escrowId, { contractAddress: ESCROW_A });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_active_other_funding"));
    expect(store.count()).toBe(0);
    expect(scopeRow(scopeId).expiresAt).toBe(iso(T0 + TTL));
  });

  it("(neg-expired) the acceptance window lapsed: expired, and the scope never activates", async () => {
    const { scopeId } = await paidScope(f);
    vi.setSystemTime(T0 + TTL); // the window ends at T0 + TTL
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual({ kind: "expired", scopeId, windowEndedAt: iso(T0 + TTL) });
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
    // A millisecond before the end it would still have activated.
    vi.setSystemTime(T0);
    const other = await paidScope(f, { real: ESCROW_B });
    vi.setSystemTime(T0 + TTL - 1);
    expect(reconcilePaidScope(other.scopeId, verification(other.scopeId, { escrowAddress: ESCROW_B }), TERMS).kind).toBe("activated");
  });

  it("(neg-unreadable-window) a window that cannot be read counts as lapsed", async () => {
    const { scopeId } = await paidScope(f);
    db().run(sql`UPDATE execution_scopes SET expires_at = ${"not a time"} WHERE id = ${scopeId}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toMatchObject({ kind: "expired" });
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-other-job) the same buyer's escrow for a different job is refused", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId, { escrowAddress: ESCROW_B }), TERMS)).toEqual(
      refused("record_escrow_not_scope_escrow"),
    );
    expect(scopeRow(one.scopeId).status).toBe("awaiting_funding");
    expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-duplicate) a duplicate notification is a no-op: the record count and the TTL do not change", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    const after = scopeRow(scopeId);
    vi.setSystemTime(T0 + 10 * MIN);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, record, TERMS)).toMatchObject({ kind: "already_active", expiresAt: after.expiresAt });
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
    expect(scopeRow(scopeId)).toEqual(after);
  });

  it("(neg-settled-repeat) a duplicate after settlement is already_active, nothing written: the escrow row's status is not read for it (P6)", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    const after = scopeRow(scopeId);
    setEscrow(escrowId, { status: "completed" }); // the job settled (paid-job-flow, settlement-keeper)
    vi.setSystemTime(T0 + 10 * MIN);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual({
      kind: "already_active",
      scopeId,
      escrowAddress: ESCROW_A,
      expiresAt: after.expiresAt,
      record,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
    expect(scopeRow(scopeId)).toEqual(after);
    // The refusals stay: another buyer's record, and another escrow's record, of this scope.
    expect(reconcilePaidScope(scopeId, verification(scopeId, { buyer: OTHER }), TERMS)).toEqual(refused("record_buyer_not_scope_buyer"));
    expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_B }), TERMS)).toEqual(refused("escrow_not_funded"));
    expect(insert).not.toHaveBeenCalled();
  });

  it("(neg-active-kept) for a live scope, a repeat is already_active only on its buyer's own well-formed kept record", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    // The kept record replaced by another buyer's.
    db().run(sql`DELETE FROM test_funding_records`);
    store.plant({ ...record, buyer: OTHER });
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    // A store answering for this scope with another scope's record.
    __setFundingRecordStoreForTest({ ...store, findByScope: () => verification("scope_elsewhere") });
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("active");
  });

  it("(neg-active-kept-unfinalized) over a store that breaks the finalized-only contract, an unfinalized kept record of a live scope is never already_active", async () => {
    // A conformant store never shows this row (ruling 3); reconcile's own check is defence in depth.
    store = installFinalityBlindFundingRecordStore();
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    db().run(sql`DELETE FROM test_funding_records_blind`);
    store.plant({ ...record, finality: "latest" });
    expect(reconcilePaidScope(scopeId, record, TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("active");
  });

  it("(neg-nostore) no record store: the fail-closed reason, and nothing changes", async () => {
    const { scopeId } = await paidScope(f);
    __setFundingRecordStoreForTest(null);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("funding_record_store_unavailable"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
  });

  it("(neg-prodstore) in a production process a store left installed is never consulted", async () => {
    const { scopeId } = await paidScope(f);
    process.env.NODE_ENV = "production";
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("funding_record_store_unavailable"));
    expect(() => __setFundingRecordStoreForTest(store)).toThrow();
    process.env.NODE_ENV = "test";
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-cas) a compare-and-set that changes no row rolls the record insert back", async () => {
    const { scopeId } = await paidScope(f);
    const before = scopeRow(scopeId);
    // The update of this scope to active is skipped, so the compare-and-set changes 0 rows.
    db().run(sql`CREATE TEMP TRIGGER test_block_activation BEFORE UPDATE OF status ON main.execution_scopes
      WHEN NEW.status = 'active' BEGIN SELECT RAISE(IGNORE); END`);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("activation_conflict"));
    expect(insert).toHaveBeenCalledTimes(1); // the record WAS inserted ...
    expect(store.count()).toBe(0); // ... and rolled back with the transaction
    expect(scopeRow(scopeId)).toEqual(before);
    db().run(sql`DROP TRIGGER temp.test_block_activation`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
  });
});

describe("S2.2 the compare-and-set moves only the exact row the checks read", () => {
  /** A store whose insert also changes the scope, as a writer between the checks and the compare-and-set would. */
  function writerInside(change: ReturnType<typeof sql>) {
    __setFundingRecordStoreForTest({
      ...store,
      insert(tx, record) {
        store.insert(tx, record);
        tx.run(change);
      },
    });
  }

  it("(neg-cas-status) a status changed inside the transaction is not activated; everything rolls back", async () => {
    const { scopeId } = await paidScope(f);
    writerInside(sql`UPDATE execution_scopes SET status = 'revoked' WHERE id = ${scopeId}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("activation_conflict"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
  });

  it("(neg-cas-expiry) a window changed inside the transaction is not activated; everything rolls back", async () => {
    const { scopeId } = await paidScope(f);
    writerInside(sql`UPDATE execution_scopes SET expires_at = ${iso(T0 + 2 * TTL)} WHERE id = ${scopeId}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("activation_conflict"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
  });
});

describe("S2.2 binding: the record is this scope's buyer's funding of this scope's escrow", () => {
  it("(neg-record-scope) a record naming another scope is refused", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(one.scopeId, verification(two.scopeId), TERMS)).toEqual(refused("record_scope_mismatch"));
    expect(store.count()).toBe(0);
  });

  it("(neg-record-buyer) a record whose verified payer is not the scope's buyer is refused", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId, { buyer: OTHER }), TERMS)).toEqual(refused("record_buyer_not_scope_buyer"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-malformed) a record that is not a well-formed, finalized verification is refused", async () => {
    const { scopeId } = await paidScope(f);
    const bad: Array<Record<string, unknown>> = [
      { finality: "latest" },
      { finality: undefined },
      { blockHash: "0x" + "c3".repeat(31) },
      { blockNumber: "-1" },
      { blockNumber: "01" },
      { blockNumber: 31337000 },
      { chainId: 0 },
      { chainId: "84532" },
      { escrowAddress: "mock-escrow-x" },
      { buyer: "alice" }, // an admin-named buyer is no on-chain payer
      { verifiedAt: "2026-10-08 12:00:00" },
      { verifierVersion: "" },
    ];
    for (const over of bad) {
      const record = { ...verification(scopeId), ...over } as never;
      expect(reconcilePaidScope(scopeId, record, TERMS), JSON.stringify(over)).toEqual(refused("record_malformed"));
    }
    expect(reconcilePaidScope(scopeId, null as never, TERMS)).toEqual(refused("record_malformed"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-block-number) a block number is a uint64: 2^64 - 1 is well formed, 2^64 and above are malformed", async () => {
    const { scopeId } = await paidScope(f);
    for (const blockNumber of ["18446744073709551616", "99999999999999999999"]) {
      expect(isWellFormedFundingRecord(verification(scopeId, { blockNumber })), blockNumber).toBe(false);
      expect(reconcilePaidScope(scopeId, verification(scopeId, { blockNumber }), TERMS), blockNumber).toEqual(refused("record_malformed"));
    }
    expect(store.count()).toBe(0);
    const max = verification(scopeId, { blockNumber: "18446744073709551615" });
    expect(isWellFormedFundingRecord(max)).toBe(true);
    expect(reconcilePaidScope(scopeId, max, TERMS).kind).toBe("activated");
  });

  it("(neg-escrow-row) the scope's escrow row must exist, be the buyer's and be funded", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    setEscrow(escrowId, { status: "created" });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("escrow_not_funded"));
    setEscrow(escrowId, { status: "funded", payer: OTHER });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("escrow_payer_not_buyer"));
    // A scope bound to no job has no escrow.
    db().run(sql`INSERT INTO execution_scopes (id, kernel_id, job_id, created_by, status, allowed_tools, max_commands, command_count, max_retries, retry_count, created_at, expires_at)
      VALUES (${"scope_nojob"}, ${KERNEL}, ${null}, ${BUYER}, ${"awaiting_funding"}, ${"[]"}, ${10}, ${0}, ${1}, ${0}, ${iso(T0)}, ${iso(T0 + TTL)})`);
    expect(reconcilePaidScope("scope_nojob", verification("scope_nojob"), TERMS)).toEqual(refused("escrow_missing"));
    expect(store.count()).toBe(0);
  });

  it("(neg-escrow-reuse) one funding activates one scope: an escrow already bound to another scope is refused", async () => {
    // Two jobs whose escrow rows name the same contract (a reused address).
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_A });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId), TERMS).kind).toBe("activated");
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId), TERMS)).toEqual(refused("escrow_bound_to_other_scope"));
    expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(1);
  });

  it("(neg-escrow-case) one funding activates one scope even over a store that matches escrow letter case exactly (P10)", async () => {
    // The fund-s2 review's P10: two jobs whose escrow rows name one contract in different letter
    // case. reconcilePaidScope folds the address for the lookup and the insert, so the second is
    // refused over a store with case-exact lookups and no unique escrow key. Both orders: a fold on
    // one side only would let one of them through.
    store = installCaseExactFundingRecordStore();
    const upper = (address: string) => "0x" + address.slice(2).toUpperCase();
    for (const [first, second] of [
      [ESCROW_A, upper(ESCROW_A)],
      [upper(ESCROW_B), ESCROW_B],
    ]) {
      const one = await paidScope(f, { real: first });
      const two = await paidScope(f, { real: second });
      expect(reconcilePaidScope(one.scopeId, verification(one.scopeId, { escrowAddress: first }), TERMS).kind).toBe("activated");
      expect(reconcilePaidScope(two.scopeId, verification(two.scopeId, { escrowAddress: second }), TERMS), second).toEqual(
        refused("escrow_bound_to_other_scope"),
      );
      expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    }
    expect(store.count()).toBe(2); // one record per contract
  });

  it("(port-fold) the port keeps every record folded, whatever case a writer hands it: over a case-exact store, a checksummed pre-stored record binds one scope only (NIT-3)", async () => {
    store = installCaseExactFundingRecordStore();
    const upper = "0x" + ESCROW_A.slice(2).toUpperCase();
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_A });
    // The verifier stores one's record through the port, the escrow in upper case.
    db().transaction((tx) => fundingRecordStore()!.insert(tx, verification(one.scopeId, { escrowAddress: upper })));
    expect(store.findByScope(db(), one.scopeId)?.escrowAddress).toBe(ESCROW_A); // kept folded
    expect(fundingRecordStore()!.findByEscrow(db(), CHAIN_ID, upper)?.scopeId).toBe(one.scopeId); // looked up folded
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId), TERMS).kind).toBe("activated");
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId), TERMS)).toEqual(refused("escrow_bound_to_other_scope"));
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
  });

  it("(fund-two-chains) one escrow address on two chains is two fundings: each activates its own scope (ruling 4)", async () => {
    // Two jobs whose escrow rows name one contract address: one funded on Base Sepolia, one on another chain.
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_A });
    const onOther = { ...TERMS, expectedChainId: 545 }; // the other chain's deployment
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId, { chainId: CHAIN_ID }), TERMS).kind).toBe("activated");
    // Each record activates only where its chain is the expected one.
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId, { chainId: 545 }), TERMS)).toEqual(refused("record_chain_mismatch"));
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId, { chainId: 545 }), onOther).kind).toBe("activated");
    expect(store.count()).toBe(2);
    expect(store.findByEscrow(db(), CHAIN_ID, ESCROW_A)?.scopeId).toBe(one.scopeId);
    expect(store.findByEscrow(db(), 545, ESCROW_A)?.scopeId).toBe(two.scopeId);
    // And on either chain the funding still binds one scope.
    const three = await paidScope(f, { real: ESCROW_A });
    expect(reconcilePaidScope(three.scopeId, verification(three.scopeId, { chainId: 545 }), onOther)).toEqual(refused("escrow_bound_to_other_scope"));
  });

  it("(neg-kept-record) over a store that breaks the finalized-only contract, a kept record that is not well formed blocks the activation", async () => {
    // A conformant store never shows this row (ruling 3); reconcile's own check is defence in depth.
    store = installFinalityBlindFundingRecordStore();
    const { scopeId } = await paidScope(f);
    store.plant({ ...verification(scopeId), finality: "latest" }); // some other writer's unfinalized row
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
  });

  it("(fin-unfinalized-no-block) an unfinalized observation of this scope's funding never blocks its finalized activation (ruling 3)", async () => {
    const { scopeId } = await paidScope(f);
    // Rows another writer left, not finalized: for this scope and this escrow, and for another scope and this escrow.
    store.plant({ ...verification(scopeId), finality: "latest" });
    store.plant({ ...verification("scope_elsewhere"), finality: "safe" });
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record, TERMS)).toMatchObject({ kind: "activated", record });
    expect(scopeRow(scopeId).status).toBe("active");
    expect(store.findByScope(db(), scopeId)).toEqual(record); // the finalized one is the record kept
    expect(store.count()).toBe(3); // two unfinalized rows, untouched, and the finalized record
  });

  it("(neg-kept-buyer) a kept record of this scope and escrow whose verified payer is another buyer blocks the activation", async () => {
    const { scopeId } = await paidScope(f);
    store.plant(verification(scopeId, { buyer: OTHER }));
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
  });

  it("(neg-kept-lying) a store answering for this scope with another scope's record is not believed", async () => {
    const { scopeId } = await paidScope(f);
    const other = verification("scope_elsewhere");
    __setFundingRecordStoreForTest({ ...store, findByScope: () => other });
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("an unknown scope is refused", () => {
    expect(reconcilePaidScope("scope_unknown", verification("scope_unknown"), TERMS)).toEqual(refused("scope_not_found"));
  });

  it("the accept route still answers 409 for a scope that went live through reconcile", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
    const again = await acceptScope(f, scopeId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_decided", status: "active" });
  });
});

describe("ruling 1: the DTO and reconcile use the same rule", () => {
  /** A contract address of its own for case `i`, so that records of different cases never share a key. */
  const contract = (i: number) => "0x" + (0xc0000 + i).toString(16).padStart(40, "0");

  it("(dto-agrees) before activation the DTO reads funded_verified exactly when reconcile activates, over rows, records and chains (stop clear, buyer unblocked)", async () => {
    const records: Array<[string, (scopeId: string, own: string, other: string) => object]> = [
      ["good", (id, own) => verification(id, { escrowAddress: own })],
      ["other chain", (id, own) => verification(id, { escrowAddress: own, chainId: 545 })],
      ["other escrow", (id, _own, other) => verification(id, { escrowAddress: other })],
      ["other buyer", (id, own) => verification(id, { escrowAddress: own, buyer: OTHER })],
      ["unfinalized", (id, own) => ({ ...verification(id, { escrowAddress: own }), finality: "latest" })],
    ];
    const both: string[] = [];
    let i = 0;
    for (const rowStatus of ["funded", "active", "created", "completed", ""]) {
      for (const [name, make] of records) {
        const own = contract(i++);
        const other = contract(i++);
        const { scopeId, escrowId } = await paidScope(f, { real: own });
        setEscrow(escrowId, { status: rowStatus });
        const record = make(scopeId, own, other);
        store.plant(record); // the verifier's write; an unfinalized row stays invisible
        const dto = fundingStatusNow(store, scopeId);
        const result = reconcilePaidScope(scopeId, record as never, TERMS);
        const label = `${rowStatus || "''"} ${name}: DTO ${dto.state}, reconcile ${result.kind === "refused" ? result.reason : result.kind}`;
        expect(dto.state === "funded_verified", label).toBe(result.kind === "activated");
        if (result.kind === "activated") both.push(`${rowStatus} ${name}`);
      }
    }
    // The control: both say yes for the good record on a funded or active row, and only there.
    expect(both).toEqual(["funded good", "active good"]);
  });

  it("(dto-q3a) the review's Q3a: an accepted scope whose bound record's row reads created is not funded_verified, as reconcile refuses escrow_not_funded", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    setEscrow(escrowId, { status: "created" });
    db().transaction((tx) => store.insert(tx, verification(scopeId)));
    expect(fundingStatusNow(store, scopeId)).toMatchObject({ state: "unknown", binding: "bound" });
    expect(fundingStatusNow(store, scopeId).verification).not.toBeNull();
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS)).toEqual(refused("escrow_not_funded"));
    // S1.2 writes the row funded with the record (ruling 2): then both say yes.
    setEscrow(escrowId, { status: "funded" });
    expect(fundingStatusNow(store, scopeId).state).toBe("funded_verified");
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
  });
});

describe("what Stage 2 must not write or read (rulings 2 and 7; gateway's condition (ii), accepted in bulletin 7195)", () => {
  const jobRow = (jobId: string) => db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  const escrowRows = (escrowId: string) => ({
    escrow: db().select().from(schema.escrows).where(eq(schema.escrows.id, escrowId)).get(),
    milestones: db().select().from(schema.escrowMilestones).where(eq(schema.escrowMilestones.escrowId, escrowId)).all(),
  });
  const setMilestones = (escrowId: string, status: string) =>
    db().update(schema.escrowMilestones).set({ status }).where(eq(schema.escrowMilestones.escrowId, escrowId)).run();
  /** A contract address of its own for case `i`, so that records of different cases never share a key. */
  const contract = (i: number) => "0x" + (0xd0000 + i).toString(16).padStart(40, "0");

  it("(no-job-write) an activation writes neither the job row nor the escrow row or its milestones: no job status, no second writer of funded (rulings 7 and 2)", async () => {
    const { scopeId, jobId, escrowId } = await paidScope(f);
    const job = jobRow(jobId);
    const escrow = escrowRows(escrowId);
    expect(job).toBeDefined();
    expect(escrow.milestones.length).toBeGreaterThan(0);
    vi.setSystemTime(T0 + 5 * MIN);
    expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
    expect(jobRow(jobId)).toEqual(job);
    expect(escrowRows(escrowId)).toEqual(escrow);
  });

  it("(milestones-unread) milestone rows that disagree with the escrow row change neither reconcile's answer nor the DTO's", async () => {
    let i = 0;
    // The escrow row funded, its milestones anything: activation-ready, as with funded milestones.
    for (const milestones of ["funded", "pending", "released", "disputed", "refunded", ""]) {
      const own = contract(i++);
      const { scopeId, escrowId } = await paidScope(f, { real: own });
      setMilestones(escrowId, milestones);
      store.plant(verification(scopeId, { escrowAddress: own }));
      expect(fundingStatusNow(store, scopeId).state, milestones).toBe("funded_verified");
      expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: own }), TERMS).kind, milestones).toBe("activated");
      expect(fundingStatusNow(store, scopeId).state, milestones).toBe("funded_verified");
    }
    // The escrow row created, its milestones anything (funded included): not activation-ready.
    for (const milestones of ["funded", "pending"]) {
      const own = contract(i++);
      const { scopeId, escrowId } = await paidScope(f, { real: own });
      setEscrow(escrowId, { status: "created" });
      setMilestones(escrowId, milestones);
      store.plant(verification(scopeId, { escrowAddress: own }));
      expect(fundingStatusNow(store, scopeId), milestones).toMatchObject({ state: "unknown", binding: "bound" });
      expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: own }), TERMS), milestones).toEqual(refused("escrow_not_funded"));
    }
  });
});

describe("S2.2 across connections: one database file, two connections (as two gateway processes)", () => {
  let dir: string | undefined;
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("(neg-two-connections) while a reconcile runs, a second connection reads the old row and cannot start a write; then it reads the activation", async () => {
    dir = mkdtempSync(join(tmpdir(), "fund-s2-two-connections-"));
    const file = join(dir, "pcc.sqlite");
    await tearDownFixture(f); // this test's own fixture, on a database file
    f = await setUpFixture({ dbPath: file });
    store = installTestFundingRecordStore();
    const { scopeId } = await paidScope(f);
    const other = createDatabase(file).sqlite;
    other.pragma("busy_timeout = 0"); // SQLITE_BUSY at once, not after the 5 s default
    const statusOf = () => (other.prepare("SELECT status FROM execution_scopes WHERE id = ?").get(scopeId) as { status: string }).status;
    const seen: string[] = [];
    __setFundingRecordStoreForTest({
      ...store,
      insert(tx, record) {
        store.insert(tx, record); // inside reconcile's BEGIN IMMEDIATE transaction
        seen.push(statusOf());
        try {
          other.prepare("BEGIN IMMEDIATE").run();
          seen.push("began");
          other.prepare("ROLLBACK").run();
        } catch (err) {
          seen.push((err as { code?: string }).code ?? "error");
        }
      },
    });
    try {
      expect(reconcilePaidScope(scopeId, verification(scopeId), TERMS).kind).toBe("activated");
      expect(seen).toEqual(["awaiting_funding", "SQLITE_BUSY"]);
      expect(statusOf()).toBe("active");
    } finally {
      other.close();
    }
  });
});
