import type { FastifyInstance } from "fastify";
import type {
  CapabilityCertificate,
  RewardEpoch,
  KernelEpochScore,
  DePINRewardClaim,
  TreasuryBalance,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mock Data — DePIN Economics
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

// ── Mock Certificates ───────────────────────────────────────────

const mockCertificates: CapabilityCertificate[] = [
  {
    id: "cnft_biolab_fdm_001",
    kernelDid: "did:pcc:kernel:biolab-01",
    capabilityType: "fdm",
    assuranceTier: 2,
    metadata: {
      toleranceSpecs: { xy: "+/- 0.15mm", z: "+/- 0.10mm" },
      materials: ["PLA", "PETG", "ABS", "TPU"],
      calibrationProofCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      calibrationDate: "2026-02-15T10:00:00Z",
      maxBuildVolume: "250x210x210 mm",
    },
    mintedAt: "2026-02-16T08:00:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    leafIndex: 0,
    assetId: "AssetCnftBioLabFDM001",
  },
  {
    id: "cnft_metalshop_cnc_001",
    kernelDid: "did:pcc:kernel:metalshop-01",
    capabilityType: "cnc-3axis",
    assuranceTier: 3,
    metadata: {
      toleranceSpecs: { xy: "+/- 0.01mm", z: "+/- 0.005mm" },
      materials: ["aluminum-6061", "steel-304", "brass"],
      calibrationProofCid: "bafybeih5cid5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55kxlpde",
      calibrationDate: "2026-03-01T14:00:00Z",
    },
    mintedAt: "2026-03-02T09:00:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    leafIndex: 1,
    assetId: "AssetCnftMetalCNC001",
  },
  {
    id: "cnft_biolab_hplc_001",
    kernelDid: "did:pcc:kernel:biolab-01",
    capabilityType: "hplc",
    assuranceTier: 2,
    metadata: {
      materials: ["C18_reverse_phase"],
      calibrationProofCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55hplc1",
      calibrationDate: "2026-03-05T11:00:00Z",
    },
    mintedAt: "2026-03-06T08:00:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    leafIndex: 2,
    assetId: "AssetCnftBioLabHPLC001",
  },
];

// ── Mock Epochs ─────────────────────────────────────────────────

const mockKernelScores: KernelEpochScore[] = [
  {
    kernelId: "kernel-biolab-01",
    kernelDid: "did:pcc:kernel:biolab-01",
    jobsCompleted: 42,
    qualityScore: 0.95,
    uptimePercent: 99.2,
    capabilityDiversity: 4,
    scarcityBonus: 0.3,
    totalScore: 0.823,
    rewardAmount: "4115.000000",
  },
  {
    kernelId: "kernel-metalshop-01",
    kernelDid: "did:pcc:kernel:metalshop-01",
    jobsCompleted: 28,
    qualityScore: 0.98,
    uptimePercent: 97.5,
    capabilityDiversity: 2,
    scarcityBonus: 0.7,
    totalScore: 0.712,
    rewardAmount: "3560.000000",
  },
  {
    kernelId: "kernel-printfarm-01",
    kernelDid: "did:pcc:kernel:printfarm-01",
    jobsCompleted: 85,
    qualityScore: 0.87,
    uptimePercent: 94.1,
    capabilityDiversity: 1,
    scarcityBonus: 0.1,
    totalScore: 0.665,
    rewardAmount: "3325.000000",
  },
];

const mockEpochs: RewardEpoch[] = [
  {
    id: "epoch_completed_001",
    epochNumber: 1,
    startTime: "2026-02-01T00:00:00Z",
    endTime: "2026-02-28T23:59:59Z",
    totalRewards: "10000.000000",
    status: "completed",
    kernelScores: mockKernelScores,
  },
  {
    id: "epoch_active_002",
    epochNumber: 2,
    startTime: "2026-03-01T00:00:00Z",
    endTime: "2026-03-31T23:59:59Z",
    totalRewards: "12000.000000",
    status: "active",
    kernelScores: [],
  },
];

// ── Mock Claims ─────────────────────────────────────────────────

const mockClaims: DePINRewardClaim[] = [
  {
    id: "claim_biolab_ep1",
    kernelId: "kernel-biolab-01",
    epochId: "epoch_completed_001",
    amount: "4115.000000",
    chain: "solana",
    status: "claimed",
    txHash: "5xYz...mockTxHash",
    claimedAt: "2026-03-01T12:00:00Z",
  },
  {
    id: "claim_metalshop_ep1",
    kernelId: "kernel-metalshop-01",
    epochId: "epoch_completed_001",
    amount: "3560.000000",
    chain: "base",
    status: "pending",
  },
];

// ── Mock Treasury ───────────────────────────────────────────────

const mockTreasury: TreasuryBalance = {
  agentId: "broker-agent",
  chain: "base",
  balances: [
    { currency: "USDC", amount: "50000.00" },
    { currency: "ETH", amount: "10.5" },
  ],
  totalUsdValue: "85000.00",
  lastUpdated: now,
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function rewardRoutes(app: FastifyInstance) {
  // ── Epochs ────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string } }>(
    "/api/rewards/epochs",
    async (req) => {
      let epochs = [...mockEpochs];
      if (req.query.status) {
        epochs = epochs.filter((e) => e.status === req.query.status);
      }
      return { epochs, total: epochs.length };
    },
  );

  app.get<{ Params: { epochId: string } }>(
    "/api/rewards/epochs/:epochId",
    async (req, reply) => {
      const epoch = mockEpochs.find((e) => e.id === req.params.epochId);
      if (!epoch) {
        return reply.code(404).send({ error: "not_found", message: "Epoch not found" });
      }
      return { epoch };
    },
  );

  // ── Kernel Rewards ────────────────────────────────────────────

  app.get<{ Params: { kernelId: string } }>(
    "/api/rewards/kernels/:kernelId",
    async (req) => {
      const history: { epochId: string; epochNumber: number; score: number; reward: string }[] = [];
      for (const epoch of mockEpochs) {
        if (epoch.status !== "completed") continue;
        const score = epoch.kernelScores.find((s) => s.kernelId === req.params.kernelId);
        if (score) {
          history.push({
            epochId: epoch.id,
            epochNumber: epoch.epochNumber,
            score: score.totalScore,
            reward: score.rewardAmount,
          });
        }
      }
      return { kernelId: req.params.kernelId, history, totalEarned: history.reduce((s, h) => s + parseFloat(h.reward), 0).toFixed(6) };
    },
  );

  // ── Claims ────────────────────────────────────────────────────

  app.post("/api/rewards/claims", async (req, reply) => {
    const body = (req.body ?? {}) as { kernelId?: string; epochId?: string; amount?: string; chain?: string };
    if (!body.kernelId || !body.epochId || !body.amount) {
      return reply.code(400).send({ error: "bad_request", message: "kernelId, epochId, and amount are required" });
    }
    const id = `claim_${Date.now().toString(36)}`;
    return reply.code(201).send({
      created: true,
      claim: {
        id,
        kernelId: body.kernelId,
        epochId: body.epochId,
        amount: body.amount,
        chain: body.chain ?? "base",
        status: "pending",
      } satisfies DePINRewardClaim,
    });
  });

  app.get<{ Params: { claimId: string } }>(
    "/api/rewards/claims/:claimId",
    async (req, reply) => {
      const claim = mockClaims.find((c) => c.id === req.params.claimId);
      if (!claim) {
        return reply.code(404).send({ error: "not_found", message: "Claim not found" });
      }
      return { claim };
    },
  );

  // ── Certificates ──────────────────────────────────────────────

  app.get<{ Querystring: { kernelDid?: string; status?: string } }>(
    "/api/certificates",
    async (req) => {
      let certs = [...mockCertificates];
      if (req.query.kernelDid) {
        certs = certs.filter((c) => c.kernelDid === req.query.kernelDid);
      }
      if (req.query.status) {
        certs = certs.filter((c) => c.status === req.query.status);
      }
      return { certificates: certs, total: certs.length };
    },
  );

  app.get<{ Params: { certId: string } }>(
    "/api/certificates/:certId",
    async (req, reply) => {
      const cert = mockCertificates.find((c) => c.id === req.params.certId);
      if (!cert) {
        return reply.code(404).send({ error: "not_found", message: "Certificate not found" });
      }
      return { certificate: cert };
    },
  );

  app.post("/api/certificates/mint", async (req, reply) => {
    const body = (req.body ?? {}) as {
      kernelDid?: string;
      capabilityType?: string;
      assuranceTier?: number;
      metadata?: Record<string, unknown>;
    };
    if (!body.kernelDid || !body.capabilityType) {
      return reply.code(400).send({ error: "bad_request", message: "kernelDid and capabilityType are required" });
    }
    const id = `cnft_${Date.now().toString(36)}`;
    return reply.code(201).send({
      minted: true,
      certificate: {
        id,
        kernelDid: body.kernelDid,
        capabilityType: body.capabilityType,
        assuranceTier: body.assuranceTier ?? 1,
        metadata: body.metadata ?? {},
        mintedAt: now,
        soulbound: true,
        status: "active",
        merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        leafIndex: mockCertificates.length,
        assetId: `Asset${id}`,
      },
    });
  });

  // ── Treasury ──────────────────────────────────────────────────

  app.get("/api/treasury/summary", async () => {
    return {
      treasury: mockTreasury,
      proposals: [],
      proposalCount: 0,
      approvedTotal: "0.00",
    };
  });
}
