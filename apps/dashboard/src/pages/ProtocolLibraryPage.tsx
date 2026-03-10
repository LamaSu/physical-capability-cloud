import React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge, DataCell } from "@pcc/ui";
import type { ProtocolTemplate, ProtocolRun, AutomationStatus, AutomationLevel } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useProtocolLibraryStore } from "../stores/protocol-library-store.js";

const GATEWAY = "/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  published: "green",
  draft: "gold",
  deprecated: "red",
  archived: "gray",
};

const RUN_STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  running: "gold",
  ready: "gold",
  binding: "gray",
  paused: "gold",
  failed: "red",
  cancelled: "red",
};

const AUTOMATION_LEVEL_COLORS: Record<string, string> = {
  manual: "bg-red-400",
  teleoperated: "bg-amber-400",
  pilot_operated: "bg-blue-400",
  vla_assisted: "bg-cyan-400",
  fully_autonomous: "bg-green-400",
};

function automationBadgeColor(level: AutomationLevel): "green" | "gold" | "red" | "gray" {
  if (level === "fully_autonomous") return "green";
  if (level === "vla_assisted") return "green";
  if (level === "pilot_operated" || level === "teleoperated") return "gold";
  if (level === "manual") return "red";
  return "gray";
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function renderStars(rating: number | undefined): string {
  if (rating == null) return "--";
  const full = Math.floor(rating);
  return "\u2605".repeat(full) + "\u2606".repeat(5 - full);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProtocolLibraryPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    templates,
    runs,
    automationStatuses,
    searchQuery,
    filterTags,
    setTemplates,
    setRuns,
    setAutomationStatuses,
    setSearchQuery,
    setFilterTags,
  } = useProtocolLibraryStore();

  React.useEffect(() => {
    setPageMeta("Protocol Library", "Browse, fork, and run shareable protocols");
  }, [setPageMeta]);

  // Fetch data
  const { data: templateData } = useQuery({
    queryKey: ["protocol-templates"],
    queryFn: () => fetch(`${GATEWAY}/protocols`).then((r) => r.json()),
  });

  const { data: runData } = useQuery({
    queryKey: ["protocol-runs"],
    queryFn: () => fetch(`${GATEWAY}/protocol-runs`).then((r) => r.json()),
  });

  const { data: automationData } = useQuery({
    queryKey: ["automation-statuses"],
    queryFn: () => fetch(`${GATEWAY}/automation-status`).then((r) => r.json()),
  });

  React.useEffect(() => {
    if (templateData?.templates) setTemplates(templateData.templates);
  }, [templateData]);

  React.useEffect(() => {
    if (runData?.runs) setRuns(runData.runs);
  }, [runData]);

  React.useEffect(() => {
    if (automationData?.statuses) setAutomationStatuses(automationData.statuses);
  }, [automationData]);

  // All unique tags
  const allTags = React.useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of templates) {
      for (const tag of t.tags) tagSet.add(tag);
    }
    return Array.from(tagSet).sort();
  }, [templates]);

  // Filtered templates
  const filtered = React.useMemo(() => {
    let result = templates;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.requiredCapabilities.some((c) => c.toLowerCase().includes(q)),
      );
    }
    if (filterTags.length > 0) {
      result = result.filter((t) => filterTags.every((ft) => t.tags.includes(ft)));
    }
    return result;
  }, [templates, searchQuery, filterTags]);

  const toggleTag = (tag: string) => {
    if (filterTags.includes(tag)) {
      setFilterTags(filterTags.filter((t) => t !== tag));
    } else {
      setFilterTags([...filterTags, tag]);
    }
  };

  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Templates" value={String(templates.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Published" value={String(templates.filter((t) => t.status === "published").length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Runs" value={String(runs.filter((r) => r.status === "running").length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Automation Pairs" value={String(automationStatuses.length)} />
        </GlassPanel>
      </div>

      {/* Search + Filters */}
      <GlassPanel padding="md">
        <div className="flex items-center gap-4">
          <input
            type="text"
            placeholder="Search protocols..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-2 text-sm text-white/80 outline-none focus:border-green-500/30 placeholder:text-white/20"
          />
          <button
            onClick={() => navigate("/protocols/new")}
            className="px-4 py-2 rounded-lg bg-green-500/20 border border-green-500/30 text-sm text-green-400 hover:bg-green-500/30 transition-colors whitespace-nowrap"
          >
            Create Protocol
          </button>
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className={`px-2.5 py-1 rounded-full text-[10px] border transition-all ${
                  filterTags.includes(tag)
                    ? "bg-green-500/15 border-green-500/30 text-green-400"
                    : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </GlassPanel>

      {/* Protocol Template Grid */}
      <div className="grid grid-cols-3 gap-4">
        {filtered.map((template) => (
          <GlassPanel
            key={template.id}
            padding="md"
          >
            <button
              onClick={() => navigate(`/protocols/${template.id}`)}
              className="w-full text-left"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-white/80 truncate">{template.name}</h3>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px] font-mono text-white/30">v{template.version}</span>
                  <GlowBadge color={STATUS_COLOR[template.status] ?? "gray"}>
                    {template.status}
                  </GlowBadge>
                </div>
              </div>

              <p className="text-xs text-white/40 mb-3 line-clamp-2">{template.description}</p>

              {/* Required capabilities */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {template.requiredCapabilities.map((cap) => (
                  <GlowBadge key={cap} color="green">{cap}</GlowBadge>
                ))}
              </div>

              {/* Tags */}
              {template.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {template.tags.map((tag) => (
                    <span key={tag} className="text-[10px] text-white/25 bg-white/[0.03] px-1.5 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Stats row */}
              <div className="flex items-center gap-4 text-[10px] text-white/30 border-t border-white/[0.06] pt-2">
                <span>Forks: {template.forkCount}</span>
                <span>Runs: {template.runCount}</span>
                <span className="text-amber-400/60">{renderStars(template.rating)}</span>
                <span className="ml-auto text-white/20">{template.authorName}</span>
              </div>
            </button>
          </GlassPanel>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-3 text-center py-16 text-white/30 text-sm">
            No protocols found
          </div>
        )}
      </div>

      {/* Active Runs */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Active Runs</h3>
        <div className="space-y-2">
          {runs.map((run) => {
            const tmpl = templates.find((t) => t.id === run.templateId);
            const completedSteps = run.steps.filter((s) => s.status === "completed").length;
            const totalSteps = run.steps.length;
            return (
              <button
                key={run.id}
                onClick={() => navigate(`/protocol-runs/${run.id}`)}
                className="w-full px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-left hover:border-white/[0.12] transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-white/70">{run.id}</span>
                    {tmpl && <span className="text-white/40">{tmpl.name}</span>}
                  </div>
                  <GlowBadge color={RUN_STATUS_COLOR[run.status] ?? "gray"}>{run.status}</GlowBadge>
                </div>
                <div className="grid grid-cols-4 gap-2 mt-2 text-white/40">
                  <div>
                    <span className="text-white/20">Kernel:</span>{" "}
                    <span className="text-white/60">{run.kernelId}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Progress:</span>{" "}
                    <span className="text-white/60">{completedSteps}/{totalSteps}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Samples:</span>{" "}
                    <span className="text-white/60">{run.sampleIds.length}</span>
                  </div>
                  <div>
                    <span className="text-white/20">By:</span>{" "}
                    <span className="text-white/60">{run.initiatedBy}</span>
                  </div>
                </div>
                {/* Step progress bar */}
                {totalSteps > 0 && (
                  <div className="mt-2 flex gap-1">
                    {run.steps.map((step) => (
                      <div
                        key={step.id}
                        className="flex-1 h-1.5 rounded-full overflow-hidden"
                        title={`${step.action} — ${step.status}`}
                      >
                        <div
                          className={`h-full rounded-full ${
                            step.status === "completed"
                              ? "bg-green-400"
                              : step.status === "running"
                              ? "bg-amber-400 animate-pulse"
                              : step.status === "failed"
                              ? "bg-red-400"
                              : "bg-white/10"
                          }`}
                          style={{ width: step.status === "pending" || step.status === "queued" ? "0%" : "100%" }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
          {runs.length === 0 && (
            <div className="text-center py-8 text-white/30 text-xs">No protocol runs</div>
          )}
        </div>
      </GlassPanel>

      {/* Automation Status */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Automation Status</h3>
        <div className="space-y-2">
          {automationStatuses.map((status) => {
            const pct = status.minEpisodesForTraining > 0
              ? Math.min(100, Math.round((status.episodeCount / status.minEpisodesForTraining) * 100))
              : 0;
            return (
              <div
                key={status.id}
                className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-white/50">{status.fromNodeId}</span>
                    <span className="text-white/20">&rarr;</span>
                    <span className="font-mono text-white/50">{status.toNodeId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${AUTOMATION_LEVEL_COLORS[status.currentLevel] ?? "bg-gray-400"}`}
                    />
                    <GlowBadge color={automationBadgeColor(status.currentLevel)}>
                      {status.currentLevel}
                    </GlowBadge>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 text-white/40">
                  <div>
                    <span className="text-white/20">Episodes:</span>{" "}
                    <span className="text-white/60">{status.episodeCount}/{status.minEpisodesForTraining}</span>
                  </div>
                  <div>
                    <span className="text-white/20">VLA:</span>{" "}
                    <span className="text-white/60">{status.vlaModelName ?? "none"}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Success:</span>{" "}
                    <span className="text-white/60">
                      {status.vlaSuccessRate != null ? `${(status.vlaSuccessRate * 100).toFixed(0)}%` : "--"}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/20">Threshold:</span>{" "}
                    <span className="text-white/60">{(status.advanceThreshold * 100).toFixed(0)}%</span>
                  </div>
                </div>
                {/* Episode progress bar */}
                <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      pct >= 100 ? "bg-green-400" : pct >= 50 ? "bg-amber-400" : "bg-white/20"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
          {automationStatuses.length === 0 && (
            <div className="text-center py-8 text-white/30 text-xs">No automation status data</div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
