import React from "react";
import { GlassPanel, EmptyState } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";

/**
 * Sponsor integration telemetry: what GET /api/status/integrations reports.
 *
 * The gateway reports configuration, not usage: for each integration whether
 * it is configured, its mode, network and addresses, and Lit's in-process
 * encrypt/decrypt counters (packages/gateway/src/routes/status.ts). It
 * stopped sending a status string and per-integration counters when its
 * invented counters were removed (gateway commit 9fd877e7), but this page
 * kept reading that old shape: a live response crashed it (`totalUploads` of
 * undefined), and a missing status fell through to "Mock". It now renders
 * only the fields the gateway returns. A field it didn't send reads "Not
 * reported"; a status it can't determine reads "Unknown".
 */

// ---------------------------------------------------------------------------
// Types: GET /api/status/integrations. Every field is optional because the
// page shows what arrived, not what it expects.
// ---------------------------------------------------------------------------

interface LitLiveStatus {
  connected?: boolean;
  mode?: string;
  network?: string;
  encryptCount?: number;
  decryptCount?: number;
  lastError?: string | null;
}

interface IntegrationsPayload {
  timestamp?: string;
  storacha?: { configured?: boolean; mode?: string; spaceId?: string | null };
  starknet?: { configured?: boolean; network?: string; contractAddress?: string | null };
  litProtocol?: { configured?: boolean; mode?: string; live?: LitLiveStatus };
  flow?: { configured?: boolean; chainId?: number; escrowAddress?: string | null };
  near?: { configured?: boolean; endpoint?: string };
  protocol?: { escrowAddress?: string | null; feeBps?: number; feeRecipient?: string };
}

const INTEGRATIONS = ["storacha", "starknet", "litProtocol", "flow", "near", "protocol"] as const;

type IntegrationStatus = "configured" | "not-configured" | "unknown";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOT_REPORTED = "Not reported";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The gateway's `configured` flag; anything but a boolean is unknown. */
function statusFrom(configured: unknown): IntegrationStatus {
  if (configured === true) return "configured";
  if (configured === false) return "not-configured";
  return "unknown";
}

/** The protocol entry has no `configured` flag: an escrow address means configured. */
function protocolStatus(p: unknown): IntegrationStatus {
  if (!isRecord(p) || !("escrowAddress" in p)) return "unknown";
  if (typeof p.escrowAddress === "string" && p.escrowAddress !== "") return "configured";
  if (p.escrowAddress === null) return "not-configured";
  return "unknown";
}

function integrationStatuses(data: IntegrationsPayload): IntegrationStatus[] {
  return [
    statusFrom(data.storacha?.configured),
    statusFrom(data.starknet?.configured),
    statusFrom(data.litProtocol?.configured),
    statusFrom(data.flow?.configured),
    statusFrom(data.near?.configured),
    protocolStatus(data.protocol),
  ];
}

function textOf(v: unknown): string {
  return typeof v === "string" && v.trim() !== "" ? v : NOT_REPORTED;
}

