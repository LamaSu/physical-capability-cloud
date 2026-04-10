import React from "react";
import { GlassPanel, GlowBadge, Skeleton } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "../stores/auth-store.js";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ---------------------------------------------------------------------------
// Types (matching gateway /api/analytics/* response shapes)
// ---------------------------------------------------------------------------

interface AnalyticsStatus {
  posthog: { configured: boolean; canQuery: boolean; projectId: string | null };
  sentry: { configured: boolean; canQuery: boolean; org: string | null; project: string | null };
  ga4: { configured: boolean; measurementId: string | null; hasApiSecret: boolean };
  message: string;
}

interface OverviewData {
  dateRange: { from: string; to: string };
  posthog: {
    available: boolean;
    totalEvents: number;
    uniquePersons: number;
    pageviews: number;
    topEvents: { name: string; count: number }[];
    error?: string;
  };
  sentry: {
    available: boolean;
    totalIssues: number;
    unresolvedIssues: number;
    issues: { id: string; title: string; count: number; level: string; firstSeen: string; lastSeen: string }[];
    error?: string;
  };
  ga4: { available: boolean; error?: string };
}

interface TrafficData {
  series: { date: string; pageviews: number; visitors: number; events: number }[];
  error?: string;
}

interface PagesData {
  pages: { url: string; path: string; views: number; uniqueVisitors: number }[];
  error?: string;
}

interface EventsData {
  events: { name: string; count: number; uniqueUsers: number }[];
  error?: string;
}

interface ErrorsData {
  issues: { id: string; title: string; count: number; level: string; firstSeen: string; lastSeen: string; shortId: string }[];
  errorSeries: { date: string; count: number }[];
  totalErrors: number;
  error?: string;
}

interface SecurityData {
  attacks: { type: string; ip: string; path: string; payload: string; ua: string; timestamp: string; count: number }[];
  honeypots: { path: string; ip: string; ua: string; count: number }[];
  bots: { type: string; confidence: number; ip: string; reason: string; ua: string; count: number }[];
  rateLimits: { ip: string; requestCount: number; ua: string }[];
  totalSecurityEvents: number;
  breakdown: Record<string, number>;
  error?: string;
}

interface DevicesData {
  browsers: { name: string; count: number }[];
  os: { name: string; count: number }[];
  devices: { type: string; count: number }[];
  error?: string;
}

