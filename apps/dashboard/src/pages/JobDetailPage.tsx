import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  GlassPanel, StatusChip, AmountDisplay, TierBadge, ProgressArc,
  DataCell, HashDisplay, AddressDisplay, EvidenceTimeline, TierRequirementsList,
  MilestoneTimeline,
} from "@pcc/ui";
import type { EvidenceEvent, AssuranceTier } from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { mockJobs, jobMeta, mockEscrows } from "../api/mock-data.js";

// Mock evidence events for the detail view
const mockEvidence: EvidenceEvent[] = [
  { id: "ev-1", type: "gcode_received", timestamp: "2026-03-03T13:00:01Z", source: { deviceId: "dev-prusa", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { fileSize: 1240000 }, hash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as `sha256:${string}` },
  { id: "ev-2", type: "gcode_hash_verified", timestamp: "2026-03-03T13:00:02Z", source: { deviceId: "dev-prusa", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { match: true }, hash: "sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3" as `sha256:${string}` },
  { id: "ev-3", type: "execution_started", timestamp: "2026-03-03T13:00:05Z", source: { deviceId: "dev-prusa", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { estimatedMinutes: 180 }, hash: "sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" as `sha256:${string}` },
  { id: "ev-4", type: "power_profile_sample", timestamp: "2026-03-03T13:30:00Z", source: { deviceId: "dev-power", deviceType: "power_monitor", kernelId: "kernel-nyc" }, payload: { watts: 125, duration: 1800 }, hash: "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5" as `sha256:${string}` },
  { id: "ev-5", type: "camera_snapshot", timestamp: "2026-03-03T14:00:00Z", source: { deviceId: "dev-cam-1", deviceType: "camera", kernelId: "kernel-nyc" }, payload: { resolution: "1920x1080" }, hash: "sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6" as `sha256:${string}` },
  { id: "ev-6", type: "execution_progress", timestamp: "2026-03-03T14:30:00Z", source: { deviceId: "dev-prusa", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { progress: 67, layer: 134, totalLayers: 200 }, hash: "sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1" as `sha256:${string}` },
];

const jobStatusToPulse: Record<string, "online" | "executing" | "completed" | "failed" | "offline"> = {
  queued: "online",
  preparing: "executing",
  executing: "executing",
  collecting_evidence: "executing",
  completed: "completed",
  failed: "failed",
  cancelled: "offline",
};

export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const job = mockJobs.find((j) => j.id === jobId);
  const meta = jobId ? jobMeta[jobId] : undefined;
  const escrow = mockEscrows.find((e) => e.milestones.some((m) => m.stepId === job?.stepId));

  React.useEffect(() => {
    setPageMeta(meta?.name ?? `Job ${jobId}`, "Job progress, evidence, and escrow details");
  }, [setPageMeta, meta, jobId]);

  if (!job) {
    return (
      <GlassPanel padding="lg">
        <div className="text-center py-8 text-white/40">
          Job not found
          <button onClick={() => navigate("/jobs")} className="block mx-auto mt-2 text-green-400/70 text-sm">← Back to jobs</button>
        </div>
      </GlassPanel>
    );
  }

  const tierReqs = meta ? DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === meta.tier) : undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate("/jobs")} className="text-xs text-white/30 hover:text-white/50 mb-2">← Back to jobs</button>
          <h2 className="text-xl font-semibold text-white/90">{meta?.name ?? job.id}</h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-white/30 font-mono">{job.id}</span>
            {meta && <TierBadge tier={meta.tier} />}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {meta && <AmountDisplay amount={meta.amount} size="lg" glow />}
          <StatusChip status={jobStatusToPulse[job.status] ?? "offline"} label={job.status.replace(/_/g, " ")} />
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Progress" value={<ProgressArc progress={job.progress} size={56} />} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Kernel" value={meta?.kernelName ?? job.capabilityId} sub={job.capabilityId} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Evidence Events" value={mockEvidence.length} sub={`${mockEvidence.length} collected`} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Started" value={job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : "Pending"} mono />
        </GlassPanel>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Evidence Timeline */}
        <div className="col-span-2 space-y-4">
          <GlassPanel padding="lg">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Evidence Timeline</h3>
            <EvidenceTimeline events={mockEvidence} />
          </GlassPanel>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Tier Requirements */}
          {tierReqs && (
            <GlassPanel padding="md">
              <TierRequirementsList requirements={tierReqs} events={mockEvidence} />
            </GlassPanel>
          )}

          {/* Escrow milestone */}
          {escrow && (
            <GlassPanel padding="md">
              <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3">Escrow</h3>
              <MilestoneTimeline milestones={escrow.milestones} />
              <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-xs text-white/30">Total Escrowed</span>
                <AmountDisplay amount={escrow.totalAmount} size="sm" />
              </div>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
