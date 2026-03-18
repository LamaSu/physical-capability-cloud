import React from "react";
import { GlassPanel, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import type { CapabilityType } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useCapabilityTemplates, useKernels } from "../api/hooks/use-pcc-data.js";
import { useNavigate } from "react-router-dom";

const capabilityTypes: CapabilityType[] = ["hplc", "pcr", "microscopy", "mass-spec", "sequencing", "cell-culture"];

export function DiscoverPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [search, setSearch] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<CapabilityType | "all">("all");

  React.useEffect(() => { setPageMeta("Discover Capabilities", "Search and browse available capabilities"); }, [setPageMeta]);

  const { data: templatesData, isLoading: templatesLoading } = useCapabilityTemplates();
  const { data: kernels = [], isLoading: kernelsLoading } = useKernels();

  if (templatesLoading || kernelsLoading) return <LoadingShell rows={4} />;

  const templates = (templatesData?.templates ?? []) as any[];

  const filtered = templates.filter((cap: any) => {
    if (typeFilter !== "all" && cap.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        (cap.name ?? "").toLowerCase().includes(q) ||
        (cap.type ?? "").toLowerCase().includes(q) ||
        (cap.description ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Search + filters */}
      <GlassPanel padding="md">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Describe what you need... (e.g., HPLC purity analysis, CNC machining, 3D printing)"
          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white/80 placeholder-white/25 outline-none focus:border-teal-500/40 transition-colors"
        />
        <div className="flex gap-2 mt-3 flex-wrap">
          <button
            onClick={() => setTypeFilter("all")}
            className={`px-3 py-1 rounded-lg text-xs border transition-all ${
              typeFilter === "all"
                ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
            }`}
          >
            All
          </button>
          {capabilityTypes.map((type) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1 rounded-lg text-xs border transition-all ${
                typeFilter === type
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              {type.toUpperCase().replace("-", " ")}
            </button>
          ))}
        </div>
      </GlassPanel>

      {templates.length === 0 ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No capabilities available"
            description="Capabilities will appear here as operators onboard equipment and register kernels on the network."
            action={{ label: "Register a Kernel", onClick: () => navigate("/onboard") }}
          />
        </GlassPanel>
      ) : (
        <>
          <div className="text-xs text-white/30">
            {filtered.length} capabilit{filtered.length === 1 ? "y" : "ies"} found
            {typeFilter !== "all" && <> in <GlowBadge color="teal">{typeFilter}</GlowBadge></>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((cap: any) => {
              const kernel = kernels.find((k: any) => k.id === cap.kernelId);
              return (
                <GlassPanel key={cap.id} padding="md" hover>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-sm font-medium text-white/80">{cap.name}</div>
                      <div className="text-xs text-white/30 font-mono">{cap.type}</div>
                    </div>
                    <GlowBadge color="teal">{cap.type}</GlowBadge>
                  </div>
                  {cap.description && <p className="text-xs text-white/40 mb-2">{cap.description}</p>}
                  {kernel && <div className="text-[10px] text-white/20 font-mono">at {kernel.name}</div>}
                </GlassPanel>
              );
            })}
          </div>
          {filtered.length === 0 && search && (
            <EmptyState title="No capabilities match your search" description="Try different keywords or clear the filter." />
          )}
        </>
      )}
    </div>
  );
}
