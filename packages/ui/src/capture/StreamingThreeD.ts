/**
 * StreamingThreeD — operator-side LingBot-Map adapter.
 *
 * The closest in-repo location for the user-requested
 * `apps/mobile/streaming-3d.ts` entry point. Mirrors the shape of the other
 * browser-side capture adapters (SensorFusion, C2PAReader, WebAuthnClient,
 * FaceLandmarker) — see `packages/ui/src/capture/index.ts`.
 *
 * Responsibility split:
 *   - Browser  (this file): record a short phone-video clip via
 *     MediaRecorder, hash it, POST to `/api/capture/3d-stream`, hold the
 *     returned `PointMap3DTrace` for inclusion in the parent
 *     `CaptureManifest.pointMaps3D`.
 *   - Server   (`packages/verifier/src/capture/lingbot-adapter.ts`): spawn
 *     `scripts/pcc_lingbot_runner.py`, run streaming inference (or stub),
 *     validate the trace, return it.
 *
 * The adapter exposes two surfaces:
 *   - `StreamingThreeD.recordAndInfer(opts)` — record from the camera then
 *     upload. Used by `CaptureFlow.tsx`.
 *   - `StreamingThreeD.inferFromBlob(opts)` — bring-your-own-video path for
 *     tests and for capture flows that already own the MediaStream (e.g.
 *     when the photo + video share a stream).
 *
 * Author: pcc-lingbot adapter
 * License: Apache-2.0 (matches LingBot-Map upstream)
 */

import type { PointMap3DTrace } from "@pcc/spec";

/** Options for one record-and-infer cycle. */
export interface StreamingThreeDOptions {
  /** Gateway base URL. */
  apiBaseUrl: string;
  /** Bearer token for `/api/capture/3d-stream`. */
  bearerToken: string;
  /** Optional job id to thread through telemetry. */
  jobId?: string;
  /** Optional logical device id stamped on the trace. */
  deviceId?: string;
  /** Inference mode. Default "streaming". */
  mode?: "streaming" | "windowed";
  /** FPS sampling for the server-side runner. Default 10. */
  fps?: number;
  /** Hard cap on frames the runner processes. Default 32. */
  maxFrames?: number;
  /** Sparse points per frame in the returned trace. Default 256. */
  downsamplePoints?: number;
  /**
   * Existing MediaStream to record from. If omitted, the adapter will call
   * `getUserMedia({video: {facingMode: 'environment'}})` and stop the stream
   * after recording.
   */
  mediaStream?: MediaStream;
  /** Recording duration in ms. Default 3000 (3s). Clamped to [500, 15000]. */
  recordMs?: number;
  /**
   * Optional MIME type for MediaRecorder. Adapter probes the browser for
   * support and falls back to `video/webm` then "" (browser default).
   */
  mimeType?: string;
}

/** Options for the bring-your-own-blob path. */
export interface StreamingThreeDFromBlobOptions extends Omit<StreamingThreeDOptions, "mediaStream" | "recordMs" | "mimeType"> {
  /** Caller-provided recorded video blob. */
  videoBlob: Blob;
  /** Expected sha256:<hex> of the video; if provided, sent for echo-check. */
  expectedVideoHash?: string;
}

/** Adapter result returned to the capture flow. */
export interface StreamingThreeDResult {
  trace: PointMap3DTrace;
  durationMs: number;
  /** True iff server ran in stub mode (no GPU touched). */
  stubbed: boolean;
  /** Bytes uploaded — for telemetry / debug surface in CaptureFlow. */
  bytesUploaded: number;
  /** sha256:<hex> of the video that produced the trace. */
  videoHash: string;
}

const DEFAULT_RECORD_MS = 3000;
const MIN_RECORD_MS = 500;
const MAX_RECORD_MS = 15000;
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
];

/** sha256 a Blob using crypto.subtle. Returns `sha256:<hex>`. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `sha256:${hex}`;
}

/** Choose a MIME type supported by the browser's MediaRecorder. */
export function pickMimeType(preferred?: string): string {
  const supportsCheck =
    typeof MediaRecorder !== "undefined" &&
    typeof (MediaRecorder as { isTypeSupported?: (m: string) => boolean }).isTypeSupported === "function";
  if (!supportsCheck) return preferred ?? "";
  const isTypeSupported =
    (MediaRecorder as { isTypeSupported: (m: string) => boolean }).isTypeSupported;
  if (preferred && isTypeSupported(preferred)) return preferred;
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (isTypeSupported(candidate)) return candidate;
  }
  return "";
}

