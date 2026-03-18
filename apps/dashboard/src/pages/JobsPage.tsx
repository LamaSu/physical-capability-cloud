import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, DataCell, AmountDisplay, StatusChip, ProgressArc, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs } from "../api/hooks/use-pcc-data.js";

const jobStatusToPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  queued: "online", preparing: "executing", executing: "executing",
  collecting_evidence: "executing", awaiting_pickup: "executing",
  completed: "completed", failed: "failed", cancelled: "offline",
};

export function JobsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Jobs", "Active and completed jobs"); }, [setPageMeta]);

  const { data: jobs = [], isLoading } = useJobs();
  const [filter, setFilter] = React.useState<"all" | "active" | "completed">("all");

  if (isLoading) return <LoadingShell rows={5} />;

  const filtered = filter === "all" ? jobs
    : filter === "active" ? jobs.filter((j: any) => !["completed", "failed", "cancelled"].includes(j.status))
    : jobs.filter((j: any) => j.status === "completed");

  const activeCount = jobs.filter((j: any) => !["completed", "failed", "cancelled"].includes(j.status)).length;
  const completedCount = jobs.filter((j: any) => j.status === "completed").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Total Jobs" value={jobs.length} mono /></GlassPanel>
        <GlassPanel padding="md" glow={activeCount > 0 ? "green" : undefined}><DataCell label="Active" value={activeCount} mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Completed" value={completedCount} mono /></GlassPanel>
      </div>

      <GlassPanel padding="lg">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            {(["all", "active", "completed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs rounded-md capitalize transition-all ${
                  filter === f ? "bg-teal-400/20 text-teal-400 border border-teal-400/30" : "text-white/30 hover:text-white/50"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={jobs.length === 0 ? "No jobs yet" : `No ${filter} jobs`}
            description={jobs.length === 0 ? "Jobs will appear here when you submit a workflow or capability request." : undefined}
            action={jobs.length === 0 ? { label: "Discover Capabilities", onClick: () => navigate("/discover") } : undefined}
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((job: any) => (
              <div
                key={job.id}
                onClick={() => navigate(`/jobs/${job.id}`)}
                className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
              >
                <ProgressArc progress={job.progress ?? 0} size={40} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate">{job.name ?? job.id}</div>
                  <div className="text-xs text-white/30 font-mono">{job.capabilityId ?? ""}</div>
                </div>
                <AmountDisplay amount={job.amount ?? "0"} size="sm" />
                <StatusChip status={jobStatusToPulse[job.status] ?? "offline"} label={job.status?.replace("_", " ") ?? ""} />
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
