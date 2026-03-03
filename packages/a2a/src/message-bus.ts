/**
 * A2A Message Bus — in-process pub/sub for agent communication.
 *
 * In v1 this is an in-memory EventEmitter-style bus. Agents register,
 * send messages, and receive messages addressed to them. In production
 * this would be backed by a message queue (NATS, Redis Streams, etc.)
 * or a peer-to-peer protocol.
 */

import type { A2AMessage, AgentCard, Conversation, Intent } from "./types.js";

type MessageHandler = (message: A2AMessage) => void | Promise<void>;

export class MessageBus {
  private agents: Map<string, AgentCard> = new Map();
  private handlers: Map<string, MessageHandler[]> = new Map();
  private conversations: Map<string, Conversation> = new Map();

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

    // Deliver to recipient's handlers
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error(`Handler error for agent ${message.to}:`, err);
      }
    }
  }

  /** Broadcast to all agents with a specific role */
  async broadcast(message: A2AMessage, role?: string): Promise<void> {
    const targets = role
      ? [...this.agents.values()].filter((a) => a.role === role)
      : [...this.agents.values()];

    for (const agent of targets) {
      if (agent.id === message.from) continue;
      await this.send({ ...message, to: agent.id });
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
