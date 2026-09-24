import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel, DataCell, AmountDisplay, StatusChip, ProgressArc,
  EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs, useKernels, useEscrows, useGatewayHealth, useProductHome } from "../api/hooks/use-pcc-data.js";
import { isActiveJob, JOBS_PAGE_SIZE, mayBeTruncated } from "../lib/live-status.js";
import { readSection, sectionReason } from "../lib/product-home.js";
import { UnavailableState } from "../components/LiveState.js";

/** Canonical job statuses (types/dto.ts StepStatus) to a pulse; the label always carries the status text. */
const jobStatusToPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  pending: "online",
  queued: "online",
  in_progress: "executing",
  paused: "offline",
  completed: "completed",
  failed: "failed",
  cancelled: "offline",
};

/** A KPI value whose read failed is shown as unavailable, never as 0. */
function Unavailable({ reason }: { reason?: string | null }) {
  return <span className="text-white/40" title={reason ?? "Couldn't load this from the gateway"}>—</span>;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Command Center", "System overview and active operations"); }, [setPageMeta]);

  const health = useGatewayHealth();
  const jobsQ = useJobs();
  const kernelsQ = useKernels();
  const escrowsQ = useEscrows();
  // The KPI figures: counted by the gateway over its own records (readmodels #409).
  const homeQ = useProductHome();

  if (jobsQ.isLoading || kernelsQ.isLoading || escrowsQ.isLoading || homeQ.isLoading) return <LoadingShell rows={4} />;

  // A summary shows only what its latest read returned: after a failed refresh a
  // figure is unavailable ("—"), not its last-known value presented as current.
  const jobs = jobsQ.isError ? undefined : jobsQ.data;
  const kernels = kernelsQ.isError ? undefined : kernelsQ.data;
  const escrows = escrowsQ.isError ? undefined : escrowsQ.data;
  const home = homeQ.isError ? undefined : homeQ.data;

  // Nothing could be read: say so instead of rendering zeros.
  if (!jobs && !kernels && !escrows && !home) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState
          what="the Command Center"
          error={homeQ.error ?? jobsQ.error ?? kernelsQ.error ?? escrowsQ.error}
          onRetry={() => {
            void homeQ.refetch();
            void jobsQ.refetch();
            void kernelsQ.refetch();
            void escrowsQ.refetch();
          }}
        />
      </GlassPanel>
    );
  }

  const gatewayDown = health.isError || (health.isSuccess && health.data?.status !== "ok");
  const anyReadFailed = homeQ.isError || jobsQ.isError || kernelsQ.isError || escrowsQ.isError;

  const homeJobs = readSection(home?.jobs);
  const homeKernels = readSection(home?.kernels);
  const homeCapabilities = readSection(home?.capabilities);
  const held = readSection(home?.escrowHeld);
  const activeJobs = jobs?.filter(isActiveJob);
  // /api/jobs returns one page and no total: the list below may be cut short.
  const jobsTruncated = jobs ? mayBeTruncated(jobs) : false;

  // "Nothing yet" only when every read succeeded and came back empty.
  const isEmpty =
    jobsQ.isSuccess && kernelsQ.isSuccess && escrowsQ.isSuccess &&
    !jobs?.length && !kernels?.length && !escrows?.length;

  return (
    <div className="space-y-6">
      {(gatewayDown || anyReadFailed) && (
        <div
          role="status"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-200/70"
        >
          <span className="font-semibold uppercase tracking-wider text-amber-300/80">Unavailable</span>
          {gatewayDown
            ? "Can't reach the PCC gateway. Figures that couldn't be loaded show as —, not zero."
            : "Some live data couldn't be loaded. Those figures show as —, not zero."}
        </div>
      )}

      {/* KPI Row: ProductHomeDTO, counted by the gateway over its own records */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <GlassPanel glow={homeJobs?.active ? "green" : undefined} padding="lg" hover onClick={() => navigate("/jobs")}>
          <DataCell
            label="Active Jobs"
            value={homeJobs ? homeJobs.active : <Unavailable reason={sectionReason(home?.jobs)} />}
            sub={homeJobs ? `of ${homeJobs.total} in all` : (sectionReason(home?.jobs) ?? "unavailable")}
            mono
          />
        </GlassPanel>
        <GlassPanel glow={homeKernels?.online ? "green" : undefined} padding="lg" hover onClick={() => navigate("/kernels")}>
          <DataCell
            label="Kernels Online"
            value={homeKernels ? `${homeKernels.online}/${homeKernels.total}` : <Unavailable reason={sectionReason(home?.kernels)} />}
            sub={
              homeKernels
                ? homeKernels.total
                  ? `${homeKernels.stale} with a stale heartbeat, ${homeKernels.other} not online`
                  : "none registered"
                : (sectionReason(home?.kernels) ?? "unavailable")
            }
            mono
          />
        </GlassPanel>
        <GlassPanel padding="lg" hover onClick={() => navigate("/discover")}>
          <DataCell
            label="Capabilities Listed"
            value={homeCapabilities ? homeCapabilities.total : <Unavailable reason={sectionReason(home?.capabilities)} />}
            sub={
              homeCapabilities
                ? `${homeCapabilities.onOnlineKernels} on an online kernel. A listing is not a promise of capacity.`
                : (sectionReason(home?.capabilities) ?? "unavailable")
            }
            mono
          />
        </GlassPanel>
        <GlassPanel padding="lg" hover onClick={() => navigate("/escrow")}>
          <DataCell
            label="Held in Escrow"
            value={
              held ? (
                held.byCurrency.length ? (
                  <span className="flex flex-col gap-1">
                    {held.byCurrency.map((h) => (
                      <AmountDisplay key={h.currency} amount={h.amountBaseUnits} decimals={h.decimals} currency={h.currency} size="md" />
                    ))}
                  </span>
                ) : (
                  "None held"
                )
              ) : (
                <Unavailable reason={sectionReason(home?.escrowHeld)} />
              )
            }
            sub={
              held
                ? [
                    "From escrow records; no chain read confirms it.",
                    held.uncountedMilestones ? `${held.uncountedMilestones} held milestone(s) couldn't be counted exactly.` : "",
                    held.unclassifiedMilestones ? `${held.unclassifiedMilestones} milestone(s) have a status this total doesn't recognise.` : "",
                    held.excludedSimulatedEscrows ? `${held.excludedSimulatedEscrows} simulated escrow(s) left out.` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : (sectionReason(home?.escrowHeld) ?? "unavailable")
            }
          />
        </GlassPanel>
      </div>

      {isEmpty ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="Nothing running yet"
            description="This gateway has no kernels, jobs or escrows. Onboard equipment or discover capabilities to get started."
            action={{ label: "Onboard Equipment", onClick: () => navigate("/onboard") }}
          />
        </GlassPanel>
      ) : (
        <>
          {/* Active Jobs List */}
          <GlassPanel padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Active Jobs</h2>
              <button onClick={() => navigate("/jobs")} className="text-xs text-teal-400/60 hover:text-teal-400/90 transition-colors">
                View all
              </button>
            </div>
            {!activeJobs ? (
              <UnavailableState what="jobs" error={jobsQ.error} onRetry={() => void jobsQ.refetch()} />
            ) : activeJobs.length === 0 ? (
              <EmptyState title="No active jobs" description="Submit a job or discover capabilities to get started." />
            ) : (
              <div className="space-y-3">
                {jobsTruncated && (
                  <p className="text-xs text-white/35">
                    Active jobs among the first {JOBS_PAGE_SIZE} the gateway returned; there may be more.
                  </p>
                )}
                {activeJobs.map((job) => (
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

          <GlassPanel padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Escrows</h2>
              <button onClick={() => navigate("/escrow")} className="text-xs text-teal-400/60 hover:text-teal-400/90 transition-colors">
                View all
              </button>
            </div>
            {!escrows ? (
              <UnavailableState what="escrows" error={escrowsQ.error} onRetry={() => void escrowsQ.refetch()} />
            ) : escrows.length === 0 ? (
              <EmptyState title="No escrows" description="Escrows are created when jobs are submitted with milestone-based payment." />
            ) : (
              <div className="space-y-1">
                {escrows.map((esc) => (
                  <div key={esc.id} className="flex items-center justify-between py-1.5 text-xs gap-4">
                    <span className="text-white/40 font-mono truncate">{esc.id}</span>
                    <span className="text-white/50">{esc.status}</span>
                    {esc.totalAmount != null ? <AmountDisplay amount={esc.totalAmount} size="sm" /> : <Unavailable />}
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
