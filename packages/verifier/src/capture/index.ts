/**
 * Capture Verification Protocol (CVP) — verifier-side barrel.
 *
 * Re-exports:
 *   - 6-pass CaptureDetector (Wave 2 — detector-charlie)
 *   - CaptureVerifier orchestrator (Wave 3 — verifier-juliet)
 *   - 4 real adapters (C2PA / WebAuthn / AppAttest / PlayIntegrity)
 *   - Their mock constructors for tests
 *
 * See: ai/research/capture-verification-protocol.md §4 + §6
 */

export {
  CaptureDetector,
  type CaptureDetectorAdapters,
  type CaptureDetectionInput,
  type CaptureDetectionResult,
  type FaceLandmarkerAdapter,
  type FaceLandmarkerResult,
  type C2PAParserAdapter,
  type ParsedC2PA,
  type PlatformAttestationAdapter,
  type PlatformAttestationResult,
  type CameraAttestationAdapter,
  type DePINAttestationAdapter,
} from "./detector.js";

export {
  CaptureVerifier,
  canonicalJSON,
  type CaptureVerifierAdapters,
  type CaptureVerifyInput,
  type CaptureVerifierResult,
  type CaptureVerdict,
  type WebAuthnVerifierAdapter,
  type WebAuthnVerifierResult,
} from "./verifier.js";

export { C2PAAdapter, mockC2PAAdapter } from "./adapters/c2pa.js";
export {
  WebAuthnAdapter,
  mockWebAuthnAdapter,
} from "./adapters/webauthn.js";
export { AppAttestAdapter, mockAppAttestAdapter } from "./adapters/appattest.js";
export {
  PlayIntegrityAdapter,
  mockPlayIntegrityAdapter,
} from "./adapters/playintegrity.js";

// LingBot-Map streaming-3D adapter (operator-capture wave)
export {
  runLingBotInference,
  setLingBotSpawnerForTests,
  LingBotAdapterError,
  type LingBotAdapterInput,
  type LingBotAdapterResult,
  type LingBotSpawner,
} from "./lingbot-adapter.js";
