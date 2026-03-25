/**
 * A2A Message Bus — in-process pub/sub for agent communication.
 *
 * In v1 this is an in-memory EventEmitter-style bus. Agents register,
 * send messages, and receive messages addressed to them. In production
 * this would be backed by a message queue (NATS, Redis Streams, etc.)
 * or a peer-to-peer protocol.
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
import * as Sentry from "@sentry/node";

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
  }

  /** Send a message from one agent to another */
  async send(message: A2AMessage): Promise<void> {
    // Security scan — throws SecurityError if blocked
    if (this.security) {
      await this.security.scanMessage(message);
    }

    // Track in conversation
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
    convo.messages.push(message);
    convo.updatedAt = message.timestamp;
    if (!convo.participants.includes(message.from)) convo.participants.push(message.from);
    if (!convo.participants.includes(message.to)) convo.participants.push(message.to);

    // Deliver to recipient's handlers — each handler invocation is a Sentry span
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
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
      } catch (err) {
        console.error(`Handler error for agent ${message.to}:`, err);
      }
    }

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
    // Track in conversation
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
    convo.messages.push(message);
    convo.updatedAt = message.timestamp;
    if (!convo.participants.includes(message.from)) convo.participants.push(message.from);
    if (!convo.participants.includes(message.to)) convo.participants.push(message.to);

    // Deliver to recipient's handlers — each handler invocation is a Sentry span
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
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
      } catch (err) {
        console.error(`Handler error for agent ${message.to}:`, err);
      }
    }
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
}
