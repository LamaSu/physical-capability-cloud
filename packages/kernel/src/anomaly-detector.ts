/**
 * Anomaly Detector — background service that monitors the system for anomalies
 * and emits alerts. Tracks evidence integrity, job timeouts, protocol failures,
 * consensus failures, and submission rate spikes.
 */

import type { EvidenceBundle, SHA256 } from "@pcc/spec";
import { verifyBundleHash, hashEvent } from "@pcc/spec";
import { nanoid } from "nanoid";

export interface AnomalyReport {
  id: string;
  timestamp: string;
  severity: "info" | "warning" | "critical";
  category:
    | "protocol_failure"
    | "evidence_mismatch"
    | "consensus_failure"
    | "timeout"
    | "rate_anomaly"
    | "trust_violation";
  description: string;
  sourceId: string;
  targetId?: string;
  evidence: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: string;
}

export interface AnomalyDetectorConfig {
  /** default: 300000 (5 min) */
  jobTimeoutMs?: number;
  /** default: 3 */
  maxConsecutiveFailures?: number;
  /** default: 60000 (1 min) */
  evidenceRateWindowMs?: number;
  /** default: 100 */
  maxEvidenceRatePerWindow?: number;
  /** default: 0.6 */
  minConsensusRatio?: number;
  /** default: 3 anomalies */
  trustDowngradeThreshold?: number;
}

const DEFAULTS = {
  jobTimeoutMs: 300_000,
  maxConsecutiveFailures: 3,
  evidenceRateWindowMs: 60_000,
  maxEvidenceRatePerWindow: 100,
  minConsensusRatio: 0.6,
  trustDowngradeThreshold: 3,
} as const;

export class AnomalyDetector {
  private reports: AnomalyReport[] = [];
  private listeners: Array<(report: AnomalyReport) => void> = [];
  private agentFailureCounts: Map<string, number> = new Map();
  /** ISO timestamp strings per source */
  private evidenceRates: Map<string, string[]> = new Map();
  private config: Required<AnomalyDetectorConfig>;

