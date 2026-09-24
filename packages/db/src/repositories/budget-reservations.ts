/**
 * R13: one-use, server-issued budget reservations (reconciliation row R13; MUST-CLOSE 7 and 8). The
 * schema is operator decision #2240, as amended by #2301 and #2302.
 *
 * A reservation is the payer's bounded authority for ONE accepted plan:
 *   - a principal (who may spend it);
 *   - a payer wallet;
 *   - a currency and an exact maximum in token base units;
 *   - a request, an expiry and an optional assurance floor.
 * It is consumed EXACTLY ONCE, in one atomic step that seals the accepted deal's digest.
 *
 * Exactness. SQLite has no numeric(78,0), so amounts are stored as canonical decimal TEXT (no sign,
 * no leading zeros, at most 78 digits) and compared as BigInt in application code, never in SQL and
 * never as a float.
 *
 * Atomicity. `issue` and `consume` each run in ONE `BEGIN IMMEDIATE` transaction: the write lock is
 * taken before the row is read, so no other connection can interleave between the check and the
 * write. The final UPDATE is still conditional on `state = 'issued'`, and exactly one row must change.
 *
 * The consume never trusts a caller-carried digest for integrity: the caller (the gateway's consume
 * protocol) RECOMPUTES `acceptedDealDigest` from the compiled plan before calling it (the #351
 * consumer contract).
 *
 * The sealed deal itself is stored too (amendment #3231, steward conditions #3235). `consumed_deal_json`
 * holds the digest's own canonical PREIMAGE, so sha256(stored bytes) == consumed_deal_digest holds
 * literally, and the consume refuses otherwise. It holds every settlement term: each job's operator,
 * each unit's g/f/n, payouts and reclaimAt, and each node's planHash. MC 9 derives a parent unit's
 * terms from it. It is never part of the reservation object this store returns; only
 * `sealedDealPreimage` reads it, for server-side use (condition b).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type BudgetReservationState = "issued" | "consumed" | "expired" | "released";

/** A reservation as the store returns it: exact types, decoded. */
export interface BudgetReservation {
  reservationId: string;
  principal: string;
  /** The payer wallet, bound at issue. The plan never supplies it (invariant 10). */
  payerAddress: string;
  currency: string;
  maxAmountBaseUnits: bigint;
  purpose: string;
  requestId: string;
  jobBinding: string | null;
  /** The payer's assurance floor on this money (#2302), or null. */
  minTier: number | null;
  /** MC 9: a child reservation names the parent reservation and unit it is funded from. */
  parentReservationId: string | null;
  parentUnit: string | null;
  /** Unix seconds. */
  expiresAt: number;
  state: BudgetReservationState;
  consumedDealDigest: string | null;
  createdAt: number;
  consumedAt: number | null;
}

/** The terms of the parent unit a child reservation is carved from, read by the server from the parent's sealed deal. */
export interface ParentUnitTerms {
  reservationId: string;
  /** The parent's `${jobId}#${milestoneIndex}`. */
  unit: string;
  /** The parent unit's signing operator: the only principal a child may be issued to. */
  operator: string;
  /** The parent unit's net n, in exact base units: the most all its children may reserve together. */
  netBaseUnits: bigint;
  /** The parent unit's reclaimAt (unix seconds): no child may outlive it. */
  reclaimAt: number;
}

export interface IssueReservationInput {
  /** Server-generated (e.g. a UUID). */
  reservationId: string;
  principal: string;
  payerAddress: string;
  currency: string;
  maxAmountBaseUnits: bigint;
  purpose: string;
  requestId: string;
  jobBinding?: string | null;
  minTier?: number | null;
  expiresAt: number;
  now: number;
  /**
   * The request's immutable authorized ceiling in exact base units (#335 R-06), read by the server.
   * Issued and consumed reservations for the request, plus this one, must fit under it.
   */
  requestCeilingBaseUnits: bigint;
  /** MC 9 (#2301): present for a child reservation. The request ceiling does not apply; the parent unit bounds it. */
  parent?: ParentUnitTerms | null;
}

export type IssueRefusal =
  | "invalid-input"
  | "duplicate-id"
  | "over-request-ceiling"
  | "parent-not-found"
  | "parent-not-consumed"
  | "parent-currency-mismatch"
  | "child-principal-not-parent-operator"
  | "child-payer-is-parent-payer"
  | "over-parent-unit"
  | "child-outlives-parent-unit";

