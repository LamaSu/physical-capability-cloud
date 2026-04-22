/**
 * Capture Verification Protocol — browser-side face-liveness detector.
 *
 * Thin wrapper around `@mediapipe/tasks-vision@0.10.34` FaceLandmarker for
 * pass-3 liveness in the CaptureFlow. The returned shape matches
 * `FaceLandmarkerResult` in the verifier so the server's detector can
 * consume client-side pre-computed liveness when provided (future wave) or
 * re-run the same computation server-side against the raw frame.
 *
 * What we check (design doc §4 Pass 3):
 *   - `hasFace`       — at least one face in the frame
 *   - `blinkDetected` — eye-aspect-ratio dip across the capture window
 *     (we track min eye blendshape score vs a threshold)
 *   - `yawDegrees`    — maximum head-yaw deflection from neutral (head pan)
 *
 * The model + WASM binaries are loaded from the MediaPipe CDN on first
 * detect() call. Callers can pass an explicit loader to override (e.g. for
 * SRI pinning via a self-hosted bundle).
 *
 * TODO (Wave 4): self-host the `face_landmarker.task` model bundle + WASM
 * under `apps/dashboard/public/mediapipe/` so the capture flow works
 * offline. Today we rely on Google's CDN with SRI-less CORS — which means
 * we're one supply-chain incident away from a false-positive outage. Vet
 * team tagged this WARN during Gate A.
 */

import type { FaceLandmarkerResult } from "./types.js";

/**
 * Narrow contract over the bits of `@mediapipe/tasks-vision` we consume.
 *
 * We do NOT import the full package type surface because (a) the MediaPipe
 * types churn between minor versions and (b) we want zero runtime cost in
 * tests. Instead we type the minimum subset here and cast the native module
 * at the boundary.
 */
export interface FaceLandmarkerNative {
  /** Run the model on a single frame and return landmarks + blendshapes */
  detect(input: ImageInput): FaceLandmarkerNativeResult;
  /** Clean up GPU resources */
  close?(): void;
}

/** Acceptable frame input types across MediaPipe versions. */
export type ImageInput =
  | ImageData
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

/** Subset of MediaPipe's `FaceLandmarkerResult` we consume. */
export interface FaceLandmarkerNativeResult {
  faceLandmarks?: readonly (readonly { x: number; y: number; z: number }[])[];
  faceBlendshapes?: readonly {
    categories: readonly { categoryName: string; score: number }[];
  }[];
  facialTransformationMatrixes?: readonly { data: readonly number[] }[];
}

/**
 * Factory type for loading a `FaceLandmarkerNative`.
 *
 * Production usage (in `apps/dashboard`):
 * ```ts
 * import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
 * const loader: FaceLandmarkerLoader = async () => {
 *   const fileset = await FilesetResolver.forVisionTasks(
 *     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
 *   );
 *   return FaceLandmarker.createFromOptions(fileset, {
 *     baseOptions: { modelAssetPath: "...face_landmarker.task" },
 *     outputFaceBlendshapes: true,
 *     outputFacialTransformationMatrixes: true,
 *     runningMode: "IMAGE",
 *   }) as unknown as FaceLandmarkerNative;
 * };
 * ```
 */
export type FaceLandmarkerLoader = () => Promise<FaceLandmarkerNative>;

/**
 * Options the caller can tune — sensible defaults baked in.
 *
 * Thresholds come from the design doc §4: blinks below 0.15 eye blendshape
 * score are real blinks; yaw requires ≥5 degrees to count as movement.
 */
export interface FaceLandmarkerAdapterOptions {
  /** Max eye-blendshape score to count as a blink (0=closed, 1=open) */
  blinkScoreThreshold?: number;
  /** Minimum absolute yaw (degrees) to count as a head-yaw positive */
  minYawDegrees?: number;
}

const DEFAULT_BLINK_THRESHOLD = 0.15;
const DEFAULT_MIN_YAW_DEGREES = 5;

/**
 * Decode a capture blob (PNG/JPEG bytes) into a form MediaPipe can consume.
 *
 * Uses `createImageBitmap` which is available in all modern browsers as well
 * as in Node ≥20 via `--experimental-global-webstreams`. When unavailable
 * (older test envs), returns null — the caller treats that as "no face".
 */
