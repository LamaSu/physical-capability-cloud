import React from "react";
import {
  GlassPanel, GlowBadge, DataCell,
  AnimatedNumber, EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs, useEscrows } from "../api/hooks/use-pcc-data.js";
import { useNavigate } from "react-router-dom";
import { JOBS_PAGE_SIZE, formatCount, isActiveJob, mayBeTruncated } from "../lib/live-status.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { EscrowAmount } from "../components/EscrowAmount.js";

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
  // /api/jobs returns one page and no total: a rate over a partial page would be a guess.
  const truncated = mayBeTruncated(jobs);
  const successRate = finishedCount > 0 && !truncated
    ? Math.round((completedJobs.length / finishedCount) * 100 * 10) / 10
    : null;

  const isEmpty = jobs.length === 0 && escrows.length === 0;
  // A failed refresh leaves the last successful read on screen, labelled with its age.
  const staleWhat = jobsQ.isError && escrowsQ.isError ? "jobs and escrows" : jobsQ.isError ? "jobs" : escrowsQ.isError ? "escrows" : null;

  return (
    <div className="space-y-6">
      {staleWhat && (
        <StaleNotice
          what={staleWhat}
          updatedAt={Math.min(jobsQ.dataUpdatedAt, escrowsQ.dataUpdatedAt)}
          onRetry={() => {
            void jobsQ.refetch();
            void escrowsQ.refetch();
          }}
        />
      )}
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Active Jobs" value={truncated ? formatCount(jobs.filter(isActiveJob).length, true) : <AnimatedNumber value={jobs.filter(isActiveJob).length} />} sub="pending, queued, running or paused" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Success Rate"
            value={successRate != null ? `${successRate}%` : "--"}
            sub={successRate != null ? "completed of finished jobs" : truncated ? "needs the gateway's job total" : "no finished jobs"}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Completed" value={truncated ? formatCount(completedJobs.length, true) : <AnimatedNumber value={completedJobs.length} />} sub="total jobs" mono />
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
                    <EscrowAmount amount={esc.totalAmount} currency={esc.currency} size="sm" />
                  </div>
                ))}
              </div>
            )}
          </GlassPanel>

          {/* Completed Jobs */}
          <GlassPanel padding="lg">
            <h2 className="text-sm font-medium text-white/60 mb-4">Completed Jobs</h2>
            {completedJobs.length === 0 ? (
              truncated ? (
                // One page was read: none completed in it is not none completed at all (astra 18b F5).
                <EmptyState
                  title={`No completed jobs in the first ${JOBS_PAGE_SIZE}`}
                  description={`The gateway returned its first ${JOBS_PAGE_SIZE} jobs and none of them is completed; there may be completed jobs beyond them.`}
                />
              ) : (
                <EmptyState title="No completed jobs yet" />
              )
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
