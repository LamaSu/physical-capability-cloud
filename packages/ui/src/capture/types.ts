/**
 * Capture Verification Protocol — browser-side shared types.
 *
 * Mirrors interfaces from `@pcc/verifier/src/capture/detector.ts` so the
 * browser adapters can be consumed on the wire by the same detector. The
 * UI package deliberately does NOT depend on `@pcc/verifier` (which carries
 * Node-only deps such as `viem`, `starknet`); we re-declare the adapter
 * shapes here.
 *
 * TODO (Wave 4): unify these with `@pcc/verifier` by publishing a
 * `@pcc/spec/capture-adapters` barrel that both sides import. Until then,
 * any change on the verifier side MUST be mirrored here (and vice versa).
 *
 * See: ai/research/capture-verification-protocol.md §4, §5, §9
 */

/**
 * Result of running a face-landmarker pass over captured frame(s).
 *
 * Shape MUST match `FaceLandmarkerResult` in
 * `packages/verifier/src/capture/detector.ts` lines 60-67.
 */
export interface FaceLandmarkerResult {
  /** Whether at least one face was detected in the capture window */
  hasFace: boolean;
  /** Whether a blink was observed (eye-aspect-ratio dip) */
  blinkDetected: boolean;
  /** Maximum observed head-yaw (degrees off neutral pose) */
  yawDegrees: number;
}

/**
 * Minimal parsed view of a C2PA manifest that the detector cares about.
 *
 * Shape MUST match `ParsedC2PA` in
 * `packages/verifier/src/capture/detector.ts` lines 87-96.
 */
export interface ParsedC2PA {
  /** Signature passed cryptographic verification against the trust store */
  signatureValid: boolean;
  /** Claim generator string (e.g. "com.truepic", "Leica M11-P") */
  claimGenerator: string;
  /** True iff the signing cert chains to a known hardware-camera root */
  hardwareCamera: boolean;
  /** True iff the signing cert chains to a known enclave-SDK root (Truepic, ...) */
  enclaveSigned: boolean;
}
