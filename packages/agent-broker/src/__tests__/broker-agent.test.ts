import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus } from "@pcc/a2a";
import { BrokerAgent } from "../broker-agent.js";

describe("BrokerAgent", () => {
  let bus: MessageBus;
  let agent: BrokerAgent;

  beforeEach(() => {
    bus = new MessageBus();
    agent = new BrokerAgent(bus);
  });

  // ── Construction ──────────────────────────────────────────────

  describe("constructor", () => {
    it("creates an agent with a valid id", () => {
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe("string");
      expect(agent.id.length).toBeGreaterThan(0);
    });

    it("has name 'PCC Broker'", () => {
      expect(agent.name).toBe("PCC Broker");
    });

    it("has role 'scheduler'", () => {
      expect(agent.role).toBe("scheduler");
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
      expect(agent.card.name).toBe("PCC Broker");
      expect(agent.card.role).toBe("scheduler");
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
      const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as `0x${string}`;
      const agent1 = new BrokerAgent(bus, { privateKey: key });
      const agent2 = new BrokerAgent(bus, { privateKey: key });
      expect(agent1.wallet.address).toBe(agent2.wallet.address);
    });
  });

  // ── Intent Handlers ───────────────────────────────────────────

  describe("intent handlers", () => {
    it("registers intent handlers on construction", () => {
      agent.start();
      expect(agent.card.supportedIntents.length).toBeGreaterThan(0);
    });

    it("handles discover_capabilities intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("discover_capabilities");
    });

    it("handles request_quote intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("request_quote");
    });

    it("handles submit_workflow intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("submit_workflow");
    });

    it("handles negotiate intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("negotiate");
    });

    it("handles job_status_query intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("job_status_query");
    });

    it("handles text_message intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("text_message");
    });

    it("handles get_build_options intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("get_build_options");
    });

    it("handles build_contract intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("build_contract");
    });

    it("handles discover_hubs intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("discover_hubs");
    });

    it("handles job_completed intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("job_completed");
    });
  });

  // ── Tools ─────────────────────────────────────────────────────

  describe("tools", () => {
    it("registers tools on construction", () => {
      const tools = agent.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("has a search_capabilities tool", () => {
      const tools = agent.getTools();
      const search = tools.find((t) => t.name === "search_capabilities");
      expect(search).toBeDefined();
    });

    it("has a get_quote tool", () => {
      const tools = agent.getTools();
      const quote = tools.find((t) => t.name === "get_quote");
      expect(quote).toBeDefined();
    });

    it("has a list_active_plans tool", () => {
      const tools = agent.getTools();
      const plans = tools.find((t) => t.name === "list_active_plans");
      expect(plans).toBeDefined();
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

    it("is discoverable by role 'scheduler' on the bus", () => {
      agent.start();
      const schedulers = bus.findAgents("scheduler");
      expect(schedulers.length).toBe(1);
      expect(schedulers[0].id).toBe(agent.id);
    });
  });

  // ── Kernel Registration ────────────────────────────────────────

  describe("kernel capabilities registration", () => {
    it("registerKernelCapabilities does not throw", () => {
      expect(() => {
        agent.registerKernelCapabilities("kernel-test", {
          kernelId: "kernel-test",
          reputation: 500,
          capabilities: [
            {
              id: "cap_fdm_test",
              kernelId: "kernel-test",
              type: "fdm",
              name: "Test FDM",
              description: "Test FDM printer",
              materials: ["pla"],
              assuranceTiers: [0, 1],
              pricing: { currency: "USDC", baseCost: "5.00", perMinute: "0.10", minimum: "5.00" },
              availability: { timezone: "UTC", windows: {} },
              location: { lat: 0, lng: 0 },
              queueDepth: 0,
            },
          ],
        });
      }).not.toThrow();
    });
  });

  // ── Unique Instances ──────────────────────────────────────────

  describe("unique instances", () => {
    it("two agents get different ids", () => {
      const agent2 = new BrokerAgent(bus);
      expect(agent.id).not.toBe(agent2.id);
    });

    it("two agents get different wallet addresses (random keys)", () => {
      const agent2 = new BrokerAgent(bus);
      expect(agent.wallet.address).not.toBe(agent2.wallet.address);
    });
  });
});
