import { describe, it, expect, beforeEach } from "vitest";
import { NativeEscrowService } from "../native-escrow-service.js";
import { AttestationService } from "../attestation-service.js";
import type {
  FulfillmentProof,
  EscrowObligation,
} from "../types.js";
import type { EscrowMilestone, BondConfig } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUYER = "0x1111111111111111111111111111111111111111" as const;
const SELLER = "0x2222222222222222222222222222222222222222" as const;
const ESCROW_ID = "escrow-001";

function makeMilestone(
  stepId: string,
  amount: string,
): EscrowMilestone {
  return {
    stepId,
    amount,
    status: "unfunded",
    bondAmount: "0",
  };
}

function makeBondConfig(tier: 0 | 1 | 2 | 3): BondConfig {
  const configs: Record<number, BondConfig> = {
    0: {
      tier: 0,
      operatorBondPercent: 0,
      challengerBondPercent: 10,
      challengeWindowSeconds: 3600,
      slashPercent: 100,
    },
    1: {
      tier: 1,
      operatorBondPercent: 5,
      challengerBondPercent: 10,
      challengeWindowSeconds: 14400,
      slashPercent: 100,
    },
    2: {
      tier: 2,
      operatorBondPercent: 15,
      challengerBondPercent: 15,
      challengeWindowSeconds: 86400,
      slashPercent: 100,
    },
    3: {
      tier: 3,
      operatorBondPercent: 25,
      challengerBondPercent: 20,
      challengeWindowSeconds: 259200,
      slashPercent: 100,
    },
  };
  return configs[tier]!;
}

