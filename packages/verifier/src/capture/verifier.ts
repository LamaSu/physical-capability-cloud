/**
 * CaptureVerifier — Wave 3 verifier-echo.
 *
 * Orchestrates the 6 verification gates (G1..G6) for a Capture Verification
 * Protocol (CVP) submission. The detector (Wave 2) ESTABLISHES the ceiling
 * class from raw signals. The verifier (this file) ENFORCES the per-gate
 * semantics and produces a verdict the gateway can anchor on-chain.
 *
 *   G1 Structural   — hash of captureBytes matches manifest.mediaHash
 *   G2 Signature    — per-class signature (WebAuthn / C2PA / platform / camera / DePIN)
 *   G3 Freshness    — challengeService.verifyCaptureNonce + ≤120s TTL
 *   G4 Detection    — detector.ceiling ≥ declaredClass; else PARTIAL + downgrade
 *   G5 Attestation  — platform attest (CC3+) confirms the signing device
 *   G6 Consensus    — N-of-M verifier signatures (Wave 5 stubbed here)
 *
 * Verdict semantics:
 *   - PASS      — every MANDATORY gate for the declared class passed
 *                 and no soft-fail warnings tripped a critical threshold
 *   - PARTIAL   — G1 + G3 green but detector downgraded declaredClass
 *                 by one step (or a non-critical gate soft-failed)
 *   - FAIL      — any mandatory gate failed (hash mismatch, expired nonce,
 *                 adapter threw, declared-ceiling gap > 1)
 *
 * The CaptureVerifier is intentionally stateless. It consumes adapter
 * interfaces (defined here for WebAuthn, borrowed from detector.ts for
 * everything else) and emits a deterministic result gateway-golf can
 * persist + anchor.
 *
 * See:
 *   ai/research/capture-verification-protocol.md §4 + §5
 *   ai/supervisor/cvp-completeness-checklist.md §B
 *
 * Author: verifier-juliet
 */

import { createHash } from "node:crypto";
import {
  CaptureClass,
  type CaptureManifest,
} from "@pcc/spec";
import type {
  C2PAParserAdapter,
  PlatformAttestationAdapter,
  CameraAttestationAdapter,
  DePINAttestationAdapter,
  CaptureDetector,
  CaptureDetectionResult,
} from "./detector.js";
import type { ChallengeService, CaptureNonceChallenge } from "../workflow/challenge-service.js";

// ---------------------------------------------------------------------------
// WebAuthn adapter interface (new — concrete impl in adapters/webauthn.ts)
// ---------------------------------------------------------------------------

/**
 * Result of verifying a WebAuthn assertion against the capture's expected
 * challenge. `signatureValid` is the core signal; `userVerified` is an
 * additional CC2-raising hint (requires user presence + user verification
 * flag in authenticatorData).
 */
export interface WebAuthnVerifierResult {
  /** Cryptographic signature verified against stored credential */
  signatureValid: boolean;
  /** Extracted challenge from clientDataJSON matched the expected challenge */
  challengeMatches: boolean;
  /** Authenticator data UP (user present) + UV (user verified) flags set */
  userVerified: boolean;
  /** Counter value returned by the authenticator (must monotonically increase) */
  signCount: number;
  /** Credential ID the assertion was signed with */
  credentialId: string;
}

/**
 * Adapter for verifying WebAuthn assertions during G2 signature gate.
 *
 * Real implementation (in adapters/webauthn.ts) wraps `@simplewebauthn/server`
 * `verifyAuthenticationResponse`. Mock implementations can return deterministic
 * results for tests without pulling in the full WebAuthn machinery.
 */
