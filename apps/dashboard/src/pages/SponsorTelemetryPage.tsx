import React from "react";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "../stores/auth-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SponsorStatus = "active" | "mock" | "disabled" | "pending" | "not-deployed";

interface StorachaData {
  status: SponsorStatus;
  mode: "storacha" | "helia";
  totalUploads: number;
  totalCIDs: number;
  lastUploadAt: string | null;
  spaceId: string | null;
  details: string;
}

interface StarknetData {
  status: SponsorStatus;
  network: "sepolia" | "mainnet";
  totalAnchored: number;
  lastAnchorAt: string | null;
  contractAddress: string | null;
  details: string;
}

interface LitProtocolData {
  status: SponsorStatus;
  mode: "real" | "mock";
  network: "datil-test" | null;
  totalEncrypted: number;
  lastEncryptAt: string | null;
  details: string;
}

interface FlowData {
  status: "active" | "pending";
  chainId: number;
  rpcUrl: string;
  contracts: { milestoneEscrow: string | null; mockUSDC: string | null };
  explorerUrl: string;
  details: string;
}

interface NearData {
  status: "active" | "mock";
  network: "testnet";
  totalQuotes: number;
  totalIntents: number;
  lastIntentAt: string | null;
  oneClickEndpoint: string;
  details: string;
}

interface ProtocolData {
  status: "active" | "not-deployed";
  feeRecipient: string;
  feeBps: number;
  totalEscrows: number;
  totalFeesCollected: string;
  details: string;
}

