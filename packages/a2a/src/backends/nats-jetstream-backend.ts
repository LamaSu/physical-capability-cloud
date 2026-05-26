/**
 * NATSJetStreamBackend — NATS JetStream-backed implementation of
 * MessageBusBackend.
 *
 * Architecture:
 *   - Lazy connect on first publish/subscribe via nats.js `connect()`.
 *   - Idempotent stream creation: try `streams.info()` first; on 404 add the
 *     stream with subject pattern `pcc.a2a.>`.
 *   - Each subscribe() creates (idempotently) a durable consumer + starts a
 *     `consume()` loop that ack()s every message it dispatches to the user
 *     handler.
 *   - Exponential reconnect: handled by nats.js (`maxReconnectAttempts: 10`
 *     plus a custom `reconnectDelayHandler` that doubles the delay each retry,
 *     capped at 30s, with jitter).
 *   - close() drains in-flight work via `nc.drain()` and is idempotent.
 *
 * Backend semantics:
 *   - publish() returns after the server has persisted the message (PubAck).
 *   - subscribe() resolves once the consumer is bound and the consume loop is
 *     running. The returned unsubscribe() stops the loop and deletes the
 *     ephemeral durable.
 *
 * Test mode:
 *   - The constructor accepts an injected `connectFn` so unit tests can pass
 *     a mocked nats.js client without requiring a running NATS server.
 *
 * To run against a real NATS server, see the integration suite in
 * `__tests__/nats-backend.test.ts`.
 */

import type { A2AMessage } from "../types.js";
import type {
  MessageBusBackend,
  BackendMessageHandler,
  BackendSubscription,
} from "./backend.js";

// ── Public options ──────────────────────────────────────────────────────────

export interface NATSJetStreamBackendOptions {
  /** Server URL(s). Default: nats://localhost:4222 */
  url: string;
  /** JetStream stream name. Default: PCC_A2A */
  streamName: string;
  /** Optional durable consumer name prefix. Defaults to `pcc-a2a-bus`. */
  durableName?: string;
  /**
   * Subject pattern captured by the stream. Defaults to `pcc.a2a.>` so all
   * intent-typed subjects produced by `subjectFor()` flow into one stream.
   */
  streamSubject?: string;
  /** Max reconnect attempts (passed to nats.js). Default: 10. -1 = unlimited. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay in ms. Default 500. */
  reconnectBaseDelayMs?: number;
  /** Cap on the exponential reconnect delay in ms. Default 30000. */
  reconnectMaxDelayMs?: number;
  /**
   * Optional injection for tests: a function with the same signature as
   * nats.js `connect()`. When supplied, the backend uses this instead of
   * loading the real `nats` module. Production code SHOULD NOT pass this.
   */
  connectFn?: NatsConnectFn;
}

// ── Minimal type surface we depend on (covers nats.js 2.x) ──────────────────
// Defined as a local structural type so tests can mock without importing
// the real `nats` module (which would force CI to install it).

export interface NatsConnectFn {
  (opts: NatsConnectionOptions): Promise<NatsConnectionLike>;
}

export interface NatsConnectionOptions {
  servers?: string | string[];
  maxReconnectAttempts?: number;
  reconnect?: boolean;
  reconnectDelayHandler?: () => number;
  name?: string;
  timeout?: number;
}

export interface NatsConnectionLike {
  isClosed(): boolean;
  isDraining(): boolean;
  drain(): Promise<void>;
  close(): Promise<void>;
  jetstream(): JetStreamClientLike;
  jetstreamManager(): Promise<JetStreamManagerLike>;
}

export interface PubAckLike {
  seq: number;
  stream: string;
  duplicate?: boolean;
}

export interface JetStreamClientLike {
  publish(subject: string, payload: Uint8Array): Promise<PubAckLike>;
  consumers: {
    get(stream: string, name: string): Promise<ConsumerLike>;
  };
}

export interface ConsumerMessagesLike extends AsyncIterable<JsMsgLike> {
  stop(): void;
}

export interface ConsumerLike {
  consume(): Promise<ConsumerMessagesLike>;
  delete(): Promise<boolean>;
}

export interface JsMsgLike {
  data: Uint8Array;
  ack(): void;
  nak(millis?: number): void;
  string(): string;
  // Allow extra props without typing them
  [k: string]: unknown;
}

export interface JetStreamManagerLike {
  streams: {
    info(name: string): Promise<unknown>;
    add(cfg: { name: string; subjects: string[] }): Promise<unknown>;
  };
  consumers: {
    info(stream: string, name: string): Promise<unknown>;
    add(stream: string, cfg: ConsumerAddConfig): Promise<unknown>;
  };
}

