import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, DataCell, StatusChip, ProgressArc, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs } from "../api/hooks/use-pcc-data.js";
import { formatCount, isActiveJob, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-status.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";

/** Canonical job statuses (types/dto.ts StepStatus) to a pulse; the label always carries the status text. */
const jobStatusToPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  pending: "online", queued: "online", in_progress: "executing", paused: "offline",
  completed: "completed", failed: "failed", cancelled: "offline",
};

export function JobsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Jobs", "Active and completed jobs"); }, [setPageMeta]);

  const jobsQ = useJobs();
  const [filter, setFilter] = React.useState<"all" | "active" | "completed">("all");

  if (jobsQ.isLoading) return <LoadingShell rows={5} />;
  const jobs = jobsQ.data;
  if (!jobs) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="jobs" error={jobsQ.error} onRetry={() => void jobsQ.refetch()} />
      </GlassPanel>
    );
  }

  const filtered = filter === "all" ? jobs
    : filter === "active" ? jobs.filter(isActiveJob)
    : jobs.filter((j) => j.status === "completed");

  const activeCount = jobs.filter(isActiveJob).length;
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  // /api/jobs returns one page and no total: counts over a full page are lower bounds.
  const truncated = mayBeTruncated(jobs);

  return (
    <div className="space-y-6">
      {jobsQ.isError && (
        <StaleNotice what="jobs" updatedAt={jobsQ.dataUpdatedAt} onRetry={() => void jobsQ.refetch()} />
      )}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Total Jobs" value={formatCount(jobs.length, truncated)} mono /></GlassPanel>
        <GlassPanel padding="md" glow={activeCount > 0 ? "green" : undefined}><DataCell label="Active" value={formatCount(activeCount, truncated)} mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Completed" value={formatCount(completedCount, truncated)} mono /></GlassPanel>
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

        {truncated && (
          <p className="text-xs text-white/35 mb-3">
            Showing the first {JOBS_PAGE_SIZE} jobs the gateway returned; there may be more.
          </p>
        )}
        {filtered.length === 0 ? (
          <EmptyState
            title={jobs.length === 0 ? "No jobs yet" : `No ${filter} jobs`}
            description={jobs.length === 0 ? "Jobs will appear here when you submit a workflow or capability request." : undefined}
            action={jobs.length === 0 ? { label: "Discover Capabilities", onClick: () => navigate("/discover") } : undefined}
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((job) => (
              <div
                key={job.id}
                onClick={() => navigate(`/jobs/${job.id}`)}
                className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
              >
                {typeof job.progress === "number" && <ProgressArc progress={job.progress} size={40} />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate font-mono">{job.id}</div>
                  <div className="text-xs text-white/30 truncate">
                    {[job.capabilityType ?? job.capabilityId, job.kernelName].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <StatusChip status={jobStatusToPulse[job.status] ?? "offline"} label={String(job.status).replace(/_/g, " ")} />
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
