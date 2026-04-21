/**
 * @pcc/alerts — shared types.
 *
 * Kept tiny and dependency-free so notifier/source modules can import without
 * pulling in fastify/viem transitively.
 *
 * Author: implementer-alpha
 */

/** Severity scale. Mirrors Discord embed colors used by the Discord notifier. */
export type Severity = "info" | "warning" | "critical";

/** Broad classifier describing which subsystem emitted the alert. */
export type AlertSource = "chain-watcher" | "rpc-health" | "heartbeat" | "manual";

/** A single fired alert. In-memory only — persistence is out of scope for v1. */
export interface Alert {
  /** ISO-8601 timestamp the alert fired at (source-side, not notifier-side). */
  ts: string;
  /** Subsystem that fired it. */
  source: AlertSource;
  /** Severity of this occurrence. */
  severity: Severity;
  /** Short (< 120 char) one-line human summary. */
  title: string;
  /** Longer body. May be multi-line. */
  body: string;
  /**
   * Arbitrary structured context (tx hash, event args, probe window, worker id).
   * Must be JSON-serializable; notifiers may stringify it for display.
   */
  context?: Record<string, unknown>;
}
