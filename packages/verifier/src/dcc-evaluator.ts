/**
 * DCC Evaluator — scores an InvocationReceipt and produces an assurance score.
 *
 * Mirrors the pattern in `./evidence-verifier.ts`: takes a receipt + optional
 * tool metadata, runs a series of checks producing `DccEvaluationFinding`
 * rows, rolls them up to a numeric assurance score, and emits a verdict.
 *
 * The score equation matches CVP's `evidenceScore × captureMultiplier`:
 *
 *     finalScore = baseScore * DCC_MULTIPLIERS[effectiveDccClass]
 *
 * where `baseScore` starts at 100 and is decremented for each failing check.
 * If `effectiveDccClass < requestedDccClass`, a downgrade is noted but the
 * multiplier corresponds to the EFFECTIVE class (not the requested) — the
 * caller already paid the price of their downgrade choice via the lower
 * multiplier, no additional penalty applied.
 *
 * Pure synchronous evaluation. No crypto verification here — that's the
 * receipt-signer's domain (HMAC for DCC1, JWS for DCC2, Sigstore for DCC3,
 * etc.). This evaluator only verifies the SHAPE of the receipt and that
 * required fields for the claimed DCC class are present.
 *
 * Used by:
 *   - /api/aggregator/invoke route (immediately after signing the receipt)
 *   - /api/aggregator/receipts/:id route (re-validate persisted receipts)
 *   - downstream auditors who want to recompute the score independently
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §3 + §7
 */

