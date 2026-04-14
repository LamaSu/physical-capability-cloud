/**
 * Pure logic for KernelLeaderboardPage.
 *
 * Extracted so unit tests can exercise rollup/sort behaviour without
 * transitively pulling in React, zustand stores that touch localStorage,
 * or the TanStack Query client.
 */

import type { CapabilityDTO, KernelDTO } from "../types/dto.js";

export type SortDir = "desc" | "asc";

export interface LeaderboardRow {
  kernelId: string;
  kernelName: string;
  kernelStatus: KernelDTO["status"] | "unknown";
  /** Average assurance score across all this kernel's capabilities. Null
   *  when no capability reports a score yet. */
  avgScore: number | null;
  /** Count of capabilities used for the average. */
  scoredCount: number;
  /** Total capabilities this kernel offers (for display). */
  capabilityCount: number;
  /** Types of capabilities offered (up to 4 shown). */
  types: string[];
  /** Sum of queue depth across capabilities. */
  queueDepth: number;
  /** Reputation from ERC-8004, when available (0-1000). */
  reputation?: number;
}

/** Build per-kernel rollups from capability list + kernel list. */
export function buildLeaderboard(
  capabilities: CapabilityDTO[],
  kernels: KernelDTO[],
): LeaderboardRow[] {
  const byKernel = new Map<string, CapabilityDTO[]>();
  for (const cap of capabilities) {
    const existing = byKernel.get(cap.kernelId);
    if (existing) existing.push(cap);
    else byKernel.set(cap.kernelId, [cap]);
  }

  const rows: LeaderboardRow[] = [];
  for (const [kernelId, caps] of byKernel) {
    const scores = caps
      .map((c) =>
        typeof c.assuranceScore === "number" ? c.assuranceScore : null,
      )
      .filter((s): s is number => s != null);
    const avg = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
    const kernel = kernels.find((k) => k.id === kernelId);
    const typeSet = new Set(caps.map((c) => c.type));
    const queueDepth = caps.reduce((s, c) => s + (c.queueDepth ?? 0), 0);
    const reputation =
      kernel?.reputation ??
      caps.find((c) => typeof c.reputation === "number")?.reputation;

    rows.push({
      kernelId,
      kernelName: kernel?.name ?? caps[0]?.kernelName ?? kernelId,
      kernelStatus: kernel?.status ?? (caps[0]?.kernelStatus as any) ?? "unknown",
      avgScore: avg,
      scoredCount: scores.length,
      capabilityCount: caps.length,
      types: Array.from(typeSet).slice(0, 4),
      queueDepth,
      reputation,
    });
  }

  return rows;
}

/** Sort leaderboard rows by assurance score, with unscored rows always at the bottom. */
export function sortLeaderboard(
  rows: LeaderboardRow[],
  dir: SortDir,
): LeaderboardRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (a.avgScore == null && b.avgScore == null) {
      return a.kernelName.localeCompare(b.kernelName);
    }
    if (a.avgScore == null) return 1;
    if (b.avgScore == null) return -1;
    return dir === "desc" ? b.avgScore - a.avgScore : a.avgScore - b.avgScore;
  });
  return copy;
}
