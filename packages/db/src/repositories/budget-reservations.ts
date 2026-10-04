/**
 * R13: one-use, server-issued budget reservations (reconciliation row R13; MUST-CLOSE 7 and 8). The
 * schema is operator decision #2240, as amended by #2301, #2302 and #3231.
 *
 * A reservation is the payer's bounded authority for ONE accepted plan:
 *   - a principal (who may spend it);
 *   - a payer wallet;
 *   - a currency and an exact maximum in token base units;
 *   - a request, an expiry and an optional assurance floor.
 * It is consumed EXACTLY ONCE, in one atomic step that seals the accepted deal.
 *
 * Exactness. SQLite has no numeric(78,0), so amounts are stored as canonical decimal TEXT (no sign,
 * no leading zeros, positive, at most uint256) and compared as BigInt in application code, never in
 * SQL and never as a float.
 *
 * Atomicity. `issue` and `consume` each run in ONE `BEGIN IMMEDIATE` transaction: the write lock is
 * taken before the row is read, so no other connection can interleave between the check and the
 * write. The final UPDATE is still conditional on `state = 'issued'`, and exactly one row must change.
 *
 * Round 2 (the operator's ChatGPT review of 0b8adda9, DO-NOT-SHIP):
 *   - H1. A child's parent-unit terms are never the caller's. `issue` takes only the parent id and the
 *     unit reference; inside its transaction it reads the parent's stored sealed deal, checks that
 *     it hashes to the sealed digest, parses it strictly (`parseSealedDeal`), finds that exact unit,
 *     and derives its operator, net n and reclaimAt there. A child also fits its own request's ceiling.
 *   - H2. Time is the store's own: one clock, injected at construction and read inside each
 *     transaction; no caller passes `now`. And "expired" is a durable fact, not a clock reading:
 *     before an issue lets an expired reservation stop counting against a ceiling, it moves that
 *     reservation `issued -> expired` in the same transaction, and a consume that finds a reservation
 *     expired records it too. Consume requires `issued`, so no clock, however skewed, can consume an
 *     authority whose share has already been released.
 *   - H3. `0004_budget_reservations.sql` is BUDGET_RESERVATIONS_DDL, statement for statement (a test
 *     holds them equal), and `ensureBudgetReservationsSchema` refuses a table of another shape: an
 *     empty one is rebuilt, one holding rows stops the boot.
 *   - M5. The table refuses the states its invariants forbid: a zero or over-uint256 amount, a
 *     consumed row without its digest, deal or time, an expiry not after creation, any update that is
 *     not `issued -> consumed | expired | released`, any change to a term, any delete, and a child
 *     inserted under a parent that is not consumed. SQL has no sha256, so the trusted readers
 *     re-check sha256(stored deal) == stored digest.
 *   - M6. The consume seals only a real deal. It parses the preimage strictly and takes the request,
 *     reservation, currency, every payer, the obligation and the lowest tier FROM THE DEAL, checking
 *     each against the row. A caller cannot pass those terms separately any more.
 *
 * The sealed deal (amendment #3231, steward conditions #3235). `consumed_deal_json` holds the digest's
 * own canonical PREIMAGE, so sha256(stored bytes) == consumed_deal_digest holds literally. It is never
 * part of the reservation object this store returns; only `sealedDealPreimage` reads it, for
 * server-side use (condition b).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_SEALED_DEAL_BYTES, parseSealedDeal, type SealedDeal } from "@pcc/spec";

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

/** MC 9: which parent unit a child is carved from. Lookup keys only: the store derives every term. */
export interface ParentUnitRef {
  reservationId: string;
  /** The parent deal's `${jobId}#${milestoneIndex}`. */
  unit: string;
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
  /** Lifetime in seconds, from the store's own clock at issue. */
  expiresInSec: number;
  /**
   * The request's immutable authorized ceiling in exact base units (#335 R-06), read by the server.
   * Every reservation of the request that still holds money, plus this one, must fit under it.
   */
  requestCeilingBaseUnits: bigint;
  /** MC 9 (#2301): present for a child reservation. */
  parent?: ParentUnitRef | null;
}