function makeValidProof(overrides?: Partial<FulfillmentProof>): FulfillmentProof {
  return {
    bundleHash: "sha256:abc123def456",
    ipfsCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    consensusScore: 0.95,
    verifierCount: 5,
    zkProofId: "zk-proof-001",
    signatures: ["sig1", "sig2", "sig3"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NativeEscrowService Tests
// ---------------------------------------------------------------------------

describe("NativeEscrowService", () => {
  let service: NativeEscrowService;

  beforeEach(() => {
    service = new NativeEscrowService();
  });

  // ---- Lock ----

  describe("lockMilestone", () => {
    it("creates obligation with correct demand encoding", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(2),
      });

      expect(obligation.id).toMatch(/^obl_/);
      expect(obligation.escrowId).toBe(ESCROW_ID);
      expect(obligation.milestoneStepId).toBe("step-1");
      expect(obligation.buyer).toBe(BUYER);
      expect(obligation.seller).toBe(SELLER);
      expect(obligation.status).toBe("locked");
      expect(obligation.demand.minimumTier).toBe(2);
      expect(obligation.demand.minimumVerifiers).toBe(3);
      expect(obligation.demand.minimumConsensusScore).toBe(0.7);
      expect(obligation.demand.requireZKProof).toBe(false);
      expect(obligation.lockTxHash).toBeTruthy();
      expect(obligation.createdAt).toBeTruthy();
    });

    it("calculates bond correctly for tier 0 (no bond)", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });

      // Tier 0: 0% bond, so total = 100
      expect(parseFloat(obligation.amount)).toBe(100);
    });

    it("calculates bond correctly for tier 1 (5%)", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "1000"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      // Tier 1: 5% bond, total = 1000 + 50 = 1050
      expect(parseFloat(obligation.amount)).toBe(1050);
    });

    it("calculates bond correctly for tier 2 (15%)", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "200"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(2),
      });

      // Tier 2: 15% bond, total = 200 + 30 = 230
      expect(parseFloat(obligation.amount)).toBe(230);
    });

    it("calculates bond correctly for tier 3 (25%)", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "400"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(3),
      });

      // Tier 3: 25% bond, total = 400 + 100 = 500
      expect(parseFloat(obligation.amount)).toBe(500);
      // Tier 3 demands ZK proof
      expect(obligation.demand.requireZKProof).toBe(true);
      expect(obligation.demand.minimumConsensusScore).toBe(0.9);
    });

    it("sets tier 3 demand to require ZK proof", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(3),
      });

      expect(obligation.demand.requireZKProof).toBe(true);
      expect(obligation.demand.minimumVerifiers).toBe(3);
      expect(obligation.demand.minimumConsensusScore).toBe(0.9);
    });
  });

  // ---- Fulfill ----

  describe("fulfillMilestone", () => {
    let lockedObligation: EscrowObligation;

    beforeEach(async () => {
      lockedObligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });
    });

    it("succeeds with valid proof", async () => {
      const result = await service.fulfillMilestone({
        obligationId: lockedObligation.id,
        proof: makeValidProof(),
      });

      expect(result.status).toBe("fulfilled");
      expect(result.fulfillmentEvidence).toBeDefined();
      expect(result.fulfillmentEvidence!.bundleHash).toBe(
        "sha256:abc123def456",
      );
    });

    it("fails with insufficient verifiers", async () => {
      await expect(
        service.fulfillMilestone({
          obligationId: lockedObligation.id,
          proof: makeValidProof({ verifierCount: 0 }),
        }),
      ).rejects.toThrow("Need 1 verifiers, got 0");
    });

    it("fails with low consensus score", async () => {
      await expect(
        service.fulfillMilestone({
          obligationId: lockedObligation.id,
          proof: makeValidProof({ consensusScore: 0.3 }),
        }),
      ).rejects.toThrow("Consensus 0.3 < required 0.5");
    });

    it("fails without required ZK proof (tier 3)", async () => {
      const tier3Obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-zk", "500"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(3),
      });

      await expect(
        service.fulfillMilestone({
          obligationId: tier3Obligation.id,
          proof: makeValidProof({ zkProofId: undefined }),
        }),
      ).rejects.toThrow("ZK proof required but not provided");
    });

    it("fails when obligation is not locked", async () => {
      // Fulfill first
      await service.fulfillMilestone({
        obligationId: lockedObligation.id,
        proof: makeValidProof(),
      });

      // Try to fulfill again
      await expect(
        service.fulfillMilestone({
          obligationId: lockedObligation.id,
          proof: makeValidProof(),
        }),
      ).rejects.toThrow("Cannot fulfill obligation in status: fulfilled");
    });

    it("fails with missing bundle hash", async () => {
      await expect(
        service.fulfillMilestone({
          obligationId: lockedObligation.id,
          proof: makeValidProof({ bundleHash: "" }),
        }),
      ).rejects.toThrow("Missing evidence bundle hash");
    });
  });

  // ---- Collect ----

  describe("collectEscrow", () => {
    it("succeeds after fulfillment", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await service.fulfillMilestone({
        obligationId: obligation.id,
        proof: makeValidProof(),
      });

      const collected = await service.collectEscrow(obligation.id);
      expect(collected.status).toBe("collected");
      expect(collected.settleTxHash).toBeTruthy();
    });

    it("fails without fulfillment", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await expect(service.collectEscrow(obligation.id)).rejects.toThrow(
        "Cannot collect: obligation is locked, must be fulfilled",
      );
    });
  });

  // ---- Return Expired ----

  describe("returnExpired", () => {
    it("returns expired obligation to buyer", async () => {
      // Lock with immediate expiration
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
        expirationSeconds: -1, // already expired
      });

      const returned = await service.returnExpired(obligation.id);
      expect(returned.status).toBe("expired");
      expect(returned.settleTxHash).toBeTruthy();
    });

    it("fails for non-expired obligation", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
        expirationSeconds: 999999,
      });

      await expect(
        service.returnExpired(obligation.id),
      ).rejects.toThrow("Obligation has not expired yet");
    });

    it("fails for non-locked obligation", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await service.fulfillMilestone({
        obligationId: obligation.id,
        proof: makeValidProof(),
      });

      await expect(
        service.returnExpired(obligation.id),
      ).rejects.toThrow("Cannot return: obligation is fulfilled, must be locked");
    });
  });

  // ---- Dispute ----

  describe("disputeMilestone", () => {
    it("freezes funds and creates dispute", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      const dispute = await service.disputeMilestone(
        obligation.id,
        "Evidence appears fabricated",
        "10",
      );

      expect(dispute.id).toMatch(/^dsp_/);
      expect(dispute.reason).toBe("Evidence appears fabricated");
      expect(dispute.challengerBond).toBe("10");

      const updated = service.getObligation(obligation.id);
      expect(updated!.status).toBe("disputed");
    });

    it("fails for already collected obligation", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await service.fulfillMilestone({
        obligationId: obligation.id,
        proof: makeValidProof(),
      });
      await service.collectEscrow(obligation.id);

      await expect(
        service.disputeMilestone(obligation.id, "too late", "10"),
      ).rejects.toThrow("Cannot dispute obligation in status: collected");
    });
  });

  // ---- Resolve Dispute ----

  describe("resolveDispute", () => {
    let disputedObligationId: string;

    beforeEach(async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await service.disputeMilestone(
        obligation.id,
        "quality concern",
        "10",
      );
      disputedObligationId = obligation.id;
    });

    it("resolves for buyer (returns funds)", async () => {
      const result = await service.resolveDispute(
        disputedObligationId,
        "buyer",
      );
      expect(result.status).toBe("expired");
      expect(result.settleTxHash).toContain("mock_return");
    });

    it("resolves for seller (releases funds)", async () => {
      const result = await service.resolveDispute(
        disputedObligationId,
        "seller",
      );
      expect(result.status).toBe("collected");
      expect(result.settleTxHash).toContain("mock_resolve");
    });

    it("resolves with split", async () => {
      const result = await service.resolveDispute(
        disputedObligationId,
        "split",
        60,
      );
      expect(result.status).toBe("collected");

      // Verify the dispute has the split recorded
      const disputes = service.getDisputesForObligation(
        disputedObligationId,
      );
      expect(disputes.length).toBe(1);
      expect(disputes[0]!.resolution!.decision).toBe("split");
      expect(disputes[0]!.resolution!.splitPercent).toBe(60);
    });

    it("fails for non-disputed obligation", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-clean", "50"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });

      await expect(
        service.resolveDispute(obligation.id, "buyer"),
      ).rejects.toThrow("must be disputed");
    });
  });

  // ---- Batch Operations ----

  describe("lockAllMilestones", () => {
    it("locks multiple milestones", async () => {
      const milestones = [
        makeMilestone("step-1", "100"),
        makeMilestone("step-2", "200"),
        makeMilestone("step-3", "300"),
      ];

      const obligations = await service.lockAllMilestones({
        escrowId: ESCROW_ID,
        milestones,
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      expect(obligations).toHaveLength(3);
      expect(obligations[0]!.milestoneStepId).toBe("step-1");
      expect(obligations[1]!.milestoneStepId).toBe("step-2");
      expect(obligations[2]!.milestoneStepId).toBe("step-3");

      // Each has unique ID
      const ids = new Set(obligations.map((o) => o.id));
      expect(ids.size).toBe(3);
    });
  });

  // ---- Queries ----

  describe("queries", () => {
    it("queries obligations by escrow ID", async () => {
      await service.lockMilestone({
        escrowId: "escrow-A",
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });
      await service.lockMilestone({
        escrowId: "escrow-A",
        milestone: makeMilestone("step-2", "200"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });
      await service.lockMilestone({
        escrowId: "escrow-B",
        milestone: makeMilestone("step-1", "300"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });

      const escrowA = service.getObligationsForEscrow("escrow-A");
      expect(escrowA).toHaveLength(2);

      const escrowB = service.getObligationsForEscrow("escrow-B");
      expect(escrowB).toHaveLength(1);
    });

    it("queries obligations by seller", async () => {
      await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "100"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(0),
      });

      const sellerObligations = service.getObligationsForSeller(SELLER);
      expect(sellerObligations).toHaveLength(1);

      const otherSeller = service.getObligationsForSeller(
        "0x9999999999999999999999999999999999999999",
      );
      expect(otherSeller).toHaveLength(0);
    });

    it("returns undefined for non-existent obligation", () => {
      expect(service.getObligation("obl_nonexistent")).toBeUndefined();
    });
  });

  // ---- Full Lifecycle ----

  describe("full lifecycle", () => {
    it("lock -> fulfill -> collect", async () => {
      // Step 1: Lock
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "500"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(2),
      });
      expect(obligation.status).toBe("locked");

      // Step 2: Fulfill
      const fulfilled = await service.fulfillMilestone({
        obligationId: obligation.id,
        proof: makeValidProof(),
      });
      expect(fulfilled.status).toBe("fulfilled");
      expect(fulfilled.fulfillmentEvidence).toBeDefined();

      // Step 3: Collect
      const collected = await service.collectEscrow(obligation.id);
      expect(collected.status).toBe("collected");
      expect(collected.settleTxHash).toBeTruthy();
    });

    it("lock -> expire -> return", async () => {
      // Step 1: Lock with immediate expiration
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "500"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
        expirationSeconds: -1,
      });
      expect(obligation.status).toBe("locked");

      // Step 2: Return expired
      const returned = await service.returnExpired(obligation.id);
      expect(returned.status).toBe("expired");
    });

    it("lock -> dispute -> resolve for buyer", async () => {
      const obligation = await service.lockMilestone({
        escrowId: ESCROW_ID,
        milestone: makeMilestone("step-1", "500"),
        buyer: BUYER,
        seller: SELLER,
        bondConfig: makeBondConfig(1),
      });

      await service.disputeMilestone(
        obligation.id,
        "Fraudulent evidence",
        "50",
      );

      const resolved = await service.resolveDispute(
        obligation.id,
        "buyer",
      );
      expect(resolved.status).toBe("expired");
    });
  });
});

