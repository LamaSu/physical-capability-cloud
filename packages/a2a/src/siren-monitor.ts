/**
 * SIREN Monitor — conversation drift detection for A2A protocol.
 * Inspired by DESTILL's SIREN alignment monitor.
 *
 * Tracks conversation "coherence profiles" and alerts when messages
 * deviate significantly from the conversation baseline. Catches:
 * - Crescendo attacks (gradual escalation)
 * - Topic drift (conversation hijacking)
 * - Behavioral anomalies (sudden intent type changes)
 */

import type { A2AMessage } from "./types.js";
import type { DriftAlert } from "@pcc/spec";

interface CoherenceProfile {
  /** Intent types seen in this conversation */
  intentTypes: Map<string, number>;
  /** Average message length */
  avgLength: number;
  /** Total messages analyzed */
  messageCount: number;
  /** Last update time */
  lastUpdated: string;
}

export interface SIRENConfig {
  /** Drift score threshold for "warning" alerts (0-1, default: 0.6) */
  warningThreshold: number;
  /** Drift score threshold for "critical" alerts (0-1, default: 0.85) */
  criticalThreshold: number;
  /** Minimum messages before drift detection activates (default: 3) */
  minMessages: number;
  /** Callback when drift is detected */
  onDrift?: (alert: DriftAlert) => void;
}

const DEFAULT_CONFIG: SIRENConfig = {
  warningThreshold: 0.6,
  criticalThreshold: 0.85,
  minMessages: 3,
};

export class SIRENMonitor {
  private profiles: Map<string, CoherenceProfile> = new Map();
  private config: SIRENConfig;

  constructor(config?: Partial<SIRENConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze a message for drift. Returns a DriftAlert if drift is detected, null otherwise.
   */
  analyzeMessage(message: A2AMessage): DriftAlert | null {
    const convId = message.conversationId;
    const existing = this.profiles.get(convId);

    if (!existing) {
      // First message — establish baseline
      this.profiles.set(convId, this.createProfile(message));
      return null;
    }

    if (existing.messageCount < this.config.minMessages) {
      // Not enough data — update baseline
      this.updateProfile(existing, message);
      return null;
    }

    // Compute drift score
    const drift = this.computeDrift(existing, message);

    // Update profile (rolling)
    this.updateProfile(existing, message);

    if (drift >= this.config.criticalThreshold) {
      const alert: DriftAlert = {
        conversationId: convId,
        severity: "critical",
        driftScore: drift,
        recommendation: "TERMINATE",
        trigger: this.describeDrift(existing, message),
        detectedAt: new Date().toISOString(),
      };
      this.config.onDrift?.(alert);
      return alert;
    }

    if (drift >= this.config.warningThreshold) {
      const alert: DriftAlert = {
        conversationId: convId,
        severity: "warning",
        driftScore: drift,
        recommendation: "REVIEW",
        trigger: this.describeDrift(existing, message),
        detectedAt: new Date().toISOString(),
      };
      this.config.onDrift?.(alert);
      return alert;
    }

    return null;
  }

  /** Reset monitoring for a conversation */
  resetConversation(conversationId: string): void {
    this.profiles.delete(conversationId);
  }

  /** Get current profile for a conversation */
  getProfile(conversationId: string): CoherenceProfile | undefined {
    return this.profiles.get(conversationId);
  }

  /** Get all monitored conversation IDs */
  get monitoredConversations(): string[] {
    return [...this.profiles.keys()];
  }

  private createProfile(message: A2AMessage): CoherenceProfile {
    const intentTypes = new Map<string, number>();
    intentTypes.set(message.intent.type, 1);
    const contentLength = JSON.stringify(message.intent).length;

    return {
      intentTypes,
      avgLength: contentLength,
      messageCount: 1,
      lastUpdated: message.timestamp,
    };
  }

  private updateProfile(profile: CoherenceProfile, message: A2AMessage): void {
    const count = profile.intentTypes.get(message.intent.type) ?? 0;
    profile.intentTypes.set(message.intent.type, count + 1);

    const contentLength = JSON.stringify(message.intent).length;
    profile.avgLength =
      (profile.avgLength * profile.messageCount + contentLength) / (profile.messageCount + 1);

    profile.messageCount++;
    profile.lastUpdated = message.timestamp;
  }

  private computeDrift(profile: CoherenceProfile, message: A2AMessage): number {
    let drift = 0;

    // Factor 1: New intent type not seen before (weight: 0.4)
    if (!profile.intentTypes.has(message.intent.type)) {
      drift += 0.4;
    }

    // Factor 2: Message length anomaly (weight: 0.3)
    const contentLength = JSON.stringify(message.intent).length;
    const lengthRatio = contentLength / Math.max(profile.avgLength, 1);
    if (lengthRatio > 3 || lengthRatio < 0.2) {
      drift += 0.3;
    } else if (lengthRatio > 2 || lengthRatio < 0.3) {
      drift += 0.15;
    }

    // Factor 3: Intent type distribution anomaly (weight: 0.3)
    // If the current intent type is rare relative to the conversation
    const totalIntents = [...profile.intentTypes.values()].reduce((a, b) => a + b, 0);
    const thisTypeCount = profile.intentTypes.get(message.intent.type) ?? 0;
    const typeFrequency = thisTypeCount / totalIntents;
    if (typeFrequency < 0.1 && profile.messageCount > 5) {
      drift += 0.2;
    }

    // Factor 4: Suspicious content patterns in text fields (weight: 0.2)
    const textContent = JSON.stringify(message.intent).toLowerCase();
    const suspiciousKeywords = [
      "ignore", "override", "bypass", "forget", "pretend", "jailbreak",
      "unrestricted", "system prompt", "previous instructions",
    ];
    const keywordHits = suspiciousKeywords.filter((kw) => textContent.includes(kw));
    if (keywordHits.length > 0) {
      drift += Math.min(0.1 * keywordHits.length, 0.3);
    }

    return Math.min(drift, 1);
  }

  private describeDrift(profile: CoherenceProfile, message: A2AMessage): string {
    const parts: string[] = [];

    if (!profile.intentTypes.has(message.intent.type)) {
      parts.push(`new intent type "${message.intent.type}"`);
    }

    const contentLength = JSON.stringify(message.intent).length;
    const lengthRatio = contentLength / Math.max(profile.avgLength, 1);
    if (lengthRatio > 3) {
      parts.push(`message ${lengthRatio.toFixed(1)}x longer than average`);
    }

    return parts.length > 0 ? parts.join(", ") : "cumulative drift";
  }
}