export type IssueResult = { ok: true; reservation: BudgetReservation } | { ok: false; reason: IssueRefusal };

export interface ConsumeReservationInput {
  reservationId: string;
  principal: string;
  requestId: string;
  currency: string;
  /** Every job's payer in the plan being sealed; each must equal the reservation's payer. */
  payerAddresses: readonly string[];
  /** Σ g over the plan's units, DERIVED from the units by the caller, in exact base units. */
  obligationBaseUnits: bigint;
  /** The plan's minimum unit tier, for the reservation's floor. */
  minUnitTier: number;
  /** `acceptedDealDigest` RECOMPUTED by the caller from the compiled plan. */
  dealDigest: string;
  /** That digest's canonical preimage (#351 `acceptedDealPreimage`). It must hash to `dealDigest`, and it is stored. */
  dealPreimage: string;
  now: number;
}

export type ConsumeRefusal =
  | "invalid-input"
  | "not-found"
  | "wrong-principal"
  | "wrong-request"
  | "wrong-currency"
  | "wrong-payer"
  | "not-issued"
  | "expired"
  | "over-reservation"
  | "below-min-tier"
  | "deal-preimage-mismatch";

export type ConsumeResult = { ok: true; reservation: BudgetReservation } | { ok: false; reason: ConsumeRefusal };

/** The runtime DDL. It is also run by `migrateDatabase` and mirrored in migrations/0004_budget_reservations.sql. */
export const BUDGET_RESERVATIONS_DDL = `
    CREATE TABLE IF NOT EXISTS budget_reservations (
      id TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      payer_address TEXT NOT NULL,
      currency TEXT NOT NULL,
      max_amount_base_units TEXT NOT NULL
        CHECK (max_amount_base_units NOT GLOB '*[^0-9]*' AND length(max_amount_base_units) BETWEEN 1 AND 78
               AND (max_amount_base_units = '0' OR substr(max_amount_base_units, 1, 1) <> '0')),
      purpose TEXT NOT NULL,
      request_id TEXT NOT NULL,
      job_binding TEXT,
      min_tier INTEGER CHECK (min_tier IS NULL OR min_tier BETWEEN 0 AND 3),
      parent_reservation_id TEXT,
      parent_unit TEXT,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'released')),
      consumed_deal_digest TEXT,
      consumed_deal_json TEXT CHECK (consumed_deal_json IS NULL OR length(CAST(consumed_deal_json AS BLOB)) <= 1048576),
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      CHECK ((state = 'consumed') = (consumed_deal_digest IS NOT NULL)),
      CHECK ((state = 'consumed') = (consumed_deal_json IS NOT NULL)),
      CHECK ((parent_reservation_id IS NULL) = (parent_unit IS NULL))
    );
    CREATE INDEX IF NOT EXISTS budget_reservations_request_idx ON budget_reservations(request_id, state);
    CREATE INDEX IF NOT EXISTS budget_reservations_parent_idx ON budget_reservations(parent_reservation_id, parent_unit);
`;

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
/** The largest sealed-deal preimage stored (condition c): 64 units' terms fit well inside it. */
export const MAX_DEAL_PREIMAGE_BYTES = 1 << 20;
const TEXT_ID = /^[\x21-\x7e]{1,128}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

function isId(x: unknown): x is string {
  return typeof x === "string" && TEXT_ID.test(x);
}
function isUnix(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}
function isAmount(x: unknown): x is bigint {
  return typeof x === "bigint" && x > 0n && x <= MAX_UINT256;
}
function isTier(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 3;
}

interface Row {
  id: string;
  principal: string;
  payer_address: string;
  currency: string;
  max_amount_base_units: string;
  purpose: string;
  request_id: string;
  job_binding: string | null;
  min_tier: number | null;
  parent_reservation_id: string | null;
  parent_unit: string | null;
  expires_at: number;
  state: BudgetReservationState;
  consumed_deal_digest: string | null;
  created_at: number;
  consumed_at: number | null;
}

function decode(r: Row): BudgetReservation {
  if (!BASE_UNITS.test(r.max_amount_base_units)) throw new Error("budget_reservations: non-canonical amount in storage");
  return {
    reservationId: r.id,
    principal: r.principal,
    payerAddress: r.payer_address,
    currency: r.currency,
    maxAmountBaseUnits: BigInt(r.max_amount_base_units),
    purpose: r.purpose,
    requestId: r.request_id,
    jobBinding: r.job_binding,
    minTier: r.min_tier,
    parentReservationId: r.parent_reservation_id,
    parentUnit: r.parent_unit,
    expiresAt: r.expires_at,
    state: r.state,
    consumedDealDigest: r.consumed_deal_digest,
    createdAt: r.created_at,
    consumedAt: r.consumed_at,
  };
}

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