export interface WebAuthnVerifierAdapter {
  verify(params: {
    /** The WebAuthnAssertion from the CaptureManifest */
    assertion: {
      credentialId: string;
      signature: string;
      authenticatorData: string;
      clientDataJSON: string;
      challenge: string;
      signCount: number;
    };
    /** Previously registered credential public key (CBOR-encoded, base64url) */
    expectedPublicKey: string;
    /** The challenge value the server expects to appear inside clientDataJSON */
    expectedChallenge: string;
    /** Relying-party origin the clientDataJSON must reference (e.g. "https://capability.network") */
    expectedOrigin: string;
    /** Relying-party identifier (e.g. "capability.network") */
    expectedRpId: string;
    /** Monotonic counter from the last successful verification (0 if first) */
    previousSignCount?: number;
  }): Promise<WebAuthnVerifierResult>;
}

// ---------------------------------------------------------------------------
// Verifier types
// ---------------------------------------------------------------------------

/**
 * Adapter bundle the verifier orchestrator consumes.
 *
 * The WebAuthn adapter is NEW (defined above). The rest come from
 * detector.ts — we re-use the same interfaces so a single concrete set of
 * adapters serves both the detector (Wave 2) and the verifier (this wave).
 */
export interface CaptureVerifierAdapters {
  /** G2 for CC1 — WebAuthn assertion verification */
  webauthn: WebAuthnVerifierAdapter;
  /** G2 for CC2+ — C2PA manifest parsing */
  c2pa: C2PAParserAdapter;
  /** G2+G5 for CC3 (iOS) — App Attest / DeviceCheck */
  appattest: PlatformAttestationAdapter;
  /** G2+G5 for CC3 (Android) — Play Integrity */
  playintegrity: PlatformAttestationAdapter;
  /** G2 for CC4 (optional) — dedicated camera body signatures */
  camera?: CameraAttestationAdapter;
  /** G2 for CC5 (optional) — DePIN chain attestation lookup */
  depin?: DePINAttestationAdapter;
  /** G4 — 6-pass detector already wired by the caller */
  detector: CaptureDetector;
  /** G3 — challenge freshness / anti-replay check */
  challengeService: ChallengeService;
}

/**
 * Input the verifier consumes.
 *
 * `captureBytes` is the original media (image/video). Its SHA256 MUST match
 * `manifest.mediaHash` or G1 fails outright. `c2paManifestBytes` is the
 * raw JUMBF block for CC2+/CC3+/CC4+ captures — when absent for those
 * classes, G2 falls through to whatever sub-evidence is present.
 *
 * Freshness (G3) requires the originating `CaptureNonceChallenge` to be
 * supplied so `verifyCaptureNonce` can run. Callers (gateway) hold the
 * challenge in their DB and pass it here.
 */
export interface CaptureVerifyInput {
  /** The capture manifest submitted by the operator */
  manifest: CaptureManifest;
  /** Raw captured media bytes (image or video) */
  captureBytes: Uint8Array;
  /** Raw C2PA JUMBF manifest bytes (CC2+) */
  c2paManifestBytes?: Uint8Array;
  /** The nonce challenge this capture claims to answer (G3) */
  challenge?: CaptureNonceChallenge;
  /** Extracted visual nonce payload from the captured frame (detector pass 2) */
  visualNonceEcho?: string;
  /** Time the capture was submitted (unix seconds) for freshness math */
  submittedAt?: number;
  /** WebAuthn public key for the credential the operator registered (CC1) */
  webAuthnPublicKey?: string;
  /** WebAuthn relying-party origin (e.g. "https://capability.network") */
  webAuthnOrigin?: string;
  /** WebAuthn relying-party ID (e.g. "capability.network") */
  webAuthnRpId?: string;
  /** Previous WebAuthn sign-count for monotonic-counter anti-replay */
  previousSignCount?: number;
  /** Optional raw captured frame blob for detector pass 3 face-liveness */
  frameBlob?: Uint8Array;
  /** N-of-M verifier attestations (G6; Wave 5 full, Wave 3 stubbed) */
  attestations?: Array<{ verifierId: string; signature: string }>;
}

