/**
 * CaptureVerifier factory — Path A (gateway-owned construction).
 *
 * The verifier package (`@pcc/verifier`) ships the `CaptureVerifier`
 * orchestrator and its 4 concrete adapters (WebAuthn / C2PA / AppAttest /
 * PlayIntegrity) but, as of the Wave 3 merge, does NOT export a
 * `getCaptureVerifier()` factory from its barrel (`src/index.ts` only
 * re-exports detector types). Gateway-golf owns its own construction so
 * Wave 4 doesn't block on a verifier-package patch.
 *
 * The factory wires:
 *   - WebAuthnAdapter        (real, requires user verification by default)
 *   - C2PAAdapter            (real, @contentauth/c2pa-node on first use)
 *   - AppAttestAdapter       (real)
 *   - PlayIntegrityAdapter   (real, JWS verification)
 *   - CaptureDetector        (constructed with the same C2PA + platform adapters)
 *   - ChallengeService       (wave-1 singleton — one per process is fine)
 *
 * Tests MUST NOT touch this — they should inject a mocked `CaptureVerifier`
 * instance via `setCaptureVerifierForTests` (see below). The real C2PA node
 * library pulls native binaries on first call, which slows test cold-start
 * and is unreliable on CI sandboxes.
 *
 * Source: ai/supervisor/wave4-spec.md §Required Imports + Path A decision.
 */

// NOTE: subpath import — `@pcc/verifier`'s root barrel doesn't re-export
// capture types yet. Using dist paths avoids needing to modify
// verifier-juliet's package.
import { CaptureVerifier } from "@pcc/verifier/dist/capture/verifier.js";
import type { CaptureVerifierAdapters } from "@pcc/verifier/dist/capture/verifier.js";
import { WebAuthnAdapter } from "@pcc/verifier/dist/capture/adapters/webauthn.js";
import { C2PAAdapter } from "@pcc/verifier/dist/capture/adapters/c2pa.js";
import { AppAttestAdapter } from "@pcc/verifier/dist/capture/adapters/appattest.js";
import { PlayIntegrityAdapter } from "@pcc/verifier/dist/capture/adapters/playintegrity.js";
import { CaptureDetector } from "@pcc/verifier/dist/capture/detector.js";
import { ChallengeService } from "@pcc/verifier";

// ---------------------------------------------------------------------------
// Test-injection surface
// ---------------------------------------------------------------------------

let _verifier: CaptureVerifier | null = null;
let _testOverride: CaptureVerifier | null = null;
let _challengeService: ChallengeService | null = null;
let _challengeTestOverride: ChallengeService | null = null;

/**
 * Replace the process-level verifier with a test double. Used exclusively
 * by packages/gateway/src/__tests__/capture.test.ts to mock gate results.
 * Pass `null` to restore real construction.
 */
export function setCaptureVerifierForTests(v: CaptureVerifier | null): void {
  _testOverride = v;
  _verifier = null; // force re-construction on next access
}

/**
 * Replace the process-level ChallengeService with a test double. Wave-1's
 * block-anchor issuance is live RPC, so tests inject a fake with a
 * deterministic block number / hash.
 */
export function setChallengeServiceForTests(s: ChallengeService | null): void {
  _challengeTestOverride = s;
  _challengeService = null;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a new set of production adapters. Factored out so tests that want
 * _some_ real adapters and _some_ fakes can selectively override.
 */
function buildProductionAdapters(): CaptureVerifierAdapters {
  const c2pa = new C2PAAdapter();
  const appattest = new AppAttestAdapter();
  const playintegrity = new PlayIntegrityAdapter();
  const webauthn = new WebAuthnAdapter({ requireUserVerification: true });

  // Detector needs its own adapter bundle — share the C2PA + platform
  // adapters so a single cold-start hit covers both paths. Camera + DePIN
  // + face-landmarker adapters are not wired in Wave 4 (optional; detector
  // degrades gracefully when absent).
  const detector = new CaptureDetector({
    c2pa,
    appattest,
    playintegrity,
  });

  return {
    webauthn,
    c2pa,
    appattest,
    playintegrity,
    detector,
    challengeService: getChallengeService(),
  };
}

/**
 * Return the singleton CaptureVerifier. Respects test overrides.
 */
export function getCaptureVerifier(): CaptureVerifier {
  if (_testOverride) return _testOverride;
  if (!_verifier) {
    _verifier = new CaptureVerifier(buildProductionAdapters());
  }
  return _verifier;
}

/**
 * Return the singleton ChallengeService. Respects test overrides.
 */
export function getChallengeService(): ChallengeService {
  if (_challengeTestOverride) return _challengeTestOverride;
  if (!_challengeService) {
    _challengeService = new ChallengeService();
  }
  return _challengeService;
}
