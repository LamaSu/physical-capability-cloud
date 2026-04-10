/**
 * A2A Relay Routes — Fastify plugin that turns the Gateway into a message relay.
 *
 * Routes:
 *   POST   /api/a2a/send                — receive A2AMessage, route to recipient WebSocket
 *   GET    /api/a2a/agents              — list connected agents
 *   GET    /api/a2a/conversations/:agentId — conversations for an agent
 *   WS     /ws/a2a?agentId=xxx          — agent WebSocket connection
 *
 * The relay keeps a Map of agentId -> WebSocket, queues messages for offline
 * agents (up to 100 per agent), and delivers them on reconnect.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { A2AMessage, Conversation } from "./types.js";

interface AgentConnection {
  agentId: string;
  socket: import("ws").WebSocket;
  connectedAt: string;
  role?: string;
}

const MAX_QUEUE_PER_AGENT = 100;

/**
 * State container for the relay. Exported for testing — in production this is
 * encapsulated inside the Fastify plugin lifecycle.
 */
export class RelayState {
  connections = new Map<string, AgentConnection>();
  conversations = new Map<string, Conversation>();
  /** Queued messages for agents that are not currently connected */
  offlineQueue = new Map<string, A2AMessage[]>();

  /** Route a message to the recipient. Returns true if delivered immediately. */
  routeMessage(message: A2AMessage): boolean {
    // Track conversation
    this.trackConversation(message);

    const conn = this.connections.get(message.to);
    if (conn && conn.socket.readyState === 1 /* WebSocket.OPEN */) {
      conn.socket.send(JSON.stringify(message));
      return true;
    }

    // Queue for offline delivery
    let queue = this.offlineQueue.get(message.to);
    if (!queue) {
      queue = [];
      this.offlineQueue.set(message.to, queue);
    }
    if (queue.length < MAX_QUEUE_PER_AGENT) {
      queue.push(message);
    }
    return false;
  }

  /** Broadcast a message to all connected agents (optionally filtered by role). */
  broadcastMessage(message: A2AMessage, role?: string): void {
    for (const [agentId, conn] of this.connections) {
      if (agentId === message.from) continue;
      if (role && conn.role !== role) continue;
      if (conn.socket.readyState === 1) {
        const targeted = { ...message, to: agentId };
        this.trackConversation(targeted);
        conn.socket.send(JSON.stringify(targeted));
      }
    }
  }

  /** Deliver queued messages when an agent connects. */
  flushQueue(agentId: string): void {
    const queue = this.offlineQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    const conn = this.connections.get(agentId);
    if (!conn || conn.socket.readyState !== 1) return;

    for (const msg of queue) {
      conn.socket.send(JSON.stringify(msg));
    }
    this.offlineQueue.delete(agentId);
  }

  /** Get conversations for an agent. */
  getConversationsFor(agentId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) =>
      c.participants.includes(agentId),
    );
  }

  /** List connected agents summary. */
  listAgents(): Array<{ id: string; role?: string; connectedAt: string }> {
    return [...this.connections.values()].map((c) => ({
      id: c.agentId,
      role: c.role,
      connectedAt: c.connectedAt,
    }));
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

/**
 * Fastify plugin — registers the relay WebSocket and REST routes.
 * Requires @fastify/websocket to be registered on the Fastify instance first.
 */
export async function a2aRelayRoutes(app: FastifyInstance): Promise<void> {
  const state = new RelayState();

  // Expose state for testing via decoration
  app.decorate("a2aRelayState", state);

  // ── REST: send a message ────────────────────────────────────────
  app.post("/api/a2a/send", async (req: FastifyRequest, reply: FastifyReply) => {
    const message = req.body as A2AMessage;
    if (!message || !message.id || !message.to || !message.intent) {
      return reply.status(400).send({ error: "Invalid A2AMessage" });
    }

    // If "to" is "*", it's a broadcast
    if (message.to === "*") {
      const role = (req.query as Record<string, string>).role;
      state.broadcastMessage(message, role);
      return reply.send({ status: "broadcast", recipients: state.connections.size });
    }

    const delivered = state.routeMessage(message);
    return reply.send({ status: delivered ? "delivered" : "queued" });
  });

  // ── REST: list connected agents ─────────────────────────────────
  app.get("/api/a2a/agents", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ agents: state.listAgents() });
  });

  // ── REST: get conversations for an agent ────────────────────────
  app.get(
    "/api/a2a/conversations/:agentId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { agentId } = req.params as { agentId: string };
      return reply.send({ conversations: state.getConversationsFor(agentId) });
    },
  );

  // ── WebSocket: agent connection ─────────────────────────────────
  app.get(
    "/ws/a2a",
    { websocket: true },
    (socket: import("ws").WebSocket, req: FastifyRequest) => {
      const { agentId, role, apiKey } = req.query as { agentId?: string; role?: string; apiKey?: string };
      if (!agentId) {
        socket.close(4000, "agentId query param required");
        return;
      }

      // Authentication check — require API key or existing session
      // Check Authorization header first (WebSocket handshake passes headers)
      const authHeader = req.headers.authorization;
      const hasApiKey = authHeader?.startsWith("Bearer pcc_") || apiKey?.startsWith("pcc_");
      const hasSession = !!(req as any).userId;

      if (!hasApiKey && !hasSession) {
        socket.close(4001, "Authentication required — provide API key via apiKey query param or Authorization header");
        return;
      }

      // Register connection
      const conn: AgentConnection = {
        agentId,
        socket,
        connectedAt: new Date().toISOString(),
        role,
      };
      state.connections.set(agentId, conn);

      // Flush any queued messages
      state.flushQueue(agentId);

      // Handle incoming messages over WebSocket (agents can also send this way)
      socket.on("message", (raw: Buffer | string) => {
        try {
          const data = typeof raw === "string" ? raw : raw.toString("utf-8");
          const message: A2AMessage = JSON.parse(data);
          state.routeMessage(message);
        } catch {
          // Ignore malformed messages
        }
      });

      // Clean up on disconnect
      socket.on("close", () => {
        // Only remove if this is still the active connection for this agentId
        if (state.connections.get(agentId)?.socket === socket) {
          state.connections.delete(agentId);
        }
      });
    },
  );
}
