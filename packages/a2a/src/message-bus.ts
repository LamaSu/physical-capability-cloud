/**
 * A2A Message Bus — pluggable-backend pub/sub for agent communication.
 *
 * Architecture (refactored 2026-05-23):
 *
 *   MessageBus (this class)                       — owns conversation tracking,
 *      |                                            security scanning, OTel/Sentry
 *      |                                            spans, per-agent fanout
 *      v
 *   MessageBusBackend (interface)                 — moves bytes between processes
 *      ├─ InMemoryBackend (default)                — pure in-process pub/sub
 *      └─ NATSJetStreamBackend (PCC_MESSAGE_BUS_BACKEND=nats)
 *
 * Wire compatibility: existing callers of `new MessageBus()` get identical
 * behavior to the previous in-memory implementation. The backend is selected
 * via the optional constructor arg or via `setBackend()`; if neither is
 * called, an `InMemoryBackend` is created on first use.
 */

import type {
  A2AMessage,
  AgentCard,
  Conversation,
  Intent,
  AnomalyDetectedIntent,
  ProtocolFailureIntent,
  SystemAlertIntent,
} from "./types.js";
import type { SecurityMiddleware } from "./security-middleware.js";
import type {
  MessageBusBackend,
  BackendSubscription,
} from "./backends/backend.js";
import {
  InMemoryBackend,
  subjectFor,
  ALL_A2A_SUBJECTS,
} from "./backends/index.js";
import * as Sentry from "@sentry/node";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";

/** Shared tracer for A2A message spans */
const a2aTracer = trace.getTracer("pcc-a2a", "2.0.0");

type MessageHandler = (message: A2AMessage) => void | Promise<void>;
type AnomalyHandler = (intent: AnomalyDetectedIntent | ProtocolFailureIntent | SystemAlertIntent) => void;

/** Intent types that trigger anomaly broadcast in addition to point-to-point delivery */
const ANOMALY_INTENT_TYPES = new Set(["anomaly_detected", "protocol_failure", "system_alert"]);

export class MessageBus {
  private agents: Map<string, AgentCard> = new Map();
  private handlers: Map<string, MessageHandler[]> = new Map();
  private conversations: Map<string, Conversation> = new Map();
  private security?: SecurityMiddleware;
  private anomalyListeners: AnomalyHandler[] = [];

  private backend: MessageBusBackend;
  /** Single wildcard subscription that routes incoming backend messages
   *  to per-agent handlers. Established lazily on first subscribe(). */
  private wildcardSub?: BackendSubscription;
  /** Track delivered message IDs to suppress double-dispatch when the
   *  backend echoes our own publish back through the wildcard sub. */
  private deliveredIds: Set<string> = new Set();
  /** Cap deliveredIds set growth */
  private readonly maxDeliveredIds = 10_000;

  constructor(backend?: MessageBusBackend) {
    this.backend = backend ?? new InMemoryBackend();
  }

  /** Replace the backend (test/integration use; not for production hot-swap). */
  async setBackend(backend: MessageBusBackend): Promise<void> {
    if (this.wildcardSub) {
      await this.wildcardSub.unsubscribe();
      this.wildcardSub = undefined;
    }
    await this.backend.close().catch(() => {});
    this.backend = backend;
    // Re-establish wildcard sub if we previously had subscribers
    if (this.handlers.size > 0) {
      await this.ensureWildcardSub();
    }
  }

  /** Get the active backend (for diagnostics / tests) */
  getBackend(): MessageBusBackend {
    return this.backend;
  }

  /** Set security middleware — if set, all messages are scanned before delivery */
  setSecurityMiddleware(mw: SecurityMiddleware): void {
    this.security = mw;
  }

  /**
   * Register an anomaly listener. All anomaly_detected, protocol_failure, and
   * system_alert intents are broadcast to every registered listener regardless
   * of the message's `to` field (fan-out pattern — not point-to-point).
   */
  onAnomaly(callback: AnomalyHandler): void {
    this.anomalyListeners.push(callback);
  }

  /** Register an agent on the bus */
  register(card: AgentCard): void {
    this.agents.set(card.id, card);
    if (!this.handlers.has(card.id)) {
      this.handlers.set(card.id, []);
    }
  }

