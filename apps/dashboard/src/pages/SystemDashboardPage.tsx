import React from "react";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "../stores/auth-store.js";

// ---------------------------------------------------------------------------
// Types — mirrors /api/telemetry/system response shape
// ---------------------------------------------------------------------------

type SponsorStatus = "active" | "mock" | "disabled" | "pending" | "not-deployed";

interface ChainInfo {
  name: string;
  contractAddress: string | null;
  status: "active" | "pending" | "unavailable";
  explorerUrl?: string;
}

interface SystemPayload {
  timestamp: string;

  // Row 1: Protocol Economics
  protocol: {
    feeBps: number;
    feeRecipient: string;
    totalFeesCollected: string;
  };
  escrow: {
    totalEscrows: number;
    totalVolume: string;
  };
  marketplace: {
    listingsCount: number;
    orderCount: number;
    categoryCount: number;
  };

  // Row 2: Infrastructure
  chains: ChainInfo[];
  operators: {
    registered: number;
    activeKernels: number;
    dhtPeers: number;
    capabilityAnnouncements: number;
  };
  gateway: {
    routeCount: number;
    testCount: number;
    version: string;
    uptimeSeconds: number;
  };

  // Row 3: Sovereign Data Stack
  evidence: {
    bundlesStored: number;
    bundlesEncrypted: number;
    ipfsUploads: number;
    zkProofsAnchored: number;
  };
  storage: {
    storageMode: "storacha" | "helia" | "mock";
    encryptionMode: "real" | "mock";
  };
  near: {
    quotes: number;
    intentsSubmitted: number;
    status: "active" | "mock";
  };

