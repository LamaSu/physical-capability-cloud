/**
 * MessageBusBackend — the pluggable transport interface used by MessageBus.
 *
 * The bus class itself owns conversation tracking, security scanning,
 * tracing, and handler-fan-out. The backend's only job is to move bytes
 * (a serialized A2AMessage) between processes by `subject`.
 *
 * Subjects follow the pattern `pcc.a2a.<intent-type>` (e.g.
 * `pcc.a2a.request_quote`). Backends MUST NOT inspect message contents —
 * the subject is the only routing signal at this layer.
 *
 * Backends MUST be safe to call publish/subscribe before any explicit
 * connect step (lazy connect on first call is fine).
 *
 * close() MUST be idempotent and safe to call after errors.
 */

import type { A2AMessage } from "../types.js";

/** Handler invoked when a subscribed subject receives a message */
export type BackendMessageHandler = (message: A2AMessage) => void | Promise<void>;

/** Handle returned from subscribe(); call unsubscribe() to detach. */
export interface BackendSubscription {
  /** Identifier for diagnostics (subject + suffix) */
  readonly subject: string;
  /** Detach this handler from the backend. Idempotent. */
  unsubscribe(): Promise<void>;
}

export interface MessageBusBackend {
  /** Backend identifier for diagnostics ("memory" | "nats" | etc.) */
  readonly name: string;

  /**
   * Publish a single message to a subject. Returns when the backend has
   * accepted the message (NOT when it has been delivered to subscribers).
   *
   * For at-least-once backends (NATS JetStream), this returns after the
   * server has persisted the message. For in-memory, returns after handlers
   * have run.
   */
  publish(subject: string, message: A2AMessage): Promise<void>;

  /**
   * Subscribe a handler to a subject. The subject MAY include wildcards
   * (NATS-style: `*` matches one token, `>` matches the rest). The
   * in-memory backend only supports exact subjects and `pcc.a2a.>`
   * (everything) — the bus class itself does not currently use wildcards.
   */
  subscribe(
    subject: string,
    handler: BackendMessageHandler,
  ): Promise<BackendSubscription>;

  /**
   * Gracefully drain in-flight work and close all resources. After close,
   * publish/subscribe MUST throw or reject. Idempotent.
   */
  close(): Promise<void>;
}
