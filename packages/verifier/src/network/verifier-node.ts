/**
 * VerifierNode — a single node in the private verification network.
 *
 * Each node independently verifies evidence bundles using deterministic
 * checks (hash integrity, tier compliance, missing fields) combined with
 * quality-tier scoring. This is the production replacement for MockMiner,
 * reusing its proven defect-detection logic but with:
 *   - Ed25519 signing (HMAC-based for portability)
 *   - Deterministic scoring (no random noise)
 *   - Structured node identity (id, publicKey, stake, reputation)
 */

import type { EvidenceBundle, EvidenceEventType } from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import type {
  VerifierNodeInfo,
  VerificationRequest,
  VerificationResponse,
  NodeStatus,
} from "./types.js";
import { createHmac, randomBytes } from "node:crypto";

/** Quality tier of the verifier node — determines verification thoroughness */
export type VerifierQuality = "excellent" | "good" | "acceptable";

const QUALITY_THRESHOLDS: Record<VerifierQuality, { baseAccuracy: number; minScore: number; maxScore: number }> = {
  excellent: { baseAccuracy: 0.97, minScore: 0.95, maxScore: 1.0 },
  good: { baseAccuracy: 0.85, minScore: 0.80, maxScore: 0.94 },
  acceptable: { baseAccuracy: 0.70, minScore: 0.65, maxScore: 0.79 },
};

export interface VerifierNodeConfig {
  /** Unique node identifier */
  id: string;
  /** HMAC secret key (hex). If omitted, a random key is generated. */
  privateKey?: string;
  /** Quality tier of this node */
  quality?: VerifierQuality;
  /** Amount of stake */
  stake?: number;
  /** HTTP endpoint (for future networked mode) */
  endpoint?: string;
}

export class VerifierNode {
  readonly id: string;
  readonly quality: VerifierQuality;

  private privateKey: string;
  private publicKey: string;
  private stake: number;
  private reputation: number;
  private status: NodeStatus;
  private endpoint: string;
  private totalVerifications: number = 0;

  constructor(config: VerifierNodeConfig) {
    this.id = config.id;
    this.quality = config.quality ?? "good";
    this.stake = config.stake ?? 1000;
    this.reputation = 100;
    this.status = "online";
    this.endpoint = config.endpoint ?? `http://localhost:0/verify/${config.id}`;

    // Key pair: use HMAC-SHA256 as a portable signing mechanism
    this.privateKey = config.privateKey ?? randomBytes(32).toString("hex");
    // Public key is a hash of the private key (deterministic derivation)
    this.publicKey = createHmac("sha256", "pcc-verifier-pk")
      .update(this.privateKey)
      .digest("hex");
  }

  /**
   * Verify an evidence bundle and produce a signed response.
   * All checks are deterministic — no random noise.
   */
  async verify(request: VerificationRequest): Promise<VerificationResponse> {
    const startTime = Date.now();
    const defects: string[] = [];
    let score: number;
    let tierCompliant: boolean;

    try {
      const bundle: EvidenceBundle = JSON.parse(request.bundleData);

      // 1. Hash integrity check (critical — always detected)
      const hashValid = bundle.bundleHash === request.bundleHash;
      if (!hashValid) {
        defects.push("bundle_hash_mismatch");
      }

      // 2. Tier compliance check (critical — always detected)
      tierCompliant = this.checkTierCompliance(bundle, request.requiredTier);
      if (!tierCompliant) {
        defects.push(`tier_${request.requiredTier}_requirements_not_met`);
      }

      // 3. Empty bundle check (critical)
      if (bundle.events.length === 0) {
        defects.push("empty_evidence_bundle");
      }

      // 4. Missing required fields
      if (!bundle.kernelSignature) {
        defects.push("missing_kernel_signature");
      }
      if (!bundle.bundleHash) {
        defects.push("missing_bundle_hash");
      }

      // 5. Sensor data plausibility (quality-dependent depth)
      const sensorDefects = this.checkSensorPlausibility(bundle);
      defects.push(...sensorDefects);

      // 6. Timestamp ordering
      const timestampDefects = this.checkTimestampOrdering(bundle);
      defects.push(...timestampDefects);

      // Deterministic scoring based on defect severity
      const criticalDefectCount = defects.filter(
        (d) =>
          d === "bundle_hash_mismatch" ||
          d === "empty_evidence_bundle" ||
          d.startsWith("tier_"),
      ).length;

      const softDefectCount = defects.length - criticalDefectCount;

      if (criticalDefectCount > 0) {
        // Critical defects heavily penalize score
        score = Math.max(0, 0.3 - criticalDefectCount * 0.15);
      } else if (softDefectCount > 0) {
        // Soft defects moderately penalize score
        const qualityConfig = QUALITY_THRESHOLDS[this.quality];
        score = Math.max(
          qualityConfig.minScore,
          qualityConfig.maxScore - softDefectCount * 0.1,
        );
      } else {
        // Clean evidence — score in quality tier range
        const qualityConfig = QUALITY_THRESHOLDS[this.quality];
        score = qualityConfig.maxScore;
      }

      // Override tierCompliant if hash failed
      if (!hashValid) {
        tierCompliant = false;
      }
    } catch {
      // Failed to parse evidence data
      score = 0;
      tierCompliant = false;
      defects.push("invalid_evidence_data");
    }

    const processingTimeMs = Math.max(1, Date.now() - startTime);

    // Build response payload and sign it
    const responsePayload = `${request.requestId}:${this.id}:${score}:${tierCompliant}:${defects.join(",")}`;
    const signature = this.sign(responsePayload);

    this.totalVerifications++;

    return {
      requestId: request.requestId,
      nodeId: this.id,
      score: Math.round(score * 1000) / 1000,
      tierCompliant,
      defectsFound: defects,
      processingTimeMs,
      signature,
    };
  }

