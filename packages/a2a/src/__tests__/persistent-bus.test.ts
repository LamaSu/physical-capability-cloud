import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PersistentMessageBus } from "../persistent-bus.js";
import { MessageBus } from "../message-bus.js";
import type { MessagePersistence, A2AMessagePersistedData, A2AConversationPersistedData } from "../persistence.js";
import type { AgentCard, A2AMessage } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    role: "user",
    walletAddress: "0x0000000000000000000000000000000000000001",
    capabilities: [],
    endpoint: "agent://test",
    description: "test agent",
    supportedIntents: [],
    publicKey: "0xpub",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "conv-default",
    from: "agent-sender",
    to: "agent-receiver",
    intent: { type: "text_message", text: "hello" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── In-memory mock persistence ────────────────────────────────────────────────

class MockPersistence implements MessagePersistence {
  private messages: A2AMessagePersistedData[] = [];
  private conversations: Map<string, A2AConversationPersistedData> = new Map();

  persistMessage(msg: A2AMessagePersistedData): void {
    // Idempotent — skip duplicates
    if (!this.messages.find((m) => m.id === msg.id)) {
      this.messages.push(msg);
    }
  }

  upsertConversation(conv: A2AConversationPersistedData): void {
    this.conversations.set(conv.id, conv);
  }

  getConversation(conversationId: string): A2AMessagePersistedData[] {
    return this.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getMessagesAfter(timestamp: string, limit?: number): A2AMessagePersistedData[] {
    const filtered = this.messages
      .filter((m) => m.timestamp >= timestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return limit != null ? filtered.slice(0, limit) : filtered;
  }

  getRecentMessages(limit: number): A2AMessagePersistedData[] {
    return [...this.messages]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  getMessagesByAgent(agentId: string, limit?: number): A2AMessagePersistedData[] {
    const filtered = this.messages
      .filter((m) => m.fromAgentId === agentId || m.toAgentId === agentId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return limit != null ? filtered.slice(0, limit) : filtered;
  }

  getConversationIds(limit?: number): string[] {
    const ids = [...this.conversations.keys()];
    return limit != null ? ids.slice(0, limit) : ids;
  }

  // ── Test helpers ──────────────────────────────────────────────────────

  getAllMessages(): A2AMessagePersistedData[] {
    return this.messages;
  }

  getConversationAgg(id: string): A2AConversationPersistedData | undefined {
    return this.conversations.get(id);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PersistentMessageBus", () => {
  let bus: PersistentMessageBus;
  let persistence: MockPersistence;

  const alice = makeCard({ id: "agent-alice", role: "user" });
  const bob = makeCard({ id: "agent-bob", role: "kernel" });

  beforeEach(() => {
    persistence = new MockPersistence();
    bus = new PersistentMessageBus(persistence);
    bus.register(alice);
    bus.register(bob);
  });

  // ── instanceof + API compatibility ────────────────────────────────────────

  describe("compatibility", () => {
    it("is an instance of MessageBus", () => {
      expect(bus).toBeInstanceOf(MessageBus);
    });

    it("exposes all MessageBus methods", () => {
      expect(typeof bus.register).toBe("function");
      expect(typeof bus.send).toBe("function");
      expect(typeof bus.broadcast).toBe("function");
      expect(typeof bus.subscribe).toBe("function");
      expect(typeof bus.getConversation).toBe("function");
    });
  });

  // ── Constructor with no persistence (graceful degradation) ───────────────

  describe("without persistence", () => {
    it("works exactly like MessageBus when no persistence is provided", async () => {
      const noPersistBus = new PersistentMessageBus();
      noPersistBus.register(alice);
      noPersistBus.register(bob);

      const received: A2AMessage[] = [];
      noPersistBus.subscribe("agent-bob", (msg) => { received.push(msg); });

      const msg = makeMessage({ from: "agent-alice", to: "agent-bob" });
      await noPersistBus.send(msg);

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(msg.id);
    });

    it("rehydrate() is a no-op when no persistence is provided", async () => {
      const noPersistBus = new PersistentMessageBus();
      await expect(noPersistBus.rehydrate()).resolves.not.toThrow();
    });
  });

  // ── send() ────────────────────────────────────────────────────────────────

  describe("send()", () => {
    it("delivers message to subscriber AND persists it", async () => {
      const received: A2AMessage[] = [];
      bus.subscribe("agent-bob", (msg) => { received.push(msg); });

      const msg = makeMessage({ from: "agent-alice", to: "agent-bob", conversationId: "conv-1" });
      await bus.send(msg);

      // In-memory delivery
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(msg.id);

      // Persistence
      const stored = persistence.getAllMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(msg.id);
      expect(stored[0].fromAgentId).toBe("agent-alice");
      expect(stored[0].toAgentId).toBe("agent-bob");
      expect(stored[0].intentType).toBe("text_message");
    });

    it("persists the intent payload as the full intent object", async () => {
      bus.subscribe("agent-bob", () => {});

      const msg = makeMessage({
        from: "agent-alice",
        to: "agent-bob",
        intent: {
          type: "request_quote",
          capabilityType: "fdm",
          assuranceTier: 1,
          params: { material: "pla" },
        },
      });
      await bus.send(msg);

      const stored = persistence.getAllMessages();
      expect(stored[0].intentPayload).toMatchObject({
        type: "request_quote",
        capabilityType: "fdm",
        assuranceTier: 1,
      });
    });

    it("marks isEncrypted=1 when message has encrypted envelope", async () => {
      bus.subscribe("agent-bob", () => {});

      const msg = makeMessage({
        from: "agent-alice",
        to: "agent-bob",
        encrypted: {
          nonce: "abc123base64",
          ciphertext: "deadbeefbase64",
          ephemeralPublicKey: "0xephemeralPubKey",
        },
      });
      await bus.send(msg);

      const stored = persistence.getAllMessages();
      expect(stored[0].isEncrypted).toBe(1);
      expect(stored[0].encryptedEnvelope).toBeDefined();
    });

    it("marks isEncrypted=0 when no encrypted envelope", async () => {
      bus.subscribe("agent-bob", () => {});

      await bus.send(makeMessage({ from: "agent-alice", to: "agent-bob" }));

      const stored = persistence.getAllMessages();
      expect(stored[0].isEncrypted).toBe(0);
    });

    it("upserts conversation aggregate after persisting", async () => {
      bus.subscribe("agent-bob", () => {});

      const msg = makeMessage({ from: "agent-alice", to: "agent-bob", conversationId: "conv-agg" });
      await bus.send(msg);

      const conv = persistence.getConversationAgg("conv-agg");
      expect(conv).toBeDefined();
      expect(conv!.messageCount).toBe(1);
      expect(conv!.participants).toContain("agent-alice");
      expect(conv!.participants).toContain("agent-bob");
    });

    it("persistence failures do NOT block message delivery", async () => {
      const errorPersistence: MessagePersistence = {
        persistMessage: () => { throw new Error("DB down"); },
        upsertConversation: () => { throw new Error("DB down"); },
        getConversation: () => [],
        getMessagesAfter: () => [],
        getRecentMessages: () => [],
        getMessagesByAgent: () => [],
        getConversationIds: () => [],
      };

      const robustBus = new PersistentMessageBus(errorPersistence);
      robustBus.register(alice);
      robustBus.register(bob);

      const received: A2AMessage[] = [];
      robustBus.subscribe("agent-bob", (msg) => { received.push(msg); });

      // Should NOT throw despite persistence failing
      await expect(
        robustBus.send(makeMessage({ from: "agent-alice", to: "agent-bob" })),
      ).resolves.not.toThrow();

      // Message was still delivered
      expect(received).toHaveLength(1);
    });
  });

  // ── broadcast() ───────────────────────────────────────────────────────────

  describe("broadcast()", () => {
    it("persists the broadcast message once after delivering to all targets", async () => {
      const carol = makeCard({ id: "agent-carol", role: "kernel" });
      bus.register(carol);

      const received = { bob: 0, carol: 0 };
      bus.subscribe("agent-bob", () => { received.bob++; });
      bus.subscribe("agent-carol", () => { received.carol++; });

      const msg = makeMessage({ from: "agent-alice", to: "agent-alice" }); // broadcast
      await bus.broadcast(msg, "kernel");

      // Both kernel agents received
      expect(received.bob).toBe(1);
      expect(received.carol).toBe(1);

      // Persisted once (the original message)
      const stored = persistence.getAllMessages();
      expect(stored).toHaveLength(1);
    });
  });

  // ── rehydrate() ──────────────────────────────────────────────────────────

  describe("rehydrate()", () => {
    it("seeds conversations from persistence without dispatching to handlers", async () => {
      const handlerCalled = vi.fn();
      bus.subscribe("agent-bob", handlerCalled);

      // Pre-populate persistence with a message
      const ts = new Date().toISOString();
      persistence.persistMessage({
        id: "rehydrate-msg-1",
        conversationId: "conv-rehydrate",
        fromAgentId: "agent-alice",
        toAgentId: "agent-bob",
        intentType: "text_message",
        intentPayload: { type: "text_message", text: "persisted" },
        isEncrypted: 0,
        timestamp: ts,
        persistedAt: ts,
      });

      // Create a fresh bus (simulates restart)
      const freshBus = new PersistentMessageBus(persistence);
      const freshHandlerCalled = vi.fn();
      freshBus.register(alice);
      freshBus.register(bob);
      freshBus.subscribe("agent-bob", freshHandlerCalled);

      await freshBus.rehydrate();

      // Conversation is in the in-memory cache
      const conv = freshBus.getConversation("conv-rehydrate");
      expect(conv).toBeDefined();
      expect(conv!.messages).toHaveLength(1);
      expect(conv!.messages[0].id).toBe("rehydrate-msg-1");
      expect(conv!.messages[0].from).toBe("agent-alice");
      expect(conv!.messages[0].to).toBe("agent-bob");

      // Handler was NEVER invoked (no dispatch during rehydration)
      expect(freshHandlerCalled).not.toHaveBeenCalled();
      // Original bus handler also not called
      expect(handlerCalled).not.toHaveBeenCalled();
    });

    it("is idempotent — calling rehydrate twice does not duplicate messages", async () => {
      const ts = new Date().toISOString();
      persistence.persistMessage({
        id: "idem-msg",
        conversationId: "conv-idem",
        fromAgentId: "agent-alice",
        toAgentId: "agent-bob",
        intentType: "text_message",
        intentPayload: { type: "text_message", text: "idempotent" },
        isEncrypted: 0,
        timestamp: ts,
        persistedAt: ts,
      });

      await bus.rehydrate();
      await bus.rehydrate();

      const conv = bus.getConversation("conv-idem");
      expect(conv!.messages).toHaveLength(1);
    });

    it("rehydrates multiple conversations", async () => {
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        const ts = new Date(base + i * 1000).toISOString();
        persistence.persistMessage({
          id: `msg-conv-${i}`,
          conversationId: `conv-multi-${i}`,
          fromAgentId: "agent-alice",
          toAgentId: "agent-bob",
          intentType: "text_message",
          intentPayload: { type: "text_message", text: `msg ${i}` },
          isEncrypted: 0,
          timestamp: ts,
          persistedAt: ts,
        });
      }

      const freshBus = new PersistentMessageBus(persistence);
      await freshBus.rehydrate();

      for (let i = 0; i < 3; i++) {
        const conv = freshBus.getConversation(`conv-multi-${i}`);
        expect(conv).toBeDefined();
        expect(conv!.messages).toHaveLength(1);
      }
    });
  });

  // ── getPersistedConversation ──────────────────────────────────────────────

  describe("getPersistedConversation()", () => {
    it("returns persisted messages for a conversation", async () => {
      bus.subscribe("agent-bob", () => {});
      const msg = makeMessage({ from: "agent-alice", to: "agent-bob", conversationId: "conv-get" });
      await bus.send(msg);

      const msgs = bus.getPersistedConversation("conv-get");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe(msg.id);
      expect(msgs[0].from).toBe("agent-alice");
    });

    it("falls back to in-memory conversation when no persistence", () => {
      const noBus = new PersistentMessageBus();
      expect(noBus.getPersistedConversation("any")).toEqual([]);
    });
  });

  // ── getRecentPersistedMessages ────────────────────────────────────────────

  describe("getRecentPersistedMessages()", () => {
    it("returns messages from persistence in descending order", async () => {
      bus.subscribe("agent-bob", () => {});
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await bus.send(
          makeMessage({
            from: "agent-alice",
            to: "agent-bob",
            timestamp: new Date(base + i * 1000).toISOString(),
          }),
        );
      }

      const recent = bus.getRecentPersistedMessages(3);
      expect(recent).toHaveLength(3);
      // Newest first
      expect(recent[0].timestamp >= recent[1].timestamp).toBe(true);
      expect(recent[1].timestamp >= recent[2].timestamp).toBe(true);
    });
  });

  // ── _seedConversation (protected via subclass) ────────────────────────────

  describe("_seedConversation() via rehydrate", () => {
    it("correctly reconstructs message fields from persisted row", async () => {
      const msgTs = new Date().toISOString();
      persistence.persistMessage({
        id: "field-check",
        conversationId: "conv-fields",
        fromAgentId: "agent-alice",
        toAgentId: "agent-bob",
        inReplyTo: "msg-parent",
        intentType: "quote_response",
        intentPayload: { type: "quote_response", quoteId: "q1", pricePerUnit: "10" } as Record<string, unknown>,
        isEncrypted: 0,
        signature: "0xsig",
        timestamp: msgTs,
        persistedAt: msgTs,
      });

      const freshBus = new PersistentMessageBus(persistence);
      await freshBus.rehydrate();

      const conv = freshBus.getConversation("conv-fields");
      const msg = conv!.messages[0];
      expect(msg.id).toBe("field-check");
      expect(msg.from).toBe("agent-alice");
      expect(msg.to).toBe("agent-bob");
      expect(msg.inReplyTo).toBe("msg-parent");
      expect(msg.signature).toBe("0xsig");
      expect(msg.intent).toMatchObject({ type: "quote_response", quoteId: "q1" });
    });
  });
});
