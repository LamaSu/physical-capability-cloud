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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "@pcc/store";
import { reconcilePaidScope, RECONCILE_REFUSALS } from "../services/reconcile-paid-scope.js";
import { __setFundingRecordStoreForTest } from "../services/funding-record-port.js";
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
    expect(reconcilePaidScope(scopeId, record)).toEqual({
      kind: "activated",
      scopeId,
      escrowAddress: ESCROW_A,
      activatedAt: iso(T0 + 20 * MIN),
      expiresAt: iso(T0 + 20 * MIN + TTL), // not the mint's T0 + TTL
      record,
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 20 * MIN + TTL) });
    expect(store.count()).toBe(1);
    expect(store.findByScope(db(), scopeId)).toEqual(record);
    expect((await writeAs(f, scopeId)).statusCode).toBe(201);

    // Exactly once: a later reconcile of the same funding is already_active, with the kept record.
    vi.setSystemTime(T0 + 30 * MIN);
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual({
      kind: "already_active",
      scopeId,
      escrowAddress: ESCROW_A,
      expiresAt: iso(T0 + 20 * MIN + TTL),
      record,
    });
    expect(scopeRow(scopeId)).toMatchObject({ status: "active", expiresAt: iso(T0 + 20 * MIN + TTL) });
    expect(store.count()).toBe(1);
  });

  it("an escrow address in another letter case is the same escrow", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_A.toUpperCase().replace("0X", "0x") })).kind).toBe(
      "activated",
    );
  });

  it("a record the verifier stored first is activated on, not inserted twice (pre-stored)", async () => {
    const { scopeId } = await paidScope(f);
    const stored = verification(scopeId);
    db().transaction((tx) => store.insert(tx, stored));
    vi.setSystemTime(T0 + 5 * MIN);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toMatchObject({ kind: "activated", record: stored, expiresAt: iso(T0 + 5 * MIN + TTL) });
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
  });
});

