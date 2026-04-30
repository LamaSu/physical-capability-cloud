// Pluggable session store + state machine for operator onboarding.
//
// Discovery state machine:
//   started -> data_connected -> docs_ingested -> interview ->
//   capabilities_drafted -> built
//
// Ported from `LamaSu/navi` packages/backend/src/onboard/state.ts.
//
// Wave 4.3 (2026-04-29):
//   - The hard-coded in-memory Map became `InMemorySessionStore`.
//   - A new `SessionStore` interface lets the host (gateway) swap in a
//     SQLite-backed (or in future Postgres-backed) store via
//     `setSessionStore(...)` at startup.
//   - In-memory remains the default so test environments and unit tests in
//     this package keep working without any DB plumbing.
//   - The per-session FIFO mutex (T1.4) and the idempotency cache (T1.10)
//     stay in-process. They guard concurrent writes within ONE replica.
//     Cross-replica coordination (Postgres advisory locks, Redis, etc.)
//     becomes possible once a remote store is plugged in.
//
// Hardening (Tier 1, 2026-04-29):
//   - T1.4: per-session lock map serializes concurrent advanceSession()
//     calls so voice + chat doorways can't trigger lost updates.
//   - T1.10: idempotency on retryable build-agent sub-steps.

export type OnboardState =
  | "started"
  | "data_connected"
  | "docs_ingested"
  | "interview"
  | "capabilities_drafted"
  | "built";

export interface Capability {
  id: string;
  label: string;
  params_schema?: Record<string, unknown>;
  availability?: string;
}

export interface OnboardSession {
  id: string;
  name: string;
  url?: string;
  contact_email?: string;
  state: OnboardState;
  capabilities?: Capability[];
  data_sources?: unknown[];
  backend?: { project_url: string; anon_key: string };
  agent?: { url: string; marketplace_url?: string };
  extras?: Record<string, unknown>;
  updated_at: number;
}

// ─── Pluggable session store ────────────────────────────────────────────────
//
// Hosts can replace the default in-memory implementation with any backend
// (SQLite, Postgres, Redis) by calling `setSessionStore(...)` at startup.
// The interface mirrors `Map<string, OnboardSession>` so the swap is
// behaviour-compatible.

export interface SessionStore {
  /** Fetch a session by id; undefined when absent. */
  get(id: string): OnboardSession | undefined;
  /** Insert or replace by id (last-write-wins, matches Map semantics). */
  set(id: string, session: OnboardSession): void;
  /** Delete a session by id. Idempotent (no-op when absent). */
  delete(id: string): void;
  /** Snapshot every session. Used by restart-recovery enumerators. */
  list(): OnboardSession[];
}

/** Default backing store: in-process Map. Used in tests and as the
 *  fallback when `setSessionStore` is never called. */
export class InMemorySessionStore implements SessionStore {
  private map = new Map<string, OnboardSession>();
  get(id: string): OnboardSession | undefined {
    return this.map.get(id);
  }
  set(id: string, session: OnboardSession): void {
    this.map.set(id, session);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
  list(): OnboardSession[] {
    return [...this.map.values()];
  }
  /** Test-only: reset to empty. Module-level _resetStoreForTests calls this. */
  clear(): void {
    this.map.clear();
  }
}

let activeStore: SessionStore = new InMemorySessionStore();

/**
 * Replace the active session store. Hosts call this once at startup.
 * Idempotent in the sense that subsequent calls overwrite the prior store
 * — the caller is responsible for migrating in-flight state if any.
 */
export function setSessionStore(store: SessionStore): void {
  activeStore = store;
}

/**
 * Returns the active session store (escape hatch for advanced hosts).
 * Most callers should use the `startSession`/`getSession`/`advanceSession`
 * helpers, which already coordinate the per-session mutex.
 */
export function getSessionStore(): SessionStore {
  return activeStore;
}

/**
 * Non-destructive enumeration helper: walk every session in `store` that is
 * not yet `built` and re-enter it via the active store. Hosts call this
 * once at startup after wiring up a SQLite-backed store, so any in-flight
 * onboardings persisted by a previous gateway process resume cleanly.
 *
 * In v1 this is a no-op when `store === activeStore` (the rows are
 * already there — the in-process state-machine reads through the store on
 * every call). Kept exported for forward compatibility with future
 * out-of-band stores (Redis, Postgres LISTEN/NOTIFY) where rehydration
 * needs an explicit fan-in step.
 */
export function restoreSessionsFrom(store: SessionStore): void {
  if (store === activeStore) {
    return; // already-shared backing store, nothing to do
  }
  for (const session of store.list()) {
    if (session.state !== "built") {
      activeStore.set(session.id, session);
    }
  }
}

/**
 * Per-session FIFO mutex. The map value is the tail of a promise chain;
 * each `withLock(id, fn)` enqueues onto the tail and replaces it. Concurrent
 * callers thus run in arrival order with strict mutual exclusion.
 *
 * Memory note: keys are deleted when the chain drains (last task finishes
 * and finds itself still at the tail). The store keeps no slots for
 * sessions with no in-flight work, so memory tracks live concurrency, not
 * cumulative session count.
 */
const locks = new Map<string, Promise<void>>();

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The new tail waits for `prev` to complete, then for `next` to release.
  const tail = prev.then(() => next);
  locks.set(id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // If we're still the tail, clear the map slot to avoid a memory leak.
    if (locks.get(id) === tail) {
      locks.delete(id);
    }
  }
}