interface SponsorsPayload {
  timestamp: string;
  storacha: StorachaData;
  starknet: StarknetData;
  litProtocol: LitProtocolData;
  flow: FlowData;
  near: NearData;
  protocol: ProtocolData;
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchSponsors(): Promise<SponsorsPayload> {
  const res = await fetch("/api/status/integrations", {
    headers: { ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SponsorsPayload>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(ts: string | null): string {
  if (!ts) return "Never";
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

function truncateAddr(addr: string | null, chars = 6): string {
  if (!addr) return "—";
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  status: SponsorStatus | "active" | "mock" | "pending" | "not-deployed";
}

function StatusBadge({ status }: StatusBadgeProps) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    active: {
      label: "Active",
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
      dot: "bg-emerald-400",
    },
    mock: {
      label: "Mock",
      cls: "border-amber-500/40 bg-amber-500/10 text-amber-400",
      dot: "bg-amber-400",
    },
    disabled: {
      label: "Disabled",
      cls: "border-red-500/30 bg-red-500/[0.06] text-red-400/70",
      dot: "bg-red-400/60",
    },
    pending: {
      label: "Pending",
      cls: "border-sky-500/40 bg-sky-500/10 text-sky-400",
      dot: "bg-sky-400 animate-pulse",
    },
    "not-deployed": {
      label: "Not Deployed",
      cls: "border-white/20 bg-white/[0.04] text-white/40",
      dot: "bg-white/20",
    },
  };

  const { label, cls, dot } = map[status] ?? map["mock"];

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold tracking-wide ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MetricRow — small label + value pair inside card
// ---------------------------------------------------------------------------

function MetricRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[11px] text-white/40 uppercase tracking-wider flex-shrink-0">{label}</span>
      <span className={`text-xs text-white/75 text-right truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExternalLink — small teal link
// ---------------------------------------------------------------------------

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[11px] text-teal-400/80 hover:text-teal-300 transition-colors"
    >
      {label}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 2H2a1 1 0 00-1 1v5a1 1 0 001 1h5a1 1 0 001-1V6M6 1h3v3M5 5L8.5 1.5" />
      </svg>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Individual sponsor cards
// ---------------------------------------------------------------------------

function StorachaCard({ data }: { data: StorachaData }) {
  const ipfsGateway = data.spaceId
    ? `https://w3s.link/`
    : "https://w3s.link/";

  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">Storacha / Filecoin</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Decentralized evidence storage</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow label="Evidence Bundles" value={data.totalUploads.toLocaleString()} mono />
          <MetricRow label="CIDs Generated" value={data.totalCIDs.toLocaleString()} mono />
          <MetricRow label="Backend" value={data.mode === "storacha" ? "Storacha w3up" : "Helia IPFS"} />
          <MetricRow label="Last Upload" value={formatTimeAgo(data.lastUploadAt)} />
          {data.spaceId && (
            <MetricRow label="Space" value={truncateAddr(data.spaceId, 8)} mono />
          )}
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink href={ipfsGateway} label="View on IPFS Gateway" />
      </div>
    </GlassPanel>
  );
}

function StarknetCard({ data }: { data: StarknetData }) {
  const explorerBase = data.network === "mainnet"
    ? "https://starkscan.co"
    : "https://sepolia.starkscan.co";
  const explorerUrl = data.contractAddress
    ? `${explorerBase}/contract/${data.contractAddress}`
    : explorerBase;

  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">Starknet</h3>
            <p className="text-[11px] text-white/35 mt-0.5">ZK proof anchoring</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow label="Proofs Anchored" value={data.totalAnchored.toLocaleString()} mono />
          <MetricRow label="Network" value={data.network === "sepolia" ? "Sepolia Testnet" : "Mainnet"} />
          <MetricRow label="Last Anchor" value={formatTimeAgo(data.lastAnchorAt)} />
          {data.contractAddress && (
            <MetricRow label="Contract" value={truncateAddr(data.contractAddress)} mono />
          )}
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink href={explorerUrl} label="View on Starknet Explorer" />
      </div>
    </GlassPanel>
  );
}

function LitProtocolCard({ data }: { data: LitProtocolData }) {
  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">Lit Protocol</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Threshold encryption + access control</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow label="Bundles Encrypted" value={data.totalEncrypted.toLocaleString()} mono />
          <MetricRow label="Access Conditions" value={data.totalEncrypted > 0 ? data.totalEncrypted.toLocaleString() : "—"} mono />
          <MetricRow label="Mode" value={data.mode === "real" ? "Threshold (datil-test)" : "AES-256-GCM (local)"} />
          <MetricRow label="Network" value={data.network ?? "none"} />
          <MetricRow label="Last Encrypt" value={formatTimeAgo(data.lastEncryptAt)} />
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink href="https://developer.litprotocol.com/sdk/access-control/intro" label="Lit Protocol Docs" />
      </div>
    </GlassPanel>
  );
}

function FlowCard({ data }: { data: FlowData }) {
  const flowscanUrl = data.contracts.milestoneEscrow
    ? `${data.explorerUrl}/address/${data.contracts.milestoneEscrow}`
    : data.explorerUrl;

  const contractsDeployed =
    Boolean(data.contracts.milestoneEscrow) || Boolean(data.contracts.mockUSDC);

  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">Flow EVM</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Chain ID {data.chainId} · EVM Testnet</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow label="Chain" value={`Flow EVM Testnet (${data.chainId})`} />
          <MetricRow
            label="Contracts Deployed"
            value={contractsDeployed ? (
              <span className="text-emerald-400 font-semibold">Yes</span>
            ) : (
              <span className="text-amber-400/80">No</span>
            )}
          />
          {data.contracts.milestoneEscrow && (
            <MetricRow label="MilestoneEscrow" value={truncateAddr(data.contracts.milestoneEscrow)} mono />
          )}
          {data.contracts.mockUSDC && (
            <MetricRow label="MockUSDC" value={truncateAddr(data.contracts.mockUSDC)} mono />
          )}
          <MetricRow label="RPC" value="testnet.evm.nodes.onflow.org" mono />
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink href={flowscanUrl} label="View on FlowScan" />
      </div>
    </GlassPanel>
  );
}

function NearCard({ data }: { data: NearData }) {
  const nearExplorer = "https://testnet.nearblocks.io";

  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">NEAR Protocol</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Cross-chain payment intents</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow label="Cross-chain Quotes" value={data.totalQuotes.toLocaleString()} mono />
          <MetricRow label="Intents Submitted" value={data.totalIntents.toLocaleString()} mono />
          <MetricRow label="Network" value={data.network} />
          <MetricRow label="Last Intent" value={formatTimeAgo(data.lastIntentAt)} />
          <MetricRow label="Solver" value="1Click (chaindefuser)" />
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink href={nearExplorer} label="View on NEAR Explorer" />
      </div>
    </GlassPanel>
  );
}