describe("S2.2 negatives (the plan's Stage 2 list)", () => {
  it("(neg-estop) the e-stop engaged between verify and activate: refused, the scope stays awaiting, nothing recorded", async () => {
    const { scopeId } = await paidScope(f);
    const policy = basePolicy();
    const record = verification(scopeId); // verified ...
    setPolicy(KERNEL, { ...policy, emergencyStop: true }); // ... then the stop lands
    expect(reconcilePaidScope(scopeId, record)).toEqual(refused("kernel_emergency_stopped"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);

    // A policy that cannot be read cannot show the stop clear.
    db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
      VALUES (${KERNEL}, ${"[]"}, ${new Date().toISOString()}, ${"test"})`);
    expect(reconcilePaidScope(scopeId, record)).toEqual(refused("policy_unavailable"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);

    // Cleared while the window is open, the same funding activates it.
    setPolicy(KERNEL, policy);
    expect(reconcilePaidScope(scopeId, record).kind).toBe("activated");
  });

  it("(neg-blocked) a buyer blocked since the accept is refused; nothing recorded", async () => {
    const { scopeId } = await paidScope(f);
    setPolicy(KERNEL, { ...basePolicy(), blockedAgents: [BUYER.toUpperCase().replace("0X", "0x")] });
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("buyer_blocked"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-revoked) a scope the operator revoked never activates", async () => {
    const { scopeId } = await paidScope(f);
    expect((await revokeScope(f, scopeId)).statusCode).toBe(200);
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("scope_revoked"));
    expect(scopeRow(scopeId).status).toBe("revoked");
    expect(store.count()).toBe(0);
    expect((await writeAs(f, scopeId)).statusCode).toBe(403);
  });

  it("(neg-unaccepted) funding never skips the operator's acceptance: a scope awaiting it is refused", async () => {
    const { scopeId } = await paidScope(f, { accept: false });
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("scope_not_awaiting_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect(store.count()).toBe(0);
  });

  it("(neg-twice) two reconciles of one scope with the same funding: exactly one activates, the other is already_active", async () => {
    const { scopeId } = await paidScope(f);
    const results = await Promise.all([0, 1].map(async () => reconcilePaidScope(scopeId, verification(scopeId))));
    expect(results.map((r) => r.kind).sort()).toEqual(["activated", "already_active"]);
    expect(scopeRow(scopeId).status).toBe("active");
    expect(store.count()).toBe(1);
  });

  it("(neg-race-escrow) two reconciles of one scope with different escrows: exactly one activates, the other is refused", async () => {
    const { scopeId } = await paidScope(f);
    const results = await Promise.all(
      [ESCROW_A, ESCROW_B].map(async (escrowAddress) => reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress }))),
    );
    expect(results[0].kind).toBe("activated");
    expect(results[1]).toEqual(refused("record_escrow_not_scope_escrow"));
    expect(store.count()).toBe(1);
  });

  it("(neg-other-funding) a live scope's record is never replaced by another escrow's", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId)).kind).toBe("activated");
    // The job's escrow row is re-pointed to another contract (a replacement), and its record arrives.
    setEscrow(escrowId, { contractAddress: ESCROW_B });
    expect(reconcilePaidScope(scopeId, verification(scopeId, { escrowAddress: ESCROW_B }))).toEqual(
      refused("scope_bound_to_other_funding"),
    );
    expect(store.count()).toBe(1);
    expect(store.findByScope(db(), scopeId)?.escrowAddress).toBe(ESCROW_A);
  });

  it("(neg-active-mock) a scope already live on other funding (a test's mock escrow) is refused a real record", async () => {
    const { scopeId, escrowId } = await paidScope(f, { real: null }); // the mock escrow, accepted: live
    expect(scopeRow(scopeId).status).toBe("active");
    setEscrow(escrowId, { contractAddress: ESCROW_A });
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("scope_active_other_funding"));
    expect(store.count()).toBe(0);
    expect(scopeRow(scopeId).expiresAt).toBe(iso(T0 + TTL));
  });

  it("(neg-expired) the acceptance window lapsed: expired, and the scope never activates", async () => {
    const { scopeId } = await paidScope(f);
    vi.setSystemTime(T0 + TTL); // the window ends at T0 + TTL
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual({ kind: "expired", scopeId, windowEndedAt: iso(T0 + TTL) });
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
    // A millisecond before the end it would still have activated.
    vi.setSystemTime(T0);
    const other = await paidScope(f, { real: ESCROW_B });
    vi.setSystemTime(T0 + TTL - 1);
    expect(reconcilePaidScope(other.scopeId, verification(other.scopeId, { escrowAddress: ESCROW_B })).kind).toBe("activated");
  });

  it("(neg-unreadable-window) a window that cannot be read counts as lapsed", async () => {
    const { scopeId } = await paidScope(f);
    db().run(sql`UPDATE execution_scopes SET expires_at = ${"not a time"} WHERE id = ${scopeId}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toMatchObject({ kind: "expired" });
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-other-job) the same buyer's escrow for a different job is refused", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId, { escrowAddress: ESCROW_B }))).toEqual(
      refused("record_escrow_not_scope_escrow"),
    );
    expect(scopeRow(one.scopeId).status).toBe("awaiting_funding");
    expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-duplicate) a duplicate notification is a no-op: the record count and the TTL do not change", async () => {
    const { scopeId } = await paidScope(f);
    const record = verification(scopeId);
    expect(reconcilePaidScope(scopeId, record).kind).toBe("activated");
    const after = scopeRow(scopeId);
    vi.setSystemTime(T0 + 10 * MIN);
    const insert = vi.spyOn(store, "insert");
    expect(reconcilePaidScope(scopeId, record)).toMatchObject({ kind: "already_active", expiresAt: after.expiresAt });
    expect(insert).not.toHaveBeenCalled();
    expect(store.count()).toBe(1);
    expect(scopeRow(scopeId)).toEqual(after);
  });

  it("(neg-nostore) no record store: the fail-closed reason, and nothing changes", async () => {
    const { scopeId } = await paidScope(f);
    __setFundingRecordStoreForTest(null);
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("funding_record_store_unavailable"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
  });

  it("(neg-prodstore) in a production process a store left installed is never consulted", async () => {
    const { scopeId } = await paidScope(f);
    process.env.NODE_ENV = "production";
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("funding_record_store_unavailable"));
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
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("activation_conflict"));
    expect(insert).toHaveBeenCalledTimes(1); // the record WAS inserted ...
    expect(store.count()).toBe(0); // ... and rolled back with the transaction
    expect(scopeRow(scopeId)).toEqual(before);
    db().run(sql`DROP TRIGGER temp.test_block_activation`);
    expect(reconcilePaidScope(scopeId, verification(scopeId)).kind).toBe("activated");
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
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("activation_conflict"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
  });

  it("(neg-cas-expiry) a window changed inside the transaction is not activated; everything rolls back", async () => {
    const { scopeId } = await paidScope(f);
    writerInside(sql`UPDATE execution_scopes SET expires_at = ${iso(T0 + 2 * TTL)} WHERE id = ${scopeId}`);
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("activation_conflict"));
    expect(scopeRow(scopeId)).toMatchObject({ status: "awaiting_funding", expiresAt: iso(T0 + TTL) });
    expect(store.count()).toBe(0);
  });
});

