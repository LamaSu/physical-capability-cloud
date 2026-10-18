/**
 * Evidence Verifier -- checks that an evidence bundle meets tier requirements.
 *
 * This is what a verifier node runs when assigned a verification request.
 * It checks:
 *   1. Bundle hash integrity
 *   2. Event hash integrity
 *   3. Tier evidence requirements met
 *   4. Consistency checks between events (e.g., power profile matches execution duration)
 *   5. (Optional) Challenge freshness -- anti-replay proof
 *   6. (Optional) Step completeness -- workflow step coverage
 *
 * ONLY COMMITTED FIELDS AND AUTHENTICATED INPUTS DECIDE (E11c, N118). The bundle hash commits the
 * sorted multiset of event hashes, and each event hash commits `type`, `timestamp`, `source` and
 * `payload`. Nothing else in a bundle is signed: not an event's `id`, not the order of `events`, and
 * not the bundle-level fields (`assuranceTier`, `id`, `jobId`, `stepId`, `kernelId`, `createdAt`,
 * `kernelSignature`). So none of them may change a verdict.
 *   - The evidence a tier requires comes from `options.acceptedTier`: the tier the job was accepted
 *     at, which the CALLER takes from authoritative, owner-bound state (the accepted plan or its
 *     poster), never from the bundle. The bundle's own `assuranceTier` is not read at all (E11e).
 *     Without an accepted tier no requirement can be chosen, so the verdict fails closed.
 *   - A supplied tier ladder has no provenance in this verifier. This is a precheck under the
 *     caller's ladder; the oracle selects its ladder from the funded committed program identity.
 *   - The lifecycle and power events checked in step 4 are chosen by committed fields (timestamp,
 *     then hash), never by position.
 *   - A workflow step in step 6 is covered only by a committed `payload.stepId`, never by an id.
 *   - Event ids still label findings (`evidenceEventId`), as display only.
 *   7. Assurance score rollup
 *   8. Produces a VerificationAttestation
 */

