/**
 * Operator Health & Stats — everything an agent needs to evaluate
 * this operator before, during, and after a job.
 *
 * Aggregates: uptime, success rate, average durations, consumable
 * status, calibration state, queue analytics, and peak hours.
 */

import type { JobHistoryEntry } from "./estimator.js";

// ── Operator Info (full discovery response) ───────────────────────

export interface OperatorInfo {
  /** Identity */
  identity: {
    kernelId: string;
    name: string;
    operatorAddress: string;
    location: { lat: number; lng: number };
  };

  /** Robot hardware */
  hardware: {
    model: string;
    serialNumber: string;
    firmwareVersion: string;
    apiVersion: string;
    pipettes: Array<{
      mount: string;
      name: string;
      id: string;
      minVolume: number;
      maxVolume: number;
      channels: number;
    }>;
    modules: Array<{
      type: string;
      serial: string;
      slot: string;
      status: Record<string, unknown>;
    }>;
    deckSlots: number;
  };

  /** Current state */
  state: {
    online: boolean;
    status: "idle" | "busy" | "error" | "offline" | "maintenance";
    currentJobId: string | null;
    currentJobProgress: number;
    currentJobEstimatedRemainingMs: number;
    queueDepth: number;
    queueEstimatedWaitMs: number;
  };

  /** Reliability metrics */
  reliability: {
    uptimePercent24h: number;
    uptimePercent7d: number;
    uptimePercent30d: number;
    totalJobsCompleted: number;
    totalJobsFailed: number;
    successRate: number;
    avgJobDurationMs: number;
    avgQueueWaitMs: number;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
  };

  /** Consumable status */
  consumables: {
    tipRacksLoaded: number;
    tipsRemaining: number;
    /** Whether a refill is needed before the next job */
    needsRefill: boolean;
    /** Reagent levels by deck slot (estimated µL remaining) */
    reagentLevels: Record<string, number>;
    lastRefillAt: string | null;
  };

  /** Calibration */
  calibration: {
    lastCalibratedAt: string | null;
    calibrationDueAt: string | null;
    /** Whether calibration is current */
    calibrationCurrent: boolean;
    pipetteCalibration: Record<string, { calibrated: boolean; lastAt: string | null }>;
    deckCalibration: { calibrated: boolean; lastAt: string | null };
  };

  /** Scheduling */
  scheduling: {
    /** Availability windows (day of week → time ranges) */
    availabilityWindows: Record<number, Array<{ start: string; end: string }>>;
    /** Upcoming maintenance blackouts */
    maintenanceWindows: Array<{ start: string; end: string; reason: string }>;
    /** Peak hours (0-23 → average queue depth) */
    peakHours: Record<number, number>;
    /** Best time to submit (lowest historical queue) */
    bestSubmissionHour: number;
    timezone: string;
  };

  /** Pricing */
  pricing: {
    baseCost: string;
    perMinute: string;
    minimum: string;
    currency: string;
    /** Whether this operator accepts negotiation */
    negotiable: boolean;
  };

  /** Supported capabilities */
  capabilities: {
    actions: string[];
    labware: string[];
    materials: string[];
    assuranceTiers: number[];
    maxProtocolDurationMs: number;
  };

  /** Cancellation policy */
  cancellationPolicy: {
    /** Can cancel while queued? */
    cancelWhileQueued: boolean;
    /** Can cancel while running? (usually no for liquid handlers) */
    cancelWhileRunning: boolean;
    /** Cancellation fee (% of quote) */
    cancellationFeePercent: number;
    /** Refund window after submission (ms) */
    fullRefundWindowMs: number;
  };
}

// ── Job Completion Record (for stats) ─────────────────────────────

export interface CompletionRecord {
  jobId: string;
  templateId: string;
  submittedBy: string;
  enqueuedAt: string;
  startedAt: string;
  completedAt: string;
  actualDurationMs: number;
  queueWaitMs: number;
  success: boolean;
  errorMessage?: string;
  tipsUsed: number;
  volumeTransferredUl: number;
  assuranceTier: number;
  evidenceBundleId?: string;
}

// ── Health Tracker ────────────────────────────────────────────────

export class OperatorHealthTracker {
  private completions: CompletionRecord[] = [];
  private heartbeats: Array<{ timestamp: number; online: boolean }> = [];
  private tipsRemaining = 96 * 4; // default: 4 full racks
  private reagentLevels: Record<string, number> = {};
  private lastCalibration: string | null = null;
  private lastRefill: string | null = null;
  private lastError: { at: string; message: string } | null = null;

  /** Record a heartbeat (call periodically) */
  recordHeartbeat(online: boolean): void {
    this.heartbeats.push({ timestamp: Date.now(), online });
    // Keep last 30 days (at 1/min = ~43200 entries)
    if (this.heartbeats.length > 43_200) {
      this.heartbeats = this.heartbeats.slice(-43_200);
    }
  }

  /** Record a completed job */
  recordCompletion(record: CompletionRecord): void {
    this.completions.push(record);
    if (!record.success && record.errorMessage) {
      this.lastError = { at: record.completedAt, message: record.errorMessage };
    }
    // Decrement tips
    this.tipsRemaining = Math.max(0, this.tipsRemaining - record.tipsUsed);
    // Trim to last 500
    if (this.completions.length > 500) {
      this.completions = this.completions.slice(-500);
    }
  }

  /** Record a tip refill */
  recordRefill(tipsAdded: number): void {
    this.tipsRemaining += tipsAdded;
    this.lastRefill = new Date().toISOString();
  }

