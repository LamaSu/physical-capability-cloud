/**
 * In-memory ring buffer of recent template-match queries.
 *
 * T2.4 — used by the discoverability diagnostics route to surface what
 * keywords buyers searched for that did NOT match a given operator. This is
 * a deliberately lightweight implementation: no persistence (lost on
 * deploy), bounded buffer to stop memory growth. If we need durable
 * analytics later, the table for it is `analytics_events` in @pcc/store
 * (already wired); this service is a pre-table prototype.
 *
 * The buffer is process-local. Multi-instance deployments will see
 * per-instance views, which is acceptable for a placeholder/heuristic
 * surface.
 */

export interface MatchQueryEntry {
  /** ISO timestamp when the query was issued. */
  timestamp: string;
  /** Free-text query the buyer issued. */
  query: string;
  /** Match score for the operator under test (0-1, higher = better match). */
  score: number;
  /** Operator that was scored against this query. */
  operatorId: string;
}

const MAX_BUFFER_SIZE = 500;
let buffer: MatchQueryEntry[] = [];

export function recordMatchQuery(entry: Omit<MatchQueryEntry, "timestamp">): void {
  const fullEntry: MatchQueryEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  buffer.push(fullEntry);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(-MAX_BUFFER_SIZE);
  }
}

export function listMatchQueriesForOperator(operatorId: string): MatchQueryEntry[] {
  return buffer.filter((e) => e.operatorId === operatorId);
}

/** Test-only: wipe the buffer between tests. */
export function _clearMatchLogForTests(): void {
  buffer = [];
}
