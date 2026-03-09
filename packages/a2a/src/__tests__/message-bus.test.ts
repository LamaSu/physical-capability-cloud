import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageBus } from "../message-bus.js";
import type { AgentCard, A2AMessage } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────

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
    conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent_sender",
    to: "agent_receiver",
    intent: { type: "text_message", text: "hello" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("MessageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  // ── Registration ───────────────────────────────────────────────

  describe("agent registration", () => {
    it("registers an agent and retrieves it by id", () => {
      const card = makeCard({ id: "agent_alice" });
      bus.register(card);

      expect(bus.getAgent("agent_alice")).toBe(card);
    });

    it("lists all registered agents via findAgents()", () => {
      const a = makeCard({ id: "agent_a" });
      const b = makeCard({ id: "agent_b" });
      bus.register(a);
      bus.register(b);

      const all = bus.findAgents();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });

    it("returns undefined for an unknown agent", () => {
      expect(bus.getAgent("nonexistent")).toBeUndefined();
    });

    it("unregisters an agent", () => {
      const card = makeCard({ id: "agent_x" });
      bus.register(card);
      expect(bus.getAgent("agent_x")).toBe(card);

      bus.unregister("agent_x");
      expect(bus.getAgent("agent_x")).toBeUndefined();
      expect(bus.findAgents()).toHaveLength(0);
    });

    it("unregistering removes the agent's handlers", async () => {
      const card = makeCard({ id: "agent_y" });
      bus.register(card);

      const handler = vi.fn();
      bus.subscribe("agent_y", handler);

      bus.unregister("agent_y");

      // Re-register so the agent exists but old handlers should be gone
      bus.register(card);
      await bus.send(makeMessage({ to: "agent_y" }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Sending & Subscribing ─────────────────────────────────────

  describe("message sending", () => {
    it("delivers a message to the recipient's handler", async () => {
      const receiver = makeCard({ id: "agent_recv" });
      bus.register(receiver);

      const handler = vi.fn();
      bus.subscribe("agent_recv", handler);

      const msg = makeMessage({ to: "agent_recv", from: "agent_send" });
      await bus.send(msg);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("delivers to multiple handlers on the same agent", async () => {
      const card = makeCard({ id: "agent_multi" });
      bus.register(card);

      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.subscribe("agent_multi", h1);
      bus.subscribe("agent_multi", h2);

      await bus.send(makeMessage({ to: "agent_multi" }));

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it("does not deliver to other agents", async () => {
      const a = makeCard({ id: "agent_a" });
      const b = makeCard({ id: "agent_b" });
      bus.register(a);
      bus.register(b);

      const handlerA = vi.fn();
      const handlerB = vi.fn();
      bus.subscribe("agent_a", handlerA);
      bus.subscribe("agent_b", handlerB);

      await bus.send(makeMessage({ to: "agent_a" }));

      expect(handlerA).toHaveBeenCalledOnce();
      expect(handlerB).not.toHaveBeenCalled();
    });

    it("silently drops a message when there are no handlers", async () => {
      // No agent registered — should not throw
      await expect(
        bus.send(makeMessage({ to: "agent_nobody" })),
      ).resolves.toBeUndefined();
    });

    it("catches handler errors without breaking delivery", async () => {
      const card = makeCard({ id: "agent_err" });
      bus.register(card);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const badHandler = vi.fn().mockRejectedValue(new Error("boom"));
      const goodHandler = vi.fn();

      bus.subscribe("agent_err", badHandler);
      bus.subscribe("agent_err", goodHandler);

      await bus.send(makeMessage({ to: "agent_err" }));

      expect(badHandler).toHaveBeenCalledOnce();
      expect(goodHandler).toHaveBeenCalledOnce();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  // ── Conversation Tracking ─────────────────────────────────────

  describe("conversation tracking", () => {
    it("creates a conversation on first message", async () => {
      const card = makeCard({ id: "agent_c" });
      bus.register(card);

      const msg = makeMessage({
        conversationId: "conv_1",
        from: "agent_s",
        to: "agent_c",
        intent: { type: "text_message", text: "hi" },
      });
      await bus.send(msg);

      const convo = bus.getConversation("conv_1");
      expect(convo).toBeDefined();
      expect(convo!.id).toBe("conv_1");
      expect(convo!.participants).toContain("agent_s");
      expect(convo!.participants).toContain("agent_c");
      expect(convo!.messages).toHaveLength(1);
      expect(convo!.status).toBe("active");
      expect(convo!.topic).toBe("text_message");
    });

    it("appends subsequent messages to the same conversation", async () => {
      const card = makeCard({ id: "agent_d" });
      bus.register(card);

      const msg1 = makeMessage({
        conversationId: "conv_2",
        from: "agent_x",
        to: "agent_d",
      });
      const msg2 = makeMessage({
        conversationId: "conv_2",
        from: "agent_d",
        to: "agent_x",
      });

      await bus.send(msg1);
      await bus.send(msg2);

      const convo = bus.getConversation("conv_2");
      expect(convo!.messages).toHaveLength(2);
      expect(convo!.messages[0]).toBe(msg1);
      expect(convo!.messages[1]).toBe(msg2);
    });

    it("adds new participants to existing conversation", async () => {
      const cardA = makeCard({ id: "agent_p1" });
      const cardB = makeCard({ id: "agent_p2" });
      bus.register(cardA);
      bus.register(cardB);

      await bus.send(
        makeMessage({ conversationId: "conv_3", from: "agent_p1", to: "agent_p2" }),
      );
      // Third participant joins
      await bus.send(
        makeMessage({ conversationId: "conv_3", from: "agent_p3", to: "agent_p1" }),
      );

      const convo = bus.getConversation("conv_3");
      expect(convo!.participants).toContain("agent_p1");
      expect(convo!.participants).toContain("agent_p2");
      expect(convo!.participants).toContain("agent_p3");
    });

    it("returns undefined for unknown conversation", () => {
      expect(bus.getConversation("conv_none")).toBeUndefined();
    });

    it("getConversationsFor returns only that agent's conversations", async () => {
      const card = makeCard({ id: "agent_f1" });
      bus.register(card);

      await bus.send(
        makeMessage({ conversationId: "conv_a", from: "agent_f1", to: "agent_f2" }),
      );
      await bus.send(
        makeMessage({ conversationId: "conv_b", from: "agent_f3", to: "agent_f4" }),
      );

      const convos = bus.getConversationsFor("agent_f1");
      expect(convos).toHaveLength(1);
      expect(convos[0].id).toBe("conv_a");
    });

    it("updates updatedAt on each message", async () => {
      const card = makeCard({ id: "agent_t" });
      bus.register(card);

      const ts1 = "2026-01-01T00:00:00Z";
      const ts2 = "2026-01-01T01:00:00Z";

      await bus.send(
        makeMessage({ conversationId: "conv_ts", timestamp: ts1, to: "agent_t" }),
      );
      const after1 = bus.getConversation("conv_ts")!.updatedAt;

      await bus.send(
        makeMessage({ conversationId: "conv_ts", timestamp: ts2, to: "agent_t" }),
      );
      const after2 = bus.getConversation("conv_ts")!.updatedAt;

      expect(after1).toBe(ts1);
      expect(after2).toBe(ts2);
    });
  });

  // ── Broadcasting ──────────────────────────────────────────────

  describe("broadcasting", () => {
    it("broadcasts to all agents (excluding sender)", async () => {
      const a = makeCard({ id: "agent_ba", role: "user" });
      const b = makeCard({ id: "agent_bb", role: "broker" });
      const c = makeCard({ id: "agent_bc", role: "kernel" });
      bus.register(a);
      bus.register(b);
      bus.register(c);

      const hA = vi.fn();
      const hB = vi.fn();
      const hC = vi.fn();
      bus.subscribe("agent_ba", hA);
      bus.subscribe("agent_bb", hB);
      bus.subscribe("agent_bc", hC);

      const msg = makeMessage({ from: "agent_ba" });
      await bus.broadcast(msg);

      // sender excluded
      expect(hA).not.toHaveBeenCalled();
      expect(hB).toHaveBeenCalledOnce();
      expect(hC).toHaveBeenCalledOnce();
    });

    it("broadcasts only to agents with a specific role", async () => {
      const k1 = makeCard({ id: "agent_k1", role: "kernel" });
      const k2 = makeCard({ id: "agent_k2", role: "kernel" });
      const u1 = makeCard({ id: "agent_u1", role: "user" });
      bus.register(k1);
      bus.register(k2);
      bus.register(u1);

      const hK1 = vi.fn();
      const hK2 = vi.fn();
      const hU1 = vi.fn();
      bus.subscribe("agent_k1", hK1);
      bus.subscribe("agent_k2", hK2);
      bus.subscribe("agent_u1", hU1);

      await bus.broadcast(makeMessage({ from: "agent_u1" }), "kernel");

      expect(hK1).toHaveBeenCalledOnce();
      expect(hK2).toHaveBeenCalledOnce();
      expect(hU1).not.toHaveBeenCalled();
    });

    it("sender is excluded even when they match the role filter", async () => {
      const k1 = makeCard({ id: "agent_ks1", role: "kernel" });
      const k2 = makeCard({ id: "agent_ks2", role: "kernel" });
      bus.register(k1);
      bus.register(k2);

      const hK1 = vi.fn();
      const hK2 = vi.fn();
      bus.subscribe("agent_ks1", hK1);
      bus.subscribe("agent_ks2", hK2);

      await bus.broadcast(makeMessage({ from: "agent_ks1" }), "kernel");

      expect(hK1).not.toHaveBeenCalled();
      expect(hK2).toHaveBeenCalledOnce();
    });
  });

  // ── Finding Agents ────────────────────────────────────────────

  describe("finding agents", () => {
    it("findAgents filters by role", () => {
      bus.register(makeCard({ id: "a1", role: "user" }));
      bus.register(makeCard({ id: "a2", role: "broker" }));
      bus.register(makeCard({ id: "a3", role: "user" }));

      const users = bus.findAgents("user");
      expect(users).toHaveLength(2);
      expect(users.map((a) => a.id).sort()).toEqual(["a1", "a3"]);

      const brokers = bus.findAgents("broker");
      expect(brokers).toHaveLength(1);
      expect(brokers[0].id).toBe("a2");
    });

    it("findAgents with no role returns all", () => {
      bus.register(makeCard({ id: "x1" }));
      bus.register(makeCard({ id: "x2" }));
      expect(bus.findAgents()).toHaveLength(2);
    });

    it("findByIntent returns agents that support a given intent", () => {
      bus.register(
        makeCard({ id: "i1", supportedIntents: ["discover_capabilities", "request_quote"] }),
      );
      bus.register(
        makeCard({ id: "i2", supportedIntents: ["submit_workflow"] }),
      );
      bus.register(
        makeCard({ id: "i3", supportedIntents: ["discover_capabilities"] }),
      );

      const discover = bus.findByIntent("discover_capabilities");
      expect(discover).toHaveLength(2);
      expect(discover.map((a) => a.id).sort()).toEqual(["i1", "i3"]);

      const workflow = bus.findByIntent("submit_workflow");
      expect(workflow).toHaveLength(1);
      expect(workflow[0].id).toBe("i2");
    });

    it("findByIntent returns empty array when no agents match", () => {
      bus.register(makeCard({ id: "z1", supportedIntents: ["text_message"] }));
      expect(bus.findByIntent("request_courier")).toEqual([]);
    });
  });
});
