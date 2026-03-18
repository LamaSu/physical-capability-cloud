import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel, DataCell, AmountDisplay, StatusChip, ProgressArc,
  EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs, useKernels, useEscrows, useGatewayHealth } from "../api/hooks/use-pcc-data.js";

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

export function DashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Command Center", "System overview and active operations"); }, [setPageMeta]);

  const health = useGatewayHealth();
  const { data: jobs = [], isLoading: jobsLoading } = useJobs();
  const { data: kernels = [], isLoading: kernelsLoading } = useKernels();
  const { data: escrows = [], isLoading: escrowsLoading } = useEscrows();

  const isLoading = jobsLoading || kernelsLoading || escrowsLoading;
  const gatewayOnline = health.data?.status === "ok";

  const onlineKernels = kernels.filter((k: any) => k.status === "online").length;
  const activeJobs = jobs.filter((j: any) => j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled");
  const totalLocked = escrows.reduce((sum: number, e: any) => sum + parseFloat(e.totalAmount || "0"), 0);

  if (isLoading) return <LoadingShell rows={4} />;

  // No gateway, no data — show welcome state
  const isEmpty = !jobs.length && !kernels.length && !escrows.length;

  return (
    <div className="space-y-6">
      {/* Gateway status */}
      {!gatewayOnline && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-white/30">
          <span className="inline-block w-2 h-2 rounded-full bg-white/20" />
          Gateway offline — connect at port 3200 to see live data
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel glow={activeJobs.length > 0 ? "green" : undefined} padding="lg" hover onClick={() => navigate("/jobs")}>
          <DataCell label="Active Jobs" value={activeJobs.length} sub={jobs.length ? `${jobs.filter((j: any) => j.status === "completed").length} completed` : "none yet"} mono />
        </GlassPanel>
        <GlassPanel glow={onlineKernels > 0 ? "green" : undefined} padding="lg" hover onClick={() => navigate("/kernels")}>
          <DataCell label="Kernels Online" value={kernels.length ? `${onlineKernels}/${kernels.length}` : "0"} sub={onlineKernels ? `${onlineKernels} connected` : "none registered"} mono />
        </GlassPanel>
        <GlassPanel glow={totalLocked > 0 ? "green" : undefined} padding="lg" hover onClick={() => navigate("/escrow")}>
          <DataCell label="Total Value Locked" value={<AmountDisplay amount={totalLocked.toFixed(2)} size="md" />} sub={escrows.length ? `across ${escrows.length} escrows` : "no escrows"} />
        </GlassPanel>
        <GlassPanel padding="lg">
          <DataCell label="Evidence Events" value="0" sub="last 24 hours" mono />
        </GlassPanel>
      </div>

      {isEmpty ? (
        /* Welcome state when nothing exists yet */
        <GlassPanel padding="lg">
          <EmptyState
            title="Welcome to PCC"
            description="Your physical capability cloud is ready. Register a kernel, onboard equipment, or discover capabilities to get started."
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
            {activeJobs.length === 0 ? (
              <EmptyState title="No active jobs" description="Submit a job or discover capabilities to get started." />
            ) : (
              <div className="space-y-3">
                {activeJobs.map((job: any) => (
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

          {/* Bottom row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <GlassPanel padding="lg">
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Recent Activity</h2>
              <EmptyState title="No activity yet" description="Activity will appear here as jobs run and evidence is submitted." />
            </GlassPanel>

            <GlassPanel padding="lg">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Escrow Overview</h2>
                <button onClick={() => navigate("/escrow")} className="text-xs text-teal-400/60 hover:text-teal-400/90 transition-colors">
                  View all
                </button>
              </div>
              {escrows.length === 0 ? (
                <EmptyState title="No escrows" description="Escrows are created when jobs are submitted with milestone-based payment." />
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-white/50">Total Locked</span>
                    <AmountDisplay amount={totalLocked.toFixed(2)} size="md" />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-white/50">Active Escrows</span>
                    <span className="text-sm font-mono text-white/70">{escrows.filter((e: any) => e.status === "active").length}</span>
                  </div>
                  <div className="pt-2 border-t border-white/[0.06]">
                    {escrows.map((esc: any) => (
                      <div key={esc.id} className="flex items-center justify-between py-1.5 text-xs">
                        <span className="text-white/40 font-mono">{esc.id}</span>
                        <span className="text-white/30">{esc.status}</span>
                        <AmountDisplay amount={esc.totalAmount ?? "0"} size="sm" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </GlassPanel>
          </div>
        </>
      )}
    </div>
  );
}
