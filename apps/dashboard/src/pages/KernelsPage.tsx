import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, DataCell, GlowBadge, PulseIndicator, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useKernels } from "../api/hooks/use-pcc-data.js";

/**
 * The line of text under a kernel's name: its address, else its location
 * label, else its coordinates, else "Location not set" (astra H491 MEDIUM).
 *
 * A gateway kernel's location is untrusted JSON (gateway.ts returns
 * res.json() with no runtime validation), so each field is checked before
 * it is shown rather than used because it happened to be truthy: an object
 * in physicalAddress or location.label is truthy but is not valid text —
 * rendering it directly crashes with "Objects are not valid as a React
 * child" — and a coordinate pair can be two finite numbers that are still
 * not a place on Earth (astra's {lat: 91, lng: 181}).
 */
function kernelLocationText(kernel: any): string {
  if (typeof kernel.physicalAddress === "string" && kernel.physicalAddress !== "") {
    return kernel.physicalAddress;
  }
  if (typeof kernel.location?.label === "string" && kernel.location.label !== "") {
    return kernel.location.label;
  }
  const { lat, lng } = kernel.location ?? {};
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
  return "Location not set";
}

export function KernelsPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Kernels", "Shop kernels and connected equipment"); }, [setPageMeta]);

  const { data: kernels = [], isLoading } = useKernels();

  if (isLoading) return <LoadingShell rows={4} />;

  const onlineCount = kernels.filter((k: any) => k.status === "online").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Total Kernels" value={kernels.length} mono /></GlassPanel>
        <GlassPanel padding="md" glow={onlineCount > 0 ? "green" : undefined}><DataCell label="Online" value={onlineCount} mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Capabilities" value={kernels.reduce((s: number, k: any) => s + (k.capabilities?.length ?? 0), 0)} mono /></GlassPanel>
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
          {kernels.map((kernel: any) => (
            <GlassPanel
              key={kernel.id}
              padding="lg"
              hover
              glow={kernel.status === "online" ? "green" : undefined}
              onClick={() => navigate(`/kernels/${kernel.id}`)}
            >
              <div className="flex items-center gap-3 mb-3">
                <PulseIndicator status={kernel.status === "online" ? "online" : "offline"} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white/80 truncate">{kernel.name}</div>
                  <div className="text-xs text-white/30 font-mono">{kernel.id}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {(kernel.capabilities ?? []).slice(0, 4).map((cap: string, i: number) => (
                  <GlowBadge key={i} color="teal">{cap}</GlowBadge>
                ))}
                {(kernel.capabilities?.length ?? 0) > 4 && (
                  <GlowBadge color="gray">+{kernel.capabilities.length - 4}</GlowBadge>
                )}
              </div>
              <div className="text-xs text-white/25">{kernelLocationText(kernel)}</div>
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