  /** Unregister an agent */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
    this.handlers.delete(agentId);
  }

  /** Subscribe to messages addressed to this agent */
  subscribe(agentId: string, handler: MessageHandler): void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);
    // Fire-and-forget: ensure the backend wildcard sub is active. We don't
    // await here to preserve the synchronous public API; first publish will
    // observe the established sub.
    void this.ensureWildcardSub();
  }

  private async ensureWildcardSub(): Promise<void> {
    if (this.wildcardSub) return;
    this.wildcardSub = await this.backend.subscribe(
      ALL_A2A_SUBJECTS,
      (msg) => this.deliverFromBackend(msg),
    );
  }

  /**
   * Mark a message ID as already-delivered (so the wildcard sub from the
   * backend doesn't double-fire). Bounded LRU-ish set.
   */
  private markDelivered(id: string): void {
    if (this.deliveredIds.size >= this.maxDeliveredIds) {
      const drop = Math.floor(this.maxDeliveredIds / 8);
      let n = 0;
      for (const k of this.deliveredIds) {
        this.deliveredIds.delete(k);
        if (++n >= drop) break;
      }
    }
    this.deliveredIds.add(id);
  }

  /** Send a message from one agent to another */
  async send(message: A2AMessage): Promise<void> {
    // Security scan — throws SecurityError if blocked
    if (this.security) {
      await this.security.scanMessage(message);
    }

    // Inject current W3C Trace Context into the message so the receiving agent
    // can create child spans linked to the sender's active trace.
    const carrier: { traceparent?: string; tracestate?: string } = {};
    propagation.inject(context.active(), carrier);
    if (carrier.traceparent) {
      message = { ...message, traceContext: carrier };
    }

    // Track in conversation
    this.trackConversation(message);

    // Dispatch handlers locally FIRST (preserves the existing tested
    // semantics: send() resolves only after handlers have run), then publish
    // to the backend so other processes can see it. Mark the ID so the
    // wildcard sub doesn't deliver it again.
    this.markDelivered(message.id);
    await this.dispatchToLocalHandlers(message);
    await this.publishToBackendIfRemote(message);

    // Anomaly broadcast — fan-out to all anomaly listeners regardless of `to`
    if (ANOMALY_INTENT_TYPES.has(message.intent.type)) {
      const anomalyIntent = message.intent as AnomalyDetectedIntent | ProtocolFailureIntent | SystemAlertIntent;
      for (const listener of this.anomalyListeners) {
        try {
          listener(anomalyIntent);
        } catch (err) {
          console.error(`Anomaly listener error for intent ${message.intent.type}:`, err);
        }
      }
    }
  }

  /**
   * For the in-memory backend, dispatch happens inline above and there is
   * no need to publish — this single-process bus has no peers to inform.
   * For network backends (NATS), publish so peer processes get the message.
   */
  private async publishToBackendIfRemote(message: A2AMessage): Promise<void> {
    if (this.backend.name === "memory") return;
    try {
      await this.backend.publish(subjectFor(message.intent.type), message);
    } catch (err) {
      console.error(
        `[MessageBus] backend publish failed (intent=${message.intent.type}):`,
        err,
      );
      // Do not throw — local delivery already succeeded. Network drops are
      // observable via the backend's own metrics / connection state.
    }
  }

  /**
   * Called by the backend wildcard sub when a message arrives from a peer
   * process. Idempotent — drops messages we already delivered locally.
   */
  private async deliverFromBackend(message: A2AMessage): Promise<void> {
    if (this.deliveredIds.has(message.id)) return;
    this.markDelivered(message.id);
    this.trackConversation(message);
    await this.dispatchToLocalHandlers(message);
  }

  /** Per-recipient handler fan-out with OTel + Sentry spans */
  private async dispatchToLocalHandlers(message: A2AMessage): Promise<void> {
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
      try {
        const parentCtx = message.traceContext
          ? propagation.extract(context.active(), message.traceContext)
          : context.active();

        await a2aTracer.startActiveSpan(
          `a2a.handler.${message.intent.type}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              "a2a.intent": message.intent.type,
              "a2a.from": message.from,
              "a2a.to": message.to,
              "a2a.conversation_id": message.conversationId,
              "a2a.traceparent": message.traceContext?.traceparent ?? "",
            },
          },
          parentCtx,
          async (span) => {
            try {
              await Sentry.startSpan(
                {
                  name: `a2a.handler.${message.intent.type}`,
                  op: "a2a.message",
                  attributes: {
                    "a2a.intent": message.intent.type,
                    "a2a.from": message.from,
                    "a2a.to": message.to,
                    "a2a.conversation_id": message.conversationId,
                  },
                },
                async () => handler(message),
              );
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      } catch (err) {
        console.error(`Handler error for agent ${message.to}:`, err);
      }
    }
  }

  /** Track conversation aggregate — idempotent on (conversationId, message.id). */
  private trackConversation(message: A2AMessage): void {
    let convo = this.conversations.get(message.conversationId);
    if (!convo) {
      convo = {
        id: message.conversationId,
        participants: [message.from, message.to],
        messages: [],
        status: "active",
        topic: message.intent.type,
        createdAt: message.timestamp,
        updatedAt: message.timestamp,
      };
      this.conversations.set(message.conversationId, convo);
    }
    if (!convo.messages.find((m) => m.id === message.id)) {
      convo.messages.push(message);
    }
    if (message.timestamp > convo.updatedAt) {
      convo.updatedAt = message.timestamp;
    }
    if (!convo.participants.includes(message.from)) convo.participants.push(message.from);
    if (!convo.participants.includes(message.to)) convo.participants.push(message.to);
  }

  /** Broadcast to all agents with a specific role */
  async broadcast(message: A2AMessage, role?: string): Promise<void> {
    // Security scan — throws SecurityError if blocked
    if (this.security) {
      await this.security.scanMessage(message);
    }

    const targets = role
      ? [...this.agents.values()].filter((a) => a.role === role)
      : [...this.agents.values()];

    for (const agent of targets) {
      if (agent.id === message.from) continue;
      // Use internal delivery (already scanned above)
      await this._deliverTo({ ...message, to: agent.id });
    }
  }

  /** Internal delivery without re-scanning (used by broadcast after scan) */
  private async _deliverTo(message: A2AMessage): Promise<void> {
    this.trackConversation(message);
    this.markDelivered(message.id);
    await this.dispatchToLocalHandlers(message);
    await this.publishToBackendIfRemote(message);
  }

  /** Find agents by role */
  findAgents(role?: string): AgentCard[] {
    if (!role) return [...this.agents.values()];
    return [...this.agents.values()].filter((a) => a.role === role);
  }

  /** Find a specific agent by ID */
  getAgent(id: string): AgentCard | undefined {
    return this.agents.get(id);
  }

  /** Find agents that support a specific intent */
  findByIntent(intentType: string): AgentCard[] {
    return [...this.agents.values()].filter((a) =>
      a.supportedIntents.includes(intentType),
    );
  }

  /** Get a conversation */
  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /** Get all conversations for an agent */
  getConversationsFor(agentId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) =>
      c.participants.includes(agentId),
    );
  }

  /**
   * Close the bus and its backend. After close, send/subscribe is undefined
   * behavior. Existing tests don't call this so it's additive.
   */
  async close(): Promise<void> {
    if (this.wildcardSub) {
      await this.wildcardSub.unsubscribe().catch(() => {});
      this.wildcardSub = undefined;
    }
    await this.backend.close().catch(() => {});
  }

  /**
   * Seed a message into the in-memory conversation map WITHOUT dispatching
   * to any registered handlers. Used exclusively by PersistentMessageBus.rehydrate()
   * to warm the conversation cache from persisted data on startup.
   *
   * This is idempotent: if the message ID already exists in the conversation's
   * message list, it will not be added again.
   */
  protected _seedConversation(id: string, messages: A2AMessage[]): void {
    for (const message of messages) {
      let convo = this.conversations.get(id);
      if (!convo) {
        convo = {
          id,
          participants: [message.from, message.to],
          messages: [],
          status: "active",
          topic: message.intent.type,
          createdAt: message.timestamp,
          updatedAt: message.timestamp,
        };
        this.conversations.set(id, convo);
      }
      // Idempotent — skip if already present
      if (!convo.messages.find((m) => m.id === message.id)) {
        convo.messages.push(message);
      }
      if (message.timestamp > convo.updatedAt) {
        convo.updatedAt = message.timestamp;
      }
      if (!convo.participants.includes(message.from)) convo.participants.push(message.from);
      if (!convo.participants.includes(message.to)) convo.participants.push(message.to);
    }
  }
}