/**
 * The reservations that still hold money against a ceiling: consumed ones, and issued ones that have
 * not expired. An issued reservation past its expiry can never be consumed, so it must not keep its
 * share, even before any housekeeping marks it 'expired'. Binds one parameter: now.
 */
const HOLDS_MONEY = "(state = 'consumed' OR (state = 'issued' AND expires_at > ?))";

export class BudgetReservationStore {
  constructor(private readonly sqlite: Database.Database) {}

  /** Create the table if needed (idempotent). `migrateDatabase` also runs this DDL. */
  ensureSchema(): void {
    this.sqlite.exec(BUDGET_RESERVATIONS_DDL);
  }

  /**
   * The sealed deal's canonical preimage for a consumed reservation, or null. Server-side only (MC 9's
   * parent terms, funding, VCR delivery). Never serve it on a public or non-party read path (#3235 b).
   */
  sealedDealPreimage(reservationId: string): string | null {
    const r = this.sqlite
      .prepare("SELECT consumed_deal_json AS j FROM budget_reservations WHERE id = ? AND state = 'consumed'")
      .get(reservationId) as { j: string | null } | undefined;
    return r?.j ?? null;
  }

  findById(reservationId: string): BudgetReservation | null {
    const r = this.sqlite.prepare("SELECT * FROM budget_reservations WHERE id = ?").get(reservationId) as Row | undefined;
    return r ? decode(r) : null;
  }

