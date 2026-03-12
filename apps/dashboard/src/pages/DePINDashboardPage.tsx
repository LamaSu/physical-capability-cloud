import React from "react";
import {
  GlassPanel,
  DataCell,
  AmountDisplay,
  TierBadge,
  DIDBadge,
  GlowBadge,
} from "@pcc/ui";
import type {
  CapabilityCertificate,
  RewardEpoch,
  DePINRewardClaim,
  TreasuryBalance,
} from "@pcc/spec";
import { useUIStore } from "../stores/ui-store";
import { useDePINStore } from "../stores/depin-store";

// ── Mock Data ───────────────────────────────────────────────────

const MOCK_TREASURY: TreasuryBalance = {
  agentId: "broker-agent-001",
  chain: "solana",
  balances: [
    { currency: "USDC", amount: "12450.00" },
    { currency: "SOL", amount: "84.25" },
  ],
  totalUsdValue: "24780.50",
  lastUpdated: new Date().toISOString(),
};

const MOCK_CERTIFICATES: CapabilityCertificate[] = [
  {
    id: "cnft_cert001",
    kernelDid: "did:pcc:kernel:kernel-sovereign-001",
    capabilityType: "fdm",
    assuranceTier: 2,
    metadata: { materials: ["PLA", "PETG"], maxBuildVolume: "250x210x210 mm" },
    mintedAt: "2026-03-01T10:00:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    leafIndex: 0,
    assetId: "Assetcnftcert001aaa",
  },
  {
    id: "cnft_cert002",
    kernelDid: "did:pcc:kernel:kernel-midwest-002",
    capabilityType: "cnc-3axis",
    assuranceTier: 3,
    metadata: { materials: ["Aluminum", "Steel"], toleranceSpecs: { xy: "+/-0.01mm" } },
    mintedAt: "2026-02-20T14:30:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    leafIndex: 1,
    assetId: "Assetcnftcert002bbb",
  },
  {
    id: "cnft_cert003",
    kernelDid: "did:pcc:kernel:kernel-east-003",
    capabilityType: "laser-cut",
    assuranceTier: 1,
    metadata: { materials: ["Acrylic", "MDF"] },
    mintedAt: "2026-01-15T08:00:00Z",
    soulbound: true,
    status: "revoked",
    merkleTree: "TreeCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    leafIndex: 2,
    assetId: "Assetcnftcert003ccc",
  },
];

const MOCK_EPOCHS: RewardEpoch[] = [
  {
    id: "epoch_e001",
    epochNumber: 42,
    startTime: "2026-03-01T00:00:00Z",
    endTime: "2026-03-07T23:59:59Z",
    totalRewards: "1000.000000",
    status: "completed",
    kernelScores: [
      {
        kernelId: "kernel-sovereign-001",
        kernelDid: "did:pcc:kernel:kernel-sovereign-001",
        jobsCompleted: 12,
        qualityScore: 0.95,
        uptimePercent: 99.2,
        capabilityDiversity: 2,
        scarcityBonus: 0.8,
        totalScore: 0.8515,
        rewardAmount: "520.123456",
      },
      {
        kernelId: "kernel-midwest-002",
        kernelDid: "did:pcc:kernel:kernel-midwest-002",
        jobsCompleted: 8,
        qualityScore: 0.88,
        uptimePercent: 97.5,
        capabilityDiversity: 1,
        scarcityBonus: 0.4,
        totalScore: 0.6342,
        rewardAmount: "387.654321",
      },
      {
        kernelId: "kernel-east-003",
        kernelDid: "did:pcc:kernel:kernel-east-003",
        jobsCompleted: 3,
        qualityScore: 0.72,
        uptimePercent: 85.0,
        capabilityDiversity: 1,
        scarcityBonus: 0.2,
        totalScore: 0.3930,
        rewardAmount: "92.222223",
      },
    ],
  },
  {
    id: "epoch_e002",
    epochNumber: 43,
    startTime: "2026-03-08T00:00:00Z",
    endTime: "2026-03-12T12:00:00Z",
    totalRewards: "1000.000000",
    status: "active",
    kernelScores: [],
  },
];

const MOCK_CLAIMS: DePINRewardClaim[] = [
  {
    id: "claim_c001",
    kernelId: "kernel-sovereign-001",
    epochId: "epoch_e001",
    amount: "520.123456",
    chain: "solana",
    status: "claimed",
    txHash: "5VERy...FaKe",
    claimedAt: "2026-03-08T02:15:00Z",
  },
  {
    id: "claim_c002",
    kernelId: "kernel-midwest-002",
    epochId: "epoch_e001",
    amount: "387.654321",
    chain: "solana",
    status: "pending",
  },
  {
    id: "claim_c003",
    kernelId: "kernel-east-003",
    epochId: "epoch_e001",
    amount: "92.222223",
    chain: "solana",
    status: "failed",
  },
];

// ── Helpers ─────────────────────────────────────────────────────

function certStatusColor(status: CapabilityCertificate["status"]): "green" | "red" | "gray" {
  if (status === "active") return "green";
  if (status === "revoked") return "red";
  return "gray";
}

function claimStatusColor(status: DePINRewardClaim["status"]): "green" | "gold" | "red" {
  if (status === "claimed") return "green";
  if (status === "pending") return "gold";
  return "red";
}

function epochStatusColor(status: RewardEpoch["status"]): "green" | "gold" | "gray" {
  if (status === "completed") return "green";
  if (status === "active") return "gold";
  return "gray";
}

// ── Component ───────────────────────────────────────────────────

