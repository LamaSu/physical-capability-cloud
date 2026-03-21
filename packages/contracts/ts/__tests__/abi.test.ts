import { describe, it, expect } from "vitest";
import {
  MilestoneEscrowABI,
  MockUSDCABI,
  MilestoneStatus,
  milestoneStatusName,
  getDeployment,
  getContractAddress,
  deployments,
} from "../index.js";

describe("MilestoneEscrowABI", () => {
  it("exports a valid ABI array", () => {
    expect(Array.isArray(MilestoneEscrowABI)).toBe(true);
    expect(MilestoneEscrowABI.length).toBeGreaterThan(0);
  });

  it("has constructor, views, state-changing functions, and events", () => {
    const types = new Set(MilestoneEscrowABI.map((item) => item.type));
    expect(types.has("constructor")).toBe(true);
    expect(types.has("function")).toBe(true);
    expect(types.has("event")).toBe(true);
  });

  it("includes all key functions", () => {
    const fns = MilestoneEscrowABI
      .filter((item) => item.type === "function")
      .map((item) => (item as { name: string }).name);
    expect(fns).toContain("addMilestone");
    expect(fns).toContain("fund");
    expect(fns).toContain("depositBond");
    expect(fns).toContain("submitEvidence");
    expect(fns).toContain("submitAttestation");
    expect(fns).toContain("release");
    expect(fns).toContain("fileDispute");
    expect(fns).toContain("resolveDispute");
    expect(fns).toContain("getMilestoneCount");
    expect(fns).toContain("getMilestone");
    expect(fns).toContain("getDispute");
  });

  it("includes all events", () => {
    const events = MilestoneEscrowABI
      .filter((item) => item.type === "event")
      .map((item) => (item as { name: string }).name);
    expect(events).toContain("EscrowFunded");
    expect(events).toContain("MilestoneLocked");
    expect(events).toContain("EvidenceSubmitted");
    expect(events).toContain("AttestationSubmitted");
    expect(events).toContain("MilestoneReleased");
    expect(events).toContain("DisputeFiled");
    expect(events).toContain("DisputeResolved");
    expect(events).toContain("BondSlashed");
  });
});

describe("MockUSDCABI", () => {
  it("exports ERC-20 functions", () => {
    const fns = MockUSDCABI
      .filter((item) => item.type === "function")
      .map((item) => (item as { name: string }).name);
    expect(fns).toContain("balanceOf");
    expect(fns).toContain("transfer");
    expect(fns).toContain("approve");
    expect(fns).toContain("transferFrom");
    expect(fns).toContain("mint");
  });
});

describe("MilestoneStatus", () => {
  it("maps all 9 statuses", () => {
    expect(Object.keys(MilestoneStatus)).toHaveLength(9);
    expect(MilestoneStatus.Unfunded).toBe(0);
    expect(MilestoneStatus.Funded).toBe(1);
    expect(MilestoneStatus.Locked).toBe(2);
    expect(MilestoneStatus.Evidenced).toBe(3);
    expect(MilestoneStatus.Attested).toBe(4);
    expect(MilestoneStatus.Released).toBe(5);
    expect(MilestoneStatus.Disputed).toBe(6);
    expect(MilestoneStatus.Refunded).toBe(7);
    expect(MilestoneStatus.Slashed).toBe(8);
  });

  it("milestoneStatusName resolves correctly", () => {
    expect(milestoneStatusName(0)).toBe("Unfunded");
    expect(milestoneStatusName(5)).toBe("Released");
    expect(milestoneStatusName(8)).toBe("Slashed");
    expect(milestoneStatusName(99)).toBe("Unfunded"); // fallback
  });
});

describe("chain-config", () => {
  it("has at least 4 network deployments (including Story Protocol chains)", () => {
    const networks = Object.keys(deployments);
    expect(networks).toContain("localhost");
    expect(networks).toContain("sepolia");
    expect(networks).toContain("base-sepolia");
    expect(networks).toContain("base");
    // Story Protocol chains added in Phase 1
    expect(networks).toContain("story");
    expect(networks).toContain("story-aeneid");
  });

  it("getDeployment returns valid config for base-sepolia", () => {
    const bsep = getDeployment("base-sepolia");
    expect(bsep.chain.id).toBe(84532);
    expect(bsep.contracts.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("getDeployment returns valid config for sepolia with deployed contracts", () => {
    const sep = getDeployment("sepolia");
    expect(sep.chain.id).toBe(11155111);
    expect(sep.rpcUrl).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(sep.contracts.milestoneEscrowFactory).toBe("0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454");
    expect(sep.contracts.mockUSDC).toBe("0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb");
    expect(sep.blockExplorer).toBe("https://sepolia.etherscan.io");
  });

  it("getDeployment throws for unknown network", () => {
    expect(() => getDeployment("polygon")).toThrow("Unknown network");
  });

  it("getContractAddress returns deployed address for sepolia", () => {
    const addr = getContractAddress("sepolia", "milestoneEscrowFactory");
    expect(addr).toBe("0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454");
  });

  it("getContractAddress throws for undeployed contract", () => {
    // localhost has no milestoneEscrowFactory deployed (undefined in config)
    expect(() => getContractAddress("localhost", "milestoneEscrowFactory")).toThrow("not deployed");
  });

  it("getContractAddress returns address for deployed contract", () => {
    const addr = getContractAddress("base-sepolia", "usdc");
    expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
