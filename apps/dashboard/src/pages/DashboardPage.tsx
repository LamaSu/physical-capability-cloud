import React from "react";
import { useNavigate } from "react-router-dom";
import { classifySettlementRead, statusPillText } from "@pcc/spec";
import { AmountDisplay, DataCell, EmptyState, GlassPanel, GlowBadge, LoadingShell, ProgressArc, StatusChip } from "@pcc/ui";
import { useEscrows, useGatewayHealth, useJobs, useKernels, useProductHome } from "../api/hooks/use-pcc-data.js";
import { EscrowAmount } from "../components/EscrowAmount.js";
import { SKIPPED_ESCROWS_NOTICE, UnavailableState } from "../components/ReadState.js";
import { formatCount, isActiveJob, isKernelOnline, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-list.js";
import { moneyToneColor } from "../lib/money-badge.js";
import { useUIStore } from "../stores/ui-store.js";

const jobPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  pending: "online", queued: "online", in_progress: "executing", executing: "executing",
  preparing: "executing", collecting_evidence: "executing", awaiting_pickup: "executing",
  evidence_stored: "executing", evidence_submitted: "executing", active: "executing",
  paused: "offline", completed: "completed", settled: "completed", failed: "failed", cancelled: "offline",
};

function UnavailableFigure() {
  return <span className="text-white/40" title="Couldn't load this from the gateway">—</span>;
}

