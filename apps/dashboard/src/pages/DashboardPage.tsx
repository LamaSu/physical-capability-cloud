import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, DataCell, PulseIndicator, AmountDisplay, StatusChip, ProgressArc } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockKernels, mockJobs, jobMeta, mockEscrows } from "../api/mock-data.js";

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

  const onlineKernels = mockKernels.filter((k) => k.status === "online").length;
  const activeJobs = mockJobs.filter((j) => j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled").length;
  const totalLocked = mockEscrows.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0);
  const completedJobs = mockJobs.filter((j) => j.status === "completed").length;

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel glow="green" padding="lg" hover onClick={() => navigate("/jobs")}>
          <DataCell label="Active Jobs" value={activeJobs} sub={`${completedJobs} completed today`} mono />
        </GlassPanel>
        <GlassPanel glow="green" padding="lg" hover onClick={() => navigate("/kernels")}>
          <DataCell label="Kernels Online" value={`${onlineKernels}/${mockKernels.length}`} sub={mockKernels.filter((k) => k.status === "online").map((k) => k.name).join(", ")} mono />
        </GlassPanel>
        <GlassPanel glow="green" padding="lg" hover onClick={() => navigate("/escrow")}>
          <DataCell label="Total Value Locked" value={<AmountDisplay amount={totalLocked.toFixed(2)} size="md" />} sub={`across ${mockEscrows.length} escrows`} />
        </GlassPanel>
        <GlassPanel glow="green" padding="lg">
          <DataCell label="Evidence Events" value="127" sub="last 24 hours" mono />
        </GlassPanel>
      </div>

      {/* Active Jobs List */}
      <GlassPanel padding="lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Active Jobs</h2>
          <button onClick={() => navigate("/jobs")} className="text-xs text-green-400/60 hover:text-green-400/90 transition-colors">
            View all →
          </button>
        </div>
        <div className="space-y-3">
          {mockJobs.map((job) => {
            const meta = jobMeta[job.id];
            return (
              <div
                key={job.id}
                onClick={() => navigate(`/jobs/${job.id}`)}
                className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
              >
                <ProgressArc progress={job.progress} size={40} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate">{meta?.name ?? job.id}</div>
                  <div className="text-xs text-white/30 font-mono">{meta?.kernelName ?? job.capabilityId}</div>
                </div>
                <AmountDisplay amount={meta?.amount ?? "0"} size="sm" />
                <StatusChip status={jobStatusToPulse[job.status] ?? "offline"} label={job.status.replace("_", " ")} />
              </div>
            );
          })}
        </div>
      </GlassPanel>

      {/* Bottom row */}
      <div className="grid grid-cols-2 gap-4">
        <GlassPanel padding="lg">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Recent Activity</h2>
          <div className="space-y-2.5 text-sm">
            {[
              { time: "14:32", text: "Evidence submitted: HPLC chromatogram bundle for NVX-7", color: "text-green-400/70" },
              { time: "14:28", text: "Milestone funded: PCR analysis ($45 USDC locked)", color: "text-gold-300/70" },
              { time: "14:15", text: "Kernel heartbeat: NeuroLab SOMA", color: "text-green-400/50" },
              { time: "14:02", text: "Workflow compiled: Compound purity pipeline", color: "text-green-400/70" },
              { time: "13:48", text: "Quote received: BioAnalytica \u2014 $65/HPLC run", color: "text-white/40" },
              { time: "13:30", text: "New kernel registered: Frontier Tower 4F Lab", color: "text-green-400/50" },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className={`font-mono text-xs ${item.color} w-10 flex-shrink-0`}>{item.time}</span>
                <span className="text-white/50 text-xs">{item.text}</span>
              </div>
            ))}
          </div>
        </GlassPanel>

        <GlassPanel padding="lg">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Escrow Overview</h2>
            <button onClick={() => navigate("/escrow")} className="text-xs text-green-400/60 hover:text-green-400/90 transition-colors">
              View all →
            </button>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/50">Total Locked</span>
              <AmountDisplay amount={totalLocked.toFixed(2)} size="md" />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/50">Active Escrows</span>
              <span className="text-sm font-mono text-white/70">{mockEscrows.filter((e) => e.status === "active").length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/50">Challenge Windows</span>
              <span className="text-sm font-mono text-gold-300">
                {mockEscrows.flatMap((e) => e.milestones).filter((m) => m.status === "releasing").length} active
              </span>
            </div>
            <div className="pt-2 border-t border-white/[0.06]">
              {mockEscrows.map((esc) => (
                <div key={esc.id} className="flex items-center justify-between py-1.5 text-xs">
                  <span className="text-white/40 font-mono">{esc.id}</span>
                  <span className={`${esc.status === "active" ? "text-gold-300/60" : "text-white/30"}`}>{esc.status}</span>
                  <AmountDisplay amount={esc.totalAmount} size="sm" />
                </div>
              ))}
            </div>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}