import {
  type InvocationReceipt,
  type IndexedTool,
  DigitalCaptureClass,
  DCC_MULTIPLIERS,
  DCC_TIER,
  TrustTier,
  TRUST_TIER_DCC_CEILING,
  TRUST_TIER_NUMERIC,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Finding / result types
// ---------------------------------------------------------------------------

/** A single check produced during DCC evaluation. Mirrors VerificationFinding. */
export interface DccEvaluationFinding {
  /** Short identifier for the check (e.g. "hmac_signature_present"). */
  check: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Human-friendly explanation. */
  details: string;
  /** Severity if failed: "critical" -> invalidates; "warning" -> noted; "info" -> log. */
  severity?: "critical" | "warning" | "info";
}

/**
 * Result of evaluating an InvocationReceipt.
 *
 * `finalScore` is in [0, 100]; downstream economics charge per-receipt fees
 * based on `effectiveDccClass`, not `finalScore`. Score is for ranking/trust
 * surfacing, not pricing.
 *
 * `verdict` is "valid" when all critical checks pass, "invalid" when any
 * critical check fails, "inconclusive" when no critical failures but warnings
 * accumulated below a confidence threshold.
 */
export interface DccEvaluationResult {
  /** Final 0..100 assurance score after applying DCC multiplier. */
  finalScore: number;
  /** Base score before multiplier. */
  baseScore: number;
  /** Multiplier applied (DCC_MULTIPLIERS[effectiveDccClass]). */
  multiplier: number;
  /** What the caller asked for. */
  requestedDccClass: DigitalCaptureClass;
  /** What was achieved after the min-of-three downgrade rule. */
  effectiveDccClass: DigitalCaptureClass;
  /** True iff effective < requested. */
  downgraded: boolean;
  /** All checks run, in order. */
  findings: DccEvaluationFinding[];
  /** Overall verdict. */
  verdict: "valid" | "invalid" | "inconclusive";
  /** 0..100 confidence in the verdict. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate an InvocationReceipt against an optional IndexedTool context.
 *
 * If `tool` is provided, the trust-tier ceiling check runs. Otherwise the
 * evaluator assumes the receipt's effectiveDccClass was already computed
 * correctly by the receipt-signer.
 *
 * The function is intentionally pure / synchronous — no IO, no crypto. Crypto
 * verification (HMAC for DCC1, JWS for DCC2, Sigstore for DCC3, TEE quote
 * for DCC4, zkProof for DCC5) is the receipt-signer's responsibility.
 */
export function evaluateReceipt(
  receipt: InvocationReceipt,
  tool?: IndexedTool,
): DccEvaluationResult {
  const findings: DccEvaluationFinding[] = [];

  // 1. schemaVersion check
  findings.push({
    check: "receipt_schema_version",
    passed: receipt.schemaVersion === "1.0",
    details:
      receipt.schemaVersion === "1.0"
        ? "Receipt schema version is 1.0"
        : `Unknown receipt schema version: ${receipt.schemaVersion}`,
    severity: receipt.schemaVersion === "1.0" ? undefined : "critical",
  });

  // 2. PCC signature present
  findings.push({
    check: "pcc_signature_present",
    passed: receipt.pccSignature.length > 0 && receipt.pccKeyId.length > 0,
    details:
      receipt.pccSignature.length > 0
        ? `PCC signature present (keyId: ${receipt.pccKeyId})`
        : "PCC signature missing — receipt is unauthenticated",
    severity: receipt.pccSignature.length > 0 ? undefined : "critical",
  });

  // 3. Tool schema hash bound
  findings.push({
    check: "tool_schema_hash_bound",
    passed: receipt.toolSchemaHashAtCall.length > 0,
    details:
      receipt.toolSchemaHashAtCall.length > 0
        ? `Receipt binds tool schema hash ${receipt.toolSchemaHashAtCall.slice(0, 16)}...`
        : "Receipt does not bind a tool schema hash",
    severity: receipt.toolSchemaHashAtCall.length > 0 ? undefined : "critical",
  });

  // 4. Request projection integrity
  const rp = receipt.requestProjection;
  findings.push({
    check: "request_projection_complete",
    passed: rp.headersHash.length > 0 && rp.bodyHash.length > 0,
    details:
      rp.headersHash.length > 0 && rp.bodyHash.length > 0
        ? `Request projection: ${rp.method} ${rp.url}`
        : "Request projection missing hashes",
    severity:
      rp.headersHash.length > 0 && rp.bodyHash.length > 0 ? undefined : "critical",
  });

  // 5. Response projection integrity
  const resp = receipt.responseProjection;
  findings.push({
    check: "response_projection_complete",
    passed: resp.headersHash.length > 0 && resp.bodyHash.length > 0,
    details:
      resp.headersHash.length > 0 && resp.bodyHash.length > 0
        ? `Response projection: status ${resp.status}`
        : "Response projection missing hashes",
    severity:
      resp.headersHash.length > 0 && resp.bodyHash.length > 0 ? undefined : "critical",
  });

  // 6. DCC-class-specific attestation presence
  const effective = receipt.effectiveDccClass;
  const dccChecks = checkDccAttestation(receipt, effective);
  findings.push(...dccChecks);

  // 7. If a tool is provided, verify the effective class respects ceilings
  if (tool) {
    const tierCeiling = TRUST_TIER_DCC_CEILING[tool.trustTier];
    const toolCeiling = tool.assuranceCeiling;
    const effTier = DCC_TIER[effective];
    const tierMax = DCC_TIER[tierCeiling];
    const toolMax = DCC_TIER[toolCeiling];
    const respectsCeiling = effTier <= tierMax && effTier <= toolMax;
    findings.push({
      check: "effective_dcc_within_ceilings",
      passed: respectsCeiling,
      details: respectsCeiling
        ? `Effective ${effective} respects trust-tier ceiling ${tierCeiling} and tool ceiling ${toolCeiling}`
        : `Effective ${effective} EXCEEDS ceiling (trust-tier=${tierCeiling}, tool=${toolCeiling})`,
      severity: respectsCeiling ? undefined : "critical",
    });

    // 7b. Quarantined tools cannot be invoked at all
    if (tool.trustTier === TrustTier.QUARANTINED) {
      findings.push({
        check: "tool_not_quarantined",
        passed: false,
        details: "Tool is QUARANTINED and cannot be invoked",
        severity: "critical",
      });
    }
    // 7c. Trust tier sanity (numeric ordering)
    findings.push({
      check: "trust_tier_valid",
      passed: TRUST_TIER_NUMERIC[tool.trustTier] >= -1,
      details: `Trust tier ${tool.trustTier} (${TRUST_TIER_NUMERIC[tool.trustTier]})`,
      severity: undefined,
    });
  }

  // 8. Downgrade reason consistency
  const downgraded =
    DCC_TIER[receipt.effectiveDccClass] < DCC_TIER[receipt.requestedDccClass];
  const downgradeFinding: DccEvaluationFinding = downgraded
    ? {
        check: "downgrade_reason_present",
        passed: !!receipt.downgradeReason,
        details: receipt.downgradeReason
          ? `Downgrade explained: ${receipt.downgradeReason}`
          : "Effective class is below requested but no downgradeReason provided",
        severity: receipt.downgradeReason ? undefined : "warning",
      }
    : {
        check: "no_unexpected_downgrade",
        passed: true,
        details: `No downgrade (requested ${receipt.requestedDccClass} == effective ${receipt.effectiveDccClass})`,
        severity: undefined,
      };
  findings.push(downgradeFinding);

  // ── Roll up to score ──────────────────────────────────────────────────
  const totalChecks = findings.length;
  const passedChecks = findings.filter((f) => f.passed).length;
  const criticalFailures = findings.filter(
    (f) => !f.passed && f.severity === "critical",
  );
  const warnings = findings.filter(
    (f) => !f.passed && f.severity === "warning",
  );

  // Base score: 100 - 20 per critical failure - 5 per warning, floored at 0.
  const baseScore = Math.max(
    0,
    100 - criticalFailures.length * 20 - warnings.length * 5,
  );
  const multiplier = DCC_MULTIPLIERS[effective];
  const finalScore = Math.round(baseScore * multiplier * 100) / 100;

  const verdict: DccEvaluationResult["verdict"] =
    criticalFailures.length > 0
      ? "invalid"
      : warnings.length > 0 && passedChecks / totalChecks < 0.9
        ? "inconclusive"
        : "valid";

  const confidence =
    verdict === "valid"
      ? Math.min(100, 90 + (passedChecks / totalChecks) * 10)
      : verdict === "inconclusive"
        ? 60
        : Math.max(0, 50 - criticalFailures.length * 15);

  return {
    finalScore,
    baseScore,
    multiplier,
    requestedDccClass: receipt.requestedDccClass,
    effectiveDccClass: effective,
    downgraded,
    findings,
    verdict,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Per-DCC attestation checks
// ---------------------------------------------------------------------------

/**
 * Return the findings for required attestations at a given DCC class.
 *
 * - DCC0 / DCC1: PCC signature already checked above; nothing extra here.
 * - DCC2: upstream signature + key id required.
 * - DCC3: sigstoreBundleRef required.
 * - DCC4: teeQuote required.
 * - DCC5: zkProof required.
 */
function checkDccAttestation(
  receipt: InvocationReceipt,
  effective: DigitalCaptureClass,
): DccEvaluationFinding[] {
  const findings: DccEvaluationFinding[] = [];
  switch (effective) {
    case DigitalCaptureClass.DCC0:
      findings.push({
        check: "dcc0_unsigned_acknowledged",
        passed: true,
        details: "DCC0: no upstream attestation required",
        severity: undefined,
      });
      break;
    case DigitalCaptureClass.DCC1:
      // DCC1 receipts are HMAC-signed by PCC itself; the PCC signature check
      // above covers this. No upstream signature needed.
      findings.push({
        check: "dcc1_hmac_via_pcc",
        passed: receipt.pccSignature.length > 0,
        details:
          receipt.pccSignature.length > 0
            ? "DCC1: PCC HMAC receipt present"
            : "DCC1: HMAC receipt missing",
        severity: receipt.pccSignature.length > 0 ? undefined : "critical",
      });
      break;
    case DigitalCaptureClass.DCC2:
      findings.push({
        check: "dcc2_upstream_signature",
        passed: !!receipt.upstreamSignature && !!receipt.upstreamKeyId,
        details:
          receipt.upstreamSignature && receipt.upstreamKeyId
            ? `DCC2: upstream signature present (keyId: ${receipt.upstreamKeyId})`
            : "DCC2: upstream signature or keyId missing",
        severity:
          receipt.upstreamSignature && receipt.upstreamKeyId
            ? undefined
            : "critical",
      });
      break;
    case DigitalCaptureClass.DCC3:
      findings.push({
        check: "dcc3_sigstore_bundle_ref",
        passed: !!receipt.sigstoreBundleRef,
        details: receipt.sigstoreBundleRef
          ? `DCC3: Sigstore bundle ref ${receipt.sigstoreBundleRef}`
          : "DCC3: sigstoreBundleRef missing",
        severity: receipt.sigstoreBundleRef ? undefined : "critical",
      });
      break;
    case DigitalCaptureClass.DCC4:
      findings.push({
        check: "dcc4_tee_quote",
        passed: !!receipt.teeQuote,
        details: receipt.teeQuote
          ? "DCC4: TEE quote present"
          : "DCC4: teeQuote missing",
        severity: receipt.teeQuote ? undefined : "critical",
      });
      break;
    case DigitalCaptureClass.DCC5:
      findings.push({
        check: "dcc5_zk_proof",
        passed: !!receipt.zkProof,
        details: receipt.zkProof
          ? "DCC5: zkProof present"
          : "DCC5: zkProof missing",
        severity: receipt.zkProof ? undefined : "critical",
      });
      break;
  }
  return findings;
}
