/**
 * Compliance Facade — business logic for evidence compliance, drift detection,
 * and attestation aggregation.
 *
 * Provides:
 * - Evidence listing and bundle retrieval (with EvidenceSummaryDTO population)
 * - Tier compliance checking (per DEFAULT_TIER_REQUIREMENTS)
 * - Drift detection (CWM expected vs. evidence actual)
 * - Full compliance report generation (ALCOA+, ISO 9001, tier compliance, drift)
 * - Multi-verifier attestation aggregation (simple majority consensus)
 *
 * Access: verification, settlement, operator, admin roles only.
 */

import { type Result } from "@pcc/spec";
import type {
  EvidenceEvent,
  AssuranceTier,
  VerificationAttestation,
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS, DEFAULT_VERIFIER_CRITERIA } from "@pcc/spec";
import type { CWMStep } from "@pcc/spec";
import { BaseFacade } from "./base.facade.js";
import type {
  EvidenceSummaryDTO,
  ComplianceReportDTO,
  DriftAlertDTO,
  ALCOAStatus,
  TierComplianceResult,
  AggregatedAttestationDTO,
  AgentRole,
  PopulationContext,
} from "./types.js";
import {
  populateEvidenceSummaryDTO,
  populateEvidenceList,
  type RawEvidenceBundle,
} from "./populators/compliance.populator.js";
import { detectDrifts } from "./drift-detector.js";

// ── ISO 9001 / FDA Part 11 audit standard constants ───────────────────────────

const ISO_9001_PRODUCTION_CONTROL = "ISO-9001:8.5.1";
const ISO_9001_TRACEABILITY = "ISO-9001:8.5.2";
const ISO_9001_INSPECTION = "ISO-9001:8.6";
const ISO_9001_MEASUREMENT = "ISO-9001:9.1.1";
const ISO_9001_TEE = "ISO-9001:8.6-TEE";
const FDA_21_CFR_PART_11 = "FDA-21CFR-Part11";

// ── Internal error helper ─────────────────────────────────────────────────────

class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
  }
}

// ── Bundle shape with pre-loaded events ──────────────────────────────────────

interface BundleWithEvents {
  raw: RawEvidenceBundle;
  events: EvidenceEvent[];
}

// ── ComplianceFacade ──────────────────────────────────────────────────────────

