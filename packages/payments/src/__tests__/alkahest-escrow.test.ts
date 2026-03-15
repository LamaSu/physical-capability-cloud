import { describe, it, expect, beforeEach } from "vitest";
import { AlkahestEscrowBridge } from "../alkahest/escrow-bridge.js";
import type { EscrowMilestone, BondConfig } from "@pcc/spec";

const BUYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const ESCROW_ID = "esc-test-001";

const milestone: EscrowMilestone = {
  stepId: "step-1",
  amount: "100.00",
  status: "funded",
  bondAmount: "15.00",
};

const tier2Bond: BondConfig = {
  tier: 2,
  operatorBondPercent: 15,
  challengerBondPercent: 15,
  challengeWindowSeconds: 86400,
  slashPercent: 100,
};

describe("AlkahestEscrowBridge", () => {
  let bridge: AlkahestEscrowBridge;

  beforeEach(() => {
    bridge = new AlkahestEscrowBridge({ mock: true });
  });

  // ── Lock ──────────────────────────────────────────────────────

  it("locks a milestone as an Alkahest obligation", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    expect(obligation.uid).toMatch(/^0x/);
    expect(obligation.status).toBe("locked");
    expect(obligation.buyer).toBe(BUYER);
    expect(obligation.seller).toBe(SELLER);
    expect(obligation.milestoneStepId).toBe("step-1");
    expect(obligation.pccEscrowId).toBe(ESCROW_ID);
    expect(obligation.lockTxHash).toBeTruthy();
    // Amount includes operator bond (15% of 100 = 115)
    expect(parseFloat(obligation.amount)).toBeCloseTo(115, 0);
  });

  it("encodes evidence demand based on assurance tier", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    // Demand should be hex-encoded JSON
    expect(obligation.demand).toMatch(/^0x/);
    const demandJson = Buffer.from(obligation.demand.slice(2), "hex").toString("utf-8");
    const demand = JSON.parse(demandJson);
    expect(demand.minimumTier).toBe(2);
    expect(demand.minimumVerifiers).toBe(3);
    expect(demand.minimumConsensusScore).toBe(0.7);
    expect(demand.requireZKProof).toBe(false);
  });

  it("tier 3 demands ZK proof", async () => {
    const tier3Bond: BondConfig = { tier: 3, operatorBondPercent: 25, challengerBondPercent: 20, challengeWindowSeconds: 259200, slashPercent: 100 };
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier3Bond,
    });

    const demand = JSON.parse(Buffer.from(obligation.demand.slice(2), "hex").toString("utf-8"));
    expect(demand.requireZKProof).toBe(true);
    expect(demand.minimumConsensusScore).toBe(0.9);
  });

  // ── Fulfill ───────────────────────────────────────────────────

  it("fulfills an obligation with valid evidence", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    const fulfilled = await bridge.fulfillMilestone({
      obligationUid: obligation.uid,
      result: {
        bundleHash: "sha256:abc123",
        ipfsCid: "bafybeig...",
        consensusScore: 0.85,
        verifierCount: 5,
      },
    });

    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.fulfillmentUid).toMatch(/^0x/);
  });

  it("rejects fulfillment with insufficient verifiers", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    await expect(
      bridge.fulfillMilestone({
        obligationUid: obligation.uid,
        result: {
          bundleHash: "sha256:abc123",
          ipfsCid: "bafybeig...",
          consensusScore: 0.85,
          verifierCount: 1, // Need 3 for tier 2
        },
      }),
    ).rejects.toThrow("Need 3 verifiers");
  });

  it("rejects fulfillment with low consensus score", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    await expect(
      bridge.fulfillMilestone({
        obligationUid: obligation.uid,
        result: {
          bundleHash: "sha256:abc123",
          ipfsCid: "bafybeig...",
          consensusScore: 0.5, // Need 0.7 for tier 2
          verifierCount: 5,
        },
      }),
    ).rejects.toThrow("Consensus");
  });

  it("rejects fulfillment without ZK proof at tier 3", async () => {
    const tier3Bond: BondConfig = { tier: 3, operatorBondPercent: 25, challengerBondPercent: 20, challengeWindowSeconds: 259200, slashPercent: 100 };
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier3Bond,
    });

    await expect(
      bridge.fulfillMilestone({
        obligationUid: obligation.uid,
        result: {
          bundleHash: "sha256:abc123",
          ipfsCid: "bafybeig...",
          consensusScore: 0.95,
          verifierCount: 5,
          // No zkProofId — should fail
        },
      }),
    ).rejects.toThrow("ZK proof required");
  });

  // ── Collect ───────────────────────────────────────────────────

  it("collects escrowed funds after fulfillment", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    await bridge.fulfillMilestone({
      obligationUid: obligation.uid,
      result: { bundleHash: "sha256:abc", ipfsCid: "bafy...", consensusScore: 0.9, verifierCount: 4 },
    });

    const collected = await bridge.collectEscrow(obligation.uid);
    expect(collected.status).toBe("collected");
    expect(collected.settleTxHash).toBeTruthy();
  });

  it("cannot collect unfulfilled obligation", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    await expect(bridge.collectEscrow(obligation.uid)).rejects.toThrow("Not fulfilled");
  });

  // ── Expiry ────────────────────────────────────────────────────

  it("returns expired escrow to buyer", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
      expirationSeconds: -1, // Already expired
    });

    const returned = await bridge.returnExpired(obligation.uid);
    expect(returned.status).toBe("expired");
    expect(returned.settleTxHash).toBeTruthy();
  });

  it("cannot return non-expired obligation", async () => {
    const obligation = await bridge.lockMilestone({
      pccEscrowId: ESCROW_ID,
      milestone,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
      expirationSeconds: 999999,
    });

    await expect(bridge.returnExpired(obligation.uid)).rejects.toThrow("not yet expired");
  });

  // ── Batch ─────────────────────────────────────────────────────

  it("locks all milestones in a PCC escrow", async () => {
    const milestones: EscrowMilestone[] = [
      { stepId: "step-1", amount: "50.00", status: "funded", bondAmount: "7.50" },
      { stepId: "step-2", amount: "75.00", status: "funded", bondAmount: "11.25" },
      { stepId: "step-3", amount: "25.00", status: "funded", bondAmount: "3.75" },
    ];

    const obligations = await bridge.lockAllMilestones({
      pccEscrowId: ESCROW_ID,
      milestones,
      buyer: BUYER,
      seller: SELLER,
      bondConfig: tier2Bond,
    });

    expect(obligations).toHaveLength(3);
    expect(obligations.every((o) => o.status === "locked")).toBe(true);
    expect(obligations.map((o) => o.milestoneStepId)).toEqual(["step-1", "step-2", "step-3"]);
  });

  // ── Queries ───────────────────────────────────────────────────

  it("queries obligations by PCC escrow ID", async () => {
    await bridge.lockMilestone({ pccEscrowId: "esc-1", milestone, buyer: BUYER, seller: SELLER, bondConfig: tier2Bond });
    await bridge.lockMilestone({ pccEscrowId: "esc-2", milestone, buyer: BUYER, seller: SELLER, bondConfig: tier2Bond });
    await bridge.lockMilestone({ pccEscrowId: "esc-1", milestone: { ...milestone, stepId: "step-2" }, buyer: BUYER, seller: SELLER, bondConfig: tier2Bond });

    const forEsc1 = bridge.getObligationsForEscrow("esc-1");
    expect(forEsc1).toHaveLength(2);
  });

  it("queries obligations by seller", async () => {
    await bridge.lockMilestone({ pccEscrowId: ESCROW_ID, milestone, buyer: BUYER, seller: SELLER, bondConfig: tier2Bond });
    await bridge.lockMilestone({ pccEscrowId: ESCROW_ID, milestone, buyer: BUYER, seller: "0x3333333333333333333333333333333333333333", bondConfig: tier2Bond });

    const forSeller = bridge.getObligationsForSeller(SELLER);
    expect(forSeller).toHaveLength(1);
  });
});