// ---------------------------------------------------------------------------
// AttestationService Tests
// ---------------------------------------------------------------------------

describe("AttestationService", () => {
  let attestationService: AttestationService;
  let keyPair: { publicKey: string; privateKey: string };

  beforeEach(() => {
    attestationService = new AttestationService();
    keyPair = AttestationService.generateKeyPair();
  });

  it("generates a valid keypair", () => {
    expect(keyPair.publicKey).toBeTruthy();
    expect(keyPair.privateKey).toBeTruthy();
    // DER-encoded keys have standard lengths
    expect(keyPair.publicKey.length).toBeGreaterThan(0);
    expect(keyPair.privateKey.length).toBeGreaterThan(0);
  });

  it("creates an attestation with valid signature", () => {
    const attestation = attestationService.createAttestation(
      "pcc.demand.v1",
      { minimumTier: 2, minimumVerifiers: 3 },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    expect(attestation.id).toMatch(/^att_/);
    expect(attestation.schema).toBe("pcc.demand.v1");
    expect(attestation.signer).toBe(keyPair.publicKey);
    expect(attestation.signature).toBeTruthy();
    expect(attestation.revoked).toBe(false);
  });

  it("verifies a valid attestation", () => {
    const attestation = attestationService.createAttestation(
      "pcc.result.v1",
      { bundleHash: "sha256:test", consensusScore: 0.95 },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    const valid = attestationService.verifyAttestation(
      attestation,
      keyPair.publicKey,
    );
    expect(valid).toBe(true);
  });

  it("fails verification with wrong signer", () => {
    const attestation = attestationService.createAttestation(
      "pcc.result.v1",
      { bundleHash: "sha256:test" },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    const otherKey = AttestationService.generateKeyPair();
    const valid = attestationService.verifyAttestation(
      attestation,
      otherKey.publicKey,
    );
    expect(valid).toBe(false);
  });

  it("fails verification for revoked attestation", () => {
    const attestation = attestationService.createAttestation(
      "pcc.demand.v1",
      { test: true },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    attestationService.revokeAttestation(attestation.id);

    const valid = attestationService.verifyAttestation(
      attestation,
      keyPair.publicKey,
    );
    expect(valid).toBe(false);
  });

  it("fails verification with tampered data", () => {
    const attestation = attestationService.createAttestation(
      "pcc.demand.v1",
      { amount: 100 },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    // Tamper with the data
    const tampered = { ...attestation, data: { amount: 999 } };

    const valid = attestationService.verifyAttestation(
      tampered,
      keyPair.publicKey,
    );
    expect(valid).toBe(false);
  });

  it("retrieves attestation by ID", () => {
    const attestation = attestationService.createAttestation(
      "pcc.demand.v1",
      { test: true },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    const retrieved = attestationService.getAttestation(attestation.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(attestation.id);
  });

  it("queries attestations by schema", () => {
    attestationService.createAttestation(
      "pcc.demand.v1",
      { a: 1 },
      keyPair.privateKey,
      keyPair.publicKey,
    );
    attestationService.createAttestation(
      "pcc.result.v1",
      { b: 2 },
      keyPair.privateKey,
      keyPair.publicKey,
    );
    attestationService.createAttestation(
      "pcc.demand.v1",
      { c: 3 },
      keyPair.privateKey,
      keyPair.publicKey,
    );

    const demands =
      attestationService.getAttestationsBySchema("pcc.demand.v1");
    expect(demands).toHaveLength(2);

    const results =
      attestationService.getAttestationsBySchema("pcc.result.v1");
    expect(results).toHaveLength(1);
  });

  it("queries attestations by signer", () => {
    const otherKey = AttestationService.generateKeyPair();

    attestationService.createAttestation(
      "pcc.demand.v1",
      { a: 1 },
      keyPair.privateKey,
      keyPair.publicKey,
    );
    attestationService.createAttestation(
      "pcc.demand.v1",
      { b: 2 },
      otherKey.privateKey,
      otherKey.publicKey,
    );

    const mine = attestationService.getAttestationsBySigner(
      keyPair.publicKey,
    );
    expect(mine).toHaveLength(1);

    const theirs = attestationService.getAttestationsBySigner(
      otherKey.publicKey,
    );
    expect(theirs).toHaveLength(1);
  });
});
