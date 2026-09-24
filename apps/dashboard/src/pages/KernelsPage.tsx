import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, DataCell, GlowBadge, PulseIndicator, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useKernels } from "../api/hooks/use-pcc-data.js";
import { isKernelOnline } from "../lib/live-status.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import type { KernelDTO } from "../types/dto.js";

/** Where a kernel is, as text. `location` is a {lat, lng} object, never a renderable string. */
function kernelPlace(kernel: KernelDTO): string {
  if (kernel.physicalAddress) return kernel.physicalAddress;
  const loc = kernel.location;
  if (loc?.label) return loc.label;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`;
  return "Location not set";
}

export function KernelsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Kernels", "Shop kernels and connected equipment"); }, [setPageMeta]);

  const kernelsQ = useKernels();

  if (kernelsQ.isLoading) return <LoadingShell rows={4} />;
  const kernels = kernelsQ.data;
  if (!kernels) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="kernels" error={kernelsQ.error} onRetry={() => void kernelsQ.refetch()} />
      </GlassPanel>
    );
  }

  const onlineCount = kernels.filter(isKernelOnline).length;

  return (
    <div className="space-y-6">
      {kernelsQ.isError && (
        <StaleNotice what="kernels" updatedAt={kernelsQ.dataUpdatedAt} onRetry={() => void kernelsQ.refetch()} />
      )}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Total Kernels" value={kernels.length} mono /></GlassPanel>
        <GlassPanel padding="md" glow={onlineCount > 0 ? "green" : undefined}>
          <DataCell label="Online" value={onlineCount} sub="fresh heartbeat" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Capabilities" value={kernels.reduce((s, k) => s + (k.capabilityCount ?? 0), 0)} mono />
        </GlassPanel>
      </div>

      {kernels.length === 0 ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No kernels registered"
            description="A kernel represents a physical site with equipment. Register your first kernel to start offering capabilities on the network."
            action={{ label: "Onboard Equipment", onClick: () => navigate("/onboard") }}
          />
        </GlassPanel>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {kernels.map((kernel) => (
            <GlassPanel
              key={kernel.id}
              padding="lg"
              hover
              glow={isKernelOnline(kernel) ? "green" : undefined}
              onClick={() => navigate(`/kernels/${kernel.id}`)}
            >
              <div className="flex items-center gap-3 mb-3">
                <PulseIndicator status={isKernelOnline(kernel) ? "online" : "offline"} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate">{kernel.name}</div>
                  <div className="text-xs text-white/30 font-mono">
                    {kernel.id}
                    {kernel.status === "online" && kernel.isStale && <span className="ml-2 text-amber-300/70">stale heartbeat</span>}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {(kernel.capabilityTypes ?? []).slice(0, 4).map((cap, i) => (
                  <GlowBadge key={i} color="teal">{cap}</GlowBadge>
                ))}
                {(kernel.capabilityTypes?.length ?? 0) > 4 && (
                  <GlowBadge color="gray">+{kernel.capabilityTypes.length - 4}</GlowBadge>
                )}
              </div>
              <div className="text-xs text-white/25">{kernelPlace(kernel)}</div>
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