  /** Record calibration */
  recordCalibration(): void {
    this.lastCalibration = new Date().toISOString();
  }

  /** Update reagent levels */
  setReagentLevel(slot: string, volumeUl: number): void {
    this.reagentLevels[slot] = volumeUl;
  }

  /** Compute uptime for a time window */
  getUptime(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const relevant = this.heartbeats.filter((h) => h.timestamp >= cutoff);
    if (relevant.length === 0) return 1; // assume up if no data
    const online = relevant.filter((h) => h.online).length;
    return online / relevant.length;
  }

  /** Get success rate */
  getSuccessRate(): number {
    if (this.completions.length === 0) return 1;
    const succeeded = this.completions.filter((c) => c.success).length;
    return succeeded / this.completions.length;
  }

  /** Get average job duration (ms) */
  getAvgDuration(): number {
    const successful = this.completions.filter((c) => c.success);
    if (successful.length === 0) return 0;
    return successful.reduce((s, c) => s + c.actualDurationMs, 0) / successful.length;
  }

  /** Get average queue wait (ms) */
  getAvgQueueWait(): number {
    if (this.completions.length === 0) return 0;
    return this.completions.reduce((s, c) => s + c.queueWaitMs, 0) / this.completions.length;
  }

  /** Get peak hours (hour → avg queue depth at submission time) */
  getPeakHours(): Record<number, number> {
    const hourCounts: Record<number, number[]> = {};
    for (let h = 0; h < 24; h++) hourCounts[h] = [];

    for (const c of this.completions) {
      const hour = new Date(c.enqueuedAt).getUTCHours();
      hourCounts[hour].push(1);
    }

    const result: Record<number, number> = {};
    for (let h = 0; h < 24; h++) {
      result[h] = hourCounts[h].length;
    }
    return result;
  }

  /** Get the best hour to submit (lowest historical load) */
  getBestHour(): number {
    const peaks = this.getPeakHours();
    let bestHour = 0;
    let minLoad = Infinity;
    for (const [hour, load] of Object.entries(peaks)) {
      if (load < minLoad) {
        minLoad = load;
        bestHour = parseInt(hour);
      }
    }
    return bestHour;
  }

  /** Build the full reliability section */
  getReliability(): OperatorInfo["reliability"] {
    return {
      uptimePercent24h: Math.round(this.getUptime(24 * 60 * 60_000) * 100),
      uptimePercent7d: Math.round(this.getUptime(7 * 24 * 60 * 60_000) * 100),
      uptimePercent30d: Math.round(this.getUptime(30 * 24 * 60 * 60_000) * 100),
      totalJobsCompleted: this.completions.filter((c) => c.success).length,
      totalJobsFailed: this.completions.filter((c) => !c.success).length,
      successRate: Math.round(this.getSuccessRate() * 100) / 100,
      avgJobDurationMs: Math.round(this.getAvgDuration()),
      avgQueueWaitMs: Math.round(this.getAvgQueueWait()),
      lastErrorAt: this.lastError?.at ?? null,
      lastErrorMessage: this.lastError?.message ?? null,
    };
  }

  /** Build the consumables section */
  getConsumables(): OperatorInfo["consumables"] {
    return {
      tipRacksLoaded: Math.ceil(this.tipsRemaining / 96),
      tipsRemaining: this.tipsRemaining,
      needsRefill: this.tipsRemaining < 96, // less than one rack
      reagentLevels: { ...this.reagentLevels },
      lastRefillAt: this.lastRefill,
    };
  }

  /** Build the calibration section */
  getCalibration(): OperatorInfo["calibration"] {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60_000;
    const isCurrent = this.lastCalibration
      ? new Date(this.lastCalibration).getTime() > sevenDaysAgo
      : false;

    return {
      lastCalibratedAt: this.lastCalibration,
      calibrationDueAt: this.lastCalibration
        ? new Date(new Date(this.lastCalibration).getTime() + 7 * 24 * 60 * 60_000).toISOString()
        : null,
      calibrationCurrent: isCurrent,
      pipetteCalibration: {
        left: { calibrated: isCurrent, lastAt: this.lastCalibration },
        right: { calibrated: isCurrent, lastAt: this.lastCalibration },
      },
      deckCalibration: { calibrated: isCurrent, lastAt: this.lastCalibration },
    };
  }

  /** Build the scheduling section */
  getScheduling(): OperatorInfo["scheduling"] {
    return {
      availabilityWindows: {
        0: [{ start: "00:00", end: "23:59" }],
        1: [{ start: "00:00", end: "23:59" }],
        2: [{ start: "00:00", end: "23:59" }],
        3: [{ start: "00:00", end: "23:59" }],
        4: [{ start: "00:00", end: "23:59" }],
        5: [{ start: "00:00", end: "23:59" }],
        6: [{ start: "00:00", end: "23:59" }],
      },
      maintenanceWindows: [],
      peakHours: this.getPeakHours(),
      bestSubmissionHour: this.getBestHour(),
      timezone: "UTC",
    };
  }

  /** Convert completion to history entry for the estimator */
  toHistoryEntry(record: CompletionRecord, actionProfile: string, stepCount: number): JobHistoryEntry {
    return {
      jobId: record.jobId,
      templateId: record.templateId,
      actionProfile,
      stepCount,
      actualDurationMs: record.actualDurationMs,
      estimatedDurationMs: 0, // filled by caller
      completedAt: record.completedAt,
      success: record.success,
    };
  }
}