describe("S2.2 binding: the record is this scope's buyer's funding of this scope's escrow", () => {
  it("(neg-record-scope) a record naming another scope is refused", async () => {
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_B });
    expect(reconcilePaidScope(one.scopeId, verification(two.scopeId))).toEqual(refused("record_scope_mismatch"));
    expect(store.count()).toBe(0);
  });

  it("(neg-record-buyer) a record whose verified payer is not the scope's buyer is refused", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId, { buyer: OTHER }))).toEqual(refused("record_buyer_not_scope_buyer"));
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
      expect(reconcilePaidScope(scopeId, record), JSON.stringify(over)).toEqual(refused("record_malformed"));
    }
    expect(reconcilePaidScope(scopeId, null as never)).toEqual(refused("record_malformed"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("(neg-escrow-row) the scope's escrow row must exist, be the buyer's and be funded", async () => {
    const { scopeId, escrowId } = await paidScope(f);
    setEscrow(escrowId, { status: "created" });
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("escrow_not_funded"));
    setEscrow(escrowId, { status: "funded", payer: OTHER });
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("escrow_payer_not_buyer"));
    // A scope bound to no job has no escrow.
    db().run(sql`INSERT INTO execution_scopes (id, kernel_id, job_id, created_by, status, allowed_tools, max_commands, command_count, max_retries, retry_count, created_at, expires_at)
      VALUES (${"scope_nojob"}, ${KERNEL}, ${null}, ${BUYER}, ${"awaiting_funding"}, ${"[]"}, ${10}, ${0}, ${1}, ${0}, ${iso(T0)}, ${iso(T0 + TTL)})`);
    expect(reconcilePaidScope("scope_nojob", verification("scope_nojob"))).toEqual(refused("escrow_missing"));
    expect(store.count()).toBe(0);
  });

  it("(neg-escrow-reuse) one funding activates one scope: an escrow already bound to another scope is refused", async () => {
    // Two jobs whose escrow rows name the same contract (a reused address).
    const one = await paidScope(f, { real: ESCROW_A });
    const two = await paidScope(f, { real: ESCROW_A });
    expect(reconcilePaidScope(one.scopeId, verification(one.scopeId)).kind).toBe("activated");
    expect(reconcilePaidScope(two.scopeId, verification(two.scopeId))).toEqual(refused("escrow_bound_to_other_scope"));
    expect(scopeRow(two.scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(1);
  });

  it("(neg-kept-record) a kept record that is not this buyer's well-formed record blocks the activation", async () => {
    const { scopeId } = await paidScope(f);
    store.plant({ ...verification(scopeId), finality: "latest" }); // some other writer's unfinalized row
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
  });

  it("(neg-kept-lying) a store answering for this scope with another scope's record is not believed", async () => {
    const { scopeId } = await paidScope(f);
    const other = verification("scope_elsewhere");
    __setFundingRecordStoreForTest({ ...store, findByScope: () => other });
    expect(reconcilePaidScope(scopeId, verification(scopeId))).toEqual(refused("scope_bound_to_other_funding"));
    expect(scopeRow(scopeId).status).toBe("awaiting_funding");
    expect(store.count()).toBe(0);
  });

  it("an unknown scope is refused", () => {
    expect(reconcilePaidScope("scope_unknown", verification("scope_unknown"))).toEqual(refused("scope_not_found"));
  });

  it("the accept route still answers 409 for a scope that went live through reconcile", async () => {
    const { scopeId } = await paidScope(f);
    expect(reconcilePaidScope(scopeId, verification(scopeId)).kind).toBe("activated");
    const again = await acceptScope(f, scopeId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_decided", status: "active" });
  });
});