export async function startSession(input: {
  id: string;
  name: string;
  url?: string;
  contact_email?: string;
}): Promise<OnboardSession> {
  return withLock(input.id, async () => {
    const session: OnboardSession = {
      ...input,
      state: "started",
      updated_at: Date.now(),
    };
    activeStore.set(input.id, session);
    return session;
  });
}

export async function getSession(id: string): Promise<OnboardSession | undefined> {
  // Reads don't need the lock — stale-read tolerance is acceptable; the
  // important invariant is that writes don't interleave.
  return activeStore.get(id);
}

export async function advanceSession(
  id: string,
  to: OnboardState,
  patch: Record<string, unknown> = {}
): Promise<OnboardSession> {
  return withLock(id, async () => {
    const current = activeStore.get(id);
    if (!current) throw new Error(`session ${id} not found`);
    const next: OnboardSession = {
      ...current,
      ...patch,
      state: to,
      updated_at: Date.now(),
    };
    activeStore.set(id, next);
    return next;
  });
}

/** Test-only helper: clear all sessions, locks, and the idempotency cache.
 *  When the active store is the in-memory default, it is cleared in place;
 *  when a test has plugged in a SQLite store, the test owns its lifecycle
 *  and should reset that store separately. */
export function _resetStoreForTests(): void {
  if (activeStore instanceof InMemorySessionStore) {
    activeStore.clear();
  } else {
    // Best-effort: walk and delete. Hosts of non-default stores typically
    // dispose the underlying DB between tests, so this rarely matters.
    for (const s of activeStore.list()) {
      activeStore.delete(s.id);
    }
  }
  locks.clear();
  idempotencyCache.clear();
}

/** Test-only helper: revert to a fresh InMemorySessionStore. Used by
 *  persistence tests so module-internal state doesn't leak between cases. */
export function _resetStoreInstanceForTests(): void {
  activeStore = new InMemorySessionStore();
  locks.clear();
  idempotencyCache.clear();
}

// ─── T1.10: Idempotency on retryable build-agent sub-steps ─────────────────
//
// A single onboarding session can fan out into N side-effecting sub-steps
// (publish_operator, write_static_mirror, create_wallet, etc.). The chat /
// voice doorways may retry the build flow if a downstream tool blips, which
// without dedup creates duplicate registrations + duplicate wallets per run.
//
// Strategy: hash(session_id + step_name) -> stored Promise of the result.
// Concurrent calls with the same key share the same promise; later calls get
// the cached resolution. Wave 5 will replace this in-memory Map with a
// Postgres `idempotency_keys` table keyed off the same SHA-256 + a 24h TTL.

import { createHash } from "node:crypto";

/**
 * Map idempotency-key -> in-flight or resolved Promise. We deliberately store
 * Promises (not values) so two callers entering withIdempotency at the same
 * time both observe the FIRST in-flight call rather than racing each other.
 */
const idempotencyCache = new Map<string, Promise<unknown>>();

export function idempotencyKey(sessionId: string, stepName: string): string {
  return createHash("sha256").update(`${sessionId}::${stepName}`).digest("hex");
}

/**
 * Run `fn` exactly once per (sessionId, stepName). Subsequent calls return
 * the cached resolution. Errors are NOT cached — a failed step can be
 * retried — so this is "at-least-once-with-coalescing" not "exactly-once".
 *
 * If two callers enter at the same time, both observe the same in-flight
 * promise, so the body runs once.
 */
export async function withIdempotency<T>(
  sessionId: string,
  stepName: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = idempotencyKey(sessionId, stepName);
  const existing = idempotencyCache.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await fn();
    } catch (err) {
      // Don't cache failures — let the next caller retry the step.
      idempotencyCache.delete(key);
      throw err;
    }
  })();
  idempotencyCache.set(key, promise as Promise<unknown>);
  return promise;
}

/** Test-only helper. Real callers shouldn't need this — the cache is
 *  intentionally process-lifetime in scope. */
export function _clearIdempotencyForTests(): void {
  idempotencyCache.clear();
}
