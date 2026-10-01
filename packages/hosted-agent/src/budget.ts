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

/** Who a call is charged to. `userKey` is the service's account key for the
 * caller (an account id once signed in; an anonymous key before that). */
export interface Payer {
  readonly sessionId: string;
  readonly userKey: string;
}

/** The usage block a Messages API response carries. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export type BudgetStopReason = "per-session" | "per-user-day" | "per-month" | "disabled" | "overrun";

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
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
  nano_usd INTEGER NOT NULL CHECK (nano_usd >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_session ON hosted_agent_spend (session_id);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_user_day ON hosted_agent_spend (user_key, day);
CREATE INDEX IF NOT EXISTS hosted_agent_spend_month ON hosted_agent_spend (month);
-- A settlement that cost more than its reservation. One row stops that payer for the rest of its UTC day.
CREATE TABLE IF NOT EXISTS hosted_agent_overrun (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  day TEXT NOT NULL,
  reserved_nano_usd INTEGER NOT NULL CHECK (reserved_nano_usd >= 0),
  actual_nano_usd INTEGER NOT NULL CHECK (actual_nano_usd >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_agent_overrun_user_day ON hosted_agent_overrun (user_key, day);
`;

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
    db.exec(DDL);
  }

  /** Reserve `worstNanoUsd` for one call, or throw BudgetStop. */
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
      // An overrun stops the payer for the rest of its UTC day, before any cap is looked at.
      const overrun = this.db.prepare(`SELECT 1 AS found FROM hosted_agent_overrun WHERE user_key = ? AND day = ? LIMIT 1`).get(payer.userKey, day);
      if (overrun !== undefined) throw new BudgetStop("overrun", sum("user_key = ? AND day = ?", payer.userKey, day), this.caps.perUserDay);
      const checks: Array<[BudgetStopReason, number, number]> = [
        ["per-session", sum("session_id = ?", payer.sessionId), this.caps.perSession],
        ["per-user-day", sum("user_key = ? AND day = ?", payer.userKey, day), this.caps.perUserDay],
        ["per-month", sum("month = ?", month), this.caps.perMonth],
      ];
      for (const [reason, spent, cap] of checks) {
        if (spent + worstNanoUsd > cap) throw new BudgetStop(reason, spent, cap);
      }
      const info = this.db
        .prepare(
          `INSERT INTO hosted_agent_spend (session_id, user_key, day, month, state, nano_usd, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(payer.sessionId, payer.userKey, day, month, worstNanoUsd, at.getTime());
      return { id: Number(info.lastInsertRowid), worstNanoUsd };
    }).immediate();
  }

  /**
   * Settle a reservation to what the call cost. Each reservation settles once.
   * The ledger records the TRUE cost, even when it exceeds the reservation. When
   * it does, that is an overrun: it is flagged in the ledger and the payer is
   * stopped for the rest of the UTC day (see `blocked`).
   */
  settle(reservation: Reservation, actualNanoUsdValue: number): { overrun: boolean } {
    nonNegativeSafeInteger(actualNanoUsdValue, "actual cost");
    const at = this.now();
    return this.db.transaction((): { overrun: boolean } => {
      const row = this.db
        .prepare(`SELECT session_id AS sessionId, user_key AS userKey, nano_usd AS reserved FROM hosted_agent_spend WHERE id = ? AND state = 'pending'`)
        .get(reservation.id) as { sessionId: string; userKey: string; reserved: number } | undefined;
      if (row === undefined) throw new Error(`reservation ${reservation.id} is not pending`);
      this.db.prepare(`UPDATE hosted_agent_spend SET state = 'settled', nano_usd = ? WHERE id = ?`).run(actualNanoUsdValue, reservation.id);
      const overrun = actualNanoUsdValue > row.reserved;
      if (overrun) {
        this.db
          .prepare(
            `INSERT INTO hosted_agent_overrun (session_id, user_key, day, reserved_nano_usd, actual_nano_usd, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(row.sessionId, row.userKey, at.toISOString().slice(0, 10), row.reserved, actualNanoUsdValue, at.getTime());
      }
      return { overrun };
    }).immediate();
  }

  /** Whether an overrun has stopped this payer for the current UTC day. */
  blocked(payer: Payer): boolean {
    const day = this.now().toISOString().slice(0, 10);
    return this.db.prepare(`SELECT 1 AS found FROM hosted_agent_overrun WHERE user_key = ? AND day = ? LIMIT 1`).get(payer.userKey, day) !== undefined;
  }

  /** A call that failed without a usage block is charged its worst case. */
  abandon(reservation: Reservation): void {
    this.settle(reservation, reservation.worstNanoUsd);
  }

  /** Spent (settled plus pending) for the payer's session, user-day and the month. */
  spent(payer: Payer): { session: number; userDay: number; month: number } {
    const iso = this.now().toISOString();
    const q = (where: string, ...args: string[]): number =>
      (this.db.prepare(`SELECT COALESCE(SUM(nano_usd), 0) AS s FROM hosted_agent_spend WHERE ${where}`).get(...args) as { s: number }).s;
    return {
      session: q("session_id = ?", payer.sessionId),
      userDay: q("user_key = ? AND day = ?", payer.userKey, iso.slice(0, 10)),
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
