/**
 * System Dashboard: what the gateway reports about its own state, read from
 * GET /api/telemetry/system (packages/gateway/src/routes/status.ts).
 *
 * That route returns raw lists and a few settings: the kernel registry, the
 * job facade's first page of jobs, evidence bundles, machine registrations,
 * capability records, the in-process agent bus's conversations and recent
 * messages, recent audit entries, some environment variables and the process
 * uptime. This page used to expect another shape (protocol fees, escrow
 * volume, chain deployments, DHT peers, route and test counts, IPFS and ZK
 * totals, NEAR intents, sponsor statuses). A live answer crashed it
 * (`protocol` of undefined), and a failed read showed built-in defaults as the
 * platform's state: "347 routes", "3300 tests", a 1.50% fee, 154 agent tools
 * and a Base Sepolia contract.
 *
 * It now shows only what the route returns, as counts over those lists:
 *   - jobs: the route passes on the facade's first 50 jobs without a total, so
 *     a full page is shown as a lower bound ("50+");
 *   - an empty list reads "the report lists no ...": the route also sends an
 *     empty list when its database read fails, and no conversations when the
 *     agent bus isn't running;
 *   - devices are not shown: kernel list entries carry no devices, so the
 *     route's device list is always empty;
 *   - audit entries are not shown: they carry client IPs and no timestamps.
 * What the route doesn't report is marked not live. A failed read shows as
 * unavailable, or as stale over earlier data. In demo mode (lib/demo-mode.ts)
 * the prototype renders sample values under a DemoBanner.
 */

import React from "react";
import { GlassPanel } from "@pcc/ui";
import { useQuery } from "@tanstack/react-query";
import { useUIStore } from "../stores/ui-store.js";
import { apiGet } from "../lib/api.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { formatCount, isActiveJob, isKernelOnline, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-status.js";
import type { JobDTO, KernelDTO } from "../types/dto.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { demoSystemTelemetry } from "../demo/SystemDashboardPage.fixtures.js";

// ---------------------------------------------------------------------------
// Prototype types: the shape the demo cards were drawn for. /api/telemetry/system
// does not return it; only the demo fixtures (src/demo/) use it.
// ---------------------------------------------------------------------------

export type SponsorStatus = "active" | "mock" | "disabled" | "pending" | "not-deployed";

export interface ChainInfo {
  name: string;
  contractAddress: string | null;
  status: "active" | "pending" | "unavailable";
  explorerUrl?: string;
}