export type IssueRefusal =
  | "invalid-input"
  | "duplicate-id"
  | "over-request-ceiling"
  | "parent-not-found"
  | "parent-not-consumed"
  | "parent-deal-corrupt"
  | "parent-unit-not-found"
  | "child-principal-not-parent-operator"
  | "parent-currency-mismatch"
  | "child-payer-is-parent-payer"
  | "over-parent-unit"
  | "child-outlives-parent-unit";

export type IssueResult = { ok: true; reservation: BudgetReservation } | { ok: false; reason: IssueRefusal };

export interface ConsumeReservationInput {
  reservationId: string;
  principal: string;
  /** `acceptedDealDigest`, RECOMPUTED by the caller from the compiled plan (the #351 consumer contract). */
  dealDigest: string;
  /** That digest's canonical preimage (#351 `acceptedDealPreimage`). It must hash to `dealDigest`, parse as a sealed deal for THIS reservation, and it is stored. */
  dealPreimage: string;
}

export type ConsumeRefusal =
  | "invalid-input"
  | "deal-preimage-mismatch"
  | "invalid-deal"
  | "wrong-reservation"
  | "not-found"
  | "wrong-principal"
  | "wrong-request"
  | "wrong-currency"
  | "wrong-payer"
  | "not-issued"
  | "expired"
  | "over-reservation"
  | "below-min-tier";

export type ConsumeResult = { ok: true; reservation: BudgetReservation } | { ok: false; reason: ConsumeRefusal };

/** The largest uint256, as the decimal the SQL CHECK compares 78-digit amounts against. */
const MAX_UINT256_DECIMAL = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/** The table, once. SQLite stores it as `CREATE TABLE <this>`, which `ensureBudgetReservationsSchema` compares. */
const TABLE = `budget_reservations (
      id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
      principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
      payer_address TEXT NOT NULL CHECK (length(payer_address) BETWEEN 1 AND 128),
      currency TEXT NOT NULL CHECK (length(currency) BETWEEN 1 AND 128),
      max_amount_base_units TEXT NOT NULL
        CHECK (max_amount_base_units NOT GLOB '*[^0-9]*' AND substr(max_amount_base_units, 1, 1) <> '0'
               AND (length(max_amount_base_units) BETWEEN 1 AND 77
                    OR (length(max_amount_base_units) = 78 AND max_amount_base_units <= '${MAX_UINT256_DECIMAL}'))),
      purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 256),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
      job_binding TEXT CHECK (job_binding IS NULL OR length(job_binding) BETWEEN 1 AND 128),
      min_tier INTEGER CHECK (min_tier IS NULL OR (typeof(min_tier) = 'integer' AND min_tier BETWEEN 0 AND 3)),
      parent_reservation_id TEXT,
      parent_unit TEXT CHECK (parent_unit IS NULL OR length(parent_unit) BETWEEN 3 AND 300),
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'released')),
      consumed_deal_digest TEXT
        CHECK (consumed_deal_digest IS NULL OR (length(consumed_deal_digest) = 66 AND substr(consumed_deal_digest, 1, 2) = '0x'
               AND substr(consumed_deal_digest, 3) NOT GLOB '*[^0-9a-f]*')),
      consumed_deal_json TEXT CHECK (consumed_deal_json IS NULL OR length(CAST(consumed_deal_json AS BLOB)) BETWEEN 2 AND ${MAX_SEALED_DEAL_BYTES}),
      created_at INTEGER NOT NULL,
      consumed_at INTEGER CHECK (consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= 0)),
      CHECK (typeof(created_at) = 'integer' AND typeof(expires_at) = 'integer' AND created_at >= 0 AND expires_at > created_at),
      CHECK ((state = 'consumed') = (consumed_deal_digest IS NOT NULL)),
      CHECK ((state = 'consumed') = (consumed_deal_json IS NOT NULL)),
      CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
      CHECK ((parent_reservation_id IS NULL) = (parent_unit IS NULL))
    )`;

