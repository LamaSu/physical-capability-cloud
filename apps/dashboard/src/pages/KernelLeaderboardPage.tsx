/**
 * KernelLeaderboardPage — ranks kernels by their average assurance score.
 *
 * Buyers and agents use this page to pick high-quality kernels before
 * committing jobs. Ordering is strictly by assuranceScore (desc by default).
 * Kernels with no score yet sink to the bottom.
 *
 * Data source: GET /api/capabilities (enriched PaginatedResult<CapabilityDTO>).
 * We roll capabilities up per-kernel because a kernel can offer many
 * capabilities, and the leaderboard surface is kernel-oriented.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel,
  DataCell,
  GlowBadge,
  PulseIndicator,
  EmptyState,
  LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useCapabilities, useKernels } from "../api/hooks/use-pcc-data.js";
import {
  AssuranceScoreBadge,
  scoreToColor,
} from "../components/assurance/index.js";
import {
  buildLeaderboard,
  sortLeaderboard,
  type SortDir,
} from "./kernel-leaderboard-logic.js";

// Re-export helpers for callers (and tests that prefer importing from the page).
export {
  buildLeaderboard,
  sortLeaderboard,
} from "./kernel-leaderboard-logic.js";
export type { SortDir, LeaderboardRow } from "./kernel-leaderboard-logic.js";

export function KernelLeaderboardPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");
  const [minScoreInput, setMinScoreInput] = React.useState<string>("");

  React.useEffect(() => {
    setPageMeta(
      "Kernel Leaderboard",
      "Kernels ranked by assurance score (ALCOA+ compliance rollup)",
    );
  }, [setPageMeta]);

  const { data: capabilitiesPage, isLoading: capsLoading } = useCapabilities({
    limit: 500,
  });
  const { data: kernels = [], isLoading: kernelsLoading } = useKernels();

  if (capsLoading || kernelsLoading) return <LoadingShell rows={6} />;

  const capabilities = capabilitiesPage?.items ?? [];
  const rows = buildLeaderboard(capabilities, kernels);

  const minScore = React.useMemo(() => {
    const raw = minScoreInput.trim();
    if (!raw) return null;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
  }, [minScoreInput]);

  const filtered = minScore != null
    ? rows.filter((r) => r.avgScore != null && r.avgScore >= minScore)
    : rows;
  const sorted = sortLeaderboard(filtered, sortDir);

  const scored = rows.filter((r) => r.avgScore != null);
  const avgOfAvgs =
    scored.length > 0
      ? scored.reduce((s, r) => s + (r.avgScore ?? 0), 0) / scored.length
      : null;

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Kernels" value={rows.length} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="With Scores" value={scored.length} mono />
        </GlassPanel>
        <GlassPanel
          padding="md"
          glow={avgOfAvgs != null && avgOfAvgs >= 0.85 ? "green" : undefined}
        >
          <DataCell
            label="Network Average"
            value={
              <span className="flex items-center gap-2">
                <AssuranceScoreBadge score={avgOfAvgs} size="md" />
              </span>
            }
          />
        </GlassPanel>
      </div>

      {/* Controls */}
      <GlassPanel padding="md">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-white/30">
            Sort
          </span>
          <div className="flex gap-1.5">
            <button
              onClick={() => setSortDir("desc")}
              className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${
                sortDir === "desc"
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              Best first
            </button>
            <button
              onClick={() => setSortDir("asc")}
              className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${
                sortDir === "asc"
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
              }`}
            >
              Worst first
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
          <div className="ml-auto text-xs text-white/30">
            {sorted.length} row{sorted.length === 1 ? "" : "s"}
          </div>
        </div>
      </GlassPanel>

      {/* Leaderboard */}
      {rows.length === 0 ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No kernels on the network yet"
            description="Leaderboard populates as kernels register capabilities and complete jobs with evidence."
            action={{
              label: "Onboard Equipment",
              onClick: () => navigate("/onboard"),
            }}
          />
        </GlassPanel>
      ) : (
        <GlassPanel padding="none" className="overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-12 gap-3 px-4 py-3 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-white/40">
            <div className="col-span-1">Rank</div>
            <div className="col-span-4">Kernel</div>
            <div className="col-span-2">Types</div>
            <div className="col-span-2">Assurance</div>
            <div className="col-span-1 text-right">Queue</div>
            <div className="col-span-2 text-right">Reputation</div>
          </div>

          {sorted.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No kernels match this filter"
                description="Try relaxing the minimum score."
              />
            </div>
          ) : (
            sorted.map((row, idx) => {
              const color = scoreToColor(row.avgScore);
              return (
                <button
                  key={row.kernelId}
                  onClick={() => navigate(`/kernels/${row.kernelId}`)}
                  className={`w-full grid grid-cols-12 gap-3 px-4 py-3 border-b border-white/[0.04] text-left transition-colors ${
                    color === "green"
                      ? "hover:bg-green-500/[0.04]"
                      : color === "red"
                        ? "hover:bg-red-500/[0.04]"
                        : "hover:bg-white/[0.03]"
                  }`}
                >
                  <div className="col-span-1 flex items-center">
                    <span className="font-mono text-xs text-white/40">
                      #{idx + 1}
                    </span>
                  </div>
                  <div className="col-span-4 flex items-center gap-2 min-w-0">
                    <PulseIndicator
                      status={
                        row.kernelStatus === "online" ? "online" : "offline"
                      }
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white/85 truncate">
                        {row.kernelName}
                      </div>
                      <div className="text-[10px] text-white/30 font-mono truncate">
                        {row.kernelId}
                      </div>
                    </div>
                  </div>
                  <div className="col-span-2 flex flex-wrap gap-1 items-center">
                    {row.types.map((t, i) => (
                      <GlowBadge key={i} color="teal">
                        {t}
                      </GlowBadge>
                    ))}
                  </div>
                  <div className="col-span-2 flex items-center gap-2">
                    <AssuranceScoreBadge score={row.avgScore} size="md" />
                    {row.scoredCount < row.capabilityCount && (
                      <span
                        className="text-[10px] text-white/25 font-mono"
                        title={`Score averaged across ${row.scoredCount} of ${row.capabilityCount} capabilities`}
                      >
                        ({row.scoredCount}/{row.capabilityCount})
                      </span>
                    )}
                  </div>
                  <div className="col-span-1 flex items-center justify-end">
                    <span className="font-mono text-xs text-white/60">
                      {row.queueDepth}
                    </span>
                  </div>
                  <div className="col-span-2 flex items-center justify-end">
                    {row.reputation != null ? (
                      <GlowBadge color={row.reputation >= 750 ? "green" : "gray"}>
                        {row.reputation}
                      </GlowBadge>
                    ) : (
                      <span className="text-[10px] text-white/20 font-mono">
                        —
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </GlassPanel>
      )}
    </div>
  );
}
