import React from "react";
import { GlassPanel, CapabilityCard, GlowBadge } from "@pcc/ui";
import type { CapabilityType } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { allCapabilities, mockKernels } from "../api/mock-data.js";

const capabilityTypes: CapabilityType[] = ["hplc", "pcr", "microscopy", "mass-spec", "sequencing", "cell-culture"];

export function DiscoverPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [search, setSearch] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<CapabilityType | "all">("all");

  React.useEffect(() => { setPageMeta("Discover Capabilities", "Search and browse available biotech and neurotech capabilities"); }, [setPageMeta]);

  const filtered = allCapabilities.filter((cap) => {
    if (typeFilter !== "all" && cap.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        cap.name.toLowerCase().includes(q) ||
        cap.type.toLowerCase().includes(q) ||
        cap.materials.some((m) => m.toLowerCase().includes(q)) ||
        (cap.description ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Search + filters */}
      <GlassPanel padding="md">
        <div className="flex gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search capabilities... (e.g., HPLC, PCR, neural tissue, sequencing)"
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-2.5 text-sm text-white/80 placeholder-white/25 outline-none focus:border-green-500/30 transition-colors"
          />
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => setTypeFilter("all")}
            className={`px-3 py-1 rounded-lg text-xs border transition-all ${
              typeFilter === "all"
                ? "bg-green-500/15 border-green-500/30 text-green-400"
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
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              {type.toUpperCase().replace("-", " ")}
            </button>
          ))}
        </div>
      </GlassPanel>

      {/* Results count */}
      <div className="text-xs text-white/30">
        {filtered.length} capabilit{filtered.length === 1 ? "y" : "ies"} found
        {typeFilter !== "all" && <> in <GlowBadge color="green">{typeFilter}</GlowBadge></>}
      </div>

      {/* Capability cards */}
      <div className="grid grid-cols-2 gap-4">
        {filtered.map((cap) => {
          const kernel = mockKernels.find((k) => k.id === cap.kernelId);
          return (
            <div key={cap.id} className="space-y-1">
              <CapabilityCard capability={cap} />
              {kernel && (
                <div className="text-[10px] text-white/20 font-mono px-2">
                  at {kernel.name}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-white/30 text-sm">
          No capabilities match your search
        </div>
      )}
    </div>
  );
}
