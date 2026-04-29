/**
 * Atomic balance operations over a pluggable LedgerStore.
 *
 * All public methods are atomic: either the entry lands AND the balance
 * map updates, or neither does. The default store is in-memory; the
 * design lets a future week swap in a Postgres or Stripe Treasury
 * adapter by implementing the same interface.
 *
 * Account naming convention used throughout this module:
 *   acct:user:<actorId>     — user spendable balance
 *   acct:operator:<actorId> — operator collected balance
 *   acct:escrow:<sessionId> — per-session locked funds
 *   acct:fee                — protocol fee bucket (reserved; not used in v1)
 */

import { randomUUID } from "node:crypto";
import type {
  Actor,
  LedgerEntry,
  LedgerEntryKind,
  LockReceipt,
  ReleaseReceipt,
  RefundReceipt,
} from "./types.js";
import { LedgerEntrySchema, AmountSchema } from "./types.js";

export interface LedgerStore {
  appendEntry(entry: LedgerEntry): LedgerEntry;
  getBalance(account: string): number;
  /**
   * Atomically apply +/- to a set of accounts AND append the entry. The
   * implementation MUST roll back balance changes if the entry append
   * fails, and MUST throw on negative-balance violations BEFORE applying.
   */
  atomicTransfer(
    deltas: Record<string, number>,
    entry: LedgerEntry,
  ): LedgerEntry;
  /** Read-only snapshot of all balances (for tests / debugging). */
  snapshot(): Record<string, number>;
  /** All entries, in append order. */
  history(): LedgerEntry[];
}

/** Naming convention helpers. */
export const userAccount = (a: Actor) => `acct:${a.kind}:${a.id}`;
export const operatorAccount = (a: Actor) => `acct:${a.kind}:${a.id}`;
export const escrowAccount = (sessionId: string) => `acct:escrow:${sessionId}`;

export class InMemoryLedgerStore implements LedgerStore {
  private balances = new Map<string, number>();
  private entries: LedgerEntry[] = [];

  appendEntry(entry: LedgerEntry): LedgerEntry {
    const parsed = LedgerEntrySchema.parse(entry);
    this.entries.push(parsed);
    return parsed;
  }

  getBalance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  atomicTransfer(deltas: Record<string, number>, entry: LedgerEntry): LedgerEntry {
    const parsed = LedgerEntrySchema.parse(entry);

    // Pre-flight: simulate deltas against current balances. If any account
    // would go negative, abort BEFORE mutating anything.
    const proposed = new Map<string, number>(this.balances);
    for (const [account, delta] of Object.entries(deltas)) {
      const current = proposed.get(account) ?? 0;
      const next = current + delta;
      if (next < 0) {
        throw new InsufficientBalanceError(account, current, delta);
      }
      proposed.set(account, next);
    }

    // Commit: balance map first (in-memory replacement), then entry log.
    this.balances = proposed;
    this.entries.push(parsed);
    return parsed;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.balances);
  }

  history(): LedgerEntry[] {
    return [...this.entries];
  }
}

/**
 * High-level ledger operations. Each method is a single atomic transfer.
 */
export class EscrowLedger {
  constructor(private readonly store: LedgerStore = new InMemoryLedgerStore()) {}

  /** Internal: build a validated LedgerEntry. */
  private buildEntry(
    kind: LedgerEntryKind,
    from: string | null,
    to: string,
    amountCents: number,
    sessionId: string | null,
  ): LedgerEntry {
    AmountSchema.parse(amountCents);
    return {
      id: randomUUID(),
      kind,
      from,
      to,
      amountCents,
      sessionId,
      at: new Date().toISOString(),
    };
  }

  /** Reveal underlying store for read-only inspection (tests + diagnostics). */
  getStore(): LedgerStore {
    return this.store;
  }

  /** Read-only balance probe. */
  getBalance(account: string): number {
    return this.store.getBalance(account);
  }

  /**
   * Add cash to an actor account (e.g. user funded their wallet via Stripe).
   *
   * In a v1 centralized flow this is the side-effect of an external rail
   * (Stripe webhook, ACH credit, USDC bridge). The ledger itself only
   * records the line.
   */
  deposit(actor: Actor, amountCents: number): LedgerEntry {
    const account = userAccount(actor);
    const entry = this.buildEntry("deposit", null, account, amountCents, null);
    return this.store.atomicTransfer({ [account]: amountCents }, entry);
  }

  /**
   * Move cash from `fromActor` to a session-scoped escrow account.
   * Used at session "commit" time when the user has agreed to the quote.
   */
  lock(sessionId: string, fromActor: Actor, amountCents: number): LockReceipt {
    AmountSchema.parse(amountCents);
    const fromAcct = userAccount(fromActor);
    const escrowAcct = escrowAccount(sessionId);
    const entry = this.buildEntry("lock", fromAcct, escrowAcct, amountCents, sessionId);
    const stored = this.store.atomicTransfer(
      { [fromAcct]: -amountCents, [escrowAcct]: amountCents },
      entry,
    );
    return {
      entry: stored,
      newBalance: {
        from: this.store.getBalance(fromAcct),
        escrow: this.store.getBalance(escrowAcct),
      },
    };
  }

  /**
   * Release the entire escrow balance for a session to the operator.
   * Used at session "settle" time after evidence is accepted.
   *
   * @returns ReleaseReceipt with the new balances of escrow + operator.
   */
  release(sessionId: string, toOperator: Actor): ReleaseReceipt {
    const escrowAcct = escrowAccount(sessionId);
    const opAcct = operatorAccount(toOperator);
    const balance = this.store.getBalance(escrowAcct);
    if (balance <= 0) {
      throw new EscrowEmptyError(sessionId, balance);
    }
    const entry = this.buildEntry("release", escrowAcct, opAcct, balance, sessionId);
    const stored = this.store.atomicTransfer(
      { [escrowAcct]: -balance, [opAcct]: balance },
      entry,
    );
    return {
      entry: stored,
      newBalance: {
        escrow: this.store.getBalance(escrowAcct),
        to: this.store.getBalance(opAcct),
      },
    };
  }

  /**
   * Refund the escrow back to the original user. Used in cancel / dispute
   * resolution where the user keeps their money.
   */
  refund(sessionId: string, toUser: Actor): RefundReceipt {
    const escrowAcct = escrowAccount(sessionId);
    const userAcct = userAccount(toUser);
    const balance = this.store.getBalance(escrowAcct);
    if (balance <= 0) {
      throw new EscrowEmptyError(sessionId, balance);
    }
    const entry = this.buildEntry("refund", escrowAcct, userAcct, balance, sessionId);
    const stored = this.store.atomicTransfer(
      { [escrowAcct]: -balance, [userAcct]: balance },
      entry,
    );
    return {
      entry: stored,
      newBalance: {
        escrow: this.store.getBalance(escrowAcct),
        to: this.store.getBalance(userAcct),
      },
    };
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly account: string,
    public readonly currentBalance: number,
    public readonly attemptedDelta: number,
  ) {
    super(
      `Insufficient balance on ${account}: current ${currentBalance}, delta ${attemptedDelta}`,
    );
    this.name = "InsufficientBalanceError";
  }
}

export class EscrowEmptyError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly balance: number,
  ) {
    super(`Escrow for session "${sessionId}" is empty (balance=${balance})`);
    this.name = "EscrowEmptyError";
  }
}