export interface ConsumerAddConfig {
  durable_name: string;
  ack_policy: "explicit" | "none" | "all";
  filter_subject?: string;
  deliver_policy?: "all" | "new" | "last" | "by_start_sequence" | "by_start_time";
  max_ack_pending?: number;
  // Allow other server-side fields to pass through
  [k: string]: unknown;
}

// ── Implementation ──────────────────────────────────────────────────────────

const DEFAULT_STREAM_SUBJECT = "pcc.a2a.>";
const DEFAULT_DURABLE_PREFIX = "pcc-a2a-bus";

export class NATSJetStreamBackend implements MessageBusBackend {
  readonly name = "nats";

  private readonly opts: Required<
    Omit<NATSJetStreamBackendOptions, "durableName" | "connectFn">
  > & {
    durableName: string;
    connectFn?: NatsConnectFn;
  };

  /** Resolved on the first connect(); reused after that. */
  private nc?: NatsConnectionLike;
  /** Cached JetStream client (lives on top of nc). */
  private js?: JetStreamClientLike;
  /** Cached JetStream manager (lives on top of nc). */
  private jsm?: JetStreamManagerLike;
  /** One-shot connection promise, so concurrent callers share the same handshake. */
  private connectPromise?: Promise<void>;
  /** True once close() has been invoked; further calls reject. */
  private closed = false;
  /** Reconnect attempt counter (drives exponential delay). */
  private reconnectAttempt = 0;
  /** Track every subscription so close() can stop them all. */
  private subs: Set<InternalSubscription> = new Set();
  /** Bumped on each subscribe() so each durable name is unique within a process. */
  private nextSubId = 1;

  constructor(opts: NATSJetStreamBackendOptions) {
    this.opts = {
      url: opts.url,
      streamName: opts.streamName,
      durableName: opts.durableName ?? DEFAULT_DURABLE_PREFIX,
      streamSubject: opts.streamSubject ?? DEFAULT_STREAM_SUBJECT,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
      reconnectBaseDelayMs: opts.reconnectBaseDelayMs ?? 500,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 30_000,
      connectFn: opts.connectFn,
    };
  }

  // ── public surface ────────────────────────────────────────────────────────

  async publish(subject: string, message: A2AMessage): Promise<void> {
    this.assertOpen();
    await this.ensureReady();
    const payload = encodeMessage(message);
    await this.js!.publish(subject, payload);
  }

  async subscribe(
    subject: string,
    handler: BackendMessageHandler,
  ): Promise<BackendSubscription> {
    this.assertOpen();
    await this.ensureReady();

    const subId = this.nextSubId++;
    const durable = `${this.opts.durableName}-${subId}`;

    // Idempotent consumer creation: info() first, then add() if missing.
    try {
      await this.jsm!.consumers.info(this.opts.streamName, durable);
    } catch {
      await this.jsm!.consumers.add(this.opts.streamName, {
        durable_name: durable,
        ack_policy: "explicit",
        filter_subject: subject,
        deliver_policy: "new",
        max_ack_pending: 1000,
      });
    }

    const consumer = await this.js!.consumers.get(this.opts.streamName, durable);
    const messages = await consumer.consume();

    const internal: InternalSubscription = {
      subject,
      durable,
      consumer,
      messages,
      stopped: false,
      unsubscribe: async () => {
        if (internal.stopped) return;
        internal.stopped = true;
        try {
          messages.stop();
        } catch {
          // ignore — stopping a partially-initialized iterator is best-effort
        }
        try {
          await consumer.delete();
        } catch {
          // The consumer may already be gone (e.g. server restart). Best-effort.
        }
        this.subs.delete(internal);
      },
    };
    this.subs.add(internal);

    // Drive the message loop in the background; errors are logged but never
    // thrown back to the bus (handlers run inside try/catch).
    void this.runConsumeLoop(internal, handler);

    return {
      subject,
      unsubscribe: internal.unsubscribe,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop all subscriptions first so no more messages flow.
    const subUnsubs = Array.from(this.subs).map((s) =>
      s.unsubscribe().catch((err) => {
        // Best-effort — log and continue draining the rest.
        // eslint-disable-next-line no-console
        console.error(`[NATSJetStreamBackend] unsubscribe error during close:`, err);
      }),
    );
    await Promise.all(subUnsubs);

    if (this.nc && !this.nc.isClosed()) {
      try {
        await this.nc.drain();
      } catch (err) {
        // drain may fail if already draining/closed; fall through to close.
        // eslint-disable-next-line no-console
        console.error(`[NATSJetStreamBackend] drain error during close:`, err);
        try {
          await this.nc.close();
        } catch {
          // Already closed.
        }
      }
    }

    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    this.connectPromise = undefined;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("NATSJetStreamBackend: backend is closed");
    }
  }