function ProtocolCard({ data }: { data: ProtocolData }) {
  return (
    <GlassPanel padding="lg" glow={data.status === "active" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">PCCProtocol</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Root escrow + fee settlement</p>
          </div>
          <StatusBadge status={data.status} />
        </div>

        <div className="space-y-2">
          <MetricRow
            label="Protocol Fee"
            value={`${(data.feeBps / 100).toFixed(2)}% (${data.feeBps} bps)`}
          />
          <MetricRow label="Fee Recipient" value={truncateAddr(data.feeRecipient)} mono />
          <MetricRow label="Total Escrows" value={data.totalEscrows.toLocaleString()} mono />
          <MetricRow label="Total Fees" value={`$${data.totalFeesCollected} USDC`} />
        </div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {data.details}
        </div>

        <ExternalLink
          href="https://sepolia.etherscan.io/address/0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454"
          label="View MilestoneEscrow on Etherscan"
        />
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder while loading
// ---------------------------------------------------------------------------

function CardSkeleton() {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4 animate-pulse">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="h-3.5 w-32 bg-white/[0.06] rounded" />
            <div className="h-2.5 w-20 bg-white/[0.04] rounded" />
          </div>
          <div className="h-6 w-14 bg-white/[0.05] rounded-full" />
        </div>
        <div className="space-y-2.5">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex justify-between">
              <div className="h-2.5 w-16 bg-white/[0.04] rounded" />
              <div className="h-2.5 w-12 bg-white/[0.03] rounded" />
            </div>
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Summary stat strip
// ---------------------------------------------------------------------------

interface SummaryStatsProps {
  data: SponsorsPayload;
}

function SummaryStats({ data }: SummaryStatsProps) {
  const sponsors = [
    data.storacha.status,
    data.starknet.status,
    data.litProtocol.status,
    data.flow.status,
    data.near.status,
    data.protocol.status,
  ];

  const activeCount = sponsors.filter((s) => s === "active").length;
  const mockCount = sponsors.filter((s) => s === "mock").length;
  const pendingCount = sponsors.filter(
    (s) => s === "pending" || s === "not-deployed" || s === "disabled"
  ).length;

  const cards = [
    { label: "Active Integrations", value: activeCount, sub: "of 6 sponsors", glow: activeCount > 0 },
    { label: "Mock Mode", value: mockCount, sub: "simulated APIs", glow: false },
    { label: "Pending", value: pendingCount, sub: "not yet deployed", glow: false },
    {
      label: "Last Refreshed",
      value: new Date(data.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      sub: "live data",
      glow: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <GlassPanel key={c.label} glow={c.glow ? "green" : undefined} padding="md">
          <div className="space-y-1">
            <div className="text-[10px] text-white/40 uppercase tracking-wider">{c.label}</div>
            <div className="text-xl font-bold font-mono text-white/90">{c.value}</div>
            <div className="text-xs text-white/30">{c.sub}</div>
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function SponsorTelemetryPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta(
      "Sponsor Integration Telemetry",
      "Live status and metrics for all 6 sponsor integrations"
    );
  }, [setPageMeta]);

  const query = useQuery({
    queryKey: ["sponsors", "telemetry"],
    queryFn: fetchSponsors,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
  });

  const data = query.data;
  const isLoading = query.isLoading;
  const isError = query.isError;

  return (
    <div className="space-y-5">
      {/* Header / Controls row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-white/80">Sponsor Integration Telemetry</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Hackathon sponsor integrations — live status for Storacha, Starknet, Lit Protocol, Flow EVM, NEAR, and PCC Protocol
          </p>
        </div>
        <button
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] text-xs text-white/50 hover:text-white/80 hover:bg-white/[0.07] hover:border-white/[0.15] transition-all disabled:opacity-40"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={query.isFetching ? "animate-spin" : ""}
          >
            <path d="M10 6A4 4 0 112 6M10 6V3M10 6H7" />
          </svg>
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Error banner */}
      {isError && !data && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/[0.06] border border-red-500/20 text-xs text-red-400/80">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400/60" />
          Failed to fetch sponsor telemetry — gateway may be offline
        </div>
      )}

      {/* Summary stats */}
      {data ? (
        <SummaryStats data={data} />
      ) : isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <GlassPanel key={i} padding="md">
              <div className="animate-pulse space-y-1">
                <div className="h-2.5 w-20 bg-white/[0.05] rounded" />
                <div className="h-6 w-10 bg-white/[0.04] rounded" />
                <div className="h-2 w-16 bg-white/[0.03] rounded" />
              </div>
            </GlassPanel>
          ))}
        </div>
      ) : null}

      {/* Sponsor cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          [...Array(6)].map((_, i) => <CardSkeleton key={i} />)
        ) : data ? (
          <>
            <StorachaCard data={data.storacha} />
            <StarknetCard data={data.starknet} />
            <LitProtocolCard data={data.litProtocol} />
            <FlowCard data={data.flow} />
            <NearCard data={data.near} />
            <ProtocolCard data={data.protocol} />
          </>
        ) : (
          // Show skeleton cards even on error (data = undefined but no longer loading)
          [...Array(6)].map((_, i) => <CardSkeleton key={i} />)
        )}
      </div>

      {/* Footer note */}
      <p className="text-[11px] text-white/20 text-center pb-2">
        Status sourced from{" "}
        <span className="font-mono text-white/30">/api/status/integrations</span> — refreshes every 15s.
        Set <span className="font-mono text-white/30">EVIDENCE_STORAGE=storacha</span>,{" "}
        <span className="font-mono text-white/30">LIT_PROTOCOL_REAL=true</span>, or{" "}
        <span className="font-mono text-white/30">STARKNET_ACCOUNT_ADDRESS</span> to switch from mock to live.
      </p>
    </div>
  );
}