import type {
  EvidenceBundle,
  EvidenceEvent,
  VerificationAttestation,
  VerificationFinding,
  AssuranceTier,
  Signature,
  Address,
  DigitalWorkflowStep,
  WorkflowChallenge,
  ExecutionProof,
  TierEvidenceRequirements,
} from "@pcc/spec";
import { types as nodeTypes } from "node:util";
import { DEFAULT_TIER_REQUIREMENTS, EVIDENCE_EVENT_TYPES, verifyBundleHash, verifyEventHash, ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";
import { computeAssuranceScore } from "./workflow/assurance-score.js";
import { checkStepCompleteness, type StepTrace } from "./workflow/completeness-checker.js";
import { ChallengeService } from "./workflow/challenge-service.js";

/** Options for digital-workflow-aware verification. All fields are optional --
 *  callers that pass nothing get the existing behavior. */
export interface DigitalVerifyOptions {
  /**
   * The assurance tier the job was ACCEPTED at, taken by the caller from authenticated state (the
   * accepted plan or its poster), never from the bundle, whose `assuranceTier` is not signed and is
   * not read (N118, E11e). It chooses the evidence required, and without it the verdict fails closed.
   */
  acceptedTier?: AssuranceTier;
  /** Declared workflow steps from the contract. Enables step-completeness checking. */
  workflowSteps?: DigitalWorkflowStep[];
  /** Challenge issued before execution. Together with executionProof, enables anti-replay freshness. */
  challenge?: WorkflowChallenge;
  /** Proof that execution happened after the challenge was issued. */
  executionProof?: ExecutionProof;
  /** Block timestamp to use for challenge age check. Defaults to Date.now()/1000. */
  currentBlockTimestamp?: bigint;
  /**
   * The caller's tier requirements, for example `compileTierLadder(csd).tiers`
   * (@pcc/spec). This option carries no provenance: the result is a precheck
   * under that ladder, not proof of the funded policy. The oracle selects its
   * ladder from the funded committed program identity. When omitted, defaults to
   * DEFAULT_TIER_REQUIREMENTS, which is FDM-shaped (gcode_hash_verified at
   * every tier), so a non-FDM bundle only passes under its own CSD's ladder.
   * Supplied ladders are copied before verification and must be dense,
   * well-formed, contiguous from tier 0, unique by tier, and monotone.
   */
  tierRequirements?: readonly TierEvidenceRequirements[];
}

/**
 * The event of `type` that comes first (`earliest`) or last (`latest`) by committed fields: its
 * timestamp, then its hash. Never by array position, and never by the unsigned `id` (E11c). An
 * unparseable timestamp sorts where the duration check then fails closed: as the latest start, or
 * as the earliest completion.
 */
function selectByCommittedOrder(
  events: readonly EvidenceEvent[],
  type: string,
  which: "earliest" | "latest",
): EvidenceEvent | undefined {
  const unparseableAs = which === "latest" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  let chosen: EvidenceEvent | undefined;
  let chosenTime = 0;
  for (const event of events) {
    if (event.type !== type) continue;
    const parsed = new Date(event.timestamp).getTime();
    const time = Number.isNaN(parsed) ? unparseableAs : parsed;
    const better =
      chosen === undefined ||
      (which === "earliest"
        ? time < chosenTime || (time === chosenTime && event.hash < chosen.hash)
        : time > chosenTime || (time === chosenTime && event.hash > chosen.hash));
    if (better) {
      chosen = event;
      chosenTime = time;
    }
  }
  return chosen;
}

/** A tier the verifier knows: an integer 0..3 (a string, NaN or an object is not one). */
function isAssuranceTier(v: unknown): v is AssuranceTier {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

const EVENT_TYPES = new Set<string>(EVIDENCE_EVENT_TYPES);

/** Read data descriptors rather than invoking accessors or caller-provided iterators. */
function dataProperties(value: unknown): PropertyDescriptorMap {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw new Error("Tier requirements must contain ordinary data objects");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Tier requirement entries must be plain objects");
  }
  const properties: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
  Object.setPrototypeOf(properties, null);
  if (Reflect.ownKeys(properties).some((key) => !Object.hasOwn(properties[key as string]!, "value"))) {
    throw new Error("Tier requirements must not contain accessors");
  }
  return properties;
}

function denseValues(value: unknown): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Tier requirements and event groups must be ordinary arrays");
  }
  const properties: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value as object);
  Object.setPrototypeOf(properties, null);
  const length = properties.length!.value as number;
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const property = properties[String(i)];
    if (!property || !Object.hasOwn(property, "value")) {
      throw new Error("Tier requirements and event groups must be dense data arrays");
    }
    result.push(property.value);
  }
  return result;
}

/** Own the requirements used across awaits, and reject ladders that can omit lower-tier promises. */
function snapshotTierRequirements(value: unknown): TierEvidenceRequirements[] {
  const snapshot: TierEvidenceRequirements[] = [];
  const seen = new Set<AssuranceTier>();
  for (const raw of denseValues(value)) {
    const properties = dataProperties(raw);
    const tier: unknown = properties.tier?.value;
    const minimumEvents: unknown = properties.minimumEvents?.value;
    const description: unknown = properties.description?.value;
    if (
      !isAssuranceTier(tier) ||
      typeof minimumEvents !== "number" || !Number.isSafeInteger(minimumEvents) || minimumEvents < 0 ||
      typeof description !== "string"
    ) {
      throw new Error("Each tier needs a tier 0..3, a nonnegative integer minimumEvents, and a description");
    }
    if (seen.has(tier)) throw new Error(`Tier ${tier} is defined more than once`);
    seen.add(tier);
    const requiredEventTypes = denseValues(properties.requiredEventTypes?.value).map((rawGroup) => {
      const group = denseValues(rawGroup);
      if (group.length === 0 || group.some((event) => typeof event !== "string" || !EVENT_TYPES.has(event))) {
        throw new Error(`Tier ${tier} contains an empty or unknown event group`);
      }
      return group as TierEvidenceRequirements["requiredEventTypes"][number];
    });
    snapshot.push({ tier, minimumEvents, description, requiredEventTypes });
  }
  snapshot.sort((a, b) => a.tier - b.tier);
  for (const [index, upper] of snapshot.entries()) {
    if (upper.tier !== index) throw new Error("Tier requirements must be contiguous from tier 0");
    for (const lower of snapshot.slice(0, index)) {
      // An OR group may become stricter: [cv] implies the default lower tier's [cv, camera].
      // It may never become weaker: [cv, camera] does not imply a lower [cv] requirement.
      const impliesLowerGroups = lower.requiredEventTypes.every((lowerGroup) =>
        upper.requiredEventTypes.some((upperGroup) => upperGroup.every((event) => lowerGroup.includes(event))),
      );
      if (!impliesLowerGroups || upper.minimumEvents < lower.minimumEvents) {
        throw new Error(`Tier ${upper.tier} weakens tier ${lower.tier}'s requirements`);
      }
    }
  }
  return snapshot;
}

