/**
 * Capture Verification Protocol (CVP) — verifier-side barrel.
 *
 * Re-exports the 6-pass `CaptureDetector`, its adapter interfaces, and
 * its input/output types for consumption by the gateway and tests.
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