interface GeoData {
  countries: { name: string; code: string; visitors: number }[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  "#14b8a6", // teal-500
  "#06b6d4", // cyan-500
  "#8b5cf6", // violet-500
  "#f59e0b", // amber-500
  "#ef4444", // red-500
  "#10b981", // emerald-500
  "#3b82f6", // blue-500
  "#ec4899", // pink-500
  "#f97316", // orange-500
  "#6366f1", // indigo-500
];

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  fatal: "text-red-500",
  info: "text-cyan-400",
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const headers = () => ({ ...getAuthHeaders() });

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Date range hook
// ---------------------------------------------------------------------------

function useDateRange() {
  const [from, setFrom] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = React.useState(() => new Date().toISOString().slice(0, 10));
  return { from, to, setFrom, setTo };
}

// ---------------------------------------------------------------------------
// Tooltip component (shared)
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-black/90 border border-white/10 rounded-lg px-3 py-2 text-xs backdrop-blur-sm">
      <div className="text-white/50 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-white/70">{p.name}:</span>
          <span className="text-white font-mono">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source Status Bar
// ---------------------------------------------------------------------------

function SourceStatusBar({ status }: { status: AnalyticsStatus | undefined }) {
  if (!status) return null;

  const sources = [
    {
      name: "PostHog",
      ok: status.posthog.canQuery,
      partial: status.posthog.configured && !status.posthog.canQuery,
      detail: status.posthog.canQuery
        ? `Project ${status.posthog.projectId}`
        : status.posthog.configured
          ? "Set POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID to enable queries"
          : "Not configured",
    },
    {
      name: "Sentry",
      ok: status.sentry.canQuery,
      partial: status.sentry.configured && !status.sentry.canQuery,
      detail: status.sentry.canQuery
        ? `${status.sentry.org}/${status.sentry.project}`
        : "Set SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT",
    },
    {
      name: "GA4",
      ok: status.ga4.configured && status.ga4.hasApiSecret,
      partial: status.ga4.configured && !status.ga4.hasApiSecret,
      detail: status.ga4.configured
        ? status.ga4.measurementId ?? "Active"
        : "Set GA4_MEASUREMENT_ID",
    },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {sources.map((s) => (
        <div
          key={s.name}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.06] text-xs"
        >
          <div
            className={`w-2 h-2 rounded-full ${
              s.ok ? "bg-emerald-400" : s.partial ? "bg-amber-400 animate-pulse" : "bg-white/15"
            }`}
          />
          <span className="text-white/60 font-medium">{s.name}</span>
          <span className="text-white/25">{s.detail}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Cards — the hero stats row
// ---------------------------------------------------------------------------

function OverviewCards({ data, loading }: { data: OverviewData | undefined; loading: boolean }) {
  const cards = [
    {
      label: "Total Events",
      value: data?.posthog.totalEvents ?? 0,
      sub: data?.posthog.available ? "All tracked events" : "PostHog not connected",
      glow: (data?.posthog.totalEvents ?? 0) > 0 ? "green" as const : undefined,
      available: data?.posthog.available ?? false,
    },
    {
      label: "Unique Visitors",
      value: data?.posthog.uniquePersons ?? 0,
      sub: "Distinct persons",
      glow: (data?.posthog.uniquePersons ?? 0) > 0 ? "green" as const : undefined,
      available: data?.posthog.available ?? false,
    },
    {
      label: "Page Views",
      value: data?.posthog.pageviews ?? 0,
      sub: "$pageview events",
      glow: (data?.posthog.pageviews ?? 0) > 0 ? "green" as const : undefined,
      available: data?.posthog.available ?? false,
    },
    {
      label: "Sentry Issues",
      value: data?.sentry.unresolvedIssues ?? 0,
      sub: data?.sentry.available
        ? `${data.sentry.totalIssues} total`
        : "Sentry not connected",
      glow: (data?.sentry.unresolvedIssues ?? 0) > 0 ? "gold" as const : undefined,
      available: data?.sentry.available ?? false,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <GlassPanel key={c.label} glow={c.glow} padding="md">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-[10px] text-white/40 uppercase tracking-wider font-medium">{c.label}</div>
              <div className="text-2xl font-bold font-mono text-white/90">
                {c.available ? c.value.toLocaleString() : "—"}
              </div>
              <div className="text-xs text-white/30">{c.sub}</div>
            </div>
          )}
        </GlassPanel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic Chart — area chart of pageviews/visitors over time
// ---------------------------------------------------------------------------

function TrafficChart({ data, loading }: { data: TrafficData | undefined; loading: boolean }) {
  const series = data?.series ?? [];

  if (loading) {
    return (
      <GlassPanel padding="lg">
        <Skeleton className="h-4 w-32 mb-4" />
        <Skeleton className="h-56 w-full" />
      </GlassPanel>
    );
  }

  if (series.length === 0) {
    return (
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Traffic Over Time</h2>
        <div className="h-56 flex items-center justify-center text-white/20 text-sm">
          {data?.error ? `Error: ${data.error}` : "No traffic data available — configure PostHog to see trends"}
        </div>
      </GlassPanel>
    );
  }

  const formatted = series.map((s) => ({
    ...s,
    label: s.date.length > 10 ? s.date.slice(5, 16) : s.date.slice(5),
  }));

  return (
    <GlassPanel padding="lg">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Traffic Over Time</h2>
        <div className="flex gap-4 text-[10px] text-white/30">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal-500" /> Visitors</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-500" /> Pageviews</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-500/50" /> Events</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={formatted} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="gradVisitors" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradPageviews" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="label" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="visitors" name="Visitors" stroke="#14b8a6" fill="url(#gradVisitors)" strokeWidth={2} />
          <Area type="monotone" dataKey="pageviews" name="Pageviews" stroke="#06b6d4" fill="url(#gradPageviews)" strokeWidth={1.5} />
          <Area type="monotone" dataKey="events" name="Events" stroke="#8b5cf6" fill="none" strokeWidth={1} strokeDasharray="4 4" />
        </AreaChart>
      </ResponsiveContainer>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Top Pages — horizontal bar chart
// ---------------------------------------------------------------------------

function TopPages({ data, loading }: { data: PagesData | undefined; loading: boolean }) {
  const pages = data?.pages ?? [];

  if (loading) {
    return (
      <GlassPanel padding="lg">
        <Skeleton className="h-4 w-24 mb-4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full mb-2" />
        ))}
      </GlassPanel>
    );
  }

  return (
    <GlassPanel padding="lg">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Top Pages</h2>
      {pages.length === 0 ? (
        <div className="py-8 text-center text-white/20 text-sm">
          {data?.error ? `Error: ${data.error}` : "No page data yet"}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {pages.map((p, i) => {
            const maxViews = pages[0]?.views ?? 1;
            const pct = Math.round((p.views / maxViews) * 100);
            return (
              <div key={i} className="relative">
                <div
                  className="absolute inset-y-0 left-0 bg-teal-500/[0.08] rounded"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative flex items-center justify-between px-3 py-2 text-xs">
                  <span className="text-white/70 font-mono truncate max-w-[60%]">{p.path}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-white/50">{p.uniqueVisitors} visitors</span>
                    <span className="text-white/80 font-medium font-mono">{p.views.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Top Events — bar chart
// ---------------------------------------------------------------------------

function TopEventsSection({ overview, events, loading }: { overview: OverviewData | undefined; events: EventsData | undefined; loading: boolean }) {
  // Combine overview topEvents and dedicated events endpoint
  const eventList = events?.events ?? overview?.posthog.topEvents ?? [];

  if (loading) {
    return (
      <GlassPanel padding="lg">
        <Skeleton className="h-4 w-28 mb-4" />
        <Skeleton className="h-48 w-full" />
      </GlassPanel>
    );
  }

  if (eventList.length === 0) {
    return (
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Custom Events</h2>
        <div className="py-8 text-center text-white/20 text-sm">No custom events recorded yet</div>
      </GlassPanel>
    );
  }

  const chartData = eventList.slice(0, 12).map((e) => ({
    name: e.name.length > 20 ? e.name.slice(0, 18) + "…" : e.name,
    fullName: e.name,
    count: e.count,
  }));

  return (
    <GlassPanel padding="lg">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Custom Events</h2>
      <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
          <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={140}
            tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload;
              return (
                <div className="bg-black/90 border border-white/10 rounded-lg px-3 py-2 text-xs backdrop-blur-sm">
                  <div className="text-white/80 font-mono">{d.fullName}</div>
                  <div className="text-teal-400 font-bold">{d.count.toLocaleString()} events</div>
                </div>
              );
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Sentry Errors — issue list + error sparkline
// ---------------------------------------------------------------------------

function SentryErrors({ data, loading }: { data: ErrorsData | undefined; loading: boolean }) {
  if (loading) {
    return (
      <GlassPanel padding="lg">
        <Skeleton className="h-4 w-28 mb-4" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full mb-2" />
        ))}
      </GlassPanel>
    );
  }

  const issues = data?.issues ?? [];
  const series = data?.errorSeries ?? [];

  return (
    <GlassPanel padding="lg" glow={issues.length > 0 ? "gold" : undefined}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Sentry Errors</h2>
        {(data?.totalErrors ?? 0) > 0 && (
          <GlowBadge color="red">{data!.totalErrors.toLocaleString()} total errors</GlowBadge>
        )}
      </div>

      {/* Error trend sparkline */}
      {series.length > 0 && (
        <div className="mb-4">
          <ResponsiveContainer width="100%" height={60}>
            <AreaChart data={series} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradErrors" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="count" stroke="#ef4444" fill="url(#gradErrors)" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {issues.length === 0 ? (
        <div className="py-6 text-center text-white/20 text-sm">
          {data?.error ? `Error: ${data.error}` : "No unresolved issues"}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-start gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04] text-xs"
            >
              <div className="mt-1 flex-shrink-0">
                <div className={`w-1.5 h-1.5 rounded-full ${
                  issue.level === "error" || issue.level === "fatal" ? "bg-red-400" : "bg-amber-400"
                }`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white/70 truncate">{issue.title}</div>
                <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                  <span className={LEVEL_COLORS[issue.level] ?? "text-white/30"}>{issue.level}</span>
                  <span className="text-white/20">{issue.shortId}</span>
                  <span className="text-white/20">
                    {new Date(issue.lastSeen).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="flex-shrink-0 text-white/50 font-mono font-medium">
                {issue.count.toLocaleString()}x
              </div>
            </div>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Devices & Geography — pie charts + country list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Security Events — attacks, honeypots, bots, rate limits
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, string> = {
  sqli: "text-red-400",
  xss: "text-red-400",
  path_traversal: "text-amber-400",
  cmd_injection: "text-red-500",
  headless: "text-violet-400",
  automation: "text-violet-400",
  stealth_browser: "text-cyan-400",
  scraper: "text-amber-400",
  ai_agent: "text-teal-400",
  known_scanner: "text-red-400",
};

// ---------------------------------------------------------------------------
// Daily Reports Viewer — browse historical snapshots
// ---------------------------------------------------------------------------

interface ReportListData {
  reports: { date: string; filename: string }[];
  error?: string;
}

interface ReportSnapshot {
  generatedAt: string;
  range: { from: string; to: string };
  overview: OverviewData;
  errors: ErrorsData;
  pages: PagesData;
  events: EventsData;
  security: SecurityData;
}

function DailyReports() {
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  const listQ = useQuery({
    queryKey: ["analytics", "reports-list"],
    queryFn: () => fetchJson<ReportListData>("/api/analytics/reports"),
    staleTime: 60_000,
  });

  const reportQ = useQuery({
    queryKey: ["analytics", "report", selectedDate],
    queryFn: () => fetchJson<ReportSnapshot>(`/api/analytics/reports/${selectedDate}`),
    enabled: !!selectedDate,
    staleTime: Infinity,
  });

  // Auto-select most recent report
  React.useEffect(() => {
    if (!selectedDate && listQ.data?.reports?.[0]?.date) {
      setSelectedDate(listQ.data.reports[0].date);
    }
  }, [listQ.data, selectedDate]);

  const reports = listQ.data?.reports ?? [];

  return (
    <GlassPanel padding="lg">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 text-sm font-semibold text-white/60 uppercase tracking-wider hover:text-white/80 transition-colors"
        >
          <span className="text-base">📊</span>
          Daily Reports
          <span className="text-[10px] text-white/30">({reports.length} saved)</span>
          <span className="text-white/40 ml-1">{expanded ? "▼" : "▶"}</span>
        </button>
        {expanded && reports.length > 0 && (
          <select
            value={selectedDate ?? ""}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 focus:outline-none focus:border-teal-400/40"
          >
            {reports.map((r) => (
              <option key={r.date} value={r.date}>{r.date}</option>
            ))}
          </select>
        )}
      </div>

      {!expanded ? (
        <div className="text-xs text-white/30">
          {reports.length === 0
            ? "No daily reports yet. Run `node scripts/daily-report.mjs --save` or wait for the scheduled daily run."
            : `Latest: ${reports[0]?.date ?? "—"}. Click to expand.`}
        </div>
      ) : listQ.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : reports.length === 0 ? (
        <div className="py-4 text-center text-white/30 text-sm">
          No saved reports. Run the daily report script with <code className="text-teal-400">--save</code> to generate one.
        </div>
      ) : reportQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : reportQ.data ? (
        <div className="space-y-4 text-xs">
          {/* Report header */}
          <div className="flex items-center gap-3 text-white/40">
            <span>Generated: {new Date(reportQ.data.generatedAt).toLocaleString()}</span>
            <span>•</span>
            <span>Range: {reportQ.data.range.from} → {reportQ.data.range.to}</span>
          </div>

          {/* Overview stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="px-3 py-2 rounded bg-white/[0.02] border border-white/[0.06]">
              <div className="text-[10px] text-white/40 uppercase">Events</div>
              <div className="text-lg font-bold font-mono text-white/80">{reportQ.data.overview?.posthog?.totalEvents?.toLocaleString() ?? 0}</div>
            </div>
            <div className="px-3 py-2 rounded bg-white/[0.02] border border-white/[0.06]">
              <div className="text-[10px] text-white/40 uppercase">Visitors</div>
              <div className="text-lg font-bold font-mono text-white/80">{reportQ.data.overview?.posthog?.uniquePersons?.toLocaleString() ?? 0}</div>
            </div>
            <div className="px-3 py-2 rounded bg-white/[0.02] border border-white/[0.06]">
              <div className="text-[10px] text-white/40 uppercase">Pageviews</div>
              <div className="text-lg font-bold font-mono text-white/80">{reportQ.data.overview?.posthog?.pageviews?.toLocaleString() ?? 0}</div>
            </div>
            <div className="px-3 py-2 rounded bg-white/[0.02] border border-white/[0.06]">
              <div className="text-[10px] text-white/40 uppercase">Unresolved Errors</div>
              <div className={`text-lg font-bold font-mono ${(reportQ.data.overview?.sentry?.unresolvedIssues ?? 0) > 0 ? "text-amber-400" : "text-white/80"}`}>{reportQ.data.overview?.sentry?.unresolvedIssues?.toLocaleString() ?? 0}</div>
            </div>
          </div>

          {/* Security summary */}
          {(reportQ.data.security?.totalSecurityEvents ?? 0) > 0 && (
            <div className="p-3 rounded bg-red-500/[0.04] border border-red-500/[0.12]">
              <div className="text-[10px] text-red-400 uppercase tracking-wider mb-2 font-medium">Security Events on {selectedDate}</div>
              <div className="grid grid-cols-4 gap-2">
                <div><span className="text-white/40">Attacks:</span> <span className="text-red-400 font-mono">{reportQ.data.security?.attacks?.length ?? 0}</span></div>
                <div><span className="text-white/40">Honeypots:</span> <span className="text-amber-400 font-mono">{reportQ.data.security?.honeypots?.length ?? 0}</span></div>
                <div><span className="text-white/40">Bots:</span> <span className="text-violet-400 font-mono">{reportQ.data.security?.bots?.length ?? 0}</span></div>
                <div><span className="text-white/40">Rate:</span> <span className="text-cyan-400 font-mono">{reportQ.data.security?.rateLimits?.length ?? 0}</span></div>
              </div>
            </div>
          )}

          {/* Top events from snapshot */}
          {(reportQ.data.events?.events ?? []).length > 0 && (
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-2">Top Events</div>
              <div className="space-y-1">
                {reportQ.data.events!.events.slice(0, 5).map((e, i) => (
                  <div key={i} className="flex items-center justify-between px-2 py-1 rounded bg-white/[0.02]">
                    <span className="text-white/60 font-mono">{e.name}</span>
                    <span className="text-white/80 font-mono">{e.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Download link */}
          <div className="pt-2 border-t border-white/[0.06]">
            <a
              href={`/api/analytics/reports/${selectedDate}`}
              download={`analytics-${selectedDate}.json`}
              className="text-[10px] text-teal-400/70 hover:text-teal-400 transition-colors"
            >
              ↓ Download JSON snapshot
            </a>
          </div>
        </div>
      ) : null}
    </GlassPanel>
  );
}

function SecurityEvents({ data, loading }: { data: SecurityData | undefined; loading: boolean }) {
  if (loading) {
    return (
      <GlassPanel padding="lg">
        <Skeleton className="h-4 w-32 mb-4" />
        <Skeleton className="h-48 w-full" />
      </GlassPanel>
    );
  }

  const total = data?.totalSecurityEvents ?? 0;
  const attacks = data?.attacks ?? [];
  const honeypots = data?.honeypots ?? [];
  const bots = data?.bots ?? [];
  const rateLimits = data?.rateLimits ?? [];
  const breakdown = data?.breakdown ?? {};

  const hasEvents = total > 0;

  return (
    <GlassPanel padding="lg" glow={attacks.length > 0 ? "gold" : hasEvents ? "green" : undefined}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Security Events</h2>
        <div className="flex gap-2">
          {Object.entries(breakdown).map(([name, count]) => (
            <span key={name} className="px-2 py-0.5 rounded bg-white/[0.04] text-[10px] text-white/40">
              {name.replace(/_/g, " ")} <span className="text-white/60 font-mono">{count}</span>
            </span>
          ))}
          {total > 0 && <GlowBadge color="gold">{total} events</GlowBadge>}
        </div>
      </div>

      {!hasEvents ? (
        <div className="py-8 text-center text-white/20 text-sm">
          {data?.error ? `Error: ${data.error}` : "No security events detected — monitoring active"}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Attacks */}
          {attacks.length > 0 && (
            <div>
              <div className="text-[10px] text-red-400/70 uppercase tracking-wider mb-2 font-medium">Attack Attempts</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {attacks.map((a, i) => (
                  <div key={i} className="flex items-start gap-2 px-2 py-1.5 rounded bg-red-500/[0.04] border border-red-500/[0.08] text-xs">
                    <span className={`flex-shrink-0 font-mono font-medium ${SEVERITY_COLORS[a.type] ?? "text-red-400"}`}>{a.type}</span>
                    <span className="text-white/30 font-mono flex-shrink-0">{a.ip}</span>
                    <span className="text-white/50 truncate flex-1">{a.path}</span>
                    <span className="text-white/20 text-[10px] flex-shrink-0">{a.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Honeypots */}
          {honeypots.length > 0 && (
            <div>
              <div className="text-[10px] text-amber-400/70 uppercase tracking-wider mb-2 font-medium">Honeypot Triggers</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {honeypots.map((h, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded bg-amber-500/[0.04] border border-amber-500/[0.08] text-xs">
                    <span className="text-amber-400 font-mono flex-shrink-0">{h.path}</span>
                    <span className="text-white/30 font-mono flex-shrink-0">{h.ip}</span>
                    <span className="text-white/20 truncate flex-1">{h.ua.slice(0, 60)}</span>
                    <span className="text-white/20 text-[10px] flex-shrink-0">{h.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bots */}
          {bots.length > 0 && (
            <div>
              <div className="text-[10px] text-violet-400/70 uppercase tracking-wider mb-2 font-medium">Bot / Agent Detection</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {bots.map((b, i) => (
                  <div key={i} className="flex items-start gap-2 px-2 py-1.5 rounded bg-violet-500/[0.04] border border-violet-500/[0.08] text-xs">
                    <span className={`flex-shrink-0 font-mono font-medium ${SEVERITY_COLORS[b.type] ?? "text-violet-400"}`}>{b.type}</span>
                    <span className="text-white/30 font-mono flex-shrink-0">{b.ip}</span>
                    <span className="text-white/40 truncate flex-1">{b.reason}</span>
                    <span className="text-white/20 text-[10px] flex-shrink-0">{Math.round(b.confidence * 100)}%</span>
                    <span className="text-white/20 text-[10px] flex-shrink-0">{b.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rate Limits */}
          {rateLimits.length > 0 && (
            <div>
              <div className="text-[10px] text-cyan-400/70 uppercase tracking-wider mb-2 font-medium">Rate Limit Exceeded</div>
              <div className="space-y-1">
                {rateLimits.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded bg-cyan-500/[0.04] border border-cyan-500/[0.08] text-xs">
                    <span className="text-cyan-400 font-mono flex-shrink-0">{r.ip}</span>
                    <span className="text-white/50 font-mono">{r.requestCount} req/min</span>
                    <span className="text-white/20 truncate flex-1">{r.ua.slice(0, 60)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

function DevicesAndGeo({
  devices,
  geo,
  loading,
}: {
  devices: DevicesData | undefined;
  geo: GeoData | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassPanel padding="lg">
          <Skeleton className="h-4 w-20 mb-4" />
          <Skeleton className="h-40 w-full" />
        </GlassPanel>
        <GlassPanel padding="lg">
          <Skeleton className="h-4 w-20 mb-4" />
          <Skeleton className="h-40 w-full" />
        </GlassPanel>
      </div>
    );
  }

  const browsers = devices?.browsers ?? [];
  const countries = geo?.countries ?? [];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Browsers pie */}
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Browsers</h2>
        {browsers.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-sm">No browser data</div>
        ) : (
          <div className="flex items-center gap-4">
            <ResponsiveContainer width={140} height={140}>
              <PieChart>
                <Pie
                  data={browsers}
                  dataKey="count"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={60}
                  innerRadius={35}
                  strokeWidth={0}
                >
                  {browsers.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.8} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-1 text-xs">
              {browsers.slice(0, 6).map((b, i) => (
                <div key={b.name} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                  <span className="text-white/50 flex-1 truncate">{b.name}</span>
                  <span className="text-white/70 font-mono">{b.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* OS breakdown below browsers */}
        {(devices?.os ?? []).length > 0 && (
          <div className="mt-4 pt-3 border-t border-white/[0.06]">
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Operating Systems</div>
            <div className="flex flex-wrap gap-2">
              {devices!.os.slice(0, 5).map((o) => (
                <span key={o.name} className="px-2 py-0.5 rounded bg-white/[0.04] text-[10px] text-white/40">
                  {o.name} <span className="text-white/60 font-mono">{o.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </GlassPanel>

      {/* Geography */}
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Geography</h2>
        {countries.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-sm">No geographic data</div>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {countries.map((c, i) => {
              const maxVisitors = countries[0]?.visitors ?? 1;
              const pct = Math.round((c.visitors / maxVisitors) * 100);
              return (
                <div key={c.code || i} className="relative">
                  <div
                    className="absolute inset-y-0 left-0 bg-cyan-500/[0.06] rounded"
                    style={{ width: `${pct}%` }}
                  />
                  <div className="relative flex items-center justify-between px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-white/30 font-mono text-[10px] w-6">{c.code}</span>
                      <span className="text-white/60">{c.name}</span>
                    </div>
                    <span className="text-white/80 font-mono font-medium">{c.visitors}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Device types below geography */}
        {(devices?.devices ?? []).length > 0 && (
          <div className="mt-4 pt-3 border-t border-white/[0.06]">
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Device Types</div>
            <div className="flex flex-wrap gap-2">
              {devices!.devices.slice(0, 4).map((d) => (
                <span key={d.type} className="px-2 py-0.5 rounded bg-white/[0.04] text-[10px] text-white/40">
                  {d.type} <span className="text-white/60 font-mono">{d.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup Guide — shown when sources are not fully configured
// ---------------------------------------------------------------------------

function SetupGuide({ status }: { status: AnalyticsStatus | undefined }) {
  if (!status) return null;
  const needed: string[] = [];
  if (!status.posthog.canQuery) {
    needed.push(
      "PostHog: Set POSTHOG_PERSONAL_API_KEY (create at PostHog > Settings > Personal API keys) and POSTHOG_PROJECT_ID (from your PostHog dashboard URL) in Railway env vars",
    );
  }
  if (!status.sentry.canQuery) {
    needed.push(
      "Sentry: Set SENTRY_AUTH_TOKEN (create at sentry.io > Settings > Auth Tokens) in Railway. SENTRY_ORG and SENTRY_PROJECT should already be set from the Dockerfile.",
    );
  }

  if (needed.length === 0) return null;

  return (
    <GlassPanel padding="lg">
      <h2 className="text-sm font-semibold text-amber-400/70 uppercase tracking-wider mb-3">
        Setup Required for Full Analytics
      </h2>
      <div className="space-y-2">
        {needed.map((n, i) => (
          <div key={i} className="flex gap-2 text-xs text-white/40">
            <span className="text-amber-400/60 flex-shrink-0">{'>'}</span>
            <span>{n}</span>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function AnalyticsDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { from, to, setFrom, setTo } = useDateRange();

  React.useEffect(() => {
    setPageMeta("Analytics", "PostHog + Sentry + GA4 — unified analytics dashboard");
  }, [setPageMeta]);

  // -- Queries ---------------------------------------------------------------

  const statusQ = useQuery({
    queryKey: ["analytics", "status"],
    queryFn: () => fetchJson<AnalyticsStatus>("/api/analytics/status"),
    staleTime: 60_000,
  });

  const overviewQ = useQuery({
    queryKey: ["analytics", "overview", from, to],
    queryFn: () => fetchJson<OverviewData>(`/api/analytics/overview?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const trafficQ = useQuery({
    queryKey: ["analytics", "traffic", from, to],
    queryFn: () => fetchJson<TrafficData>(`/api/analytics/traffic?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const pagesQ = useQuery({
    queryKey: ["analytics", "pages", from, to],
    queryFn: () => fetchJson<PagesData>(`/api/analytics/pages?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const eventsQ = useQuery({
    queryKey: ["analytics", "events", from, to],
    queryFn: () => fetchJson<EventsData>(`/api/analytics/events?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const errorsQ = useQuery({
    queryKey: ["analytics", "errors", from, to],
    queryFn: () => fetchJson<ErrorsData>(`/api/analytics/errors?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const devicesQ = useQuery({
    queryKey: ["analytics", "devices", from, to],
    queryFn: () => fetchJson<DevicesData>(`/api/analytics/devices?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const geoQ = useQuery({
    queryKey: ["analytics", "geography", from, to],
    queryFn: () => fetchJson<GeoData>(`/api/analytics/geography?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const securityQ = useQuery({
    queryKey: ["analytics", "security", from, to],
    queryFn: () => fetchJson<SecurityData>(`/api/analytics/security?from=${from}&to=${to}`),
    staleTime: 10_000, // Fast refresh for security events
    refetchInterval: 30_000, // Auto-refresh every 30s
  });

  // -- Render ----------------------------------------------------------------

  return (
    <div className="space-y-5">
      {/* Header with date range picker */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceStatusBar status={statusQ.data} />
        <div className="flex items-center gap-2 text-xs">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-white/60 focus:outline-none focus:border-teal-400/40"
          />
          <span className="text-white/20">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-white/60 focus:outline-none focus:border-teal-400/40"
          />
        </div>
      </div>

      {/* Setup guide (if sources need configuration) */}
      <SetupGuide status={statusQ.data} />

      {/* Overview cards */}
      <OverviewCards data={overviewQ.data} loading={overviewQ.isLoading} />

      {/* Traffic chart */}
      <TrafficChart data={trafficQ.data} loading={trafficQ.isLoading} />

      {/* Two-column: Pages + Events */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopPages data={pagesQ.data} loading={pagesQ.isLoading} />
        <TopEventsSection overview={overviewQ.data} events={eventsQ.data} loading={eventsQ.isLoading} />
      </div>

      {/* Sentry Errors */}
      {/* Daily Reports — click to browse historical snapshots */}
      <DailyReports />

      {/* Security Events — attacks, bots, honeypots, rate limits */}
      <SecurityEvents data={securityQ.data} loading={securityQ.isLoading} />

      {/* Sentry Errors */}
      <SentryErrors data={errorsQ.data} loading={errorsQ.isLoading} />

      {/* Devices & Geography */}
      <DevicesAndGeo devices={devicesQ.data} geo={geoQ.data} loading={devicesQ.isLoading || geoQ.isLoading} />
    </div>
  );
}