export class ComplianceFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "verification",
    "settlement",
    "operator",
    "admin",
  ];

  constructor() {
    super("compliance");
  }

  // ── Evidence Access ───────────────────────────────────────────────────────

  /**
   * List all evidence bundles for a job as EvidenceSummaryDTOs.
   * Sorted most-recent-first.
   */
  async getEvidenceForJob(jobId: string): Promise<Result<EvidenceSummaryDTO[]>> {
    return this.execute("getEvidenceForJob", async () => {
      const rawBundles = this.repos.evidence.findByJob(jobId) as RawEvidenceBundle[];
      return populateEvidenceList(rawBundles);
    });
  }

  /**
   * Get a single evidence bundle by ID.
   */
  async getBundle(bundleId: string): Promise<Result<EvidenceSummaryDTO>> {
    return this.execute("getBundle", async () => {
      const raw = this.repos.evidence.findById(bundleId) as RawEvidenceBundle | undefined;
      if (!raw) throw new NotFoundError("evidence bundle", bundleId);
      return populateEvidenceSummaryDTO(raw);
    });
  }

  // ── Tier Compliance ───────────────────────────────────────────────────────

  /**
   * Check whether an evidence bundle meets its tier requirements.
   * Uses DEFAULT_TIER_REQUIREMENTS from @pcc/spec.
   */
  async checkTierCompliance(bundleId: string): Promise<Result<TierComplianceResult>> {
    return this.execute("checkTierCompliance", async () => {
      const raw = this.repos.evidence.findById(bundleId) as RawEvidenceBundle | undefined;
      if (!raw) throw new NotFoundError("evidence bundle", bundleId);

      const events = this.repos.evidence.findEventsByBundle(bundleId) as EvidenceEvent[];
      const tier = (raw.assuranceTier ?? 0) as AssuranceTier;

      return computeTierCompliance(events, tier);
    });
  }

  // ── Drift Detection ───────────────────────────────────────────────────────

  /**
   * Detect drift for all bundles associated with a job.
   * Compares evidence events against CWM-expected parameters (when provided).
   * Returns a flat list of DriftAlertDTOs across all bundles.
   */
  async detectDrift(jobId: string, cwmStep?: CWMStep): Promise<Result<DriftAlertDTO[]>> {
    return this.execute("detectDrift", async () => {
      const rawBundles = this.repos.evidence.findByJob(jobId) as RawEvidenceBundle[];
      const allAlerts: DriftAlertDTO[] = [];

      for (const raw of rawBundles) {
        const events = this.repos.evidence.findEventsByBundle(raw.id) as EvidenceEvent[];
        const tier = (raw.assuranceTier ?? 0) as AssuranceTier;

        const alerts = detectDrifts({
          evidenceEvents: events,
          assuranceTier: tier,
          cwmStep,
        });

        allAlerts.push(...alerts);
      }

      return allAlerts;
    });
  }

  // ── Compliance Report ─────────────────────────────────────────────────────

  /**
   * Generate a full compliance report for a capability.
   *
   * Includes:
   * - ALCOA+ status checks
   * - ISO 9001 / FDA Part 11 satisfied standards
   * - Tier compliance map (tiers 0–3)
   * - Recent evidence bundles (up to 10)
   * - Drift alerts across the 5 most recent bundles
   */
  async generateComplianceReport(
    capabilityId: string,
    _ctx?: Partial<PopulationContext>,
  ): Promise<Result<ComplianceReportDTO>> {
    return this.execute("generateComplianceReport", async () => {
      const capability = this.repos.capabilities.findById(capabilityId);
      if (!capability) throw new NotFoundError("capability", capabilityId);

      const kernelId: string = capability.kernelId;

      // Load up to 20 recent bundles for this kernel
      const allKernelBundles = this.repos.evidence.findByKernel(kernelId) as RawEvidenceBundle[];
      const recentBundles = allKernelBundles
        .slice()
        .sort(
          (a, b) =>
            new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
        )
        .slice(0, 20);

      // Load events for the 5 most recent bundles (used for ALCOA+ and drift)
      const bundlesWithEvents: BundleWithEvents[] = recentBundles.slice(0, 5).map((raw) => {
        try {
          const events = this.repos.evidence.findEventsByBundle(raw.id) as EvidenceEvent[];
          return { raw, events };
        } catch {
          return { raw, events: [] };
        }
      });

      // Aggregate all events from those bundles
      const allEvents: EvidenceEvent[] = bundlesWithEvents.flatMap((b) => b.events);

      // ALCOA+ analysis
      const alcoaStatus = this.computeAlcoa(bundlesWithEvents);

      // Tier compliance map — check all 4 tiers against the combined event set
      const tierCompliance: Record<AssuranceTier, boolean> = {
        0: computeTierCompliance(allEvents, 0).compliant,
        1: computeTierCompliance(allEvents, 1).compliant,
        2: computeTierCompliance(allEvents, 2).compliant,
        3: computeTierCompliance(allEvents, 3).compliant,
      };

      // Drift detection across the 5 most recent bundles
      const driftAlerts: DriftAlertDTO[] = bundlesWithEvents.flatMap(({ raw, events }) =>
        detectDrifts({
          evidenceEvents: events,
          assuranceTier: (raw.assuranceTier ?? 0) as AssuranceTier,
        }),
      );

      // ISO 9001 / FDA regulatory standard detection
      const satisfiedStandards = computeSatisfiedStandards(allEvents, alcoaStatus);

      // Recent evidence as DTOs (up to 10)
      const recentEvidence = populateEvidenceList(recentBundles.slice(0, 10));

      return {
        capabilityId,
        kernelId,
        satisfiedStandards,
        alcoaStatus,
        tierCompliance,
        recentEvidence,
        driftAlerts,
      };
    });
  }

  // ── Attestation Aggregation ───────────────────────────────────────────────

  /**
   * Aggregate multiple VerificationAttestations into a single consensus result.
   *
   * Algorithm:
   * 1. Count valid / invalid / inconclusive from each verifier (deduplicated by verifierId).
   * 2. Determine quorum required for the job's assurance tier.
   * 3. If quorum not reached → "no_quorum".
   * 4. Majority of valid → "valid". Majority of invalid → "invalid". Otherwise → "inconclusive".
   * 5. Aggregate confidence = arithmetic mean of individual confidence scores.
   */
  async aggregateAttestations(
    jobId: string,
    attestations: VerificationAttestation[],
  ): Promise<Result<AggregatedAttestationDTO>> {
    return this.execute("aggregateAttestations", async () => {
      if (!attestations.length) {
        return buildNoQuorumResult(jobId, attestations, 1);
      }

      // Resolve tier from the first evidence bundle for this job
      const rawBundles = this.repos.evidence.findByJob(jobId) as RawEvidenceBundle[];
      const tier = ((rawBundles[0]?.assuranceTier ?? 0) as AssuranceTier);
      const criteria = DEFAULT_VERIFIER_CRITERIA[tier];
      const quorumRequired = criteria.quorum;

      // Deduplicate: keep only the most recent attestation per verifier
      const unique = deduplicateByVerifier(attestations);
      const quorumAchieved = unique.length;

      if (quorumAchieved < quorumRequired) {
        return buildNoQuorumResult(jobId, attestations, quorumRequired);
      }

      // Count votes and sum confidence
      let validCount = 0;
      let invalidCount = 0;
      let totalConfidence = 0;

      for (const att of unique) {
        if (att.result === "valid") validCount++;
        else if (att.result === "invalid") invalidCount++;
        totalConfidence += att.confidence;
      }

      const total = unique.length;
      const aggregatedConfidence = total > 0 ? totalConfidence / total : 0;

      // Simple majority consensus
      let consensus: AggregatedAttestationDTO["consensus"];
      if (validCount > total / 2) {
        consensus = "valid";
      } else if (invalidCount > total / 2) {
        consensus = "invalid";
      } else {
        consensus = "inconclusive";
      }

      return {
        jobId,
        attestations: unique.map((att) => ({
          verifierId: att.verifierId,
          result: att.result,
          confidence: att.confidence,
          timestamp: att.createdAt,
        })),
        consensus,
        quorumRequired,
        quorumAchieved,
        aggregatedConfidence: Math.round(aggregatedConfidence * 100) / 100,
      };
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /** Compute ALCOA+ status from a set of bundles with their pre-loaded events. */
  private computeAlcoa(bundles: BundleWithEvents[]): ALCOAStatus {
    if (!bundles.length) return falseAlcoa();

    const allEvents = bundles.flatMap((b) => b.events);
    const allBundles = bundles.map((b) => b.raw);

    // Attributable: every event has a non-empty source.deviceId and source.kernelId
    const attributable = allEvents.every(
      (e) => e.source?.deviceId && e.source?.kernelId,
    );

    // Legible: every event has a 64-char hex hash; every bundle has a non-empty bundleHash
    const legible =
      allEvents.every((e) => typeof e.hash === "string" && e.hash.length === 64) &&
      allBundles.every((b) => typeof b.bundleHash === "string" && (b.bundleHash as string).length > 0);

    // Contemporaneous: timestamps are valid ISO strings and span ≤ 48 hours
    const contemporaneous = checkTimestampsContemporaneous(allEvents);

    // Original: kernelSignature is present and signer is not the zero-address test signer
    const ZERO_SIGNER = "0x0000000000000000000000000000000000000000";
    const original = allBundles.every((b) => {
      const sig = (b as any).kernelSignature as { signer?: string } | undefined;
      return sig !== undefined && sig.signer !== ZERO_SIGNER;
    });

    // Accurate: each bundle's events satisfy the bundle's declared tier requirements
    const accurate = bundles.every(({ raw, events }) => {
      const tier = (raw.assuranceTier ?? 0) as AssuranceTier;
      return computeTierCompliance(events, tier).compliant;
    });

    // Consistent: no high/critical duration_mismatch alerts
    const consistent = !bundles.some(({ raw, events }) =>
      detectDrifts({
        evidenceEvents: events,
        assuranceTier: (raw.assuranceTier ?? 0) as AssuranceTier,
      }).some(
        (a) =>
          a.type === "duration_mismatch" &&
          (a.severity === "high" || a.severity === "critical"),
      ),
    );

    // Complete: no sensor_gap alerts across any bundle
    const complete = !bundles.some(({ raw, events }) =>
      detectDrifts({
        evidenceEvents: events,
        assuranceTier: (raw.assuranceTier ?? 0) as AssuranceTier,
      }).some((a) => a.type === "sensor_gap"),
    );

    // Credible: assumed true at report level; can be enriched via aggregateAttestations
    const credible = true;

    // Enduring: at least one bundle has a storageCid (IPFS archival)
    const enduring = allBundles.some(
      (b) => typeof b.storageCid === "string" && (b.storageCid as string).length > 0,
    );

    // Available: bundles were retrieved successfully
    const available = allBundles.length > 0;

    return {
      attributable,
      legible,
      contemporaneous,
      original,
      accurate,
      consistent,
      complete,
      credible,
      enduring,
      available,
    };
  }
}

// ── Pure Computation Helpers (module-level) ───────────────────────────────────

/** Check a set of events against a single tier's requirements */
function computeTierCompliance(
  events: EvidenceEvent[],
  tier: AssuranceTier,
): TierComplianceResult {
  const tierReqs = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === tier);

  if (!tierReqs) {
    return {
      tier,
      compliant: false,
      missingEventTypes: [],
      presentEventTypes: [],
      totalEvents: events.length,
      minimumRequired: 0,
    };
  }

  const presentTypeSet = new Set(events.map((e) => e.type));
  const presentEventTypes: string[] = [...presentTypeSet];
  const missingEventTypes: string[] = [];

  for (const group of tierReqs.requiredEventTypes) {
    const satisfied = group.some((t) => presentTypeSet.has(t as EvidenceEvent["type"]));
    if (!satisfied) {
      missingEventTypes.push(group.join("|"));
    }
  }

  const compliant =
    missingEventTypes.length === 0 && events.length >= tierReqs.minimumEvents;

  return {
    tier,
    compliant,
    missingEventTypes,
    presentEventTypes,
    totalEvents: events.length,
    minimumRequired: tierReqs.minimumEvents,
  };
}

/** Check that timestamps are valid and span a reasonable window (≤ 48 hours) */
function checkTimestampsContemporaneous(events: EvidenceEvent[]): boolean {
  if (!events.length) return true;

  if (events.some((e) => !e.timestamp || isNaN(new Date(e.timestamp).getTime()))) {
    return false;
  }

  const times = events.map((e) => new Date(e.timestamp).getTime());
  const earliest = Math.min(...times);
  const latest = Math.max(...times);

  // Events should span ≤ 48 hours
  return latest - earliest <= 48 * 60 * 60 * 1000;
}

/** Compute satisfied ISO 9001 / FDA Part 11 standards from events and ALCOA status */
function computeSatisfiedStandards(
  events: EvidenceEvent[],
  alcoa: ALCOAStatus,
): string[] {
  const standards: string[] = [];
  const eventTypes = new Set(events.map((e) => e.type));

  if (eventTypes.has("execution_started") && eventTypes.has("execution_completed")) {
    standards.push(ISO_9001_PRODUCTION_CONTROL);
  }

  if (eventTypes.has("gcode_hash_verified") && eventTypes.has("execution_completed")) {
    standards.push(ISO_9001_TRACEABILITY);
  }

  if (eventTypes.has("cv_inspection_result") || eventTypes.has("camera_snapshot")) {
    standards.push(ISO_9001_INSPECTION);
  }

  if (eventTypes.has("power_profile_summary") || eventTypes.has("temperature_log")) {
    standards.push(ISO_9001_MEASUREMENT);
  }

  if (eventTypes.has("tee_attestation")) {
    standards.push(ISO_9001_TEE);
  }

  if (alcoa.attributable && alcoa.contemporaneous && alcoa.original) {
    standards.push(FDA_21_CFR_PART_11);
  }

  return standards;
}

/** Build a no_quorum aggregation result */
function buildNoQuorumResult(
  jobId: string,
  attestations: VerificationAttestation[],
  quorumRequired: number,
): AggregatedAttestationDTO {
  return {
    jobId,
    attestations: attestations.map((att) => ({
      verifierId: att.verifierId,
      result: att.result,
      confidence: att.confidence,
      timestamp: att.createdAt,
    })),
    consensus: "no_quorum",
    quorumRequired,
    quorumAchieved: attestations.length,
    aggregatedConfidence: 0,
  };
}

/**
 * Deduplicate attestations by verifierId.
 * Keeps the most recently created attestation per verifier.
 */
function deduplicateByVerifier(attestations: VerificationAttestation[]): VerificationAttestation[] {
  const map = new Map<string, VerificationAttestation>();
  for (const att of attestations) {
    const existing = map.get(att.verifierId);
    if (
      !existing ||
      new Date(att.createdAt).getTime() > new Date(existing.createdAt).getTime()
    ) {
      map.set(att.verifierId, att);
    }
  }
  return [...map.values()];
}

/** Return a fully-false ALCOA+ status (used when no bundles are available) */
function falseAlcoa(): ALCOAStatus {
  return {
    attributable: false,
    legible: false,
    contemporaneous: false,
    original: false,
    accurate: false,
    consistent: false,
    complete: false,
    credible: false,
    enduring: false,
    available: false,
  };
}
