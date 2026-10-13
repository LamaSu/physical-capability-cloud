/**
 * The hosted agent's spend cap: a hard stop, enforced outside the model loop.
 *
 * Every model call first RESERVES its worst-case cost against three caps, in
 * one immediate transaction, so concurrent sessions cannot jointly cross a cap:
 *   - per session;
 *   - per user per UTC day;
 *   - global per UTC month.
 * A call whose worst case would cross any cap is refused (BudgetStop) and never
 * made. After the call, its reservation is settled to the actual usage: the TRUE
 * cost, never less. Money already spent cannot be un-spent, so a settlement that
 * exceeds its reservation (an OVERRUN: the upper bound did not hold) is recorded
 * as it was, flagged in the ledger, and stops that payer for the rest of the UTC
 * day, whatever the caps. The global kill switch is a separate control and is
 * not touched by an overrun.
 *
 * Money is integer nano-USD (1e-9 USD), so no float ever decides a refusal.
 */
import type Database from "better-sqlite3";

/** Model prices in nano-USD per token ($3 per million tokens = 3000). */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  /** Cache writes and reads, when the model bills them differently. */
  readonly cacheWrite?: number;
  readonly cacheRead?: number;
}

/** The three caps, in nano-USD. */
export interface BudgetCaps {
  readonly perSession: number;
  readonly perUserDay: number;
  readonly perMonth: number;
}

/**
 * Who a call is charged to. `userKey` is the service's account key for the
 * caller (an account id once signed in; an anonymous key before that).
 *
 * `addressKey` is the caller's client address (the SAME key an anonymous
 * session uses: `anon:${digest(req.ip)}`), charged ALONGSIDE `userKey`. A
 * signed-in operator id is only as trustworthy as provisioning, which accepts
 * an unverified email or wallet (Q3): an attacker can provision any number of
 * operator ids from one client and give each its own `userKey` allowance. The
 * address cap closes that: it is shared by every `userKey` (and every
 * anonymous session) seen from one client address, so provisioning a fresh
 * operator id never grants a fresh allowance by itself. For an anonymous
 * session `addressKey` equals `userKey` — they are the same cap, not two.
 */
export interface Payer {
  readonly sessionId: string;
  readonly userKey: string;
  readonly addressKey: string;
}

/** The usage block a Messages API response carries. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export type BudgetStopReason = "per-session" | "per-user-day" | "per-address-day" | "per-month" | "disabled" | "overrun";

export class BudgetStop extends Error {
  readonly retryable = false;
  constructor(
    readonly reason: BudgetStopReason,
    readonly spentNanoUsd: number,
    readonly capNanoUsd: number,
  ) {
    super(
      reason === "disabled"
        ? "the hosted agent is disabled"
        : reason === "overrun"
          ? "an earlier call cost more than its reservation, so this payer is stopped for the rest of the UTC day"
          : `budget stop (${reason}): spent ${spentNanoUsd} of ${capNanoUsd} nano-USD, and this call's worst case would cross the cap`,
    );
    this.name = "BudgetStop";
  }
}

export interface Reservation {
  readonly id: number;
  readonly worstNanoUsd: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS hosted_agent_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  address_key TEXT NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
  nano_usd INTEGER NOT NULL CHECK (nano_usd >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_session ON hosted_agent_spend (session_id);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_user_day ON hosted_agent_spend (user_key, day);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_address_day ON hosted_agent_spend (address_key, day);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_month ON hosted_agent_spend (month);
-- A settlement that cost more than its reservation. One row stops that payer (by EITHER its
-- operator id or its client address) for the rest of its UTC day.
CREATE TABLE IF NOT EXISTS hosted_agent_overrun (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  address_key TEXT NOT NULL,
  day TEXT NOT NULL,
  reserved_nano_usd INTEGER NOT NULL CHECK (reserved_nano_usd >= 0),
  actual_nano_usd INTEGER NOT NULL CHECK (actual_nano_usd >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_agent_overrun_user_day ON hosted_agent_overrun (user_key, day);
CREATE INDEX IF NOT EXISTS hosted_agent_overrun_address_day ON hosted_agent_overrun (address_key, day);
`;

/**
 * Fail closed on an old-shape spend or overrun table (Q3 round 2 + R3 round
 * 3): `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists,
 * so a pre-existing table from before `address_key` existed would otherwise
 * silently keep running without the address cap — exactly the sybil hole this
 * column closes. A table that does not exist yet is unaffected; the DDL below
 * creates it with the current shape. The service is undeployed, so there is
 * no data to migrate: recreate the ledger instead of patching it in place.
 *
 * R3: checks `hosted_agent_overrun` too, not just `hosted_agent_spend` — an
 * old-shape overrun table on its own left `settle()` to throw a raw SQLite
 * error AFTER the model call it was settling, instead of refusing at startup.
 */