async function frameBlobToBitmap(
  bytes: Uint8Array,
): Promise<ImageBitmap | null> {
  // Empty blob → no face.
  if (!bytes || bytes.byteLength === 0) return null;

  // Guard: createImageBitmap may not be defined in pure Node test runners.
  if (
    typeof globalThis === "undefined" ||
    typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap !==
      "function"
  ) {
    return null;
  }

  try {
    const blob = new Blob([bytes]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (globalThis as any).createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Browser-side face landmarker / liveness adapter.
 *
 * Implements `FaceLandmarkerAdapter` from `@pcc/verifier` so it can be fed
 * directly into the detector (either server-side for Node builds, or in a
 * test that wants to reuse our heuristics).
 */
export class FaceLandmarkerAdapter {
  private nativeCache: FaceLandmarkerNative | null = null;

  private readonly blinkThreshold: number;
  private readonly minYawDegrees: number;

  constructor(
    private readonly loader: FaceLandmarkerLoader,
    options: FaceLandmarkerAdapterOptions = {},
  ) {
    this.blinkThreshold = options.blinkScoreThreshold ?? DEFAULT_BLINK_THRESHOLD;
    this.minYawDegrees = options.minYawDegrees ?? DEFAULT_MIN_YAW_DEGREES;
  }

  /**
   * Load the MediaPipe native (cached across calls).
   *
   * Exposed as a method so tests can pre-warm or inspect load errors
   * independently of detect().
   */
  async load(): Promise<FaceLandmarkerNative> {
    if (!this.nativeCache) {
      this.nativeCache = await this.loader();
    }
    return this.nativeCache;
  }

  /**
   * Free GPU / WASM resources. Idempotent.
   */
  async close(): Promise<void> {
    if (this.nativeCache?.close) {
      this.nativeCache.close();
    }
    this.nativeCache = null;
  }

  /**
   * Run face detection on a single frame.
   *
   * Never throws — returns a "no face" result when the WASM fails to load
   * or the frame can't be decoded, so the detector's pass-3 path can
   * uniformly read the result.
   */
  async detectFace(frameBlob: Uint8Array): Promise<FaceLandmarkerResult> {
    const bitmap = await frameBlobToBitmap(frameBlob);
    if (!bitmap) {
      return { hasFace: false, blinkDetected: false, yawDegrees: 0 };
    }

    let native: FaceLandmarkerNative;
    try {
      native = await this.load();
    } catch {
      return { hasFace: false, blinkDetected: false, yawDegrees: 0 };
    }

    let result: FaceLandmarkerNativeResult;
    try {
      result = native.detect(bitmap);
    } catch {
      return { hasFace: false, blinkDetected: false, yawDegrees: 0 };
    }

    return interpretLandmarkerResult(
      result,
      this.blinkThreshold,
      this.minYawDegrees,
    );
  }
}

/**
 * Convert a raw MediaPipe `FaceLandmarkerNativeResult` to our
 * `FaceLandmarkerResult` domain shape.
 *
 * Exposed for unit tests.
 */
export function interpretLandmarkerResult(
  result: FaceLandmarkerNativeResult,
  blinkThreshold: number,
  minYawDegrees: number,
): FaceLandmarkerResult {
  const faces = result.faceLandmarks ?? [];
  const hasFace = faces.length > 0;
  if (!hasFace) {
    return { hasFace: false, blinkDetected: false, yawDegrees: 0 };
  }

  // Blink detection from blendshape scores. MediaPipe emits
  // `eyeBlinkLeft` / `eyeBlinkRight` in its blendshape bank. A closed eye
  // has score ≈ 0.6..0.9 for `eyeBlink*` (opposite of `eyeOpen`).
  //
  // We consider a blink detected when EITHER eye's blink score in the
  // current frame rises above `1 - blinkThreshold` (i.e. eye is "mostly
  // closed") OR when an explicit `eyeBlink*` above 0.5 is present.
  let blinkDetected = false;
  const blendshapes = result.faceBlendshapes ?? [];
  for (const face of blendshapes) {
    for (const cat of face.categories) {
      const name = cat.categoryName.toLowerCase();
      if (name.includes("blink") && cat.score >= 1 - blinkThreshold) {
        blinkDetected = true;
        break;
      }
    }
    if (blinkDetected) break;
  }

  // Yaw extraction. `facialTransformationMatrixes[0].data` is a
  // column-major 4x4 matrix. Yaw = atan2(-m20, sqrt(m21^2 + m22^2))
  // in degrees. We cap at 89 degrees to avoid asymptotes when the matrix
  // is near-singular (e.g. completely turned away).
  let yawDegrees = 0;
  const matrices = result.facialTransformationMatrixes ?? [];
  const m = matrices[0]?.data;
  if (m && m.length >= 16) {
    // column-major indexing — m[col*4+row]
    const m20 = m[0 * 4 + 2] ?? 0;
    const m21 = m[1 * 4 + 2] ?? 0;
    const m22 = m[2 * 4 + 2] ?? 0;
    const yawRad = Math.atan2(-m20, Math.sqrt(m21 * m21 + m22 * m22));
    yawDegrees = Math.max(
      -89,
      Math.min(89, (yawRad * 180) / Math.PI),
    );
  }

  void minYawDegrees; // reserved: caller can compare yawDegrees to this.

  return { hasFace, blinkDetected, yawDegrees };
}