/** Overall verdict returned by the verifier orchestrator. */
export type CaptureVerdict = "PASS" | "PARTIAL" | "FAIL";

/**
 * Final structured result the verifier returns.
 *
 * Gateway-golf reads this to decide whether to anchor on-chain
 * (`anchorCandidate`), which assurance-score multiplier to apply
 * (`verifiedClass`), and what to surface in the operator UI
 * (`warnings` + `gatesFailed`).
 */
export interface CaptureVerifierResult {
  /** Overall verdict — see class docblock for semantics */
  verdict: CaptureVerdict;
  /** Final class the evidence supports (may be < declaredClass) */
  verifiedClass: CaptureClass;
  /** The class the operator claimed in the manifest */
  declaredClass: CaptureClass;
  /** Gate numbers that passed for the declared class */
  gatesPassed: number[];
  /** Gate numbers that failed (missing or explicit failure) */
  gatesFailed: number[];
  /** Soft warnings — things worth logging but not breaking the verdict */
  warnings: string[];
  /** True iff gateway should push to CaptureClassRegistry */
  anchorCandidate: boolean;
  /** Full detector evidence trail for the gateway to persist */
  detectorEvidence: CaptureDetectionResult;
  /** SHA256 of captureBytes (0x-prefixed) — gateway stores on-chain */
  captureHash: `0x${string}`;
  /** SHA256 of canonicalJSON(manifest) (0x-prefixed) */
  manifestHash: `0x${string}`;
}

// ---------------------------------------------------------------------------
// Constants (gate ordering + class → mandatory gates)
// ---------------------------------------------------------------------------

const CLASS_ORDER: readonly CaptureClass[] = [
  CaptureClass.CC0,
  CaptureClass.CC1,
  CaptureClass.CC2,
  CaptureClass.CC3,
  CaptureClass.CC4,
  CaptureClass.CC5,
];

function classRank(c: CaptureClass): number {
  return CLASS_ORDER.indexOf(c);
}

/**
 * Mandatory gates by declared class. G4 (detection) always runs but is only
 * "mandatory" when the operator claimed > CC0. G6 (consensus) is soft for
 * everything below CC5 in this wave — Wave 5 hardens it to mandatory for
 * CC5 and optional with penalties for CC3/CC4.
 */
const MANDATORY_GATES: Record<CaptureClass, readonly number[]> = {
  [CaptureClass.CC0]: [1], // only structural
  [CaptureClass.CC1]: [1, 2, 3, 4],
  [CaptureClass.CC2]: [1, 2, 3, 4, 5],
  [CaptureClass.CC3]: [1, 2, 3, 4, 5],
  [CaptureClass.CC4]: [1, 2, 3, 4, 5],
  [CaptureClass.CC5]: [1, 2, 3, 4, 5, 6],
};

// ---------------------------------------------------------------------------
// Canonical JSON helper — deterministic, sorted keys, no prototype-pollution
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic JSON string with recursively-sorted object keys.
 *
 * The on-chain `manifestHash` is `sha256(canonicalJSON(manifest))`; gateway
 * and verifier MUST agree on the exact bytes or the hash will differ across
 * replays. Using `JSON.stringify(obj, Object.keys(obj).sort())` is NOT
 * recursive — we need a full walker.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
  return "{" + parts.join(",") + "}";
}