function assertTableShape(db: Database.Database, table: string): void {
  const exists = db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "address_key")) {
    throw new Error(
      `${table} exists without an address_key column (Q3 round 2: the address-day cap). ` +
        "This is an old-shape table; refusing to start rather than silently migrating it. " +
        "The service is undeployed — recreate the spend ledger.",
    );
  }
}

function assertSpendTableShape(db: Database.Database): void {
  assertTableShape(db, "hosted_agent_spend");
  assertTableShape(db, "hosted_agent_overrun");
}

function nonNegativeSafeInteger(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative safe integer, got ${n}`);
  return n;
}

function mul(tokens: number, price: number, what: string): number {
  const v = nonNegativeSafeInteger(tokens, `${what} tokens`) * nonNegativeSafeInteger(price, `${what} price`);
  return nonNegativeSafeInteger(v, `${what} cost`);
}

/**
 * The most a request can cost. A byte-level tokenizer emits at most one token
 * per byte, so the request's UTF-8 length bounds its input tokens (system,
 * tools and messages included). Input is priced at the dearer of the input
 * and cache-write rates, and output at `max_tokens`.
 */
export function worstCaseNanoUsd(request: { readonly max_tokens: number }, price: ModelPrice): number {
  const inputBound = Buffer.byteLength(JSON.stringify(request), "utf8");
  const inputRate = Math.max(price.input, price.cacheWrite ?? 0, price.cacheRead ?? 0);
  const cost = mul(inputBound, inputRate, "input") + mul(request.max_tokens, price.output, "output");
  return nonNegativeSafeInteger(cost, "worst case");
}

/** What a response actually cost. */
export function actualNanoUsd(usage: Usage, price: ModelPrice): number {
  const cost =
    mul(usage.input_tokens, price.input, "input") +
    mul(usage.output_tokens, price.output, "output") +
    mul(usage.cache_creation_input_tokens ?? 0, price.cacheWrite ?? price.input, "cache write") +
    mul(usage.cache_read_input_tokens ?? 0, price.cacheRead ?? price.input, "cache read");
  return nonNegativeSafeInteger(cost, "actual cost");
}

export class BudgetMeter {
  constructor(
    private readonly db: Database.Database,
    private readonly caps: BudgetCaps,
    private readonly now: () => Date = () => new Date(),
    private readonly disabled: () => boolean = () => process.env.PCC_HOSTED_AGENT_DISABLED === "1",
  ) {
    nonNegativeSafeInteger(caps.perSession, "perSession cap");
    nonNegativeSafeInteger(caps.perUserDay, "perUserDay cap");
    nonNegativeSafeInteger(caps.perMonth, "perMonth cap");
    assertSpendTableShape(db);
    db.exec(DDL);
  }

  /**
   * Reserve `worstNanoUsd` for one call, or throw BudgetStop. Charges the
   * reservation against every applicable cap: per-session, the operator's own
   * day (user_key), the CLIENT's day (address_key — Q3 round 2, shared by
   * every operator id and every anonymous session seen from that address),
   * and the month. A kill switch or an earlier overrun (by EITHER the
   * operator or the address) refuses before any cap is even summed.
   */
  reserve(payer: Payer, worstNanoUsd: number): Reservation {
    nonNegativeSafeInteger(worstNanoUsd, "worst case");
    if (this.disabled()) throw new BudgetStop("disabled", 0, 0);
    const at = this.now();
    const iso = at.toISOString();
    const day = iso.slice(0, 10);
    const month = iso.slice(0, 7);
    const sum = (where: string, ...args: string[]): number =>
      (this.db.prepare(`SELECT COALESCE(SUM(nano_usd), 0) AS s FROM hosted_agent_spend WHERE ${where}`).get(...args) as { s: number }).s;
    return this.db.transaction((): Reservation => {
      // An overrun stops the payer for the rest of its UTC day, before any cap is looked at —
      // by its operator id OR its client address, whichever carries the flag.
      const overrun = this.db
        .prepare(`SELECT 1 AS found FROM hosted_agent_overrun WHERE day = ? AND (user_key = ? OR address_key = ?) LIMIT 1`)
        .get(day, payer.userKey, payer.addressKey);
      if (overrun !== undefined) throw new BudgetStop("overrun", sum("user_key = ? AND day = ?", payer.userKey, day), this.caps.perUserDay);
      const checks: Array<[BudgetStopReason, number, number]> = [
        ["per-session", sum("session_id = ?", payer.sessionId), this.caps.perSession],
        ["per-user-day", sum("user_key = ? AND day = ?", payer.userKey, day), this.caps.perUserDay],
        // Same cap VALUE as per-user-day (there is one address allowance, not a separately
        // configured one): the address cap is the cap anonymous sessions already use.
        ["per-address-day", sum("address_key = ? AND day = ?", payer.addressKey, day), this.caps.perUserDay],
        ["per-month", sum("month = ?", month), this.caps.perMonth],
      ];
      for (const [reason, spent, cap] of checks) {
        if (spent + worstNanoUsd > cap) throw new BudgetStop(reason, spent, cap);
      }
      const info = this.db
        .prepare(
          `INSERT INTO hosted_agent_spend (session_id, user_key, address_key, day, month, state, nano_usd, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(payer.sessionId, payer.userKey, payer.addressKey, day, month, worstNanoUsd, at.getTime());
      return { id: Number(info.lastInsertRowid), worstNanoUsd };
    }).immediate();
  }

  /**
   * Settle a reservation to what the call cost. Each reservation settles once.
   * The ledger records the TRUE cost, even when it exceeds the reservation. When
   * it does, that is an overrun: it is flagged in the ledger and the payer is
   * stopped for the rest of the UTC day (see `blocked`) by EITHER its operator
   * id or its client address.
   */
  settle(reservation: Reservation, actualNanoUsdValue: number): { overrun: boolean } {
    nonNegativeSafeInteger(actualNanoUsdValue, "actual cost");
    const at = this.now();
    return this.db.transaction((): { overrun: boolean } => {
      const row = this.db
        .prepare(
          `SELECT session_id AS sessionId, user_key AS userKey, address_key AS addressKey, nano_usd AS reserved
           FROM hosted_agent_spend WHERE id = ? AND state = 'pending'`,
        )
        .get(reservation.id) as { sessionId: string; userKey: string; addressKey: string; reserved: number } | undefined;
      if (row === undefined) throw new Error(`reservation ${reservation.id} is not pending`);
      this.db.prepare(`UPDATE hosted_agent_spend SET state = 'settled', nano_usd = ? WHERE id = ?`).run(actualNanoUsdValue, reservation.id);
      const overrun = actualNanoUsdValue > row.reserved;
      if (overrun) {
        this.db
          .prepare(
            `INSERT INTO hosted_agent_overrun (session_id, user_key, address_key, day, reserved_nano_usd, actual_nano_usd, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.sessionId, row.userKey, row.addressKey, at.toISOString().slice(0, 10), row.reserved, actualNanoUsdValue, at.getTime());
      }
      return { overrun };
    }).immediate();
  }

  /** Whether an overrun has stopped this payer for the current UTC day — by its
   * operator id, or by its client address (Q3 round 2: shared with every other
   * operator id, and any anonymous session, seen from that address). */
  blocked(payer: Payer): boolean {
    const day = this.now().toISOString().slice(0, 10);
    return (
      this.db
        .prepare(`SELECT 1 AS found FROM hosted_agent_overrun WHERE day = ? AND (user_key = ? OR address_key = ?) LIMIT 1`)
        .get(day, payer.userKey, payer.addressKey) !== undefined
    );
  }

  /** A call that failed without a usage block is charged its worst case. */
  abandon(reservation: Reservation): void {
    this.settle(reservation, reservation.worstNanoUsd);
  }

  /** Spent (settled plus pending) for the payer's session, operator-day, address-day and the month. */
  spent(payer: Payer): { session: number; userDay: number; addressDay: number; month: number } {
    const iso = this.now().toISOString();
    const q = (where: string, ...args: string[]): number =>
      (this.db.prepare(`SELECT COALESCE(SUM(nano_usd), 0) AS s FROM hosted_agent_spend WHERE ${where}`).get(...args) as { s: number }).s;
    return {
      session: q("session_id = ?", payer.sessionId),
      userDay: q("user_key = ? AND day = ?", payer.userKey, iso.slice(0, 10)),
      addressDay: q("address_key = ? AND day = ?", payer.addressKey, iso.slice(0, 10)),
      month: q("month = ?", iso.slice(0, 7)),
    };
  }
}

/** The part of the Anthropic client the agent loop uses. */
export interface MessagesClient {
  readonly messages: {
    create(request: { readonly max_tokens: number } & Record<string, unknown>): Promise<{ usage?: Usage | null }>;
  };
}

/**
 * Wrap a client so every `messages.create` is reserved before it is made and
 * settled after. A refused reservation throws BudgetStop and the inner client
 * is never called. A failed call is charged its worst case, and the original
 * error is rethrown. The wrapper exposes `messages.create` only, which is all
 * the agent loop calls.
 */
export function meteredClient(inner: MessagesClient, meter: BudgetMeter, payer: Payer, price: ModelPrice): MessagesClient {
  const create = async (request: { readonly max_tokens: number } & Record<string, unknown>) => {
    const reservation = meter.reserve(payer, worstCaseNanoUsd(request, price));
    let response: { usage?: Usage | null };
    try {
      response = await inner.messages.create(request);
    } catch (err) {
      meter.abandon(reservation);
      throw err;
    }
    if (response.usage) meter.settle(reservation, actualNanoUsd(response.usage, price));
    else meter.abandon(reservation);
    return response;
  };
  return { messages: { create } };
}
