import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startSession,
  getSession,
  advanceSession,
  setSessionStore,
  getSessionStore,
  restoreSessionsFrom,
  InMemorySessionStore,
  _resetStoreInstanceForTests,
  type SessionStore,
  type OnboardSession,
} from "./state-machine.js";

// ─── Test fixtures ──────────────────────────────────────────────────────────
//
// We avoid pulling in @pcc/store / better-sqlite3 from this package's tests
// (would couple the SDK to a specific backing store). Instead we use:
//
//   1. SimulatedPersistentStore — a Map-based store that survives module
//      reset via a static Map. This is the proxy for SQLite/Postgres in
//      these unit tests; the actual SQLite round-trip is exercised by the
//      gateway-side adapter tests in
//      packages/gateway/src/__tests__/orchestrator-session-store.test.ts.
//   2. CountingStore — tracks every method call so we can assert the
//      state-machine routes through the active store.

class SimulatedPersistentStore implements SessionStore {
  // `static` so the data survives a module reset — emulates the behaviour
  // of an external DB (SQLite file, Postgres) where the rows persist past
  // an in-process module reload.
  static rows = new Map<string, OnboardSession>();
  get(id: string) {
    return SimulatedPersistentStore.rows.get(id);
  }
  set(id: string, s: OnboardSession) {
    SimulatedPersistentStore.rows.set(id, s);
  }
  delete(id: string) {
    SimulatedPersistentStore.rows.delete(id);
  }
  list() {
    return [...SimulatedPersistentStore.rows.values()];
  }
  static clear() {
    SimulatedPersistentStore.rows.clear();
  }
}

class CountingStore implements SessionStore {
  inner = new Map<string, OnboardSession>();
  calls = { get: 0, set: 0, delete: 0, list: 0 };
  get(id: string) {
    this.calls.get++;
    return this.inner.get(id);
  }
  set(id: string, s: OnboardSession) {
    this.calls.set++;
    this.inner.set(id, s);
  }
  delete(id: string) {
    this.calls.delete++;
    this.inner.delete(id);
  }
  list() {
    this.calls.list++;
    return [...this.inner.values()];
  }
}

beforeEach(() => {
  _resetStoreInstanceForTests();
  SimulatedPersistentStore.clear();
});

afterEach(() => {
  _resetStoreInstanceForTests();
  SimulatedPersistentStore.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Wave 4.3 — pluggable SessionStore", () => {
  it("setSessionStore swaps the active store; reads and writes route through it", async () => {
    const counter = new CountingStore();
    setSessionStore(counter);
    expect(getSessionStore()).toBe(counter);

    await startSession({ id: "p-1", name: "PluggableCo" });
    expect(counter.calls.set).toBeGreaterThanOrEqual(1);

    const found = await getSession("p-1");
    expect(found?.state).toBe("started");
    expect(found?.name).toBe("PluggableCo");
    expect(counter.calls.get).toBeGreaterThanOrEqual(1);

    await advanceSession("p-1", "data_connected", { data_sources: [{ kind: "csv" }] });
    const advanced = await getSession("p-1");
    expect(advanced?.state).toBe("data_connected");
    expect(advanced?.data_sources).toEqual([{ kind: "csv" }]);
  });

  it("restart-recovery: state survives a simulated process restart on a persistent store", async () => {
    setSessionStore(new SimulatedPersistentStore());
    await startSession({ id: "r-1", name: "RestartCo", url: "https://restart.example" });
    await advanceSession("r-1", "data_connected", { data_sources: [{ kind: "postgres" }] });

    // Snapshot what's in the "DB" before the restart.
    const persistedSnapshot = SimulatedPersistentStore.rows.get("r-1");
    expect(persistedSnapshot?.state).toBe("data_connected");
    expect(persistedSnapshot?.url).toBe("https://restart.example");

    // ─── Simulated process restart ─────────────────────────────────────────
    // Reset module-internal state (locks + in-memory store + idempotency
    // cache) — emulating a fresh Node process. The "DB" rows survive
    // because SimulatedPersistentStore.rows is a static Map.
    _resetStoreInstanceForTests();
    expect(getSessionStore()).toBeInstanceOf(InMemorySessionStore);

    // Re-wire the persistent store after the restart, mirroring what the
    // gateway does in server.ts (setSessionStore at startup).
    setSessionStore(new SimulatedPersistentStore());

    // Read-through: the row is still there.
    const recovered = await getSession("r-1");
    expect(recovered).toBeDefined();
    expect(recovered?.state).toBe("data_connected");
    expect(recovered?.name).toBe("RestartCo");
    expect(recovered?.data_sources).toEqual([{ kind: "postgres" }]);

    // Continue the workflow from where it was. The state-machine reads
    // the persisted row, applies the patch, and writes back — proving
    // the resume path works.
    const resumed = await advanceSession("r-1", "docs_ingested", {
      extras: { docs_count: 3 },
    });
    expect(resumed.state).toBe("docs_ingested");
    expect(resumed.extras).toEqual({ docs_count: 3 });
    expect(resumed.data_sources).toEqual([{ kind: "postgres" }]); // patches accumulate
  });

  it("restoreSessionsFrom enumerates non-built sessions and copies them into the active store", () => {
    // Simulate a "previous gateway process" that left rows in a persistent
    // store across two sessions, one in-flight and one already built.
    SimulatedPersistentStore.rows.set("a", {
      id: "a",
      name: "ACo",
      state: "data_connected",
      updated_at: 1,
    });
    SimulatedPersistentStore.rows.set("b", {
      id: "b",
      name: "BCo",
      state: "built",
      updated_at: 2,
    });

    // The active store is the default in-memory one (post-restart).
    const persistent = new SimulatedPersistentStore();
    expect(getSessionStore()).toBeInstanceOf(InMemorySessionStore);

    restoreSessionsFrom(persistent);

    const active = getSessionStore();
    expect(active.get("a")?.state).toBe("data_connected");
    expect(active.get("b")).toBeUndefined(); // built sessions are skipped
  });

  it("restoreSessionsFrom is a no-op when src === activeStore (avoid double-write)", () => {
    const counter = new CountingStore();
    counter.inner.set("x", {
      id: "x",
      name: "XCo",
      state: "interview",
      updated_at: 5,
    });
    setSessionStore(counter);
    expect(getSessionStore()).toBe(counter);

    const setsBefore = counter.calls.set;
    restoreSessionsFrom(counter);
    expect(counter.calls.set).toBe(setsBefore); // no extra writes
  });

  it("per-session mutex still serialises concurrent advances on a persistent store", async () => {
    setSessionStore(new SimulatedPersistentStore());
    await startSession({ id: "m-1", name: "MutexCo" });

    // 25 concurrent advances each writing a unique key. The lock guarantees
    // FIFO application; without it, two callers could read the same
    // `current` and overwrite each other's intermediate state.
    const promises = Array.from({ length: 25 }, (_, i) =>
      advanceSession("m-1", "data_connected", { extras: { [`k${i}`]: i } })
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(25);

    // Final state is observable and consistent.
    const final = await getSession("m-1");
    expect(final?.state).toBe("data_connected");
    expect(final?.updated_at).toBeGreaterThan(0);
    // Every patch was a fresh extras object; with the lock the LAST
    // write wins deterministically (extras has exactly one key).
    expect(Object.keys(final?.extras ?? {})).toHaveLength(1);
  });
});
