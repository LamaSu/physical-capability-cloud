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
import { computeAssuranceScore } from "@pcc/verifier";
import type { CaptureVerdictRow } from "@pcc/store";
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
  CaptureVerificationSummaryDTO,
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

/**
 * Extension of BundleWithEvents for cross-facade CVP integration.
 * When captureVerdicts have been loaded for a job, they are attached to the
 * bundle so ALCOA+ computation can tighten `accurate`, `credible`, and
 * `original` based on capture verdict outcomes.
 *
 * The `captureVerdicts` field is always an array — empty when no CVP work
 * has been performed for the underlying jobId (the common case).
 */
interface BundleWithCaptureContext extends BundleWithEvents {
  captureVerdicts: CaptureVerdictRow[];
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

      // Attach captureVerdicts to each bundle so ALCOA+ can cross-reference
      // CVP outcomes. Verdicts are linked by jobId (NOT bundleId) — a job can
      // have verdicts without evidence bundles and vice versa. Missing/empty
      // is the normal case and contributes [] (no tightening).
      const bundlesWithCapture: BundleWithCaptureContext[] = bundlesWithEvents.map((b) => ({
        ...b,
        captureVerdicts: this.loadCaptureVerdictsForJob(b.raw.jobId),
      }));

      // Aggregate all events from those bundles
      const allEvents: EvidenceEvent[] = bundlesWithEvents.flatMap((b) => b.events);

      // ALCOA+ analysis — uses the capture-aware variant, which falls through
      // to plain computeAlcoa when no verdicts were found.
      const alcoaStatus = this.computeAlcoaWithCapture(bundlesWithCapture);

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

      // Compute assurance score from structured compliance data
      // Builds findings from ALCOA checks and drift alerts for the rollup
      const alcoaFindings = Object.entries(alcoaStatus).map(([principle, passed]) => ({
        check: `alcoa_${principle}`,
        passed: passed as boolean,
        severity: "warning" as const,
        details: `ALCOA+ ${principle}: ${passed ? "satisfied" : "not satisfied"}`,
      }));

      const assuranceScore = computeAssuranceScore({
        findings: alcoaFindings,
        alcoaPrinciples: alcoaStatus as unknown as Record<string, boolean>,
        driftAlerts: driftAlerts.map((a) => ({
          severity: a.severity,
          type: a.type,
        })),
      });

      // Capture-verification aggregate — only emitted when ≥1 verdict was
      // loaded from the recent bundles. Keeps the DTO tight for legacy
      // callers that don't use CVP.
      const allVerdicts = bundlesWithCapture.flatMap((b) => b.captureVerdicts);
      const captureVerification: CaptureVerificationSummaryDTO | undefined =
        allVerdicts.length > 0
          ? buildCaptureVerificationSummary(allVerdicts)
          : undefined;

      const report: ComplianceReportDTO = {
        capabilityId,
        kernelId,
        satisfiedStandards,
        alcoaStatus,
        tierCompliance,
        recentEvidence,
        driftAlerts,
        assuranceScore,
      };
      if (captureVerification) {
        report.captureVerification = captureVerification;
      }
      return report;
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

  /**
   * Load capture verdicts for a job. Returns [] when jobId is missing or
   * no verdicts exist. Never throws — verdict lookup is optional context.
   */
  private loadCaptureVerdictsForJob(jobId: string | null | undefined): CaptureVerdictRow[] {
    if (!jobId) return [];
    try {
      return this.repos.evidence.findCaptureVerdictsByJob(jobId) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * ALCOA+ with capture-verdict cross-facade tightening.
   *
   * Falls through to the base `computeAlcoa` when no verdicts are attached
   * (ensuring zero-impact for pre-CVP callers). When verdicts exist, it
   * tightens three flags per the ai/research/cvp-alcoa-integration.md
   * mapping:
   *
   *   accurate  AND noCC0ForTier2    — a CC0 capture on a tier-2+ bundle
   *                                    means the capture couldn't be
   *                                    corroborated at all, so ALCOA
   *                                    "Accurate" is not satisfied.
   *   credible  AND passRate >= 0.9  — the PCC verifier-credibility bar
   *                                    for the CVP sub-protocol.
   *   original  AND allAnchorCandidates — every verdict must be anchor-
   *                                    eligible; a non-anchorable capture
   *                                    breaks "Original" because the
   *                                    kernel signature chain is unsupported.
   */
  private computeAlcoaWithCapture(bundles: BundleWithCaptureContext[]): ALCOAStatus {
    const base = this.computeAlcoa(bundles);
    const allVerdicts = bundles.flatMap((b) => b.captureVerdicts);
    if (allVerdicts.length === 0) return base;

    const passCount = allVerdicts.filter((v) => v.verdict === "PASS").length;
    const passRate = passCount / allVerdicts.length;
    const allAnchorCandidates = allVerdicts.every((v) => v.anchorCandidate === 1);
    const noCC0ForTier2 = bundles.every(
      (b) =>
        (b.raw.assuranceTier ?? 0) < 2 ||
        !b.captureVerdicts.some((v) => v.verifiedClass === 0),
    );

    return {
      ...base,
      accurate: base.accurate && noCC0ForTier2,
      credible: base.credible && passRate >= 0.9,
      original: base.original && allAnchorCandidates,
    };
  }

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

/**
 * Build the CaptureVerificationSummaryDTO from a flat list of verdict rows.
 *
 * `verifiedClass` is the integer (0..5) stored on-chain; we map it to the
 * "CC0".."CC5" string form the dashboard expects so the UI never has to
 * reverse-map. All six buckets are zero-filled so callers can read any
 * class without guarding for `undefined`.
 */
function buildCaptureVerificationSummary(
  verdicts: CaptureVerdictRow[],
): CaptureVerificationSummaryDTO {
  const verdictCount = verdicts.length;
  const passCount = verdicts.filter((v) => v.verdict === "PASS").length;
  const failCount = verdicts.filter((v) => v.verdict === "FAIL").length;
  const partialCount = verdicts.filter((v) => v.verdict === "PARTIAL").length;
  const passRate = verdictCount > 0 ? passCount / verdictCount : 0;

  // Zero-fill all six CC-buckets, then increment from the verdict rows.
  const classHistogram: Record<string, number> = {
    CC0: 0,
    CC1: 0,
    CC2: 0,
    CC3: 0,
    CC4: 0,
    CC5: 0,
  };
  for (const v of verdicts) {
    const key = `CC${v.verifiedClass}`;
    classHistogram[key] = (classHistogram[key] ?? 0) + 1;
  }

  return {
    verdictCount,
    passRate,
    passCount,
    failCount,
    partialCount,
    classHistogram,
  };
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