  /**
   * Sign data using HMAC-SHA256 with this node's private key.
   * In production, this would use Ed25519 via libsodium or noble-ed25519.
   */
  sign(data: string): string {
    return createHmac("sha256", this.privateKey).update(data).digest("hex");
  }

  /** Get node info for network registration */
  getInfo(): VerifierNodeInfo {
    return {
      id: this.id,
      endpoint: this.endpoint,
      publicKey: this.publicKey,
      stake: this.stake,
      reputation: this.reputation,
      status: this.status,
    };
  }

  /** Update reputation (called by consensus engine) */
  updateReputation(delta: number): void {
    this.reputation = Math.max(0, this.reputation + delta);
  }

  /** Get current reputation */
  getReputation(): number {
    return this.reputation;
  }

  /** Get total verifications processed */
  getTotalVerifications(): number {
    return this.totalVerifications;
  }

  /** Set node online/offline */
  setStatus(status: NodeStatus): void {
    this.status = status;
  }

  /** Get current status */
  getStatus(): NodeStatus {
    return this.status;
  }

  /** Get stake amount */
  getStake(): number {
    return this.stake;
  }

  // ── Private verification logic ──────────────────────────────────────

  /** Check that the bundle contains required evidence types for the tier */
  private checkTierCompliance(bundle: EvidenceBundle, requiredTier: number): boolean {
    const tierReq = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === requiredTier);
    if (!tierReq) return true; // Unknown tier, pass by default

    const eventTypes = new Set(bundle.events.map((e) => e.type));

    for (const group of tierReq.requiredEventTypes) {
      const found = group.some((t) => eventTypes.has(t as EvidenceEventType));
      if (!found) return false;
    }

    if (bundle.events.length < tierReq.minimumEvents) return false;

    return true;
  }

  /** Validate sensor data ranges for plausibility */
  private checkSensorPlausibility(bundle: EvidenceBundle): string[] {
    const defects: string[] = [];

    for (const event of bundle.events) {
      if (event.type === "power_profile_summary") {
        const avgWatts = (event.payload as Record<string, unknown>).avgWatts;
        if (typeof avgWatts === "number") {
          if (avgWatts < 0) defects.push("negative_power_reading");
          if (avgWatts > 50000) defects.push("implausible_power_reading");
        }
        const durationSeconds = (event.payload as Record<string, unknown>).durationSeconds;
        if (typeof durationSeconds === "number" && durationSeconds < 0) {
          defects.push("negative_duration");
        }
      }

      if (event.type === "temperature_log") {
        const temp = (event.payload as Record<string, unknown>).temperature;
        if (typeof temp === "number") {
          if (temp < -273.15) defects.push("below_absolute_zero");
          if (temp > 5000) defects.push("implausible_temperature");
        }
      }
    }

    return defects;
  }

  /** Check that event timestamps are in non-decreasing order */
  private checkTimestampOrdering(bundle: EvidenceBundle): string[] {
    const defects: string[] = [];
    const timestamps = bundle.events.map((e) => new Date(e.timestamp).getTime());

    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        defects.push("timestamp_ordering_violation");
        break; // One defect is enough
      }
    }

    return defects;
  }
}