  constructor(config?: AnomalyDetectorConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  // -------------------------------------------------------------------------
  // Detection methods
  // -------------------------------------------------------------------------

  /** Check an evidence bundle for integrity issues */
  async checkEvidenceIntegrity(bundle: EvidenceBundle): Promise<AnomalyReport | null> {
    // 1. Verify bundle hash
    const bundleOk = await verifyBundleHash(bundle);
    if (!bundleOk) {
      return this.emit({
        severity: "critical",
        category: "evidence_mismatch",
        description: `Bundle hash mismatch for bundle ${bundle.id}: stored hash does not match computed hash`,
        sourceId: bundle.kernelId,
        targetId: bundle.id,
        evidence: { bundleId: bundle.id, storedHash: bundle.bundleHash },
      });
    }

    // 2. Verify each event hash
    for (const event of bundle.events) {
      const computed = await hashEvent(event);
      if (computed !== event.hash) {
        return this.emit({
          severity: "critical",
          category: "evidence_mismatch",
          description: `Event hash mismatch for event ${event.id} in bundle ${bundle.id}`,
          sourceId: bundle.kernelId,
          targetId: bundle.id,
          evidence: { eventId: event.id, storedHash: event.hash, computedHash: computed },
        });
      }
    }

    // 3. Check kernel signature isn't the test default
    const sigValue = bundle.kernelSignature?.value ?? "";
    if (typeof sigValue === "string" && sigValue.startsWith("test_sig_")) {
      return this.emit({
        severity: "critical",
        category: "evidence_mismatch",
        description: `Bundle ${bundle.id} has a test/default kernel signature — not valid for production`,
        sourceId: bundle.kernelId,
        targetId: bundle.id,
        evidence: { bundleId: bundle.id, signatureValue: sigValue },
      });
    }

    return null;
  }

  /** Record a job completion and check for timeout anomalies */
  recordJobDuration(jobId: string, kernelId: string, durationMs: number): AnomalyReport | null {
    const { jobTimeoutMs } = this.config;

    if (durationMs > 3 * jobTimeoutMs) {
      return this.emit({
        severity: "critical",
        category: "timeout",
        description: `Job ${jobId} on kernel ${kernelId} took ${durationMs}ms — more than 3x the configured timeout (${jobTimeoutMs}ms)`,
        sourceId: kernelId,
        targetId: jobId,
        evidence: { jobId, durationMs, jobTimeoutMs },
      });
    }

    if (durationMs > jobTimeoutMs) {
      return this.emit({
        severity: "warning",
        category: "timeout",
        description: `Job ${jobId} on kernel ${kernelId} took ${durationMs}ms — exceeded timeout threshold (${jobTimeoutMs}ms)`,
        sourceId: kernelId,
        targetId: jobId,
        evidence: { jobId, durationMs, jobTimeoutMs },
      });
    }

    return null;
  }

  /** Record a protocol failure from an agent */
  recordProtocolFailure(agentId: string, protocol: string, error: string): AnomalyReport | null {
    const count = (this.agentFailureCounts.get(agentId) ?? 0) + 1;
    this.agentFailureCounts.set(agentId, count);

    if (count >= this.config.maxConsecutiveFailures) {
      return this.emit({
        severity: "critical",
        category: "protocol_failure",
        description: `Agent ${agentId} has ${count} consecutive protocol failures on protocol "${protocol}" — triggering trust downgrade`,
        sourceId: agentId,
        evidence: { agentId, protocol, error, consecutiveFailures: count },
      });
    }

    return null;
  }

  /** Record a verification consensus result and check for failures */
  recordConsensusResult(
    requestId: string,
    agreementRatio: number,
    verifierIds: string[]
  ): AnomalyReport | null {
    if (agreementRatio < 0.4) {
      return this.emit({
        severity: "critical",
        category: "consensus_failure",
        description: `Very low consensus agreement (${(agreementRatio * 100).toFixed(1)}%) for request ${requestId}`,
        sourceId: requestId,
        evidence: { requestId, agreementRatio, verifierCount: verifierIds.length, verifierIds },
      });
    }

    if (agreementRatio < this.config.minConsensusRatio) {
      return this.emit({
        severity: "warning",
        category: "consensus_failure",
        description: `Low consensus agreement (${(agreementRatio * 100).toFixed(1)}%) for request ${requestId} — below threshold (${(this.config.minConsensusRatio * 100).toFixed(1)}%)`,
        sourceId: requestId,
        evidence: { requestId, agreementRatio, verifierCount: verifierIds.length, verifierIds },
      });
    }

    return null;
  }

  /** Check evidence submission rate for spam/DoS */
  recordEvidenceSubmission(sourceId: string): AnomalyReport | null {
    const now = Date.now();
    const windowStart = now - this.config.evidenceRateWindowMs;

    // Get or create timestamp list for this source
    const timestamps = (this.evidenceRates.get(sourceId) ?? []).filter(
      (ts) => new Date(ts).getTime() > windowStart
    );
    timestamps.push(new Date(now).toISOString());
    this.evidenceRates.set(sourceId, timestamps);

    if (timestamps.length > this.config.maxEvidenceRatePerWindow) {
      return this.emit({
        severity: "warning",
        category: "rate_anomaly",
        description: `Source ${sourceId} submitted ${timestamps.length} evidence bundles within the rate window (max: ${this.config.maxEvidenceRatePerWindow})`,
        sourceId,
        evidence: {
          sourceId,
          submissionsInWindow: timestamps.length,
          windowMs: this.config.evidenceRateWindowMs,
          maxAllowed: this.config.maxEvidenceRatePerWindow,
        },
      });
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Query / management methods
  // -------------------------------------------------------------------------

  /** Get all unresolved anomalies */
  getUnresolved(): AnomalyReport[] {
    return this.reports.filter((r) => !r.resolved);
  }

  /** Get anomalies for a specific agent/kernel */
  getByTarget(targetId: string): AnomalyReport[] {
    return this.reports.filter((r) => r.targetId === targetId || r.sourceId === targetId);
  }

  /** Resolve an anomaly */
  resolve(anomalyId: string): void {
    const report = this.reports.find((r) => r.id === anomalyId);
    if (report) {
      report.resolved = true;
      report.resolvedAt = new Date().toISOString();
    }
  }

  /** Listen for new anomalies */
  onAnomaly(callback: (report: AnomalyReport) => void): void {
    this.listeners.push(callback);
  }

  /** Get trust score impact for an agent (count of unresolved anomalies) */
  getTrustImpact(agentId: string): { anomalyCount: number; shouldDowngrade: boolean } {
    const anomalyCount = this.getUnresolved().filter(
      (r) => r.sourceId === agentId || r.targetId === agentId
    ).length;
    return {
      anomalyCount,
      shouldDowngrade: anomalyCount >= this.config.trustDowngradeThreshold,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private emit(fields: Omit<AnomalyReport, "id" | "timestamp" | "resolved" | "resolvedAt">): AnomalyReport {
    const report: AnomalyReport = {
      id: `anom_${nanoid()}`,
      timestamp: new Date().toISOString(),
      resolved: false,
      ...fields,
    };
    this.reports.push(report);
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch {
        // listeners must not crash the detector
      }
    }
    return report;
  }
}