export class EvidenceVerifier {
  private verifierId: string;
  private verifierAddress: string;
  private signFn: (data: string) => Promise<Signature>;

  constructor(
    verifierId: string,
    verifierAddress: string,
    signFn?: (data: string) => Promise<Signature>,
  ) {
    this.verifierId = verifierId;
    this.verifierAddress = verifierAddress;
    // TEST-ONLY default -- replace with a real wallet signFn in production
    this.signFn = signFn ?? (async (data: string) => ({
      signer: verifierAddress as Address,
      algorithm: "secp256k1" as const,
      value: `test_sig_${data.slice(0, 16)}`,
    }));
  }

  /**
   * Verify an evidence bundle and produce an attestation.
   *
   * @param bundle   The evidence bundle to verify.
   * @param options  Optional digital-workflow data. When omitted, existing
   *                 behavior is preserved exactly (backward compatible).
   */
  async verify(
    bundle: EvidenceBundle,
    options?: DigitalVerifyOptions,
  ): Promise<VerificationAttestation> {
    const findings: VerificationFinding[] = [];
    const acceptedTier = options?.acceptedTier;
    let ladder: TierEvidenceRequirements[] | undefined;
    let ladderError: string | undefined;
    if (isAssuranceTier(acceptedTier)) {
      try {
        const supplied = options?.tierRequirements;
        ladder = snapshotTierRequirements(supplied === undefined ? DEFAULT_TIER_REQUIREMENTS : supplied);
      } catch {
        // A caller accessor can throw any value, including a Proxy. Do not inspect that value.
        ladderError = "Malformed tier requirements";
      }
    }

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

    // 3. Tier requirements, chosen by the ACCEPTED tier only (N118, E11e). The bundle's own assuranceTier
    // is not signed, so it is not read at all.
    if (!isAssuranceTier(acceptedTier)) {
      findings.push({
        evidenceEventId: "",
        check: "assurance_tier_accepted",
        passed: false,
        details:
          "No accepted tier was supplied: the bundle's own assuranceTier is not signed, so it cannot choose the evidence required",
        severity: "critical",
      });
    } else {
      // The bundle's own assuranceTier is never read, not even to compare (E11e): an unsigned field may
      // not change a verdict in either direction.
      findings.push({
        evidenceEventId: "",
        check: "assurance_tier_accepted",
        passed: true,
        details: `The evidence required is the accepted tier ${acceptedTier}'s`,
      });
      // Shape validation proves no policy provenance. The oracle resolves the ladder from the
      // funded committed program identity; this verifier only prechecks the caller's snapshot.
      const tierReq = ladder?.find((r) => r.tier === acceptedTier);
      if (ladderError !== undefined) {
        findings.push({
          evidenceEventId: "",
          check: "tier_requirements_valid",
          passed: false,
          details: `Invalid tier requirements: ${ladderError}`,
          severity: "critical",
        });
      } else if (!tierReq) {
        // An accepted tier the funded capability's ladder does not define proves nothing: fail closed.
        findings.push({
          evidenceEventId: "",
          check: "tier_requirement_defined",
          passed: false,
          details: `Tier ${acceptedTier} is not defined by the tier requirements in force`,
          severity: "critical",
        });
      } else {
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
    }

    // 4. Consistency checks. The latest start and the earliest completion, by committed fields (E11c):
    // a positive duration then means every completion follows every start, whatever the order.
    const executionStarted = selectByCommittedOrder(bundle.events, "execution_started", "latest");
    const executionCompleted = selectByCommittedOrder(bundle.events, "execution_completed", "earliest");
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
      const powerSummary = selectByCommittedOrder(bundle.events, "power_profile_summary", "earliest");
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

    // ── Digital-verifier primitives (pre-oracle checks) ──────────────

    // 5. Challenge freshness check (anti-replay)
    if (options?.challenge && options?.executionProof) {
      const challengeService = new ChallengeService();
      const proofResult = challengeService.verifyExecutionProof({
        challenge: options.challenge,
        proof: options.executionProof,
        currentBlockTimestamp: options.currentBlockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)),
      });
      findings.push({
        evidenceEventId: "",
        check: "challenge_freshness",
        passed: proofResult.valid,
        details: proofResult.valid
          ? "Execution proof is fresh and matches challenge"
          : proofResult.failures.join("; "),
        severity: proofResult.valid ? undefined : "critical",
      });
    }

