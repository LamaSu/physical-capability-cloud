import React from "react";
import { useNavigate } from "react-router-dom";
import { DataCell, EmptyState, GlassPanel, LoadingShell, ProgressArc, StatusChip } from "@pcc/ui";
import { useJobs } from "../api/hooks/use-pcc-data.js";
import { StaleNotice, UnavailableState } from "../components/ReadState.js";
import { formatCount, isActiveJob, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-list.js";
import { useUIStore } from "../stores/ui-store.js";

const jobPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  pending: "online", queued: "online", in_progress: "executing", executing: "executing",
  preparing: "executing", collecting_evidence: "executing", awaiting_pickup: "executing",
  evidence_stored: "executing", evidence_submitted: "executing", active: "executing",
  paused: "offline", completed: "completed", settled: "completed", failed: "failed", cancelled: "offline",
};

export function JobsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((state) => state.setPageMeta);
  React.useEffect(() => { setPageMeta("Jobs", "Active and completed jobs"); }, [setPageMeta]);
  const query = useJobs();
  const [filter, setFilter] = React.useState<"all" | "active" | "completed">("all");
  if (query.isLoading) return <LoadingShell rows={5} />;
  const jobs = query.data;
  if (!jobs) return <GlassPanel padding="lg"><UnavailableState what="jobs" error={query.error} onRetry={() => void query.refetch()} /></GlassPanel>;

  const truncated = mayBeTruncated(jobs);
  const active = jobs.filter(isActiveJob);
  const completed = jobs.filter((job) => job.status === "completed");
  const filtered = filter === "all" ? jobs : filter === "active" ? active : completed;
  return (
    <div className="space-y-6">
      {query.isError && <StaleNotice what="jobs" updatedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} />}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Total Jobs" value={formatCount(jobs.length, truncated)} mono /></GlassPanel>
        <GlassPanel padding="md" glow={active.length ? "green" : undefined}><DataCell label="Active" value={formatCount(active.length, truncated)} mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Completed" value={formatCount(completed.length, truncated)} mono /></GlassPanel>
      </div>
      <GlassPanel padding="lg">
        <div className="flex gap-2 mb-4">
          {(["all", "active", "completed"] as const).map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={`px-3 py-1 text-xs rounded-md capitalize transition-all ${filter === value ? "bg-teal-400/20 text-teal-400 border border-teal-400/30" : "text-white/30 hover:text-white/50"}`}>{value}</button>
          ))}
        </div>
        {truncated && <p className="text-xs text-white/35 mb-3">Showing the first {JOBS_PAGE_SIZE} jobs the gateway returned; there may be more.</p>}
        {filtered.length === 0 ? (
          <EmptyState
            title={jobs.length === 0 ? "No jobs yet" : truncated ? `No ${filter} jobs in the first ${JOBS_PAGE_SIZE}` : `No ${filter} jobs`}
            description={jobs.length === 0 ? "Jobs will appear here when you submit a workflow or capability request." : truncated ? `Only the first ${JOBS_PAGE_SIZE} jobs were read; there may be ${filter} jobs beyond them.` : undefined}
            action={jobs.length === 0 ? { label: "Discover Capabilities", onClick: () => navigate("/discover") } : undefined}
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((job) => (
              <div key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors">
                {typeof job.progress === "number" && <ProgressArc progress={job.progress} size={40} />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate font-mono">{job.id}</div>
                  <div className="text-xs text-white/30 truncate">{[job.capabilityType ?? job.capabilityId, job.kernelName].filter(Boolean).join(" · ")}</div>
                </div>
                <StatusChip status={jobPulse[job.status] ?? "offline"} label={String(job.status).replace(/_/g, " ")} />
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
