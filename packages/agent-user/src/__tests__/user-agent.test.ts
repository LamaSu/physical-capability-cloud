import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "../user-agent.js";

describe("UserAgent", () => {
  let bus: MessageBus;
  let agent: UserAgent;

  beforeEach(() => {
    bus = new MessageBus();
    agent = new UserAgent(bus);
  });

  // ── Construction ──────────────────────────────────────────────

  describe("constructor", () => {
    it("creates an agent with a valid id", () => {
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe("string");
      expect(agent.id.length).toBeGreaterThan(0);
    });

    it("has name 'User Agent'", () => {
      expect(agent.name).toBe("User Agent");
    });

    it("has role 'user'", () => {
      expect(agent.role).toBe("user");
    });

    it("has a description", () => {
      expect(agent.description).toBeDefined();
      expect(agent.description.length).toBeGreaterThan(0);
    });
  });

  // ── Agent Card ────────────────────────────────────────────────

  describe("card", () => {
    it("exposes an agent card object", () => {
      expect(agent.card).toBeDefined();
    });

    it("card.id matches agent.id", () => {
      expect(agent.card.id).toBe(agent.id);
    });

    it("card has name and role", () => {
      expect(agent.card.name).toBe("User Agent");
      expect(agent.card.role).toBe("user");
    });

    it("card has a wallet address", () => {
      expect(agent.card.walletAddress).toBeDefined();
      expect(agent.card.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("card has endpoint", () => {
      expect(agent.card.endpoint).toContain("agent://");
    });

    it("card has description", () => {
      expect(agent.card.description).toBeDefined();
      expect(agent.card.description!.length).toBeGreaterThan(0);
    });
  });

  // ── Wallet ────────────────────────────────────────────────────

  describe("wallet", () => {
    it("has a wallet with an address", () => {
      expect(agent.wallet).toBeDefined();
      expect(agent.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("wallet address matches card wallet address", () => {
      expect(agent.wallet.address).toBe(agent.card.walletAddress);
    });

    it("creates deterministic wallet with explicit private key", () => {
      const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
      const agent1 = new UserAgent(bus, { privateKey: key });
      const agent2 = new UserAgent(bus, { privateKey: key });
      expect(agent1.wallet.address).toBe(agent2.wallet.address);
    });
  });

  // ── Intent Handlers ───────────────────────────────────────────

  describe("intent handlers", () => {
    it("registers intent handlers on construction", () => {
      // After start(), supportedIntents is populated from the handler map
      agent.start();
      expect(agent.card.supportedIntents.length).toBeGreaterThan(0);
    });

    it("registers handlers for expected response intents", () => {
      agent.start();
      const intents = agent.card.supportedIntents;
      expect(intents).toContain("capabilities_response");
      expect(intents).toContain("quote_response");
      expect(intents).toContain("workflow_accepted");
      expect(intents).toContain("job_status_response");
      expect(intents).toContain("text_message");
      expect(intents).toContain("error");
    });

    it("registers build options and contract built handlers", () => {
      agent.start();
      const intents = agent.card.supportedIntents;
      expect(intents).toContain("build_options_response");
      expect(intents).toContain("contract_built_response");
    });
  });

  // ── Tools ─────────────────────────────────────────────────────

  describe("tools", () => {
    it("registers tools on construction", () => {
      const tools = agent.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("has a discover tool", () => {
      const tools = agent.getTools();
      const discover = tools.find((t) => t.name === "discover");
      expect(discover).toBeDefined();
      expect(discover!.description.length).toBeGreaterThan(0);
    });

    it("has a get_quote tool", () => {
      const tools = agent.getTools();
      const quote = tools.find((t) => t.name === "get_quote");
      expect(quote).toBeDefined();
    });

    it("has an explore_build_options tool", () => {
      const tools = agent.getTools();
      const explore = tools.find((t) => t.name === "explore_build_options");
      expect(explore).toBeDefined();
    });

    it("has a configure_and_build tool", () => {
      const tools = agent.getTools();
      const build = tools.find((t) => t.name === "configure_and_build");
      expect(build).toBeDefined();
    });

    it("has a chat_with_broker tool", () => {
      const tools = agent.getTools();
      const chat = tools.find((t) => t.name === "chat_with_broker");
      expect(chat).toBeDefined();
    });

    it("getToolDefinitions returns OpenAI-format schemas", () => {
      const defs = agent.getToolDefinitions();
      expect(defs.length).toBeGreaterThan(0);
      const first = defs[0];
      expect(first.name).toBeDefined();
      expect(first.description).toBeDefined();
      expect(first.input_schema).toBeDefined();
      expect(first.input_schema.type).toBe("object");
    });
  });

  // ── Notifications ─────────────────────────────────────────────

  describe("notifications", () => {
    it("starts with empty notifications", () => {
      expect(agent.getNotifications()).toEqual([]);
    });

    it("accepts a notification callback", () => {
      let called = false;
      agent.onNotification(() => {
        called = true;
      });
      // We can't easily trigger a notification without a full bus interaction,
      // but at least ensure the method doesn't throw.
      expect(called).toBe(false);
    });
  });

  // ── Bus Registration ──────────────────────────────────────────

  describe("bus registration", () => {
    it("registers on the bus when started", () => {
      agent.start();
      const found = bus.getAgent(agent.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(agent.id);
    });

    it("unregisters from the bus when stopped", () => {
      agent.start();
      expect(bus.getAgent(agent.id)).toBeDefined();
      agent.stop();
      expect(bus.getAgent(agent.id)).toBeUndefined();
    });

    it("is discoverable by role on the bus", () => {
      agent.start();
      const users = bus.findAgents("user");
      expect(users.length).toBe(1);
      expect(users[0].id).toBe(agent.id);
    });
  });

  // ── Unique Instances ──────────────────────────────────────────

  describe("unique instances", () => {
    it("two agents get different ids", () => {
      const agent2 = new UserAgent(bus);
      expect(agent.id).not.toBe(agent2.id);
    });

    it("two agents get different wallet addresses (random keys)", () => {
      const agent2 = new UserAgent(bus);
      expect(agent.wallet.address).not.toBe(agent2.wallet.address);
    });
  });
});
