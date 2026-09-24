import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, StatusChip, DataCell, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useKernel } from "../api/hooks/use-pcc-data.js";
import { isActiveJob, isKernelOnline } from "../lib/live-status.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";

/**
 * One kernel, read from GET /api/kernels/:kernelId (KernelHealthSnapshot).
 *
 * This page used to read api/mock-data.ts, whose arrays are empty, so every
 * kernel opened from the live Kernels list showed "Kernel not found" (N51).
 * It now renders only what the snapshot returns. There is no DID badge (no
 * route serves a kernel DID) and no job names or amounts (not in JobDTO). The
 * max assurance tier is the kernel's own declaration, and the label says so.
 */

/** The gateway answers 404 for an unknown kernel id; any other failure is "unavailable". */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message);
}

const deviceStatusToPulse: Record<string, "online" | "executing" | "failed" | "offline"> = {
  idle: "online",
  busy: "executing",
  error: "failed",
  offline: "offline",
  maintenance: "offline",
};

export function KernelDetailPage() {
  const { kernelId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const kernelQ = useKernel(kernelId);
  const kernel = kernelQ.data?.kernel;

  React.useEffect(() => {
    setPageMeta(kernel?.name ?? `Kernel ${kernelId ?? ""}`, "Capabilities, devices, and queue status");
  }, [setPageMeta, kernel?.name, kernelId]);

  const back = (
    <button onClick={() => navigate("/kernels")} className="text-xs text-white/30 hover:text-white/50 mb-2">
      ← Back to kernels
    </button>
  );

  if (kernelQ.isLoading) return <LoadingShell rows={4} />;

  if (!kernel) {
    if (isNotFound(kernelQ.error)) {
      return (
        <GlassPanel padding="lg">
          {back}
          <EmptyState title="Kernel not found" description={`The gateway has no kernel ${kernelId}.`} />
        </GlassPanel>
      );
    }
    return (
      <GlassPanel padding="lg">
        {back}
        <UnavailableState what="this kernel" error={kernelQ.error} onRetry={() => void kernelQ.refetch()} />
      </GlassPanel>
    );
  }

  const online = isKernelOnline(kernel);
  const devices = kernel.devices ?? [];
  const activeJobs = (kernel.recentJobs ?? []).filter(isActiveJob);
  const loc = kernel.location;
  const hasCoords = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng);

  return (
    <div className="space-y-6">
      {kernelQ.isError && (
        <StaleNotice what="this kernel" updatedAt={kernelQ.dataUpdatedAt} onRetry={() => void kernelQ.refetch()} />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          {back}
          <h2 className="text-xl font-semibold text-white/90">{kernel.name}</h2>
          <div className="text-xs text-white/30 font-mono mt-1">{kernel.id}</div>
        </div>
        <StatusChip
          status={online ? "online" : kernel.status === "maintenance" ? "executing" : "offline"}
          label={kernel.status === "online" && kernel.isStale ? "online · stale heartbeat" : kernel.status}
        />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Reputation" value={typeof kernel.reputation === "number" ? kernel.reputation : "—"} sub={typeof kernel.reputation === "number" ? "/1000" : "not reported"} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Jobs Completed" value={kernel.totalJobsCompleted} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Declared Max Tier" value={`Tier ${kernel.maxAssuranceTier}`} sub="set by the kernel, not verified" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Operator" value={<span className="font-mono text-xs break-all">{kernel.operatorAddress}</span>} />
        </GlassPanel>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Capabilities */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            Capabilities ({kernel.capabilityCount})
          </h3>
          {kernel.capabilityTypes?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {kernel.capabilityTypes.map((t) => (
                <GlowBadge key={t} color="teal">{t}</GlowBadge>
              ))}
            </div>
          ) : (
            <div className="text-sm text-white/30">No capabilities registered</div>
          )}
        </div>

        {/* Devices */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Devices ({devices.length})</h3>
          {devices.length === 0 ? (
            <div className="text-sm text-white/30">No devices registered</div>
          ) : (
            <GlassPanel padding="md">
              <div className="space-y-2">
                {devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="text-white/70 truncate">{d.model ?? d.id}</div>
                      <div className="text-white/30 font-mono">{[d.type, d.adapterType].filter(Boolean).join(" · ")}</div>
                    </div>
                    <StatusChip status={deviceStatusToPulse[d.status] ?? "offline"} label={`${d.status} · ${d.healthStatus}`} />
                  </div>
                ))}
              </div>
            </GlassPanel>
          )}

          {/* Active Jobs */}
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Active Jobs</h3>
          {activeJobs.length === 0 ? (
            <div className="text-sm text-white/30">No active jobs</div>
          ) : (
            activeJobs.map((job) => (
              <GlassPanel key={job.id} hover padding="md" onClick={() => navigate(`/jobs/${job.id}`)}>
                <div className="text-sm text-white/70 font-mono truncate">{job.id}</div>
                <div className="text-[10px] text-white/30 font-mono">
                  {String(job.status).replace(/_/g, " ")}
                  {typeof job.progress === "number" ? ` · ${job.progress}%` : ""}
                </div>
              </GlassPanel>
            ))
          )}

          {/* Location */}
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Location</h3>
          <GlassPanel padding="md">
            <div className="text-sm text-white/60">{kernel.physicalAddress || "No address given"}</div>
            {hasCoords && (
              <div className="text-xs text-white/25 font-mono mt-1">
                {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
              </div>
            )}
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}