/**
 * The schema's version, recorded in `pcc_schema_versions` by the DDL, in the same run that creates the table, and
 * never over a table that already exists. `ensureBudgetReservationsSchema`
 * trusts this record, never the table's SQL text: two texts can describe one schema (astra, round 2 of R13).
 * Bump it whenever TABLE, or anything the store relies on, changes. v1 was 45d0cde3; v2 adds `id NOT NULL`
 * and the insert guard that refuses a reused id.
 */
export const BUDGET_RESERVATIONS_SCHEMA_VERSION = 2;

/**
 * The runtime DDL: the version table, the version record, the table, its indexes and its guard triggers. `ensureBudgetReservationsSchema` runs
 * it (so does `migrateDatabase`), and migrations/0004_budget_reservations.sql is this, statement for
 * statement. The triggers hold no data, so they are dropped and recreated on every run.
 *
 * The version record is written only by the run that CREATES the table (pack 92, MEDIUM): `CREATE TABLE IF
 * NOT EXISTS` keeps an existing table as it is, so stamping after it would certify a table of any age. An
 * existing table is never stamped here; `ensureBudgetReservationsSchema` alone decides about it.
 */
export const BUDGET_RESERVATIONS_DDL = `
    CREATE TABLE IF NOT EXISTS pcc_schema_versions (object TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL);
    INSERT OR REPLACE INTO pcc_schema_versions (object, version) SELECT 'budget_reservations', ${BUDGET_RESERVATIONS_SCHEMA_VERSION}
      WHERE NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_reservations');
    CREATE TABLE IF NOT EXISTS ${TABLE};
    CREATE INDEX IF NOT EXISTS budget_reservations_request_idx ON budget_reservations(request_id, state);
    CREATE INDEX IF NOT EXISTS budget_reservations_parent_idx ON budget_reservations(parent_reservation_id, parent_unit);
    DROP TRIGGER IF EXISTS budget_reservations_insert_guard;
    CREATE TRIGGER budget_reservations_insert_guard BEFORE INSERT ON budget_reservations
    WHEN NEW.state <> 'issued'
      OR EXISTS (SELECT 1 FROM budget_reservations e WHERE e.id = NEW.id)
      OR (NEW.parent_reservation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM budget_reservations p WHERE p.id = NEW.parent_reservation_id AND p.state = 'consumed'))
    BEGIN
      SELECT RAISE(ABORT, 'budget_reservations: a reservation is inserted issued, under an id never used before, and a child only under a consumed parent');
    END;
    DROP TRIGGER IF EXISTS budget_reservations_update_guard;
    CREATE TRIGGER budget_reservations_update_guard BEFORE UPDATE ON budget_reservations
    WHEN OLD.state <> 'issued' OR NEW.state = 'issued'
      OR NEW.id IS NOT OLD.id OR NEW.principal IS NOT OLD.principal OR NEW.payer_address IS NOT OLD.payer_address
      OR NEW.currency IS NOT OLD.currency OR NEW.max_amount_base_units IS NOT OLD.max_amount_base_units
      OR NEW.purpose IS NOT OLD.purpose OR NEW.request_id IS NOT OLD.request_id OR NEW.job_binding IS NOT OLD.job_binding
      OR NEW.min_tier IS NOT OLD.min_tier OR NEW.parent_reservation_id IS NOT OLD.parent_reservation_id
      OR NEW.parent_unit IS NOT OLD.parent_unit OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'budget_reservations: only issued -> consumed, expired or released, and no term changes');
    END;
    DROP TRIGGER IF EXISTS budget_reservations_delete_guard;
    CREATE TRIGGER budget_reservations_delete_guard BEFORE DELETE ON budget_reservations
    BEGIN
      SELECT RAISE(ABORT, 'budget_reservations: a reservation is never deleted');
    END;
`;

