import React from "react";
import {
  GlassPanel, GlowBadge, DataCell, AmountDisplay, TierBadge,
  AnimatedNumber, EmptyState, LoadingShell, type EarningsPeriod,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useJobs, useEscrows } from "../api/hooks/use-pcc-data.js";
import { useNavigate } from "react-router-dom";

export function RevenueDashboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Revenue Dashboard", "Operator earnings, capabilities, and reputation"); }, [setPageMeta]);

  const { data: jobs = [], isLoading: jobsLoading } = useJobs();
  const { data: escrows = [], isLoading: escrowsLoading } = useEscrows();

  if (jobsLoading || escrowsLoading) return <LoadingShell rows={4} />;

  const completedJobs = jobs.filter((j: any) => j.status === "completed");
  const activeEscrows = escrows.filter((e: any) => e.status === "active");
  const totalRevenue = completedJobs.reduce((s: number, j: any) => s + parseFloat(j.amount || "0"), 0);
  const successRate = jobs.length > 0
    ? Math.round((completedJobs.length / jobs.length) * 100 * 10) / 10
    : 0;

  const isEmpty = jobs.length === 0 && escrows.length === 0;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" glow={totalRevenue > 0 ? "green" : undefined}>
          <DataCell label="Total Revenue" value={<AmountDisplay amount={totalRevenue.toFixed(2)} size="md" />} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Jobs" value={<AnimatedNumber value={jobs.filter((j: any) => !["completed", "failed", "cancelled"].includes(j.status)).length} />} sub="currently processing" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Success Rate" value={jobs.length > 0 ? `${successRate}%` : "--"} sub={jobs.length > 0 ? "all time" : "no data"} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Completed" value={<AnimatedNumber value={completedJobs.length} />} sub="total jobs" mono />
        </GlassPanel>
      </div>

      {isEmpty ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No revenue data yet"
            description="Revenue will be tracked here as jobs complete and escrow funds are released. Register a kernel and start accepting jobs to see earnings."
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
                {activeEscrows.map((esc: any) => (
                  <div key={esc.id} className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                    <div>
                      <span className="text-xs font-mono text-white/60">{esc.id}</span>
                      <GlowBadge color="gold" className="ml-2">{esc.status}</GlowBadge>
                    </div>
                    <AmountDisplay amount={esc.totalAmount ?? "0"} size="sm" />
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
                {completedJobs.slice(0, 10).map((job: any) => (
                  <div key={job.id} className="flex items-center justify-between py-2 text-xs border-b border-white/[0.03]">
                    <span className="text-white/60">{job.name ?? job.id}</span>
                    <AmountDisplay amount={job.amount ?? "0"} size="sm" />
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
