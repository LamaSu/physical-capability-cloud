import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, StatusChip, ProgressArc, AmountDisplay, TierBadge, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockJobs, jobMeta } from "../api/mock-data.js";

const jobStatusToPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  queued: "online",
  preparing: "executing",
  executing: "executing",
  collecting_evidence: "executing",
  awaiting_pickup: "executing",
  completed: "completed",
  failed: "failed",
  cancelled: "offline",
};

export function JobsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [filter, setFilter] = React.useState<"all" | "active" | "completed">("all");

  React.useEffect(() => { setPageMeta("Jobs", "Track active and completed lab and manufacturing jobs"); }, [setPageMeta]);

  const filtered = mockJobs.filter((j) => {
    if (filter === "active") return j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled";
    if (filter === "completed") return j.status === "completed";
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-2">
        {(["all", "active", "completed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-lg text-xs border transition-all ${
              filter === f
                ? "bg-green-500/15 border-green-500/30 text-green-400"
                : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="ml-auto text-xs text-white/30">{filtered.length} jobs</span>
      </div>

      {/* Job list */}
      {filtered.map((job) => {
        const meta = jobMeta[job.id];
        return (
          <GlassPanel
            key={job.id}
            hover
            padding="md"
            onClick={() => navigate(`/jobs/${job.id}`)}
          >
            <div className="flex items-center gap-4">
              <ProgressArc progress={job.progress} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white/80">{meta?.name ?? job.id}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-white/30 font-mono">{job.id}</span>
                  <span className="text-xs text-white/20">·</span>
                  <span className="text-xs text-white/30">{meta?.kernelName ?? job.capabilityId}</span>
                </div>
              </div>
              {meta && <TierBadge tier={meta.tier} />}
              <AmountDisplay amount={meta?.amount ?? "0"} size="sm" />
              <StatusChip status={jobStatusToPulse[job.status] ?? "offline"} label={job.status.replace(/_/g, " ")} />
            </div>
          </GlassPanel>
        );
      })}

      {filtered.length === 0 && (
        <div className="text-center py-12 text-white/30 text-sm">
          No jobs match the current filter
        </div>
      )}
    </div>
  );
}
