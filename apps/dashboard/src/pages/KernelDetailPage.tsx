import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  GlassPanel, StatusChip, CapabilityCard, DeviceStatusGrid,
  DataCell, AddressDisplay, AmountDisplay, TierBadge, DIDBadge,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockKernels, mockDevices, mockJobs, jobMeta } from "../api/mock-data.js";

export function KernelDetailPage() {
  const { kernelId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const kernel = mockKernels.find((k) => k.id === kernelId);
  const devices = mockDevices.filter((d) => d.kernelId === kernelId);
  const jobs = mockJobs.filter((j) => {
    const cap = kernel?.capabilities.find((c) => c.id === j.capabilityId);
    return !!cap;
  });

  React.useEffect(() => {
    setPageMeta(kernel?.name ?? `Kernel ${kernelId}`, "Capabilities, devices, and queue status");
  }, [setPageMeta, kernel, kernelId]);

  if (!kernel) {
    return (
      <GlassPanel padding="lg">
        <div className="text-center py-8 text-white/40">
          Kernel not found
          <button onClick={() => navigate("/kernels")} className="block mx-auto mt-2 text-green-400/70 text-sm">
            ← Back to kernels
          </button>
        </div>
      </GlassPanel>
    );
  }

  const statusMap: Record<string, "online" | "offline" | "executing"> = {
    online: "online",
    offline: "offline",
    maintenance: "executing",
    suspended: "offline",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate("/kernels")} className="text-xs text-white/30 hover:text-white/50 mb-2">
            ← Back to kernels
          </button>
          <h2 className="text-xl font-semibold text-white/90">{kernel.name}</h2>
          <div className="text-xs text-white/30 font-mono mt-1">{kernel.id}</div>
          <div className="mt-1.5">
            <DIDBadge did={`did:pcc:kernel:${kernel.id}`} />
          </div>
        </div>
        <StatusChip status={statusMap[kernel.status]} />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Reputation" value={kernel.reputation} sub="/1000" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Jobs Completed" value={kernel.totalJobsCompleted} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Max Tier" value={<TierBadge tier={kernel.maxAssuranceTier} />} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Operator" value={<AddressDisplay address={kernel.operatorAddress} />} />
        </GlassPanel>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Capabilities */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Capabilities</h3>
          {kernel.capabilities.map((cap) => (
            <CapabilityCard key={cap.id} capability={cap} />
          ))}
        </div>

        {/* Devices */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Devices ({devices.length})</h3>
          <GlassPanel padding="md">
            <DeviceStatusGrid devices={devices} />
          </GlassPanel>

          {/* Active Jobs */}
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Active Jobs</h3>
          {jobs.length === 0 ? (
            <div className="text-sm text-white/30">No active jobs</div>
          ) : (
            jobs.map((job) => {
              const meta = jobMeta[job.id];
              return (
                <GlassPanel key={job.id} hover padding="md" onClick={() => navigate(`/jobs/${job.id}`)}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white/70">{meta?.name ?? job.id}</div>
                      <div className="text-[10px] text-white/25 font-mono">{job.status} · {job.progress}%</div>
                    </div>
                    {meta && <AmountDisplay amount={meta.amount} size="sm" />}
                  </div>
                </GlassPanel>
              );
            })
          )}

          {/* Location */}
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Location</h3>
          <GlassPanel padding="md">
            <div className="text-sm text-white/60">{kernel.physicalAddress}</div>
            <div className="text-xs text-white/25 font-mono mt-1">
              {kernel.location.lat.toFixed(4)}, {kernel.location.lng.toFixed(4)}
            </div>
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}
