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
} from "@pcc/spec";
import { useUIStore } from "../stores/ui-store";
import { useDePINStore } from "../stores/depin-store";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import {
  DEMO_TREASURY,
  DEMO_CERTIFICATES,
  DEMO_REWARD_EPOCHS,
  DEMO_REWARD_CLAIMS,
} from "../demo/DePINDashboardPage.fixtures.js";

/**
 * DePIN Economics: treasury, capability certificates, reward epochs, claims.
 *
 * Not live. No gateway route serves real DePIN state: GET /api/treasury/summary,
 * GET /api/certificates and GET /api/rewards/epochs return records written as
 * literals in packages/gateway/src/routes/rewards.ts, and no route lists reward
 * claims. This page used to load its own sample treasury, certificates, epochs
 * and claims on every visit and show them as the network's. Outside demo mode
 * it now says what is missing and requests nothing. In demo mode
 * (lib/demo-mode.ts) the prototype renders sample values under a DemoBanner.
 */

const NOT_LIVE_DETAIL =
  "The gateway's DePIN routes (GET /api/treasury/summary, /api/certificates and /api/rewards/epochs) " +
  "return fixed sample records, not network state, and no route lists reward claims.";

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

  React.useEffect(() => {
    setPageMeta("DePIN Economics", "Capability certificates, reward epochs, and treasury");
  }, [setPageMeta]);

  if (!isDemoMode()) {
    return (
      <GlassPanel padding="lg">
        <NotLiveState what="DePIN economics" detail={NOT_LIVE_DETAIL} hasDemo />
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-6">
      <DemoBanner what="DePIN Economics" />
      <DePINPrototype />
    </div>
  );
}

/** The prototype, rendered only in demo mode, over the sample values in demo/. */
function DePINPrototype() {
  const { selectedEpochId, selectEpoch } = useDePINStore();
  const treasury = DEMO_TREASURY;
  const certificates = DEMO_CERTIFICATES;
  const epochs = DEMO_REWARD_EPOCHS;
  const claims = DEMO_REWARD_CLAIMS;

  const selectedEpoch = epochs.find((e) => e.id === selectedEpochId);

  return (
    <>
      {/* Treasury Summary */}
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
    </>
  );
}
