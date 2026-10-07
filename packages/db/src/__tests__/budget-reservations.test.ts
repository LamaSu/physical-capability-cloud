/**
 * R13 budget reservations (operator decision #2240, amended by #2301/#2302/#3231): the charter's
 * required negatives, against real SQLite, plus round 2 (the operator's ChatGPT review of 0b8adda9):
 *   - two consumes, exactly one wins (across two connections too);
 *   - expired is refused, and expiry is DURABLE: skewed clocks cannot consume a released share (H2);
 *   - principal, request, currency or payer A used for B is refused, with the terms read FROM THE DEAL (M6);
 *   - only a real sealed deal is stored: canonical, for this reservation (M6);
 *   - exact base units: never a float;
 *   - MC 9 child authority is derived from the parent's stored sealed deal, never the caller (H1);
 *   - the table refuses what its invariants forbid, even from a direct writer (M5);
 *   - migration 0004 is the runtime DDL, and a table of another shape is refused (H3).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { acceptedDealPreimage, canonicalize, compileAcceptedPlan, type AcceptedPlanInput } from "@pcc/spec";
import { createStore } from "../index.js";
import {
  BUDGET_RESERVATIONS_DDL,
  BUDGET_RESERVATIONS_SCHEMA_VERSION,
  BudgetReservationStore,
  MAX_DEAL_PREIMAGE_BYTES,
  MAX_RESERVATION_LIFETIME_SEC,
  ensureBudgetReservationsSchema,
  type IssueReservationInput,
  type ParentUnitRef,
} from "../repositories/budget-reservations.js";

const NOW = 1_900_000_000;
const PAYER = `0x${"11".repeat(20)}`;
const CHILD_PAYER = `0x${"22".repeat(20)}`;
const OP = `0x${"aa".repeat(20)}`;
const OP_B = `0x${"bb".repeat(20)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const sha = (s: string) => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;
/** Bytes and their digest, sealed as a pair (amendment #3231, condition a), whether or not they are a deal. */
const sealedPair = (preimage: string) => ({ dealPreimage: preimage, dealDigest: sha(preimage) });

interface DealSpec {
  reservationId?: string;
  requestId?: string;
  currency?: string;
  payer?: string;
  /** One unit per gross, all by `operators[i]` (default OP). */
  grosses?: bigint[];
  operators?: string[];
  tier?: number;
  reclaimAt?: bigint;
}

/** A REAL sealed deal: compiled by #351's compiler, and the digest's own canonical preimage. */
function deal(o: DealSpec = {}): { dealPreimage: string; dealDigest: string } {
  const reservationId = o.reservationId ?? "resv-1";
  const requestId = o.requestId ?? "req-42";
  const currency = o.currency ?? "USDC";
  const tier = o.tier ?? 0;
  const grosses = o.grosses ?? [5_000_000n, 4_750_000n];
  const plan: AcceptedPlanInput = {
    planId: `plan.${reservationId}`,
    requestId,
    payer: (o.payer ?? PAYER) as `0x${string}`,
    currency,
    feeBps: 0,
    feeRecipient: `0x${"00".repeat(20)}`,
    reclaimAt: o.reclaimAt ?? BigInt(NOW + 7200),
    nodes: grosses.map((g, i) => {
      const operator = (o.operators?.[i] ?? OP) as `0x${string}`;
      return {
        nodeId: `n${i}`,
        capabilityId: `cap-${i}`,
        capabilityType: "document-printing",
        csd: "document-print-and-mail",
        tierKey: `tier${tier}`,
        operator,
        payoutAddress: operator,
        grossBaseUnits: g,
        matchedCapabilityDigest: `0x${"0c".repeat(32)}`,
        committedProgramHash: tier > 0 ? `0x${"d2".repeat(32)}` : null,
        evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }],
      };
    }),
    edges: [],
    reservation: { reservationId, requestId, currency, maxAmountBaseUnits: 10n ** 30n },
  };
  const r = compileAcceptedPlan(plan, { assertProgramForTier: () => ({ ok: true }) });
  if (!r.ok) throw new Error(`fixture does not compile: ${JSON.stringify(r.violations)}`);
  const { acceptedDealDigest, ...rest } = r.plan;
  return { dealPreimage: acceptedDealPreimage(rest), dealDigest: acceptedDealDigest };
}
const unitRef = (i: number, operator = OP, reservationId = "resv-1") => `plan.${reservationId}:${operator}#${i}`;

function fresh(start = NOW): { sqlite: Database.Database; store: BudgetReservationStore; at: (t: number) => void } {
  const sqlite = new Database(":memory:");
  let t = start;
  const store = new BudgetReservationStore(sqlite, { clock: () => t });
  store.ensureSchema();
  return { sqlite, store, at: (x) => (t = x) };
}

const issueInput = (over: Partial<IssueReservationInput> = {}): IssueReservationInput => ({
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  payerAddress: PAYER,
  currency: "USDC",
  maxAmountBaseUnits: 20_000_000n,
  purpose: "accept plan for req-42",
  requestId: "req-42",
  expiresInSec: 3600,
  requestCeilingBaseUnits: 100_000_000n,
  ...over,
});

const consumeInput = (o: DealSpec & { principal?: string } = {}, sealed = deal(o)) => ({
  reservationId: o.reservationId ?? "resv-1",
  principal: o.principal ?? "agent:buyer-1",
  ...sealed,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "r13-"));
  dirs.push(dir);
  return join(dir, "r13.sqlite");
}