/**
 * Create the table (idempotent) and refuse one of an unknown version (H3). `CREATE TABLE IF NOT EXISTS`
 * would silently keep an older table, and a consume would then fail at runtime.
 * - Compatibility is the RECORDED version (`BUDGET_RESERVATIONS_SCHEMA_VERSION`), never the SQL text:
 *   two texts can describe one schema (astra, round 2 of R13).
 * - A table without the current version is rebuilt if it is empty (the table has never shipped). If it
 *   holds rows, it stops the boot for a deliberate migration (#2240).
 * - Everything runs in ONE immediate transaction: inspection, the emptiness check, the drop, the DDL and
 *   the version record. So no writer can commit a row between the check and a drop.
 */
export function ensureBudgetReservationsSchema(sqlite: Database.Database): void {
  sqlite
    .transaction(() => {
      const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_reservations'").get();
      if (table) {
        const versions = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pcc_schema_versions'").get();
        const recorded = versions
          ? (sqlite.prepare("SELECT version FROM pcc_schema_versions WHERE object = 'budget_reservations'").get() as { version: unknown } | undefined)
          : undefined;
        if (recorded?.version !== BUDGET_RESERVATIONS_SCHEMA_VERSION) {
          const { n } = sqlite.prepare("SELECT count(*) AS n FROM budget_reservations").get() as { n: number };
          if (n > 0) {
            throw new Error(
              `budget_reservations holds rows but its recorded schema version is ${recorded ? String(recorded.version) : "missing"}, ` +
                `not ${BUDGET_RESERVATIONS_SCHEMA_VERSION}: refusing to start a store its schema cannot back. ` +
                "Verify and migrate it deliberately (operator decision #2240).",
            );
          }
          sqlite.exec("DROP TABLE budget_reservations");
        }
      }
      sqlite.exec(BUDGET_RESERVATIONS_DDL);
    })
    .immediate();
}

/**
 * Read each named field of a caller's object ONCE into an owned, frozen, prototype-free copy (astra, round 2 of
 * R13). Validation and every later use see only that copy, so a getter or a proxy cannot pass a check with one
 * value and then be written with another. Null when the value is not an object, or when a read throws.
 */
function readOnce(x: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof x !== "object" || x === null) return null;
    const src = x as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of keys) out[k] = src[k];
    return Object.freeze(out);
  } catch {
    return null;
  }
}

const ISSUE_FIELDS = [
  "reservationId", "principal", "payerAddress", "currency", "maxAmountBaseUnits", "purpose", "requestId",
  "expiresInSec", "minTier", "jobBinding", "requestCeilingBaseUnits", "parent",
] as const;
const CONSUME_FIELDS = ["reservationId", "principal", "dealDigest", "dealPreimage"] as const;

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
/** The largest sealed-deal preimage stored (condition c). The parser also bounds units, legs and each unit. */
export const MAX_DEAL_PREIMAGE_BYTES = MAX_SEALED_DEAL_BYTES;
/** The longest reservation lifetime the store accepts (the issue route's own bound). */
export const MAX_RESERVATION_LIFETIME_SEC = 7 * 24 * 3600;
const TEXT_ID = /^[\x21-\x7e]{1,128}$/;
const UNIT_REF = /^[\x21-\x7e]{1,296}#(0|[1-9][0-9]?)$/;
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
const sha256Hex = (s: string) => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;

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

/** The public columns: `consumed_deal_json` is never selected into a reservation. */
const COLUMNS = `id, principal, payer_address, currency, max_amount_base_units, purpose, request_id, job_binding, min_tier,
  parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, created_at, consumed_at`;

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

export interface BudgetReservationStoreOptions {
  /** Unix seconds. Production: the host clock. Tests inject one. Read inside each transaction, never taken from a caller. */
  clock?: () => number;
}

export class BudgetReservationStore {
  private readonly clock: () => number;

