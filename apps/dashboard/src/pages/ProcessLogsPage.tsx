/**
 * Process Logs: device log lines (level, phase, progress) from running jobs.
 *
 * Nothing live serves these yet. No gateway route returns process-log history,
 * and the only publisher of `process_log` events on the kernel SSE streams is
 * the gateway's development log generator (LogProducer in
 * packages/gateway/src/sse/producers.ts, fed by sse/mock-data-generator.ts). It
 * invents lines for kernel "kernel-nyc" and jobs job-001..003 on a timer, and
 * runs by default outside production. This page used to generate forty lines
 * on load and append that stream, so it showed plausible logs that no machine
 * wrote.
 *
 * It now says the view isn't connected to live data, and opens no stream. In
 * demo mode (lib/demo-mode.ts) the prototype renders sample lines under a
 * DemoBanner.
 */

import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { ProcessLogEntry } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { demoProcessLogs } from "../demo/ProcessLogsPage.fixtures.js";

const LEVEL_COLORS: Record<ProcessLogEntry["level"], string> = {
  trace: "text-white/20",
  debug: "text-white/30",
  info: "text-green-400",
  warn: "text-amber-400",
  error: "text-red-400",
  fatal: "text-red-500 font-bold",
};

const LEVEL_BADGE_COLORS: Record<ProcessLogEntry["level"], "green" | "gold" | "red" | "gray"> = {
  trace: "gray",
  debug: "gray",
  info: "green",
  warn: "gold",
  error: "red",
  fatal: "red",
};

export function ProcessLogsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Process Logs", "Device log lines from running jobs");
  }, [setPageMeta]);

  // Sample lines render only when the viewer asked for a demo (lib/demo-mode.ts).
  return isDemoMode() ? <ProcessLogsDemo /> : <ProcessLogsNotLive />;
}

// ── Production: no live source ──────────────────────────────────────────────

function ProcessLogsNotLive() {
  return (
    <GlassPanel padding="lg">
      <NotLiveState
        what="The process log stream"
        detail="No gateway route serves device process logs yet, and the only process_log events on the kernel streams come from the gateway's development log generator. Nothing is shown here rather than generated lines. Gateway logs are on the Pipeline Telemetry page."
        hasDemo
      />
    </GlassPanel>
  );
}

// ── Demo: the prototype with sample lines, under a DemoBanner ───────────────

function ProcessLogsDemo() {
  const [logs] = React.useState<ProcessLogEntry[]>(() => demoProcessLogs(40));
  const [levelFilter, setLevelFilter] = React.useState<ProcessLogEntry["level"] | "all">("all");
  const [jobFilter, setJobFilter] = React.useState<string>("all");
  const [autoScroll, setAutoScroll] = React.useState(true);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll
  React.useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((l) => {
    if (levelFilter !== "all" && l.level !== levelFilter) return false;
    if (jobFilter !== "all" && l.jobId !== jobFilter) return false;
    return true;
  });

  const jobIds = [...new Set(logs.map((l) => l.jobId))];

  return (
    <div className="space-y-4">
      <DemoBanner what="Process logs" />

      {/* Filters */}
      <GlassPanel padding="sm">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/40">Level:</span>
            {(["all", "info", "warn", "error", "debug", "trace"] as const).map((level) => (
              <button
                key={level}
                onClick={() => setLevelFilter(level)}
                className={`px-2 py-0.5 rounded text-[10px] border transition-all ${
                  levelFilter === level
                    ? "bg-green-500/15 border-green-500/30 text-green-400"
                    : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/40">Job:</span>
            <button
              onClick={() => setJobFilter("all")}
              className={`px-2 py-0.5 rounded text-[10px] border transition-all ${
                jobFilter === "all"
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40"
              }`}
            >
              all
            </button>
            {jobIds.map((id) => (
              <button
                key={id}
                onClick={() => setJobFilter(id)}
                className={`px-2 py-0.5 rounded text-[10px] border font-mono transition-all ${
                  jobFilter === id
                    ? "bg-green-500/15 border-green-500/30 text-green-400"
                    : "bg-white/[0.03] border-white/[0.06] text-white/40"
                }`}
              >
                {id}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-white/40 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              Auto-scroll
            </label>
            <span className="text-[10px] text-white/20">{filteredLogs.length} entries</span>
          </div>
        </div>
      </GlassPanel>

      {/* Phase progress bars */}
      <GlassPanel padding="sm">
        <div className="flex gap-4">
          {[...new Set(logs.slice(-20).map((l) => l.phase))].slice(0, 4).map((phase) => {
            const latest = logs.filter((l) => l.phase === phase).slice(-1)[0];
            return (
              <div key={phase} className="flex-1">
                <div className="flex items-center justify-between text-[10px] mb-1">
                  <span className="text-white/40">{phase.replace(/_/g, " ")}</span>
                  <span className="text-white/60">{latest?.phaseProgress ?? 0}%</span>
                </div>
                <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500/50 rounded-full transition-all"
                    style={{ width: `${latest?.phaseProgress ?? 0}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </GlassPanel>

      {/* Log stream */}
      <GlassPanel padding="none">
        <div
          ref={containerRef}
          className="h-[600px] overflow-y-auto font-mono text-xs"
        >
          {filteredLogs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-3 px-4 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.02]"
            >
              <span className="text-white/20 text-[10px] w-20 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className={`w-10 shrink-0 text-[10px] ${LEVEL_COLORS[log.level]}`}>
                {log.level.toUpperCase().padEnd(5)}
              </span>
              <span className="text-white/25 text-[10px] w-16 shrink-0 truncate">
                {log.jobId}
              </span>
              <span className="text-blue-400/40 text-[10px] w-24 shrink-0 truncate">
                {log.phase}
              </span>
              <span className="text-white/60 flex-1">{log.message}</span>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}