export function DePINDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    certificates,
    epochs,
    claims,
    treasury,
    selectedEpochId,
    setCertificates,
    setEpochs,
    setClaims,
    setTreasury,
    selectEpoch,
  } = useDePINStore();

  React.useEffect(() => {
    setPageMeta("DePIN Economics", "Capability certificates, reward epochs, and treasury");
  }, [setPageMeta]);

  // Load mock data on mount
  React.useEffect(() => {
    setCertificates(MOCK_CERTIFICATES);
    setEpochs(MOCK_EPOCHS);
    setClaims(MOCK_CLAIMS);
    setTreasury(MOCK_TREASURY);
  }, [setCertificates, setEpochs, setClaims, setTreasury]);

  const selectedEpoch = epochs.find((e) => e.id === selectedEpochId);

  return (
    <div className="space-y-6">
      {/* Treasury Summary */}
      {treasury && (
        <div className="grid grid-cols-4 gap-4">
          {treasury.balances.map((b) => (
            <GlassPanel key={b.currency} padding="md">
              <DataCell
                label={`${b.currency} Balance`}
                value={<AmountDisplay amount={b.amount} currency={b.currency} size="md" />}
              />
            </GlassPanel>
          ))}
          <GlassPanel padding="md" glow="green">
            <DataCell
              label="Total USD Value"
              value={<AmountDisplay amount={treasury.totalUsdValue} currency="USD" size="md" />}
            />
          </GlassPanel>
          <GlassPanel padding="md">
            <DataCell
              label="Settlement Chain"
              value={treasury.chain.charAt(0).toUpperCase() + treasury.chain.slice(1)}
              sub={`Updated ${new Date(treasury.lastUpdated).toLocaleTimeString()}`}
              mono
            />
          </GlassPanel>
        </div>
      )}

      {/* Capability Certificates */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Capability Certificates (Soulbound cNFTs)
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {certificates.map((cert) => (
            <GlassPanel key={cert.id} padding="md" hover>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-white/40">{cert.id}</span>
                <GlowBadge color={certStatusColor(cert.status)}>{cert.status}</GlowBadge>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Capability</span>
                  <span className="text-sm font-medium text-white/80">{cert.capabilityType}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Tier</span>
                  <TierBadge tier={cert.assuranceTier as 0 | 1 | 2 | 3} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Kernel</span>
                  <DIDBadge did={cert.kernelDid} />
                </div>
                {cert.metadata.materials && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-white/40">Materials</span>
                    <span className="text-xs text-white/50">
                      {cert.metadata.materials.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Reward Epochs */}
        <div className="col-span-2 space-y-3">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            Reward Epochs
          </h3>
          {epochs.map((epoch) => (
            <GlassPanel
              key={epoch.id}
              padding="md"
              hover
              glow={epoch.id === selectedEpochId ? "green" : "none"}
              onClick={() => selectEpoch(epoch.id === selectedEpochId ? null : epoch.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/80">
                      Epoch #{epoch.epochNumber}
                    </span>
                    <GlowBadge color={epochStatusColor(epoch.status)}>{epoch.status}</GlowBadge>
                  </div>
                  <div className="text-xs text-white/30 mt-0.5">
                    {new Date(epoch.startTime).toLocaleDateString()} &mdash;{" "}
                    {new Date(epoch.endTime).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono text-emerald-400/80">
                    {parseFloat(epoch.totalRewards).toFixed(2)} PCC
                  </div>
                  <div className="text-xs text-white/30">
                    {epoch.kernelScores.length} kernels scored
                  </div>
                </div>
              </div>
            </GlassPanel>
          ))}

          {/* Selected epoch kernel scores */}
          {selectedEpoch && selectedEpoch.kernelScores.length > 0 && (
            <GlassPanel padding="md">
              <h4 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
                Epoch #{selectedEpoch.epochNumber} &mdash; Kernel Scores
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-white/40 border-b border-white/[0.06]">
                      <th className="text-left py-2 px-3 font-medium">Kernel</th>
                      <th className="text-right py-2 px-3 font-medium">Jobs</th>
                      <th className="text-right py-2 px-3 font-medium">Quality</th>
                      <th className="text-right py-2 px-3 font-medium">Uptime</th>
                      <th className="text-right py-2 px-3 font-medium">Score</th>
                      <th className="text-right py-2 px-3 font-medium">Reward</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEpoch.kernelScores.map((ks) => (
                      <tr
                        key={ks.kernelId}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="py-2.5 px-3 font-mono text-white/60 text-xs">
                          {ks.kernelId}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-white/70">
                          {ks.jobsCompleted}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-white/70">
                          {ks.qualityScore.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-white/70">
                          {ks.uptimePercent.toFixed(1)}%
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-medium text-emerald-400/80">
                          {ks.totalScore.toFixed(4)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-medium text-yellow-400/80">
                          {parseFloat(ks.rewardAmount).toFixed(2)} PCC
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassPanel>
          )}
        </div>

        {/* Recent Claims */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            Recent Claims
          </h3>
          {claims.map((claim) => (
            <GlassPanel key={claim.id} padding="md" hover>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-white/40">{claim.id}</span>
                <GlowBadge color={claimStatusColor(claim.status)}>{claim.status}</GlowBadge>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Kernel</span>
                  <span className="font-mono text-white/60">{claim.kernelId}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Amount</span>
                  <span className="font-mono text-emerald-400/80">
                    {parseFloat(claim.amount).toFixed(2)} PCC
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Chain</span>
                  <span className="text-white/50">{claim.chain}</span>
                </div>
                {claim.txHash && (
                  <div className="flex justify-between text-xs">
                    <span className="text-white/40">TX</span>
                    <span className="font-mono text-white/40">{claim.txHash}</span>
                  </div>
                )}
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>
    </div>
  );
}
