// In-memory session store + state machine for operator onboarding.
//
// Discovery state machine:
//   started -> data_connected -> docs_ingested -> interview ->
//   capabilities_drafted -> built
//
// Ported from `LamaSu/navi` packages/backend/src/onboard/state.ts. The map
// store is preserved as a placeholder; Wave 4 of the migration plan replaces
// it with PCC's Postgres + RLS so multiple replicas of the onboarder agent
// can resume sessions across restart. See:
//   docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md (§4.3 Persistent state)
//
// Hardening (Tier 1, 2026-04-29):
//   - T1.4: per-session lock map serializes concurrent advanceSession()
//     calls so voice + chat doorways can't trigger lost updates. The lock is
//     in-memory like the store — when Wave 4 swaps to Postgres + RLS this
//     mutex becomes a row-level lock or advisory lock instead.
//
// TODO(wave-4): replace `store` with a `@pcc/db` table-backed store, drop
// the in-memory mutex in favour of Postgres advisory locks, and add session
// restart recovery. Public function signatures are stable across the swap.

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

const store = new Map<string, OnboardSession>();

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
    store.set(input.id, session);
    return session;
  });
}

export async function getSession(id: string): Promise<OnboardSession | undefined> {
  // Reads don't need the lock — stale-read tolerance is acceptable; the
  // important invariant is that writes don't interleave.
  return store.get(id);
}

export async function advanceSession(
  id: string,
  to: OnboardState,
  patch: Record<string, unknown> = {}
): Promise<OnboardSession> {
  return withLock(id, async () => {
    const current = store.get(id);
    if (!current) throw new Error(`session ${id} not found`);
    const next: OnboardSession = {
      ...current,
      ...patch,
      state: to,
      updated_at: Date.now(),
    };
    store.set(id, next);
    return next;
  });
}

/** Test-only helper: clear all sessions from the in-memory store. Removed
 *  along with the `store` variable when Wave 4 swaps in Postgres. */
export function _resetStoreForTests(): void {
  store.clear();
  locks.clear();
}