describe("issue and read back: exact base units, never a float", () => {
  it("round-trips the uint256 maximum exactly, with the payer, floor, state and the store's own times", () => {
    const { store } = fresh();
    const r = store.issue(issueInput({ maxAmountBaseUnits: MAX_UINT256, requestCeilingBaseUnits: MAX_UINT256, minTier: 2 }));
    expect(r.ok).toBe(true);
    const back = store.findById("resv-1")!;
    expect(back.maxAmountBaseUnits).toBe(MAX_UINT256);
    expect(back).toMatchObject({ payerAddress: PAYER, minTier: 2, state: "issued", consumedDealDigest: null, parentReservationId: null, createdAt: NOW, expiresAt: NOW + 3600 });
    expect(store.findById("resv-404")).toBeNull();
  });

  it("refuses malformed input: zero, over uint256, a non-bigint amount, a bad lifetime, a bad tier, a bad parent ref, a duplicate id", () => {
    const { store } = fresh();
    const bad: Array<Partial<IssueReservationInput>> = [
      { maxAmountBaseUnits: 0n },
      { maxAmountBaseUnits: MAX_UINT256 + 1n },
      { maxAmountBaseUnits: 20 as unknown as bigint },
      { expiresInSec: 0 },
      { expiresInSec: -1 },
      { expiresInSec: 1.5 },
      { expiresInSec: MAX_RESERVATION_LIFETIME_SEC + 1 },
      { minTier: 4 },
      { principal: "" },
      { requestCeilingBaseUnits: -1n },
      { parent: { reservationId: "resv-0", unit: "no-hash-sign" } },
      { parent: { reservationId: "", unit: unitRef(0) } },
    ];
    for (const b of bad) expect([b, store.issue(issueInput(b))]).toEqual([b, { ok: false, reason: "invalid-input" }]);
    expect(store.issue(issueInput()).ok).toBe(true);
    expect(store.issue(issueInput())).toEqual({ ok: false, reason: "duplicate-id" });
  });

  it("a clock that is not unix seconds is a wiring fault, never a reservation", () => {
    const sqlite = new Database(":memory:");
    const store = new BudgetReservationStore(sqlite, { clock: () => Number.NaN });
    store.ensureSchema();
    expect(() => store.issue(issueInput())).toThrow(TypeError);
    expect(sqlite.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 0 });
  });

  it("the request ceiling counts issued and consumed reservations, exactly; expired and released ones free their share", () => {
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

  it("an expired reservation frees its share, and the freeing is DURABLE: it is marked expired and can never be consumed (H2)", () => {
    const { store, at } = fresh();
    const ceiling = 20_000_000n;
    expect(store.issue(issueInput({ reservationId: "a", expiresInSec: 10, requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    at(NOW + 5);
    expect(store.issue(issueInput({ reservationId: "b", requestCeilingBaseUnits: ceiling }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    expect(store.findById("a")!.state).toBe("issued"); // a refusal changes nothing that it did not rely on
    at(NOW + 10);
    expect(store.issue(issueInput({ reservationId: "b", requestCeilingBaseUnits: ceiling })).ok).toBe(true);
    expect(store.findById("a")!.state).toBe("expired"); // released for b, so recorded
    at(NOW); // even a clock that runs backwards cannot bring it back
    expect(store.consume(consumeInput({ reservationId: "a" }))).toEqual({ ok: false, reason: "expired" });
  });

  it("a consume that finds its reservation expired records it too", () => {
    const { store, at } = fresh();
    store.issue(issueInput({ expiresInSec: 10 }));
    at(NOW + 10);
    expect(store.consume(consumeInput())).toEqual({ ok: false, reason: "expired" });
    expect(store.findById("resv-1")!.state).toBe("expired");
    at(NOW + 1);
    expect(store.consume(consumeInput())).toEqual({ ok: false, reason: "expired" });
  });
});

describe("H2: two connections with skewed clocks cannot spend one ceiling twice", () => {
  function pair(file: string, clockA: number, clockB: number) {
    const a = new Database(file);
    const b = new Database(file);
    a.pragma("journal_mode = WAL");
    b.pragma("busy_timeout = 1000");
    return {
      a,
      b,
      issuer: new BudgetReservationStore(a, { clock: () => clockA }),
      consumer: new BudgetReservationStore(b, { clock: () => clockB }),
    };
  }

  it("the reviewer's interleaving: A expires at 100; an issuer at 101 re-issues its share as B; a consumer at 99 cannot consume A", () => {
    const file = tempFile();
    const seed = new Database(file);
    const seeding = new BudgetReservationStore(seed, { clock: () => NOW });
    seeding.ensureSchema();
    expect(seeding.issue(issueInput({ reservationId: "a", maxAmountBaseUnits: 10_000_000n, expiresInSec: 100, requestCeilingBaseUnits: 10_000_000n })).ok).toBe(true);
    seed.close();
    const { a, b, issuer, consumer } = pair(file, NOW + 101, NOW + 99);
    expect(issuer.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 10_000_000n, requestCeilingBaseUnits: 10_000_000n })).ok).toBe(true);
    expect(consumer.consume(consumeInput({ reservationId: "a" }))).toEqual({ ok: false, reason: "expired" });
    expect(consumer.consume(consumeInput({ reservationId: "b" })).ok).toBe(true);
    const consumed = b.prepare("SELECT sum(CAST(max_amount_base_units AS INTEGER)) AS s FROM budget_reservations WHERE state = 'consumed'").get() as { s: number };
    expect(consumed.s).toBe(10_000_000); // one ceiling, spent once
    a.close();
    b.close();
  });

  it("the other order: the lagging consumer wins first, so the share stays held and the re-issue is refused", () => {
    const file = tempFile();
    const seed = new Database(file);
    const seeding = new BudgetReservationStore(seed, { clock: () => NOW });
    seeding.ensureSchema();
    seeding.issue(issueInput({ reservationId: "a", maxAmountBaseUnits: 10_000_000n, expiresInSec: 100, requestCeilingBaseUnits: 10_000_000n }));
    seed.close();
    const { a, b, issuer, consumer } = pair(file, NOW + 101, NOW + 99);
    expect(consumer.consume(consumeInput({ reservationId: "a" })).ok).toBe(true);
    expect(issuer.issue(issueInput({ reservationId: "b", maxAmountBaseUnits: 10_000_000n, requestCeilingBaseUnits: 10_000_000n }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    a.close();
    b.close();
  });

  it("siblings too: a child whose share of the unit was re-issued cannot be consumed by a lagging clock", () => {
    const file = tempFile();
    const seed = new Database(file);
    const seeding = new BudgetReservationStore(seed, { clock: () => NOW });
    seeding.ensureSchema();
    seeding.issue(issueInput());
    expect(seeding.consume(consumeInput()).ok).toBe(true);
    const childOf = (id: string, amount: bigint, ttl: number) =>
      issueInput({ reservationId: id, principal: OP, payerAddress: CHILD_PAYER, requestId: "req-child", maxAmountBaseUnits: amount, expiresInSec: ttl, parent: { reservationId: "resv-1", unit: unitRef(0) } });
    expect(seeding.issue(childOf("child-1", 5_000_000n, 50)).ok).toBe(true); // the whole unit (n = 5.0)
    seed.close();
    const { a, b, issuer, consumer } = pair(file, NOW + 51, NOW + 49);
    expect(issuer.issue(childOf("child-2", 5_000_000n, 60)).ok).toBe(true);
    expect(issuer.findById("child-1")!.state).toBe("expired");
    const childDeal = consumeInput({ reservationId: "child-1", requestId: "req-child", payer: CHILD_PAYER, grosses: [5_000_000n], operators: [OP_B], principal: OP });
    expect(consumer.consume(childDeal)).toEqual({ ok: false, reason: "expired" });
    a.close();
    b.close();
  });
});

describe("consume: exactly once, only for a real sealed deal, with the terms taken from the deal (M6)", () => {
  it("seals the deal once; a second consume is refused", () => {
    const { store } = fresh();
    store.issue(issueInput());
    const sealed = deal();
    const first = store.consume(consumeInput({}, sealed));
    expect(first.ok && first.reservation).toMatchObject({ state: "consumed", consumedDealDigest: sealed.dealDigest, consumedAt: NOW });
    expect(store.consume(consumeInput({}, sealed))).toEqual({ ok: false, reason: "not-issued" });
    expect(store.consume(consumeInput({ grosses: [1_000_000n] }))).toEqual({ ok: false, reason: "not-issued" });
    expect(store.findById("resv-1")!.consumedDealDigest).toBe(sealed.dealDigest); // the first seal stands
  });

  it("the reviewer's case: bytes that hash right but are not a deal are refused, and nothing is written", () => {
    const { store } = fresh();
    store.issue(issueInput());
    for (const bytes of ["y".repeat(MAX_DEAL_PREIMAGE_BYTES), '{"domain":"PCC:accepted-deal:v2","planId":"plan.resv-1"}', `${deal().dealPreimage} `]) {
      expect(store.consume({ reservationId: "resv-1", principal: "agent:buyer-1", ...sealedPair(bytes) })).toEqual({ ok: false, reason: "invalid-deal" });
    }
    expect(store.findById("resv-1")!.state).toBe("issued");
    expect(store.sealedDealPreimage("resv-1")).toBeNull();
  });

  it("a real deal for ANOTHER reservation is refused", () => {
    const { store } = fresh();
    store.issue(issueInput());
    store.issue(issueInput({ reservationId: "resv-2" }));
    expect(store.consume({ ...consumeInput({ reservationId: "resv-2" }), reservationId: "resv-1" })).toEqual({ ok: false, reason: "wrong-reservation" });
  });

  it("A used for B: principal, and the deal's request, currency, payer, obligation and tier, each against the row", () => {
    const { store } = fresh();
    store.issue(issueInput({ minTier: 2 }));
    store.issue(issueInput({ reservationId: "resv-usdt", currency: "USDT" }));
    const cases: Array<[DealSpec & { principal?: string }, string]> = [
      [{ tier: 2, principal: "agent:someone-else" }, "wrong-principal"],
      [{ tier: 2, requestId: "req-other" }, "wrong-request"],
      [{ tier: 2, payer: CHILD_PAYER }, "wrong-payer"],
      [{ tier: 2, grosses: [20_000_000n, 1n + 5n] }, "over-reservation"],
      [{ tier: 1 }, "below-min-tier"],
      [{ tier: 2, reservationId: "resv-404" }, "not-found"],
    ];
    for (const [spec, reason] of cases) expect([spec, store.consume(consumeInput(spec))]).toEqual([spec, { ok: false, reason }]);
    expect(store.consume(consumeInput({ reservationId: "resv-usdt" }))).toEqual({ ok: false, reason: "wrong-currency" });
    expect(store.findById("resv-1")!.state).toBe("issued"); // no refusal consumed anything
    expect(store.consume(consumeInput({ tier: 2, grosses: [15_000_000n, 5_000_000n] })).ok).toBe(true); // exactly the maximum, at the floor
  });

  it("malformed consume input is refused before anything is read", () => {
    const { store } = fresh();
    store.issue(issueInput());
    const ok = consumeInput();
    for (const bad of [{ dealDigest: "0xabc" }, { dealDigest: 42 }, { dealPreimage: 42 }, { principal: "" }, { reservationId: " " }]) {
      expect(store.consume({ ...ok, ...(bad as object) } as typeof ok)).toEqual({ ok: false, reason: "invalid-input" });
    }
    expect(store.consume({ ...ok, dealPreimage: "x".repeat(MAX_DEAL_PREIMAGE_BYTES + 1) })).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("two connections on one database: exactly one consume wins; while one holds the write lock the other cannot interleave", () => {
    const file = tempFile();
    const a = new Database(file);
    const b = new Database(file);
    a.pragma("journal_mode = WAL");
    b.pragma("busy_timeout = 0");
    const storeA = new BudgetReservationStore(a, { clock: () => NOW });
    const storeB = new BudgetReservationStore(b, { clock: () => NOW });
    storeA.ensureSchema();
    storeA.issue(issueInput());
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
  it("(a) a preimage that does not hash to the digest is refused; a matching one is stored and hashes to the sealed digest", () => {
    const { store } = fresh();
    store.issue(issueInput());
    const sealed = deal();
    expect(store.consume({ ...consumeInput({}, sealed), dealDigest: deal({ grosses: [7_000_000n] }).dealDigest })).toEqual({ ok: false, reason: "deal-preimage-mismatch" });
    expect(store.findById("resv-1")!.state).toBe("issued");
    const upper = { ...consumeInput({}, sealed), dealDigest: sealed.dealDigest.toUpperCase().replace("0X", "0x") }; // hex case carries no meaning
    expect(store.consume(upper).ok).toBe(true);
    expect(store.sealedDealPreimage("resv-1")).toBe(sealed.dealPreimage);
    expect(sha(store.sealedDealPreimage("resv-1")!)).toBe(store.findById("resv-1")!.consumedDealDigest);
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

  it("(M5) the trusted reader re-checks the stored bytes against the stored digest: a mismatch is a fault, never data", () => {
    const { sqlite, store } = fresh();
    store.issue(issueInput());
    store.consume(consumeInput());
    // A direct writer (the guard trigger removed) swaps the stored deal for another real deal.
    sqlite.exec("DROP TRIGGER budget_reservations_update_guard");
    sqlite.prepare("UPDATE budget_reservations SET consumed_deal_json = ? WHERE id = 'resv-1'").run(deal({ grosses: [1_000_000n] }).dealPreimage);
    expect(() => store.sealedDealPreimage("resv-1")).toThrow(/does not hash/);
    const child = issueInput({ reservationId: "child-1", principal: OP, payerAddress: CHILD_PAYER, requestId: "req-child", maxAmountBaseUnits: 1n, parent: { reservationId: "resv-1", unit: unitRef(0) } });
    expect(store.issue(child)).toEqual({ ok: false, reason: "parent-deal-corrupt" });
    // Bytes and digest swapped TOGETHER for another reservation's real deal: they hash right, but it is not this reservation's deal.
    const other = deal({ reservationId: "resv-2" });
    sqlite.prepare("UPDATE budget_reservations SET consumed_deal_json = ?, consumed_deal_digest = ? WHERE id = 'resv-1'").run(other.dealPreimage, other.dealDigest);
    expect(() => store.sealedDealPreimage("resv-1")).toThrow(/not this reservation's deal/);
    expect(store.issue(child)).toEqual({ ok: false, reason: "parent-deal-corrupt" });
  });
});

describe("MC 9: a child's terms come from the parent's SEALED deal, inside the store (H1)", () => {
  const PARENT: ParentUnitRef = { reservationId: "resv-1", unit: unitRef(0) }; // n0: g = n = 5.0 USDC
  const child = (over: Partial<IssueReservationInput> = {}) =>
    // The operator funds its subcontract from its OWN wallet, never the parent payer's.
    issueInput({ reservationId: "child-1", principal: OP, payerAddress: CHILD_PAYER, requestId: "req-child", maxAmountBaseUnits: 3_000_000n, parent: PARENT, ...over });
  function sealedParent(minTier?: number) {
    const f = fresh();
    f.store.issue(issueInput(minTier === undefined ? {} : { minTier }));
    expect(f.store.consume(consumeInput(minTier === undefined ? {} : { tier: minTier })).ok).toBe(true);
    return f;
  }

  it("the reviewer's input: a caller naming its own operator, net and reclaim time for an invented unit gets nothing", () => {
    const { store } = sealedParent();
    const forged = { reservationId: "resv-1", unit: "invented#0", operator: "agent:attacker", netBaseUnits: MAX_UINT256, reclaimAt: 9_999_999_999 } as unknown as ParentUnitRef;
    expect(store.issue(child({ principal: "agent:attacker", parent: forged, maxAmountBaseUnits: 10n ** 70n, requestCeilingBaseUnits: MAX_UINT256 }))).toEqual({
      ok: false,
      reason: "parent-unit-not-found",
    });
    const realUnitForged = { ...forged, unit: unitRef(0) } as unknown as ParentUnitRef;
    expect(store.issue(child({ principal: "agent:attacker", parent: realUnitForged, requestCeilingBaseUnits: MAX_UINT256 }))).toEqual({
      ok: false,
      reason: "child-principal-not-parent-operator",
    });
    expect(store.issue(child({ parent: { reservationId: "resv-1", unit: unitRef(7) } }))).toEqual({ ok: false, reason: "parent-unit-not-found" });
    expect(store.issue(child({ parent: { reservationId: "resv-1", unit: unitRef(0, OP_B) } }))).toEqual({ ok: false, reason: "parent-unit-not-found" });
  });

  it("needs a consumed parent in the same currency; only the unit's operator may hold it, never with the parent payer's wallet", () => {
    const { store } = fresh();
    expect(store.issue(child())).toEqual({ ok: false, reason: "parent-not-found" });
    store.issue(issueInput({ minTier: 2 }));
    expect(store.issue(child())).toEqual({ ok: false, reason: "parent-not-consumed" });
    expect(store.consume(consumeInput({ tier: 2 })).ok).toBe(true);
    expect(store.issue(child({ principal: "agent:buyer-1" }))).toEqual({ ok: false, reason: "child-principal-not-parent-operator" });
    expect(store.issue(child({ currency: "USDT" }))).toEqual({ ok: false, reason: "parent-currency-mismatch" });
    expect(store.issue(child({ payerAddress: PAYER.toUpperCase().replace("0X", "0x") }))).toEqual({ ok: false, reason: "child-payer-is-parent-payer" });
    const ok = store.issue(child({ principal: OP.toUpperCase().replace("0X", "0x"), minTier: 1 }));
    expect(ok.ok && ok.reservation).toMatchObject({ parentReservationId: "resv-1", parentUnit: unitRef(0), minTier: 2 }); // inherits max(parent, own)
  });

  it("all children of one unit fit its net n FROM THE DEAL, and none outlives its reclaimAt FROM THE DEAL", () => {
    const { store } = sealedParent();
    expect(store.issue(child({ expiresInSec: 7201 }))).toEqual({ ok: false, reason: "child-outlives-parent-unit" }); // reclaimAt = NOW + 7200
    expect(store.issue(child({ expiresInSec: 7200 })).ok).toBe(true); // 3.0 of 5.0, ending exactly at reclaimAt
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 2_000_001n }))).toEqual({ ok: false, reason: "over-parent-unit" });
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 2_000_000n })).ok).toBe(true); // exactly n
    expect(store.issue(child({ reservationId: "child-3", maxAmountBaseUnits: 4_750_000n, parent: { reservationId: "resv-1", unit: unitRef(1) } })).ok).toBe(true); // the other unit: n = 4.75
  });

  it("a child fits its own request's ceiling too (it no longer skips it)", () => {
    const { store } = sealedParent();
    expect(store.issue(child({ requestCeilingBaseUnits: 2_999_999n }))).toEqual({ ok: false, reason: "over-request-ceiling" });
    expect(store.issue(child({ requestCeilingBaseUnits: 3_000_000n })).ok).toBe(true);
  });

  it("an expired child frees its share of the parent unit, durably", () => {
    const { store, at } = sealedParent();
    expect(store.issue(child({ maxAmountBaseUnits: 5_000_000n, expiresInSec: 10 })).ok).toBe(true); // the whole unit
    at(NOW + 5);
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 1n }))).toEqual({ ok: false, reason: "over-parent-unit" });
    at(NOW + 10);
    expect(store.issue(child({ reservationId: "child-2", maxAmountBaseUnits: 5_000_000n })).ok).toBe(true);
    expect(store.findById("child-1")!.state).toBe("expired");
  });

  it("siblings under DIFFERENT requests: the unit's own sweep, not the request's, releases the expired sibling", () => {
    const { store, at } = sealedParent();
    expect(store.issue(child({ requestId: "req-child-a", maxAmountBaseUnits: 5_000_000n, expiresInSec: 10 })).ok).toBe(true);
    at(NOW + 10);
    expect(store.issue(child({ reservationId: "child-2", requestId: "req-child-b", maxAmountBaseUnits: 5_000_000n })).ok).toBe(true);
    expect(store.findById("child-1")!.state).toBe("expired");
  });
});

describe("M5: the table refuses what its invariants forbid, even from a direct writer", () => {
  const insert = (sqlite: Database.Database, over: Record<string, unknown>) =>
    sqlite
      .prepare(
        `INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, min_tier,
           parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, consumed_deal_json, created_at, consumed_at)
         VALUES (@id, 'p', 'x', 'USDC', @amount, 'purpose', 'req', @minTier, @parent, @unit, @expires, @state, @digest, @json, @created, @consumedAt)`,
      )
      .run({ id: "r", amount: "10", minTier: null, parent: null, unit: null, expires: 1, state: "issued", digest: null, json: null, created: 0, consumedAt: null, ...over });
  const REFUSED = /constraint|budget_reservations:/i;

  it("inserts: a zero, non-canonical or over-uint256 amount, a non-issued state, an expiry not after creation, a bad tier, half a parent, an unconsumed parent", () => {
    const { sqlite } = fresh();
    for (const bad of [
      { amount: "0" },
      { amount: "010" },
      { amount: "1.5" },
      { amount: "-1" },
      { amount: "1e6" },
      { amount: (MAX_UINT256 + 1n).toString() },
      { amount: "1".repeat(79) },
      { state: "consumed", digest: `0x${"ab".repeat(32)}`, json: "{}", consumedAt: 1 },
      { state: "expired" },
      { state: "spent" },
      { expires: 0 },
      { expires: 1.5 },
      { minTier: 4 },
      { minTier: 1.5 },
      { parent: "p1", unit: null },
      { parent: "r0", unit: "u#0" },
    ]) {
      expect(() => insert(sqlite, bad), JSON.stringify(bad)).toThrow(REFUSED);
    }
    expect(() => insert(sqlite, { amount: MAX_UINT256.toString() })).not.toThrow(); // exactly uint256
  });

  it("updates: the reviewer's sequence, consumed without its time, a changed term, and deletes are all refused", () => {
    const { sqlite } = fresh();
    insert(sqlite, { id: "r1", expires: 10 });
    const digest = `0x${"ab".repeat(32)}`;
    expect(() => sqlite.prepare("UPDATE budget_reservations SET state = 'consumed', consumed_deal_digest = ?, consumed_deal_json = '{}' WHERE id = 'r1'").run(digest)).toThrow(REFUSED); // no consumed_at
    expect(() => sqlite.prepare("UPDATE budget_reservations SET state = 'consumed', consumed_deal_digest = ?, consumed_deal_json = '{}', consumed_at = 1 WHERE id = 'r1'").run(digest.toUpperCase())).toThrow(REFUSED); // digest spelling
    sqlite.prepare("UPDATE budget_reservations SET state = 'consumed', consumed_deal_digest = ?, consumed_deal_json = '{}', consumed_at = 1 WHERE id = 'r1'").run(digest); // SQL has no sha256: the readers check that
    expect(() => sqlite.prepare("UPDATE budget_reservations SET state = 'issued', consumed_deal_digest = NULL, consumed_deal_json = NULL, consumed_at = NULL WHERE id = 'r1'").run()).toThrow(REFUSED);
    expect(() => sqlite.prepare("UPDATE budget_reservations SET consumed_deal_json = '{ }' WHERE id = 'r1'").run()).toThrow(REFUSED);
    insert(sqlite, { id: "r2", expires: 10 });
    for (const set of ["max_amount_base_units = '11'", "principal = 'q'", "payer_address = 'y'", "request_id = 'other'", "expires_at = 99", "min_tier = 0", "created_at = 1"]) {
      expect(() => sqlite.prepare(`UPDATE budget_reservations SET ${set} WHERE id = 'r2'`).run(), set).toThrow(REFUSED);
    }
    expect(() => sqlite.prepare("UPDATE budget_reservations SET state = 'issued' WHERE id = 'r2'").run()).toThrow(REFUSED);
    for (const id of ["r1", "r2"]) expect(() => sqlite.prepare("DELETE FROM budget_reservations WHERE id = ?").run(id)).toThrow(REFUSED);
    expect(sqlite.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 2 });
  });
});

describe("H3: migration 0004 is the runtime DDL, and a table of another shape is refused", () => {
  const SQL_FILE = fileURLToPath(new URL("../migrations/0004_budget_reservations.sql", import.meta.url));
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  /** The 0b8adda9 migration: no consumed_deal_json (the reviewer's H3). */
  const OLD_0004 = `CREATE TABLE IF NOT EXISTS budget_reservations (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, payer_address TEXT NOT NULL, currency TEXT NOT NULL,
    max_amount_base_units TEXT NOT NULL, purpose TEXT NOT NULL, request_id TEXT NOT NULL, job_binding TEXT,
    min_tier INTEGER CHECK (min_tier IS NULL OR min_tier BETWEEN 0 AND 3), parent_reservation_id TEXT, parent_unit TEXT,
    expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'released')),
    consumed_deal_digest TEXT, created_at INTEGER NOT NULL, consumed_at INTEGER,
    CHECK ((state = 'consumed') = (consumed_deal_digest IS NOT NULL)), CHECK ((parent_reservation_id IS NULL) = (parent_unit IS NULL)));`;

  it("0004_budget_reservations.sql is BUDGET_RESERVATIONS_DDL, statement for statement", () => {
    const file = readFileSync(SQL_FILE, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(collapse(file)).toBe(collapse(BUDGET_RESERVATIONS_DDL));
  });

  it("the reviewer's path: 0004 applied first, then the runtime migration, then a real consume", () => {
    const file = tempFile();
    const pre = new Database(file);
    pre.exec(readFileSync(SQL_FILE, "utf8"));
    pre.close();
    const s = createStore({ dbPath: file, seed: false });
    const client = (s.db as unknown as { $client: Database.Database }).$client;
    const store = new BudgetReservationStore(client, { clock: () => NOW });
    expect(store.issue(issueInput()).ok).toBe(true);
    expect(store.consume(consumeInput()).ok).toBe(true);
    expect(store.sealedDealPreimage("resv-1")).toBe(deal().dealPreimage);
    s.close();
  });

  it("an older, EMPTY table is rebuilt with the current definition; one that holds rows stops the boot", () => {
    const empty = new Database(":memory:");
    empty.exec(OLD_0004);
    ensureBudgetReservationsSchema(empty);
    const cols = (empty.prepare("PRAGMA table_info(budget_reservations)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("consumed_deal_json");
    const store = new BudgetReservationStore(empty, { clock: () => NOW });
    expect(store.issue(issueInput()).ok && store.consume(consumeInput()).ok).toBe(true);

    const held = new Database(":memory:");
    held.exec(OLD_0004);
    held.prepare("INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, expires_at, state, created_at) VALUES ('x', 'p', 'w', 'USDC', '1', 'p', 'r', 2, 'issued', 1)").run();
    expect(() => ensureBudgetReservationsSchema(held)).toThrow(/holds rows but its recorded schema version is missing/);
    expect(held.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 1 }); // nothing dropped
  });

  // Pack 92 (MEDIUM): the reviewer's reproduction. Run directly against an existing older table, the DDL used
  // to stamp it with the current version, and the guarded path then trusted the false record.
  const versionOf = (db: Database.Database): unknown =>
    (db.prepare("SELECT version FROM pcc_schema_versions WHERE object = 'budget_reservations'").get() as { version: unknown } | undefined)?.version;
  it.each([
    ["BUDGET_RESERVATIONS_DDL", () => BUDGET_RESERVATIONS_DDL],
    ["migration 0004", () => readFileSync(SQL_FILE, "utf8")],
  ])("pack 92 MEDIUM: %s run directly on an existing, populated older table certifies nothing, and the boot still refuses it", (_label, ddl) => {
    const held = new Database(":memory:");
    held.exec(OLD_0004);
    held.prepare("INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, expires_at, state, created_at) VALUES ('x', 'p', 'w', 'USDC', '1', 'p', 'r', 2, 'issued', 1)").run();
    held.exec(ddl());
    expect(versionOf(held)).toBeUndefined();
    const cols = (held.prepare("PRAGMA table_info(budget_reservations)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("consumed_deal_json");
    expect(() => ensureBudgetReservationsSchema(held)).toThrow(/holds rows but its recorded schema version is missing/);
    expect(held.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 1 });
  });

  it("pack 92 MEDIUM: a v1 table (the same column names, id nullable) recorded as v1 is never re-stamped v2 by the DDL", () => {
    const v1 = new Database(":memory:");
    v1.exec(BUDGET_RESERVATIONS_DDL.replace("id TEXT NOT NULL PRIMARY KEY", "id TEXT PRIMARY KEY"));
    v1.exec("UPDATE pcc_schema_versions SET version = 1 WHERE object = 'budget_reservations'");
    v1.prepare("INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, expires_at, state, created_at) VALUES ('x', 'p', 'w', 'USDC', '1', 'p', 'r', 2, 'issued', 1)").run();
    v1.exec(BUDGET_RESERVATIONS_DDL);
    expect(versionOf(v1)).toBe(1);
    expect(() => ensureBudgetReservationsSchema(v1)).toThrow(/holds rows but its recorded schema version is 1/);
  });

  // Pack 252 (MEDIUM): SQLite resolves table names case-insensitively, so a table named with other letter
  // case IS budget_reservations to every statement. The presence checks must see it too.
  const CASE_VARIANT_V1 = BUDGET_RESERVATIONS_DDL.replace("id TEXT NOT NULL PRIMARY KEY", "id TEXT PRIMARY KEY").replace(
    "CREATE TABLE IF NOT EXISTS budget_reservations (",
    "CREATE TABLE IF NOT EXISTS Budget_Reservations (",
  );
  function caseVariantV1(rows: number): Database.Database {
    const db = new Database(":memory:");
    db.exec(CASE_VARIANT_V1);
    db.exec("UPDATE pcc_schema_versions SET version = 1 WHERE object = 'budget_reservations'");
    for (let i = 0; i < rows; i++) {
      db.prepare("INSERT INTO Budget_Reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, expires_at, state, created_at) VALUES (?, 'p', 'w', 'USDC', '1', 'p', 'r', 2, 'issued', 1)").run(`x${i}`);
    }
    return db;
  }
  it.each([
    ["BUDGET_RESERVATIONS_DDL", () => BUDGET_RESERVATIONS_DDL],
    ["migration 0004", () => readFileSync(SQL_FILE, "utf8")],
  ])("pack 252 MEDIUM: %s run on a case-variant v1 table (Budget_Reservations) recorded as v1 never re-stamps it v2", (_label, ddl) => {
    const db = caseVariantV1(1);
    expect(versionOf(db)).toBe(1);
    db.exec(ddl());
    expect(versionOf(db)).toBe(1);
  });

  it("pack 252 MEDIUM: the guarded path sees a case-variant table: one holding rows stops the boot, an empty one is rebuilt", () => {
    const held = caseVariantV1(1);
    expect(() => ensureBudgetReservationsSchema(held)).toThrow(/holds rows but its recorded schema version is 1/);
    expect(held.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 1 });

    const empty = caseVariantV1(0);
    ensureBudgetReservationsSchema(empty);
    const id = (empty.prepare("PRAGMA table_info(budget_reservations)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "id");
    expect(id?.notnull).toBe(1);
    expect(versionOf(empty)).toBe(BUDGET_RESERVATIONS_SCHEMA_VERSION);
  });

  it("pack 252 MEDIUM: a case-variant version table (PCC_Schema_Versions) holding the current record is read, so a current store still boots", () => {
    const db = new Database(":memory:");
    db.exec(BUDGET_RESERVATIONS_DDL.replace("CREATE TABLE IF NOT EXISTS pcc_schema_versions", "CREATE TABLE IF NOT EXISTS PCC_Schema_Versions"));
    expect(versionOf(db)).toBe(BUDGET_RESERVATIONS_SCHEMA_VERSION);
    new BudgetReservationStore(db, { clock: () => NOW }).issue(issueInput());
    expect(() => ensureBudgetReservationsSchema(db)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM budget_reservations").get()).toEqual({ n: 1 });
  });

  it("pack 92 MEDIUM: the run that creates the table records its version, and a later run keeps that record", () => {
    const db = new Database(":memory:");
    db.exec(BUDGET_RESERVATIONS_DDL);
    expect(versionOf(db)).toBe(BUDGET_RESERVATIONS_SCHEMA_VERSION);
    db.exec(BUDGET_RESERVATIONS_DDL);
    expect(versionOf(db)).toBe(BUDGET_RESERVATIONS_SCHEMA_VERSION);
    expect(db.prepare("SELECT count(*) AS n FROM pcc_schema_versions").get()).toEqual({ n: 1 });
  });

  it("createStore(:memory:) creates the table and its guards, and running the migration again changes nothing", () => {
    const s = createStore({ dbPath: ":memory:", seed: false });
    const client = (s.db as unknown as { $client: Database.Database }).$client;
    const names = (client.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'budget_reservations' AND type IN ('table', 'trigger') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["budget_reservations", "budget_reservations_delete_guard", "budget_reservations_insert_guard", "budget_reservations_update_guard"]);
    expect(() => ensureBudgetReservationsSchema(client)).not.toThrow();
    expect(() => client.exec(BUDGET_RESERVATIONS_DDL)).not.toThrow();
    s.close();
  });
});

describe("astra, round 2 of R13 (ac3db658): each finding reproduced first, then fixed", () => {
  const PARENT: ParentUnitRef = { reservationId: "resv-1", unit: unitRef(0) }; // unit n0: n = 5.0 USDC
  function sealedParent() {
    const f = fresh();
    f.store.issue(issueInput());
    expect(f.store.consume(consumeInput()).ok).toBe(true);
    return f;
  }
  const childInput = (over: Partial<IssueReservationInput> = {}) =>
    issueInput({ reservationId: "child-1", principal: OP, payerAddress: CHILD_PAYER, requestId: "req-child", maxAmountBaseUnits: 3_000_000n, parent: PARENT, ...over });

  it("A: issue reads the amount ONCE: a value that checks as 1 cannot be inserted as 100 USDC (astra's counterexample)", () => {
    const { store } = sealedParent();
    let reads = 0;
    const input = childInput({ requestCeilingBaseUnits: 10_000_000n });
    Object.defineProperty(input, "maxAmountBaseUnits", { enumerable: true, get: () => (++reads <= 3 ? 1n : 100_000_000n) });
    const r = store.issue(input);
    expect(reads).toBe(1);
    expect(r.ok && r.reservation.maxAmountBaseUnits).toBe(1n); // the ONE value that was checked
  });

  it("A: issue reads the nested parent reference ONCE", () => {
    const { store } = sealedParent();
    let unitReads = 0;
    const parent = { reservationId: "resv-1" } as ParentUnitRef;
    Object.defineProperty(parent, "unit", { enumerable: true, get: () => (unitReads++, unitRef(0)) });
    expect(store.issue(childInput({ parent })).ok).toBe(true);
    expect(unitReads).toBe(1);
  });

  it("A: consume reads the reservation id ONCE: checks made on the caller's reservation cannot consume someone else's", () => {
    const f = fresh();
    f.store.issue(issueInput()); // resv-1: the caller's
    f.store.issue(issueInput({ reservationId: "resv-2", principal: "agent:other", requestId: "req-other" })); // not the caller's
    let idReads = 0;
    const input = { ...consumeInput() };
    Object.defineProperty(input, "reservationId", { enumerable: true, get: () => (++idReads <= 3 ? "resv-1" : "resv-2") });
    f.store.consume(input);
    expect(f.store.findById("resv-2")!.state).toBe("issued");
    expect(idReads).toBe(1);
  });

  it("A: consume reads the preimage ONCE: the stored bytes are exactly the bytes that were hashed and parsed", () => {
    const f = fresh();
    f.store.issue(issueInput());
    const good = consumeInput();
    let reads = 0;
    const input = { ...good };
    Object.defineProperty(input, "dealPreimage", { enumerable: true, get: () => (++reads <= 3 ? good.dealPreimage : `${good.dealPreimage} `) });
    const r = f.store.consume(input);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
    const stored = f.sqlite.prepare("SELECT consumed_deal_json AS j FROM budget_reservations WHERE id = 'resv-1'").get() as { j: string };
    expect(stored.j).toBe(good.dealPreimage);
  });

  it("B: schema repair holds ONE immediate transaction: a writer cannot commit a row between the emptiness check and the drop", () => {
    const file = tempFile();
    const a = new Database(file);
    a.exec("CREATE TABLE budget_reservations (id TEXT PRIMARY KEY, junk TEXT)"); // another shape, empty: the repair case
    const b = new Database(file);
    b.pragma("busy_timeout = 0");
    let bCommitted = false;
    const realPrepare = a.prepare.bind(a);
    const interleaving = new Proxy(a, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const st = realPrepare(sql);
            if (!/count\(\*\)/i.test(sql)) return st;
            const realGet = st.get.bind(st);
            // Right after A counts the rows, B inserts and commits (astra's interleaving).
            return new Proxy(st, {
              get: (t, k) =>
                k === "get"
                  ? (...args: unknown[]) => {
                      const r = realGet(...args);
                      try {
                        b.prepare("INSERT INTO budget_reservations (id, junk) VALUES ('landed', 'x')").run();
                        bCommitted = true;
                      } catch {
                        // SQLITE_BUSY: A holds the write lock, so B's row is never committed
                      }
                      return r;
                    }
                  : Reflect.get(t, k),
            });
          };
        }
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    try {
      ensureBudgetReservationsSchema(interleaving as Database.Database);
    } catch {
      // a refusal is fine too; losing a committed row is not
    }
    if (bCommitted) {
      const has = a.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'budget_reservations'").get() as { n: number };
      const rows = has.n > 0 ? (a.prepare("SELECT count(*) AS n FROM budget_reservations WHERE id = 'landed'").get() as { n: number }).n : 0;
      expect(rows).toBe(1); // a COMMITTED row must survive
    }
    a.close();
    b.close();
  });

  it("B: a table whose recorded schema version matches is accepted however its SQL text is written; textual difference alone refuses nothing", () => {
    const sqlite = new Database(":memory:");
    // The same table, written differently (quoted name, lower-case keywords), holding a row, with its version recorded.
    sqlite.exec(BUDGET_RESERVATIONS_DDL.replace("CREATE TABLE IF NOT EXISTS budget_reservations (", 'create table if not exists "budget_reservations" ('));
    sqlite.exec("CREATE TABLE IF NOT EXISTS pcc_schema_versions (object TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL)");
    sqlite.exec("INSERT OR REPLACE INTO pcc_schema_versions (object, version) VALUES ('budget_reservations', 2)");
    new BudgetReservationStore(sqlite, { clock: () => NOW }).issue(issueInput());
    expect(() => ensureBudgetReservationsSchema(sqlite)).not.toThrow();
  });

  it("C: INSERT OR REPLACE cannot reopen a consumed reservation, with recursive triggers OFF", () => {
    const f = fresh();
    f.sqlite.pragma("recursive_triggers = OFF");
    f.store.issue(issueInput());
    expect(f.store.consume(consumeInput()).ok).toBe(true);
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT OR REPLACE INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id,
             job_binding, min_tier, parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, consumed_deal_json, created_at, consumed_at)
           VALUES ('resv-1', 'agent:buyer-1', ?, 'USDC', '20000000', 'reopened', 'req-42', NULL, NULL, NULL, NULL, ?, 'issued', NULL, NULL, ?, NULL)`,
        )
        .run(PAYER, NOW + 3600, NOW),
    ).toThrow();
    expect(f.store.findById("resv-1")!.state).toBe("consumed");
  });

  it("C: the id is NOT NULL (a TEXT primary key does not enforce it by itself)", () => {
    const f = fresh();
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id,
             job_binding, min_tier, parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, consumed_deal_json, created_at, consumed_at)
           VALUES (NULL, 'agent:buyer-1', ?, 'USDC', '20000000', 'p', 'req-42', NULL, NULL, NULL, NULL, ?, 'issued', NULL, NULL, ?, NULL)`,
        )
        .run(PAYER, NOW + 3600, NOW),
    ).toThrow();
  });

  it("D: a deal claiming tier 2 with NO committed program is not a sealed deal, so a floor-2 reservation refuses it", () => {
    const f = fresh();
    f.store.issue(issueInput({ minTier: 2 }));
    const base = deal(); // a real tier-0 deal
    const o = JSON.parse(base.dealPreimage);
    for (const job of o.jobs) for (const u of job.units) {
      u.requiredTier = 2;
      u.requestedTier = 2;
    }
    for (const b of o.nodeToUnit) b.tier = 2; // committedProgramHash stays null
    const forged = canonicalize(o);
    expect(f.store.consume({ reservationId: "resv-1", principal: "agent:buyer-1", ...sealedPair(forged) })).toEqual({ ok: false, reason: "invalid-deal" });
    expect(f.store.findById("resv-1")!.state).toBe("issued");
  });
});
