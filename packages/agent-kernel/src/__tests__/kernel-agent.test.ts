import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus } from "@pcc/a2a";
import type { Capability } from "@pcc/spec";
import { KernelAgent, type KernelAgentConfig } from "../kernel-agent.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "cap_fdm_test",
    kernelId: "kernel-test",
    type: "fdm",
    name: "Test FDM Printer",
    description: "A mock FDM printer for testing",
    materials: ["pla", "petg"],
    assuranceTiers: [0, 1],
    pricing: {
      currency: "USDC",
      baseCost: "2.00",
      perMinute: "0.05",
      perGram: "0.03",
      minimum: "5.00",
    },
    availability: { timezone: "UTC", windows: {} },
    location: { lat: 40.7, lng: -74.0 },
    queueDepth: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<KernelAgentConfig> = {}): KernelAgentConfig {
  return {
    kernelId: "kernel-test",
    name: "Test Kernel",
    location: { lat: 40.7, lng: -74.0 },
    capabilities: [makeCapability()],
    mockPrintDuration: 100, // Fast for testing
    ...overrides,
  };
}

describe("KernelAgent", () => {
  let bus: MessageBus;
  let agent: KernelAgent;

  beforeEach(() => {
    bus = new MessageBus();
    agent = new KernelAgent(bus, makeConfig());
  });

  // ── Construction ──────────────────────────────────────────────

  describe("constructor", () => {
    it("creates an agent with a valid id", () => {
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe("string");
      expect(agent.id.length).toBeGreaterThan(0);
    });

    it("has the configured name", () => {
      expect(agent.name).toBe("Test Kernel");
    });

    it("has role 'kernel'", () => {
      expect(agent.role).toBe("kernel");
    });

    it("stores the kernel id", () => {
      expect(agent.kernelId).toBe("kernel-test");
    });

    it("stores the location", () => {
      expect(agent.location).toEqual({ lat: 40.7, lng: -74.0 });
    });

    it("has a description containing the kernel name", () => {
      expect(agent.description).toContain("Test Kernel");
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
      expect(agent.card.name).toBe("Test Kernel");
      expect(agent.card.role).toBe("kernel");
    });

    it("card has a wallet address", () => {
      expect(agent.card.walletAddress).toBeDefined();
      expect(agent.card.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("card has endpoint", () => {
      expect(agent.card.endpoint).toContain("agent://");
    });
  });

  // ── Capabilities Config ───────────────────────────────────────

  describe("capabilities", () => {
    it("stores the capabilities from config", () => {
      expect(agent.capabilities).toBeDefined();
      expect(agent.capabilities.length).toBe(1);
    });

    it("capabilities have correct type", () => {
      expect(agent.capabilities[0].type).toBe("fdm");
    });

    it("capabilities have correct materials", () => {
      expect(agent.capabilities[0].materials).toEqual(["pla", "petg"]);
    });

    it("getCapabilities returns a copy of capabilities", () => {
      const caps = agent.getCapabilities();
      expect(caps).toEqual(agent.capabilities);
      // Verify it's a copy, not the same reference
      expect(caps).not.toBe(agent.capabilities);
    });

    it("accepts multiple capabilities", () => {
      const multiAgent = new KernelAgent(bus, makeConfig({
        capabilities: [
          makeCapability({ id: "cap_fdm_1", type: "fdm" }),
          makeCapability({ id: "cap_cnc_1", type: "cnc-3axis", materials: ["aluminum-6061"] }),
        ],
      }));
      expect(multiAgent.capabilities.length).toBe(2);
      expect(multiAgent.getCapabilities().length).toBe(2);
    });
  });

  // ── Machine Profiles ──────────────────────────────────────────

  describe("machine profiles", () => {
    it("defaults to empty machine profiles", () => {
      expect(agent.machineProfiles).toEqual([]);
    });

    it("getMachineProfiles returns a copy", () => {
      const profiles = agent.getMachineProfiles();
      expect(profiles).toEqual([]);
      expect(profiles).not.toBe(agent.machineProfiles);
    });

    it("accepts machine profiles in config", () => {
      const agentWithProfiles = new KernelAgent(bus, makeConfig({
        machineProfiles: [{
          id: "prof_prusa_mk4",
          capabilityType: "fdm",
          machineName: "Prusa MK4",
          kernelId: "kernel-test",
          paramOverrides: [],
        }],
      }));
      expect(agentWithProfiles.machineProfiles.length).toBe(1);
      expect(agentWithProfiles.getMachineProfiles()[0].machineName).toBe("Prusa MK4");
    });
  });

  // ── Intent Handlers ───────────────────────────────────────────

  describe("intent handlers", () => {
    it("registers intent handlers on construction", () => {
      agent.start();
      expect(agent.card.supportedIntents.length).toBeGreaterThan(0);
    });

    it("handles request_quote intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("request_quote");
    });

    it("handles execute_job intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("execute_job");
    });

    it("handles cancel_job intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("cancel_job");
    });

    it("handles request_handoff intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("request_handoff");
    });

    it("handles job_status_query intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("job_status_query");
    });

    it("handles text_message intent", () => {
      agent.start();
      expect(agent.card.supportedIntents).toContain("text_message");
    });
  });

  // ── Tools ─────────────────────────────────────────────────────

  describe("tools", () => {
    it("registers tools on construction", () => {
      const tools = agent.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("has a list_capabilities tool", () => {
      const tools = agent.getTools();
      const listCaps = tools.find((t) => t.name === "list_capabilities");
      expect(listCaps).toBeDefined();
    });

    it("has a list_active_jobs tool", () => {
      const tools = agent.getTools();
      const listJobs = tools.find((t) => t.name === "list_active_jobs");
      expect(listJobs).toBeDefined();
    });

    it("has a get_build_options tool", () => {
      const tools = agent.getTools();
      const buildOpts = tools.find((t) => t.name === "get_build_options");
      expect(buildOpts).toBeDefined();
    });

    it("has a get_queue_depth tool", () => {
      const tools = agent.getTools();
      const queueDepth = tools.find((t) => t.name === "get_queue_depth");
      expect(queueDepth).toBeDefined();
    });

    it("list_capabilities tool returns correct data", async () => {
      const result = await agent.executeTool("list_capabilities", {}) as any[];
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("fdm");
      expect(result[0].materials).toEqual(["pla", "petg"]);
    });

    it("get_queue_depth tool returns queue state", async () => {
      const result = await agent.executeTool("get_queue_depth", {}) as any;
      expect(result.queueDepth).toBe(0);
      expect(result.activeJobs).toBe(0);
      expect(result.completedJobs).toBe(0);
    });

    it("list_active_jobs tool returns empty initially", async () => {
      const result = await agent.executeTool("list_active_jobs", {}) as any[];
      expect(result).toEqual([]);
    });
  });

  // ── Active Jobs ───────────────────────────────────────────────

  describe("active jobs", () => {
    it("starts with no active jobs", () => {
      expect(agent.getActiveJobs()).toEqual([]);
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

    it("is discoverable by role 'kernel' on the bus", () => {
      agent.start();
      const kernels = bus.findAgents("kernel");
      expect(kernels.length).toBe(1);
      expect(kernels[0].id).toBe(agent.id);
    });
  });

  // ── Unique Instances ──────────────────────────────────────────

  describe("unique instances", () => {
    it("two agents get different ids", () => {
      const agent2 = new KernelAgent(bus, makeConfig({ kernelId: "kernel-test-2", name: "Test Kernel 2" }));
      expect(agent.id).not.toBe(agent2.id);
    });

    it("two agents get different wallet addresses", () => {
      const agent2 = new KernelAgent(bus, makeConfig({ kernelId: "kernel-test-2" }));
      expect(agent.wallet.address).not.toBe(agent2.wallet.address);
    });
  });
});