  /**
   * Idempotent lazy connect + JetStream readiness. Concurrent callers share
   * the same `connectPromise` so we never open two connections.
   */
  private async ensureReady(): Promise<void> {
    if (this.nc && !this.nc.isClosed() && this.js && this.jsm) return;
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().catch((err) => {
        // Reset so the next call can retry; surface the error.
        this.connectPromise = undefined;
        throw err;
      });
    }
    await this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const connect = this.opts.connectFn ?? (await loadRealConnect());

    const nc = await connect({
      servers: this.opts.url,
      maxReconnectAttempts: this.opts.maxReconnectAttempts,
      reconnect: true,
      reconnectDelayHandler: () => this.computeReconnectDelay(),
      name: "pcc-a2a-bus",
    });
    this.nc = nc;
    this.js = nc.jetstream();
    this.jsm = await nc.jetstreamManager();
    // Reset reconnect counter on successful connect.
    this.reconnectAttempt = 0;

    await this.ensureStream();
  }

  /**
   * Compute the next reconnect delay using exponential backoff with bounded
   * jitter. Each call advances the attempt counter, so successive nats.js
   * reconnect attempts walk up the curve.
   *
   *   delay = min(base * 2^attempt, max) + uniform_jitter(0, base/2)
   */
  private computeReconnectDelay(): number {
    const attempt = this.reconnectAttempt++;
    const expo = this.opts.reconnectBaseDelayMs * 2 ** attempt;
    const capped = Math.min(expo, this.opts.reconnectMaxDelayMs);
    const jitter = Math.floor(Math.random() * (this.opts.reconnectBaseDelayMs / 2));
    return capped + jitter;
  }

  /**
   * Idempotent: try streams.info() first; on any error treat it as missing
   * and call streams.add(). This matches the JetStream docs' recommended
   * "create-if-not-exists" pattern.
   */
  private async ensureStream(): Promise<void> {
    if (!this.jsm) throw new Error("NATSJetStreamBackend: jsm not ready");
    try {
      await this.jsm.streams.info(this.opts.streamName);
      return;
    } catch {
      await this.jsm.streams.add({
        name: this.opts.streamName,
        subjects: [this.opts.streamSubject],
      });
    }
  }

  /**
   * Pulls messages off a `consume()` iterator, decodes them, and hands them
   * to the user handler. After a successful handler invocation the message
   * is ack()ed. On handler error, nak() is called so JetStream redelivers.
   *
   * Stops gracefully when the iterator ends (close/drain) or when the
   * subscription is marked stopped.
   */
  private async runConsumeLoop(
    sub: InternalSubscription,
    handler: BackendMessageHandler,
  ): Promise<void> {
    try {
      for await (const msg of sub.messages) {
        if (sub.stopped) break;
        let decoded: A2AMessage;
        try {
          decoded = decodeMessage(msg.data);
        } catch (err) {
          // Bad payload — ack so we don't redeliver forever. Log loudly.
          // eslint-disable-next-line no-console
          console.error(
            `[NATSJetStreamBackend] failed to decode message on ${sub.subject}:`,
            err,
          );
          try {
            msg.ack();
          } catch {
            // ignore
          }
          continue;
        }
        try {
          await handler(decoded);
          msg.ack();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[NATSJetStreamBackend] handler error on ${sub.subject}:`,
            err,
          );
          try {
            // Negatively-ack with a short backoff so JetStream redelivers.
            msg.nak(1000);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      if (!sub.stopped && !this.closed) {
        // eslint-disable-next-line no-console
        console.error(
          `[NATSJetStreamBackend] consume loop ended unexpectedly on ${sub.subject}:`,
          err,
        );
      }
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface InternalSubscription {
  subject: string;
  durable: string;
  consumer: ConsumerLike;
  messages: ConsumerMessagesLike;
  stopped: boolean;
  unsubscribe: () => Promise<void>;
}

/**
 * Encode an A2A message for the wire. JSON is the lowest-friction encoding
 * given existing test/observability tooling — every span and log already
 * carries the deserialized object. We are NOT optimizing for wire size here.
 */
function encodeMessage(msg: A2AMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decodeMessage(data: Uint8Array): A2AMessage {
  const text = new TextDecoder().decode(data);
  const parsed = JSON.parse(text) as A2AMessage;
  if (!parsed || typeof parsed !== "object" || !parsed.id) {
    throw new Error("decoded payload is not a valid A2AMessage");
  }
  return parsed;
}

/**
 * Lazy-load the real nats.js `connect`. Isolated so the backend module can be
 * imported with the dep absent (consumers using a mocked `connectFn` never
 * touch this path).
 */
async function loadRealConnect(): Promise<NatsConnectFn> {
  // The dynamic import string is intentionally a bare specifier so bundlers
  // can leave it as a runtime require. Cast through `unknown` because the
  // upstream type surface is larger than our structural minimum.
  const mod = (await import("nats")) as unknown as { connect: NatsConnectFn };
  return mod.connect;
}
