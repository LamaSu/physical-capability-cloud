/**
 * Evidence Verifier — checks that an evidence bundle meets tier requirements.
 *
 * This is what a verifier node runs when assigned a verification request.
 * It checks:
 *   1. Bundle hash integrity
 *   2. Event hash integrity
 *   3. Tier evidence requirements met
 *   4. Consistency checks between events (e.g., power profile matches execution duration)
 *   5. Produces a VerificationAttestation
 */

import type {
  EvidenceBundle,
  EvidenceEvent,
  VerificationAttestation,
  VerificationFinding,
  AssuranceTier,
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS, verifyBundleHash, verifyEventHash, ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";

export class EvidenceVerifier {
  private verifierId: string;
  private verifierAddress: string;

  constructor(verifierId: string, verifierAddress: string) {
    this.verifierId = verifierId;
    this.verifierAddress = verifierAddress;
  }

  /**
   * Verify an evidence bundle and produce an attestation.
   */
  async verify(bundle: EvidenceBundle): Promise<VerificationAttestation> {
    const findings: VerificationFinding[] = [];

    // 1. Verify bundle hash
    const bundleValid = await verifyBundleHash(bundle);
    findings.push({
      evidenceEventId: "",
      check: "bundle_hash_integrity",
      passed: bundleValid,
      details: bundleValid ? "Bundle hash matches events" : "Bundle hash mismatch",
      severity: bundleValid ? undefined : "critical",
    });

    // 2. Verify each event hash
    for (const event of bundle.events) {
      const eventValid = await verifyEventHash(event);
      findings.push({
        evidenceEventId: event.id,
        check: "event_hash_integrity",
        passed: eventValid,
        details: eventValid ? `Event ${event.id} hash valid` : `Event ${event.id} hash mismatch`,
        severity: eventValid ? undefined : "critical",
      });
    }

    // 3. Check tier requirements
    const tierReq = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === bundle.assuranceTier);
    if (tierReq) {
      const eventTypes = new Set(bundle.events.map((e) => e.type));
      for (const group of tierReq.requiredEventTypes) {
        const found = group.some((t) => eventTypes.has(t));
        findings.push({
          evidenceEventId: "",
          check: `tier_requirement_${group.join("_or_")}`,
          passed: found,
          details: found
            ? `Required event type present: ${group.filter((t) => eventTypes.has(t)).join(", ")}`
            : `Missing required event type: one of ${group.join(", ")}`,
          severity: found ? undefined : "critical",
        });
      }
    }

    // 4. Consistency checks
    const executionStarted = bundle.events.find((e) => e.type === "execution_started");
    const executionCompleted = bundle.events.find((e) => e.type === "execution_completed");
    if (executionStarted && executionCompleted) {
      const startTime = new Date(executionStarted.timestamp).getTime();
      const endTime = new Date(executionCompleted.timestamp).getTime();
      const durationSec = (endTime - startTime) / 1000;

      findings.push({
        evidenceEventId: executionCompleted.id,
        check: "execution_duration_positive",
        passed: durationSec > 0,
        details: `Execution duration: ${durationSec}s`,
        severity: durationSec > 0 ? undefined : "critical",
      });

      // Check power profile consistency (if present)
      const powerSummary = bundle.events.find((e) => e.type === "power_profile_summary");
      if (powerSummary) {
        const powerDuration = (powerSummary.payload as any).durationSeconds;
        const durationRatio = powerDuration / durationSec;
        const consistent = durationRatio > 0.5 && durationRatio < 2.0;

        findings.push({
          evidenceEventId: powerSummary.id,
          check: "power_duration_consistency",
          passed: consistent,
          details: `Power duration ${powerDuration}s vs execution ${durationSec}s (ratio: ${durationRatio.toFixed(2)})`,
          severity: consistent ? undefined : "warning",
        });
      }
    }

    // Compute result
    const criticalFailures = findings.filter((f) => !f.passed && f.severity === "critical");
    const passed = criticalFailures.length === 0;
    const confidence = passed
      ? 90 + (findings.filter((f) => f.passed).length / findings.length) * 10
      : Math.max(0, 50 - criticalFailures.length * 15);

    // Create attestation
    const attestationData = {
      verifierId: this.verifierId,
      bundleHash: bundle.bundleHash,
      result: passed ? "valid" : "invalid",
      confidence,
      findingsCount: findings.length,
      criticalFailures: criticalFailures.length,
    };
    const attestationHash = await sha256(canonicalize(attestationData));

    return {
      id: ids.attestation(),
      requestId: "", // filled in by caller
      verifierId: this.verifierId,
      evidenceBundleHash: bundle.bundleHash,
      result: passed ? "valid" : criticalFailures.length > 0 ? "invalid" : "inconclusive",
      confidence: Math.round(confidence * 100) / 100,
      findings,
      attestationHash,
      signature: {
        signer: this.verifierAddress as any,
        algorithm: "secp256k1",
        value: `mock_sig_${attestationHash.slice(7, 23)}`,
      },
      createdAt: new Date().toISOString(),
    };
  }
}
