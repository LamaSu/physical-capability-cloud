// Deterministic-replay snapshot helper.
//
// A "snapshot" is a serializable freeze of an orchestrator session at a point
// in time: state-machine state, event-bus tail (since the last snapshot), and
// any arbitrary template-defined extras. Snapshots are designed to be
// content-addressable (same inputs → same hash) so a later replay can verify
// that the agent's behavior is reproducible given the same prompt + tool
// outputs. Wave 4 of the migration plan turns this into the persistence
// substrate; today it's an in-memory + JSON-serializable contract.
//
// Stays under 80 LoC by design — anything more complex (storage, replay
// runner) goes in `runner.ts` (Wave 3+).

import type { AppEvent } from "./event-bus.js";
import type { OnboardSession } from "./state-machine.js";

export interface OrchestratorSnapshot {
  /** ISO timestamp of when the snapshot was taken. */
  taken_at: string;
  /** Optional session id this snapshot belongs to. */
  session_id?: string;
  /** State-machine state at snapshot time (template-defined shape). */
  state?: OnboardSession | Record<string, unknown>;
  /** Event tail since the previous snapshot (or session start). */
  events: AppEvent[];
  /** Free-form template extras (e.g., partial extraction, draft capabilities). */
  extras?: Record<string, unknown>;
}

export interface TakeSnapshotOptions {
  session_id?: string;
  state?: OnboardSession | Record<string, unknown>;
  events?: AppEvent[];
  extras?: Record<string, unknown>;
}

/** Build a snapshot. Pure — given the same inputs, returns the same shape
 *  (modulo `taken_at`). Use `serialize()` if you need a content-addressable
 *  hash key. */
export function takeSnapshot(opts: TakeSnapshotOptions = {}): OrchestratorSnapshot {
  return {
    taken_at: new Date().toISOString(),
    session_id: opts.session_id,
    state: opts.state,
    events: [...(opts.events ?? [])],
    extras: opts.extras ? { ...opts.extras } : undefined,
  };
}

/** Stable JSON serialization. Top-level keys are emitted in alphabetical order
 *  so a hash is reproducible across runs. Excludes `taken_at` from the output
 *  by default so two snapshots with identical state but different timestamps
 *  hash equally. */
export function serialize(
  s: OrchestratorSnapshot,
  opts: { includeTimestamp?: boolean } = {}
): string {
  const { includeTimestamp = false } = opts;
  // Build with sorted keys explicitly — JSON.stringify's replacer-array
  // mechanism only filters at depth 1 and silently re-types array items.
  const ordered: Record<string, unknown> = {};
  const fields: Array<keyof OrchestratorSnapshot> = includeTimestamp
    ? ["events", "extras", "session_id", "state", "taken_at"]
    : ["events", "extras", "session_id", "state"];
  for (const k of fields) {
    if (s[k] !== undefined) ordered[k] = s[k];
  }
  return JSON.stringify(ordered);
}

/** Restore a snapshot from its serialized form. Inverse of `serialize`
 *  (when called with `includeTimestamp: true`). */
export function deserialize(json: string): OrchestratorSnapshot {
  const parsed = JSON.parse(json) as Partial<OrchestratorSnapshot>;
  return {
    taken_at: parsed.taken_at ?? new Date(0).toISOString(),
    session_id: parsed.session_id,
    state: parsed.state,
    events: Array.isArray(parsed.events) ? parsed.events : [],
    extras: parsed.extras,
  };
}