export interface PrototypeSystemPayload {
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
// Live report: GET /api/telemetry/system
// ---------------------------------------------------------------------------

/**
 * What the route returns (routes/status.ts). Only `db` is required: a body
 * without it is not a system report. Everything else is read defensively.
 */
interface SystemReport {
  timestamp?: unknown;
  uptime_seconds?: unknown;
  response_ms?: unknown;
  db: {
    kernels?: unknown;
    jobs?: unknown;
    evidence?: unknown;
    registrations?: unknown;
    capabilities?: unknown;
  };
  agents?: unknown;
  env?: unknown;
}

/** The route asks the agent bus for at most this many recent messages (routes/status.ts). */
const RECENT_MESSAGES_LIMIT = 100;

/** The environment variables the route reports, in display order. */
const ENV_KEYS = [
  "PCC_NETWORK",
  "NODE_ENV",
  "EVIDENCE_STORAGE",
  "STORACHA_SPACE_DID",
  "LIT_PROTOCOL_REAL",
  "STARKNET_ACCOUNT_ADDRESS",
  "ESCROW_CONTRACT_ADDRESS",
] as const;

const NOT_REPORTED = "Not reported";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function fetchSystemReport(): Promise<SystemReport> {
  const body = await apiGet<unknown>("/telemetry/system");
  if (!isRecord(body) || !isRecord(body.db)) {
    throw new Error("The gateway's answer wasn't a system report.");
  }
  return body as unknown as SystemReport;
}

/** The list the report sent, or null when it sent none. */
function listOf(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** A non-empty string field of a list entry. */
function textField(row: unknown, key: string): string | undefined {
  if (!isRecord(row)) return undefined;
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** How many entries carry each value of `key`, most common first; entries without one count as "unknown". */
function countBy(rows: unknown[], key: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = textField(row, key) ?? "unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The number of distinct non-empty values of `key`. */
function distinct(rows: unknown[], key: string): number {
  return new Set(rows.map((row) => textField(row, key)).filter((v) => v !== undefined)).size;
}

/** The latest valid time among the entries' `key`, or null. */
function latestTime(rows: unknown[], key: string): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    const text = textField(row, key);
    if (!text) continue;
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) continue;
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

function reportedTime(ts: unknown): string | null {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString();
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An environment value as reported: null means unset; a missing key means the route didn't say. */
function envValue(env: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return NOT_REPORTED;
  const v = env[key];
  if (v === null) return "Not set";
  if (typeof v !== "string" || v === "") return NOT_REPORTED;
  // The route reports only whether the Starknet account is set, not the address.
  if (key === "STARKNET_ACCOUNT_ADDRESS" && v === "set") return "Set";
  return v.length > 24 ? truncateAddr(v) : v;
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
  count: React.ReactNode;
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

function RefreshButton({ onClick, fetching }: { onClick: () => void; fetching: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={fetching}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] text-xs text-white/50 hover:text-white/80 hover:bg-white/[0.07] hover:border-white/[0.15] transition-all disabled:opacity-40"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={fetching ? "animate-spin" : ""}
      >
        <path d="M10 6A4 4 0 112 6M10 6V3M10 6H7" />
      </svg>
      {fetching ? "Refreshing…" : "Refresh"}
    </button>
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
// Live cards: counts over the lists /api/telemetry/system returns
// ---------------------------------------------------------------------------

function LiveCard({
  title,
  subtitle,
  note,
  children,
}: {
  title: string;
  subtitle: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold text-white/85 tracking-wide">{title}</h3>
          <p className="text-[11px] text-white/35 mt-0.5">{subtitle}</p>
        </div>
        {children}
        {note && (
          <div className="pt-1 border-t border-white/[0.06] text-[10px] text-white/25 leading-relaxed">{note}</div>
        )}
      </div>
    </GlassPanel>
  );
}

/** A list the report sent empty. The route also sends empty lists when its read failed, so this says only what the report lists. */
function ListsNone({ what }: { what: string }) {
  return (
    <p data-live-state="empty" className="text-xs text-white/45 leading-relaxed">
      The report lists no {what}.
    </p>
  );
}

/** A section the report left out: not zero, not empty. */
function NotInReport({ what }: { what: string }) {
  return <p className="text-xs text-white/45 leading-relaxed">The report didn't include {what}.</p>;
}

function KernelsCard({ kernels }: { kernels: unknown[] | null }) {
  let body: React.ReactNode;
  if (kernels === null) {
    body = <NotInReport what="the kernel list" />;
  } else if (kernels.length === 0) {
    body = <ListsNone what="kernels" />;
  } else {
    const online = kernels.filter(
      (k) => isRecord(k) && isKernelOnline({ status: k.status as KernelDTO["status"], isStale: k.isStale === true }),
    ).length;
    const stale = kernels.filter((k) => isRecord(k) && k.status === "online" && k.isStale === true).length;
    const otherStatuses = countBy(
      kernels.filter((k) => textField(k, "status") !== "online"),
      "status",
    );
    body = (
      <>
        <div className="flex gap-4">
          <BigNumber value={kernels.length} label="Registered" />
          <BigNumber value={online} label="Online" />
          <BigNumber value={distinct(kernels, "operatorAddress")} label="Operators" />
        </div>
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow label="Online, Stale Heartbeat" value={stale} mono />
          <MetricRow
            label="Other Statuses"
            value={otherStatuses.length > 0 ? otherStatuses.map(([s, n]) => `${s} ${n}`).join(" · ") : "None"}
          />
        </div>
      </>
    );
  }
  return (
    <LiveCard
      title="Kernels"
      subtitle="Sites in the kernel registry"
      note="Online means status online with a fresh heartbeat. Operators are distinct operator addresses."
    >
      {body}
    </LiveCard>
  );
}

function JobsCard({ jobs }: { jobs: unknown[] | null }) {
  let body: React.ReactNode;
  let note = "Active means pending, queued, in progress or paused.";
  if (jobs === null) {
    body = <NotInReport what="the job list" />;
  } else if (jobs.length === 0) {
    body = <ListsNone what="jobs" />;
  } else {
    const atLeast = mayBeTruncated(jobs);
    const statusOf = (j: unknown) => textField(j, "status") ?? "";
    const active = jobs.filter((j) => isActiveJob({ status: statusOf(j) as JobDTO["status"] })).length;
    const completed = jobs.filter((j) => statusOf(j) === "completed").length;
    const failed = jobs.filter((j) => statusOf(j) === "failed").length;
    const cancelled = jobs.filter((j) => statusOf(j) === "cancelled").length;
    const other = jobs.length - active - completed - failed - cancelled;
    if (atLeast) {
      note = `The report includes only the gateway's first ${JOBS_PAGE_SIZE} jobs, so these counts are lower bounds. ${note}`;
    }
    body = (
      <>
        <BigNumber value={formatCount(jobs.length, atLeast)} label="Jobs" />
        <div className="flex flex-wrap gap-2 justify-start">
          <JobBadge count={formatCount(active, atLeast)} label="Active" color="blue" />
          <JobBadge count={formatCount(completed, atLeast)} label="Done" color="green" />
          <JobBadge count={formatCount(failed, atLeast)} label="Failed" color="red" />
          <JobBadge count={formatCount(cancelled, atLeast)} label="Cancelled" color="white" />
          {other > 0 && <JobBadge count={formatCount(other, atLeast)} label="Other" color="white" />}
        </div>
      </>
    );
  }
  return (
    <LiveCard title="Jobs" subtitle="Execution state" note={note}>
      {body}
    </LiveCard>
  );
}

function GatewayReportCard({ report }: { report: SystemReport }) {
  const uptime = finiteNumber(report.uptime_seconds);
  const took = finiteNumber(report.response_ms);
  return (
    <LiveCard title="Gateway" subtitle="The process that answered this report">
      <div className="flex gap-4">
        <BigNumber value={uptime !== null && uptime >= 0 ? formatUptime(uptime) : "—"} label="Uptime" />
        <BigNumber value={took !== null ? `${took} ms` : "—"} label="Report Took" />
      </div>
      <div className="space-y-2 pt-1 border-t border-white/[0.06]">
        <MetricRow label="Reported At" value={reportedTime(report.timestamp) ?? NOT_REPORTED} />
      </div>
    </LiveCard>
  );
}

function CapabilitiesCard({ capabilities }: { capabilities: unknown[] | null }) {
  let body: React.ReactNode;
  if (capabilities === null) {
    body = <NotInReport what="the capability list" />;
  } else if (capabilities.length === 0) {
    body = <ListsNone what="capabilities" />;
  } else {
    body = (
      <div className="flex gap-4">
        <BigNumber value={capabilities.length} label="Records" />
        <BigNumber value={distinct(capabilities, "type")} label="Types" />
        <BigNumber value={distinct(capabilities, "kernelId")} label="Kernels" />
      </div>
    );
  }
  return (
    <LiveCard
      title="Capabilities"
      subtitle="Capability records"
      note="Every capability row, including ones the catalog hides after their kernel's heartbeat expired."
    >
      {body}
    </LiveCard>
  );
}

function RegistrationsCard({ registrations }: { registrations: unknown[] | null }) {
  let body: React.ReactNode;
  if (registrations === null) {
    body = <NotInReport what="the registration list" />;
  } else if (registrations.length === 0) {
    body = <ListsNone what="machine registrations" />;
  } else {
    body = (
      <>
        <BigNumber value={registrations.length} label="Registrations" />
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          {countBy(registrations, "status").map(([status, n]) => (
            <MetricRow key={status} label={status} value={n} mono />
          ))}
        </div>
      </>
    );
  }
  return (
    <LiveCard title="Machine Registrations" subtitle="Onboarding submissions, by status">
      {body}
    </LiveCard>
  );
}

function EvidenceCard({ evidence }: { evidence: unknown[] | null }) {
  let body: React.ReactNode;
  if (evidence === null) {
    body = <NotInReport what="the evidence list" />;
  } else if (evidence.length === 0) {
    body = <ListsNone what="evidence bundles" />;
  } else {
    const byTier = new Map<string, number>();
    for (const bundle of evidence) {
      const tier = isRecord(bundle) ? bundle.assuranceTier : undefined;
      const label = typeof tier === "number" && Number.isInteger(tier) ? `Tier ${tier}` : "Tier unknown";
      byTier.set(label, (byTier.get(label) ?? 0) + 1);
    }
    const latest = latestTime(evidence, "createdAt");
    body = (
      <>
        <BigNumber value={evidence.length} label="Bundles" />
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          {[...byTier.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([tier, n]) => (
              <MetricRow key={tier} label={tier} value={n} mono />
            ))}
          <MetricRow label="Latest" value={latest ? latest.toLocaleString() : NOT_REPORTED} />
        </div>
      </>
    );
  }
  return (
    <LiveCard title="Evidence" subtitle="Evidence bundles, by assurance tier">
      {body}
    </LiveCard>
  );
}

function AgentBusCard({ agents }: { agents: unknown }) {
  const conversations = isRecord(agents) ? listOf(agents.conversations) : null;
  const messages = isRecord(agents) ? listOf(agents.recentMessages) : null;
  let body: React.ReactNode;
  if (conversations === null && messages === null) {
    body = <NotInReport what="agent activity" />;
  } else if (conversations?.length === 0 && messages?.length === 0) {
    // Both lists present and empty. A missing list is not an empty one: it renders "—" below.
    body = <ListsNone what="agent conversations" />;
  } else {
    const latest = messages ? latestTime(messages, "timestamp") : null;
    body = (
      <>
        <div className="flex gap-4">
          <BigNumber value={conversations ? conversations.length : "—"} label="Conversations" />
          <BigNumber
            value={conversations ? conversations.filter((c) => textField(c, "status") === "active").length : "—"}
            label="Active"
          />
          <BigNumber
            value={messages ? formatCount(messages.length, messages.length >= RECENT_MESSAGES_LIMIT) : "—"}
            label="Recent Messages"
          />
        </div>
        <div className="space-y-2 pt-1 border-t border-white/[0.06]">
          <MetricRow label="Latest Message" value={latest ? latest.toLocaleString() : NOT_REPORTED} />
        </div>
      </>
    );
  }
  return (
    <LiveCard
      title="Agent Bus"
      subtitle="The gateway's in-process agent conversations"
      note={`Recent messages are the latest ${RECENT_MESSAGES_LIMIT} at most. The report lists no conversations also when the gateway's agent bus isn't running.`}
    >
      {body}
    </LiveCard>
  );
}

function ConfigurationCard({ env }: { env: unknown }) {
  return (
    <LiveCard
      title="Configuration"
      subtitle="Environment settings the gateway reports"
      note="Not set means the variable is unset on the gateway. Not reported means the report left it out."
    >
      {isRecord(env) ? (
        <div className="space-y-2">
          {ENV_KEYS.map((key) => (
            <MetricRow key={key} label={key} value={envValue(env, key)} mono />
          ))}
        </div>
      ) : (
        <NotInReport what="the environment settings" />
      )}
    </LiveCard>
  );
}

function LiveRows({ report }: { report: SystemReport }) {
  const { db } = report;
  return (
    <>
      <div>
        <SectionLabel>Infrastructure</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KernelsCard kernels={listOf(db.kernels)} />
          <JobsCard jobs={listOf(db.jobs)} />
          <GatewayReportCard report={report} />
        </div>
      </div>

      <div>
        <SectionLabel>Registry and Evidence</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <CapabilitiesCard capabilities={listOf(db.capabilities)} />
          <RegistrationsCard registrations={listOf(db.registrations)} />
          <EvidenceCard evidence={listOf(db.evidence)} />
        </div>
      </div>

      <div>
        <SectionLabel>Agents and Configuration</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AgentBusCard agents={report.agents} />
          <ConfigurationCard env={report.env} />
        </div>
      </div>
    </>
  );
}

function LiveRowsSkeleton() {
  return (
    <>
      {[3, 3, 2].map((n, row) => (
        <div key={row} className={`grid grid-cols-1 ${n === 3 ? "md:grid-cols-3" : "md:grid-cols-2"} gap-4`}>
          {[...Array(n)].map((_, i) => <CardSkeleton key={i} />)}
        </div>
      ))}
    </>
  );
}

/** The prototype's figures that no field of /api/telemetry/system carries. */
function NotLiveSections() {
  return (
    <>
      <div>
        <SectionLabel>Protocol Economics</SectionLabel>
        <GlassPanel padding="lg">
          <NotLiveState
            what="Protocol economics"
            detail="The system report (/api/telemetry/system) doesn't include protocol fees, escrow volume or marketplace totals, so none are shown here."
            hasDemo
          />
        </GlassPanel>
      </div>

      <div>
        <SectionLabel>Chains, Network and Data Stack</SectionLabel>
        <GlassPanel padding="lg">
          <NotLiveState
            what="The chain and data-stack overview"
            detail="The system report doesn't include chain deployments, DHT peers, capability announcements, the gateway's version or route and test counts, IPFS uploads, ZK proofs, encryption counts, NEAR intents, or the agent package's version and tool count."
            hasDemo
          />
        </GlassPanel>
      </div>
    </>
  );
}

/** Sponsor integration status lives on its own page, read from /api/status/integrations. */
function SponsorLinkStrip() {
  return (
    <GlassPanel padding="md">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span className="text-[10px] text-white/30 uppercase tracking-widest flex-shrink-0">
          Sponsor Integrations
        </span>
        <span className="text-xs text-white/40">
          How each integration is configured, as the gateway reports it, is on the Sponsor Integrations page.
        </span>
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
// Prototype cards (demo mode only)
// Row 1: Protocol Economics
// ---------------------------------------------------------------------------

function ProtocolFeeCard({ data }: { data: PrototypeSystemPayload }) {
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

function EscrowActivityCard({ data }: { data: PrototypeSystemPayload }) {
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

function MarketplaceCard({ data }: { data: PrototypeSystemPayload }) {
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
// Row 2: Infrastructure (prototype)
// ---------------------------------------------------------------------------

const CHAIN_EXPLORER: Record<string, string> = {
  "Base Sepolia": "https://sepolia.basescan.org",
  "Flow EVM": "https://evm-testnet.flowscan.io",
  Starknet: "https://sepolia.starkscan.co",
};

function MultiChainCard({ data }: { data: PrototypeSystemPayload }) {
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

function OperatorNetworkCard({ data }: { data: PrototypeSystemPayload }) {
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

function GatewayCard({ data }: { data: PrototypeSystemPayload }) {
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
// Row 3: Sovereign Data Stack (prototype)
// ---------------------------------------------------------------------------

function EvidencePipelineCard({ data }: { data: PrototypeSystemPayload }) {
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

function StorageCard({ data }: { data: PrototypeSystemPayload }) {
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

function NearIntentsCard({ data }: { data: PrototypeSystemPayload }) {
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
// Row 4: Agent Layer (prototype)
// ---------------------------------------------------------------------------

function AgentPackageCard({ data }: { data: PrototypeSystemPayload }) {
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

function A2AActivityCard({ data }: { data: PrototypeSystemPayload }) {
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

function PrototypeJobsCard({ data }: { data: PrototypeSystemPayload }) {
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
// Sponsor status strip (prototype)
// ---------------------------------------------------------------------------

const SPONSOR_LABELS: Record<keyof PrototypeSystemPayload["sponsors"], string> = {
  storacha: "Storacha",
  starknet: "Starknet",
  lit: "Lit Protocol",
  flow: "Flow EVM",
  near: "NEAR",
};

const SPONSOR_LINKS: Record<keyof PrototypeSystemPayload["sponsors"], string> = {
  storacha: "/sponsors",
  starknet: "/sponsors",
  lit: "/sponsors",
  flow: "/sponsors",
  near: "/sponsors",
};

function SponsorStatusStrip({ sponsors }: { data: PrototypeSystemPayload; sponsors: PrototypeSystemPayload["sponsors"] }) {
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
        {(Object.keys(sponsors) as Array<keyof PrototypeSystemPayload["sponsors"]>).map((key) => (
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
// Main Page
// ---------------------------------------------------------------------------

export function SystemDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("System Dashboard", "Mission control: what the gateway reports about its own state");
  }, [setPageMeta]);

  // Sample values render only when the viewer asked for a demo (lib/demo-mode.ts).
  return isDemoMode() ? <SystemDashboardDemo /> : <SystemDashboardLive />;
}

// ── Live: /api/telemetry/system, and what it doesn't report ─────────────────

function SystemDashboardLive() {
  const query = useQuery({
    queryKey: ["telemetry", "system"],
    queryFn: fetchSystemReport,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
  });

  // react-query never stores undefined, so stored data means the gateway answered with a report.
  const report = query.data;
  const retry = () => void query.refetch();
  const reportedAt = report ? reportedTime(report.timestamp) : null;

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-white/80">System Dashboard</h1>
          <p className="text-xs text-white/35 mt-0.5">
            What the gateway reports about its registry, jobs, evidence, agents and configuration
          </p>
        </div>
        <RefreshButton onClick={retry} fetching={query.isFetching} />
      </div>

      {/* A failed refresh keeps the last report on screen, labelled with its time */}
      {report && query.isError && (
        <StaleNotice what="the system report" updatedAt={query.dataUpdatedAt} onRetry={retry} />
      )}

      {report ? (
        <LiveRows report={report} />
      ) : query.isError ? (
        <GlassPanel padding="lg">
          <UnavailableState what="the system report" error={query.error} onRetry={retry} />
        </GlassPanel>
      ) : (
        <LiveRowsSkeleton />
      )}

      <NotLiveSections />

      <SponsorLinkStrip />

      {/* Footer */}
      <p className="text-[11px] text-white/20 text-center pb-2">
        Sourced from{" "}
        <span className="font-mono text-white/30">/api/telemetry/system</span>
        {reportedAt ? `, reported at ${reportedAt}` : ""}; refreshes every 15s. Counts are over the lists in
        that report: it includes at most {JOBS_PAGE_SIZE} jobs, and it sends an empty list both when there
        are none and when its database read failed.
      </p>
    </div>
  );
}

// ── Demo: the prototype with sample values, under a DemoBanner ──────────────

function SystemDashboardDemo() {
  const data = React.useMemo(() => demoSystemTelemetry(), []);

  return (
    <div className="space-y-5">
      <DemoBanner what="System dashboard" />

      {/* Header row */}
      <div>
        <h1 className="text-base font-semibold text-white/80">System Dashboard</h1>
        <p className="text-xs text-white/35 mt-0.5">
          Mission control — full operational overview of the PCC platform
        </p>
      </div>

      {/* ── Row 1: Protocol Economics ── */}
      <div>
        <SectionLabel>Protocol Economics</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ProtocolFeeCard data={data} />
          <EscrowActivityCard data={data} />
          <MarketplaceCard data={data} />
        </div>
      </div>

      {/* ── Row 2: Infrastructure ── */}
      <div>
        <SectionLabel>Infrastructure</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MultiChainCard data={data} />
          <OperatorNetworkCard data={data} />
          <GatewayCard data={data} />
        </div>
      </div>

      {/* ── Row 3: Sovereign Data Stack ── */}
      <div>
        <SectionLabel>Sovereign Data Stack</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <EvidencePipelineCard data={data} />
          <StorageCard data={data} />
          <NearIntentsCard data={data} />
        </div>
      </div>

      {/* ── Row 4: Agent Layer ── */}
      <div>
        <SectionLabel>Agent Layer</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <AgentPackageCard data={data} />
          <A2AActivityCard data={data} />
          <PrototypeJobsCard data={data} />
        </div>
      </div>

      {/* ── Sponsor Status Strip ── */}
      <SponsorStatusStrip data={data} sponsors={data.sponsors} />

      {/* Footer */}
      <p className="text-[11px] text-white/20 text-center pb-2">
        Sample values, not read from{" "}
        <span className="font-mono text-white/30">/api/telemetry/system</span>.
      </p>
    </div>
  );
}
