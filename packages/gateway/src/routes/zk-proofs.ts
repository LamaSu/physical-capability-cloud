import type { FastifyInstance } from "fastify";
import type { EvidenceCommitment, SHA256, ZKProof } from "@pcc/spec";
import { commitmentService, zkProofService } from "../services.js";
import { BittensorSubnetBridge, StarknetProofAnchoringService } from "@pcc/verifier";
import { getRepos } from "../db.js";

// Singleton Bittensor subnet bridge
const subnetBridge = new BittensorSubnetBridge({
  numMinersToQuery: 5,
  minScoreThreshold: 0.6,
});

// Singleton Starknet proof anchoring service (mock mode unless env vars are set)
const starknetService = new StarknetProofAnchoringService({
  mock: process.env.STARKNET_ACCOUNT_ADDRESS === undefined,
  nodeUrl: process.env.STARKNET_NODE_URL,
  accountAddress: process.env.STARKNET_ACCOUNT_ADDRESS,
  privateKey: process.env.STARKNET_PRIVATE_KEY,
});

export async function zkProofRoutes(app: FastifyInstance) {
  // Create commitment for a bundle
  app.post<{ Body: { bundleHash: string } }>("/api/zk/commit", async (req) => {
    const { bundleHash } = req.body as { bundleHash: string };
    const commitment = await commitmentService.createCommitment(bundleHash as SHA256);
    getRepos().encryption.insertCommitment({
      id: commitment.id,
      bundleHash: commitment.bundleHash,
      commitmentHash: commitment.commitmentHash,
      commitmentTimestamp: commitment.commitmentTimestamp,
    });
    return { commitment };
  });

  // Build commitment tree from bundle hashes
  app.post<{ Body: { bundleHashes: string[] } }>("/api/zk/tree", async (req) => {
    const { bundleHashes } = req.body as { bundleHashes: string[] };
    const cmts = bundleHashes
      .map((h) => getRepos().encryption.findCommitmentByBundleHash(h))
      .filter((c): c is NonNullable<typeof c> => c !== undefined) as unknown as EvidenceCommitment[];

    if (cmts.length === 0) return { error: "no_commitments_found" };

    const tree = await commitmentService.buildTree(cmts);
    getRepos().encryption.insertTree({
      id: tree.id,
      root: tree.root,
      depth: tree.depth,
      leafCount: tree.leafCount,
      leaves: tree.leaves,
      createdAt: tree.createdAt,
    });
    return { tree };
  });

  // Generate inclusion proof
  app.post<{ Body: { treeId: string; leafIndex: number; bundleHash: string } }>(
    "/api/zk/prove/inclusion",
    async (req) => {
      const { treeId, leafIndex, bundleHash } = req.body as { treeId: string; leafIndex: number; bundleHash: string };
      const dbTree = getRepos().encryption.findTreeById(treeId);
      if (!dbTree) return { error: "tree_not_found" };

      // Cast DB row to CommitmentTree shape expected by zkProofService
      const tree = {
        id: dbTree.id,
        root: dbTree.root as SHA256,
        depth: dbTree.depth,
        leafCount: dbTree.leafCount,
        leaves: dbTree.leaves as SHA256[],
        createdAt: dbTree.createdAt,
      };

      const proof = await zkProofService.proveEvidenceInclusion(tree, leafIndex, bundleHash as SHA256);
      getRepos().encryption.insertProof({
        id: proof.id,
        proofType: proof.proofType,
        commitmentId: proof.commitmentId,
        publicInputs: proof.publicInputs,
        proof: proof.proof,
        verificationKey: proof.verificationKey,
        verified: proof.verified,
        generatedAt: proof.generatedAt,
      });
      return { proof };
    },
  );

  // Generate tier compliance proof
  app.post<{ Body: { bundleHash: string; requiredTier: number } }>(
    "/api/zk/prove/tier",
    async (req) => {
      const { bundleHash, requiredTier } = req.body as { bundleHash: string; requiredTier: number };
      let commitment = getRepos().encryption.findCommitmentByBundleHash(bundleHash);

      if (!commitment) {
        // Auto-create commitment
        const c = await commitmentService.createCommitment(bundleHash as SHA256);
        commitment = getRepos().encryption.insertCommitment({
          id: c.id,
          bundleHash: c.bundleHash,
          commitmentHash: c.commitmentHash,
          commitmentTimestamp: c.commitmentTimestamp,
        });
      }

      const cmt = commitment as unknown as EvidenceCommitment;
      const proof = await zkProofService.generateProof("tier_compliance", cmt, {
        requiredTier,
        bundleHash,
      });
      getRepos().encryption.insertProof({
        id: proof.id,
        proofType: proof.proofType,
        commitmentId: proof.commitmentId,
        publicInputs: proof.publicInputs,
        proof: proof.proof,
        verificationKey: proof.verificationKey,
        verified: proof.verified,
        generatedAt: proof.generatedAt,
      });
      return { proof };
    },
  );

  // Verify a proof
  app.post<{ Body: { proofId: string } }>("/api/zk/verify", async (req) => {
    const { proofId } = req.body as { proofId: string };
    const dbProof = getRepos().encryption.findProofById(proofId);
    if (!dbProof) return { error: "proof_not_found" };

    // Cast DB row to ZKProof shape for the service
    const proof: ZKProof = {
      id: dbProof.id,
      proofType: dbProof.proofType as ZKProof["proofType"],
      commitmentId: dbProof.commitmentId,
      publicInputs: dbProof.publicInputs,
      proof: dbProof.proof,
      verificationKey: dbProof.verificationKey,
      verified: dbProof.verified,
      generatedAt: dbProof.generatedAt,
    };

    const verified = await zkProofService.verifyProof(proof);
    // Save verification result back to DB
    getRepos().encryption.updateProofVerified(proofId, proof.verified);
    return { verified, proof };
  });

  // Get commitment for a bundle
  app.get<{ Params: { bundleId: string } }>("/api/zk/commitments/:bundleId", async (req) => {
    const commitment = getRepos().encryption.findCommitmentByBundleHash(req.params.bundleId);
    if (!commitment) return { error: "not_found" };
    return { commitment };
  });

  // ── Bittensor Verification Subnet Routes ────────────────────────────

  // Get subnet status and metrics
  app.get("/api/verification/subnet-status", async () => {
    const available = subnetBridge.isAvailable();
    const metrics = subnetBridge.getMetrics();
    const minerCount = subnetBridge.getMinerLeaderboard().length;

    return {
      available,
      metrics,
      minerCount,
      subnetId: 42,
      network: "mock-local",
    };
  });

  // Submit evidence for subnet verification
  app.post<{ Body: { bundleHash: string; bundleData: string; requiredTier: number } }>(
    "/api/verification/subnet-submit",
    async (req) => {
      const { bundleHash, bundleData, requiredTier } = req.body as {
        bundleHash: string;
        bundleData: string;
        requiredTier: number;
      };

      if (!subnetBridge.isAvailable()) {
        return { error: "subnet_unavailable", message: "Bittensor verification subnet is not available" };
      }

      try {
        const result = await subnetBridge.submitForVerification(bundleHash, bundleData, requiredTier);
        return { result };
      } catch (err) {
        return { error: "verification_failed", message: (err as Error).message };
      }
    },
  );

  // Get miner leaderboard
  app.get("/api/verification/miners", async () => {
    const miners = subnetBridge.getMinerLeaderboard();
    return { miners, count: miners.length };
  });

  // ── Starknet Proof Anchoring Routes ─────────────────────────────────

  // Anchor a proof on Starknet
  app.post<{ Body: { proofId?: string; merkleRoot?: string; treeDepth?: number } }>(
    "/api/zk/anchor-starknet",
    async (req) => {
      const body = req.body as { proofId?: string; merkleRoot?: string; treeDepth?: number };

      // Anchor a Merkle root directly
      if (body.merkleRoot) {
        const depth = body.treeDepth ?? 0;
        try {
          const anchor = await starknetService.anchorMerkleRoot(body.merkleRoot, depth);
          return { anchor, mode: starknetService.isMock() ? "mock" : "real" };
        } catch (err) {
          return { error: "anchor_failed", message: (err as Error).message };
        }
      }

      // Anchor an existing proof by ID
      if (!body.proofId) {
        return { error: "missing_params", message: "Provide proofId or merkleRoot" };
      }

      const dbProof = getRepos().encryption.findProofById(body.proofId);
      if (!dbProof) return { error: "proof_not_found" };

      const proof: ZKProof = {
        id: dbProof.id,
        proofType: dbProof.proofType as ZKProof["proofType"],
        commitmentId: dbProof.commitmentId,
        publicInputs: dbProof.publicInputs,
        proof: dbProof.proof,
        verificationKey: dbProof.verificationKey,
        verified: dbProof.verified,
        generatedAt: dbProof.generatedAt,
      };

      try {
        const anchor = await starknetService.anchorProof(proof);
        return { anchor, mode: starknetService.isMock() ? "mock" : "real" };
      } catch (err) {
        return { error: "anchor_failed", message: (err as Error).message };
      }
    },
  );

  // Get anchor status by tx hash
  app.get<{ Params: { txHash: string } }>(
    "/api/zk/anchor-starknet/:txHash",
    async (req) => {
      const { txHash } = req.params;

      try {
        const status = await starknetService.getAnchorStatus(txHash);
        const storedAnchor = starknetService.getStoredAnchor(txHash);
        return {
          txHash,
          status,
          anchor: storedAnchor ?? null,
          mode: starknetService.isMock() ? "mock" : "real",
        };
      } catch (err) {
        return { error: "status_fetch_failed", message: (err as Error).message };
      }
    },
  );
}
