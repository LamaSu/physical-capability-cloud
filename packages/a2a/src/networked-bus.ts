/**
 * NetworkedBus — drop-in replacement for MessageBus that communicates over
 * the network via NetworkTransport (HTTP POST + WebSocket).
 *
 * Backward compatible: if the relay is unreachable, falls back to in-memory
 * message delivery (identical to the original MessageBus).
 */

import type { A2AMessage, AgentCard, Conversation } from "./types.js";
import { NetworkTransport } from "./network-transport.js";
import type { NetworkTransportConfig } from "./network-transport.js";

type MessageHandler = (message: A2AMessage) => void | Promise<void>;

export interface NetworkedBusConfig {
  /** Gateway relay URL (e.g. "http://localhost:3200") */
  relayUrl: string;
  /** Reconnect interval in ms (default: 3000) */
  reconnectInterval?: number;
}

export class NetworkedBus {
  private agents = new Map<string, AgentCard>();
  private handlers = new Map<string, MessageHandler[]>();
  private conversations = new Map<string, Conversation>();
  private transports = new Map<string, NetworkTransport>();
  private relayConfig: NetworkedBusConfig | null;

  /**
   * Create a NetworkedBus.
   * @param config - If provided, enables network transport. If omitted, works in-memory only.
   */
  constructor(config?: NetworkedBusConfig) {
    this.relayConfig = config ?? null;
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
    const transport = this.transports.get(agentId);
    if (transport) {
      transport.disconnect().catch(() => {});
      this.transports.delete(agentId);
    }
  }

  /**
   * Subscribe to messages addressed to this agent.
   * If relay config is set, also connects to the WebSocket relay so the agent
   * receives messages sent from remote processes.
   */
  subscribe(agentId: string, handler: MessageHandler): void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);

    // Connect transport if we have relay config and no transport yet
    if (this.relayConfig && !this.transports.has(agentId)) {
      this.connectTransport(agentId).catch((err) => {
        console.warn(
          `[NetworkedBus] Failed to connect transport for ${agentId}:`,
          err,
        );
      });
    }
  }

  /** Send a message from one agent to another */
  async send(message: A2AMessage): Promise<void> {
    // Track conversation locally
    this.trackConversation(message);

    // Try network delivery first
    const transport = this.getAnyTransport();
    if (transport?.connected) {
      try {
        await transport.send(message);
        return;
      } catch {
        // Fall through to in-memory delivery
      }
    }

    // In-memory fallback
    await this.deliverLocally(message);
  }

  /** Broadcast to all agents with a specific role */
  async broadcast(message: A2AMessage, role?: string): Promise<void> {
    // Try network broadcast
    const transport = this.getAnyTransport();
    if (transport?.connected) {
      try {
        const broadcastMsg = { ...message, to: "*" };
        const url = `${this.relayConfig!.relayUrl.replace(/\/$/, "")}/api/a2a/send${role ? `?role=${encodeURIComponent(role)}` : ""}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(broadcastMsg),
        });
        if (resp.ok) return;
      } catch {
        // Fall through to in-memory broadcast
      }
    }

    // In-memory fallback: same logic as MessageBus
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

  /** Get all conversations for an agent (local cache) */
  getConversationsFor(agentId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) =>
      c.participants.includes(agentId),
    );
  }

  /**
   * Fetch conversations for an agent from the relay (network).
   * Falls back to local cache if relay is unavailable.
   */
  async getConversationsFromRelay(agentId: string): Promise<Conversation[]> {
    if (!this.relayConfig) return this.getConversationsFor(agentId);

    try {
      const url = `${this.relayConfig.relayUrl.replace(/\/$/, "")}/api/a2a/conversations/${encodeURIComponent(agentId)}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = (await resp.json()) as { conversations: Conversation[] };
        return data.conversations;
      }
    } catch {
      // Fall through to local
    }
    return this.getConversationsFor(agentId);
  }

  /** Disconnect all transports */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const transport of this.transports.values()) {
      promises.push(transport.disconnect());
    }
    await Promise.all(promises);
    this.transports.clear();
  }

  /** Check if any transport is connected to the relay */
  get connected(): boolean {
    for (const transport of this.transports.values()) {
      if (transport.connected) return true;
    }
    return false;
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async connectTransport(agentId: string): Promise<void> {
    if (!this.relayConfig) return;

    const transport = new NetworkTransport({
      relayUrl: this.relayConfig.relayUrl,
      agentId,
      reconnectInterval: this.relayConfig.reconnectInterval,
    });

    // Route incoming WebSocket messages to local handlers
    transport.onMessage((msg: A2AMessage) => {
      this.trackConversation(msg);
      this.deliverLocally(msg).catch((err) => {
        console.error(`[NetworkedBus] Local delivery error:`, err);
      });
    });

    this.transports.set(agentId, transport);

    try {
      await transport.connect();
    } catch {
      // Connection failed — transport will auto-reconnect
    }
  }

  /** Get any connected transport (for sending) */
  private getAnyTransport(): NetworkTransport | null {
    for (const transport of this.transports.values()) {
      if (transport.connected) return transport;
    }
    return null;
  }

  private async deliverLocally(message: A2AMessage): Promise<void> {
    const handlers = this.handlers.get(message.to) ?? [];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error(`Handler error for agent ${message.to}:`, err);
      }
    }
  }

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
    convo.messages.push(message);
    convo.updatedAt = message.timestamp;
    if (!convo.participants.includes(message.from)) convo.participants.push(message.from);
    if (!convo.participants.includes(message.to)) convo.participants.push(message.to);
  }
}