  constructor(
    private readonly sqlite: Database.Database,
    options: BudgetReservationStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now() / 1000);
  }

  /** Create the table if needed, refusing one of another shape (see `ensureBudgetReservationsSchema`). */
  ensureSchema(): void {
    ensureBudgetReservationsSchema(this.sqlite);
  }

  /** The store's time, read inside the transaction that uses it. A clock that is not unix time is a wiring fault. */
  private now(): number {
    const t = Math.floor(this.clock());
    if (!isUnix(t)) throw new TypeError("BudgetReservationStore: the clock must return unix seconds");
    return t;
  }

  /** H2: expiry becomes durable before any decision relies on it. Scoped to the rows that decision counts. */
  private expireDue(now: number, scope: string, params: readonly unknown[]): void {
    this.sqlite.prepare(`UPDATE budget_reservations SET state = 'expired' WHERE state = 'issued' AND expires_at <= ? AND ${scope}`).run(now, ...params);
  }

  /** The stored sealed deal of a consumed reservation, integrity-checked and parsed; null when it is not a sealed deal. */
  private sealedDealOf(reservationId: string): SealedDeal | null {
    const r = this.sqlite
      .prepare("SELECT consumed_deal_json AS j, consumed_deal_digest AS d FROM budget_reservations WHERE id = ? AND state = 'consumed'")
      .get(reservationId) as { j: string | null; d: string | null } | undefined;
    if (!r || r.j === null || r.d === null || sha256Hex(r.j) !== r.d) return null;
    const parsed = parseSealedDeal(r.j);
    return parsed.ok && parsed.deal.reservationId === reservationId ? parsed.deal : null;
  }

  /**
   * The sealed deal's canonical preimage for a consumed reservation, or null when there is none.
   * Server-side only (funding, VCR delivery). Never serve it on a public or non-party read path
   * (#3235 b). Stored bytes that do not hash to the sealed digest, or are not a sealed deal for THIS
   * reservation, are a fault, never returned.
   */
  sealedDealPreimage(reservationId: string): string | null {
    const r = this.sqlite
      .prepare("SELECT consumed_deal_json AS j FROM budget_reservations WHERE id = ? AND state = 'consumed'")
      .get(reservationId) as { j: string | null } | undefined;
    if (!r || r.j === null) return null;
    if (!this.sealedDealOf(reservationId)) throw new Error("budget_reservations: a stored sealed deal does not hash to its digest or is not this reservation's deal");
    return r.j;
  }

  findById(reservationId: string): BudgetReservation | null {
    const r = this.sqlite.prepare(`SELECT ${COLUMNS} FROM budget_reservations WHERE id = ?`).get(reservationId) as Row | undefined;
    return r ? decode(r) : null;
  }

  /**
   * Issue a reservation in ONE immediate transaction.
   * - Every reservation of the request that still holds money (consumed, or issued and not expired),
   *   plus this one, must fit the request's ceiling.
   * - Child (MC 9): the parent must be consumed, and its sealed deal must hold the named unit. The unit's
   *   operator, net n and reclaimAt come from that deal. The child is issued to that operator only, in
   *   the parent's currency, never to the parent's payer; all the unit's children together fit n, none
   *   outlives the unit, and the child's floor is at least the parent's.
   */
  issue(input: IssueReservationInput): IssueResult {
    // Every field is read ONCE, the nested parent reference included; only the copies are used below.
    const i = readOnce(input, ISSUE_FIELDS) as IssueReservationInput | null;
    if (!i) return { ok: false, reason: "invalid-input" };
    const parentRaw: unknown = i.parent ?? null;
    const parent = parentRaw === null ? null : (readOnce(parentRaw, ["reservationId", "unit"]) as ParentUnitRef | null);
    if (parentRaw !== null && parent === null) return { ok: false, reason: "invalid-input" };
    if (
      !isId(i.reservationId) || !isId(i.principal) || !isId(i.payerAddress) || !isId(i.currency) || !isId(i.requestId) ||
      typeof i.purpose !== "string" || i.purpose.length === 0 || i.purpose.length > 256 ||
      !isAmount(i.maxAmountBaseUnits) ||
      !(Number.isSafeInteger(i.expiresInSec) && i.expiresInSec >= 1 && i.expiresInSec <= MAX_RESERVATION_LIFETIME_SEC) ||
      !(i.minTier === undefined || i.minTier === null || isTier(i.minTier)) ||
      !(i.jobBinding === undefined || i.jobBinding === null || isId(i.jobBinding)) ||
      typeof i.requestCeilingBaseUnits !== "bigint" || i.requestCeilingBaseUnits < 0n ||
      (parent !== null && (!isId(parent.reservationId) || typeof parent.unit !== "string" || !UNIT_REF.test(parent.unit)))
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    const run = this.sqlite.transaction((): IssueResult => {
      const now = this.now();
      const expiresAt = now + i.expiresInSec;
      if (this.sqlite.prepare("SELECT 1 FROM budget_reservations WHERE id = ?").get(i.reservationId)) return { ok: false, reason: "duplicate-id" };
      let minTier = i.minTier ?? null;
      let unitNet = 0n;
      let unitReclaimAt = 0n;
      if (parent !== null) {
        // Identity first: until the principal is shown to be the unit's operator, every answer is one
        // of the not-found family, which the route answers identically (no oracle on others' deals).
        const p = this.findById(parent.reservationId);
        if (!p) return { ok: false, reason: "parent-not-found" };
        if (p.state !== "consumed") return { ok: false, reason: "parent-not-consumed" };
        const deal = this.sealedDealOf(parent.reservationId);
        if (!deal) return { ok: false, reason: "parent-deal-corrupt" };
        const unit = deal.units.find((u) => u.unitRef === parent.unit);
        if (!unit) return { ok: false, reason: "parent-unit-not-found" };
        if (unit.operator !== i.principal.toLowerCase()) return { ok: false, reason: "child-principal-not-parent-operator" };
        if (p.currency !== i.currency) return { ok: false, reason: "parent-currency-mismatch" };
        // Never the parent payer's credentials (#2301): the operator funds its subcontract from its own wallet.
        if (i.payerAddress.toLowerCase() === p.payerAddress.toLowerCase()) return { ok: false, reason: "child-payer-is-parent-payer" };
        unitNet = unit.n;
        unitReclaimAt = unit.reclaimAt;
        // A child inherits the parent's assurance floor: max(parent's, its own) (#2302).
        if (p.minTier !== null) minTier = minTier === null ? p.minTier : Math.max(minTier, p.minTier);
      }
      this.expireDue(now, "request_id = ?", [i.requestId]);
      const held = (this.sqlite
        .prepare("SELECT max_amount_base_units AS a FROM budget_reservations WHERE request_id = ? AND state IN ('issued', 'consumed')")
        .all(i.requestId) as Array<{ a: string }>).map((r) => BigInt(r.a));
      if (sum(held) + i.maxAmountBaseUnits > i.requestCeilingBaseUnits) return { ok: false, reason: "over-request-ceiling" };
      if (parent !== null) {
        this.expireDue(now, "parent_reservation_id = ? AND parent_unit = ?", [parent.reservationId, parent.unit]);
        const siblings = (this.sqlite
          .prepare("SELECT max_amount_base_units AS a FROM budget_reservations WHERE parent_reservation_id = ? AND parent_unit = ? AND state IN ('issued', 'consumed')")
          .all(parent.reservationId, parent.unit) as Array<{ a: string }>).map((r) => BigInt(r.a));
        if (sum(siblings) + i.maxAmountBaseUnits > unitNet) return { ok: false, reason: "over-parent-unit" };
        if (BigInt(expiresAt) > unitReclaimAt) return { ok: false, reason: "child-outlives-parent-unit" };
      }
      this.sqlite
        .prepare(
          `INSERT INTO budget_reservations (id, principal, payer_address, currency, max_amount_base_units, purpose, request_id,
             job_binding, min_tier, parent_reservation_id, parent_unit, expires_at, state, consumed_deal_digest, consumed_deal_json, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, NULL, ?, NULL)`,
        )
        .run(
          i.reservationId, i.principal, i.payerAddress, i.currency, i.maxAmountBaseUnits.toString(), i.purpose, i.requestId,
          i.jobBinding ?? null, minTier, parent?.reservationId ?? null, parent?.unit ?? null, expiresAt, now,
        );
      return { ok: true, reservation: this.findById(i.reservationId)! };
    });
    return run.immediate();
  }

  /**
   * Consume a reservation EXACTLY ONCE, in ONE immediate transaction.
   * - The preimage must hash to the digest and parse as a sealed deal FOR THIS reservation (M6).
   * - Then, against the stored row: principal; the deal's request, currency and every payer; issued
   *   and unexpired; the deal's obligation within the maximum; its lowest tier at or above the floor.
   * - Then it seals the deal. The final UPDATE is conditional on `state = 'issued'`, and exactly one
   *   row must change.
   */
  consume(input: ConsumeReservationInput): ConsumeResult {
    // Every field is read ONCE: the checks, the hash, the parse and the final UPDATE all see the same values.
    const c = readOnce(input, CONSUME_FIELDS) as ConsumeReservationInput | null;
    if (!c) return { ok: false, reason: "invalid-input" };
    if (
      !isId(c.reservationId) || !isId(c.principal) ||
      typeof c.dealDigest !== "string" || !DIGEST.test(c.dealDigest) ||
      typeof c.dealPreimage !== "string" || c.dealPreimage.length > MAX_DEAL_PREIMAGE_BYTES
    ) {
      return { ok: false, reason: "invalid-input" };
    }
    // Condition (a): the stored bytes must BE the sealed deal, i.e. its digest's own preimage.
    if (sha256Hex(c.dealPreimage) !== c.dealDigest.toLowerCase()) return { ok: false, reason: "deal-preimage-mismatch" };
    const parsed = parseSealedDeal(c.dealPreimage);
    if (!parsed.ok) return { ok: false, reason: "invalid-deal" };
    const deal = parsed.deal;
    if (deal.reservationId !== c.reservationId) return { ok: false, reason: "wrong-reservation" };
    const run = this.sqlite.transaction((): ConsumeResult => {
      const now = this.now();
      const r = this.findById(c.reservationId);
      if (!r) return { ok: false, reason: "not-found" };
      if (r.principal !== c.principal) return { ok: false, reason: "wrong-principal" };
      if (r.requestId !== deal.requestId) return { ok: false, reason: "wrong-request" };
      if (r.currency !== deal.currency) return { ok: false, reason: "wrong-currency" };
      if (!deal.payers.every((p) => p === r.payerAddress.toLowerCase())) return { ok: false, reason: "wrong-payer" };
      if (r.state === "expired") return { ok: false, reason: "expired" }; // durably expired: no clock brings it back
      if (r.state !== "issued") return { ok: false, reason: "not-issued" };
      if (r.expiresAt <= now) {
        this.expireDue(now, "id = ?", [c.reservationId]);
        return { ok: false, reason: "expired" };
      }
      if (deal.totalObligationBaseUnits > r.maxAmountBaseUnits) return { ok: false, reason: "over-reservation" };
      if (r.minTier !== null && deal.minTier < r.minTier) return { ok: false, reason: "below-min-tier" };
      const changed = this.sqlite
        .prepare("UPDATE budget_reservations SET state = 'consumed', consumed_deal_digest = ?, consumed_deal_json = ?, consumed_at = ? WHERE id = ? AND state = 'issued'")
        .run(c.dealDigest.toLowerCase(), c.dealPreimage, now, c.reservationId).changes;
      if (changed !== 1) return { ok: false, reason: "not-issued" };
      return { ok: true, reservation: this.findById(c.reservationId)! };
    });
    return run.immediate();
  }
}