function HeldInEscrow() {
  const query = useProductHome();
  // A failed refresh invalidates this figure, including any previously read amount.
  const held = query.isError ? undefined : query.data?.escrowHeld;
  return (
    <GlassPanel padding="lg">
      <div className="space-y-2">
        <div className="text-xs text-white/40 uppercase tracking-wider font-medium">Held in escrow (all accounts)</div>
        {query.isLoading ? <LoadingShell rows={1} /> : !held || held.state === "unavailable" ? (
          <UnavailableState what="escrows" error={held?.state === "unavailable" ? held.reason : undefined} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <div className="space-y-1">
              {held.byCurrency.length ? held.byCurrency.map((entry) => (
                <div key={entry.currency}><AmountDisplay amount={entry.amountBaseUnits} decimals={entry.decimals} currency={entry.currency} size="md" /></div>
              )) : <span className="text-lg text-white/70">{held.uncountedMilestones === 0 && held.unclassifiedMilestones === 0 && held.releaseDecided.byCurrency.length === 0 ? "None held" : "—"}</span>}
            </div>
            {held.releaseDecided.byCurrency.map((entry) => (
              <p key={entry.currency} className="text-xs text-white/40">
                at most <AmountDisplay amount={entry.amountBaseUnits} decimals={entry.decimals} currency={entry.currency} size="sm" />, release decided, payout not finished
              </p>
            ))}
            {held.uncountedMilestones > 0 && <p className="text-xs text-white/30">{held.uncountedMilestones} milestone(s) couldn't be added to these figures.</p>}
            {held.unclassifiedMilestones > 0 && <p className="text-xs text-white/30">{held.unclassifiedMilestones} milestone(s) couldn't be classified from the records, so they aren't counted.</p>}
            {held.excludedSimulatedEscrows > 0 && <p className="text-xs text-white/30">{held.excludedSimulatedEscrows} simulated escrow(s) left out.</p>}
          </>
        )}
        <p className="text-xs text-white/30">From escrow records for every account; no chain read confirms it.</p>
      </div>
    </GlassPanel>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((state) => state.setPageMeta);
  React.useEffect(() => { setPageMeta("Command Center", "System overview and active operations"); }, [setPageMeta]);
  const health = useGatewayHealth();
  const jobsQuery = useJobs();
  const kernelsQuery = useKernels();
  const escrowsQuery = useEscrows();
  if (jobsQuery.isLoading || kernelsQuery.isLoading || escrowsQuery.isLoading) return <LoadingShell rows={4} />;

  const jobs = jobsQuery.isError ? undefined : jobsQuery.data;
  const kernels = kernelsQuery.isError ? undefined : kernelsQuery.data;
  const escrows = escrowsQuery.isError ? undefined : escrowsQuery.data?.items;
  const skipped = escrowsQuery.data?.skipped ?? 0;
  const retry = () => { void jobsQuery.refetch(); void kernelsQuery.refetch(); void escrowsQuery.refetch(); };
  if (!jobs && !kernels && !escrows) {
    return <GlassPanel padding="lg"><UnavailableState what="the Command Center" error={jobsQuery.error ?? kernelsQuery.error ?? escrowsQuery.error} onRetry={retry} /></GlassPanel>;
  }
  const gatewayDown = health.isError || (health.isSuccess && health.data?.status !== "ok");
  const partialFailure = jobsQuery.isError || kernelsQuery.isError || escrowsQuery.isError;
  const online = kernels?.filter(isKernelOnline).length;
  const activeJobs = jobs?.filter(isActiveJob);
  const truncated = jobs ? mayBeTruncated(jobs) : false;
  const empty = jobsQuery.isSuccess && kernelsQuery.isSuccess && escrowsQuery.isSuccess && !jobs?.length && !kernels?.length && !escrows?.length && skipped === 0;

  return (
    <div className="space-y-6">
      {(gatewayDown || partialFailure) && (
        <div role="status" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-200/70">
          <span className="font-semibold uppercase tracking-wider text-amber-300/80">Unavailable</span>
          {gatewayDown ? "Can't reach the PCC gateway. Figures that couldn't be loaded show as —, not zero." : "Some live data couldn't be loaded. Those figures show as —, not zero."}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <GlassPanel padding="lg" hover glow={activeJobs?.length ? "green" : undefined} onClick={() => navigate("/jobs")}>
          <DataCell label="Active Jobs" value={activeJobs ? formatCount(activeJobs.length, truncated) : <UnavailableFigure />} sub={jobs ? jobs.length ? `${formatCount(jobs.filter((job) => job.status === "completed").length, truncated)} completed` : "none yet" : "unavailable"} mono />
          <p className="text-xs text-white/30">Your account's jobs, as the gateway records them.</p>
        </GlassPanel>
        <GlassPanel padding="lg" hover glow={online ? "green" : undefined} onClick={() => navigate("/kernels")}>
          <DataCell label="Kernels Online" value={kernels ? `${online}/${kernels.length}` : <UnavailableFigure />} sub={kernels ? kernels.length ? `${online} with a fresh heartbeat` : "none registered" : "unavailable"} mono />
          <p className="text-xs text-white/30">Every account's kernels, as the gateway records them.</p>
        </GlassPanel>
        <HeldInEscrow />
        <GlassPanel padding="lg" hover onClick={() => navigate("/escrow")}>
          <DataCell label="Escrows" value={escrows ? formatCount(escrows.length, skipped > 0) : <UnavailableFigure />} sub={escrows ? "open the list for each escrow's state" : "unavailable"} mono />
          <p className="text-xs text-white/30">Every account's escrows, as the gateway records them.</p>
        </GlassPanel>
      </div>
      {empty ? (
        <GlassPanel padding="lg"><EmptyState title="Nothing running yet" description="This gateway has no kernels, jobs or escrows. Onboard equipment or discover capabilities to get started." action={{ label: "Onboard Equipment", onClick: () => navigate("/onboard") }} /></GlassPanel>
      ) : (
        <>
          <GlassPanel padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Active Jobs</h2>
              <button className="text-xs text-teal-400/60 hover:text-teal-400/90" onClick={() => navigate("/jobs")}>View all</button>
            </div>
            {!activeJobs ? <UnavailableState what="jobs" error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} /> : activeJobs.length === 0 ? (
              truncated ? <EmptyState title={`No active jobs in the first ${JOBS_PAGE_SIZE}`} description={`The gateway returned its first ${JOBS_PAGE_SIZE} jobs and none of them is active; there may be active jobs beyond them.`} /> : <EmptyState title="No active jobs" description="Submit a job or discover capabilities to get started." />
            ) : (
              <div className="space-y-3">
                {truncated && <p className="text-xs text-white/35">Active jobs among the first {JOBS_PAGE_SIZE} the gateway returned; there may be more.</p>}
                {activeJobs.map((job) => (
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
          <GlassPanel padding="lg">
            <p className="text-xs text-white/30">Every account's escrows, as the gateway records them.</p>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Escrows</h2>
              <button className="text-xs text-teal-400/60 hover:text-teal-400/90" onClick={() => navigate("/escrow")}>View all</button>
            </div>
            {escrows && skipped > 0 && <p role="status" className="text-xs text-amber-200/70">{SKIPPED_ESCROWS_NOTICE(skipped)}</p>}
            {!escrows ? <UnavailableState what="escrows" error={escrowsQuery.error} onRetry={() => void escrowsQuery.refetch()} /> : escrows.length === 0 && skipped === 0 ? (
              <EmptyState title="No escrows" description="Escrows are created when jobs are submitted with milestone-based payment." />
            ) : (
              <div className="space-y-1">
                {escrows.map((escrow) => {
                  const classification = classifySettlementRead(escrow, { path: "/api/escrow", live: true });
                  return (
                    <div key={escrow.id} className="flex items-center justify-between py-1.5 text-xs gap-4">
                      <span className="text-white/40 font-mono truncate">{escrow.id}</span>
                      <GlowBadge color={moneyToneColor(classification.tone)}>{classification.label ?? statusPillText(escrow.status, false, true)}</GlowBadge>
                      <EscrowAmount amount={escrow.totalAmount} currency={escrow.currency} size="sm" />
                    </div>
                  );
                })}
              </div>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}
