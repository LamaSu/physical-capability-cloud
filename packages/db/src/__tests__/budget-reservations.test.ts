/**
 * R13 budget reservations (operator decision #2240, amended by #2301/#2302): the charter's required
 * negatives, against real SQLite. Covered:
 *   - two consumes, exactly one wins (across two connections too);
 *   - expired is refused;
 *   - principal, request, currency or payer A used for B is refused;
 *   - an obligation over the reservation is refused;
 *   - exact base units: never a float;
 *   - MC 9 child authority stays bounded.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../index.js";
import { BUDGET_RESERVATIONS_DDL, BudgetReservationStore, MAX_DEAL_PREIMAGE_BYTES, type IssueReservationInput } from "../repositories/budget-reservations.js";

const NOW = 1_900_000_000;
const PAYER = `0x${"11".repeat(20)}`;
/** A sealed deal's canonical preimage, and its digest: sha256(preimage) (amendment #3231, condition a). */
const sealedPair = (preimage: string) => ({ dealPreimage: preimage, dealDigest: `0x${createHash("sha256").update(preimage, "utf8").digest("hex")}` });
const PREIMAGE = '{"domain":"PCC:accepted-deal:v2","planId":"plan.resv-1"}';
const DIGEST = sealedPair(PREIMAGE).dealDigest;
const MAX_UINT256 = (1n << 256n) - 1n;

function fresh(): { sqlite: Database.Database; store: BudgetReservationStore } {
  const sqlite = new Database(":memory:");
  const store = new BudgetReservationStore(sqlite);
  store.ensureSchema();
  return { sqlite, store };
}

const issueInput = (over: Partial<IssueReservationInput> = {}): IssueReservationInput => ({
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  payerAddress: PAYER,
  currency: "USDC",
  maxAmountBaseUnits: 20_000_000n,
  purpose: "accept plan for req-42",
  requestId: "req-42",
  expiresAt: NOW + 3600,
  now: NOW,
  requestCeilingBaseUnits: 100_000_000n,
  ...over,
});

