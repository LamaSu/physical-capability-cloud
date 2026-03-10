/**
 * AutomationTracker — tracks progressive automation per transfer pair.
 *
 * Each instrument-to-instrument transfer can progress through automation levels:
 * manual → teleoperated → pilot_operated → vla_assisted → fully_autonomous
 *
 * Advancement is gated on:
 * - Minimum episode count (demonstrations for VLA training)
 * - VLA success rate exceeding an advancement threshold
 */

import type { AutomationLevel, AutomationStatus } from "@pcc/spec";
import { ids } from "@pcc/spec";

/** Ordered automation levels for progression */
const AUTOMATION_LEVELS: AutomationLevel[] = [
  "manual",
  "teleoperated",
  "pilot_operated",
  "vla_assisted",
  "fully_autonomous",
];

function levelIndex(level: AutomationLevel): number {
  const idx = AUTOMATION_LEVELS.indexOf(level);
  return idx >= 0 ? idx : 0;
}

function makeKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}::${toNodeId}`;
}

export class AutomationTracker {
  private statuses = new Map<string, AutomationStatus>();

  // ── Registration ────────────────────────────────────────────────

  /** Register a transfer pair with initial automation status */
  register(
    kernelId: string,
    fromNodeId: string,
    toNodeId: string,
    transferAgentId: string,
    initialLevel: AutomationLevel = "manual",
  ): AutomationStatus {
    const key = makeKey(fromNodeId, toNodeId);

    const status: AutomationStatus = {
      id: ids.automationStatus(),
      kernelId,
      fromNodeId,
      toNodeId,
      transferAgentId,
      currentLevel: initialLevel,
      episodeCount: 0,
      minEpisodesForTraining: 10,
      advanceThreshold: 0.85,
    };

    this.statuses.set(key, status);
    return status;
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Get automation status for a transfer pair */
  getStatus(fromNodeId: string, toNodeId: string): AutomationStatus | undefined {
    return this.statuses.get(makeKey(fromNodeId, toNodeId));
  }

  /** Get all statuses, optionally filtered by kernel */
  getAllStatuses(kernelId?: string): AutomationStatus[] {
    const all = [...this.statuses.values()];
    if (kernelId) {
      return all.filter((s) => s.kernelId === kernelId);
    }
    return all;
  }

  // ── Episode recording ────────────────────────────────────────────

  /** Record a new episode (demonstration) for a transfer pair */
  recordEpisode(
    fromNodeId: string,
    toNodeId: string,
    episodeId?: string,
  ): AutomationStatus {
    const status = this.requireStatus(fromNodeId, toNodeId);
    status.episodeCount += 1;
    status.lastEpisodeAt = new Date().toISOString();
    if (episodeId) {
      status.metadata = { ...status.metadata, lastEpisodeId: episodeId };
    }
    return status;
  }

  // ── VLA model updates ────────────────────────────────────────────

  /** Update VLA model info after a training run */
  updateVLAModel(
    fromNodeId: string,
    toNodeId: string,
    modelId: string,
    modelName: string,
    successRate: number,
  ): AutomationStatus {
    const status = this.requireStatus(fromNodeId, toNodeId);
    status.vlaModelId = modelId;
    status.vlaModelName = modelName;
    status.vlaSuccessRate = successRate;
    status.lastTrainedAt = new Date().toISOString();
    return status;
  }

  // ── Advancement ──────────────────────────────────────────────────

  /** Check if ready to advance to next automation level */
  checkAdvancement(
    fromNodeId: string,
    toNodeId: string,
  ): { shouldAdvance: boolean; nextLevel: AutomationLevel; currentRate: number } {
    const status = this.requireStatus(fromNodeId, toNodeId);

    const currentIdx = levelIndex(status.currentLevel);
    const isMaxLevel = currentIdx >= AUTOMATION_LEVELS.length - 1;
    const nextLevel = isMaxLevel
      ? status.currentLevel
      : AUTOMATION_LEVELS[currentIdx + 1];

    const currentRate = status.vlaSuccessRate ?? 0;
    const hasEnoughEpisodes = status.episodeCount >= status.minEpisodesForTraining;
    const hasGoodSuccessRate = currentRate >= status.advanceThreshold;

    const shouldAdvance = !isMaxLevel && hasEnoughEpisodes && hasGoodSuccessRate;

    return { shouldAdvance, nextLevel, currentRate };
  }

  /** Advance automation level */
  advanceLevel(fromNodeId: string, toNodeId: string): AutomationStatus {
    const status = this.requireStatus(fromNodeId, toNodeId);

    const currentIdx = levelIndex(status.currentLevel);
    if (currentIdx >= AUTOMATION_LEVELS.length - 1) {
      throw new Error(
        `Cannot advance past ${status.currentLevel} — already at maximum automation level`,
      );
    }

    status.currentLevel = AUTOMATION_LEVELS[currentIdx + 1];
    return status;
  }

  // ── Internals ────────────────────────────────────────────────────

  private requireStatus(fromNodeId: string, toNodeId: string): AutomationStatus {
    const status = this.statuses.get(makeKey(fromNodeId, toNodeId));
    if (!status) {
      throw new Error(
        `No automation status registered for transfer ${fromNodeId} → ${toNodeId}`,
      );
    }
    return status;
  }
}