  // Row 4: Agent Layer
  agentPackage: {
    version: string;
    toolCount: number;
    lastUpdated: string | null;
  };
  a2a: {
    conversations: number;
    intentsProcessed: number;
    toolCalls: number;
  };
  jobs: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
  };

  // Sponsor statuses for bottom strip
  sponsors: {
    storacha: SponsorStatus;
    starknet: SponsorStatus;
    lit: SponsorStatus;
    flow: SponsorStatus;
    near: SponsorStatus;
  };
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchSystemTelemetry(): Promise<SystemPayload> {
  const res = await fetch("/api/telemetry/system", {
    headers: { ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SystemPayload>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateAddr(addr: string | null, chars = 6): string {
  if (!addr) return "—";
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Reusable display components
// ---------------------------------------------------------------------------

function MetricRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[11px] text-white/40 uppercase tracking-wider flex-shrink-0">
        {label}
      </span>
      <span
        className={`text-xs text-white/75 text-right truncate ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function BigNumber({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-2xl font-bold font-mono text-white/90 leading-none">{value}</div>
      <div className="text-[10px] text-white/35 uppercase tracking-wider">{label}</div>
    </div>
  );
}

type BadgeColor = "green" | "yellow" | "red" | "blue" | "white";

function Badge({
  color,
  children,
}: {
  color: BadgeColor;
  children: React.ReactNode;
}) {
  const styles: Record<BadgeColor, string> = {
    green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    yellow: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    red: "border-red-500/30 bg-red-500/[0.06] text-red-400/70",
    blue: "border-sky-500/40 bg-sky-500/10 text-sky-400",
    white: "border-white/20 bg-white/[0.04] text-white/40",
  };
  const dots: Record<BadgeColor, string> = {
    green: "bg-emerald-400",
    yellow: "bg-amber-400",
    red: "bg-red-400/60",
    blue: "bg-sky-400 animate-pulse",
    white: "bg-white/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wide ${styles[color]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dots[color]}`} />
      {children}
    </span>
  );
}

function JobBadge({
  count,
  label,
  color,
}: {
  count: number;
  label: string;
  color: BadgeColor;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[48px]">
      <Badge color={color}>{count}</Badge>
      <span className="text-[9px] text-white/30 uppercase tracking-wide">{label}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-3">
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Skeleton card
// ---------------------------------------------------------------------------

function CardSkeleton() {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4 animate-pulse">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="h-3.5 w-28 bg-white/[0.06] rounded" />
            <div className="h-2.5 w-18 bg-white/[0.04] rounded" />
          </div>
          <div className="h-6 w-12 bg-white/[0.05] rounded-full" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="h-5 w-10 bg-white/[0.04] rounded" />
              <div className="h-2.5 w-14 bg-white/[0.03] rounded" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
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
// Row 1: Protocol Economics
// ---------------------------------------------------------------------------

function ProtocolFeeCard({ data }: { data: SystemPayload }) {
  const feePct = (data.protocol.feeBps / 100).toFixed(2);
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Protocol Fee</h3>
            <p className="text-[11px] text-white/35 mt-0.5">On-chain settlement economics</p>
          </div>
          <Badge color="green">Live</Badge>
        </div>
        <div className="flex gap-4">
          <BigNumber value={`${feePct}%`} label="Fee Rate" />
          <BigNumber value={`$${data.protocol.totalFeesCollected}`} label="Collected" />
        </div>
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow
            label="Fee Recipient"
            value={truncateAddr(data.protocol.feeRecipient)}
            mono
          />
          <MetricRow label="Rate (bps)" value={`${data.protocol.feeBps} bps`} mono />
        </div>
      </div>
    </GlassPanel>
  );
}

function EscrowActivityCard({ data }: { data: SystemPayload }) {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Escrow Activity</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Milestone settlement contracts</p>
          </div>
          <Badge color="green">Base Sepolia</Badge>
        </div>
        <div className="flex gap-4">
          <BigNumber value={data.escrow.totalEscrows.toLocaleString()} label="Escrows" />
          <BigNumber value={`$${data.escrow.totalVolume}`} label="Volume" />
        </div>
        <div className="pt-1 border-t border-white/[0.06]">
          <MetricRow label="Contract Type" value="MilestoneEscrow" />
        </div>
      </div>
    </GlassPanel>
  );
}

function MarketplaceCard({ data }: { data: SystemPayload }) {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Marketplace</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Capability listings and orders</p>
          </div>
        </div>
        <div className="flex gap-4">
          <BigNumber value={data.marketplace.listingsCount.toLocaleString()} label="Listings" />
          <BigNumber value={data.marketplace.orderCount.toLocaleString()} label="Orders" />
          <BigNumber
            value={data.marketplace.categoryCount.toLocaleString()}
            label="Categories"
          />
        </div>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Row 2: Infrastructure
// ---------------------------------------------------------------------------

const CHAIN_EXPLORER: Record<string, string> = {
  "Base Sepolia": "https://sepolia.basescan.org",
  "Flow EVM": "https://evm-testnet.flowscan.io",
  Starknet: "https://sepolia.starkscan.co",
};

function MultiChainCard({ data }: { data: SystemPayload }) {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Multi-Chain</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Deployed contract infrastructure</p>
          </div>
          <Badge color="green">{data.chains.filter((c) => c.status === "active").length} Active</Badge>
        </div>
        <div className="space-y-2.5">
          {data.chains.map((chain) => {
            const explorer = chain.explorerUrl ?? CHAIN_EXPLORER[chain.name] ?? "#";
            const addrUrl = chain.contractAddress
              ? `${explorer}/address/${chain.contractAddress}`
              : explorer;
            return (
              <div
                key={chain.name}
                className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-lg bg-white/[0.02] border border-white/[0.04]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      chain.status === "active"
                        ? "bg-emerald-400"
                        : chain.status === "pending"
                          ? "bg-sky-400 animate-pulse"
                          : "bg-white/20"
                    }`}
                  />
                  <span className="text-xs text-white/70 font-medium">{chain.name}</span>
                  {chain.contractAddress && (
                    <a
                      href={addrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-teal-400/70 hover:text-teal-300 truncate transition-colors"
                    >
                      {truncateAddr(chain.contractAddress)}
                    </a>
                  )}
                </div>
                <Badge
                  color={
                    chain.status === "active"
                      ? "green"
                      : chain.status === "pending"
                        ? "blue"
                        : "white"
                  }
                >
                  {chain.status}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>
    </GlassPanel>
  );
}

function OperatorNetworkCard({ data }: { data: SystemPayload }) {
  const { operators } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Operator Network</h3>
            <p className="text-[11px] text-white/35 mt-0.5">DePIN infrastructure nodes</p>
          </div>
          <Badge color={operators.registered > 0 ? "green" : "white"}>
            {operators.registered} Ops
          </Badge>
        </div>
        <div className="flex gap-4">
          <BigNumber value={operators.registered} label="Operators" />
          <BigNumber value={operators.activeKernels} label="Kernels" />
          <BigNumber value={operators.dhtPeers} label="DHT Peers" />
        </div>
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow
            label="Capability Announcements"
            value={operators.capabilityAnnouncements.toLocaleString()}
            mono
          />
        </div>
      </div>
    </GlassPanel>
  );
}

function GatewayCard({ data }: { data: SystemPayload }) {
  const { gateway } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Gateway</h3>
            <p className="text-[11px] text-white/35 mt-0.5">HTTP API + SSE streams</p>
          </div>
          <Badge color="green">Online</Badge>
        </div>
        <div className="flex gap-4">
          <BigNumber value={gateway.routeCount} label="Routes" />
          <BigNumber value={gateway.testCount} label="Tests" />
        </div>
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow label="Version" value={gateway.version} mono />
          <MetricRow label="Uptime" value={formatUptime(gateway.uptimeSeconds)} />
        </div>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Row 3: Sovereign Data Stack
// ---------------------------------------------------------------------------

function EvidencePipelineCard({ data }: { data: SystemPayload }) {
  const { evidence } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Evidence Pipeline</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Hash-chained proof bundles</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <BigNumber value={evidence.bundlesStored.toLocaleString()} label="Stored" />
          <BigNumber value={evidence.bundlesEncrypted.toLocaleString()} label="Encrypted" />
          <BigNumber value={evidence.ipfsUploads.toLocaleString()} label="IPFS" />
          <BigNumber value={evidence.zkProofsAnchored.toLocaleString()} label="ZK Proofs" />
        </div>
      </div>
    </GlassPanel>
  );
}

function StorageCard({ data }: { data: SystemPayload }) {
  const { storage } = data;
  const storageModeColor =
    storage.storageMode === "storacha"
      ? "green"
      : storage.storageMode === "helia"
        ? "blue"
        : "yellow";
  const encryptModeColor = storage.encryptionMode === "real" ? "green" : "yellow";
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Storage</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Evidence storage + encryption</p>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-[10px] text-white/35 uppercase tracking-wider mb-1.5">
              Storage Backend
            </div>
            <Badge color={storageModeColor}>
              {storage.storageMode === "storacha"
                ? "Storacha w3up"
                : storage.storageMode === "helia"
                  ? "Helia IPFS"
                  : "Mock"}
            </Badge>
          </div>
          <div>
            <div className="text-[10px] text-white/35 uppercase tracking-wider mb-1.5">
              Encryption
            </div>
            <Badge color={encryptModeColor}>
              {storage.encryptionMode === "real"
                ? "Lit Protocol (real)"
                : "AES-256-GCM (mock)"}
            </Badge>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}

function NearIntentsCard({ data }: { data: SystemPayload }) {
  const { near } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">NEAR Intents</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Cross-chain payment routing</p>
          </div>
          <Badge color={near.status === "active" ? "green" : "yellow"}>
            {near.status}
          </Badge>
        </div>
        <div className="flex gap-4">
          <BigNumber value={near.quotes.toLocaleString()} label="Quotes" />
          <BigNumber value={near.intentsSubmitted.toLocaleString()} label="Intents" />
        </div>
        <div className="pt-1 border-t border-white/[0.06]">
          <MetricRow label="Solver" value="1Click (chaindefuser)" />
        </div>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Row 4: Agent Layer
// ---------------------------------------------------------------------------

function AgentPackageCard({ data }: { data: SystemPayload }) {
  const { agentPackage } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Agent Package</h3>
            <p className="text-[11px] text-white/35 mt-0.5">LLM-ready tool catalog</p>
          </div>
          <Badge color="green">Published</Badge>
        </div>
        <BigNumber value={agentPackage.toolCount} label="Tools" />
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow label="Version" value={agentPackage.version} mono />
          {agentPackage.lastUpdated && (
            <MetricRow
              label="Updated"
              value={new Date(agentPackage.lastUpdated).toLocaleDateString()}
            />
          )}
        </div>
      </div>
    </GlassPanel>
  );
}

function A2AActivityCard({ data }: { data: SystemPayload }) {
  const { a2a } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">A2A Activity</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Agent-to-agent message bus</p>
          </div>
        </div>
        <div className="flex gap-4">
          <BigNumber value={a2a.conversations.toLocaleString()} label="Convos" />
          <BigNumber value={a2a.intentsProcessed.toLocaleString()} label="Intents" />
          <BigNumber value={a2a.toolCalls.toLocaleString()} label="Tool Calls" />
        </div>
      </div>
    </GlassPanel>
  );
}

function JobsCard({ data }: { data: SystemPayload }) {
  const { jobs } = data;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white/85 tracking-wide">Jobs</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Pipeline execution state</p>
          </div>
          <Badge color={jobs.active > 0 ? "blue" : "white"}>{jobs.total} Total</Badge>
        </div>
        <div className="flex flex-wrap gap-2 justify-start">
          <JobBadge count={jobs.pending} label="Pending" color="yellow" />
          <JobBadge count={jobs.active} label="Active" color="blue" />
          <JobBadge count={jobs.completed} label="Done" color="green" />
          <JobBadge count={jobs.failed} label="Failed" color="red" />
        </div>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Sponsor status strip
// ---------------------------------------------------------------------------

const SPONSOR_LABELS: Record<keyof SystemPayload["sponsors"], string> = {
  storacha: "Storacha",
  starknet: "Starknet",
  lit: "Lit Protocol",
  flow: "Flow EVM",
  near: "NEAR",
};

const SPONSOR_LINKS: Record<keyof SystemPayload["sponsors"], string> = {
  storacha: "/sponsors",
  starknet: "/sponsors",
  lit: "/sponsors",
  flow: "/sponsors",
  near: "/sponsors",
};

function SponsorStatusStrip({ sponsors }: { data: SystemPayload; sponsors: SystemPayload["sponsors"] }) {
  const statusToColor = (s: SponsorStatus): BadgeColor => {
    if (s === "active") return "green";
    if (s === "mock") return "yellow";
    if (s === "pending") return "blue";
    return "white";
  };

  return (
    <GlassPanel padding="md">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span className="text-[10px] text-white/30 uppercase tracking-widest flex-shrink-0">
          Sponsor Integrations
        </span>
        {(Object.keys(sponsors) as Array<keyof SystemPayload["sponsors"]>).map((key) => (
          <a
            key={key}
            href={SPONSOR_LINKS[key]}
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <Badge color={statusToColor(sponsors[key])}>{SPONSOR_LABELS[key]}</Badge>
          </a>
        ))}
        <a
          href="/sponsors"
          className="ml-auto text-[10px] text-teal-400/60 hover:text-teal-300 transition-colors flex-shrink-0"
        >
          Details
          <span className="ml-1">→</span>
        </a>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Fallback placeholder data (shown when endpoint not available yet)
// ---------------------------------------------------------------------------

function makeFallbackData(): SystemPayload {
  return {
    timestamp: new Date().toISOString(),
    protocol: { feeBps: 150, feeRecipient: "0x0000000000000000000000000000000000000000", totalFeesCollected: "0.00" },
    escrow: { totalEscrows: 0, totalVolume: "0.00" },
    marketplace: { listingsCount: 0, orderCount: 0, categoryCount: 0 },
    chains: [
      { name: "Base Sepolia", contractAddress: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454", status: "active" },
      { name: "Flow EVM", contractAddress: null, status: "pending" },
      { name: "Starknet", contractAddress: null, status: "pending" },
    ],
    operators: { registered: 0, activeKernels: 0, dhtPeers: 0, capabilityAnnouncements: 0 },
    gateway: { routeCount: 347, testCount: 3300, version: "2.0.0", uptimeSeconds: 0 },
    evidence: { bundlesStored: 0, bundlesEncrypted: 0, ipfsUploads: 0, zkProofsAnchored: 0 },
    storage: { storageMode: "mock", encryptionMode: "mock" },
    near: { quotes: 0, intentsSubmitted: 0, status: "mock" },
    agentPackage: { version: "2.0.0", toolCount: 154, lastUpdated: null },
    a2a: { conversations: 0, intentsProcessed: 0, toolCalls: 0 },
    jobs: { total: 0, pending: 0, active: 0, completed: 0, failed: 0 },
    sponsors: {
      storacha: "mock",
      starknet: "not-deployed",
      lit: "disabled",
      flow: "pending",
      near: "mock",
    },
  };
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function SystemDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("System Dashboard", "Mission control — full operational overview at a glance");
  }, [setPageMeta]);

  const query = useQuery({
    queryKey: ["system", "dashboard"],
    queryFn: fetchSystemTelemetry,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
  });

  // Use actual data when available, fall back to placeholder data on error
  const data: SystemPayload = query.data ?? makeFallbackData();
  const isLoading = query.isLoading;
  const isError = query.isError;
  const usingFallback = !query.data;

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-white/80">System Dashboard</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Mission control — full operational overview of the PCC platform
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

      {/* Error / fallback banner */}
      {isError && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-400/80">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
          {`/api/telemetry/system not available — showing static defaults. The endpoint is still being deployed.`}
        </div>
      )}

      {/* ── Row 1: Protocol Economics ── */}
      <div>
        <SectionLabel>Protocol Economics</SectionLabel>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ProtocolFeeCard data={data} />
            <EscrowActivityCard data={data} />
            <MarketplaceCard data={data} />
          </div>
        )}
      </div>

      {/* ── Row 2: Infrastructure ── */}
      <div>
        <SectionLabel>Infrastructure</SectionLabel>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MultiChainCard data={data} />
            <OperatorNetworkCard data={data} />
            <GatewayCard data={data} />
          </div>
        )}
      </div>

      {/* ── Row 3: Sovereign Data Stack ── */}
      <div>
        <SectionLabel>Sovereign Data Stack</SectionLabel>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <EvidencePipelineCard data={data} />
            <StorageCard data={data} />
            <NearIntentsCard data={data} />
          </div>
        )}
      </div>

      {/* ── Row 4: Agent Layer ── */}
      <div>
        <SectionLabel>Agent Layer</SectionLabel>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <AgentPackageCard data={data} />
            <A2AActivityCard data={data} />
            <JobsCard data={data} />
          </div>
        )}
      </div>

      {/* ── Sponsor Status Strip ── */}
      {!isLoading && (
        <SponsorStatusStrip data={data} sponsors={data.sponsors} />
      )}

      {/* Footer */}
      <p className="text-[11px] text-white/20 text-center pb-2">
        Sourced from{" "}
        <span className="font-mono text-white/30">/api/telemetry/system</span>
        {usingFallback
          ? " — endpoint pending deployment, showing defaults"
          : ` — last updated ${new Date(data.timestamp).toLocaleTimeString()}`}
        {" "}· auto-refreshes every 15s
      </p>
    </div>
  );
}