  /**
   * Issue a reservation in ONE immediate transaction.
   * - Top-level: the request's reservations that still hold money (consumed, or issued and unexpired),
   *   plus this one, must fit the ceiling.
   * - Child (MC 9): the parent must be consumed, in the same currency, and issued to the parent unit's
   *   operator. All the unit's children together must fit its net n, and none may outlive the unit's
   *   reclaimAt.
   */
  issue(input: IssueReservationInput): IssueResult {
    const i = input;
    const parent = i.parent ?? null;
    if (
      !isId(i.reservationId) || !isId(i.principal) || !isId(i.payerAddress) || !isId(i.currency) || !isId(i.requestId) ||
      typeof i.purpose !== "string" || i.purpose.length === 0 || i.purpose.length > 256 ||
      !isAmount(i.maxAmountBaseUnits) || !isUnix(i.now) || !isUnix(i.expiresAt) || i.expiresAt <= i.now ||
      !(i.minTier === undefined || i.minTier === null || isTier(i.minTier)) ||
      !(i.jobBinding === undefined || i.jobBinding === null || isId(i.jobBinding)) ||
      typeof i.requestCeilingBaseUnits !== "bigint" || i.requestCeilingBaseUnits < 0n ||
      (parent !== null && (!isId(parent.reservationId) || !isId(parent.unit) || !isId(parent.operator) ||
        typeof parent.netBaseUnits !== "bigint" || parent.netBaseUnits < 0n || !isUnix(parent.reclaimAt)))
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    const run = this.sqlite.transaction((): IssueResult => {
      if (this.sqlite.prepare("SELECT 1 FROM budget_reservations WHERE id = ?").get(i.reservationId)) return { ok: false, reason: "duplicate-id" };
      let minTier = i.minTier ?? null;
      if (parent === null) {
        const held = (this.sqlite
          .prepare(`SELECT max_amount_base_units AS a FROM budget_reservations WHERE request_id = ? AND parent_reservation_id IS NULL AND ${HOLDS_MONEY}`)
          .all(i.requestId, i.now) as Array<{ a: string }>).map((r) => BigInt(r.a));
        if (sum(held) + i.maxAmountBaseUnits > i.requestCeilingBaseUnits) return { ok: false, reason: "over-request-ceiling" };
      } else {
        const p = this.findById(parent.reservationId);
        if (!p) return { ok: false, reason: "parent-not-found" };
        if (p.state !== "consumed") return { ok: false, reason: "parent-not-consumed" };
        if (p.currency !== i.currency) return { ok: false, reason: "parent-currency-mismatch" };
        if (parent.operator.toLowerCase() !== i.principal.toLowerCase()) return { ok: false, reason: "child-principal-not-parent-operator" };
        // Never the parent payer's credentials (#2301): the operator funds its subcontract from its own wallet.
        if (i.payerAddress.toLowerCase() === p.payerAddress.toLowerCase()) return { ok: false, reason: "child-payer-is-parent-payer" };
        const siblings = (this.sqlite
          .prepare(`SELECT max_amount_base_units AS a FROM budget_reservations WHERE parent_reservation_id = ? AND parent_unit = ? AND ${HOLDS_MONEY}`)
          .all(parent.reservationId, parent.unit, i.now) as Array<{ a: string }>).map((r) => BigInt(r.a));
        if (sum(siblings) + i.maxAmountBaseUnits > parent.netBaseUnits) return { ok: false, reason: "over-parent-unit" };
        if (i.expiresAt > parent.reclaimAt) return { ok: false, reason: "child-outlives-parent-unit" };
        // A child inherits the parent's assurance floor: max(parent's, its own) (#2302).
        if (p.minTier !== null) minTier = minTier === null ? p.minTier : Math.max(minTier, p.minTier);
      }
      this.sqlite
        .prepare(
          `INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id,
             job_binding, min_tier, parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, ?, NULL)`,
        )
        .run(
          i.reservationId, i.principal, i.payerAddress, i.currency, i.maxAmountBaseUnits.toString(), i.purpose, i.requestId,
          i.jobBinding ?? null, minTier, parent?.reservationId ?? null, parent?.unit ?? null, i.expiresAt, i.now,
        );
      return { ok: true, reservation: this.findById(i.reservationId)! };
    });
    return run.immediate();
  }

  /**
   * Consume a reservation EXACTLY ONCE, in ONE immediate transaction.
   * - Checks, against the stored row: principal, request, currency, every job's payer, issued and
   *   unexpired, the obligation within the maximum, and the plan at or above the reservation's floor.
   * - Then it seals `dealDigest`. The final UPDATE is conditional on `state = 'issued'`, and exactly
   *   one row must change.
   */
  consume(input: ConsumeReservationInput): ConsumeResult {
    const c = input;
    if (
      !isId(c.reservationId) || !isId(c.principal) || !isId(c.requestId) || !isId(c.currency) ||
      !Array.isArray(c.payerAddresses) || c.payerAddresses.length === 0 || !c.payerAddresses.every(isId) ||
      !isAmount(c.obligationBaseUnits) || !isTier(c.minUnitTier) || typeof c.dealDigest !== "string" || !DIGEST.test(c.dealDigest) || !isUnix(c.now) ||
      typeof c.dealPreimage !== "string" || Buffer.byteLength(c.dealPreimage, "utf8") > MAX_DEAL_PREIMAGE_BYTES
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    // Condition (a): the stored bytes must BE the sealed deal, i.e. its digest's own preimage.
    if (`0x${createHash("sha256").update(c.dealPreimage, "utf8").digest("hex")}` !== c.dealDigest.toLowerCase()) {
      return { ok: false, reason: "deal-preimage-mismatch" };
    }
    const run = this.sqlite.transaction((): ConsumeResult => {
      const r = this.findById(c.reservationId);
      if (!r) return { ok: false, reason: "not-found" };
      if (r.principal !== c.principal) return { ok: false, reason: "wrong-principal" };
      if (r.requestId !== c.requestId) return { ok: false, reason: "wrong-request" };
      if (r.currency !== c.currency) return { ok: false, reason: "wrong-currency" };
      if (!c.payerAddresses.every((p) => p.toLowerCase() === r.payerAddress.toLowerCase())) return { ok: false, reason: "wrong-payer" };
      if (r.state !== "issued") return { ok: false, reason: "not-issued" };
      if (r.expiresAt <= c.now) return { ok: false, reason: "expired" };
      if (c.obligationBaseUnits > r.maxAmountBaseUnits) return { ok: false, reason: "over-reservation" };
      if (r.minTier !== null && c.minUnitTier < r.minTier) return { ok: false, reason: "below-min-tier" };
      const changed = this.sqlite
        .prepare("UPDATE budget_reservations SET state = 'consumed', consumed_deal_digest = ?, consumed_deal_json = ?, consumed_at = ? WHERE id = ? AND state = 'issued'")
        .run(c.dealDigest.toLowerCase(), c.dealPreimage, c.now, c.reservationId).changes;
      if (changed !== 1) return { ok: false, reason: "not-issued" };
      return { ok: true, reservation: this.findById(c.reservationId)! };
    });
    return run.immediate();
  }
}