const consumeInput = (over: Partial<Parameters<BudgetReservationStore["consume"]>[0]> = {}) => ({
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  requestId: "req-42",
  currency: "USDC",
  payerAddresses: [PAYER],
  obligationBaseUnits: 9_750_000n,
  minUnitTier: 0,
  dealDigest: DIGEST,
  dealPreimage: PREIMAGE,
  now: NOW,
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("issue and read back: exact base units, never a float", () => {
  it("round-trips the uint256 maximum exactly, with the payer, floor and state", () => {
    const { store } = fresh();
    const r = store.issue(issueInput({ maxAmountBaseUnits: MAX_UINT256, requestCeilingBaseUnits: MAX_UINT256, minTier: 2 }));
    expect(r.ok).toBe(true);
    const back = store.findById("resv-1")!;
    expect(back.maxAmountBaseUnits).toBe(MAX_UINT256);
    expect(back).toMatchObject({ payerAddress: PAYER, minTier: 2, state: "issued", consumedDealDigest: null, parentReservationId: null });
    expect(store.findById("resv-404")).toBeNull();
  });

  it("refuses malformed input: zero, over uint256, a non-bigint amount, a bad clock, a past expiry, a bad tier, a duplicate id", () => {
    const { store } = fresh();
    const bad: Array<Partial<IssueReservationInput>> = [
      { maxAmountBaseUnits: 0n },
      { maxAmountBaseUnits: MAX_UINT256 + 1n },
      { maxAmountBaseUnits: 20 as unknown as bigint },
      { now: Number.NaN },
      { expiresAt: NOW },
      { minTier: 4 },
      { principal: "" },
      { requestCeilingBaseUnits: -1n },
    ];
    for (const b of bad) expect([b, store.issue(issueInput(b))]).toEqual([b, { ok: false, reason: "invalid-input" }]);
    expect(store.issue(issueInput()).ok).toBe(true);
    expect(store.issue(issueInput())).toEqual({ ok: false, reason: "duplicate-id" });
  });

  it("the request ceiling counts issued and consumed top-level reservations, exactly; expired and released ones free their share", () => {
    const { sqlite, store } = fresh();
    const ceiling = 30_000_000n;
    expect(store.issue(issueInput({ reservationId: "a", maxAmountBaseUnits: 20_000_000n, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    expect(store.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 10_000_001n, requestCeilingBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    expect(store.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 10_000_000n, requestCeilingBaseUnits: ceiling })).ok).toBe(true); // exactly at the ceiling
    expect(store.consume(consumeInput({ reservationId: "a" })).ok).toBe(true); // consumed still counts
    expect(store.issue(issueInput({ reservationId: "c", maxAmountBaseUnits: 1n, requestCeilingBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    sqlite.prepare("UPDATE budget_reservations SET state = 'released' WHERE id = 'b'").run();
    expect(store.issue(issueInput({ reservationId: "c", maxAmountBaseUnits: 10_000_000n, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    expect(store.issue(issueInput({ reservationId: "d", requestId: "req-other", maxAmountBaseUnits: 30_000_000n, requestCeilingBaseUnits: ceiling })).ok).toBe(true); // per request
  });

  it("an issued reservation past its expiry frees its share even before housekeeping marks it expired (it can never be consumed)", () => {
    const { store } = fresh();
    const ceiling = 20_000_000n;
    expect(store.issue(issueInput({ reservationId: "a", expiresAt: NOW + 10, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    expect(store.issue(issueInput({ reservationId: "b", now: NOW + 5, expiresAt: NOW + 100, requestCeilingBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    expect(store.issue(issueInput({ reservationId: "b", now: NOW + 10, expiresAt: NOW + 100, requestCeilingBaseUnits: ceiling })).ok).toBe(true); // a expired at NOW + 10
    expect(store.findById("a")!.state).toBe("issued"); // no housekeeping ran
    expect(store.consume(consumeInput({ reservationId: "a", now: NOW + 10 }))).toEqual({ ok: false, reason: "expired" });
  });
});

describe("the ceiling is exact at any magnitude (a float would round these)", () => {
  it("2^200 - 1 held, plus 1, fits a 2^200 ceiling exactly; plus 2 does not", () => {
    const { store } = fresh();
    const ceiling = 1n << 200n;
    expect(store.issue(issueInput({ reservationId: "a", maxAmountBaseUnits: ceiling - 1n, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    expect(store.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 2n, requestCeilingBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    expect(store.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 1n, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    const big = issueInput({ reservationId: "c", requestId: "req-big", maxAmountBaseUnits: ceiling - 1n, requestCeilingBaseUnits: ceiling });
    store.issue(big);
    expect(store.consume(consumeInput({ reservationId: "c", requestId: "req-big", obligationBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-reservation" });
  });
});

describe("consume: exactly once, and only by the principal, request, currency and payer it was issued for", () => {
  it("seals the digest once; a second consume is refused", () => {
    const { store } = fresh();
    store.issue(issueInput());
    const first = store.consume(consumeInput());
    expect(first.ok && first.reservation).toMatchObject({ state: "consumed", consumedDealDigest: DIGEST, consumedAt: NOW });
    expect(store.consume(consumeInput())).toEqual({ ok: false, reason: "not-issued" });
    expect(store.consume(consumeInput(sealedPair('{"another":"deal"}')))).toEqual({ ok: false, reason: "not-issued" });
    expect(store.findById("resv-1")!.consumedDealDigest).toBe(DIGEST); // the first seal stands
  });

  it("refuses A used for B: principal, request, currency, payer; and expired, over the maximum, below the floor, missing", () => {
    const { store } = fresh();
    store.issue(issueInput({ minTier: 2 }));
    const cases: Array<[Partial<ReturnType<typeof consumeInput>>, string]> = [
      [{ principal: "agent:someone-else" }, "wrong-principal"],
      [{ requestId: "req-other" }, "wrong-request"],
      [{ currency: "USDT" }, "wrong-currency"],
      [{ payerAddresses: [PAYER, `0x${"22".repeat(20)}`] }, "wrong-payer"],
      [{ now: NOW + 3600 }, "expired"],
      [{ obligationBaseUnits: 20_000_001n }, "over-reservation"],
      [{ minUnitTier: 1 }, "below-min-tier"],
      [{ reservationId: "resv-404" }, "not-found"],
      [{ dealDigest: "0xabc" }, "invalid-input"],
      [{ obligationBaseUnits: 0n }, "invalid-input"],
      [{ payerAddresses: [] }, "invalid-input"],
    ];
    for (const [over, reason] of cases) expect([over, store.consume(consumeInput({ minUnitTier: 2, ...over }))]).toEqual([over, { ok: false, reason }]);
    expect(store.findById("resv-1")!.state).toBe("issued"); // no refusal consumed anything
    expect(store.consume(consumeInput({ minUnitTier: 2, obligationBaseUnits: 20_000_000n, payerAddresses: [PAYER.toUpperCase().replace("0X", "0x")] })).ok).toBe(true); // exactly the maximum; payer hex case
  });

  it("two connections on one database: exactly one consume wins; while one holds the write lock the other cannot interleave", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "r13-"));
    dirs.push(dir);
    const file = join(dir, "r13.sqlite");
    const a = new Database(file);
    const b = new Database(file);
    a.pragma("journal_mode = WAL");
    b.pragma("busy_timeout = 0");
    const storeA = new BudgetReservationStore(a);
    const storeB = new BudgetReservationStore(b);
    storeA.ensureSchema();
    storeA.issue(issueInput());
    // While A holds the write lock (as its own consume would), B's consume cannot even begin.
    a.exec("BEGIN IMMEDIATE");
    expect(() => storeB.consume(consumeInput())).toThrow(/busy|locked/i);
    a.exec("ROLLBACK");
    expect(storeA.consume(consumeInput()).ok).toBe(true);
    expect(storeB.consume(consumeInput())).toEqual({ ok: false, reason: "not-issued" });
    a.close();
    b.close();
  });
});

describe("the sealed deal is stored as its digest's own preimage (amendment #3231, conditions #3235)", () => {
  it("(a) a preimage that does not hash to the digest is refused and nothing is written; a matching one is stored", () => {
    const { store } = fresh();
    store.issue(issueInput());
    expect(store.consume(consumeInput({ dealPreimage: PREIMAGE + " " }))).toEqual({ ok: false, reason: "deal-preimage-mismatch" });
    expect(store.consume(consumeInput({ dealDigest: sealedPair("other").dealDigest }))).toEqual({ ok: false, reason: "deal-preimage-mismatch" });
    expect(store.findById("resv-1")!.state).toBe("issued");
    expect(store.sealedDealPreimage("resv-1")).toBeNull();
    const upper = consumeInput({ dealDigest: DIGEST.toUpperCase().replace("0X", "0x") }); // hex case carries no meaning
    expect(store.consume(upper).ok).toBe(true);
    expect(store.sealedDealPreimage("resv-1")).toBe(PREIMAGE);
    expect(createHash("sha256").update(store.sealedDealPreimage("resv-1")!, "utf8").digest("hex")).toBe(store.findById("resv-1")!.consumedDealDigest!.slice(2));
  });

  it("(b) the stored bytes are never part of the reservation object; only the server-side reader returns them", () => {
    const { store } = fresh();
    store.issue(issueInput());
    store.consume(consumeInput());
    const r = store.findById("resv-1")!;
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("PCC:accepted-deal");
    expect(Object.keys(r)).not.toContain("consumedDealJson");
    expect(store.sealedDealPreimage("resv-404")).toBeNull();
  });

  it("(c) the size bound holds at write, in the store and in the table", () => {
    const { sqlite, store } = fresh();
    store.issue(issueInput());
    const big = "x".repeat(MAX_DEAL_PREIMAGE_BYTES + 1);
    expect(store.consume(consumeInput(sealedPair(big)))).toEqual({ ok: false, reason: "invalid-input" });
    const atBound = "y".repeat(MAX_DEAL_PREIMAGE_BYTES);
    expect(store.consume(consumeInput(sealedPair(atBound))).ok).toBe(true);
    expect(() => sqlite.prepare("UPDATE budget_reservations SET consumed_deal_json = ? WHERE id = 'resv-1'").run(big)).toThrow(/constraint/i);
  });
});

describe("the table's own constraints refuse what the store never writes", () => {
  it("rejects a non-canonical amount, an unknown state, a consumed row without a digest, a bad tier, half a parent binding", () => {
    const { sqlite } = fresh();
    const insert = (over: Record<string, unknown>) =>
      sqlite
        .prepare(
          `INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, min_tier,
             parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, consumed_deal_json, created_at)
           VALUES (@id, 'p', 'x', 'USDC', @amount, 'purpose', 'req', @minTier, @parent, @unit, 1, @state, @digest, @json, 0)`,
        )
        .run({ id: "r", amount: "10", minTier: null, parent: null, unit: null, state: "issued", digest: null, json: null, ...over });
    for (const bad of [
      { amount: "010" },
      { amount: "1.5" },
      { amount: "-1" },
      { amount: "1e6" },
      { amount: "1".repeat(79) },
      { state: "spent" },
      { state: "consumed", digest: null, json: PREIMAGE },
      { state: "consumed", digest: DIGEST, json: null },
      { state: "issued", digest: DIGEST },
      { state: "issued", json: PREIMAGE },
      { minTier: 4 },
      { parent: "p1", unit: null },
    ]) {
      expect(() => insert(bad), JSON.stringify(bad)).toThrow(/constraint/i);
    }
    expect(() => insert({})).not.toThrow();
  });
});

describe("MC 9: a child reservation is bounded by the parent unit it is carved from (#2301)", () => {
  const parentTerms = { reservationId: "resv-1", unit: "plan.resv-1:0xaa#0", operator: "0xAAaa", netBaseUnits: 6_000_000n, reclaimAt: NOW + 7200 };
  const child = (over: Partial<IssueReservationInput> = {}) =>
    // The operator funds its subcontract from its OWN wallet, never the parent payer's.
    issueInput({ reservationId: "child-1", principal: "0xaaaa", payerAddress: `0x${"aa".repeat(20)}`, requestId: "req-child", maxAmountBaseUnits: 4_000_000n, requestCeilingBaseUnits: 0n, parent: parentTerms, ...over });

  it("needs a consumed parent in the same currency, and only the parent unit's operator may hold it", () => {
    const { store } = fresh();
    expect(store.issue(child())).toEqual({ ok: false, reason: "parent-not-found" });
    store.issue(issueInput({ minTier: 2 }));
    expect(store.issue(child())).toEqual({ ok: false, reason: "parent-not-consumed" });
    store.consume(consumeInput({ minUnitTier: 2 }));
    expect(store.issue(child({ currency: "USDT" }))).toEqual({ ok: false, reason: "parent-currency-mismatch" });
    expect(store.issue(child({ principal: "agent:buyer-1" }))).toEqual({ ok: false, reason: "child-principal-not-parent-operator" });
    expect(store.issue(child({ payerAddress: PAYER.toUpperCase().replace("0X", "0x") }))).toEqual({ ok: false, reason: "child-payer-is-parent-payer" }); // never the parent payer's credentials
    const ok = store.issue(child({ minTier: 1 }));
    expect(ok.ok && ok.reservation).toMatchObject({ parentReservationId: "resv-1", parentUnit: parentTerms.unit, minTier: 2 }); // inherits max(parent, own)
  });

  it("all children of one unit fit its net n, and none outlives its reclaimAt; the request ceiling does not apply to a child", () => {
    const { store } = fresh();
    store.issue(issueInput());
    store.consume(consumeInput());
    expect(store.issue(child({ expiresAt: parentTerms.reclaimAt + 1 }))).toEqual({ ok: false, reason: "child-outlives-parent-unit" });
    expect(store.issue(child()).ok).toBe(true); // 4.0 of 6.0 (with a zero request ceiling)
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 2_000_001n }))).toEqual({ ok: false, reason: "over-parent-unit" });
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 2_000_000n })).ok).toBe(true); // exactly n
    expect(store.issue(child({ reservationId: "child-3", maxAmountBaseUnits: 1n, parent: { ...parentTerms, unit: "plan.resv-1:0xaa#1" } })).ok).toBe(true); // another unit
  });

  it("an expired child frees its share of the parent unit", () => {
    const { store } = fresh();
    store.issue(issueInput());
    store.consume(consumeInput());
    expect(store.issue(child({ maxAmountBaseUnits: 6_000_000n, expiresAt: NOW + 10 })).ok).toBe(true); // the whole unit
    expect(store.issue(child({ reservationId: "child-2", now: NOW + 5, maxAmountBaseUnits: 1n }))).toEqual({ ok: false, reason: "over-parent-unit" });
    expect(store.issue(child({ reservationId: "child-2", now: NOW + 10, maxAmountBaseUnits: 6_000_000n })).ok).toBe(true);
  });
});

describe("the gateway's runtime migration creates the table", () => {
  it("createStore(:memory:) runs the DDL, and it is idempotent", () => {
    const s = createStore({ dbPath: ":memory:", seed: false });
    const client = (s.db as unknown as { $client: Database.Database }).$client;
    expect(client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'budget_reservations'").get()).toEqual({ name: "budget_reservations" });
    expect(() => client.exec(BUDGET_RESERVATIONS_DDL)).not.toThrow();
    s.close();
  });
});