    // 6. Step completeness check (workflow coverage)
    if (options?.workflowSteps && options.workflowSteps.length > 0) {
      // A step is covered only by a COMMITTED payload.stepId: the unsigned event id never counts (E11c).
      const traces: StepTrace[] = bundle.events
        .filter(
          (e) =>
            (e.type === "workflow_step_completed" || e.type === "execution_completed") &&
            typeof (e.payload as any)?.stepId === "string",
        )
        .map((e) => ({
          stepId: (e.payload as any).stepId,
          outputHash: (e.payload as any).outputHash ?? e.hash,
          outputSummary: (e.payload as any).outputSummary ?? "",
          durationMs: (e.payload as any).durationMs,
          inputHash: (e.payload as any).inputHash,
        }));

      const completeness = checkStepCompleteness(
        { workflowSteps: options.workflowSteps },
        traces,
        { level: 1 },
      );
      findings.push(...completeness.findings);
    }

    // ── Assurance score rollup ───────────────────────────────────────

    const assuranceScore = computeAssuranceScore({
      findings: findings.map((f) => ({
        check: f.check,
        passed: f.passed,
        details: f.details,
        severity: f.severity === "info" ? undefined : f.severity,
      })),
      driftAlerts: [],
      consensusAgreement: undefined,
    });

    // ── Compute result ───────────────────────────────────────────────

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
      assuranceScore,
    };
    const attestationHash = await sha256(canonicalize(attestationData));
    const now = new Date().toISOString();

    // Generate POAW-style audit receipt
    const auditReceiptData = {
      attestationHash,
      verifierId: this.verifierId,
      checksPerformed: findings.length,
      timestamp: now,
    };
    const scanHash = await sha256(canonicalize(auditReceiptData));

    const signature = await this.signFn(attestationHash);

    return {
      id: ids.attestation(),
      requestId: "", // filled in by caller
      verifierId: this.verifierId,
      evidenceBundleHash: bundle.bundleHash,
      result: passed ? "valid" : criticalFailures.length > 0 ? "invalid" : "inconclusive",
      confidence: Math.round(confidence * 100) / 100,
      findings,
      attestationHash,
      signature,
      createdAt: now,
      assuranceScore,
      auditReceipt: {
        scanHash,
        chainPosition: 0,
        checksPerformed: findings.length,
        timestamp: now,
      },
    };
  }
}
