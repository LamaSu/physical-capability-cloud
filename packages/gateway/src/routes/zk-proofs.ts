import type { FastifyInstance } from "fastify";
import type { EvidenceCommitment, SHA256, ZKProof } from "@pcc/spec";
import { commitmentService, zkProofService } from "../services.js";
import { BittensorSubnetBridge } from "@pcc/verifier";

// Singleton Bittensor subnet bridge
const subnetBridge = new BittensorSubnetBridge({
  numMinersToQuery: 5,
  minScoreThreshold: 0.6,
});

// In-memory stores (production: database / on-chain)
const commitments = new Map<string, EvidenceCommitment>();
const trees = new Map<string, Awaited<ReturnType<typeof commitmentService.buildTree>>>();
const proofs = new Map<string, ZKProof>();

export async function zkProofRoutes(app: FastifyInstance) {
  // Create commitment for a bundle
  app.post<{ Body: { bundleHash: string } }>("/api/zk/commit", async (req) => {
    const { bundleHash } = req.body as { bundleHash: string };
    const commitment = await commitmentService.createCommitment(bundleHash as SHA256);
    commitments.set(bundleHash, commitment);
    return { commitment };
  });

  // Build commitment tree from bundle hashes
  app.post<{ Body: { bundleHashes: string[] } }>("/api/zk/tree", async (req) => {
    const { bundleHashes } = req.body as { bundleHashes: string[] };
    const cmts = bundleHashes
      .map((h) => commitments.get(h))
      .filter((c): c is EvidenceCommitment => c !== undefined);

    if (cmts.length === 0) return { error: "no_commitments_found" };

    const tree = await commitmentService.buildTree(cmts);
    trees.set(tree.id, tree);
    return { tree };
  });

  // Generate inclusion proof
  app.post<{ Body: { treeId: string; leafIndex: number; bundleHash: string } }>(
    "/api/zk/prove/inclusion",
    async (req) => {
      const { treeId, leafIndex, bundleHash } = req.body as { treeId: string; leafIndex: number; bundleHash: string };
      const tree = trees.get(treeId);
      if (!tree) return { error: "tree_not_found" };

      const proof = await zkProofService.proveEvidenceInclusion(tree, leafIndex, bundleHash as SHA256);
      proofs.set(proof.id, proof);
      return { proof };
    },
  );

  // Generate tier compliance proof
  app.post<{ Body: { bundleHash: string; requiredTier: number } }>(
    "/api/zk/prove/tier",
    async (req) => {
      const { bundleHash, requiredTier } = req.body as { bundleHash: string; requiredTier: number };
      const commitment = commitments.get(bundleHash);

      if (!commitment) {
        // Auto-create commitment
        const c = await commitmentService.createCommitment(bundleHash as SHA256);
        commitments.set(bundleHash, c);
      }

      const cmt = commitments.get(bundleHash)!;
      const proof = await zkProofService.generateProof("tier_compliance", cmt, {
        requiredTier,
        bundleHash,
      });
      proofs.set(proof.id, proof);
      return { proof };
    },
  );

  // Verify a proof
  app.post<{ Body: { proofId: string } }>("/api/zk/verify", async (req) => {
    const { proofId } = req.body as { proofId: string };
    const proof = proofs.get(proofId);
    if (!proof) return { error: "proof_not_found" };

    const verified = await zkProofService.verifyProof(proof);
    return { verified, proof };
  });

  // Get commitment for a bundle
  app.get<{ Params: { bundleId: string } }>("/api/zk/commitments/:bundleId", async (req) => {
    const commitment = commitments.get(req.params.bundleId);
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
}
