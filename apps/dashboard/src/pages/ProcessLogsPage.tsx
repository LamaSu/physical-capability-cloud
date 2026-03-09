import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { ProcessLogEntry } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useSSEStream } from "../hooks/use-sse-stream.js";

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

// Mock log generation
function generateMockLogs(count: number): ProcessLogEntry[] {
  const phases = ["layer_print", "gradient_elution", "heating", "cooling", "inspection", "calibration"];
  const levels: ProcessLogEntry["level"][] = ["info", "info", "info", "debug", "warn", "info", "info", "trace"];
  const messages = [
    "Layer completed successfully",
    "Temperature target reached",
    "Gradient step 3/10 — 45% B",
    "Power consumption within expected range",
    "Vibration level slightly elevated",
    "Camera snapshot captured",
    "Waiting for bed temperature stabilization",
    "G-code line 4521 executed",
    "Extrusion rate adjusted to 105%",
    "Retraction detected at Z=12.4mm",
  ];

  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `plog_${i}`,
    timestamp: new Date(now - (count - i) * 2000).toISOString(),
    kernelId: "kernel-nyc",
    deviceId: "dev-001",
    jobId: i % 3 === 0 ? "job-001" : i % 3 === 1 ? "job-002" : "job-003",
    stepId: "step-1",
    level: levels[i % levels.length],
    phase: phases[i % phases.length],
    phaseProgress: Math.min(100, Math.floor((i / count) * 100)),
    message: messages[i % messages.length],
    data: {},
    sequence: i,
    hash: `sha256:${"0".repeat(64)}` as const,
  }));
}

export function ProcessLogsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [logs, setLogs] = React.useState<ProcessLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = React.useState<ProcessLogEntry["level"] | "all">("all");
  const [jobFilter, setJobFilter] = React.useState<string>("all");
  const [autoScroll, setAutoScroll] = React.useState(true);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setPageMeta("Process Logs", "Real-time log streaming");
  }, [setPageMeta]);

  // Initialize with seed history
  React.useEffect(() => {
    setLogs(generateMockLogs(40));
  }, []);

  // Stream process logs via SSE
  const handleSSEEvent = React.useCallback(
    (type: string, data: unknown) => {
      if (type === "process_log") {
        setLogs((prev) => [...prev.slice(-200), data as ProcessLogEntry]);
      }
    },
    [],
  );

  useSSEStream({
    url: "/sse/stream/kernel/kernel-nyc",
    onEvent: handleSSEEvent,
  });

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