function sha256Hex(bytes: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// CaptureVerifier
// ---------------------------------------------------------------------------

/**
 * Orchestrates gates G1..G6 over a capture submission.
 *
 * Construction wires up the adapter bundle once. The `verify()` method is
 * stateless-per-call so a single instance can service concurrent uploads.
 */
export class CaptureVerifier {
  constructor(private readonly adapters: CaptureVerifierAdapters) {}

  async verify(input: CaptureVerifyInput): Promise<CaptureVerifierResult> {
    const { manifest } = input;
    const declaredClass = manifest.class;
    const warnings: string[] = [];
    const gatesPassed: number[] = [];
    const gatesFailed: number[] = [];

    // Compute hashes up-front (needed by G1 and the output).
    const capHex = sha256Hex(input.captureBytes);
    const captureHash = `0x${capHex}` as `0x${string}`;
    const manifestHash = `0x${sha256Hex(canonicalJSON(manifest))}` as `0x${string}`;

    // -----------------------------------------------------------------------
    // G1 Structural — byte hash matches manifest.mediaHash
    // -----------------------------------------------------------------------
    const g1 = this.gateG1Structural(input, capHex);
    if (g1.passed) gatesPassed.push(1);
    else {
      gatesFailed.push(1);
      warnings.push(g1.reason ?? "G1 structural failed");
    }

    // -----------------------------------------------------------------------
    // G2 Signature — per-class signature path
    // -----------------------------------------------------------------------
    const g2 = await this.gateG2Signature(input);
    if (g2.passed) gatesPassed.push(2);
    else {
      gatesFailed.push(2);
      warnings.push(g2.reason ?? "G2 signature failed");
    }

    // -----------------------------------------------------------------------
    // G3 Freshness — challenge nonce + TTL
    // -----------------------------------------------------------------------
    const g3 = this.gateG3Freshness(input);
    if (g3.passed) gatesPassed.push(3);
    else {
      gatesFailed.push(3);
      warnings.push(g3.reason ?? "G3 freshness failed");
    }

    // -----------------------------------------------------------------------
    // G4 Detection — detector's ceiling ≥ declaredClass?
    // -----------------------------------------------------------------------
    const g4 = await this.gateG4Detection(input);
    if (g4.passed) gatesPassed.push(4);
    else {
      gatesFailed.push(4);
      warnings.push(g4.reason ?? "G4 detection failed");
    }

    // -----------------------------------------------------------------------
    // G5 Attestation — platform attestation for CC3+
    // -----------------------------------------------------------------------
    const g5 = await this.gateG5Attestation(input);
    if (g5.passed) gatesPassed.push(5);
    else {
      gatesFailed.push(5);
      if (classRank(declaredClass) >= classRank(CaptureClass.CC3)) {
        warnings.push(g5.reason ?? "G5 attestation failed for CC3+");
      }
      // For CC1 / CC2 manifests, lack of G5 is a no-op soft-skip.
    }

    // -----------------------------------------------------------------------
    // G6 Consensus — N-of-M verifier attestations (Wave 3 minimal)
    // -----------------------------------------------------------------------
    const g6 = this.gateG6Consensus(input);
    if (g6.passed) gatesPassed.push(6);
    else {
      gatesFailed.push(6);
      if (declaredClass === CaptureClass.CC5) {
        warnings.push(g6.reason ?? "G6 consensus failed for CC5");
      }
    }

    // -----------------------------------------------------------------------
    // Final verdict
    // -----------------------------------------------------------------------
    const mandatory = MANDATORY_GATES[declaredClass];
    const mandatoryPassed = mandatory.every((g) => gatesPassed.includes(g));

    // Pull the detector's proposed ceiling for downgrade decisions.
    const detectorResult = g4.detectorResult;
    const detectorCeiling = detectorResult?.ceiling ?? CaptureClass.CC0;
    const declaredRank = classRank(declaredClass);
    const ceilingRank = classRank(detectorCeiling);
    const oneStepSlip = declaredRank - ceilingRank === 1;
    const ceilingGap = declaredRank - ceilingRank;

    let verdict: CaptureVerdict;
    let verifiedClass: CaptureClass = declaredClass;

    if (!mandatoryPassed) {
      verdict = "FAIL";
      verifiedClass = detectorCeiling;
    } else if (ceilingGap >= 2) {
      // Two-step slip (e.g. declared CC3 but only CC1 evidence) = tamper
      // signal. §B G4 explicitly flags this as reject.
      verdict = "FAIL";
      verifiedClass = detectorCeiling;
      warnings.push(
        `detector ceiling ${detectorCeiling} is ${ceilingGap} steps below declared ${declaredClass}`,
      );
    } else if (oneStepSlip) {
      // One-step downgrade is accepted but the verdict is PARTIAL.
      verdict = "PARTIAL";
      verifiedClass = detectorCeiling;
      warnings.push(
        `declared ${declaredClass} downgraded to ${detectorCeiling} (one-step slip allowed)`,
      );
    } else {
      verdict = "PASS";
      verifiedClass = declaredClass;
    }

    // Anchor candidacy: PASS or PARTIAL with G1+G3 green. CC0 captures with
    // no positive evidence at all are NOT anchored.
    const anchorCandidate =
      verdict !== "FAIL" &&
      gatesPassed.includes(1) &&
      gatesPassed.includes(3) &&
      (classRank(verifiedClass) > classRank(CaptureClass.CC0) ||
        (detectorResult?.anchorCandidate ?? false));

    return {
      verdict,
      verifiedClass,
      declaredClass,
      gatesPassed,
      gatesFailed,
      warnings,
      anchorCandidate,
      detectorEvidence: detectorResult ?? ({
        ceiling: CaptureClass.CC0,
        evidence: [],
        declaredClass,
        detectedCeiling: CaptureClass.CC0,
        confidence: 0,
        warnings: [],
        anchorCandidate: false,
      } as CaptureDetectionResult),
      captureHash,
      manifestHash,
    };
  }

  // =========================================================================
  // Gate implementations
  // =========================================================================

  /**
   * G1 Structural — hash of captureBytes matches manifest.mediaHash.
   *
   * The manifest's `mediaHash` is typed as `sha256:<64 hex>`; strip the
   * prefix before comparing.
   */
  private gateG1Structural(
    input: CaptureVerifyInput,
    actualHex: string,
  ): { passed: boolean; reason?: string } {
    const declared = input.manifest.mediaHash;
    const declaredHex = declared.startsWith("sha256:")
      ? declared.slice("sha256:".length)
      : declared;
    if (declaredHex.toLowerCase() !== actualHex.toLowerCase()) {
      return {
        passed: false,
        reason: `G1: manifest.mediaHash (${declared}) does not match sha256(captureBytes) (${actualHex})`,
      };
    }
    if (input.captureBytes.byteLength === 0) {
      return { passed: false, reason: "G1: captureBytes is empty" };
    }
    return { passed: true };
  }

  /**
   * G2 Signature — per-class signature path.
   *
   * CC0: always passes (no signature declared).
   * CC1: WebAuthn assertion must verify via the adapter.
   * CC2: platform attestation token (appattest / devicecheck / playintegrity) verifies.
   * CC3: C2PA manifest valid enclave-signed + platform attestation bound.
   * CC4: C2PA manifest valid hardware-camera signer OR CameraAttestation valid.
   * CC5: DePIN chain lookup reports exists + hashMatches.
   */
  private async gateG2Signature(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const { manifest } = input;
    const declared = manifest.class;

    if (declared === CaptureClass.CC0) {
      return { passed: true };
    }

    try {
      if (declared === CaptureClass.CC1) {
        return await this.verifyWebAuthn(input);
      }
      if (declared === CaptureClass.CC2) {
        // Platform attestation covers CC2.
        return await this.verifyPlatformAttestation(input);
      }
      if (declared === CaptureClass.CC3) {
        // Enclave-signed C2PA is the primary signal.
        return await this.verifyC2PASignature(input, {
          requireEnclave: true,
          requireHardware: false,
        });
      }
      if (declared === CaptureClass.CC4) {
        // Hardware-camera signed C2PA OR a CameraAttestation adapter pass.
        const c2pa = await this.verifyC2PASignature(input, {
          requireEnclave: false,
          requireHardware: true,
        });
        if (c2pa.passed) return c2pa;
        const camera = await this.verifyCameraAttestation(input);
        if (camera.passed) return camera;
        return {
          passed: false,
          reason: `G2/CC4: neither C2PA hardware signer nor CameraAttestation verified (${c2pa.reason ?? ""}; ${camera.reason ?? ""})`,
        };
      }
      if (declared === CaptureClass.CC5) {
        return await this.verifyDePINAttestation(input);
      }
    } catch (err) {
      return {
        passed: false,
        reason: `G2 adapter threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      passed: false,
      reason: `G2: unknown declared class ${declared}`,
    };
  }

  private async verifyWebAuthn(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const assertion = input.manifest.webAuthnAssertion;
    if (!assertion) {
      return { passed: false, reason: "G2/CC1: no webAuthnAssertion in manifest" };
    }
    if (!input.webAuthnPublicKey || !input.webAuthnOrigin || !input.webAuthnRpId) {
      return {
        passed: false,
        reason: "G2/CC1: missing webAuthnPublicKey/Origin/RpId for verification",
      };
    }
    const result = await this.adapters.webauthn.verify({
      assertion,
      expectedPublicKey: input.webAuthnPublicKey,
      expectedChallenge: assertion.challenge,
      expectedOrigin: input.webAuthnOrigin,
      expectedRpId: input.webAuthnRpId,
      previousSignCount: input.previousSignCount ?? 0,
    });
    if (!result.signatureValid) {
      return { passed: false, reason: "G2/CC1: WebAuthn signature invalid" };
    }
    if (!result.challengeMatches) {
      return { passed: false, reason: "G2/CC1: WebAuthn challenge mismatch" };
    }
    if (result.signCount <= (input.previousSignCount ?? 0) && result.signCount !== 0) {
      return {
        passed: false,
        reason: `G2/CC1: WebAuthn signCount did not advance (${result.signCount} <= ${input.previousSignCount ?? 0})`,
      };
    }
    return { passed: true };
  }

  private async verifyPlatformAttestation(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const att = input.manifest.platformAttestation;
    if (!att) {
      return { passed: false, reason: "G2/CC2: no platformAttestation in manifest" };
    }
    const adapter =
      att.source === "playintegrity"
        ? this.adapters.playintegrity
        : this.adapters.appattest;
    const res = await adapter.verify({
      source: att.source,
      token: att.token,
      expectedNonce: att.nonce,
    });
    if (!res.signatureValid) {
      return { passed: false, reason: `G2/CC2: platform attestation signature invalid (${att.source})` };
    }
    if (!res.nonceMatches) {
      return { passed: false, reason: `G2/CC2: platform attestation nonce mismatch` };
    }
    if (!res.withinTtl) {
      return { passed: false, reason: `G2/CC2: platform attestation expired` };
    }
    if (res.integrity === "failed") {
      return { passed: false, reason: `G2/CC2: platform integrity=failed` };
    }
    return { passed: true };
  }

  private async verifyC2PASignature(
    input: CaptureVerifyInput,
    opts: { requireEnclave: boolean; requireHardware: boolean },
  ): Promise<{ passed: boolean; reason?: string }> {
    if (!input.c2paManifestBytes) {
      return { passed: false, reason: "G2/C2PA: no c2paManifestBytes supplied" };
    }
    const parsed = await this.adapters.c2pa.parseManifest(input.c2paManifestBytes);
    if (!parsed.signatureValid) {
      return { passed: false, reason: "G2/C2PA: signature invalid" };
    }
    if (opts.requireEnclave && !parsed.enclaveSigned) {
      return {
        passed: false,
        reason: `G2/C2PA: enclave signing required but claimGenerator=${parsed.claimGenerator} is not enclave-rooted`,
      };
    }
    if (opts.requireHardware && !parsed.hardwareCamera) {
      return {
        passed: false,
        reason: `G2/C2PA: hardware-camera signer required but claimGenerator=${parsed.claimGenerator} is not a hardware-camera root`,
      };
    }
    return { passed: true };
  }

  private async verifyCameraAttestation(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const cam = input.manifest.camera;
    if (!cam) return { passed: false, reason: "G2/CC4: no camera attestation" };
    const adapter = this.adapters.camera;
    if (!adapter) {
      return { passed: false, reason: "G2/CC4: CameraAttestationAdapter not wired" };
    }
    const res = await adapter.verify({
      make: cam.make,
      model: cam.model,
      publicKey: cam.publicKey,
      signature: cam.signature,
      capturedBytes: input.captureBytes,
    });
    if (!res.signatureValid) {
      return { passed: false, reason: "G2/CC4: camera signature invalid" };
    }
    if (!res.firmwareAcceptable) {
      return { passed: false, reason: "G2/CC4: camera firmware below policy" };
    }
    return { passed: true };
  }

  private async verifyDePINAttestation(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const dep = input.manifest.depin;
    if (!dep) return { passed: false, reason: "G2/CC5: no depin attestation" };
    const adapter = this.adapters.depin;
    if (!adapter) {
      return { passed: false, reason: "G2/CC5: DePINAttestationAdapter not wired" };
    }
    // Extract the capture-hash expected to match on the DePIN chain.
    const expectedCaptureHash = input.manifest.mediaHash;
    const res = await adapter.verify({
      source: dep.source,
      txHash: dep.txHash,
      chainId: dep.chainId,
      expectedCaptureHash,
    });
    if (!res.exists) {
      return { passed: false, reason: `G2/CC5: DePIN tx ${dep.txHash} not found on ${dep.source}` };
    }
    if (!res.hashMatches) {
      return { passed: false, reason: "G2/CC5: DePIN on-chain hash does not match captureHash" };
    }
    return { passed: true };
  }

  /**
   * G3 Freshness — challenge nonce + TTL.
   *
   * Delegates to `ChallengeService.verifyCaptureNonce`. Callers must pass
   * the originating `CaptureNonceChallenge` (the server-side DB row) plus
   * the `submittedAt` timestamp.
   *
   * CC0 captures may skip this gate (they have no challenge). Everything
   * above CC0 requires a challenge.
   */
  private gateG3Freshness(input: CaptureVerifyInput): { passed: boolean; reason?: string } {
    const declared = input.manifest.class;
    if (declared === CaptureClass.CC0) {
      // CC0 has no freshness requirement — always passes.
      return { passed: true };
    }
    if (!input.challenge) {
      return { passed: false, reason: "G3: no CaptureNonceChallenge supplied" };
    }
    const submittedAt =
      input.submittedAt ?? Math.floor(Date.now() / 1000);
    const res = this.adapters.challengeService.verifyCaptureNonce(input.challenge, {
      challengeId: input.challenge.challengeId,
      submittedAt,
      visualNonceEcho:
        input.visualNonceEcho ?? input.challenge.visualNonce.payload,
    });
    if (!res.valid) {
      return { passed: false, reason: `G3: ${res.reason}` };
    }
    return { passed: true };
  }

  /**
   * G4 Detection — run the 6-pass detector and compare its ceiling to
   * `declaredClass`. Passes only if ceiling ≥ declaredClass (zero or
   * one-step slip; the final verdict logic handles PARTIAL / FAIL).
   */
  private async gateG4Detection(input: CaptureVerifyInput): Promise<{
    passed: boolean;
    reason?: string;
    detectorResult: CaptureDetectionResult;
  }> {
    const detectorInput = {
      manifest: input.manifest,
      challengeId: input.challenge?.challengeId,
      expectedVisualNoncePayload: input.challenge?.visualNonce.payload,
      visualNonceEcho: input.visualNonceEcho,
      frameBlob: input.frameBlob,
      c2paManifestBytes: input.c2paManifestBytes,
    };
    const result = await this.adapters.detector.detect(detectorInput);
    const declared = input.manifest.class;
    const declaredRank = classRank(declared);
    const ceilingRank = classRank(result.ceiling);
    if (ceilingRank >= declaredRank) {
      return { passed: true, detectorResult: result };
    }
    return {
      passed: false,
      reason: `G4: detector ceiling ${result.ceiling} < declared ${declared}`,
      detectorResult: result,
    };
  }

  /**
   * G5 Attestation — platform attestation confirms the signing device.
   *
   * For CC3 we re-run the platform attestation check binding it to the
   * WebAuthn credential that produced the CC1 signature. Gateway-golf will
   * add cross-device binding checks in Wave 5; here we do the basic
   * "platform attestation is strong" check.
   *
   * For CC1 / CC2 / CC4 / CC5 without a platform attestation, G5 is a
   * no-op pass (the class doesn't require it).
   */
  private async gateG5Attestation(
    input: CaptureVerifyInput,
  ): Promise<{ passed: boolean; reason?: string }> {
    const declared = input.manifest.class;
    const platformAtt = input.manifest.platformAttestation;

    // Classes that don't use platform attestation pass G5 trivially.
    if (declared === CaptureClass.CC0) return { passed: true };
    if (declared === CaptureClass.CC4) return { passed: true };
    if (declared === CaptureClass.CC5) return { passed: true };

    // CC1 has no hard requirement for platform attestation.
    if (declared === CaptureClass.CC1) {
      return { passed: true };
    }

    // CC2 + CC3 require a platform attestation.
    if (!platformAtt) {
      return {
        passed: false,
        reason: `G5: no platformAttestation for ${declared}`,
      };
    }

    const adapter =
      platformAtt.source === "playintegrity"
        ? this.adapters.playintegrity
        : this.adapters.appattest;

    try {
      const res = await adapter.verify({
        source: platformAtt.source,
        token: platformAtt.token,
        expectedNonce: platformAtt.nonce,
      });
      if (!res.signatureValid) {
        return { passed: false, reason: "G5: platform attestation signature invalid" };
      }
      if (!res.nonceMatches) {
        return { passed: false, reason: "G5: platform attestation nonce mismatch" };
      }
      if (!res.withinTtl) {
        return { passed: false, reason: "G5: platform attestation expired" };
      }
      if (declared === CaptureClass.CC3 && res.integrity !== "strong") {
        return {
          passed: false,
          reason: `G5: CC3 requires strong integrity, got ${res.integrity}`,
        };
      }
      if (res.integrity === "failed") {
        return { passed: false, reason: "G5: platform integrity=failed" };
      }
      return { passed: true };
    } catch (err) {
      return {
        passed: false,
        reason: `G5: platform adapter threw (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  /**
   * G6 Consensus — N-of-M verifier signatures.
   *
   * Wave 3 stub: if the caller passes at least one attestation OR the
   * manifest already carries a DePIN attestation (which implies network
   * consensus), the gate passes.
   *
   * Wave 5 will cryptographically verify each attester's signature over
   * captureHash + declaredClass and enforce the
   * `minAttestersPerClass[class]` policy.
   */
  private gateG6Consensus(input: CaptureVerifyInput): { passed: boolean; reason?: string } {
    const declared = input.manifest.class;

    // Only CC5 mandates consensus in Wave 3.
    if (declared !== CaptureClass.CC5) {
      return { passed: true };
    }

    // CC5 requires either explicit attestations OR a DePIN manifest entry
    // (the DePIN source IS the consensus signal).
    if (input.manifest.depin) {
      return { passed: true };
    }
    const count = (input.attestations ?? []).length;
    if (count >= 1) {
      return { passed: true };
    }
    return {
      passed: false,
      reason: "G6: CC5 requires ≥1 attestation or a DePIN entry; got neither",
    };
  }
}