/** Convert an ArrayBuffer / Uint8Array to base64 (browser-safe). */
function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack blow-up on large videos; 64 kB segments are
  // safe in every browser we care about.
  const CHUNK = 0x10000;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Clamp a number into [lo, hi]; falls back to `fallback` for non-finite values. */
function clamp(value: number | undefined, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, value));
}

/** Stop all tracks on a MediaStream. Safe to call multiple times. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Open a camera MediaStream and record `recordMs` of video. Returns the
 * resulting Blob plus the resolved MIME type.
 *
 * Exported for tests so they can substitute `getUserMedia` via the global
 * `navigator.mediaDevices` mock.
 */
export async function recordVideo(opts: {
  recordMs: number;
  mediaStream?: MediaStream;
  mimeType?: string;
}): Promise<{ blob: Blob; mimeType: string }> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("media_recorder_unsupported");
  }

  const ownsStream = !opts.mediaStream;
  let stream: MediaStream;
  if (opts.mediaStream) {
    stream = opts.mediaStream;
  } else {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      throw new Error("camera_unsupported_browser");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  }

  const mimeType = pickMimeType(opts.mimeType);
  const chunks: Blob[] = [];
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  const recordedMime = mimeType || recorder.mimeType || "video/webm";

  return new Promise<{ blob: Blob; mimeType: string }>((resolve, reject) => {
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (ev: Event) => {
      if (ownsStream) stopStream(stream);
      reject(new Error(`media_recorder_error: ${(ev as { error?: Error }).error?.message ?? "unknown"}`));
    };
    recorder.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: recordedMime });
        if (ownsStream) stopStream(stream);
        resolve({ blob, mimeType: recordedMime });
      } catch (err) {
        if (ownsStream) stopStream(stream);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      recorder.start();
    } catch (err) {
      if (ownsStream) stopStream(stream);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    setTimeout(() => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, opts.recordMs);
  });
}

/**
 * Send a video Blob to `/api/capture/3d-stream` and return the parsed
 * adapter response. Exported separately so tests can exercise the network
 * surface without driving MediaRecorder.
 */
export async function uploadAndInfer(
  videoBlob: Blob,
  opts: StreamingThreeDOptions & { expectedVideoHash?: string },
): Promise<StreamingThreeDResult> {
  const bytes = new Uint8Array(await videoBlob.arrayBuffer());
  const videoHash = opts.expectedVideoHash ?? (await sha256Blob(videoBlob));
  const videoBytesBase64 = bytesToBase64(bytes);

  const body = {
    videoBytesBase64,
    videoMime: videoBlob.type || undefined,
    mode: opts.mode,
    fps: opts.fps,
    maxFrames: opts.maxFrames,
    downsamplePoints: opts.downsamplePoints,
    jobId: opts.jobId,
    deviceId: opts.deviceId,
    expectedVideoHash: videoHash,
  };

  const res = await fetch(`${opts.apiBaseUrl}/api/capture/3d-stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.bearerToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `streaming_3d_upload_failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as {
    trace: PointMap3DTrace;
    durationMs: number;
    stubbed: boolean;
    bytesReceived: number;
  };

  // Defensive — gateway already cross-checks but trust nothing on the wire.
  if (json.trace.videoHash.toLowerCase() !== videoHash.toLowerCase()) {
    throw new Error(
      `streaming_3d_hash_mismatch: trace.videoHash=${json.trace.videoHash} expected=${videoHash}`,
    );
  }

  return {
    trace: json.trace,
    durationMs: json.durationMs,
    stubbed: json.stubbed,
    bytesUploaded: bytes.length,
    videoHash,
  };
}

/**
 * Operator-side streaming-3D adapter. The CaptureFlow component instantiates
 * one of these per capture and runs `.recordAndInfer(opts)` in parallel with
 * the other evidence collectors (SensorFusion, FaceLandmarker, WebAuthn).
 */
export class StreamingThreeD {
  /** Convenience: record from the camera AND ship to the gateway. */
  static async recordAndInfer(opts: StreamingThreeDOptions): Promise<StreamingThreeDResult> {
    const recordMs = clamp(opts.recordMs, MIN_RECORD_MS, MAX_RECORD_MS, DEFAULT_RECORD_MS);
    const { blob } = await recordVideo({
      recordMs,
      mediaStream: opts.mediaStream,
      mimeType: opts.mimeType,
    });
    return uploadAndInfer(blob, opts);
  }

  /** Bring-your-own-video flavor — used in tests and prebuilt video paths. */
  static async inferFromBlob(opts: StreamingThreeDFromBlobOptions): Promise<StreamingThreeDResult> {
    return uploadAndInfer(opts.videoBlob, {
      ...opts,
      expectedVideoHash: opts.expectedVideoHash,
    });
  }
}
