import type { orchestratorSessions } from "../schema/index.js";

/**
 * Wave 4.3 — Persistence interface for orchestrator-sdk session state.
 *
 * Storing the orchestrator-sdk's `OnboardSession` type was deliberately
 * avoided here so this package keeps no compile-time dependency on
 * @pcc/orchestrator-sdk. Callers (the gateway adapter) translate between
 * the SDK's `OnboardSession` shape and these row types.
 */
export type SessionRow = typeof orchestratorSessions.$inferSelect;
export type SessionInsert = typeof orchestratorSessions.$inferInsert;

export interface IOrchestratorSessionRepository {
  /**
   * Insert-or-replace by primary key. Mirrors the SDK's `Map.set(id, …)`
   * semantics — a write always overwrites the prior row for that id.
   */
  upsert(row: SessionInsert): SessionRow | undefined;

  /** Fetch a single session by id. Returns undefined when absent. */
  findById(id: string): SessionRow | undefined;

  /** Delete a session by id. Idempotent (no-op when absent). */
  delete(id: string): void;

  /**
   * Enumerate every persisted session. Used for restart-recovery so the
   * gateway can rehydrate the in-process state machine after a process
   * restart.
   *
   * TODO(wave-4.1): once tenant scoping lands, accept an optional
   * `tenantId` filter so each gateway replica only resumes its own tenant.
   */
  findAll(): SessionRow[];
}
