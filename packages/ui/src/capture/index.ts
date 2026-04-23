/**
 * Capture Verification Protocol — barrel exports.
 *
 * Surfaces the browser-side capture-verification API so consumers can
 * import from the `@pcc/ui/capture` subpath (or, once the parent
 * `@pcc/ui` barrel re-exports it, directly from the package root).
 *
 * Author: ui-capture-mike
 * See: ai/research/capture-verification-protocol.md §9
 */

// --- React components ----------------------------------------------
export { CaptureFlow } from "./CaptureFlow.js";
export type {
  CaptureFlowProps,
  CaptureUploadResult,
} from "./CaptureFlow.js";

export { VisualNonceRenderer } from "./VisualNonceRenderer.js";
export type { VisualNonceRendererProps } from "./VisualNonceRenderer.js";

// --- Non-React capture adapters ------------------------------------
export { SensorFusion } from "./SensorFusion.js";
export type {
  SensorFusionOptions,
  SensorFusionCaptureResult,
} from "./SensorFusion.js";

export { C2PAReader } from "./C2PAReader.js";
export type {
  C2PALoader,
  C2PANative,
  C2PANativeManifest,
  C2PANativeReadResult,
  C2PANativeValidationStatus,
} from "./C2PAReader.js";

export { FaceLandmarkerAdapter } from "./FaceLandmarker.js";
export type {
  FaceLandmarkerAdapterOptions,
  FaceLandmarkerLoader,
  FaceLandmarkerNative,
  FaceLandmarkerNativeResult,
  ImageInput,
} from "./FaceLandmarker.js";

export { WebAuthnClient } from "./WebAuthnClient.js";
export type {
  WebAuthnCaptureAssertion,
  WebAuthnClientOptions,
} from "./WebAuthnClient.js";

// --- Re-export the shared browser/server types --------------------
export type {
  FaceLandmarkerResult,
  ParsedC2PA,
} from "./types.js";
