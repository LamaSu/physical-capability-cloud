import React from "react";
import { useNavigate } from "react-router-dom";
import { classifySettlementRead, statusPillText } from "@pcc/spec";
import { AnimatedNumber, DataCell, EmptyState, GlassPanel, GlowBadge, LoadingShell } from "@pcc/ui";
import { useEscrows, useJobs } from "../api/hooks/use-pcc-data.js";
import { EscrowAmount } from "../components/EscrowAmount.js";
import { SKIPPED_ESCROWS_NOTICE, StaleNotice, UnavailableState } from "../components/ReadState.js";
import { formatCount, isActiveJob, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-list.js";
import { moneyToneColor } from "../lib/money-badge.js";
import { useUIStore } from "../stores/ui-store.js";

const finishedStatuses = new Set(["completed", "failed", "cancelled"]);

export function RevenueDashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((state) => state.setPageMeta);
  React.useEffect(() => { setPageMeta("Revenue Dashboard"); }, [setPageMeta]);
  const jobsQuery = useJobs();
  const escrowsQuery = useEscrows();
  const jobs = jobsQuery.data;
  const escrows = escrowsQuery.data?.items;
  const skipped = escrowsQuery.data?.skipped ?? 0;
  const loading = jobsQuery.isLoading || escrowsQuery.isLoading;
  const retry = () => { void jobsQuery.refetch(); void escrowsQuery.refetch(); };
  const truncated = jobs ? mayBeTruncated(jobs) : false;
  const completed = jobs?.filter((job) => job.status === "completed") ?? [];
  const finished = jobs?.filter((job) => finishedStatuses.has(job.status)).length ?? 0;
  const successRate = finished > 0 && !truncated ? Math.round(completed.length / finished * 1000) / 10 : null;
  const activeEscrows = escrows?.filter((escrow) => escrow.status === "active") ?? [];
  const stale = jobsQuery.isError && escrowsQuery.isError ? "jobs and escrows" : jobsQuery.isError ? "jobs" : escrowsQuery.isError ? "escrows" : null;
  const empty = jobsQuery.isSuccess && escrowsQuery.isSuccess && jobs?.length === 0 && escrows?.length === 0 && skipped === 0;

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/30">Your jobs, and escrows across the network (earnings need settled income, not yet served)</p>
      {loading ? <LoadingShell rows={4} /> : !jobs || !escrows ? (
        <GlassPanel padding="lg"><UnavailableState what={!jobs ? "jobs" : "escrows"} error={!jobs ? jobsQuery.error : escrowsQuery.error} onRetry={retry} /></GlassPanel>
      ) : (
        <>
          {stale && <StaleNotice what={stale} updatedAt={Math.min(jobsQuery.dataUpdatedAt, escrowsQuery.dataUpdatedAt)} onRetry={retry} />}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <GlassPanel padding="md"><DataCell label="Active Jobs" value={truncated ? formatCount(jobs.filter(isActiveJob).length, true) : <AnimatedNumber value={jobs.filter(isActiveJob).length} />} mono /></GlassPanel>
            <GlassPanel padding="md"><DataCell label="Success Rate" value={successRate === null ? "--" : `${successRate}%`} sub={successRate !== null ? "completed of finished jobs" : truncated ? "needs the gateway's job total" : "no finished jobs"} mono /></GlassPanel>
            <GlassPanel padding="md"><DataCell label="Completed" value={truncated ? formatCount(completed.length, true) : <AnimatedNumber value={completed.length} />} sub="total jobs" mono /></GlassPanel>
          </div>
          {empty ? (
            <GlassPanel padding="lg"><EmptyState title="No jobs or escrows yet" description="Jobs and escrows will appear here as work runs. Register a kernel and start accepting jobs." action={{ label: "Onboard Equipment", onClick: () => navigate("/onboard") }} /></GlassPanel>
          ) : (
            <>
              <GlassPanel padding="lg">
                <h2 className="text-sm font-medium text-white/60 mb-4">Active Escrows</h2>
                {skipped > 0 && <p role="status" className="text-xs text-amber-200/70">{SKIPPED_ESCROWS_NOTICE(skipped)}</p>}
                {activeEscrows.length === 0 && skipped === 0 ? <EmptyState title="No active escrows" description="Escrows will appear here when jobs are in progress." /> : (
                  <div className="space-y-3">
                    {activeEscrows.map((escrow) => {
                      const classification = classifySettlementRead(escrow, { path: "/api/escrow", live: true });
                      return (
                        <div key={escrow.id} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                          <div>
                            <span className="text-xs font-mono text-white/60">{escrow.id}</span>
                            <GlowBadge color={moneyToneColor(classification.tone)} className="ml-2">{classification.label ?? statusPillText(escrow.status, false, true)}</GlowBadge>
                          </div>
                          <EscrowAmount amount={escrow.totalAmount} currency={escrow.currency} size="sm" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </GlassPanel>
              <GlassPanel padding="lg">
                <h2 className="text-sm font-medium text-white/60 mb-4">Completed Jobs</h2>
                {completed.length === 0 ? (
                  truncated ? <EmptyState title={`No completed jobs in the first ${JOBS_PAGE_SIZE}`} description={`The gateway returned its first ${JOBS_PAGE_SIZE} jobs and none of them is completed; there may be completed jobs beyond them.`} /> : <EmptyState title="No completed jobs yet" />
                ) : (
                  <div className="space-y-2">
                    {completed.slice(0, 10).map((job) => (
                      <div key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className="flex items-center justify-between py-2 text-xs border-b border-white/[0.03] cursor-pointer hover:bg-white/[0.02]">
                        <span className="text-white/60 font-mono">{job.id}</span>
                        <span className="text-white/30">{job.capabilityType ?? job.capabilityId}</span>
                      </div>
                    ))}
                  </div>
                )}
              </GlassPanel>
            </>
          )}
        </>
      )}
    </div>
  );
}