function truncateAddr(addr: string, chars = 6): string {
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`;
}

/** An address field: null means the gateway has none set; absent means it didn't say. */
function addressOf(v: unknown, chars = 6): string {
  if (typeof v === "string" && v !== "") return truncateAddr(v, chars);
  if (v === null) return "Not set";
  return NOT_REPORTED;
}

function labelOf(v: unknown, labels: Record<string, string>): string {
  if (typeof v !== "string" || v === "") return NOT_REPORTED;
  return Object.hasOwn(labels, v) ? labels[v]! : v;
}

function reportedTime(ts: unknown): string | null {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const STORAGE_BACKENDS: Record<string, string> = {
  storacha: "Storacha w3up",
  helia: "Helia (in-process IPFS)",
};

const LIT_MODES: Record<string, string> = {
  real: "Lit network",
  "local-aes": "Local AES-256-GCM",
};

const LIT_SERVICES: Record<string, string> = {
  "chipotle-api": "Lit Chipotle API",
  "local-aes": "Local AES-256-GCM",
  "mock-aes": "Local AES-256-GCM (mock service)",
};

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

const STATUS_BADGES: Record<IntegrationStatus, { label: string; cls: string; dot: string }> = {
  configured: {
    label: "Configured",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    dot: "bg-emerald-400",
  },
  "not-configured": {
    label: "Not configured",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    dot: "bg-amber-400",
  },
  unknown: {
    label: "Unknown",
    cls: "border-white/20 bg-white/[0.04] text-white/40",
    dot: "bg-white/20",
  },
};

function StatusBadge({ status }: { status: IntegrationStatus }) {
  // Anything unrecognised is Unknown: the badge never guesses a state.
  const { label, cls, dot } = STATUS_BADGES[status] ?? STATUS_BADGES.unknown;

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
// Integration cards
// ---------------------------------------------------------------------------

interface IntegrationCardProps {
  title: string;
  subtitle: string;
  status: IntegrationStatus;
  /** What "configured" means for this integration, from the gateway's own check. */
  note: string;
  link?: { href: string; label: string };
  children: React.ReactNode;
}

function IntegrationCard({ title, subtitle, status, note, link, children }: IntegrationCardProps) {
  return (
    <GlassPanel padding="lg" glow={status === "configured" ? "green" : undefined}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white/90 tracking-wide">{title}</h3>
            <p className="text-[11px] text-white/35 mt-0.5">{subtitle}</p>
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="space-y-2">{children}</div>

        <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">
          {note}
        </div>

        {link && <ExternalLink href={link.href} label={link.label} />}
      </div>
    </GlassPanel>
  );
}

function StorachaCard({ data }: { data: IntegrationsPayload["storacha"] }) {
  return (
    <IntegrationCard
      title="Storacha / Filecoin"
      subtitle="Decentralized evidence storage"
      status={statusFrom(data?.configured)}
      note="Configured means EVIDENCE_STORAGE=storacha with STORACHA_PROOF set."
    >
      <MetricRow label="Evidence Backend" value={labelOf(data?.mode, STORAGE_BACKENDS)} />
      {typeof data?.spaceId === "string" && data.spaceId !== "" && (
        <MetricRow label="Space" value={truncateAddr(data.spaceId, 8)} mono />
      )}
    </IntegrationCard>
  );
}

function StarknetCard({ data }: { data: IntegrationsPayload["starknet"] }) {
  const network = data?.network;
  const contract = typeof data?.contractAddress === "string" && data.contractAddress !== "" ? data.contractAddress : null;
  const explorerBase =
    network === "mainnet" ? "https://starkscan.co" : network === "sepolia" ? "https://sepolia.starkscan.co" : null;

  return (
    <IntegrationCard
      title="Starknet"
      subtitle="ZK proof anchoring"
      status={statusFrom(data?.configured)}
      note="Configured means STARKNET_ACCOUNT_ADDRESS is set."
      link={contract && explorerBase ? { href: `${explorerBase}/contract/${contract}`, label: "View contract on Starkscan" } : undefined}
    >
      <MetricRow label="Network" value={labelOf(network, { sepolia: "Sepolia testnet", mainnet: "Mainnet" })} />
      <MetricRow label="Contract" value={addressOf(data?.contractAddress)} mono />
    </IntegrationCard>
  );
}

function LitProtocolCard({ data }: { data: IntegrationsPayload["litProtocol"] }) {
  const liveRaw: unknown = data?.live;
  const live = isRecord(liveRaw) ? (liveRaw as LitLiveStatus) : undefined;
  const encrypted = typeof live?.encryptCount === "number" ? live.encryptCount : null;
  const decrypted = typeof live?.decryptCount === "number" ? live.decryptCount : null;

  return (
    <IntegrationCard
      title="Lit Protocol"
      subtitle="Threshold encryption + access control"
      status={statusFrom(data?.configured)}
      note="Configured means LIT_PROTOCOL_REAL=true. Counts are since the gateway process started."
      link={{ href: "https://developer.litprotocol.com/sdk/access-control/intro", label: "Lit Protocol Docs" }}
    >
      <MetricRow label="Requested Mode" value={labelOf(data?.mode, LIT_MODES)} />
      <MetricRow label="Running As" value={labelOf(live?.mode, LIT_SERVICES)} />
      <MetricRow label="Network" value={textOf(live?.network)} />
      <MetricRow
        label="Connected"
        value={typeof live?.connected === "boolean" ? (live.connected ? "Yes" : "No") : NOT_REPORTED}
      />
      <MetricRow
        label="Since Start"
        value={
          encrypted !== null && decrypted !== null
            ? `${encrypted.toLocaleString("en-US")} encrypted · ${decrypted.toLocaleString("en-US")} decrypted`
            : NOT_REPORTED
        }
        mono
      />
      {typeof live?.lastError === "string" && live.lastError !== "" && (
        <MetricRow label="Last Error" value={live.lastError} />
      )}
    </IntegrationCard>
  );
}

function FlowCard({ data }: { data: IntegrationsPayload["flow"] }) {
  return (
    <IntegrationCard
      title="Flow EVM"
      subtitle="EVM testnet escrow"
      status={statusFrom(data?.configured)}
      note="Configured means ESCROW_CONTRACT_ADDRESS is set: the same escrow the PCCProtocol card shows."
    >
      <MetricRow label="Chain ID" value={typeof data?.chainId === "number" ? String(data.chainId) : NOT_REPORTED} mono />
      <MetricRow label="Escrow Address" value={addressOf(data?.escrowAddress)} mono />
    </IntegrationCard>
  );
}

function NearCard({ data }: { data: IntegrationsPayload["near"] }) {
  return (
    <IntegrationCard
      title="NEAR Protocol"
      subtitle="Cross-chain payment intents"
      status={statusFrom(data?.configured)}
      note="The gateway reports NEAR as configured when it runs in production and NEAR_MOCK isn't true."
    >
      <MetricRow label="Solver Endpoint" value={textOf(data?.endpoint)} mono />
    </IntegrationCard>
  );
}

function ProtocolCard({ data }: { data: IntegrationsPayload["protocol"] }) {
  const feeBps = typeof data?.feeBps === "number" && Number.isFinite(data.feeBps) ? data.feeBps : null;

  return (
    <IntegrationCard
      title="PCCProtocol"
      subtitle="Root escrow + fee settlement"
      status={protocolStatus(data)}
      note="Configured means ESCROW_CONTRACT_ADDRESS is set. Fee and recipient are the gateway's configured values or its defaults."
    >
      <MetricRow
        label="Protocol Fee"
        value={feeBps !== null ? `${(feeBps / 100).toFixed(2)}% (${feeBps} bps)` : NOT_REPORTED}
      />
      <MetricRow
        label="Fee Recipient"
        value={typeof data?.feeRecipient === "string" && data.feeRecipient !== "" ? truncateAddr(data.feeRecipient) : NOT_REPORTED}
        mono
      />
      <MetricRow label="Escrow Address" value={addressOf(data?.escrowAddress)} mono />
    </IntegrationCard>
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

function LoadingSkeleton() {
  return (
    <>
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(6)].map((_, i) => <CardSkeleton key={i} />)}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Summary stat strip
// ---------------------------------------------------------------------------

function SummaryStats({ data }: { data: IntegrationsPayload }) {
  const statuses = integrationStatuses(data);
  const configuredCount = statuses.filter((s) => s === "configured").length;
  const unconfiguredCount = statuses.filter((s) => s === "not-configured").length;
  const unknownCount = statuses.filter((s) => s === "unknown").length;

  const cards = [
    { label: "Configured", value: configuredCount, sub: `of ${statuses.length} integrations`, glow: configuredCount > 0 },
    { label: "Not Configured", value: unconfiguredCount, sub: "per the gateway", glow: false },
    { label: "Not Reported", value: unknownCount, sub: "status unknown", glow: false },
    { label: "Reported At", value: reportedTime(data.timestamp) ?? "Unknown", sub: "by the gateway", glow: false },
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
      "Configuration of the 6 sponsor integrations, as the gateway reports it"
    );
  }, [setPageMeta]);

  const query = useQuery({
    queryKey: ["sponsors", "telemetry"],
    queryFn: () => apiGet<IntegrationsPayload>("/status/integrations"),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
  });

  const data = isRecord(query.data) ? (query.data as IntegrationsPayload) : undefined;
  const anyReported = data !== undefined && INTEGRATIONS.some((key) => isRecord(data[key]));
  const retry = () => void query.refetch();

  return (
    <div className="space-y-5">
      {/* Header / Controls row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-white/80">Sponsor Integration Telemetry</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Whether each hackathon sponsor integration is configured on this gateway: Storacha, Starknet,
            Lit Protocol, Flow EVM, NEAR and PCC Protocol
          </p>
        </div>
        <button
          onClick={retry}
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

      {/* A failed refresh keeps the last answer on screen, labelled with its time */}
      {data && query.isError && (
        <StaleNotice what="integration status" updatedAt={query.dataUpdatedAt} onRetry={retry} />
      )}

      {data ? (
        anyReported ? (
          <>
            <SummaryStats data={data} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <StorachaCard data={data.storacha} />
              <StarknetCard data={data.starknet} />
              <LitProtocolCard data={data.litProtocol} />
              <FlowCard data={data.flow} />
              <NearCard data={data.near} />
              <ProtocolCard data={data.protocol} />
            </div>
          </>
        ) : (
          <GlassPanel padding="lg">
            <EmptyState
              title="No integrations reported"
              description="The gateway answered, but its response named none of the six integrations."
            />
          </GlassPanel>
        )
      ) : query.isError ? (
        <GlassPanel padding="lg">
          <UnavailableState what="integration status" error={query.error} onRetry={retry} />
        </GlassPanel>
      ) : (
        <LoadingSkeleton />
      )}

      {/* Footer note */}
      <p className="text-[11px] text-white/20 text-center pb-2">
        Status sourced from{" "}
        <span className="font-mono text-white/30">/api/status/integrations</span>, refreshed every 15s. It
        reports configuration, not usage. Set{" "}
        <span className="font-mono text-white/30">EVIDENCE_STORAGE=storacha</span> with{" "}
        <span className="font-mono text-white/30">STORACHA_PROOF</span>,{" "}
        <span className="font-mono text-white/30">LIT_PROTOCOL_REAL=true</span>, or{" "}
        <span className="font-mono text-white/30">STARKNET_ACCOUNT_ADDRESS</span> to configure an integration.
      </p>
    </div>
  );
}
