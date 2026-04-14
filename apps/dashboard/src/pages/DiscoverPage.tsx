import React from "react";
import { GlassPanel, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import type { CapabilityType } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useCapabilityTemplates, useKernels } from "../api/hooks/use-pcc-data.js";
import { useNavigate } from "react-router-dom";
import {
  AssuranceScoreBadge,
  scoreToColor,
} from "../components/assurance/index.js";

const capabilityTypes: CapabilityType[] = ["hplc", "pcr", "microscopy", "mass-spec", "sequencing", "cell-culture"];

type SortMode = "default" | "assurance-desc" | "assurance-asc";

export function DiscoverPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [search, setSearch] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<CapabilityType | "all">("all");
  const [sortMode, setSortMode] = React.useState<SortMode>("default");
  const [minScoreInput, setMinScoreInput] = React.useState<string>("");

  React.useEffect(() => { setPageMeta("Discover Capabilities", "Search and browse available capabilities"); }, [setPageMeta]);

  const { data: templatesData, isLoading: templatesLoading } = useCapabilityTemplates();
  const { data: kernels = [], isLoading: kernelsLoading } = useKernels();

  if (templatesLoading || kernelsLoading) return <LoadingShell rows={4} />;

  const templates = (templatesData?.templates ?? []) as any[];

  // Parse min-score: accepts "0.7" or "70" (percent). Empty → no filter.
  const minScore: number | null = React.useMemo(() => {
    const raw = minScoreInput.trim();
    if (!raw) return null;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    // Treat > 1 as percent shorthand.
    return n > 1 ? n / 100 : n;
  }, [minScoreInput]);

  const filtered = templates.filter((cap: any) => {
    if (typeFilter !== "all" && cap.type !== typeFilter) return false;
    if (minScore != null) {
      // Drop capabilities whose score is unknown or below the threshold.
      const s = typeof cap.assuranceScore === "number" ? cap.assuranceScore : null;
      if (s == null || s < minScore) return false;
    }
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

  const sorted = React.useMemo(() => {
    if (sortMode === "default") return filtered;
    const copy = [...filtered];
    copy.sort((a: any, b: any) => {
      const av = typeof a.assuranceScore === "number" ? a.assuranceScore : -Infinity;
      const bv = typeof b.assuranceScore === "number" ? b.assuranceScore : -Infinity;
      return sortMode === "assurance-desc" ? bv - av : av - bv;
    });
    return copy;
  }, [filtered, sortMode]);

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

        {/* Assurance sort + min-score filter */}
        <div className="flex gap-3 mt-3 flex-wrap items-center">
          <span className="text-[10px] uppercase tracking-wider text-white/30">Assurance</span>
          <div className="flex gap-1.5">
            <button
              onClick={() => setSortMode("default")}
              className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${
                sortMode === "default"
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              Default
            </button>
            <button
              onClick={() => setSortMode("assurance-desc")}
              className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${
                sortMode === "assurance-desc"
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              Score ↓
            </button>
            <button
              onClick={() => setSortMode("assurance-asc")}
              className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${
                sortMode === "assurance-asc"
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              Score ↑
            </button>
          </div>
          <label className="flex items-center gap-2 text-[10px] text-white/40">
            Min score
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minScoreInput}
              onChange={(e) => setMinScoreInput(e.target.value)}
              placeholder="0.00"
              className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1 text-xs text-white/80 placeholder-white/20 outline-none focus:border-teal-500/40 font-mono"
            />
          </label>
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
            {sorted.length} capabilit{sorted.length === 1 ? "y" : "ies"} found
            {typeFilter !== "all" && <> in <GlowBadge color="teal">{typeFilter}</GlowBadge></>}
            {minScore != null && (
              <> with assurance ≥ <span className="font-mono text-teal-400">{minScore.toFixed(2)}</span></>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sorted.map((cap: any) => {
              const kernel = kernels.find((k: any) => k.id === cap.kernelId);
              const color = scoreToColor(cap.assuranceScore);
              return (
                <GlassPanel
                  key={cap.id}
                  padding="md"
                  hover
                  glow={color === "green" ? "green" : color === "yellow" ? "gold" : undefined}
                >
                  <div className="flex items-start justify-between mb-2 gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white/80 truncate">{cap.name}</div>
                      <div className="text-xs text-white/30 font-mono">{cap.type}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <GlowBadge color="teal">{cap.type}</GlowBadge>
                      <AssuranceScoreBadge score={cap.assuranceScore} size="sm" />
                    </div>
                  </div>
                  {cap.description && <p className="text-xs text-white/40 mb-2">{cap.description}</p>}
                  {kernel && <div className="text-[10px] text-white/20 font-mono">at {kernel.name}</div>}
                </GlassPanel>
              );
            })}
          </div>
          {sorted.length === 0 && (search || minScore != null) && (
            <EmptyState
              title="No capabilities match your filters"
              description="Try different keywords, relax the minimum score, or clear the filter."
            />
          )}
        </>
      )}
    </div>
  );
}
