import React from "react";
import {
  GlassPanel, GlowBadge, DataCell, AmountDisplay,
  AnimatedNumber, EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs, useEscrows } from "../api/hooks/use-pcc-data.js";
import { useNavigate } from "react-router-dom";
import { isActiveJob } from "../lib/live-status.js";
import { UnavailableState } from "../components/LiveState.js";

const FINISHED = new Set(["completed", "failed", "cancelled"]);

/**
 * Revenue shows job and escrow counts only. It shows no earnings figure:
 * a job reaching "completed" is not a payment, and no read model serves
 * settled operator income yet. Summing job amounts would present completion
 * as payment.
 */
export function RevenueDashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Revenue Dashboard", "Jobs and escrows across the network (earnings need settled income, not yet served)"); }, [setPageMeta]);

  const jobsQ = useJobs();
  const escrowsQ = useEscrows();

  if (jobsQ.isLoading || escrowsQ.isLoading) return <LoadingShell rows={4} />;

  const jobs = jobsQ.data;
  const escrows = escrowsQ.data;
  if (!jobs || !escrows) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState
          what={!jobs ? "jobs" : "escrows"}
          error={jobsQ.error ?? escrowsQ.error}
          onRetry={() => {
            void jobsQ.refetch();
            void escrowsQ.refetch();
          }}
        />
      </GlassPanel>
    );
  }

  const completedJobs = jobs.filter((j) => j.status === "completed");
  const finishedCount = jobs.filter((j) => FINISHED.has(j.status)).length;
  const activeEscrows = escrows.filter((e) => e.status === "active");
  const successRate = finishedCount > 0
    ? Math.round((completedJobs.length / finishedCount) * 100 * 10) / 10
    : null;

  const isEmpty = jobs.length === 0 && escrows.length === 0;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Active Jobs" value={<AnimatedNumber value={jobs.filter(isActiveJob).length} />} sub="pending, queued, running or paused" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Success Rate" value={successRate != null ? `${successRate}%` : "--"} sub={successRate != null ? "completed of finished jobs" : "no finished jobs"} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Completed" value={<AnimatedNumber value={completedJobs.length} />} sub="total jobs" mono />
        </GlassPanel>
      </div>

      {isEmpty ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No jobs or escrows yet"
            description="Jobs and escrows will appear here as work runs. Register a kernel and start accepting jobs."
            action={{ label: "Onboard Equipment", onClick: () => navigate("/onboard") }}
          />
        </GlassPanel>
      ) : (
        <>
          {/* Active Escrows */}
          <GlassPanel padding="lg">
            <h2 className="text-sm font-medium text-white/60 mb-4">Active Escrows</h2>
            {activeEscrows.length === 0 ? (
              <EmptyState title="No active escrows" description="Escrows will appear here when jobs are in progress." />
            ) : (
              <div className="space-y-3">
                {activeEscrows.map((esc) => (
                  <div key={esc.id} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                    <div>
                      <span className="text-xs font-mono text-white/60">{esc.id}</span>
                      <GlowBadge color="gold" className="ml-2">{esc.status}</GlowBadge>
                    </div>
                    {esc.totalAmount != null ? <AmountDisplay amount={esc.totalAmount} size="sm" /> : <span className="text-white/40">—</span>}
                  </div>
                ))}
              </div>
            )}
          </GlassPanel>

          {/* Completed Jobs */}
          <GlassPanel padding="lg">
            <h2 className="text-sm font-medium text-white/60 mb-4">Completed Jobs</h2>
            {completedJobs.length === 0 ? (
              <EmptyState title="No completed jobs yet" />
            ) : (
              <div className="space-y-2">
                {completedJobs.slice(0, 10).map((job) => (
                  <div
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="flex items-center justify-between py-2 text-xs border-b border-white/[0.03] cursor-pointer hover:bg-white/[0.02]"
                  >
                    <span className="text-white/60 font-mono">{job.id}</span>
                    <span className="text-white/30">{job.capabilityType ?? job.capabilityId}</span>
                  </div>
                ))}
              </div>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}
