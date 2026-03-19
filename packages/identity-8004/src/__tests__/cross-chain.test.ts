import { describe, it, expect, beforeEach } from "vitest";
import { CrossChainRegistrationManager, SUPPORTED_CHAINS } from "../cross-chain.js";

describe("CrossChainRegistrationManager", () => {
  let manager: CrossChainRegistrationManager;

  beforeEach(() => {
    manager = new CrossChainRegistrationManager();
  });

  describe("createPlan", () => {
    it("creates a plan targeting all supported chains by default", () => {
      const plan = manager.createPlan("kernel-lab-01", "https://lab.io/.well-known/agent-registration.json");

      expect(plan.kernelId).toBe("kernel-lab-01");
      expect(plan.targetChains).toHaveLength(SUPPORTED_CHAINS.length);
      expect(plan.status).toBe("pending");
      expect(plan.targetChains.every(c => !c.registered)).toBe(true);
    });

    it("creates a plan targeting specific chains", () => {
      const plan = manager.createPlan(
        "kernel-lab-01",
        "https://lab.io/agent.json",
        [84532], // Base Sepolia only
      );

      expect(plan.targetChains).toHaveLength(1);
      expect(plan.targetChains[0]!.chainId).toBe(84532);
    });
  });

  describe("recordRegistration", () => {
    it("records a successful registration", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json");

      manager.recordRegistration(
        "kernel-01",
        84532,
        42n,
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      );

      const plan = manager.getPlan("kernel-01")!;
      const baseSepolia = plan.targetChains.find(c => c.chainId === 84532)!;
      expect(baseSepolia.registered).toBe(true);
      expect(baseSepolia.agentId).toBe(42n);
    });

    it("sets status to partial when some chains registered", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json");

      manager.recordRegistration("kernel-01", 84532, 42n, "0xabc" as `0x${string}`);

      const plan = manager.getPlan("kernel-01")!;
      expect(plan.status).toBe("partial");
    });

    it("sets status to completed when all chains registered", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json", [84532]);

      manager.recordRegistration("kernel-01", 84532, 42n, "0xabc" as `0x${string}`);

      const plan = manager.getPlan("kernel-01")!;
      expect(plan.status).toBe("completed");
    });
  });

  describe("getRegistrationsForFile", () => {
    it("returns registrations array for Agent Registration File", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json");
      manager.recordRegistration("kernel-01", 84532, 42n, "0xabc" as `0x${string}`);
      manager.recordRegistration("kernel-01", 11155111, 99n, "0xdef" as `0x${string}`);

      const registrations = manager.getRegistrationsForFile("kernel-01");

      expect(registrations).toHaveLength(2);
      expect(registrations[0]!.agentId).toBe(42);
      expect(registrations[0]!.agentRegistry).toContain("eip155:84532:");
      expect(registrations[1]!.agentId).toBe(99);
      expect(registrations[1]!.agentRegistry).toContain("eip155:11155111:");
    });

    it("returns empty array for unregistered kernel", () => {
      expect(manager.getRegistrationsForFile("nonexistent")).toEqual([]);
    });

    it("only includes completed registrations", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json");
      manager.recordRegistration("kernel-01", 84532, 42n, "0xabc" as `0x${string}`);
      // Don't register on Ethereum Sepolia

      const registrations = manager.getRegistrationsForFile("kernel-01");
      expect(registrations).toHaveLength(1);
    });
  });

  describe("updateRegistrationFile", () => {
    it("injects registrations into existing file", () => {
      manager.createPlan("kernel-01", "https://k.io/agent.json");
      manager.recordRegistration("kernel-01", 84532, 42n, "0xabc" as `0x${string}`);

      const file = manager.updateRegistrationFile("kernel-01", {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "Test Kernel",
        description: "Test",
        services: [],
        x402Support: true,
        active: true,
        registrations: [], // Will be overwritten
        supportedTrust: ["reputation"],
      });

      expect(file.registrations).toHaveLength(1);
      expect(file.name).toBe("Test Kernel"); // Other fields preserved
    });
  });
});
